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
//!      is `record_id || version_le_bytes`, binding each ciphertext to
//!      its record id and version number.
//!
//! Threat-model note on rollback (CORE-2): the AAD version binding
//! prevents a ciphertext from being *relabelled* with a different
//! version, but it does NOT by itself stop an attacker who can write the
//! local SQLite file from restoring an older, still-authentic
//! `(ciphertext, nonce, version)` triple for a record — that triple
//! decrypts correctly because its own version travels with it. The
//! version is read from the same row, so there is no trusted monotonic
//! anchor here. A global high-water mark wouldn't close this either:
//! versions are globally unique, so a rolled-back row's version is still
//! ≤ any global maximum. Defending single-record rollback would require
//! per-record authenticated version state, which is out of scope — the
//! at-rest guarantee ZeroTerm makes is confidentiality/integrity under
//! the master key, and an attacker with local write access but no master
//! password is the boundary of that guarantee. Do not re-add a comment
//! claiming rollback resistance the code does not provide.
//!
//! The primitives themselves live in [`zeroterm_crypto`]. This module
//! owns only the vault-specific `info` strings and AAD shape — those are
//! deliberately not shared with the sync layer (see RFC-002 §16 and the
//! plan in `snug-mapping-koala.md` §2).

use zeroize::{Zeroize, Zeroizing};

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

/// Legacy per-record AAD (pre-CORE-4): `record_id || version_le`. Kept so
/// records written before the `kind` binding was added still decrypt.
fn record_aad_v1(record_id: &str, version: i64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(record_id.len() + 8);
    aad.extend_from_slice(record_id.as_bytes());
    aad.extend_from_slice(&version.to_le_bytes());
    aad
}

