//! Vault: high-level encrypted record store.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use uuid::Uuid;
use zeroterm_store::{Record, Store};

use crate::crypto::{
    decrypt_record, derive_master_key, encrypt_record, encrypt_verifier, random_bytes,
    verify_master_key, Argon2Params, MasterKey,
};
use crate::error::VaultError;

// Meta keys persisted in `vault_meta`. Bumping the format means writing
// a new key (not overwriting an old one), so old vaults remain readable
// or at least diagnosable.
const META_KDF_SALT: &str = "kdf_salt_v1";
const META_KDF_PARAMS: &str = "kdf_params_v1";
const META_VERIFIER_NONCE: &str = "verifier_nonce_v1";
const META_VERIFIER_CT: &str = "verifier_ct_v1";
/// Identifier that uniquely names this vault. Stamped into every sync
/// repo at create time and verified at join time so a passphrase can't
/// accidentally cross-mount two different vaults onto the same repo.
const META_VAULT_ID: &str = "vault_id_v1";

pub struct Vault {
    store: Store,
    master: MasterKey,
    vault_id: String,
}

impl Vault {
    /// Create a fresh vault at `path`. Fails if a vault already exists
    /// there (look for `kdf_salt_v1` in `vault_meta` to detect this).
    pub fn create<P: AsRef<Path>>(path: P, master_password: &str) -> Result<Self, VaultError> {
        Self::create_with_params(path, master_password, Argon2Params::default())
    }

    /// Same as [`Vault::create`] but lets the caller pick KDF parameters,
    /// e.g. lower memory cost on constrained devices.
    pub fn create_with_params<P: AsRef<Path>>(
        path: P,
        master_password: &str,
        params: Argon2Params,
    ) -> Result<Self, VaultError> {
        let store = Store::open(path)?;
        if store.get_meta(META_KDF_SALT)?.is_some() {
            return Err(VaultError::AlreadyExists);
        }

        let salt = random_bytes(16);
        let master = derive_master_key(master_password, &salt, params)?;
        let (verifier_nonce, verifier_ct) = encrypt_verifier(&master)?;

        store.put_meta(META_KDF_SALT, &salt)?;
        store.put_meta(META_KDF_PARAMS, &params.to_bytes())?;
        store.put_meta(META_VERIFIER_NONCE, &verifier_nonce)?;
        store.put_meta(META_VERIFIER_CT, &verifier_ct)?;

        let vault_id = Uuid::now_v7().to_string();
        store.put_meta(META_VAULT_ID, vault_id.as_bytes())?;

        Ok(Self {
            store,
            master,
            vault_id,
        })
    }

    /// Open and decrypt an existing vault.
    pub fn unlock<P: AsRef<Path>>(path: P, master_password: &str) -> Result<Self, VaultError> {
        let store = Store::open(path)?;

        let salt = store
            .get_meta(META_KDF_SALT)?
            .ok_or(VaultError::NotInitialized)?;
        let params_bytes = store
            .get_meta(META_KDF_PARAMS)?
            .ok_or(VaultError::Corrupt)?;
        let params = Argon2Params::from_bytes(&params_bytes)?;

        let nonce = store
            .get_meta(META_VERIFIER_NONCE)?
            .ok_or(VaultError::Corrupt)?;
        let ct = store
            .get_meta(META_VERIFIER_CT)?
            .ok_or(VaultError::Corrupt)?;

        let master = derive_master_key(master_password, &salt, params)?;
        verify_master_key(&master, &nonce, &ct)?;

        // Pre-v2 vaults won't have vault_id_v1 yet — back-fill on first
        // unlock so sync has a stable identifier from then on. The
        // back-fill is one row in vault_meta; cheap.
        let vault_id = match store.get_meta(META_VAULT_ID)? {
            Some(bytes) => String::from_utf8(bytes).map_err(|_| VaultError::Corrupt)?,
            None => {
                let id = Uuid::now_v7().to_string();
                store.put_meta(META_VAULT_ID, id.as_bytes())?;
                id
            }
        };

        Ok(Self {
            store,
            master,
            vault_id,
        })
    }

    /// Stable identifier for this vault, persisted in `vault_meta`.
    pub fn vault_id(&self) -> &str {
        &self.vault_id
    }

