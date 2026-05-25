//! Remote event encoding (RFC-002 §11).
//!
//! Events are the append-only log under `events/YYYY-MM/`. Each event
//! describes a single record-level change (upsert / delete). The payload
//! is the sync-layer-encrypted ciphertext + nonce; the envelope around
//! it carries the routing metadata (record id, kind, lamport clock,
//! device id, revision pointers).
//!
//! Wire formats:
//!   - **`.json`** — original RFC-002 format. Pretty-printed JSON, easy
//!     to inspect. Used through M9.
//!   - **`.ztlog`** — compact binary frame introduced in M10. ~2× smaller
//!     than the JSON equivalent for typical upserts; saves more on
//!     deletes where the payload is empty. New writes go out as
//!     `.ztlog`; readers accept both extensions so old repos stay
//!     readable without a migration step.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::error::Error;

/// Bumped if the event JSON shape ever changes. Older binaries reject
/// events with a newer schema rather than misinterpreting fields.
pub const EVENT_SCHEMA: u32 = 1;

/// Magic + version prefix for `.ztlog` frames. Magic is checked first
/// so a stray `.ztlog`-named JSON file fails loudly instead of being
/// misinterpreted as a tiny binary frame.
const ZTLOG_MAGIC: &[u8; 4] = b"ZTLG";
/// Highest .ztlog frame version this binary understands.
pub const ZTLOG_SCHEMA: u8 = 1;

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

    /// Serialise to the binary `.ztlog` frame format (M10).
    ///
    /// Layout (little-endian throughout):
    ///   - 4B magic `b"ZTLG"`
    ///   - 1B frame schema (`ZTLOG_SCHEMA`)
    ///   - 1B op (`0x01` upsert, `0x02` delete)
    ///   - 8B lamport_clock
    ///   - 8B created_at
    ///   - 6× (u16 len + utf-8 bytes): event_id, device_id, vault_id,
    ///     record_id, kind, revision
    ///   - 1B parent flag (0 / 1) + u16-len-prefixed parent_revision
    ///     when present
    ///   - 1B nonce len (0–255) + raw nonce bytes
    ///   - 4B ciphertext len + raw ciphertext bytes
    pub fn to_bytes(&self) -> Result<Vec<u8>, Error> {
        let nonce = self.decode_nonce()?;
        let ct = self.decode_ciphertext()?;

        if self.schema_version != EVENT_SCHEMA {
            // The .ztlog frame pins to EVENT_SCHEMA; events crossing
            // schema boundaries must round-trip through JSON.
            return Err(Error::SchemaTooNew {
                repo: self.schema_version,
                max: EVENT_SCHEMA,
            });
        }
        if nonce.len() > u8::MAX as usize {
            return Err(Error::Corrupt);
        }

        let mut out = Vec::with_capacity(64 + nonce.len() + ct.len());
        out.extend_from_slice(ZTLOG_MAGIC);
        out.push(ZTLOG_SCHEMA);
        out.push(match self.op {
            Op::Upsert => 0x01,
            Op::Delete => 0x02,
        });
        out.extend_from_slice(&self.lamport_clock.to_le_bytes());
        out.extend_from_slice(&self.created_at.to_le_bytes());

        write_str(&mut out, &self.event_id)?;
        write_str(&mut out, &self.device_id)?;
        write_str(&mut out, &self.vault_id)?;
        write_str(&mut out, &self.record_id)?;
        write_str(&mut out, &self.kind)?;
        write_str(&mut out, &self.revision)?;

        match self.parent_revision.as_deref() {
            None => out.push(0u8),
            Some(s) => {
                out.push(1u8);
                write_str(&mut out, s)?;
            }
        }

        out.push(nonce.len() as u8);
        out.extend_from_slice(&nonce);

        let ct_len: u32 = ct
            .len()
            .try_into()
            .map_err(|_| Error::Corrupt)?;
        out.extend_from_slice(&ct_len.to_le_bytes());
        out.extend_from_slice(&ct);

        Ok(out)
    }

    /// Inverse of [`to_bytes`]. Rejects unknown magic, future schema
    /// versions, and frames whose declared lengths overrun the buffer.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, Error> {
        let mut r = FrameReader::new(bytes);

        let magic = r.take(4)?;
        if magic != ZTLOG_MAGIC {
            return Err(Error::Corrupt);
        }

        let schema = r.take_u8()?;
        if schema > ZTLOG_SCHEMA {
            return Err(Error::SchemaTooNew {
                repo: schema as u32,
                max: ZTLOG_SCHEMA as u32,
            });
        }

        let op_byte = r.take_u8()?;
        let op = match op_byte {
            0x01 => Op::Upsert,
            0x02 => Op::Delete,
            _ => return Err(Error::Corrupt),
        };

        let lamport_clock = u64::from_le_bytes(r.take_array::<8>()?);
        let created_at = i64::from_le_bytes(r.take_array::<8>()?);

        let event_id = r.take_str()?;
        let device_id = r.take_str()?;
        let vault_id = r.take_str()?;
        let record_id = r.take_str()?;
        let kind = r.take_str()?;
        let revision = r.take_str()?;

        let parent_flag = r.take_u8()?;
        let parent_revision = match parent_flag {
            0 => None,
            1 => Some(r.take_str()?),
            _ => return Err(Error::Corrupt),
        };

        let nonce_len = r.take_u8()? as usize;
        let nonce = r.take(nonce_len)?.to_vec();

        let ct_len = u32::from_le_bytes(r.take_array::<4>()?) as usize;
        let ct = r.take(ct_len)?.to_vec();

        if !r.is_empty() {
            // Trailing bytes after a well-formed frame indicate either
            // a corrupted file or two frames concatenated — the writer
            // never does this, so refuse rather than guess.
            return Err(Error::Corrupt);
        }

        Ok(RemoteEvent {
            schema_version: EVENT_SCHEMA,
            event_id,
            device_id,
            lamport_clock,
            created_at,
            vault_id,
            record_id,
            kind,
            op,
            revision,
            parent_revision,
            nonce_b64: B64.encode(&nonce),
            ciphertext_b64: B64.encode(&ct),
        })
    }

    /// True if `bytes` start with the `.ztlog` magic. Cheap, no parse.
    pub fn looks_like_ztlog(bytes: &[u8]) -> bool {
        bytes.len() >= ZTLOG_MAGIC.len() && &bytes[..ZTLOG_MAGIC.len()] == ZTLOG_MAGIC
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) -> Result<(), Error> {
    let len: u16 = s.len().try_into().map_err(|_| Error::Corrupt)?;
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(s.as_bytes());
    Ok(())
}

