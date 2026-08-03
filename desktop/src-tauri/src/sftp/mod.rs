use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tracing::{debug, info, warn};
use zeroterm_ssh::FileKind;

use crate::connect::build_connect_chain_for_host;
use crate::editor::{
    decode_editor_text, normalize_text_edit_limit, RemoteTextFileDto, HARD_TEXT_EDIT_MAX_BYTES,
};
use crate::file_dto::{kind_str, DirEntryDto, FilePermissionModeDto};
use crate::sftp::file::{
    cleanup_stale_remote_temp_entries, download_remote_file_to_local,
    downgrade_uploads_if_stalled, ensure_remote_target_available, is_retryable_transfer_error,
    upload_local_path_to_remote_once, upload_reader_to_remote_atomic,
    upload_slice_to_remote_atomic,
};
use crate::sftp::path::{
    detect_local_kind, detect_remote_kind, is_local_path_within, is_remote_path_within,
    remote_join_path, CopyNodeKind,
};
use crate::sftp::transfer::{
    acquire_transfer_slot, forget_transfer, register_transfer, run_with_progress, ProgressMode,
};
use crate::sftp::tree::{
    copy_local_tree_to_local, copy_local_tree_to_remote, copy_remote_tree_to_local,
    copy_remote_tree_to_remote, sftp_remove_dir_recursive,
};
use crate::state::{AppState, SftpHandle};
use zeroterm_ssh::{SftpErrorKind, SshError};

pub(crate) mod direct;
pub(crate) mod file;
pub(crate) mod path;
pub(crate) mod pool;
pub(crate) mod transfer;
pub(crate) mod tree;
use pool::{is_channel_limit_error, SftpChannelGuard};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IpcErrorDto {
    pub code: String,
    pub message: String,
}

pub(crate) fn classify_error_message(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("cancelled") || lower.contains("canceled") {
        "CANCELLED"
    } else {
        SftpErrorKind::infer_from_message(message).code()
    }
}

pub(crate) fn ipc_error(code: impl Into<String>, message: impl Into<String>) -> String {
    let message = message.into();
    serde_json::to_string(&IpcErrorDto {
        code: code.into(),
        message: message.clone(),
    })
    .unwrap_or(message)
}

pub(crate) fn parse_ipc_error(message: &str) -> Option<IpcErrorDto> {
    serde_json::from_str::<IpcErrorDto>(message).ok()
}

pub(crate) fn string_error(message: impl Into<String>) -> String {
    let message = message.into();
    ipc_error(classify_error_message(&message), message)
}

pub(crate) fn ssh_error(err: SshError) -> String {
    match err {
        SshError::Cancelled => ipc_error("CANCELLED", err.to_string()),
        SshError::ChannelClosed => ipc_error("CHANNEL_CLOSED", err.to_string()),
        SshError::Sftp {
            kind: SftpErrorKind::Other,
            message,
        } => ipc_error(classify_error_message(&message), message),
        SshError::Sftp { kind, message } => ipc_error(map_sftp_kind(kind), message),
        other => {
            let message = other.to_string();
            ipc_error(classify_error_message(&message), message)
        }
    }
}

fn map_sftp_kind(kind: SftpErrorKind) -> &'static str {
    kind.code()
}

#[tauri::command]
pub async fn sftp_open(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    host_id: String,
) -> Result<u64, String> {
    let (host, cfg, jump_cfg) = build_connect_chain_for_host(&state, &app_handle, &host_id)?;

    info!(host = %host.host, port = host.port, "opening sftp");
    let channel = state
        .sftp_pool
        .open_panel_channel(host_id.clone(), cfg, jump_cfg)
        .await?;
    let os_probe = host
        .os_type
        .is_none()
        .then(|| (host_id.clone(), Arc::clone(&channel.sftp), app_handle.clone()));

    let sftp_id = state.next_sftp_id.fetch_add(1, Ordering::SeqCst);
    state.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
        sftp_id,
        SftpHandle {
            host_id,
            channel_id: channel.channel_id,
        },
    );

    info!(sftp_id, "sftp ready");
    // Return the usable panel immediately. OS detection runs on the already
    // opened SFTP channel and reports its result through host:os_type_updated,
    // so slow or unsupported probes never delay or fail the panel open.
    if let Some((probe_host_id, probe_sftp, probe_app)) = os_probe {
        tauri::async_runtime::spawn(async move {
            crate::commands::detect_and_persist_host_os_type_from_sftp(
                probe_app,
                probe_host_id,
                probe_sftp,
            )
            .await;
        });
    }
    Ok(sftp_id)
}

