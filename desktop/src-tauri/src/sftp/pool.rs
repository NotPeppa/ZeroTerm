use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use zeroterm_ssh::{ConnectConfig, Session, Sftp};

use crate::sftp::{ipc_error, parse_ipc_error, ssh_error, string_error};

/// Per-host cap on concurrently open SFTP channels. A directory transfer
/// takes up to five (panel + primary + 3 workers); keeping one spare below
/// OpenSSH's default `MaxSessions 10` lets ad-hoc single-file operations
/// proceed while a tree copy runs. Servers with a lower limit simply fail
/// the extra opens, which the worker pools already tolerate.
pub(crate) const MAX_SFTP_CHANNELS_PER_HOST: usize = 6;

/// Structured code for "this host's channel quota is exhausted". Callers can
/// fall back to sharing an existing channel instead of failing the operation.
pub(crate) const CHANNEL_LIMIT_CODE: &str = "CHANNEL_LIMIT";

pub(crate) fn is_channel_limit_error(err: &str) -> bool {
    parse_ipc_error(err).is_some_and(|parsed| parsed.code == CHANNEL_LIMIT_CODE)
}

/// Wall-clock cap on opening the SFTP subsystem over a pooled session.
/// A half-open TCP connection otherwise hangs until the SSH keepalive
/// gives up (~90s); failing faster lets the open path fall back to a
/// fresh connection via the retry in `open_sftp_for_host`.
const SFTP_OPEN_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct SftpPool {
    hosts: Mutex<HashMap<String, Arc<HostPool>>>,
    next_channel_id: AtomicU64,
}

impl SftpPool {
    pub(crate) fn new() -> Self {
        Self {
            hosts: Mutex::new(HashMap::new()),
            next_channel_id: AtomicU64::new(1),
        }
    }

    pub(crate) fn clear(&self) {
        self.hosts.lock().unwrap().clear();
    }

    pub(crate) async fn open_panel_channel(
        &self,
        host_id: String,
        cfg: ConnectConfig,
        jump_cfg: Option<ConnectConfig>,
    ) -> Result<PanelChannel, String> {
        let host = self.upsert_host(host_id, cfg, jump_cfg);
        let reservation = self.reserve_panel_channel(&host)?;
        self.finish_channel_open(host, reservation, true).await
    }

    pub(crate) async fn acquire_channel(
        &self,
        host_id: String,
        cfg: ConnectConfig,
        jump_cfg: Option<ConnectConfig>,
    ) -> Result<SftpChannelGuard, String> {
        let host = self.upsert_host(host_id, cfg, jump_cfg);
        let reservation = match self.reserve_transient_channel(&host)? {
            ChannelReservation::Ready { channel_id, sftp } => {
                return Ok(SftpChannelGuard {
                    host,
                    channel_id,
                    sftp,
                });
            }
            other => other,
        };
        let panel = self
            .finish_channel_open(host.clone(), reservation, false)
            .await?;
        Ok(SftpChannelGuard {
            host,
            channel_id: panel.channel_id,
            sftp: panel.sftp,
        })
    }

    pub(crate) fn get_channel(&self, host_id: &str, channel_id: u64) -> Option<Arc<Sftp>> {
        let host = self.hosts.lock().unwrap().get(host_id).cloned()?;
        let state = host.state.lock().unwrap();
        state
            .channels
            .get(&channel_id)
            .and_then(|entry| match entry {
                ChannelEntry::Ready { sftp, .. } => Some(Arc::clone(sftp)),
                ChannelEntry::Opening => None,
            })
    }

    pub(crate) fn close_channel(&self, host_id: &str, channel_id: u64) -> bool {
        let Some(host) = self.hosts.lock().unwrap().get(host_id).cloned() else {
            return false;
        };
        let removed = host.remove_channel(channel_id, 0);
        if matches!(removed, Some(false)) {
            self.prune_idle_host(host_id, &host);
        }
        removed.is_some()
    }

