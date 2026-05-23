//! Snapshot encoding (RFC-002 §12).
//!
//! A snapshot is a point-in-time replay of every live record at some
//! Lamport clock. Compaction (M5) trims the event log by collapsing
//! everything up to a snapshot's clock; a new device joining the repo
//! can bootstrap from the most recent snapshot and then replay only the
//! events that came after.
//!
//! Format (M1): pretty-printed JSON. Compression and a binary container
//! are M5/M10 concerns — the on-disk filename ends in `.bin` already so
//! we can swap encodings later without changing the layout.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::Error;

pub const SNAPSHOT_SCHEMA: u32 = 1;

/// One row in the snapshot: identity + ciphertext envelope. The
/// engine decrypts these the same way it decrypts an `Upsert` event's
/// payload (same AAD shape, same per-record subkey).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotRecord {
    pub record_id: String,
    pub kind: String,
    pub revision: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    /// Lamport clock of the last event that touched this record before
    /// the snapshot was taken. Lets late-arriving events be ordered
    /// against the snapshot without re-reading the whole event log.
    pub last_clock: u64,
}

impl SnapshotRecord {
    pub fn decode_nonce(&self) -> Result<Vec<u8>, Error> {
        B64.decode(self.nonce_b64.as_bytes())
            .map_err(|_| Error::Base64)
    }
    pub fn decode_ciphertext(&self) -> Result<Vec<u8>, Error> {
        B64.decode(self.ciphertext_b64.as_bytes())
            .map_err(|_| Error::Base64)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snapshot {
    pub schema_version: u32,
    pub snapshot_id: String,
    /// Lamport clock at which this snapshot was taken. New devices stamp
    /// this as their starting `last_seen_clock`.
    pub head_clock: u64,
    pub vault_id: String,
    pub created_at: i64,
    pub records: Vec<SnapshotRecord>,
}

impl Snapshot {
    pub fn new(snapshot_id: impl Into<String>, vault_id: impl Into<String>, head_clock: u64, created_at: i64) -> Self {
        Self {
            schema_version: SNAPSHOT_SCHEMA,
            snapshot_id: snapshot_id.into(),
            head_clock,
            vault_id: vault_id.into(),
            created_at,
            records: Vec::new(),
        }
    }

    pub fn push(
        &mut self,
        record_id: impl Into<String>,
        kind: impl Into<String>,
        revision: impl Into<String>,
        nonce: &[u8],
        ciphertext: &[u8],
        last_clock: u64,
    ) {
        self.records.push(SnapshotRecord {
            record_id: record_id.into(),
            kind: kind.into(),
            revision: revision.into(),
            nonce_b64: B64.encode(nonce),
            ciphertext_b64: B64.encode(ciphertext),
            last_clock,
        });
    }

    pub fn to_json(&self) -> Result<Vec<u8>, Error> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        let s: Snapshot = serde_json::from_slice(bytes)?;
        if s.schema_version > SNAPSHOT_SCHEMA {
            return Err(Error::SchemaTooNew {
                repo: s.schema_version,
                max: SNAPSHOT_SCHEMA,
            });
        }
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_roundtrip() {
        let s = Snapshot::new("snap-1", "vlt", 0, 100);
        let bytes = s.to_json().unwrap();
        let back = Snapshot::from_json(&bytes).unwrap();
        assert_eq!(back.snapshot_id, "snap-1");
        assert_eq!(back.head_clock, 0);
        assert!(back.records.is_empty());
    }

    #[test]
    fn snapshot_with_records_roundtrip_and_decodes_back_to_raw_bytes() {
        let mut s = Snapshot::new("snap-2", "vlt", 42, 100);
        s.push("rec-1", "host", "rev-1", &[0u8; 24], &[1, 2, 3], 40);
        s.push("rec-2", "snippet", "rev-9", &[7u8; 24], &[9, 9, 9], 41);

        let bytes = s.to_json().unwrap();
        let back = Snapshot::from_json(&bytes).unwrap();
        assert_eq!(back.records.len(), 2);
        assert_eq!(back.records[0].record_id, "rec-1");
        assert_eq!(back.records[0].decode_nonce().unwrap(), vec![0u8; 24]);
        assert_eq!(back.records[0].decode_ciphertext().unwrap(), vec![1, 2, 3]);
        assert_eq!(back.records[1].last_clock, 41);
    }

    #[test]
    fn rejects_future_schema() {
        let s = Snapshot {
            schema_version: 999,
            snapshot_id: "x".into(),
            head_clock: 0,
            vault_id: "v".into(),
            created_at: 0,
            records: Vec::new(),
        };
        let bytes = serde_json::to_vec(&s).unwrap();
        assert!(matches!(
            Snapshot::from_json(&bytes),
            Err(Error::SchemaTooNew { .. })
        ));
    }
}
