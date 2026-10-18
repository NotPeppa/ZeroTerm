//! In-process SSH protocol checks for managed (bastion) connections.
//!
//! The gateway mimics RFC-006 §14: one authenticated connection carries any
//! number of session channels; `exec` and the `sftp` subsystem are accepted
//! or refused per channel according to the ticket's capabilities.
use async_trait::async_trait;
use russh::{server, server::Server as _, Channel, ChannelId};
use russh_sftp::protocol::{File, FileAttributes, Handle, Name, Status, StatusCode, Version};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use zeroterm_ssh::{
    AuthMethod, ChannelEvent, ConnectConfig, HostKeyPolicy, ManagedConnection, ManagedSession,
    PtySize, Session, SshError,
};

struct Provider {
    port: u16,
    fingerprint: String,
    preparations: AtomicUsize,
    cancel: CancellationToken,
    caps: Vec<String>,
}
#[async_trait]
impl ManagedConnection for Provider {
    async fn prepare(&self) -> Result<(ConnectConfig, ManagedSession), SshError> {
        let n = self.preparations.fetch_add(1, Ordering::SeqCst) + 1;
        Ok((
            ConnectConfig {
                host: "127.0.0.1".into(),
                port: self.port,
                username: format!("zt1:{n}"),
                auth_methods: vec![AuthMethod::Password(format!("ticket-{n}"))],
                host_key_policy: HostKeyPolicy::PinnedFingerprint(self.fingerprint.clone()),
                connect_timeout: Some(Duration::from_secs(5)),
            },
            ManagedSession {
                connection_id: format!("connection-{n}"),
                asset_name: "Target A".into(),
                account: "deploy".into(),
                capabilities: self.caps.clone(),
                cancelled: self.cancel.clone(),
            },
        ))
    }
    async fn failure(&self, _: &str) -> String {
        "AUTH_OR_GATEWAY_FAILED".into()
    }
}
fn config(provider: Arc<Provider>) -> ConnectConfig {
    ConnectConfig {
        host: "never-dial-this.invalid".into(),
        port: 22,
        username: "deploy".into(),
        auth_methods: vec![AuthMethod::Managed(provider)],
        host_key_policy: HostKeyPolicy::AcceptAll,
        connect_timeout: None,
    }
}

