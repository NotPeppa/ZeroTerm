use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::sftp::{classify_error_message, ipc_error, parse_ipc_error};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferErrorDto {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferEvent {
    pub transfer_id: u64,
    pub kind: &'static str,
    pub status: &'static str,
    pub source: String,
    pub destination: String,
    pub bytes_done: u64,
    pub total: Option<u64>,
    pub bytes_per_sec: Option<u64>,
    pub eta_seconds: Option<u64>,
    pub current_file: Option<String>,
    pub files_done: Option<u64>,
    pub files_total: Option<u64>,
    pub error: Option<TransferErrorDto>,
}

pub(crate) struct TransferManager {
    next_id: AtomicU64,
    transfers: Mutex<HashMap<u64, TransferRecord>>,
}

impl TransferManager {
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            transfers: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn clear(&self) {
        self.transfers.lock().unwrap().clear();
    }

    pub(crate) fn register(
        &self,
        app_handle: &AppHandle,
        kind: &'static str,
        source: String,
        destination: String,
        total: Option<u64>,
    ) -> (u64, CancellationToken) {
        let transfer_id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let token = CancellationToken::new();
        let event = TransferEvent {
            transfer_id,
            kind,
            status: "queued",
            source,
            destination,
            bytes_done: 0,
            total,
            bytes_per_sec: None,
            eta_seconds: None,
            current_file: None,
            files_done: None,
            files_total: None,
            error: None,
        };
        self.transfers.lock().unwrap().insert(
            transfer_id,
            TransferRecord {
                token: token.clone(),
                event: event.clone(),
            },
        );
        let _ = app_handle.emit("sftp:transfer", event);
        (transfer_id, token)
    }

    pub(crate) fn mark_running(&self, app_handle: &AppHandle, transfer_id: u64) {
        let event = {
            let mut transfers = self.transfers.lock().unwrap();
            let Some(record) = transfers.get_mut(&transfer_id) else {
                return;
            };
            record.event.status = "running";
            record.event.clone()
        };
        let _ = app_handle.emit("sftp:transfer", event);
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn progress(
        &self,
        app_handle: &AppHandle,
        transfer_id: u64,
        bytes_done: u64,
        total: Option<u64>,
        bytes_per_sec: Option<u64>,
        eta_seconds: Option<u64>,
        current_file: Option<String>,
        files_done: Option<u64>,
        files_total: Option<u64>,
    ) {
        let event = {
            let mut transfers = self.transfers.lock().unwrap();
            let Some(record) = transfers.get_mut(&transfer_id) else {
                return;
            };
            // A full byte count means the client has queued the last SFTP
            // write, not that the remote file is committed. Uploads still
            // need to drain acknowledgements, close the temporary file, and
            // rename it into place atomically.
            let finalizing = matches!(total, Some(total) if bytes_done >= total);
            record.event.status = if finalizing { "finalizing" } else { "running" };
            record.event.bytes_done = bytes_done;
            record.event.total = total;
            record.event.bytes_per_sec = if finalizing { None } else { bytes_per_sec };
            record.event.eta_seconds = if finalizing { None } else { eta_seconds };
            record.event.current_file = current_file;
            record.event.files_done = files_done;
            record.event.files_total = files_total;
            record.event.error = None;
            record.event.clone()
        };
        let _ = app_handle.emit("sftp:transfer", event);
    }

    pub(crate) fn finish_success(
        &self,
        app_handle: &AppHandle,
        transfer_id: u64,
        bytes_done: u64,
        total: Option<u64>,
    ) {
        self.finish(app_handle, transfer_id, "success", bytes_done, total, None);
    }

    pub(crate) fn finish_error(
        &self,
        app_handle: &AppHandle,
        transfer_id: u64,
        bytes_done: u64,
        total: Option<u64>,
        message: String,
    ) {
        let error = transfer_error_from_message(message);
        self.finish(
            app_handle,
            transfer_id,
            "error",
            bytes_done,
            total,
            Some(error),
        );
    }

    pub(crate) fn cancel(&self, app_handle: &AppHandle, transfer_id: u64) {
        let event = {
            let mut transfers = self.transfers.lock().unwrap();
            let Some(record) = transfers.get_mut(&transfer_id) else {
                return;
            };
            record.token.cancel();
            record.event.status = "cancelled";
            record.event.bytes_per_sec = None;
            record.event.eta_seconds = None;
            record.event.error = Some(TransferErrorDto {
                code: "CANCELLED".to_string(),
                message: "transfer cancelled".to_string(),
            });
            record.event.clone()
        };
        let _ = app_handle.emit("sftp:transfer", event);
    }

    pub(crate) fn token(&self, transfer_id: u64) -> Option<CancellationToken> {
        self.transfers
            .lock()
            .unwrap()
            .get(&transfer_id)
            .map(|record| record.token.clone())
    }

    pub(crate) fn remove(&self, transfer_id: u64) {
        self.transfers.lock().unwrap().remove(&transfer_id);
    }

    fn finish(
        &self,
        app_handle: &AppHandle,
        transfer_id: u64,
        status: &'static str,
        bytes_done: u64,
        total: Option<u64>,
        error: Option<TransferErrorDto>,
    ) {
        let event = {
            let mut transfers = self.transfers.lock().unwrap();
            let Some(record) = transfers.get_mut(&transfer_id) else {
                return;
            };
            record.event.status = status;
            record.event.bytes_done = bytes_done;
            record.event.total = total;
            record.event.bytes_per_sec = None;
            record.event.eta_seconds = None;
            record.event.current_file = None;
            record.event.error = error;
            record.event.clone()
        };
        let _ = app_handle.emit("sftp:transfer", event);
    }
}

fn transfer_error_from_message(message: String) -> TransferErrorDto {
    if let Some(parsed) = parse_ipc_error(&message) {
        TransferErrorDto {
            code: parsed.code,
            message: parsed.message,
        }
    } else {
        TransferErrorDto {
            code: classify_error_message(&message).to_string(),
            message,
        }
    }
}

fn is_watchdog_timeout_message(message: &str) -> bool {
    message.to_ascii_lowercase().contains("transfer stalled")
}

struct TransferRecord {
    token: CancellationToken,
    event: TransferEvent,
}

pub(crate) fn register_transfer(
    state: &AppState,
    app_handle: &AppHandle,
    kind: &'static str,
    source: String,
    destination: String,
    total: Option<u64>,
) -> (u64, CancellationToken) {
    state
        .transfer_manager
        .register(app_handle, kind, source, destination, total)
}

pub(crate) fn forget_transfer(state: &AppState, id: u64) {
    state.transfer_manager.remove(id);
}

pub(crate) async fn acquire_transfer_slot(
    state: &AppState,
    app_handle: &AppHandle,
    transfer_id: u64,
) -> Result<tokio::sync::OwnedSemaphorePermit, String> {
    let Some(cancel) = state.transfer_manager.token(transfer_id) else {
        return Err(ipc_error("CANCELLED", "transfer no longer exists"));
    };
    let acquire = state.transfer_slots.clone().acquire_owned();
    tokio::pin!(acquire);
    let permit = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            state.transfer_manager.remove(transfer_id);
            return Err(ipc_error("CANCELLED", "transfer cancelled while queued"));
        }
        result = &mut acquire => result.map_err(|_| {
            state.transfer_manager.remove(transfer_id);
            ipc_error("CHANNEL_CLOSED", "transfer queue is shutting down")
        })?,
    };
    state.transfer_manager.mark_running(app_handle, transfer_id);
    Ok(permit)
}

