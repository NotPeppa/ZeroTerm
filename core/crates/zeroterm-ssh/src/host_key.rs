//! Host-key trust policy.
//!
//! Connection time, the SSH layer is handed a `HostKeyPolicy` that decides
//! what to do with the server's public key. The CLI/UI plugs in its own
//! interactive prompt via [`HostKeyPrompt`].

use std::sync::Arc;

use async_trait::async_trait;
use russh::keys::PublicKeyBase64;
use russh::keys::{Certificate, PublicKey};

use crate::known_hosts::{KnownHostCertificateStatus, KnownHostStatus, KnownHosts};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MismatchAction {
    Reject,
    AcceptOnce,
    AcceptAndReplace,
}

/// Information surfaced to the UI when an unknown / mismatched key shows up.
#[derive(Debug, Clone)]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// SHA256 fingerprint in OpenSSH style: `SHA256:<base64-no-pad>`.
    pub fingerprint: String,
}

impl HostKeyInfo {
    pub(crate) fn from_key(host: &str, port: u16, key: &PublicKey) -> Self {
        Self {
            host: host.to_string(),
            port,
            key_type: key.algorithm().as_str().to_string(),
            // OpenSSH-style SHA256 fingerprint: `SHA256:<base64-no-pad>`.
            fingerprint: key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
        }
    }
}

/// Async hook for prompting the user about a host key. The CLI implements
/// this against stderr/stdin; a GUI would surface a dialog.
#[async_trait]
pub trait HostKeyPrompt: Send + Sync {
    /// New host, no record. Return `true` to accept and add to known_hosts.
    async fn on_unknown(&self, info: HostKeyInfo) -> bool;

    /// Host already trusted with a *different* key.
    async fn on_mismatch(&self, info: HostKeyInfo, stored: String) -> MismatchAction;
}

/// Trust strategy applied during the SSH handshake.
#[derive(Clone)]
pub enum HostKeyPolicy {
    /// Accept every key. **Demo / lab only.**
    AcceptAll,

    /// Strict OpenSSH-style: known + matching = accept; anything else = reject.
    /// No prompts, no writes.
    Strict(KnownHosts),

    /// Accept matched keys silently. Unknown / mismatched keys go through
    /// the supplied prompt; on user acceptance for an *unknown* host the
    /// key is appended to the store.
    Interactive {
        store: KnownHosts,
        prompt: Arc<dyn HostKeyPrompt>,
    },
}

impl std::fmt::Debug for HostKeyPolicy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AcceptAll => f.write_str("HostKeyPolicy::AcceptAll"),
            Self::Strict(kh) => f.debug_tuple("HostKeyPolicy::Strict").field(kh).finish(),
            Self::Interactive { store, .. } => f
                .debug_struct("HostKeyPolicy::Interactive")
                .field("store", store)
                .finish_non_exhaustive(),
        }
    }
}

impl HostKeyPolicy {
    /// Run the policy against an offered key. Returns `true` if the
    /// caller should accept the key (i.e. continue the handshake).
    pub(crate) async fn evaluate(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> std::io::Result<bool> {
        match self {
            HostKeyPolicy::AcceptAll => Ok(true),

            HostKeyPolicy::Strict(store) => match store.check(host, port, key)? {
                KnownHostStatus::Trusted => Ok(true),
                KnownHostStatus::Unknown
                | KnownHostStatus::Mismatch { .. }
                | KnownHostStatus::Revoked => Ok(false),
            },

            HostKeyPolicy::Interactive { store, prompt } => {
                match store.check(host, port, key)? {
                    KnownHostStatus::Trusted => Ok(true),
                    // An explicitly revoked key is never up for
                    // negotiation — no prompt, hard reject.
                    KnownHostStatus::Revoked => {
                        tracing::warn!(host, port, "offered host key is marked @revoked");
                        Ok(false)
                    }
                    KnownHostStatus::Unknown => {
                        let info = HostKeyInfo::from_key(host, port, key);
                        let accept = prompt.on_unknown(info).await;
                        if accept {
                            // Best-effort write; if it fails we still let the
                            // session proceed for this run, but warn.
                            if let Err(e) = store.add(host, port, key) {
                                tracing::warn!(
                                    error = %e,
                                    "failed to persist new known_hosts entry"
                                );
                            }
                        }
                        Ok(accept)
                    }
                    KnownHostStatus::Mismatch { stored } => {
                        let info = HostKeyInfo::from_key(host, port, key);
                        match prompt.on_mismatch(info, stored).await {
                            MismatchAction::Reject => Ok(false),
                            MismatchAction::AcceptOnce => Ok(true),
                            MismatchAction::AcceptAndReplace => {
                                store.replace(host, port, key).map_err(|e| {
                                    std::io::Error::new(
                                        e.kind(),
                                        format!(
                                            "failed to update known_hosts at {}: {e}",
                                            store.path().display()
                                        ),
                                    )
                                })?;
                                tracing::info!(
                                    host,
                                    port,
                                    path = %store.path().display(),
                                    "updated mismatched known_hosts entry"
                                );
                                Ok(true)
                            }
                        }
                    }
                }
            }
        }
    }

    /// Run the policy against an OpenSSH host certificate.
    ///
    /// Interactive mode deliberately does not offer TOFU for certificates:
    /// trusting a leaf certificate would become stale at renewal time and
    /// bypass the CA model. Add the CA to known_hosts explicitly instead.
    pub(crate) fn evaluate_certificate(
        &self,
        host: &str,
        port: u16,
        certificate: &Certificate,
    ) -> std::io::Result<bool> {
        match self {
            HostKeyPolicy::AcceptAll => Ok(true),
            HostKeyPolicy::Strict(store) | HostKeyPolicy::Interactive { store, .. } => {
                match store.check_certificate(host, port, certificate)? {
                    KnownHostCertificateStatus::Trusted => Ok(true),
                    KnownHostCertificateStatus::Unknown => {
                        tracing::warn!(host, port, "no matching @cert-authority entry");
                        Ok(false)
                    }
                    KnownHostCertificateStatus::Revoked => {
                        tracing::warn!(host, port, "host certificate key or CA is @revoked");
                        Ok(false)
                    }
                    KnownHostCertificateStatus::Invalid { reason } => {
                        tracing::warn!(host, port, %reason, "invalid host certificate");
                        Ok(false)
                    }
                }
            }
        }
    }
}

/// Helper, exposed because `russh::keys::PublicKey` doesn't directly
/// give a base64-string round-trip without the trait imported.
#[allow(dead_code)]
pub(crate) fn public_key_base64(k: &PublicKey) -> String {
    k.public_key_base64()
}