    /// Insert a brand-new record. The id is generated server-style
    /// (UUID v7, time-ordered). Marks the row dirty so the next sync
    /// pass picks it up.
    pub fn insert(&self, kind: &str, plaintext: &[u8]) -> Result<String, VaultError> {
        let id = Uuid::now_v7().to_string();
        let version = self.store.max_version()? + 1;
        let (nonce, ciphertext) = encrypt_record(&self.master, &id, version, plaintext)?;

        self.store.upsert_record(&Record {
            id: id.clone(),
            kind: kind.to_string(),
            ciphertext,
            nonce,
            version,
            updated_at: now_millis(),
            deleted: false,
            local_rev: Some(Uuid::now_v7().to_string()),
            server_rev: None,
            base_server_rev: None,
            dirty: true,
            conflict_state: None,
        })?;

        Ok(id)
    }

    /// Replace an existing record's plaintext. Bumps version so AAD
    /// binding stays consistent. Marks the row dirty and assigns a
    /// fresh `local_rev`; `base_server_rev` carries over so the sync
    /// engine can detect concurrent remote edits.
    pub fn update(&self, id: &str, plaintext: &[u8]) -> Result<(), VaultError> {
        let existing = self
            .store
            .get_record(id)?
            .ok_or_else(|| VaultError::NotFound(id.to_string()))?;
        if existing.deleted {
            return Err(VaultError::NotFound(id.to_string()));
        }

        let version = self.store.max_version()? + 1;
        let (nonce, ciphertext) = encrypt_record(&self.master, id, version, plaintext)?;

        self.store.upsert_record(&Record {
            id: id.to_string(),
            kind: existing.kind,
            ciphertext,
            nonce,
            version,
            updated_at: now_millis(),
            deleted: false,
            local_rev: Some(Uuid::now_v7().to_string()),
            server_rev: existing.server_rev.clone(),
            base_server_rev: existing.server_rev,
            dirty: true,
            conflict_state: None,
        })?;
        Ok(())
    }

    /// Soft-delete: writes a tombstone record with no ciphertext, so
    /// sync can propagate the deletion. Calling `get`/`list` will skip
    /// it from then on. Marks the row dirty.
    pub fn delete(&self, id: &str) -> Result<(), VaultError> {
        let existing = self
            .store
            .get_record(id)?
            .ok_or_else(|| VaultError::NotFound(id.to_string()))?;
        if existing.deleted {
            return Ok(());
        }

        let version = self.store.max_version()? + 1;
        self.store.upsert_record(&Record {
            id: id.to_string(),
            kind: existing.kind,
            ciphertext: Vec::new(),
            nonce: Vec::new(),
            version,
            updated_at: now_millis(),
            deleted: true,
            local_rev: Some(Uuid::now_v7().to_string()),
            server_rev: existing.server_rev.clone(),
            base_server_rev: existing.server_rev,
            dirty: true,
            conflict_state: None,
        })?;
        Ok(())
    }

    /// Decrypt a single record by id. Returns `NotFound` for tombstones.
    pub fn get(&self, id: &str) -> Result<Vec<u8>, VaultError> {
        let rec = self
            .store
            .get_record(id)?
            .ok_or_else(|| VaultError::NotFound(id.to_string()))?;
        if rec.deleted {
            return Err(VaultError::NotFound(id.to_string()));
        }
        decrypt_record(&self.master, &rec.id, rec.version, &rec.nonce, &rec.ciphertext)
    }

    /// Decrypt all live records of a given kind. Tombstones are skipped.
    pub fn list(&self, kind: &str) -> Result<Vec<(String, Vec<u8>)>, VaultError> {
        let recs = self.store.list_records(kind)?;
        let mut out = Vec::with_capacity(recs.len());
        for rec in recs {
            let pt =
                decrypt_record(&self.master, &rec.id, rec.version, &rec.nonce, &rec.ciphertext)?;
            out.push((rec.id, pt));
        }
        Ok(out)
    }

    /// Highest local version. Used by sync to compute deltas later.
    pub fn current_version(&self) -> Result<i64, VaultError> {
        Ok(self.store.max_version()?)
    }

    /// Wipe all records and sync metadata from this vault.
    pub fn clear_all_data(&self) -> Result<(), VaultError> {
        self.store.clear_all_data()?;
        Ok(())
    }

