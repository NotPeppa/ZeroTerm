//! Tauri command surface — the JS-callable API.
//!
//! Conventions:
//!   - All commands return `Result<T, String>` so error messages cross
//!     the IPC boundary cleanly. We pretty-print the underlying error.
//!   - Sync mutexes are acquired in tight blocks; `await` happens after
//!     the lock is dropped.

use std::sync::atomic::Ordering;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::process::Command;
#[cfg(not(target_os = "windows"))]
use tokio::process::Command;
use std::{
    env,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use futures_util::StreamExt;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};
use portable_pty::{CommandBuilder, PtySize as LocalPtySize};
use std::io::{Read, Write};
use std::sync::Mutex as StdMutex;

use zeroterm_app::{App, HostAuth, SyncBackend, SyncProfile};
use zeroterm_ssh::{FileKind, HostKeyPolicy, KnownHosts, PtySize, Session};
use tauri_plugin_updater::UpdaterExt;

use crate::host_key::TauriHostKeyPrompt;
use crate::session::{run as run_session, ClosedEvent};
use crate::state::{AppState, LocalSessionHandle, SessionCommand, SessionHandle, SftpHandle};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePermissionModeDto {
    pub mode: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFontDto {
    pub family: String,
}

const AI_CONFIG_FILE: &str = "ai-config.json";
const AI_SESSION_FILE: &str = "ai-sessions.json";
const AI_KEYCHAIN_PROFILE: &str = "default";
const AI_SESSION_MAX_ITEMS: usize = 80;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub command_results: Vec<AiCommandResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommandResult {
    pub command: String,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamEvent {
    pub request_id: String,
    pub delta: String,
    pub done: bool,
    pub error: Option<String>,
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
}

fn default_ai_config() -> AiConfig {
    AiConfig {
        provider: "openai-compatible".to_string(),
        base_url: "".to_string(),
        model: "gpt-4.1".to_string(),
        safe_mode: true,
        auto_read: true,
        show_commands: false,
        has_api_key: false,
    }
}

fn ai_config_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "no config directory on this OS".to_string())?
        .join("ZeroTerm");
    Ok(base.join(AI_CONFIG_FILE))
}

fn ai_session_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "no config directory on this OS".to_string())?
        .join("ZeroTerm");
    Ok(base.join(AI_SESSION_FILE))
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

fn read_ai_config_from_disk() -> Result<AiConfig, String> {
    let path = ai_config_path()?;
    if !path.exists() {
        return Ok(default_ai_config());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let cfg: AiConfig = serde_json::from_str(&text)
        .map_err(|e| format!("parsing {}: {e}", path.display()))?;
    Ok(normalize_ai_config(cfg))
}

fn write_ai_config_to_disk(cfg: &AiConfig) -> Result<(), String> {
    let path = ai_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))
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

fn read_ai_sessions_from_disk() -> Result<Vec<AiSessionItem>, String> {
    let path = ai_session_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let raw: Vec<AiSessionItem> = serde_json::from_str(&text)
        .map_err(|e| format!("parsing {}: {e}", path.display()))?;
    let mut items: Vec<_> = raw.into_iter().filter_map(normalize_ai_session_item).collect();
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(AI_SESSION_MAX_ITEMS);
    Ok(items)
}

fn write_ai_sessions_to_disk(items: &[AiSessionItem]) -> Result<(), String> {
    let path = ai_session_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("writing {}: {e}", path.display()))
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

    let metadata =
        fs::metadata(&src).map_err(|e| format!("reading {}: {e}", src.display()))?;
    if metadata.len() > BACKGROUND_IMAGE_MAX_BYTES {
        return Err(format!(
            "image is {:.1} MB, above the {} MB limit",
            metadata.len() as f64 / (1024.0 * 1024.0),
            BACKGROUND_IMAGE_MAX_BYTES / (1024 * 1024)
        ));
    }

    let bytes = fs::read(&src).map_err(|e| format!("reading {}: {e}", src.display()))?;

    let dir = background_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    // Drop any previously saved background under a different extension.
    if let Some(existing) = find_background_image()? {
        let _ = fs::remove_file(existing);
    }
    let dest = dir.join(format!("{BACKGROUND_IMAGE_STEM}.{ext}"));
    fs::write(&dest, &bytes).map_err(|e| format!("writing {}: {e}", dest.display()))?;

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

fn prepare_ai_request(messages: Vec<AiChatMessage>) -> Result<(AiConfig, String, Vec<serde_json::Value>), String> {
    let cfg = read_ai_config_from_disk()?;
    if cfg.provider != "openai-compatible" && cfg.provider != "openai" {
        return Err("This preview only supports OpenAI-compatible APIs for now.".into());
    }
    if cfg.base_url.trim().is_empty() {
        return Err("AI Base URL is not configured. Set it in Settings > AI.".into());
    }
    if messages.is_empty() {
        return Err("message is empty".into());
    }

    let api_key = zeroterm_app::keychain::get_ai_api_key(AI_KEYCHAIN_PROFILE)
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
    Ok((cfg, api_key, payload_messages))
}

fn emit_ai_stream(app: &AppHandle, event: AiStreamEvent) {
    let _ = app.emit("ai:stream", event);
}

fn emit_ai_stream_error(app: &AppHandle, request_id: &str, error: String) {
    emit_ai_stream(app, AiStreamEvent {
        request_id: request_id.to_string(),
        delta: String::new(),
        done: true,
        error: Some(error),
    });
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

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    let exists = App::vault_exists(&path);
    let unlocked = state.app.lock().unwrap().is_some();
    Ok(VaultStatus {
        path: path.display().to_string(),
        exists,
        unlocked,
    })
}

#[tauri::command]
pub async fn get_ai_config() -> Result<AiConfig, String> {
    let mut cfg = read_ai_config_from_disk()?;
    cfg.has_api_key = zeroterm_app::keychain::get_ai_api_key(AI_KEYCHAIN_PROFILE)
        .map_err(|e| e.to_string())?
        .is_some();
    Ok(cfg)
}

#[tauri::command]
pub async fn save_ai_config(input: SaveAiConfigInput) -> Result<AiConfig, String> {
    let mut cfg = normalize_ai_config(AiConfig {
        provider: input.provider,
        base_url: input.base_url,
        model: input.model,
        safe_mode: input.safe_mode,
        auto_read: input.auto_read,
        show_commands: input.show_commands,
        has_api_key: false,
    });

    let api_key = input.api_key.trim();
    if !api_key.is_empty() {
        zeroterm_app::keychain::save_ai_api_key(AI_KEYCHAIN_PROFILE, api_key)
            .map_err(|e| e.to_string())?;
        cfg.has_api_key = true;
    } else {
        cfg.has_api_key = zeroterm_app::keychain::get_ai_api_key(AI_KEYCHAIN_PROFILE)
            .map_err(|e| e.to_string())?
            .is_some();
    }

    write_ai_config_to_disk(&cfg)?;
    Ok(cfg)
}

#[tauri::command]
pub async fn list_ai_sessions() -> Result<Vec<AiSessionItem>, String> {
    read_ai_sessions_from_disk()
}

