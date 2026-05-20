use async_trait::async_trait;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use aws_sdk_s3::config::Credentials;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::fs;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("not found")]
    NotFound,
    #[error("conflict")]
    Conflict,
    #[error("unauthorized")]
    Unauthorized,
    #[error("timeout")]
    Timeout,
    #[error("transport: {0}")]
    Transport(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default)]
pub struct PutOptions<'a> {
    pub if_match_etag: Option<&'a str>,
    pub content_type: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectMeta {
    pub key: String,
    pub etag: Option<String>,
    pub size: u64,
    pub modified_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncManifest {
    pub schema_version: u32,
    pub vault_id: String,
    pub head_cursor: String,
    pub key_version: u32,
    pub updated_at: i64,
}

impl SyncManifest {
    pub fn new(vault_id: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            vault_id: vault_id.into(),
            head_cursor: String::new(),
            key_version: 1,
            updated_at: now_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedEvent {
    pub event_id: String,
    pub device_id: String,
    pub logical_clock: u64,
    pub object_type: String,
    pub object_id: String,
    pub op: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub created_at: i64,
    pub key_version: u32,
}

#[async_trait]
pub trait SyncAdapter: Send + Sync {
    fn kind(&self) -> &'static str;
    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, SyncError>;
    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, SyncError>;
    async fn list_prefix(&self, prefix: &str) -> Result<Vec<ObjectMeta>, SyncError>;
    async fn put(&self, key: &str, bytes: &[u8], opts: PutOptions<'_>) -> Result<ObjectMeta, SyncError>;
    async fn delete(&self, key: &str) -> Result<(), SyncError>;
    async fn try_lock(&self, _name: &str, _ttl_secs: u32) -> Result<Option<String>, SyncError> {
        Ok(None)
    }
    async fn unlock(&self, _name: &str, _token: &str) -> Result<(), SyncError> {
        Ok(())
    }
}

pub struct FsAdapter {
    root: PathBuf,
}

pub struct WebDavAdapter {
    base_url: String,
    root_path: String,
    client: reqwest::Client,
}

impl WebDavAdapter {
    pub fn new(base_url: impl Into<String>, root_path: impl Into<String>, username: &str, password: &str) -> Result<Self, SyncError> {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Authorization",
            HeaderValue::from_str(&format!(
                "Basic {}",
                base64_simple::encode(format!("{username}:{password}").as_bytes())
            ))
            .map_err(|e| SyncError::Protocol(format!("invalid auth header: {e}")))?,
        );
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .map_err(|e| SyncError::Transport(format!("build reqwest client failed: {e}")))?;
        Ok(Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            root_path: root_path.into().trim_matches('/').to_string(),
            client,
        })
    }

    fn url_of(&self, key: &str) -> String {
        format!("{}/{}/{}", self.base_url, self.root_path, key.trim_start_matches('/'))
    }

    async fn mkcol_all(&self, key: &str) -> Result<(), SyncError> {
        let mut path = String::new();
        for part in key.split('/') {
            if part.is_empty() { continue; }
            if !path.is_empty() { path.push('/'); }
            path.push_str(part);
            let url = format!("{}/{}/{}", self.base_url, self.root_path, path);
            let r = self.client.request(Method::from_bytes(b"MKCOL").unwrap(), &url).send().await
                .map_err(|e| SyncError::Transport(e.to_string()))?;
            if r.status() == StatusCode::METHOD_NOT_ALLOWED || r.status().is_success() || r.status() == StatusCode::CONFLICT {
                continue;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl SyncAdapter for WebDavAdapter {
    fn kind(&self) -> &'static str {
        "webdav"
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, SyncError> {
        let r = self.client.get(self.url_of(key)).send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        if r.status() == StatusCode::NOT_FOUND { return Ok(None); }
        if !r.status().is_success() { return Err(SyncError::Transport(format!("webdav GET {} failed: {}", key, r.status()))); }
        let b = r.bytes().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(Some(b.to_vec()))
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, SyncError> {
        let r = self.client.head(self.url_of(key)).send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        if r.status() == StatusCode::NOT_FOUND { return Ok(None); }
        if !r.status().is_success() { return Err(SyncError::Transport(format!("webdav HEAD {} failed: {}", key, r.status()))); }
        let size = r
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let etag = r.headers().get("etag").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        Ok(Some(ObjectMeta {
            key: key.to_string(),
            etag,
            size,
            modified_unix_ms: now_ms(),
        }))
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<ObjectMeta>, SyncError> {
        let url = self.url_of(prefix);
        let body = r#"<?xml version=\"1.0\" encoding=\"utf-8\" ?><propfind xmlns=\"DAV:\"><prop><getetag/><getcontentlength/></prop></propfind>"#;
        let r = self
            .client
            .request(Method::from_bytes(b"PROPFIND").unwrap(), &url)
            .header("Depth", "infinity")
            .body(body)
            .send()
            .await
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        if !r.status().is_success() {
            if r.status() == StatusCode::NOT_FOUND { return Ok(Vec::new()); }
            return Err(SyncError::Transport(format!("webdav PROPFIND {} failed: {}", prefix, r.status())));
        }
        let xml = r.text().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        let mut out = Vec::new();
        let mut reader = Reader::from_str(&xml);
        reader.config_mut().trim_text(true);
        let mut in_href = false;
        let mut href = String::new();
        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) => {
                    if e.name().as_ref().ends_with(b"href") { in_href = true; }
                }
                Ok(Event::Text(t)) => {
                    if in_href { href = t.xml_content().map_err(|e| SyncError::Protocol(e.to_string()))?.to_string(); }
                }
                Ok(Event::End(e)) => {
                    if e.name().as_ref().ends_with(b"href") {
                        in_href = false;
                        if let Some(k) = href.split(&format!("/{}/", self.root_path)).nth(1) {
                            if !k.is_empty() && !k.ends_with('/') {
                                out.push(ObjectMeta {
                                    key: k.to_string(),
                                    etag: None,
                                    size: 0,
                                    modified_unix_ms: now_ms(),
                                });
                            }
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => return Err(SyncError::Protocol(format!("parse PROPFIND xml failed: {e}"))),
                _ => {}
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    async fn put(&self, key: &str, bytes: &[u8], opts: PutOptions<'_>) -> Result<ObjectMeta, SyncError> {
        if let Some(parent) = Path::new(key).parent().and_then(|p| p.to_str()) {
            self.mkcol_all(parent).await?;
        }
        let mut req = self.client.put(self.url_of(key));
        if let Some(etag) = opts.if_match_etag {
            req = req.header("If-Match", etag);
        }
        if let Some(ct) = opts.content_type {
            req = req.header("Content-Type", ct);
        }
        let r = req.body(bytes.to_vec()).send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        if r.status() == StatusCode::PRECONDITION_FAILED { return Err(SyncError::Conflict); }
        if !r.status().is_success() {
            return Err(SyncError::Transport(format!("webdav PUT {} failed: {}", key, r.status())));
        }
        self.head(key).await?.ok_or_else(|| SyncError::Protocol("put succeeded but head missing".to_string()))
    }

    async fn delete(&self, key: &str) -> Result<(), SyncError> {
        let r = self.client.delete(self.url_of(key)).send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        if r.status() == StatusCode::NOT_FOUND || r.status().is_success() {
            return Ok(());
        }
        Err(SyncError::Transport(format!("webdav DELETE {} failed: {}", key, r.status())))
    }
}

pub struct S3Adapter {
    client: S3Client,
    bucket: String,
    prefix: String,
}

#[derive(Debug, Clone, Default)]
pub struct S3Options {
    pub endpoint: Option<String>,
    pub force_path_style: bool,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
}

impl S3Adapter {
    pub async fn new(region: &str, bucket: impl Into<String>, prefix: impl Into<String>) -> Result<Self, SyncError> {
        Self::new_with_options(region, bucket, prefix, S3Options::default()).await
    }

    pub async fn new_with_options(
        region: &str,
        bucket: impl Into<String>,
        prefix: impl Into<String>,
        options: S3Options,
    ) -> Result<Self, SyncError> {
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(region.to_string()))
            .load()
            .await;

        let mut builder = aws_sdk_s3::config::Builder::from(&cfg);
        if let Some(ep) = options.endpoint.as_deref() {
            builder = builder.endpoint_url(ep.to_string());
        }
        if options.force_path_style {
            builder = builder.force_path_style(true);
        }
        if let (Some(ak), Some(sk)) = (
            options.access_key_id.as_deref(),
            options.secret_access_key.as_deref(),
        ) {
            let creds = Credentials::new(
                ak,
                sk,
                options.session_token.clone(),
                None,
                "zeroterm-sync",
            );
            builder = builder.credentials_provider(creds);
        }
        let s3_cfg = builder.build();
        Ok(Self {
            client: S3Client::from_conf(s3_cfg),
            bucket: bucket.into(),
            prefix: prefix.into().trim_matches('/').to_string(),
        })
    }

    fn key_of(&self, key: &str) -> String {
        if self.prefix.is_empty() {
            key.trim_start_matches('/').to_string()
        } else {
            format!("{}/{}", self.prefix, key.trim_start_matches('/'))
        }
    }
}

#[async_trait]
impl SyncAdapter for S3Adapter {
    fn kind(&self) -> &'static str {
        "s3"
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, SyncError> {
        let k = self.key_of(key);
        let r = self.client.get_object().bucket(&self.bucket).key(k).send().await;
        let out = match r {
            Ok(v) => v,
            Err(e) => {
                let s = e.to_string();
                if s.contains("NoSuchKey") || s.contains("NotFound") { return Ok(None); }
                return Err(SyncError::Transport(s));
            }
        };
        let b = out.body.collect().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(Some(b.into_bytes().to_vec()))
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, SyncError> {
        let k = self.key_of(key);
        let r = self.client.head_object().bucket(&self.bucket).key(&k).send().await;
        let out = match r {
            Ok(v) => v,
            Err(e) => {
                let s = e.to_string();
                if s.contains("NotFound") || s.contains("NoSuchKey") { return Ok(None); }
                return Err(SyncError::Transport(s));
            }
        };
        Ok(Some(ObjectMeta {
            key: key.to_string(),
            etag: out.e_tag,
            size: out.content_length.unwrap_or_default().max(0) as u64,
            modified_unix_ms: now_ms(),
        }))
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<ObjectMeta>, SyncError> {
        let p = self.key_of(prefix);
        let out = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(p)
            .send()
            .await
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        let mut v = Vec::new();
        for obj in out.contents() {
            if let Some(k) = obj.key() {
                let short = if self.prefix.is_empty() { k.to_string() } else { k.trim_start_matches(&(self.prefix.clone() + "/")).to_string() };
                v.push(ObjectMeta {
                    key: short,
                    etag: obj.e_tag().map(|s| s.to_string()),
                    size: obj.size().unwrap_or_default().max(0) as u64,
                    modified_unix_ms: now_ms(),
                });
            }
        }
        v.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(v)
    }

    async fn put(&self, key: &str, bytes: &[u8], opts: PutOptions<'_>) -> Result<ObjectMeta, SyncError> {
        if let Some(expect) = opts.if_match_etag {
            let head = self.head(key).await?;
            let current = head.as_ref().and_then(|m| m.etag.as_deref()).unwrap_or("");
            if current != expect {
                return Err(SyncError::Conflict);
            }
        }
        let k = self.key_of(key);
        let mut req = self
            .client
            .put_object()
            .bucket(&self.bucket)
            .key(k)
            .body(ByteStream::from(bytes.to_vec()));
        if let Some(ct) = opts.content_type {
            req = req.content_type(ct);
        }
        req.send().await.map_err(|e| SyncError::Transport(e.to_string()))?;
        self.head(key).await?.ok_or_else(|| SyncError::Protocol("put succeeded but head missing".to_string()))
    }

    async fn delete(&self, key: &str) -> Result<(), SyncError> {
        let k = self.key_of(key);
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(k)
            .send()
            .await
            .map_err(|e| SyncError::Transport(e.to_string()))?;
        Ok(())
    }
}

impl FsAdapter {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_of(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }

    async fn ensure_parent(path: &Path) -> Result<(), SyncError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl SyncAdapter for FsAdapter {
    fn kind(&self) -> &'static str {
        "filesystem"
    }

    async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, SyncError> {
        let p = self.path_of(key);
        match fs::read(p).await {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(SyncError::Io(e)),
        }
    }

    async fn head(&self, key: &str) -> Result<Option<ObjectMeta>, SyncError> {
        let p = self.path_of(key);
        let meta = match fs::metadata(&p).await {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(SyncError::Io(e)),
        };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(now_ms);
        Ok(Some(ObjectMeta {
            key: key.to_string(),
            etag: Some(format!("{}:{}", meta.len(), modified)),
            size: meta.len(),
            modified_unix_ms: modified,
        }))
    }

    async fn list_prefix(&self, prefix: &str) -> Result<Vec<ObjectMeta>, SyncError> {
        let base = self.path_of(prefix);
        let mut out = Vec::new();
        if fs::metadata(&base).await.is_err() {
            return Ok(out);
        }

        let mut stack = vec![base.clone()];
        while let Some(dir) = stack.pop() {
            let mut rd = fs::read_dir(&dir).await?;
            while let Some(ent) = rd.next_entry().await? {
                let p = ent.path();
                let m = ent.metadata().await?;
                if m.is_dir() {
                    stack.push(p);
                    continue;
                }
                let rel = p
                    .strip_prefix(&self.root)
                    .map_err(|e| SyncError::Protocol(format!("strip_prefix failed: {e}")))?
                    .to_string_lossy()
                    .replace('\\', "/");
                let modified = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or_else(now_ms);
                out.push(ObjectMeta {
                    key: rel,
                    etag: Some(format!("{}:{}", m.len(), modified)),
                    size: m.len(),
                    modified_unix_ms: modified,
                });
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(out)
    }

    async fn put(&self, key: &str, bytes: &[u8], opts: PutOptions<'_>) -> Result<ObjectMeta, SyncError> {
        let p = self.path_of(key);
        Self::ensure_parent(&p).await?;

        if let Some(expect) = opts.if_match_etag {
            let current = self.head(key).await?;
            let current_tag = current.as_ref().and_then(|m| m.etag.as_deref()).unwrap_or("");
            if current_tag != expect {
                return Err(SyncError::Conflict);
            }
        }

        let mut f = fs::File::create(&p).await?;
        f.write_all(bytes).await?;
        f.flush().await?;

        self.head(key).await?.ok_or(SyncError::Protocol("put succeeded but missing head".to_string()))
    }

    async fn delete(&self, key: &str) -> Result<(), SyncError> {
        let p = self.path_of(key);
        match fs::remove_file(p).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SyncError::Io(e)),
        }
    }
}

pub struct SyncEngine<A: SyncAdapter> {
    pub adapter: A,
}

impl<A: SyncAdapter> SyncEngine<A> {
    pub fn new(adapter: A) -> Self {
        Self { adapter }
    }

    pub async fn load_manifest(&self) -> Result<Option<(SyncManifest, Option<String>)>, SyncError> {
        let key = "manifest.json";
        let bytes = match self.adapter.get(key).await? {
            Some(b) => b,
            None => return Ok(None),
        };
        let m: SyncManifest = serde_json::from_slice(&bytes)?;
        let etag = self.adapter.head(key).await?.and_then(|h| h.etag);
        Ok(Some((m, etag)))
    }

    pub async fn save_manifest_cas(
        &self,
        manifest: &SyncManifest,
        if_match_etag: Option<&str>,
    ) -> Result<ObjectMeta, SyncError> {
        let bytes = serde_json::to_vec_pretty(manifest)?;
        self.adapter
            .put(
                "manifest.json",
                &bytes,
                PutOptions {
                    if_match_etag,
                    content_type: Some("application/json"),
                },
            )
            .await
    }

    pub async fn push_events(&self, events: &[EncryptedEvent]) -> Result<(), SyncError> {
        for ev in events {
            let key = event_key(ev);
            let body = serde_json::to_vec(ev)?;
            let _ = self
                .adapter
                .put(&key, &body, PutOptions::default())
                .await?;
        }
        Ok(())
    }

    pub async fn pull_events_under_prefix(&self, prefix: &str) -> Result<Vec<EncryptedEvent>, SyncError> {
        let list = self.adapter.list_prefix(prefix).await?;
        let mut out = Vec::new();
        for meta in list {
            if !meta.key.ends_with(".bin") {
                continue;
            }
            let Some(bytes) = self.adapter.get(&meta.key).await? else {
                continue;
            };
            let ev: EncryptedEvent = serde_json::from_slice(&bytes)?;
            out.push(ev);
        }
        out.sort_by(|a, b| a.event_id.cmp(&b.event_id));
        Ok(out)
    }
}

pub fn event_key(ev: &EncryptedEvent) -> String {
    format!("events/{}/{}.bin", day_bucket(ev.created_at), ev.event_id)
}

fn day_bucket(unix_ms: i64) -> String {
    let days = unix_ms / 86_400_000;
    format!("d{:06}", days.max(0))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

mod base64_simple {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    pub fn encode(input: &[u8]) -> String {
        let mut out = String::new();
        let mut i = 0;
        while i < input.len() {
            let b0 = input[i];
            let b1 = if i + 1 < input.len() { input[i + 1] } else { 0 };
            let b2 = if i + 2 < input.len() { input[i + 2] } else { 0 };
            let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | b2 as u32;
            out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
            out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
            if i + 1 < input.len() {
                out.push(TABLE[((n >> 6) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
            if i + 2 < input.len() {
                out.push(TABLE[(n & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
            i += 3;
        }
        out
    }
}

pub fn new_event(
    device_id: impl Into<String>,
    logical_clock: u64,
    object_type: impl Into<String>,
    object_id: impl Into<String>,
    op: impl Into<String>,
    nonce_b64: impl Into<String>,
    ciphertext_b64: impl Into<String>,
    key_version: u32,
) -> EncryptedEvent {
    EncryptedEvent {
        event_id: uuid::Uuid::now_v7().to_string(),
        device_id: device_id.into(),
        logical_clock,
        object_type: object_type.into(),
        object_id: object_id.into(),
        op: op.into(),
        nonce_b64: nonce_b64.into(),
        ciphertext_b64: ciphertext_b64.into(),
        created_at: now_ms(),
        key_version,
    }
}
