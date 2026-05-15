//! Foreign-implemented callback interfaces.
//!
//! These traits get a `with_foreign` export so Swift / Kotlin can supply
//! their own implementations (a `class` conforming to a protocol on
//! Swift; an `interface` impl on Kotlin). Rust receives them as
//! `Arc<dyn Trait>`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::sync::oneshot;

use crate::types::HostKeyInfo;

/// Streaming hook for an active session. The Rust side calls these as
/// PTY data flows; the foreign side feeds them into its terminal
/// renderer.
#[uniffi::export(with_foreign)]
pub trait SessionListener: Send + Sync {
    /// Raw bytes from the remote PTY. Stdout and stderr are merged here.
    fn on_data(&self, data: Vec<u8>);

    /// Channel closed. `exit_code` is the remote process exit status if
    /// the server reported one before close; `message` carries a Rust-side
    /// error description (e.g. "send failed: ...") if the loop bailed
    /// early.
    fn on_closed(&self, exit_code: Option<u32>, message: Option<String>);
}

/// Foreign-implemented host-key prompt. The contract:
///
/// 1. Rust calls [`HostKeyPromptCallback::on_prompt`] synchronously.
/// 2. Foreign code shows a dialog and **returns immediately** — do NOT
///    block this call on user input.
/// 3. When the user decides, foreign code calls
///    [`crate::ZeroTerm::respond_host_key`] with the same `request_id`
///    and the user's choice. That unblocks the SSH handshake on the
///    Rust side.
/// 4. If `respond_host_key` is never called (window closed, etc.), the
///    handshake is rejected by default — never silently accepted.
///
/// `stored` is `Some(...)` only for mismatch-with-existing-known-key;
/// in that case the foreign UI should show both fingerprints and warn
/// loudly.
#[uniffi::export(with_foreign)]
pub trait HostKeyPromptCallback: Send + Sync {
    fn on_prompt(&self, request_id: String, info: HostKeyInfo, stored: Option<String>);
}

// --------------------------------------------------------------------------
// Adapter: Rust-side `HostKeyPrompt` impl that defers to a foreign
// `HostKeyPromptCallback` via the request-id / oneshot dance.
// --------------------------------------------------------------------------

pub(crate) type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

pub(crate) struct ForeignHostKeyPrompt {
    pub foreign: Arc<dyn HostKeyPromptCallback>,
    pub pending: PendingMap,
}

#[async_trait]
impl zeroterm_ssh::HostKeyPrompt for ForeignHostKeyPrompt {
    async fn on_unknown(&self, info: zeroterm_ssh::HostKeyInfo) -> bool {
        self.ask(info, None).await
    }

    async fn on_mismatch(
        &self,
        info: zeroterm_ssh::HostKeyInfo,
        stored: String,
    ) -> zeroterm_ssh::MismatchAction {
        if self.ask(info, Some(stored)).await {
            zeroterm_ssh::MismatchAction::AcceptOnce
        } else {
            zeroterm_ssh::MismatchAction::Reject
        }
    }
}

impl ForeignHostKeyPrompt {
    async fn ask(&self, info: zeroterm_ssh::HostKeyInfo, stored: Option<String>) -> bool {
        let request_id = uuid::Uuid::now_v7().to_string();
        let (tx, rx) = oneshot::channel::<bool>();

        self.pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);

        let ffi_info: HostKeyInfo = info.into();
        self.foreign
            .on_prompt(request_id.clone(), ffi_info, stored);

        match rx.await {
            Ok(accept) => accept,
            Err(_) => {
                // `respond_host_key` always removes the entry before
                // sending; getting here means the foreign side dropped
                // the response without calling respond. Clean up just
                // in case, and reject by default.
                self.pending.lock().unwrap().remove(&request_id);
                tracing::warn!(
                    request_id,
                    "host-key prompt dropped without a response — rejecting"
                );
                false
            }
        }
    }
}
