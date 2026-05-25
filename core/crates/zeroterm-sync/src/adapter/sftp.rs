//! SFTP-backed sync adapter.
//!
//! Maps the [`crate::adapter::SyncAdapter`] trait onto a live
//! [`zeroterm_ssh::Sftp`] channel. The caller is responsible for
//! connecting the underlying SSH session + ProxyJump (if any) and for
//! keeping them alive — the adapter owns those handles via this struct
//! so dropping the adapter cleanly tears the connection down.
//!
//! Path scheme: every adapter method receives a repo-relative key (e.g.
//! `"manifest.json"`, `"events/2024-03/ev-…json"`); this adapter
//! prepends `<remote_dir>/zeroterm-sync/` to form an absolute remote
//! path. The repo dir name `zeroterm-sync/` matches the local-folder
//! adapter so the two stores look identical on the wire.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;

use zeroterm_ssh::{FileKind, Session, Sftp, SshError};

use crate::adapter::{ObjectMeta, SyncAdapter};
use crate::error::Error;
use crate::repo::REPO_DIR;

pub struct SftpAdapter {
    sftp: Arc<Sftp>,
    /// Held to keep the SSH session alive for the adapter's lifetime —
    /// no methods read these fields, but dropping them closes the
    /// underlying TCP connection.
    _session: Session,
    _jump_session: Option<Session>,
    paths: SftpPaths,
}

/// Pure path math for the SFTP adapter. Lives outside the adapter so
/// the path layout is covered by unit tests that don't need a real
/// SSH connection. The semantics here MUST stay in sync with what the
/// local-folder adapter writes on disk so the two backends are
/// interchangeable per repo.
#[derive(Debug, Clone)]
pub(crate) struct SftpPaths {
    /// Absolute remote base dir, never with a trailing slash (apart
    /// from `/` itself).
    base_dir: String,
}

impl SftpPaths {
    pub(crate) fn new(remote_dir: impl Into<String>) -> Self {
        let mut base = remote_dir.into();
        while base.ends_with('/') && base.len() > 1 {
            base.pop();
        }
        Self { base_dir: base }
    }

    /// Repo-relative key → absolute remote path.
    pub(crate) fn full(&self, key: &str) -> String {
        let trimmed = key.trim_start_matches('/');
        if self.base_dir == "/" {
            format!("/{REPO_DIR}/{trimmed}")
        } else {
            format!("{}/{REPO_DIR}/{}", self.base_dir, trimmed)
        }
    }

    /// Same as [`full`] but for directory listings — trailing slashes
    /// confuse some servers so we never emit them.
    pub(crate) fn dir(&self, prefix: &str) -> String {
        let p = self.full(prefix);
        let trimmed = p.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    }

    /// Absolute path of the `zeroterm-sync` repo dir.
    pub(crate) fn repo_root(&self) -> String {
        if self.base_dir == "/" {
            format!("/{REPO_DIR}")
        } else {
            format!("{}/{}", self.base_dir, REPO_DIR)
        }
    }
}

impl SftpAdapter {
    /// Wrap a freshly-connected SFTP channel.
    ///
    /// `remote_dir` is the directory under which `zeroterm-sync/` will
    /// be created. It must be an absolute remote path (most SFTP servers
    /// have a per-user `$HOME` cwd, so relative paths *usually* work —
    /// but absolute is the only contract we can rely on).
    pub fn new(
        sftp: Arc<Sftp>,
        session: Session,
        jump_session: Option<Session>,
        remote_dir: impl Into<String>,
    ) -> Self {
        Self {
            sftp,
            _session: session,
            _jump_session: jump_session,
            paths: SftpPaths::new(remote_dir),
        }
    }

    fn full(&self, key: &str) -> String {
        self.paths.full(key)
    }

    fn dir(&self, prefix: &str) -> String {
        self.paths.dir(prefix)
    }

    fn repo_root(&self) -> String {
        self.paths.repo_root()
    }

    async fn ensure_dirs_for(&self, key: &str) -> Result<(), Error> {
        let full = self.full(key);
        // Drop the final segment (file name).
        let parent = match full.rsplit_once('/') {
            Some((p, _)) => p.to_string(),
            None => return Ok(()),
        };
        self.mkdir_p_absolute(&parent).await
    }