pub(crate) async fn open_ephemeral_sftp(
    state: &AppState,
    app_handle: &AppHandle,
    host_id: &str,
) -> Result<SftpChannelGuard, String> {
    let (_host, cfg, jump_cfg) = build_connect_chain_for_host(state, app_handle, host_id)?;
    state
        .sftp_pool
        .acquire_channel(host_id.to_string(), cfg, jump_cfg)
        .await
}

/// A channel for a transfer, plus the guard keeping it leased when it came
/// from the pool. When the host is at its channel quota this falls back to
/// the panel's own pinned channel (`_guard: None`): SFTP multiplexes
/// concurrent requests safely on one channel, it's just slower than a
/// dedicated one — better than failing the transfer outright.
pub(crate) struct TransferChannel {
    sftp: Arc<zeroterm_ssh::Sftp>,
    _guard: Option<SftpChannelGuard>,
}

impl TransferChannel {
    pub(crate) fn sftp(&self) -> Arc<zeroterm_ssh::Sftp> {
        Arc::clone(&self.sftp)
    }
}

pub(crate) async fn acquire_transfer_sftp(
    state: &AppState,
    app_handle: &AppHandle,
    sftp_id: u64,
) -> Result<TransferChannel, String> {
    let host_id = lookup_sftp_host_id(state, sftp_id)?;
    match open_ephemeral_sftp(state, app_handle, &host_id).await {
        Ok(guard) => Ok(TransferChannel {
            sftp: guard.sftp(),
            _guard: Some(guard),
        }),
        Err(err) if is_channel_limit_error(&err) => {
            warn!(
                sftp_id,
                host_id = %host_id,
                "sftp channel quota exhausted, sharing the panel channel for this transfer"
            );
            let sftp = lookup_sftp(state, sftp_id)?;
            Ok(TransferChannel { sftp, _guard: None })
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn sftp_close(state: State<'_, AppState>, sftp_id: u64) -> Result<(), String> {
    let removed = state.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&sftp_id);
    if let Some(handle) = removed {
        state
            .sftp_pool
            .close_channel(&handle.host_id, handle.channel_id);
    }
    Ok(())
}

pub(crate) fn lookup_sftp(
    state: &AppState,
    sftp_id: u64,
) -> Result<Arc<zeroterm_ssh::Sftp>, String> {
    let (host_id, channel_id) = lookup_sftp_channel_info(state, sftp_id)?;
    state
        .sftp_pool
        .get_channel(&host_id, channel_id)
        .ok_or_else(|| format!("no sftp channel for handle {sftp_id}"))
}

fn lookup_sftp_channel_info(state: &AppState, sftp_id: u64) -> Result<(String, u64), String> {
    state
        .sftp_handles
        .lock()
        .unwrap()
        .get(&sftp_id)
        .map(|h| (h.host_id.clone(), h.channel_id))
        .ok_or_else(|| format!("no sftp handle with id {sftp_id}"))
}

pub(crate) fn lookup_sftp_host_id(state: &AppState, sftp_id: u64) -> Result<String, String> {
    state
        .sftp_handles
        .lock()
        .unwrap()
        .get(&sftp_id)
        .map(|h| h.host_id.clone())
        .ok_or_else(|| format!("no sftp handle with id {sftp_id}"))
}

fn remote_directory_copy_targets_source(
    source_host_id: &str,
    destination_host_id: &str,
    source_path: &str,
    destination_path: &str,
) -> bool {
    source_host_id == destination_host_id
        && is_remote_path_within(destination_path, source_path)
}

pub(crate) async fn with_resilient_panel_sftp<T, F, Fut>(
    state: &AppState,
    sftp_id: u64,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut(Arc<zeroterm_ssh::Sftp>) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let (host_id, channel_id) = lookup_sftp_channel_info(state, sftp_id)?;
    let sftp = lookup_sftp(state, sftp_id)?;
    match op(sftp).await {
        Ok(value) => Ok(value),
        Err(err) if is_retryable_transfer_error(&err) => {
            warn!(
                sftp_id,
                host_id = %host_id,
                channel_id,
                error = %err,
                "panel SFTP command lost its channel, refreshing and retrying once"
            );
            let refreshed = state
                .sftp_pool
                .refresh_channel(&host_id, channel_id)
                .await?;
            op(refreshed).await
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<Vec<DirEntryDto>, String> {
    let mut entries = with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        async move { sftp.list(&path).await.map_err(ssh_error) }
    })
    .await?;
    if let Ok(sftp) = lookup_sftp(&state, sftp_id) {
        cleanup_stale_remote_temp_entries(sftp.as_ref(), &path, &mut entries).await;
    }
    entries.sort_by(|a, b| {
        let kind_order = |k: FileKind| match k {
            FileKind::Dir => 0,
            _ => 1,
        };
        kind_order(a.kind)
            .cmp(&kind_order(b.kind))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries
        .into_iter()
        .map(|e| DirEntryDto {
            name: e.name,
            kind: kind_str(e.kind),
            size: e.size,
        })
        .collect())
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    remote: String,
    local: String,
    overwrite: Option<bool>,
) -> Result<u64, String> {
    let sftp = lookup_sftp(&state, sftp_id)?;
    let host_id = lookup_sftp_host_id(&state, sftp_id)?;
    download_remote_file_to_local(
        sftp,
        remote,
        PathBuf::from(local),
        overwrite.unwrap_or(false),
        Some(host_id.as_str()),
        ProgressMode::Standalone {
            app: &app_handle,
            state: &state,
        },
    )
    .await
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    local: String,
    remote: String,
    overwrite: Option<bool>,
) -> Result<u64, String> {
    let overwrite = overwrite.unwrap_or(false);
    let host_id = lookup_sftp_host_id(&state, sftp_id)?;
    let metadata = tokio::fs::metadata(&local)
        .await
        .map_err(|e| format!("stating {local}: {e}"))?;
    let size_hint = Some(metadata.len());
    if !overwrite {
        with_resilient_panel_sftp(&state, sftp_id, |sftp| {
            let remote = remote.clone();
            async move { ensure_remote_target_available(sftp.as_ref(), &remote).await }
        })
        .await?;
    }
    let sftp = lookup_sftp(&state, sftp_id)?;
    let (transfer_id, cancel) = register_transfer(
        &state,
        &app_handle,
        "upload",
        local.clone(),
        remote.clone(),
        size_hint,
    );
    let _permit = acquire_transfer_slot(&state, &app_handle, transfer_id).await?;
    let cancel_for_body = cancel.clone();
    let retry_app_handle = app_handle.clone();
    let retry_state: &AppState = &state;
    let retry_host_id = host_id.clone();

    let result = run_with_progress(
        &app_handle,
        &state,
        transfer_id,
        move |progress_cb| async move {
            let mut progress_cb = progress_cb;
            let first = upload_local_path_to_remote_once(
                sftp.as_ref(),
                Path::new(&local),
                &remote,
                size_hint,
                overwrite,
                true,
                cancel_for_body.clone(),
                &mut progress_cb,
            )
            .await
            .map_err(ssh_error);
            match first {
                Ok(bytes) => Ok(bytes),
                Err(err)
                    if !cancel_for_body.is_cancelled() && is_retryable_transfer_error(&err) =>
                {
                    warn!(
                        source = %local,
                        destination = %remote,
                        error = %err,
                        "direct upload lost its SFTP channel, retrying once with a fresh channel"
                    );
                    downgrade_uploads_if_stalled(retry_state, &retry_host_id, &err).await;
                    let guard =
                        open_ephemeral_sftp(retry_state, &retry_app_handle, &retry_host_id).await?;
                    upload_local_path_to_remote_once(
                        guard.sftp().as_ref(),
                        Path::new(&local),
                        &remote,
                        size_hint,
                        overwrite,
                        true,
                        cancel_for_body,
                        &mut progress_cb,
                    )
                    .await
                    .map_err(ssh_error)
                }
                Err(err) => Err(err),
            }
        },
    )
    .await;

    forget_transfer(&state, transfer_id);
    result
}

#[tauri::command]
pub async fn sftp_upload_bytes(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    remote: String,
    data: Vec<u8>,
    source_label: Option<String>,
    overwrite: Option<bool>,
) -> Result<u64, String> {
    // Inline byte arrays ride the JSON IPC channel; anything bigger must go
    // through `prepare_staging_upload_path` + `sftp_upload`. Shares the
    // editor's hard cap since the in-app copy/edit flows are the callers.
    if data.len() as u64 > HARD_TEXT_EDIT_MAX_BYTES {
        return Err(string_error(format!(
            "inline byte upload is {} bytes, above limit {} bytes; use a staged file upload instead",
            data.len(),
            HARD_TEXT_EDIT_MAX_BYTES
        )));
    }
    let overwrite = overwrite.unwrap_or(false);
    let host_id = lookup_sftp_host_id(&state, sftp_id)?;
    let size_hint = Some(data.len() as u64);
    let source = source_label.unwrap_or_else(|| format!("dragged-bytes({})", data.len()));
    if !overwrite {
        with_resilient_panel_sftp(&state, sftp_id, |sftp| {
            let remote = remote.clone();
            async move { ensure_remote_target_available(sftp.as_ref(), &remote).await }
        })
        .await?;
    }
    let sftp = lookup_sftp(&state, sftp_id)?;
    let (transfer_id, cancel) = register_transfer(
        &state,
        &app_handle,
        "upload",
        source,
        remote.clone(),
        size_hint,
    );
    let _permit = acquire_transfer_slot(&state, &app_handle, transfer_id).await?;
    let cancel_for_body = cancel.clone();
    let mut cursor = std::io::Cursor::new(data);
    let retry_app_handle = app_handle.clone();
    let retry_state: &AppState = &state;
    let retry_host_id = host_id.clone();

    let result = run_with_progress(
        &app_handle,
        &state,
        transfer_id,
        move |progress_cb| async move {
            let mut progress_cb = progress_cb;
            let first = upload_reader_to_remote_atomic(
                sftp.as_ref(),
                &remote,
                &mut cursor,
                size_hint,
                overwrite,
                true,
                cancel_for_body.clone(),
                &mut progress_cb,
            )
            .await
            .map_err(ssh_error);
            match first {
                Ok(bytes) => Ok(bytes),
                Err(err)
                    if !cancel_for_body.is_cancelled() && is_retryable_transfer_error(&err) =>
                {
                    warn!(
                        destination = %remote,
                        error = %err,
                        "byte upload lost its SFTP channel, retrying once with a fresh channel"
                    );
                    let guard =
                        open_ephemeral_sftp(retry_state, &retry_app_handle, &retry_host_id).await?;
                    cursor.set_position(0);
                    upload_reader_to_remote_atomic(
                        guard.sftp().as_ref(),
                        &remote,
                        &mut cursor,
                        size_hint,
                        overwrite,
                        true,
                        cancel_for_body,
                        &mut progress_cb,
                    )
                    .await
                    .map_err(ssh_error)
                }
                Err(err) => Err(err),
            }
        },
    )
    .await;

    forget_transfer(&state, transfer_id);
    result
}

#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    max_bytes: Option<u64>,
) -> Result<RemoteTextFileDto, String> {
    let max_len = normalize_text_edit_limit(max_bytes);
    let path_for_op = path.clone();
    let (metadata, bytes) = with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path_for_op.clone();
        async move {
            let metadata = sftp.stat(&path).await.map_err(ssh_error)?;
            if metadata.kind != FileKind::File {
                return Err(string_error(format!("`{path}` is not a regular file")));
            }
            if metadata.size > max_len {
                return Err(string_error(format!(
                    "`{path}` is {} bytes, above editor limit {} bytes",
                    metadata.size, max_len
                )));
            }
            let bytes = sftp.download_to_vec(&path).await.map_err(ssh_error)?;
            Ok((metadata, bytes))
        }
    })
    .await?;

    if bytes.len() as u64 > max_len {
        return Err(string_error(format!(
            "`{path}` expanded to {} bytes, above editor limit {} bytes",
            bytes.len(),
            max_len
        )));
    }
    let (content, encoding) = decode_editor_text(&path, bytes)?;

    Ok(RemoteTextFileDto {
        path,
        size: metadata.size,
        content,
        encoding,
    })
}

#[tauri::command]
pub async fn sftp_permission_mode(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<FilePermissionModeDto, String> {
    let meta = with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        async move { sftp.stat(&path).await.map_err(ssh_error) }
    })
    .await?;
    Ok(FilePermissionModeDto {
        mode: meta.permissions_mode.map(|m| m & 0o7777),
    })
}