/// What the gateway granted on the server side, independent of the client's
/// own capability check, so tests can prove the gateway refusal is handled.
#[derive(Clone, Default)]
struct Grants {
    exec: bool,
    sftp: bool,
}
#[derive(Clone, Default)]
struct Counters {
    passwords: Arc<AtomicUsize>,
    channels: Arc<AtomicUsize>,
    execs: Arc<AtomicUsize>,
    sftp_extensions: Arc<Mutex<Vec<String>>>,
}
#[derive(Clone)]
struct Gateway {
    counters: Counters,
    grants: Grants,
    wait_for_eof: Option<ChannelId>,
    open: Arc<Mutex<HashMap<ChannelId, Channel<server::Msg>>>>,
}
impl server::Server for Gateway {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        let mut client = self.clone();
        client.open = Arc::default();
        client
    }
}
impl server::Handler for Gateway {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.counters.passwords.fetch_add(1, Ordering::SeqCst);
        let accepted = user
            .strip_prefix("zt1:")
            .is_some_and(|n| password == format!("ticket-{n}"));
        Ok(if accepted {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.counters.channels.fetch_add(1, Ordering::SeqCst);
        self.open.lock().unwrap().insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        ch: ChannelId,
        name: &str,
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        let channel = self.open.lock().unwrap().remove(&ch);
        match channel {
            Some(channel) if name == "sftp" && self.grants.sftp => {
                s.channel_success(ch)?;
                russh_sftp::server::run(
                    channel.into_stream(),
                    Sftp {
                        extensions: self.counters.sftp_extensions.clone(),
                        listed: Default::default(),
                    },
                )
                .await;
            }
            _ => s.channel_failure(ch)?,
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        ch: ChannelId,
        command: &[u8],
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if !self.grants.exec {
            // RFC-006 §14.1: the gateway refuses the request, the channel stays open.
            return s.channel_failure(ch);
        }
        self.counters.execs.fetch_add(1, Ordering::SeqCst);
        s.channel_success(ch)?;
        if command == b"stdin-eof" {
            self.wait_for_eof = Some(ch);
            return Ok(());
        }
        s.data(ch, b"target stdout".to_vec())?;
        s.extended_data(ch, 1, b"target stderr".to_vec())?;
        // EOF only ends the data stream. Exit metadata may follow it.
        s.eof(ch)?;
        if command == b"signal" {
            s.exit_signal_request(ch, russh::Sig::TERM, false, "terminated", "en")?;
        } else {
            s.exit_status_request(ch, 7)?;
        }
        s.close(ch)?;
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        ch: ChannelId,
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if self.wait_for_eof == Some(ch) {
            self.wait_for_eof = None;
            s.data(ch, vec![0, 255, 10])?;
            s.extended_data(ch, 1, vec![128, 0])?;
            s.eof(ch)?;
            s.exit_status_request(ch, 9)?;
            s.close(ch)?;
        }
        Ok(())
    }
    async fn pty_request(
        &mut self,
        ch: ChannelId,
        _: &str,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        s.channel_success(ch)?;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        ch: ChannelId,
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        s.channel_success(ch)?;
        s.data(ch, "目标 A\r\n".as_bytes().to_vec())?;
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        ch: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
        s.data(ch, format!("{cols}x{rows}").into_bytes())?;
        Ok(())
    }
}

/// Minimal SFTP v3 target behind the gateway. Like the RFC-006 proxy it answers
/// every extension outside the allow-list with OP_UNSUPPORTED.
struct Sftp {
    extensions: Arc<Mutex<Vec<String>>>,
    /// Directory handles that have already returned their entries.
    listed: std::collections::HashSet<String>,
}
impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn init(
        &mut self,
        version: u32,
        _: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        if version != 3 {
            return Err(StatusCode::BadMessage);
        }
        Ok(Version::new())
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        Ok(Name {
            id,
            files: vec![File::dummy(if path == "." { "/home/deploy" } else { &path })],
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        Ok(Handle { id, handle: format!("dir:{path}:{id}") })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        if self.listed.insert(handle) {
            return Ok(Name {
                id,
                files: vec![File::new("app.log", FileAttributes::default())],
            });
        }
        Err(StatusCode::Eof)
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        })
    }
    async fn extended(
        &mut self,
        _: u32,
        request: String,
        _: Vec<u8>,
    ) -> Result<russh_sftp::protocol::Packet, Self::Error> {
        self.extensions.lock().unwrap().push(request);
        Err(StatusCode::OpUnsupported)
    }
}

async fn gateway_with(
    caps: &[&str],
    grants: Grants,
) -> (Arc<Provider>, Counters, tokio::task::JoinHandle<()>) {
    let (key, _) = zeroterm_ssh::generate_ephemeral_ed25519_identity().unwrap();
    let fingerprint = key
        .public_key()
        .fingerprint(russh::keys::HashAlg::Sha256)
        .to_string();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let cfg = Arc::new(server::Config {
        keys: vec![(*key).clone()],
        auth_rejection_time: Duration::ZERO,
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let counters = Counters::default();
    let state = Gateway {
        counters: counters.clone(),
        grants,
        wait_for_eof: None,
        open: Arc::default(),
    };
    let task = tokio::spawn(async move {
        let mut gateway = state;
        let _ = gateway.run_on_socket(cfg, &listener).await;
    });
    (
        Arc::new(Provider {
            port,
            fingerprint,
            preparations: AtomicUsize::new(0),
            cancel: CancellationToken::new(),
            caps: caps.iter().map(|c| c.to_string()).collect(),
        }),
        counters,
        task,
    )
}
async fn gateway(caps: &[&str]) -> (Arc<Provider>, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let grants = Grants {
        exec: caps.contains(&"exec"),
        sftp: caps.contains(&"sftp"),
    };
    let (provider, counters, task) = gateway_with(caps, grants).await;
    (provider, counters.passwords, task)
}
fn is_permission_denied(result: &SshError, capability: &str) -> bool {
    matches!(result, SshError::Managed(m) if m == &format!("CHANNEL_PERMISSION_DENIED: {capability}"))
}

#[tokio::test]
async fn reconnect_resolves_fresh_credentials_exec_drains_eof_and_logout_closes_shell() {
    let (provider, passwords, task) = gateway(&["shell", "exec"]).await;
    let cfg = config(provider.clone());
    let first = Session::connect(cfg.clone()).await.unwrap();
    assert_eq!(
        first.exec("probe").await.unwrap(),
        (7, b"target stdout".to_vec(), b"target stderr".to_vec())
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), first.exec("stdin-eof"))
            .await
            .unwrap()
            .unwrap(),
        (9, vec![0, 255, 10], vec![128, 0])
    );
    assert!(
        matches!(first.exec("signal").await,Err(SshError::ExitSignal(signal)) if signal == "TERM")
    );
    first.disconnect().await.unwrap();
    let mut second = Session::connect(cfg).await.unwrap();
    assert_eq!(provider.preparations.load(Ordering::SeqCst), 2);
    assert_eq!(passwords.load(Ordering::SeqCst), 2);
    let mut shell = second.open_shell(PtySize::new(80, 24)).await.unwrap();
    assert!(matches!(shell.recv().await, ChannelEvent::Data(_)));
    shell.resize(PtySize::new(120, 40)).await.unwrap();
    assert!(matches!(shell.recv().await,ChannelEvent::Data(data) if data==b"120x40"));
    provider.cancel.cancel();
    assert!(second.is_closed());
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(3), shell.recv())
            .await
            .unwrap(),
        ChannelEvent::Closed
    ));
    task.abort();
}

