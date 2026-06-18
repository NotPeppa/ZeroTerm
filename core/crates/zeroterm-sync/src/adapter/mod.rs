//! The new sync adapter trait.
//!
//! Replaces the old ETag-CAS-based sync adapter model with
//! a smaller API tailored to the repo layout:
//!   - `write_new` for append-only files (events, snapshots) — fails if
//!     the path already exists, so collisions are caught loudly instead
//!     of silently overwriting.
//!   - `write_atomic` for mutable files (manifest, keyring, device meta)
//!     — semantics are write-to-tmp-then-rename, so a torn write is
//!     never visible.
//!   - `rename` + `mkdir_p` + `list(recursive)` round out the file-system
//!     primitives that the repo layout needs.
//!
//! `try_lock` / `unlock` have default no-op implementations: not every
//! backend can implement a real distributed lock, and the engine's
//! compact step is best-effort anyway (RFC-002 §15).

use std::time::Duration;

use async_trait::async_trait;

use crate::error::Error;

#[derive(Debug, Clone)]
pub struct ObjectMeta {
    /// Repo-relative path, using `/` as the separator regardless of OS.
    pub path: String,
    pub size: u64,
    pub modified_unix_ms: i64,
}

/// Opaque token returned by [`SyncAdapter::try_lock`]. The backend is
/// free to interpret the inner string however it likes — file lease id,
/// S3 multipart upload id, whatever.
#[derive(Debug, Clone)]
pub struct LockToken {
    pub name: String,
    pub token: String,
}

#[async_trait]
pub trait SyncAdapter: Send + Sync {
    fn kind(&self) -> &'static str;

    async fn read(&self, path: &str) -> Result<Option<Vec<u8>>, Error>;

    async fn stat(&self, path: &str) -> Result<Option<ObjectMeta>, Error>;

    async fn list(&self, prefix: &str, recursive: bool) -> Result<Vec<ObjectMeta>, Error>;

    /// Write a file that must not yet exist. Returns
    /// [`Error::AlreadyExists`] on collision — that's how the engine
    /// detects two devices writing an event with the same filename.
    async fn write_new(&self, path: &str, bytes: &[u8]) -> Result<ObjectMeta, Error>;

    /// Atomic replace: write to a temp file, then rename over `path`.
    /// Readers never see a half-written file.
    async fn write_atomic(&self, path: &str, bytes: &[u8]) -> Result<ObjectMeta, Error>;

    async fn rename(&self, from: &str, to: &str) -> Result<(), Error>;

    async fn delete(&self, path: &str) -> Result<(), Error>;

    async fn mkdir_p(&self, path: &str) -> Result<(), Error>;

    /// Delete the whole repo root directory (`.../zeroterm-sync/`) for
    /// this adapter.
    async fn delete_repo_root_dir(&self) -> Result<(), Error>;

    /// Best-effort distributed lock. Default returns `None` ("not
    /// supported"); engines must work correctly without it.
    async fn try_lock(&self, _name: &str, _ttl: Duration) -> Result<Option<LockToken>, Error> {
        Ok(None)
    }

    async fn unlock(&self, _token: &LockToken) -> Result<(), Error> {
        Ok(())
    }
}

pub mod local;
#[cfg(feature = "s3-backend")]
pub mod s3;
pub mod sftp;
#[cfg(feature = "webdav-backend")]
pub mod webdav;
pub use local::LocalAdapter;
#[cfg(feature = "s3-backend")]
pub use s3::{S3Adapter, S3Config};
pub use sftp::SftpAdapter;
#[cfg(feature = "webdav-backend")]
pub use webdav::{WebDavAdapter, WebDavConfig};
