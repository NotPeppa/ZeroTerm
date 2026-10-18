//! ZeroTerm native SSH entry (zeroterm-terminal RFC-006). Tokens and SSH tickets live only in memory.
use crate::{App, Host, HostAuth};
use base64::{engine::general_purpose::STANDARD_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};
use zeroterm_ssh::{
    AuthMethod, ConnectConfig, HostKeyPolicy, ManagedConnection, ManagedSession, SshError,
};

const KIND: &str = "bastion_profile";
const MAX_RESPONSE: usize = 1024 * 1024;

/// Connection metadata returned to clients; passwords, tokens and tickets are omitted.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BastionProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub server_id: String,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_host_key_sha256: String,
    /// Optional public CA PEM for a private TLS certificate authority.
    #[serde(default)]
    pub ca_pem: Option<String>,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_deserializing)]
    pub has_password: bool,
}

/// Configuration and optional login password share one encrypted Vault record.
#[derive(Serialize, Deserialize)]
struct StoredBastionProfile {
    #[serde(flatten)]
    profile: BastionProfile,
    #[serde(default)]
    password: String,
}
impl Drop for StoredBastionProfile {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// RFC-006 account. `label` is for display; `username` is the target account name.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BastionAccount {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub username: String,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub credential_kind: String,
    pub capabilities: Vec<String>,
}
impl BastionAccount {
    pub fn display_name(&self) -> &str {
        if self.label.trim().is_empty() {
            &self.username
        } else {
            &self.label
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BastionAsset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    pub accounts: Vec<BastionAccount>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BastionAssetGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BastionCatalog {
    pub assets: Vec<BastionAsset>,
    pub groups: Vec<BastionAssetGroup>,
}
#[derive(Deserialize)]
struct AssetPage {
    items: Vec<BastionAsset>,
    #[serde(default)]
    groups: Vec<BastionAssetGroup>,
    next_cursor: Option<String>,
}
/// `GET /api/v1/info` (RFC-006 §6). The top-level `protocol_version` belongs to the
/// browser family and is ignored; ZeroTerm reads only the `native` block.
#[derive(Deserialize)]
struct Info {
    server_id: String,
    #[serde(default)]
    production_ready: Option<bool>,
    #[serde(default)]
    recording: Option<Recording>,
    #[serde(default)]
    native: Option<Native>,
}
/// Absent when the server has no native SSH listener.
#[derive(Deserialize)]
struct Native {
    protocol_version: u32,
    minimum_client_protocol_version: u32,
    available: bool,
    gateway: Option<InfoGateway>,
    features: NativeFeatures,
}
/// SSH entry advertised by `/info`; trusted only because the response arrived
/// over the same verified HTTPS channel that later issues tickets.
#[derive(Deserialize)]
struct InfoGateway {
    #[allow(dead_code)]
    id: String,
    host: String,
    port: u16,
    public_key: String,
}
#[derive(Deserialize)]
struct NativeFeatures {
    #[serde(default)]
    shell: bool,
    #[serde(default)]
    exec: bool,
    #[serde(default)]
    sftp: bool,
}
#[derive(Deserialize)]
struct Recording {
    required: bool,
    format_version: u32,
    #[serde(default)]
    available: Option<bool>,
}
impl Info {
    fn validate(&self) -> Result<(), BastionError> {
        if self.production_ready.is_none() {
            return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
        }
        let native = self
            .native
            .as_ref()
            .ok_or_else(|| error("NATIVE_ENTRY_UNAVAILABLE"))?;
        if native.protocol_version != 1 || native.minimum_client_protocol_version > 1 {
            return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
        }
        if !self
            .recording
            .as_ref()
            .is_some_and(|r| r.required && r.format_version == 2)
        {
            return Err(error("RECORDING_REQUIRED"));
        }
        Ok(())
    }
    /// Validated native SSH entry used for fingerprint pinning.
    fn gateway(&self) -> Result<&InfoGateway, BastionError> {
        self.validate()?;
        self.native
            .as_ref()
            .and_then(|n| n.gateway.as_ref())
            .ok_or_else(|| error("CLIENT_PROTOCOL_UNSUPPORTED"))
    }
    fn supports(&self, capability: &str) -> bool {
        self.native.as_ref().is_some_and(|n| {
            n.available
                && match capability {
                    "shell" => {
                        n.features.shell
                            && self
                                .recording
                                .as_ref()
                                .is_some_and(|r| r.available != Some(false))
                    }
                    "exec" => n.features.exec,
                    "sftp" => n.features.sftp,
                    _ => false,
                }
        })
    }
}
#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    access_expires_at: DateTime<Utc>,
    /// Local time this response arrived. Expiry is the server's decision; locally only the lifetime
    /// the server granted (its `access_expires_at` minus its `Date`) is used, so a skewed client clock
    /// never rejects valid tokens.
    #[serde(skip, default = "Utc::now")]
    received_at: DateTime<Utc>,
    #[serde(skip)]
    lifetime: Option<chrono::Duration>,
}
impl Tokens {
    /// Refresh this long before the server-granted lifetime runs out.
    const MARGIN: i64 = 15;
    fn due(&self) -> bool {
        match self.lifetime {
            Some(lifetime) => Utc::now() >= self.received_at + lifetime - chrono::Duration::seconds(Self::MARGIN),
            // Without a server Date header fall back to the server's absolute expiry.
            None => self.access_expires_at <= Utc::now() + chrono::Duration::seconds(Self::MARGIN),
        }
    }
    fn expired(&self) -> bool {
        match self.lifetime {
            Some(lifetime) => Utc::now() >= self.received_at + lifetime,
            None => self.access_expires_at <= Utc::now(),
        }
    }
}
impl Drop for Tokens {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}
#[derive(Deserialize)]
struct Gateway {
    host: String,
    port: u16,
    username: String,
}
#[derive(Deserialize)]
struct Ticket {
    protocol_version: u32,
    ticket_id: String,
    ticket_secret: String,
    connection_id: String,
    gateway: Gateway,
    capabilities: Vec<String>,
    /// Required in the contract but only the gateway enforces it; a skewed local clock must not.
    #[allow(dead_code)]
    expires_at: DateTime<Utc>,
}
impl Drop for Ticket {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.ticket_secret.zeroize();
    }
}

/// Stable code and request ID are safe to display; response bodies and URLs are never logged.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code} (request_id: {request_id})")]
pub struct BastionError {
    pub code: String,
    #[serde(default)]
    pub request_id: String,
}
fn error(code: &str) -> BastionError {
    BastionError {
        code: code.into(),
        request_id: String::new(),
    }
}
fn local_error(e: impl std::fmt::Display) -> BastionError {
    // Internal errors can contain vault plaintext or HTTP headers; do not surface them.
    let _ = e;
    error("INTERNAL_ERROR")
}
fn validate_id(id: &str) -> Result<(), BastionError> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| error("INVALID_ARGUMENT"))
}
/// Accounts report `[]` while the native gateway is unavailable (RFC-006 §5).
fn validate_account_caps(caps: &[String]) -> Result<(), BastionError> {
    if caps.is_empty() {
        Ok(())
    } else {
        validate_caps(caps)
    }
}
fn validate_caps(caps: &[String]) -> Result<(), BastionError> {
    if caps.is_empty() || caps.len() > 3 {
        return Err(error("INVALID_ARGUMENT"));
    }
    if caps
        .iter()
        .any(|c| !matches!(c.as_str(), "shell" | "exec" | "sftp"))
    {
        return Err(error("UNKNOWN_CAPABILITY"));
    }
    if caps.iter().enumerate().any(|(i, c)| caps[..i].contains(c)) {
        return Err(error("INVALID_ARGUMENT"));
    }
    Ok(())
}
/// HTTPS origin only: no credentials, query, fragment or path. Returns the host.
fn validate_api_url(api_url: &str) -> Result<String, BastionError> {
    let url = Url::parse(api_url).map_err(|_| error("INVALID_ARGUMENT"))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(error("INVALID_ARGUMENT"));
    }
    url.host_str()
        .map(str::to_owned)
        .ok_or_else(|| error("INVALID_ARGUMENT"))
}
fn http_client(ca_pem: Option<&str>) -> Result<Client, BastionError> {
    let mut builder = Client::builder()
        .https_only(true)
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20));
    if let Some(pem) = ca_pem {
        builder = builder.add_root_certificate(
            reqwest::Certificate::from_pem(pem.as_bytes())
                .map_err(|_| error("INVALID_ARGUMENT"))?,
        );
    }
    if let Some(proxy) = zeroterm_ssh::current_http_proxy() {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|_| error("INVALID_ARGUMENT"))?);
    }
    builder.build().map_err(local_error)
}
impl BastionProfile {
    pub fn validate(&self) -> Result<(), BastionError> {
        validate_api_url(&self.api_url)?;
        if self.name.trim().is_empty()
            || self.server_id.is_empty()
            || self.ssh_port == 0
            || self.ssh_host.is_empty()
            || self
                .ssh_host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '@' | '[' | ']'))
        {
            return Err(error("INVALID_ARGUMENT"));
        }
        let fp = self
            .ssh_host_key_sha256
            .strip_prefix("SHA256:")
            .ok_or_else(|| error("INVALID_ARGUMENT"))?;
        if STANDARD_NO_PAD
            .decode(fp)
            .map_err(|_| error("INVALID_ARGUMENT"))?
            .len()
            != 32
        {
            return Err(error("INVALID_ARGUMENT"));
        }
        Ok(())
    }
}