#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    content: String,
) -> Result<u64, String> {
    let bytes = content.into_bytes();
    let size = bytes.len() as u64;
    if size > HARD_TEXT_EDIT_MAX_BYTES {
        return Err(string_error(format!(
            "editor payload is {} bytes, above hard limit {} bytes",
            size, HARD_TEXT_EDIT_MAX_BYTES
        )));
    }

    with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        let bytes = bytes.clone();
        async move {
            upload_slice_to_remote_atomic(sftp.as_ref(), &path, &bytes, true, true)
                .await
                .map_err(ssh_error)
                .map(|_| ())
        }
    })
    .await?;
    Ok(size)
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
    mode: u32,
) -> Result<(), String> {
    with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        async move { sftp.chmod(&path, mode).await.map_err(ssh_error) }
    })
    .await
}

#[tauri::command]
pub async fn sftp_cancel_transfer(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    transfer_id: u64,
) -> Result<(), String> {
    let token = state.transfer_manager.token(transfer_id);
    if let Some(t) = token {
        t.cancel();
        state.transfer_manager.cancel(&app_handle, transfer_id);
        debug!(transfer_id, "transfer cancellation requested");
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        async move { sftp.remove_file(&path).await.map_err(ssh_error) }
    })
    .await
}

#[tauri::command]
pub async fn sftp_remove_dir(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    let (host_id, channel_id) = lookup_sftp_channel_info(&state, sftp_id)?;
    let sftp = lookup_sftp(&state, sftp_id)?;
    match sftp_remove_dir_recursive(&sftp, &path, Some((&app_handle, &state))).await {
        Ok(()) => Ok(()),
        Err(err) if is_retryable_transfer_error(&err) => {
            warn!(
                sftp_id,
                host_id = %host_id,
                channel_id,
                error = %err,
                "recursive delete lost its channel, refreshing and retrying once"
            );
            let refreshed = state
                .sftp_pool
                .refresh_channel(&host_id, channel_id)
                .await?;
            match refreshed.stat(&path).await {
                // The failed attempt may have finished server-side (e.g. a
                // timeout after the final rmdir was processed): gone is done.
                Err(SshError::Sftp {
                    kind: SftpErrorKind::NotFound,
                    ..
                }) => Ok(()),
                _ => sftp_remove_dir_recursive(&refreshed, &path, Some((&app_handle, &state))).await,
            }
        }
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    sftp_id: u64,
    from: String,
    to: String,
) -> Result<(), String> {
    with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let from = from.clone();
        let to = to.clone();
        async move { sftp.rename(&from, &to).await.map_err(ssh_error) }
    })
    .await
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    sftp_id: u64,
    path: String,
) -> Result<(), String> {
    with_resilient_panel_sftp(&state, sftp_id, |sftp| {
        let path = path.clone();
        async move { sftp.create_dir(&path).await.map_err(ssh_error) }
    })
    .await
}

