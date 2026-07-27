//! Errors raised by the (new) sync engine.
//!
//! These are deliberately shaped for the repo-based engine (per-record
//! conflicts, manifest parse errors, repo locking) and we don't want
//! the migration to be gated on lining up enum variants.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("sync repo is uninitialized at this location")]
    NotInitialized,

    #[error("sync repo already exists at this location")]
    AlreadyExists,

    #[error("sync passphrase rejected")]
    AuthenticationFailed,

    #[error("device is not enrolled in the authenticated keyring")]
    DeviceNotEnrolled,

    #[error("the current device cannot revoke itself")]
    CannotRevokeCurrentDevice,

    #[error("a local record changed during root-key rotation; retry the operation")]
    RekeyConcurrentEdit,

    #[error("the replacement sync passphrase must not be empty")]
    EmptyPassphrase,

    #[error("the replacement sync passphrase must differ from every existing device passphrase")]
    PassphraseNotRotated,

    #[error("vault_id mismatch (local={local}, remote={remote})")]
    VaultIdMismatch { local: String, remote: String },

    #[error("sync metadata is corrupt or in an unsupported format")]
    Corrupt,

    #[error("crypto error")]
    Crypto,

    #[error("schema is newer than this binary supports (repo={repo}, max={max})")]
    SchemaTooNew { repo: u32, max: u32 },

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("base64 decode failed")]
    Base64,
}

impl From<zeroterm_crypto::CryptoError> for Error {
    fn from(e: zeroterm_crypto::CryptoError) -> Self {
        tracing::error!(error = ?e, "sync crypto failed");
        Error::Crypto
    }
}
