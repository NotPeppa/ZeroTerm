//! OS-keychain caching of secrets (master password + sync secrets).
//!
//! Backends per platform:
//!   - macOS: Keychain (via the Security framework)
//!   - Windows: Credential Manager (via Wincred)
//!   - Linux: Secret Service (via D-Bus to gnome-keyring / kwallet / etc.)
//!
//! ## Why a single consolidated entry
//!
//! macOS prompts for authorization **per keychain item**, not per unit
//! of time. The previous design stored five separate items
//! (`vault:<path>`, `sync-encryption:<id>`, `sync-backend-credential:<id>`,
//! `sync-backend-extra:<id>`, `ai-api-key:<id>`), so a cold start that
//! needed all of them produced up to five Touch ID / password prompts —
//! "batch reading" them quickly did nothing, because each distinct item
//! has its own ACL gate.
//!
//! To get a single prompt, we now store **everything in one keychain
//! item** (`SERVICE`, [`CONSOLIDATED_USER`]) whose value is a JSON map
//! of `logical-key -> secret`. Reading that one item once (with the
//! result cached in memory) is the only keychain access on the hot path,
//! so the user sees at most one prompt per launch.
//!
//! Legacy per-item entries are migrated transparently: the first time a
//! secret is requested and it isn't in the consolidated blob, we read
//! the old individual item (one last prompt for that item), fold it into
//! the consolidated blob, and delete the legacy item. After the one-time
//! migration launch, only the consolidated item remains.
//!
//! This is a convenience layer; **never** let it become the source of
//! truth. The vault file itself is always authoritative, and a cached
//! password that turns out to be wrong (e.g. user rotated it elsewhere)
//! just means we re-prompt and optionally re-cache.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use thiserror::Error;

const SERVICE: &str = "ZeroTerm";
/// User field of the single consolidated keychain item that holds every
/// secret as a JSON blob. Versioned so a future format change can live
/// alongside the old one during migration.
const CONSOLIDATED_USER: &str = "secrets-v1";

/// Errors specific to keychain interaction. All of them are
/// non-catastrophic — callers should fall back to prompting on `Err`.
#[derive(Debug, Error)]
pub enum KeychainError {
    #[error("keychain backend error: {0}")]
    Backend(String),
}

// ---------------------------------------------------------------------------
// Logical key builders
//
// These are the in-blob keys. They intentionally match the *legacy*
// per-item user strings so migration can map old item -> blob key 1:1.
// ---------------------------------------------------------------------------

fn vault_key(vault_path: &Path) -> String {
    format!("vault:{}", vault_path.display())
}
fn sync_encryption_key(profile_id: &str) -> String {
    format!("sync-encryption:{profile_id}")
}
fn sync_backend_credential_key(profile_id: &str) -> String {
    format!("sync-backend-credential:{profile_id}")
}
fn sync_backend_extra_key(profile_id: &str) -> String {
    format!("sync-backend-extra:{profile_id}")
}
fn ai_api_key_key(profile_id: &str) -> String {
    format!("ai-api-key:{profile_id}")
}

// ---------------------------------------------------------------------------
// Consolidated store
// ---------------------------------------------------------------------------

#[derive(Default, Serialize, Deserialize)]
struct Blob {
    secrets: HashMap<String, String>,
}

struct Inner {
    /// `true` once we've read the consolidated keychain item (or
    /// confirmed it's absent) at least once this process.
    loaded: bool,
    secrets: Option<HashMap<String, String>>,
}

impl Inner {
    fn secrets_mut(&mut self) -> &mut HashMap<String, String> {
        self.secrets.get_or_insert_with(HashMap::new)
    }
}

/// Process-global keychain store. All reads/writes funnel through one
/// consolidated keychain item; the parsed contents live here in memory.
pub struct KeychainStore {
    inner: Mutex<Inner>,
}