pub(crate) enum ProgressMode<'a> {
    None,
    Standalone {
        app: &'a AppHandle,
        state: &'a AppState,
    },
    Aggregate(Arc<TransferSink>),
}

pub(crate) struct TransferSink {
    transfer_id: u64,
    total: std::sync::atomic::AtomicU64,
    bytes_done: std::sync::atomic::AtomicU64,
    files_total: std::sync::atomic::AtomicU64,
    files_done: std::sync::atomic::AtomicU64,
    pub(crate) app_handle: AppHandle,
    pub(crate) cancel: CancellationToken,
    state: Mutex<SinkState>,
}

struct SinkState {
    last_emit_at: Instant,
    last_emit_bytes: u64,
    last_activity_at: Instant,
    has_baseline: bool,
    current_file: String,
}

impl TransferSink {
    pub(crate) fn register(
        app_handle: AppHandle,
        state: &AppState,
        kind: &'static str,
        source: String,
        destination: String,
        total: u64,
    ) -> Arc<Self> {
        let (transfer_id, cancel) = register_transfer(
            state,
            &app_handle,
            kind,
            source,
            destination,
            if total > 0 { Some(total) } else { None },
        );
        Arc::new(Self {
            transfer_id,
            total: std::sync::atomic::AtomicU64::new(total),
            bytes_done: std::sync::atomic::AtomicU64::new(0),
            files_total: std::sync::atomic::AtomicU64::new(0),
            files_done: std::sync::atomic::AtomicU64::new(0),
            app_handle,
            cancel,
            state: Mutex::new(SinkState {
                last_emit_at: Instant::now(),
                last_emit_bytes: 0,
                last_activity_at: Instant::now(),
                has_baseline: false,
                current_file: String::new(),
            }),
        })
    }

