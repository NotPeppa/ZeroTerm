//! WebDAV-backed sync adapter (RFC-002 §17.3, M7).
//!
//! Maps the [`crate::adapter::SyncAdapter`] trait onto a WebDAV server.
//! Path scheme: every adapter method receives a repo-relative key
//! (e.g. `"manifest.json"`, `"events/2024-03/ev-…json"`); this adapter
//! prepends `<base_url>/<root_path>/zeroterm-sync/` to form the
//! absolute URL. The `zeroterm-sync/` marker mirrors what the local
//! and SFTP adapters do so all three backends look interchangeable.
//!
//! HTTP verbs used:
//!   - `GET`     → read
//!   - `HEAD`    → stat
//!   - `PROPFIND Depth: infinity` → list (recursive)
//!   - `PROPFIND Depth: 1`        → list (non-recursive)
//!   - `PUT`     → write_atomic (server-side atomic overwrite)
//!   - `PUT` + `If-None-Match: *` → write_new (412 → AlreadyExists)
//!   - `MOVE`    → rename
//!   - `DELETE`  → delete
//!   - `MKCOL`   → mkdir_p (per segment, idempotent)
//!
//! Authentication is HTTP Basic for now — that matches what every major
//! WebDAV-as-a-Service (Nextcloud, ownCloud, Box, FastMail, plain
//! Apache/nginx) supports. Bearer tokens land later behind the same
//! feature gate.

use std::time::Duration;

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode};

use crate::adapter::{validate_repo_relative_path, ObjectMeta, SyncAdapter};
use crate::error::Error;
use crate::repo::REPO_DIR;

/// User-facing configuration. Built once at engine construction time.
#[derive(Debug, Clone)]
pub struct WebDavConfig {
    /// Server base URL, e.g. `https://dav.example.com/remote.php/dav/files/alice`.
    /// Trailing slashes are normalised away.
    pub base_url: String,
    /// Path under `base_url` to host the repo, e.g. `"zeroterm"`. May be
    /// empty (then the repo lives directly under `base_url`).
    pub root_path: String,
    pub username: String,
    pub password: String,
    /// HTTP timeout per request. Defaults to 30 s if `None`.
    pub timeout: Option<Duration>,
}

pub struct WebDavAdapter {
    paths: WebDavPaths,
    default_headers: HeaderMap,
    timeout: Duration,
}

/// Pure URL math. Lives outside the adapter so the path layout is
/// covered by unit tests that don't need a live HTTP client.
#[derive(Debug, Clone)]
pub(crate) struct WebDavPaths {
    /// `base_url` minus any trailing slashes.
    base_url: String,
    /// `root_path` minus any leading/trailing slashes; may be empty.
    root_path: String,
}

impl WebDavPaths {
    pub(crate) fn new(base_url: &str, root_path: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            root_path: root_path.trim_matches('/').to_string(),
        }
    }

    /// Repo-relative key → absolute URL.
    pub(crate) fn url_of(&self, key: &str) -> String {
        let key = key.trim_start_matches('/');
        if self.root_path.is_empty() {
            format!("{}/{}/{}", self.base_url, REPO_DIR, key)
        } else {
            format!("{}/{}/{}/{}", self.base_url, self.root_path, REPO_DIR, key)
        }
    }

    /// URL of the `zeroterm-sync/` collection itself (no trailing key).
    pub(crate) fn repo_root_url(&self) -> String {
        if self.root_path.is_empty() {
            format!("{}/{}", self.base_url, REPO_DIR)
        } else {
            format!("{}/{}/{}", self.base_url, self.root_path, REPO_DIR)
        }
    }

    /// Server-relative path prefix that PROPFIND `href` values start
    /// with. Used to strip the prefix when converting `href` → key.
    /// Example: if base_url is `https://dav.example.com/dav/alice`,
    /// servers usually return `href="/dav/alice/zeroterm/zeroterm-sync/manifest.json"`.
    pub(crate) fn server_path_prefix(&self) -> String {
        // base_url's path portion. We strip the scheme + authority by
        // finding the third `/` after `://`.
        let after_scheme = self
            .base_url
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&self.base_url);
        let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
        let path = &after_scheme[path_start..];
        let path = path.trim_end_matches('/');
        if self.root_path.is_empty() {
            format!("{path}/{REPO_DIR}/")
        } else {
            format!("{path}/{}/{REPO_DIR}/", self.root_path)
        }
    }
}

