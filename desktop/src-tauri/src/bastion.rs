use crate::state::AppState;
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
use zeroterm_app::{App, BastionAsset, BastionCatalog, BastionProfile};

fn app(state: &AppState) -> Result<Arc<App>, String> {
    state
        .app
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .ok_or_else(|| "vault is locked".into())
}
#[derive(Clone, Serialize)]
pub struct ConnectionIdentity {
    pub connection_id: String,
    pub asset_name: String,
    pub account: String,
    pub capabilities: Vec<String>,
}
impl From<&zeroterm_ssh::ManagedSession> for ConnectionIdentity {
    fn from(m: &zeroterm_ssh::ManagedSession) -> Self {
        Self {
            connection_id: m.connection_id.clone(),
            asset_name: m.asset_name.clone(),
            account: m.account.clone(),
            capabilities: m.capabilities.clone(),
        }
    }
}
#[tauri::command]
pub fn bastion_profiles(state: State<'_, AppState>) -> Result<Vec<BastionProfile>, String> {
    app(&state)?
        .list_bastion_profiles()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn bastion_save_profile(
    state: State<'_, AppState>,
    profile: BastionProfile,
) -> Result<String, String> {
    app(&state)?
        .save_bastion_profile(&profile)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn bastion_delete_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    app(&state)?
        .delete_bastion_profile(&profile_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bastion_login(
    state: State<'_, AppState>,
    profile_id: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let password = zeroize::Zeroizing::new(password);
    let app = app(&state)?;
    let profile = app
        .list_bastion_profiles()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or("RESOURCE_NOT_FOUND")?;
    app.bastions()
        .login(profile, &username, &password, "ZeroTerm Desktop")
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bastion_logout(state: State<'_, AppState>, profile_id: String) -> Result<(), String> {
    app(&state)?
        .bastions()
        .logout(&profile_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bastion_assets(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<BastionAsset>, String> {
    app(&state)?
        .bastions()
        .assets(&profile_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bastion_catalog(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<BastionCatalog, String> {
    app(&state)?
        .bastions()
        .catalog(&profile_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn bastion_save_asset(
    state: State<'_, AppState>,
    profile_id: String,
    asset_id: String,
    account_id: String,
) -> Result<String, String> {
    app(&state)?
        .save_bastion_asset(&profile_id, &asset_id, &account_id)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn bastion_session_identity(
    state: State<'_, AppState>,
    session_id: u64,
) -> Result<Option<ConnectionIdentity>, String> {
    state
        .sessions
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&session_id)
        .map(|s| s.bastion.clone())
        .ok_or_else(|| "session closed".into())
}

#[tauri::command]
pub fn bastion_sftp_identity(
    state: State<'_, AppState>,
    sftp_id: u64,
) -> Result<Option<ConnectionIdentity>, String> {
    let handles = state
        .sftp_handles
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let handle = handles.get(&sftp_id).ok_or("SFTP closed")?;
    let sftp = state
        .sftp_pool
        .get_channel(&handle.host_id, handle.channel_id)
        .ok_or("SFTP closed")?;
    Ok(sftp.managed_identity().map(ConnectionIdentity::from))
}
