//! Errors that cross the FFI boundary.
//!
//! We deliberately keep this small and stringly-typed. The richer
//! [`zeroterm_app::AppError`] / [`zeroterm_vault::VaultError`] tree
//! includes types like `russh::Error` and `rusqlite::Error` that aren't
//! safe to ferry across an FFI surface as-is. [`map_app_error`] collapses
//! them into the variants Swift/Kotlin actually want to switch on.

use thiserror::Error;

#[derive(Debug, Error, uniffi::Error)]
pub enum FfiError {
    /// Vault operations were attempted before [`crate::ZeroTerm::unlock`]
    /// or [`crate::ZeroTerm::create`] succeeded.
    #[error("vault is locked")]
    VaultLocked,

    /// Master password rejected. The vault file is intact; retry with the
    /// correct password.
    #[error("master password rejected")]
    AuthenticationFailed,

    /// `unlock` was called against a path that has no vault yet.
    #[error("vault is not initialized at this path")]
    NotInitialized,

    /// `create` was called against a path that already has a vault.
    #[error("vault already exists")]
    AlreadyExists,

    #[error("not found: {message}")]
    NotFound { message: String },

    /// Catch-all for anything that doesn't fit a more specific case —
    /// IO errors, malformed records, name collisions, etc. The `message`
    /// is `Display` of the underlying error.
    #[error("{message}")]
    Other { message: String },
}

pub(crate) fn map_app_error(e: zeroterm_app::AppError) -> FfiError {
    use zeroterm_app::AppError;
    use zeroterm_vault::VaultError;

    match e {
        AppError::Vault(VaultError::AuthenticationFailed) => FfiError::AuthenticationFailed,
        AppError::Vault(VaultError::NotInitialized) => FfiError::NotInitialized,
        AppError::Vault(VaultError::AlreadyExists) => FfiError::AlreadyExists,
        AppError::Vault(VaultError::NotFound(s)) => FfiError::NotFound { message: s },
        AppError::HostNotFound(s) => FfiError::NotFound { message: s },
        AppError::HostNameTaken(name) => FfiError::Other {
            message: format!("host name '{name}' already taken"),
        },
        other => FfiError::Other {
            message: other.to_string(),
        },
    }
}

pub(crate) fn other<E: std::fmt::Display>(e: E) -> FfiError {
    FfiError::Other {
        message: e.to_string(),
    }
}