impl KeychainStore {
    pub const fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                loaded: false,
                secrets: None,
            }),
        }
    }

    fn consolidated_entry() -> Result<keyring::Entry, KeychainError> {
        keyring::Entry::new(SERVICE, CONSOLIDATED_USER)
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }

    /// Read the consolidated item exactly once and cache it. This is the
    /// only keychain access on the hot path, so it costs at most one
    /// authorization prompt.
    fn ensure_loaded(&self, inner: &mut Inner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true; // mark first so a backend error doesn't loop

        let entry = match Self::consolidated_entry() {
            Ok(e) => e,
            Err(e) => {
                tracing::debug!(target: "zeroterm::keychain", error = %e, "could not open consolidated entry");
                return;
            }
        };
        match entry.get_password() {
            Ok(json) => match serde_json::from_str::<Blob>(&json) {
                Ok(blob) => {
                    tracing::debug!(
                        target: "zeroterm::keychain",
                        count = blob.secrets.len(),
                        "loaded consolidated keychain blob"
                    );
                    inner.secrets = Some(blob.secrets);
                }
                Err(e) => {
                    tracing::warn!(target: "zeroterm::keychain", error = %e, "consolidated blob is corrupt; ignoring");
                }
            },
            Err(keyring::Error::NoEntry) => {
                tracing::debug!(target: "zeroterm::keychain", "no consolidated entry yet");
            }
            Err(e) => {
                tracing::debug!(target: "zeroterm::keychain", error = %e, "consolidated entry read failed");
            }
        }
    }

    /// Write the in-memory secrets back to the single consolidated item.
    /// Writing an item the app owns does not prompt on macOS.
    fn persist(inner: &mut Inner) -> Result<(), KeychainError> {
        let blob = Blob {
            secrets: inner.secrets_mut().clone(),
        };
        let json = serde_json::to_string(&blob)
            .map_err(|e| KeychainError::Backend(format!("serialize: {e}")))?;
        let entry = Self::consolidated_entry()?;
        entry
            .set_password(&json)
            .map_err(|e| KeychainError::Backend(e.to_string()))
    }

    /// Best-effort read of a single legacy per-item entry. Used only
    /// during migration. Returns the value if the old item exists.
    fn read_legacy(user: &str) -> Option<String> {
        let entry = keyring::Entry::new(SERVICE, user).ok()?;
        entry.get_password().ok()
    }

    /// Best-effort delete of a legacy per-item entry after migration.
    fn delete_legacy(user: &str) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, user) {
            let _ = entry.delete_password();
        }
    }

    /// Fetch a secret by its logical key. Migrates the matching legacy
    /// item into the consolidated blob on first miss.
    fn get_secret(&self, key: &str) -> Result<Option<String>, KeychainError> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded(&mut inner);

        if let Some(v) = inner.secrets_mut().get(key) {
            return Ok(Some(v.clone()));
        }

        // Not in the consolidated blob — try the legacy item (the
        // logical key *is* the legacy user string).
        if let Some(v) = Self::read_legacy(key) {
            inner.secrets_mut().insert(key.to_string(), v.clone());
            if let Err(e) = Self::persist(&mut inner) {
                tracing::debug!(target: "zeroterm::keychain", error = %e, "failed to persist migrated secret");
            } else {
                Self::delete_legacy(key);
                tracing::debug!(target: "zeroterm::keychain", key, "migrated legacy keychain item");
            }
            return Ok(Some(v));
        }

        Ok(None)
    }

    fn set_secret(&self, key: String, value: &str) -> Result<(), KeychainError> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded(&mut inner);
        inner.secrets_mut().insert(key, value.to_string());
        Self::persist(&mut inner)
    }

    fn remove_secret(&self, key: &str) -> Result<(), KeychainError> {
        let mut inner = self.inner.lock().unwrap();
        self.ensure_loaded(&mut inner);
        let existed = inner.secrets_mut().remove(key).is_some();
        // Always clear any stray legacy item too.
        Self::delete_legacy(key);
        if existed {
            Self::persist(&mut inner)?;
        }
        Ok(())
    }

    /// Warm the in-memory cache by reading the consolidated item once.
    /// `profile_ids` lets us proactively migrate legacy per-profile items
    /// in the same launch (each still costs one prompt the first time,
    /// but only ever once). Safe to call multiple times.
    pub fn preload(&self, vault_path: &Path, profile_ids: &[String]) {
        // Trigger the single consolidated read.
        let _ = self.get_secret(&vault_key(vault_path));
        // Proactively migrate any legacy per-profile items.
        for pid in profile_ids {
            let _ = self.get_secret(&sync_encryption_key(pid));
            let _ = self.get_secret(&sync_backend_credential_key(pid));
            let _ = self.get_secret(&sync_backend_extra_key(pid));
            let _ = self.get_secret(&ai_api_key_key(pid));
        }
    }

    /// Drop the in-memory cache so the next access re-reads the keychain.
    pub fn invalidate(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.loaded = false;
        inner.secrets = None;
    }
}