impl WebDavAdapter {
    pub fn new(cfg: WebDavConfig) -> Result<Self, Error> {
        let mut headers = HeaderMap::new();
        let auth = format!("{}:{}", cfg.username, cfg.password);
        let token = B64.encode(auth.as_bytes());
        let value = HeaderValue::from_str(&format!("Basic {token}")).map_err(|_| Error::Corrupt)?;
        headers.insert("Authorization", value);

        Ok(Self {
            paths: WebDavPaths::new(&cfg.base_url, &cfg.root_path),
            default_headers: headers,
            timeout: cfg.timeout.unwrap_or_else(|| Duration::from_secs(30)),
        })
    }

    fn client(&self) -> Result<reqwest::Client, Error> {
        reqwest::Client::builder()
            .default_headers(self.default_headers.clone())
            .timeout(self.timeout)
            .build()
            .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))
    }

    async fn mkcol_one(&self, url: &str) -> Result<(), Error> {
        let client = self.client()?;
        let mkcol_url = if url.ends_with('/') {
            url.to_string()
        } else {
            format!("{url}/")
        };
        let res = client
            .request(Method::from_bytes(b"MKCOL").unwrap(), &mkcol_url)
            .send()
            .await
            .map_err(transport_err)?;
        // 201 Created and 405 Method Not Allowed (already exists) are
        // both idempotent-success for our directory bootstrap flow.
        //
        // Some servers (including certain Nextcloud setups) return 409
        // when the collection already exists. For 409 we probe with HEAD:
        // if the path exists, treat as success; otherwise bubble the error.
        let status = res.status();
        match status {
            s if s.is_success() => Ok(()),
            StatusCode::METHOD_NOT_ALLOWED => Ok(()),
            StatusCode::CONFLICT => {
                let mkcol_body = res.text().await.unwrap_or_default();
                let probe = client
                    .head(&mkcol_url)
                    .send()
                    .await
                    .map_err(transport_err)?;
                match probe.status() {
                    s if s.is_success() => Ok(()),
                    other => Err(Error::Io(std::io::Error::other(format!(
                        "webdav MKCOL {mkcol_url} failed: {status}; HEAD probe: {other}; body: {mkcol_body}"
                    )))),
                }
            }
            other => {
                let body = res.text().await.unwrap_or_default();
                Err(Error::Io(std::io::Error::other(format!(
                    "webdav MKCOL {mkcol_url} failed: {other}; body: {body}"
                ))))
            }
        }
    }

    async fn ensure_root_path_dirs(&self) -> Result<(), Error> {
        let root = self.paths.root_path.trim_matches('/');
        if root.is_empty() {
            return Ok(());
        }

        let mut acc = String::new();
        for part in root.split('/') {
            if part.is_empty() {
                continue;
            }
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            let url = format!("{}/{}", self.paths.base_url, acc);
            self.mkcol_one(&url).await?;
        }
        Ok(())
    }
}

fn transport_err(e: reqwest::Error) -> Error {
    Error::Io(std::io::Error::other(e.to_string()))
}

fn http_err(verb: &str, url: &str, status: StatusCode) -> Error {
    Error::Io(std::io::Error::other(format!(
        "webdav {verb} {url} failed: {status}"
    )))
}