    pub(crate) async fn refresh_channel(
        &self,
        host_id: &str,
        channel_id: u64,
    ) -> Result<Arc<Sftp>, String> {
        let Some(host) = self.hosts.lock().unwrap().get(host_id).cloned() else {
            return Err(string_error(format!("no sftp host pool for {host_id}")));
        };

        let (pinned, leased) = {
            let state = host.state.lock().unwrap();
            match state.channels.get(&channel_id) {
                Some(ChannelEntry::Ready { pinned, leased, .. }) => (*pinned, *leased),
                Some(ChannelEntry::Opening) => {
                    return Err(string_error(format!(
                        "sftp channel {channel_id} is still opening"
                    )));
                }
                None => {
                    return Err(string_error(format!(
                        "no sftp channel {channel_id} for host {host_id}"
                    )));
                }
            }
        };

        // Try the existing pooled session first: a channel-level failure
        // (single dead SFTP channel) must not tear down the shared session
        // that other panel/transfer channels on this host still use. If the
        // session itself is dead, the open below fails or times out with a
        // retryable error and `open_sftp_for_host` reconnects from scratch.
        let sftp = self.open_sftp_for_host(&host).await?;

        let mut state = host.state.lock().unwrap();
        state.channels.insert(
            channel_id,
            ChannelEntry::Ready {
                sftp: Arc::clone(&sftp),
                pinned,
                leased,
            },
        );
        Ok(sftp)
    }

    fn upsert_host(
        &self,
        host_id: String,
        cfg: ConnectConfig,
        jump_cfg: Option<ConnectConfig>,
    ) -> Arc<HostPool> {
        let mut hosts = self.hosts.lock().unwrap();
        let host = hosts
            .entry(host_id.clone())
            .or_insert_with(|| Arc::new(HostPool::new(host_id, cfg.clone(), jump_cfg.clone())))
            .clone();
        host.update_config(cfg, jump_cfg);
        host
    }

    fn prune_idle_host(&self, host_id: &str, host: &Arc<HostPool>) {
        if !host.is_idle() {
            return;
        }
        host.invalidate_connection();
        let mut hosts = self.hosts.lock().unwrap();
        if host.is_idle() {
            hosts.remove(host_id);
        }
    }

    fn reserve_panel_channel(&self, host: &Arc<HostPool>) -> Result<ChannelReservation, String> {
        let mut state = host.state.lock().unwrap();

        for (&channel_id, entry) in state.channels.iter_mut() {
            if let ChannelEntry::Ready {
                sftp,
                pinned,
                leased,
            } = entry
            {
                if !*pinned && !*leased {
                    *pinned = true;
                    return Ok(ChannelReservation::Ready {
                        channel_id,
                        sftp: Arc::clone(sftp),
                    });
                }
            }
        }

        if state.channels.len() >= MAX_SFTP_CHANNELS_PER_HOST {
            return Err(ipc_error(
                CHANNEL_LIMIT_CODE,
                format!("sftp channel limit reached for host {}", host.host_id),
            ));
        }

        let channel_id = self.next_channel_id.fetch_add(1, Ordering::SeqCst);
        state.channels.insert(channel_id, ChannelEntry::Opening);
        Ok(ChannelReservation::Opening { channel_id })
    }

    fn reserve_transient_channel(
        &self,
        host: &Arc<HostPool>,
    ) -> Result<ChannelReservation, String> {
        let mut state = host.state.lock().unwrap();

        for (&channel_id, entry) in state.channels.iter_mut() {
            if let ChannelEntry::Ready {
                sftp,
                pinned,
                leased,
            } = entry
            {
                if !*pinned && !*leased {
                    *leased = true;
                    return Ok(ChannelReservation::Ready {
                        channel_id,
                        sftp: Arc::clone(sftp),
                    });
                }
            }
        }

        if state.channels.len() >= MAX_SFTP_CHANNELS_PER_HOST {
            return Err(ipc_error(
                CHANNEL_LIMIT_CODE,
                format!("sftp channel limit reached for host {}", host.host_id),
            ));
        }

        let channel_id = self.next_channel_id.fetch_add(1, Ordering::SeqCst);
        state.channels.insert(channel_id, ChannelEntry::Opening);
        Ok(ChannelReservation::Opening { channel_id })
    }

