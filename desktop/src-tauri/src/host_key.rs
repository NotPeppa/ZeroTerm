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

use async_trait::async_trait;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tracing::warn;

use zeroterm_ssh::{HostKeyInfo, HostKeyPrompt, MismatchAction};

use crate::state::AppState;

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

        if let Err(e) = self.app_handle.emit("host-key-prompt", payload) {
            warn!(error = %e, "failed to emit host-key-prompt");
            // Clean up the pending entry so it doesn't leak.
            if let Some(state) = self.app_handle.try_state::<AppState>() {
                state.pending_host_key.lock().unwrap().remove(&request_id);
            }
            return HostKeyResponse::Reject;
        }

        // Default to reject if the frontend disappears (window closed,
        // dropped sender, etc.). Better than silently auto-accepting.
        rx.await.unwrap_or(HostKeyResponse::Reject)
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