    pub(crate) fn add_total_bytes(&self, delta: u64) {
        if delta > 0 {
            self.total.fetch_add(delta, Ordering::SeqCst);
        }
    }

    pub(crate) fn add_files_total(&self, delta: u64) {
        if delta > 0 {
            self.files_total.fetch_add(delta, Ordering::SeqCst);
        }
    }

    /// Count one file as fully transferred. Emission piggybacks on the next
    /// throttled progress tick, except when this completion is what finishes
    /// the whole batch (zero-byte tails would otherwise never update the UI).
    pub(crate) fn note_file_done(&self) {
        let done = self.files_done.fetch_add(1, Ordering::SeqCst) + 1;
        let total = self.files_total.load(Ordering::SeqCst);
        if total > 0 && done >= total {
            let current_file = self.state.lock().unwrap().current_file.clone();
            self.emit_progress_snapshot(&current_file, None, None);
        }
    }

    fn file_counts(&self) -> (Option<u64>, Option<u64>) {
        let total = self.files_total.load(Ordering::SeqCst);
        if total == 0 {
            return (None, None);
        }
        (Some(self.files_done.load(Ordering::SeqCst)), Some(total))
    }

    fn emit_progress_snapshot(
        &self,
        current_file: &str,
        bytes_per_sec: Option<u64>,
        eta_seconds: Option<u64>,
    ) {
        let bytes_done = self.bytes_done.load(Ordering::SeqCst);
        let total = self.total.load(Ordering::Relaxed);
        let (files_done, files_total) = self.file_counts();
        let current_file = if current_file.is_empty() {
            None
        } else {
            Some(current_file.to_string())
        };
        self.app_handle
            .state::<AppState>()
            .transfer_manager
            .progress(
                &self.app_handle,
                self.transfer_id,
                bytes_done,
                if total > 0 { Some(total) } else { None },
                bytes_per_sec,
                eta_seconds,
                current_file,
                files_done,
                files_total,
            );
    }

    pub(crate) fn rewind_bytes(&self, delta: u64) {
        if delta == 0 {
            return;
        }
        let bytes_done = self
            .bytes_done
            .fetch_sub(delta, Ordering::SeqCst)
            .saturating_sub(delta);
        let mut s = self.state.lock().unwrap();
        s.last_emit_bytes = s.last_emit_bytes.min(bytes_done);
        s.last_activity_at = Instant::now();
    }

    pub(crate) fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub(crate) fn transfer_id(&self) -> u64 {
        self.transfer_id
    }

    pub(crate) fn note_path(&self, current_file: &str) {
        let now = Instant::now();
        let bytes_done = self.bytes_done.load(Ordering::SeqCst);

        let mut s = self.state.lock().unwrap();
        s.last_activity_at = now;
        s.current_file = current_file.to_string();
        if s.has_baseline && now.duration_since(s.last_emit_at) < Duration::from_millis(250) {
            return;
        }

        s.last_emit_at = now;
        s.last_emit_bytes = bytes_done;
        s.has_baseline = true;
        let current_file = s.current_file.clone();
        drop(s);

        self.emit_progress_snapshot(&current_file, None, None);
    }