/// RFC-006 §14.2: shell, repeated exec and SFTP share one ticket and one connection.
#[tokio::test]
async fn shell_exec_and_sftp_share_one_ticket_and_connection() {
    let (provider, counters, task) = gateway_with(
        &["shell", "exec", "sftp"],
        Grants { exec: true, sftp: true },
    )
    .await;
    let mut session = Session::connect(config(provider.clone())).await.unwrap();
    let mut shell = session.open_shell(PtySize::new(80, 24)).await.unwrap();
    assert!(matches!(shell.recv().await, ChannelEvent::Data(_)));
    // Periodic server tools: many exec channels, concurrently and in sequence.
    let session = Arc::new(session);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let session = session.clone();
        tasks.push(tokio::spawn(async move { session.exec("metrics").await }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap().unwrap().0, 7);
    }
    for _ in 0..3 {
        assert_eq!(session.exec("metrics").await.unwrap().0, 7);
    }
    let sftp = session.sftp().await.unwrap();
    assert_eq!(sftp.managed_identity().unwrap().connection_id, "connection-1");
    let entries = sftp.list("/var/log").await.unwrap();
    assert_eq!(entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["app.log"]);
    // A second SFTP channel coexists with the first.
    let second = session.sftp().await.unwrap();
    assert_eq!(second.list("/var/log").await.unwrap().len(), 1);
    // The shell is still alive after all the side channels.
    shell.resize(PtySize::new(100, 30)).await.unwrap();
    assert!(matches!(shell.recv().await, ChannelEvent::Data(data) if data == b"100x30"));
    assert_eq!(provider.preparations.load(Ordering::SeqCst), 1, "one ticket");
    assert_eq!(counters.passwords.load(Ordering::SeqCst), 1, "one SSH authentication");
    assert_eq!(counters.execs.load(Ordering::SeqCst), 7);
    assert_eq!(counters.channels.load(Ordering::SeqCst), 1 + 7 + 2);
    // The client relies on no SFTP extension the gateway would reject.
    assert!(counters.sftp_extensions.lock().unwrap().is_empty());
    task.abort();
}