#[async_trait]
impl SyncAdapter for WebDavAdapter {
    fn kind(&self) -> &'static str {
        "webdav"
    }

    async fn read(&self, key: &str) -> Result<Option<Vec<u8>>, Error> {
        let url = self.paths.url_of(key);
        let client = self.client()?;
        let res = client.get(&url).send().await.map_err(transport_err)?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => {
                let bytes = res.bytes().await.map_err(transport_err)?;
                Ok(Some(bytes.to_vec()))
            }
            other => Err(http_err("GET", &url, other)),
        }
    }

    async fn stat(&self, key: &str) -> Result<Option<ObjectMeta>, Error> {
        let url = self.paths.url_of(key);
        let client = self.client()?;
        let res = client.head(&url).send().await.map_err(transport_err)?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => {
                let size = res
                    .headers()
                    .get("content-length")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(0);
                let modified_unix_ms = res
                    .headers()
                    .get("last-modified")
                    .and_then(|v| v.to_str().ok())
                    .and_then(parse_http_date_ms)
                    .unwrap_or(0);
                Ok(Some(ObjectMeta {
                    path: key.to_string(),
                    size,
                    modified_unix_ms,
                }))
            }
            other => Err(http_err("HEAD", &url, other)),
        }
    }

    async fn list(&self, prefix: &str, recursive: bool) -> Result<Vec<ObjectMeta>, Error> {
        let url = self.paths.url_of(prefix);
        let client = self.client()?;
        let depth = if recursive { "infinity" } else { "1" };
        let body = r#"<?xml version="1.0" encoding="utf-8" ?>
<propfind xmlns="DAV:">
  <prop>
    <getcontentlength/>
    <getlastmodified/>
    <resourcetype/>
  </prop>
</propfind>"#;
        let res = client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .header("Depth", depth)
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body)
            .send()
            .await
            .map_err(transport_err)?;

        match res.status() {
            StatusCode::NOT_FOUND => return Ok(Vec::new()),
            s if s.is_success() || s == StatusCode::MULTI_STATUS => {}
            other => return Err(http_err("PROPFIND", &url, other)),
        }

        let xml = res.text().await.map_err(transport_err)?;
        let server_prefix = self.paths.server_path_prefix();
        let mut entries = parse_propfind(&xml, &server_prefix)?;
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(entries)
    }

    async fn write_new(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        self.ensure_parent_dirs(key).await?;
        let url = self.paths.url_of(key);
        let client = self.client()?;
        let res = client
            .put(&url)
            .header("If-None-Match", "*")
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(transport_err)?;
        match res.status() {
            // Server-side existence collision — exactly the error our
            // event log relies on to detect duplicate file names.
            StatusCode::PRECONDITION_FAILED => Err(Error::AlreadyExists),
            s if s.is_success() => self.stat(key).await?.ok_or(Error::Corrupt),
            other => Err(http_err("PUT (new)", &url, other)),
        }
    }

    async fn write_atomic(&self, key: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        // WebDAV PUT is an idempotent server-side overwrite; for the
        // single-file case it's atomic on every reasonable server (the
        // half-written intermediate state is never exposed via GET).
        // Tmp+MOVE would buy us cross-file atomicity which we don't
        // need — the manifest/keyring are the only mutable files and
        // they're single-blob.
        self.ensure_parent_dirs(key).await?;
        let url = self.paths.url_of(key);
        let client = self.client()?;
        let res = client
            .put(&url)
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(transport_err)?;
        if !res.status().is_success() {
            return Err(http_err("PUT", &url, res.status()));
        }
        self.stat(key).await?.ok_or(Error::Corrupt)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        self.ensure_parent_dirs(to).await?;
        let from_url = self.paths.url_of(from);
        let to_url = self.paths.url_of(to);
        let client = self.client()?;
        let res = client
            .request(Method::from_bytes(b"MOVE").unwrap(), &from_url)
            .header("Destination", &to_url)
            .header("Overwrite", "T")
            .send()
            .await
            .map_err(transport_err)?;
        if !res.status().is_success() {
            return Err(http_err("MOVE", &from_url, res.status()));
        }
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<(), Error> {
        let url = self.paths.url_of(key);
        let client = self.client()?;
        let res = client.delete(&url).send().await.map_err(transport_err)?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(()),
            s if s.is_success() => Ok(()),
            other => Err(http_err("DELETE", &url, other)),
        }
    }

    async fn mkdir_p(&self, key: &str) -> Result<(), Error> {
        // Walk the key one path component at a time and MKCOL each.
        // Idempotent: 405/409 mean "already a collection", which is
        // what we want.
        let key = key.trim_matches('/');
        self.ensure_root_path_dirs().await?;
        // Ensure the repo root collection exists before creating
        // descendants like `snapshots/` or `events/YYYY-MM/`.
        self.mkcol_one(&self.paths.repo_root_url()).await?;
        if key.is_empty() {
            return Ok(());
        }
        let mut acc = String::new();
        for part in key.split('/') {
            if part.is_empty() {
                continue;
            }
            if !acc.is_empty() {
                acc.push('/');
            }
            acc.push_str(part);
            let url = self.paths.url_of(&acc);
            self.mkcol_one(&url).await?;
        }
        Ok(())
    }

    async fn delete_repo_root_dir(&self) -> Result<(), Error> {
        let url = self.paths.repo_root_url();
        let client = self.client()?;
        let res = client.delete(&url).send().await.map_err(transport_err)?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(()),
            s if s.is_success() => Ok(()),
            StatusCode::METHOD_NOT_ALLOWED => {
                // Some WebDAV servers (e.g. SeaweedFS behind certain
                // proxies) forbid deleting a collection directly but do
                // allow deleting files inside it. Fallback to content wipe.
                let mut listed = self.list("", true).await?;
                listed.sort_by_key(|m| std::cmp::Reverse(m.path.len()));
                for entry in listed {
                    let u = self.paths.url_of(&entry.path);
                    let rr = client.delete(&u).send().await.map_err(transport_err)?;
                    if rr.status() == StatusCode::NOT_FOUND || rr.status().is_success() {
                        continue;
                    }
                    return Err(http_err("DELETE", &u, rr.status()));
                }

                // When the repo currently contains only directories (no
                // files), `list()` returns nothing. Explicitly clear known
                // top-level entries as a best-effort pass.
                for file in ["manifest.json", "keyring.json"] {
                    let u = self.paths.url_of(file);
                    let rr = client.delete(&u).send().await.map_err(transport_err)?;
                    if rr.status() == StatusCode::NOT_FOUND || rr.status().is_success() {
                        continue;
                    }
                }
                for dir in ["events", "snapshots", "trash", "devices", "locks"] {
                    let u = self.paths.url_of(dir);
                    let rr = client.delete(&u).send().await.map_err(transport_err)?;
                    if rr.status() == StatusCode::NOT_FOUND || rr.status().is_success() {
                        continue;
                    }
                    let u_slash = format!("{u}/");
                    let rr2 = client
                        .delete(&u_slash)
                        .send()
                        .await
                        .map_err(transport_err)?;
                    if rr2.status() == StatusCode::NOT_FOUND || rr2.status().is_success() {
                        continue;
                    }
                }

                // Try deleting the root once more; if still forbidden, we've
                // already wiped what the backend lets us wipe.
                let _ = client.delete(&url).send().await;
                Ok(())
            }
            other => Err(http_err("DELETE", &url, other)),
        }
    }
}

