//! The per-session async loop. One task per active SSH session; emits
//! data/closed events to the frontend, drains commands from the frontend.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::{self, Duration};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyEvent {
    pub session_id: u64,
    pub rtt_ms: u32,
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

    let mut latency_enabled = false;
    let mut latency_tick = time::interval(Duration::from_secs(3));
    latency_tick.set_missed_tick_behavior(time::MissedTickBehavior::Skip);
    // Some SSH servers refuse a second concurrent session channel (e.g.
    // `MaxSessions 1`). We give up the RTT probe after a few consecutive
    // failures so the log doesn't keep filling with `ConnectFailed`.
    let mut latency_failures: u32 = 0;
    const LATENCY_FAILURE_LIMIT: u32 = 3;

    loop {
        tokio::select! {
            ev = channel.recv() => match ev {
                ChannelEvent::Data(bytes) | ChannelEvent::Stderr(bytes) => {
                    latency_enabled = true;
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
            },
            probe_tick = latency_tick.tick(), if latency_enabled => {
                let _ = probe_tick;
                match session.probe_rtt_ms().await {
                    Ok(rtt_ms) => {
                        latency_failures = 0;
                        let _ = app_handle.emit(
                            "session:latency",
                            LatencyEvent { session_id, rtt_ms },
                        );
                    }
                    Err(e) => {
                        latency_failures += 1;
                        debug!(session_id, error = %e, "latency probe failed");
                        if latency_failures >= LATENCY_FAILURE_LIMIT {
                            warn!(
                                session_id,
                                "disabling latency probe after {} consecutive failures (server likely refuses extra sessions)",
                                latency_failures
                            );
                            latency_enabled = false;
                        }
                    }
                }
            },
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
        state.sessions.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&session_id);
    }
}