/// The ticket advertises exec/sftp but the gateway refuses the channel request
/// (e.g. capability withdrawn during rollout): a clear error, never a hang.
#[tokio::test]
async fn gateway_refusals_surface_channel_permission_denied_without_hanging() {
    let (provider, _, task) =
        gateway_with(&["shell", "exec", "sftp"], Grants::default()).await;
    let session = Session::connect(config(provider)).await.unwrap();
    let exec = tokio::time::timeout(Duration::from_secs(3), session.exec("metrics"))
        .await
        .expect("refused exec must not hang")
        .unwrap_err();
    assert!(is_permission_denied(&exec, "exec"), "{exec:?}");
    let sftp = tokio::time::timeout(Duration::from_secs(3), session.sftp())
        .await
        .expect("refused sftp must not hang");
    assert!(is_permission_denied(&sftp.err().unwrap(), "sftp"));
    // The connection stays usable after a refusal.
    assert!(!session.is_closed());
    task.abort();
}

#[tokio::test]
async fn managed_exec_rejects_oversized_or_nul_commands_before_opening_a_channel() {
    let (provider, counters, task) =
        gateway_with(&["exec"], Grants { exec: true, sftp: false }).await;
    let session = Session::connect(config(provider)).await.unwrap();
    for command in ["a\0b".to_owned(), "x".repeat(64 * 1024 + 1)] {
        assert!(matches!(
            session.exec(&command).await,
            Err(SshError::Managed(m)) if m.starts_with("INVALID_ARGUMENT")
        ));
    }
    assert_eq!(counters.channels.load(Ordering::SeqCst), 0);
    assert_eq!(session.exec(&"x".repeat(64 * 1024)).await.unwrap().0, 7);
    task.abort();
}

#[tokio::test]
async fn capabilities_reject_exec_sftp_jump_and_every_forward_before_channel_open() {
    let (provider, counters, task) = gateway_with(&["shell"], Grants::default()).await;
    let session = Session::connect(config(provider)).await.unwrap();
    assert!(is_permission_denied(&session.exec("blocked").await.unwrap_err(), "exec"));
    assert!(is_permission_denied(&session.sftp().await.err().unwrap(), "sftp"));
    assert!(
        zeroterm_ssh::forward_local(&session, "127.0.0.1", 0, "localhost".into(), 22)
            .await
            .is_err()
    );
    assert!(
        zeroterm_ssh::forward_remote(&session, "127.0.0.1", 0, "localhost".into(), 22)
            .await
            .is_err()
    );
    assert!(zeroterm_ssh::forward_dynamic(&session, "127.0.0.1", 0)
        .await
        .is_err());
    assert!(session
        .exec_forwarding_agent("blocked", |_, _| {})
        .await
        .is_err());
    let direct = ConnectConfig {
        host: "unreachable.invalid".into(),
        port: 22,
        username: "root".into(),
        auth_methods: vec![AuthMethod::Password("unused".into())],
        host_key_policy: HostKeyPolicy::AcceptAll,
        connect_timeout: None,
    };
    assert!(Session::connect_via(direct, &session).await.is_err());
    assert_eq!(counters.channels.load(Ordering::SeqCst), 0, "rejected locally");
    task.abort();
}

/// Agent-forwarded exec stays refused even when exec itself is granted.
#[tokio::test]
async fn exec_capability_never_enables_agent_forwarding() {
    let (provider, counters, task) =
        gateway_with(&["shell", "exec", "sftp"], Grants { exec: true, sftp: true }).await;
    let session = Session::connect(config(provider)).await.unwrap();
    let err = session
        .exec_forwarding_agent_with_identities("rsync", Vec::new(), |_, _| {})
        .await
        .unwrap_err();
    assert!(matches!(err, SshError::Managed(m) if m.starts_with("CHANNEL_PERMISSION_DENIED")));
    assert_eq!(counters.channels.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn changed_gateway_key_is_rejected_before_submitting_ticket_secret() {
    let (mut provider, passwords, task) = gateway(&["shell"]).await;
    Arc::get_mut(&mut provider).unwrap().fingerprint = "SHA256:wrong".into();
    assert!(Session::connect(config(provider)).await.is_err());
    assert_eq!(passwords.load(Ordering::SeqCst), 0);
    task.abort();
}
