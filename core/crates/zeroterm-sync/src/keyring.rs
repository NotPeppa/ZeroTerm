//! Passphrase keyring: wraps the sync root key with one Argon2id-derived
//! key per enrolled device.
//!
//! Layout on disk (RFC-002 §10.2):
//!   `keyring.json`
//!   ```text
//!   {
//!     "schema_version": 2,
//!     "root_epoch": 1,
//!     "entries": [
//!       {
//!         "device_id": "...",
//!         "kdf_salt_b64": "...",
//!         "kdf_params": { "m_cost": 65536, "t_cost": 3, "p_cost": 4 },
//!         "wrap_nonce_b64": "...",
//!         "wrap_ct_b64": "..."   // sealed (sync_root_key, AAD = device_id)
//!       },
//!       ...
//!     ],
//!     "mac_b64": "..."          // MAC of the complete entry set
//!   }
//!   ```
//!
//! Adding a device = append a new entry (the inviter unwraps with their
//! own passphrase, then re-wraps with the invitee's passphrase). Revoking
//! a device removes the entry and rotates both the root key and
//! passphrase. The whole entry set is MACed by the new root key so a
//! backend cannot splice an old/revoked entry into the new epoch.

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
pub const KEYRING_SCHEMA: u32 = 2;

/// AAD tag bound into every wrap ciphertext. Includes the device id so
/// one device's wrapped key can't be replayed as another's.
fn wrap_aad(device_id: &str, root_epoch: u64) -> Vec<u8> {
    let label: &[u8] = if root_epoch == 0 {
        b"zeroterm-sync-keyring-v1|"
    } else {
        b"zeroterm-sync-keyring-v2|"
    };
    let mut aad = Vec::with_capacity(label.len() + 24 + device_id.len());
    aad.extend_from_slice(label);
    if root_epoch > 0 {
        aad.extend_from_slice(root_epoch.to_string().as_bytes());
        aad.push(b'|');
    }
    aad.extend_from_slice(device_id.as_bytes());
    aad
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyringMacStatus {
    Valid,
    Absent,
    Invalid,
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
    /// Generation of the sync root key. Epoch 0 is the legacy,
    /// unauthenticated keyring format.
    #[serde(default)]
    pub root_epoch: u64,
    pub entries: Vec<KeyringEntry>,
    /// HMAC over the entire keyring with this field blank.
    #[serde(default)]
    pub mac_b64: String,
}

impl Default for Keyring {
    fn default() -> Self {
        Self {
            schema_version: KEYRING_SCHEMA,
            root_epoch: 0,
            entries: Vec::new(),
            mac_b64: String::new(),
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
        let mut seen = std::collections::HashSet::with_capacity(me.entries.len());
        if me.entries.iter().any(|entry| !seen.insert(&entry.device_id)) {
            return Err(Error::Corrupt);
        }
        Ok(me)
    }

    fn mac_input(&self) -> Result<Vec<u8>, Error> {
        let mut bare = self.clone();
        bare.mac_b64.clear();
        bare.to_json()
    }

    pub fn sign(&mut self, mac_key: &[u8]) -> Result<(), Error> {
        self.mac_b64.clear();
        let tag = zeroterm_crypto::hmac_sha256(mac_key, &self.mac_input()?);
        self.mac_b64 = B64.encode(tag);
        Ok(())
    }

    pub fn verify_mac(&self, mac_key: &[u8]) -> KeyringMacStatus {
        if self.mac_b64.is_empty() {
            return KeyringMacStatus::Absent;
        }
        let Ok(input) = self.mac_input() else {
            return KeyringMacStatus::Invalid;
        };
        let expected = zeroterm_crypto::hmac_sha256(mac_key, &input);
        let Ok(got) = B64.decode(self.mac_b64.as_bytes()) else {
            return KeyringMacStatus::Invalid;
        };
        if zeroterm_crypto::constant_time_eq(&got, &expected) {
            KeyringMacStatus::Valid
        } else {
            KeyringMacStatus::Invalid
        }
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
    wrap_root_key_for_epoch(device_id, passphrase, params, root, 0)
}

pub fn wrap_root_key_for_epoch(
    device_id: &str,
    passphrase: &str,
    params: Argon2Params,
    root: &SyncRootKey,
    root_epoch: u64,
) -> Result<KeyringEntry, Error> {
    let salt = zeroterm_crypto::random_bytes(16);
    let wrap_key = derive_key_argon2id(passphrase.as_bytes(), &salt, params)?;
    let nonce = random_nonce();
    let aad = wrap_aad(device_id, root_epoch);
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
    unwrap_root_key_for_epoch(entry, passphrase, 0)
}

pub fn unwrap_root_key_for_epoch(
    entry: &KeyringEntry,
    passphrase: &str,
    root_epoch: u64,
) -> Result<SyncRootKey, Error> {
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
    let aad = wrap_aad(&entry.device_id, root_epoch);
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
            m_cost: 19 * 1024,
            t_cost: 2,
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
            root_epoch: 0,
            entries: vec![a, b],
            mac_b64: String::new(),
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

    #[test]
    fn collection_mac_detects_entry_splicing() {
        let root = fresh_root_key();
        let entry =
            wrap_root_key_for_epoch("dev-A", "pw", fast_params(), &root, 1).unwrap();
        let mut keyring = Keyring {
            schema_version: KEYRING_SCHEMA,
            root_epoch: 1,
            entries: vec![entry.clone()],
            mac_b64: String::new(),
        };
        let mac_key = crate::crypto::derive_keyring_mac_key(&root);
        keyring.sign(mac_key.as_ref()).unwrap();
        assert_eq!(
            keyring.verify_mac(mac_key.as_ref()),
            KeyringMacStatus::Valid
        );
        let mut spliced = entry;
        spliced.device_id = "dev-B".into();
        keyring.entries.push(spliced);
        assert_eq!(
            keyring.verify_mac(mac_key.as_ref()),
            KeyringMacStatus::Invalid
        );
    }
}