    async fn mkdir_p_absolute(&self, abs_path: &str) -> Result<(), Error> {
        // Walk path components left-to-right, mkdir each. Ignore
        // "already exists" — SFTP servers signal this differently, so
        // we treat *any* `create_dir` error as "probably exists" and
        // verify by stat afterwards.
        if abs_path.is_empty() || abs_path == "/" {
            return Ok(());
        }
        let parts: Vec<&str> = abs_path.split('/').filter(|s| !s.is_empty()).collect();
        let leading_slash = abs_path.starts_with('/');
        let mut acc = String::new();
        for part in parts {
            if leading_slash || !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            // Attempt mkdir; ignore failures (could be "exists"). We
            // verify success after the full walk via a final stat below.
            let _ = self.sftp.create_dir(&acc).await;
        }
        // Confirm the leaf exists; if not, the original error was
        // genuine.
        match self.sftp.stat(abs_path).await {
            Ok(m) if matches!(m.kind, FileKind::Dir) => Ok(()),
            Ok(_) => Err(Error::Corrupt),
            Err(e) => Err(map_ssh_err(e)),
        }
    }

    async fn list_recursive(&self, abs_path: &str, recursive: bool) -> Result<Vec<RemoteEntry>, Error> {
        // Bail early if root doesn't exist — adapter contract is empty list, not error.
        match self.sftp.stat(abs_path).await {
            Ok(m) if matches!(m.kind, FileKind::Dir) => {}
            Ok(_) => return Ok(Vec::new()),
            Err(e) if is_not_found(&e) => return Ok(Vec::new()),
            Err(e) => return Err(map_ssh_err(e)),
        }

        let mut out = Vec::new();
        let mut stack = vec![abs_path.to_string()];
        while let Some(dir) = stack.pop() {
            let entries = self.sftp.list(&dir).await.map_err(map_ssh_err)?;
            for e in entries {
                if e.name == "." || e.name == ".." {
                    continue;
                }
                let full = format!("{dir}/{}", e.name);
                match e.kind {
                    FileKind::Dir => {
                        if recursive {
                            stack.push(full);
                        }
                    }
                    FileKind::File | FileKind::Symlink => {
                        out.push(RemoteEntry {
                            full_path: full,
                            size: e.size,
                            modified_unix_ms: e.modified_unix_ms.unwrap_or(0),
                        });
                    }
                    FileKind::Other => {}
                }
            }
        }
        Ok(out)
    }
}

struct RemoteEntry {
    full_path: String,
    size: u64,
    modified_unix_ms: i64,
}

fn map_ssh_err(e: SshError) -> Error {
    tracing::error!(error = ?e, "sftp adapter ssh error");
    match &e {
        SshError::Cancelled => Error::Io(std::io::Error::other("sftp transfer cancelled")),
        _ => Error::Io(std::io::Error::other(e.to_string())),
    }
}

fn is_not_found(e: &SshError) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("no such file") || s.contains("not found") || s.contains("does not exist")
}