#[tauri::command]
pub async fn sftp_copy_entry_between_panes(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    source_sftp_id: Option<u64>,
    source_path: String,
    destination_sftp_id: Option<u64>,
    destination_dir: String,
    overwrite: Option<bool>,
) -> Result<(), String> {
    let overwrite = overwrite.unwrap_or(false);
    let source_name = Path::new(&source_path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| string_error(format!("invalid source path: {source_path}")))?
        .to_string();

    if source_name == "." || source_name == ".." {
        return Err(string_error("cannot copy pseudo entry"));
    }

    match (source_sftp_id, destination_sftp_id) {
        (None, None) => {
            let src = PathBuf::from(&source_path);
            let dst_dir = PathBuf::from(&destination_dir);
            let dst = dst_dir.join(&source_name);

            let root_kind = detect_local_kind(&src)?;
            if root_kind == CopyNodeKind::Dir && is_local_path_within(&dst, &src)? {
                return Err(string_error("cannot copy a directory into itself"));
            }
            if root_kind == CopyNodeKind::Dir && !overwrite && dst.exists() {
                return Err(string_error(format!(
                    "destination already exists: {}",
                    dst.display()
                )));
            }
            copy_local_tree_to_local(
                &src,
                &dst,
                root_kind,
                overwrite,
                Some((&app_handle, &state)),
            )
            .await
        }
        (None, Some(dst_id)) => {
            let src = PathBuf::from(&source_path);
            let dst_host_id = lookup_sftp_host_id(&state, dst_id)?;
            let dst_channel = acquire_transfer_sftp(&state, &app_handle, dst_id).await?;
            let dst_sftp = dst_channel.sftp();
            let dst = remote_join_path(&destination_dir, &source_name);
            let root_kind = detect_local_kind(&src)?;
            if root_kind == CopyNodeKind::Dir && !overwrite {
                ensure_remote_target_available(dst_sftp.as_ref(), &dst).await?;
            }
            copy_local_tree_to_remote(
                &src,
                &dst_sftp,
                &dst,
                Some(dst_host_id.clone()),
                root_kind,
                overwrite,
                Some((&app_handle, &state)),
            )
            .await
        }
        (Some(src_id), None) => {
            let src_host_id = lookup_sftp_host_id(&state, src_id)?;
            let src_channel = acquire_transfer_sftp(&state, &app_handle, src_id).await?;
            let src_sftp = src_channel.sftp();
            let dst_dir = PathBuf::from(&destination_dir);
            let dst = dst_dir.join(&source_name);
            let meta = src_sftp.stat(&source_path).await.map_err(ssh_error)?;
            let root_kind = detect_remote_kind(&source_path, meta.kind)?;
            if root_kind == CopyNodeKind::Dir && !overwrite && dst.exists() {
                return Err(string_error(format!(
                    "destination already exists: {}",
                    dst.display()
                )));
            }
            copy_remote_tree_to_local(
                &src_sftp,
                &source_path,
                &dst,
                root_kind,
                overwrite,
                Some(src_host_id),
                Some((&app_handle, &state)),
            )
            .await
        }
        (Some(src_id), Some(dst_id)) => {
            let src_host_id = lookup_sftp_host_id(&state, src_id)?;
            let dst_host_id = lookup_sftp_host_id(&state, dst_id)?;
            let src_channel = acquire_transfer_sftp(&state, &app_handle, src_id).await?;
            let dst_channel = acquire_transfer_sftp(&state, &app_handle, dst_id).await?;
            let src_sftp = src_channel.sftp();
            let dst_sftp = dst_channel.sftp();
            let dst = remote_join_path(&destination_dir, &source_name);

            let meta = src_sftp.stat(&source_path).await.map_err(ssh_error)?;
            let root_kind = detect_remote_kind(&source_path, meta.kind)?;

            if root_kind == CopyNodeKind::Dir
                && remote_directory_copy_targets_source(
                    &src_host_id,
                    &dst_host_id,
                    &source_path,
                    &dst,
                )
            {
                return Err(string_error("cannot copy a directory into itself"));
            }
            if root_kind == CopyNodeKind::Dir && !overwrite {
                ensure_remote_target_available(dst_sftp.as_ref(), &dst).await?;
            }
            copy_remote_tree_to_remote(
                &src_sftp,
                &source_path,
                &dst_sftp,
                &dst,
                Some(src_host_id),
                Some(dst_host_id),
                root_kind,
                overwrite,
                Some((&app_handle, &state)),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_common_error_messages() {
        assert_eq!(
            classify_error_message("destination already exists"),
            "ALREADY_EXISTS"
        );
        assert_eq!(
            classify_error_message("permission denied"),
            "PERMISSION_DENIED"
        );
        assert_eq!(classify_error_message("no such file"), "NOT_FOUND");
        assert_eq!(classify_error_message("not a directory"), "NOT_A_DIRECTORY");
        assert_eq!(
            classify_error_message("channel closed by remote"),
            "CHANNEL_CLOSED"
        );
        assert_eq!(
            classify_error_message("ssh protocol error: Channel send error"),
            "CHANNEL_CLOSED"
        );
        assert_eq!(classify_error_message("transfer timed out"), "TIMEOUT");
        assert_eq!(
            classify_error_message("FileExists: /tmp/app.log"),
            "ALREADY_EXISTS"
        );
        assert_eq!(
            classify_error_message("拒绝访问: /root/secret"),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            classify_error_message("is a directory (os error 21)"),
            "UNSUPPORTED"
        );
    }

    #[test]
    fn remote_directory_self_copy_is_detected_across_panels_on_same_host() {
        assert!(remote_directory_copy_targets_source(
            "host-1",
            "host-1",
            "/srv/data",
            "/srv/data/archive/data",
        ));
        assert!(!remote_directory_copy_targets_source(
            "host-1",
            "host-2",
            "/srv/data",
            "/srv/data/archive/data",
        ));
    }

    #[test]
    fn string_error_round_trips_as_ipc_payload() {
        let payload = string_error("destination already exists: /tmp/file");
        let parsed = parse_ipc_error(&payload).expect("ipc payload");
        assert_eq!(parsed.code, "ALREADY_EXISTS");
        assert_eq!(parsed.message, "destination already exists: /tmp/file");
    }

    #[test]
    fn ssh_error_uses_structured_sftp_kind() {
        let payload = ssh_error(SshError::Sftp {
            kind: SftpErrorKind::PermissionDenied,
            message: "permission denied: /root".to_string(),
        });
        let parsed = parse_ipc_error(&payload).expect("ipc payload");
        assert_eq!(parsed.code, "PERMISSION_DENIED");
        assert_eq!(parsed.message, "permission denied: /root");
    }

    #[test]
    fn ssh_error_recovers_disconnect_from_generic_sftp_kind() {
        let payload = ssh_error(SshError::Sftp {
            kind: SftpErrorKind::Other,
            message: "ssh protocol error: Channel send error".to_string(),
        });
        let parsed = parse_ipc_error(&payload).expect("ipc payload");
        assert_eq!(parsed.code, "CHANNEL_CLOSED");
    }
}
