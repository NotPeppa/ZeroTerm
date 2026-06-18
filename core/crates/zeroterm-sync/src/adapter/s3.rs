//! S3-backed sync adapter (RFC-002 §17.4, M8).
//!
//! Maps the [`crate::adapter::SyncAdapter`] trait onto S3 or any
//! S3-compatible service (MinIO, Cloudflare R2, Backblaze B2, …).
//!
//! Key layout: every adapter method receives a repo-relative key
//! (`"manifest.json"`, `"events/2024-03/ev-…json"`); this adapter
//! prepends `<prefix>/zeroterm-sync/` to form the S3 object key.
//! Mirrors the local-folder and WebDAV layouts so the three backends
//! stay interchangeable per repo.
//!
//! S3-specific notes:
//!   - **Directories don't exist.** `mkdir_p` is a no-op; `list` only
//!     filters by prefix.
//!   - **PUT is already atomic** for a single object. `write_atomic`
//!     is just PutObject; no tmp+rename needed.
//!   - **Conditional create** via `If-None-Match: *` (AWS support
//!     announced Nov 2024 — most S3-compatible services have it too,
//!     but on older ones the precondition is silently ignored and
//!     `write_new` degrades to PutObject + last-writer-wins). Event
//!     filenames are ULID-prefixed so a genuine collision is a
//!     protocol-level bug, not a user concern.
//!   - **Rename = Copy + Delete** since S3 has no native rename. We
//!     issue a CopyObject then DeleteObject; if the delete fails the
//!     original lingers as garbage — acceptable for compact's
//!     events→trash flow because the trash prune later cleans up.

use std::time::Duration;