/// Previous per-record AAD (early CORE-4): `record_id || version_le || 0x1f
/// || kind`. Kept for backward-compatible reads of live records written
/// before the deletion bit was authenticated.
fn record_aad_v2(record_id: &str, version: i64, kind: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(record_id.len() + 9 + kind.len());
    aad.extend_from_slice(record_id.as_bytes());
    aad.extend_from_slice(&version.to_le_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(kind.as_bytes());
    aad
}

/// Current per-record AAD (CORE-4): `record_id || version_le || 0x1f ||
/// kind || 0x1f || deleted`. Binding `kind` means an attacker who can rewrite the (plaintext)
/// `kind` column can no longer make a record decrypt under a different
/// kind — which mattered because the desktop's conflict preview only
/// masks secrets for `kind == "host"`, so a silent `host → snippet`
/// relabel would have surfaced the raw password JSON. Binding `deleted`
/// makes flipping a live row into a tombstone (or vice versa) fail
/// authentication instead of silently hiding/resurrecting it.
fn record_aad_v3(record_id: &str, version: i64, kind: &str, deleted: bool) -> Vec<u8> {
    let mut aad = Vec::with_capacity(record_id.len() + 11 + kind.len());
    aad.extend_from_slice(record_id.as_bytes());
    aad.extend_from_slice(&version.to_le_bytes());
    aad.push(0x1f);
    aad.extend_from_slice(kind.as_bytes());
    aad.push(0x1f);
    aad.push(u8::from(deleted));
    aad
}

/// Encrypt `plaintext` for the given record. Returns `(nonce, ciphertext)`.
/// New writes always use the v2 (kind-bound) AAD.
pub(crate) fn encrypt_record(
    master: &MasterKey,
    record_id: &str,
    version: i64,
    kind: &str,
    deleted: bool,
    plaintext: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let key = derive_record_key(master, record_id);
    let aad = record_aad_v3(record_id, version, kind, deleted);
    let (nonce, ct) = aead_seal(&key, plaintext, &aad).map_err(map_crypto_err)?;
    Ok((nonce.to_vec(), ct))
}

/// Decrypt a previously-encrypted record. Wrong key, tampered ciphertext,
/// or mismatched aad all collapse into [`VaultError::Crypto`].
///
/// Tries the v2 (kind-bound) AAD first, then falls back to the v1 AAD so
/// records written before CORE-4 still open. A v1 hit is reported via the
/// returned flag so the caller can lazily re-encrypt to v2 on the next
/// write (the vault does this transparently).
///
/// Returns `Zeroizing<Vec<u8>>` so the decrypted plaintext (which may be
/// a password / private-key PEM) is wiped from the heap on drop rather
/// than lingering in freed memory for a dump/swap/cold-boot to recover
/// (CORE-3).
pub(crate) fn decrypt_record(
    master: &MasterKey,
    record_id: &str,
    version: i64,
    kind: &str,
    deleted: bool,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    decrypt_record_detect(
        master,
        record_id,
        version,
        kind,
        deleted,
        nonce,
        ciphertext,
    )
    .map(|(pt, _)| pt)
}

/// Like [`decrypt_record`] but also reports whether the ciphertext was in
/// the legacy v1 AAD format (`true` ⇒ caller should re-encrypt to v2).
pub(crate) fn decrypt_record_detect(
    master: &MasterKey,
    record_id: &str,
    version: i64,
    kind: &str,
    deleted: bool,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<(Zeroizing<Vec<u8>>, bool), VaultError> {
    // Pre-CORE-4 tombstones deliberately stored no ciphertext. Accept that
    // exact legacy shape, but never accept a non-empty legacy ciphertext as
    // deleted: before deleted-aware AAD, legitimate deleted rows were always
    // empty, so a non-empty row with `deleted=1` is a tampered live record.
    if deleted && nonce.is_empty() && ciphertext.is_empty() {
        return Ok((Zeroizing::new(Vec::new()), true));
    }
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::Crypto);
    }
    let key = derive_record_key(master, record_id);
    let aad_v3 = record_aad_v3(record_id, version, kind, deleted);
    if let Ok(pt) = aead_decrypt(&key, nonce, ciphertext, &aad_v3) {
        return Ok((Zeroizing::new(pt), false));
    }
    if deleted {
        return Err(VaultError::Crypto);
    }
    let aad_v2 = record_aad_v2(record_id, version, kind);
    if let Ok(pt) = aead_decrypt(&key, nonce, ciphertext, &aad_v2) {
        return Ok((Zeroizing::new(pt), true));
    }
    // Backward compatibility: records sealed before CORE-4.
    let aad_v1 = record_aad_v1(record_id, version);
    aead_decrypt(&key, nonce, ciphertext, &aad_v1)
        .map(|pt| (Zeroizing::new(pt), true))
        .map_err(map_crypto_err)
}

/// HKDF info string for the verifier subkey (CORE-7). Deriving a
/// dedicated key means the master key is never used directly as an AEAD
/// key — it stays purely HKDF input keying material, matching how record
/// keys are derived. Bumping the suffix rotates the verifier derivation.
const VERIFIER_INFO: &[u8] = b"zeroterm-vault-verifier-key-v1";

/// Derive the dedicated verifier subkey from the master key.
fn derive_verifier_key(master: &MasterKey) -> SymmetricKey {
    let okm = hkdf_subkey::<KEY_LEN>(master.as_ref(), b"verifier", VERIFIER_INFO);
    let mut key: SymmetricKey = Zeroizing::new([0u8; KEY_LEN]);
    key.as_mut().copy_from_slice(okm.as_ref());
    key
}

/// HKDF info string for general-purpose local blob encryption (TAURI-7).
const LOCAL_BLOB_INFO: &[u8] = b"zeroterm-vault-local-blob-v1";

/// Derive a per-context subkey for [`encrypt_blob`]. `context` (e.g.
/// `"ai-sessions"`) is the HKDF salt, so distinct blob kinds get
/// independent keys — domain-separated from record and verifier keys.
fn derive_blob_key(master: &MasterKey, context: &str) -> SymmetricKey {
    let okm = hkdf_subkey::<KEY_LEN>(master.as_ref(), context.as_bytes(), LOCAL_BLOB_INFO);
    let mut key: SymmetricKey = Zeroizing::new([0u8; KEY_LEN]);
    key.as_mut().copy_from_slice(okm.as_ref());
    key
}

