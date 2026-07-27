//! Repo-level manifest (RFC-002 §10.1).
//!
//! `manifest.json` is the single mutable pointer in the repo. Everything
//! else (snapshots, events, keyring entries) is append-mostly. The
//! manifest is what every device reads first to discover the head clock
//! and the latest snapshot.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::Error;

pub const MANIFEST_SCHEMA: u32 = 2;

/// Result of authenticating a manifest against the root-key MAC (SYNC-8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestMacStatus {
    /// A MAC is present and matches — the manifest is authentic.
    Valid,
    /// No MAC field (a legacy manifest written before SYNC-8). Accepted
    /// only when the caller's persistent downgrade policy permits it; the
    /// next writer stamps a MAC.
    Absent,
    /// A MAC is present but does not match — the manifest was tampered
    /// with by a party without the root key. Must be rejected.
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema_version: u32,
    pub repo_id: String,
    pub vault_id: String,
    /// Lamport clock advertised as "fully covered by the latest
    /// snapshot or events upload by this manifest writer".
    pub head_clock: u64,
    /// Repo-relative path to the most recent snapshot, if one has been
    /// written. Absent on freshly-created repos.
    pub latest_snapshot: Option<String>,
    /// Bumped whenever `keyring.json` is rewritten (enroll/revoke/rotate).
    /// Lets devices notice they need to re-fetch the keyring without
    /// always reading it.
    pub keyring_version: u32,
    /// Root-key generation. Epoch 0 is the legacy format. A rotation
    /// increments this and re-encrypts the complete snapshot.
    #[serde(default)]
    pub root_epoch: u64,
    /// Immutable keyring object selected by this manifest. Legacy
    /// manifests omit it and use `keyring.json`.
    #[serde(default = "default_keyring_path")]
    pub keyring_path: String,
    pub updated_at: i64,
    pub updated_by_device: String,

    /// Monotonic counter bumped on every manifest write (SYNC-8). A
    /// device remembers the highest value it has seen; a manifest that
    /// arrives with a *lower* value is a rollback (a malicious backend
    /// replaying an older, still-authentic manifest to hide records) and
    /// is rejected even though its MAC verifies. `#[serde(default)]` so
    /// legacy manifests (no field) parse as 0.
    #[serde(default)]
    pub meta_version: u64,

    /// Base64 HMAC-SHA256 over the manifest (with this field blank),
    /// keyed by a subkey of the sync root key (SYNC-8). Empty on legacy
    /// manifests. `#[serde(default)]` so old readers ignore it and old
    /// files still parse.
    #[serde(default)]
    pub mac_b64: String,
}

impl Manifest {
    pub fn new(
        repo_id: impl Into<String>,
        vault_id: impl Into<String>,
        updated_by_device: impl Into<String>,
        now: i64,
    ) -> Self {
        Self {
            schema_version: MANIFEST_SCHEMA,
            repo_id: repo_id.into(),
            vault_id: vault_id.into(),
            head_clock: 0,
            latest_snapshot: None,
            keyring_version: 1,
            root_epoch: 0,
            keyring_path: default_keyring_path(),
            updated_at: now,
            updated_by_device: updated_by_device.into(),
            meta_version: 0,
            mac_b64: String::new(),
        }
    }