    /// Apply a remote upsert: write the record at the caller-chosen id
    /// with `dirty=0` and the server-known revision stamped into
    /// `server_rev`/`base_server_rev`. This is the path the sync engine
    /// uses when an event arrived from another device and there's no
    /// local conflict to merge.
    pub fn apply_remote_upsert(
        &self,
        id: &str,
        kind: &str,
        plaintext: &[u8],
        server_rev: &str,
    ) -> Result<(), VaultError> {
        let version = self.store.max_version()? + 1;
        let (nonce, ciphertext) = encrypt_record(&self.master, id, version, plaintext)?;

        self.store.upsert_record(&Record {
            id: id.to_string(),
            kind: kind.to_string(),
            ciphertext,
            nonce,
            version,
            updated_at: now_millis(),
            deleted: false,
            local_rev: Some(server_rev.to_string()),
            server_rev: Some(server_rev.to_string()),
            base_server_rev: Some(server_rev.to_string()),
            dirty: false,
            conflict_state: None,
        })?;
        Ok(())
    }

    /// Apply a remote tombstone (delete event). Idempotent — applying
    /// the same `server_rev` twice is a no-op.
    pub fn apply_remote_delete(&self, id: &str, server_rev: &str) -> Result<(), VaultError> {
        let existing = self.store.get_record(id)?;
        // Compute kind from existing row, or default to a sentinel; the
        // schema requires `kind`, but tombstones don't actually need it.
        let kind = existing
            .as_ref()
            .map(|r| r.kind.clone())
            .unwrap_or_else(|| "tombstone".to_string());

        let version = self.store.max_version()? + 1;
        self.store.upsert_record(&Record {
            id: id.to_string(),
            kind,
            ciphertext: Vec::new(),
            nonce: Vec::new(),
            version,
            updated_at: now_millis(),
            deleted: true,
            local_rev: Some(server_rev.to_string()),
            server_rev: Some(server_rev.to_string()),
            base_server_rev: Some(server_rev.to_string()),
            dirty: false,
            conflict_state: None,
        })?;
        Ok(())
    }

    /// Drain dirty records. Returns one entry per dirty row (live or
    /// tombstone) with decrypted plaintext for live rows.
    pub fn list_dirty(&self) -> Result<Vec<DirtyRecord>, VaultError> {
        let recs = self.store.dirty_records()?;
        let mut out = Vec::with_capacity(recs.len());
        for r in recs {
            let plaintext = if r.deleted {
                Vec::new()
            } else {
                decrypt_record(&self.master, &r.id, r.version, &r.nonce, &r.ciphertext)?
            };
            out.push(DirtyRecord {
                id: r.id,
                kind: r.kind,
                plaintext,
                deleted: r.deleted,
                local_rev: r.local_rev.unwrap_or_default(),
                base_server_rev: r.base_server_rev,
            });
        }
        Ok(out)
    }

    /// Mark a record clean: dirty=0, stamp `server_rev` and
    /// `base_server_rev`. Used after a successful push.
    pub fn mark_clean(&self, id: &str, server_rev: &str) -> Result<(), VaultError> {
        self.store.mark_clean(id, server_rev)?;
        Ok(())
    }

    /// Look up the full sync-relevant view of a record.
    pub fn find_full(&self, id: &str) -> Result<Option<FullRecord>, VaultError> {
        let Some(r) = self.store.get_record(id)? else {
            return Ok(None);
        };
        let plaintext = if r.deleted {
            Vec::new()
        } else {
            decrypt_record(&self.master, &r.id, r.version, &r.nonce, &r.ciphertext)?
        };
        Ok(Some(FullRecord {
            id: r.id,
            kind: r.kind,
            plaintext,
            deleted: r.deleted,
            local_rev: r.local_rev,
            server_rev: r.server_rev,
            base_server_rev: r.base_server_rev,
            dirty: r.dirty,
        }))
    }

    /// All live records of every kind. Used by snapshot generation
    /// (compaction) and by `engine.create_repo` seeding.
    pub fn list_all_live(&self) -> Result<Vec<FullRecord>, VaultError> {
        let recs = self.store.records_since(0)?;
        let mut out = Vec::with_capacity(recs.len());
        for r in recs {
            if r.deleted {
                continue;
            }
            let plaintext =
                decrypt_record(&self.master, &r.id, r.version, &r.nonce, &r.ciphertext)?;
            out.push(FullRecord {
                id: r.id,
                kind: r.kind,
                plaintext,
                deleted: false,
                local_rev: r.local_rev,
                server_rev: r.server_rev,
                base_server_rev: r.base_server_rev,
                dirty: r.dirty,
            });
        }
        Ok(out)
    }

    // -- sync glue --------------------------------------------------------
    //
    // The sync engine doesn't talk to `Store` directly — it goes through
    // these helpers so the vault stays in charge of the master key and
    // we never accidentally write plaintext to disk through a different
    // path.

