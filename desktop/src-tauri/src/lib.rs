mod commands;
mod connect;
mod editor;
mod file_dto;
mod host_key;
mod session;
mod sftp;
mod state;

use crate::state::AppState;
use tauri::Manager;

/// Center `win` on the monitor it currently occupies, using the *intended*
/// logical size (the one we just passed to `set_size`) instead of querying the
/// window. On macOS `set_size` isn't reflected in `outer_size()` yet when we
/// position the window right after `show()`, so Tauri's `center()` (and any
/// size we read back) still use the pre-resize default — which leaves a
/// smaller saved window biased toward the top-left. Centering against the
/// known target size sidesteps that timing entirely. Falls back to `center()`
/// if the monitor can't be queried. Only used on macOS, but compiled
/// everywhere so it's type-checked on every platform.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn center_window(win: &tauri::WebviewWindow, logical_w: f64, logical_h: f64) {
    let Ok(Some(monitor)) = win.current_monitor() else {
        let _ = win.center();
        return;
    };
    let scale = monitor.scale_factor();
    let mon = monitor.size().to_logical::<f64>(scale);
    let mon_pos = monitor.position().to_logical::<f64>(scale);
    let x = mon_pos.x + ((mon.width - logical_w) / 2.0).max(0.0);
    let y = mon_pos.y + ((mon.height - logical_h) / 2.0).max(0.0);
    let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                tracing_subscriber::EnvFilter::new("info,zeroterm=debug,tauri=info")
            }),
        )
        .init();

    if let Err(e) = commands::apply_saved_network_proxy_config() {
        tracing::warn!(error = %e, "failed to apply saved network proxy config");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .setup(|app| {
            match sftp::file::cleanup_local_sftp_temp_files(app.handle()) {
                Ok(removed) if removed > 0 => {
                    tracing::info!(removed, "cleaned stale local SFTP temp files");
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!(error = %e, "failed to clean stale local SFTP temp files");
                }
            }

            if let Some(win) = app.get_webview_window("main") {
                // Open at the user's saved startup size, or the default if
                // none is saved / the file is unreadable. Applied while the
                // window is still hidden (`visible: false` in tauri.conf.json)
                // so there's no resize flash. Position is NOT persisted; every
                // launch recenters the window, which is the most predictable
                // behavior across monitor/layout changes.
                let (w, h) = commands::read_startup_window_size().unwrap_or((1500.0, 860.0));
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(w, h)));

                // Centering timing differs by platform. On Windows/Linux the
                // window can be positioned while still hidden, so we center
                // before show() to avoid any visible jump. On macOS set_size
                // hasn't taken effect yet at that point, so we show first then
                // center against the *known* target size (w, h) — see
                // center_window() for why we don't query the live size.
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = win.center();
                    let _ = win.show();
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = win.show();
                    center_window(&win, w, h);
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
            commands::get_network_proxy_config,
            commands::save_network_proxy_config,
            commands::clear_network_proxy_config,
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
            commands::destroy_current_window,
            commands::request_window_attention,
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
            commands::reveal_host_credential,
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
            commands::sync_revoke_device,
            commands::sync_list_conflicts,
            commands::sync_resolve_conflict,
            commands::sync_compact_now,
            commands::sync_repo_stats,
            commands::sync_delete_remote_repo,
            commands::pick_local_file,
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
            commands::authorize_ai_terminal_command,
            commands::resize_session,
            commands::disconnect_session,
            commands::session_info,
            commands::collect_system_metrics,
            commands::list_system_services,
            commands::system_service_action,
            commands::system_service_file,
            commands::docker_exec,
            commands::respond_host_key,
            commands::local_home_path,
            commands::local_list,
            commands::local_path_exists,
            commands::local_file_fingerprint,
            commands::local_mkdir,
            commands::local_remove,
            commands::local_remove_dir,
            commands::local_rename,
            commands::local_permission_mode,
            commands::local_chmod,
            sftp::file::prepare_staging_upload_path,
            commands::temp_open_path,
            commands::open_with_app,
            sftp::sftp_open,
            sftp::sftp_close,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_upload_bytes,
            sftp::sftp_read_text,
            sftp::sftp_permission_mode,
            sftp::sftp_write_text,
            sftp::sftp_chmod,
            sftp::sftp_remove,
            sftp::sftp_remove_dir,
            sftp::sftp_rename,
            sftp::sftp_mkdir,
            sftp::sftp_copy_entry_between_panes,
            sftp::sftp_cancel_transfer,
            commands::list_system_fonts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
