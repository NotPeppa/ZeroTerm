//! Top-level Object exposed to Swift / Kotlin. Holds the vault and any
//! active sessions, delegating to `zeroterm-app` and `zeroterm-ssh`.
//!
//! Locking discipline: the `Mutex`es here protect plain in-memory maps
//! and Options. We never hold one across an `await`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tracing::{debug, info, warn};
use serde::Deserialize;
use serde_json::json;

use zeroterm_ssh::{ChannelEvent, HostKeyPolicy, KnownHosts, PtySize, Session, ShellChannel};

use crate::error::{map_app_error, other, FfiError};
use crate::listener::{ForeignHostKeyPrompt, HostKeyPromptCallback, PendingMap, SessionListener};
use crate::types::{
    host_group_to_record, host_input_to_host, host_to_detail, host_to_summary, AiChatMessage,
    AiChatResponse, AiProfileInput, AiProfileRecord, HostAuthInput, HostDetail, HostExecResult,
    HostGroupInput, HostGroupRecord, HostInput, HostSummary, SnippetInput, SnippetRecord, VaultStatus,
};

/// Entry point for the FFI surface. Construct one per app process,
/// store it in a long-lived holder on the host (a singleton, an
/// `ObservableObject`, etc.).
#[derive(uniffi::Object)]
pub struct ZeroTerm {
    /// Arc so sync engines can share the vault-backed store safely.
    pub(crate) inner: Mutex<Option<Arc<zeroterm_app::App>>>,
    vault_path_override: Mutex<Option<PathBuf>>,
    /// App-private data directory (Android `filesDir`, iOS Documents, etc.).
    /// When set: default vault is `{data_dir}/zeroterm.vault` and known_hosts
    /// is `{data_dir}/known_hosts`. Required on mobile where `$HOME` is missing.
    data_dir: Mutex<Option<PathBuf>>,

    sessions: Arc<Mutex<HashMap<u64, SessionEntry>>>,
    next_session_id: AtomicU64,

    pub(crate) pending_host_key: PendingMap,

    /// Active SFTP channels (batch-4).
    pub(crate) sftp_handles: crate::sftp::SftpMap,
    pub(crate) next_sftp_id: AtomicU64,
    pub(crate) transfer_cancels: crate::sftp::CancelMap,
    pub(crate) next_transfer_id: AtomicU64,

    /// Sync engines keyed by profile id (batch-6).
    pub(crate) sync_manager: Arc<zeroterm_app::SyncManager>,
}

struct SessionEntry {
    control_tx: mpsc::Sender<SessionCommand>,
}

#[derive(Debug)]
enum SessionCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    Exec {
        command: String,
        response: oneshot::Sender<Result<HostExecResult, String>>,
    },
    Disconnect,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiResponseMessage,
}

#[derive(Deserialize)]
struct OpenAiResponseMessage {
    #[serde(default)]
    content: String,
    #[serde(default)]
    reasoning_content: String,
}

fn ai_profile_record(profile: zeroterm_app::AiProfile) -> AiProfileRecord {
    AiProfileRecord {
        has_api_key: !profile.api_key.is_empty(),
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        base_url: profile.base_url,
        model: profile.model,
        system_prompt: profile.system_prompt,
        reasoning_effort: profile.reasoning_effort,
    }
}

fn ai_http_client() -> Result<reqwest::Client, FfiError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(other)
}

