use std::borrow::Cow;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::sync::{OnceLock, RwLock};
use std::time::Duration;
use std::time::Instant;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use russh::client::{self, Handle, Handler, Msg};
use russh::keys::{Algorithm, Certificate, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelId, ChannelMsg, Disconnect};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Mutex};
use url::Url;
use zeroize::Zeroize;

use crate::error::SshError;
use crate::host_key::HostKeyPolicy;
use crate::sftp::map_sftp_err;

/// Authentication credentials. The connection will try each entry in
/// [`ConnectConfig::auth_methods`] in order, accepting the first one the
/// server agrees to.
///
/// `Debug` is hand-written (not derived) so a stray `{:?}` — e.g. a
/// future `tracing::debug!(?auth)` — can never print a password,
/// passphrase, or private-key PEM. Only the variant and non-secret
/// shape (the key path) are shown. See SSH-14.
#[derive(Clone)]
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

impl std::fmt::Debug for AuthMethod {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthMethod::Password(_) => f.write_str("Password(<redacted>)"),
            AuthMethod::PrivateKey { path, passphrase } => f
                .debug_struct("PrivateKey")
                .field("path", path)
                .field(
                    "passphrase",
                    &if passphrase.is_some() {
                        "<redacted>"
                    } else {
                        "None"
                    },
                )
                .finish(),
            AuthMethod::PrivateKeyData { passphrase, .. } => f
                .debug_struct("PrivateKeyData")
                .field("pem", &"<redacted>")
                .field(
                    "passphrase",
                    &if passphrase.is_some() {
                        "<redacted>"
                    } else {
                        "None"
                    },
                )
                .finish(),
            AuthMethod::Agent => f.write_str("Agent"),
        }
    }
}

impl Drop for AuthMethod {
    fn drop(&mut self) {
        match self {
            Self::Password(password) => password.zeroize(),
            Self::PrivateKey { passphrase, .. } => passphrase.zeroize(),
            Self::PrivateKeyData { pem, passphrase } => {
                pem.zeroize();
                passphrase.zeroize();
            }
            Self::Agent => {}
        }
    }
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

/// Which of a command's two output streams a chunk came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecStream {
    Stdout,
    Stderr,
}

/// russh `Handler` carrying the host-key policy and the host coordinates
/// it needs to consult `known_hosts`.
pub(crate) struct ZeroTermHandler {
    policy: HostKeyPolicy,
    host: String,
    port: u16,
    remote_forward_tx: mpsc::UnboundedSender<RemoteForwardIncoming>,
    /// Number of operations currently allowed to reach the local SSH agent
    /// through this session. Agent forwarding hands the remote host the
    /// ability to authenticate *as you* for as long as it is on, so it stays
    /// off by default and is granted only for the span of a command that
    /// needs it (see [`Session::exec_forwarding_agent`]). A counter rather
    /// than a flag so overlapping transfers on a pooled session can't have
    /// the first one to finish revoke the second one's grant.
    agent_forward_grants: Arc<AtomicUsize>,
    /// Identities currently lent to forwarded agent channels. When
    /// non-empty, an opened agent channel is answered by an in-process
    /// agent offering exactly these keys (vault credentials for a specific
    /// destination) instead of proxying the user's whole system agent —
    /// see [`Session::exec_forwarding_agent_with_identities`].
    forward_identities: ForwardIdentities,
}

/// Keys lent to the forwarded agent channel, shared between [`Session`]
/// and its [`ZeroTermHandler`]. Guarded by a std mutex: touched only to
/// push/remove/snapshot, never held across an await.
pub(crate) type ForwardIdentities = Arc<std::sync::Mutex<Vec<Arc<PrivateKey>>>>;

/// Keeps agent forwarding enabled for as long as it is alive. Revokes on
/// drop, including when the guarded future is cancelled or errors out.
pub(crate) struct AgentForwardGrant(Arc<AtomicUsize>);

impl AgentForwardGrant {
    fn new(grants: Arc<AtomicUsize>) -> Self {
        grants.fetch_add(1, AtomicOrdering::SeqCst);
        Self(grants)
    }
}

impl Drop for AgentForwardGrant {
    fn drop(&mut self) {
        self.0.fetch_sub(1, AtomicOrdering::SeqCst);
    }
}