impl Default for KeychainStore {
    fn default() -> Self {
        Self::new()
    }
}

/// Global store instance.
static STORE: KeychainStore = KeychainStore::new();

/// Access the global keychain store (e.g. to call `preload` at startup).
pub fn cache() -> &'static KeychainStore {
    &STORE
}

// ---------------------------------------------------------------------------
// Public API — unchanged signatures, now backed by the single item
// ---------------------------------------------------------------------------

/// Persist `password` so future unlocks of `vault_path` can skip the prompt.
pub fn save_master_password(vault_path: &Path, password: &str) -> Result<(), KeychainError> {
    tracing::debug!(target: "zeroterm::keychain", path = %vault_path.display(), "saving master password");
    STORE.set_secret(vault_key(vault_path), password)
}

/// Look up a previously-saved master password. Returns `Ok(None)` if no
/// entry exists, `Err` only on actual backend failure.
pub fn get_master_password(vault_path: &Path) -> Result<Option<String>, KeychainError> {
    STORE.get_secret(&vault_key(vault_path))
}

/// Forget any cached password for `vault_path`. Idempotent.
pub fn forget_master_password(vault_path: &Path) -> Result<(), KeychainError> {
    STORE.remove_secret(&vault_key(vault_path))
}

pub fn save_sync_encryption_secret(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    STORE.set_secret(sync_encryption_key(profile_id), secret)
}

pub fn get_sync_encryption_secret(profile_id: &str) -> Result<Option<String>, KeychainError> {
    STORE.get_secret(&sync_encryption_key(profile_id))
}

pub fn forget_sync_encryption_secret(profile_id: &str) -> Result<(), KeychainError> {
    STORE.remove_secret(&sync_encryption_key(profile_id))
}

/// Persist a backend credential (e.g. WebDAV password). Stored under a
/// key separate from the sync passphrase so the two rotate independently
/// and a leaked backend password doesn't imply repo decryption.
pub fn save_sync_backend_credential(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    STORE.set_secret(sync_backend_credential_key(profile_id), secret)
}

pub fn get_sync_backend_credential(profile_id: &str) -> Result<Option<String>, KeychainError> {
    STORE.get_secret(&sync_backend_credential_key(profile_id))
}

pub fn forget_sync_backend_credential(profile_id: &str) -> Result<(), KeychainError> {
    STORE.remove_secret(&sync_backend_credential_key(profile_id))
}

/// Persist an extra backend secret (e.g. S3 STS session token), kept in
/// its own key so rotating the main credential doesn't disturb it.
pub fn save_sync_backend_extra(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    STORE.set_secret(sync_backend_extra_key(profile_id), secret)
}

pub fn get_sync_backend_extra(profile_id: &str) -> Result<Option<String>, KeychainError> {
    STORE.get_secret(&sync_backend_extra_key(profile_id))
}

pub fn forget_sync_backend_extra(profile_id: &str) -> Result<(), KeychainError> {
    STORE.remove_secret(&sync_backend_extra_key(profile_id))
}

pub fn save_ai_api_key(profile_id: &str, secret: &str) -> Result<(), KeychainError> {
    STORE.set_secret(ai_api_key_key(profile_id), secret)
}

pub fn get_ai_api_key(profile_id: &str) -> Result<Option<String>, KeychainError> {
    STORE.get_secret(&ai_api_key_key(profile_id))
}

pub fn forget_ai_api_key(profile_id: &str) -> Result<(), KeychainError> {
    STORE.remove_secret(&ai_api_key_key(profile_id))
}
