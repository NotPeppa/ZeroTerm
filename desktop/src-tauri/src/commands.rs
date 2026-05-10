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
            },
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
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostAuthInput {
    Password { value: String },
    PrivateKey {
        key_pem: String,
        passphrase: Option<String>,
    },
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
            },
            // CRUD UI doesn't (yet) edit forwards / proxy_jump — preserve
            // them on update via `update_host`'s round-trip below.
            forwards: Vec::new(),
            proxy_jump: None,
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
    /// Only populated for `password` auth — keys never leave the vault
    /// over IPC for editing (you can replace the key but not view it).
    pub password: Option<String>,
    pub key_passphrase: Option<String>,
    /// Read-only summaries of saved forwards (edit via CLI for now).
    pub forwards: Vec<String>,
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

    // Read existing record so we can preserve forwards / proxy_jump
    // — the form edits identity + auth only for now.
    let existing = app
        .find_host_by_id(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {id}"))?;

    let mut new_host = input.into_app_host(id);
    new_host.forwards = existing.forwards;
    new_host.proxy_jump = existing.proxy_jump;

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
    };

    Ok(HostFull {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        auth_type,
        password,
        key_passphrase,
        forwards: h.forwards.iter().map(|f| f.summary()).collect(),
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
