use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{self, Handle, Handler};
use russh::{ChannelId, ChannelMsg, Disconnect};
use russh_keys::key;

use crate::error::SshError;
use crate::host_key::HostKeyPolicy;

/// Authentication credentials. The connection will try each entry in
/// [`ConnectConfig::auth_methods`] in order, accepting the first one the
/// server agrees to.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    Password(String),
    /// Private key on disk. `passphrase` is required if (and only if) the
    /// key is encrypted; pass `None` for unencrypted keys.
    PrivateKey {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// Private key supplied as in-memory PEM/OpenSSH text. Used when the
    /// key material lives in the vault (and therefore travels between
    /// devices) rather than on a single machine's disk.
    PrivateKeyData {
        pem: String,
        passphrase: Option<String>,
    },
    /// Use the running SSH agent ($SSH_AUTH_SOCK on Unix, OpenSSH agent
    /// service named pipe on Windows). Tries every identity the agent
    /// offers, in agent-supplied order.
    Agent,
}

#[derive(Clone)]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_methods: Vec<AuthMethod>,
    /// TCP / handshake inactivity timeout. None = russh default.
    pub connect_timeout: Option<Duration>,
    pub host_key_policy: HostKeyPolicy,
}

impl std::fmt::Debug for ConnectConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_methods", &format!("{} method(s)", self.auth_methods.len()))
            .field("connect_timeout", &self.connect_timeout)
            .field("host_key_policy", &self.host_key_policy)
            .finish()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
    pub pixel_width: u16,
    pub pixel_height: u16,
}

impl PtySize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

/// russh `Handler` carrying the host-key policy and the host coordinates
/// it needs to consult `known_hosts`.
pub(crate) struct ZeroTermHandler {
    policy: HostKeyPolicy,
    host: String,
    port: u16,
}

#[async_trait]
impl Handler for ZeroTermHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match self.policy.evaluate(&self.host, self.port, server_public_key).await {
            Ok(accept) => Ok(accept),
            Err(e) => Err(russh::Error::IO(e)),
        }
    }
}

/// An authenticated SSH session.
pub struct Session {
    handle: Arc<Handle<ZeroTermHandler>>,
}

impl Session {
    pub async fn connect(cfg: ConnectConfig) -> Result<Self, SshError> {
        if cfg.auth_methods.is_empty() {
            return Err(SshError::NoAuthMethod);
        }

        // NOTE: deliberately do NOT set `Config::inactivity_timeout` —
        // that's russh's idle-kill timer, which would tear the session
        // down after that long without SSH-layer traffic. SFTP browsing
        // (and any other request/response flow that sits idle while the
        // user thinks) becomes unusable. The caller's `connect_timeout`
        // is enforced as a real wall-clock timeout around the initial
        // TCP + handshake below instead.
        let config = Arc::new(client::Config::default());

        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
        };

        let addr = (cfg.host.as_str(), cfg.port);
        let connect_fut = client::connect(config, addr, handler);
        let handle = match cfg.connect_timeout {
            Some(t) => match tokio::time::timeout(t, connect_fut).await {
                Ok(res) => res?,
                Err(_) => {
                    return Err(SshError::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("connect timed out after {t:?}"),
                    )));
                }
            },
            None => connect_fut.await?,
        };

        authenticate(handle, &cfg).await
    }

    /// Same as [`Session::connect`], but the underlying TCP transport
    /// is provided by an existing SSH session via `direct-tcpip`. This
    /// is `ssh -J jumpHost target` semantics: SSH-over-SSH for one hop.
    pub async fn connect_via(cfg: ConnectConfig, jump: &Session) -> Result<Self, SshError> {
        if cfg.auth_methods.is_empty() {
            return Err(SshError::NoAuthMethod);
        }

        let channel = jump
            .handle
            .channel_open_direct_tcpip(cfg.host.clone(), cfg.port as u32, "127.0.0.1", 0)
            .await?;
        let stream = channel.into_stream();

        let config = Arc::new(client::Config::default());
        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
        };

        let connect_fut = client::connect_stream(config, stream, handler);
        let handle = match cfg.connect_timeout {
            Some(t) => match tokio::time::timeout(t, connect_fut).await {
                Ok(res) => res?,
                Err(_) => {
                    return Err(SshError::Io(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        format!("connect-via timed out after {t:?}"),
                    )));
                }
            },
            None => connect_fut.await?,
        };

        authenticate(handle, &cfg).await
    }

    /// Cheap clone of the underlying russh handle. Used by long-lived
    /// background tasks (port-forward listeners) that need to open
    /// channels without exclusive access to the `Session`.
    pub(crate) fn handle_clone(&self) -> Arc<Handle<ZeroTermHandler>> {
        Arc::clone(&self.handle)
    }

    /// Open an interactive shell on a freshly allocated PTY.
    pub async fn open_shell(&mut self, size: PtySize) -> Result<ShellChannel, SshError> {
        let channel = self.handle.channel_open_session().await?;

        channel
            .request_pty(
                false,
                "xterm-256color",
                size.cols as u32,
                size.rows as u32,
                size.pixel_width as u32,
                size.pixel_height as u32,
                &[],
            )
            .await?;

        channel.request_shell(false).await?;

        Ok(ShellChannel { inner: channel })
    }

    /// Open an SFTP subsystem on a fresh channel. Returns a wrapper with
    /// the file-management methods we expose to UIs.
    pub async fn sftp(&mut self) -> Result<crate::sftp::Sftp, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| SshError::Sftp(e.to_string()))?;
        Ok(crate::sftp::Sftp::from_session(session))
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await?;
        Ok(())
    }
}

