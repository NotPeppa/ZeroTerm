//! Tauri command surface — the JS-callable API.
//!
//! Conventions:
//!   - All commands return `Result<T, String>` so error messages cross
//!     the IPC boundary cleanly. We pretty-print the underlying error.
//!   - Sync mutexes are acquired in tight blocks; `await` happens after
//!     the lock is dropped.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tracing::{debug, info};

use zeroterm_app::{App, HostAuth};
use zeroterm_ssh::{FileKind, HostKeyPolicy, KnownHosts, PtySize, Session};

use crate::host_key::TauriHostKeyPrompt;
use crate::session::{run as run_session, ClosedEvent};
use crate::state::{AppState, SessionCommand, SessionHandle, SftpHandle};

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
pub async fn unlock_vault(
    state: State<'_, AppState>,
    password: String,
    remember: bool,
) -> Result<(), String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    let app = App::open(&path, &password).map_err(|e| e.to_string())?;
    *state.app.lock().unwrap() = Some(app);
    if remember {
        if let Err(e) = zeroterm_app::keychain::save_master_password(&path, &password) {
            tracing::warn!(error = %e, "could not cache master password in keychain");
        }
    }
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
    *state.app.lock().unwrap() = Some(app);
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
    Ok(())
}

/// Try to unlock the vault using the password cached in the OS keychain.
/// Returns `true` on success, `false` if there's no cache, the cache is
/// stale (password rotated), or the keychain backend is unavailable.
/// Never errors — keychain absence is a normal state.
#[tauri::command]
pub async fn try_keychain_unlock(state: State<'_, AppState>) -> Result<bool, String> {
    let path = zeroterm_app::default_vault_path()
        .ok_or_else(|| "no default vault path on this OS".to_string())?;
    if !App::vault_exists(&path) {
        return Ok(false);
    }
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
            *state.app.lock().unwrap() = Some(app);
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
    tauri::WebviewWindowBuilder::new(
        &app_handle,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("ZeroTerm")
    .inner_size(1360.0, 860.0)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
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
        })
        .collect())
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
    #[serde(default)]
    pub proxy_jump: Option<String>,
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
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    Dynamic {
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
    },
}