    async fn finish_channel_open(
        &self,
        host: Arc<HostPool>,
        reservation: ChannelReservation,
        pinned: bool,
    ) -> Result<PanelChannel, String> {
        let ChannelReservation::Opening { channel_id } = reservation else {
            unreachable!("finish_channel_open only handles opening reservations");
        };

        // Frees the Opening slot if the open fails or this future is dropped,
        // so a failed open never permanently consumes host channel quota.
        let mut opening_guard = OpeningGuard {
            host: &host,
            channel_id,
            completed: false,
        };

        let sftp = self.open_sftp_for_host(&host).await?;

        let mut state = host.state.lock().unwrap();
        state.channels.insert(
            channel_id,
            ChannelEntry::Ready {
                sftp: Arc::clone(&sftp),
                pinned,
                leased: !pinned,
            },
        );
        drop(state);
        opening_guard.completed = true;

        Ok(PanelChannel { channel_id, sftp })
    }

    async fn open_sftp_for_host(&self, host: &Arc<HostPool>) -> Result<Arc<Sftp>, String> {
        let mut attempts = 0usize;
        loop {
            attempts += 1;
            let session = host.connect_session().await?;
            let opened = match tokio::time::timeout(SFTP_OPEN_TIMEOUT, session.sftp()).await {
                Ok(result) => result.map_err(ssh_error),
                Err(_) => Err(ipc_error(
                    "TIMEOUT",
                    format!(
                        "timed out opening sftp channel after {}s",
                        SFTP_OPEN_TIMEOUT.as_secs()
                    ),
                )),
            };
            match opened {
                Ok(sftp) => return Ok(Arc::new(sftp)),
                Err(err) => {
                    if attempts < 2 && is_retryable_session_open_error(&err) {
                        host.invalidate_connection();
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }
}

fn is_retryable_session_open_error(err: &str) -> bool {
    if let Some(parsed) = parse_ipc_error(err) {
        return matches!(parsed.code.as_str(), "CHANNEL_CLOSED" | "TIMEOUT");
    }

    let lower = err.to_ascii_lowercase();
    lower.contains("channel closed")
        || lower.contains("channel send error")
        || lower.contains("broken pipe")
        || lower.contains("connection lost")
        || lower.contains("connection reset")
        || lower.contains("session closed")
        || lower.contains("timed out")
        || lower.contains("timeout")
}

struct HostPool {
    host_id: String,
    state: Mutex<HostState>,
    connect_lock: AsyncMutex<()>,
}

impl HostPool {
    fn new(host_id: String, cfg: ConnectConfig, jump_cfg: Option<ConnectConfig>) -> Self {
        Self {
            host_id,
            connect_lock: AsyncMutex::new(()),
            state: Mutex::new(HostState {
                cfg,
                jump_cfg,
                session: None,
                jump_session: None,
                connecting: false,
                channels: HashMap::new(),
            }),
        }
    }

    fn update_config(&self, cfg: ConnectConfig, jump_cfg: Option<ConnectConfig>) {
        let mut state = self.state.lock().unwrap();
        state.cfg = cfg;
        state.jump_cfg = jump_cfg;
    }

    async fn connect_session(&self) -> Result<Arc<Session>, String> {
        {
            let state = self.state.lock().unwrap();
            if let Some(session) = state.session.clone() {
                return Ok(session);
            }
        }

        let _connect_guard = self.connect_lock.lock().await;
        let (cfg, jump_cfg) = {
            let mut state = self.state.lock().unwrap();
            if let Some(session) = state.session.clone() {
                return Ok(session);
            }
            state.connecting = true;
            (state.cfg.clone(), state.jump_cfg.clone())
        };

        let connected = match jump_cfg {
            Some(jump_cfg) => match Session::connect(jump_cfg).await.map_err(ssh_error) {
                Ok(jump_session) => {
                    let jump_session = Arc::new(jump_session);
                    Session::connect_via(cfg, jump_session.as_ref())
                        .await
                        .map(|session| (Arc::new(session), Some(jump_session)))
                        .map_err(ssh_error)
                }
                Err(err) => Err(err),
            },
            None => Session::connect(cfg)
                .await
                .map(|session| (Arc::new(session), None))
                .map_err(ssh_error),
        };

        let mut state = self.state.lock().unwrap();
        state.connecting = false;
        match connected {
            Ok((session, jump_session)) => {
                state.session = Some(session.clone());
                state.jump_session = jump_session;
                Ok(session)
            }
            Err(err) => Err(err),
        }
    }

    fn invalidate_connection(&self) {
        let mut state = self.state.lock().unwrap();
        state.session = None;
        state.jump_session = None;
        state.connecting = false;
    }

    fn remove_channel(&self, channel_id: u64, retained_refs: usize) -> Option<bool> {
        let entry = self.state.lock().unwrap().channels.remove(&channel_id)?;
        let has_external_refs = match &entry {
            ChannelEntry::Ready { sftp, .. } => Arc::strong_count(sftp) > retained_refs + 1,
            ChannelEntry::Opening => false,
        };
        Some(has_external_refs)
    }

    fn is_idle(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.connecting && state.channels.is_empty()
    }
}

struct HostState {
    cfg: ConnectConfig,
    jump_cfg: Option<ConnectConfig>,
    session: Option<Arc<Session>>,
    jump_session: Option<Arc<Session>>,
    connecting: bool,
    channels: HashMap<u64, ChannelEntry>,
}

enum ChannelEntry {
    Opening,
    Ready {
        sftp: Arc<Sftp>,
        pinned: bool,
        leased: bool,
    },
}

enum ChannelReservation {
    Ready { channel_id: u64, sftp: Arc<Sftp> },
    Opening { channel_id: u64 },
}

/// Removes an `Opening` placeholder from the host pool unless the open
/// completed, covering both error returns and cancelled futures.
struct OpeningGuard<'a> {
    host: &'a HostPool,
    channel_id: u64,
    completed: bool,
}

impl Drop for OpeningGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            self.host
                .state
                .lock()
                .unwrap()
                .channels
                .remove(&self.channel_id);
        }
    }
}