struct Login {
    profile: BastionProfile,
    http: Client,
    // All token refreshes and API requests for this login are serialized. A refresh
    // response with an unknown outcome clears the login; never replay a refresh.
    tokens: AsyncMutex<Option<Tokens>>,
    cancelled: CancellationToken,
}
impl Login {
    /// `info` is the shared, unauthenticated discovery route; every other call uses the
    /// Bearer-only `/api/v1/native/` prefix (RFC-006 §3.1), never browser routes.
    fn url(&self, path: &str) -> String {
        let prefix = if path == "info" { "" } else { "native/" };
        format!(
            "{}/api/v1/{prefix}{path}",
            self.profile.api_url.trim_end_matches('/')
        )
    }
    async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
        token: Option<&str>,
    ) -> Result<serde_json::Value, BastionError> {
        let mut req = self.http.request(method, self.url(path));
        if let Some(body) = body {
            req = req.json(body);
        }
        if let Some(token) = token {
            req = req.bearer_auth(token);
        }
        let mut response = req.send().await.map_err(|_| error("API_UNREACHABLE"))?;
        let status = response.status();
        let server_date = response
            .headers()
            .get(reqwest::header::DATE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| DateTime::parse_from_rfc2822(v).ok())
            .map(|v| v.with_timezone(&Utc));
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| error("API_UNREACHABLE"))?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if !status.is_success() {
            let code = serde_json::from_slice::<serde_json::Value>(&bytes)
                .ok()
                .and_then(|v| v.get("error")?.get("code")?.as_str().map(str::to_owned))
                .filter(|s| s.len() <= 80 && s.bytes().all(|c| c.is_ascii_uppercase() || c == b'_'))
                .unwrap_or_else(|| format!("HTTP_{}", status.as_u16()));
            return Err(BastionError { code, request_id });
        }
        if bytes.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| error("CLIENT_PROTOCOL_UNSUPPORTED"))?;
        let token_response = matches!(path, "auth/login" | "auth/refresh");
        if let (true, Some(date), Some(object)) = (token_response, server_date, value.as_object_mut()) {
            object.insert(SERVER_DATE.into(), serde_json::json!(date.to_rfc3339()));
        }
        Ok(value)
    }
    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, BastionError> {
        let mut guard = self.tokens.lock().await;
        if self.cancelled.is_cancelled() {
            return Err(error("LOGIN_SESSION_REVOKED"));
        }
        let tokens = guard.as_ref().ok_or_else(|| error("UNAUTHENTICATED"))?;
        if tokens.due() {
            let refresh = self
                .raw(
                    Method::POST,
                    "auth/refresh",
                    Some(&serde_json::json!({"refresh_token":tokens.refresh_token})),
                    None,
                )
                .await;
            match refresh.and_then(decode_tokens) {
                Ok(tokens) => *guard = Some(tokens),
                Err(e) => {
                    *guard = None;
                    self.cancelled.cancel();
                    return Err(e);
                }
            }
        }
        let tokens = guard.as_ref().ok_or_else(|| error("UNAUTHENTICATED"))?;
        let result = self
            .raw(method, path, body, Some(&tokens.access_token))
            .await;
        if result.as_ref().err().is_some_and(|e| {
            matches!(
                e.code.as_str(),
                "UNAUTHENTICATED"
                    | "SESSION_EXPIRED"
                    | "ACCESS_TOKEN_EXPIRED"
                    | "LOGIN_SESSION_REVOKED"
                    | "USER_DISABLED"
            )
        }) {
            *guard = None;
            self.cancelled.cancel();
        }
        result
    }
}
/// Response key `raw` adds to login/refresh responses with the server's HTTP `Date`.
const SERVER_DATE: &str = "_server_date";
/// Token lifetime is measured on the server clock: `access_expires_at - Date`, applied from local receipt.
fn decode_tokens(mut value: serde_json::Value) -> Result<Tokens, BastionError> {
    let date = value
        .as_object_mut()
        .and_then(|o| o.remove(SERVER_DATE))
        .and_then(|v| v.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()))
        .map(|v| v.with_timezone(&Utc));
    let mut tokens: Tokens = decode(value)?;
    tokens.lifetime = date
        .map(|date| tokens.access_expires_at - date)
        .filter(|lifetime| *lifetime > chrono::Duration::zero());
    Ok(tokens)
}
fn decode<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T, BastionError> {
    serde_json::from_value(value).map_err(|_| error("CLIENT_PROTOCOL_UNSUPPORTED"))
}