#[tauri::command]
pub async fn save_ai_session(input: SaveAiSessionInput) -> Result<AiSessionItem, String> {
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

    let mut items = read_ai_sessions_from_disk()?;
    items.retain(|existing| existing.id != item.id);
    items.insert(0, item.clone());
    items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    items.truncate(AI_SESSION_MAX_ITEMS);
    write_ai_sessions_to_disk(&items)?;
    Ok(item)
}

#[tauri::command]
pub async fn delete_ai_session(id: String) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let mut items = read_ai_sessions_from_disk()?;
    let before = items.len();
    items.retain(|item| item.id != id);
    if items.len() != before {
        write_ai_sessions_to_disk(&items)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn clear_ai_sessions() -> Result<(), String> {
    write_ai_sessions_to_disk(&[])
}

#[tauri::command]
pub async fn clear_ai_sessions_for_scope(input: ClearAiSessionsForScopeInput) -> Result<(), String> {
    let scope_type = input.scope_type.trim();
    let scope_id = input.scope_id.trim();
    if scope_type.is_empty() || scope_id.is_empty() {
        return Ok(());
    }
    let mut items = read_ai_sessions_from_disk()?;
    let before = items.len();
    items.retain(|item| item.scope_type != scope_type || item.scope_id != scope_id);
    if items.len() != before {
        write_ai_sessions_to_disk(&items)?;
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

    let api_key = if input.api_key.trim().is_empty() {
        zeroterm_app::keychain::get_ai_api_key(AI_KEYCHAIN_PROFILE)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "AI API Key is not configured.".to_string())?
    } else {
        input.api_key.trim().to_string()
    };

    let endpoint = format!("{}/models", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(endpoint)
        .bearer_auth(api_key)
        .send()
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
    Ok(AiModelListResponse { models })
}

#[tauri::command]
pub async fn ai_chat(messages: Vec<AiChatMessage>) -> Result<AiChatResponse, String> {
    let (cfg, api_key, payload_messages) = prepare_ai_request(messages)?;
    let endpoint = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&json!({
            "model": cfg.model,
            "messages": payload_messages,
            "temperature": 0.2,
        }))
        .send()
        .await
        .map_err(|e| format!("AI request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("reading AI response failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("AI request failed ({status}): {body}"));
    }

    let parsed: OpenAiChatResponse = serde_json::from_str(&body)
        .map_err(|e| format!("parsing AI response failed: {e}"))?;
    let content = parsed
        .choices
        .into_iter()
        .find_map(|c| c.message.content)
        .unwrap_or_default()
        .trim()
        .to_string();
    if content.is_empty() {
        return Err("AI response was empty.".into());
    }
    Ok(AiChatResponse { content })
}

#[tauri::command]
pub async fn ai_chat_stream(app: AppHandle, input: AiChatStreamInput) -> Result<(), String> {
    let request_id = input.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err("request id is empty".into());
    }

    let (cfg, api_key, payload_messages) = match prepare_ai_request(input.messages) {
        Ok(v) => v,
        Err(e) => {
            emit_ai_stream_error(&app, &request_id, e.clone());
            return Err(e);
        }
    };
    let endpoint = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let response = match client
        .post(endpoint)
        .bearer_auth(api_key)
        .json(&json!({
            "model": cfg.model,
            "messages": payload_messages,
            "temperature": 0.2,
            "stream": true,
        }))
        .send()
        .await
    {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("AI request failed: {e}");
            emit_ai_stream_error(&app, &request_id, msg.clone());
            return Err(msg);
        }
    };

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let msg = format!("AI request failed ({status}): {body}");
        emit_ai_stream_error(&app, &request_id, msg.clone());
        return Err(msg);
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    while let Some(item) = stream.next().await {
        let bytes = match item {
            Ok(v) => v,
            Err(e) => {
                let msg = format!("AI stream failed: {e}");
                emit_ai_stream_error(&app, &request_id, msg.clone());
                return Err(msg);
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        for frame in parse_sse_frames(&mut buffer) {
            for line in frame.lines() {
                let line = line.trim();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" {
                    emit_ai_stream(&app, AiStreamEvent {
                        request_id: request_id.clone(),
                        delta: String::new(),
                        done: true,
                        error: None,
                    });
                    return Ok(());
                }
                let parsed: OpenAiStreamChunk = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                for choice in parsed.choices {
                    if let Some(delta) = choice.delta.content {
                        if !delta.is_empty() {
                            emit_ai_stream(&app, AiStreamEvent {
                                request_id: request_id.clone(),
                                delta,
                                done: false,
                                error: None,
                            });
                        }
                    }
                }
            }
        }
    }
    emit_ai_stream(&app, AiStreamEvent {
        request_id,
        delta: String::new(),
        done: true,
        error: None,
    });
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
    *state.app.lock().unwrap() = Some(app.clone());
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
    *state.app.lock().unwrap() = Some(Arc::new(app));
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
    *state.app.lock().unwrap() = None;
    // Locking the vault drops every cached sync engine too — they hold
    // the unwrapped sync root key in memory and shouldn't outlive the
    // master key.
    state.sync.forget_all().await;
    Ok(())
}