    pub fn put_sync_state(&self, key: &str, value: &[u8]) -> Result<(), VaultError> {
        self.store.put_sync_state(key, value)?;
        Ok(())
    }

    pub fn get_sync_state(&self, key: &str) -> Result<Option<Vec<u8>>, VaultError> {
        Ok(self.store.get_sync_state(key)?)
    }

    /// Persist a conflict for later resolution by the user.
    pub fn record_conflict(
        &self,
        record_id: &str,
        kind: &str,
        local_payload: &[u8],
        remote_payload: &[u8],
        local_rev: &str,
        remote_rev: &str,
    ) -> Result<(), VaultError> {
        let id = Uuid::now_v7().to_string();
        self.store.insert_conflict(&zeroterm_store::ConflictRow {
            id,
            record_id: record_id.to_string(),
            kind: kind.to_string(),
            local_payload: local_payload.to_vec(),
            remote_payload: remote_payload.to_vec(),
            local_rev: local_rev.to_string(),
            remote_rev: remote_rev.to_string(),
            detected_at: now_millis(),
            resolved_at: None,
        })?;
        Ok(())
    }

    pub fn list_open_conflicts(&self) -> Result<Vec<zeroterm_store::ConflictRow>, VaultError> {
        Ok(self.store.list_open_conflicts()?)
    }

    pub fn get_conflict(
        &self,
        id: &str,
    ) -> Result<Option<zeroterm_store::ConflictRow>, VaultError> {
        Ok(self.store.get_conflict(id)?)
    }

    /// Mark a conflict resolved (audit only — doesn't touch the
    /// underlying record). The caller does the record-level work
    /// (`apply_remote_*` for keep-remote, `bump_base_server_rev` for
    /// keep-local) and then calls this to close out the inbox entry.
    pub fn resolve_conflict(&self, id: &str) -> Result<(), VaultError> {
        self.store.resolve_conflict(id, now_millis())?;
        Ok(())
    }

    /// Update only the `base_server_rev` column on a record, leaving
    /// ciphertext/dirty flag intact. Used when the user picks
    /// "keep-local" on a conflict: we bump base to the remote's
    /// revision so the next push references the remote's lineage and
    /// other devices accept the override cleanly.
    pub fn bump_base_server_rev(
        &self,
        id: &str,
        base_rev: &str,
    ) -> Result<(), VaultError> {
        let mut rec = self
            .store
            .get_record(id)?
            .ok_or_else(|| VaultError::NotFound(id.to_string()))?;
        rec.base_server_rev = Some(base_rev.to_string());
        self.store.upsert_record(&rec)?;
        Ok(())
    }

    /// Drop resolved conflict audit rows beyond the most recent `keep`.
    pub fn trim_resolved_conflicts(&self, keep: usize) -> Result<usize, VaultError> {
        Ok(self.store.trim_resolved_conflicts(keep)?)
    }

    /// Physically remove tombstone records older than `max_age_days`. Used
    /// by the sync layer's compact step; see RFC-002 §12.3 — by the time
    /// a tombstone has aged out, every reasonable peer has already
    /// applied (or missed) it, so the local row no longer needs to
    /// suppress resurrection.
    pub fn prune_old_tombstones(&self, max_age_days: u64) -> Result<usize, VaultError> {
        let cutoff = now_millis().saturating_sub((max_age_days as i64) * 86_400_000);
        Ok(self.store.prune_old_tombstones(cutoff)?)
    }
}

/// A record currently flagged dirty for the sync engine to push.
#[derive(Debug, Clone)]
pub struct DirtyRecord {
    pub id: String,
    pub kind: String,
    pub plaintext: Vec<u8>,
    pub deleted: bool,
    pub local_rev: String,
    pub base_server_rev: Option<String>,
}

/// Full view of a record with sync metadata. Used by the engine's
/// conflict detector and by snapshot/event encoders.
#[derive(Debug, Clone)]
pub struct FullRecord {
    pub id: String,
    pub kind: String,
    pub plaintext: Vec<u8>,
    pub deleted: bool,
    pub local_rev: Option<String>,
    pub server_rev: Option<String>,
    pub base_server_rev: Option<String>,
    pub dirty: bool,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fast_params() -> Argon2Params {
        // Tests can't afford 64MiB+3iter on every assertion. Match the
        // production AAD/key derivation paths but use parameters that
        // run in milliseconds.
        Argon2Params {
            m_cost: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn create_then_unlock() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw1", fast_params()).unwrap();
        let id = v.insert("host", b"hello").unwrap();
        drop(v);

        let v = Vault::unlock(&path, "pw1").unwrap();
        let pt = v.get(&id).unwrap();
        assert_eq!(pt, b"hello");
    }

    #[test]
    fn unlock_with_wrong_password_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw1", fast_params()).unwrap();
        v.insert("host", b"x").unwrap();
        drop(v);

        let err = match Vault::unlock(&path, "WRONG") {
            Ok(_) => panic!("vault opened with wrong password"),
            Err(e) => e,
        };
        assert!(matches!(err, VaultError::AuthenticationFailed));
    }

