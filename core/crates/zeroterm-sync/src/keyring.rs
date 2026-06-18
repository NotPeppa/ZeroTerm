//! Passphrase keyring: wraps the sync root key with one Argon2id-derived
//! key per enrolled device.
//!
//! Layout on disk (RFC-002 §10.2):
//!   `keyring.json`
//!   ```text
//!   {
//!     "schema_version": 1,
//!     "entries": [
//!       {
//!         "device_id": "...",
//!         "kdf_salt_b64": "...",
//!         "kdf_params": { "m_cost": 65536, "t_cost": 3, "p_cost": 4 },
//!         "wrap_nonce_b64": "...",
//!         "wrap_ct_b64": "..."   // sealed (sync_root_key, AAD = device_id)
//!       },
//!       ...
//!     ]
//!   }
//!   ```
//!
//! Adding a device = append a new entry (the inviter unwraps with their
//! own passphrase, then re-wraps with the invitee's passphrase). Revoking
//! a device = remove the entry **and** rotate the root key (otherwise the
//! revoked passphrase still works against old ciphertexts the device
//! already copied). Root rotation is M7; for M1 we only support enroll.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use zeroterm_crypto::{
    aead_decrypt, aead_encrypt, derive_key_argon2id, random_nonce, Argon2Params, SymmetricKey,
    KEY_LEN, NONCE_LEN,
};

use crate::crypto::SyncRootKey;
use crate::error::Error;

/// On-disk schema version for the keyring file. Bumped if the layout
/// ever changes — the AAD format is part of the layout, so bumping this
/// would also rotate which AAD bytes are tagged.
pub const KEYRING_SCHEMA: u32 = 1;

