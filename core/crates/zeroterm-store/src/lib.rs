//! Local storage layer for ZeroTerm.
//!
//! `Store` is intentionally crypto-blind: it stores opaque ciphertext blobs
//! and per-record metadata. The encryption layer (`zeroterm-vault`) and the
//! sync layer (`zeroterm-sync`) both go through this same API, which is why
//! it lives in its own crate.
//!
//! Schema is versioned via SQLite's `PRAGMA user_version`. New schema
//! revisions are added as additional `if version < N` blocks in
//! [`run_migrations`].

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("record not found: {0}")]
    NotFound(String),

    #[error("schema is newer than this binary expects (db={db}, max supported={supported})")]
    SchemaTooNew { db: u32, supported: u32 },
}

/// Opaque encrypted record as written by the vault.
///
/// `local_rev` / `server_rev` / `base_server_rev` / `dirty` / `conflict_state`
/// were added in schema v2 for record-level sync (RFC-002 §6). They are
/// `Option` because legacy rows migrated from v1 leave them NULL until the
/// vault next touches the record.
#[derive(Debug, Clone)]
pub struct Record {
    pub id: String,
    pub kind: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub version: i64,
    pub updated_at: i64,
    pub deleted: bool,

    /// Local revision id (ULID) — assigned by the vault on every write.
    /// `None` only for rows that predate sync v2.
    pub local_rev: Option<String>,
    /// Revision id last confirmed pushed to the sync repo.
    pub server_rev: Option<String>,
    /// `server_rev` at the time the local edit started — used to detect
    /// concurrent remote edits (Three-way: base/local/remote).
    pub base_server_rev: Option<String>,
    /// True when there are local changes not yet pushed.
    pub dirty: bool,
    /// Free-form marker the sync engine writes when a record is in a
    /// conflict state (e.g. "remote_newer", "needs_user_resolution").
    pub conflict_state: Option<String>,
}

/// Key/value blob storage for vault metadata (KDF salt, params, verifier).
#[derive(Debug, Clone)]
pub struct MetaEntry {
    pub key: String,
    pub value: Vec<u8>,
}

/// A persisted conflict record awaiting user resolution. See RFC-002 §14.
#[derive(Debug, Clone)]
pub struct ConflictRow {
    pub id: String,
    pub record_id: String,
    pub kind: String,
    pub local_payload: Vec<u8>,
    pub remote_payload: Vec<u8>,
    pub local_rev: String,
    pub remote_rev: String,
    pub detected_at: i64,
    pub resolved_at: Option<i64>,
}

/// SQLite schema we know how to produce. Bumping this requires adding a
/// migration step in [`run_migrations`].
pub const SCHEMA_VERSION: u32 = 2;

