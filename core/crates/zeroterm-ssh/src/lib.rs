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
// Re-exported so callers can decode vault-stored key material into the
// identities accepted by `Session::exec_forwarding_agent_with_identities`
// without depending on russh directly.
pub use russh::keys::{decode_secret_key, PrivateKey};
pub use session::{
    current_http_proxy, set_global_http_proxy, AuthMethod, ChannelEvent, ConnectConfig, ExecStream,
    PtySize, Session, ShellChannel,
};
pub use sftp::{
    is_upload_stall, DirEntry, FileKind, FileMetadata, ProgressTick, Sftp, SftpTuning,
    CONSERVATIVE_UPLOAD_CHUNK, DEFAULT_CHUNK, DEFAULT_DOWNLOAD_PARALLELISM, DEFAULT_UPLOAD_CHUNK,
    UPLOAD_STALL_MARKER,
};

/// Generate a task-scoped Ed25519 identity for server-to-server transfers.
///
/// The private key is returned only as an in-memory identity suitable for the
/// constrained agent served by [`Session::exec_forwarding_agent_with_identities`].
/// The public half is formatted for an OpenSSH `authorized_keys` entry.
pub fn generate_ephemeral_ed25519_identity() -> Result<(std::sync::Arc<PrivateKey>, String), String> {
    use russh::keys::{Algorithm, PublicKeyBase64};

    let key = PrivateKey::random(&mut rand_ssh::rng(), Algorithm::Ed25519)
        .map_err(|e| format!("generate ephemeral Ed25519 key: {e}"))?;
    let public = format!("ssh-ed25519 {}", key.public_key().public_key_base64());
    Ok((std::sync::Arc::new(key), public))
}
