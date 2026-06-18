//! Adapter trait separating the sync engine from the concrete storage
//! it pulls dirty records from / pushes applied records into.
//!
//! Why a trait? The engine wants to be testable without dragging the
//! whole vault/store stack in. Production wires it to a
//! `VaultBackedStore` (zeroterm-app); the integration tests in this
//! crate use [`InMemoryStore`].
//!
//! All methods are synchronous because the operations underneath are
//! fast (in-process SQLite or `HashMap` access). Async would just add
//! ceremony for no win.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::Error;

/// A view of a single local record relevant to the sync engine.
#[derive(Debug, Clone)]
pub struct LocalRecord {
    pub id: String,
    pub kind: String,
    /// Decrypted payload. Empty when `deleted` is true (tombstone).
    pub plaintext: Vec<u8>,
    pub deleted: bool,
    pub local_rev: String,
    /// `server_rev` at the moment the dirty edit began — used by the
    /// conflict detector. `None` only when the record was created
    /// locally and has never been pushed.
    pub base_server_rev: Option<String>,
    /// True if the local replica has unsent changes for this record.
    /// Apply-remote uses this to choose between "land cleanly" and
    /// "record a conflict".
    pub dirty: bool,
}

/// What the engine reports back about each applied remote event.
#[derive(Debug, Clone, Default)]
pub struct ApplyTally {
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
}

impl ApplyTally {
    pub fn merge(&mut self, other: &ApplyTally) {
        self.upserts_applied += other.upserts_applied;
        self.deletes_applied += other.deletes_applied;
        self.conflicts_detected += other.conflicts_detected;
        self.already_seen += other.already_seen;
        self.skipped += other.skipped;
    }
}

/// Abstraction the engine calls into.
pub trait LocalRecordStore: Send + Sync {
    /// All records currently flagged dirty. Order doesn't matter — the
    /// engine sorts events by Lamport clock after generating them.
    fn list_dirty(&self) -> Result<Vec<LocalRecord>, Error>;

    /// Look up a record by id. Returns `Ok(None)` for "no such record"
    /// (i.e. the local replica has never seen it).
    fn find(&self, id: &str) -> Result<Option<LocalRecord>, Error>;

    /// Apply a remote upsert: overwrite the local row with the remote
    /// plaintext, mark it clean, stamp `server_rev`/`base_server_rev`.
    fn apply_upsert(
        &self,
        id: &str,
        kind: &str,
        plaintext: &[u8],
        server_rev: &str,
    ) -> Result<(), Error>;

    /// Apply a remote tombstone.
    fn apply_delete(&self, id: &str, server_rev: &str) -> Result<(), Error>;

    /// Clear the dirty flag and stamp the freshly-pushed `server_rev`
    /// onto the record. Used after a successful push.
    fn mark_clean(&self, id: &str, server_rev: &str) -> Result<(), Error>;

    /// Record a conflict that needs user resolution. The engine has
    /// already detected the divergence; this hook persists it.
    fn record_conflict(
        &self,
        record_id: &str,
        kind: &str,
        local_payload: &[u8],
        remote_payload: &[u8],
        local_rev: &str,
        remote_rev: &str,
    ) -> Result<(), Error>;

    /// All currently-live records. Used to build the initial snapshot
    /// at `create_repo` and (later, in M5) at compaction time.
    fn list_all_live(&self) -> Result<Vec<LocalRecord>, Error>;

    /// Sync-state key/value: persisted Lamport clock, applied-event set,
    /// last-known snapshot pointer, …
    fn get_sync_state(&self, key: &str) -> Result<Option<Vec<u8>>, Error>;
    fn put_sync_state(&self, key: &str, value: &[u8]) -> Result<(), Error>;

    /// Permanently remove tombstone records older than `max_age_days`.
    /// Called by the engine's compact step to bound the size of the
    /// local store; backends that don't support physical pruning can
    /// keep the default no-op implementation.
    fn prune_old_tombstones(&self, _max_age_days: u64) -> Result<usize, Error> {
        Ok(0)
    }
}

// --------------------------------------------------------------------
// In-memory implementation, intended for the engine's own tests.
// --------------------------------------------------------------------

#[derive(Default)]
struct InMemoryRecord {
    kind: String,
    plaintext: Vec<u8>,
    deleted: bool,
    local_rev: String,
    server_rev: Option<String>,
    base_server_rev: Option<String>,
    dirty: bool,
    /// Epoch-millis when this row was tombstoned. `None` while live.
    /// Used by [`InMemoryStore::prune_old_tombstones`] in tests.
    deleted_at_ms: Option<i64>,
}

