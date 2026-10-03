//! Independent, vault-backed SSH forwards for mobile clients.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use zeroterm_app::{ForwardSpec, PortForwardRule};
use zeroterm_ssh::{ConnectConfig, ForwardHandle, HostKeyPolicy, Session};

use crate::error::{map_app_error, other};
use crate::facade::connect_session_chain;
use crate::listener::ForeignHostKeyPrompt;
use crate::{FfiError, HostKeyPromptCallback, ZeroTerm};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct PortForwardInput {
    pub id: Option<String>,
    pub host_id: String,
    pub kind: ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub enabled: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct PortForwardRecord {
    pub id: String,
    pub host_id: String,
    pub host_name: String,
    pub kind: ForwardKind,
    pub bind_addr: String,
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
    pub enabled: bool,
    /// stopped | starting | active | reconnecting
    pub state: String,
    pub last_error: Option<String>,
}

const STARTING: u8 = 0;
const ACTIVE: u8 = 1;
const RECONNECTING: u8 = 2;
pub(crate) type ForwardMap = Arc<Mutex<HashMap<String, Arc<ForwardEntry>>>>;
pub(crate) struct ForwardEntry {
    rule_id: String,
    pub host_id: String,
    spec_json: String,
    state: AtomicU8,
    error: Mutex<Option<String>>,
    cancel: CancellationToken,
    finished: CancellationToken,
}

/// Removes only this attempt, so an old cancelled start cannot erase a new one.
struct ForwardLease {
    map: ForwardMap,
    id: String,
    entry: Arc<ForwardEntry>,
}
impl Drop for ForwardLease {
    fn drop(&mut self) {
        self.entry.cancel.cancel();
        let mut map = self
            .map
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if map
            .get(&self.id)
            .is_some_and(|current| Arc::ptr_eq(current, &self.entry))
        {
            map.remove(&self.id);
        }
        self.entry.finished.cancel();
    }
}

fn validated_spec(input: &PortForwardInput) -> Result<ForwardSpec, FfiError> {
    let valid_address = |value: &str| {
        !value.is_empty()
            && value.len() <= 255
            && !value.chars().any(|c| c.is_control() || c.is_whitespace())
    };
    let bind = input.bind_addr.trim();
    let target = input.target_host.trim();
    if input.host_id.trim().is_empty() || !valid_address(bind) || input.bind_port == 0 {
        return Err(other(
            "host, bind address and a port from 1 to 65535 are required",
        ));
    }
    if input.kind != ForwardKind::Dynamic && (!valid_address(target) || input.target_port == 0) {
        return Err(other(
            "target address and a port from 1 to 65535 are required",
        ));
    }
    Ok(match input.kind {
        ForwardKind::Local => ForwardSpec::Local {
            enabled: input.enabled,
            bind_addr: bind.into(),
            bind_port: input.bind_port,
            target_host: target.into(),
            target_port: input.target_port,
        },
        ForwardKind::Remote => ForwardSpec::Remote {
            enabled: input.enabled,
            bind_addr: bind.into(),
            bind_port: input.bind_port,
            target_host: target.into(),
            target_port: input.target_port,
        },
        ForwardKind::Dynamic => ForwardSpec::Dynamic {
            enabled: input.enabled,
            bind_addr: bind.into(),
            bind_port: input.bind_port,
        },
    })
}

fn record(
    rule: PortForwardRule,
    host_name: String,
    entry: Option<&Arc<ForwardEntry>>,
) -> PortForwardRecord {
    let (kind, enabled, bind_addr, bind_port, target_host, target_port) = match rule.spec {
        ForwardSpec::Local {
            enabled,
            bind_addr,
            bind_port,
            target_host,
            target_port,
        } => (
            ForwardKind::Local,
            enabled,
            bind_addr,
            bind_port,
            target_host,
            target_port,
        ),
        ForwardSpec::Remote {
            enabled,
            bind_addr,
            bind_port,
            target_host,
            target_port,
        } => (
            ForwardKind::Remote,
            enabled,
            bind_addr,
            bind_port,
            target_host,
            target_port,
        ),
        ForwardSpec::Dynamic {
            enabled,
            bind_addr,
            bind_port,
        } => (
            ForwardKind::Dynamic,
            enabled,
            bind_addr,
            bind_port,
            String::new(),
            0,
        ),
    };
    PortForwardRecord {
        id: rule.id,
        host_id: rule.host_id,
        host_name,
        kind,
        enabled,
        bind_addr,
        bind_port,
        target_host,
        target_port,
        state: entry
            .map_or("stopped", |e| match e.state.load(Ordering::Acquire) {
                ACTIVE => "active",
                RECONNECTING => "reconnecting",
                _ => "starting",
            })
            .into(),
        last_error: entry.and_then(|e| {
            e.error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        }),
    }
}

#[uniffi::export(async_runtime = "tokio")]
impl ZeroTerm {
    pub fn migrate_port_forward_rules(&self) -> Result<u32, FfiError> {
        let app = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or(FfiError::VaultLocked)?;
        let count = app
            .migrate_embedded_port_forwards()
            .map_err(map_app_error)?;
        if count > 0 {
            self.sync_manager.schedule_debounced_sync_for_all(app);
        }
        Ok(count as u32)
    }

    pub fn list_port_forwards(&self) -> Result<Vec<PortForwardRecord>, FfiError> {
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let hosts = app.list_hosts().map_err(map_app_error)?;
        let rules = app.list_port_forwards().map_err(map_app_error)?;
        // Synced deletes/edits must not leave a hidden tunnel running.
        self.cancel_port_forwards_where(|entry| {
            !rules.iter().any(|rule| {
                rule.id == entry.rule_id
                    && rule.host_id == entry.host_id
                    && serde_json::to_string(&rule.spec).ok().as_deref() == Some(&entry.spec_json)
                    && hosts.iter().any(|host| host.id == rule.host_id)
            })
        });
        let active = self
            .port_forwards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Ok(rules
            .into_iter()
            .filter_map(|rule| {
                let host = hosts.iter().find(|host| host.id == rule.host_id)?;
                let entry = active.get(&rule.id);
                Some(record(rule, host.name.clone(), entry))
            })
            .collect())
    }

    pub async fn save_port_forward(&self, input: PortForwardInput) -> Result<String, FfiError> {
        let spec = validated_spec(&input)?;
        let id = input.id.filter(|id| !id.is_empty()).unwrap_or_default();
        if !id.is_empty() {
            self.stop_port_forward(id.clone()).await?;
        }
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?.clone();
        if self
            .port_forwards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&id)
        {
            return Err(other("port forward is starting; stop it before editing"));
        }
        let rule = PortForwardRule {
            id: id.clone(),
            host_id: input.host_id,
            spec,
        };
        let saved = if id.is_empty() {
            app.save_port_forward(&rule).map_err(map_app_error)?
        } else {
            app.find_port_forward_by_id(&id)
                .map_err(map_app_error)?
                .ok_or_else(|| other("port forward no longer exists"))?;
            app.update_port_forward(&rule).map_err(map_app_error)?;
            id
        };
        self.sync_manager.schedule_debounced_sync_for_all(app);
        Ok(saved)
    }

    pub async fn delete_port_forward(&self, id: String) -> Result<(), FfiError> {
        self.stop_port_forward(id.clone()).await?;
        let guard = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?.clone();
        self.cancel_port_forwards_where(|entry| entry.rule_id == id);
        app.delete_port_forward(&id).map_err(map_app_error)?;
        self.sync_manager.schedule_debounced_sync_for_all(app);
        Ok(())
    }

    pub async fn start_port_forward(
        self: Arc<Self>,
        id: String,
        host_key_prompt: Arc<dyn HostKeyPromptCallback>,
    ) -> Result<(), FfiError> {
        // Register before awaiting, under the vault lock: lock/delete/stop can
        // cancel a connection in progress, including a pending host-key prompt.
        let (rule, entry) = {
            let guard = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            let rule = app
                .find_port_forward_by_id(&id)
                .map_err(map_app_error)?
                .ok_or_else(|| other("port forward not found"))?;
            let spec_json = serde_json::to_string(&rule.spec).map_err(other)?;
            if !record(rule.clone(), String::new(), None).enabled {
                return Err(other("port forward is disabled"));
            }
            let mut map = self
                .port_forwards
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if map.contains_key(&id) {
                return Err(other("port forward is already running"));
            }
            let entry = Arc::new(ForwardEntry {
                rule_id: id.clone(),
                host_id: rule.host_id.clone(),
                spec_json,
                state: AtomicU8::new(STARTING),
                error: Mutex::new(None),
                cancel: CancellationToken::new(),
                finished: CancellationToken::new(),
            });
            map.insert(id.clone(), entry.clone());
            (rule, entry)
        };
        let lease = ForwardLease {
            map: self.port_forwards.clone(),
            id,
            entry: entry.clone(),
        };
        let policy = HostKeyPolicy::Interactive {
            store: self.resolved_known_hosts()?,
            prompt: Arc::new(ForeignHostKeyPrompt {
                foreign: host_key_prompt,
                pending: self.pending_host_key.clone(),
            }),
        };
        let chain = self.forward_connect_configs(&rule.host_id, policy.clone())?;
        let tunnel = tokio::select! {
            _ = entry.cancel.cancelled() => return Err(other("port forward cancelled")),
            result = open_tunnel(chain, &rule.spec) => result?,
        };
        entry.state.store(ACTIVE, Ordering::Release);
        tokio::spawn(supervise(
            Arc::downgrade(&self),
            rule,
            policy,
            tunnel,
            lease,
        ));
        Ok(())
    }

    pub async fn stop_port_forward(&self, id: String) -> Result<(), FfiError> {
        let entries = self.cancel_port_forwards_where_id(Some(&id));
        for entry in entries {
            entry.finished.cancelled().await;
        }
        Ok(())
    }

    pub async fn stop_all_port_forwards(&self) {
        for entry in self.cancel_port_forwards_where_id(None) {
            entry.finished.cancelled().await;
        }
    }

    pub fn active_port_forward_count(&self) -> u32 {
        self.port_forwards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len() as u32
    }
}

