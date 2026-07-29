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

/// Emitted when the RTT probe is permanently disabled for this session
/// (server refuses extra session channels). Lets the frontend disarm its
/// liveness watchdog instead of misreading the silence as a hung link.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyStoppedEvent {
    pub session_id: u64,
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
    // A probe that *times out* is a different beast from one the server
    // rejects: rejection proves the transport is alive, a timeout means the
    // channel layer has stopped responding while SSH keepalives may still be
    // answered (half-alive server). Without this the probe await hangs
    // forever inside the select arm, freezing the whole session loop while
    // the UI keeps saying "connected". Two consecutive timeouts → declare
    // the link dead and tear down, so the frontend gets a real
    // `session:closed` instead of a zombie.
    let mut probe_timeouts: u32 = 0;
    const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
    const PROBE_TIMEOUT_LIMIT: u32 = 2;
    // Input writes block on the SSH flow-control window; if the remote stops
    // widening it, an un-timed send would freeze the loop the same way.
    // Generous enough for a large paste over a slow link.
    const SEND_TIMEOUT: Duration = Duration::from_secs(30);

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
                    match time::timeout(SEND_TIMEOUT, channel.send(&b)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => {
                            warn!(session_id, error = %e, "send failed");
                            error_msg = Some(format!("send failed: {e}"));
                            break;
                        }
                        Err(_) => {
                            warn!(session_id, "send timed out; connection unresponsive");
                            error_msg = Some("connection unresponsive: send timed out".into());
                            break;
                        }
                    }
                }
                Some(SessionCommand::Resize(cols, rows)) => {
                    match time::timeout(SEND_TIMEOUT, channel.resize(PtySize::new(cols, rows))).await {
                        Ok(Ok(())) => {}
                        // resize failure isn't fatal — keep going
                        Ok(Err(e)) => warn!(session_id, error = %e, "resize failed"),
                        Err(_) => warn!(session_id, "resize timed out"),
                    }
                }
                Some(SessionCommand::Disconnect) | None => {
                    debug!(session_id, "disconnect requested");
                    break;
                }
            },
            probe_tick = latency_tick.tick(), if latency_enabled => {
                let _ = probe_tick;
                match time::timeout(PROBE_TIMEOUT, session.probe_rtt_ms()).await {
                    Ok(Ok(rtt_ms)) => {
                        latency_failures = 0;
                        probe_timeouts = 0;
                        let _ = app_handle.emit(
                            "session:latency",
                            LatencyEvent { session_id, rtt_ms },
                        );
                    }
                    Ok(Err(e)) => {
                        // The server answered, just not with a channel —
                        // transport is alive, so this only counts against
                        // the probe itself.
                        probe_timeouts = 0;
                        latency_failures += 1;
                        debug!(session_id, error = %e, "latency probe failed");
                        if latency_failures >= LATENCY_FAILURE_LIMIT {
                            warn!(
                                session_id,
                                "disabling latency probe after {} consecutive failures (server likely refuses extra sessions)",
                                latency_failures
                            );
                            latency_enabled = false;
                            let _ = app_handle.emit(
                                "session:latency-stopped",
                                LatencyStoppedEvent { session_id },
                            );
                        }
                    }
                    Err(_) => {
                        probe_timeouts += 1;
                        warn!(
                            session_id,
                            probe_timeouts,
                            "latency probe timed out after {PROBE_TIMEOUT:?}"
                        );
                        if probe_timeouts >= PROBE_TIMEOUT_LIMIT {
                            error_msg = Some(
                                "connection unresponsive: server stopped answering channel requests".into(),
                            );
                            break;
                        }
                    }
                }
            },
        }
    }

    drop(forwards);
    // Best-effort goodbye. On the very links that got us here (dead or
    // half-dead transport) the DISCONNECT packet may never flush — don't let
    // it delay the `session:closed` event the frontend is waiting on.
    let _ = time::timeout(Duration::from_secs(5), session.disconnect()).await;
    if let Some(j) = jump_session {
        let _ = time::timeout(Duration::from_secs(5), j.disconnect()).await;
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