#[derive(Default)]
pub struct InMemoryStore {
    inner: Mutex<InMemoryState>,
}

#[derive(Default)]
struct InMemoryState {
    records: HashMap<String, InMemoryRecord>,
    sync_state: HashMap<String, Vec<u8>>,
    conflicts: Vec<ConflictRow>,
}

#[derive(Debug, Clone)]
pub struct ConflictRow {
    pub record_id: String,
    pub kind: String,
    pub local_payload: Vec<u8>,
    pub remote_payload: Vec<u8>,
    pub local_rev: String,
    pub remote_rev: String,
}

impl InMemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mimic a local edit (so the next `list_dirty` returns it).
    pub fn put_local(&self, id: &str, kind: &str, plaintext: Vec<u8>) {
        let mut g = self.inner.lock().unwrap();
        let rev = uuid::Uuid::now_v7().to_string();
        let base = g.records.get(id).and_then(|r| r.server_rev.clone());
        g.records.insert(
            id.to_string(),
            InMemoryRecord {
                kind: kind.to_string(),
                plaintext,
                deleted: false,
                local_rev: rev,
                server_rev: base.clone(),
                base_server_rev: base,
                dirty: true,
                deleted_at_ms: None,
            },
        );
    }

    /// Mimic a local delete.
    pub fn delete_local(&self, id: &str) {
        let mut g = self.inner.lock().unwrap();
        let Some(rec) = g.records.get_mut(id) else {
            return;
        };
        rec.deleted = true;
        rec.plaintext.clear();
        rec.local_rev = uuid::Uuid::now_v7().to_string();
        rec.base_server_rev = rec.server_rev.clone();
        rec.dirty = true;
        rec.deleted_at_ms = Some(now_ms());
    }

    /// Stamp a tombstone's recorded deletion time directly. Test-only:
    /// the engine's compact step exercises tombstone pruning by age, so
    /// suites need a way to fake an "old" tombstone without sleeping.
    pub fn set_tombstone_age_ms(&self, id: &str, deleted_at_ms: i64) {
        let mut g = self.inner.lock().unwrap();
        if let Some(rec) = g.records.get_mut(id) {
            rec.deleted = true;
            rec.deleted_at_ms = Some(deleted_at_ms);
        }
    }

    pub fn snapshot_live(&self) -> Vec<(String, Vec<u8>)> {
        let g = self.inner.lock().unwrap();
        g.records
            .iter()
            .filter(|(_, r)| !r.deleted)
            .map(|(id, r)| (id.clone(), r.plaintext.clone()))
            .collect()
    }

    pub fn conflicts(&self) -> Vec<ConflictRow> {
        self.inner.lock().unwrap().conflicts.clone()
    }
}

impl LocalRecordStore for InMemoryStore {
    fn list_dirty(&self) -> Result<Vec<LocalRecord>, Error> {
        let g = self.inner.lock().unwrap();
        Ok(g.records
            .iter()
            .filter(|(_, r)| r.dirty)
            .map(|(id, r)| LocalRecord {
                id: id.clone(),
                kind: r.kind.clone(),
                plaintext: r.plaintext.clone(),
                deleted: r.deleted,
                local_rev: r.local_rev.clone(),
                base_server_rev: r.base_server_rev.clone(),
                dirty: true,
            })
            .collect())
    }

    fn find(&self, id: &str) -> Result<Option<LocalRecord>, Error> {
        let g = self.inner.lock().unwrap();
        Ok(g.records.get(id).map(|r| LocalRecord {
            id: id.to_string(),
            kind: r.kind.clone(),
            plaintext: r.plaintext.clone(),
            deleted: r.deleted,
            local_rev: r.local_rev.clone(),
            base_server_rev: r.base_server_rev.clone(),
            dirty: r.dirty,
        }))
    }

    fn apply_upsert(
        &self,
        id: &str,
        kind: &str,
        plaintext: &[u8],
        server_rev: &str,
    ) -> Result<(), Error> {
        let mut g = self.inner.lock().unwrap();
        g.records.insert(
            id.to_string(),
            InMemoryRecord {
                kind: kind.to_string(),
                plaintext: plaintext.to_vec(),
                deleted: false,
                local_rev: server_rev.to_string(),
                server_rev: Some(server_rev.to_string()),
                base_server_rev: Some(server_rev.to_string()),
                dirty: false,
                deleted_at_ms: None,
            },
        );
        Ok(())
    }

