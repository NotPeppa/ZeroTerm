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

use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use zeroterm_ssh::{ChannelEvent, HostKeyPolicy, KnownHosts, PtySize, Session, ShellChannel};

use crate::error::{map_app_error, other, FfiError};
use crate::listener::{ForeignHostKeyPrompt, HostKeyPromptCallback, PendingMap, SessionListener};
use crate::types::{host_input_to_host, host_to_summary, HostInput, HostSummary, VaultStatus};

/// Entry point for the FFI surface. Construct one per app process,
/// store it in a long-lived holder on the host (a singleton, an
/// `ObservableObject`, etc.).
#[derive(uniffi::Object)]
pub struct ZeroTerm {
    inner: Mutex<Option<zeroterm_app::App>>,
    vault_path_override: Mutex<Option<PathBuf>>,

    sessions: Arc<Mutex<HashMap<u64, SessionEntry>>>,
    next_session_id: AtomicU64,

    pending_host_key: PendingMap,
}

struct SessionEntry {
    control_tx: mpsc::Sender<SessionCommand>,
}

#[derive(Debug)]
enum SessionCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    Disconnect,
}

#[uniffi::export(async_runtime = "tokio")]
impl ZeroTerm {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(None),
            vault_path_override: Mutex::new(None),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_session_id: AtomicU64::new(1),
            pending_host_key: Arc::new(Mutex::new(HashMap::new())),
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
        let app = zeroterm_app::App::open(&path, &password).map_err(map_app_error)?;
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
                message: "password cannot be empty".into(),
            });
        }
        let path = self.resolved_vault_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(other)?;
        }
        let app = zeroterm_app::App::create(&path, &password).map_err(map_app_error)?;
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
                *self.inner.lock().unwrap() = Some(app);
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
            message: e.to_string(),
        })
    }

    // -- hosts ------------------------------------------------------------

    pub fn list_hosts(&self) -> Result<Vec<HostSummary>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let hosts = app.list_hosts().map_err(map_app_error)?;
        Ok(hosts.into_iter().map(host_to_summary).collect())
    }

    pub fn save_host(&self, host: HostInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let h = host_input_to_host(host);
        app.save_host(&h).map_err(map_app_error)
    }

    pub fn delete_host(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_host(&id).map_err(map_app_error)
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
                    message: host_id.clone(),
                })?
        };

        let known_hosts = KnownHosts::at_default().ok_or_else(|| FfiError::Other {
            message: "could not locate $HOME for known_hosts".into(),
        })?;
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
            app.connect_config(&host, policy, Some(Duration::from_secs(15)))
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

    pub async fn send_input(&self, session_id: u64, data: Vec<u8>) -> Result<(), FfiError> {
        let tx = self.lookup_tx(session_id)?;
        tx.send(SessionCommand::Input(data))
            .await
            .map_err(|_| FfiError::Other {
                message: "session task closed".into(),
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
                message: format!("no pending host-key prompt for id {request_id}"),
            }),
        }
    }
}

// --------------------------------------------------------------------------
// non-FFI helpers (regular Rust impl block, not exported)
// --------------------------------------------------------------------------

impl ZeroTerm {
    fn resolved_vault_path(&self) -> Result<PathBuf, FfiError> {
        if let Some(p) = self.vault_path_override.lock().unwrap().clone() {
            return Ok(p);
        }
        zeroterm_app::default_vault_path().ok_or(FfiError::Other {
            message: "no default vault path on this OS".into(),
        })
    }

    fn lookup_tx(&self, session_id: u64) -> Result<mpsc::Sender<SessionCommand>, FfiError> {
        self.sessions
            .lock()
            .unwrap()
            .get(&session_id)
            .map(|e| e.control_tx.clone())
            .ok_or_else(|| FfiError::NotFound {
                message: format!("session {session_id}"),
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
    session: Session,
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