fn default_bind_addr() -> String {
    "127.0.0.1".to_string()
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
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_app::ForwardSpec::Local {
                bind_addr,
                bind_port,
                target_host,
                target_port,
            },
            ForwardSpecIO::Dynamic {
                bind_addr,
                bind_port,
            } => zeroterm_app::ForwardSpec::Dynamic {
                bind_addr,
                bind_port,
            },
        }
    }

    fn from_app(spec: &zeroterm_app::ForwardSpec) -> Self {
        match spec {
            zeroterm_app::ForwardSpec::Local {
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => ForwardSpecIO::Local {
                bind_addr: bind_addr.clone(),
                bind_port: *bind_port,
                target_host: target_host.clone(),
                target_port: *target_port,
            },
            zeroterm_app::ForwardSpec::Dynamic {
                bind_addr,
                bind_port,
            } => ForwardSpecIO::Dynamic {
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
            proxy_jump: self.proxy_jump,
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
    pub proxy_jump: Option<String>,
}

#[tauri::command]
pub async fn save_host(
    state: State<'_, AppState>,
    input: HostInput,
) -> Result<String, String> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    let h = input.into_app_host(String::new());
    app.save_host(&h).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_host(
    state: State<'_, AppState>,
    id: String,
    input: HostInput,
) -> Result<(), String> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let existing = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;

    let mut new_host = input.into_app_host(id);
    if new_host.os_type.is_none() {
        new_host.os_type = existing.os_type;
    }
    app.update_host(&new_host).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_host(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;
    app.delete_host(&id).map_err(|e| e.to_string())
}

/// Read a local text file (key material picked by the host editor).
/// We don't whitelist arbitrary FS access via the `tauri-plugin-fs`
/// permission machinery; this command takes a single path the user
/// just selected via the dialog plugin and reads it as UTF-8.
#[tauri::command]
pub async fn read_local_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("reading {path}: {e}"))
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
        proxy_jump: h.proxy_jump,
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

    let jump_cfg = if let Some(alias) = host.proxy_jump.as_deref() {
        let jump_host = app
            .find_host_by_name(alias)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("ProxyJump alias '{alias}' not found in vault"))?;
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

fn parse_os_release_value(raw: &str) -> &str {
    let v = raw.trim();
    if v.len() >= 2 {
        if (v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')) {
            return &v[1..v.len() - 1];
        }
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

    // Best effort: discover the remote OS once a connection is up, then
    // persist it so host cards can render stable system badges.
    match tokio::time::timeout(Duration::from_secs(3), detect_remote_os_type(&mut session)).await {
        Ok(Some(detected)) => {
            if host.os_type.as_deref() != Some(detected.as_str()) {
                if let Err(e) = persist_host_os_type(&state, &host.id, &detected) {
                    debug!(host_id = %host.id, error = %e, "persisting detected os_type failed");
                } else {
                    info!(host_id = %host.id, os_type = %detected, "detected remote os");
                }
            }
        }
        Ok(None) => {}
        Err(_) => {
            debug!(host_id = %host.id, "remote os detection timed out");
        }
    }

    // Saved forwards.
    let mut forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();
    let mut forward_summaries: Vec<String> = Vec::new();
    for spec in &host.forwards {
        let summary = spec.summary();
        let h = match spec {
            zeroterm_app::ForwardSpec::Local {
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

    let pty = PtySize::new(cols.unwrap_or(80), rows.unwrap_or(24));
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
    Ok(session_id)
}

#[tauri::command]
pub async fn send_input(
    state: State<'_, AppState>,
    session_id: u64,
    data: Vec<u8>,
) -> Result<(), String> {
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
) -> Result<(), String> {
    let tx = {
        state
            .pending_host_key
            .lock()
            .unwrap()
            .remove(&request_id)
    };
    if let Some(tx) = tx {
        let _ = tx.send(accept);
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

fn copy_local_tree_to_local(source: &Path, target: &Path, root_kind: CopyNodeKind) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            fs::copy(source, target).map_err(|e| {
                format!("copy file {} -> {}: {e}", source.display(), target.display())
            })?;
            Ok(())
        }
        CopyNodeKind::Dir => {
            fs::create_dir(target)
                .map_err(|e| format!("mkdir {}: {e}", target.display()))?;

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
                            fs::copy(&child_src, &child_dst).map_err(|e| {
                                format!(
                                    "copy file {} -> {}: {e}",
                                    child_src.display(),
                                    child_dst.display()
                                )
                            })?;
                        }
                        CopyNodeKind::Dir => {
                            fs::create_dir(&child_dst)
                                .map_err(|e| format!("mkdir {}: {e}", child_dst.display()))?;
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
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
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
            target_sftp
                .create_dir(target)
                .await
                .map_err(|e| e.to_string())?;

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
                            let data = tokio::fs::read(&child_src).await.map_err(|e| {
                                format!("reading {}: {e}", child_src.display())
                            })?;
                            target_sftp
                                .upload_from_slice(&child_dst, &data)
                                .await
                                .map_err(|e| e.to_string())?;
                        }
                        CopyNodeKind::Dir => {
                            target_sftp
                                .create_dir(&child_dst)
                                .await
                                .map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
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
            tokio::fs::create_dir(target)
                .await
                .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
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
                            let bytes = source_sftp
                                .download_to_vec(&child_src)
                                .await
                                .map_err(|e| e.to_string())?;
                            tokio::fs::write(&child_dst, &bytes)
                                .await
                                .map_err(|e| format!("writing {}: {e}", child_dst.display()))?;
                        }
                        CopyNodeKind::Dir => {
                            tokio::fs::create_dir(&child_dst)
                                .await
                                .map_err(|e| format!("mkdir {}: {e}", child_dst.display()))?;
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
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
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
            target_sftp
                .create_dir(target)
                .await
                .map_err(|e| e.to_string())?;
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
                            target_sftp
                                .create_dir(&child_dst)
                                .await
                                .map_err(|e| e.to_string())?;
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
) -> Result<(), String> {
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
            if fs::symlink_metadata(&dst).is_ok() {
                return Err(format!("destination already exists: {}", dst.display()));
            }
            copy_local_tree_to_local(&src, &dst, root_kind)
        }
        (None, Some(dst_id)) => {
            let src = PathBuf::from(&source_path);
            let dst_sftp = lookup_sftp(&state, dst_id)?;
            let dst = remote_join_path(&destination_dir, &source_name);
            if dst_sftp.stat(&dst).await.is_ok() {
                return Err(format!("destination already exists: {dst}"));
            }
            let root_kind = detect_local_kind(&src)?;
            copy_local_tree_to_remote(&src, &dst_sftp, &dst, root_kind).await
        }
        (Some(src_id), None) => {
            let src_sftp = lookup_sftp(&state, src_id)?;
            let dst_dir = PathBuf::from(&destination_dir);
            let dst = dst_dir.join(&source_name);
            if fs::symlink_metadata(&dst).is_ok() {
                return Err(format!("destination already exists: {}", dst.display()));
            }
            let meta = src_sftp
                .stat(&source_path)
                .await
                .map_err(|e| e.to_string())?;
            let root_kind = detect_remote_kind(&source_path, meta.kind)?;
            copy_remote_tree_to_local(&src_sftp, &source_path, &dst, root_kind).await
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
            if dst_sftp.stat(&dst).await.is_ok() {
                return Err(format!("destination already exists: {dst}"));
            }
            copy_remote_tree_to_remote(&src_sftp, &source_path, &dst_sftp, &dst, root_kind).await
        }
    }
}

const DEFAULT_TEXT_EDIT_MAX_BYTES: u64 = 2 * 1024 * 1024;
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
    sftp.remove_dir(&path).await.map_err(|e| e.to_string())
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