const MIGRATION_V1: &str = r#"
CREATE TABLE IF NOT EXISTS vault_meta (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS records (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce      BLOB NOT NULL,
    version    INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_records_kind     ON records (kind, deleted);
CREATE INDEX IF NOT EXISTS idx_records_version  ON records (version);
"#;

const MIGRATION_V2: &str = r#"
ALTER TABLE records ADD COLUMN local_rev       TEXT;
ALTER TABLE records ADD COLUMN server_rev      TEXT;
ALTER TABLE records ADD COLUMN base_server_rev TEXT;
ALTER TABLE records ADD COLUMN dirty           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE records ADD COLUMN conflict_state  TEXT;

CREATE INDEX IF NOT EXISTS idx_records_dirty ON records (dirty) WHERE dirty = 1;

CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sync_conflicts (
    id             TEXT PRIMARY KEY,
    record_id      TEXT NOT NULL,
    kind           TEXT NOT NULL,
    local_payload  BLOB NOT NULL,
    remote_payload BLOB NOT NULL,
    local_rev      TEXT NOT NULL,
    remote_rev     TEXT NOT NULL,
    detected_at    INTEGER NOT NULL,
    resolved_at    INTEGER
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open
    ON sync_conflicts (record_id) WHERE resolved_at IS NULL;
"#;

/// Local SQLite store. Cheap to clone via `Arc`; internally serializes
/// access through a `Mutex<Connection>`.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open or create the database at `path`. Runs all pending migrations.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self, StoreError> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// In-memory store, for tests.
    pub fn open_memory() -> Result<Self, StoreError> {
        let mut conn = Connection::open_in_memory()?;
        run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // -- meta ---------------------------------------------------------------

    pub fn put_meta(&self, key: &str, value: &[u8]) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO vault_meta (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let value: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM vault_meta WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value)
    }

    // -- sync_state (mirror of vault_meta, scoped to the sync layer) --------

    pub fn put_sync_state(&self, key: &str, value: &[u8]) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO sync_state (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_sync_state(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let value: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM sync_state WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value)
    }

    pub fn delete_sync_state(&self, key: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM sync_state WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Remove all user and sync data while keeping schema intact.
    pub fn clear_all_data(&self) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM records", [])?;
        tx.execute("DELETE FROM sync_state", [])?;
        tx.execute("DELETE FROM sync_conflicts", [])?;
        tx.commit()?;
        Ok(())
    }

    // -- records ------------------------------------------------------------

    /// Highest version number across all records. 0 if the table is empty.
    /// Used by the vault to assign monotonically increasing versions.
    pub fn max_version(&self) -> Result<i64, StoreError> {
        let conn = self.conn.lock().unwrap();
        let v: Option<i64> = conn
            .query_row("SELECT MAX(version) FROM records", [], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(v.unwrap_or(0))
    }

    pub fn upsert_record(&self, rec: &Record) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO records (
                id, kind, ciphertext, nonce, version, updated_at, deleted,
                local_rev, server_rev, base_server_rev, dirty, conflict_state
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                kind            = excluded.kind,
                ciphertext      = excluded.ciphertext,
                nonce           = excluded.nonce,
                version         = excluded.version,
                updated_at      = excluded.updated_at,
                deleted         = excluded.deleted,
                local_rev       = excluded.local_rev,
                server_rev      = excluded.server_rev,
                base_server_rev = excluded.base_server_rev,
                dirty           = excluded.dirty,
                conflict_state  = excluded.conflict_state
            "#,
            params![
                rec.id,
                rec.kind,
                rec.ciphertext,
                rec.nonce,
                rec.version,
                rec.updated_at,
                rec.deleted as i64,
                rec.local_rev,
                rec.server_rev,
                rec.base_server_rev,
                rec.dirty as i64,
                rec.conflict_state,
            ],
        )?;
        Ok(())
    }

    pub fn get_record(&self, id: &str) -> Result<Option<Record>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let rec = conn
            .query_row(
                "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted, \
                        local_rev, server_rev, base_server_rev, dirty, conflict_state \
                 FROM records WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(rec)
    }

    /// All non-deleted records of a given `kind`, ordered by version.
    pub fn list_records(&self, kind: &str) -> Result<Vec<Record>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted, \
                    local_rev, server_rev, base_server_rev, dirty, conflict_state \
             FROM records WHERE kind = ?1 AND deleted = 0 ORDER BY version",
        )?;
        let rows = stmt.query_map(params![kind], row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// All records (including tombstones) with `version > since`. The sync
    /// layer uses this to compute outbound deltas. Order is ascending so
    /// callers can stream incrementally.
    pub fn records_since(&self, since: i64) -> Result<Vec<Record>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted, \
                    local_rev, server_rev, base_server_rev, dirty, conflict_state \
             FROM records WHERE version > ?1 ORDER BY version",
        )?;
        let rows = stmt.query_map(params![since], row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// All records (including tombstones) currently marked dirty. The sync
    /// layer's push step drains this list.
    pub fn dirty_records(&self) -> Result<Vec<Record>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted, \
                    local_rev, server_rev, base_server_rev, dirty, conflict_state \
             FROM records WHERE dirty = 1 ORDER BY updated_at",
        )?;
        let rows = stmt.query_map([], row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Permanently remove tombstone rows (`deleted = 1`) whose
    /// `updated_at` is older than `cutoff_unix_ms`. Tombstones are kept
    /// around so that a still-online peer with a stale resurrection
    /// event cannot reintroduce a deleted record; per RFC-002 §12.3,
    /// 90 days is enough to outlast any reasonable peer-offline window.
    ///
    /// Returns the number of rows physically removed.
    pub fn prune_old_tombstones(&self, cutoff_unix_ms: i64) -> Result<usize, StoreError> {
        let conn = self.conn.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM records WHERE deleted = 1 AND dirty = 0 AND updated_at < ?1",
            params![cutoff_unix_ms],
        )?;
        Ok(removed)
    }

    /// Clear the dirty flag and record the `server_rev` returned by the
    /// remote after a successful push. Leaves the rest of the row alone.
    pub fn mark_clean(&self, id: &str, server_rev: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE records SET dirty = 0, server_rev = ?2, base_server_rev = ?2, \
                                 conflict_state = NULL \
             WHERE id = ?1",
            params![id, server_rev],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }

    // -- sync_conflicts -----------------------------------------------------

    pub fn insert_conflict(&self, c: &ConflictRow) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO sync_conflicts
                (id, record_id, kind, local_payload, remote_payload,
                 local_rev, remote_rev, detected_at, resolved_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                c.id,
                c.record_id,
                c.kind,
                c.local_payload,
                c.remote_payload,
                c.local_rev,
                c.remote_rev,
                c.detected_at,
                c.resolved_at,
            ],
        )?;
        Ok(())
    }

    /// All conflicts still awaiting resolution (i.e. `resolved_at IS NULL`).
    pub fn list_open_conflicts(&self) -> Result<Vec<ConflictRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, record_id, kind, local_payload, remote_payload, \
                    local_rev, remote_rev, detected_at, resolved_at \
             FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY detected_at",
        )?;
        let rows = stmt.query_map([], row_to_conflict)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Look up a single conflict by id (resolved or not).
    pub fn get_conflict(&self, id: &str) -> Result<Option<ConflictRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT id, record_id, kind, local_payload, remote_payload, \
                        local_rev, remote_rev, detected_at, resolved_at \
                 FROM sync_conflicts WHERE id = ?1",
                params![id],
                row_to_conflict,
            )
            .optional()?;
        Ok(row)
    }

    /// Delete all resolved conflicts older than `keep_recent` newest. The
    /// retention sweep uses this; sync correctness doesn't depend on it.
    pub fn trim_resolved_conflicts(&self, keep_recent: usize) -> Result<usize, StoreError> {
        let conn = self.conn.lock().unwrap();
        let removed = conn.execute(
            "DELETE FROM sync_conflicts \
             WHERE resolved_at IS NOT NULL \
               AND id NOT IN ( \
                 SELECT id FROM sync_conflicts \
                 WHERE resolved_at IS NOT NULL \
                 ORDER BY resolved_at DESC \
                 LIMIT ?1 \
               )",
            params![keep_recent as i64],
        )?;
        Ok(removed)
    }

    /// Mark a conflict resolved at the given epoch-millis timestamp. The
    /// row stays in the table for audit (cleaned up later by the retention
    /// policy).
    pub fn resolve_conflict(&self, id: &str, resolved_at: i64) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "UPDATE sync_conflicts SET resolved_at = ?2 WHERE id = ?1",
            params![id, resolved_at],
        )?;
        if n == 0 {
            return Err(StoreError::NotFound(id.to_string()));
        }
        Ok(())
    }
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    Ok(Record {
        id: row.get(0)?,
        kind: row.get(1)?,
        ciphertext: row.get(2)?,
        nonce: row.get(3)?,
        version: row.get(4)?,
        updated_at: row.get(5)?,
        deleted: row.get::<_, i64>(6)? != 0,
        local_rev: row.get(7)?,
        server_rev: row.get(8)?,
        base_server_rev: row.get(9)?,
        dirty: row.get::<_, i64>(10)? != 0,
        conflict_state: row.get(11)?,
    })
}

