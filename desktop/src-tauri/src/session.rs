//! The per-session async loop. One task per active SSH session; emits
//! data/closed events to the frontend, drains commands from the frontend.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tracing::{debug, warn};

use zeroterm_ssh::{ChannelEvent, ForwardHandle, PtySize, Session, ShellChannel};

use crate::state::{AppState, SessionCommand};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataEvent {
    pub session_id: u64,
    /// Raw bytes from the remote PTY. The frontend's terminal renderer
    /// (xterm.js) consumes these directly via `term.write(uint8array)`.
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedEvent {
    pub session_id: u64,
    pub exit_code: Option<u32>,
    pub message: Option<String>,
}

pub async fn run(
    session_id: u64,
    session: Session,
    jump_session: Option<Session>,
    forwards: Vec<ForwardHandle>,
    mut channel: ShellChannel,
    mut control_rx: mpsc::Receiver<SessionCommand>,
    app_handle: AppHandle,
) {
    let mut last_exit: Option<u32> = None;
    let mut error_msg: Option<String> = None;

    loop {
        tokio::select! {
            ev = channel.recv() => match ev {
                ChannelEvent::Data(bytes) | ChannelEvent::Stderr(bytes) => {
                    let _ = app_handle.emit(
                        "session:data",
                        DataEvent { session_id, data: bytes },
                    );
                }
                ChannelEvent::Exit(code) => {
                    last_exit = Some(code);
                    debug!(session_id, code, "remote exited");
                }
                ChannelEvent::Closed => {
                    debug!(session_id, "channel closed");
                    break;
                }
            },
            cmd = control_rx.recv() => match cmd {
                Some(SessionCommand::Input(b)) => {
                    if let Err(e) = channel.send(&b).await {
                        warn!(session_id, error = %e, "send failed");
                        error_msg = Some(format!("send failed: {e}"));
                        break;
                    }
                }
                Some(SessionCommand::Resize(cols, rows)) => {
                    if let Err(e) = channel.resize(PtySize::new(cols, rows)).await {
                        warn!(session_id, error = %e, "resize failed");
                        // resize failure isn't fatal — keep going
                    }
                }
                Some(SessionCommand::Disconnect) | None => {
                    debug!(session_id, "disconnect requested");
                    break;
                }
            }
        }
    }

    drop(forwards);
    let _ = session.disconnect().await;
    if let Some(j) = jump_session {
        let _ = j.disconnect().await;
    }

    let _ = app_handle.emit(
        "session:closed",
        ClosedEvent {
            session_id,
            exit_code: last_exit,
            message: error_msg,
        },
    );

    // Remove ourselves from the registry so the frontend can't accidentally
    // address a dead session.
    if let Some(state) = app_handle.try_state::<AppState>() {
        state.sessions.lock().unwrap().remove(&session_id);
    }
}