impl WebDavAdapter {
    async fn ensure_parent_dirs(&self, key: &str) -> Result<(), Error> {
        // Drop the final segment (file name) and MKCOL everything above.
        let trimmed = key.trim_matches('/');
        let parent = match trimmed.rsplit_once('/') {
            Some((p, _)) => p,
            None => return Ok(()),
        };
        self.mkdir_p(parent).await
    }
}

/// Parse a PROPFIND multistatus response into a flat list of files
/// (collections are skipped). `server_prefix` is the path part of the
/// repo root URL — used to strip the leading prefix from `href` values
/// so callers see repo-relative paths.
fn parse_propfind(xml: &str, server_prefix: &str) -> Result<Vec<ObjectMeta>, Error> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut out = Vec::new();
    // Per-response state.
    let mut cur_href = String::new();
    let mut cur_size: Option<u64> = None;
    let mut cur_mtime_ms: Option<i64> = None;
    let mut cur_is_collection = false;
    // What we are currently reading text into.
    let mut tag_stack: Vec<String> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref()).to_string();
                tag_stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                let name = local_name(e.name().as_ref()).to_string();
                if name == "collection" {
                    cur_is_collection = true;
                }
                // <getcontentlength/> empty: leave size at None.
                // No state change needed for other self-closing tags.
                let _ = name;
            }
            Ok(Event::Text(t)) => {
                let text = t
                    .xml_content(XmlVersion::Implicit1_0)
                    .map_err(|e| {
                        Error::Io(std::io::Error::other(format!("propfind text decode: {e}")))
                    })?
                    .to_string();
                let tag = tag_stack.last().cloned().unwrap_or_default();
                match tag.as_str() {
                    "href" => cur_href = text,
                    "getcontentlength" => {
                        cur_size = text.trim().parse::<u64>().ok();
                    }
                    "getlastmodified" => {
                        cur_mtime_ms = parse_http_date_ms(&text);
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.name().as_ref()).to_string();
                tag_stack.pop();
                if name == "response" {
                    if !cur_is_collection && !cur_href.is_empty() {
                        let rel = href_to_rel(&cur_href, server_prefix);
                        if !rel.is_empty() {
                            validate_repo_relative_path(&rel)?;
                            out.push(ObjectMeta {
                                path: rel,
                                size: cur_size.unwrap_or(0),
                                modified_unix_ms: cur_mtime_ms.unwrap_or(0),
                            });
                        }
                    }
                    cur_href.clear();
                    cur_size = None;
                    cur_mtime_ms = None;
                    cur_is_collection = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(Error::Io(std::io::Error::other(format!(
                    "propfind parse: {e}"
                ))));
            }
            _ => {}
        }
    }
    Ok(out)
}