use async_trait::async_trait;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::{Builder as S3ConfigBuilder, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;

use crate::adapter::{ObjectMeta, SyncAdapter};
use crate::error::Error;
use crate::repo::REPO_DIR;

/// User-facing configuration.
#[derive(Debug, Clone)]
pub struct S3Config {
    pub region: String,
    pub bucket: String,
    /// Sub-path under which `zeroterm-sync/` will live. May be empty
    /// (then the repo sits at the bucket root).
    pub prefix: String,
    /// Override for S3-compatible services (MinIO / R2 / B2). Use the
    /// full URL including scheme; leave `None` for AWS S3.
    pub endpoint: Option<String>,
    /// Path-style addressing (`<endpoint>/<bucket>/<key>`) instead of
    /// virtual-hosted (`<bucket>.<endpoint>/<key>`). Most non-AWS
    /// services require this.
    pub force_path_style: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

pub struct S3Adapter {
    cfg: S3Config,
    bucket: String,
    paths: S3Paths,
}

/// Pure key math. Lives outside the adapter so the path layout is
/// covered by unit tests that don't need a live S3 client.
#[derive(Debug, Clone)]
pub(crate) struct S3Paths {
    /// User-supplied prefix, minus any leading/trailing slashes. May be
    /// empty (the repo then sits at the bucket root).
    prefix: String,
}

impl S3Paths {
    pub(crate) fn new(prefix: &str) -> Self {
        Self {
            prefix: prefix.trim_matches('/').to_string(),
        }
    }

    /// Repo-relative key → S3 object key.
    pub(crate) fn object_key(&self, key: &str) -> String {
        let key = key.trim_start_matches('/');
        if self.prefix.is_empty() {
            format!("{REPO_DIR}/{key}")
        } else {
            format!("{}/{REPO_DIR}/{}", self.prefix, key)
        }
    }

    /// Object-key prefix for listings.
    pub(crate) fn list_prefix(&self, prefix: &str) -> String {
        let prefix = prefix.trim_matches('/');
        if prefix.is_empty() {
            // Listing the repo root: include trailing slash so we don't
            // match sibling buckets sharing the zeroterm-sync name.
            self.repo_prefix()
        } else {
            // Caller-supplied subdir prefix.
            let base = self.repo_prefix();
            format!("{base}{prefix}/")
        }
    }

    /// The full repo prefix (`<prefix>/zeroterm-sync/`) used both to
    /// build object keys and to strip them back to repo-relative.
    pub(crate) fn repo_prefix(&self) -> String {
        if self.prefix.is_empty() {
            format!("{REPO_DIR}/")
        } else {
            format!("{}/{}/", self.prefix, REPO_DIR)
        }
    }

    /// Convert a full S3 object key back to repo-relative.
    pub(crate) fn key_to_rel(&self, object_key: &str) -> Option<String> {
        let prefix = self.repo_prefix();
        object_key
            .strip_prefix(&prefix)
            .map(|s| s.trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
    }
}

impl S3Adapter {
    pub async fn new(cfg: S3Config) -> Result<Self, Error> {
        Ok(Self {
            bucket: cfg.bucket.clone(),
            paths: S3Paths::new(&cfg.prefix),
            cfg,
        })
    }

    fn client(&self) -> Result<S3Client, Error> {
        let creds = Credentials::new(
            self.cfg.access_key_id.clone(),
            self.cfg.secret_access_key.clone(),
            self.cfg.session_token.clone(),
            None,
            "zeroterm-sync",
        );
        // We deliberately do not call `aws_config::defaults().load()`
        // because that walks env vars / profile files / IMDS, which is
        // surprising for a sync passphrase-style flow. Caller's config
        // is the only source of truth.
        let mut builder = S3ConfigBuilder::new()
            .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
            .region(Region::new(self.cfg.region.clone()))
            .credentials_provider(creds);
        if let Some(ep) = self.cfg.endpoint.as_deref() {
            if !ep.trim().is_empty() {
                builder = builder.endpoint_url(ep);
            }
        }
        if self.cfg.force_path_style {
            builder = builder.force_path_style(true);
        }
        Ok(S3Client::from_conf(builder.build()))
    }
}

fn is_not_found_str(s: &str) -> bool {
    s.contains("NoSuchKey") || s.contains("NotFound") || s.contains("404")
}

fn err_str<E: std::fmt::Display>(e: E) -> Error {
    Error::Io(std::io::Error::other(e.to_string()))
}

fn is_precondition_failed_str(s: &str) -> bool {
    // S3 surfaces "PreconditionFailed" or HTTP 412 for If-None-Match
    // collisions. MinIO uses the same enum.
    s.contains("PreconditionFailed") || s.contains("412")
}

#[async_trait]
impl SyncAdapter for S3Adapter {
    fn kind(&self) -> &'static str {
        "s3"
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        let object_key = self.paths.object_key(key);
        let client = self.client()?;
        match client
            .get_object()
            .bucket(&self.bucket)
            .key(&object_key)
            .send()
            .await
        {
            Ok(out) => {
                let body = out.body.collect().await.map_err(err_str)?;
                Ok(Some(body.into_bytes().to_vec()))
            }
            Err(e) => {
                let s = e.to_string();
                if is_not_found_str(&s) {
                    Ok(None)
                } else {
                    Err(err_str(s))
                }
            }
        }
    }

    async fn stat(&self, key: &str) -> Result<Option<ObjectMeta>, Error> {
        let object_key = self.paths.object_key(key);
        let client = self.client()?;
        match client
            .head_object()
            .bucket(&self.bucket)
            .key(&object_key)
            .send()
            .await
        {
            Ok(out) => {
                let size = out.content_length.unwrap_or_default().max(0) as u64;
                let modified_unix_ms = out
                    .last_modified
                    .map(|t| t.to_millis().unwrap_or(0))
                    .unwrap_or(0);
                Ok(Some(ObjectMeta {
                    path: key.to_string(),
                    size,
                    modified_unix_ms,
                }))
            }
            Err(e) => {
                let s = e.to_string();
                if is_not_found_str(&s) {
                    Ok(None)
                } else {
                    Err(err_str(s))
                }
            }
        }
    }

    async fn list(&self, prefix: &str, _recursive: bool) -> Result<Vec<ObjectMeta>, Error> {
        // S3 has no directories, so `recursive` is irrelevant — a prefix
        // list is always "recursive" in the local-folder sense.
        let list_prefix = self.paths.list_prefix(prefix);

        let mut out = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let client = self.client()?;
            let mut req = client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&list_prefix);
            if let Some(token) = continuation.as_deref() {
                req = req.continuation_token(token);
            }
            let res = req.send().await.map_err(err_str)?;

            for obj in res.contents() {
                let Some(k) = obj.key() else { continue };
                let Some(rel) = self.paths.key_to_rel(k) else {
                    continue;
                };
                let size = obj.size().unwrap_or_default().max(0) as u64;
                let modified_unix_ms = obj
                    .last_modified()
                    .and_then(|t| t.to_millis().ok())
                    .unwrap_or(0);
                out.push(ObjectMeta {
                    path: rel,
                    size,
                    modified_unix_ms,
                });
            }

            if res.is_truncated().unwrap_or(false) {
                continuation = res.next_continuation_token().map(|s| s.to_string());
                if continuation.is_none() {
                    break;
                }
            } else {
                break;
            }
        }

        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    async fn write_new(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        let object_key = self.paths.object_key(key);
        let client = self.client()?;
        let res = client
            .put_object()
            .bucket(&self.bucket)
            .key(&object_key)
            .if_none_match("*")
            .body(ByteStream::from(bytes.to_vec()))
            .send()
            .await;
        match res {
            Ok(_) => self.stat(key).await?.ok_or(Error::Corrupt),
            Err(e) => {
                let s = e.to_string();
                if is_precondition_failed_str(&s) {
                    Err(Error::AlreadyExists)
                } else {
                    Err(err_str(s))
                }
            }
        }
    }

    async fn write_atomic(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        let object_key = self.paths.object_key(key);
        let client = self.client()?;
        client
            .put_object()
            .bucket(&self.bucket)
            .key(&object_key)
            .body(ByteStream::from(bytes.to_vec()))
            .send()
            .await
            .map_err(err_str)?;
        self.stat(key).await?.ok_or(Error::Corrupt)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        // S3 has no native rename: copy + delete. CopyObject's
        // `copy_source` expects `bucket/key`, URL-encoded.
        let from_key = self.paths.object_key(from);
        let to_key = self.paths.object_key(to);
        let copy_source = format!("{}/{}", self.bucket, url_encode_path(&from_key));
        let client = self.client()?;
        client
            .copy_object()
            .bucket(&self.bucket)
            .key(&to_key)
            .copy_source(copy_source)
            .send()
            .await
            .map_err(err_str)?;
        // Best-effort delete: a leftover source object would only ever
        // be picked up by the next compact's trash sweep.
        let _ = client
            .delete_object()
            .bucket(&self.bucket)
            .key(&from_key)
            .send()
            .await;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        let object_key = self.paths.object_key(key);
        let client = self.client()?;
        // DeleteObject is idempotent — S3 returns 204 whether the key
        // existed or not. Map any error other than transport to Ok().
        match client
            .delete_object()
            .bucket(&self.bucket)
            .key(&object_key)
            .send()
            .await
        {
            Ok(_) => Ok(()),
            Err(e) => {
                let s = e.to_string();
                if is_not_found_str(&s) {
                    Ok(())
                } else {
                    Err(err_str(s))
                }
            }
        }
    }

    async fn mkdir_p(&self, _key: &str) -> Result<(), Error> {
        // S3 has no directories. The engine calls this to "prepare"
        // sub-paths but the actual writes don't need any setup.
        Ok(())
    }

    async fn delete_repo_root_dir(&self) -> Result<(), Error> {
        let prefix = self.paths.repo_prefix();
        let mut token: Option<String> = None;
        loop {
            let client = self.client()?;
            let mut req = client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&prefix);
            if let Some(t) = token.as_deref() {
                req = req.continuation_token(t);
            }
            let out = req.send().await.map_err(err_str)?;
            for obj in out.contents() {
                if let Some(k) = obj.key() {
                    client
                        .delete_object()
                        .bucket(&self.bucket)
                        .key(k)
                        .send()
                        .await
                        .map_err(err_str)?;
                }
            }
            if out.is_truncated().unwrap_or(false) {
                token = out.next_continuation_token().map(ToOwned::to_owned);
            } else {
                break;
            }
        }
        Ok(())
    }

    async fn try_lock(
        &self,
        _name: &str,
        _ttl: Duration,
    ) -> Result<Option<crate::adapter::LockToken>, Error> {
        // S3 has no first-class lock primitive (Object Lock is per-object
        // retention, not the same thing). Engine tolerates a no-op.
        Ok(None)
    }
}