    fn apply_delete(&self, id: &str, server_rev: &str) -> Result<(), Error> {
        let mut g = self.inner.lock().unwrap();
        let entry = g
            .records
            .entry(id.to_string())
            .or_insert_with(|| InMemoryRecord {
                kind: "tombstone".to_string(),
                ..Default::default()
            });
        entry.deleted = true;
        entry.plaintext.clear();
        entry.local_rev = server_rev.to_string();
        entry.server_rev = Some(server_rev.to_string());
        entry.base_server_rev = Some(server_rev.to_string());
        entry.dirty = false;
        entry.deleted_at_ms = Some(now_ms());
        Ok(())
    }

    fn mark_clean(&self, id: &str, server_rev: &str) -> Result<(), Error> {
        let mut g = self.inner.lock().unwrap();
        let Some(rec) = g.records.get_mut(id) else {
            return Ok(());
        };
        rec.dirty = false;
        rec.server_rev = Some(server_rev.to_string());
        rec.base_server_rev = Some(server_rev.to_string());
        Ok(())
    }

    fn record_conflict(
        &self,
        record_id: &str,
        kind: &str,
        local_payload: &[u8],
        remote_payload: &[u8],
        local_rev: &str,
        remote_rev: &str,
    ) -> Result<(), Error> {
        let mut g = self.inner.lock().unwrap();
        g.conflicts.push(ConflictRow {
            record_id: record_id.to_string(),
            kind: kind.to_string(),
            local_payload: local_payload.to_vec(),
            remote_payload: remote_payload.to_vec(),
            local_rev: local_rev.to_string(),
            remote_rev: remote_rev.to_string(),
        });
        Ok(())
    }

    fn list_all_live(&self) -> Result<Vec<LocalRecord>, Error> {
        let g = self.inner.lock().unwrap();
        Ok(g.records
            .iter()
            .filter(|(_, r)| !r.deleted)
            .map(|(id, r)| LocalRecord {
                id: id.clone(),
                kind: r.kind.clone(),
                plaintext: r.plaintext.clone(),
                deleted: false,
                local_rev: r.local_rev.clone(),
                base_server_rev: r.base_server_rev.clone(),
                dirty: r.dirty,
            })
            .collect())
    }

    fn get_sync_state(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        Ok(self.inner.lock().unwrap().sync_state.get(key).cloned())
    }

    fn put_sync_state(&self, key: &str, value: &[u8]) -> Result<(), Error> {
        self.inner
            .lock()
            .unwrap()
            .sync_state
            .insert(key.to_string(), value.to_vec());
        Ok(())
    }

    fn prune_old_tombstones(&self, max_age_days: u64) -> Result<usize, Error> {
        let cutoff = now_ms().saturating_sub((max_age_days as i64) * 86_400_000);
        let mut g = self.inner.lock().unwrap();
        let before = g.records.len();
        g.records.retain(|_, r| {
            !(r.deleted && !r.dirty && r.deleted_at_ms.map(|t| t < cutoff).unwrap_or(false))
        });
        Ok(before - g.records.len())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_local_then_list_dirty() {
        let s = InMemoryStore::new();
        s.put_local("r1", "host", b"hello".to_vec());
        let dirty = s.list_dirty().unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].id, "r1");
        assert!(dirty[0].base_server_rev.is_none());
    }

    #[test]
    fn apply_then_local_edit_carries_base_server_rev() {
        let s = InMemoryStore::new();
        s.apply_upsert("r1", "host", b"a", "srv-1").unwrap();
        s.put_local("r1", "host", b"b".to_vec());
        let dirty = s.list_dirty().unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].base_server_rev.as_deref(), Some("srv-1"));
    }

    #[test]
    fn mark_clean_clears_dirty_flag() {
        let s = InMemoryStore::new();
        s.put_local("r1", "host", b"a".to_vec());
        s.mark_clean("r1", "srv-1").unwrap();
        assert!(s.list_dirty().unwrap().is_empty());
        let r = s.find("r1").unwrap().unwrap();
        assert_eq!(r.base_server_rev.as_deref(), Some("srv-1"));
    }

    #[test]
    fn record_conflict_is_persisted() {
        let s = InMemoryStore::new();
        s.record_conflict("r1", "host", b"L", b"R", "lrev", "rrev")
            .unwrap();
        let c = s.conflicts();
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].record_id, "r1");
    }
}