impl Drop for ZeroTerm {
    fn drop(&mut self) {
        self.cancel_port_forwards_where(|_| true);
    }
}

impl ZeroTerm {
    fn cancel_port_forwards_where_id(&self, id: Option<&str>) -> Vec<Arc<ForwardEntry>> {
        let mut map = self
            .port_forwards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let ids: Vec<_> = map
            .keys()
            .filter(|key| id.is_none_or(|id| *key == id))
            .cloned()
            .collect();
        ids.into_iter()
            .filter_map(|id| map.remove(&id))
            .inspect(|entry| entry.cancel.cancel())
            .collect()
    }

    pub(crate) fn cancel_port_forwards_where(&self, predicate: impl Fn(&ForwardEntry) -> bool) {
        let mut map = self
            .port_forwards
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        map.retain(|_, entry| {
            if predicate(entry) {
                entry.cancel.cancel();
                false
            } else {
                true
            }
        });
    }

    fn forward_connect_configs(
        &self,
        host_id: &str,
        policy: HostKeyPolicy,
    ) -> Result<(ConnectConfig, Option<ConnectConfig>), FfiError> {
        let host = {
            let guard = self
                .inner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard
                .as_ref()
                .ok_or(FfiError::VaultLocked)?
                .find_host_by_id(host_id)
                .map_err(map_app_error)?
                .ok_or_else(|| other("forward host not found"))?
        };
        self.saved_host_connect_configs(&host, policy)
    }
}