/// Conservative URL encoder for CopyObject's `copy_source` header.
/// Encodes everything except unreserved chars (RFC 3986 §2.3) and `/`.
/// AWS does NOT want the `/` encoded — that's what separates bucket
/// from key in the source spec.
fn url_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let unreserved = matches!(
            b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/'
        );
        if unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pure key-math coverage — the rest of the adapter is wired to a
    // live S3 endpoint. See `docs/manual-s3-test.md` for the manual
    // playbook used to verify the round-trip against a real bucket.

    #[test]
    fn object_key_joins_prefix_repo_dir_and_key() {
        let p = S3Paths::new("zeroterm");
        assert_eq!(
            p.object_key("manifest.json"),
            "zeroterm/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn object_key_handles_empty_prefix() {
        let p = S3Paths::new("");
        assert_eq!(
            p.object_key("events/2024-03/ev-foo.json"),
            "zeroterm-sync/events/2024-03/ev-foo.json"
        );
    }

    #[test]
    fn object_key_trims_prefix_slashes() {
        let p = S3Paths::new("/zeroterm/sub/");
        assert_eq!(
            p.object_key("manifest.json"),
            "zeroterm/sub/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn object_key_strips_leading_key_slash() {
        let p = S3Paths::new("z");
        assert_eq!(
            p.object_key("/manifest.json"),
            "z/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn list_prefix_empty_yields_repo_root() {
        let p = S3Paths::new("zeroterm");
        assert_eq!(p.list_prefix(""), "zeroterm/zeroterm-sync/");
    }

    #[test]
    fn list_prefix_subdir_appends_trailing_slash() {
        let p = S3Paths::new("zeroterm");
        assert_eq!(
            p.list_prefix("events/2024-03"),
            "zeroterm/zeroterm-sync/events/2024-03/"
        );
    }

    #[test]
    fn list_prefix_works_without_user_prefix() {
        let p = S3Paths::new("");
        assert_eq!(p.list_prefix("snapshots"), "zeroterm-sync/snapshots/");
    }

    #[test]
    fn key_to_rel_strips_repo_prefix() {
        let p = S3Paths::new("zeroterm");
        assert_eq!(
            p.key_to_rel("zeroterm/zeroterm-sync/manifest.json")
                .as_deref(),
            Some("manifest.json")
        );
        assert_eq!(
            p.key_to_rel("zeroterm/zeroterm-sync/events/2024-03/ev-1.json")
                .as_deref(),
            Some("events/2024-03/ev-1.json")
        );
    }

    #[test]
    fn key_to_rel_returns_none_outside_repo_prefix() {
        let p = S3Paths::new("zeroterm");
        assert_eq!(p.key_to_rel("other-bucket-prefix/foo.json"), None);
        // Empty result after stripping is treated as "no real key".
        assert_eq!(p.key_to_rel("zeroterm/zeroterm-sync/"), None);
    }

    #[test]
    fn url_encode_path_keeps_slashes_but_escapes_specials() {
        assert_eq!(
            url_encode_path("zeroterm/zeroterm-sync/events/foo bar.json"),
            "zeroterm/zeroterm-sync/events/foo%20bar.json"
        );
        assert_eq!(url_encode_path("a/b/c+d&e.txt"), "a/b/c%2Bd%26e.txt");
    }
}
