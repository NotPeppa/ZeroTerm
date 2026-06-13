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
                // Open at the user's saved startup size, or the default if
                // none is saved / the file is unreadable. Applied while the
                // window is still hidden (`visible: false` in tauri.conf.json)
                // so there's no resize flash. Position is NOT persisted; every
                // launch recenters the window, which is the most predictable
                // behavior across monitor/layout changes.
                let (w, h) = commands::read_startup_window_size().unwrap_or((1500.0, 860.0));
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));
                let _ = win.show();
                if let Ok(Some(monitor)) = win.current_monitor() {
                    if let Ok(window_size) = win.outer_size() {
                        let monitor_size = monitor.size();
                        let monitor_pos = monitor.position();
                        let x = monitor_pos.x + ((monitor_size.width.saturating_sub(window_size.width)) / 2) as i32;
                        let y = monitor_pos.y + ((monitor_size.height.saturating_sub(window_size.height)) / 2) as i32;
                        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x, y)));
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::get_ai_config,
            commands::save_ai_profile,
            commands::delete_ai_profile,
            commands::set_active_ai_profile,
            commands::set_ai_profile_model,
            commands::list_ai_sessions,
            commands::save_ai_session,
            commands::delete_ai_session,
            commands::clear_ai_sessions,
            commands::clear_ai_sessions_for_scope,
            commands::list_ai_models,
            commands::list_ai_models_for_profile,
            commands::ai_chat,
            commands::ai_chat_stream,
            commands::cancel_ai_chat_stream,
            commands::set_background_image,
            commands::get_background_image,
            commands::clear_background_image,
            commands::save_window_size,
            commands::get_window_size_setting,
            commands::clear_window_size_setting,
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
            commands::update_host_forwards,
            commands::update_sync_profile,
            commands::delete_host,
            commands::delete_sync_profile,
            commands::delete_all_sync_profiles,
            commands::create_port_forward_rule,
            commands::update_port_forward_rule,
            commands::delete_port_forward_rule,
            commands::migrate_port_forward_rules,
            commands::get_host,
            commands::list_host_groups,
            commands::create_host_group,
            commands::update_host_group,
            commands::delete_host_group,
            commands::set_host_group,
            commands::list_snippets,
            commands::create_snippet,
            commands::update_snippet,
            commands::delete_snippet,
            commands::rename_snippet_group,
            commands::delete_snippet_group,
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
            commands::list_port_forward_status,
            commands::list_port_forward_hosts,
            commands::start_port_forward,
            commands::stop_port_forward,
            commands::connect_quick_host,
            commands::open_local_terminal,
            commands::create_local_terminal_session,
            commands::send_input,
            commands::resize_session,
            commands::disconnect_session,
            commands::session_info,
            commands::collect_system_metrics,
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
            commands::list_system_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
