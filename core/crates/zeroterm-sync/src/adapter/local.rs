//! Local-folder sync adapter.
//!
//! The sync "repo" lives at `<root>/zeroterm-sync/`. The root is just
//! a directory the user picks (synced cloud folder, USB stick, network
//! share). All adapter paths are relative to `zeroterm-sync/` — the
//! adapter prepends the prefix internally so the engine never sees the
//! marker directory.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use async_trait::async_trait;
use tokio::fs;
use tokio::io::AsyncWriteExt;

use crate::adapter::{ObjectMeta, SyncAdapter};
use crate::error::Error;
use crate::repo;

pub struct LocalAdapter {
    root: PathBuf,
}

impl LocalAdapter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Public for tests / diagnostics — the absolute path on disk that
    /// holds the repo.
    pub fn repo_dir(&self) -> PathBuf {
        self.root.join(repo::REPO_DIR)
    }

    fn full(&self, key: &str) -> PathBuf {
        repo::join(&self.root, key)
    }

    fn to_meta(&self, full: &Path, m: &std::fs::Metadata) -> Result<Option<ObjectMeta>, Error> {
        let base = self.repo_dir();
        let rel = match full.strip_prefix(&base) {
            Ok(r) => r,
            Err(_) => return Ok(None),
        };
        Ok(Some(ObjectMeta {
            path: rel.to_string_lossy().replace('\\', "/"),
            size: m.len(),
            modified_unix_ms: modified_ms(m),
        }))
    }
}