struct Tunnel {
    forward: ForwardHandle,
    session: Session,
    jump: Option<Session>,
}
impl Tunnel {
    async fn close(self) {
        drop(self.forward);
        let _ = tokio::time::timeout(Duration::from_secs(2), self.session.disconnect()).await;
        if let Some(jump) = self.jump {
            let _ = tokio::time::timeout(Duration::from_secs(2), jump.disconnect()).await;
        }
    }
}

async fn open_tunnel(
    chain: (ConnectConfig, Option<ConnectConfig>),
    spec: &ForwardSpec,
) -> Result<Tunnel, FfiError> {
    let (jump, session) = connect_session_chain(chain.0, chain.1)
        .await
        .map_err(other)?;
    let forward = match spec {
        ForwardSpec::Local {
            bind_addr,
            bind_port,
            target_host,
            target_port,
            ..
        } => {
            zeroterm_ssh::forward_local(
                &session,
                bind_addr,
                *bind_port,
                target_host.clone(),
                *target_port,
            )
            .await
        }
        ForwardSpec::Remote {
            bind_addr,
            bind_port,
            target_host,
            target_port,
            ..
        } => {
            zeroterm_ssh::forward_remote(
                &session,
                bind_addr,
                *bind_port,
                target_host.clone(),
                *target_port,
            )
            .await
        }
        ForwardSpec::Dynamic {
            bind_addr,
            bind_port,
            ..
        } => zeroterm_ssh::forward_dynamic(&session, bind_addr, *bind_port).await,
    }
    .map_err(other)?;
    Ok(Tunnel {
        forward,
        session,
        jump,
    })
}