    pub(crate) fn add_bytes(&self, delta: u64, current_file: &str) {
        if delta == 0 {
            return;
        }
        let now = Instant::now();
        let bytes_done = self.bytes_done.fetch_add(delta, Ordering::SeqCst) + delta;
        let total = self.total.load(Ordering::Relaxed);

        let mut s = self.state.lock().unwrap();
        s.last_activity_at = now;
        s.current_file = current_file.to_string();
        let is_done = total > 0 && bytes_done >= total;
        if s.has_baseline
            && now.duration_since(s.last_emit_at) < Duration::from_millis(100)
            && !is_done
        {
            return;
        }

        let bytes_per_sec = if s.has_baseline {
            let dt = now.duration_since(s.last_emit_at).as_secs_f64();
            if dt > 0.001 {
                let db = bytes_done.saturating_sub(s.last_emit_bytes) as f64;
                Some((db / dt) as u64)
            } else {
                None
            }
        } else {
            None
        };

        let eta_seconds = match (bytes_per_sec, total) {
            (Some(bps), total) if bps > 0 && total > 0 && bytes_done < total => {
                Some((total - bytes_done) / bps)
            }
            _ => None,
        };

        s.last_emit_at = now;
        s.last_emit_bytes = bytes_done;
        s.has_baseline = true;
        let current_file = s.current_file.clone();
        drop(s);

        self.emit_progress_snapshot(&current_file, bytes_per_sec, eta_seconds);
    }

    pub(crate) fn emit_initial(&self) {
        self.emit_progress_snapshot("", None, None);
    }

    pub(crate) fn emit_finished(&self, result: Result<(), String>) {
        let bytes_done = self.bytes_done.load(Ordering::SeqCst);
        let total = self.total.load(Ordering::Relaxed);
        let manager = &self.app_handle.state::<AppState>().transfer_manager;
        match result {
            Ok(()) => manager.finish_success(
                &self.app_handle,
                self.transfer_id,
                bytes_done,
                if total > 0 { Some(total) } else { None },
            ),
            Err(message) => {
                if self.cancel.is_cancelled() && !is_watchdog_timeout_message(&message) {
                    manager.cancel(&self.app_handle, self.transfer_id);
                } else {
                    manager.finish_error(
                        &self.app_handle,
                        self.transfer_id,
                        bytes_done,
                        if total > 0 { Some(total) } else { None },
                        message,
                    );
                }
            }
        }
    }
}

async fn run_tree_with_sink<F, Fut>(sink: Arc<TransferSink>, body: F) -> Result<(), String>
where
    F: FnOnce(Arc<TransferSink>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

    let body_fut = body(sink.clone());
    tokio::pin!(body_fut);

    let outcome = loop {
        let deadline = {
            let s = sink.state.lock().unwrap();
            s.last_activity_at + IDLE_TIMEOUT
        };
        tokio::select! {
            biased;
            r = &mut body_fut => {
                break r;
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                let idle = {
                    let s = sink.state.lock().unwrap();
                    Instant::now().duration_since(s.last_activity_at)
                };
                if idle >= IDLE_TIMEOUT {
                    sink.cancel.cancel();
                    warn!(
                        transfer_id = sink.transfer_id,
                        idle_secs = idle.as_secs(),
                        bytes_done = sink.bytes_done.load(Ordering::SeqCst),
                        "SFTP tree transfer stalled, aborting"
                    );
                    break Err(format!(
                        "transfer stalled: no progress for {} seconds",
                        idle.as_secs()
                    ));
                }
            }
        }
    };

    match outcome {
        Ok(()) => {
            sink.emit_finished(Ok(()));
            Ok(())
        }
        Err(err) => {
            sink.emit_finished(Err(err.clone()));
            Err(err)
        }
    }
}

pub(crate) async fn run_tree_transfer<F, Fut>(
    progress_ctx: Option<(&AppHandle, &AppState)>,
    kind: &'static str,
    source_label: String,
    destination_label: String,
    body: F,
) -> Result<(), String>
where
    F: FnOnce(Option<Arc<TransferSink>>) -> Fut + Send,
    Fut: std::future::Future<Output = Result<(), String>> + Send,
{
    match progress_ctx {
        Some((app, state)) => {
            let sink = TransferSink::register(
                app.clone(),
                state,
                kind,
                source_label,
                destination_label,
                0,
            );
            let transfer_id = sink.transfer_id();
            let _permit = acquire_transfer_slot(state, app, transfer_id).await?;
            sink.emit_initial();
            let result = run_tree_with_sink(sink, move |sink_arc| body(Some(sink_arc))).await;
            forget_transfer(state, transfer_id);
            result
        }
        None => body(None).await,
    }
}

