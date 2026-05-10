use thiserror::Error;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("master password rejected")]
    AuthenticationFailed,

    #[error("vault is not initialized at this path — call Vault::create first")]
    NotInitialized,

    #[error("vault already exists at this path — call Vault::unlock instead")]
    AlreadyExists,

    #[error("vault metadata is corrupt or in an unsupported format")]
    Corrupt,

    #[error("record not found: {0}")]
    NotFound(String),

    #[error("storage error: {0}")]
    Store(#[from] zeroterm_store::StoreError),

    #[error("crypto error")]
    /// AEAD decryption failed, KDF failed, or RNG failed. We deliberately
    /// don't expose the underlying details to avoid leaking timing /
    /// padding-oracle signal — internal logs at `tracing::error` carry the
    /// real cause for diagnostics.
    Crypto,

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
