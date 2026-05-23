//! Remote event encoding (RFC-002 §11).
//!
//! Events are the append-only log under `events/YYYY-MM/`. Each event
//! describes a single record-level change (upsert / delete). The payload
//! is the sync-layer-encrypted ciphertext + nonce; the envelope around
//! it carries the routing metadata (record id, kind, lamport clock,
//! device id, revision pointers).
//!
//! Format: pretty JSON, one event per file. Binary `.ztlog` is a future
//! optimisation (M10) — for M1 readability wins.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Bumped if the event JSON shape ever changes. Older binaries reject
/// events with a newer schema rather than misinterpreting fields.
pub const EVENT_SCHEMA: u32 = 1;

/// What this event does to the record. Tombstones go through `Delete`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEvent {
    pub schema_version: u32,
    pub event_id: String,
    pub device_id: String,
    pub lamport_clock: u64,
    pub created_at: i64,

    pub vault_id: String,
    pub record_id: String,
    pub kind: String,
    pub op: Op,

    /// Revision id this event introduces. For `Upsert` it's the new
    /// `local_rev`; for `Delete` it's a fresh ULID that downstream
    /// devices use to stamp `server_rev`.
    pub revision: String,
    /// Predecessor revision the author saw before writing — `None` for
    /// brand-new records. Used by the conflict detector to spot
    /// concurrent edits.
    pub parent_revision: Option<String>,

    /// The encrypted record payload. Empty for `Delete`.
    pub nonce_b64: String,
    pub ciphertext_b64: String,
}

impl RemoteEvent {
    pub fn to_json(&self) -> Result<Vec<u8>, Error> {
        Ok(serde_json::to_vec_pretty(self)?)
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        let ev: RemoteEvent = serde_json::from_slice(bytes)?;
        if ev.schema_version > EVENT_SCHEMA {
            return Err(Error::SchemaTooNew {
                repo: ev.schema_version,
                max: EVENT_SCHEMA,
            });
        }
        Ok(ev)
    }

    pub fn decode_nonce(&self) -> Result<Vec<u8>, Error> {
        B64.decode(self.nonce_b64.as_bytes())
            .map_err(|_| Error::Base64)
    }

    pub fn decode_ciphertext(&self) -> Result<Vec<u8>, Error> {
        B64.decode(self.ciphertext_b64.as_bytes())
            .map_err(|_| Error::Base64)
    }
}

/// Helper to assemble an upsert event from its raw parts (the engine
/// passes in everything that's already been computed elsewhere).
#[allow(clippy::too_many_arguments)]
pub fn new_upsert(
    event_id: impl Into<String>,
    device_id: impl Into<String>,
    lamport_clock: u64,
    created_at: i64,
    vault_id: impl Into<String>,
    record_id: impl Into<String>,
    kind: impl Into<String>,
    revision: impl Into<String>,
    parent_revision: Option<String>,
    nonce: &[u8],
    ciphertext: &[u8],
) -> RemoteEvent {
    RemoteEvent {
        schema_version: EVENT_SCHEMA,
        event_id: event_id.into(),
        device_id: device_id.into(),
        lamport_clock,
        created_at,
        vault_id: vault_id.into(),
        record_id: record_id.into(),
        kind: kind.into(),
        op: Op::Upsert,
        revision: revision.into(),
        parent_revision,
        nonce_b64: B64.encode(nonce),
        ciphertext_b64: B64.encode(ciphertext),
    }
}

/// Tombstone variant. No payload; just identity and lineage.
#[allow(clippy::too_many_arguments)]
pub fn new_delete(
    event_id: impl Into<String>,
    device_id: impl Into<String>,
    lamport_clock: u64,
    created_at: i64,
    vault_id: impl Into<String>,
    record_id: impl Into<String>,
    kind: impl Into<String>,
    revision: impl Into<String>,
    parent_revision: Option<String>,
) -> RemoteEvent {
    RemoteEvent {
        schema_version: EVENT_SCHEMA,
        event_id: event_id.into(),
        device_id: device_id.into(),
        lamport_clock,
        created_at,
        vault_id: vault_id.into(),
        record_id: record_id.into(),
        kind: kind.into(),
        op: Op::Delete,
        revision: revision.into(),
        parent_revision,
        nonce_b64: String::new(),
        ciphertext_b64: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_upsert() -> RemoteEvent {
        new_upsert(
            "evt-1",
            "dev-A",
            42,
            1_700_000_000_000,
            "vlt",
            "rec-1",
            "host",
            "rev-1",
            None,
            &[0u8; 24],
            &[9u8, 8, 7, 6],
        )
    }

    #[test]
    fn upsert_json_roundtrip() {
        let ev = sample_upsert();
        let bytes = ev.to_json().unwrap();
        let back = RemoteEvent::from_json(&bytes).unwrap();
        assert_eq!(back.op, Op::Upsert);
        assert_eq!(back.lamport_clock, 42);
        assert_eq!(back.decode_nonce().unwrap(), vec![0u8; 24]);
        assert_eq!(back.decode_ciphertext().unwrap(), vec![9, 8, 7, 6]);
    }

    #[test]
    fn delete_json_roundtrip() {
        let ev = new_delete(
            "evt-2",
            "dev-A",
            43,
            1_700_000_000_001,
            "vlt",
            "rec-1",
            "host",
            "rev-2",
            Some("rev-1".to_string()),
        );
        let bytes = ev.to_json().unwrap();
        let back = RemoteEvent::from_json(&bytes).unwrap();
        assert_eq!(back.op, Op::Delete);
        assert_eq!(back.parent_revision.as_deref(), Some("rev-1"));
        assert!(back.decode_nonce().unwrap().is_empty());
        assert!(back.decode_ciphertext().unwrap().is_empty());
    }

    #[test]
    fn rejects_future_schema() {
        let mut ev = sample_upsert();
        ev.schema_version = 999;
        let bytes = serde_json::to_vec(&ev).unwrap();
        assert!(matches!(
            RemoteEvent::from_json(&bytes),
            Err(Error::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn base64_decode_returns_error_on_garbage() {
        let mut ev = sample_upsert();
        ev.nonce_b64 = "!!!not base64!!!".to_string();
        let bytes = ev.to_json().unwrap();
        let back = RemoteEvent::from_json(&bytes).unwrap();
        assert!(matches!(back.decode_nonce(), Err(Error::Base64)));
    }
}
