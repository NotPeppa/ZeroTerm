//! Async host-key prompt that surfaces the question through Tauri events.
//!
//! Flow:
//!   1. SSH layer asks our `HostKeyPrompt` impl during the handshake.
//!   2. We register a `oneshot` sender in `AppState::pending_host_key`
//!      keyed by a fresh request id, then emit `host-key-prompt`.
//!   3. The frontend shows a dialog and calls `respond_host_key` with
//!      the request id and the user's choice.
//!   4. That command pulls our sender out of the map and resolves the
//!      future, unblocking the SSH handshake.

use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tracing::warn;

use zeroterm_ssh::{HostKeyInfo, HostKeyPrompt, MismatchAction};

use crate::state::AppState;

/// How long to wait for the human to answer a host-key prompt before giving
/// up and rejecting. The connect timeout (15s) does not cover this segment,
/// so without a bound an abandoned prompt (window closed, event missed) would
/// leave the handshake hung indefinitely. See TAURI-4.
const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Removes its `pending_host_key` entry on drop, so the entry never leaks no
/// matter which path (timeout, emit failure, normal response, dropped sender)
/// unwinds [`TauriHostKeyPrompt::ask`].
struct PendingHostKeyGuard {
    app_handle: AppHandle,
    request_id: String,
}

impl Drop for PendingHostKeyGuard {
    fn drop(&mut self) {
        if let Some(state) = self.app_handle.try_state::<AppState>() {
            state
                .pending_host_key
                .lock()
                .unwrap()
                .remove(&self.request_id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPromptPayload {
    pub request_id: String,
    pub kind: HostKeyKind,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    /// Only set for mismatch — short summary of the previously-trusted key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyKind {
    Unknown,
    Mismatch,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyResponse {
    Reject,
    AcceptOnce,
    AcceptAndReplace,
}

pub struct TauriHostKeyPrompt {
    pub app_handle: AppHandle,
}

impl TauriHostKeyPrompt {
    async fn ask(&self, payload: HostKeyPromptPayload) -> HostKeyResponse {
        let request_id = payload.request_id.clone();

        let (tx, rx) = oneshot::channel();
        {
            let state = match self.app_handle.try_state::<AppState>() {
                Some(s) => s,
                None => {
                    warn!("AppState missing — cannot prompt for host key");
                    return HostKeyResponse::Reject;
                }
            };
            state
                .pending_host_key
                .lock()
                .unwrap()
                .insert(request_id.clone(), tx);
        }
        // From here on the guard removes the pending entry on every exit
        // path (timeout, emit failure, response, dropped sender).
        let _guard = PendingHostKeyGuard {
            app_handle: self.app_handle.clone(),
            request_id: request_id.clone(),
        };

        if let Err(e) = self.app_handle.emit("host-key-prompt", payload) {
            warn!(error = %e, "failed to emit host-key-prompt");
            return HostKeyResponse::Reject;
        }

        // Bound the human-response wait: an abandoned prompt must not hang the
        // handshake forever. Default to reject on timeout or if the frontend
        // disappears (window closed, dropped sender) — never auto-accept.
        match tokio::time::timeout(HOST_KEY_PROMPT_TIMEOUT, rx).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => HostKeyResponse::Reject,
            Err(_) => {
                warn!(
                    request_id = %request_id,
                    "host-key prompt timed out with no response; rejecting"
                );
                HostKeyResponse::Reject
            }
        }
    }
}

#[async_trait]
impl HostKeyPrompt for TauriHostKeyPrompt {
    async fn on_unknown(&self, info: HostKeyInfo) -> bool {
        let payload = HostKeyPromptPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            kind: HostKeyKind::Unknown,
            host: info.host,
            port: info.port,
            key_type: info.key_type,
            fingerprint: info.fingerprint,
            stored: None,
        };
        !matches!(self.ask(payload).await, HostKeyResponse::Reject)
    }

    async fn on_mismatch(&self, info: HostKeyInfo, stored: String) -> MismatchAction {
        let payload = HostKeyPromptPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            kind: HostKeyKind::Mismatch,
            host: info.host,
            port: info.port,
            key_type: info.key_type,
            fingerprint: info.fingerprint,
            stored: Some(stored),
        };
        match self.ask(payload).await {
            HostKeyResponse::Reject => MismatchAction::Reject,
            HostKeyResponse::AcceptOnce => MismatchAction::AcceptOnce,
            HostKeyResponse::AcceptAndReplace => MismatchAction::AcceptAndReplace,
        }
    }
}
