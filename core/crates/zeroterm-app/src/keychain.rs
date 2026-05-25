//! OS-keychain caching of the master password.
//!
//! Backends per platform:
//!   - macOS: Keychain (via the Security framework)
//!   - Windows: Credential Manager (via Wincred)
//!   - Linux: Secret Service (via D-Bus to gnome-keyring / kwallet / etc.)
//!
//! Each cached entry is keyed by `(SERVICE, "vault:" + vault_path)` so
//! multiple vaults on the same machine don't collide. Moving a vault
//! file invalidates its cache — caller will fall through to prompting.
//!
//! This is a convenience layer; **never** let it become the source of
//! truth. The vault file itself is always authoritative, and a cached
//! password that turns out to be wrong (e.g. user rotated the password
//! elsewhere) just means we re-prompt and optionally re-cache.

use std::path::Path;

use thiserror::Error;

const SERVICE: &str = "ZeroTerm";

/// Errors specific to keychain interaction. All of them are
/// non-catastrophic — callers should fall back to prompting on `Err`.
#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("keychain backend error: {0}")]
    Backend(String),
}

fn entry(vault_path: &Path) -> Result<keyring::Entry, KeychainError> {
    let user = format!("vault:{}", vault_path.display());
    keyring::Entry::new(SERVICE, &user).map_err(|e| KeychainError::Backend(e.to_string()))
}

fn sync_encryption_entry(profile_id: &str) -> Result<keyring::Entry, KeychainError> {
    let user = format!("sync-encryption:{profile_id}");
    keyring::Entry::new(SERVICE, &user).map_err(|e| KeychainError::Backend(e.to_string()))
}

/// Keyed entry for backend credentials (e.g. WebDAV password).
/// Separate from `sync-encryption:` (the sync passphrase) so the two
/// can be rotated independently and so a leaked backend password
/// doesn't trivially imply control of repo decryption.
fn sync_backend_credential_entry(profile_id: &str) -> Result<keyring::Entry, KeychainError> {
    let user = format!("sync-backend-credential:{profile_id}");
    keyring::Entry::new(SERVICE, &user).map_err(|e| KeychainError::Backend(e.to_string()))
}

/// Sibling slot for an optional second backend secret (e.g. STS session
/// token for S3). Kept separate so rotating the main credential
/// doesn't disturb the secondary slot, and vice versa.
fn sync_backend_extra_entry(profile_id: &str) -> Result<keyring::Entry, KeychainError> {
    let user = format!("sync-backend-extra:{profile_id}");
    keyring::Entry::new(SERVICE, &user).map_err(|e| KeychainError::Backend(e.to_string()))
}

/// Persist `password` so future unlocks of `vault_path` can skip the prompt.
pub fn save_master_password(vault_path: &Path, password: &str) -> Result<(), KeychainError> {
    let e = entry(vault_path)?;
    tracing::debug!(
        target: "zeroterm::keychain",
        path = %vault_path.display(),
        "saving master password to keychain"
    );
    e.set_password(password)
        .map_err(|e| KeychainError::Backend(e.to_string()))
}

/// Look up a previously-saved master password. Returns `Ok(None)` if no
/// entry exists, `Err` only on actual backend failure.
pub fn get_master_password(vault_path: &Path) -> Result<Option<String>, KeychainError> {
    let e = entry(vault_path)?;
    match e.get_password() {
        Ok(p) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                path = %vault_path.display(),
                "keychain hit"
            );
            Ok(Some(p))
        }
        Err(keyring::Error::NoEntry) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                path = %vault_path.display(),
                "keychain miss (NoEntry)"
            );
            Ok(None)
        }
        Err(other) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                path = %vault_path.display(),
                error = %other,
                "keychain backend error on lookup"
            );
            Err(KeychainError::Backend(other.to_string()))
        }
    }
}

/// Forget any cached password for `vault_path`. Idempotent — a missing
/// entry is treated as success.
pub fn forget_master_password(vault_path: &Path) -> Result<(), KeychainError> {
    let e = entry(vault_path)?;
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn save_sync_encryption_secret(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    let e = sync_encryption_entry(profile_id)?;
    e.set_password(secret)
        .map_err(|e| KeychainError::Backend(e.to_string()))
}

pub fn get_sync_encryption_secret(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let e = sync_encryption_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_encryption_secret(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_encryption_entry(profile_id)?;
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

/// Persist a backend credential (e.g. WebDAV password) under
/// `sync-backend-credential:<profile_id>`.
pub fn save_sync_backend_credential(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    let e = sync_backend_credential_entry(profile_id)?;
    e.set_password(secret)
        .map_err(|e| KeychainError::Backend(e.to_string()))
}

pub fn get_sync_backend_credential(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let e = sync_backend_credential_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_backend_credential(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_backend_credential_entry(profile_id)?;
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

/// Persist an extra backend secret (e.g. S3 session token) under
/// `sync-backend-extra:<profile_id>`.
pub fn save_sync_backend_extra(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    let e = sync_backend_extra_entry(profile_id)?;
    e.set_password(secret)
        .map_err(|e| KeychainError::Backend(e.to_string()))
}

pub fn get_sync_backend_extra(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let e = sync_backend_extra_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_backend_extra(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_backend_extra_entry(profile_id)?;
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}
