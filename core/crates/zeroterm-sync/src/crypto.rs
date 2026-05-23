//! Sync-layer crypto: the *sync root key* and per-record subkeys.
//!
//! Distinct from `zeroterm_vault::crypto`:
//!   - Vault keys protect *local-at-rest* records, AAD = `record_id || version`.
//!   - Sync keys protect *records in the shared repo*, AAD =
//!     `vault_id || record_id || kind || revision`. New devices joining
//!     the repo only have the sync passphrase, never the vault password
//!     (RFC-002 §16).
//!
//! Keeping these in separate modules — with separate HKDF `info` strings
//! and separate AAD shapes — is intentional. Sharing primitives across
//! the two layers but not their *labels* is what `zeroterm_crypto` is
//! there to enable.

use zeroize::Zeroizing;

use zeroterm_crypto::{aead_decrypt, aead_seal, hkdf_subkey, SymmetricKey, KEY_LEN, NONCE_LEN};

use crate::error::Error;

/// HKDF info string for sync per-record key derivation.
pub const SYNC_RECORD_INFO: &[u8] = b"zeroterm-sync-record-v1";

/// HKDF info string for keyring-wrapped subkeys (see [`crate::keyring`]).
pub const SYNC_KEYRING_INFO: &[u8] = b"zeroterm-sync-keyring-v1";

/// The sync root key — 32 raw bytes, unwrapped by the keyring at join
/// time and held in memory while sync is running.
pub type SyncRootKey = SymmetricKey;

/// Build a fresh, random sync root key. Called once when a new repo is
/// created; from then on the same key is fanned out to every device via
/// the keyring.
pub fn fresh_root_key() -> SyncRootKey {
    let bytes = zeroterm_crypto::random_bytes(KEY_LEN);
    let mut k: SyncRootKey = Zeroizing::new([0u8; KEY_LEN]);
    k.as_mut().copy_from_slice(&bytes);
    k
}

/// Derive a per-record subkey from the sync root key.
///
/// Salt = `record_id`, info = [`SYNC_RECORD_INFO`]. Bumping the info
/// suffix (`-v2`, …) is the rotation path.
pub fn derive_record_key(root: &SyncRootKey, record_id: &str) -> SymmetricKey {
    let okm = hkdf_subkey::<KEY_LEN>(root.as_ref(), record_id.as_bytes(), SYNC_RECORD_INFO);
    let mut k: SymmetricKey = Zeroizing::new([0u8; KEY_LEN]);
    k.as_mut().copy_from_slice(okm.as_ref());
    k
}

/// AAD for a record payload in the sync repo. Binding all four fields
/// means a ciphertext from one record can't be replayed as another, can't
/// pretend to be a different kind, and can't be rolled back to a prior
/// revision.
pub fn record_aad(vault_id: &str, record_id: &str, kind: &str, revision: &str) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(vault_id.len() + record_id.len() + kind.len() + revision.len() + 3);
    aad.extend_from_slice(vault_id.as_bytes());
    aad.push(b'|');
    aad.extend_from_slice(record_id.as_bytes());
    aad.push(b'|');
    aad.extend_from_slice(kind.as_bytes());
    aad.push(b'|');
    aad.extend_from_slice(revision.as_bytes());
    aad
}

/// Encrypt a record payload for the sync repo. Returns `(nonce, ciphertext)`.
pub fn seal_record(
    root: &SyncRootKey,
    vault_id: &str,
    record_id: &str,
    kind: &str,
    revision: &str,
    plaintext: &[u8],
) -> Result<([u8; NONCE_LEN], Vec<u8>), Error> {
    let key = derive_record_key(root, record_id);
    let aad = record_aad(vault_id, record_id, kind, revision);
    let (nonce, ct) = aead_seal(&key, plaintext, &aad)?;
    Ok((nonce, ct))
}

/// Decrypt a record payload pulled from the sync repo.
pub fn open_record(
    root: &SyncRootKey,
    vault_id: &str,
    record_id: &str,
    kind: &str,
    revision: &str,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, Error> {
    if nonce.len() != NONCE_LEN {
        return Err(Error::Corrupt);
    }
    let key = derive_record_key(root, record_id);
    let aad = record_aad(vault_id, record_id, kind, revision);
    Ok(aead_decrypt(&key, nonce, ciphertext, &aad)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let root = fresh_root_key();
        let (n, ct) = seal_record(&root, "vlt", "rec-1", "host", "rev-1", b"hello").unwrap();
        let pt = open_record(&root, "vlt", "rec-1", "host", "rev-1", &n, &ct).unwrap();
        assert_eq!(pt, b"hello");
    }

    #[test]
    fn aad_binds_record_id() {
        let root = fresh_root_key();
        let (n, ct) = seal_record(&root, "vlt", "rec-1", "host", "rev-1", b"x").unwrap();
        assert!(open_record(&root, "vlt", "rec-OTHER", "host", "rev-1", &n, &ct).is_err());
    }

    #[test]
    fn aad_binds_kind() {
        let root = fresh_root_key();
        let (n, ct) = seal_record(&root, "vlt", "rec-1", "host", "rev-1", b"x").unwrap();
        assert!(open_record(&root, "vlt", "rec-1", "snippet", "rev-1", &n, &ct).is_err());
    }

    #[test]
    fn aad_binds_revision() {
        let root = fresh_root_key();
        let (n, ct) = seal_record(&root, "vlt", "rec-1", "host", "rev-1", b"x").unwrap();
        assert!(open_record(&root, "vlt", "rec-1", "host", "rev-2", &n, &ct).is_err());
    }

    #[test]
    fn aad_binds_vault_id() {
        let root = fresh_root_key();
        let (n, ct) = seal_record(&root, "vlt-1", "rec-1", "host", "rev-1", b"x").unwrap();
        assert!(open_record(&root, "vlt-2", "rec-1", "host", "rev-1", &n, &ct).is_err());
    }

    #[test]
    fn derive_record_key_is_deterministic_and_context_sensitive() {
        let root = fresh_root_key();
        let k1 = derive_record_key(&root, "rec-1");
        let k1_again = derive_record_key(&root, "rec-1");
        let k2 = derive_record_key(&root, "rec-2");
        assert_eq!(k1.as_ref(), k1_again.as_ref());
        assert_ne!(k1.as_ref(), k2.as_ref());
    }
}