fn modified_ms(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_suffix() -> String {
    let bytes = zeroterm_crypto::random_bytes(8);
    let mut s = String::with_capacity(16);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

#[async_trait]
impl SyncAdapter for LocalAdapter {
    fn kind(&self) -> &'static str {
        "local"
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        match fs::read(self.full(key)).await {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    async fn stat(&self, key: &str) -> Result<Option<ObjectMeta>, Error> {
        let p = self.full(key);
        let m = match fs::metadata(&p).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(Error::Io(e)),
        };
        Ok(Some(ObjectMeta {
            path: key.to_string(),
            size: m.len(),
            modified_unix_ms: modified_ms(&m),
        }))
    }

    async fn list(&self, prefix: &str, recursive: bool) -> Result<Vec<ObjectMeta>, Error> {
        let base = self.full(prefix);
        let mut out = Vec::new();

        if fs::metadata(&base).await.is_err() {
            return Ok(out);
        }

        if recursive {
            let mut stack = vec![base];
            while let Some(dir) = stack.pop() {
                let mut rd = fs::read_dir(&dir).await?;
                while let Some(ent) = rd.next_entry().await? {
                    let path = ent.path();
                    let m = ent.metadata().await?;
                    if m.is_dir() {
                        stack.push(path);
                        continue;
                    }
                    if let Some(meta) = self.to_meta(&path, &m)? {
                        out.push(meta);
                    }
                }
            }
        } else {
            let mut rd = fs::read_dir(&base).await?;
            while let Some(ent) = rd.next_entry().await? {
                let path = ent.path();
                let m = ent.metadata().await?;
                if m.is_dir() {
                    continue;
                }
                if let Some(meta) = self.to_meta(&path, &m)? {
                    out.push(meta);
                }
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    async fn write_new(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        let p = self.full(key);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut f = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .await
        {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(Error::AlreadyExists)
            }
            Err(e) => return Err(Error::Io(e)),
        };
        f.write_all(bytes).await?;
        f.flush().await?;
        drop(f);
        self.stat(key).await?.ok_or(Error::Corrupt)
    }

    async fn write_atomic(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        let p = self.full(key);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).await?;
        }

        // Put the temp file next to the destination so the rename stays
        // on the same volume (cross-volume renames are not atomic on
        // Windows and become copy-then-delete on Unix).
        let tmp_name = match p.file_name().and_then(|n| n.to_str()) {
            Some(name) => format!(".{name}.tmp-{}", random_suffix()),
            None => return Err(Error::Corrupt),
        };
        let tmp = p
            .parent()
            .map(|d| d.join(&tmp_name))
            .unwrap_or_else(|| PathBuf::from(&tmp_name));

        {
            let mut f = fs::File::create(&tmp).await?;
            f.write_all(bytes).await?;
            f.flush().await?;
        }
        // On Windows, std/tokio's rename uses MoveFileExW with
        // MOVEFILE_REPLACE_EXISTING, so this replaces an existing file
        // atomically; on Unix, rename(2) is atomic on the same filesystem.
        fs::rename(&tmp, &p).await?;

        self.stat(key).await?.ok_or(Error::Corrupt)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        let f = self.full(from);
        let t = self.full(to);
        if let Some(parent) = t.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::rename(&f, &t).await?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        match fs::remove_file(self.full(key)).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Io(e)),
        }
    }

    async fn mkdir_p(&self, key: &str) -> Result<(), Error> {
        fs::create_dir_all(self.full(key)).await?;
        Ok(())
    }

    async fn delete_repo_root_dir(&self) -> Result<(), Error> {
        let root = self.repo_dir();
        match fs::remove_dir_all(root).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Io(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn adapter() -> (tempfile::TempDir, LocalAdapter) {
        let d = tempdir().unwrap();
        let a = LocalAdapter::new(d.path());
        (d, a)
    }

    #[tokio::test]
    async fn read_missing_file_returns_none() {
        let (_d, a) = adapter();
        assert!(a.read("manifest.json").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn write_atomic_roundtrip() {
        let (_d, a) = adapter();
        a.write_atomic("manifest.json", b"hello").await.unwrap();
        let back = a.read("manifest.json").await.unwrap().unwrap();
        assert_eq!(back, b"hello");
    }

    #[tokio::test]
    async fn write_atomic_replaces_existing() {
        let (_d, a) = adapter();
        a.write_atomic("manifest.json", b"v1").await.unwrap();
        a.write_atomic("manifest.json", b"v2").await.unwrap();
        let back = a.read("manifest.json").await.unwrap().unwrap();
        assert_eq!(back, b"v2");
    }

    #[tokio::test]
    async fn write_new_collides_loudly() {
        let (_d, a) = adapter();
        a.write_new("events/2024-03/ev-1.json", b"first").await.unwrap();
        let err = a.write_new("events/2024-03/ev-1.json", b"again").await;
        assert!(matches!(err, Err(Error::AlreadyExists)));
    }

    #[tokio::test]
    async fn list_recursive_returns_relative_paths() {
        let (_d, a) = adapter();
        a.write_new("events/2024-03/ev-1.json", b"x").await.unwrap();
        a.write_new("events/2024-03/ev-2.json", b"x").await.unwrap();
        a.write_new("snapshots/snap-1.bin", b"y").await.unwrap();

        let listed = a.list("events", true).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|m| m.path.starts_with("events/2024-03/")));
        // Forward slashes regardless of platform.
        assert!(listed.iter().all(|m| !m.path.contains('\\')));
    }

    #[tokio::test]
    async fn list_missing_prefix_is_empty_not_error() {
        let (_d, a) = adapter();
        assert!(a.list("never-existed", true).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn mkdir_p_is_idempotent() {
        let (_d, a) = adapter();
        a.mkdir_p("locks").await.unwrap();
        a.mkdir_p("locks").await.unwrap();
    }

    #[tokio::test]
    async fn delete_missing_is_noop() {
        let (_d, a) = adapter();
        a.delete("nothing/here").await.unwrap();
    }

    #[tokio::test]
    async fn stat_reports_size() {
        let (_d, a) = adapter();
        a.write_atomic("keyring.json", b"abcd").await.unwrap();
        let m = a.stat("keyring.json").await.unwrap().unwrap();
        assert_eq!(m.size, 4);
        assert_eq!(m.path, "keyring.json");
    }
}
