use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use zeroterm_ssh::{ConnectConfig, HostKeyPolicy, KnownHosts, Session};

use crate::host_key::TauriHostKeyPrompt;
use crate::state::AppState;

pub(crate) type ConnectChain = (zeroterm_app::Host, ConnectConfig, Option<ConnectConfig>);

/// Resolve a host id from the (unlocked) vault into the data needed to drive a
/// connection: the canonical host record, its `ConnectConfig`, and (if the host
/// has a saved ProxyJump) the jump host's `ConnectConfig` too.
pub(crate) fn build_connect_chain_for_host(
    state: &AppState,
    app_handle: &AppHandle,
    host_id: &str,
) -> Result<ConnectChain, String> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let host = app
        .find_host_by_id(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| "could not locate $HOME for known_hosts".to_string())?;
    let prompt = Arc::new(TauriHostKeyPrompt {
        app_handle: app_handle.clone(),
    });
    let policy = HostKeyPolicy::Interactive {
        store: known_hosts.clone(),
        prompt: prompt.clone(),
    };

    let cfg = app.connect_config(&host, policy, Some(Duration::from_secs(15)));

    let jump_cfg = if let Some(jump_id) = host.proxy_jump_host_id.as_deref() {
        let jump_host = app
            .find_host_by_id(jump_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("ProxyJump host id '{jump_id}' not found in vault"))?;
        let jump_policy = HostKeyPolicy::Interactive {
            store: known_hosts,
            prompt,
        };
        Some(app.connect_config(&jump_host, jump_policy, Some(Duration::from_secs(15))))
    } else {
        None
    };

    Ok((host, cfg, jump_cfg))
}

pub(crate) fn build_connect_chain_for_host_strict(
    state: &AppState,
    host_id: &str,
) -> Result<ConnectChain, String> {
    let app_lock = state.app.lock().unwrap();
    let app = app_lock.as_ref().ok_or("vault is locked")?;

    let host = app
        .find_host_by_id(host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no host with id {host_id}"))?;

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| "could not locate $HOME for known_hosts".to_string())?;

    let cfg = app.connect_config(
        &host,
        HostKeyPolicy::Strict(known_hosts.clone()),
        Some(Duration::from_secs(15)),
    );

    let jump_cfg = if let Some(jump_id) = host.proxy_jump_host_id.as_deref() {
        let jump_host = app
            .find_host_by_id(jump_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("ProxyJump host id '{jump_id}' not found in vault"))?;
        Some(app.connect_config(
            &jump_host,
            HostKeyPolicy::Strict(known_hosts),
            Some(Duration::from_secs(15)),
        ))
    } else {
        None
    };

    Ok((host, cfg, jump_cfg))
}

pub(crate) async fn connect_host_sessions(
    cfg: ConnectConfig,
    jump_cfg: Option<ConnectConfig>,
) -> Result<(Option<Session>, Session), String> {
    match jump_cfg {
        Some(jcfg) => {
            let j = Session::connect(jcfg).await.map_err(|e| e.to_string())?;
            let s = Session::connect_via(cfg, &j)
                .await
                .map_err(|e| e.to_string())?;
            Ok((Some(j), s))
        }
        None => {
            let s = Session::connect(cfg).await.map_err(|e| e.to_string())?;
            Ok((None, s))
        }
    }
}