/// Encrypt an arbitrary local blob (config-dir files that live outside
/// the records table but still hold sensitive data, e.g. AI session
/// history — TAURI-7). Returns `nonce || ciphertext`; `context` is bound
/// as AAD so a blob can't be replayed under a different context.
pub(crate) fn encrypt_blob(
    master: &MasterKey,
    context: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, VaultError> {
    let key = derive_blob_key(master, context);
    let (nonce, ct) = aead_seal(&key, plaintext, context.as_bytes()).map_err(map_crypto_err)?;
    let mut out = Vec::with_capacity(nonce.len() + ct.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Inverse of [`encrypt_blob`]. Expects `nonce || ciphertext`.
pub(crate) fn decrypt_blob(
    master: &MasterKey,
    context: &str,
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, VaultError> {
    if blob.len() < NONCE_LEN {
        return Err(VaultError::Crypto);
    }
    let (nonce, ct) = blob.split_at(NONCE_LEN);
    let key = derive_blob_key(master, context);
    aead_decrypt(&key, nonce, ct, context.as_bytes())
        .map(Zeroizing::new)
        .map_err(map_crypto_err)
}

/// Encrypt the verifier constant. Stored at vault creation; the unlock
/// path tries to decrypt it back to confirm the password is right. Sealed
/// under the HKDF-derived verifier subkey (CORE-7 domain separation).
pub(crate) fn encrypt_verifier(master: &MasterKey) -> Result<(Vec<u8>, Vec<u8>), VaultError> {
    let key = derive_verifier_key(master);
    let (nonce, ct) = aead_seal(&key, VERIFIER_PLAINTEXT, VERIFIER_AAD).map_err(map_crypto_err)?;
    Ok((nonce.to_vec(), ct))
}

/// Verify the master key by decrypting the stored verifier blob and
/// comparing to the known constant. Returns `true` when the blob was in
/// the legacy format (sealed with the master key directly, pre-CORE-7) so
/// the caller can re-encrypt it under the derived subkey.
pub(crate) fn verify_master_key(
    master: &MasterKey,
    nonce: &[u8],
    ciphertext: &[u8],
) -> Result<bool, VaultError> {
    if nonce.len() != NONCE_LEN {
        return Err(VaultError::Corrupt);
    }

    // Current format: sealed under the derived verifier subkey.
    let derived = derive_verifier_key(master);
    if let Ok(pt) = aead_decrypt(&derived, nonce, ciphertext, VERIFIER_AAD) {
        let ok = zeroterm_crypto::constant_time_eq(&pt, VERIFIER_PLAINTEXT);
        let mut pt = pt;
        pt.zeroize();
        return if ok {
            Ok(false)
        } else {
            Err(VaultError::AuthenticationFailed)
        };
    }

    // Legacy format (pre-CORE-7): sealed with the master key directly.
    let pt = aead_decrypt(master, nonce, ciphertext, VERIFIER_AAD)
        .map_err(|_| VaultError::AuthenticationFailed)?;
    let ok = zeroterm_crypto::constant_time_eq(&pt, VERIFIER_PLAINTEXT);
    let mut pt = pt;
    pt.zeroize();
    if ok {
        Ok(true)
    } else {
        Err(VaultError::AuthenticationFailed)
    }
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
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, "host", false, b"hello").unwrap();
        let pt = decrypt_record(&master, "id-1", 1, "host", false, &nonce, &ct).unwrap();
        assert_eq!(pt.as_slice(), b"hello");
    }

    #[test]
    fn record_id_is_bound_into_aad() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, "host", false, b"hello").unwrap();
        assert!(decrypt_record(&master, "id-OTHER", 1, "host", false, &nonce, &ct).is_err());
    }

    #[test]
    fn version_is_bound_into_aad() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, "host", false, b"hello").unwrap();
        assert!(decrypt_record(&master, "id-1", 2, "host", false, &nonce, &ct).is_err());
    }

    #[test]
    fn kind_is_bound_into_aad() {
        // CORE-4: the same id/version under a different kind must not open.
        let master = fresh_master();
        let (nonce, ct) = encrypt_record(&master, "id-1", 1, "host", false, b"secret").unwrap();
        assert!(decrypt_record(&master, "id-1", 1, "snippet", false, &nonce, &ct).is_err());
        assert_eq!(
            decrypt_record(&master, "id-1", 1, "host", false, &nonce, &ct)
                .unwrap()
                .as_slice(),
            b"secret"
        );
    }

    #[test]
    fn deleted_state_is_bound_into_aad() {
        let master = fresh_master();
        let (live_nonce, live_ct) =
            encrypt_record(&master, "id-live", 1, "host", false, b"secret").unwrap();
        assert!(
            decrypt_record(
                &master,
                "id-live",
                1,
                "host",
                true,
                &live_nonce,
                &live_ct,
            )
            .is_err(),
            "a live row relabelled as deleted must fail authentication"
        );

        let (dead_nonce, dead_ct) =
            encrypt_record(&master, "id-dead", 2, "host", true, &[]).unwrap();
        assert!(
            decrypt_record(
                &master,
                "id-dead",
                2,
                "host",
                false,
                &dead_nonce,
                &dead_ct,
            )
            .is_err(),
            "a tombstone relabelled as live must fail authentication"
        );
        assert!(
            decrypt_record(
                &master,
                "id-dead",
                2,
                "host",
                true,
                &dead_nonce,
                &dead_ct,
            )
            .unwrap()
            .is_empty()
        );
    }

    #[test]
    fn v1_ciphertext_still_decrypts_via_fallback() {
        // A record sealed with the pre-CORE-4 AAD (id||version only) must
        // still open, and be flagged as legacy so callers can migrate it.
        let master = fresh_master();
        let key = derive_record_key(&master, "id-1");
        let aad_v1 = record_aad_v1("id-1", 7);
        let (nonce, ct) = aead_seal(&key, b"legacy-plaintext", &aad_v1).unwrap();

        let (pt, was_legacy) = decrypt_record_detect(
            &master,
            "id-1",
            7,
            "host",
            false,
            nonce.as_ref(),
            &ct,
        )
        .unwrap();
        assert_eq!(pt.as_slice(), b"legacy-plaintext");
        assert!(was_legacy, "v1 ciphertext must be reported as legacy");

        // A v3 ciphertext is not flagged legacy.
        let (nonce2, ct2) =
            encrypt_record(&master, "id-1", 7, "host", false, b"new").unwrap();
        let (_pt2, was_legacy2) = decrypt_record_detect(
            &master, "id-1", 7, "host", false, &nonce2, &ct2,
        )
        .unwrap();
        assert!(!was_legacy2);
    }

    #[test]
    fn legacy_tombstone_shape_is_accepted_but_live_legacy_ciphertext_cannot_be_relabelled() {
        let master = fresh_master();
        let (pt, legacy) =
            decrypt_record_detect(&master, "old-dead", 3, "host", true, &[], &[]).unwrap();
        assert!(pt.is_empty());
        assert!(legacy);

        let key = derive_record_key(&master, "old-live");
        let aad_v2 = record_aad_v2("old-live", 4, "host");
        let (nonce, ct) = aead_seal(&key, b"still live", &aad_v2).unwrap();
        assert!(
            decrypt_record_detect(
                &master,
                "old-live",
                4,
                "host",
                true,
                &nonce,
                &ct,
            )
            .is_err()
        );
    }

    #[test]
    fn verifier_round_trip() {
        let master = fresh_master();
        let (nonce, ct) = encrypt_verifier(&master).unwrap();
        // Current format verifies and is NOT flagged legacy.
        assert!(!verify_master_key(&master, &nonce, &ct).unwrap());
    }

    #[test]
    fn legacy_verifier_verifies_and_is_flagged() {
        // CORE-7: a verifier sealed the old way (master key used directly
        // as the AEAD key) must still verify, and be reported as legacy so
        // the vault re-seals it under the derived subkey.
        let master = fresh_master();
        let (nonce, ct) = aead_seal(&master, VERIFIER_PLAINTEXT, VERIFIER_AAD).unwrap();
        assert!(verify_master_key(&master, nonce.as_ref(), &ct).unwrap());
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
