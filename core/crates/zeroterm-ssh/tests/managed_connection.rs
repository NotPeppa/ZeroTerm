//! In-process SSH protocol checks for RFC-004 managed connections.
use async_trait::async_trait;
use russh::{server, server::Server as _, Channel, ChannelId};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
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
#[derive(Clone)]
struct Gateway {
    passwords: Arc<AtomicUsize>,
    wait_for_eof: Option<ChannelId>,
}
impl server::Server for Gateway {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for Gateway {
    type Error = russh::Error;
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        self.passwords.fetch_add(1, Ordering::SeqCst);
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
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn exec_request(
        &mut self,
        ch: ChannelId,
        command: &[u8],
        s: &mut server::Session,
    ) -> Result<(), Self::Error> {
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
async fn gateway(caps: &[&str]) -> (Arc<Provider>, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
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
    let passwords = Arc::new(AtomicUsize::new(0));
    let state = Gateway {
        passwords: passwords.clone(),
        wait_for_eof: None,
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
        passwords,
        task,
    )
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
#[tokio::test]
async fn capabilities_reject_exec_sftp_jump_and_every_forward_before_channel_open() {
    let (provider, _, task) = gateway(&["shell"]).await;
    let session = Session::connect(config(provider)).await.unwrap();
    assert!(matches!(
        session.exec("blocked").await,
        Err(SshError::Managed(_))
    ));
    assert!(matches!(session.sftp().await, Err(SshError::Managed(_))));
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
