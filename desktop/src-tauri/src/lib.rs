mod commands;
mod host_key;
mod session;
mod state;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,zeroterm=debug,tauri=info")
            }),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::unlock_vault,
            commands::create_vault,
            commands::lock_vault,
            commands::try_keychain_unlock,
            commands::forget_keychain,
            commands::list_hosts,
            commands::connect_host,
            commands::send_input,
            commands::resize_session,
            commands::disconnect_session,
            commands::session_info,
            commands::respond_host_key,
            commands::sftp_open,
            commands::sftp_close,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_remove,
            commands::sftp_remove_dir,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_cancel_transfer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
