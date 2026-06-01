mod commands;
mod host_key;
mod session;
mod state;

use crate::state::AppState;
use tauri::Manager;

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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(1500.0, 860.0)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::get_ai_config,
            commands::save_ai_config,
            commands::list_ai_models,
            commands::ai_chat,
            commands::ai_chat_stream,
            commands::set_background_image,
            commands::get_background_image,
            commands::clear_background_image,
            commands::unlock_vault,
            commands::create_vault,
            commands::lock_vault,
            commands::clear_vault_data,
            commands::try_keychain_unlock,
            commands::forget_keychain,
            commands::open_new_window,
            commands::app_version,
            commands::check_for_update,
            commands::install_update,
            commands::list_hosts,
            commands::host_sync_diagnostics,
            commands::list_sync_profiles,
            commands::save_host,
            commands::save_sync_profile,
            commands::update_host,
            commands::update_sync_profile,
            commands::delete_host,
            commands::delete_sync_profile,
            commands::delete_all_sync_profiles,
            commands::get_host,
            commands::list_host_groups,
            commands::create_host_group,
            commands::update_host_group,
            commands::delete_host_group,
            commands::set_host_group,
            commands::sync_create_repo,
            commands::sync_join_repo,
            commands::sync_now,
            commands::sync_status,
            commands::sync_forget_engine,
            commands::sync_has_remembered_passphrase,
            commands::sync_list_devices,
            commands::sync_list_conflicts,
            commands::sync_resolve_conflict,
            commands::sync_compact_now,
            commands::sync_repo_stats,
            commands::sync_delete_remote_repo,
            commands::read_local_text_file,
            commands::local_read_text,
            commands::local_write_text,
            commands::connect_host,
            commands::connect_quick_host,
            commands::open_local_terminal,
            commands::create_local_terminal_session,
            commands::send_input,
            commands::resize_session,
            commands::disconnect_session,
            commands::session_info,
            commands::respond_host_key,
            commands::local_home_path,
            commands::local_list,
            commands::local_mkdir,
            commands::local_remove,
            commands::local_remove_dir,
            commands::local_rename,
            commands::local_permission_mode,
            commands::local_chmod,
            commands::temp_open_path,
            commands::open_with_app,
            commands::sftp_open,
            commands::sftp_detect_dir_helper,
            commands::sftp_install_dir_helper,
            commands::sftp_close,
            commands::sftp_list,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_upload_bytes,
            commands::sftp_read_text,
            commands::sftp_permission_mode,
            commands::sftp_write_text,
            commands::sftp_chmod,
            commands::sftp_remove,
            commands::sftp_remove_dir,
            commands::sftp_rename,
            commands::sftp_mkdir,
            commands::sftp_copy_entry_between_panes,
            commands::sftp_cancel_transfer,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
