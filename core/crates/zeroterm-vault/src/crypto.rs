//! Vault-specific crypto wrappers over [`zeroterm_crypto`].
//!
//! Layering, top to bottom:
//!   1. Argon2id derives a 32-byte `master_key` from the user's password
//!      plus a per-vault salt. Parameters are persisted alongside the
//!      vault so they can be tuned upward without breaking old vaults.
//!   2. HKDF-SHA256 derives a per-record key from `master_key`, scoped by
//!      the record id. Separate keys per record limit blast radius and
//!      bind ciphertexts to ids.
//!   3. XChaCha20-Poly1305 (24-byte nonce, 256-bit key) is the AEAD. AAD
//!      is `record_id || version_le_bytes`, so ciphertexts can't be
//!      replayed against a different id or rolled back to an older
//!      version.
//!
//! The primitives themselves live in [`zeroterm_crypto`]. This module
//! owns only the vault-specific `info` strings and AAD shape — those are
//! deliberately not shared with the sync layer (see RFC-002 §16 and the
//! plan in `snug-mapping-koala.md` §2).

use zeroize::Zeroize;

use zeroterm_crypto::{
    aead_decrypt, aead_seal, derive_key_argon2id, hkdf_subkey, random_bytes as crypto_random_bytes,
    Argon2Params as KdfParams, CryptoError, SymmetricKey, KEY_LEN, NONCE_LEN,
};

use crate::error::VaultError;

/// Constant the verifier blob encrypts. Decrypting back to this exact
/// byte string proves the master password is correct without storing
/// any direct password hash.
pub(crate) const VERIFIER_PLAINTEXT: &[u8] = b"zeroterm-vault-verifier-v1";

/// AAD tag attached to the verifier blob, distinct from per-record AAD
/// to make sure a verifier ciphertext can never be confused with a
/// record ciphertext.
const VERIFIER_AAD: &[u8] = b"zeroterm-vault-verifier";

/// HKDF info string for record key derivation. Bumping the suffix
/// (e.g. `-v2`) is how we'd rotate the per-record key derivation
/// without disturbing the master key derivation.
const RECORD_INFO: &[u8] = b"zeroterm-record-v1";

/// Argon2id parameters. Defaults match RFC-001 (64 MiB / 3 iters / 4 lanes).
///
/// This is a thin newtype over [`zeroterm_crypto::Argon2Params`] so the
/// vault keeps its existing public API while the primitives are shared.
#[derive(Debug, Clone, Copy)]
pub struct Argon2Params {
    /// Memory cost, in KiB.
    pub m_cost: u32,
    /// Time cost, in iterations.
    pub t_cost: u32,
    /// Parallelism (lanes).
    pub p_cost: u32,
}

impl Default for Argon2Params {
    fn default() -> Self {
        let d = KdfParams::default();
        Self {
            m_cost: d.m_cost,
            t_cost: d.t_cost,
            p_cost: d.p_cost,
        }
    }
}

impl Argon2Params {
    fn to_crypto(self) -> KdfParams {
        KdfParams {
            m_cost: self.m_cost,
            t_cost: self.t_cost,
            p_cost: self.p_cost,
        }
    }

    pub(crate) fn to_bytes(self) -> [u8; 12] {
        self.to_crypto().to_bytes()
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        let p = KdfParams::from_bytes(bytes).map_err(|_| VaultError::Corrupt)?;
        Ok(Self {
            m_cost: p.m_cost,
            t_cost: p.t_cost,
            p_cost: p.p_cost,
        })
    }
}

/// Owned 32-byte master key. Auto-zeroes on drop.
pub(crate) type MasterKey = SymmetricKey;

pub(crate) fn random_bytes(n: usize) -> Vec<u8> {
    crypto_random_bytes(n)
}

fn map_crypto_err(e: CryptoError) -> VaultError {
    tracing::error!(error = ?e, "vault crypto failed");
    VaultError::Crypto
}

pub(crate) fn derive_master_key(
    password: &str,
    salt: &[u8],
    params: Argon2Params,
) -> Result<MasterKey, VaultError> {
    derive_key_argon2id(password.as_bytes(), salt, params.to_crypto()).map_err(map_crypto_err)
}