fn ai_http_error(status: u16, body: &str) -> FfiError {
    let preview = body.chars().take(1_000).collect::<String>();
    FfiError::Other {
        detail: format!("AI request failed ({status}): {preview}"),
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl ZeroTerm {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(None),
            vault_path_override: Mutex::new(None),
            data_dir: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: AtomicU64::new(1),
            pending_host_key: Arc::new(Mutex::new(HashMap::new())),
            sftp_handles: Arc::new(Mutex::new(HashMap::new())),
            next_sftp_id: AtomicU64::new(1),
            transfer_cancels: Arc::new(Mutex::new(HashMap::new())),
            next_transfer_id: AtomicU64::new(1),
            sync_manager: Arc::new(zeroterm_app::SyncManager::new()),
        })
    }

    /// Use a custom vault path instead of the OS default. Pass empty
    /// string to revert to the OS default.
    pub fn set_vault_path(&self, path: String) {
        let mut guard = self.vault_path_override.lock().unwrap();
        *guard = if path.is_empty() {
            None
        } else {
            Some(PathBuf::from(path))
        };
    }

    /// Set the app data directory used for vault + known_hosts when no
    /// explicit vault path is set. Pass empty string to clear.
    ///
    /// On Android call with `context.filesDir.absolutePath` at startup
    /// before any vault/session operations.
    pub fn set_data_dir(&self, path: String) {
        let mut guard = self.data_dir.lock().unwrap();
        *guard = if path.is_empty() {
            zeroterm_app::set_sync_known_hosts_path(None);
            None
        } else {
            let p = PathBuf::from(&path);
            zeroterm_app::set_sync_known_hosts_path(Some(p.join("known_hosts")));
            Some(p)
        };
    }

    /// Configure one process-wide HTTP CONNECT proxy for SSH and network
    /// clients. An empty value disables the proxy.
    pub fn set_network_proxy(&self, proxy_url: String) -> Result<String, FfiError> {
        let raw = proxy_url.trim();
        if raw.is_empty() {
            for key in [
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "http_proxy",
                "https_proxy",
                "all_proxy",
            ] {
                std::env::remove_var(key);
            }
            zeroterm_ssh::set_global_http_proxy(None);
            return Ok(String::new());
        }

        let parsed = reqwest::Url::parse(raw).map_err(|e| FfiError::Other {
            detail: format!("invalid proxy URL: {e}"),
        })?;
        if parsed.scheme() != "http" {
            return Err(FfiError::Other {
                detail: "only http:// proxy URLs are supported".into(),
            });
        }
        if parsed.host_str().is_none() || parsed.port_or_known_default().is_none() {
            return Err(FfiError::Other {
                detail: "proxy URL must include a host and valid port".into(),
            });
        }
        if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(FfiError::Other {
                detail: "proxy URL may only contain scheme, host, port, and optional credentials"
                    .into(),
            });
        }

        let normalized = parsed.to_string();
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            std::env::set_var(key, &normalized);
        }
        zeroterm_ssh::set_global_http_proxy(Some(normalized.clone()));
        Ok(normalized)
    }

    // -- vault ------------------------------------------------------------

    pub fn vault_status(&self) -> Result<VaultStatus, FfiError> {
        let path = self.resolved_vault_path()?;
        let exists = zeroterm_app::App::vault_exists(&path);
        let unlocked = self.inner.lock().unwrap().is_some();
        Ok(VaultStatus {
            path: path.display().to_string(),
            exists,
            unlocked,
        })
    }

    pub fn unlock(&self, password: String, remember: bool) -> Result<(), FfiError> {
        let path = self.resolved_vault_path()?;
        let app = Arc::new(zeroterm_app::App::open(&path, &password).map_err(map_app_error)?);
        *self.inner.lock().unwrap() = Some(app);
        if remember {
            if let Err(e) = zeroterm_app::keychain::save_master_password(&path, &password) {
                tracing::warn!(error = %e, "could not cache master password in keychain");
            }
        }
        Ok(())
    }

    pub fn create(&self, password: String, remember: bool) -> Result<(), FfiError> {
        if password.is_empty() {
            return Err(FfiError::Other {
                detail: "password cannot be empty".into(),
            });
        }
        let path = self.resolved_vault_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(other)?;
        }
        let app = Arc::new(zeroterm_app::App::create(&path, &password).map_err(map_app_error)?);
        *self.inner.lock().unwrap() = Some(app);
        if remember {
            if let Err(e) = zeroterm_app::keychain::save_master_password(&path, &password) {
                tracing::warn!(error = %e, "could not cache master password in keychain");
            }
        }
        Ok(())
    }

    pub fn lock(&self) {
        *self.inner.lock().unwrap() = None;
        // Drop any live sync engines; re-join after next unlock.
    }

    /// Try to unlock the vault using the OS keychain-cached master
    /// password, if any. Returns `true` on success, `false` if there's no
    /// cache, the cache is stale, or the keychain backend is unavailable.
    /// Never errors — keychain absence is a normal state.
    ///
    /// On macOS, all keychain reads are batched via preload so the user
    /// only sees a single Touch ID / password prompt.
    pub fn try_keychain_unlock(&self) -> Result<bool, FfiError> {
        let path = self.resolved_vault_path()?;
        if !zeroterm_app::App::vault_exists(&path) {
            return Ok(false);
        }

        // Preload master password in one burst (single macOS prompt).
        zeroterm_app::keychain::cache().preload(&path, &[]);

        let pw = match zeroterm_app::keychain::get_master_password(&path) {
            Ok(Some(p)) => p,
            Ok(None) => return Ok(false),
            Err(e) => {
                tracing::debug!(error = %e, "keychain unavailable");
                return Ok(false);
            }
        };
        match zeroterm_app::App::open(&path, &pw) {
            Ok(app) => {
                *self.inner.lock().unwrap() = Some(Arc::new(app));
                Ok(true)
            }
            Err(zeroterm_app::AppError::Vault(zeroterm_app::VaultError::AuthenticationFailed)) => {
                tracing::warn!("cached master password no longer matches; ignoring");
                Ok(false)
            }
            Err(e) => Err(map_app_error(e)),
        }
    }

    /// Drop any cached master password for the current vault path.
    pub fn forget_keychain(&self) -> Result<(), FfiError> {
        let path = self.resolved_vault_path()?;
        zeroterm_app::keychain::forget_master_password(&path).map_err(|e| FfiError::Other {
            detail: e.to_string(),
        })
    }

    // -- AI ---------------------------------------------------------------

    pub fn list_ai_profiles(&self) -> Result<Vec<AiProfileRecord>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        Ok(app
            .list_ai_profiles()
            .map_err(map_app_error)?
            .into_iter()
            .map(ai_profile_record)
            .collect())
    }

    pub fn save_ai_profile(&self, input: AiProfileInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let id = input.id.clone().filter(|id| !id.trim().is_empty());
        let existing = id
            .as_deref()
            .map(|profile_id| app.find_ai_profile_by_id(profile_id))
            .transpose()
            .map_err(map_app_error)?
            .flatten();
        let api_key = if input.api_key.trim().is_empty() {
            existing.as_ref().map(|p| p.api_key.clone()).unwrap_or_default()
        } else {
            input.api_key.trim().to_string()
        };
        if api_key.is_empty() {
            return Err(FfiError::Other {
                detail: "AI API key cannot be empty".into(),
            });
        }
        let provider = if input.provider.trim().is_empty() {
            "openai-compatible".to_string()
        } else {
            input.provider.trim().to_string()
        };
        let mut base_url = input.base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() && provider == "openai" {
            base_url = "https://api.openai.com/v1".into();
        }
        reqwest::Url::parse(&base_url).map_err(other)?;
        let profile = zeroterm_app::AiProfile {
            id: id.clone().unwrap_or_default(),
            name: input.name.trim().to_string(),
            provider,
            base_url,
            model: input.model.trim().to_string(),
            api_key,
            system_prompt: input.system_prompt.trim().to_string(),
            reasoning_effort: input.reasoning_effort.trim().to_string(),
        };
        if id.is_some() {
            app.update_ai_profile(&profile).map_err(map_app_error)?;
            Ok(profile.id)
        } else {
            app.save_ai_profile(&profile).map_err(map_app_error)
        }
    }

    pub fn delete_ai_profile(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_ai_profile(&id).map_err(map_app_error)
    }

    pub async fn list_ai_models(&self, profile_id: String) -> Result<Vec<String>, FfiError> {
        let profile = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_ai_profile_by_id(&profile_id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound {
                    detail: profile_id.clone(),
                })?
        };
        let client = ai_http_client()?;
        let response = client
            .get(format!("{}/models", profile.base_url))
            .bearer_auth(profile.api_key)
            .send()
            .await
            .map_err(other)?;
        let status = response.status();
        let body = response.text().await.map_err(other)?;
        if !status.is_success() {
            return Err(ai_http_error(status.as_u16(), &body));
        }
        let mut models = serde_json::from_str::<OpenAiModelsResponse>(&body)
            .map_err(other)?
            .data
            .into_iter()
            .map(|model| model.id)
            .filter(|id| !id.trim().is_empty())
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        Ok(models)
    }

    pub async fn list_ai_models_with_config(
        &self,
        profile_id: Option<String>,
        base_url: String,
        api_key: String,
    ) -> Result<Vec<String>, FfiError> {
        let base_url = base_url.trim().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err(FfiError::Other {
                detail: "AI Base URL cannot be empty".into(),
            });
        }
        reqwest::Url::parse(&base_url).map_err(other)?;

        let api_key = if api_key.trim().is_empty() {
            let id = profile_id
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| FfiError::Other {
                    detail: "AI API key cannot be empty".into(),
                })?;
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_ai_profile_by_id(&id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound { detail: id })?
                .api_key
        } else {
            api_key.trim().to_string()
        };

        let client = ai_http_client()?;
        let response = client
            .get(format!("{base_url}/models"))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(other)?;
        let status = response.status();
        let body = response.text().await.map_err(other)?;
        if !status.is_success() {
            return Err(ai_http_error(status.as_u16(), &body));
        }
        let mut models = serde_json::from_str::<OpenAiModelsResponse>(&body)
            .map_err(other)?
            .data
            .into_iter()
            .map(|model| model.id)
            .filter(|id| !id.trim().is_empty())
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        Ok(models)
    }

    pub async fn ai_chat(
        &self,
        profile_id: String,
        messages: Vec<AiChatMessage>,
    ) -> Result<AiChatResponse, FfiError> {
        self.ai_chat_with_model(profile_id, String::new(), messages)
            .await
    }

    pub async fn ai_chat_with_model(
        &self,
        profile_id: String,
        model_override: String,
        messages: Vec<AiChatMessage>,
    ) -> Result<AiChatResponse, FfiError> {
        let profile = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_ai_profile_by_id(&profile_id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound {
                    detail: profile_id.clone(),
                })?
        };
        let mut payload = Vec::new();
        if !profile.system_prompt.is_empty() {
            payload.push(json!({ "role": "system", "content": profile.system_prompt }));
        }
        for message in messages {
            let content = message.content.trim();
            if content.is_empty() {
                continue;
            }
            let role = match message.role.as_str() {
                "system" | "assistant" | "user" => message.role,
                _ => "user".into(),
            };
            payload.push(json!({ "role": role, "content": content }));
        }
        if payload.is_empty() {
            return Err(FfiError::Other { detail: "message is empty".into() });
        }
        let model = if model_override.trim().is_empty() {
            profile.model.clone()
        } else {
            model_override.trim().to_string()
        };
        let mut body = json!({
            "model": model,
            "messages": payload,
            "temperature": 0.2,
        });
        if !profile.reasoning_effort.is_empty() {
            body["reasoning_effort"] = json!(profile.reasoning_effort);
        }
        let response = ai_http_client()?
            .post(format!("{}/chat/completions", profile.base_url))
            .bearer_auth(profile.api_key)
            .json(&body)
            .send()
            .await
            .map_err(other)?;
        let status = response.status();
        let text = response.text().await.map_err(other)?;
        if !status.is_success() {
            return Err(ai_http_error(status.as_u16(), &text));
        }
        let parsed: OpenAiChatResponse = serde_json::from_str(&text).map_err(other)?;
        let message = parsed.choices.into_iter().next().map(|c| c.message)
            .ok_or_else(|| FfiError::Other { detail: "AI response was empty".into() })?;
        if message.content.trim().is_empty() && message.reasoning_content.trim().is_empty() {
            return Err(FfiError::Other { detail: "AI response was empty".into() });
        }
        Ok(AiChatResponse {
            content: message.content.trim().to_string(),
            reasoning_content: message.reasoning_content.trim().to_string(),
        })
    }

    // -- hosts ------------------------------------------------------------

    pub fn list_hosts(&self) -> Result<Vec<HostSummary>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let hosts = app.list_hosts().map_err(map_app_error)?;
        Ok(hosts.into_iter().map(host_to_summary).collect())
    }

    pub fn list_host_groups(&self) -> Result<Vec<HostGroupRecord>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let groups = app.list_host_groups().map_err(map_app_error)?;
        Ok(groups.into_iter().map(host_group_to_record).collect())
    }

    pub fn save_host_group(&self, input: HostGroupInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let group = zeroterm_app::HostGroup {
            id: input.id.clone().unwrap_or_default(),
            name: input.name.trim().to_string(),
            parent_id: input.parent_id.filter(|id| !id.is_empty()),
            sort_order: input.sort_order,
        };
        if input.id.as_deref().is_some_and(|id| !id.is_empty()) {
            app.update_host_group(&group).map_err(map_app_error)?;
            Ok(group.id)
        } else {
            app.save_host_group(&group).map_err(map_app_error)
        }
    }

    pub fn delete_host_group(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_host_group(&id).map_err(map_app_error)
    }

    pub fn get_host(&self, id: String) -> Result<HostDetail, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let host = app
            .find_host_by_id(&id)
            .map_err(map_app_error)?
            .ok_or_else(|| FfiError::NotFound {
                detail: id.clone(),
            })?;
        Ok(host_to_detail(host))
    }

    /// Insert a new host (`host.id` ignored / empty) or update when
    /// `host.id` is set. Forwards / ProxyJump from the existing record
    /// are preserved on update.
    pub fn save_host(&self, host: HostInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        if let Some(ref id) = host.id {
            if !id.is_empty() {
                let existing = app
                    .find_host_by_id(id)
                    .map_err(map_app_error)?
                    .ok_or_else(|| FfiError::NotFound {
                        detail: id.clone(),
                    })?;
                let mut h = host_input_to_host(host);
                h.id = existing.id;
                h.forwards = existing.forwards;
                h.proxy_jump_host_id = existing.proxy_jump_host_id;
                h.os_type = existing.os_type;
                app.update_host(&h).map_err(map_app_error)?;
                return Ok(h.id);
            }
        }
        let h = host_input_to_host(host);
        app.save_host(&h).map_err(map_app_error)
    }

    pub fn delete_host(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_host(&id).map_err(map_app_error)
    }

    // -- snippets ---------------------------------------------------------

    pub fn list_snippets(&self) -> Result<Vec<SnippetRecord>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let list = app.list_snippets().map_err(map_app_error)?;
        Ok(list
            .into_iter()
            .map(|s| SnippetRecord {
                id: s.id,
                title: s.title,
                command: s.command,
                group: s.group,
                sort_order: s.sort_order,
            })
            .collect())
    }

    pub fn get_snippet(&self, id: String) -> Result<SnippetRecord, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let s = app
            .find_snippet_by_id(&id)
            .map_err(map_app_error)?
            .ok_or_else(|| FfiError::NotFound {
                detail: id.clone(),
            })?;
        Ok(SnippetRecord {
            id: s.id,
            title: s.title,
            command: s.command,
            group: s.group,
            sort_order: s.sort_order,
        })
    }

    pub fn save_snippet(&self, input: SnippetInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        if let Some(ref id) = input.id {
            if !id.is_empty() {
                let snip = zeroterm_app::Snippet {
                    id: id.clone(),
                    title: input.title,
                    command: input.command,
                    group: input.group,
                    sort_order: input.sort_order,
                };
                app.update_snippet(&snip).map_err(map_app_error)?;
                return Ok(id.clone());
            }
        }
        let snip = zeroterm_app::Snippet {
            id: String::new(),
            title: input.title,
            command: input.command,
            group: input.group,
            sort_order: input.sort_order,
        };
        app.save_snippet(&snip).map_err(map_app_error)
    }

    pub fn delete_snippet(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_snippet(&id).map_err(map_app_error)
    }

    pub fn rename_snippet_group(&self, old: String, new: String) -> Result<u32, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let n = app
            .rename_snippet_group(&old, &new)
            .map_err(map_app_error)?;
        Ok(n as u32)
    }

    pub fn delete_snippet_group(&self, group: String) -> Result<u32, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let n = app.delete_snippet_group(&group).map_err(map_app_error)?;
        Ok(n as u32)
    }

    // -- sessions ---------------------------------------------------------

    /// Connect to a saved host and open a PTY-backed shell. Streams data
    /// into `listener.on_data`; surfaces unknown / mismatched host keys
    /// via `host_key_prompt.on_prompt` (which must be answered via
    /// [`Self::respond_host_key`]).
    ///
    /// Returns the new `session_id`. Use it with [`Self::send_input`],
    /// [`Self::resize_session`], [`Self::disconnect_session`].
    pub async fn connect_host(
        &self,
        host_id: String,
        cols: u16,
        rows: u16,
        listener: Arc<dyn SessionListener>,
        host_key_prompt: Arc<dyn HostKeyPromptCallback>,
    ) -> Result<u64, FfiError> {
        let host = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_host_by_id(&host_id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound {
                    detail: host_id.clone(),
                })?
        };
        self.spawn_session(&host, cols, rows, listener, host_key_prompt)
            .await
    }

    /// Quick Connect: connect without a saved vault host. Vault must still
    /// be unlocked (session APIs live on the same object). Host is not
    /// written to the vault.
    pub async fn connect_direct(
        &self,
        host: String,
        port: u16,
        user: String,
        auth: HostAuthInput,
        cols: u16,
        rows: u16,
        listener: Arc<dyn SessionListener>,
        host_key_prompt: Arc<dyn HostKeyPromptCallback>,
    ) -> Result<u64, FfiError> {
        // Require unlocked vault so mobile clients keep a consistent gate.
        {
            let guard = self.inner.lock().unwrap();
            guard.as_ref().ok_or(FfiError::VaultLocked)?;
        }
        let ephemeral = zeroterm_app::Host {
            id: String::new(),
            name: format!("{user}@{host}"),
            host,
            port: if port == 0 { 22 } else { port },
            user,
            auth: match auth {
                HostAuthInput::Password { value } => {
                    zeroterm_app::HostAuth::Password { value }
                }
                HostAuthInput::PrivateKey {
                    key_pem,
                    passphrase,
                } => zeroterm_app::HostAuth::PrivateKey {
                    key_pem,
                    passphrase,
                },
                HostAuthInput::Agent => zeroterm_app::HostAuth::Agent,
            },
            os_type: None,
            forwards: Vec::new(),
            proxy_jump_host_id: None,
            group_id: None,
        };
        self.spawn_session(&ephemeral, cols, rows, listener, host_key_prompt)
            .await
    }

    pub async fn send_input(&self, session_id: u64, data: Vec<u8>) -> Result<(), FfiError> {
        let tx = self.lookup_tx(session_id)?;
        tx.send(SessionCommand::Input(data))
            .await
            .map_err(|_| FfiError::Other {
                detail: "session task closed".into(),
            })
    }

    pub async fn resize_session(
        &self,
        session_id: u64,
        cols: u16,
        rows: u16,
    ) -> Result<(), FfiError> {
        // Resize is best-effort — if the task already exited, swallow
        // silently rather than surface as an error.
        if let Some(tx) = self.maybe_lookup_tx(session_id) {
            let _ = tx.send(SessionCommand::Resize(cols, rows)).await;
        }
        Ok(())
    }

    pub async fn disconnect_session(&self, session_id: u64) -> Result<(), FfiError> {
        if let Some(tx) = self.maybe_lookup_tx(session_id) {
            let _ = tx.send(SessionCommand::Disconnect).await;
        }
        debug!(session_id, "ffi: disconnect requested");
        Ok(())
    }

    /// Execute a command over the active SSH transport without writing it to
    /// the PTY. Works for both saved hosts and Quick Connect sessions.
    pub async fn exec_session_command(
        &self,
        session_id: u64,
        command: String,
    ) -> Result<HostExecResult, FfiError> {
        if command.trim().is_empty() {
            return Err(FfiError::Other { detail: "command cannot be empty".into() });
        }
        let tx = self.lookup_tx(session_id)?;
        let (response, receive) = oneshot::channel();
        tx.send(SessionCommand::Exec { command, response })
            .await
            .map_err(|_| FfiError::Other { detail: "session task closed".into() })?;
        receive.await
            .map_err(|_| FfiError::Other { detail: "session command cancelled".into() })?
            .map_err(|detail| FfiError::Other { detail })
    }

    /// Execute a non-interactive command on a saved host. This deliberately
    /// uses a separate SSH channel so monitoring never writes into the user's PTY.
    pub async fn exec_host_command(
        &self,
        host_id: String,
        command: String,
    ) -> Result<HostExecResult, FfiError> {
        if command.trim().is_empty() {
            return Err(FfiError::Other { detail: "command cannot be empty".into() });
        }
        let host = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_host_by_id(&host_id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound { detail: host_id.clone() })?
        };
        let known_hosts = self.resolved_known_hosts()?;
        let cfg = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.connect_config(
                &host,
                HostKeyPolicy::Strict(known_hosts),
                Some(Duration::from_secs(15)),
            )
        };
        let mut session = Session::connect(cfg).await.map_err(other)?;
        let (code, stdout, stderr) = session.exec(&command).await.map_err(other)?;
        let _ = session.disconnect().await;
        Ok(HostExecResult {
            code: code as i32,
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
        })
    }

    // -- host-key prompt response ----------------------------------------

    /// Answer a pending host-key prompt. `accept = true` continues the
    /// SSH handshake; `false` cancels it.
    pub fn respond_host_key(&self, request_id: String, accept: bool) -> Result<(), FfiError> {
        let tx_opt = self.pending_host_key.lock().unwrap().remove(&request_id);
        match tx_opt {
            Some(tx) => {
                let _ = tx.send(accept);
                Ok(())
            }
            None => Err(FfiError::NotFound {
                detail: format!("no pending host-key prompt for id {request_id}"),
            }),
        }
    }
}

