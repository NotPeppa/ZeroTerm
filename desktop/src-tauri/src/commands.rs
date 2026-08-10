//! Tauri command surface — the JS-callable API.
//!
//! Conventions:
//!   - All commands return `Result<T, String>` so error messages cross
//!     the IPC boundary cleanly. We pretty-print the underlying error.
//!   - Sync mutexes are acquired in tight blocks; `await` happens after
//!     the lock is dropped.

use std::collections::{BTreeSet, HashMap, HashSet};
#[cfg(target_os = "windows")]
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
#[cfg(not(target_os = "windows"))]
use tokio::process::Command;

use futures_util::StreamExt;
use portable_pty::{CommandBuilder, PtySize as LocalPtySize};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::Mutex as StdMutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use tauri_plugin_updater::UpdaterExt;
use zeroterm_app::{App, HostAuth, SyncBackend, SyncProfile};
use zeroterm_ssh::{HostKeyPolicy, KnownHosts, PtySize, Session};

use crate::connect::{
    build_connect_chain_for_host, connect_host_sessions,
};
use crate::editor::{
    decode_editor_text, normalize_text_edit_limit, RemoteTextFileDto, HARD_TEXT_EDIT_MAX_BYTES,
};
use crate::file_dto::{DirEntryDto, FilePermissionModeDto, LocalFileFingerprintDto};
use crate::host_key::TauriHostKeyPrompt;
use crate::session::{run as run_session, ClosedEvent};
use crate::state::{
    AppState, LocalSessionHandle, PortForwardHandle, SessionCommand, SessionHandle, PF_ACTIVE,
    PF_RECONNECTING,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// --------------------------------------------------------------------------
// vault
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub path: String,
    pub exists: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontDto {
    pub family: String,
}

const AI_CONFIG_FILE: &str = "ai-config.json";
const AI_SESSION_FILE: &str = "ai-sessions.json";
const NETWORK_PROXY_FILE: &str = "network-proxy.json";
/// Keychain profile id under which the proxy credential (userinfo of a
/// `http://user:pass@host:port` proxy) is stored, so `network-proxy.json`
/// never holds it in cleartext. See TAURI-3.
const NETWORK_PROXY_KEYCHAIN_ID: &str = "__network_proxy__";
const AI_KEYCHAIN_PROFILE: &str = "default";
const AI_SESSION_MAX_ITEMS: usize = 80;
const AI_STORE_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProxyConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub safe_mode: bool,
    pub auto_read: bool,
    pub show_commands: bool,
    #[serde(default)]
    pub has_api_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigInput {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    pub safe_mode: bool,
    pub auto_read: bool,
    pub show_commands: bool,
}

/// A single named AI configuration. `id` doubles as the keychain profile id,
/// so each profile stores its own API key under `ai-api-key:{id}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub has_api_key: bool,
    #[serde(default)]
    pub reasoning_effort: String,
}