async fn supervise(
    owner: Weak<ZeroTerm>,
    rule: PortForwardRule,
    policy: HostKeyPolicy,
    mut tunnel: Tunnel,
    lease: ForwardLease,
) {
    loop {
        loop {
            tokio::select! {
                _ = lease.entry.cancel.cancelled() => { tunnel.close().await; return; },
                _ = tokio::time::sleep(Duration::from_secs(2)) => {
                    if tunnel.session.is_closed() || tunnel.jump.as_ref().is_some_and(Session::is_closed) { break; }
                }
            }
        }
        lease.entry.state.store(RECONNECTING, Ordering::Release);
        tunnel.close().await;
        let mut backoff = Duration::from_secs(1);
        loop {
            tokio::select! { _ = lease.entry.cancel.cancelled() => return, _ = tokio::time::sleep(backoff) => {} }
            let Some(owner) = owner.upgrade() else {
                return;
            };
            let chain = owner.forward_connect_configs(&rule.host_id, policy.clone());
            drop(owner);
            let attempt = async { open_tunnel(chain?, &rule.spec).await };
            let result = tokio::select! { _ = lease.entry.cancel.cancelled() => return, result = attempt => result };
            match result {
                Ok(new_tunnel) => {
                    tunnel = new_tunnel;
                    *lease
                        .entry
                        .error
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
                    lease.entry.state.store(ACTIVE, Ordering::Release);
                    break;
                }
                Err(error) => {
                    *lease
                        .entry
                        .error
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(error.to_string());
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostAuthInput, HostInput, HostKeyInfo};
    use tempfile::TempDir;

    struct RejectKey;
    impl HostKeyPromptCallback for RejectKey {
        fn on_prompt(&self, _: String, _: HostKeyInfo, _: Option<String>) {
            panic!("test peer must not reach host-key verification");
        }
    }

    fn fixture(port: u16) -> (Arc<ZeroTerm>, TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let zt = ZeroTerm::new();
        zt.set_data_dir(dir.path().to_string_lossy().into());
        zt.create("test-password".into(), false).unwrap();
        let host = zt
            .save_host(HostInput {
                id: None,
                name: "fixture".into(),
                host: "127.0.0.1".into(),
                port,
                user: "fixture".into(),
                auth: HostAuthInput::Password {
                    value: "fixture".into(),
                },
                group_id: None,
            })
            .unwrap();
        (zt, dir, host)
    }

    fn input(host_id: String, kind: ForwardKind) -> PortForwardInput {
        PortForwardInput {
            id: None,
            host_id,
            kind,
            bind_addr: "127.0.0.1".into(),
            bind_port: 8080,
            target_host: "127.0.0.1".into(),
            target_port: 80,
            enabled: true,
        }
    }

    #[tokio::test]
    async fn port_forward_crud_uses_desktop_vault_records_and_preserves_disabled_rules() {
        let (zt, _dir, host) = fixture(22);
        let mut draft = input(host.clone(), ForwardKind::Remote);
        draft.enabled = false;
        let id = zt.save_port_forward(draft.clone()).await.unwrap();
        let rows = zt.list_port_forwards().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].state, "stopped");
        assert!(!rows[0].enabled);
        assert_eq!(rows[0].kind, ForwardKind::Remote);
        let app = zt.inner.lock().unwrap().clone().unwrap();
        assert!(matches!(
            app.find_port_forward_by_id(&id).unwrap().unwrap().spec,
            ForwardSpec::Remote {
                bind_port: 8080,
                target_port: 80,
                ..
            }
        ));
        draft.id = Some(id.clone());
        draft.kind = ForwardKind::Dynamic;
        draft.enabled = true;
        draft.target_host.clear();
        draft.target_port = 0;
        zt.save_port_forward(draft).await.unwrap();
        let rows = zt.list_port_forwards().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ForwardKind::Dynamic);
        assert_eq!(rows[0].target_port, 0);
        zt.delete_port_forward(id).await.unwrap();
        assert!(zt.list_port_forwards().unwrap().is_empty());
        zt.lock();
        assert!(matches!(
            zt.list_port_forwards(),
            Err(FfiError::VaultLocked)
        ));
        assert!(zt
            .save_port_forward(input(host, ForwardKind::Local))
            .await
            .is_err());
    }

    #[test]
    fn validates_addresses_ports_and_dynamic_targets() {
        let mut draft = input("fixture".into(), ForwardKind::Local);
        draft.bind_port = 0;
        assert!(validated_spec(&draft).is_err());
        draft.bind_port = 65535;
        draft.target_port = 0;
        assert!(validated_spec(&draft).is_err());
        draft.kind = ForwardKind::Dynamic;
        assert!(validated_spec(&draft).is_ok());
        draft.bind_addr = "bad\naddress".into();
        assert!(validated_spec(&draft).is_err());
    }

    #[tokio::test]
    async fn embedded_forwards_migrate_once_without_starting_them() {
        let (zt, _dir, host_id) = fixture(22);
        let app = zt.inner.lock().unwrap().clone().unwrap();
        let mut host = app.find_host_by_id(&host_id).unwrap().unwrap();
        host.forwards
            .push(validated_spec(&input(host_id, ForwardKind::Local)).unwrap());
        app.update_host(&host).unwrap();
        assert_eq!(zt.migrate_port_forward_rules().unwrap(), 1);
        assert_eq!(zt.migrate_port_forward_rules().unwrap(), 0);
        assert_eq!(zt.list_port_forwards().unwrap().len(), 1);
        assert_eq!(zt.active_port_forward_count(), 0);
    }

    async fn pending_start(
        zt: &Arc<ZeroTerm>,
        host: String,
    ) -> (String, tokio::task::JoinHandle<Result<(), FfiError>>) {
        let id = zt
            .save_port_forward(input(host, ForwardKind::Local))
            .await
            .unwrap();
        let task = tokio::spawn(
            zt.clone()
                .start_port_forward(id.clone(), Arc::new(RejectKey)),
        );
        tokio::time::timeout(Duration::from_secs(2), async {
            while zt.active_port_forward_count() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        (id, task)
    }

    #[tokio::test]
    async fn stop_cancels_pending_start_and_releases_duplicate_reservation() {
        let peer = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (zt, _dir, host) = fixture(peer.local_addr().unwrap().port());
        let (id, task) = pending_start(&zt, host).await;
        assert!(zt
            .clone()
            .start_port_forward(id.clone(), Arc::new(RejectKey))
            .await
            .is_err());
        tokio::time::timeout(Duration::from_secs(2), zt.stop_port_forward(id.clone()))
            .await
            .unwrap()
            .unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(zt.active_port_forward_count(), 0);
        assert_eq!(zt.list_port_forwards().unwrap()[0].state, "stopped");
        // Idempotent stops make CRUD and foreground-service shutdown safe.
        zt.stop_port_forward(id).await.unwrap();
    }

    #[tokio::test]
    async fn lock_and_host_delete_cancel_connections_in_progress() {
        let peer = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (zt, _dir, host) = fixture(peer.local_addr().unwrap().port());
        let (_, task) = pending_start(&zt, host.clone()).await;
        zt.delete_host(host).unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert_eq!(zt.active_port_forward_count(), 0);
        assert!(zt.list_port_forwards().unwrap().is_empty());
        let host = zt
            .save_host(HostInput {
                id: None,
                name: "fixture".into(),
                host: "127.0.0.1".into(),
                port: peer.local_addr().unwrap().port(),
                user: "fixture".into(),
                auth: HostAuthInput::Password {
                    value: "fixture".into(),
                },
                group_id: None,
            })
            .unwrap();
        let (_, task) = pending_start(&zt, host).await;
        zt.lock();
        assert!(tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert_eq!(zt.active_port_forward_count(), 0);
    }

    /// Opt-in against the same loopback OpenSSH fixture as ssh/tests/live_sshd.
    /// A TCP gate drops only this test's connection to exercise reconnects.
    #[tokio::test]
    #[ignore = "requires ZEROTERM_TEST_SSH_PORT/USER/KEY/KNOWN_HOSTS for a loopback SSH fixture"]
    async fn live_mobile_forwards_relay_all_three_types_and_reconnect() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::{TcpListener, TcpStream};
        let ssh_port: u16 = std::env::var("ZEROTERM_TEST_SSH_PORT")
            .unwrap()
            .parse()
            .unwrap();
        let gate = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gate_port = gate.local_addr().unwrap().port();
        let (gate_tx, mut gate_rx) = tokio::sync::mpsc::unbounded_channel();
        let gate_task = tokio::spawn(async move {
            loop {
                let (mut client, _) = gate.accept().await.unwrap();
                let mut upstream = TcpStream::connect(("127.0.0.1", ssh_port)).await.unwrap();
                let cancel = CancellationToken::new();
                gate_tx.send(cancel.clone()).unwrap();
                tokio::spawn(async move {
                    tokio::select! { _ = cancel.cancelled() => {}, _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {} }
                });
            }
        });
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            loop {
                let (stream, _) = echo.accept().await.unwrap();
                tokio::spawn(async move {
                    let (mut read, mut write) = stream.into_split();
                    let _ = tokio::io::copy(&mut read, &mut write).await;
                });
            }
        });
        let (zt, dir, old_host) = fixture(gate_port);
        zt.delete_host(old_host).unwrap();
        let known =
            std::fs::read_to_string(std::env::var("ZEROTERM_TEST_SSH_KNOWN_HOSTS").unwrap())
                .unwrap();
        std::fs::write(
            dir.path().join("known_hosts"),
            known.replace(
                &format!("[127.0.0.1]:{ssh_port}"),
                &format!("[127.0.0.1]:{gate_port}"),
            ),
        )
        .unwrap();
        let host = zt
            .save_host(HostInput {
                id: None,
                name: "loopback fixture".into(),
                host: "127.0.0.1".into(),
                port: gate_port,
                user: std::env::var("ZEROTERM_TEST_SSH_USER").unwrap(),
                auth: HostAuthInput::PrivateKey {
                    key_pem: std::fs::read_to_string(
                        std::env::var("ZEROTERM_TEST_SSH_KEY").unwrap(),
                    )
                    .unwrap(),
                    passphrase: None,
                },
                group_id: None,
            })
            .unwrap();
        async fn free_port() -> u16 {
            TcpListener::bind("127.0.0.1:0")
                .await
                .unwrap()
                .local_addr()
                .unwrap()
                .port()
        }
        async fn verify_echo(mut stream: TcpStream) {
            let payload = b"zeroterm-mobile-forward";
            stream.write_all(payload).await.unwrap();
            let mut received = vec![0; payload.len()];
            tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut received))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&received, payload);
        }
        let mut ids = Vec::new();
        let mut ports = Vec::new();
        for kind in [
            ForwardKind::Local,
            ForwardKind::Remote,
            ForwardKind::Dynamic,
        ] {
            let mut draft = input(host.clone(), kind);
            draft.bind_port = free_port().await;
            draft.target_port = echo_port;
            ports.push(draft.bind_port);
            let id = zt.save_port_forward(draft.clone()).await.unwrap();
            zt.clone()
                .start_port_forward(id.clone(), Arc::new(RejectKey))
                .await
                .unwrap();
            let mut stream = TcpStream::connect(("127.0.0.1", draft.bind_port))
                .await
                .unwrap();
            if kind == ForwardKind::Dynamic {
                stream.write_all(&[5, 1, 0]).await.unwrap();
                let mut greeting = [0; 2];
                stream.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [5, 0]);
                let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
                request.extend(echo_port.to_be_bytes());
                stream.write_all(&request).await.unwrap();
                let mut response = [0; 10];
                stream.read_exact(&mut response).await.unwrap();
                assert_eq!(response[1], 0);
            }
            verify_echo(stream).await;
            ids.push(id);
        }
        assert_eq!(zt.active_port_forward_count(), 3);
        assert!(zt.send_input(1, Vec::new()).await.is_err());
        gate_rx.recv().await.unwrap().cancel();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if zt
                    .list_port_forwards()
                    .unwrap()
                    .iter()
                    .any(|row| row.id == ids[0] && row.state == "reconnecting")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            loop {
                if zt
                    .list_port_forwards()
                    .unwrap()
                    .iter()
                    .any(|row| row.id == ids[0] && row.state == "active")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap();
        verify_echo(TcpStream::connect(("127.0.0.1", ports[0])).await.unwrap()).await;
        zt.stop_all_port_forwards().await;
        assert_eq!(zt.active_port_forward_count(), 0);
        tokio::time::timeout(Duration::from_secs(5), async {
            for port in ports {
                loop {
                    if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        })
        .await
        .unwrap();
        gate_task.abort();
        echo_task.abort();
    }
}