/// Adds keys to [`ForwardIdentities`] for its lifetime and removes exactly
/// those keys on drop (including cancellation), so overlapping operations
/// on a pooled session can't revoke one another's identities.
struct IdentityLease {
    list: ForwardIdentities,
    added: Vec<Arc<PrivateKey>>,
}

impl IdentityLease {
    fn new(list: ForwardIdentities, keys: Vec<Arc<PrivateKey>>) -> Self {
        if !keys.is_empty() {
            list.lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(keys.iter().cloned());
        }
        Self { list, added: keys }
    }
}

impl Drop for IdentityLease {
    fn drop(&mut self) {
        if self.added.is_empty() {
            return;
        }
        let mut list = self
            .list
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for key in &self.added {
            if let Some(pos) = list.iter().position(|k| Arc::ptr_eq(k, key)) {
                list.swap_remove(pos);
            }
        }
    }
}

pub(crate) struct RemoteForwardIncoming {
    pub channel: Channel<Msg>,
    pub connected_address: String,
    pub connected_port: u32,
    pub originator_address: String,
    pub originator_port: u32,
}

type RemoteForwardKey = (String, u32);
type RouteMap<T> = Arc<Mutex<HashMap<RemoteForwardKey, mpsc::UnboundedSender<T>>>>;
type RemoteForwardRoutes = RouteMap<RemoteForwardIncoming>;
pub(crate) type SharedHandle = Arc<Mutex<Handle<ZeroTermHandler>>>;

/// A dedicated stream for one successful `tcpip-forward` request.
///
/// There is exactly one dispatcher per SSH session. It consumes russh's
/// single `forwarded-tcpip` callback stream and routes each channel by the
/// server-reported `(connected_address, connected_port)`. Giving each `-R`
/// listener its own receiver prevents concurrent remote forwards from
/// stealing and dropping one another's channels (SSH-5).
pub(crate) struct RemoteForwardSubscription {
    address: String,
    port: u32,
    incoming: mpsc::UnboundedReceiver<RemoteForwardIncoming>,
    handle: SharedHandle,
    routes: RemoteForwardRoutes,
}

impl RemoteForwardSubscription {
    pub(crate) fn port(&self) -> u32 {
        self.port
    }

    pub(crate) async fn recv(&mut self) -> Option<RemoteForwardIncoming> {
        self.incoming.recv().await
    }

    /// Stop the server-side listener and remove this route. Cancellation is
    /// best-effort because the underlying transport may already be closed.
    pub(crate) async fn close(self, cancel_server_listener: bool) {
        if cancel_server_listener {
            let handle = self.handle.lock().await;
            let _ = handle
                .cancel_tcpip_forward(self.address.clone(), self.port)
                .await;
        }
        self.routes.lock().await.remove(&(self.address, self.port));
    }
}

/// russh's `Handler` uses native `async fn` (no `#[async_trait]`).
impl Handler for ZeroTermHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
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

    async fn check_server_certificate(
        &mut self,
        server_certificate: &Certificate,
    ) -> Result<bool, Self::Error> {
        self.policy
            .evaluate_certificate(&self.host, self.port, server_certificate)
            .map_err(russh::Error::IO)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let _ = self.remote_forward_tx.send(RemoteForwardIncoming {
            channel,
            connected_address: connected_address.to_string(),
            connected_port,
            originator_address: originator_address.to_string(),
            originator_port,
        });
        Ok(())
    }

    /// Serve the local SSH agent to a remote that we granted forwarding to.
    ///
    /// russh's default implementation accepts unconditionally and then drops
    /// the channel, so this override matters in both directions: it refuses
    /// the channel outright on sessions that never asked for forwarding, and
    /// actually proxies the agent protocol on the ones that did.
    ///
    /// A failure here (no agent running, agent closed the socket) only kills
    /// this one channel — the remote sees its agent request fail, which for
    /// an `ssh`/`scp` invocation means falling back to its other auth
    /// methods. The SSH session itself stays healthy.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: Channel<Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if self.agent_forward_grants.load(AtomicOrdering::SeqCst) == 0 {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        reply.accept().await;

        // Two credential sources, strictly ordered: identities explicitly
        // lent for this operation (vault keys scoped to one destination)
        // win; only when none were lent do we fall back to proxying the
        // user's whole system agent. Serving the lent set in-process keeps
        // the far host from ever seeing identities beyond the one the
        // operation needs.
        let lent = self
            .forward_identities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if !lent.is_empty() {
            tokio::spawn(async move {
                let stream = channel.into_stream();
                if let Err(e) = russh::keys::agent::server::serve_stream(stream, lent).await {
                    tracing::debug!(error = %e, "in-process agent channel closed");
                }
            });
            return Ok(());
        }

        tokio::spawn(async move {
            let mut agent = match crate::agent::connect_local_agent().await {
                Ok(agent) => agent,
                Err(e) => {
                    tracing::warn!(error = %e, "agent forwarding requested but no local agent");
                    return;
                }
            };
            let mut stream = channel.into_stream();
            if let Err(e) = tokio::io::copy_bidirectional(&mut stream, &mut agent).await {
                tracing::debug!(error = %e, "forwarded agent channel closed");
            }
        });
        Ok(())
    }
}

