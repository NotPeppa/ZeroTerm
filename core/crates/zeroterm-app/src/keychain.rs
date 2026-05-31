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
//!
//! ## Batch preload
//!
//! On macOS, every individual Keychain read triggers a system
//! authorization prompt (Touch ID / password dialog). To avoid
//! prompting the user N times at startup, [`KeychainCache::preload`]
//! reads all relevant entries in one burst — the OS groups rapid
//! sequential accesses into a single prompt — and caches the results
//! in memory. Subsequent `get_*` calls hit the in-memory cache instead
//! of the Keychain again.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use thiserror::Error;

const SERVICE: &str = "ZeroTerm";

/// Errors specific to keychain interaction. All of them are
/// non-catastrophic — callers should fall back to prompting on `Err`.
#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("keychain backend error: {0}")]
    Backend(String),
}

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------

/// In-memory cache of keychain secrets, populated by [`KeychainCache::preload`].
///
/// The cache is process-global. Writes (`save_*`) update both the OS
/// keychain and the cache; deletes (`forget_*`) evict from both.
/// Reads (`get_*`) check the cache first and only fall through to the
/// OS keychain on a miss (which shouldn't happen after a successful
/// preload, but is safe regardless).
pub struct KeychainCache {
    /// `None` = not yet preloaded (reads fall through to OS).
    /// `Some(map)` = preloaded; keys are the `user` field of the
    /// keyring entry (e.g. "vault:/path", "sync-encryption:id").
    inner: Mutex<Option<HashMap<String, Option<String>>>>,
}

impl KeychainCache {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    /// Batch-read all keychain entries needed for startup in one burst.
    ///
    /// On macOS this collapses multiple Keychain authorization prompts
    /// into a single Touch ID / password dialog because the OS grants
    /// a short grace window after the first successful auth.
    ///
    /// `profile_ids` should be the list of sync profile IDs that might
    /// have remembered secrets.
    pub fn preload(&self, vault_path: &Path, profile_ids: &[String]) {
        let mut map: HashMap<String, Option<String>> = HashMap::new();

        // 1. Master password
        let vault_key = format!("vault:{}", vault_path.display());
        map.insert(vault_key.clone(), read_entry_raw(&vault_key));

        // 2. Per-profile secrets
        for pid in profile_ids {
            let enc_key = format!("sync-encryption:{pid}");
            map.insert(enc_key.clone(), read_entry_raw(&enc_key));

            let cred_key = format!("sync-backend-credential:{pid}");
            map.insert(cred_key.clone(), read_entry_raw(&cred_key));

            let extra_key = format!("sync-backend-extra:{pid}");
            map.insert(extra_key.clone(), read_entry_raw(&extra_key));
        }

        tracing::debug!(
            target: "zeroterm::keychain",
            entries = map.len(),
            hits = map.values().filter(|v| v.is_some()).count(),
            "keychain preload complete"
        );

        *self.inner.lock().unwrap() = Some(map);
    }

    /// Look up a cached value. Returns:
    ///   - `Some(Some(secret))` — cache hit with a value
    ///   - `Some(None)` — cache hit, entry was absent in keychain
    ///   - `None` — cache not populated (fall through to OS)
    fn get(&self, key: &str) -> Option<Option<String>> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().and_then(|m| m.get(key).cloned())
    }

    /// Insert or update a value in the cache (called after a successful
    /// OS keychain write).
    fn put(&self, key: String, value: Option<String>) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(ref mut m) = *guard {
            m.insert(key, value);
        }
    }

    /// Remove a key from the cache (called after a forget/delete).
    fn evict(&self, key: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(ref mut m) = *guard {
            m.remove(key);
        }
    }

    /// Invalidate the entire cache. Next reads will go to the OS.
    pub fn invalidate(&self) {
        *self.inner.lock().unwrap() = None;
    }
}

/// Global cache instance.
static CACHE: KeychainCache = KeychainCache::new();

/// Access the global keychain cache (e.g. to call `preload` at startup).
pub fn cache() -> &'static KeychainCache {
    &CACHE
}