fn local_name(qualified: &[u8]) -> &str {
    let qualified = std::str::from_utf8(qualified).unwrap_or("");
    match qualified.rsplit_once(':') {
        Some((_, local)) => local,
        None => qualified,
    }
}

/// Convert a PROPFIND `href` to a repo-relative path. Handles
/// percent-encoded hrefs and both absolute-URL and absolute-path forms.
fn href_to_rel(href: &str, server_prefix: &str) -> String {
    let decoded = percent_decode(href);
    // Strip scheme+host if the server returned a full URL.
    let path_only = match decoded.find("://") {
        Some(scheme_end) => {
            let after_scheme = &decoded[scheme_end + 3..];
            let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
            &after_scheme[path_start..]
        }
        None => decoded.as_str(),
    };
    let path_norm = if path_only.starts_with('/') {
        path_only.to_string()
    } else {
        format!("/{path_only}")
    };
    let prefix_norm = if server_prefix.starts_with('/') {
        server_prefix.to_string()
    } else {
        format!("/{server_prefix}")
    };

    if let Some(idx) = path_norm.find(&prefix_norm) {
        return path_norm[idx + prefix_norm.len()..]
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string();
    }

    // Some servers reshape/redirect base paths but keep the repo marker.
    // Fall back to matching from `<repo_dir>/` so listing still works.
    let repo_anchor = format!("/{REPO_DIR}/");
    if let Some(idx) = path_norm.find(&repo_anchor) {
        return path_norm[idx + repo_anchor.len()..]
            .trim_start_matches('/')
            .trim_end_matches('/')
            .to_string();
    }

    String::new()
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// RFC 7231 IMF-fixdate parser (the format WebDAV uses for getlastmodified).
/// Returns milliseconds since the Unix epoch.
fn parse_http_date_ms(s: &str) -> Option<i64> {
    // Format: "Sun, 06 Nov 1994 08:49:37 GMT"
    let s = s.trim();
    let mut parts = s.split_ascii_whitespace();
    let _weekday = parts.next()?;
    let day: u32 = parts.next()?.trim_end_matches(',').parse().ok()?;
    let month = month_index(parts.next()?)?;
    let year: i32 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let (h, m, sec) = {
        let mut t = time.split(':');
        let h: u32 = t.next()?.parse().ok()?;
        let m: u32 = t.next()?.parse().ok()?;
        let s: u32 = t.next()?.parse().ok()?;
        (h, m, s)
    };
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + (h as i64) * 3600 + (m as i64) * 60 + (sec as i64);
    Some(secs * 1000)
}

fn month_index(s: &str) -> Option<u32> {
    Some(match s {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

/// Howard Hinnant's `days_from_civil` — same algorithm we use in
/// repo.rs for the inverse direction.
fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era as i64) * 146_097 + (doe as i64) - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_of_joins_base_root_repo_and_key() {
        let p = WebDavPaths::new(
            "https://dav.example.com/remote.php/dav/files/alice",
            "zeroterm",
        );
        assert_eq!(
            p.url_of("manifest.json"),
            "https://dav.example.com/remote.php/dav/files/alice/zeroterm/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn url_of_handles_empty_root_path() {
        let p = WebDavPaths::new("https://dav.example.com/files/alice/", "");
        assert_eq!(
            p.url_of("events/2024-03/ev-foo.json"),
            "https://dav.example.com/files/alice/zeroterm-sync/events/2024-03/ev-foo.json"
        );
    }

    #[test]
    fn url_of_strips_trailing_base_slashes() {
        let p = WebDavPaths::new("https://dav.example.com/dav///", "zeroterm///");
        assert_eq!(
            p.url_of("manifest.json"),
            "https://dav.example.com/dav/zeroterm/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn url_of_strips_leading_key_slash() {
        let p = WebDavPaths::new("https://dav.example.com", "z");
        assert_eq!(
            p.url_of("/manifest.json"),
            "https://dav.example.com/z/zeroterm-sync/manifest.json"
        );
    }

    #[test]
    fn server_path_prefix_drops_scheme_and_host() {
        let p = WebDavPaths::new(
            "https://dav.example.com/remote.php/dav/files/alice",
            "zeroterm",
        );
        assert_eq!(
            p.server_path_prefix(),
            "/remote.php/dav/files/alice/zeroterm/zeroterm-sync/"
        );
    }

    #[test]
    fn server_path_prefix_handles_empty_root_path() {
        let p = WebDavPaths::new("https://dav.example.com/files/alice", "");
        assert_eq!(p.server_path_prefix(), "/files/alice/zeroterm-sync/");
    }

    #[test]
    fn href_to_rel_strips_server_prefix() {
        let server_prefix = "/dav/zeroterm/zeroterm-sync/";
        assert_eq!(
            href_to_rel(
                "/dav/zeroterm/zeroterm-sync/events/2024-03/ev-foo.json",
                server_prefix
            ),
            "events/2024-03/ev-foo.json"
        );
    }

    #[test]
    fn propfind_rejects_traversal_paths() {
        let xml = r#"<multistatus xmlns="DAV:"><response><href>/dav/zeroterm/zeroterm-sync/events/../manifest.json</href><propstat><prop><getcontentlength>1</getcontentlength></prop></propstat></response></multistatus>"#;
        assert!(parse_propfind(xml, "/dav/zeroterm/zeroterm-sync/").is_err());
    }

    #[test]
    fn href_to_rel_handles_full_url() {
        let server_prefix = "/dav/zeroterm/zeroterm-sync/";
        assert_eq!(
            href_to_rel(
                "https://dav.example.com/dav/zeroterm/zeroterm-sync/manifest.json",
                server_prefix
            ),
            "manifest.json"
        );
    }

    #[test]
    fn href_to_rel_percent_decodes() {
        let server_prefix = "/dav/zeroterm/zeroterm-sync/";
        assert_eq!(
            href_to_rel(
                "/dav/zeroterm/zeroterm-sync/events/2024-03/ev-with%20space.json",
                server_prefix
            ),
            "events/2024-03/ev-with space.json"
        );
    }

    #[test]
    fn href_to_rel_returns_empty_when_no_match() {
        assert_eq!(href_to_rel("/totally/different/path.json", "/dav/x/"), "");
    }

    #[test]
    fn href_to_rel_handles_path_without_leading_slash() {
        let server_prefix = "/dav/zeroterm/zeroterm-sync/";
        assert_eq!(
            href_to_rel(
                "dav/zeroterm/zeroterm-sync/events/2024-03/ev-foo.ztlog",
                server_prefix
            ),
            "events/2024-03/ev-foo.ztlog"
        );
    }

    #[test]
    fn href_to_rel_falls_back_to_repo_anchor() {
        // Prefix mismatch, but path still contains `/zeroterm-sync/`.
        assert_eq!(
            href_to_rel(
                "/redirected/base/zeroterm-sync/events/2024-03/ev-2.ztlog",
                "/unexpected/prefix/"
            ),
            "events/2024-03/ev-2.ztlog"
        );
    }

    #[test]
    fn parse_propfind_extracts_files_skips_collections() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/dav/zeroterm/zeroterm-sync/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/zeroterm/zeroterm-sync/manifest.json</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>120</d:getcontentlength>
        <d:getlastmodified>Sun, 06 Nov 1994 08:49:37 GMT</d:getlastmodified>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/dav/zeroterm/zeroterm-sync/events/2024-03/ev-1.json</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>42</d:getcontentlength>
        <d:resourcetype/>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>"#;
        let prefix = "/dav/zeroterm/zeroterm-sync/";
        let entries = parse_propfind(xml, prefix).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "manifest.json");
        assert_eq!(entries[0].size, 120);
        assert!(entries[0].modified_unix_ms > 0);
        assert_eq!(entries[1].path, "events/2024-03/ev-1.json");
        assert_eq!(entries[1].size, 42);
    }

    #[test]
    fn parse_http_date_ms_rfc7231_sample() {
        // "Sun, 06 Nov 1994 08:49:37 GMT" — the classic RFC sample —
        // equals 784111777 seconds since Unix epoch.
        let got = parse_http_date_ms("Sun, 06 Nov 1994 08:49:37 GMT").unwrap();
        assert_eq!(got, 784_111_777_000);
    }
}