    #[test]
    fn double_create_fails() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let _ = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let err = match Vault::create_with_params(&path, "pw", fast_params()) {
            Ok(_) => panic!("second create should have failed"),
            Err(e) => e,
        };
        assert!(matches!(err, VaultError::AlreadyExists));
    }

    #[test]
    fn update_then_get() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let id = v.insert("host", b"v1").unwrap();
        v.update(&id, b"v2-much-longer-than-v1").unwrap();
        let pt = v.get(&id).unwrap();
        assert_eq!(pt, b"v2-much-longer-than-v1");
    }

    #[test]
    fn delete_creates_tombstone_invisible_to_get_and_list() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let id = v.insert("host", b"hello").unwrap();
        v.delete(&id).unwrap();

        match v.get(&id) {
            Err(VaultError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {:?}", other),
        }
        let live = v.list("host").unwrap();
        assert!(live.is_empty());
    }

    #[test]
    fn list_returns_all_live_records_of_kind() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let _ = v.insert("host", b"a").unwrap();
        let _ = v.insert("host", b"b").unwrap();
        let _ = v.insert("snippet", b"docker ps").unwrap();

        let hosts = v.list("host").unwrap();
        assert_eq!(hosts.len(), 2);
        let snippets = v.list("snippet").unwrap();
        assert_eq!(snippets.len(), 1);
    }

    #[test]
    fn vault_id_is_stable_across_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let id_create = v.vault_id().to_string();
        assert!(!id_create.is_empty());
        drop(v);

        let v = Vault::unlock(&path, "pw").unwrap();
        assert_eq!(v.vault_id(), id_create);
    }

    #[test]
    fn upsert_record_writes_with_caller_chosen_id() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        v.apply_remote_upsert("remote-id-1", "host", b"from-remote", "srv-1").unwrap();
        let pt = v.get("remote-id-1").unwrap();
        assert_eq!(pt, b"from-remote");

        // Calling apply_remote_upsert again with the same id and a new
        // server_rev replaces.
        v.apply_remote_upsert("remote-id-1", "host", b"updated", "srv-2").unwrap();
        let pt = v.get("remote-id-1").unwrap();
        assert_eq!(pt, b"updated");

        let full = v.find_full("remote-id-1").unwrap().unwrap();
        assert!(!full.dirty);
        assert_eq!(full.server_rev.as_deref(), Some("srv-2"));
    }

    #[test]
    fn insert_marks_dirty_and_assigns_local_rev() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let id = v.insert("host", b"hi").unwrap();
        let full = v.find_full(&id).unwrap().unwrap();
        assert!(full.dirty);
        assert!(full.local_rev.is_some());
        assert!(full.server_rev.is_none());
    }

    #[test]
    fn list_dirty_returns_local_edits() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        let id_a = v.insert("host", b"a").unwrap();
        let _id_b = v.insert("host", b"b").unwrap();

        let dirty = v.list_dirty().unwrap();
        assert_eq!(dirty.len(), 2);

        v.mark_clean(&id_a, "srv-1").unwrap();
        let dirty = v.list_dirty().unwrap();
        assert_eq!(dirty.len(), 1);
    }

    #[test]
    fn apply_remote_delete_is_idempotent() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v.sqlite");

        let v = Vault::create_with_params(&path, "pw", fast_params()).unwrap();
        v.apply_remote_upsert("rec-1", "host", b"a", "srv-1").unwrap();
        v.apply_remote_delete("rec-1", "srv-2").unwrap();
        assert!(matches!(v.get("rec-1"), Err(VaultError::NotFound(_))));

        // Second delete: still a no-op result.
        v.apply_remote_delete("rec-1", "srv-3").unwrap();
        let full = v.find_full("rec-1").unwrap().unwrap();
        assert!(full.deleted);
        assert_eq!(full.server_rev.as_deref(), Some("srv-3"));
    }
}
