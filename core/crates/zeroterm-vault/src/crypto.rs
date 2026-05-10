//! Crypto primitives used by the vault.
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
//! See RFC-001 §4 for the rationale.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

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

/// Argon2id parameters. Defaults match RFC-001.
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
        Self {
            m_cost: 64 * 1024, // 64 MiB
            t_cost: 3,
            p_cost: 4,
        }
    }
}

impl Argon2Params {
    pub(crate) fn to_bytes(self) -> [u8; 12] {
        let mut out = [0u8; 12];
        out[0..4].copy_from_slice(&self.m_cost.to_le_bytes());
        out[4..8].copy_from_slice(&self.t_cost.to_le_bytes());
        out[8..12].copy_from_slice(&self.p_cost.to_le_bytes());
        out
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Result<Self, VaultError> {
        if bytes.len() != 12 {
            return Err(VaultError::Corrupt);
        }
        let m_cost = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
        let t_cost = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
        let p_cost = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        Ok(Self {
            m_cost,
            t_cost,
            p_cost,
        })
    }
}

/// Owned 32-byte master key. Auto-zeroes on drop.
pub(crate) type MasterKey = Zeroizing<[u8; 32]>;

pub(crate) fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

pub(crate) fn derive_master_key(
    password: &str,
    salt: &[u8],
    params: Argon2Params,
) -> Result<MasterKey, VaultError> {
    let argon_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| {
            tracing::error!(error = ?e, "invalid Argon2 params");
            VaultError::Crypto
        })?;

    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|e| {
            tracing::error!(error = ?e, "argon2 derive failed");
            VaultError::Crypto
        })?;
    Ok(out)
}

fn derive_record_key(master: &MasterKey, record_id: &str) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(record_id.as_bytes()), master.as_ref());
    let mut okm = Zeroizing::new([0u8; 32]);
    // expand on a 32-byte buffer with our fixed info — both inputs are
    // controlled, infallible at runtime.
    hk.expand(RECORD_INFO, okm.as_mut())
        .expect("HKDF-SHA256 expand of 32 bytes must succeed");
    okm
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
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));

    let mut nonce = vec![0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);

    let aad = record_aad(record_id, version);
    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::Crypto)?;

    Ok((nonce, ct))
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
    if nonce.len() != 24 {
        return Err(VaultError::Crypto);
    }
    let key = derive_record_key(master, record_id);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));

    let aad = record_aad(record_id, version);
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| VaultError::Crypto)
}

/// Encrypt the verifier constant. Stored at vault creation; the unlock
/// path tries to decrypt it back to confirm the password is right.
pub(crate) fn encrypt_verifier(master: &MasterKey) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(master.as_ref()));
    let mut nonce = vec![0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);

    let ct = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: VERIFIER_PLAINTEXT,
                aad: VERIFIER_AAD,
            },
        )
        .map_err(|_| VaultError::Crypto)?;
    Ok((nonce, ct))
}

/// Verify the master key by decrypting the stored verifier blob and
/// comparing to the known constant.
pub(crate) fn verify_master_key(
    master: &MasterKey,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<(), VaultError> {
    if nonce.len() != 24 {
        return Err(VaultError::Corrupt);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(master.as_ref()));
    let pt = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: VERIFIER_AAD,
            },
        )
        .map_err(|_| VaultError::AuthenticationFailed)?;

    // Constant-time compare — chacha20poly1305 already authenticates, but
    // we belt-and-suspenders the equality check just in case.
    if !constant_time_eq(&pt, VERIFIER_PLAINTEXT) {
        let mut pt = pt;
        pt.zeroize();
        return Err(VaultError::AuthenticationFailed);
    }
    Ok(())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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
        // Same key (master) but different record id → must fail.
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