/// An authenticated SSH session.
#[derive(Clone)]
pub struct Session {
    // Global requests and channel opens share one connection handle. An async mutex
    // gives both paths safe shared access and removes the old `Arc::get_mut`
    // ordering failure when `-L`/`-D` cloned the handle before `-R` (SSH-4).
    handle: SharedHandle,
    remote_forward_routes: RemoteForwardRoutes,
    /// Shared with this session's `ZeroTermHandler`; see the field there.
    agent_forward_grants: Arc<AtomicUsize>,
    /// Shared with this session's `ZeroTermHandler`; see the field there.
    forward_identities: ForwardIdentities,
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
    let mut config = client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        ..Default::default()
    };
    let certificate_algorithms = [
        "ssh-ed25519-cert-v01@openssh.com",
        "ecdsa-sha2-nistp256-cert-v01@openssh.com",
        "ecdsa-sha2-nistp384-cert-v01@openssh.com",
        "ecdsa-sha2-nistp521-cert-v01@openssh.com",
        "rsa-sha2-512-cert-v01@openssh.com",
        "rsa-sha2-256-cert-v01@openssh.com",
        "ssh-rsa-cert-v01@openssh.com",
    ];
    let mut host_key_algorithms = certificate_algorithms
        .into_iter()
        .map(|name| Algorithm::new(name).expect("valid OpenSSH certificate algorithm"))
        .collect::<Vec<_>>();
    host_key_algorithms.extend(config.preferred.key.iter().cloned());
    config.preferred.key = Cow::Owned(host_key_algorithms);
    config
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
        let agent_forward_grants = Arc::new(AtomicUsize::new(0));
        let forward_identities: ForwardIdentities = Arc::default();
        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
            remote_forward_tx,
            agent_forward_grants: Arc::clone(&agent_forward_grants),
            forward_identities: Arc::clone(&forward_identities),
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

        authenticate(
            handle,
            &cfg,
            remote_forward_rx,
            agent_forward_grants,
            forward_identities,
        )
        .await
    }

    /// Same as [`Session::connect`], but the underlying TCP transport
    /// is provided by an existing SSH session via `direct-tcpip`. This
    /// is `ssh -J jumpHost target` semantics: SSH-over-SSH for one hop.
    pub async fn connect_via(cfg: ConnectConfig, jump: &Session) -> Result<Self, SshError> {
        if cfg.auth_methods.is_empty() {
            return Err(SshError::NoAuthMethod);
        }

        let channel = {
            let handle = jump.handle.lock().await;
            handle
                .channel_open_direct_tcpip(cfg.host.clone(), cfg.port as u32, "127.0.0.1", 0)
                .await?
        };
        let stream = channel.into_stream();

        let config = Arc::new(client_config());
        let (remote_forward_tx, remote_forward_rx) = mpsc::unbounded_channel();
        let agent_forward_grants = Arc::new(AtomicUsize::new(0));
        let forward_identities: ForwardIdentities = Arc::default();
        let handler = ZeroTermHandler {
            policy: cfg.host_key_policy.clone(),
            host: cfg.host.clone(),
            port: cfg.port,
            remote_forward_tx,
            agent_forward_grants: Arc::clone(&agent_forward_grants),
            forward_identities: Arc::clone(&forward_identities),
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

        authenticate(
            handle,
            &cfg,
            remote_forward_rx,
            agent_forward_grants,
            forward_identities,
        )
        .await
    }

    /// Cheap clone of the underlying russh handle. Used by long-lived
    /// background tasks (port-forward listeners) that need to open
    /// channels without exclusive access to the `Session`.
    pub(crate) fn handle_clone(&self) -> SharedHandle {
        Arc::clone(&self.handle)
    }

    /// True once the underlying russh client loop has ended — i.e. the
    /// connection is gone (disconnect, transport error, or keepalive
    /// timeout). Long-lived supervisors (e.g. port forwards) poll this to
    /// notice a passive disconnect and reconnect.
    pub fn is_closed(&self) -> bool {
        // Channel/global requests hold the async mutex only until russh
        // confirms the open. If a health poll lands during that brief window,
        // report "not known closed" and let the next poll decide.
        self.handle
            .try_lock()
            .map(|handle| handle.is_closed())
            .unwrap_or(false)
    }

    pub(crate) async fn request_remote_forward(
        &self,
        address: &str,
        port: u32,
    ) -> Result<RemoteForwardSubscription, SshError> {
        // Reject an exact duplicate before touching the server. Port zero is
        // resolved by the server, so its effective key is checked below.
        if port != 0
            && self
                .remote_forward_routes
                .lock()
                .await
                .contains_key(&(address.to_string(), port))
        {
            return Err(SshError::Io(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("remote forward {address}:{port} is already active"),
            )));
        }

        let allocated = {
            let handle = self.handle.lock().await;
            handle.tcpip_forward(address.to_string(), port).await?
        };
        let effective_port = if port == 0 { allocated } else { port };
        let (tx, rx) = mpsc::unbounded_channel();
        let key = (address.to_string(), effective_port);
        let mut routes = self.remote_forward_routes.lock().await;
        match routes.entry(key.clone()) {
            Entry::Vacant(entry) => {
                entry.insert(tx);
            }
            Entry::Occupied(_) => {
                // This should only be possible if a server incorrectly hands
                // the same allocated port to two port-zero requests. Preserve
                // the existing route and cancel only our new request.
                drop(routes);
                let handle = self.handle.lock().await;
                let _ = handle
                    .cancel_tcpip_forward(address.to_string(), effective_port)
                    .await;
                return Err(SshError::Io(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "remote forward {}:{} is already active",
                        address, effective_port
                    ),
                )));
            }
        }
        drop(routes);

        Ok(RemoteForwardSubscription {
            address: address.to_string(),
            port: effective_port,
            incoming: rx,
            handle: Arc::clone(&self.handle),
            routes: Arc::clone(&self.remote_forward_routes),
        })
    }

    /// Open an interactive shell on a freshly allocated PTY.
    pub async fn open_shell(&mut self, size: PtySize) -> Result<ShellChannel, SshError> {
        let channel = {
            let handle = self.handle.lock().await;
            handle.channel_open_session().await?
        };

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
    pub async fn sftp(&self) -> Result<crate::sftp::Sftp, SshError> {
        self.sftp_tuned(crate::sftp::SftpTuning::default()).await
    }

    /// [`Self::sftp`] with an explicit upload tier. The pipeline depth and
    /// packet ceiling are negotiated once, at channel creation, so a caller
    /// that needs to drop to [`SftpTuning::CONSERVATIVE`] after a stall
    /// (see [`crate::sftp::is_upload_stall`]) has to open a new channel.
    pub async fn sftp_tuned(
        &self,
        tuning: crate::sftp::SftpTuning,
    ) -> Result<crate::sftp::Sftp, SshError> {
        let channel = {
            let handle = self.handle.lock().await;
            handle.channel_open_session().await?
        };
        channel.request_subsystem(true, "sftp").await?;
        let session = russh_sftp::client::SftpSession::new_with_config(
            channel.into_stream(),
            russh_sftp::client::Config {
                // Only binds servers that don't advertise
                // `limits@openssh.com`; the ones that do hand us their own
                // read/write lengths, which russh-sftp prefers over this.
                max_packet_len: tuning.max_packet_len,
                max_concurrent_writes: tuning.max_concurrent_writes,
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
        .map_err(map_sftp_err)?;
        Ok(crate::sftp::Sftp::from_session(session, tuning))
    }

    /// Execute a non-interactive command and collect stdout/stderr.
    pub async fn exec(&self, command: &str) -> Result<(u32, Vec<u8>, Vec<u8>), SshError> {
        let mut channel = {
            let handle = self.handle.lock().await;
            handle.channel_open_session().await?
        };
        channel.exec(true, command).await?;

        let mut code = 0;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
        Ok((code, stdout, stderr))
    }

    /// Execute `command` with the local SSH agent forwarded to it, streaming
    /// output to `on_output` as it arrives instead of buffering the lot.
    ///
    /// This is what lets a remote-to-remote copy run entirely between the two
    /// servers: the `scp`/`rsync` we start on this host authenticates to the
    /// far host with *your* keys, over a channel this session proxies back to
    /// your agent. Forwarding is granted only for the lifetime of the returned
    /// future — see [`ZeroTermHandler::agent_forward_grants`].
    ///
    /// Streaming matters for progress: `rsync --info=progress2` reports on
    /// stdout as it goes, and a buffered read would surface all of it at the
    /// end. Returns the command's exit status.
    ///
    /// Note that agent forwarding lets anyone with root on this host use your
    /// keys while the command runs. Only call it for hosts the user has
    /// deliberately targeted.
    pub async fn exec_forwarding_agent<F>(
        &self,
        command: &str,
        on_output: F,
    ) -> Result<u32, SshError>
    where
        F: FnMut(ExecStream, &[u8]) + Send,
    {
        self.exec_forwarding_agent_with_identities(command, Vec::new(), on_output)
            .await
    }

    /// [`Self::exec_forwarding_agent`], but the forwarded agent channel is
    /// answered in-process with exactly `identities` instead of proxying the
    /// system agent. This is how vault-stored keys work for server-to-server
    /// copies: the key never leaves this machine and the far host sees only
    /// the identity the operation needs — strictly less exposure than
    /// lending the whole system agent. An empty `identities` falls back to
    /// the system agent proxy.
    ///
    /// The lease lasts for the lifetime of the returned future; overlapping
    /// calls on a pooled session each add and remove their own keys.
    pub async fn exec_forwarding_agent_with_identities<F>(
        &self,
        command: &str,
        identities: Vec<Arc<PrivateKey>>,
        mut on_output: F,
    ) -> Result<u32, SshError>
    where
        F: FnMut(ExecStream, &[u8]) + Send,
    {
        let _grant = AgentForwardGrant::new(Arc::clone(&self.agent_forward_grants));
        let _lease = IdentityLease::new(Arc::clone(&self.forward_identities), identities);

        let mut channel = {
            let handle = self.handle.lock().await;
            handle.channel_open_session().await?
        };
        // Must precede `exec`: the server binds the forwarding request to the
        // session channel before the command's environment is set up.
        channel.agent_forward(true).await?;
        channel.exec(true, command).await?;

        let mut code = 0;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => on_output(ExecStream::Stdout, &data),
                ChannelMsg::ExtendedData { data, ext: 1 } => on_output(ExecStream::Stderr, &data),
                ChannelMsg::ExitStatus { exit_status } => code = exit_status,
                ChannelMsg::Close | ChannelMsg::Eof => break,
                _ => {}
            }
        }
        Ok(code)
    }

    pub async fn disconnect(self) -> Result<(), SshError> {
        let handle = self.handle.lock().await;
        handle
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
        let channel = {
            let handle = self.handle.lock().await;
            handle.channel_open_session().await?
        };
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
    agent_forward_grants: Arc<AtomicUsize>,
    forward_identities: ForwardIdentities,
) -> Result<Session, SshError> {
    let mut last_error: Option<SshError> = None;
    for method in &cfg.auth_methods {
        match try_authenticate(&mut handle, &cfg.username, method).await {
            Ok(true) => {
                let handle = Arc::new(Mutex::new(handle));
                let routes = Arc::new(Mutex::new(HashMap::new()));
                tokio::spawn(dispatch_remote_forwards(
                    remote_forward_rx,
                    Arc::clone(&routes),
                ));
                return Ok(Session {
                    handle,
                    remote_forward_routes: routes,
                    agent_forward_grants,
                    forward_identities,
                });
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

async fn dispatch_remote_forwards(
    mut incoming: mpsc::UnboundedReceiver<RemoteForwardIncoming>,
    routes: RemoteForwardRoutes,
) {
    while let Some(item) = incoming.recv().await {
        let key = (item.connected_address.clone(), item.connected_port);
        match deliver_to_route(&routes, key.clone(), item).await {
            RouteDelivery::Delivered => {}
            RouteDelivery::ReceiverClosed => {
                tracing::warn!(
                    address = %key.0,
                    port = key.1,
                    "remote forward route receiver closed; dropping incoming channel"
                );
            }
            RouteDelivery::Missing => {
                tracing::warn!(
                    address = %key.0,
                    port = key.1,
                    "no registered remote forward route; dropping incoming channel"
                );
            }
        }
    }
    routes.lock().await.clear();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RouteDelivery {
    Delivered,
    ReceiverClosed,
    Missing,
}

async fn deliver_to_route<T>(
    routes: &RouteMap<T>,
    key: RemoteForwardKey,
    item: T,
) -> RouteDelivery {
    let route = routes.lock().await.get(&key).cloned();
    match route {
        Some(tx) if tx.send(item).is_ok() => RouteDelivery::Delivered,
        Some(_) => {
            routes.lock().await.remove(&key);
            RouteDelivery::ReceiverClosed
        }
        None => RouteDelivery::Missing,
    }
}

async fn try_authenticate(
    handle: &mut Handle<ZeroTermHandler>,
    username: &str,
    method: &AuthMethod,
) -> Result<bool, SshError> {
    match method {
        AuthMethod::Password(pw) => {
            // russh 0.54: auth methods return an `AuthResult`, not a bool.
            Ok(handle
                .authenticate_password(username, pw.clone())
                .await?
                .success())
        }
        AuthMethod::PrivateKey { path, passphrase } => {
            let key = russh::keys::load_secret_key(path, passphrase.as_deref())?;
            let hash_alg = best_rsa_hash(handle).await;
            Ok(handle
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await?
                .success())
        }
        AuthMethod::PrivateKeyData { pem, passphrase } => {
            let key = russh::keys::decode_secret_key(pem, passphrase.as_deref())?;
            let hash_alg = best_rsa_hash(handle).await;
            Ok(handle
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg),
                )
                .await?
                .success())
        }
        AuthMethod::Agent => crate::agent::try_agent_auth(handle, username).await,
    }
}

/// Negotiate the RSA signature hash the server supports (russh 0.54).
/// Modern servers advertise `rsa-sha2-256`/`rsa-sha2-512` via the
/// `server-sig-algs` extension; using the negotiated hash avoids the
/// legacy SHA-1 `ssh-rsa` that many servers now reject. `None` (fall back
/// to SHA-1) only when the server sent no extension or the query failed —
/// and it's ignored for non-RSA keys anyway.
pub(crate) async fn best_rsa_hash(
    handle: &Handle<ZeroTermHandler>,
) -> Option<russh::keys::HashAlg> {
    handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn remote_forward_routes_deliver_to_the_matching_listener_only() {
        let routes: RouteMap<&'static str> = Arc::new(Mutex::new(HashMap::new()));
        let (a_tx, mut a_rx) = mpsc::unbounded_channel();
        let (b_tx, mut b_rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(("127.0.0.1".into(), 2201), a_tx);
        routes.lock().await.insert(("127.0.0.1".into(), 2202), b_tx);

        assert_eq!(
            deliver_to_route(&routes, ("127.0.0.1".into(), 2202), "for-b").await,
            RouteDelivery::Delivered
        );
        assert_eq!(b_rx.recv().await, Some("for-b"));
        assert!(
            a_rx.try_recv().is_err(),
            "the other remote listener must not steal this channel"
        );

        assert_eq!(
            deliver_to_route(&routes, ("127.0.0.1".into(), 2299), "missing").await,
            RouteDelivery::Missing
        );
    }

    #[tokio::test]
    async fn closed_remote_forward_route_is_removed() {
        let routes: RouteMap<&'static str> = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::unbounded_channel();
        routes.lock().await.insert(("0.0.0.0".into(), 2200), tx);
        drop(rx);

        assert_eq!(
            deliver_to_route(&routes, ("0.0.0.0".into(), 2200), "orphan").await,
            RouteDelivery::ReceiverClosed
        );
        assert!(routes.lock().await.is_empty());
    }
}