    pub fn to_json(&self) -> Result<Vec<u8>, Error> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        let m: Manifest = serde_json::from_slice(bytes)?;
        if m.schema_version > MANIFEST_SCHEMA {
            return Err(Error::SchemaTooNew {
                repo: m.schema_version,
                max: MANIFEST_SCHEMA,
            });
        }
        Ok(m)
    }

    /// Canonical bytes the MAC is computed over: the manifest serialized
    /// with `mac_b64` blanked. Deterministic because serde emits fields
    /// in declaration order.
    fn mac_input(&self) -> Result<Vec<u8>, Error> {
        let mut bare = self.clone();
        bare.mac_b64 = String::new();
        bare.to_json()
    }

    /// Stamp `mac_b64` with an HMAC over this manifest, keyed by
    /// `mac_key`. Call after every mutation, right before writing.
    pub fn sign(&mut self, mac_key: &[u8]) -> Result<(), Error> {
        self.mac_b64 = String::new();
        let input = self.mac_input()?;
        let tag = zeroterm_crypto::hmac_sha256(mac_key, &input);
        self.mac_b64 = B64.encode(tag);
        Ok(())
    }

    /// Authenticate this manifest against `mac_key` in constant time.
    pub fn verify_mac(&self, mac_key: &[u8]) -> ManifestMacStatus {
        if self.mac_b64.is_empty() {
            return ManifestMacStatus::Absent;
        }
        let Ok(input) = self.mac_input() else {
            return ManifestMacStatus::Invalid;
        };
        let expected = zeroterm_crypto::hmac_sha256(mac_key, &input);
        let Ok(got) = B64.decode(self.mac_b64.as_bytes()) else {
            return ManifestMacStatus::Invalid;
        };
        if zeroterm_crypto::constant_time_eq(&got, &expected) {
            ManifestMacStatus::Valid
        } else {
            ManifestMacStatus::Invalid
        }
    }
}

fn default_keyring_path() -> String {
    "keyring.json".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_manifest_has_no_snapshot() {
        let m = Manifest::new("repo-1", "vlt-1", "dev-A", 100);
        assert_eq!(m.head_clock, 0);
        assert!(m.latest_snapshot.is_none());
        assert_eq!(m.keyring_version, 1);
    }

    #[test]
    fn manifest_json_roundtrip() {
        let mut m = Manifest::new("repo-1", "vlt-1", "dev-A", 100);
        m.head_clock = 42;
        m.latest_snapshot = Some("snapshots/snapshot-42-x.bin".into());
        m.keyring_version = 3;

        let bytes = m.to_json().unwrap();
        let back = Manifest::from_json(&bytes).unwrap();
        assert_eq!(back.head_clock, 42);
        assert_eq!(
            back.latest_snapshot.as_deref(),
            Some("snapshots/snapshot-42-x.bin")
        );
        assert_eq!(back.keyring_version, 3);
        assert_eq!(back.updated_by_device, "dev-A");
    }

    #[test]
    fn mac_signs_verifies_and_detects_tampering() {
        let key = [7u8; 32];
        let other_key = [9u8; 32];
        let mut m = Manifest::new("repo-1", "vlt-1", "dev-A", 100);
        m.head_clock = 42;
        m.latest_snapshot = Some("snapshots/snapshot-42-x.bin".into());

        // Unsigned → Absent.
        assert_eq!(m.verify_mac(&key), ManifestMacStatus::Absent);

        m.sign(&key).unwrap();
        // Signed → Valid under the same key, Invalid under a different key.
        assert_eq!(m.verify_mac(&key), ManifestMacStatus::Valid);
        assert_eq!(m.verify_mac(&other_key), ManifestMacStatus::Invalid);

        // Survives a JSON round-trip.
        let back = Manifest::from_json(&m.to_json().unwrap()).unwrap();
        assert_eq!(back.verify_mac(&key), ManifestMacStatus::Valid);

        // Tampering with a MAC'd field (e.g. redirecting the snapshot
        // pointer) invalidates the MAC.
        let mut tampered = back.clone();
        tampered.latest_snapshot = Some("snapshots/snapshot-01-evil.bin".into());
        assert_eq!(tampered.verify_mac(&key), ManifestMacStatus::Invalid);
    }

    #[test]
    fn rejects_future_schema() {
        let raw = br#"{
            "schema_version": 999,
            "repo_id": "r",
            "vault_id": "v",
            "head_clock": 0,
            "latest_snapshot": null,
            "keyring_version": 1,
            "updated_at": 0,
            "updated_by_device": "d"
        }"#;
        assert!(matches!(
            Manifest::from_json(raw),
            Err(Error::SchemaTooNew { .. })
        ));
    }
}
