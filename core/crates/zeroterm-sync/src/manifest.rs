//! Repo-level manifest (RFC-002 §10.1).
//!
//! `manifest.json` is the single mutable pointer in the repo. Everything
//! else (snapshots, events, keyring entries) is append-mostly. The
//! manifest is what every device reads first to discover the head clock
//! and the latest snapshot.

use serde::{Deserialize, Serialize};

use crate::error::Error;

pub const MANIFEST_SCHEMA: u32 = 1;

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
    pub updated_at: i64,
    pub updated_by_device: String,
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
            updated_at: now,
            updated_by_device: updated_by_device.into(),
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