pub(crate) struct PanelChannel {
    pub(crate) channel_id: u64,
    pub(crate) sftp: Arc<Sftp>,
}

pub(crate) struct SftpChannelGuard {
    host: Arc<HostPool>,
    channel_id: u64,
    sftp: Arc<Sftp>,
}

impl SftpChannelGuard {
    pub(crate) fn sftp(&self) -> Arc<Sftp> {
        Arc::clone(&self.sftp)
    }
}

impl Drop for SftpChannelGuard {
    fn drop(&mut self) {
        let should_remove = {
            let mut state = self.host.state.lock().unwrap();
            match state.channels.get_mut(&self.channel_id) {
                Some(ChannelEntry::Ready { pinned, leased, .. }) if !*pinned => {
                    *leased = false;
                    true
                }
                _ => false,
            }
        };
        if should_remove {
            let has_external_refs = self
                .host
                .remove_channel(self.channel_id, 1)
                .unwrap_or(false);
            if !has_external_refs && self.host.is_idle() {
                self.host.invalidate_connection();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sftp::ipc_error;

    #[test]
    fn retryable_session_open_error_uses_structured_codes() {
        assert!(is_retryable_session_open_error(&ipc_error(
            "CHANNEL_CLOSED",
            "channel closed while opening sftp"
        )));
        assert!(is_retryable_session_open_error(&ipc_error(
            "TIMEOUT",
            "timed out opening sftp"
        )));
        assert!(!is_retryable_session_open_error(&ipc_error(
            "PERMISSION_DENIED",
            "permission denied"
        )));
    }

    #[test]
    fn retryable_session_open_error_detects_plaintext_disconnects() {
        assert!(is_retryable_session_open_error("broken pipe"));
        assert!(is_retryable_session_open_error(
            "ssh protocol error: Channel send error"
        ));
        assert!(is_retryable_session_open_error("connection reset by peer"));
        assert!(is_retryable_session_open_error("session closed"));
        assert!(!is_retryable_session_open_error("bad username or password"));
    }

    #[test]
    fn channel_limit_error_is_detected_by_code_only() {
        let err = ipc_error(
            CHANNEL_LIMIT_CODE,
            "sftp channel limit reached for host h1",
        );
        assert!(is_channel_limit_error(&err));
        assert!(!is_retryable_session_open_error(&err));
        assert!(!is_channel_limit_error(&ipc_error("TIMEOUT", "timed out")));
        assert!(!is_channel_limit_error("sftp channel limit reached"));
    }
}