#[derive(Default)]
pub struct BastionManager {
    logins: Mutex<HashMap<String, Arc<Login>>>,
    epoch: AtomicU64,
}
impl BastionManager {
    pub fn clear(&self) {
        let mut logins = self
            .logins
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        for (_, login) in logins.drain() {
            login.cancelled.cancel();
        }
    }
    fn login_for(&self, profile_id: &str) -> Result<Arc<Login>, BastionError> {
        self.logins
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(profile_id)
            .filter(|l| !l.cancelled.is_cancelled())
            .cloned()
            .ok_or_else(|| error("UNAUTHENTICATED"))
    }
    pub async fn login(
        &self,
        profile: BastionProfile,
        username: &str,
        password: &str,
        device_label: &str,
    ) -> Result<(), BastionError> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        profile.validate()?;
        let login = Arc::new(Login {
            profile: profile.clone(),
            http: http_client(profile.ca_pem.as_deref())?,
            tokens: AsyncMutex::new(None),
            cancelled: CancellationToken::new(),
        });
        self.discover(&login).await?;
        let tokens = decode_tokens(login.raw(Method::POST, "auth/login", Some(&serde_json::json!({"username":username,"password":password,"device_label":device_label})), None).await?)?;
        if tokens.access_token.is_empty() || tokens.refresh_token.is_empty() {
            return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
        }
        *login.tokens.lock().await = Some(tokens);
        let mut logins = self
            .logins
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.epoch.load(Ordering::SeqCst) != epoch {
            login.cancelled.cancel();
            return Err(error("LOGIN_SESSION_REVOKED"));
        }
        if let Some(old) = logins.insert(profile.id.clone(), login) {
            old.cancelled.cancel();
        }
        Ok(())
    }
    /// Reads `/info` over strictly verified HTTPS and returns an unsaved profile
    /// with server_id, SSH entry and host-key fingerprint filled in. The caller
    /// shows these to the user for confirmation before saving; saved values are
    /// then pinned and any later change is rejected (`SERVER_ID_CHANGED`, host key).
    pub async fn probe(
        &self,
        name: &str,
        api_url: &str,
        ca_pem: Option<String>,
    ) -> Result<BastionProfile, BastionError> {
        let host = validate_api_url(api_url.trim())?;
        let api_url = api_url.trim().trim_end_matches('/').to_owned();
        let ca_pem = ca_pem.filter(|pem| !pem.trim().is_empty());
        let login = Login {
            profile: BastionProfile {
                id: String::new(),
                name: String::new(),
                api_url: api_url.clone(),
                server_id: String::new(),
                ssh_host: String::new(),
                ssh_port: 0,
                ssh_host_key_sha256: String::new(),
                ca_pem: ca_pem.clone(),
                username: String::new(),
                has_password: false,
            },
            http: http_client(ca_pem.as_deref())?,
            tokens: AsyncMutex::new(None),
            cancelled: CancellationToken::new(),
        };
        let info: Info = decode(login.raw(Method::GET, "info", None, None).await?)?;
        let gateway = info.gateway()?;
        let profile = BastionProfile {
            id: String::new(),
            name: Some(name.trim())
                .filter(|n| !n.is_empty())
                .unwrap_or(&host)
                .to_owned(),
            api_url,
            server_id: info.server_id.clone(),
            ssh_host: gateway.host.clone(),
            ssh_port: gateway.port,
            ssh_host_key_sha256: zeroterm_ssh::openssh_fingerprint(&gateway.public_key)
                .ok_or_else(|| error("CLIENT_PROTOCOL_UNSUPPORTED"))?,
            ca_pem,
            username: String::new(),
            has_password: false,
        };
        profile.validate()?;
        Ok(profile)
    }
    fn forget(&self, profile_id: &str) -> Option<Arc<Login>> {
        let mut logins = self
            .logins
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let login = logins.remove(profile_id);
        if let Some(login) = &login {
            login.cancelled.cancel();
        }
        login
    }
    pub async fn logout(&self, profile_id: &str) -> Result<(), BastionError> {
        let login = self.forget(profile_id);
        let Some(login) = login else {
            return Ok(());
        };
        // Cancel locally first even if API logout cannot reach the server.
        login.cancelled.cancel();
        let mut tokens = login.tokens.lock().await;
        if let Some(current) = tokens
            .as_ref()
            .filter(|t| t.expired())
        {
            let result = login
                .raw(
                    Method::POST,
                    "auth/refresh",
                    Some(&serde_json::json!({"refresh_token":current.refresh_token})),
                    None,
                )
                .await
                .and_then(decode_tokens);
            match result {
                Ok(refreshed) => *tokens = Some(refreshed),
                Err(e) => {
                    *tokens = None;
                    return Err(e);
                }
            }
        }
        let result = if let Some(tokens) = tokens.as_ref() {
            login
                .raw(
                    Method::POST,
                    "auth/logout",
                    None,
                    Some(&tokens.access_token),
                )
                .await
                .map(|_| ())
        } else {
            Ok(())
        };
        *tokens = None;
        result
    }
    async fn discover(&self, login: &Login) -> Result<Info, BastionError> {
        let info: Info = decode(login.raw(Method::GET, "info", None, None).await?)?;
        if info.server_id != login.profile.server_id {
            self.forget(&login.profile.id);
            return Err(error("SERVER_ID_CHANGED"));
        }
        let gateway = info.gateway()?;
        let fingerprint = zeroterm_ssh::openssh_fingerprint(&gateway.public_key)
            .ok_or_else(|| error("CLIENT_PROTOCOL_UNSUPPORTED"))?;
        let changed =
            if gateway.host != login.profile.ssh_host || gateway.port != login.profile.ssh_port {
                Some("GATEWAY_ADDRESS_CHANGED")
            } else if fingerprint != login.profile.ssh_host_key_sha256 {
                Some("GATEWAY_HOST_KEY_CHANGED")
            } else {
                None
            };
        if let Some(code) = changed {
            self.forget(&login.profile.id);
            return Err(error(code));
        }
        Ok(info)
    }
    pub async fn assets(&self, profile_id: &str) -> Result<Vec<BastionAsset>, BastionError> {
        Ok(self.catalog(profile_id).await?.assets)
    }
    pub async fn catalog(&self, profile_id: &str) -> Result<BastionCatalog, BastionError> {
        let login = self.login_for(profile_id)?;
        let info = self.discover(&login).await?;
        let mut items = Vec::new();
        let mut groups = std::collections::BTreeMap::new();
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        loop {
            let mut url = Url::parse(&login.url("assets")).map_err(local_error)?;
            url.query_pairs_mut().append_pair("limit", "200");
            if let Some(cursor) = &cursor {
                url.query_pairs_mut().append_pair("cursor", cursor);
            }
            let path = format!("assets?{}", url.query().unwrap_or(""));
            let mut page: AssetPage = decode(login.request(Method::GET, &path, None).await?)?;
            for asset in &mut page.items {
                validate_id(&asset.id)?;
                for account in &mut asset.accounts {
                    validate_id(&account.id)?;
                    validate_account_caps(&account.capabilities)?;
                    account.capabilities.retain(|c| info.supports(c));
                }
                asset.accounts.retain(|a| !a.capabilities.is_empty());
            }
            page.items.retain(|a| !a.accounts.is_empty());
            for group in page.groups {
                if group.id.is_empty() || group.name.is_empty() {
                    return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
                }
                groups.insert(group.id.clone(), group);
            }
            items.extend(page.items);
            cursor = page.next_cursor;
            match &cursor {
                None => break,
                Some(c) if !seen.insert(c.clone()) || seen.len() > 1000 => {
                    return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"))
                }
                _ => {}
            }
        }
        Ok(BastionCatalog {
            assets: items,
            groups: groups.into_values().collect(),
        })
    }
}
impl Drop for BastionManager {
    fn drop(&mut self) {
        self.clear();
    }
}

struct TicketProvider {
    manager: Arc<BastionManager>,
    profile_id: String,
    asset_id: String,
    account_id: String,
}
#[async_trait::async_trait]
impl ManagedConnection for TicketProvider {
    async fn prepare(&self) -> Result<(ConnectConfig, ManagedSession), SshError> {
        self.prepare_ticket()
            .await
            .map_err(|e| SshError::Managed(e.to_string()))
    }
    async fn failure(&self, connection_id: &str) -> String {
        let result = async {
            let login = self.manager.login_for(&self.profile_id)?;
            let value = login
                .request(Method::GET, &format!("connections/{connection_id}"), None)
                .await?;
            let code = value
                .get("failure")
                .and_then(|v| v.get("code"))
                .and_then(|v| v.as_str())
                .filter(|s| s.len() <= 80 && s.bytes().all(|c| c.is_ascii_uppercase() || c == b'_'))
                .unwrap_or("AUTH_OR_GATEWAY_FAILED");
            Ok::<_, BastionError>(error(code).to_string())
        }
        .await;
        result.unwrap_or_else(|_| "AUTH_OR_GATEWAY_FAILED".into())
    }
}
impl TicketProvider {
    async fn prepare_ticket(&self) -> Result<(ConnectConfig, ManagedSession), BastionError> {
        validate_id(&self.asset_id)?;
        validate_id(&self.account_id)?;
        let login = self.manager.login_for(&self.profile_id)?;
        let info = self.manager.discover(&login).await?;
        // Read current authorization for every new transport. No cached grant can
        // expand an existing connection or survive a login change.
        let asset: BastionAsset = decode(
            login
                .request(Method::GET, &format!("assets/{}", self.asset_id), None)
                .await?,
        )?;
        if asset.id != self.asset_id {
            return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
        }
        let account = asset
            .accounts
            .iter()
            .find(|a| a.id == self.account_id)
            .ok_or_else(|| error("PERMISSION_DENIED"))?;
        validate_account_caps(&account.capabilities)?;
        let capabilities: Vec<_> = account
            .capabilities
            .iter()
            .filter(|c| info.supports(c))
            .cloned()
            .collect();
        if capabilities.is_empty() {
            return Err(error("CHANNEL_PERMISSION_DENIED"));
        }
        let mut ticket: Ticket = decode(login.request(Method::POST, "connection-tickets", Some(&serde_json::json!({"asset_id":self.asset_id,"account_id":self.account_id,"capabilities":capabilities}))).await?)?;
        validate_ticket(&ticket, &login.profile, &capabilities)?;
        let cfg = ConnectConfig {
            host: ticket.gateway.host.clone(),
            port: ticket.gateway.port,
            username: ticket.gateway.username.clone(),
            auth_methods: vec![AuthMethod::Password(std::mem::take(
                &mut ticket.ticket_secret,
            ))],
            connect_timeout: Some(Duration::from_secs(15)),
            host_key_policy: HostKeyPolicy::PinnedFingerprint(
                login.profile.ssh_host_key_sha256.clone(),
            ),
        };
        Ok((
            cfg,
            ManagedSession {
                connection_id: ticket.connection_id.clone(),
                asset_name: asset.name,
                account: account.display_name().to_owned(),
                capabilities: ticket.capabilities.clone(),
                cancelled: login.cancelled.clone(),
            },
        ))
    }
}
fn validate_ticket(
    ticket: &Ticket,
    profile: &BastionProfile,
    caps: &[String],
) -> Result<(), BastionError> {
    validate_id(&ticket.ticket_id)?;
    validate_id(&ticket.connection_id)?;
    validate_caps(&ticket.capabilities)?;
    if ticket.protocol_version != 1 {
        return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
    }
    if ticket.gateway.host != profile.ssh_host
        || ticket.gateway.port != profile.ssh_port
        || ticket.gateway.username != format!("zt1:{}", ticket.ticket_id)
        || ticket.capabilities.len() != caps.len()
        || ticket.capabilities.iter().any(|c| !caps.contains(c))
    {
        return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
    }
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    if URL_SAFE_NO_PAD
        .decode(&ticket.ticket_secret)
        .map_err(|_| error("CLIENT_PROTOCOL_UNSUPPORTED"))?
        .len()
        < 32
    {
        return Err(error("CLIENT_PROTOCOL_UNSUPPORTED"));
    }
    Ok(())
}