#[async_trait]
impl SyncAdapter for SftpAdapter {
    fn kind(&self) -> &'static str {
        "sftp"
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        let path = self.full(key);
        match self.sftp.download_to_vec(&path).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(map_ssh_err(e)),
        }
    }

    async fn stat(&self, key: &str) -> Result<Option<ObjectMeta>, Error> {
        let path = self.full(key);
        match self.sftp.stat(&path).await {
            Ok(m) => Ok(Some(ObjectMeta {
                path: key.to_string(),
                size: m.size,
                modified_unix_ms: m.modified_unix_ms.unwrap_or(0),
            })),
            Err(e) if is_not_found(&e) => Ok(None),
            Err(e) => Err(map_ssh_err(e)),
        }
    }

    async fn list(&self, prefix: &str, recursive: bool) -> Result<Vec<ObjectMeta>, Error> {
        let abs = self.dir(prefix);
        let root = self.repo_root();
        let entries = self.list_recursive(&abs, recursive).await?;

        let mut out: Vec<ObjectMeta> = entries
            .into_iter()
            .map(|e| {
                // Convert absolute path back to repo-relative.
                let rel = e
                    .full_path
                    .strip_prefix(&format!("{root}/"))
                    .unwrap_or(&e.full_path)
                    .to_string();
                ObjectMeta {
                    path: rel,
                    size: e.size,
                    modified_unix_ms: e.modified_unix_ms,
                }
            })
            .collect();
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    async fn write_new(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        self.ensure_dirs_for(key).await?;
        // Best-effort existence check before upload. SFTP doesn't have
        // a true "create new" mode without server extensions, so a
        // racing writer could slip in between this stat and the upload.
        // Acceptable: events are uniquely named with ULID + clock, so
        // genuine collisions only happen on protocol-level bugs anyway.
        if let Ok(Some(_)) = self.stat(key).await {
            return Err(Error::AlreadyExists);
        }
        let path = self.full(key);
        self.sftp
            .upload_from_slice(&path, bytes)
            .await
            .map_err(map_ssh_err)?;
        Ok(self.stat(key).await?.unwrap_or(ObjectMeta {
            path: key.to_string(),
            size: bytes.len() as u64,
            modified_unix_ms: 0,
        }))
    }

    async fn write_atomic(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        self.ensure_dirs_for(key).await?;
        let path = self.full(key);

        // Random tmp suffix collocated with the destination so we can
        // rename across the same SFTP "filesystem" (cross-server rename
        // isn't a thing anyway). Pure-bytes randomness because the
        // crypto crate is already a dep.
        let suffix: String = {
            let r = zeroterm_crypto::random_bytes(8);
            r.iter().map(|b| format!("{:02x}", b)).collect()
        };
        let tmp = format!("{path}.tmp-{suffix}");

        self.sftp
            .upload_from_slice(&tmp, bytes)
            .await
            .map_err(map_ssh_err)?;

        // Delete the destination if it exists, then rename. NOT atomic
        // against other writers — true atomic-replace would need the
        // server's posix-rename extension (russh-sftp doesn't expose
        // it yet). Acceptable for repo-sync since the engine
        // serialises writes to manifest/keyring within a process.
        let _ = self.sftp.remove_file(&path).await;
        if let Err(e) = self.sftp.rename(&tmp, &path).await {
            // Best-effort cleanup of the tmp file if rename failed.
            let _ = self.sftp.remove_file(&tmp).await;
            return Err(map_ssh_err(e));
        }

        Ok(self.stat(key).await?.unwrap_or(ObjectMeta {
            path: key.to_string(),
            size: bytes.len() as u64,
            modified_unix_ms: 0,
        }))
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        self.ensure_dirs_for(to).await?;
        let f = self.full(from);
        let t = self.full(to);
        let _ = self.sftp.remove_file(&t).await;
        self.sftp.rename(&f, &t).await.map_err(map_ssh_err)?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        let path = self.full(key);
        match self.sftp.remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if is_not_found(&e) => Ok(()),
            Err(e) => Err(map_ssh_err(e)),
        }
    }

    async fn mkdir_p(&self, key: &str) -> Result<(), Error> {
        let path = self.full(key);
        self.mkdir_p_absolute(&path).await
    }

    async fn try_lock(
        &self,
        _name: &str,
        _ttl: Duration,
    ) -> Result<Option<crate::adapter::LockToken>, Error> {
        // SFTP has no native lock primitive. The engine's compact path
        // tolerates this — it just relies on serial calls from a single
        // process. Multi-device compact races converge through the
        // manifest's last-writer-wins semantics.
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure path-math coverage — the rest of the adapter is wired to a
    // live SFTP server, which can't run in unit tests without standing
    // up an embedded russh server (significant ceremony for a thin
    // layer of glue). See `docs/manual-sftp-test.md` for the manual
    // playbook used to verify the round-trip against a real server.

    #[test]
    fn full_joins_base_dir_with_repo_dir_and_key() {
        let p = SftpPaths::new("/home/me/zeroterm");
        assert_eq!(
            p.full("events/2024-03/ev-foo.json"),
            "/home/me/zeroterm/.zeroterm-sync/events/2024-03/ev-foo.json"
        );
    }

    #[test]
    fn full_strips_trailing_slashes_from_base_dir() {
        let p = SftpPaths::new("/home/me/zeroterm///");
        assert_eq!(p.full("manifest.json"), "/home/me/zeroterm/.zeroterm-sync/manifest.json");
    }

    #[test]
    fn full_handles_root_base_dir() {
        let p = SftpPaths::new("/");
        assert_eq!(p.full("manifest.json"), "/.zeroterm-sync/manifest.json");
    }

    #[test]
    fn full_strips_leading_slash_from_key() {
        let p = SftpPaths::new("/var/lib");
        assert_eq!(p.full("/manifest.json"), "/var/lib/.zeroterm-sync/manifest.json");
    }

    #[test]
    fn dir_never_emits_trailing_slash() {
        let p = SftpPaths::new("/var/lib");
        assert_eq!(p.dir("events/2024-03/"), "/var/lib/.zeroterm-sync/events/2024-03");
        assert_eq!(p.dir("events/2024-03"), "/var/lib/.zeroterm-sync/events/2024-03");
    }

    #[test]
    fn repo_root_matches_full_with_empty_key() {
        let p = SftpPaths::new("/home/me");
        assert_eq!(p.repo_root(), "/home/me/.zeroterm-sync");
        let root = SftpPaths::new("/");
        assert_eq!(root.repo_root(), "/.zeroterm-sync");
    }
}