// --------------------------------------------------------------------------
// non-FFI helpers (regular Rust impl block, not exported)
// --------------------------------------------------------------------------

impl ZeroTerm {
    pub(crate) fn resolved_known_hosts(&self) -> Result<KnownHosts, FfiError> {
        if let Some(dir) = self.data_dir.lock().unwrap().clone() {
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return Err(other(e));
            }
            return Ok(KnownHosts::new(dir.join("known_hosts")));
        }
        KnownHosts::at_default().ok_or_else(|| FfiError::Other {
            detail: "could not locate $HOME for known_hosts; call setDataDir first".into(),
        })
    }

    async fn spawn_session(
        &self,
        host: &zeroterm_app::Host,
        cols: u16,
        rows: u16,
        listener: Arc<dyn SessionListener>,
        host_key_prompt: Arc<dyn HostKeyPromptCallback>,
    ) -> Result<u64, FfiError> {
        let known_hosts = self.resolved_known_hosts()?;
        let prompt = Arc::new(ForeignHostKeyPrompt {
            foreign: host_key_prompt,
            pending: self.pending_host_key.clone(),
        });
        let policy = HostKeyPolicy::Interactive {
            store: known_hosts,
            prompt,
        };

        let cfg = {
            let guard = self.inner.lock().unwrap();
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.connect_config(host, policy, Some(Duration::from_secs(15)))
        };

        info!(host = %host.host, port = host.port, "ffi: connecting");
        let mut session = Session::connect(cfg).await.map_err(other)?;

        let pty = PtySize::new(cols.max(1), rows.max(1));
        let channel = session.open_shell(pty).await.map_err(other)?;

        let session_id = self.next_session_id.fetch_add(1, Ordering::SeqCst);
        let (control_tx, control_rx) = mpsc::channel::<SessionCommand>(64);

        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            run_session_task(session_id, session, channel, control_rx, listener, sessions).await;
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id, SessionEntry { control_tx });

        info!(session_id, "ffi: session ready");
        Ok(session_id)
    }

    fn resolved_vault_path(&self) -> Result<PathBuf, FfiError> {
        if let Some(p) = self.vault_path_override.lock().unwrap().clone() {
            return Ok(p);
        }
        if let Some(dir) = self.data_dir.lock().unwrap().clone() {
            return Ok(dir.join("zeroterm.vault"));
        }
        zeroterm_app::default_vault_path().ok_or(FfiError::Other {
            detail: "no default vault path on this OS; call setDataDir first".into(),
        })
    }

    fn lookup_tx(&self, session_id: u64) -> Result<mpsc::Sender<SessionCommand>, FfiError> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|e| e.control_tx.clone())
            .ok_or_else(|| FfiError::NotFound {
                detail: format!("session {session_id}"),
            })
    }

    fn maybe_lookup_tx(&self, session_id: u64) -> Option<mpsc::Sender<SessionCommand>> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|e| e.control_tx.clone())
    }
}