impl App {
    pub fn bastions(&self) -> Arc<BastionManager> {
        self.bastions.clone()
    }
    pub fn list_bastion_profiles(&self) -> Result<Vec<BastionProfile>, BastionError> {
        self.vault
            .list(KIND)
            .map_err(local_error)?
            .into_iter()
            .map(|(id, bytes)| {
                let stored: StoredBastionProfile =
                    serde_json::from_slice(&bytes).map_err(local_error)?;
                let mut profile = stored.profile.clone();
                profile.id = id;
                profile.has_password = !stored.password.is_empty();
                Ok(profile)
            })
            .collect()
    }
    pub fn save_bastion_profile(&self, profile: &BastionProfile) -> Result<String, BastionError> {
        self.save_bastion_connection(profile, None)
    }
    fn stored_bastion_profile(&self, id: &str) -> Result<StoredBastionProfile, BastionError> {
        let (_, bytes) = self.vault.list(KIND).map_err(local_error)?
            .into_iter().find(|(record_id, _)| record_id == id)
            .ok_or_else(|| error("RESOURCE_NOT_FOUND"))?;
        let mut stored: StoredBastionProfile = serde_json::from_slice(&bytes).map_err(local_error)?;
        stored.profile.id = id.to_owned();
        Ok(stored)
    }
    /// None keeps an existing password for the same account and identity; Some("") clears it.
    pub fn save_bastion_connection(
        &self,
        profile: &BastionProfile,
        password: Option<&str>,
    ) -> Result<String, BastionError> {
        profile.validate()?;
        let mut stored = StoredBastionProfile { profile: profile.clone(), password: String::new() };
        if !profile.id.is_empty() {
            let old = self.stored_bastion_profile(&profile.id)?;
            // Never reuse a password when its account or trusted endpoint changes.
            if old.profile.username == profile.username
                && old.profile.api_url == profile.api_url
                && old.profile.server_id == profile.server_id
                && old.profile.ssh_host == profile.ssh_host
                && old.profile.ssh_port == profile.ssh_port
                && old.profile.ssh_host_key_sha256 == profile.ssh_host_key_sha256
                && old.profile.ca_pem == profile.ca_pem
            {
                stored.password = old.password.clone();
            }
        }
        if let Some(password) = password {
            stored.password.zeroize();
            stored.password = password.to_owned();
        }
        if !stored.password.is_empty() && profile.username.trim().is_empty() {
            return Err(error("INVALID_ARGUMENT"));
        }
        let bytes = Zeroizing::new(serde_json::to_vec(&stored).map_err(local_error)?);
        if profile.id.is_empty() {
            self.vault.insert(KIND, &bytes).map_err(local_error)
        } else {
            // Updating connection or account settings ends the old login.
            self.bastions.forget(&profile.id);
            self.vault
                .update(&profile.id, &bytes)
                .map_err(local_error)?;
            Ok(profile.id.clone())
        }
    }
    pub async fn login_bastion(
        &self,
        profile_id: &str,
        username: &str,
        password: &str,
        device_label: &str,
    ) -> Result<(), BastionError> {
        let stored = self.stored_bastion_profile(profile_id)?;
        let password = if password.is_empty() && stored.profile.username == username {
            stored.password.as_str()
        } else {
            password
        };
        if username.trim().is_empty() || password.is_empty() {
            return Err(error("INVALID_ARGUMENT"));
        }
        self.bastions.login(stored.profile.clone(), username, password, device_label).await
    }
    pub fn delete_bastion_profile(&self, id: &str) -> Result<(), BastionError> {
        if !self.list_bastion_profiles()?.iter().any(|p| p.id == id) {
            return Err(error("RESOURCE_NOT_FOUND"));
        }
        self.bastions.forget(id);
        self.vault.delete(id).map_err(local_error)
    }
    /// A favorite stores only asset/account references. Names and capabilities are
    /// display snapshots; the gateway and API remain authoritative.
    pub async fn save_bastion_asset(
        &self,
        profile_id: &str,
        asset_id: &str,
        account_id: &str,
    ) -> Result<String, BastionError> {
        let assets = self.bastions.assets(profile_id).await?;
        let asset = assets
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| error("RESOURCE_NOT_FOUND"))?;
        let account = asset
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| error("PERMISSION_DENIED"))?;
        let profile = self
            .list_bastion_profiles()?
            .into_iter()
            .find(|p| p.id == profile_id)
            .ok_or_else(|| error("RESOURCE_NOT_FOUND"))?;
        let existing = self.list_hosts().map_err(local_error)?.into_iter().find(|h| matches!(&h.auth, HostAuth::Bastion { profile_id: p, asset_id: a, account_id: c } if p == profile_id && a == asset_id && c == account_id));
        let host = Host {
            id: existing.as_ref().map(|h| h.id.clone()).unwrap_or_default(),
            name: format!("{} · {}", asset.name, account.display_name()),
            host: profile.ssh_host,
            port: profile.ssh_port,
            user: account.username.clone(),
            auth: HostAuth::Bastion {
                profile_id: profile_id.into(),
                asset_id: asset_id.into(),
                account_id: account_id.into(),
            },
            os_type: None,
            forwards: vec![],
            proxy_jump_host_id: None,
            group_id: existing.and_then(|h| h.group_id),
        };
        if host.id.is_empty() {
            self.save_host(&host).map_err(local_error)
        } else {
            self.update_host(&host).map_err(local_error)?;
            Ok(host.id)
        }
    }
    pub(crate) fn managed_auth(
        &self,
        profile_id: &str,
        asset_id: &str,
        account_id: &str,
    ) -> AuthMethod {
        AuthMethod::Managed(Arc::new(TicketProvider {
            manager: self.bastions.clone(),
            profile_id: profile_id.into(),
            asset_id: asset_id.into(),
            account_id: account_id.into(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::{rustls, TlsAcceptor};
    const ASSET: &str = "11111111-1111-4111-8111-111111111111";
    const ACCOUNT: &str = "22222222-2222-4222-8222-222222222222";
    #[derive(Default)]
    struct Mock {
        logins: AtomicUsize,
        refreshes: AtomicUsize,
        tickets: AtomicUsize,
        reject_refresh: AtomicBool,
        grouped_assets: AtomicBool,
        expired: AtomicBool,
        changed_identity: AtomicBool,
        changed_gateway: AtomicUsize,
        disable_shell: AtomicBool,
        // N2/N3 servers open exec and sftp; rollouts may open exec before sftp.
        disable_exec: AtomicBool,
        disable_sftp: AtomicBool,
        // What `/native/assets` reports for the account; None = ["shell","exec","sftp"].
        account_caps: Mutex<Option<serde_json::Value>>,
        // Simulates a server that does not echo the requested capability set.
        ticket_drops_caps: AtomicBool,
        native_unavailable: AtomicBool,
        no_native: AtomicBool,
        login_body: Mutex<serde_json::Value>,
        ticket_body: Mutex<serde_json::Value>,
        recording_unavailable: AtomicBool,
        optional_recording: AtomicBool,
        failure_secret: AtomicBool,
        pause_login: AtomicBool,
        check_saved_credentials: AtomicBool,
        login_started: tokio::sync::Notify,
        continue_login: tokio::sync::Notify,
    }
    struct Server {
        profile: BastionProfile,
        state: Arc<Mock>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn server() -> Server {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rcgen::CertifiedKey { cert, key_pair } =
            rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let cfg = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                rustls::pki_types::PrivatePkcs8KeyDer::from(key_pair.serialize_der()).into(),
            )
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(cfg));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mock::default());
        let state_task = state.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let acceptor = acceptor.clone();
                let state = state_task.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(stream).await else {
                        return;
                    };
                    let mut bytes = Vec::new();
                    let mut buf = [0; 4096];
                    let header_end = loop {
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
                    let len = headers
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|s| s.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    while bytes.len() < header_end + len {
                        let n = stream.read(&mut buf).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&buf[..n]);
                    }
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let body: serde_json::Value = if len == 0 {
                        json!(null)
                    } else {
                        serde_json::from_slice(&bytes[header_end..header_end + len]).unwrap()
                    };
                    let mut status = 200;
                    let value = if path == "/api/v1/info" {
                        let available = !state.native_unavailable.load(Ordering::SeqCst);
                        // Browser-family fields stay as served by schema 2; ZeroTerm must ignore them.
                        let mut info = json!({"schema_version":2,"server_id":if state.changed_identity.load(Ordering::SeqCst) {"other"} else {"test"},"protocol_version":2,"stream_protocol":"bastion.guac.v1","production_ready":false,"features":{"web_ssh":true,"web_rdp":false,"web_vnc":false,"recording_replay":true,"device_sessions":true},"recording":{"required":!state.optional_recording.load(Ordering::SeqCst),"format_version":2,"available":!state.recording_unavailable.load(Ordering::SeqCst)},"native":{"protocol_version":1,"minimum_client_protocol_version":1,"available":available,"gateway":{"id":"main","host":"gateway.test","port":2222,"public_key":GATEWAY_KEY},"features":{"shell":available && !state.disable_shell.load(Ordering::SeqCst),"exec":available && !state.disable_exec.load(Ordering::SeqCst),"sftp":available && !state.disable_sftp.load(Ordering::SeqCst)}}});
                        match state.changed_gateway.load(Ordering::SeqCst) {
                            1 => info["native"]["gateway"]["host"] = json!("other.test"),
                            2 => info["native"]["gateway"]["port"] = json!(22),
                            3 => info["native"]["gateway"]["public_key"] = json!("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB"),
                            4 => info["native"]["gateway"] = json!(null),
                            5 => info["native"]["gateway"]["public_key"] = json!("invalid-key"),
                            _ => {}
                        }
                        if state.no_native.load(Ordering::SeqCst) {
                            info.as_object_mut().unwrap().remove("native");
                        }
                        info
                    } else if path == "/api/v1/native/auth/login" {
                        state.logins.fetch_add(1, Ordering::SeqCst);
                        *state.login_body.lock().unwrap() = body.clone();
                        if state.check_saved_credentials.load(Ordering::SeqCst) {
                            assert_eq!(body["username"], "alice");
                            assert_eq!(body["password"], "vault-password-marker");
                        }
                        if state.pause_login.load(Ordering::SeqCst) {
                            state.login_started.notify_one();
                            state.continue_login.notified().await;
                        }
                        tokens(state.expired.load(Ordering::SeqCst))
                    } else if path == "/api/v1/native/auth/refresh" {
                        state.refreshes.fetch_add(1, Ordering::SeqCst);
                        if state.reject_refresh.load(Ordering::SeqCst) {
                            status = 401;
                            json!({"error":{"code":"LOGIN_SESSION_REVOKED","message":"SECRET_MARKER"}})
                        } else {
                            tokens(false)
                        }
                    } else {
                        assert!(headers
                            .to_ascii_lowercase()
                            .contains("authorization: bearer access-secret-marker"));
                        match path {
                            "/api/v1/native/auth/logout" => {
                                status = 204;
                                json!(null)
                            }
                            "/api/v1/native/assets?limit=200" => {
                                if state.grouped_assets.load(Ordering::SeqCst) {
                                    let mut item = asset(&state);
                                    item["group_id"] = json!("apps");
                                    json!({"items":[item],"groups":[{"id":"apps","name":"Applications","parent_id":"production","sort_order":2}],"next_cursor":"opaque+/cursor"})
                                } else {
                                    json!({"items":[asset(&state)],"next_cursor":"opaque+/cursor"})
                                }
                            }
                            "/api/v1/native/assets?limit=200&cursor=opaque%2B%2Fcursor" => {
                                if state.grouped_assets.load(Ordering::SeqCst) {
                                    json!({"items":[],"groups":[{"id":"production","name":"Production"},{"id":"apps","name":"Applications","parent_id":"production","sort_order":2}],"next_cursor":null})
                                } else {
                                    json!({"items":[],"next_cursor":null})
                                }
                            }
                            "/api/v1/native/assets/11111111-1111-4111-8111-111111111111" => asset(&state),
                            "/api/v1/native/connection-tickets" => {
                                *state.ticket_body.lock().unwrap() = body.clone();
                                let n = state.tickets.fetch_add(1, Ordering::SeqCst) + 1;
                                let id = format!("33333333-3333-4333-8333-{n:012}");
                                json!({"protocol_version":1,"ticket_id":id,"ticket_secret":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([(n+40) as u8;32]),"connection_id":format!("44444444-4444-4444-8444-{n:012}"),"gateway":{"host":"gateway.test","port":2222,"username":format!("zt1:{id}")},"capabilities":if state.ticket_drops_caps.load(Ordering::SeqCst) {json!(["shell"])} else {body["capabilities"].clone()},"expires_at":(Utc::now()+chrono::Duration::seconds(30)).to_rfc3339()})
                            }
                            "/api/v1/native/connections/44444444-4444-4444-8444-000000000001" => {
                                json!({"failure":{"code":if state.failure_secret.load(Ordering::SeqCst) {"ticket-secret-marker"} else {"AUTH_OR_GATEWAY_FAILED"}}})
                            }
                            _ => {
                                status = 404;
                                json!({"error":{"code":"RESOURCE_NOT_FOUND"}})
                            }
                        }
                    };
                    let body = if status == 204 {
                        String::new()
                    } else {
                        value.to_string()
                    };
                    let response = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nX-Request-Id: mock-request\r\n\r\n{body}",body.len());
                    stream.write_all(response.as_bytes()).await.unwrap();
                    let _ = stream.shutdown().await;
                });
            }
        });
        Server {
            profile: BastionProfile {
                id: "profile".into(),
                name: "Test".into(),
                api_url: format!("https://localhost:{port}"),
                server_id: "test".into(),
                ssh_host: "gateway.test".into(),
                ssh_port: 2222,
                ssh_host_key_sha256: GATEWAY_FINGERPRINT.into(),
                ca_pem: Some(cert.pem()),
                username: String::new(),
                has_password: false,
            },
            state,
            task,
        }
    }
    fn tokens(expired: bool) -> serde_json::Value {
        json!({"access_token":"access-secret-marker","refresh_token":"refresh-secret-marker","access_expires_at":(Utc::now()+chrono::Duration::seconds(if expired {-1} else {600})).to_rfc3339()})
    }
    // RFC-006 §14.1: an authorized account lists every open native capability. Tests
    // override this to prove the client still intersects with `/info.native.features`.
    fn asset(state: &Mock) -> serde_json::Value {
        let caps = state.account_caps.lock().unwrap().clone().unwrap_or_else(|| json!(["shell","exec","sftp"]));
        json!({"id":ASSET,"name":"Target A","protocol":"ssh","tags":[],"group_id":null,"group_name":null,"revision":1,"accounts":[{"id":ACCOUNT,"label":"Deploy (prod)","username":"deploy","domain":null,"credential_kind":"password","capabilities":caps}]})
    }
    async fn login(manager: &BastionManager, s: &Server) {
        manager
            .login(s.profile.clone(), "alice", "login-secret-marker", "Tests")
            .await
            .unwrap();
    }
    fn provider(manager: Arc<BastionManager>) -> TicketProvider {
        TicketProvider {
            manager,
            profile_id: "profile".into(),
            asset_id: ASSET.into(),
            account_id: ACCOUNT.into(),
        }
    }

    fn info_json() -> serde_json::Value {
        json!({"schema_version":2,"server_id":"test","protocol_version":2,"stream_protocol":"bastion.guac.v1","production_ready":false,"features":{"web_ssh":true,"web_rdp":true,"web_vnc":true,"recording_replay":true,"device_sessions":true},"recording":{"required":true,"available":true,"format_version":2},"native":{"protocol_version":1,"minimum_client_protocol_version":1,"available":true,"gateway":{"id":"main","host":"gateway.test","port":2222,"public_key":GATEWAY_KEY},"features":{"shell":true,"exec":true,"sftp":true}}})
    }
    #[test]
    fn discovery_reads_only_the_native_block_and_requires_recording_v2() {
        let info: Info = decode(info_json()).unwrap();
        info.validate().unwrap();
        assert_eq!(info.gateway().unwrap().port, 2222);
        assert!(info.supports("shell") && info.supports("exec") && info.supports("sftp"));
        assert!(!info.supports("forward"));
        // Top-level protocol_version is the browser family (2 today); it is not a native gate.
        for top in [json!(1), json!(3), json!(null)] {
            let mut value = info_json();
            value["protocol_version"] = top;
            decode::<Info>(value).unwrap().validate().unwrap();
        }
        let mut value = info_json();
        value.as_object_mut().unwrap().remove("native");
        assert_eq!(
            decode::<Info>(value).unwrap().validate().unwrap_err().code,
            "NATIVE_ENTRY_UNAVAILABLE"
        );
        let mut value = info_json();
        value.as_object_mut().unwrap().remove("production_ready");
        assert_eq!(
            decode::<Info>(value).unwrap().validate().unwrap_err().code,
            "CLIENT_PROTOCOL_UNSUPPORTED"
        );
        for (field, v) in [
            ("protocol_version", json!(2)),
            ("protocol_version", json!(0)),
            ("minimum_client_protocol_version", json!(2)),
        ] {
            let mut value = info_json();
            value["native"][field] = v;
            assert_eq!(
                decode::<Info>(value).unwrap().validate().unwrap_err().code,
                "CLIENT_PROTOCOL_UNSUPPORTED"
            );
        }
        // Required native fields: a malformed block is a protocol error, never a downgrade.
        for field in ["protocol_version", "minimum_client_protocol_version", "available", "features"] {
            let mut value = info_json();
            value["native"].as_object_mut().unwrap().remove(field);
            assert_eq!(decode::<Info>(value).err().unwrap().code, "CLIENT_PROTOCOL_UNSUPPORTED");
        }
        // Browser features never enable native capabilities.
        let mut value = info_json();
        value["native"]["features"] = json!({});
        let info: Info = decode(value).unwrap();
        info.validate().unwrap();
        assert!(!info.supports("shell") && !info.supports("exec") && !info.supports("sftp"));
        // available=false disables everything even if a feature flag is left true.
        let mut value = info_json();
        value["native"]["available"] = json!(false);
        let info: Info = decode(value).unwrap();
        info.validate().unwrap();
        assert!(!info.supports("shell") && !info.supports("exec") && !info.supports("sftp"));
        let mut value = info_json();
        value["recording"]["available"] = json!(false);
        let info: Info = decode(value).unwrap();
        assert!(!info.supports("shell") && info.supports("sftp"));
        for recording in [
            json!(null),
            json!({"required":false,"format_version":2}),
            json!({"required":true,"format_version":1}),
            json!({"required":true,"format_version":3}),
        ] {
            let mut value = info_json();
            value["recording"] = recording;
            assert_eq!(
                decode::<Info>(value).unwrap().validate().unwrap_err().code,
                "RECORDING_REQUIRED"
            );
        }
    }
    #[test]
    fn account_label_is_displayed_and_falls_back_to_username() {
        let mut account: BastionAccount = decode(json!({"id":ACCOUNT,"label":"Deploy (prod)","username":"deploy","domain":null,"credential_kind":"password","capabilities":["shell"]})).unwrap();
        assert_eq!(account.display_name(), "Deploy (prod)");
        assert_eq!(account.username, "deploy");
        account.label = " ".into();
        assert_eq!(account.display_name(), "deploy");
        let legacy: BastionAccount = decode(json!({"id":ACCOUNT,"username":"root","capabilities":["shell"]})).unwrap();
        assert_eq!(legacy.display_name(), "root");
    }
    #[tokio::test]
    async fn native_login_and_ticket_requests_use_rfc006_bodies() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let body = s.state.login_body.lock().unwrap().clone();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["device_label", "password", "username"]);
        assert!(body.get("client_type").is_none());
        assert_eq!(body["device_label"], "Tests");
        let (_, meta) = provider(m.clone()).prepare().await.unwrap();
        let body = s.state.ticket_body.lock().unwrap().clone();
        let mut keys: Vec<_> = body.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["account_id", "asset_id", "capabilities"]);
        assert!(body.get("purpose").is_none());
        assert_eq!(body["asset_id"], ASSET);
        assert_eq!(body["account_id"], ACCOUNT);
        // N2/N3: one ticket requests every open capability so the connection can carry
        // shell, exec and sftp channels together (RFC-006 §14.2).
        assert_eq!(body["capabilities"], json!(["shell", "exec", "sftp"]));
        assert_eq!(meta.capabilities, vec!["shell", "exec", "sftp"]);
        assert_eq!(meta.account, "Deploy (prod)");
        let catalog = m.catalog("profile").await.unwrap();
        let account = &catalog.assets[0].accounts[0];
        assert_eq!((account.label.as_str(), account.username.as_str()), ("Deploy (prod)", "deploy"));
        assert_eq!(account.capabilities, vec!["shell", "exec", "sftp"]);
    }
    #[tokio::test]
    async fn server_without_native_entry_is_rejected_before_credentials_are_sent() {
        let s = server().await;
        s.state.no_native.store(true, Ordering::SeqCst);
        let m = BastionManager::default();
        assert_eq!(
            m.probe("", &s.profile.api_url, s.profile.ca_pem.clone())
                .await
                .unwrap_err()
                .code,
            "NATIVE_ENTRY_UNAVAILABLE"
        );
        assert_eq!(
            m.login(s.profile.clone(), "alice", "secret", "Tests")
                .await
                .unwrap_err()
                .code,
            "NATIVE_ENTRY_UNAVAILABLE"
        );
        assert_eq!(s.state.logins.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn catalog_and_fresh_tickets_honor_feature_and_recording_availability() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let p = provider(m.clone());
        let caps = |m: &Arc<BastionManager>| {
            let m = m.clone();
            async move { m.assets("profile").await.unwrap()[0].accounts[0].capabilities.clone() }
        };
        // Rollout: exec opens before sftp. The client honors the advertised set only.
        s.state.disable_sftp.store(true, Ordering::SeqCst);
        assert_eq!(caps(&m).await, vec!["shell", "exec"]);
        assert_eq!(p.prepare().await.unwrap().1.capabilities, vec!["shell", "exec"]);
        s.state.disable_shell.store(true, Ordering::SeqCst);
        s.state.disable_sftp.store(false, Ordering::SeqCst);
        assert_eq!(caps(&m).await, vec!["exec", "sftp"]);
        assert_eq!(p.prepare().await.unwrap().1.capabilities, vec!["exec", "sftp"]);
        s.state.disable_shell.store(false, Ordering::SeqCst);
        // Recording only gates the shell; exec is audited and sftp is not recorded.
        s.state.recording_unavailable.store(true, Ordering::SeqCst);
        assert_eq!(p.prepare().await.unwrap().1.capabilities, vec!["exec", "sftp"]);
        s.state.disable_exec.store(true, Ordering::SeqCst);
        s.state.disable_sftp.store(true, Ordering::SeqCst);
        assert!(m.assets("profile").await.unwrap().is_empty());
        assert!(p
            .prepare()
            .await
            .unwrap_err()
            .to_string()
            .contains("CHANNEL_PERMISSION_DENIED"));
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 3);
        // An enabled but unavailable native gateway offers nothing.
        s.state.recording_unavailable.store(false, Ordering::SeqCst);
        s.state.disable_exec.store(false, Ordering::SeqCst);
        s.state.disable_sftp.store(false, Ordering::SeqCst);
        s.state.native_unavailable.store(true, Ordering::SeqCst);
        assert!(m.assets("profile").await.unwrap().is_empty());
        assert!(p
            .prepare()
            .await
            .unwrap_err()
            .to_string()
            .contains("CHANNEL_PERMISSION_DENIED"));
        s.state.native_unavailable.store(false, Ordering::SeqCst);
        s.state.optional_recording.store(true, Ordering::SeqCst);
        assert_eq!(
            m.assets("profile").await.unwrap_err().code,
            "RECORDING_REQUIRED"
        );
        assert!(p
            .prepare()
            .await
            .unwrap_err()
            .to_string()
            .contains("RECORDING_REQUIRED"));
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn ticket_requests_advertised_features_intersected_with_the_account() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let p = provider(m.clone());
        let requested = |s: &Server| s.state.ticket_body.lock().unwrap()["capabilities"].clone();
        // A stale catalog row lists fewer capabilities than the server advertises.
        *s.state.account_caps.lock().unwrap() = Some(json!(["shell", "sftp"]));
        assert_eq!(p.prepare().await.unwrap().1.capabilities, vec!["shell", "sftp"]);
        assert_eq!(requested(&s), json!(["shell", "sftp"]));
        // An account that over-reports is cut back to `/info.native.features`.
        *s.state.account_caps.lock().unwrap() = Some(json!(["shell", "exec", "sftp"]));
        s.state.disable_exec.store(true, Ordering::SeqCst);
        assert_eq!(p.prepare().await.unwrap().1.capabilities, vec!["shell", "sftp"]);
        assert_eq!(requested(&s), json!(["shell", "sftp"]));
        s.state.disable_exec.store(false, Ordering::SeqCst);
        // Unknown capabilities from the catalog are a protocol error, never a guess.
        *s.state.account_caps.lock().unwrap() = Some(json!(["shell", "forward"]));
        assert!(p.prepare().await.unwrap_err().to_string().contains("UNKNOWN_CAPABILITY"));
        *s.state.account_caps.lock().unwrap() = None;
        // The ticket must echo the requested set exactly (RFC-006 §14.1).
        s.state.ticket_drops_caps.store(true, Ordering::SeqCst);
        assert!(p.prepare().await.unwrap_err().to_string().contains("CLIENT_PROTOCOL_UNSUPPORTED"));
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn connection_failure_never_surfaces_arbitrary_response_text() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        s.state.failure_secret.store(true, Ordering::SeqCst);
        let failure = provider(m)
            .failure("44444444-4444-4444-8444-000000000001")
            .await;
        assert!(failure.contains("AUTH_OR_GATEWAY_FAILED"));
        assert!(!failure.contains("ticket-secret-marker"));
    }
    #[tokio::test]
    async fn catalog_merges_groups_across_pages_and_supports_legacy_ungrouped_assets() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        assert_eq!(
            m.catalog("profile").await.unwrap_err().code,
            "UNAUTHENTICATED"
        );
        login(&m, &s).await;
        let legacy = m.catalog("profile").await.unwrap();
        assert!(legacy.groups.is_empty());
        assert!(legacy.assets[0].group_id.is_none());
        s.state.grouped_assets.store(true, Ordering::SeqCst);
        let catalog = m.catalog("profile").await.unwrap();
        assert_eq!(catalog.assets.len(), 1);
        assert_eq!(catalog.assets[0].group_id.as_deref(), Some("apps"));
        assert_eq!(catalog.groups.len(), 2);
        let apps = catalog.groups.iter().find(|g| g.id == "apps").unwrap();
        assert_eq!(apps.parent_id.as_deref(), Some("production"));
        assert_eq!(apps.sort_order, 2);
        assert_eq!(
            m.assets("profile").await.unwrap()[0].accounts[0].id,
            ACCOUNT
        );
    }
    #[tokio::test]
    async fn every_transport_gets_a_fresh_ticket_and_public_metadata() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let p = provider(m.clone());
        let (first, a) = p.prepare().await.unwrap();
        let (second, b) = p.prepare().await.unwrap();
        assert_ne!(first.username, second.username);
        assert_ne!(a.connection_id, b.connection_id);
        assert_eq!(a.asset_name, "Target A");
        assert_eq!(a.account, "Deploy (prod)");
        assert_eq!(first.username, format!("zt1:{}", "33333333-3333-4333-8333-000000000001"));
        assert_eq!(a.capabilities, vec!["shell", "exec", "sftp"]);
        assert!(matches!(
            first.host_key_policy,
            HostKeyPolicy::PinnedFingerprint(_)
        ));
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 2);
        assert!(!format!("{first:?}")
            .contains(&base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([41u8; 32])));
        m.logout("profile").await.unwrap();
        assert!(a.cancelled.is_cancelled());
        assert!(p.prepare().await.is_err());
    }
    #[tokio::test]
    async fn concurrent_requests_rotate_refresh_once_and_paginate_opaque_cursors() {
        let s = server().await;
        s.state.expired.store(true, Ordering::SeqCst);
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let m = m.clone();
            tasks.push(tokio::spawn(
                async move { m.assets("profile").await.unwrap() },
            ));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap().len(), 1);
        }
        assert_eq!(s.state.refreshes.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn failed_refresh_is_not_replayed_and_drops_login() {
        let s = server().await;
        s.state.expired.store(true, Ordering::SeqCst);
        s.state.reject_refresh.store(true, Ordering::SeqCst);
        let m = BastionManager::default();
        login(&m, &s).await;
        let e = m.assets("profile").await.unwrap_err();
        assert_eq!(e.code, "LOGIN_SESSION_REVOKED");
        assert!(!e.to_string().contains("SECRET_MARKER"));
        assert!(m.assets("profile").await.is_err());
        assert_eq!(s.state.refreshes.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn vault_lock_cannot_be_undone_by_an_inflight_login() {
        let s = server().await;
        s.state.pause_login.store(true, Ordering::SeqCst);
        let m = Arc::new(BastionManager::default());
        let cloned = m.clone();
        let profile = s.profile.clone();
        let task =
            tokio::spawn(async move { cloned.login(profile, "alice", "secret", "Tests").await });
        s.state.login_started.notified().await;
        m.clear();
        s.state.continue_login.notify_one();
        assert_eq!(
            task.await.unwrap().unwrap_err().code,
            "LOGIN_SESSION_REVOKED"
        );
        assert!(m.login_for("profile").is_err());
    }
    #[tokio::test]
    async fn server_identity_changes_block_new_tickets_and_cancel_old_connections() {
        let s = server().await;
        let m = Arc::new(BastionManager::default());
        login(&m, &s).await;
        let p = provider(m.clone());
        let (_, metadata) = p.prepare().await.unwrap();
        s.state.changed_identity.store(true, Ordering::SeqCst);
        assert!(p
            .prepare()
            .await
            .unwrap_err()
            .to_string()
            .contains("SERVER_ID_CHANGED"));
        assert!(metadata.cancelled.is_cancelled());
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 1);
    }
    // Throwaway key; FINGERPRINT is `ssh-keygen -lf -E sha256` of the same line.
    const GATEWAY_KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMkUewCugYJx6+EHYnQImqhx0CBpNFSgEqWhdpd9ncgJ probe-test";
    const GATEWAY_FINGERPRINT: &str = "SHA256:V7VLKpTCA0oXCfOoEXmUW01yqozapS/EuSnoPQwWBq4";
    #[tokio::test]
    async fn probe_fills_pins_from_verified_info_and_requires_tls() {
        let s = server().await;
        let m = BastionManager::default();
        let probed = m
            .probe(
                "",
                &format!("{}/", s.profile.api_url),
                s.profile.ca_pem.clone(),
            )
            .await
            .unwrap();
        assert_eq!(probed.name, "localhost");
        assert_eq!(probed.api_url, s.profile.api_url);
        assert_eq!(probed.server_id, "test");
        assert_eq!(
            (probed.ssh_host.as_str(), probed.ssh_port),
            ("gateway.test", 2222)
        );
        assert_eq!(probed.ssh_host_key_sha256, GATEWAY_FINGERPRINT);
        assert!(probed.id.is_empty());
        assert_eq!(s.state.logins.load(Ordering::SeqCst), 0);
        assert_eq!(s.state.tickets.load(Ordering::SeqCst), 0);
        assert!(m.probe("Named", &s.profile.api_url, None).await.is_err());
        assert!(m.probe("x", "http://localhost", None).await.is_err());
        assert!(m
            .probe(
                "x",
                &format!("{}///", s.profile.api_url),
                s.profile.ca_pem.clone()
            )
            .await
            .is_err());
        for change in [4, 5] {
            s.state.changed_gateway.store(change, Ordering::SeqCst);
            assert_eq!(
                m.probe("", &s.profile.api_url, s.profile.ca_pem.clone())
                    .await
                    .unwrap_err()
                    .code,
                "CLIENT_PROTOCOL_UNSUPPORTED"
            );
        }
    }
    #[tokio::test]
    async fn changed_gateway_blocks_login_and_cancels_existing_connections_without_repinning() {
        for (change, code) in [
            (1, "GATEWAY_ADDRESS_CHANGED"),
            (2, "GATEWAY_ADDRESS_CHANGED"),
            (3, "GATEWAY_HOST_KEY_CHANGED"),
        ] {
            let s = server().await;
            let m = Arc::new(BastionManager::default());
            login(&m, &s).await;
            let (_, metadata) = provider(m.clone()).prepare().await.unwrap();
            s.state.changed_gateway.store(change, Ordering::SeqCst);
            assert_eq!(m.assets("profile").await.unwrap_err().code, code);
            assert!(metadata.cancelled.is_cancelled());
            assert_eq!(
                m.assets("profile").await.unwrap_err().code,
                "UNAUTHENTICATED"
            );
            assert_eq!(
                m.login(s.profile.clone(), "alice", "secret", "Tests")
                    .await
                    .unwrap_err()
                    .code,
                code
            );
            assert_eq!(s.state.logins.load(Ordering::SeqCst), 1);
            assert_eq!(s.state.tickets.load(Ordering::SeqCst), 1);
            assert_eq!(s.profile.ssh_host_key_sha256, GATEWAY_FINGERPRINT);
        }
    }
    #[tokio::test]
    async fn tls_verification_is_required() {
        let s = server().await;
        let mut profile = s.profile.clone();
        profile.ca_pem = None;
        assert!(BastionManager::default()
            .login(profile, "alice", "secret", "Tests")
            .await
            .is_err());
    }
    #[tokio::test]
    async fn saved_account_survives_reopen_without_exposing_or_reusing_password_for_changed_identity() {
        let s = server().await;
        s.state.check_saved_credentials.store(true, Ordering::SeqCst);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.db");
        let app = App::create(&path, "master-password").unwrap();
        let mut profile = s.profile.clone();
        profile.id.clear();
        profile.username = "alice".into();
        profile.id = app.save_bastion_connection(&profile, Some("vault-password-marker")).unwrap();
        drop(app);

        let app = App::open(&path, "master-password").unwrap();
        let listed = app.list_bastion_profiles().unwrap();
        assert!(listed[0].has_password);
        assert_eq!(listed[0].username, "alice");
        let public = serde_json::to_string(&listed).unwrap();
        assert!(!public.contains("vault-password-marker"));
        assert!(serde_json::to_value(&listed[0]).unwrap().get("password").is_none());
        app.login_bastion(&profile.id, "alice", "", "Tests").await.unwrap();
        assert_eq!(s.state.logins.load(Ordering::SeqCst), 1);
        // Favorites show the account label but connect as the target username.
        let host_id = app.save_bastion_asset(&profile.id, ASSET, ACCOUNT).await.unwrap();
        let host = app.find_host_by_id(&host_id).unwrap().unwrap();
        assert_eq!(host.name, "Target A · Deploy (prod)");
        assert_eq!(host.user, "deploy");
        // The private password and transient login tokens never appear on disk as plaintext.
        let disk = std::fs::read(&path).unwrap();
        for secret in ["vault-password-marker", "access-secret-marker", "refresh-secret-marker"] {
            assert!(!disk.windows(secret.len()).any(|w| w == secret.as_bytes()));
        }
        assert!(app.login_bastion(&profile.id, "bob", "", "Tests").await.is_err());
        app.bastions.clear();
        assert!(app.bastions.assets(&profile.id).await.is_err());
        assert!(app.list_bastion_profiles().unwrap()[0].has_password);

        profile.name = "Renamed".into();
        app.save_bastion_profile(&profile).unwrap();
        assert!(app.list_bastion_profiles().unwrap()[0].has_password);
        s.state.changed_identity.store(true, Ordering::SeqCst);
        assert!(app.login_bastion(&profile.id, "alice", "", "Tests").await.is_err());
        assert_eq!(s.state.logins.load(Ordering::SeqCst), 1);
        s.state.changed_identity.store(false, Ordering::SeqCst);

        profile.api_url = "https://other.test".into();
        app.save_bastion_profile(&profile).unwrap();
        assert!(!app.list_bastion_profiles().unwrap()[0].has_password);
        profile.api_url = s.profile.api_url.clone();
        app.save_bastion_connection(&profile, Some("vault-password-marker")).unwrap();
        profile.username = "bob".into();
        app.save_bastion_profile(&profile).unwrap();
        assert!(!app.list_bastion_profiles().unwrap()[0].has_password);
        profile.username = "alice".into();
        app.save_bastion_connection(&profile, Some("vault-password-marker")).unwrap();
        app.save_bastion_connection(&profile, Some("")).unwrap();
        assert!(!app.list_bastion_profiles().unwrap()[0].has_password);
        assert!(app.login_bastion(&profile.id, "alice", "", "Tests").await.is_err());
        app.delete_bastion_profile(&profile.id).unwrap();
        assert!(app.list_bastion_profiles().unwrap().is_empty());

        // Profiles written by older versions contain neither account nor password.
        let mut legacy = serde_json::to_value(&s.profile).unwrap();
        for key in ["username", "has_password"] { legacy.as_object_mut().unwrap().remove(key); }
        app.vault.insert(KIND, &serde_json::to_vec(&legacy).unwrap()).unwrap();
        let listed = app.list_bastion_profiles().unwrap();
        assert_eq!(listed[0].username, "");
        assert!(!listed[0].has_password);
    }

    #[test]
    fn profile_rejects_insecure_urls_and_unverified_fingerprints() {
        let mut p = BastionProfile {
            id: String::new(),
            name: "Test".into(),
            api_url: "https://bastion.test".into(),
            server_id: "test".into(),
            ssh_host: "bastion.test".into(),
            ssh_port: 2222,
            ssh_host_key_sha256: format!("SHA256:{}", STANDARD_NO_PAD.encode([1u8; 32])),
            ca_pem: None,
            username: String::new(),
            has_password: false,
        };
        p.validate().unwrap();
        for url in [
            "http://bastion.test",
            "https://user:password@bastion.test",
            "https://bastion.test?token=x",
            "https://bastion.test/api/v1",
        ] {
            p.api_url = url.into();
            assert!(p.validate().is_err());
        }
        p.api_url = "https://bastion.test".into();
        p.ssh_host_key_sha256 = "SHA256:unverified".into();
        assert!(p.validate().is_err());
    }
    #[test]
    fn ticket_validation_rejects_routing_downgrade_unknown_caps_and_expiry() {
        let p = BastionProfile {
            id: String::new(),
            name: "Test".into(),
            api_url: "https://bastion.test".into(),
            server_id: "test".into(),
            ssh_host: "bastion.test".into(),
            ssh_port: 2222,
            ssh_host_key_sha256: String::new(),
            ca_pem: None,
            username: String::new(),
            has_password: false,
        };
        let make = || Ticket {
            protocol_version: 1,
            ticket_id: ASSET.into(),
            ticket_secret: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 32]),
            connection_id: ACCOUNT.into(),
            gateway: Gateway {
                host: p.ssh_host.clone(),
                port: 2222,
                username: format!("zt1:{ASSET}"),
            },
            capabilities: vec!["shell".into()],
            expires_at: Utc::now() + chrono::Duration::seconds(30),
        };
        let caps = vec!["shell".into()];
        validate_ticket(&make(), &p, &caps).unwrap();
        let mut t = make();
        t.gateway.host = "target.test".into();
        assert!(validate_ticket(&t, &p, &caps).is_err());
        let mut t = make();
        t.gateway.username = "root".into();
        assert!(validate_ticket(&t, &p, &caps).is_err());
        let mut t = make();
        t.capabilities.push("exec".into());
        assert!(validate_ticket(&t, &p, &caps).is_err());
        let mut t = make();
        t.capabilities = vec!["forward".into()];
        assert!(validate_ticket(&t, &p, &caps).is_err());
        // N2/N3: any order of the exact requested set is accepted; subsets and duplicates are not.
        let all: Vec<String> = vec!["shell".into(), "exec".into(), "sftp".into()];
        let mut t = make();
        t.capabilities = vec!["sftp".into(), "shell".into(), "exec".into()];
        validate_ticket(&t, &p, &all).unwrap();
        t.capabilities = vec!["shell".into(), "exec".into()];
        assert!(validate_ticket(&t, &p, &all).is_err());
        t.capabilities = vec!["shell".into(), "exec".into(), "exec".into()];
        assert!(validate_ticket(&t, &p, &all).is_err());
        let mut t = make();
        // Ticket expiry is the gateway's decision: a client clock running ahead must not reject it.
        t.expires_at = Utc::now() - chrono::Duration::seconds(120);
        assert!(validate_ticket(&t, &p, &caps).is_ok());
    }
    #[test]
    fn token_lifetime_follows_the_server_clock_not_the_local_one() {
        let token = |expires: DateTime<Utc>, date: Option<DateTime<Utc>>| {
            let mut v = json!({"access_token":"a","refresh_token":"r","access_expires_at":expires.to_rfc3339()});
            if let Some(date) = date {
                v[SERVER_DATE] = json!(date.to_rfc3339());
            }
            decode_tokens(v).unwrap()
        };
        // Server clock one hour behind the client: 10-minute token is still fresh locally.
        let behind = Utc::now() - chrono::Duration::hours(1);
        let t = token(behind + chrono::Duration::minutes(10), Some(behind));
        assert!(!t.due() && !t.expired());
        // Server clock one hour ahead: the same token is not treated as long-lived.
        let ahead = Utc::now() + chrono::Duration::hours(1);
        let t = token(ahead + chrono::Duration::seconds(10), Some(ahead));
        assert!(t.due() && !t.expired());
        // Without a Date header the absolute expiry is used.
        let t = token(Utc::now() - chrono::Duration::seconds(1), None);
        assert!(t.due() && t.expired());
    }
}
