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
#[derive(Debug, Clone)]
pub struct Record {
    pub id: String,
    pub kind: String,
    pub ciphertext: Vec<u8>,
    pub nonce: Vec<u8>,
    pub version: i64,
    pub updated_at: i64,
    pub deleted: bool,
}

/// Key/value blob storage for vault metadata (KDF salt, params, verifier).
#[derive(Debug, Clone)]
pub struct MetaEntry {
    pub key: String,
    pub value: Vec<u8>,
}

/// SQLite schema we know how to produce. Bumping this requires adding a
/// migration step in [`run_migrations`].
pub const SCHEMA_VERSION: u32 = 1;

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
            INSERT INTO records (id, kind, ciphertext, nonce, version, updated_at, deleted)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                kind       = excluded.kind,
                ciphertext = excluded.ciphertext,
                nonce      = excluded.nonce,
                version    = excluded.version,
                updated_at = excluded.updated_at,
                deleted    = excluded.deleted
            "#,
            params![
                rec.id,
                rec.kind,
                rec.ciphertext,
                rec.nonce,
                rec.version,
                rec.updated_at,
                rec.deleted as i64,
            ],
        )?;
        Ok(())
    }

    pub fn get_record(&self, id: &str) -> Result<Option<Record>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let rec = conn
            .query_row(
                "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted \
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
            "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted \
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
            "SELECT id, kind, ciphertext, nonce, version, updated_at, deleted \
             FROM records WHERE version > ?1 ORDER BY version",
        )?;
        let rows = stmt.query_map(params![since], row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
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

    // Future migrations:
    //   if current < 2 { ... apply v2 ... }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_db_to_v1() {
        let store = Store::open_memory().unwrap();
        // Smoke test: tables exist, max_version on empty is 0.
        assert_eq!(store.max_version().unwrap(), 0);
    }

    #[test]
    fn upsert_then_get_roundtrip() {
        let store = Store::open_memory().unwrap();
        let rec = Record {
            id: "abc".into(),
            kind: "host".into(),
            ciphertext: vec![1, 2, 3],
            nonce: vec![4; 24],
            version: 1,
            updated_at: 99,
            deleted: false,
        };
        store.upsert_record(&rec).unwrap();

        let got = store.get_record("abc").unwrap().unwrap();
        assert_eq!(got.kind, "host");
        assert_eq!(got.ciphertext, vec![1, 2, 3]);
        assert_eq!(got.version, 1);
    }

    #[test]
    fn list_records_skips_tombstones() {
        let store = Store::open_memory().unwrap();
        store
            .upsert_record(&Record {
                id: "a".into(),
                kind: "host".into(),
                ciphertext: vec![1],
                nonce: vec![0; 24],
                version: 1,
                updated_at: 1,
                deleted: false,
            })
            .unwrap();
        store
            .upsert_record(&Record {
                id: "b".into(),
                kind: "host".into(),
                ciphertext: vec![],
                nonce: vec![],
                version: 2,
                updated_at: 2,
                deleted: true,
            })
            .unwrap();

        let live = store.list_records("host").unwrap();
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].id, "a");

        let everything = store.records_since(0).unwrap();
        assert_eq!(everything.len(), 2);
    }

    #[test]
    fn meta_kv_roundtrip() {
        let store = Store::open_memory().unwrap();
        store.put_meta("salt", &[1, 2, 3]).unwrap();
        assert_eq!(store.get_meta("salt").unwrap(), Some(vec![1, 2, 3]));
        assert_eq!(store.get_meta("nope").unwrap(), None);
    }
}
