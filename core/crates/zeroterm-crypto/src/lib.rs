//! Shared crypto primitives used by both the vault and the sync layer.
//!
//! This crate is intentionally tiny: it only wraps the three building blocks
//! we need (Argon2id, HKDF-SHA256, XChaCha20-Poly1305) and exposes them with
//! a typed-key API and an opaque error. Callers above this layer define
//! their own HKDF `info` strings and AAD layouts — coupling those across
//! crates is exactly the footgun we want to avoid.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use thiserror::Error;
use zeroize::Zeroizing;

/// XChaCha20-Poly1305 key length in bytes.
pub const KEY_LEN: usize = 32;
/// XChaCha20 nonce length in bytes.
pub const NONCE_LEN: usize = 24;

/// Resource ceilings for persisted/untrusted Argon2 parameters. Vault files
/// and sync keyrings carry these values, so accepting arbitrary `u32`s would
/// let a corrupted or hostile file request impractical memory/CPU during
/// unlock. These limits remain comfortably above ZeroTerm's defaults.
pub const MAX_ARGON2_MEMORY_KIB: u32 = 256 * 1024;
pub const MAX_ARGON2_ITERATIONS: u32 = 10;
pub const MAX_ARGON2_LANES: u32 = 16;

/// A 32-byte symmetric key that auto-zeroes on drop.
pub type SymmetricKey = Zeroizing<[u8; KEY_LEN]>;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid KDF parameters")]
    InvalidParams,
    #[error("KDF failed")]
    Kdf,
    #[error("AEAD operation failed")]
    Aead,
    #[error("invalid input length")]
    InvalidLength,
}

/// Argon2id parameters. Defaults match RFC-001 (64 MiB / 3 iters / 4 lanes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
            m_cost: 64 * 1024,
            t_cost: 3,
            p_cost: 4,
        }
    }
}

impl Argon2Params {
    /// Fixed-width little-endian encoding suitable for persisting alongside
    /// derived material (vault meta, keyring json, etc.).
    pub fn to_bytes(self) -> [u8; 12] {
        let mut out = [0u8; 12];
        out[0..4].copy_from_slice(&self.m_cost.to_le_bytes());
        out[4..8].copy_from_slice(&self.t_cost.to_le_bytes());
        out[8..12].copy_from_slice(&self.p_cost.to_le_bytes());
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CryptoError> {
        if bytes.len() != 12 {
            return Err(CryptoError::InvalidLength);
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

/// Fill a `Vec` with `n` cryptographically random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// A fresh 24-byte XChaCha20 nonce.
pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut n);
    n
}

/// Argon2id KDF — derive a 32-byte symmetric key from `password` and `salt`.
pub fn derive_key_argon2id(
    password: &[u8],
    salt: &[u8],
    params: Argon2Params,
) -> Result<SymmetricKey, CryptoError> {
    if params.m_cost > MAX_ARGON2_MEMORY_KIB
        || params.t_cost > MAX_ARGON2_ITERATIONS
        || params.p_cost > MAX_ARGON2_LANES
    {
        return Err(CryptoError::InvalidParams);
    }
    let argon_params = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(KEY_LEN))
        .map_err(|e| {
            tracing::error!(error = ?e, "invalid Argon2 params");
            CryptoError::InvalidParams
        })?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut out: SymmetricKey = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password, salt, out.as_mut())
        .map_err(|e| {
            tracing::error!(error = ?e, "argon2 derive failed");
            CryptoError::Kdf
        })?;
    Ok(out)
}

/// HKDF-SHA256 — derive an `N`-byte subkey from input keying material.
///
/// The `salt`/`info` semantics are intentionally exposed so callers can
/// bind subkeys to context-specific labels. `N` must be at most 255 * 32 =
/// 8160 bytes (HKDF-SHA256 max output); the call panics otherwise, which
/// is a programming error rather than a runtime failure.
pub fn hkdf_subkey<const N: usize>(ikm: &[u8], salt: &[u8], info: &[u8]) -> Zeroizing<[u8; N]> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm: Zeroizing<[u8; N]> = Zeroizing::new([0u8; N]);
    hk.expand(info, okm.as_mut())
        .expect("HKDF-SHA256 expand within max length");
    okm
}

/// XChaCha20-Poly1305 encrypt. Caller supplies a 24-byte nonce.
pub fn aead_encrypt(
    key: &SymmetricKey,
    nonce: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::InvalidLength);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    cipher
        .encrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Aead)
}

/// XChaCha20-Poly1305 decrypt. Wrong key / tampered ciphertext / mismatched
/// AAD all collapse into [`CryptoError::Aead`].
pub fn aead_decrypt(
    key: &SymmetricKey,
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if nonce.len() != NONCE_LEN {
        return Err(CryptoError::InvalidLength);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_ref()));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Aead)
}