// --------------------------------------------------------------------------
// per-session task
// --------------------------------------------------------------------------

async fn run_session_task(
    session_id: u64,
    mut session: Session,
    mut channel: ShellChannel,
    mut control_rx: mpsc::Receiver<SessionCommand>,
    listener: Arc<dyn SessionListener>,
    sessions: Arc<Mutex<HashMap<u64, SessionEntry>>>,
) {
    let mut last_exit: Option<u32> = None;
    let mut error_msg: Option<String> = None;

    loop {
        tokio::select! {
            ev = channel.recv() => match ev {
                ChannelEvent::Data(bytes) | ChannelEvent::Stderr(bytes) => {
                    listener.on_data(bytes);
                }
                ChannelEvent::Exit(code) => {
                    last_exit = Some(code);
                    debug!(session_id, code, "ffi: remote exited");
                }
                ChannelEvent::Closed => {
                    debug!(session_id, "ffi: channel closed");
                    break;
                }
            },
            cmd = control_rx.recv() => match cmd {
                Some(SessionCommand::Input(b)) => {
                    if let Err(e) = channel.send(&b).await {
                        warn!(session_id, error = %e, "ffi: send failed");
                        error_msg = Some(format!("send failed: {e}"));
                        break;
                    }
                }
                Some(SessionCommand::Resize(c, r)) => {
                    if let Err(e) = channel.resize(PtySize::new(c, r)).await {
                        warn!(session_id, error = %e, "ffi: resize failed");
                    }
                }
                Some(SessionCommand::Exec { command, response }) => {
                    let result = session.exec(&command).await
                        .map(|(code, stdout, stderr)| HostExecResult {
                            code: code as i32,
                            stdout: String::from_utf8_lossy(&stdout).to_string(),
                            stderr: String::from_utf8_lossy(&stderr).to_string(),
                        })
                        .map_err(|e| e.to_string());
                    let _ = response.send(result);
                }
                Some(SessionCommand::Disconnect) | None => {
                    debug!(session_id, "ffi: disconnect requested");
                    break;
                }
            }
        }
    }

    let _ = session.disconnect().await;
    listener.on_closed(last_exit, error_msg);
    sessions.lock().unwrap().remove(&session_id);
}