#[tauri::command]
pub async fn clear_vault_data(state: State<'_, AppState>) -> Result<(), String> {
    {
        let app_lock = state.app.lock().unwrap();
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.clear_vault_data().map_err(|e| e.to_string())?;
    }
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
            *state.app.lock().unwrap() = Some(app.clone());
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
        .download_and_install(
            |_, _| {},
            || {},
        )
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
    let app_lock = state.app.lock().unwrap();
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
pub async fn host_sync_diagnostics(state: State<'_, AppState>) -> Result<HostSyncDiagnostics, String> {
    let app_lock = state.app.lock().unwrap();
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
        SyncBackend::Sftp { host_ref, remote_dir } => {
            io.backend = "sftp".into();
            io.host_ref = Some(host_ref);
            io.remote_dir = Some(remote_dir);
        }
        SyncBackend::WebDav { url, root_path, username } => {
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
                endpoint: input
                    .endpoint
                    .clone()
                    .filter(|s| !s.trim().is_empty()),
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
    let app_lock = state.app.lock().unwrap();
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
    let app_lock = state.app.lock().unwrap();
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
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let p = profile_from_input(id.clone(), input)?;
    app.update_sync_profile(&p).map_err(|e| e.to_string())?;
    persist_sync_profile_credential(&id, &credential);
    Ok(())
}

#[tauri::command]
pub async fn delete_sync_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    {
        let app_lock = state.app.lock().unwrap();
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
    let ids = {
        let app_lock = state.app.lock().unwrap();
        let app = app_lock.as_ref().ok_or("vault is locked")?;
        app.list_sync_profile_ids_raw().map_err(|e| e.to_string())?
    };

    let mut deleted_count = 0usize;
    for id in &ids {
        {
            let app_lock = state.app.lock().unwrap();
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
    Ok(DeleteAllSyncProfilesResult { deleted_count })
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
        let app_lock = state.app.lock().unwrap();
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
        let guard = state.app.lock().unwrap();
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
pub async fn sync_list_conflicts(
    state: State<'_, AppState>,
    _profile_id: String,
) -> Result<Vec<zeroterm_app::ConflictView>, String> {
    let app = {
        let guard = state.app.lock().unwrap();
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
        let guard = state.app.lock().unwrap();
        guard.as_ref().ok_or("vault is locked")?.clone()
    };
    let r = match resolution {
        SyncResolutionInput::KeepLocal => zeroterm_app::ConflictResolution::KeepLocal,
        SyncResolutionInput::KeepRemote => zeroterm_app::ConflictResolution::KeepRemote,
    };
    app.resolve_conflict(&conflict_id, r).map_err(|e| e.to_string())
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
    let guard = state.app.lock().unwrap();
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
    #[serde(default)]
    pub forwards: Vec<ForwardSpecIO>,
    #[serde(default, alias = "proxy_jump")]
    pub proxy_jump_host_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostAuthInput {
    Password { value: String },
    PrivateKey {
        key_pem: String,
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
                    key_pem,
                    passphrase,
                },
                HostAuthInput::Agent => zeroterm_app::HostAuth::Agent,
            },
            os_type: self.os_type.and_then(|v| normalize_os_type(&v)),
            forwards: self.forwards.into_iter().map(|f| f.into_app()).collect(),
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
    /// Only populated for `password` auth — keys never leave the vault
    /// over IPC for editing (you can replace the key but not view it).
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
    /// Structured forwards for the editor.
    pub forwards: Vec<ForwardSpecIO>,
    pub proxy_jump_host_id: Option<String>,
    pub group_id: Option<String>,
}

#[tauri::command]
pub async fn save_host(
    state: State<'_, AppState>,
    input: HostInput,
) -> Result<String, String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    let h = input.into_app_host(String::new());
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
    app.update_host(&new_host).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
    Ok(())
}

#[tauri::command]
pub async fn delete_host(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (app, manager) = clone_app_and_sync(&state)?;
    app.delete_host(&id).map_err(|e| e.to_string())?;
    manager.schedule_debounced_sync_for_all(app);
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
    let app_lock = state.app.lock().unwrap();
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
    let app_lock = state.app.lock().unwrap();
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

/// Read a local text file (key material picked by the host editor).
/// We don't whitelist arbitrary FS access via the `tauri-plugin-fs`
/// permission machinery; this command takes a single path the user
/// just selected via the dialog plugin and reads it as UTF-8.
#[tauri::command]
pub async fn read_local_text_file(path: String) -> Result<String, String> {
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
    if bytes.contains(&0) {
        return Err(format!("`{path}` looks like binary data (contains NUL bytes)"));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| format!("`{path}` is not valid UTF-8 text"))?;

    Ok(RemoteTextFileDto {
        path,
        size: metadata.len(),
        content,
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
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let h = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;

    let (auth_type, password, key_passphrase) = match &h.auth {
        zeroterm_app::HostAuth::Password { value } => ("password", Some(value.clone()), None),
        zeroterm_app::HostAuth::PrivateKey { passphrase, .. } => {
            ("key", None, passphrase.clone())
        }
        zeroterm_app::HostAuth::Agent => ("agent", None, None),
    };

    Ok(HostFull {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        auth_type,
        os_type: h.os_type,
        password,
        key_passphrase,
        forwards: h.forwards.iter().map(ForwardSpecIO::from_app).collect(),
        proxy_jump_host_id: h.proxy_jump_host_id,
        group_id: h.group_id,
    })
}

// --------------------------------------------------------------------------
// session lifecycle
// --------------------------------------------------------------------------

/// Resolve a host id from the (unlocked) vault into the data we need to
/// drive a connection: the canonical host record, its `ConnectConfig`,
/// and (if the host has a saved ProxyJump) the jump host's
/// `ConnectConfig` too.
fn build_connect_chain_for_host(
    state: &AppState,
    app_handle: &AppHandle,
    host_id: &str,
) -> Result<
    (
        zeroterm_app::Host,
        zeroterm_ssh::ConnectConfig,
        Option<zeroterm_ssh::ConnectConfig>,
    ),
    String,
> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let host = app
        .find_host_by_id(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| "could not locate $HOME for known_hosts".to_string())?;
    let prompt = Arc::new(TauriHostKeyPrompt {
        app_handle: app_handle.clone(),
    });
    let policy = HostKeyPolicy::Interactive {
        store: known_hosts.clone(),
        prompt: prompt.clone(),
    };

    let cfg = app.connect_config(&host, policy, Some(Duration::from_secs(15)));

    let jump_cfg = if let Some(jump_id) = host.proxy_jump_host_id.as_deref() {
        let jump_host = app
            .find_host_by_id(jump_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("ProxyJump host id '{jump_id}' not found in vault"))?;
        let jump_policy = HostKeyPolicy::Interactive {
            store: known_hosts,
            prompt,
        };
        Some(app.connect_config(&jump_host, jump_policy, Some(Duration::from_secs(15))))
    } else {
        None
    };

    Ok((host, cfg, jump_cfg))
}

fn build_connect_chain_for_host_strict(
    state: &AppState,
    host_id: &str,
) -> Result<
    (
        zeroterm_app::Host,
        zeroterm_ssh::ConnectConfig,
        Option<zeroterm_ssh::ConnectConfig>,
    ),
    String,
> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let host = app
        .find_host_by_id(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| "could not locate $HOME for known_hosts".to_string())?;

    let cfg = app.connect_config(
        &host,
        HostKeyPolicy::Strict(known_hosts.clone()),
        Some(Duration::from_secs(15)),
    );

    let jump_cfg = if let Some(jump_id) = host.proxy_jump_host_id.as_deref() {
        let jump_host = app
            .find_host_by_id(jump_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("ProxyJump host id '{jump_id}' not found in vault"))?;
        Some(app.connect_config(
            &jump_host,
            HostKeyPolicy::Strict(known_hosts),
            Some(Duration::from_secs(15)),
        ))
    } else {
        None
    };

    Ok((host, cfg, jump_cfg))
}

#[allow(dead_code)]
fn parse_os_release_value(raw: &str) -> &str {
    let v = raw.trim();
    if v.len() >= 2 {
        if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
            return &v[1..v.len() - 1];
        }
    }
    v
}

#[allow(dead_code)]
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

#[allow(dead_code)]
async fn detect_remote_os_type(session: &mut Session) -> Option<String> {
    let sftp = session.sftp().await.ok()?;

    for path in ["/etc/os-release", "/usr/lib/os-release"] {
        if let Ok(bytes) = sftp.download_to_vec(path).await {
            if let Ok(text) = String::from_utf8(bytes) {
                if let Some(os) = detect_os_type_from_os_release(&text) {
                    return Some(os);
                }
            }
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

#[allow(dead_code)]
fn persist_host_os_type(state: &AppState, host_id: &str, os_type: &str) -> Result<(), String> {
    let app_lock = state.app.lock().unwrap();
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

async fn detect_and_persist_host_os_type(app_handle: AppHandle, host_id: String) {
    let (host, cfg, jump_cfg) = {
        let state = app_handle.state::<AppState>();
        match build_connect_chain_for_host_strict(&state, &host_id) {
            Ok(v) => v,
            Err(e) => {
                debug!(host_id = %host_id, error = %e, "skip os detect: build chain failed");
                return;
            }
        }
    };

    let (jump_session, mut session) = match jump_cfg {
        Some(jcfg) => match Session::connect(jcfg).await {
            Ok(j) => match Session::connect_via(cfg, &j).await {
                Ok(s) => (Some(j), s),
                Err(e) => {
                    debug!(host_id = %host_id, error = %e, "skip os detect: connect via jump failed");
                    return;
                }
            },
            Err(e) => {
                debug!(host_id = %host_id, error = %e, "skip os detect: jump connect failed");
                return;
            }
        },
        None => match Session::connect(cfg).await {
            Ok(s) => (None, s),
            Err(e) => {
                debug!(host_id = %host_id, error = %e, "skip os detect: direct connect failed");
                return;
            }
        },
    };

    let detected = detect_remote_os_type(&mut session).await;
    drop(session);
    drop(jump_session);

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

    let _ = app_handle.emit(
        "host:os_type_updated",
        HostOsTypeUpdatedEvent {
            host_id,
            os_type,
        },
    );
    info!(host = %host.name, "detected and persisted host os type");
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

    let jump_summary = jump_cfg.as_ref().map(|j| format!("{}@{}:{}", j.username, j.host, j.port));

    info!(host = %host.host, port = host.port, jump = ?jump_summary, "connecting");

    // ProxyJump first if configured.
    let (jump_session, mut session) = match jump_cfg {
        Some(jcfg) => {
            let j = Session::connect(jcfg).await.map_err(|e| e.to_string())?;
            let t = Session::connect_via(cfg, &j).await.map_err(|e| e.to_string())?;
            (Some(j), t)
        }
        None => {
            let s = Session::connect(cfg).await.map_err(|e| e.to_string())?;
            (None, s)
        }
    };

    // NOTE: compatibility-first path.
    // Some embedded SSH servers (notably on OpenWRT variants) behave
    // poorly when extra channels (SFTP probe) are opened immediately after
    // auth but before interactive shell startup. We skip eager OS probing
    // here to keep shell startup reliable.

    // Saved forwards.
    let mut forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();
    let mut forward_summaries: Vec<String> = Vec::new();
    for spec in &host.forwards {
        let enabled = match spec {
            zeroterm_app::ForwardSpec::Local { enabled, .. } => *enabled,
            zeroterm_app::ForwardSpec::Dynamic { enabled, .. } => *enabled,
        };
        if !enabled {
            continue;
        }
        let summary = spec.summary();
        let h = match spec {
            zeroterm_app::ForwardSpec::Local {
                enabled: _,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_ssh::forward_local(
                &session,
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
            } => zeroterm_ssh::forward_dynamic(&session, bind_addr, *bind_port)
                .await
                .map_err(|e| format!("forward `{summary}`: {e}"))?,
        };
        info!(local = %h.local_addr(), spec = %summary, "saved forward up");
        forwards.push(h);
        forward_summaries.push(summary);
    }

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

    state.sessions.lock().unwrap().insert(
        session_id,
        SessionHandle {
            control_tx,
            forward_summaries,
            jump_summary,
        },
    );

    info!(session_id, "session ready");

    // Best-effort background OS detection and persistence so host badges
    // can update without requiring app restart.
    let os_detect_handle = app_handle.clone();
    let os_detect_host_id = host_id.clone();
    tokio::spawn(async move {
        detect_and_persist_host_os_type(os_detect_handle, os_detect_host_id).await;
    });

    Ok(session_id)
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
    Password { value: String },
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

    state.sessions.lock().unwrap().insert(
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


#[tauri::command]
pub async fn create_local_terminal_session(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    cols: Option<u16>,
    rows: Option<u16>,
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

    #[cfg(target_os = "windows")]
    let cmd = CommandBuilder::new("cmd.exe");
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        CommandBuilder::new(shell)
    };
    #[cfg(not(target_os = "windows"))]
    cmd.arg("-l");

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
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = app_for_read.emit(
                        "session:data",
                        crate::session::DataEvent {
                            session_id,
                            data: buf[..n].to_vec(),
                        },
                    );
                }
                Err(_) => break,
            }
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
            ClosedEvent { session_id, exit_code: None, message: None },
        );
    });

    state.local_sessions.lock().unwrap().insert(
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
        let locals = state.local_sessions.lock().unwrap();
        locals.get(&session_id).map(|h| h.writer_tx.clone())
    };
    if let Some(tx) = local_tx {
        tx.send(data)
            .await
            .map_err(|_| "local session task closed".to_string())?;
        return Ok(());
    }

    let tx = {
        let sessions = state.sessions.lock().unwrap();
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

#[tauri::command]
pub async fn resize_session(
    state: State<'_, AppState>,
    session_id: u64,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let local_tx = {
        let locals = state.local_sessions.lock().unwrap();
        locals.get(&session_id).map(|h| h.resize_tx.clone())
    };
    if let Some(tx) = local_tx {
        let _ = tx.send((cols, rows)).await;
        return Ok(());
    }

    let tx = {
        let sessions = state.sessions.lock().unwrap();
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
        let mut locals = state.local_sessions.lock().unwrap();
        locals.remove(&session_id).map(|h| h.shutdown_tx)
    };
    if let Some(tx) = local_tx_opt {
        let _ = tx.send(()).await;
        debug!(session_id, "local disconnect requested");
        return Ok(());
    }

    let tx_opt = {
        let sessions = state.sessions.lock().unwrap();
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
    let sessions = state.sessions.lock().unwrap();
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
    let tx = {
        state
            .pending_host_key
            .lock()
            .unwrap()
            .remove(&request_id)
    };
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
}

fn kind_str(k: FileKind) -> &'static str {
    match k {
        FileKind::File => "file",
        FileKind::Dir => "dir",
        FileKind::Symlink => "symlink",
        FileKind::Other => "other",
    }
}

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
        let meta = fs::symlink_metadata(&full)
            .map_err(|e| format!("symlink_metadata {}: {e}", full.display()))?;
        let ft = meta.file_type();
        let kind = local_kind_str(&ft);
        let size = if ft.is_file() { meta.len() } else { 0 };
        out.push(DirEntryDto { name, kind, size });
    }

    out.sort_by(|a, b| {
        let order = |k: &str| if k == "dir" { 0 } else { 1 };
        order(a.kind).cmp(&order(b.kind)).then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    fs::create_dir(&path).map_err(|e| format!("mkdir {}: {e}", path))
}

#[tauri::command]
pub async fn local_remove(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("remove file {}: {e}", path))
}

#[tauri::command]
pub async fn local_remove_dir(path: String) -> Result<(), String> {
    fs::remove_dir_all(&path).map_err(|e| format!("remove dir {}: {e}", path))
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| format!("rename {} -> {}: {e}", from, to))
}

#[tauri::command]
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

#[tauri::command]
pub async fn open_with_app(file_path: String, app_path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg(&app_path)
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
            .arg(&file_path)
            .spawn()
            .map_err(|e| format!("launch {} {}: {e}", app_path, file_path))?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyNodeKind {
    File,
    Dir,
}

fn remote_join_path(base: &str, leaf: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{leaf}")
    } else {
        format!("{base}/{leaf}")
    }
}

fn normalize_remote_path(path: &str) -> String {
    let raw = path.trim();
    if raw.is_empty() || raw == "/" {
        return "/".to_string();
    }
    let mut out = String::from("/");
    let mut first = true;
    for seg in raw.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if !first {
            out.push('/');
        }
        first = false;
        out.push_str(seg);
    }
    if out.is_empty() { "/".to_string() } else { out }
}

fn is_remote_path_within(path: &str, parent: &str) -> bool {
    let n_path = normalize_remote_path(path);
    let n_parent = normalize_remote_path(parent);
    if n_parent == "/" {
        return n_path != "/";
    }
    n_path == n_parent || n_path.starts_with(&(n_parent.clone() + "/"))
}

fn detect_local_kind(path: &Path) -> Result<CopyNodeKind, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("symlink_metadata {}: {e}", path.display()))?;
    let ft = meta.file_type();
    if ft.is_file() {
        Ok(CopyNodeKind::File)
    } else if ft.is_dir() {
        Ok(CopyNodeKind::Dir)
    } else if ft.is_symlink() {
        Err(format!(
            "symlink is not supported for copy yet: {}",
            path.display()
        ))
    } else {
        Err(format!("unsupported file type: {}", path.display()))
    }
}

fn detect_remote_kind(path: &str, kind: FileKind) -> Result<CopyNodeKind, String> {
    match kind {
        FileKind::File => Ok(CopyNodeKind::File),
        FileKind::Dir => Ok(CopyNodeKind::Dir),
        FileKind::Symlink => Err(format!("symlink is not supported for copy yet: {path}")),
        FileKind::Other => Err(format!("unsupported file type: {path}")),
    }
}

fn copy_local_tree_to_local(
    source: &Path,
    target: &Path,
    root_kind: CopyNodeKind,
    overwrite: bool,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            if target.exists() && !overwrite {
                return Err(format!("destination already exists: {}", target.display()));
            }
            fs::copy(source, target).map_err(|e| {
                format!("copy file {} -> {}: {e}", source.display(), target.display())
            })?;
            Ok(())
        }
        CopyNodeKind::Dir => {
            if !target.exists() {
                fs::create_dir_all(target)
                    .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            }

            let mut stack: Vec<(PathBuf, PathBuf)> = vec![(source.to_path_buf(), target.to_path_buf())];
            while let Some((src_dir, dst_dir)) = stack.pop() {
                let rd = fs::read_dir(&src_dir)
                    .map_err(|e| format!("read_dir {}: {e}", src_dir.display()))?;
                for item in rd {
                    let entry = item
                        .map_err(|e| format!("read_dir entry {}: {e}", src_dir.display()))?;
                    let name = entry.file_name();
                    let child_src = entry.path();
                    let child_dst = dst_dir.join(&name);
                    let kind = detect_local_kind(&child_src)?;
                    match kind {
                        CopyNodeKind::File => {
                            if child_dst.exists() && !overwrite {
                                return Err(format!("destination already exists: {}", child_dst.display()));
                            }
                            fs::copy(&child_src, &child_dst).map_err(|e| {
                                format!(
                                    "copy file {} -> {}: {e}",
                                    child_src.display(),
                                    child_dst.display()
                                )
                            })?;
                        }
                        CopyNodeKind::Dir => {
                            if !child_dst.exists() {
                                fs::create_dir_all(&child_dst)
                                    .map_err(|e| format!("mkdir {}: {e}", child_dst.display()))?;
                            }
                            stack.push((child_src, child_dst));
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

async fn copy_local_tree_to_remote(
    source: &Path,
    target_sftp: &zeroterm_ssh::Sftp,
    target: &str,
    root_kind: CopyNodeKind,
    overwrite: bool,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            if target_sftp.stat(target).await.is_ok() && !overwrite {
                return Err(format!("destination already exists: {target}"));
            }
            let data = tokio::fs::read(source)
                .await
                .map_err(|e| format!("reading {}: {e}", source.display()))?;
            target_sftp
                .upload_from_slice(target, &data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        CopyNodeKind::Dir => {
            if target_sftp.create_dir(target).await.is_err() {
                target_sftp.stat(target).await.map_err(|e| e.to_string())?;
            }

            let mut stack: Vec<(PathBuf, String)> = vec![(source.to_path_buf(), target.to_string())];
            while let Some((src_dir, dst_dir)) = stack.pop() {
                let rd = fs::read_dir(&src_dir)
                    .map_err(|e| format!("read_dir {}: {e}", src_dir.display()))?;
                for item in rd {
                    let entry = item
                        .map_err(|e| format!("read_dir entry {}: {e}", src_dir.display()))?;
                    let name = entry.file_name().to_string_lossy().to_string();
                    let child_src = entry.path();
                    let child_dst = remote_join_path(&dst_dir, &name);
                    let kind = detect_local_kind(&child_src)?;
                    match kind {
                        CopyNodeKind::File => {
                            if target_sftp.stat(&child_dst).await.is_ok() && !overwrite {
                                return Err(format!("destination already exists: {child_dst}"));
                            }
                            let data = tokio::fs::read(&child_src).await.map_err(|e| {
                                format!("reading {}: {e}", child_src.display())
                            })?;
                            target_sftp
                                .upload_from_slice(&child_dst, &data)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                        CopyNodeKind::Dir => {
                            if target_sftp.create_dir(&child_dst).await.is_err() {
                                target_sftp.stat(&child_dst).await.map_err(|e| e.to_string())?;
                            }
                            stack.push((child_src, child_dst));
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

async fn copy_remote_tree_to_local(
    source_sftp: &zeroterm_ssh::Sftp,
    source: &str,
    target: &Path,
    root_kind: CopyNodeKind,
    overwrite: bool,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            if target.exists() && !overwrite {
                return Err(format!("destination already exists: {}", target.display()));
            }
            let bytes = source_sftp
                .download_to_vec(source)
                .await
                .map_err(|e| e.to_string())?;
            tokio::fs::write(target, &bytes)
                .await
                .map_err(|e| format!("writing {}: {e}", target.display()))?;
            Ok(())
        }
        CopyNodeKind::Dir => {
            if tokio::fs::metadata(target).await.is_err() {
                tokio::fs::create_dir_all(target)
                    .await
                    .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            }
            let mut stack: Vec<(String, PathBuf)> =
                vec![(source.to_string(), target.to_path_buf())];
            while let Some((src_dir, dst_dir)) = stack.pop() {
                let entries = source_sftp
                    .list(&src_dir)
                    .await
                    .map_err(|e| e.to_string())?;
                for entry in entries {
                    if entry.name == "." || entry.name == ".." {
                        continue;
                    }
                    let child_src = remote_join_path(&src_dir, &entry.name);
                    let child_dst = dst_dir.join(&entry.name);
                    let kind = detect_remote_kind(&child_src, entry.kind)?;
                    match kind {
                        CopyNodeKind::File => {
                            if child_dst.exists() && !overwrite {
                                return Err(format!("destination already exists: {}", child_dst.display()));
                            }
                            let bytes = source_sftp
                                .download_to_vec(&child_src)
                                .await
                                .map_err(|e| e.to_string())?;
                            tokio::fs::write(&child_dst, &bytes)
                                .await
                                .map_err(|e| format!("writing {}: {e}", child_dst.display()))?;
                        }
                        CopyNodeKind::Dir => {
                            if tokio::fs::metadata(&child_dst).await.is_err() {
                                tokio::fs::create_dir_all(&child_dst)
                                    .await
                                    .map_err(|e| format!("mkdir {}: {e}", child_dst.display()))?;
                            }
                            stack.push((child_src, child_dst));
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

async fn copy_remote_tree_to_remote(
    source_sftp: &zeroterm_ssh::Sftp,
    source: &str,
    target_sftp: &zeroterm_ssh::Sftp,
    target: &str,
    root_kind: CopyNodeKind,
    overwrite: bool,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            if target_sftp.stat(target).await.is_ok() && !overwrite {
                return Err(format!("destination already exists: {target}"));
            }
            let data = source_sftp
                .download_to_vec(source)
                .await
                .map_err(|e| e.to_string())?;
            target_sftp
                .upload_from_slice(target, &data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        CopyNodeKind::Dir => {
            if target_sftp.create_dir(target).await.is_err() {
                target_sftp.stat(target).await.map_err(|e| e.to_string())?;
            }
            let mut stack: Vec<(String, String)> = vec![(source.to_string(), target.to_string())];
            while let Some((src_dir, dst_dir)) = stack.pop() {
                let entries = source_sftp
                    .list(&src_dir)
                    .await
                    .map_err(|e| e.to_string())?;
                for entry in entries {
                    if entry.name == "." || entry.name == ".." {
                        continue;
                    }
                    let child_src = remote_join_path(&src_dir, &entry.name);
                    let child_dst = remote_join_path(&dst_dir, &entry.name);
                    let kind = detect_remote_kind(&child_src, entry.kind)?;
                    match kind {
                        CopyNodeKind::File => {
                            if target_sftp.stat(&child_dst).await.is_ok() && !overwrite {
                                return Err(format!("destination already exists: {child_dst}"));
                            }
                            let data = source_sftp
                                .download_to_vec(&child_src)
                                .await
                                .map_err(|e| e.to_string())?;
                            target_sftp
                                .upload_from_slice(&child_dst, &data)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                        CopyNodeKind::Dir => {
                            if target_sftp.create_dir(&child_dst).await.is_err() {
                                target_sftp.stat(&child_dst).await.map_err(|e| e.to_string())?;
                            }
                            stack.push((child_src, child_dst));
                        }
                    }
                }
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub async fn sftp_copy_entry_between_panes(
    state: State<'_, AppState>,
    source_sftp_id: Option<u64>,
    source_path: String,
    destination_sftp_id: Option<u64>,
    destination_dir: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let overwrite = overwrite.unwrap_or(false);
    let source_name = Path::new(&source_path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("invalid source path: {source_path}"))?
        .to_string();

    if source_name == "." || source_name == ".." {
        return Err("cannot copy pseudo entry".to_string());
    }

    match (source_sftp_id, destination_sftp_id) {
        (None, None) => {
            let src = PathBuf::from(&source_path);
            let dst_dir = PathBuf::from(&destination_dir);
            let dst = dst_dir.join(&source_name);

            let root_kind = detect_local_kind(&src)?;
            if root_kind == CopyNodeKind::Dir && dst.starts_with(&src) {
                return Err("cannot copy a directory into itself".to_string());
            }
            copy_local_tree_to_local(&src, &dst, root_kind, overwrite)
        }
        (None, Some(dst_id)) => {
            let src = PathBuf::from(&source_path);
            let dst_sftp = lookup_sftp(&state, dst_id)?;
            let dst = remote_join_path(&destination_dir, &source_name);
            let root_kind = detect_local_kind(&src)?;
            copy_local_tree_to_remote(&src, &dst_sftp, &dst, root_kind, overwrite).await
        }
        (Some(src_id), None) => {
            let src_sftp = lookup_sftp(&state, src_id)?;
            let dst_dir = PathBuf::from(&destination_dir);
            let dst = dst_dir.join(&source_name);
            let meta = src_sftp
                .stat(&source_path)
                .await
                .map_err(|e| e.to_string())?;
            let root_kind = detect_remote_kind(&source_path, meta.kind)?;
            copy_remote_tree_to_local(&src_sftp, &source_path, &dst, root_kind, overwrite).await
        }
        (Some(src_id), Some(dst_id)) => {
            let src_sftp = lookup_sftp(&state, src_id)?;
            let dst_sftp = lookup_sftp(&state, dst_id)?;
            let dst = remote_join_path(&destination_dir, &source_name);

            let meta = src_sftp
                .stat(&source_path)
                .await
                .map_err(|e| e.to_string())?;
            let root_kind = detect_remote_kind(&source_path, meta.kind)?;

            if root_kind == CopyNodeKind::Dir && src_id == dst_id && is_remote_path_within(&dst, &source_path) {
                return Err("cannot copy a directory into itself".to_string());
            }
            copy_remote_tree_to_remote(&src_sftp, &source_path, &dst_sftp, &dst, root_kind, overwrite).await
        }
    }
}

const DEFAULT_TEXT_EDIT_MAX_BYTES: u64 = 5 * 1024 * 1024;
const HARD_TEXT_EDIT_MAX_BYTES: u64 = 8 * 1024 * 1024;

fn normalize_text_edit_limit(max_bytes: Option<u64>) -> u64 {
    let requested = max_bytes.unwrap_or(DEFAULT_TEXT_EDIT_MAX_BYTES);
    requested.clamp(1, HARD_TEXT_EDIT_MAX_BYTES)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTextFileDto {
    pub path: String,
    pub size: u64,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDirHelperStatusDto {
    pub configured: bool,
    pub marker_path: String,
}

const SFTP_FOLLOW_MARKER: &str = ".zeroterm_sftp_follow";
const SFTP_FOLLOW_CWD_FILE: &str = ".zeroterm_sftp_follow_cwd";
const SFTP_FOLLOW_BLOCK_BEGIN: &str = "# >>> zeroterm sftp follow >>>";
const SFTP_FOLLOW_BLOCK_END: &str = "# <<< zeroterm sftp follow <<<";

fn build_follow_block() -> String {
    format!(
        "{begin}\nexport ZEROTERM_SFTP_CWD_FILE=\"$HOME/{cwd}\"\nzeroterm_sftp_follow_pwd() {{ printf '%s\\n' \"$PWD\" > \"$ZEROTERM_SFTP_CWD_FILE\" 2>/dev/null || true; }}\ncase \":$PROMPT_COMMAND:\" in *:zeroterm_sftp_follow_pwd:*) ;; *) PROMPT_COMMAND=\"zeroterm_sftp_follow_pwd${{PROMPT_COMMAND:+;$PROMPT_COMMAND}}\" ;; esac\nzeroterm_sftp_follow_pwd\n{end}\n",
        begin = SFTP_FOLLOW_BLOCK_BEGIN,
        cwd = SFTP_FOLLOW_CWD_FILE,
        end = SFTP_FOLLOW_BLOCK_END
    )
}

fn merge_follow_block(existing: String) -> String {
    if existing.contains(SFTP_FOLLOW_BLOCK_BEGIN) {
        return existing;
    }
    let mut out = existing;
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&build_follow_block());
    out
}

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: String,
) -> Result<u64, String> {
    let (host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;

    info!(host = %host.host, port = host.port, "opening sftp");
    let (jump_session, mut session) = match jump_cfg {
        Some(jcfg) => {
            let j = Session::connect(jcfg).await.map_err(|e| e.to_string())?;
            let t = Session::connect_via(cfg, &j).await.map_err(|e| e.to_string())?;
            (Some(j), t)
        }
        None => {
            let s = Session::connect(cfg).await.map_err(|e| e.to_string())?;
            (None, s)
        }
    };
    let sftp = session.sftp().await.map_err(|e| e.to_string())?;

    let sftp_id = state.next_sftp_id.fetch_add(1, Ordering::SeqCst);
    state.sftp_handles.lock().unwrap().insert(
        sftp_id,
        SftpHandle {
            _session: session,
            _jump_session: jump_session,
            sftp: Arc::new(sftp),
        },
    );

    info!(sftp_id, "sftp ready");
    Ok(sftp_id)
}

#[tauri::command]
pub async fn sftp_detect_dir_helper(
    state: State<'_, AppState>,
    sftp_id: u64,
) -> Result<SftpDirHelperStatusDto, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let marker = SFTP_FOLLOW_MARKER.to_string();
    let configured = sftp.stat(&marker).await.is_ok();
    Ok(SftpDirHelperStatusDto {
        configured,
        marker_path: marker,
    })
}

#[tauri::command]
pub async fn sftp_install_dir_helper(
    state: State<'_, AppState>,
    sftp_id: u64,
) -> Result<SftpDirHelperStatusDto, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let marker = SFTP_FOLLOW_MARKER.to_string();
    let marker_content = b"# ZeroTerm SFTP directory follow marker\n# Created by ZeroTerm on first-run setup\n";
    sftp.upload_from_slice(&marker, marker_content)
        .await
        .map_err(|e| e.to_string())?;

    sftp
        .upload_from_slice(SFTP_FOLLOW_CWD_FILE, b"/\n")
        .await
        .map_err(|e| e.to_string())?;

    for rc in [".bashrc", ".zshrc"] {
        let next = match sftp.download_to_vec(rc).await {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).to_string();
                merge_follow_block(text)
            }
            Err(_) => build_follow_block(),
        };
        sftp.upload_from_slice(rc, next.as_bytes())
            .await
            .map_err(|e| format!("updating {rc}: {e}"))?;
    }

    Ok(SftpDirHelperStatusDto {
        configured: true,
        marker_path: marker,
    })
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, sftp_id: u64) -> Result<(), String> {
    let removed = state.sftp_handles.lock().unwrap().remove(&sftp_id);
    if let Some(handle) = removed {
        // Drop the session gracefully — we can't `disconnect().await`
        // because we'd need owned access; the Drop impl on Session sends
        // the appropriate close message anyway. Move into a task to make
        // the asymmetry explicit.
        drop(handle);
    }
    Ok(())
}

fn lookup_sftp(state: &AppState, sftp_id: u64) -> Result<Arc<zeroterm_ssh::Sftp>, String> {
    state
        .sftp_handles
        .lock()
        .unwrap()
        .get(&sftp_id)
        .map(|h| h.sftp.clone())
        .ok_or_else(|| format!("no sftp handle with id {sftp_id}"))
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<Vec<DirEntryDto>, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let mut entries = sftp.list(&path).await.map_err(|e| e.to_string())?;
    entries.sort_by(|a, b| {
        // Directories first, then files, then by name.
        let kind_order = |k: FileKind| match k {
            FileKind::Dir => 0,
            _ => 1,
        };
        kind_order(a.kind)
            .cmp(&kind_order(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries
        .into_iter()
        .map(|e| DirEntryDto {
            name: e.name,
            kind: kind_str(e.kind),
            size: e.size,
        })
        .collect())
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    remote: String,
    local: String,
) -> Result<u64, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let (transfer_id, cancel) = register_transfer(&state);

    let mut file = tokio::fs::File::create(&local)
        .await
        .map_err(|e| format!("opening {local}: {e}"))?;

    let result = run_with_progress(
        &app_handle,
        transfer_id,
        "download",
        remote.clone(),
        local.clone(),
        move |progress_cb| async move {
            sftp.download_to_writer(
                &remote,
                &mut file,
                zeroterm_ssh::DEFAULT_CHUNK,
                cancel,
                progress_cb,
            )
            .await
        },
    )
    .await;

    forget_transfer(&state, transfer_id);
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    local: String,
    remote: String,
) -> Result<u64, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let (transfer_id, cancel) = register_transfer(&state);

    let metadata = std::fs::metadata(&local).map_err(|e| format!("stating {local}: {e}"))?;
    let size_hint = Some(metadata.len());

    let mut file = tokio::fs::File::open(&local)
        .await
        .map_err(|e| format!("reading {local}: {e}"))?;

    let result = run_with_progress(
        &app_handle,
        transfer_id,
        "upload",
        local.clone(),
        remote.clone(),
        move |progress_cb| async move {
            sftp.upload_from_reader(
                &remote,
                &mut file,
                zeroterm_ssh::DEFAULT_CHUNK,
                size_hint,
                cancel,
                progress_cb,
            )
            .await
        },
    )
    .await;

    forget_transfer(&state, transfer_id);
    result.map_err(|e| e.to_string())
}

/// Upload a file payload already loaded in the frontend (e.g. drag-drop).
/// Suitable for small/medium files where an extra in-memory copy is fine.
#[tauri::command]
pub async fn sftp_upload_bytes(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    remote: String,
    data: Vec<u8>,
    source_label: Option<String>,
) -> Result<u64, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let (transfer_id, cancel) = register_transfer(&state);

    let size_hint = Some(data.len() as u64);
    let source = source_label.unwrap_or_else(|| format!("dragged-bytes({})", data.len()));
    let mut cursor = std::io::Cursor::new(data);

    let result = run_with_progress(
        &app_handle,
        transfer_id,
        "upload",
        source,
        remote.clone(),
        move |progress_cb| async move {
            sftp.upload_from_reader(
                &remote,
                &mut cursor,
                zeroterm_ssh::DEFAULT_CHUNK,
                size_hint,
                cancel,
                progress_cb,
            )
            .await
        },
    )
    .await;

    forget_transfer(&state, transfer_id);
    result.map_err(|e| e.to_string())
}

/// Download a UTF-8 text file for inline editing.
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    max_bytes: Option<u64>,
) -> Result<RemoteTextFileDto, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let max_len = normalize_text_edit_limit(max_bytes);
    let metadata = sftp.stat(&path).await.map_err(|e| e.to_string())?;

    if metadata.kind != FileKind::File {
        return Err(format!("`{path}` is not a regular file"));
    }
    if metadata.size > max_len {
        return Err(format!(
            "`{path}` is {} bytes, above editor limit {} bytes",
            metadata.size, max_len
        ));
    }

    let bytes = sftp.download_to_vec(&path).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_len {
        return Err(format!(
            "`{path}` expanded to {} bytes, above editor limit {} bytes",
            bytes.len(),
            max_len
        ));
    }
    if bytes.contains(&0) {
        return Err(format!("`{path}` looks like binary data (contains NUL bytes)"));
    }

    let content =
        String::from_utf8(bytes).map_err(|_| format!("`{path}` is not valid UTF-8 text"))?;

    Ok(RemoteTextFileDto {
        path,
        size: metadata.size,
        content,
    })
}

#[tauri::command]
pub async fn sftp_permission_mode(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<FilePermissionModeDto, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let meta = sftp.stat(&path).await.map_err(|e| e.to_string())?;
    Ok(FilePermissionModeDto {
        mode: meta.permissions_mode.map(|m| m & 0o7777),
    })
}

/// Save UTF-8 text content back to a remote file path.
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    content: String,
) -> Result<u64, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let bytes = content.into_bytes();
    let size = bytes.len() as u64;
    if size > HARD_TEXT_EDIT_MAX_BYTES {
        return Err(format!(
            "editor payload is {} bytes, above hard limit {} bytes",
            size, HARD_TEXT_EDIT_MAX_BYTES
        ));
    }

    sftp.upload_from_slice(&path, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(size)
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    sftp.chmod(&path, mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    transfer_id: u64,
) -> Result<(), String> {
    let token = state.transfers.lock().unwrap().get(&transfer_id).cloned();
    if let Some(t) = token {
        t.cancel();
        debug!(transfer_id, "transfer cancellation requested");
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    pub transfer_id: u64,
    pub kind: &'static str, // "download" | "upload"
    pub source: String,
    pub destination: String,
    pub bytes_done: u64,
    pub total: Option<u64>,
    /// Instantaneous throughput over the last emit interval. `None` on
    /// the first event (no baseline) and on the final `finished` event.
    pub bytes_per_sec: Option<u64>,
    /// Remaining seconds, computed when both `total` and `bytes_per_sec`
    /// are known and non-zero.
    pub eta_seconds: Option<u64>,
    pub finished: bool,
}

fn register_transfer(state: &AppState) -> (u64, tokio_util::sync::CancellationToken) {
    let id = state
        .next_transfer_id
        .fetch_add(1, Ordering::SeqCst);
    let token = tokio_util::sync::CancellationToken::new();
    state
        .transfers
        .lock()
        .unwrap()
        .insert(id, token.clone());
    (id, token)
}

fn forget_transfer(state: &AppState, id: u64) {
    state.transfers.lock().unwrap().remove(&id);
}

async fn sftp_remove_dir_recursive(
    sftp: &zeroterm_ssh::Sftp,
    path: &str,
) -> Result<(), String> {
    let root = normalize_remote_path(path);
    if root == "/" {
        return Err("refusing to delete remote root directory `/`".to_string());
    }

    // Post-order traversal: remove files first, then remove each directory
    // after all of its children have been processed.
    let mut stack: Vec<(String, bool)> = vec![(root, false)];
    while let Some((current, visited)) = stack.pop() {
        if visited {
            sftp.remove_dir(&current).await.map_err(|e| e.to_string())?;
            continue;
        }

        stack.push((current.clone(), true));
        let entries = sftp.list(&current).await.map_err(|e| e.to_string())?;
        for entry in entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child = remote_join_path(&current, &entry.name);
            match entry.kind {
                FileKind::Dir => stack.push((child, false)),
                FileKind::File | FileKind::Symlink | FileKind::Other => {
                    sftp.remove_file(&child).await.map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

/// Wrap a streaming SFTP call so the progress callback emits Tauri
/// `sftp:progress` events, throttled to ~10 per second so we don't
/// drown the IPC bus on big files. Always emits a final `finished`
/// event regardless of success / failure.
async fn run_with_progress<F, Fut>(
    app_handle: &AppHandle,
    transfer_id: u64,
    kind: &'static str,
    source: String,
    destination: String,
    body: F,
) -> Result<u64, zeroterm_ssh::SshError>
where
    F: FnOnce(
        Box<dyn FnMut(zeroterm_ssh::ProgressTick) + Send>,
    ) -> Fut,
    Fut: std::future::Future<Output = Result<u64, zeroterm_ssh::SshError>>,
{
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    /// Tracking state for throughput / ETA computation. `has_baseline`
    /// flips to true after the first emit so subsequent emits know they
    /// have a prior point to subtract from.
    struct ProgressState {
        last_emit_at: Instant,
        last_emit_bytes: u64,
        has_baseline: bool,
    }

    let state = Arc::new(Mutex::new(ProgressState {
        last_emit_at: Instant::now(),
        last_emit_bytes: 0,
        has_baseline: false,
    }));
    let app_handle_for_cb = app_handle.clone();
    let source_for_cb = source.clone();
    let dest_for_cb = destination.clone();

    let cb: Box<dyn FnMut(zeroterm_ssh::ProgressTick) + Send> = Box::new(move |tick| {
        let now = Instant::now();
        let mut s = state.lock().unwrap();
        let is_done = matches!(tick.total, Some(t) if tick.bytes_done >= t);

        // Throttle: don't emit more than ~10/s, but always emit the very
        // first tick (so the UI can render initial state) and the final
        // tick (so the UI sees 100%).
        if s.has_baseline
            && now.duration_since(s.last_emit_at) < Duration::from_millis(100)
            && !is_done
        {
            return;
        }

        let bytes_per_sec = if s.has_baseline {
            let dt = now.duration_since(s.last_emit_at).as_secs_f64();
            if dt > 0.001 {
                let db = tick.bytes_done.saturating_sub(s.last_emit_bytes) as f64;
                Some((db / dt) as u64)
            } else {
                None
            }
        } else {
            None
        };

        let eta_seconds = match (bytes_per_sec, tick.total) {
            (Some(bps), Some(total)) if bps > 0 && tick.bytes_done < total => {
                Some((total - tick.bytes_done) / bps)
            }
            _ => None,
        };

        s.last_emit_at = now;
        s.last_emit_bytes = tick.bytes_done;
        s.has_baseline = true;
        drop(s);

        let _ = app_handle_for_cb.emit(
            "sftp:progress",
            TransferProgressEvent {
                transfer_id,
                kind,
                source: source_for_cb.clone(),
                destination: dest_for_cb.clone(),
                bytes_done: tick.bytes_done,
                total: tick.total,
                bytes_per_sec,
                eta_seconds,
                finished: false,
            },
        );
    });

    let outcome = body(cb).await;

    // Always send a final event so the UI knows it can clean up.
    let _ = app_handle.emit(
        "sftp:progress",
        TransferProgressEvent {
            transfer_id,
            kind,
            source,
            destination,
            bytes_done: outcome.as_ref().copied().unwrap_or(0),
            total: None,
            bytes_per_sec: None,
            eta_seconds: None,
            finished: true,
        },
    );

    outcome
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    sftp.remove_file(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove_dir(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    sftp_remove_dir_recursive(&sftp, &path).await
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: u64,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    sftp.rename(&from, &to).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    sftp.create_dir(&path).await.map_err(|e| e.to_string())
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