/// Convenience: encrypt with a freshly generated nonce. Returns `(nonce, ct)`.
pub fn aead_seal(
    key: &SymmetricKey,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<([u8; NONCE_LEN], Vec<u8>), CryptoError> {
    let nonce = random_nonce();
    let ct = aead_encrypt(key, &nonce, plaintext, aad)?;
    Ok((nonce, ct))
}

/// Constant-time byte slice comparison.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
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

    fn fast_params() -> Argon2Params {
        Argon2Params {
            m_cost: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    fn fresh_key() -> SymmetricKey {
        let salt = random_bytes(16);
        derive_key_argon2id(b"hunter2", &salt, fast_params()).unwrap()
    }

    #[test]
    fn argon2_params_roundtrip() {
        let p = Argon2Params {
            m_cost: 32 * 1024,
            t_cost: 2,
            p_cost: 1,
        };
        let bytes = p.to_bytes();
        assert_eq!(Argon2Params::from_bytes(&bytes).unwrap(), p);
    }

    #[test]
    fn argon2_params_from_bytes_rejects_bad_len() {
        assert!(matches!(
            Argon2Params::from_bytes(&[0u8; 8]),
            Err(CryptoError::InvalidLength)
        ));
    }

    #[test]
    fn argon2_rejects_resource_exhaustion_parameters() {
        let salt = b"sixteen-byte-slt";
        for params in [
            Argon2Params {
                m_cost: MAX_ARGON2_MEMORY_KIB + 1,
                ..fast_params()
            },
            Argon2Params {
                t_cost: MAX_ARGON2_ITERATIONS + 1,
                ..fast_params()
            },
            Argon2Params {
                p_cost: MAX_ARGON2_LANES + 1,
                ..fast_params()
            },
        ] {
            assert!(matches!(
                derive_key_argon2id(b"pw", salt, params),
                Err(CryptoError::InvalidParams)
            ));
        }
    }

    #[test]
    fn argon2_is_deterministic_given_same_inputs() {
        let salt = b"sixteen-byte-slt";
        let k1 = derive_key_argon2id(b"pw", salt, fast_params()).unwrap();
        let k2 = derive_key_argon2id(b"pw", salt, fast_params()).unwrap();
        assert_eq!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn argon2_differs_for_different_salt() {
        let k1 = derive_key_argon2id(b"pw", b"sixteen-byte-slt", fast_params()).unwrap();
        let k2 = derive_key_argon2id(b"pw", b"another-byte-slt", fast_params()).unwrap();
        assert_ne!(k1.as_ref(), k2.as_ref());
    }

    #[test]
    fn hkdf_subkey_deterministic_and_context_separates() {
        let ikm = [42u8; 32];
        let a = hkdf_subkey::<32>(&ikm, b"salt", b"info-a");
        let b = hkdf_subkey::<32>(&ikm, b"salt", b"info-b");
        let a2 = hkdf_subkey::<32>(&ikm, b"salt", b"info-a");
        assert_eq!(a.as_ref(), a2.as_ref());
        assert_ne!(a.as_ref(), b.as_ref());
    }

    #[test]
    fn aead_roundtrip() {
        let key = fresh_key();
        let nonce = random_nonce();
        let ct = aead_encrypt(&key, &nonce, b"hello", b"aad-1").unwrap();
        let pt = aead_decrypt(&key, &nonce, &ct, b"aad-1").unwrap();
        assert_eq!(pt, b"hello");
    }

    #[test]
    fn aead_rejects_wrong_aad() {
        let key = fresh_key();
        let nonce = random_nonce();
        let ct = aead_encrypt(&key, &nonce, b"hello", b"aad-1").unwrap();
        assert!(aead_decrypt(&key, &nonce, &ct, b"aad-2").is_err());
    }

    #[test]
    fn aead_rejects_tampered_ciphertext() {
        let key = fresh_key();
        let nonce = random_nonce();
        let mut ct = aead_encrypt(&key, &nonce, b"hello", b"aad").unwrap();
        ct[0] ^= 1;
        assert!(aead_decrypt(&key, &nonce, &ct, b"aad").is_err());
    }

    #[test]
    fn aead_rejects_bad_nonce_len() {
        let key = fresh_key();
        assert!(matches!(
            aead_encrypt(&key, b"too-short", b"x", b""),
            Err(CryptoError::InvalidLength)
        ));
        assert!(matches!(
            aead_decrypt(&key, b"too-short", b"x", b""),
            Err(CryptoError::InvalidLength)
        ));
    }

    #[test]
    fn aead_seal_returns_unique_nonces() {
        let key = fresh_key();
        let (n1, _) = aead_seal(&key, b"x", b"").unwrap();
        let (n2, _) = aead_seal(&key, b"x", b"").unwrap();
        assert_ne!(n1, n2);
    }

    #[test]
    fn constant_time_eq_behaves() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