/// The multi-profile store persisted to `ai-config.json` (schema v2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigStore {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub profiles: Vec<AiProfile>,
    #[serde(default)]
    pub active_profile_id: String,
    #[serde(default = "default_true")]
    pub safe_mode: bool,
    #[serde(default)]
    pub auto_read: bool,
    #[serde(default)]
    pub show_commands: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiProfileInput {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub reasoning_effort: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiProfileModelInput {
    pub id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub reasoning_content: String,
    #[serde(default)]
    pub command_results: Vec<AiCommandResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandResult {
    pub command: String,
    #[serde(default)]
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionItem {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub pane_key: Option<String>,
    #[serde(default)]
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: String,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiSessionInput {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub pane_key: Option<String>,
    #[serde(default)]
    pub scope_type: String,
    #[serde(default)]
    pub scope_id: String,
    #[serde(default)]
    pub scope_label: String,
    pub messages: Vec<AiChatMessage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearAiSessionsForScopeInput {
    pub scope_type: String,
    pub scope_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResponse {
    pub content: String,
    #[serde(default)]
    pub reasoning_content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelListResponse {
    pub models: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamInput {
    pub request_id: String,
    pub messages: Vec<AiChatMessage>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub request_id: String,
    pub delta: String,
    #[serde(default)]
    pub reasoning_delta: String,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsDto {
    pub host: String,
    pub os: String,
    pub arch: String,
    pub outbound_ip_type: String,
    pub uptime_seconds: u64,
    pub cpu_cores: u32,
    pub cpu_usage: f64,
    pub memory_total: u64,
    pub memory_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub disks: Vec<SystemDiskDto>,
    pub networks: Vec<SystemNetworkDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDiskDto {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub usage: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNetworkDto {
    pub name: String,
    pub rx_bytes_per_sec: u64,
    pub tx_bytes_per_sec: u64,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModelItem>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelItem {
    id: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChunk {
    choices: Vec<OpenAiStreamChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamChoice {
    delta: OpenAiStreamDelta,
}

#[derive(Debug, Deserialize)]
struct OpenAiStreamDelta {
    content: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

static CANCELED_AI_REQUESTS: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();

fn canceled_ai_requests() -> &'static StdMutex<HashSet<String>> {
    CANCELED_AI_REQUESTS.get_or_init(|| StdMutex::new(HashSet::new()))
}

fn default_true() -> bool {
    true
}

fn default_ai_store() -> AiConfigStore {
    AiConfigStore {
        version: AI_STORE_VERSION,
        profiles: Vec::new(),
        active_profile_id: String::new(),
        safe_mode: true,
        auto_read: false,
        show_commands: false,
    }
}

fn zeroterm_config_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .ok_or_else(|| "no config directory on this OS".to_string())
        .map(|d| d.join("ZeroTerm"))
}

fn generate_profile_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("prof-{nanos:x}")
}

fn legacy_profile_name(cfg: &AiConfig) -> String {
    if !cfg.model.trim().is_empty() {
        cfg.model.trim().to_string()
    } else if !cfg.provider.trim().is_empty() {
        cfg.provider.trim().to_string()
    } else {
        "Default".to_string()
    }
}

fn normalize_ai_profile(mut p: AiProfile) -> AiProfile {
    p.id = p.id.trim().to_string();
    p.name = p.name.trim().to_string();
    if p.provider.trim().is_empty() {
        p.provider = "openai-compatible".to_string();
    }
    p.base_url = p.base_url.trim().trim_end_matches('/').to_string();
    if p.base_url.is_empty() && p.provider == "openai" {
        p.base_url = "https://api.openai.com/v1".to_string();
    }
    p.model = p.model.trim().to_string();
    if p.name.is_empty() {
        p.name = if !p.model.is_empty() {
            p.model.clone()
        } else {
            p.provider.clone()
        };
    }
    p
}

fn normalize_ai_store(mut store: AiConfigStore) -> AiConfigStore {
    store.version = AI_STORE_VERSION;
    store.profiles = store
        .profiles
        .into_iter()
        .map(normalize_ai_profile)
        .filter(|p| !p.id.is_empty())
        .collect();
    if !store
        .profiles
        .iter()
        .any(|p| p.id == store.active_profile_id)
    {
        store.active_profile_id = store
            .profiles
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_default();
    }
    store
}

fn ai_config_path() -> Result<PathBuf, String> {
    Ok(zeroterm_config_dir()?.join(AI_CONFIG_FILE))
}

fn ai_session_path() -> Result<PathBuf, String> {
    Ok(zeroterm_config_dir()?.join(AI_SESSION_FILE))
}

fn network_proxy_path() -> Result<PathBuf, String> {
    Ok(zeroterm_config_dir()?.join(NETWORK_PROXY_FILE))
}

fn validate_network_proxy_url(url: &str) -> Result<String, String> {
    let raw = url.trim();
    if raw.is_empty() {
        return Err("Proxy URL cannot be empty.".to_string());
    }
    let parsed = reqwest::Url::parse(raw).map_err(|e| format!("Invalid proxy URL: {e}"))?;
    if parsed.scheme() != "http" {
        return Err("Only http:// proxy URLs are supported right now.".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("Proxy URL must include a host.".to_string());
    }
    if parsed.port_or_known_default().is_none() {
        return Err("Proxy URL must include a valid port.".to_string());
    }
    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(
            "Proxy URL should only include scheme, host, port, and optional username/password."
                .to_string(),
        );
    }
    Ok(parsed.to_string())
}

/// Split a validated proxy URL into `(sanitized_url, credentialed_url)`.
///
/// The sanitized URL carries only scheme/host/port and is the only form ever
/// written to `network-proxy.json`. When the input embeds a username/password,
/// the full credentialed URL is returned separately so the caller can stash it
/// in the OS keychain (never on disk). See TAURI-3.
fn split_proxy_userinfo(validated_url: &str) -> Result<(String, Option<String>), String> {
    let parsed =
        reqwest::Url::parse(validated_url).map_err(|e| format!("Invalid proxy URL: {e}"))?;
    let has_userinfo = !parsed.username().is_empty() || parsed.password().is_some();
    let credentialed = has_userinfo.then(|| parsed.to_string());
    let mut sanitized = parsed;
    // These only fail for cannot-be-a-base URLs; http proxies never are.
    let _ = sanitized.set_username("");
    let _ = sanitized.set_password(None);
    Ok((sanitized.to_string(), credentialed))
}

fn normalize_network_proxy_config(
    mut cfg: NetworkProxyConfig,
) -> Result<NetworkProxyConfig, String> {
    cfg.enabled = true;
    let validated = validate_network_proxy_url(&cfg.url)?;
    // Never let userinfo survive into the on-disk / frontend-facing config.
    let (sanitized, _credentialed) = split_proxy_userinfo(&validated)?;
    cfg.url = sanitized;
    Ok(cfg)
}

fn read_network_proxy_from_disk() -> Result<Option<NetworkProxyConfig>, String> {
    let path = network_proxy_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let raw: NetworkProxyConfig =
        serde_json::from_str(&text).map_err(|e| format!("parsing {}: {e}", path.display()))?;
    if !raw.enabled || raw.url.trim().is_empty() {
        return Ok(None);
    }
    normalize_network_proxy_config(raw).map(Some)
}

fn write_network_proxy_to_disk(cfg: &NetworkProxyConfig) -> Result<(), String> {
    let path = network_proxy_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// The proxy URL to actually use for outbound requests: scheme/host/port from
/// disk recombined with the credential from the OS keychain (if any). Returns
/// `None` when no proxy is configured.
fn effective_network_proxy_url() -> Option<String> {
    let cfg = read_network_proxy_from_disk().ok().flatten()?;
    let sanitized = reqwest::Url::parse(cfg.url.trim()).ok()?;
    match zeroterm_app::keychain::get_sync_backend_credential(NETWORK_PROXY_KEYCHAIN_ID) {
        Ok(Some(full)) => match reqwest::Url::parse(full.trim()) {
            // Only apply the stored credential if it still targets the same
            // proxy origin recorded on disk — guards a tampered disk file from
            // redirecting the credential to a different host.
            Ok(full_url)
                if full_url.scheme() == sanitized.scheme()
                    && full_url.host_str() == sanitized.host_str()
                    && full_url.port_or_known_default() == sanitized.port_or_known_default() =>
            {
                Some(full_url.to_string())
            }
            _ => Some(sanitized.to_string()),
        },
        _ => Some(sanitized.to_string()),
    }
}

/// Push the current effective proxy into the process-global store that both
/// the SSH layer and our reqwest clients read. Unlike the old code this never
/// touches `*_PROXY` environment variables, which race reqwest's env reads on
/// other threads (glibc `setenv`/`getenv` data race → possible crash). See
/// TAURI-2.
fn apply_network_proxy_config() {
    zeroterm_ssh::set_global_http_proxy(effective_network_proxy_url());
}

/// Build a reqwest client that honours the configured proxy from our
/// in-process store and ignores ambient `*_PROXY` env vars. Every desktop
/// reqwest client must be built through here so proxy state lives in-process
/// rather than in racy process-wide env vars (TAURI-2).
fn build_http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().no_proxy().timeout(timeout);
    if let Some(proxy_url) = zeroterm_ssh::current_http_proxy() {
        let proxy = reqwest::Proxy::all(proxy_url.as_str())
            .map_err(|e| format!("invalid proxy configuration: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder.build().map_err(|e| e.to_string())
}

/// One-time migration: older builds wrote `http://user:pass@host:port`
/// straight into `network-proxy.json`. Move any such credential into the
/// keychain and rewrite the file with only scheme/host/port.
fn migrate_legacy_cleartext_proxy_credential() {
    let path = match network_proxy_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    if !path.exists() {
        return;
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let raw: NetworkProxyConfig = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    if raw.url.trim().is_empty() {
        return;
    }
    let validated = match validate_network_proxy_url(&raw.url) {
        Ok(v) => v,
        Err(_) => return,
    };
    let (sanitized, credentialed) = match split_proxy_userinfo(&validated) {
        Ok(v) => v,
        Err(_) => return,
    };
    if let Some(full) = credentialed {
        if zeroterm_app::keychain::save_sync_backend_credential(NETWORK_PROXY_KEYCHAIN_ID, &full)
            .is_ok()
        {
            let cfg = NetworkProxyConfig {
                enabled: raw.enabled,
                url: sanitized,
            };
            let _ = write_network_proxy_to_disk(&cfg);
            tracing::info!(
                "migrated cleartext proxy credential from network-proxy.json into the OS keychain"
            );
        }
    }
}

pub fn apply_saved_network_proxy_config() -> Result<Option<NetworkProxyConfig>, String> {
    migrate_legacy_cleartext_proxy_credential();
    apply_network_proxy_config();
    read_network_proxy_from_disk()
}

#[tauri::command]
pub async fn get_network_proxy_config() -> Result<Option<NetworkProxyConfig>, String> {
    read_network_proxy_from_disk()
}

#[tauri::command]
pub async fn save_network_proxy_config(
    input: NetworkProxyConfig,
) -> Result<NetworkProxyConfig, String> {
    let validated = validate_network_proxy_url(&input.url)?;
    let (sanitized, credentialed) = split_proxy_userinfo(&validated)?;
    let cfg = NetworkProxyConfig {
        enabled: true,
        url: sanitized,
    };
    // Stash the credential (if any) in the keychain first, and clear any
    // stale one when the new URL has no userinfo — so the two never drift.
    match &credentialed {
        Some(full) => {
            zeroterm_app::keychain::save_sync_backend_credential(NETWORK_PROXY_KEYCHAIN_ID, full)
                .map_err(|e| format!("saving proxy credential to keychain: {e}"))?;
        }
        None => {
            let _ =
                zeroterm_app::keychain::forget_sync_backend_credential(NETWORK_PROXY_KEYCHAIN_ID);
        }
    }
    write_network_proxy_to_disk(&cfg)?;
    apply_network_proxy_config();
    Ok(cfg)
}

#[tauri::command]
pub async fn clear_network_proxy_config() -> Result<(), String> {
    let path = network_proxy_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
    }
    let _ = zeroterm_app::keychain::forget_sync_backend_credential(NETWORK_PROXY_KEYCHAIN_ID);
    apply_network_proxy_config();
    Ok(())
}

fn normalize_ai_config(mut cfg: AiConfig) -> AiConfig {
    if cfg.provider.trim().is_empty() {
        cfg.provider = "openai-compatible".to_string();
    }
    cfg.base_url = cfg.base_url.trim().trim_end_matches('/').to_string();
    if cfg.base_url.is_empty() && cfg.provider == "openai" {
        cfg.base_url = "https://api.openai.com/v1".to_string();
    }
    if cfg.model.trim().is_empty() {
        cfg.model = "gpt-4.1".to_string();
    } else {
        cfg.model = cfg.model.trim().to_string();
    }
    cfg
}

fn read_ai_store_from_disk() -> Result<AiConfigStore, String> {
    let path = ai_config_path()?;
    if !path.exists() {
        return Ok(default_ai_store());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parsing {}: {e}", path.display()))?;

    // New schema (v2) is keyed by a `profiles` array.
    if value.get("profiles").is_some() {
        let store: AiConfigStore = serde_json::from_value(value)
            .map_err(|e| format!("parsing {}: {e}", path.display()))?;
        return Ok(normalize_ai_store(store));
    }

    // Legacy single-config file -> migrate to a one-profile store. The legacy
    // API key already lives in the keychain under AI_KEYCHAIN_PROFILE
    // ("default"), so reusing that id as the migrated profile id preserves it.
    let legacy = normalize_ai_config(
        serde_json::from_value::<AiConfig>(value)
            .map_err(|e| format!("parsing {}: {e}", path.display()))?,
    );
    let store = normalize_ai_store(AiConfigStore {
        version: AI_STORE_VERSION,
        profiles: vec![AiProfile {
            id: AI_KEYCHAIN_PROFILE.to_string(),
            name: legacy_profile_name(&legacy),
            provider: legacy.provider,
            base_url: legacy.base_url,
            model: legacy.model,
            models: Vec::new(),
            has_api_key: false,
            reasoning_effort: String::new(),
        }],
        active_profile_id: AI_KEYCHAIN_PROFILE.to_string(),
        safe_mode: legacy.safe_mode,
        auto_read: legacy.auto_read,
        show_commands: legacy.show_commands,
    });
    write_ai_store_to_disk(&store)?;
    Ok(store)
}

fn write_ai_store_to_disk(store: &AiConfigStore) -> Result<(), String> {
    let path = ai_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))
}

/// Fill each profile's `has_api_key` from the keychain (never returns secrets).
fn store_with_key_flags(mut store: AiConfigStore) -> AiConfigStore {
    for p in store.profiles.iter_mut() {
        p.has_api_key = zeroterm_app::keychain::get_ai_api_key(&p.id)
            .ok()
            .flatten()
            .is_some();
    }
    store
}

/// Send an AI API request, retrying up to 3 times on HTTP 429.
///
/// Honors the `Retry-After` response header (interpreted as whole
/// seconds) when present; otherwise uses exponential backoff
/// (1s → 2s → 4s). Transport errors and other non-success statuses
/// are terminal — they surface to the caller unchanged so existing
/// error messages stay intact.
async fn send_ai_request_with_retry(
    builder: reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    const MAX_RETRIES: usize = 3;
    let mut attempt = 0usize;
    loop {
        // Clone the builder so we can re-issue on 429. JSON request
        // bodies are cloneable, so this always succeeds for our calls;
        // the None branch is a defensive fallback for non-cloneable
        // bodies (single attempt, no retry).
        let req = match builder.try_clone() {
            Some(r) => r,
            None => return builder.send().await,
        };
        match req.send().await {
            Ok(resp) => {
                if resp.status() != reqwest::StatusCode::TOO_MANY_REQUESTS || attempt >= MAX_RETRIES
                {
                    return Ok(resp);
                }
                let backoff = match attempt {
                    0 => Duration::from_secs(1),
                    1 => Duration::from_secs(2),
                    _ => Duration::from_secs(4),
                };
                let delay = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(backoff);
                // Drain the 429 body so the connection can be reused.
                let _ = resp.text().await;
                warn!(
                    attempt = attempt + 1,
                    delay_ms = delay.as_millis() as u64,
                    "AI request rate-limited (429), retrying"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

async fn fetch_ai_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));
    let client = build_http_client(Duration::from_secs(30))?;
    let response = send_ai_request_with_retry(client.get(endpoint).bearer_auth(api_key))
        .await
        .map_err(|e| format!("AI model request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("reading AI model response failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI model request failed ({status}): {body}"));
    }
    let parsed: OpenAiModelsResponse = serde_json::from_str(&body)
        .map_err(|e| format!("parsing AI model response failed: {e}"))?;
    let mut models: Vec<String> = parsed
        .data
        .into_iter()
        .map(|m| m.id)
        .filter(|id| !id.trim().is_empty())
        .collect();
    models.sort();
    models.dedup();
    Ok(models)
}

fn normalize_ai_session_item(mut item: AiSessionItem) -> Option<AiSessionItem> {
    item.id = item.id.trim().to_string();
    if item.id.is_empty() {
        return None;
    }
    item.title = item.title.trim().to_string();
    if item.title.is_empty() {
        item.title = item
            .messages
            .iter()
            .find(|m| m.role == "user" && !m.content.trim().is_empty())
            .map(|m| m.content.trim().chars().take(48).collect())
            .unwrap_or_else(|| "New chat".to_string());
    }
    item.scope_type = match item.scope_type.trim() {
        "host" => "host".to_string(),
        "local" => "local".to_string(),
        _ => "global".to_string(),
    };
    item.scope_id = item.scope_id.trim().to_string();
    if item.scope_id.is_empty() {
        item.scope_id = item.scope_type.clone();
    }
    item.scope_label = item.scope_label.trim().to_string();
    if item.scope_label.is_empty() {
        item.scope_label = match item.scope_type.as_str() {
            "host" => "SSH 主机".to_string(),
            "local" => "本地终端".to_string(),
            _ => "全局".to_string(),
        };
    }
    item.messages = item
        .messages
        .into_iter()
        .filter_map(|mut m| {
            m.role = match m.role.trim() {
                "assistant" => "assistant".to_string(),
                "user" => "user".to_string(),
                "error" => "error".to_string(),
                _ => return None,
            };
            m.content = m.content.trim().to_string();
            if m.content.is_empty() {
                return None;
            }
            m.command_results = m
                .command_results
                .into_iter()
                .filter_map(|mut result| {
                    result.command = result.command.trim().to_string();
                    result.output = result.output.trim().to_string();
                    if result.command.is_empty() {
                        return None;
                    }
                    Some(result)
                })
                .collect();
            Some(m)
        })
        .collect();
    if item.messages.is_empty() {
        return None;
    }
    if item.created_at == 0 {
        item.created_at = item.updated_at;
    }
    if item.updated_at == 0 {
        item.updated_at = item.created_at;
    }
    Some(item)
}

/// Magic header marking an encrypted AI-session file (TAURI-7). Legacy
/// plaintext files start with `[` (a JSON array), so the two are trivially
/// distinguishable and old files keep loading.
const AI_SESSION_ENC_MAGIC: &[u8] = b"ZTAIENC1\n";
/// Vault blob context (AAD + subkey salt) for AI session history.
const AI_SESSION_BLOB_CONTEXT: &str = "ai-sessions";

/// True if `id`'s vault is unlocked; returns an owned handle so we don't
/// hold the state mutex across file IO.
fn optional_app(state: &State<'_, AppState>) -> Option<Arc<zeroterm_app::App>> {
    state
        .app
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn read_ai_sessions_from_disk(app: Option<&zeroterm_app::App>) -> Result<Vec<AiSessionItem>, String> {
    let path = ai_session_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;

    // Decrypt if the file is in the encrypted format; otherwise treat it
    // as legacy cleartext JSON (and it'll be re-encrypted on the next
    // write, once the vault is unlocked).
    let json: Vec<u8> = if bytes.starts_with(AI_SESSION_ENC_MAGIC) {
        // Encrypted: need the unlocked vault. If it's locked, treat as
        // "not available yet" (empty) rather than erroring the UI — the
        // history loads once the user unlocks.
        let Some(app) = app else {
            return Ok(Vec::new());
        };
        app.decrypt_local_blob(AI_SESSION_BLOB_CONTEXT, &bytes[AI_SESSION_ENC_MAGIC.len()..])
            .map_err(|e| format!("decrypting AI history: {e}"))?
    } else {
        bytes
    };

    let raw: Vec<AiSessionItem> =
        serde_json::from_slice(&json).map_err(|e| format!("parsing {}: {e}", path.display()))?;
    let mut items: Vec<_> = raw
        .into_iter()
        .filter_map(normalize_ai_session_item)
        .collect();
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    items.truncate(AI_SESSION_MAX_ITEMS);
    Ok(items)
}

/// Write `contents` to `path`, truncating any existing file, and restrict the
/// result to owner read/write (`0600`) on Unix. On other platforms this is a
/// plain create+truncate write. Used for cleartext-but-sensitive config files.
fn write_private_file(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    // `mode()` only applies when the file is newly created; normalise an
    // existing file's permissions too.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(contents)
}

/// Persist AI sessions to `ai-sessions.json`.
///
/// TAURI-7 / FE-5: this file holds the full conversation history plus
/// `command_results` (commands and their output), which can contain
/// secrets. When the vault is unlocked it's sealed under the vault master
/// key via `App::encrypt_local_blob` (a magic-prefixed `nonce||ciphertext`
/// blob). If the vault is locked, refuse the write: owner-only permissions
/// are useful defence in depth, but do not meet the vault's at-rest
/// encryption guarantee. The read path still accepts legacy cleartext so it
/// can be transparently upgraded on the first write after unlock.
fn write_ai_sessions_to_disk(
    items: &[AiSessionItem],
    app: Option<&zeroterm_app::App>,
) -> Result<(), String> {
    let path = ai_session_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;

    match app {
        Some(app) => {
            let blob = app
                .encrypt_local_blob(AI_SESSION_BLOB_CONTEXT, text.as_bytes())
                .map_err(|e| format!("encrypting AI history: {e}"))?;
            let mut out = Vec::with_capacity(AI_SESSION_ENC_MAGIC.len() + blob.len());
            out.extend_from_slice(AI_SESSION_ENC_MAGIC);
            out.extend_from_slice(&blob);
            write_private_file(&path, &out)
                .map_err(|e| format!("writing {}: {e}", path.display()))
        }
        None => Err("vault is locked; refusing to persist AI history as plaintext".to_string()),
    }
}

// --------------------------------------------------------------------------
// background image
// --------------------------------------------------------------------------
//
// The user-picked image is copied into `config_dir/ZeroTerm/` under a
// fixed stem so there's only ever one. We hand the frontend a base64
// data URL (rather than an asset:// path) to dodge per-path fs scope
// permissions and CSP `img-src`/`background` restrictions — the webview
// can always render a `data:` URL the app itself produced.

const BACKGROUND_IMAGE_STEM: &str = "background";
/// Reject absurdly large images so we don't blow up the webview with a
/// giant base64 string. 16 MiB is plenty for a desktop backdrop.
const BACKGROUND_IMAGE_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn background_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .ok_or_else(|| "no config directory on this OS".to_string())
        .map(|d| d.join("ZeroTerm"))
}

/// Locate an existing background image regardless of which extension it
/// was saved with.
fn find_background_image() -> Result<Option<PathBuf>, String> {
    let dir = background_dir()?;
    for ext in ["png", "jpg", "jpeg", "webp", "gif"] {
        let candidate = dir.join(format!("{BACKGROUND_IMAGE_STEM}.{ext}"));
        if candidate.exists() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

fn encode_data_url(bytes: &[u8], ext: &str) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{};base64,{}", mime_for_ext(ext), b64)
}

/// Copy the picked image into the app config dir and return it as a
/// base64 `data:` URL for immediate display. Any previously saved
/// background (with a different extension) is removed first.
#[tauri::command]
pub async fn set_background_image(path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| matches!(e.as_str(), "png" | "jpg" | "jpeg" | "webp" | "gif"))
        .ok_or_else(|| "unsupported image type (use PNG, JPG, WEBP or GIF)".to_string())?;

    let metadata = tokio::fs::metadata(&src)
        .await
        .map_err(|e| format!("reading {}: {e}", src.display()))?;
    if metadata.len() > BACKGROUND_IMAGE_MAX_BYTES {
        return Err(format!(
            "image is {:.1} MB, above the {} MB limit",
            metadata.len() as f64 / (1024.0 * 1024.0),
            BACKGROUND_IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let bytes = tokio::fs::read(&src)
        .await
        .map_err(|e| format!("reading {}: {e}", src.display()))?;

    let dir = background_dir()?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("creating {}: {e}", dir.display()))?;
    // Drop any previously saved background under a different extension.
    if let Some(existing) = find_background_image()? {
        let _ = tokio::fs::remove_file(existing).await;
    }
    let dest = dir.join(format!("{BACKGROUND_IMAGE_STEM}.{ext}"));
    tokio::fs::write(&dest, &bytes)
        .await
        .map_err(|e| format!("writing {}: {e}", dest.display()))?;

    Ok(encode_data_url(&bytes, &ext))
}

/// Read the saved background image back as a base64 `data:` URL, or
/// `None` if the user hasn't set one.
#[tauri::command]
pub async fn get_background_image() -> Result<Option<String>, String> {
    let Some(path) = find_background_image()? else {
        return Ok(None);
    };
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string();
    let bytes = fs::read(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    Ok(Some(encode_data_url(&bytes, &ext)))
}

/// Remove any saved background image.
#[tauri::command]
pub async fn clear_background_image() -> Result<(), String> {
    if let Some(path) = find_background_image()? {
        fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
    }
    Ok(())
}

// --------------------------------------------------------------------------
// startup window size
// --------------------------------------------------------------------------
//
// The user can save the current window size as the size the app opens at.
// We persist a *logical* (DPI-independent) size to `config_dir/ZeroTerm/
// window.json`; the `setup` hook in `lib.rs` reads it back before the window
// is shown, so there's no resize flash on launch. Doing the read/write in
// Rust (rather than the JS window API) keeps it DPI-correct and needs no
// extra `core:window:*` capability entries.

/// Minimum startup size, kept in sync with `minWidth`/`minHeight` in
/// `tauri.conf.json` so a saved size never opens smaller than the window
/// is actually allowed to be.
const WINDOW_MIN_W: f64 = 700.0;
const WINDOW_MIN_H: f64 = 480.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowSizeSetting {
    pub width: f64,
    pub height: f64,
}

fn window_state_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "no config directory on this OS".to_string())?
        .join("ZeroTerm");
    Ok(base.join("window.json"))
}

/// Clamp a logical size up to the configured minimum so we never persist
/// (or restore) something smaller than the window can be.
fn clamp_window_size(width: f64, height: f64) -> WindowSizeSetting {
    WindowSizeSetting {
        width: width.max(WINDOW_MIN_W),
        height: height.max(WINDOW_MIN_H),
    }
}

/// Read the saved startup size as a plain `(width, height)` logical pair,
/// or `None` if nothing valid is saved. Called by the `setup` hook in
/// `lib.rs`; deliberately infallible — a missing or corrupt file just means
/// "fall back to the default size".
pub fn read_startup_window_size() -> Option<(f64, f64)> {
    let path = window_state_path().ok()?;
    let text = fs::read_to_string(&path).ok()?;
    let saved: WindowSizeSetting = serde_json::from_str(&text).ok()?;
    if !saved.width.is_finite() || !saved.height.is_finite() {
        return None;
    }
    let s = clamp_window_size(saved.width, saved.height);
    Some((s.width, s.height))
}

/// Save the current window's inner size as the startup size. The physical
/// inner size is converted to logical via the scale factor so it restores
/// consistently across monitors with different DPI. Runs synchronously on
/// the main thread, which is also where window introspection is safest.
#[tauri::command]
pub fn save_window_size(window: tauri::WebviewWindow) -> Result<WindowSizeSetting, String> {
    let scale = window
        .scale_factor()
        .map_err(|e| format!("reading scale factor: {e}"))?;
    let phys = window
        .inner_size()
        .map_err(|e| format!("reading window size: {e}"))?;
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let setting = clamp_window_size(phys.width as f64 / scale, phys.height as f64 / scale);

    let path = window_state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&setting).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))?;
    Ok(setting)
}

/// Return the saved startup size, or `None` if the user hasn't set one. A
/// corrupt file is treated as "no setting" rather than a hard error.
#[tauri::command]
pub fn get_window_size_setting() -> Result<Option<WindowSizeSetting>, String> {
    let path = window_state_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    match serde_json::from_str::<WindowSizeSetting>(&text) {
        Ok(s) if s.width.is_finite() && s.height.is_finite() => {
            Ok(Some(clamp_window_size(s.width, s.height)))
        }
        _ => Ok(None),
    }
}

/// Forget the saved startup size; the app falls back to the default.
#[tauri::command]
pub fn clear_window_size_setting() -> Result<(), String> {
    let path = window_state_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("removing {}: {e}", path.display()))?;
    }
    Ok(())
}

fn prepare_ai_request(
    messages: Vec<AiChatMessage>,
    profile_id: Option<String>,
) -> Result<(AiProfile, String, Vec<serde_json::Value>), String> {
    let store = read_ai_store_from_disk()?;
    let id = profile_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| store.active_profile_id.clone());
    let profile = store
        .profiles
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "No AI profile is selected. Configure one in Settings > AI.".to_string())?;
    if profile.provider != "openai-compatible" && profile.provider != "openai" {
        return Err("This preview only supports OpenAI-compatible APIs for now.".into());
    }
    if profile.base_url.trim().is_empty() {
        return Err("AI Base URL is not configured. Set it in Settings > AI.".into());
    }
    if messages.is_empty() {
        return Err("message is empty".into());
    }

    let api_key = zeroterm_app::keychain::get_ai_api_key(&profile.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "AI API Key is not configured.".to_string())?;

    let payload_messages: Vec<_> = messages
        .into_iter()
        .filter_map(|m| {
            let role = m.role.trim();
            let content = m.content.trim();
            if content.is_empty() {
                return None;
            }
            let role = match role {
                "system" | "assistant" | "user" => role,
                _ => "user",
            };
            Some(json!({ "role": role, "content": content }))
        })
        .collect();
    if payload_messages.is_empty() {
        return Err("message is empty".into());
    }
    Ok((profile, api_key, payload_messages))
}

fn emit_ai_stream(app: &AppHandle, event: AiStreamEvent) {
    let _ = app.emit("ai:stream", event);
}

fn emit_ai_stream_error(app: &AppHandle, request_id: &str, error: String) {
    emit_ai_stream(
        app,
        AiStreamEvent {
            request_id: request_id.to_string(),
            delta: String::new(),
            reasoning_delta: String::new(),
            done: true,
            error: Some(error),
        },
    );
}

fn take_ai_request_canceled(request_id: &str) -> bool {
    canceled_ai_requests().lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(request_id)
}

fn parse_sse_frames(buffer: &mut String) -> Vec<String> {
    let mut frames = Vec::new();
    while let Some((idx, len)) = buffer
        .find("\r\n\r\n")
        .map(|i| (i, 4))
        .or_else(|| buffer.find("\n\n").map(|i| (i, 2)))
    {
        let frame = buffer[..idx].replace("\r\n", "\n");
        buffer.drain(..idx + len);
        frames.push(frame);
    }
    frames
}

fn parse_sse_frame_payloads(frame: &str) -> Vec<String> {
    frame
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if !line.starts_with("data:") {
                return None;
            }
            Some(line.trim_start_matches("data:").trim().to_string())
        })
        .collect()
}

/// Appends a byte chunk to `buffer` as UTF-8. A multi-byte sequence split at
/// the chunk boundary stays in `carry` (≤3 bytes) until the next chunk
/// completes it; definitely-invalid bytes are decoded lossily so a corrupt
/// stream keeps flowing instead of stalling.
fn push_utf8_chunk(buffer: &mut String, carry: &mut Vec<u8>, chunk: &[u8]) {
    carry.extend_from_slice(chunk);
    match std::str::from_utf8(carry) {
        Ok(text) => {
            buffer.push_str(text);
            carry.clear();
        }
        Err(e) if e.error_len().is_none() => {
            let valid = e.valid_up_to();
            buffer.push_str(std::str::from_utf8(&carry[..valid]).unwrap());
            carry.drain(..valid);
        }
        Err(_) => {
            buffer.push_str(&String::from_utf8_lossy(carry));
            carry.clear();
        }
    }
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    let exists = App::vault_exists(&path);
    let unlocked = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_some();
    Ok(VaultStatus {
        path: path.display().to_string(),
        exists,
        unlocked,
    })
}

#[tauri::command]
pub async fn get_ai_config() -> Result<AiConfigStore, String> {
    Ok(store_with_key_flags(read_ai_store_from_disk()?))
}

#[tauri::command]
pub async fn save_ai_profile(input: SaveAiProfileInput) -> Result<AiConfigStore, String> {
    let mut store = read_ai_store_from_disk()?;
    let mut id = input.id.trim().to_string();
    if id.is_empty() {
        id = generate_profile_id();
    }
    let mut profile = normalize_ai_profile(AiProfile {
        id,
        name: input.name,
        provider: input.provider,
        base_url: input.base_url,
        model: input.model,
        models: input.models,
        has_api_key: false,
        reasoning_effort: input.reasoning_effort,
    });

    let api_key = input.api_key.trim();
    if !api_key.is_empty() {
        zeroterm_app::keychain::save_ai_api_key(&profile.id, api_key).map_err(|e| e.to_string())?;
    }

    if let Some(existing) = store.profiles.iter_mut().find(|p| p.id == profile.id) {
        // Preserve the cached model list when the caller didn't send one.
        if profile.models.is_empty() {
            profile.models = existing.models.clone();
        }
        *existing = profile.clone();
    } else {
        store.profiles.push(profile.clone());
    }
    if store.active_profile_id.trim().is_empty() {
        store.active_profile_id = profile.id.clone();
    }

    let store = normalize_ai_store(store);
    write_ai_store_to_disk(&store)?;
    Ok(store_with_key_flags(store))
}

#[tauri::command]
pub async fn delete_ai_profile(id: String) -> Result<AiConfigStore, String> {
    let id = id.trim().to_string();
    let mut store = read_ai_store_from_disk()?;
    let before = store.profiles.len();
    store.profiles.retain(|p| p.id != id);
    if store.profiles.len() != before {
        let _ = zeroterm_app::keychain::forget_ai_api_key(&id);
    }
    if store.active_profile_id == id {
        store.active_profile_id = store
            .profiles
            .first()
            .map(|p| p.id.clone())
            .unwrap_or_default();
    }
    let store = normalize_ai_store(store);
    write_ai_store_to_disk(&store)?;
    Ok(store_with_key_flags(store))
}

#[tauri::command]
pub async fn set_active_ai_profile(id: String) -> Result<AiConfigStore, String> {
    let id = id.trim().to_string();
    let mut store = read_ai_store_from_disk()?;
    if store.profiles.iter().any(|p| p.id == id) {
        store.active_profile_id = id;
    }
    let store = normalize_ai_store(store);
    write_ai_store_to_disk(&store)?;
    Ok(store_with_key_flags(store))
}

#[tauri::command]
pub async fn set_ai_profile_model(input: SetAiProfileModelInput) -> Result<AiConfigStore, String> {
    let id = input.id.trim().to_string();
    let model = input.model.trim().to_string();
    let mut store = read_ai_store_from_disk()?;
    if let Some(p) = store.profiles.iter_mut().find(|p| p.id == id) {
        if !model.is_empty() {
            p.model = model;
        }
    }
    let store = normalize_ai_store(store);
    write_ai_store_to_disk(&store)?;
    Ok(store_with_key_flags(store))
}

#[tauri::command]
pub async fn list_ai_sessions(state: State<'_, AppState>) -> Result<Vec<AiSessionItem>, String> {
    let app = optional_app(&state);
    read_ai_sessions_from_disk(app.as_deref())
}

#[tauri::command]
pub async fn save_ai_session(
    state: State<'_, AppState>,
    input: SaveAiSessionInput,
) -> Result<AiSessionItem, String> {
    let item = normalize_ai_session_item(AiSessionItem {
        id: input.id,
        title: input.title,
        created_at: input.created_at,
        updated_at: input.updated_at,
        pane_key: input.pane_key,
        scope_type: input.scope_type,
        scope_id: input.scope_id,
        scope_label: input.scope_label,
        messages: input.messages,
    })
    .ok_or_else(|| "AI session is empty".to_string())?;

    let app = optional_app(&state);
    let mut items = read_ai_sessions_from_disk(app.as_deref())?;
    items.retain(|existing| existing.id != item.id);
    items.insert(0, item.clone());
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    items.truncate(AI_SESSION_MAX_ITEMS);
    write_ai_sessions_to_disk(&items, app.as_deref())?;
    Ok(item)
}

#[tauri::command]
pub async fn delete_ai_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let app = optional_app(&state);
    let mut items = read_ai_sessions_from_disk(app.as_deref())?;
    let before = items.len();
    items.retain(|item| item.id != id);
    if items.len() != before {
        write_ai_sessions_to_disk(&items, app.as_deref())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_ai_sessions(state: State<'_, AppState>) -> Result<(), String> {
    write_ai_sessions_to_disk(&[], optional_app(&state).as_deref())
}

#[tauri::command]
pub async fn clear_ai_sessions_for_scope(
    state: State<'_, AppState>,
    input: ClearAiSessionsForScopeInput,
) -> Result<(), String> {
    let scope_type = input.scope_type.trim();
    let scope_id = input.scope_id.trim();
    if scope_type.is_empty() || scope_id.is_empty() {
        return Ok(());
    }
    let app = optional_app(&state);
    let mut items = read_ai_sessions_from_disk(app.as_deref())?;
    let before = items.len();
    items.retain(|item| item.scope_type != scope_type || item.scope_id != scope_id);
    if items.len() != before {
        write_ai_sessions_to_disk(&items, app.as_deref())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_ai_models(input: SaveAiConfigInput) -> Result<AiModelListResponse, String> {
    let cfg = normalize_ai_config(AiConfig {
        provider: input.provider,
        base_url: input.base_url,
        model: input.model,
        safe_mode: input.safe_mode,
        auto_read: input.auto_read,
        show_commands: input.show_commands,
        has_api_key: false,
    });
    if cfg.provider != "openai-compatible" && cfg.provider != "openai" {
        return Err("This preview only supports OpenAI-compatible APIs for now.".into());
    }
    if cfg.base_url.trim().is_empty() {
        return Err("AI Base URL is not configured.".into());
    }
    let api_key = input.api_key.trim();
    if api_key.is_empty() {
        return Err("AI API Key is not configured.".into());
    }
    let models = fetch_ai_models(&cfg.base_url, api_key).await?;
    Ok(AiModelListResponse { models })
}

/// List models for an already-saved profile, using its keychain API key, and
/// cache the result into the profile (used by the header pill's "refresh").
#[tauri::command]
pub async fn list_ai_models_for_profile(id: String) -> Result<AiModelListResponse, String> {
    let id = id.trim().to_string();
    let mut store = read_ai_store_from_disk()?;
    let profile = store
        .profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| "AI profile not found.".to_string())?;
    if profile.provider != "openai-compatible" && profile.provider != "openai" {
        return Err("This preview only supports OpenAI-compatible APIs for now.".into());
    }
    if profile.base_url.trim().is_empty() {
        return Err("AI Base URL is not configured.".into());
    }
    let api_key = zeroterm_app::keychain::get_ai_api_key(&profile.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "AI API Key is not configured.".to_string())?;
    let models = fetch_ai_models(&profile.base_url, &api_key).await?;
    if let Some(p) = store.profiles.iter_mut().find(|p| p.id == id) {
        p.models = models.clone();
    }
    let store = normalize_ai_store(store);
    write_ai_store_to_disk(&store)?;
    Ok(AiModelListResponse { models })
}

static TOOL_CHOICE_COMPAT_PROFILES: OnceLock<StdMutex<HashSet<String>>> = OnceLock::new();

/// Profiles whose upstream requires the tool_choice compat body (see
/// apply_tool_choice_compat). Remembered in-memory after the first successful
/// compat retry so later requests skip the failing round trip.
fn tool_choice_compat_profiles() -> &'static StdMutex<HashSet<String>> {
    TOOL_CHOICE_COMPAT_PROFILES.get_or_init(|| StdMutex::new(HashSet::new()))
}

/// Some gateways inject a `tool_choice` while converting requests for certain
/// upstreams, which the upstream then rejects because we send no `tools`.
/// Detects that rejection so the request can be retried with the compat body.
fn needs_tool_choice_compat(status: reqwest::StatusCode, body: &str) -> bool {
    status.is_client_error() && body.contains("tool_choice")
}

/// Makes the request valid for gateways that force a `tool_choice`: declares a
/// placeholder tool (so tools are never "unspecified") and explicitly opts out
/// of calling it, which keeps the model in plain-chat behaviour.
fn apply_tool_choice_compat(body: &mut serde_json::Value) {
    body["tools"] = json!([{
        "type": "function",
        "function": {
            "name": "noop",
            "description": "Placeholder. Never call this tool.",
            "parameters": { "type": "object", "properties": {} }
        }
    }]);
    body["tool_choice"] = json!("none");
}

#[tauri::command]
pub async fn ai_chat(
    messages: Vec<AiChatMessage>,
    profile_id: Option<String>,
) -> Result<AiChatResponse, String> {
    let (profile, api_key, payload_messages) = prepare_ai_request(messages, profile_id)?;
    let endpoint = format!(
        "{}/chat/completions",
        profile.base_url.trim_end_matches('/')
    );
    let client = build_http_client(Duration::from_secs(90))?;
    let mut body = json!({
        "model": profile.model,
        "messages": payload_messages,
        "temperature": 0.2,
    });
    if !profile.reasoning_effort.is_empty() {
        body["reasoning_effort"] = json!(profile.reasoning_effort);
    }
    let mut compat_applied = tool_choice_compat_profiles()
        .lock()
        .unwrap()
        .contains(&profile.id);
    if compat_applied {
        apply_tool_choice_compat(&mut body);
    }
    let mut response =
        send_ai_request_with_retry(client.post(&endpoint).bearer_auth(&api_key).json(&body))
            .await
            .map_err(|e| format!("AI request failed: {e}"))?;

    if !response.status().is_success() && !compat_applied {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        if !needs_tool_choice_compat(status, &err_body) {
            return Err(format!("AI request failed ({status}): {err_body}"));
        }
        apply_tool_choice_compat(&mut body);
        compat_applied = true;
        response =
            send_ai_request_with_retry(client.post(&endpoint).bearer_auth(&api_key).json(&body))
                .await
                .map_err(|e| format!("AI request failed: {e}"))?;
    }

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("reading AI response failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI request failed ({status}): {body}"));
    }
    if compat_applied {
        tool_choice_compat_profiles()
            .lock()
            .unwrap()
            .insert(profile.id.clone());
    }

    let parsed: OpenAiChatResponse =
        serde_json::from_str(&body).map_err(|e| format!("parsing AI response failed: {e}"))?;
    let choice = parsed.choices.into_iter().next();
    let content = choice
        .as_ref()
        .and_then(|c| c.message.content.clone())
        .unwrap_or_default()
        .trim()
        .to_string();
    let reasoning_content = choice
        .and_then(|c| c.message.reasoning_content)
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() && reasoning_content.is_empty() {
        return Err("AI response was empty.".into());
    }
    Ok(AiChatResponse {
        content,
        reasoning_content,
    })
}

#[tauri::command]
pub async fn ai_chat_stream(app: AppHandle, input: AiChatStreamInput) -> Result<(), String> {
    let request_id = input.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("request id is empty".into());
    }
    take_ai_request_canceled(&request_id);

    let (profile, api_key, payload_messages) =
        match prepare_ai_request(input.messages, input.profile_id) {
            Ok(v) => v,
            Err(e) => {
                emit_ai_stream_error(&app, &request_id, e.clone());
                return Err(e);
            }
        };
    let endpoint = format!(
        "{}/chat/completions",
        profile.base_url.trim_end_matches('/')
    );
    let client = build_http_client(Duration::from_secs(120))?;
    let mut body = json!({
        "model": profile.model,
        "messages": payload_messages,
        "temperature": 0.2,
        "stream": true,
    });
    if !profile.reasoning_effort.is_empty() {
        body["reasoning_effort"] = json!(profile.reasoning_effort);
    }
    let mut compat_applied = tool_choice_compat_profiles()
        .lock()
        .unwrap()
        .contains(&profile.id);
    if compat_applied {
        apply_tool_choice_compat(&mut body);
    }
    let mut response =
        match send_ai_request_with_retry(client.post(&endpoint).bearer_auth(&api_key).json(&body))
            .await
        {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("AI request failed: {e}");
                emit_ai_stream_error(&app, &request_id, msg.clone());
                return Err(msg);
            }
        };

    if !response.status().is_success() && !compat_applied {
        let status = response.status();
        let err_body = response.text().await.unwrap_or_default();
        if !needs_tool_choice_compat(status, &err_body) {
            let msg = format!("AI request failed ({status}): {err_body}");
            emit_ai_stream_error(&app, &request_id, msg.clone());
            return Err(msg);
        }
        apply_tool_choice_compat(&mut body);
        compat_applied = true;
        response = match send_ai_request_with_retry(
            client.post(&endpoint).bearer_auth(&api_key).json(&body),
        )
        .await
        {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("AI request failed: {e}");
                emit_ai_stream_error(&app, &request_id, msg.clone());
                return Err(msg);
            }
        };
    }

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let msg = format!("AI request failed ({status}): {body}");
        emit_ai_stream_error(&app, &request_id, msg.clone());
        return Err(msg);
    }
    if compat_applied {
        tool_choice_compat_profiles()
            .lock()
            .unwrap()
            .insert(profile.id.clone());
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    // Holds an incomplete UTF-8 sequence when a network chunk splits a
    // character; a plain lossy decode per chunk would inject U+FFFD instead.
    let mut carry: Vec<u8> = Vec::new();
    while let Some(item) = stream.next().await {
        if take_ai_request_canceled(&request_id) {
            emit_ai_stream(
                &app,
                AiStreamEvent {
                    request_id,
                    delta: String::new(),
                    reasoning_delta: String::new(),
                    done: true,
                    error: Some("canceled".to_string()),
                },
            );
            return Ok(());
        }
        let bytes = match item {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("AI stream failed: {e}");
                emit_ai_stream_error(&app, &request_id, msg.clone());
                return Err(msg);
            }
        };
        push_utf8_chunk(&mut buffer, &mut carry, &bytes);
        for frame in parse_sse_frames(&mut buffer) {
            for data in parse_sse_frame_payloads(&frame) {
                if data == "[DONE]" {
                    emit_ai_stream(
                        &app,
                        AiStreamEvent {
                            request_id: request_id.clone(),
                            delta: String::new(),
                            reasoning_delta: String::new(),
                            done: true,
                            error: None,
                        },
                    );
                    return Ok(());
                }
                if take_ai_request_canceled(&request_id) {
                    emit_ai_stream(
                        &app,
                        AiStreamEvent {
                            request_id,
                            delta: String::new(),
                            reasoning_delta: String::new(),
                            done: true,
                            error: Some("canceled".to_string()),
                        },
                    );
                    return Ok(());
                }
                let parsed: OpenAiStreamChunk = match serde_json::from_str(&data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for choice in parsed.choices {
                    let reasoning = choice.delta.reasoning_content.clone().unwrap_or_default();
                    let content = choice.delta.content.clone().unwrap_or_default();
                    if !reasoning.is_empty() || !content.is_empty() {
                        emit_ai_stream(
                            &app,
                            AiStreamEvent {
                                request_id: request_id.clone(),
                                delta: content,
                                reasoning_delta: reasoning,
                                done: false,
                                error: None,
                            },
                        );
                    }
                }
            }
        }
    }
    if !buffer.trim().is_empty() {
        let trailing = buffer.replace("\r\n", "\n");
        for data in parse_sse_frame_payloads(&trailing) {
            if data == "[DONE]" {
                emit_ai_stream(
                    &app,
                    AiStreamEvent {
                        request_id: request_id.clone(),
                        delta: String::new(),
                        reasoning_delta: String::new(),
                        done: true,
                        error: None,
                    },
                );
                return Ok(());
            }
            let parsed: OpenAiStreamChunk = match serde_json::from_str(&data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for choice in parsed.choices {
                let reasoning = choice.delta.reasoning_content.clone().unwrap_or_default();
                let content = choice.delta.content.clone().unwrap_or_default();
                if !reasoning.is_empty() || !content.is_empty() {
                    emit_ai_stream(
                        &app,
                        AiStreamEvent {
                            request_id: request_id.clone(),
                            delta: content,
                            reasoning_delta: reasoning,
                            done: false,
                            error: None,
                        },
                    );
                }
            }
        }
    }
    emit_ai_stream(
        &app,
        AiStreamEvent {
            request_id,
            delta: String::new(),
            reasoning_delta: String::new(),
            done: true,
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn cancel_ai_chat_stream(request_id: String) -> Result<(), String> {
    let id = request_id.trim();
    if id.is_empty() {
        return Err("request id is empty".into());
    }
    canceled_ai_requests()
        .lock()
        .unwrap()
        .insert(id.to_string());
    Ok(())
}

#[tauri::command]
pub async fn unlock_vault(
    state: State<'_, AppState>,
    password: String,
    remember: bool,
) -> Result<(), String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    let app = Arc::new(App::open(&path, &password).map_err(|e| e.to_string())?);
    *state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(app.clone());
    if remember {
        if let Err(e) = zeroterm_app::keychain::save_master_password(&path, &password) {
            tracing::warn!(error = %e, "could not cache master password in keychain");
        }
    }
    spawn_sync_engine_bootstrap(app, state.sync.clone(), path.clone());
    info!(remember, "vault unlocked");
    Ok(())
}

#[tauri::command]
pub async fn create_vault(
    state: State<'_, AppState>,
    password: String,
    remember: bool,
) -> Result<(), String> {
    if password.is_empty() {
        return Err("password cannot be empty".into());
    }
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("creating vault dir: {e}"))?;
    }
    let app = App::create(&path, &password).map_err(|e| e.to_string())?;
    *state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(Arc::new(app));
    if remember {
        if let Err(e) = zeroterm_app::keychain::save_master_password(&path, &password) {
            tracing::warn!(error = %e, "could not cache master password in keychain");
        }
    }
    info!(path = %path.display(), remember, "vault created");
    Ok(())
}

#[tauri::command]
pub async fn lock_vault(state: State<'_, AppState>) -> Result<(), String> {
    *state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    state.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    state.sftp_pool.clear();
    state.transfer_manager.clear();
    // Probe verdicts embed host coordinates and the keys we'd lend out.
    state.direct_probes.clear();
    // Locking the vault drops every cached sync engine too — they hold
    // the unwrapped sync root key in memory and shouldn't outlive the
    // master key.
    state.sync.forget_all().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_vault_data(state: State<'_, AppState>) -> Result<(), String> {
    {
        let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.clear_vault_data().map_err(|e| e.to_string())?;
    }
    state.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    state.sftp_pool.clear();
    state.transfer_manager.clear();
    state.direct_probes.clear();
    state.sync.forget_all().await;
    Ok(())
}

/// Try to unlock the vault using the password cached in the OS keychain.
/// Returns `true` on success, `false` if there's no cache, the cache is
/// stale (password rotated), or the keychain backend is unavailable.
/// Never errors — keychain absence is a normal state.
///
/// On macOS, all keychain reads are batched via [`KeychainCache::preload`]
/// so the user only sees a single Touch ID / password prompt instead of
/// one per stored secret.
#[tauri::command]
pub async fn try_keychain_unlock(state: State<'_, AppState>) -> Result<bool, String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    if !App::vault_exists(&path) {
        return Ok(false);
    }

    // Phase 1: preload just the master password (single keychain access).
    zeroterm_app::keychain::cache().preload(&path, &[]);

    let pw = match zeroterm_app::keychain::get_master_password(&path) {
        Ok(Some(p)) => p,
        Ok(None) => return Ok(false),
        Err(e) => {
            tracing::debug!(error = %e, "keychain unavailable");
            return Ok(false);
        }
    };
    match App::open(&path, &pw) {
        Ok(app) => {
            let app = Arc::new(app);
            *state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(app.clone());
            spawn_sync_engine_bootstrap(app, state.sync.clone(), path.clone());
            info!("vault unlocked from keychain cache");
            Ok(true)
        }
        Err(zeroterm_app::AppError::Vault(zeroterm_app::VaultError::AuthenticationFailed)) => {
            tracing::warn!("cached master password no longer matches; ignoring");
            Ok(false)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn spawn_sync_engine_bootstrap(
    app: Arc<zeroterm_app::App>,
    manager: Arc<zeroterm_app::SyncManager>,
    vault_path: PathBuf,
) {
    tauri::async_runtime::spawn(async move {
        bootstrap_sync_engines_from_keychain(app, manager, &vault_path).await;
    });
}

async fn bootstrap_sync_engines_from_keychain(
    app: Arc<zeroterm_app::App>,
    manager: Arc<zeroterm_app::SyncManager>,
    vault_path: &Path,
) {
    let profiles = match app.list_sync_profiles() {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(error = %e, "could not list sync profiles during keychain bootstrap");
            return;
        }
    };

    if profiles.is_empty() {
        return;
    }

    // Phase 2: now that we know the profile IDs, batch-preload all
    // sync-related secrets in one burst. On macOS this collapses into
    // a single authorization prompt (or none at all if the grace window
    // from Phase 1 is still open).
    let profile_ids: Vec<String> = profiles.iter().map(|p| p.id.clone()).collect();
    zeroterm_app::keychain::cache().preload(vault_path, &profile_ids);

    for profile in profiles {
        let profile_id = profile.id;
        let passphrase = match zeroterm_app::keychain::get_sync_encryption_secret(&profile_id) {
            Ok(Some(v)) => v,
            Ok(None) => continue,
            Err(e) => {
                tracing::debug!(profile_id = %profile_id, error = %e, "could not read sync passphrase from keychain");
                continue;
            }
        };

        if let Err(e) = app.sync_join_repo(&manager, &profile_id, &passphrase).await {
            tracing::debug!(profile_id = %profile_id, error = %e, "sync auto-bootstrap from remembered passphrase failed");
        }
    }
}

/// Drop any cached master password for the default vault.
#[tauri::command]
pub async fn forget_keychain() -> Result<(), String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    zeroterm_app::keychain::forget_master_password(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_new_window(app_handle: AppHandle) -> Result<(), String> {
    let label = format!("window-{}", uuid::Uuid::new_v4());
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app_handle,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ZeroTerm")
    .inner_size(1500.0, 860.0);
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    builder = builder.disable_drag_drop_handler();
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_version() -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub fn destroy_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

/// Ask the OS to point the user at this window: a flashing taskbar button on
/// Windows, a bouncing dock icon on macOS, the urgency hint on Linux. Used when
/// a CLI in a background tab starts waiting on the user (see the terminal
/// attention badge in the frontend) and ZeroTerm itself sits behind other
/// windows. `Critical` keeps flashing until the window is focused; `flash =
/// false` stops it, which also clears the highlight Windows otherwise leaves on
/// the taskbar button. No-op when the window is already the active one.
#[tauri::command]
pub fn request_window_attention(window: tauri::WebviewWindow, flash: bool) -> Result<(), String> {
    let request = flash.then_some(tauri::UserAttentionType::Critical);
    window
        .request_user_attention(request)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn check_for_update(app_handle: AppHandle) -> Result<UpdateInfo, String> {
    let updater = app_handle
        .updater()
        .map_err(|e| format!("updater init failed: {e}"))?;
    let pending = updater
        .check()
        .await
        .map_err(|e| format!("check update failed: {e}"))?;

    let current_version = env!("CARGO_PKG_VERSION").to_string();
    if let Some(update) = pending {
        Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            notes: update.body.clone(),
        })
    } else {
        Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
        })
    }
}

#[tauri::command]
pub async fn install_update(app_handle: AppHandle) -> Result<String, String> {
    let updater = app_handle
        .updater()
        .map_err(|e| format!("updater init failed: {e}"))?;
    let pending = updater
        .check()
        .await
        .map_err(|e| format!("check update failed: {e}"))?;
    let Some(update) = pending else {
        return Ok("already_latest".to_string());
    };

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| {
            // Common case: the release manifest on the server has a
            // placeholder / malformed `signature` field, which the
            // updater fails to base64-decode. Surface a friendly
            // message instead of the raw "Invalid symbol …" string.
            let msg = e.to_string();
            if msg.contains("Invalid symbol") || msg.to_lowercase().contains("base64") {
                "update_signature_invalid".to_string()
            } else {
                format!("install update failed: {msg}")
            }
        })?;

    app_handle.restart();
}

// --------------------------------------------------------------------------
// hosts
// --------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: &'static str,
    pub os_type: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSyncDiagnostics {
    pub raw_host_records: usize,
    pub parsed_hosts: usize,
    pub malformed_hosts: usize,
}

#[tauri::command]
pub async fn list_hosts(state: State<'_, AppState>) -> Result<Vec<HostSummary>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let hosts = app.list_hosts().map_err(|e| e.to_string())?;
    Ok(hosts
        .into_iter()
        .map(|h| HostSummary {
            id: h.id,
            name: h.name,
            host: h.host,
            port: h.port,
            user: h.user,
            auth_type: match h.auth {
                HostAuth::Password { .. } => "password",
                HostAuth::PrivateKey { .. } => "key",
                HostAuth::Agent => "agent",
            },
            os_type: h.os_type,
            group_id: h.group_id,
        })
        .collect())
}

#[tauri::command]
pub async fn host_sync_diagnostics(
    state: State<'_, AppState>,
) -> Result<HostSyncDiagnostics, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let d = app.host_diagnostics().map_err(|e| e.to_string())?;
    Ok(HostSyncDiagnostics {
        raw_host_records: d.raw_host_records,
        parsed_hosts: d.parsed_hosts,
        malformed_hosts: d.malformed_hosts,
    })
}

// --------------------------------------------------------------------------
// sync profiles & engine (RFC-002 repo-based)
// --------------------------------------------------------------------------
//
// Profile shape is intentionally narrow: only LocalFolder is wired up
// today. SFTP lands in M6; that variant exists in `SyncBackend` for
// forwards-compat but is rejected at every command boundary.

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfileIO {
    pub id: String,
    pub name: String,
    pub backend: String,
    pub root: Option<String>,
    pub host_ref: Option<String>,
    pub remote_dir: Option<String>,
    pub url: Option<String>,
    pub root_path: Option<String>,
    pub username: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub prefix: Option<String>,
    pub endpoint: Option<String>,
    pub force_path_style: Option<bool>,
    pub access_key_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfileInput {
    pub name: String,
    pub backend: String,
    pub root: Option<String>,
    pub host_ref: Option<String>,
    pub remote_dir: Option<String>,
    pub url: Option<String>,
    pub root_path: Option<String>,
    pub username: Option<String>,
    /// WebDAV password. Only sent on save/update; we never echo it back
    /// from `profile_to_io`. Persisted in the OS keychain, not the
    /// vault, so it doesn't survive a sync profile export.
    pub password: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub prefix: Option<String>,
    pub endpoint: Option<String>,
    pub force_path_style: Option<bool>,
    pub access_key_id: Option<String>,
    /// S3 secret access key. Same keychain handling as `password`.
    pub secret_access_key: Option<String>,
    /// Optional S3 session token (STS). Empty string = leave keychain
    /// intact, exact same convention as `password` / `secret_access_key`.
    pub session_token: Option<String>,
}

fn profile_to_io(p: SyncProfile) -> SyncProfileIO {
    let mut io = SyncProfileIO {
        id: p.id,
        name: p.name,
        backend: String::new(),
        root: None,
        host_ref: None,
        remote_dir: None,
        url: None,
        root_path: None,
        username: None,
        region: None,
        bucket: None,
        prefix: None,
        endpoint: None,
        force_path_style: None,
        access_key_id: None,
        created_at: p.created_at,
    };
    match p.backend {
        SyncBackend::LocalFolder { root } => {
            io.backend = "local_folder".into();
            io.root = Some(root);
        }
        SyncBackend::Sftp {
            host_ref,
            remote_dir,
        } => {
            io.backend = "sftp".into();
            io.host_ref = Some(host_ref);
            io.remote_dir = Some(remote_dir);
        }
        SyncBackend::WebDav {
            url,
            root_path,
            username,
        } => {
            io.backend = "webdav".into();
            io.url = Some(url);
            io.root_path = Some(root_path);
            io.username = Some(username);
        }
        SyncBackend::S3 {
            region,
            bucket,
            prefix,
            endpoint,
            force_path_style,
            access_key_id,
        } => {
            io.backend = "s3".into();
            io.region = Some(region);
            io.bucket = Some(bucket);
            io.prefix = Some(prefix);
            io.endpoint = endpoint;
            io.force_path_style = Some(force_path_style);
            io.access_key_id = Some(access_key_id);
        }
    }
    io
}

fn profile_from_input(id: String, input: SyncProfileInput) -> Result<SyncProfile, String> {
    let backend = match input.backend.as_str() {
        "local_folder" => {
            let root = input
                .root
                .clone()
                .ok_or_else(|| "sync root is required for local_folder backend".to_string())?;
            if root.trim().is_empty() {
                return Err("sync root cannot be empty".to_string());
            }
            SyncBackend::LocalFolder { root }
        }
        "sftp" => {
            let host_ref = input
                .host_ref
                .clone()
                .ok_or_else(|| "sftp host_ref is required".to_string())?;
            if host_ref.trim().is_empty() {
                return Err("sftp host_ref cannot be empty".to_string());
            }
            let remote_dir = input
                .remote_dir
                .clone()
                .ok_or_else(|| "sftp remote_dir is required".to_string())?;
            if remote_dir.trim().is_empty() {
                return Err("sftp remote_dir cannot be empty".to_string());
            }
            SyncBackend::Sftp {
                host_ref,
                remote_dir,
            }
        }
        "webdav" => {
            let url = input
                .url
                .clone()
                .ok_or_else(|| "webdav url is required".to_string())?;
            if url.trim().is_empty() {
                return Err("webdav url cannot be empty".to_string());
            }
            let username = input
                .username
                .clone()
                .ok_or_else(|| "webdav username is required".to_string())?;
            if username.trim().is_empty() {
                return Err("webdav username cannot be empty".to_string());
            }
            SyncBackend::WebDav {
                url,
                root_path: input.root_path.clone().unwrap_or_default(),
                username,
            }
        }
        "s3" => {
            let region = input
                .region
                .clone()
                .ok_or_else(|| "s3 region is required".to_string())?;
            if region.trim().is_empty() {
                return Err("s3 region cannot be empty".to_string());
            }
            let bucket = input
                .bucket
                .clone()
                .ok_or_else(|| "s3 bucket is required".to_string())?;
            if bucket.trim().is_empty() {
                return Err("s3 bucket cannot be empty".to_string());
            }
            let access_key_id = input
                .access_key_id
                .clone()
                .ok_or_else(|| "s3 access_key_id is required".to_string())?;
            if access_key_id.trim().is_empty() {
                return Err("s3 access_key_id cannot be empty".to_string());
            }
            SyncBackend::S3 {
                region,
                bucket,
                prefix: input.prefix.clone().unwrap_or_default(),
                endpoint: input.endpoint.clone().filter(|s| !s.trim().is_empty()),
                force_path_style: input.force_path_style.unwrap_or(false),
                access_key_id,
            }
        }
        other => return Err(format!("unsupported sync backend: {other}")),
    };
    Ok(SyncProfile {
        id,
        name: input.name,
        created_at: 0,
        backend,
    })
}

fn sync_backend_key_from_input(input: &SyncProfileInput) -> &str {
    input.backend.as_str()
}

fn sync_backend_key_from_profile(profile: &SyncProfile) -> &'static str {
    match profile.backend {
        SyncBackend::LocalFolder { .. } => "local_folder",
        SyncBackend::Sftp { .. } => "sftp",
        SyncBackend::WebDav { .. } => "webdav",
        SyncBackend::S3 { .. } => "s3",
    }
}

#[tauri::command]
pub async fn list_sync_profiles(state: State<'_, AppState>) -> Result<Vec<SyncProfileIO>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let profiles = app.list_sync_profiles().map_err(|e| e.to_string())?;
    Ok(profiles.into_iter().map(profile_to_io).collect())
}

#[tauri::command]
pub async fn save_sync_profile(
    state: State<'_, AppState>,
    input: SyncProfileInput,
) -> Result<String, String> {
    let backend_key = sync_backend_key_from_input(&input).to_string();
    let credential = sync_profile_credential_from_input(&input);
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let existing = app
        .list_sync_profiles()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| sync_backend_key_from_profile(p) == backend_key);

    let id = if let Some(existing) = existing {
        let mut p = profile_from_input(existing.id.clone(), input)?;
        p.created_at = existing.created_at;
        app.update_sync_profile(&p).map_err(|e| e.to_string())?;
        existing.id
    } else {
        let p = profile_from_input(String::new(), input)?;
        app.save_sync_profile(&p).map_err(|e| e.to_string())?
    };
    persist_sync_profile_credential(&id, &credential);
    Ok(id)
}

#[tauri::command]
pub async fn update_sync_profile(
    state: State<'_, AppState>,
    id: String,
    input: SyncProfileInput,
) -> Result<(), String> {
    let credential = sync_profile_credential_from_input(&input);
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let p = profile_from_input(id.clone(), input)?;
    app.update_sync_profile(&p).map_err(|e| e.to_string())?;
    persist_sync_profile_credential(&id, &credential);
    Ok(())
}

#[tauri::command]
pub async fn delete_sync_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.delete_sync_profile(&id).map_err(|e| e.to_string())?;
    }
    // Forget any cached engine and any cached sync passphrase. Best-effort.
    state.sync.forget(&id).await;
    let _ = zeroterm_app::keychain::forget_sync_encryption_secret(&id);
    let _ = zeroterm_app::keychain::forget_sync_backend_credential(&id);
    let _ = zeroterm_app::keychain::forget_sync_backend_extra(&id);
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAllSyncProfilesResult {
    pub deleted_count: usize,
}

#[tauri::command]
pub async fn delete_all_sync_profiles(
    state: State<'_, AppState>,
) -> Result<DeleteAllSyncProfilesResult, String> {
    let ai_keys = snapshot_ai_api_keys();
    let ids = {
        let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.list_sync_profile_ids_raw().map_err(|e| e.to_string())?
    };

    let mut deleted_count = 0usize;
    for id in &ids {
        {
            let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let app = app_lock.as_ref().ok_or("vault is locked")?;
            app.delete_sync_profile(id).map_err(|e| e.to_string())?;
        }
        state.sync.forget(id).await;
        let _ = zeroterm_app::keychain::forget_sync_encryption_secret(id);
        let _ = zeroterm_app::keychain::forget_sync_backend_credential(id);
        let _ = zeroterm_app::keychain::forget_sync_backend_extra(id);
        deleted_count += 1;
    }

    state.sync.forget_all().await;
    restore_ai_api_keys(ai_keys);
    Ok(DeleteAllSyncProfilesResult { deleted_count })
}

fn snapshot_ai_api_keys() -> HashMap<String, String> {
    let store = read_ai_store_from_disk().unwrap_or_else(|_| default_ai_store());
    let mut keys = HashMap::new();
    for profile in store.profiles {
        if let Some(secret) = zeroterm_app::keychain::get_ai_api_key(&profile.id)
            .ok()
            .flatten()
        {
            keys.insert(profile.id, secret);
        }
    }
    keys
}

fn restore_ai_api_keys(keys: HashMap<String, String>) {
    for (profile_id, secret) in keys {
        if let Err(e) = zeroterm_app::keychain::save_ai_api_key(&profile_id, &secret) {
            tracing::warn!(profile_id = %profile_id, error = %e, "could not restore AI API key after clearing sync profiles");
        }
    }
}

/// What the keychain needs to know after a save/update. Empty strings
/// mean "leave the existing keychain entry alone" — the UI never echoes
/// stored secrets back, so a re-save that only changed the URL must not
/// blow away the password.
#[derive(Default)]
struct SyncBackendCredentialUpdate {
    /// WebDAV password OR S3 secret access key — both go into the
    /// `sync-backend-credential:<id>` slot.
    primary: Option<String>,
    /// Optional sibling secret (e.g. S3 STS session token).
    extra: Option<String>,
}

fn sync_profile_credential_from_input(input: &SyncProfileInput) -> SyncBackendCredentialUpdate {
    match input.backend.as_str() {
        "webdav" => SyncBackendCredentialUpdate {
            primary: input.password.clone(),
            extra: None,
        },
        "s3" => SyncBackendCredentialUpdate {
            primary: input.secret_access_key.clone(),
            extra: input.session_token.clone(),
        },
        _ => SyncBackendCredentialUpdate::default(),
    }
}

fn persist_sync_profile_credential(profile_id: &str, update: &SyncBackendCredentialUpdate) {
    if let Some(primary) = update.primary.as_deref() {
        if !primary.is_empty() {
            let _ = zeroterm_app::keychain::save_sync_backend_credential(profile_id, primary);
        }
    }
    if let Some(extra) = update.extra.as_deref() {
        if extra.is_empty() {
            // Explicit empty string from a UI that supports clearing
            // the STS token. We don't expose that path yet; treat empty
            // as "leave it" to match the primary semantics.
        } else {
            let _ = zeroterm_app::keychain::save_sync_backend_extra(profile_id, extra);
        }
    }
}

#[tauri::command]
pub async fn sync_create_repo(
    state: State<'_, AppState>,
    profile_id: String,
    passphrase: String,
    remember_passphrase: Option<bool>,
) -> Result<SyncCreateRepoResult, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let seeded_records = app
        .sync_create_repo(&manager, &profile_id, &passphrase)
        .await
        .map_err(|e| e.to_string())?;
    if remember_passphrase.unwrap_or(false) {
        let _ = zeroterm_app::keychain::save_sync_encryption_secret(&profile_id, &passphrase);
    }
    Ok(SyncCreateRepoResult { seeded_records })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCreateRepoResult {
    pub seeded_records: usize,
}

#[tauri::command]
pub async fn sync_join_repo(
    state: State<'_, AppState>,
    profile_id: String,
    passphrase: String,
    remember_passphrase: Option<bool>,
) -> Result<SyncJoinResult, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let join = app
        .sync_join_repo(&manager, &profile_id, &passphrase)
        .await
        .map_err(|e| e.to_string())?;

    let local_vault_id = {
        let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.vault_id().to_string()
    };
    if remember_passphrase.unwrap_or(false) {
        let _ = zeroterm_app::keychain::save_sync_encryption_secret(&profile_id, &passphrase);
    }
    let local_vault_id_matches = local_vault_id == join.repo_vault_id;
    Ok(SyncJoinResult {
        repo_vault_id: join.repo_vault_id,
        local_vault_id_matches,
        events_pulled: join.events_pulled,
        upserts_applied: join.upserts_applied,
        deletes_applied: join.deletes_applied,
        conflicts_detected: join.conflicts_detected,
        already_seen: join.already_seen,
        skipped: join.skipped,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncJoinResult {
    pub repo_vault_id: String,
    /// `false` if the user joined a repo created against a *different*
    /// local vault — the engine will reject `sync_now` with
    /// VaultIdMismatch, but the UI can warn early.
    pub local_vault_id_matches: bool,
    pub events_pulled: usize,
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
}

#[tauri::command]
pub async fn sync_now(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<zeroterm_app::SyncOutcome, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.sync_now(&manager, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_status(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<zeroterm_app::SyncStatus, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.sync_status(&manager, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_forget_engine(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    state.sync.forget(&profile_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sync_has_remembered_passphrase(profile_id: String) -> Result<bool, String> {
    zeroterm_app::keychain::get_sync_encryption_secret(&profile_id)
        .map(|v| v.is_some())
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceEntry {
    pub device_id: String,
    pub name: String,
    pub last_seen_at: i64,
    pub is_current: bool,
}

#[tauri::command]
pub async fn sync_list_devices(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<SyncDeviceEntry>, String> {
    let app = {
        let guard = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.as_ref().ok_or("vault is locked")?.clone()
    };
    let devices = app
        .sync_list_devices(&state.sync, &profile_id)
        .await
        .map_err(|e| e.to_string())?;
    let current_device_id = zeroterm_app::local_device_id();
    Ok(devices
        .into_iter()
        .map(|device| SyncDeviceEntry {
            is_current: device.device_id == current_device_id,
            device_id: device.device_id,
            name: device.name,
            last_seen_at: device.last_seen_at,
        })
        .collect())
}

#[tauri::command]
pub async fn sync_revoke_device(
    state: State<'_, AppState>,
    profile_id: String,
    device_id: String,
    new_passphrase: String,
    remember_passphrase: Option<bool>,
) -> Result<zeroterm_sync::engine::RekeyReport, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let report = app
        .sync_revoke_device(&manager, &profile_id, &device_id, &new_passphrase)
        .await
        .map_err(|e| e.to_string())?;
    if remember_passphrase.unwrap_or(false) {
        if let Err(e) =
            zeroterm_app::keychain::save_sync_encryption_secret(&profile_id, &new_passphrase)
        {
            tracing::warn!(profile_id = %profile_id, error = %e, "root rotation succeeded but the replacement sync passphrase could not be saved");
        }
    } else if let Err(e) = zeroterm_app::keychain::forget_sync_encryption_secret(&profile_id) {
        tracing::warn!(profile_id = %profile_id, error = %e, "root rotation succeeded but the old remembered sync passphrase could not be removed");
    }
    Ok(report)
}

#[tauri::command]
pub async fn sync_list_conflicts(
    state: State<'_, AppState>,
    _profile_id: String,
) -> Result<Vec<zeroterm_app::ConflictView>, String> {
    let app = {
        let guard = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.as_ref().ok_or("vault is locked")?.clone()
    };
    app.list_open_conflicts().map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncResolutionInput {
    KeepLocal,
    KeepRemote,
}

#[tauri::command]
pub async fn sync_resolve_conflict(
    state: State<'_, AppState>,
    _profile_id: String,
    conflict_id: String,
    resolution: SyncResolutionInput,
) -> Result<(), String> {
    let app = {
        let guard = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.as_ref().ok_or("vault is locked")?.clone()
    };
    let r = match resolution {
        SyncResolutionInput::KeepLocal => zeroterm_app::ConflictResolution::KeepLocal,
        SyncResolutionInput::KeepRemote => zeroterm_app::ConflictResolution::KeepRemote,
    };
    app.resolve_conflict(&conflict_id, r)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_compact_now(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<zeroterm_sync::engine::CompactReport, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.sync_compact(&manager, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_delete_remote_repo(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.sync_delete_remote_repo(&manager, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_repo_stats(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<zeroterm_sync::engine::RepoStats, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.sync_repo_stats(&manager, &profile_id)
        .await
        .map_err(|e| e.to_string())
}

fn clone_app_and_sync(
    state: &State<'_, AppState>,
) -> Result<(Arc<zeroterm_app::App>, Arc<zeroterm_app::SyncManager>), String> {
    let guard = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = guard.as_ref().ok_or("vault is locked")?.clone();
    let manager = state.sync.clone();
    Ok((app, manager))
}

// ---- host CRUD -----------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuthInput,
    #[serde(default)]
    pub os_type: Option<String>,
    #[serde(default, alias = "proxy_jump")]
    pub proxy_jump_host_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostAuthInput {
    Password {
        value: String,
    },
    PrivateKey {
        /// Omitted when editing an existing key-authenticated host without
        /// replacing its private key.
        key_pem: Option<String>,
        passphrase: Option<String>,
    },
    Agent,
}

/// Wire shape for a forward, both incoming (`HostInput`) and outgoing
/// (`HostFull`). Mirrors `zeroterm_app::ForwardSpec` but lives here so
/// we can decorate it with the right serde shape for IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardSpecIO {
    Local {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    Remote {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
    },
}

fn default_bind_addr() -> String {
    "127.0.0.1".to_string()
}

fn default_forward_enabled() -> bool {
    true
}

fn normalize_os_type(raw: &str) -> Option<String> {
    let key = raw.trim().to_lowercase().replace('_', "-");
    if key.is_empty() {
        return None;
    }
    let canonical = match key.as_str() {
        "ubuntu" => "ubuntu",
        "debian" => "debian",
        "centos" => "centos",
        "redhat" | "rhel" | "red-hat" | "red-hat-enterprise-linux" => "redhat",
        "fedora" => "fedora",
        "arch" | "archlinux" => "archlinux",
        "rocky" | "rockylinux" | "rocky-linux" => "rockylinux",
        "alma" | "almalinux" | "alma-linux" => "almalinux",
        "opensuse" | "suse" | "opensuse-leap" | "opensuse-tumbleweed" => "opensuse",
        "kali" | "kalilinux" | "kali-linux" => "kalilinux",
        "mint" | "linuxmint" | "linux-mint" => "linuxmint",
        "windows" | "windows10" | "windows11" | "win" | "win10" | "win11" => "windows",
        "macos" | "osx" | "darwin" | "mac" => "macos",
        "linux" => "linux",
        _ => return None,
    };
    Some(canonical.to_string())
}

impl ForwardSpecIO {
    fn into_app(self) -> zeroterm_app::ForwardSpec {
        match self {
            ForwardSpecIO::Local {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_app::ForwardSpec::Local {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            },
            ForwardSpecIO::Remote {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_app::ForwardSpec::Remote {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            },
            ForwardSpecIO::Dynamic {
                enabled,
                bind_addr,
                bind_port,
            } => zeroterm_app::ForwardSpec::Dynamic {
                enabled,
                bind_addr,
                bind_port,
            },
        }
    }

    fn from_app(spec: &zeroterm_app::ForwardSpec) -> Self {
        match spec {
            zeroterm_app::ForwardSpec::Local {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => ForwardSpecIO::Local {
                enabled: *enabled,
                bind_addr: bind_addr.clone(),
                bind_port: *bind_port,
                target_host: target_host.clone(),
                target_port: *target_port,
            },
            zeroterm_app::ForwardSpec::Remote {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => ForwardSpecIO::Remote {
                enabled: *enabled,
                bind_addr: bind_addr.clone(),
                bind_port: *bind_port,
                target_host: target_host.clone(),
                target_port: *target_port,
            },
            zeroterm_app::ForwardSpec::Dynamic {
                enabled,
                bind_addr,
                bind_port,
            } => ForwardSpecIO::Dynamic {
                enabled: *enabled,
                bind_addr: bind_addr.clone(),
                bind_port: *bind_port,
            },
        }
    }
}

impl HostInput {
    fn into_app_host(self, id: String) -> zeroterm_app::Host {
        zeroterm_app::Host {
            id,
            name: self.name,
            host: self.host,
            port: self.port,
            user: self.user,
            auth: match self.auth {
                HostAuthInput::Password { value } => zeroterm_app::HostAuth::Password { value },
                HostAuthInput::PrivateKey {
                    key_pem,
                    passphrase,
                } => zeroterm_app::HostAuth::PrivateKey {
                    key_pem: key_pem.unwrap_or_default(),
                    passphrase,
                },
                HostAuthInput::Agent => zeroterm_app::HostAuth::Agent,
            },
            os_type: self.os_type.and_then(|v| normalize_os_type(&v)),
            forwards: Vec::new(),
            proxy_jump_host_id: self.proxy_jump_host_id.filter(|s| !s.is_empty()),
            group_id: self.group_id.filter(|s| !s.is_empty()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFull {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: &'static str,
    pub os_type: Option<String>,
    /// Structured forwards for the editor.
    pub forwards: Vec<ForwardSpecIO>,
    pub proxy_jump_host_id: Option<String>,
    pub group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostCredentialKind {
    Password,
    KeyPassphrase,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardStatus {
    pub id: u64,
    pub host_id: String,
    pub host_name: String,
    pub summaries: Vec<String>,
    /// "active" while the tunnel is up, "reconnecting" while it's
    /// re-establishing after a passive disconnect.
    pub state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardHostStatus {
    pub host_id: String,
    pub host_name: String,
    pub forwards: Vec<ForwardSpecIO>,
    pub active: Option<PortForwardStatus>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRuleStatus {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub forward: ForwardSpecIO,
    pub summary: String,
    pub active: Option<PortForwardStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRuleInput {
    pub host_id: String,
    pub forward: ForwardSpecIO,
}

impl PortForwardRuleInput {
    fn into_app_rule(self, id: String) -> zeroterm_app::PortForwardRule {
        zeroterm_app::PortForwardRule {
            id,
            host_id: self.host_id,
            spec: self.forward.into_app(),
        }
    }
}

#[tauri::command]
pub async fn save_host(state: State<'_, AppState>, input: HostInput) -> Result<String, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let h = input.into_app_host(String::new());
    if matches!(
        &h.auth,
        zeroterm_app::HostAuth::PrivateKey { key_pem, .. } if key_pem.trim().is_empty()
    ) {
        return Err("private key is required".to_string());
    }
    if matches!(&h.auth, zeroterm_app::HostAuth::Password { value } if value.is_empty()) {
        return Err("password is required".to_string());
    }
    let id = app.save_host(&h).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(id)
}

#[tauri::command]
pub async fn update_host(
    state: State<'_, AppState>,
    id: String,
    input: HostInput,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;

    let existing = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;

    let mut new_host = input.into_app_host(id);
    if new_host.os_type.is_none() {
        new_host.os_type = existing.os_type;
    }
    match (&mut new_host.auth, &existing.auth) {
        (
            zeroterm_app::HostAuth::Password { value },
            zeroterm_app::HostAuth::Password {
                value: existing_value,
            },
        ) if value.is_empty() => value.clone_from(existing_value),
        (
            zeroterm_app::HostAuth::PrivateKey {
                key_pem,
                passphrase,
            },
            zeroterm_app::HostAuth::PrivateKey {
                key_pem: existing_key,
                passphrase: existing_passphrase,
            },
        ) if key_pem.trim().is_empty() => {
            key_pem.clone_from(existing_key);
            if passphrase.as_deref().unwrap_or_default().is_empty() {
                passphrase.clone_from(existing_passphrase);
            }
        }
        (zeroterm_app::HostAuth::Password { value }, _) if value.is_empty() => {
            return Err("password is required".to_string());
        }
        (zeroterm_app::HostAuth::PrivateKey { key_pem, .. }, _)
            if key_pem.trim().is_empty() =>
        {
            return Err("private key is required".to_string());
        }
        _ => {}
    }
    app.update_host(&new_host).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

#[tauri::command]
pub async fn update_host_forwards(
    state: State<'_, AppState>,
    id: String,
    forwards: Vec<ForwardSpecIO>,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let mut host = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;
    host.forwards = forwards.into_iter().map(|f| f.into_app()).collect();
    app.update_host(&host).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

#[tauri::command]
pub async fn delete_host(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    id: String,
) -> Result<(), String> {
    // Stop any running tunnels for this host before removing it, so they don't
    // linger / auto-reconnect to a host that no longer exists.
    let stopped = stop_port_forwards_where(&state, |h| h.host_id == id);
    let (app, manager) = clone_app_and_sync(&state)?;
    app.delete_host(&id).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    if stopped > 0 {
        let _ = app_handle.emit("port-forward:changed", ());
    }
    Ok(())
}

// ---- host group CRUD -----------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupDto {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupInput {
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

fn group_to_dto(g: zeroterm_app::HostGroup) -> HostGroupDto {
    HostGroupDto {
        id: g.id,
        name: g.name,
        parent_id: g.parent_id,
        sort_order: g.sort_order,
    }
}

#[tauri::command]
pub async fn list_host_groups(state: State<'_, AppState>) -> Result<Vec<HostGroupDto>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let groups = app.list_host_groups().map_err(|e| e.to_string())?;
    Ok(groups.into_iter().map(group_to_dto).collect())
}

#[tauri::command]
pub async fn create_host_group(
    state: State<'_, AppState>,
    input: HostGroupInput,
) -> Result<String, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let g = zeroterm_app::HostGroup {
        id: String::new(),
        name: input.name,
        parent_id: input.parent_id.filter(|s| !s.is_empty()),
        sort_order: input.sort_order.unwrap_or(0),
    };
    let id = app.save_host_group(&g).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(id)
}

#[tauri::command]
pub async fn update_host_group(
    state: State<'_, AppState>,
    id: String,
    input: HostGroupInput,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let g = zeroterm_app::HostGroup {
        id,
        name: input.name,
        parent_id: input.parent_id.filter(|s| !s.is_empty()),
        sort_order: input.sort_order.unwrap_or(0),
    };
    app.update_host_group(&g).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

#[tauri::command]
pub async fn delete_host_group(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.delete_host_group(&id).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

/// Move a host into a group (or out of any group with `groupId = None`).
/// Convenience over update_host so the frontend doesn't need to round-trip
/// the entire host payload just to drag it onto a different group node.
#[tauri::command]
pub async fn set_host_group(
    state: State<'_, AppState>,
    host_id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let mut host = app
        .find_host_by_id(&host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;
    host.group_id = group_id.filter(|s| !s.is_empty());
    app.update_host(&host).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

// ---- snippet CRUD --------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDto {
    pub id: String,
    pub title: String,
    pub command: String,
    pub group: String,
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub title: String,
    pub command: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub sort_order: Option<i32>,
}

fn snippet_to_dto(s: zeroterm_app::Snippet) -> SnippetDto {
    SnippetDto {
        id: s.id,
        title: s.title,
        command: s.command,
        group: s.group,
        sort_order: s.sort_order,
    }
}

#[tauri::command]
pub async fn list_snippets(state: State<'_, AppState>) -> Result<Vec<SnippetDto>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let snippets = app.list_snippets().map_err(|e| e.to_string())?;
    Ok(snippets.into_iter().map(snippet_to_dto).collect())
}

#[tauri::command]
pub async fn create_snippet(
    state: State<'_, AppState>,
    input: SnippetInput,
) -> Result<String, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let s = zeroterm_app::Snippet {
        id: String::new(),
        title: input.title,
        command: input.command,
        group: input.group,
        sort_order: input.sort_order.unwrap_or(0),
    };
    let id = app.save_snippet(&s).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(id)
}

#[tauri::command]
pub async fn update_snippet(
    state: State<'_, AppState>,
    id: String,
    input: SnippetInput,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let s = zeroterm_app::Snippet {
        id,
        title: input.title,
        command: input.command,
        group: input.group,
        sort_order: input.sort_order.unwrap_or(0),
    };
    app.update_snippet(&s).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

#[tauri::command]
pub async fn delete_snippet(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.delete_snippet(&id).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

/// Rename a group across all its snippets. Snippet groups are just a
/// string field, so this is a batch field rewrite under the hood (see
/// `App::rename_snippet_group`). Returns how many snippets were touched.
#[tauri::command]
pub async fn rename_snippet_group(
    state: State<'_, AppState>,
    old_name: String,
    new_name: String,
) -> Result<usize, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let touched = app
        .rename_snippet_group(&old_name, &new_name)
        .map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(touched)
}

/// Delete every snippet in a group. Returns how many were removed.
#[tauri::command]
pub async fn delete_snippet_group(
    state: State<'_, AppState>,
    name: String,
) -> Result<usize, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let deleted = app.delete_snippet_group(&name).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(deleted)
}

/// Upper bound for `read_local_text_file` — it exists to import key
/// material, which is a few KiB. Anything larger is a wrong pick.
const MAX_PICKED_TEXT_FILE_BYTES: u64 = 1024 * 1024;

fn picker_starting_directory(
    default_path: Option<&str>,
    ssh_directory: Option<PathBuf>,
) -> Option<PathBuf> {
    default_path
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| ssh_directory.filter(|path| path.is_dir()))
}

/// `tauri-plugin-dialog`/`rfd` does not currently expose AppKit's
/// `showsHiddenFiles` option. Private keys commonly live below the hidden
/// `~/.ssh` directory, so use the native switch for that picker on macOS.
#[cfg(target_os = "macos")]
fn blocking_pick_file_showing_hidden(
    title: Option<String>,
    starting_directory: Option<PathBuf>,
) -> Option<PathBuf> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{NSString, NSURL};

    autoreleasepool(|_| {
        dispatch2::run_on_main(move |mtm| {
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setCanChooseDirectories(false);
            panel.setCanChooseFiles(true);
            panel.setAllowsMultipleSelection(false);
            panel.setShowsHiddenFiles(true);

            if let Some(title) = title {
                panel.setMessage(Some(&NSString::from_str(&title)));
            }
            if let Some(directory) = starting_directory {
                if let Some(path) = directory.to_str() {
                    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), true);
                    panel.setDirectoryURL(Some(&url));
                }
            }

            if panel.runModal() == NSModalResponseOK {
                panel
                    .URL()
                    .and_then(|url| url.path())
                    .map(|path| PathBuf::from(path.to_string()))
            } else {
                None
            }
        })
    })
}

/// Open a native file-picker and, when the user picks something,
/// remember the canonical path in the session's dialog-grant set.
/// High-risk commands (`read_local_text_file`, `open_with_app`) only
/// accept granted paths — this is what ties "the user chose this file"
/// to the backend instead of trusting whatever string the webview sends.
#[tauri::command]
pub async fn pick_local_file(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    title: Option<String>,
    default_path: Option<String>,
    show_hidden: Option<bool>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let show_hidden = show_hidden.unwrap_or(false);
    let ssh_directory = show_hidden
        .then(|| dirs::home_dir().map(|home| home.join(".ssh")))
        .flatten();
    let starting_directory = picker_starting_directory(default_path.as_deref(), ssh_directory);

    let picked = tauri::async_runtime::spawn_blocking(move || -> Result<Option<PathBuf>, String> {
        #[cfg(target_os = "macos")]
        if show_hidden {
            return Ok(blocking_pick_file_showing_hidden(title, starting_directory));
        }

        let mut builder = app_handle.dialog().file();
        if let Some(t) = title {
            builder = builder.set_title(t);
        }
        if let Some(dir) = starting_directory {
            builder = builder.set_directory(dir);
        }
        builder
            .blocking_pick_file()
            .map(|file_path| {
                file_path
                    .into_path()
                    .map_err(|e| format!("unsupported dialog result: {e}"))
            })
            .transpose()
    })
    .await
    .map_err(|e| format!("dialog task failed: {e}"))??;

    let Some(path) = picked else {
        return Ok(None);
    };
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("resolving {}: {e}", path.display()))?;
    state
        .dialog_grants
        .lock()
        .unwrap()
        .insert(canonical.clone());
    Ok(Some(canonical.to_string_lossy().to_string()))
}

/// True when `path` resolves to a file the user picked through
/// [`pick_local_file`] this session.
fn is_dialog_granted(state: &State<'_, AppState>, path: &str) -> bool {
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    state.dialog_grants.lock().unwrap_or_else(std::sync::PoisonError::into_inner).contains(&canonical)
}

/// Read a local text file (key material picked by the host editor).
/// Only paths the user just selected through [`pick_local_file`] are
/// accepted; this command is the designated reader for private keys, so
/// letting the webview name arbitrary paths would hand any XSS a copy
/// of `~/.ssh/id_rsa`.
#[tauri::command]
pub async fn read_local_text_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    if !is_dialog_granted(&state, &path) {
        return Err(format!(
            "`{path}` was not selected through the file picker; refusing to read it"
        ));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("stating {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("`{path}` is not a regular file"));
    }
    if meta.len() > MAX_PICKED_TEXT_FILE_BYTES {
        return Err(format!(
            "`{path}` is {} bytes, above the {} byte import limit",
            meta.len(),
            MAX_PICKED_TEXT_FILE_BYTES
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))
}

/// Read a local UTF-8 text file for inline editing.
#[tauri::command]
pub async fn local_read_text(
    path: String,
    max_bytes: Option<u64>,
) -> Result<RemoteTextFileDto, String> {
    let max_len = normalize_text_edit_limit(max_bytes);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("stating {path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("`{path}` is not a regular file"));
    }
    if metadata.len() > max_len {
        return Err(format!(
            "`{path}` is {} bytes, above editor limit {} bytes",
            metadata.len(),
            max_len
        ));
    }

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("reading {path}: {e}"))?;
    if bytes.len() as u64 > max_len {
        return Err(format!(
            "`{path}` expanded to {} bytes, above editor limit {} bytes",
            bytes.len(),
            max_len
        ));
    }
    let (content, encoding) = decode_editor_text(&path, bytes)?;

    Ok(RemoteTextFileDto {
        path,
        size: metadata.len(),
        content,
        encoding,
    })
}

/// Save UTF-8 text content to a local file path.
#[tauri::command]
pub async fn local_write_text(path: String, content: String) -> Result<u64, String> {
    let bytes = content.into_bytes();
    let size = bytes.len() as u64;
    if size > HARD_TEXT_EDIT_MAX_BYTES {
        return Err(format!(
            "editor payload is {} bytes, above hard limit {} bytes",
            size, HARD_TEXT_EDIT_MAX_BYTES
        ));
    }

    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("writing {path}: {e}"))?;
    Ok(size)
}

#[tauri::command]
pub async fn get_host(state: State<'_, AppState>, id: String) -> Result<HostFull, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let h = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;

    let auth_type = match &h.auth {
        zeroterm_app::HostAuth::Password { .. } => "password",
        zeroterm_app::HostAuth::PrivateKey { .. } => "key",
        zeroterm_app::HostAuth::Agent => "agent",
    };

    Ok(HostFull {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        auth_type,
        os_type: h.os_type,
        forwards: h.forwards.iter().map(ForwardSpecIO::from_app).collect(),
        proxy_jump_host_id: h.proxy_jump_host_id,
        group_id: h.group_id,
    })
}

/// Reveal one stored host credential only after the user has re-entered the
/// vault master password. The regular host-editor read path deliberately
/// never returns secret material over IPC.
#[tauri::command]
pub async fn reveal_host_credential(
    state: State<'_, AppState>,
    id: String,
    kind: HostCredentialKind,
    master_password: String,
) -> Result<String, String> {
    if master_password.is_empty() {
        return Err("master password is required".to_string());
    }
    if state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_none() {
        return Err("vault is locked".to_string());
    }
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;

    tokio::task::spawn_blocking(move || {
        let app = App::open(path, &master_password)
            .map_err(|_| "master password verification failed".to_string())?;
        let host = app
            .find_host_by_id(&id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no host with id {id}"))?;
        match (kind, &host.auth) {
            (HostCredentialKind::Password, HostAuth::Password { value }) => Ok(value.clone()),
            (HostCredentialKind::KeyPassphrase, HostAuth::PrivateKey { passphrase: Some(value), .. }) => {
                Ok(value.clone())
            }
            (HostCredentialKind::KeyPassphrase, HostAuth::PrivateKey { passphrase: None, .. }) => {
                Err("this private key has no saved passphrase".to_string())
            }
            (HostCredentialKind::Password, _) => {
                Err("this host does not use password authentication".to_string())
            }
            (HostCredentialKind::KeyPassphrase, _) => {
                Err("this host does not use private-key authentication".to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("credential verification task failed: {e}"))?
}

// --------------------------------------------------------------------------
// session lifecycle
// --------------------------------------------------------------------------

const METRICS_SCRIPT: &str = r#"printf 'ZT_METRICS_V1\n'
hostname 2>/dev/null || uname -n
uname -s 2>/dev/null || printf 'unknown\n'
uname -m 2>/dev/null || printf 'unknown\n'
awk '{print int($1)}' /proc/uptime 2>/dev/null || printf '0\n'
nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf '1\n'
awk 'NR==1{total=$2+$3+$4+$5+$6+$7+$8; idle=$5+$6; print total, idle}' /proc/stat 2>/dev/null
sleep 0.25
awk 'NR==1{total=$2+$3+$4+$5+$6+$7+$8; idle=$5+$6; print total, idle}' /proc/stat 2>/dev/null
awk '
/^MemTotal:/ {mt=$2*1024}
/^MemAvailable:/ {ma=$2*1024}
/^SwapTotal:/ {st=$2*1024}
/^SwapFree:/ {sf=$2*1024}
# Some awk implementations clamp %d to INT_MAX. Memory byte counts routinely
# exceed that, while awk's numeric representation can still preserve them.
END {printf "%.0f %.0f %.0f %.0f\n", mt, mt-ma, st, st-sf}
' /proc/meminfo 2>/dev/null
v4=0
v6=0
v4_metric=2147483647
v6_metric=2147483647
if command -v ip >/dev/null 2>&1; then
  v4_route=$(ip -4 route show default 2>/dev/null | head -n 1)
  v6_route=$(ip -6 route show default 2>/dev/null | head -n 1)
  if [ -n "$v4_route" ]; then
    v4=1
    v4_metric=$(printf '%s\n' "$v4_route" | awk '{m=0; for(i=1;i<=NF;i++) if($i=="metric" && $(i+1) ~ /^[0-9]+$/) m=$(i+1); print m}')
  fi
  if [ -n "$v6_route" ]; then
    v6=1
    v6_metric=$(printf '%s\n' "$v6_route" | awk '{m=0; for(i=1;i<=NF;i++) if($i=="metric" && $(i+1) ~ /^[0-9]+$/) m=$(i+1); print m}')
  fi
else
  awk '$2 == "00000000" {found=1} END {exit !found}' /proc/net/route 2>/dev/null && v4=1
  awk '$1 == "00000000000000000000000000000000" && $2 == "00" {found=1} END {exit !found}' /proc/net/ipv6_route 2>/dev/null && v6=1
  [ "$v4" = 1 ] && v4_metric=0
  [ "$v6" = 1 ] && v6_metric=0
fi
if [ "$v4" = 1 ] && [ "$v6" = 1 ] && [ "$v4_metric" -lt "$v6_metric" ]; then printf 'O|ipv4\n'
elif [ "$v4" = 1 ] && [ "$v6" = 1 ] && [ "$v6_metric" -lt "$v4_metric" ]; then printf 'O|ipv6\n'
elif [ "$v4" = 1 ] && [ "$v6" = 1 ]; then printf 'O|dual\n'
elif [ "$v6" = 1 ]; then printf 'O|ipv6\n'
elif [ "$v4" = 1 ]; then printf 'O|ipv4\n'
else printf 'O|none\n'; fi
df -P -B1 -T 2>/dev/null | awk '
NR>1 && $3 ~ /^[0-9]+$/ {
  fstype=$2
  mount=$7
  if (fstype ~ /^(tmpfs|devtmpfs|squashfs|overlay|proc|sysfs|cgroup2?|devpts|mqueue|securityfs|pstore|autofs|tracefs|debugfs|fusectl|configfs)$/) next
  if (mount ~ /^(\/dev|\/proc|\/sys)(\/|$)/) next
  if (mount ~ /^(\/run)(\/|$)/) next
  if (mount ~ /^\/tmp(\/|$)/) next
  print "D|" mount "|" $3 "|" $4
}' | head -n 8
awk 'NR>2 {gsub(":", "", $1); print "A|" $1 "|" $2 "|" $10}' /proc/net/dev 2>/dev/null
sleep 1
awk 'NR>2 {gsub(":", "", $1); print "B|" $1 "|" $2 "|" $10}' /proc/net/dev 2>/dev/null
"#;

#[cfg(target_os = "macos")]
const MACOS_METRICS_SCRIPT: &str = r#"printf 'ZT_METRICS_V1\n'
hostname 2>/dev/null || uname -n
uname -s 2>/dev/null || printf 'Darwin\n'
uname -m 2>/dev/null || printf 'unknown\n'
boot=$(sysctl -n kern.boottime 2>/dev/null | awk -F'[=,]' '{gsub(/ /, "", $2); print $2}')
now=$(date +%s)
if [ -n "$boot" ]; then printf '%s\n' $((now - boot)); else printf '0\n'; fi
sysctl -n hw.ncpu 2>/dev/null || printf '1\n'
printf '0 0\n'
top -l 1 -n 0 2>/dev/null | awk -F'[:,% ]+' '
/CPU usage/ {idle=$7; printf "10000 %d\n", int(idle * 100); found=1; exit}
END {if (!found) print "10000 10000"}
'
pagesize=$(sysctl -n hw.pagesize 2>/dev/null || printf '4096')
mem_total=$(sysctl -n hw.memsize 2>/dev/null || printf '0')
vm_stat 2>/dev/null | awk -v ps="$pagesize" -v total="$mem_total" '
/Pages active/ {gsub("\\.", "", $3); active=$3}
/Pages wired down/ {gsub("\\.", "", $4); wired=$4}
/Pages occupied by compressor/ {gsub("\\.", "", $5); compressed=$5}
END {used=(active+wired+compressed)*ps; printf "%.0f %.0f ", total, used}
'
sysctl vm.swapusage 2>/dev/null | awk '{total=0; used=0; for(i=1;i<=NF;i++){if($i=="total") total=$(i+2); if($i=="used") used=$(i+2)} unit=1024*1024; printf "%.0f %.0f\n", total*unit, used*unit}'
v4=0
v6=0
route -n get -inet default >/dev/null 2>&1 && v4=1
route -n get -inet6 default >/dev/null 2>&1 && v6=1
if [ "$v4" = 1 ] && [ "$v6" = 1 ]; then printf 'O|ipv6\n'
elif [ "$v6" = 1 ]; then printf 'O|ipv6\n'
elif [ "$v4" = 1 ]; then printf 'O|ipv4\n'
else printf 'O|none\n'; fi
df -P -k 2>/dev/null | awk '
NR>1 && $2 ~ /^[0-9]+$/ && $6 ~ /^\// {
  mount=$6
  if (mount == "/") { root_total=$2*1024; root_used=$3*1024; next }
  if (mount == "/System/Volumes/Data") { data_total=$2*1024; data_used=$3*1024; next }
  if (substr(mount, 1, 9) == "/Volumes/" && substr(mount, 10) !~ /\//) {
    volumes[++volume_count]="D|" mount "|" $2*1024 "|" $3*1024
  }
}
END {
  if (data_total > 0) print "D|/|" data_total "|" data_used
  else if (root_total > 0) print "D|/|" root_total "|" root_used
  for (i=1; i<=volume_count && i<=7; i++) print volumes[i]
}'
netstat -ibn 2>/dev/null | awk 'NR>1 && $1 !~ /^(lo|gif|stf|utun|awdl|llw|bridge|anpi)/ && $7 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/ {rx[$1]=$7; tx[$1]=$10} END {for (i in rx) print "A|" i "|" rx[i] "|" tx[i]}'
sleep 1
netstat -ibn 2>/dev/null | awk 'NR>1 && $1 !~ /^(lo|gif|stf|utun|awdl|llw|bridge|anpi)/ && $7 ~ /^[0-9]+$/ && $10 ~ /^[0-9]+$/ {rx[$1]=$7; tx[$1]=$10} END {for (i in rx) print "B|" i "|" rx[i] "|" tx[i]}'
"#;

#[cfg(target_os = "windows")]
const WINDOWS_METRICS_SCRIPT: &str = r#"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1
'ZT_METRICS_V1'
$env:COMPUTERNAME
'Windows'
$env:PROCESSOR_ARCHITECTURE
[int]((Get-Date) - $os.LastBootUpTime).TotalSeconds
$env:NUMBER_OF_PROCESSORS
$cpu = 0.0
try {
  $cpuSample = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction Stop | Select-Object -First 1
  if ($null -ne $cpuSample) { $cpu = [double]$cpuSample.PercentProcessorTime }
} catch {}
'0 0'
[string]10000 + ' ' + [string]([math]::Max(0, 10000 - [int]($cpu * 100)))
[string]($os.TotalVisibleMemorySize * 1024) + ' ' + [string](($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) * 1024) + ' ' + [string]($os.TotalVirtualMemorySize * 1024) + ' ' + [string](($os.TotalVirtualMemorySize - $os.FreeVirtualMemory) * 1024)
$route4 = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
$route6 = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
$metric4 = [long]::MaxValue
$metric6 = [long]::MaxValue
if ($null -ne $route4) {
  $iface4 = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route4.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1
  $metric4 = [long]$route4.RouteMetric + $(if ($null -ne $iface4) { [long]$iface4.InterfaceMetric } else { 0 })
}
if ($null -ne $route6) {
  $iface6 = Get-NetIPInterface -AddressFamily IPv6 -InterfaceIndex $route6.InterfaceIndex -ErrorAction SilentlyContinue | Select-Object -First 1
  $metric6 = [long]$route6.RouteMetric + $(if ($null -ne $iface6) { [long]$iface6.InterfaceMetric } else { 0 })
}
if (($null -ne $route4) -and ($null -ne $route6) -and ($metric4 -lt $metric6)) { 'O|ipv4' }
elseif (($null -ne $route4) -and ($null -ne $route6) -and ($metric6 -lt $metric4)) { 'O|ipv6' }
elseif (($null -ne $route4) -and ($null -ne $route6)) { 'O|dual' }
elseif ($null -ne $route6) { 'O|ipv6' }
elseif ($null -ne $route4) { 'O|ipv4' }
else { 'O|none' }
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  if ($_.Size -gt 0) { 'D|' + $_.DeviceID + '|'+ [string]$_.Size + '|' + [string]($_.Size - $_.FreeSpace) }
}
$netA = @{}
$adapters = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object {
  $_.Status -eq 'Up' -and
  $_.HardwareInterface -eq $true -and
  $_.Name -notmatch '^et_' -and
  $_.Name -notmatch '^(vEthernet|Loopback|Npcap|VMware|VirtualBox|ZeroTier|Tailscale|Bluetooth)' -and
  $_.InterfaceDescription -notmatch '(Virtual|Miniport|Loopback|TAP|TUN|VPN|Hyper-V|Bluetooth)'
}
$adapters | ForEach-Object {
  $s = Get-NetAdapterStatistics -Name $_.Name -ErrorAction SilentlyContinue
  if ($null -eq $s) { return }
  $netA[$_.Name] = @([uint64]$s.ReceivedBytes, [uint64]$s.SentBytes)
  'A|' + $_.Name + '|' + [string]$s.ReceivedBytes + '|' + [string]$s.SentBytes
}
Start-Sleep -Seconds 1
$adapters | ForEach-Object {
  $s = Get-NetAdapterStatistics -Name $_.Name -ErrorAction SilentlyContinue
  if ($null -eq $s) { return }
  'B|' + $_.Name + '|' + [string]$s.ReceivedBytes + '|' + [string]$s.SentBytes
}
"#;

fn parse_metric_u64(s: Option<&str>) -> u64 {
    s.unwrap_or("0").trim().parse::<u64>().unwrap_or(0)
}

fn parse_metrics_output(text: &str) -> Result<SystemMetricsDto, String> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("ZT_METRICS_V1") {
        return Err("unexpected metrics response".to_string());
    }
    let host = lines.next().unwrap_or("unknown").trim().to_string();
    let os = lines.next().unwrap_or("unknown").trim().to_string();
    let arch = lines.next().unwrap_or("unknown").trim().to_string();
    let uptime_seconds = parse_metric_u64(lines.next());
    let cpu_cores = parse_metric_u64(lines.next()).max(1) as u32;
    let parse_cpu = |s: &str| -> (u64, u64) {
        let mut p = s.split_whitespace();
        (parse_metric_u64(p.next()), parse_metric_u64(p.next()))
    };
    let (t1, i1) = parse_cpu(lines.next().unwrap_or("0 0"));
    let (t2, i2) = parse_cpu(lines.next().unwrap_or("0 0"));
    let dt = t2.saturating_sub(t1);
    let di = i2.saturating_sub(i1);
    let cpu_usage = if dt > 0 {
        ((dt.saturating_sub(di)) as f64 / dt as f64) * 100.0
    } else {
        0.0
    };
    let mut mem = lines.next().unwrap_or("0 0 0 0").split_whitespace();
    let memory_total = parse_metric_u64(mem.next());
    let memory_used = parse_metric_u64(mem.next());
    let swap_total = parse_metric_u64(mem.next());
    let swap_used = parse_metric_u64(mem.next());
    let mut disks = Vec::new();
    let mut outbound_ip_type = "none".to_string();
    let mut network_first: HashMap<String, (u64, u64)> = HashMap::new();
    let mut networks = Vec::new();
    for line in lines {
        let mut parts = line.split('|');
        match parts.next() {
            Some("O") => {
                outbound_ip_type = match parts.next().unwrap_or("none") {
                    "ipv4" => "ipv4",
                    "ipv6" => "ipv6",
                    "dual" => "dual",
                    _ => "none",
                }
                .to_string();
            }
            Some("D") => {
                let mount = parts.next().unwrap_or("").to_string();
                let total = parse_metric_u64(parts.next());
                let used = parse_metric_u64(parts.next());
                let usage = if total > 0 {
                    used as f64 / total as f64 * 100.0
                } else {
                    0.0
                };
                disks.push(SystemDiskDto {
                    mount,
                    total,
                    used,
                    usage,
                });
            }
            Some("A") => {
                let name = parts.next().unwrap_or("").to_string();
                let rx = parse_metric_u64(parts.next());
                let tx = parse_metric_u64(parts.next());
                network_first.insert(name, (rx, tx));
            }
            Some("B") => {
                let name = parts.next().unwrap_or("").to_string();
                let rx = parse_metric_u64(parts.next());
                let tx = parse_metric_u64(parts.next());
                let (rx0, tx0) = network_first.get(&name).copied().unwrap_or((rx, tx));
                networks.push(SystemNetworkDto {
                    name,
                    rx_bytes_per_sec: rx.saturating_sub(rx0),
                    tx_bytes_per_sec: tx.saturating_sub(tx0),
                });
            }
            _ => {}
        }
    }
    Ok(SystemMetricsDto {
        host,
        os,
        arch,
        outbound_ip_type,
        uptime_seconds,
        cpu_cores,
        cpu_usage,
        memory_total,
        memory_used,
        swap_total,
        swap_used,
        disks,
        networks,
    })
}

async fn local_metrics() -> Result<SystemMetricsDto, String> {
    #[cfg(target_os = "windows")]
    let output = tokio::process::Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            WINDOWS_METRICS_SCRIPT,
        ])
        .output()
        .await
        .map_err(|e| format!("local metrics failed: {e}"))?;
    #[cfg(target_os = "macos")]
    let output = Command::new("sh")
        .arg("-lc")
        .arg(MACOS_METRICS_SCRIPT)
        .output()
        .await
        .map_err(|e| format!("local metrics failed: {e}"))?;
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let output = Command::new("sh")
        .arg("-lc")
        .arg(METRICS_SCRIPT)
        .output()
        .await
        .map_err(|e| format!("local metrics failed: {e}"))?;
    parse_metrics_output(&String::from_utf8_lossy(&output.stdout))
}

#[tauri::command]
pub async fn collect_system_metrics(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: Option<String>,
) -> Result<SystemMetricsDto, String> {
    let host_id = host_id.unwrap_or_default();
    if host_id.is_empty() || host_id.starts_with("local-") {
        return local_metrics().await;
    }
    let (_host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;
    let session = state
        .sftp_pool
        .acquire_session(host_id, cfg, jump_cfg)
        .await?;
    let (_code, stdout, stderr) = session
        .exec(METRICS_SCRIPT)
        .await
        .map_err(|e| e.to_string())?;
    if stdout.is_empty() && !stderr.is_empty() {
        return Err(String::from_utf8_lossy(&stderr).to_string());
    }
    parse_metrics_output(&String::from_utf8_lossy(&stdout))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemServiceDto {
    pub name: String,
    pub scope: String,
    pub group: String,
    pub description: String,
    pub load_state: String,
    pub active_state: String,
    pub sub_state: String,
}

fn parse_system_services(output: &str, scope: &str) -> Vec<SystemServiceDto> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let name = fields.next()?;
            let load_state = fields.next()?;
            let active_state = fields.next()?;
            let sub_state = fields.next()?;
            if !name.ends_with(".service") {
                return None;
            }
            Some(SystemServiceDto {
                name: name.to_string(),
                scope: scope.to_string(),
                group: "system".to_string(),
                description: fields.collect::<Vec<_>>().join(" "),
                load_state: load_state.to_string(),
                active_state: active_state.to_string(),
                sub_state: sub_state.to_string(),
            })
        })
        .collect()
}

fn parse_system_service_fragment_paths(output: &str) -> HashMap<String, String> {
    let mut paths = HashMap::new();
    let mut unit = String::new();
    let mut fragment = String::new();
    for line in output.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !unit.is_empty() {
                paths.insert(std::mem::take(&mut unit), std::mem::take(&mut fragment));
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("Id=") {
            if !unit.is_empty() {
                paths.insert(std::mem::take(&mut unit), std::mem::take(&mut fragment));
            }
            unit = value.to_string();
        } else if let Some(value) = line.strip_prefix("FragmentPath=") {
            fragment = value.to_string();
        }
    }
    paths
}

fn is_custom_service_fragment(scope: &str, path: &str) -> bool {
    if scope == "user" {
        path.starts_with("/etc/systemd/user/")
            || path.starts_with("/usr/local/lib/systemd/user/")
            || path.contains("/.config/systemd/user/")
            || path.contains("/.local/share/systemd/user/")
            || path.contains("/systemd/user.control/")
    } else {
        path.starts_with("/etc/systemd/system/")
            || path.starts_with("/usr/local/lib/systemd/system/")
    }
}

fn assign_system_service_groups(
    services: &mut [SystemServiceDto],
    paths: &HashMap<String, String>,
) {
    for service in services {
        let path = paths.get(&service.name).map(String::as_str).unwrap_or("");
        service.group = if is_custom_service_fragment(&service.scope, path) {
            "custom"
        } else {
            "system"
        }
        .to_string();
    }
}

fn system_service_show_args(services: &[SystemServiceDto], scope: &str) -> Vec<String> {
    let mut args = Vec::with_capacity(5 + services.len());
    if scope == "user" {
        args.push("--user".to_string());
    }
    args.extend([
        "--no-pager".to_string(),
        "show".to_string(),
        "--property=Id".to_string(),
        "--property=FragmentPath".to_string(),
    ]);
    args.extend(services.iter().map(|service| service.name.clone()));
    args
}

async fn local_system_service_fragment_paths(
    services: &[SystemServiceDto],
    scope: &str,
) -> HashMap<String, String> {
    if services.is_empty() {
        return HashMap::new();
    }
    let args = system_service_show_args(services, scope);
    #[cfg(target_os = "windows")]
    let output = tokio::process::Command::new("systemctl")
        .creation_flags(CREATE_NO_WINDOW)
        .args(&args)
        .output()
        .await;
    #[cfg(not(target_os = "windows"))]
    let output = Command::new("systemctl")
        .env("LC_ALL", "C")
        .env("SYSTEMD_COLORS", "0")
        .args(&args)
        .output()
        .await;
    match output {
        Ok(output) => {
            parse_system_service_fragment_paths(&String::from_utf8_lossy(&output.stdout))
        }
        _ => HashMap::new(),
    }
}

async fn remote_system_service_fragment_paths(
    session: &Session,
    services: &[SystemServiceDto],
    scope: &str,
) -> HashMap<String, String> {
    if services.is_empty() {
        return HashMap::new();
    }
    let mut command = format!(
        "LC_ALL=C SYSTEMD_COLORS=0 systemctl{} --no-pager show --property=Id --property=FragmentPath",
        if scope == "user" { " --user" } else { "" }
    );
    for service in services {
        command.push(' ');
        command.push_str(&shell_quote(&service.name));
    }
    match session.exec(&command).await {
        Ok((_code, stdout, _)) => {
            parse_system_service_fragment_paths(&String::from_utf8_lossy(&stdout))
        }
        _ => HashMap::new(),
    }
}

fn service_command_error(action: &str, code: i32, stdout: &[u8], stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(if stderr.is_empty() { stdout } else { stderr })
        .trim()
        .to_string();
    if detail.is_empty() {
        format!("systemctl {action} failed with exit code {code}")
    } else {
        detail
    }
}

fn validate_system_service_target(unit: &str, scope: &str) -> Result<(), String> {
    if !matches!(scope, "system" | "user") {
        return Err(format!("service scope `{scope}` is not allowed"));
    }
    if unit.is_empty()
        || unit.len() > 256
        || unit.starts_with('-')
        || !unit.ends_with(".service")
        || !unit.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@' | ':' | '\\')
        })
    {
        return Err("invalid systemd service unit name".to_string());
    }
    Ok(())
}

fn validate_system_service_action(action: &str, unit: &str, scope: &str) -> Result<(), String> {
    if !matches!(action, "start" | "stop" | "restart") {
        return Err(format!("service action `{action}` is not allowed"));
    }
    validate_system_service_target(unit, scope)
}

#[tauri::command]
pub async fn list_system_services(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: Option<String>,
) -> Result<Vec<SystemServiceDto>, String> {
    let host_id = host_id.unwrap_or_default();
    if host_id.is_empty() || host_id.starts_with("local-") {
        #[cfg(target_os = "windows")]
        let output = tokio::process::Command::new("systemctl")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ])
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("systemctl")
            .env("LC_ALL", "C")
            .env("SYSTEMD_COLORS", "0")
            .args([
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ])
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        if !output.status.success() {
            return Err(service_command_error(
                "list-units",
                output.status.code().unwrap_or(-1),
                &output.stdout,
                &output.stderr,
            ));
        }
        let mut services = parse_system_services(&String::from_utf8_lossy(&output.stdout), "system");
        let system_paths = local_system_service_fragment_paths(&services, "system").await;
        assign_system_service_groups(&mut services, &system_paths);
        #[cfg(target_os = "windows")]
        let user_output = tokio::process::Command::new("systemctl")
            .creation_flags(CREATE_NO_WINDOW)
            .args([
                "--user",
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ])
            .output()
            .await;
        #[cfg(not(target_os = "windows"))]
        let user_output = Command::new("systemctl")
            .env("LC_ALL", "C")
            .env("SYSTEMD_COLORS", "0")
            .args([
                "--user",
                "list-units",
                "--type=service",
                "--all",
                "--no-legend",
                "--no-pager",
                "--plain",
            ])
            .output()
            .await;
        if let Ok(user_output) = user_output {
            if user_output.status.success() {
                let mut user_services = parse_system_services(
                    &String::from_utf8_lossy(&user_output.stdout),
                    "user",
                );
                let user_paths = local_system_service_fragment_paths(&user_services, "user").await;
                assign_system_service_groups(&mut user_services, &user_paths);
                services.extend(
                    user_services
                        .into_iter()
                        .filter(|service| service.group == "custom"),
                );
            }
        }
        return Ok(services);
    }

    let (_host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;
    let session = state
        .sftp_pool
        .acquire_session(host_id, cfg, jump_cfg)
        .await?;
    let command = "LC_ALL=C SYSTEMD_COLORS=0 systemctl list-units --type=service --all --no-legend --no-pager --plain";
    let (code, stdout, stderr) = session.exec(command).await.map_err(|e| e.to_string())?;
    if code != 0 {
        return Err(service_command_error(
            "list-units",
            code as i32,
            &stdout,
            &stderr,
        ));
    }
    let mut services = parse_system_services(&String::from_utf8_lossy(&stdout), "system");
    let system_paths = remote_system_service_fragment_paths(&session, &services, "system").await;
    assign_system_service_groups(&mut services, &system_paths);
    let user_command = "LC_ALL=C SYSTEMD_COLORS=0 systemctl --user list-units --type=service --all --no-legend --no-pager --plain";
    if let Ok((user_code, user_stdout, _user_stderr)) = session.exec(user_command).await {
        if user_code == 0 {
            let mut user_services = parse_system_services(
                &String::from_utf8_lossy(&user_stdout),
                "user",
            );
            let user_paths =
                remote_system_service_fragment_paths(&session, &user_services, "user").await;
            assign_system_service_groups(&mut user_services, &user_paths);
            services.extend(
                user_services
                    .into_iter()
                    .filter(|service| service.group == "custom"),
            );
        }
    }
    Ok(services)
}

#[tauri::command]
pub async fn system_service_action(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: Option<String>,
    unit: String,
    action: String,
    scope: String,
) -> Result<(), String> {
    validate_system_service_action(&action, &unit, &scope)?;
    let host_id = host_id.unwrap_or_default();
    if host_id.is_empty() || host_id.starts_with("local-") {
        let mut args = Vec::with_capacity(4);
        if scope == "user" {
            args.push("--user");
        }
        args.extend(["--no-ask-password", action.as_str(), unit.as_str()]);
        #[cfg(target_os = "windows")]
        let output = tokio::process::Command::new("systemctl")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("systemctl")
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        if !output.status.success() {
            return Err(service_command_error(
                &action,
                output.status.code().unwrap_or(-1),
                &output.stdout,
                &output.stderr,
            ));
        }
        return Ok(());
    }

    let (_host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;
    let session = state
        .sftp_pool
        .acquire_session(host_id, cfg, jump_cfg)
        .await?;
    let command = format!(
        "systemctl{} --no-ask-password {} {}",
        if scope == "user" { " --user" } else { "" },
        action,
        shell_quote(&unit)
    );
    let (code, stdout, stderr) = session.exec(&command).await.map_err(|e| e.to_string())?;
    if code != 0 {
        return Err(service_command_error(
            &action,
            code as i32,
            &stdout,
            &stderr,
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn system_service_file(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: Option<String>,
    unit: String,
    scope: String,
) -> Result<String, String> {
    validate_system_service_target(&unit, &scope)?;
    let host_id = host_id.unwrap_or_default();
    let (code, stdout, stderr) = if host_id.is_empty() || host_id.starts_with("local-") {
        let mut args = Vec::with_capacity(4);
        if scope == "user" {
            args.push("--user");
        }
        args.extend(["--no-pager", "cat", unit.as_str()]);
        #[cfg(target_os = "windows")]
        let output = tokio::process::Command::new("systemctl")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("systemctl")
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("systemctl not available: {e}"))?;
        (
            output.status.code().unwrap_or(-1),
            output.stdout,
            output.stderr,
        )
    } else {
        let (_host, cfg, jump_cfg) =
            build_connect_chain_for_host(&state, &app_handle, &host_id)?;
        let session = state
            .sftp_pool
            .acquire_session(host_id, cfg, jump_cfg)
            .await?;
        let command = format!(
            "systemctl{} --no-pager cat {}",
            if scope == "user" { " --user" } else { "" },
            shell_quote(&unit)
        );
        let (code, stdout, stderr) = session.exec(&command).await.map_err(|e| e.to_string())?;
        (code as i32, stdout, stderr)
    };
    if code != 0 {
        return Err(service_command_error("cat", code, &stdout, &stderr));
    }
    const MAX_SERVICE_FILE_BYTES: usize = 1024 * 1024;
    if stdout.len() > MAX_SERVICE_FILE_BYTES {
        return Err("systemd service file output exceeds 1 MiB".to_string());
    }
    Ok(String::from_utf8_lossy(&stdout).to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

fn shell_quote(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('\'');
    for ch in arg.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Subcommands the Docker panel actually issues. `docker_exec` runs
/// with app privileges (locally) or on the remote host, so the surface
/// is pinned to container lifecycle/inspection verbs — notably NOT
/// `run`/`exec`/`create`/`cp`/`build`, any of which would let an
/// injected script mount the host filesystem or execute arbitrary code.
const DOCKER_ALLOWED_SUBCOMMANDS: &[&str] = &[
    "ps", "inspect", "logs", "stats", "start", "stop", "restart", "rm", "pause", "unpause",
];

fn validate_docker_args(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("docker: no subcommand given".to_string());
    };
    if !DOCKER_ALLOWED_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!(
            "docker subcommand `{sub}` is not allowed from the UI"
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn docker_exec(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: Option<String>,
    args: Vec<String>,
) -> Result<DockerExecResult, String> {
    validate_docker_args(&args)?;
    let host_id = host_id.unwrap_or_default();
    if host_id.is_empty() || host_id.starts_with("local-") {
        #[cfg(target_os = "windows")]
        let output = tokio::process::Command::new("docker")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("docker not available: {e}"))?;
        #[cfg(not(target_os = "windows"))]
        let output = Command::new("docker")
            .args(&args)
            .output()
            .await
            .map_err(|e| format!("docker not available: {e}"))?;
        return Ok(DockerExecResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        });
    }
    let (_host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;
    let session = state
        .sftp_pool
        .acquire_session(host_id, cfg, jump_cfg)
        .await?;
    let mut cmd = String::from("docker");
    for a in &args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    let (code, stdout, stderr) = session.exec(&cmd).await.map_err(|e| e.to_string())?;
    Ok(DockerExecResult {
        code: code as i32,
        stdout: String::from_utf8_lossy(&stdout).to_string(),
        stderr: String::from_utf8_lossy(&stderr).to_string(),
    })
}

async fn start_host_forwards(
    session: &mut Session,
    specs: &[zeroterm_app::ForwardSpec],
) -> Result<(Vec<zeroterm_ssh::ForwardHandle>, Vec<String>), String> {
    let mut forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();
    let mut summaries: Vec<String> = Vec::new();

    for spec in specs {
        let enabled = match spec {
            zeroterm_app::ForwardSpec::Local { enabled, .. } => *enabled,
            zeroterm_app::ForwardSpec::Remote { enabled, .. } => *enabled,
            zeroterm_app::ForwardSpec::Dynamic { enabled, .. } => *enabled,
        };
        if !enabled {
            continue;
        }

        let summary = spec.summary();
        let handle = match spec {
            zeroterm_app::ForwardSpec::Local {
                enabled: _,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_ssh::forward_local(
                session,
                bind_addr,
                *bind_port,
                target_host.clone(),
                *target_port,
            )
            .await
            .map_err(|e| format!("forward `{summary}`: {e}"))?,
            zeroterm_app::ForwardSpec::Remote {
                enabled: _,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_ssh::forward_remote(
                session,
                bind_addr,
                *bind_port,
                target_host.clone(),
                *target_port,
            )
            .await
            .map_err(|e| format!("forward `{summary}`: {e}"))?,
            zeroterm_app::ForwardSpec::Dynamic {
                enabled: _,
                bind_addr,
                bind_port,
            } => zeroterm_ssh::forward_dynamic(session, bind_addr, *bind_port)
                .await
                .map_err(|e| format!("forward `{summary}`: {e}"))?,
        };

        info!(addr = %handle.local_addr(), spec = %summary, "forward up");
        forwards.push(handle);
        summaries.push(summary);
    }

    Ok((forwards, summaries))
}

fn parse_os_release_value(raw: &str) -> &str {
    let v = raw.trim();
    if v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"'))
            || (v.starts_with('\'') && v.ends_with('\'')))
    {
        return &v[1..v.len() - 1];
    }
    v
}

fn detect_os_type_from_os_release(content: &str) -> Option<String> {
    let mut id: Option<String> = None;
    let mut id_like: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let key = k.trim();
        let value = parse_os_release_value(v).trim();
        if value.is_empty() {
            continue;
        }
        match key {
            "ID" => id = Some(value.to_string()),
            "ID_LIKE" => id_like = Some(value.to_string()),
            _ => {}
        }
    }

    if let Some(ref raw_id) = id {
        if let Some(os) = normalize_os_type(raw_id) {
            return Some(os);
        }
    }

    if let Some(ref likes) = id_like {
        for token in likes.split_whitespace() {
            if let Some(os) = normalize_os_type(token) {
                return Some(os);
            }
        }
    }

    None
}

async fn detect_remote_os_type(sftp: &zeroterm_ssh::Sftp) -> Option<String> {
    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(bytes) = sftp.download_to_vec(path).await {
            if let Ok(text) = String::from_utf8(bytes) {
                if let Some(os) = detect_os_type_from_os_release(&text) {
                    return Some(os);
                }
            }
        }
    }

    for path in [
        "/System/Library/CoreServices/SystemVersion.plist",
        "/System/Library/CoreServices",
    ] {
        if sftp.stat(path).await.is_ok() {
            return Some("macos".to_string());
        }
    }

    for path in ["C:/Windows", "/C:/Windows"] {
        if sftp.stat(path).await.is_ok() {
            return Some("windows".to_string());
        }
    }

    if sftp.stat("/etc/redhat-release").await.is_ok() {
        return Some("redhat".to_string());
    }
    if sftp.stat("/etc/debian_version").await.is_ok() {
        return Some("debian".to_string());
    }
    if sftp.stat("/etc/alpine-release").await.is_ok() {
        return Some("linux".to_string());
    }

    None
}

fn persist_host_os_type(state: &AppState, host_id: &str, os_type: &str) -> Result<(), String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let mut host = app
        .find_host_by_id(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;

    if host.os_type.as_deref() == Some(os_type) {
        return Ok(());
    }

    host.os_type = Some(os_type.to_string());
    app.update_host(&host).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostOsTypeUpdatedEvent {
    host_id: String,
    os_type: String,
}

pub(crate) async fn detect_and_persist_host_os_type_from_sftp(
    app_handle: AppHandle,
    host_id: String,
    sftp: Arc<zeroterm_ssh::Sftp>,
) {
    let detected = detect_remote_os_type(sftp.as_ref()).await;

    let Some(os_type) = detected else {
        debug!(host_id = %host_id, "os detect produced no result");
        return;
    };

    {
        let state = app_handle.state::<AppState>();
        if let Err(e) = persist_host_os_type(&state, &host_id, &os_type) {
            warn!(host_id = %host_id, error = %e, "persist detected os type failed");
            return;
        }
    }

    info!(host_id, "detected and persisted host os type");
    let _ = app_handle.emit(
        "host:os_type_updated",
        HostOsTypeUpdatedEvent { host_id, os_type },
    );
}

#[tauri::command]
pub async fn connect_host(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u64, String> {
    let (host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;

    let jump_summary = jump_cfg
        .as_ref()
        .map(|j| format!("{}@{}:{}", j.username, j.host, j.port));

    info!(host = %host.host, port = host.port, jump = ?jump_summary, "connecting");

    let (jump_session, mut session) = connect_host_sessions(cfg, jump_cfg).await?;

    // NOTE: compatibility-first path.
    // Some embedded SSH servers (notably on OpenWRT variants) behave
    // poorly when extra channels (SFTP probe) are opened immediately after
    // auth but before interactive shell startup. We skip eager OS probing
    // here to keep shell startup reliable.

    let forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();
    let forward_summaries: Vec<String> = Vec::new();

    let pty = PtySize::new(cols.unwrap_or(80).max(1), rows.unwrap_or(24).max(1));
    let channel = session.open_shell(pty).await.map_err(|e| e.to_string())?;

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let (control_tx, control_rx) = mpsc::channel::<SessionCommand>(64);

    let handle_clone = app_handle.clone();
    tokio::spawn(async move {
        run_session(
            session_id,
            session,
            jump_session,
            forwards,
            channel,
            control_rx,
            handle_clone,
        )
        .await;
    });

    state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
        session_id,
        SessionHandle {
            control_tx,
            forward_summaries,
            jump_summary,
        },
    );

    info!(session_id, "session ready");

    Ok(session_id)
}

#[tauri::command]
pub async fn list_port_forward_status(
    state: State<'_, AppState>,
) -> Result<Vec<PortForwardRuleStatus>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let hosts = app.list_hosts().map_err(|e| e.to_string())?;
    let rules = app.list_port_forwards().map_err(|e| e.to_string())?;
    drop(app_lock);

    let active = state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut out = Vec::new();
    for host in hosts {
        for rule in rules.iter().filter(|rule| rule.host_id == host.id) {
            let active_forward = active.iter().find_map(|(id, handle)| {
                if handle.rule_id == rule.id {
                    let state = if handle.state.load(Ordering::Relaxed) == PF_RECONNECTING {
                        "reconnecting"
                    } else {
                        "active"
                    };
                    Some(PortForwardStatus {
                        id: *id,
                        host_id: handle.host_id.clone(),
                        host_name: handle.host_name.clone(),
                        summaries: handle.summaries.clone(),
                        state,
                    })
                } else {
                    None
                }
            });
            out.push(PortForwardRuleStatus {
                id: rule.id.clone(),
                host_id: host.id.clone(),
                host_name: host.name.clone(),
                forward: ForwardSpecIO::from_app(&rule.spec),
                summary: rule.spec.summary(),
                active: active_forward,
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn list_port_forward_hosts(
    state: State<'_, AppState>,
) -> Result<Vec<PortForwardHostStatus>, String> {
    let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let hosts = app.list_hosts().map_err(|e| e.to_string())?;
    let rules = app.list_port_forwards().map_err(|e| e.to_string())?;
    drop(app_lock);

    let active = state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut out = Vec::new();
    for host in hosts {
        let host_id = host.id.clone();
        let active_forward = active.iter().find_map(|(id, handle)| {
            if handle.host_id == host_id {
                let state = if handle.state.load(Ordering::Relaxed) == PF_RECONNECTING {
                    "reconnecting"
                } else {
                    "active"
                };
                Some(PortForwardStatus {
                    id: *id,
                    host_id: handle.host_id.clone(),
                    host_name: handle.host_name.clone(),
                    summaries: handle.summaries.clone(),
                    state,
                })
            } else {
                None
            }
        });
        out.push(PortForwardHostStatus {
            host_id: host_id.clone(),
            host_name: host.name,
            forwards: rules
                .iter()
                .filter(|rule| rule.host_id == host_id)
                .map(|rule| ForwardSpecIO::from_app(&rule.spec))
                .collect(),
            active: active_forward,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn create_port_forward_rule(
    state: State<'_, AppState>,
    input: PortForwardRuleInput,
) -> Result<String, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let rule = input.into_app_rule(String::new());
    let id = app.save_port_forward(&rule).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(id)
}

#[tauri::command]
pub async fn update_port_forward_rule(
    state: State<'_, AppState>,
    id: String,
    input: PortForwardRuleInput,
) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let rule = input.into_app_rule(id);
    app.update_port_forward(&rule).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

/// Cancel and remove every running port forward whose handle matches `pred`,
/// returning how many were stopped. Cancelling makes each supervisor drop its
/// sessions/forwards (freeing the local ports) and exit. Used so deleting a
/// rule or host can't leave an orphan supervisor running — which, with
/// auto-reconnect, would otherwise keep re-establishing a tunnel for something
/// the user just deleted. `cancel()` is non-blocking, so it's safe to call
/// while holding the map lock.
fn stop_port_forwards_where(state: &AppState, pred: impl Fn(&PortForwardHandle) -> bool) -> usize {
    let mut map = state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let ids: Vec<u64> = map
        .iter()
        .filter(|(_, h)| pred(h))
        .map(|(id, _)| *id)
        .collect();
    for id in &ids {
        if let Some(handle) = map.remove(id) {
            handle.cancel.cancel();
        }
    }
    ids.len()
}

#[tauri::command]
pub async fn delete_port_forward_rule(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    id: String,
) -> Result<(), String> {
    // Stop a running tunnel for this rule first, so deleting it can't leave an
    // orphan supervisor auto-reconnecting in the background.
    let stopped = stop_port_forwards_where(&state, |h| h.rule_id == id);
    let (app, manager) = clone_app_and_sync(&state)?;
    app.delete_port_forward(&id).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    if stopped > 0 {
        let _ = app_handle.emit("port-forward:changed", ());
    }
    Ok(())
}

#[tauri::command]
pub async fn migrate_port_forward_rules(state: State<'_, AppState>) -> Result<usize, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let migrated = app
        .migrate_embedded_port_forwards()
        .map_err(|e| e.to_string())?;
    if migrated > 0 {
        manager.schedule_debounced_sync_for_all(app);
    }
    Ok(migrated)
}

/// Long-lived supervisor for one running port forward.
///
/// Owns the live SSH session(s) and forward handles. It polls the session for
/// a passive disconnect (NAT/firewall reap, transport error, or keepalive
/// timeout); on death it flips the shared state to `PF_RECONNECTING`, releases
/// the old local listen ports, and reconnects with exponential backoff —
/// rebuilding the connect chain from the vault each attempt, so host edits are
/// picked up. A user stop cancels `cancel`, which drops everything (freeing the
/// local ports) and ends the task. Every transition emits `port-forward:changed`
/// so the UI reflects active / reconnecting / stopped live.
#[allow(clippy::too_many_arguments)]
fn spawn_port_forward_supervisor(
    app_handle: AppHandle,
    id: u64,
    host_id: String,
    spec: zeroterm_app::ForwardSpec,
    pf_state: Arc<std::sync::atomic::AtomicU8>,
    cancel: tokio_util::sync::CancellationToken,
    mut jump: Option<Session>,
    mut session: Session,
    mut forwards: Vec<zeroterm_ssh::ForwardHandle>,
) {
    tokio::spawn(async move {
        loop {
            // --- monitor: tunnel is up; watch for death or user stop ---
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {
                        let jump_dead = jump.as_ref().map(|j| j.is_closed()).unwrap_or(false);
                        if session.is_closed() || jump_dead {
                            break;
                        }
                    }
                }
            }

            // --- died: enter reconnecting and free the old local ports ---
            pf_state.store(PF_RECONNECTING, Ordering::Relaxed);
            let _ = app_handle.emit("port-forward:changed", ());
            warn!(id, "port forward disconnected; reconnecting");
            forwards.clear();

            let mut backoff = Duration::from_secs(1);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }

                // Re-read host config from the vault each attempt (scoped so the
                // AppState guard never spans an await).
                let chain = {
                    let st = app_handle.state::<AppState>();
                    build_connect_chain_for_host(st.inner(), &app_handle, &host_id)
                };
                let (cfg, jump_cfg) = match chain {
                    Ok((_host, cfg, jump_cfg)) => (cfg, jump_cfg),
                    Err(e) => {
                        warn!(id, error = %e, "port forward reconnect: build chain failed");
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                        continue;
                    }
                };

                let connected = tokio::select! {
                    _ = cancel.cancelled() => return,
                    r = connect_host_sessions(cfg, jump_cfg) => r,
                };
                let (new_jump, mut new_session) = match connected {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(id, error = %e, "port forward reconnect: connect failed");
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                        continue;
                    }
                };

                let forwarded = tokio::select! {
                    _ = cancel.cancelled() => return,
                    r = start_host_forwards(&mut new_session, std::slice::from_ref(&spec)) => r,
                };
                let (new_forwards, _summaries) = match forwarded {
                    Ok(v) => v,
                    Err(e) => {
                        warn!(id, error = %e, "port forward reconnect: rebind failed");
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                        continue;
                    }
                };

                // Reconnected — swap in the new tunnel and resume monitoring.
                jump = new_jump;
                session = new_session;
                forwards = new_forwards;
                pf_state.store(PF_ACTIVE, Ordering::Relaxed);
                let _ = app_handle.emit("port-forward:changed", ());
                info!(id, "port forward reconnected");
                break;
            }
        }
    });
}

#[tauri::command]
pub async fn start_port_forward(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    rule_id: String,
) -> Result<u64, String> {
    let (host_id, spec) = {
        let app_lock = state.app.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        let rule = app
            .find_port_forward_by_id(&rule_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("no port forward rule with id {rule_id}"))?;
        (rule.host_id, rule.spec)
    };
    {
        let active = state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if active.values().any(|handle| handle.rule_id == rule_id) {
            return Err("port forward is already running".to_string());
        }
    }

    let (host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;
    if !match &spec {
        zeroterm_app::ForwardSpec::Local { enabled, .. } => *enabled,
        zeroterm_app::ForwardSpec::Remote { enabled, .. } => *enabled,
        zeroterm_app::ForwardSpec::Dynamic { enabled, .. } => *enabled,
    } {
        return Err("port forward is disabled".to_string());
    }

    let (jump_session, mut session) = connect_host_sessions(cfg, jump_cfg).await?;
    let (forwards, summaries) =
        start_host_forwards(&mut session, std::slice::from_ref(&spec)).await?;
    let id = state.next_port_forward_id.fetch_add(1, Ordering::SeqCst);
    let pf_state = Arc::new(std::sync::atomic::AtomicU8::new(PF_ACTIVE));
    let cancel = tokio_util::sync::CancellationToken::new();
    state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
        id,
        PortForwardHandle {
            host_id: host_id.clone(),
            rule_id,
            host_name: host.name,
            summaries,
            state: Arc::clone(&pf_state),
            cancel: cancel.clone(),
        },
    );
    // Hand the live sessions/forwards to a supervisor that watches for a
    // passive disconnect and auto-reconnects. The handle above only carries
    // state + the cancel signal; the supervisor owns the actual tunnel.
    spawn_port_forward_supervisor(
        app_handle.clone(),
        id,
        host_id,
        spec,
        pf_state,
        cancel,
        jump_session,
        session,
        forwards,
    );
    let _ = app_handle.emit("port-forward:changed", ());
    Ok(id)
}

#[tauri::command]
pub async fn stop_port_forward(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    id: u64,
) -> Result<(), String> {
    let removed = state.port_forwards.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&id);
    match removed {
        Some(handle) => {
            // Cancelling makes the supervisor drop its sessions and forwards
            // (releasing the local listen ports) and exit.
            handle.cancel.cancel();
            let _ = app_handle.emit("port-forward:changed", ());
            Ok(())
        }
        None => Err(format!("no port forward with id {id}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickConnectInput {
    pub user: String,
    pub host: String,
    pub port: Option<u16>,
    pub auth: QuickConnectAuthInput,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QuickConnectAuthInput {
    Password {
        value: String,
    },
    PrivateKey {
        key_pem: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[tauri::command]
pub async fn connect_quick_host(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    input: QuickConnectInput,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<u64, String> {
    let user = input.user.trim();
    let host = input.host.trim();
    if user.is_empty() || host.is_empty() {
        return Err("user and host are required".to_string());
    }
    let auth_methods = match input.auth {
        QuickConnectAuthInput::Password { value } => {
            if value.is_empty() {
                return Err("password is required".to_string());
            }
            vec![zeroterm_ssh::AuthMethod::Password(value)]
        }
        QuickConnectAuthInput::PrivateKey {
            key_pem,
            passphrase,
        } => {
            if key_pem.trim().is_empty() {
                return Err("private key is required".to_string());
            }
            vec![zeroterm_ssh::AuthMethod::PrivateKeyData {
                pem: key_pem,
                passphrase,
            }]
        }
        QuickConnectAuthInput::Agent => vec![zeroterm_ssh::AuthMethod::Agent],
    };

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| "could not locate $HOME for known_hosts".to_string())?;
    let prompt = Arc::new(TauriHostKeyPrompt {
        app_handle: app_handle.clone(),
    });
    let policy = HostKeyPolicy::Interactive {
        store: known_hosts,
        prompt,
    };

    let cfg = zeroterm_ssh::ConnectConfig {
        host: host.to_string(),
        port: input.port.unwrap_or(22),
        username: user.to_string(),
        auth_methods,
        connect_timeout: Some(Duration::from_secs(15)),
        host_key_policy: policy,
    };

    let mut session = Session::connect(cfg).await.map_err(|e| e.to_string())?;
    let forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();
    let forward_summaries: Vec<String> = Vec::new();
    let jump_summary = None;

    let pty = PtySize::new(cols.unwrap_or(80).max(1), rows.unwrap_or(24).max(1));
    let channel = session.open_shell(pty).await.map_err(|e| e.to_string())?;

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let (control_tx, control_rx) = mpsc::channel::<SessionCommand>(64);
    let handle_clone = app_handle.clone();
    tokio::spawn(async move {
        run_session(
            session_id,
            session,
            None,
            forwards,
            channel,
            control_rx,
            handle_clone,
        )
        .await;
    });

    state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
        session_id,
        SessionHandle {
            control_tx,
            forward_summaries,
            jump_summary,
        },
    );

    Ok(session_id)
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub async fn open_local_terminal() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .spawn()
            .map_err(|e| format!("open Terminal failed: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "wt"])
            .spawn()
            .or_else(|_| Command::new("cmd").args(["/C", "start", "cmd"]).spawn())
            .map_err(|e| format!("open local terminal failed: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("x-terminal-emulator")
            .spawn()
            .or_else(|_| Command::new("gnome-terminal").spawn())
            .or_else(|_| Command::new("konsole").spawn())
            .map_err(|e| format!("open local terminal failed: {e}"))?;
        return Ok(());
    }
}

/// Build the default local shell command for the current platform. Used when
/// the user hasn't configured a custom shell path in terminal settings.
fn default_local_shell_command() -> CommandBuilder {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = CommandBuilder::new("cmd.exe");
        cmd.arg("/K");
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd
    }
}

/// Byte count of a torn multi-byte UTF-8 sequence at the end of `buf`, or 0
/// when the buffer ends on a character boundary (or in bytes no continuation
/// could ever complete).
fn torn_utf8_tail_len(buf: &[u8]) -> usize {
    for back in 1..=buf.len().min(3) {
        let b = buf[buf.len() - back];
        if b & 0xC0 == 0x80 {
            continue; // continuation byte — keep scanning for its lead
        }
        let need = match b {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0, // ASCII or a byte that can't start a sequence
        };
        return if need > back { back } else { 0 };
    }
    0
}

/// One step of the local-pty stream decode: appends a read chunk to `pending`
/// and returns the bytes safe to forward now. Shell output is UTF-8, but
/// read() can split a multi-byte character at the chunk boundary — the torn
/// tail (≤3 bytes) stays in `pending` until the next read completes it.
///
/// Bytes that are invalid mid-chunk are handled per platform. On Windows the
/// whole chunk is re-encoded from GBK (winpty fallback or legacy tools
/// writing the legacy codepage). Elsewhere only the invalid sequences are
/// replaced with U+FFFD: Unix terminals are UTF-8-only, and a whole-chunk GBK
/// fallback would let one stray byte (e.g. partial writes interleaving
/// mid-character) mojibake an entire 8 KB frame. The Unix path also withholds
/// a torn UTF-8 tail before replacing, so one bad chunk can't leave the next
/// chunk starting on orphaned continuation bytes and cascade. (Not done for
/// GBK — its trailing bytes overlap UTF-8 lead bytes and would be misheld.)
fn decode_local_pty_chunk(pending: &mut Vec<u8>, chunk: &[u8]) -> Vec<u8> {
    pending.extend_from_slice(chunk);
    match std::str::from_utf8(pending) {
        Ok(_) => std::mem::take(pending),
        Err(e) if e.error_len().is_none() => {
            let tail = pending.split_off(e.valid_up_to());
            std::mem::replace(pending, tail)
        }
        Err(_) if cfg!(windows) => {
            let (cow, _) = encoding_rs::GBK.decode_without_bom_handling(pending);
            let data = cow.into_owned().into_bytes();
            pending.clear();
            data
        }
        Err(_) => {
            let tail = pending.split_off(pending.len() - torn_utf8_tail_len(pending));
            let head = std::mem::replace(pending, tail);
            String::from_utf8_lossy(&head).into_owned().into_bytes()
        }
    }
}

#[tauri::command]
pub async fn create_local_terminal_session(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    cwd: Option<String>,
) -> Result<u64, String> {
    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(LocalPtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open pty failed: {e}"))?;

    // A non-empty configured path wins; spawn it directly (no forced /K or -l,
    // since those are cmd/login-shell specific). Otherwise use the platform default.
    let mut cmd = match shell
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(prog) => CommandBuilder::new(prog),
        None => default_local_shell_command(),
    };

    // Start the shell in the configured working directory when it exists; fall
    // back to the process default rather than failing to spawn on a stale path.
    if let Some(dir) = cwd.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        if std::path::Path::new(&dir).is_dir() {
            cmd.cwd(dir);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn local shell failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("open pty writer failed: {e}"))?;
    let master = pair.master;

    let session_id = state.next_session_id.fetch_add(1, Ordering::SeqCst);
    let (writer_tx, mut writer_rx) = mpsc::channel::<Vec<u8>>(128);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(32);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(2);

    let writer = Arc::new(StdMutex::new(writer));
    let writer_ref = Arc::clone(&writer);
    tokio::spawn(async move {
        while let Some(bytes) = writer_rx.recv().await {
            let writer_ref = Arc::clone(&writer_ref);
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(mut w) = writer_ref.lock() {
                    let _ = w.write_all(&bytes);
                    let _ = w.flush();
                }
            })
            .await;
        }
    });

    let master_ref = Arc::new(StdMutex::new(master));
    let master_resize_ref = Arc::clone(&master_ref);
    tokio::spawn(async move {
        while let Some((c, r)) = resize_rx.recv().await {
            let master_resize_ref = Arc::clone(&master_resize_ref);
            let _ = tokio::task::spawn_blocking(move || {
                if let Ok(m) = master_resize_ref.lock() {
                    let _ = m.resize(LocalPtySize {
                        rows: r.max(1),
                        cols: c.max(1),
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            })
            .await;
        }
    });

    let app_for_read = app_handle.clone();
    tokio::task::spawn_blocking(move || {
        let mut buf = vec![0u8; 8192];
        // Carries a UTF-8 sequence split across reads; see decode_local_pty_chunk.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_local_pty_chunk(&mut pending, &buf[..n]);
                    if data.is_empty() {
                        continue;
                    }
                    let _ = app_for_read.emit(
                        "session:data",
                        crate::session::DataEvent { session_id, data },
                    );
                }
                Err(_) => break,
            }
        }
        // A torn character can be left behind when the pty closes mid-sequence.
        if !pending.is_empty() {
            let _ = app_for_read.emit(
                "session:data",
                crate::session::DataEvent {
                    session_id,
                    data: String::from_utf8_lossy(&pending).into_owned().into_bytes(),
                },
            );
        }
    });

    let app_for_close = app_handle.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = shutdown_rx.recv() => {}
            _ = tokio::task::spawn_blocking(move || {
                let mut child = child;
                let _ = child.wait();
            }) => {}
        }
        let _ = app_for_close.emit(
            "session:closed",
            ClosedEvent {
                session_id,
                exit_code: None,
                message: None,
            },
        );
    });

    state.local_sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
        session_id,
        LocalSessionHandle {
            writer_tx,
            resize_tx,
            shutdown_tx,
        },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn send_input(
    state: State<'_, AppState>,
    session_id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
    let local_tx = {
        let locals = state.local_sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        locals.get(&session_id).map(|h| h.writer_tx.clone())
    };
    if let Some(tx) = local_tx {
        tx.send(data)
            .await
            .map_err(|_| "local session task closed".to_string())?;
        return Ok(());
    }

    let tx = {
        let sessions = state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions
            .get(&session_id)
            .ok_or_else(|| format!("session {session_id} not found"))?
            .control_tx
            .clone()
    };
    tx.send(SessionCommand::Input(data))
        .await
        .map_err(|_| "session task closed".to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiTerminalCommandClass {
    ReadOnly,
    Mutating,
    ApprovalRequired,
    UserInputRequired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTerminalCommandPolicy {
    classification: String,
    auto_allowed: bool,
    reason: String,
}

fn ai_terminal_command_class(command: &str) -> (AiTerminalCommandClass, &'static str) {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return (AiTerminalCommandClass::ApprovalRequired, "empty command");
    }
    if trimmed.contains(['\n', '\r']) || trimmed.chars().any(char::is_control) {
        return (AiTerminalCommandClass::ApprovalRequired, "multi-line or control-character command");
    }
    if ai_terminal_command_contains_placeholder(trimmed) {
        return (
            AiTerminalCommandClass::UserInputRequired,
            "command contains an unresolved placeholder",
        );
    }

    // Shell composition can hide a destructive second operation. Keep the
    // automatic path deliberately conservative and leave composed commands to
    // the existing per-command approval button.
    const SHELL_META: [&str; 9] = ["&&", "||", "$(", "`", ";", "|", ">", "<", "&"];
    if SHELL_META.iter().any(|token| trimmed.contains(token)) {
        return (AiTerminalCommandClass::ApprovalRequired, "shell composition or redirection");
    }

    let words: Vec<&str> = trimmed.split_whitespace().collect();
    let program = words.first().map(|word| word.trim_matches(['\'', '"'])).unwrap_or("");
    let program = program.rsplit('/').next().unwrap_or(program).to_ascii_lowercase();
    let subcommand = words.get(1).map(|word| word.to_ascii_lowercase()).unwrap_or_default();

    const ALWAYS_APPROVE: &[&str] = &[
        "sudo", "su", "doas", "rm", "rmdir", "dd", "mkfs", "fdisk", "parted",
        "shutdown", "reboot", "poweroff", "halt", "kill", "pkill", "killall", "chmod",
        "chown", "chgrp", "mount", "umount", "systemctl", "service", "launchctl", "curl",
        "wget", "ssh", "scp", "sftp", "rsync", "docker", "podman", "kubectl", "helm",
        "apt", "apt-get", "yum", "dnf", "pacman", "brew", "eval", "exec", "source",
        "del", "erase", "format", "diskpart", "taskkill", "runas", "reg", "sc",
        "remove-item", "clear-content", "stop-computer", "restart-computer", "format-volume",
        "invoke-webrequest", "invoke-restmethod", "iwr", "irm",
        "xargs", "nice", "nohup", "timeout", "builtin",
    ];
    if ALWAYS_APPROVE.contains(&program.as_str()) {
        return (AiTerminalCommandClass::ApprovalRequired, "privileged, destructive, remote, or system command");
    }
    if ["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].contains(&program.as_str())
        && words.iter().skip(1).any(|word| matches!(word.to_ascii_lowercase().as_str(), "-c" | "-command" | "/c"))
    {
        return (AiTerminalCommandClass::ApprovalRequired, "nested shell execution");
    }
    if program == "git" && ["reset", "clean", "push", "rebase", "filter-branch"].contains(&subcommand.as_str()) {
        return (AiTerminalCommandClass::ApprovalRequired, "high-impact git operation");
    }
    if program == "git" && subcommand == "branch"
        && words.iter().skip(2).any(|word| matches!(*word, "-d" | "-D" | "--delete"))
    {
        return (AiTerminalCommandClass::ApprovalRequired, "git branch deletion");
    }
    if program == "git" && subcommand == "remote"
        && words.iter().skip(2).any(|word| matches!(*word, "add" | "remove" | "rm" | "rename" | "set-url"))
    {
        return (AiTerminalCommandClass::ApprovalRequired, "git remote mutation");
    }
    if program == "env" && words.len() > 1 {
        return (AiTerminalCommandClass::ApprovalRequired, "environment wrapper can execute another command");
    }
    if program == "command" {
        if words.get(1).is_some_and(|word| *word == "-v") {
            return (AiTerminalCommandClass::ReadOnly, "recognized command lookup");
        }
        return (AiTerminalCommandClass::ApprovalRequired, "shell wrapper can execute another command");
    }

    if program == "find" && words.iter().skip(1).any(|word| {
        matches!(word.to_ascii_lowercase().as_str(), "-exec" | "-execdir" | "-ok" | "-okdir" | "-delete")
    }) {
        return (AiTerminalCommandClass::ApprovalRequired, "find action can execute or delete content");
    }
    if program == "dmesg" && words.iter().skip(1).any(|word| matches!(*word, "-C" | "--clear")) {
        return (AiTerminalCommandClass::ApprovalRequired, "command clears the kernel message buffer");
    }

    const READ_ONLY: &[&str] = &[
        "pwd", "ls", "dir", "cat", "head", "tail", "grep", "rg", "find", "fd", "stat",
        "file", "wc", "which", "where", "whereis", "type", "whoami", "id", "uname", "date",
        "uptime", "df", "du", "free", "ps", "pgrep", "printenv", "ss", "netstat", "lsof",
        "dmesg",
    ];
    if READ_ONLY.contains(&program.as_str()) {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only inspection command");
    }
    if program == "env" && words.len() == 1 {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only environment inspection");
    }
    if program == "ip" && !words.iter().skip(1).any(|word| {
        matches!(word.to_ascii_lowercase().as_str(), "set" | "add" | "del" | "delete" | "replace" | "flush")
    }) {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only network inspection");
    }
    if program == "ifconfig" && !words.iter().skip(1).any(|word| matches!(word.to_ascii_lowercase().as_str(), "up" | "down")) {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only network inspection");
    }
    if program == "git" && ["status", "log", "diff", "show"].contains(&subcommand.as_str()) {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only git command");
    }
    if program == "git" && subcommand == "branch"
        && !words.iter().skip(2).any(|word| matches!(*word, "-d" | "-D" | "--delete"))
    {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only git branch listing");
    }
    if program == "git" && subcommand == "remote" && words.iter().skip(2).all(|word| matches!(*word, "-v" | "--verbose")) {
        return (AiTerminalCommandClass::ReadOnly, "recognized read-only git remote listing");
    }

    (AiTerminalCommandClass::Mutating, "command may change terminal or filesystem state")
}

fn ai_terminal_command_contains_placeholder(command: &str) -> bool {
    let lower = command.to_lowercase();
    const MARKERS: &[&str] = &[
        "你的密钥",
        "您的密钥",
        "你的 api key",
        "您的 api key",
        "你的apikey",
        "您的apikey",
        "你的令牌",
        "您的令牌",
        "你的密码",
        "您的密码",
        "请替换",
        "替换为实际",
        "替换成实际",
        "your api key",
        "your_api_key",
        "your-api-key",
        "your token",
        "your_token",
        "your-token",
        "your password",
        "your_password",
        "your-password",
        "your secret",
        "your_secret",
        "your-secret",
        "replace_me",
        "replace-me",
        "changeme",
        "api_key_here",
        "token_here",
        "password_here",
    ];
    if MARKERS.iter().any(|marker| lower.contains(marker)) {
        return true;
    }

    let mut rest = lower.as_str();
    while let Some(start) = rest.find('<') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find('>') else {
            break;
        };
        let placeholder = &rest[..end];
        if ["key", "token", "password", "secret", "host", "user", "path", "value"]
            .iter()
            .any(|keyword| placeholder.contains(keyword))
        {
            return true;
        }
        rest = &rest[end + 1..];
    }
    false
}

#[tauri::command]
pub async fn authorize_ai_terminal_command(
    state: State<'_, AppState>,
    session_id: u64,
    mode: String,
    command: String,
) -> Result<AiTerminalCommandPolicy, String> {
    let has_local = state
        .local_sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(&session_id);
    let has_remote = state
        .sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .contains_key(&session_id);
    if !has_local && !has_remote {
        return Err(format!("session {session_id} not found"));
    }

    if !matches!(mode.as_str(), "manual" | "read_only" | "supervised") {
        return Err("invalid AI terminal-control mode".to_string());
    }
    let (class, reason) = ai_terminal_command_class(&command);
    let classification = match class {
        AiTerminalCommandClass::ReadOnly => "read_only",
        AiTerminalCommandClass::Mutating => "mutating",
        AiTerminalCommandClass::ApprovalRequired => "approval_required",
        AiTerminalCommandClass::UserInputRequired => "user_input_required",
    };
    let auto_allowed = matches!(mode.as_str(), "read_only" | "supervised")
        && (class == AiTerminalCommandClass::ReadOnly
            || (mode == "supervised" && class == AiTerminalCommandClass::Mutating));
    Ok(AiTerminalCommandPolicy {
        classification: classification.to_string(),
        auto_allowed,
        reason: reason.to_string(),
    })
}

#[tauri::command]
pub async fn resize_session(
    state: State<'_, AppState>,
    session_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let local_tx = {
        let locals = state.local_sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        locals.get(&session_id).map(|h| h.resize_tx.clone())
    };
    if let Some(tx) = local_tx {
        let _ = tx.send((cols, rows)).await;
        return Ok(());
    }

    let tx = {
        let sessions = state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        match sessions.get(&session_id) {
            Some(h) => h.control_tx.clone(),
            None => return Ok(()), // session already gone — ignore
        }
    };
    let _ = tx.send(SessionCommand::Resize(cols, rows)).await;
    Ok(())
}

#[tauri::command]
pub async fn disconnect_session(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: u64,
) -> Result<(), String> {
    let local_tx_opt = {
        let mut locals = state.local_sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        locals.remove(&session_id).map(|h| h.shutdown_tx)
    };
    if let Some(tx) = local_tx_opt {
        let _ = tx.send(()).await;
        debug!(session_id, "local disconnect requested");
        return Ok(());
    }

    let tx_opt = {
        let sessions = state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        sessions.get(&session_id).map(|h| h.control_tx.clone())
    };
    if let Some(tx) = tx_opt {
        let _ = tx.send(SessionCommand::Disconnect).await;
    } else {
        // Already gone — emit a synthetic closed so the frontend cleans up.
        let _ = app_handle.emit(
            "session:closed",
            ClosedEvent {
                session_id,
                exit_code: None,
                message: Some("session not found".into()),
            },
        );
    }
    debug!(session_id, "disconnect requested");
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Human-readable summaries: e.g. `["L 8080:127.0.0.1:80", "D 1080"]`.
    pub forwards: Vec<String>,
    /// Jump host display name, like `me@bastion:22`, or `None` if direct.
    pub jump: Option<String>,
}

#[tauri::command]
pub async fn session_info(
    state: State<'_, AppState>,
    session_id: u64,
) -> Result<SessionInfo, String> {
    let sessions = state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let h = sessions
        .get(&session_id)
        .ok_or_else(|| format!("no session {session_id}"))?;
    Ok(SessionInfo {
        forwards: h.forward_summaries.clone(),
        jump: h.jump_summary.clone(),
    })
}

// --------------------------------------------------------------------------
// host-key prompt response
// --------------------------------------------------------------------------

#[tauri::command]
pub async fn respond_host_key(
    state: State<'_, AppState>,
    request_id: String,
    accept: bool,
    mode: Option<String>,
) -> Result<(), String> {
    let tx = { state.pending_host_key.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&request_id) };
    if let Some(tx) = tx {
        let response = if accept {
            match mode.as_deref() {
                Some("accept_and_replace") => crate::host_key::HostKeyResponse::AcceptAndReplace,
                _ => crate::host_key::HostKeyResponse::AcceptOnce,
            }
        } else {
            crate::host_key::HostKeyResponse::Reject
        };
        let _ = tx.send(response);
        Ok(())
    } else {
        Err(format!("no pending host-key prompt with id {request_id}"))
    }
}

// --------------------------------------------------------------------------
// sftp
// --------------------------------------------------------------------------

fn local_home_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return Ok(PathBuf::from(home));
        }
        let drive = std::env::var_os("HOMEDRIVE");
        let path = std::env::var_os("HOMEPATH");
        if let (Some(d), Some(p)) = (drive, path) {
            let mut pb = PathBuf::from(d);
            pb.push(p);
            return Ok(pb);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home));
        }
    }
    std::env::current_dir().map_err(|e| format!("cannot resolve local home directory: {e}"))
}

fn local_kind_str(ft: &fs::FileType) -> &'static str {
    if ft.is_dir() {
        "dir"
    } else if ft.is_file() {
        "file"
    } else if ft.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

#[tauri::command]
pub async fn local_home_path() -> Result<String, String> {
    let home = local_home_dir()?;
    Ok(home.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<Vec<DirEntryDto>, String> {
    let pb = PathBuf::from(&path);
    let mut out = Vec::new();
    let rd = fs::read_dir(&pb).map_err(|e| format!("read_dir {}: {e}", pb.display()))?;

    for item in rd {
        let entry = item.map_err(|e| format!("read_dir entry {}: {e}", pb.display()))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path();
        // Windows may return reserved devices such as `nul` while walking a
        // directory. They cannot be stat'ed as normal paths (`ERROR_INVALID_FUNCTION`),
        // so omit that one unusable entry instead of failing the whole listing.
        let meta = match fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(error) => {
                warn!(path = %full.display(), error = %error, "skipping unreadable local directory entry");
                continue;
            }
        };
        let ft = meta.file_type();
        let kind = local_kind_str(&ft);
        let size = if ft.is_file() { meta.len() } else { 0 };
        out.push(DirEntryDto { name, kind, size });
    }

    out.sort_by(|a, b| {
        let order = |k: &str| if k == "dir" { 0 } else { 1 };
        order(a.kind)
            .cmp(&order(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

#[tauri::command]
pub async fn local_path_exists(path: String) -> Result<bool, String> {
    match fs::symlink_metadata(&path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!("stat {}: {err}", path)),
    }
}

#[tauri::command]
pub async fn local_file_fingerprint(path: String) -> Result<LocalFileFingerprintDto, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path));
    }
    let modified = meta
        .modified()
        .map_err(|e| format!("read modified time {}: {e}", path))?;
    let modified_at_nanos = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("invalid modified time {}: {e}", path))?
        .as_nanos()
        .to_string();
    Ok(LocalFileFingerprintDto {
        size: meta.len(),
        modified_at_nanos,
    })
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| format!("mkdir {}: {e}", path))
}

#[tauri::command]
pub async fn local_remove(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("remove file {}: {e}", path))
}

fn validate_local_removable_dir(path: &Path) -> Result<(), String> {
    let refuse = |why: &str| {
        Err(format!(
            "refusing to recursively remove {}: {why}",
            path.display()
        ))
    };
    if !path.is_absolute() || path.parent().is_none() {
        return refuse("not an absolute path with a parent");
    }
    // Resolve `..`/symlink games in the *parent*; keep the leaf as
    // named so a symlinked leaf is removed as a link, not followed.
    let Some(parent) = path.parent() else {
        return refuse("no parent directory");
    };
    let Some(leaf) = path.file_name() else {
        return refuse("no final path component");
    };
    let canonical = match parent.canonicalize() {
        Ok(p) => p.join(leaf),
        Err(e) => return Err(format!("resolving {}: {e}", path.display())),
    };
    // Never the filesystem root or a top-level directory (`/home`,
    // `/Users`, `/etc`, `C:\Windows`, …). Count only named components
    // so the Windows drive prefix doesn't inflate the depth.
    let depth = canonical
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .count();
    if depth <= 1 {
        return refuse("filesystem root or top-level directory");
    }
    // Never the user's home directory or any ancestor of it — an
    // injected `local_remove_dir("/Users/me")` must not wipe the
    // account even though it is "an absolute path with a parent".
    if let Some(home) = dirs::home_dir().and_then(|h| h.canonicalize().ok()) {
        if home.starts_with(&canonical) {
            return refuse("the home directory (or an ancestor of it)");
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn local_remove_dir(path: String) -> Result<(), String> {
    validate_local_removable_dir(Path::new(&path))?;
    fs::remove_dir_all(&path).map_err(|e| format!("remove dir {}: {e}", path))
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| format!("rename {} -> {}: {e}", from, to))
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub async fn local_permission_mode(path: String) -> Result<FilePermissionModeDto, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("stat {}: {e}", path))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        return Ok(FilePermissionModeDto {
            mode: Some(meta.mode() & 0o7777),
        });
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        Ok(FilePermissionModeDto { mode: None })
    }
}

#[tauri::command]
pub async fn local_chmod(path: String, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = fs::Permissions::from_mode(mode & 0o7777);
        fs::set_permissions(&path, perms).map_err(|e| format!("chmod {} {:o}: {e}", path, mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Err("editing permissions is only supported on Unix-like systems in this build".to_string())
    }
}

#[tauri::command]
pub async fn temp_open_path(file_name: String) -> Result<String, String> {
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("file.bin");
    let mut dir = env::temp_dir();
    dir.push("zeroterm-open-with");
    fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;

    let stem = Path::new(safe_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let ext = Path::new(safe_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let unique = uuid::Uuid::new_v4().to_string();
    let target_name = if ext.is_empty() {
        format!("{stem}-{unique}")
    } else {
        format!("{stem}-{unique}.{ext}")
    };
    Ok(dir.join(target_name).to_string_lossy().to_string())
}

/// Is `app_path` an acceptable "open with" application target?
///
/// `app_path` becomes the executable in a `spawn()` (or the `-a`
/// argument to macOS `open`), so an unconstrained value is arbitrary
/// code execution the moment any XSS reaches `invoke`. We accept it only
/// when it is a real application the user pointed us at:
///   - a path the user picked this session through `pick_local_file`, or
///   - an entry under a known system applications directory.
fn validate_open_with_app(state: &State<'_, AppState>, app_path: &str) -> Result<(), String> {
    if is_dialog_granted(state, app_path) {
        return Ok(());
    }
    let canonical = std::fs::canonicalize(app_path)
        .map_err(|e| format!("resolving application {app_path}: {e}"))?;

    #[cfg(target_os = "macos")]
    let roots: &[&str] = &["/Applications", "/System/Applications"];
    #[cfg(target_os = "windows")]
    let roots: &[&str] = &["C:\\Program Files", "C:\\Program Files (x86)"];
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let roots: &[&str] = &["/usr/bin", "/usr/local/bin", "/opt", "/snap", "/var/lib/flatpak"];

    let under_system_root = roots.iter().any(|r| {
        std::fs::canonicalize(r)
            .map(|root| canonical.starts_with(root))
            .unwrap_or(false)
    });
    if under_system_root {
        Ok(())
    } else {
        Err(format!(
            "application `{app_path}` must be chosen through the picker or live under a system apps directory"
        ))
    }
}

#[tauri::command]
#[allow(clippy::needless_return)]
pub async fn open_with_app(
    state: State<'_, AppState>,
    file_path: String,
    app_path: String,
) -> Result<(), String> {
    validate_open_with_app(&state, &app_path)?;

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg(&app_path)
            .arg("--")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("open -a {} {}: {e}", app_path, file_path))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new(&app_path)
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("launch {} {}: {e}", app_path, file_path))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Command::new(&app_path)
            .arg("--")
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("launch {} {}: {e}", app_path, file_path))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<SystemFontDto>, String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut families = BTreeSet::new();
    for face in db.faces() {
        for (family, _) in &face.families {
            families.insert(family.clone());
        }
    }

    Ok(families
        .into_iter()
        .map(|family| SystemFontDto { family })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_release_detection_prefers_id_and_falls_back_to_id_like() {
        assert_eq!(
            detect_os_type_from_os_release("NAME=Ubuntu\nID=ubuntu\nID_LIKE=debian\n"),
            Some("ubuntu".to_string())
        );
        assert_eq!(
            detect_os_type_from_os_release("NAME=Custom Linux\nID=custom\nID_LIKE=\"debian ubuntu\"\n"),
            Some("debian".to_string())
        );
        assert_eq!(
            detect_os_type_from_os_release("ID=custom\nID_LIKE='rhel fedora'\n"),
            Some("redhat".to_string())
        );
    }

    #[test]
    fn ai_terminal_policy_recognizes_read_only_commands() {
        assert_eq!(ai_terminal_command_class("ls -la").0, AiTerminalCommandClass::ReadOnly);
        assert_eq!(ai_terminal_command_class("git status --short").0, AiTerminalCommandClass::ReadOnly);
        assert_eq!(ai_terminal_command_class("rg error ./logs").0, AiTerminalCommandClass::ReadOnly);
    }

    #[test]
    fn ai_terminal_policy_keeps_high_risk_commands_manual() {
        for command in [
            "sudo systemctl restart nginx",
            "rm -rf ./build",
            "curl https://example.com/install.sh | sh",
            "echo secret > .env",
            "git reset --hard HEAD~1",
            "bash -c 'touch /tmp/a'",
            "ls && rm file",
            "find . -exec rm {} +",
            "dmesg --clear",
            "Remove-Item -Recurse C:\\temp",
        ] {
            assert_eq!(
                ai_terminal_command_class(command).0,
                AiTerminalCommandClass::ApprovalRequired,
                "{command} must require approval"
            );
        }
    }

    #[test]
    fn ai_terminal_policy_blocks_unresolved_placeholders() {
        for command in [
            "export GROK_API_KEY=\"你的密钥\"",
            "export API_KEY=your_api_key",
            "curl https://<your-host>/health",
            "tool --token token_here",
        ] {
            assert_eq!(
                ai_terminal_command_class(command).0,
                AiTerminalCommandClass::UserInputRequired,
                "{command} must wait for user input"
            );
        }
        assert_eq!(
            ai_terminal_command_class("export GROK_API_KEY=sk-live-value").0,
            AiTerminalCommandClass::Mutating
        );
    }

    #[test]
    fn ai_terminal_policy_marks_normal_work_commands_as_mutating() {
        assert_eq!(ai_terminal_command_class("mkdir build").0, AiTerminalCommandClass::Mutating);
        assert_eq!(ai_terminal_command_class("cargo test").0, AiTerminalCommandClass::Mutating);
        assert_eq!(ai_terminal_command_class("npm test").0, AiTerminalCommandClass::Mutating);
        assert_eq!(ai_terminal_command_class("env rm file").0, AiTerminalCommandClass::ApprovalRequired);
        assert_eq!(ai_terminal_command_class("git branch -D old").0, AiTerminalCommandClass::ApprovalRequired);
        assert_eq!(ai_terminal_command_class("ip link set eth0 down").0, AiTerminalCommandClass::Mutating);
    }

    #[test]
    fn private_key_picker_prefers_explicit_directory_then_ssh_directory() {
        let root = std::env::temp_dir().join(format!("zeroterm-picker-{}", uuid::Uuid::new_v4()));
        let explicit = root.join("explicit");
        let ssh = root.join(".ssh");
        std::fs::create_dir_all(&explicit).unwrap();
        std::fs::create_dir_all(&ssh).unwrap();

        assert_eq!(
            picker_starting_directory(explicit.to_str(), Some(ssh.clone())),
            Some(explicit.clone())
        );
        assert_eq!(
            picker_starting_directory(Some("/path/that/does/not/exist"), Some(ssh.clone())),
            Some(ssh)
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recursive_local_delete_rejects_relative_and_root_paths() {
        assert!(validate_local_removable_dir(Path::new(".")).is_err());
        #[cfg(unix)]
        assert!(validate_local_removable_dir(Path::new("/")).is_err());
        // A real, deep, existing directory is fine.
        let deep = std::env::temp_dir().join("zeroterm-rmtest-child");
        std::fs::create_dir_all(&deep).unwrap();
        assert!(validate_local_removable_dir(&deep).is_ok());
        let _ = std::fs::remove_dir_all(&deep);
    }

    #[cfg(unix)]
    #[test]
    fn recursive_local_delete_rejects_top_level_and_home() {
        // Top-level directories (depth <= 2) are refused.
        assert!(validate_local_removable_dir(Path::new("/home")).is_err());
        assert!(validate_local_removable_dir(Path::new("/etc")).is_err());
        // The home directory itself is refused even though it is a deep
        // absolute path with a parent.
        if let Some(home) = dirs::home_dir() {
            assert!(
                validate_local_removable_dir(&home).is_err(),
                "home dir must not be recursively removable"
            );
        }
    }

    #[test]
    fn metrics_parser_reads_outbound_ip_type() {
        let metrics = parse_metrics_output(
            "ZT_METRICS_V1\nnode-1\nLinux\nx86_64\n3600\n4\n100 20\n200 30\n1024 512 0 0\nO|dual\n",
        )
        .unwrap();
        assert_eq!(metrics.outbound_ip_type, "dual");
    }

    #[test]
    fn linux_metrics_script_uses_wide_memory_byte_format() {
        assert!(METRICS_SCRIPT.contains("printf \"%.0f %.0f %.0f %.0f\\n\", mt, mt-ma, st, st-sf"));
        assert!(!METRICS_SCRIPT.contains("printf \"%d %d %d %d\\n\", mt, mt-ma, st, st-sf"));
    }

    #[test]
    fn docker_args_allow_lifecycle_but_reject_run_and_exec() {
        assert!(validate_docker_args(&["ps".into(), "-a".into()]).is_ok());
        assert!(validate_docker_args(&["stop".into(), "abc".into()]).is_ok());
        assert!(validate_docker_args(&["logs".into(), "abc".into()]).is_ok());
        // The dangerous verbs an injected script would reach for.
        assert!(validate_docker_args(&["run".into(), "-v".into(), "/:/host".into()]).is_err());
        assert!(validate_docker_args(&["exec".into(), "c".into(), "sh".into()]).is_err());
        assert!(validate_docker_args(&["cp".into()]).is_err());
        assert!(validate_docker_args(&["build".into()]).is_err());
        assert!(validate_docker_args(&[]).is_err());
    }

    #[test]
    fn system_service_parser_preserves_descriptions_and_states() {
        let rows = parse_system_services(
            "ssh.service loaded active running OpenBSD Secure Shell server\n\
             cron.service loaded inactive dead Regular background program processing daemon\n\
             dev-sda.device loaded active plugged Disk\n",
            "system",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].name, "ssh.service");
        assert_eq!(rows[0].scope, "system");
        assert_eq!(rows[0].active_state, "active");
        assert_eq!(rows[0].sub_state, "running");
        assert_eq!(rows[0].description, "OpenBSD Secure Shell server");
        assert_eq!(
            rows[1].description,
            "Regular background program processing daemon"
        );
    }

    #[test]
    fn system_services_are_grouped_by_fragment_origin_not_manager_scope() {
        let mut rows = parse_system_services(
            "custom-api.service loaded active running Custom API\n\
             dbus.service loaded active running D-Bus System Message Bus\n",
            "system",
        );
        let paths = parse_system_service_fragment_paths(
            "Id=custom-api.service\nFragmentPath=/etc/systemd/system/custom-api.service\n\n\
             Id=dbus.service\nFragmentPath=/usr/lib/systemd/system/dbus.service\n",
        );
        assign_system_service_groups(&mut rows, &paths);
        assert_eq!(rows[0].group, "custom");
        assert_eq!(rows[0].scope, "system");
        assert_eq!(rows[1].group, "system");

        let mut user_rows = parse_system_services(
            "my-agent.service loaded active running My Agent\n\
             dbus.service loaded inactive dead D-Bus User Message Bus\n",
            "user",
        );
        let user_paths = parse_system_service_fragment_paths(
            "Id=my-agent.service\nFragmentPath=/home/me/.config/systemd/user/my-agent.service\n\n\
             Id=dbus.service\nFragmentPath=/usr/lib/systemd/user/dbus.service\n",
        );
        assign_system_service_groups(&mut user_rows, &user_paths);
        assert_eq!(user_rows[0].group, "custom");
        assert_eq!(user_rows[0].scope, "user");
        assert_eq!(user_rows[1].group, "system");
    }

    #[test]
    fn system_service_actions_are_narrowly_validated() {
        assert!(validate_system_service_action("start", "nginx.service", "system").is_ok());
        assert!(
            validate_system_service_action("restart", "app@worker-1.service", "user").is_ok()
        );
        assert!(validate_system_service_action("status", "nginx.service", "system").is_err());
        assert!(validate_system_service_action("stop", "--now.service", "system").is_err());
        assert!(
            validate_system_service_action("stop", "nginx.service; reboot", "system").is_err()
        );
        assert!(validate_system_service_action("stop", "nginx.socket", "system").is_err());
        assert!(validate_system_service_action("stop", "nginx.service", "global").is_err());
        assert!(validate_system_service_target("nginx.service", "system").is_ok());
        assert!(validate_system_service_target("app@worker.service", "user").is_ok());
        assert!(validate_system_service_target("../../etc/passwd", "system").is_err());
        assert!(validate_system_service_target("nginx.service; cat /etc/passwd", "system").is_err());
    }

    #[test]
    fn local_pty_decode_carries_utf8_split_across_reads() {
        let bytes = "回显中文".as_bytes(); // 3 bytes per char
        let mut pending = Vec::new();
        let mut out = Vec::new();
        // Boundary lands inside the second character.
        out.extend(decode_local_pty_chunk(&mut pending, &bytes[..4]));
        out.extend(decode_local_pty_chunk(&mut pending, &bytes[4..]));
        assert_eq!(out, bytes);
        assert!(pending.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn local_pty_decode_still_falls_back_to_gbk() {
        // "你好" encoded as GBK, split so the first read alone looks like an
        // incomplete UTF-8 sequence.
        let gbk = [0xC4u8, 0xE3, 0xBA, 0xC3];
        let mut pending = Vec::new();
        let mut out = Vec::new();
        out.extend(decode_local_pty_chunk(&mut pending, &gbk[..1]));
        out.extend(decode_local_pty_chunk(&mut pending, &gbk[1..]));
        assert_eq!(String::from_utf8(out).unwrap(), "你好");
        assert!(pending.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn local_pty_decode_replaces_stray_byte_without_gbk_mojibake() {
        // One invalid byte inside a chunk of box-drawing characters must not
        // re-decode the whole chunk as GBK ("──" would become "鈹€鈹€").
        let mut bytes = "─".as_bytes().to_vec();
        bytes.push(0xFF);
        bytes.extend_from_slice("─".as_bytes());
        let mut pending = Vec::new();
        let out = decode_local_pty_chunk(&mut pending, &bytes);
        assert_eq!(String::from_utf8(out).unwrap(), "─\u{FFFD}─");
        assert!(pending.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn local_pty_decode_does_not_cascade_after_stray_byte() {
        // A chunk holding both an invalid byte and a torn trailing character:
        // the torn tail must stay pending so the next chunk doesn't start on
        // orphaned continuation bytes and mojibake in turn.
        let full = "─│".as_bytes(); // two 3-byte characters
        let mut first = vec![0xFFu8];
        first.extend_from_slice(&full[..4]); // "─" + first byte of "│"
        let mut pending = Vec::new();
        let mut out = Vec::new();
        out.extend(decode_local_pty_chunk(&mut pending, &first));
        out.extend(decode_local_pty_chunk(&mut pending, &full[4..]));
        assert_eq!(String::from_utf8(out).unwrap(), "\u{FFFD}─│");
        assert!(pending.is_empty());
    }

    #[test]
    fn sse_push_carries_utf8_split_across_chunks() {
        let bytes = "data: 中文\n\n".as_bytes();
        let mut buffer = String::new();
        let mut carry = Vec::new();
        // Boundary lands inside 中 ("data: " is 6 bytes).
        push_utf8_chunk(&mut buffer, &mut carry, &bytes[..8]);
        assert!(!buffer.contains('\u{FFFD}'));
        push_utf8_chunk(&mut buffer, &mut carry, &bytes[8..]);
        assert_eq!(buffer, "data: 中文\n\n");
        assert!(carry.is_empty());
    }

    #[test]
    fn tool_choice_compat_detects_gateway_rejection() {
        assert!(needs_tool_choice_compat(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"code":"invalid-argument","error":"Invalid request content: A tool_choice was set on the request but no tools were specified."}"#,
        ));
        assert!(!needs_tool_choice_compat(
            reqwest::StatusCode::BAD_REQUEST,
            "model not found",
        ));
        // Server-side failures are not a request-shape problem.
        assert!(!needs_tool_choice_compat(
            reqwest::StatusCode::INTERNAL_SERVER_ERROR,
            "tool_choice",
        ));
    }

    #[test]
    fn tool_choice_compat_adds_placeholder_tools() {
        let mut body = json!({ "model": "m", "messages": [] });
        apply_tool_choice_compat(&mut body);
        assert_eq!(body["tool_choice"], json!("none"));
        let tools = body["tools"].as_array().expect("tools array");
        assert!(!tools.is_empty());
    }
}