pub(crate) async fn run_with_progress<F, Fut, E>(
    app_handle: &AppHandle,
    state: &AppState,
    transfer_id: u64,
    body: F,
) -> Result<u64, String>
where
    F: FnOnce(Box<dyn FnMut(zeroterm_ssh::ProgressTick) + Send>) -> Fut,
    Fut: std::future::Future<Output = Result<u64, E>>,
    E: std::fmt::Display,
{
    const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

    struct ProgressState {
        last_emit_at: Instant,
        last_emit_bytes: u64,
        last_total: Option<u64>,
        last_activity_at: Instant,
        has_baseline: bool,
    }

    let transfer_manager = state.transfer_manager.clone();
    let transfer_manager_for_cb = transfer_manager.clone();
    let progress_state = Arc::new(Mutex::new(ProgressState {
        last_emit_at: Instant::now(),
        last_emit_bytes: 0,
        last_total: None,
        last_activity_at: Instant::now(),
        has_baseline: false,
    }));
    let watchdog_state = progress_state.clone();
    let app_handle_for_cb = app_handle.clone();

    let cb: Box<dyn FnMut(zeroterm_ssh::ProgressTick) + Send> = Box::new(move |tick| {
        let now = Instant::now();
        let mut s = progress_state.lock().unwrap();
        let is_done = matches!(tick.total, Some(t) if tick.bytes_done >= t);
        s.last_activity_at = now;
        if tick.total.is_some() {
            s.last_total = tick.total;
        }

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

        transfer_manager_for_cb.progress(
            &app_handle_for_cb,
            transfer_id,
            tick.bytes_done,
            tick.total,
            bytes_per_sec,
            eta_seconds,
            None,
            None,
            None,
        );
    });

    let body_fut = body(cb);
    tokio::pin!(body_fut);

    let outcome: Result<u64, String> = loop {
        let deadline = {
            let s = watchdog_state.lock().unwrap();
            s.last_activity_at + IDLE_TIMEOUT
        };
        tokio::select! {
            biased;
            r = &mut body_fut => {
                break match r {
                    Ok(n) => Ok(n),
                    Err(e) => Err(e.to_string()),
                };
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                let idle = {
                    let s = watchdog_state.lock().unwrap();
                    Instant::now().duration_since(s.last_activity_at)
                };
                if idle >= IDLE_TIMEOUT {
                    let last_bytes = watchdog_state.lock().unwrap().last_emit_bytes;
                    if let Some(token) = transfer_manager.token(transfer_id) {
                        token.cancel();
                    }
                    warn!(
                        transfer_id,
                        idle_secs = idle.as_secs(),
                        bytes_done = last_bytes,
                        "SFTP transfer stalled, aborting"
                    );
                    break Err(format!(
                        "transfer stalled: no progress for {} seconds",
                        idle.as_secs()
                    ));
                }
            }
        }
    };

    let final_bytes = match &outcome {
        Ok(n) => *n,
        Err(_) => watchdog_state.lock().unwrap().last_emit_bytes,
    };
    let final_total = watchdog_state.lock().unwrap().last_total;
    match &outcome {
        Ok(_) => transfer_manager.finish_success(app_handle, transfer_id, final_bytes, final_total),
        Err(message) => {
            if transfer_manager
                .token(transfer_id)
                .is_some_and(|token| token.is_cancelled())
                && !is_watchdog_timeout_message(message)
            {
                transfer_manager.cancel(app_handle, transfer_id);
            } else {
                transfer_manager.finish_error(
                    app_handle,
                    transfer_id,
                    final_bytes,
                    final_total,
                    message.clone(),
                );
            }
        }
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sftp::ipc_error;

    #[test]
    fn transfer_error_preserves_structured_ipc_code() {
        let error = transfer_error_from_message(ipc_error(
            "CHANNEL_CLOSED",
            "channel closed while reading /var/log/app.log",
        ));
        assert_eq!(error.code, "CHANNEL_CLOSED");
        assert_eq!(
            error.message,
            "channel closed while reading /var/log/app.log"
        );
    }

    #[test]
    fn transfer_error_classifies_plaintext_fallback() {
        let error = transfer_error_from_message("destination already exists: /tmp/a".to_string());
        assert_eq!(error.code, "ALREADY_EXISTS");
        assert_eq!(error.message, "destination already exists: /tmp/a");
    }

    #[test]
    fn transfer_stall_is_timeout_error_not_user_cancel() {
        let message = "transfer stalled: no progress for 180 seconds";
        let error = transfer_error_from_message(message.to_string());
        assert_eq!(error.code, "TIMEOUT");
        assert!(is_watchdog_timeout_message(message));
    }
}
