use std::path::PathBuf;
use std::sync::Arc;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use std::time::Instant;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh::client::{self, Handle, Handler, Msg};
use russh::{Channel, ChannelId, ChannelMsg, Disconnect};
use russh_keys::key;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use url::Url;

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
            .field(
                "auth_methods",
                &format!("{} method(s)", self.auth_methods.len()),
            )
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
    remote_forward_tx: mpsc::UnboundedSender<RemoteForwardIncoming>,
}

pub(crate) struct RemoteForwardIncoming {
    pub channel: Channel<Msg>,
    pub connected_address: String,
    pub connected_port: u32,
    pub originator_address: String,
    pub originator_port: u32,
}

#[async_trait]
impl Handler for ZeroTermHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match self
            .policy
            .evaluate(&self.host, self.port, server_public_key)
            .await
        {
            Ok(accept) => Ok(accept),
            Err(e) => Err(russh::Error::IO(e)),
        }
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.remote_forward_tx.send(RemoteForwardIncoming {
            channel,
            connected_address: connected_address.to_string(),
            connected_port,
            originator_address: originator_address.to_string(),
            originator_port,
        });
        Ok(())
    }
}

/// An authenticated SSH session.
pub struct Session {
    handle: Arc<Handle<ZeroTermHandler>>,
    remote_forward_rx: Arc<Mutex<mpsc::UnboundedReceiver<RemoteForwardIncoming>>>,
}

static GLOBAL_HTTP_PROXY: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn global_http_proxy() -> &'static RwLock<Option<String>> {
    GLOBAL_HTTP_PROXY.get_or_init(|| RwLock::new(None))
}

pub fn set_global_http_proxy(proxy_url: Option<String>) {
    *global_http_proxy().write().unwrap() = proxy_url
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty());
}

/// The currently-configured global HTTP proxy URL, if any. Returned to
/// consumers (e.g. the S3 sync adapter) that build their own HTTP clients
/// and must route them through the same proxy the SSH transport uses.
pub fn current_http_proxy() -> Option<String> {
    global_http_proxy().read().unwrap().clone()
}

#[derive(Debug, Clone)]
struct HttpProxyConfig {
    host: String,
    port: u16,
    auth_header: Option<String>,
}

fn parse_http_proxy_url(proxy_url: &str) -> Result<HttpProxyConfig, SshError> {
    let parsed = Url::parse(proxy_url).map_err(|e| {
        SshError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("invalid proxy url: {e}"),
        ))
    })?;
    if parsed.scheme() != "http" {
        return Err(SshError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "only http:// proxies are supported for SSH transports",
        )));
    }
    let host = parsed.host_str().ok_or_else(|| {
        SshError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "proxy url is missing a host",
        ))
    })?;
    let port = parsed.port_or_known_default().ok_or_else(|| {
        SshError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "proxy url is missing a port",
        ))
    })?;
    let auth_header = if parsed.username().is_empty() {
        None
    } else {
        let raw = format!(
            "{}:{}",
            parsed.username(),
            parsed.password().unwrap_or_default()
        );
        Some(format!("Basic {}", B64.encode(raw.as_bytes())))
    };
    Ok(HttpProxyConfig {
        host: host.to_string(),
        port,
        auth_header,
    })
}

fn format_connect_target(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') && !host.ends_with(']') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

async fn connect_tcp_via_http_proxy(
    cfg: &ConnectConfig,
    proxy_url: &str,
) -> Result<TcpStream, SshError> {
    let proxy = parse_http_proxy_url(proxy_url)?;
    let connect_fut = TcpStream::connect((proxy.host.as_str(), proxy.port));
    let mut stream = match cfg.connect_timeout {
        Some(t) => match tokio::time::timeout(t, connect_fut).await {
            Ok(res) => res?,
            Err(_) => {
                return Err(SshError::Io(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    format!("proxy connect timed out after {t:?}"),
                )));
            }
        },
        None => connect_fut.await?,
    };

    let target = format_connect_target(&cfg.host, cfg.port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(auth) = proxy.auth_header.as_deref() {
        request.push_str(&format!("Proxy-Authorization: {auth}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes()).await?;

    let mut response = Vec::with_capacity(1024);
    let mut byte = [0_u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            return Err(SshError::Io(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "proxy closed the CONNECT tunnel before responding",
            )));
        }
        response.push(byte[0]);
        if response.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if response.len() > 16 * 1024 {
            return Err(SshError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proxy CONNECT response headers are too large",
            )));
        }
    }

    let header_end = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|idx| idx + 4)
        .ok_or_else(|| {
            SshError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "proxy CONNECT response was malformed",
            ))
        })?;
    let headers = String::from_utf8_lossy(&response[..header_end]);
    let status_line = headers.lines().next().unwrap_or_default();
    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            SshError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("proxy CONNECT response missing status code: {status_line}"),
            ))
        })?;
    if status_code != 200 {
        return Err(SshError::Io(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("proxy CONNECT failed: {status_line}"),
        )));
    }
    Ok(stream)
}

