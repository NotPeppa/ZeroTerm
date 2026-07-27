//! ZeroTerm SSH layer.
//!
//! Thin async wrapper over `russh`. Currently exposes:
//!   - password / private-key / agent authentication (chained)
//!   - host-key trust policies including OpenSSH-compatible `known_hosts`
//!   - PTY-backed interactive shell channel
//!   - SFTP subsystem with streaming + progress + cancellation
//!   - Local, remote, and dynamic (SOCKS5) port forwarding
//!   - ProxyJump (single hop)
//!
//! Out of scope (tracked for later): multi-hop ProxyJump chains, the FFI surface itself.

mod agent;
mod error;
mod forward;
mod host_key;
mod known_hosts;
mod session;
mod sftp;

pub use error::{SftpErrorKind, SshError};
pub use forward::{forward_dynamic, forward_local, forward_remote, ForwardHandle};
pub use host_key::{HostKeyInfo, HostKeyPolicy, HostKeyPrompt, MismatchAction};
pub use known_hosts::{KnownHostCertificateStatus, KnownHostStatus, KnownHosts};
pub use session::{
    current_http_proxy, set_global_http_proxy, AuthMethod, ChannelEvent, ConnectConfig, PtySize,
    Session, ShellChannel,
};
pub use sftp::{
    DirEntry, FileKind, FileMetadata, ProgressTick, Sftp, DEFAULT_CHUNK,
    DEFAULT_DOWNLOAD_PARALLELISM, DEFAULT_UPLOAD_CHUNK,
};