fn row_to_conflict(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConflictRow> {
    Ok(ConflictRow {
        id: row.get(0)?,
        record_id: row.get(1)?,
        kind: row.get(2)?,
        local_payload: row.get(3)?,
        remote_payload: row.get(4)?,
        local_rev: row.get(5)?,
        remote_rev: row.get(6)?,
        detected_at: row.get(7)?,
        resolved_at: row.get(8)?,
    })
}

fn run_migrations(conn: &mut Connection) -> Result<(), StoreError> {
    let current: u32 =
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))? as u32;

    if current > SCHEMA_VERSION {
        return Err(StoreError::SchemaTooNew {
            db: current,
            supported: SCHEMA_VERSION,
        });
    }

    if current < 1 {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V1)?;
        tx.pragma_update(None, "user_version", 1)?;
        tx.commit()?;
        tracing::info!("store: migrated to schema v1");
    }

    if current < 2 {
        let tx = conn.transaction()?;
        tx.execute_batch(MIGRATION_V2)?;
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
        tracing::info!("store: migrated to schema v2");
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, kind: &str, version: i64) -> Record {
        Record {
            id: id.into(),
            kind: kind.into(),
            ciphertext: vec![1, 2, 3],
            nonce: vec![0; 24],
            version,
            updated_at: 99,
            deleted: false,
            local_rev: None,
            server_rev: None,
            base_server_rev: None,
            dirty: false,
            conflict_state: None,
        }
    }

    #[test]
    fn migrates_fresh_db_to_current() {
        let store = Store::open_memory().unwrap();
        assert_eq!(store.max_version().unwrap(), 0);
        // sync_state table exists and is empty.
        assert_eq!(store.get_sync_state("anything").unwrap(), None);
    }

    #[test]
    fn upsert_then_get_roundtrip_with_v2_columns() {
        let store = Store::open_memory().unwrap();
        let mut r = rec("abc", "host", 1);
        r.local_rev = Some("rev-1".into());
        r.dirty = true;
        store.upsert_record(&r).unwrap();

        let got = store.get_record("abc").unwrap().unwrap();
        assert_eq!(got.kind, "host");
        assert_eq!(got.local_rev.as_deref(), Some("rev-1"));
        assert!(got.dirty);
        assert!(got.server_rev.is_none());
    }

    #[test]
    fn list_records_skips_tombstones() {
        let store = Store::open_memory().unwrap();
        store.upsert_record(&rec("a", "host", 1)).unwrap();
        let mut tomb = rec("b", "host", 2);
        tomb.deleted = true;
        store.upsert_record(&tomb).unwrap();

        let live = store.list_records("host").unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].id, "a");

        let everything = store.records_since(0).unwrap();
        assert_eq!(everything.len(), 2);
    }

    #[test]
    fn dirty_records_only_returns_dirty_rows() {
        let store = Store::open_memory().unwrap();
        let mut a = rec("a", "host", 1);
        a.dirty = true;
        let b = rec("b", "host", 2);
        store.upsert_record(&a).unwrap();
        store.upsert_record(&b).unwrap();

        let dirty = store.dirty_records().unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].id, "a");
    }

    #[test]
    fn mark_clean_clears_dirty_and_sets_server_rev() {
        let store = Store::open_memory().unwrap();
        let mut a = rec("a", "host", 1);
        a.dirty = true;
        a.local_rev = Some("rev-1".into());
        store.upsert_record(&a).unwrap();

        store.mark_clean("a", "srv-1").unwrap();
        let after = store.get_record("a").unwrap().unwrap();
        assert!(!after.dirty);
        assert_eq!(after.server_rev.as_deref(), Some("srv-1"));
        assert_eq!(after.base_server_rev.as_deref(), Some("srv-1"));
    }

    #[test]
    fn mark_clean_missing_id_errors() {
        let store = Store::open_memory().unwrap();
        assert!(matches!(
            store.mark_clean("ghost", "srv-1"),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn meta_kv_roundtrip() {
        let store = Store::open_memory().unwrap();
        store.put_meta("salt", &[1, 2, 3]).unwrap();
        assert_eq!(store.get_meta("salt").unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(store.get_meta("nope").unwrap(), None);
    }

    #[test]
    fn sync_state_kv_roundtrip() {
        let store = Store::open_memory().unwrap();
        store.put_sync_state("clock", &[9]).unwrap();
        assert_eq!(store.get_sync_state("clock").unwrap(), Some(vec![9]));
        store.delete_sync_state("clock").unwrap();
        assert_eq!(store.get_sync_state("clock").unwrap(), None);
    }

    #[test]
    fn conflict_lifecycle() {
        let store = Store::open_memory().unwrap();
        let c = ConflictRow {
            id: "cf-1".into(),
            record_id: "rec-1".into(),
            kind: "host".into(),
            local_payload: b"L".to_vec(),
            remote_payload: b"R".to_vec(),
            local_rev: "L1".into(),
            remote_rev: "R1".into(),
            detected_at: 100,
            resolved_at: None,
        };
        store.insert_conflict(&c).unwrap();
        let open = store.list_open_conflicts().unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, "cf-1");

        store.resolve_conflict("cf-1", 200).unwrap();
        assert!(store.list_open_conflicts().unwrap().is_empty());
    }

    #[test]
    fn prune_old_tombstones_only_removes_old_clean_tombstones() {
        let store = Store::open_memory().unwrap();

        // recent clean tombstone — keep
        let mut recent_tomb = rec("recent-tomb", "host", 1);
        recent_tomb.deleted = true;
        recent_tomb.updated_at = 1_000_000;
        store.upsert_record(&recent_tomb).unwrap();

        // old clean tombstone — drop
        let mut old_tomb = rec("old-tomb", "host", 2);
        old_tomb.deleted = true;
        old_tomb.updated_at = 100;
        store.upsert_record(&old_tomb).unwrap();

        // old but dirty tombstone (waiting to push) — keep
        let mut old_dirty_tomb = rec("old-dirty-tomb", "host", 3);
        old_dirty_tomb.deleted = true;
        old_dirty_tomb.dirty = true;
        old_dirty_tomb.updated_at = 100;
        store.upsert_record(&old_dirty_tomb).unwrap();

        // old live record — never prunable through this method
        let mut old_live = rec("old-live", "host", 4);
        old_live.updated_at = 100;
        store.upsert_record(&old_live).unwrap();

        let removed = store.prune_old_tombstones(500).unwrap();
        assert_eq!(removed, 1);
        assert!(store.get_record("old-tomb").unwrap().is_none());
        assert!(store.get_record("recent-tomb").unwrap().is_some());
        assert!(store.get_record("old-dirty-tomb").unwrap().is_some());
        assert!(store.get_record("old-live").unwrap().is_some());
    }

    #[test]
    fn v1_db_migrates_to_v2_without_losing_records() {
        // Build a v1 DB by hand, then re-open it (which should run v2).
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V1).unwrap();
        conn.pragma_update(None, "user_version", 1).unwrap();
        conn.execute(
            "INSERT INTO records (id, kind, ciphertext, nonce, version, updated_at, deleted) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["old-1", "host", vec![9u8], vec![0u8; 24], 1i64, 1i64, 0i64],
        )
        .unwrap();

        // Now run migrations as Store::open would.
        run_migrations(&mut conn).unwrap();
        let version: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap() as u32;
        assert_eq!(version, 2);

        let got: Option<String> = conn
            .query_row(
                "SELECT local_rev FROM records WHERE id = 'old-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(got.is_none(), "legacy row should have NULL local_rev");

        // sync_state must now exist.
        conn.execute(
            "INSERT INTO sync_state (key, value) VALUES ('k', x'00')",
            [],
        )
        .unwrap();
    }
}