/// Read a single entry from the OS keychain. Returns `None` on
/// `NoEntry` or any backend error (logged at debug level).
fn read_entry_raw(user: &str) -> Option<String> {
    let entry = match keyring::Entry::new(SERVICE, user) {
        Ok(e) => e,
        Err(e) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                user,
                error = %e,
                "keyring::Entry::new failed during preload"
            );
            return None;
        }
    };
    match entry.get_password() {
        Ok(v) => Some(v),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                user,
                error = %e,
                "get_password failed during preload"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Entry constructors (unchanged)
// ---------------------------------------------------------------------------

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

fn ai_api_key_entry(profile_id: &str) -> Result<keyring::Entry, KeychainError> {
    let user = format!("ai-api-key:{profile_id}");
    keyring::Entry::new(SERVICE, &user).map_err(|e| KeychainError::Backend(e.to_string()))
}

// ---------------------------------------------------------------------------
// Public API — reads go through cache, writes update both OS + cache
// ---------------------------------------------------------------------------

/// Persist `password` so future unlocks of `vault_path` can skip the prompt.
pub fn save_master_password(vault_path: &Path, password: &str) -> Result<(), KeychainError> {
    let e = entry(vault_path)?;
    tracing::debug!(
        target: "zeroterm::keychain",
        path = %vault_path.display(),
        "saving master password to keychain"
    );
    e.set_password(password)
        .map_err(|e| KeychainError::Backend(e.to_string()))?;
    CACHE.put(format!("vault:{}", vault_path.display()), Some(password.to_string()));
    Ok(())
}

/// Look up a previously-saved master password. Returns `Ok(None)` if no
/// entry exists, `Err` only on actual backend failure.
pub fn get_master_password(vault_path: &Path) -> Result<Option<String>, KeychainError> {
    let key = format!("vault:{}", vault_path.display());

    // Try cache first.
    if let Some(cached) = CACHE.get(&key) {
        tracing::debug!(
            target: "zeroterm::keychain",
            path = %vault_path.display(),
            hit = cached.is_some(),
            "master password from cache"
        );
        return Ok(cached);
    }

    // Cache miss — fall through to OS keychain.
    let e = entry(vault_path)?;
    match e.get_password() {
        Ok(p) => {
            tracing::debug!(
                target: "zeroterm::keychain",
                path = %vault_path.display(),
                "keychain hit (uncached)"
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
    CACHE.evict(&format!("vault:{}", vault_path.display()));
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn save_sync_encryption_secret(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    let e = sync_encryption_entry(profile_id)?;
    e.set_password(secret)
        .map_err(|e| KeychainError::Backend(e.to_string()))?;
    CACHE.put(format!("sync-encryption:{profile_id}"), Some(secret.to_string()));
    Ok(())
}

pub fn get_sync_encryption_secret(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let key = format!("sync-encryption:{profile_id}");
    if let Some(cached) = CACHE.get(&key) {
        return Ok(cached);
    }
    let e = sync_encryption_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_encryption_secret(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_encryption_entry(profile_id)?;
    CACHE.evict(&format!("sync-encryption:{profile_id}"));
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
        .map_err(|e| KeychainError::Backend(e.to_string()))?;
    CACHE.put(
        format!("sync-backend-credential:{profile_id}"),
        Some(secret.to_string()),
    );
    Ok(())
}

pub fn get_sync_backend_credential(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let key = format!("sync-backend-credential:{profile_id}");
    if let Some(cached) = CACHE.get(&key) {
        return Ok(cached);
    }
    let e = sync_backend_credential_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_backend_credential(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_backend_credential_entry(profile_id)?;
    CACHE.evict(&format!("sync-backend-credential:{profile_id}"));
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
        .map_err(|e| KeychainError::Backend(e.to_string()))?;
    CACHE.put(
        format!("sync-backend-extra:{profile_id}"),
        Some(secret.to_string()),
    );
    Ok(())
}

pub fn get_sync_backend_extra(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let key = format!("sync-backend-extra:{profile_id}");
    if let Some(cached) = CACHE.get(&key) {
        return Ok(cached);
    }
    let e = sync_backend_extra_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_sync_backend_extra(profile_id: &str) -> Result<(), KeychainError> {
    let e = sync_backend_extra_entry(profile_id)?;
    CACHE.evict(&format!("sync-backend-extra:{profile_id}"));
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn save_ai_api_key(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    let e = ai_api_key_entry(profile_id)?;
    e.set_password(secret)
        .map_err(|e| KeychainError::Backend(e.to_string()))?;
    CACHE.put(format!("ai-api-key:{profile_id}"), Some(secret.to_string()));
    Ok(())
}

pub fn get_ai_api_key(profile_id: &str) -> Result<Option<String>, KeychainError> {
    let key = format!("ai-api-key:{profile_id}");
    if let Some(cached) = CACHE.get(&key) {
        return Ok(cached);
    }
    let e = ai_api_key_entry(profile_id)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}

pub fn forget_ai_api_key(profile_id: &str) -> Result<(), KeychainError> {
    let e = ai_api_key_entry(profile_id)?;
    CACHE.evict(&format!("ai-api-key:{profile_id}"));
    match e.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(other) => Err(KeychainError::Backend(other.to_string())),
    }
}
