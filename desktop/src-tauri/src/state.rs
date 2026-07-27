use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicU8};
use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot, Semaphore};

use crate::host_key::HostKeyResponse;
use crate::sftp::pool::SftpPool;
use crate::sftp::transfer::TransferManager;
use tokio_util::sync::CancellationToken;

/// Backend state shared across Tauri commands.
///
/// Locking discipline:
///   - All inner mutexes are sync `std::sync::Mutex`. **Never await while
///     holding one**. The session loop in `session::run` is the only
///     long-lived async work here, and it doesn't take these locks at
///     all — it owns its `ShellChannel` directly.
///   - Locks are short and granular; if you find yourself wanting to hold
///     `app` and `sessions` at the same time, restructure instead.
pub struct AppState {
    /// `None` while the vault is locked, `Some(Arc<App>)` once unlocked.
    /// Held as an `Arc` so commands can grab a cheap owned handle out of
    /// the mutex and `.await` without holding the lock.
    pub app: Mutex<Option<Arc<zeroterm_app::App>>>,

    /// Per-process cache of bootstrapped sync engines, keyed by sync
    /// profile id. Engines hold the unwrapped sync root key in memory,
    /// so dropping the manager (e.g. on vault lock) drops every key.
    pub sync: Arc<zeroterm_app::SyncManager>,

    /// Active shell sessions keyed by id assigned via `next_session_id`.
    pub sessions: Mutex<HashMap<u64, SessionHandle>>,

    pub next_session_id: AtomicU64,

    /// Outstanding host-key prompts, keyed by request_id. The session
    /// task that triggered the prompt awaits a oneshot from this map;
    /// the `respond_host_key` command pulls the sender out and fulfills
    /// it.
    pub pending_host_key: Mutex<HashMap<String, oneshot::Sender<HostKeyResponse>>>,

    /// Active SFTP handles keyed by id assigned via `next_sftp_id`.
    /// Distinct from `sessions` because the frontend addresses SFTP
    /// panes separately from interactive shells.
    pub sftp_handles: Mutex<HashMap<u64, SftpHandle>>,

    /// Shared SSH/SFTP connection pool keyed by host id. SFTP panes and
    /// background directory-copy workers borrow channels from here.
    pub sftp_pool: Arc<SftpPool>,

    pub transfer_manager: Arc<TransferManager>,
    pub transfer_slots: Arc<Semaphore>,

    pub next_sftp_id: AtomicU64,

    pub local_sessions: Mutex<HashMap<u64, LocalSessionHandle>>,

    /// Standalone SSH port forwarding tasks. These own their SSH session and
    /// do not require an interactive terminal tab to stay open.
    pub port_forwards: Mutex<HashMap<u64, PortForwardHandle>>,

    pub next_port_forward_id: AtomicU64,

    /// Canonical paths the user explicitly picked through a native file
    /// dialog this session (`pick_local_file`). High-risk commands that
    /// exist only to act on a just-picked path (`read_local_text_file`,
    /// `open_with_app`'s application path) refuse anything not in this
    /// set — so webview-side script injection can't feed them arbitrary
    /// paths like `~/.ssh/id_rsa` or `/bin/sh`.
    pub dialog_grants: Mutex<HashSet<PathBuf>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            app: Mutex::new(None),
            sync: Arc::new(zeroterm_app::SyncManager::new()),
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            pending_host_key: Mutex::new(HashMap::new()),
            sftp_handles: Mutex::new(HashMap::new()),
            sftp_pool: Arc::new(SftpPool::new()),
            transfer_manager: Arc::new(TransferManager::new()),
            transfer_slots: Arc::new(Semaphore::new(3)),
            next_sftp_id: AtomicU64::new(1),
            local_sessions: Mutex::new(HashMap::new()),
            port_forwards: Mutex::new(HashMap::new()),
            next_port_forward_id: AtomicU64::new(1),
            dialog_grants: Mutex::new(HashSet::new()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Per-session control channel. The frontend calls `send_input`,
/// `resize_session`, or `disconnect_session`; those commands enqueue a
/// [`SessionCommand`] which the session task drains.
///
/// We don't keep the spawned task's `JoinHandle` here: the task ends
/// itself on either `SessionCommand::Disconnect` or remote close, and
/// when `AppState` drops the `control_tx` is dropped too — the task's
/// `recv()` returns `None` and it falls through to graceful shutdown.
pub struct SessionHandle {
    pub control_tx: mpsc::Sender<SessionCommand>,
    /// Human-readable list of forwards active for this session
    /// (`["L 8080:127.0.0.1:80", "D 1080"]`). The frontend reads this
    /// when displaying the host header.
    pub forward_summaries: Vec<String>,
    pub jump_summary: Option<String>,
}

#[derive(Debug)]
pub enum SessionCommand {
    Input(Vec<u8>),
    Resize(u16, u16),
    Disconnect,
}

pub struct LocalSessionHandle {
    pub writer_tx: mpsc::Sender<Vec<u8>>,
    pub resize_tx: mpsc::Sender<(u16, u16)>,
    pub shutdown_tx: mpsc::Sender<()>,
}

pub struct SftpHandle {
    pub host_id: String,
    pub channel_id: u64,
}

pub struct PortForwardHandle {
    pub host_id: String,
    pub rule_id: String,
    pub host_name: String,
    /// Human-readable forward summaries (constant for a given rule).
    pub summaries: Vec<String>,
    /// Liveness state shared with the supervisor task: [`PF_ACTIVE`] while the
    /// tunnel is up, [`PF_RECONNECTING`] while it's re-establishing after a
    /// passive disconnect. The supervisor writes it; commands read it for the
    /// UI. The actual SSH sessions and forwards live inside the supervisor
    /// task, not here — so dropping this handle does not by itself tear the
    /// tunnel down; [`cancel`](Self::cancel) does.
    pub state: Arc<AtomicU8>,
    /// User-stop signal. Cancelling makes the supervisor drop its sessions and
    /// forwards (releasing the local listen ports) and exit.
    pub cancel: CancellationToken,
}

/// `PortForwardHandle::state` values.
pub const PF_ACTIVE: u8 = 0;
pub const PF_RECONNECTING: u8 = 1;