/// Shared russh client config for both direct and jump-host connections.
///
/// We enable SSH-level keepalive (`keepalive@openssh.com`, sent every 30s).
/// Without it russh sends nothing on an idle connection, so NAT/firewall idle
/// timeouts silently reap long-lived sessions — most visibly standalone port
/// forwards, which can sit idle for minutes and then "randomly" drop. After
/// `keepalive_max` consecutive unanswered probes the link is declared dead and
/// torn down promptly instead of hanging, matching OpenSSH's
/// `ServerAliveInterval=30` / `ServerAliveCountMax=3`.
///
/// We still leave `inactivity_timeout` unset on purpose (see `connect`): that
/// is russh's idle-*kill* timer and would defeat the whole point.
fn client_config() -> client::Config {
    client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    }
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
        let config = Arc::new(client_config());

        let (remote_forward_tx, remote_forward_rx) = mpsc::unbounded_channel();
        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
            remote_forward_tx,
        };

        let handle = if let Some(proxy_url) = current_http_proxy() {
            let stream = connect_tcp_via_http_proxy(&cfg, &proxy_url).await?;
            let connect_fut = client::connect_stream(config, stream, handler);
            match cfg.connect_timeout {
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
            }
        } else {
            let addr = (cfg.host.as_str(), cfg.port);
            let connect_fut = client::connect(config, addr, handler);
            match cfg.connect_timeout {
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
            }
        };

        authenticate(handle, &cfg, remote_forward_rx).await
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

        let config = Arc::new(client_config());
        let (remote_forward_tx, remote_forward_rx) = mpsc::unbounded_channel();
        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
            remote_forward_tx,
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

        authenticate(handle, &cfg, remote_forward_rx).await
    }

    /// Cheap clone of the underlying russh handle. Used by long-lived
    /// background tasks (port-forward listeners) that need to open
    /// channels without exclusive access to the `Session`.
    pub(crate) fn handle_clone(&self) -> Arc<Handle<ZeroTermHandler>> {
        Arc::clone(&self.handle)
    }

    /// True once the underlying russh client loop has ended — i.e. the
    /// connection is gone (disconnect, transport error, or keepalive
    /// timeout). Long-lived supervisors (e.g. port forwards) poll this to
    /// notice a passive disconnect and reconnect.
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub(crate) async fn tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
    ) -> Result<u32, SshError> {
        let handle = Arc::get_mut(&mut self.handle).ok_or_else(|| {
            SshError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "cannot request remote forward after SSH handle was cloned",
            ))
        })?;
        Ok(handle.tcpip_forward(address.to_string(), port).await?)
    }

    pub(crate) fn remote_forward_receiver(
        &self,
    ) -> Arc<Mutex<mpsc::UnboundedReceiver<RemoteForwardIncoming>>> {
        Arc::clone(&self.remote_forward_rx)
    }

    /// Open an interactive shell on a freshly allocated PTY.
    pub async fn open_shell(&mut self, size: PtySize) -> Result<ShellChannel, SshError> {
        let channel = self.handle.channel_open_session().await?;

        channel
            .request_pty(
                true,
                "xterm-256color",
                size.cols as u32,
                size.rows as u32,
                size.pixel_width as u32,
                size.pixel_height as u32,
                &[],
            )
            .await?;

        channel.request_shell(true).await?;

        Ok(ShellChannel { inner: channel })
    }

    /// Open an SFTP subsystem on a fresh channel. Returns a wrapper with
    /// the file-management methods we expose to UIs.
    pub async fn sftp(&mut self) -> Result<crate::sftp::Sftp, SshError> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let session = russh_sftp::client::SftpSession::new_with_config(
            channel.into_stream(),
            russh_sftp::client::Config {
                max_packet_len: 1024 * 1024,
                max_concurrent_writes: 16,
                // Per-request timeout. 30s was too aggressive for slow
                // servers and large directory listings — a timed-out
                // request leaves an orphaned response that desyncs the
                // SFTP channel, and the user sees "io error: Timeout"
                // followed by a cascade of failures that looks like a
                // disconnect. 120s gives overloaded servers room to
                // breathe while still catching genuinely hung requests.
                // Truly dead connections are detected by the SSH
                // keepalive (30s interval, 3 misses = 90s) and by the
                // transfer-level idle watchdog in the Tauri layer.
                request_timeout_secs: 120,
            },
        )
        .await
        .map_err(|e| SshError::Sftp(e.to_string()))?;
        Ok(crate::sftp::Sftp::from_session(session))
    }

    /// Execute a non-interactive command and collect stdout/stderr.
    pub async fn exec(&mut self, command: &str) -> Result<(u32, Vec<u8>, Vec<u8>), SshError> {
        let mut channel = self.handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut code = 0;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext } if ext == 1 => {
                    stderr.extend_from_slice(&data)
                }
                ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
        Ok((code, stdout, stderr))
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        self.handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await?;
        Ok(())
    }

    /// Lightweight RTT probe against the SSH transport.
    ///
    /// Opens a session channel, then immediately closes it so the server
    /// frees the slot. Without the explicit `close()` the server keeps
    /// the channel open from its side (we only drop the local handle), so
    /// repeated probes pile up against `MaxSessions` until new opens fail.
    pub async fn probe_rtt_ms(&self) -> Result<u32, SshError> {
        let start = Instant::now();
        let channel = self.handle.channel_open_session().await?;
        // Best-effort close — failure here just means the server side will
        // clean up later, which is still better than leaking the slot.
        let _ = channel.close().await;
        Ok(start.elapsed().as_millis().min(u32::MAX as u128) as u32)
    }
}

async fn authenticate(
    mut handle: Handle<ZeroTermHandler>,
    cfg: &ConnectConfig,
    remote_forward_rx: mpsc::UnboundedReceiver<RemoteForwardIncoming>,
) -> Result<Session, SshError> {
    let mut last_error: Option<SshError> = None;
    for method in &cfg.auth_methods {
        match try_authenticate(&mut handle, &cfg.username, method).await {
            Ok(true) => {
                return Ok(Session {
                    handle: Arc::new(handle),
                    remote_forward_rx: Arc::new(Mutex::new(remote_forward_rx)),
                })
            }
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