/// AAD tag bound into every wrap ciphertext. Includes the device id so
/// one device's wrapped key can't be replayed as another's.
fn wrap_aad(device_id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(b"zeroterm-sync-keyring-v1|".len() + device_id.len());
    aad.extend_from_slice(b"zeroterm-sync-keyring-v1|");
    aad.extend_from_slice(device_id.as_bytes());
    aad
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParamsSerde {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl From<Argon2Params> for KdfParamsSerde {
    fn from(p: Argon2Params) -> Self {
        Self {
            m_cost: p.m_cost,
            t_cost: p.t_cost,
            p_cost: p.p_cost,
        }
    }
}

impl From<KdfParamsSerde> for Argon2Params {
    fn from(p: KdfParamsSerde) -> Self {
        Argon2Params {
            m_cost: p.m_cost,
            t_cost: p.t_cost,
            p_cost: p.p_cost,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyringEntry {
    pub device_id: String,
    pub kdf_salt_b64: String,
    pub kdf_params: KdfParamsSerde,
    pub wrap_nonce_b64: String,
    pub wrap_ct_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyring {
    pub schema_version: u32,
    pub entries: Vec<KeyringEntry>,
}

impl Default for Keyring {
    fn default() -> Self {
        Self {
            schema_version: KEYRING_SCHEMA,
            entries: Vec::new(),
        }
    }
}

impl Keyring {
    /// Look up an entry by device id.
    pub fn entry(&self, device_id: &str) -> Option<&KeyringEntry> {
        self.entries.iter().find(|e| e.device_id == device_id)
    }

    /// Encode as pretty JSON (canonical-enough; ordering follows struct
    /// field order). Atomic write is the adapter's job.
    pub fn to_json(&self) -> Result<Vec<u8>, Error> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        let me: Keyring = serde_json::from_slice(bytes)?;
        if me.schema_version > KEYRING_SCHEMA {
            return Err(Error::SchemaTooNew {
                repo: me.schema_version,
                max: KEYRING_SCHEMA,
            });
        }
        Ok(me)
    }
}

/// Wrap `root` with a passphrase-derived key and produce a fresh keyring
/// entry for the given `device_id`. Used both on repo creation (the
/// inviter's own entry) and on join (a second device's entry).
pub fn wrap_root_key(
    device_id: &str,
    passphrase: &str,
    params: Argon2Params,
    root: &SyncRootKey,
) -> Result<KeyringEntry, Error> {
    let salt = zeroterm_crypto::random_bytes(16);
    let wrap_key = derive_key_argon2id(passphrase.as_bytes(), &salt, params)?;
    let nonce = random_nonce();
    let aad = wrap_aad(device_id);
    let ct = aead_encrypt(&wrap_key, &nonce, root.as_ref(), &aad)?;

    Ok(KeyringEntry {
        device_id: device_id.to_string(),
        kdf_salt_b64: B64.encode(&salt),
        kdf_params: params.into(),
        wrap_nonce_b64: B64.encode(nonce),
        wrap_ct_b64: B64.encode(&ct),
    })
}

/// Unwrap the sync root key for `device_id` using the given passphrase.
/// Wrong passphrase ⇒ [`Error::AuthenticationFailed`].
pub fn unwrap_root_key(entry: &KeyringEntry, passphrase: &str) -> Result<SyncRootKey, Error> {
    let salt = B64
        .decode(entry.kdf_salt_b64.as_bytes())
        .map_err(|_| Error::Base64)?;
    let nonce = B64
        .decode(entry.wrap_nonce_b64.as_bytes())
        .map_err(|_| Error::Base64)?;
    let ct = B64
        .decode(entry.wrap_ct_b64.as_bytes())
        .map_err(|_| Error::Base64)?;
    if nonce.len() != NONCE_LEN {
        return Err(Error::Corrupt);
    }

    let wrap_key = derive_key_argon2id(passphrase.as_bytes(), &salt, entry.kdf_params.into())?;
    let aad = wrap_aad(&entry.device_id);
    let plain =
        aead_decrypt(&wrap_key, &nonce, &ct, &aad).map_err(|_| Error::AuthenticationFailed)?;

    if plain.len() != KEY_LEN {
        return Err(Error::Corrupt);
    }
    let mut root: SymmetricKey = Zeroizing::new([0u8; KEY_LEN]);
    root.as_mut().copy_from_slice(&plain);
    // Drop the plaintext copy explicitly; SymmetricKey will zero itself
    // when it goes out of scope, but this minimises window-of-exposure.
    drop(plain);
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::fresh_root_key;

    fn fast_params() -> Argon2Params {
        Argon2Params {
            m_cost: 8 * 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let root = fresh_root_key();
        let entry = wrap_root_key("dev-A", "hunter2", fast_params(), &root).unwrap();
        let got = unwrap_root_key(&entry, "hunter2").unwrap();
        assert_eq!(got.as_ref(), root.as_ref());
    }

    #[test]
    fn wrong_passphrase_rejected() {
        let root = fresh_root_key();
        let entry = wrap_root_key("dev-A", "hunter2", fast_params(), &root).unwrap();
        assert!(matches!(
            unwrap_root_key(&entry, "WRONG"),
            Err(Error::AuthenticationFailed)
        ));
    }

    #[test]
    fn second_device_can_be_enrolled_independently() {
        // Inviter wraps once, then re-wraps for the invitee using a
        // different passphrase — both must unwrap to the same root.
        let root = fresh_root_key();
        let a = wrap_root_key("dev-A", "alice-pw", fast_params(), &root).unwrap();
        let b = wrap_root_key("dev-B", "bob-pw", fast_params(), &root).unwrap();

        let from_a = unwrap_root_key(&a, "alice-pw").unwrap();
        let from_b = unwrap_root_key(&b, "bob-pw").unwrap();
        assert_eq!(from_a.as_ref(), root.as_ref());
        assert_eq!(from_b.as_ref(), root.as_ref());
        // Cross-attempts must fail.
        assert!(unwrap_root_key(&a, "bob-pw").is_err());
        assert!(unwrap_root_key(&b, "alice-pw").is_err());
    }

    #[test]
    fn aad_binds_device_id_so_entries_cant_swap() {
        let root = fresh_root_key();
        let entry = wrap_root_key("dev-A", "pw", fast_params(), &root).unwrap();
        // Rename the entry to a different device id — same passphrase,
        // same salt — and confirm the AEAD rejects it.
        let mut tampered = entry.clone();
        tampered.device_id = "dev-B".to_string();
        assert!(matches!(
            unwrap_root_key(&tampered, "pw"),
            Err(Error::AuthenticationFailed)
        ));
    }

    #[test]
    fn keyring_json_roundtrip_preserves_entries() {
        let root = fresh_root_key();
        let a = wrap_root_key("dev-A", "pw-a", fast_params(), &root).unwrap();
        let b = wrap_root_key("dev-B", "pw-b", fast_params(), &root).unwrap();
        let kr = Keyring {
            schema_version: KEYRING_SCHEMA,
            entries: vec![a, b],
        };
        let bytes = kr.to_json().unwrap();
        let back = Keyring::from_json(&bytes).unwrap();
        assert_eq!(back.entries.len(), 2);
        assert_eq!(back.entries[0].device_id, "dev-A");
        // Unwrap still works through the JSON detour.
        let r = unwrap_root_key(&back.entries[1], "pw-b").unwrap();
        assert_eq!(r.as_ref(), root.as_ref());
    }

    #[test]
    fn keyring_rejects_future_schema() {
        let json = br#"{"schema_version":999,"entries":[]}"#;
        assert!(matches!(
            Keyring::from_json(json),
            Err(Error::SchemaTooNew { .. })
        ));
    }
}