fn derive_record_key(master: &MasterKey, record_id: &str) -> SymmetricKey {
    // Salt = record_id, info = constant tag. Both inputs are controlled,
    // 32-byte output is well within HKDF-SHA256's max.
    let okm = hkdf_subkey::<KEY_LEN>(master.as_ref(), record_id.as_bytes(), RECORD_INFO);
    // Re-wrap into a SymmetricKey alias (same shape, but the explicit
    // re-construction makes intent clear at the call site).
    let mut key: SymmetricKey = zeroize::Zeroizing::new([0u8; KEY_LEN]);
    key.as_mut().copy_from_slice(okm.as_ref());
    key
}

fn record_aad(record_id: &str, version: i64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(record_id.len() + 8);
    aad.extend_from_slice(record_id.as_bytes());
    aad.extend_from_slice(&version.to_le_bytes());
    aad
}

/// Encrypt `plaintext` for the given record. Returns `(nonce, ciphertext)`.
pub(crate) fn encrypt_record(
    master: &MasterKey,
    record_id: &str,
    version: i64,
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let key = derive_record_key(master, record_id);
    let aad = record_aad(record_id, version);
    let (nonce, ct) = aead_seal(&key, plaintext, &aad).map_err(map_crypto_err)?;
    Ok((nonce.to_vec(), ct))
}

/// Decrypt a previously-encrypted record. Wrong key, tampered ciphertext,
/// or mismatched aad all collapse into [`VaultError::Crypto`].
pub(crate) fn decrypt_record(
    master: &MasterKey,
    record_id: &str,
    version: i64,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::Crypto);
    }
    let key = derive_record_key(master, record_id);
    let aad = record_aad(record_id, version);
    aead_decrypt(&key, nonce, ciphertext, &aad).map_err(map_crypto_err)
}

/// Encrypt the verifier constant. Stored at vault creation; the unlock
/// path tries to decrypt it back to confirm the password is right.
pub(crate) fn encrypt_verifier(master: &MasterKey) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let (nonce, ct) = aead_seal(master, VERIFIER_PLAINTEXT, VERIFIER_AAD).map_err(map_crypto_err)?;
    Ok((nonce.to_vec(), ct))
}

/// Verify the master key by decrypting the stored verifier blob and
/// comparing to the known constant.
pub(crate) fn verify_master_key(
    master: &MasterKey,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<(), VaultError> {
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::Corrupt);
    }
    let pt = aead_decrypt(master, nonce, ciphertext, VERIFIER_AAD)
        .map_err(|_| VaultError::AuthenticationFailed)?;

    if !zeroterm_crypto::constant_time_eq(&pt, VERIFIER_PLAINTEXT) {
        let mut pt = pt;
        pt.zeroize();
        return Err(VaultError::AuthenticationFailed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_master() -> MasterKey {
        let salt = random_bytes(16);
        derive_master_key("hunter2", &salt, Argon2Params::default()).unwrap()
    }

    #[test]
    fn record_roundtrip() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, b"hello").unwrap();
        let pt = decrypt_record(&master, "id-1", 1, &nonce, &ct).unwrap();
        assert_eq!(pt, b"hello");
    }

    #[test]
    fn record_id_is_bound_into_aad() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, b"hello").unwrap();
        assert!(decrypt_record(&master, "id-OTHER", 1, &nonce, &ct).is_err());
    }

    #[test]
    fn version_is_bound_into_aad() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, b"hello").unwrap();
        assert!(decrypt_record(&master, "id-1", 2, &nonce, &ct).is_err());
    }

    #[test]
    fn verifier_round_trip() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_verifier(&master).unwrap();
        verify_master_key(&master, &nonce, &ct).unwrap();
    }

    #[test]
    fn verifier_rejects_wrong_master() {
        let m1 = fresh_master();
        let m2 = fresh_master();
        let (nonce, ct) = encrypt_verifier(&m1).unwrap();
        assert!(matches!(
            verify_master_key(&m2, &nonce, &ct),
            Err(VaultError::AuthenticationFailed)
        ));
    }

    #[test]
    fn argon2_params_roundtrip() {
        let p = Argon2Params {
            m_cost: 32 * 1024,
            t_cost: 2,
            p_cost: 1,
        };
        let bytes = p.to_bytes();
        let p2 = Argon2Params::from_bytes(&bytes).unwrap();
        assert_eq!(p.m_cost, p2.m_cost);
        assert_eq!(p.t_cost, p2.t_cost);
        assert_eq!(p.p_cost, p2.p_cost);
    }
}