/// Cursor over a `.ztlog` frame body. All readers funnel through here so
/// every overrun maps to [`Error::Corrupt`] consistently.
struct FrameReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> FrameReader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        let end = self.pos.checked_add(n).ok_or(Error::Corrupt)?;
        if end > self.buf.len() {
            return Err(Error::Corrupt);
        }
        let out = &self.buf[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn take_u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    fn take_array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        let slice = self.take(N)?;
        let mut arr = [0u8; N];
        arr.copy_from_slice(slice);
        Ok(arr)
    }

    fn take_str(&mut self) -> Result<String, Error> {
        let len = u16::from_le_bytes(self.take_array::<2>()?) as usize;
        let bytes = self.take(len)?;
        String::from_utf8(bytes.to_vec()).map_err(|_| Error::Corrupt)
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

    #[test]
    fn ztlog_upsert_roundtrip_preserves_every_field() {
        let ev = sample_upsert();
        let bytes = ev.to_bytes().unwrap();
        assert!(RemoteEvent::looks_like_ztlog(&bytes));
        let back = RemoteEvent::from_bytes(&bytes).unwrap();
        assert_eq!(back.op, Op::Upsert);
        assert_eq!(back.event_id, ev.event_id);
        assert_eq!(back.device_id, ev.device_id);
        assert_eq!(back.lamport_clock, ev.lamport_clock);
        assert_eq!(back.created_at, ev.created_at);
        assert_eq!(back.vault_id, ev.vault_id);
        assert_eq!(back.record_id, ev.record_id);
        assert_eq!(back.kind, ev.kind);
        assert_eq!(back.revision, ev.revision);
        assert_eq!(back.parent_revision, ev.parent_revision);
        assert_eq!(back.decode_nonce().unwrap(), ev.decode_nonce().unwrap());
        assert_eq!(
            back.decode_ciphertext().unwrap(),
            ev.decode_ciphertext().unwrap()
        );
    }

    #[test]
    fn ztlog_delete_roundtrip_preserves_parent_revision() {
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
        let bytes = ev.to_bytes().unwrap();
        let back = RemoteEvent::from_bytes(&bytes).unwrap();
        assert_eq!(back.op, Op::Delete);
        assert_eq!(back.parent_revision.as_deref(), Some("rev-1"));
        assert!(back.decode_nonce().unwrap().is_empty());
        assert!(back.decode_ciphertext().unwrap().is_empty());
    }

    #[test]
    fn ztlog_rejects_wrong_magic() {
        let mut bytes = sample_upsert().to_bytes().unwrap();
        bytes[0] = b'X';
        assert!(matches!(
            RemoteEvent::from_bytes(&bytes),
            Err(Error::Corrupt)
        ));
    }

    #[test]
    fn ztlog_rejects_future_schema() {
        let mut bytes = sample_upsert().to_bytes().unwrap();
        bytes[4] = 0xFF; // bump frame version
        assert!(matches!(
            RemoteEvent::from_bytes(&bytes),
            Err(Error::SchemaTooNew { .. })
        ));
    }

    #[test]
    fn ztlog_rejects_truncated_frame() {
        let bytes = sample_upsert().to_bytes().unwrap();
        // Lop off the last 5 bytes — somewhere inside the ciphertext.
        let truncated = &bytes[..bytes.len() - 5];
        assert!(matches!(
            RemoteEvent::from_bytes(truncated),
            Err(Error::Corrupt)
        ));
    }

    #[test]
    fn ztlog_rejects_trailing_garbage() {
        let mut bytes = sample_upsert().to_bytes().unwrap();
        bytes.extend_from_slice(b"junk");
        assert!(matches!(
            RemoteEvent::from_bytes(&bytes),
            Err(Error::Corrupt)
        ));
    }

    #[test]
    fn ztlog_is_smaller_than_pretty_json() {
        // Headline win is on a typical upsert with realistic ULID-sized
        // ids and a small ciphertext. JSON pretty-printing adds field
        // names + indentation; the binary frame skips both.
        let mut ev = sample_upsert();
        ev.event_id = "01HXYZABCD0123456789EFGHJK".to_string();
        ev.device_id = "device-host-abc".to_string();
        ev.vault_id = "01HW3F0V0Q5G9A8X2P4M2YQS44".to_string();
        ev.record_id = "01HW3F0V0Q5G9A8X2P4M2YQRZ7".to_string();
        ev.revision = "01HW3F0V0Q5G9A8X2P4M2YQS00".to_string();
        let big_ct: Vec<u8> = (0..200).map(|i| (i % 251) as u8).collect();
        ev.ciphertext_b64 = B64.encode(&big_ct);
        ev.nonce_b64 = B64.encode(vec![0xAB; 24]);

        let json = ev.to_json().unwrap();
        let bin = ev.to_bytes().unwrap();
        // Headline win: dropping pretty-printed whitespace + field
        // names + base64 expansion lands us around 55–60% of the JSON
        // size for a typical upsert. Anything above 70% would mean the
        // encoder regressed somewhere obvious.
        assert!(
            bin.len() * 100 <= json.len() * 70,
            "expected .ztlog to be at most 70% of pretty-JSON size: \
             json={}, ztlog={}",
            json.len(),
            bin.len()
        );
    }

    #[test]
    fn looks_like_ztlog_distinguishes_formats() {
        let json = sample_upsert().to_json().unwrap();
        let bin = sample_upsert().to_bytes().unwrap();
        assert!(!RemoteEvent::looks_like_ztlog(&json));
        assert!(RemoteEvent::looks_like_ztlog(&bin));
    }
}