async fn authenticate(
    mut handle: Handle<ZeroTermHandler>,
    cfg: &ConnectConfig,
) -> Result<Session, SshError> {
    let mut last_error: Option<SshError> = None;
    for method in &cfg.auth_methods {
        match try_authenticate(&mut handle, &cfg.username, method).await {
            Ok(true) => return Ok(Session { handle: Arc::new(handle) }),
            Ok(false) => {
                tracing::debug!(method = method_name(method), "auth method rejected");
            }
            Err(e) => {
                tracing::warn!(method = method_name(method), error = %e, "auth method errored");
                last_error = Some(e);
            }
        }
    }
    Err(last_error.unwrap_or(SshError::AuthFailed))
}

async fn try_authenticate(
    handle: &mut Handle<ZeroTermHandler>,
    username: &str,
    method: &AuthMethod,
) -> Result<bool, SshError> {
    match method {
        AuthMethod::Password(pw) => {
            let ok = handle.authenticate_password(username, pw.clone()).await?;
            Ok(ok)
        }
        AuthMethod::PrivateKey { path, passphrase } => {
            let key_pair = russh_keys::load_secret_key(path, passphrase.as_deref())?;
            let ok = handle
                .authenticate_publickey(username, Arc::new(key_pair))
                .await?;
            Ok(ok)
        }
        AuthMethod::PrivateKeyData { pem, passphrase } => {
            let key_pair = russh_keys::decode_secret_key(pem, passphrase.as_deref())?;
            let ok = handle
                .authenticate_publickey(username, Arc::new(key_pair))
                .await?;
            Ok(ok)
        }
        AuthMethod::Agent => crate::agent::try_agent_auth(handle, username).await,
    }
}

fn method_name(m: &AuthMethod) -> &'static str {
    match m {
        AuthMethod::Password(_) => "password",
        AuthMethod::PrivateKey { .. } => "publickey(file)",
        AuthMethod::PrivateKeyData { .. } => "publickey(vault)",
        AuthMethod::Agent => "publickey(agent)",
    }
}

/// A live PTY-backed shell channel.
pub struct ShellChannel {
    inner: russh::Channel<russh::client::Msg>,
}

#[derive(Debug)]
pub enum ChannelEvent {
    /// Stdout / merged stream bytes.
    Data(Vec<u8>),
    /// Stderr bytes (extended data, type 1).
    Stderr(Vec<u8>),
    /// Remote process exited with this status.
    Exit(u32),
    /// Channel closed (EOF / close from remote, or unexpected).
    Closed,
}

impl ShellChannel {
    pub fn id(&self) -> ChannelId {
        self.inner.id()
    }

    pub async fn send(&mut self, data: &[u8]) -> Result<(), SshError> {
        self.inner.data(data).await?;
        Ok(())
    }

    pub async fn resize(&mut self, size: PtySize) -> Result<(), SshError> {
        self.inner
            .window_change(
                size.cols as u32,
                size.rows as u32,
                size.pixel_width as u32,
                size.pixel_height as u32,
            )
            .await?;
        Ok(())
    }

    pub async fn recv(&mut self) -> ChannelEvent {
        loop {
            match self.inner.wait().await {
                None => return ChannelEvent::Closed,
                Some(ChannelMsg::Data { data }) => return ChannelEvent::Data(data.to_vec()),
                Some(ChannelMsg::ExtendedData { data, ext }) => {
                    if ext == 1 {
                        return ChannelEvent::Stderr(data.to_vec());
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    return ChannelEvent::Exit(exit_status);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => return ChannelEvent::Closed,
                Some(_) => {}
            }
        }
    }
}
