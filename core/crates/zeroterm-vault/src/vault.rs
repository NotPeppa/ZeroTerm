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

pub struct Vault {
    store: Store,
    master: MasterKey,
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

        Ok(Self { store, master })
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

        Ok(Self { store, master })
    }

    /// Insert a brand-new record. The id is generated server-style
    /// (UUID v7, time-ordered).
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
        })?;

        Ok(id)
    }

    /// Replace an existing record's plaintext. Bumps version so AAD
    /// binding stays consistent.
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
        })?;
        Ok(())
    }

    /// Soft-delete: writes a tombstone record with no ciphertext, so
    /// sync can propagate the deletion. Calling `get`/`list` will skip
    /// it from then on.
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
}
