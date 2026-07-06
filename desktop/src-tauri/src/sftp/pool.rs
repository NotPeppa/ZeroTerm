use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use zeroterm_ssh::{ConnectConfig, Session, Sftp};

use crate::sftp::{parse_ipc_error, ssh_error, string_error};

pub(crate) const MAX_SFTP_CHANNELS_PER_HOST: usize = 4;

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
        let removed = host
            .state
            .lock()
            .unwrap()
            .channels
            .remove(&channel_id)
            .is_some();
        removed
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

        host.invalidate_connection();
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
            return Err(string_error(format!(
                "sftp channel limit reached for host {}",
                host.host_id
            )));
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
            return Err(string_error(format!(
                "sftp channel limit reached for host {}",
                host.host_id
            )));
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
            match session.sftp().await {
                Ok(sftp) => return Ok(Arc::new(sftp)),
                Err(err) => {
                    let err = ssh_error(err);
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
}

impl HostPool {
    fn new(host_id: String, cfg: ConnectConfig, jump_cfg: Option<ConnectConfig>) -> Self {
        Self {
            host_id,
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
        loop {
            let connect_plan = {
                let mut state = self.state.lock().unwrap();
                if let Some(session) = state.session.clone() {
                    return Ok(session);
                }
                if state.connecting {
                    None
                } else {
                    state.connecting = true;
                    Some((state.cfg.clone(), state.jump_cfg.clone()))
                }
            };

            let Some((cfg, jump_cfg)) = connect_plan else {
                tokio::task::yield_now().await;
                continue;
            };

            let connected = match jump_cfg {
                Some(jump_cfg) => {
                    let jump_session =
                        Arc::new(Session::connect(jump_cfg).await.map_err(ssh_error)?);
                    let session = Arc::new(
                        Session::connect_via(cfg, jump_session.as_ref())
                            .await
                            .map_err(ssh_error)?,
                    );
                    Ok::<_, String>((session, Some(jump_session)))
                }
                None => {
                    let session = Arc::new(Session::connect(cfg).await.map_err(ssh_error)?);
                    Ok((session, None))
                }
            };

            let mut state = self.state.lock().unwrap();
            state.connecting = false;
            match connected {
                Ok((session, jump_session)) => {
                    state.session = Some(session.clone());
                    state.jump_session = jump_session;
                    return Ok(session);
                }
                Err(err) => return Err(err),
            }
        }
    }

    fn invalidate_connection(&self) {
        let mut state = self.state.lock().unwrap();
        state.session = None;
        state.jump_session = None;
        state.connecting = false;
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
        let mut state = self.host.state.lock().unwrap();
        if let Some(ChannelEntry::Ready { pinned, leased, .. }) =
            state.channels.get_mut(&self.channel_id)
        {
            if !*pinned {
                *leased = false;
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
        assert!(is_retryable_session_open_error("connection reset by peer"));
        assert!(is_retryable_session_open_error("session closed"));
        assert!(!is_retryable_session_open_error("bad username or password"));
    }
}
