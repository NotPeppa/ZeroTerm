use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;
use tracing::warn;

use crate::sftp::path::{remote_join_path, validate_remote_leaf_name};
use crate::sftp::transfer::{
    acquire_transfer_slot, forget_transfer, register_transfer, run_with_progress, ProgressMode,
};
use crate::sftp::{open_ephemeral_sftp, parse_ipc_error, ssh_error, string_error};
use crate::state::AppState;

const STALE_SFTP_TEMP_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTempFileDto {
    pub relative_path: String,
    pub absolute_path: String,
}

fn unique_sibling_path(target: &Path, tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("download");
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!(".{file_name}.zeroterm-{tag}-{pid}-{nanos:x}.part"))
}

fn unique_remote_temp_path(target: &str, tag: &str) -> String {
    let unique = uuid::Uuid::new_v4().to_string();
    format!("{target}.zeroterm-{tag}-{unique}")
}

fn is_zeroterm_local_transfer_temp_name(name: &str) -> bool {
    (name.contains(".zeroterm-download-") || name.contains(".zeroterm-backup-"))
        && name.ends_with(".part")
}

fn is_zeroterm_remote_transfer_temp_name(name: &str) -> bool {
    [".zeroterm-part-", ".zeroterm-backup-"]
        .iter()
        .any(|marker| {
            name.rfind(marker)
                .map(|idx| uuid::Uuid::parse_str(&name[idx + marker.len()..]).is_ok())
                .unwrap_or(false)
        })
}

fn is_stale_modified_time(modified: SystemTime, now: SystemTime) -> bool {
    now.duration_since(modified)
        .map(|age| age >= STALE_SFTP_TEMP_TTL)
        .unwrap_or(false)
}

fn cleanup_old_files_in_dir<F>(dir: &Path, mut should_consider: F) -> Result<usize, String>
where
    F: FnMut(&str) -> bool,
{
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Ok(0);
    };
    let now = SystemTime::now();
    let mut removed = 0usize;
    for item in read_dir {
        let entry = match item {
            Ok(entry) => entry,
            Err(err) => {
                warn!(path = %dir.display(), error = %err, "failed to read SFTP temp dir entry");
                continue;
            }
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !should_consider(&name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => continue,
            Err(err) => {
                warn!(path = %path.display(), error = %err, "failed to stat SFTP temp file");
                continue;
            }
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if !is_stale_modified_time(modified, now) {
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => removed += 1,
            Err(err) => {
                warn!(path = %path.display(), error = %err, "failed to remove stale SFTP temp file");
            }
        }
    }
    Ok(removed)
}

pub(crate) fn cleanup_local_sftp_temp_files(
    app_handle: &tauri::AppHandle,
) -> Result<usize, String> {
    let mut removed = 0usize;

    let app_cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache dir: {e}"))?;
    removed += cleanup_old_files_in_dir(&app_cache_dir.join("sftp-upload-stage"), |_| true)?;

    removed +=
        cleanup_old_files_in_dir(&std::env::temp_dir().join("zeroterm-open-with"), |_| true)?;

    Ok(removed)
}

fn cleanup_stale_local_transfer_temps_for_target(target: &Path) {
    let Some(parent) = target.parent() else {
        return;
    };
    if let Err(err) = cleanup_old_files_in_dir(parent, is_zeroterm_local_transfer_temp_name) {
        warn!(
            path = %parent.display(),
            error = %err,
            "failed to clean local SFTP transfer temp files"
        );
    }
}

pub(crate) async fn cleanup_stale_remote_temp_entries(
    sftp: &zeroterm_ssh::Sftp,
    dir: &str,
    entries: &mut Vec<zeroterm_ssh::DirEntry>,
) {
    let now_ms = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(dur) => dur.as_millis() as i64,
        Err(_) => return,
    };
    let ttl_ms = STALE_SFTP_TEMP_TTL.as_millis() as i64;
    let mut removed_names = HashSet::new();

    for entry in entries.iter() {
        if entry.kind != zeroterm_ssh::FileKind::File
            || !is_zeroterm_remote_transfer_temp_name(&entry.name)
            || validate_remote_leaf_name(&entry.name).is_err()
        {
            continue;
        }
        let Some(modified_ms) = entry.modified_unix_ms else {
            continue;
        };
        if now_ms.saturating_sub(modified_ms) < ttl_ms {
            continue;
        }

        let remote_path = remote_join_path(dir, &entry.name);
        match sftp.remove_file(&remote_path).await {
            Ok(()) => {
                removed_names.insert(entry.name.clone());
            }
            Err(err) if is_remote_not_found(&err) => {
                removed_names.insert(entry.name.clone());
            }
            Err(err) => {
                warn!(
                    path = %remote_path,
                    error = %err,
                    "failed to remove stale remote SFTP temp file"
                );
            }
        }
    }

    if !removed_names.is_empty() {
        entries.retain(|entry| !removed_names.contains(&entry.name));
    }
}

fn is_remote_not_found(err: &zeroterm_ssh::SshError) -> bool {
    matches!(
        err,
        zeroterm_ssh::SshError::Sftp {
            kind: zeroterm_ssh::SftpErrorKind::NotFound,
            ..
        }
    )
}

async fn remote_path_exists(
    sftp: &zeroterm_ssh::Sftp,
    path: &str,
) -> Result<bool, zeroterm_ssh::SshError> {
    match sftp.stat(path).await {
        Ok(_) => Ok(true),
        Err(err) if is_remote_not_found(&err) => Ok(false),
        Err(err) => Err(err),
    }
}

/// Probe the destination before a transfer is registered so an expected
/// conflict surfaces as a plain command error instead of a failed transfer
/// in the dock. Callers that pass this check should skip the in-transfer
/// overwrite check (`skip_overwrite_check = true`) to avoid a second stat.
pub(crate) async fn ensure_remote_target_available(
    sftp: &zeroterm_ssh::Sftp,
    target: &str,
) -> Result<(), String> {
    if remote_path_exists(sftp, target).await.map_err(ssh_error)? {
        return Err(ssh_error(zeroterm_ssh::SshError::Sftp {
            kind: zeroterm_ssh::SftpErrorKind::AlreadyExists,
            message: format!("destination already exists: {target}"),
        }));
    }
    Ok(())
}

async fn finalize_remote_upload_target(
    sftp: &zeroterm_ssh::Sftp,
    temp_path: &str,
    target: &str,
    overwrite: bool,
) -> Result<(), zeroterm_ssh::SshError> {
    if !overwrite || !remote_path_exists(sftp, target).await? {
        return sftp.rename(temp_path, target).await;
    }

    let target_meta = sftp.stat(target).await?;
    if target_meta.kind != zeroterm_ssh::FileKind::File {
        return Err(zeroterm_ssh::SshError::Sftp {
            kind: zeroterm_ssh::SftpErrorKind::Unsupported,
            message: format!("destination is not a regular file: {target}"),
        });
    }

    match sftp.rename(temp_path, target).await {
        Ok(()) => return Ok(()),
        Err(err) => {
            let temp_still_exists = remote_path_exists(sftp, temp_path).await.unwrap_or(false);
            let target_still_exists = remote_path_exists(sftp, target).await.unwrap_or(false);
            if !temp_still_exists || !target_still_exists {
                return Err(err);
            }
        }
    }

    let backup_path = unique_remote_temp_path(target, "backup");
    sftp.rename(target, &backup_path).await?;
    match sftp.rename(temp_path, target).await {
        Ok(()) => {
            let _ = sftp.remove_file(&backup_path).await;
            Ok(())
        }
        Err(err) => {
            let _ = sftp.rename(&backup_path, target).await;
            Err(err)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_reader_to_remote_atomic<R, F>(
    sftp: &zeroterm_ssh::Sftp,
    target: &str,
    src: &mut R,
    size_hint: Option<u64>,
    overwrite: bool,
    skip_overwrite_check: bool,
    cancel: tokio_util::sync::CancellationToken,
    on_progress: F,
) -> Result<u64, zeroterm_ssh::SshError>
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(zeroterm_ssh::ProgressTick),
{
    if !skip_overwrite_check && !overwrite && remote_path_exists(sftp, target).await? {
        return Err(zeroterm_ssh::SshError::Sftp {
            kind: zeroterm_ssh::SftpErrorKind::AlreadyExists,
            message: format!("destination already exists: {target}"),
        });
    }

    let temp_target = unique_remote_temp_path(target, "part");
    let upload_result = sftp
        .upload_from_reader(
            &temp_target,
            src,
            zeroterm_ssh::DEFAULT_UPLOAD_CHUNK,
            size_hint,
            cancel,
            on_progress,
        )
        .await;

    match upload_result {
        Ok(bytes_done) => {
            if let Err(err) =
                finalize_remote_upload_target(sftp, &temp_target, target, overwrite).await
            {
                let _ = sftp.remove_file(&temp_target).await;
                Err(err)
            } else {
                Ok(bytes_done)
            }
        }
        Err(err) => {
            let _ = sftp.remove_file(&temp_target).await;
            Err(err)
        }
    }
}

pub(crate) async fn upload_slice_to_remote_atomic(
    sftp: &zeroterm_ssh::Sftp,
    target: &str,
    data: &[u8],
    overwrite: bool,
    skip_overwrite_check: bool,
) -> Result<u64, zeroterm_ssh::SshError> {
    let mut cursor = std::io::Cursor::new(data);
    upload_reader_to_remote_atomic(
        sftp,
        target,
        &mut cursor,
        Some(data.len() as u64),
        overwrite,
        skip_overwrite_check,
        tokio_util::sync::CancellationToken::new(),
        |_| {},
    )
    .await
}

pub(crate) fn is_retryable_transfer_error(err: &str) -> bool {
    if let Some(parsed) = parse_ipc_error(err) {
        return matches!(parsed.code.as_str(), "CHANNEL_CLOSED" | "TIMEOUT")
            || is_retryable_transfer_error(&parsed.message);
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn upload_local_path_to_remote_once<F>(
    sftp: &zeroterm_ssh::Sftp,
    source: &Path,
    target: &str,
    size_hint: Option<u64>,
    overwrite: bool,
    skip_overwrite_check: bool,
    cancel: tokio_util::sync::CancellationToken,
    on_progress: &mut F,
) -> Result<u64, zeroterm_ssh::SshError>
where
    F: FnMut(zeroterm_ssh::ProgressTick) + Send,
{
    let mut file = tokio::fs::File::open(source)
        .await
        .map_err(zeroterm_ssh::SshError::Io)?;
    upload_reader_to_remote_atomic(
        sftp,
        target,
        &mut file,
        size_hint,
        overwrite,
        skip_overwrite_check,
        cancel,
        on_progress,
    )
    .await
}

#[tauri::command]
pub async fn prepare_staging_upload_path(
    app_handle: tauri::AppHandle,
    file_name: String,
) -> Result<LocalTempFileDto, String> {
    let safe_name = Path::new(&file_name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("upload.bin");
    let app_cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("resolve app cache dir: {e}"))?;
    let stage_dir = app_cache_dir.join("sftp-upload-stage");
    std::fs::create_dir_all(&stage_dir)
        .map_err(|e| format!("mkdir {}: {e}", stage_dir.display()))?;

    let stem = Path::new(safe_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("upload");
    let ext = Path::new(safe_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let unique = uuid::Uuid::new_v4().to_string();
    let target_name = if ext.is_empty() {
        format!("{stem}-{unique}")
    } else {
        format!("{stem}-{unique}.{ext}")
    };
    let absolute_path = stage_dir.join(&target_name);
    let relative_path = PathBuf::from("sftp-upload-stage")
        .join(&target_name)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(LocalTempFileDto {
        relative_path,
        absolute_path: absolute_path.to_string_lossy().to_string(),
    })
}

async fn download_remote_file_to_temp_once<F>(
    sftp: &zeroterm_ssh::Sftp,
    source: &str,
    temp_path: &Path,
    cancel: tokio_util::sync::CancellationToken,
    on_progress: &mut F,
) -> Result<u64, zeroterm_ssh::SshError>
where
    F: FnMut(zeroterm_ssh::ProgressTick) + Send,
{
    // Remove any leftover from a previous attempt (the retry path reuses this
    // exact temp path), then create with O_EXCL so a pre-planted symlink at
    // the temp path fails instead of being followed and written through. If an
    // attacker re-plants a symlink in the tiny window after the remove,
    // `create_new` still refuses it (EEXIST). See TAURI-9.
    let _ = tokio::fs::remove_file(temp_path).await;
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .await
        .map_err(zeroterm_ssh::SshError::Io)?;
    let mut file = tokio::io::BufWriter::new(file);
    sftp.download_to_writer_parallel(
        source,
        &mut file,
        zeroterm_ssh::DEFAULT_CHUNK,
        zeroterm_ssh::DEFAULT_DOWNLOAD_PARALLELISM,
        cancel,
        on_progress,
    )
    .await
}

async fn finalize_download_target(
    temp_path: &Path,
    target: &Path,
    overwrite: bool,
) -> Result<(), String> {
    if !overwrite || !target.exists() {
        return tokio::fs::rename(temp_path, target).await.map_err(|e| {
            format!(
                "rename {} -> {}: {e}",
                temp_path.display(),
                target.display()
            )
        });
    }

    let target_meta = tokio::fs::metadata(target).await.map_err(|e| {
        format!(
            "stating destination before overwrite {}: {e}",
            target.display()
        )
    })?;
    if !target_meta.is_file() {
        return Err(string_error(format!(
            "destination is not a regular file: {}",
            target.display()
        )));
    }

    match tokio::fs::rename(temp_path, target).await {
        Ok(()) => return Ok(()),
        Err(err) => {
            if !temp_path.exists() || !target.exists() {
                return Err(format!(
                    "rename {} -> {}: {err}",
                    temp_path.display(),
                    target.display()
                ));
            }
        }
    }

    let backup_path = unique_sibling_path(target, "backup");
    tokio::fs::rename(target, &backup_path).await.map_err(|e| {
        format!(
            "rename {} -> {}: {e}",
            target.display(),
            backup_path.display()
        )
    })?;

    match tokio::fs::rename(temp_path, target).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&backup_path).await;
            Ok(())
        }
        Err(e) => {
            let _ = tokio::fs::rename(&backup_path, target).await;
            Err(format!(
                "rename {} -> {}: {e}",
                temp_path.display(),
                target.display()
            ))
        }
    }
}

pub(crate) async fn download_remote_file_to_local(
    source_sftp: Arc<zeroterm_ssh::Sftp>,
    source: String,
    target: PathBuf,
    overwrite: bool,
    retry_host_id: Option<&str>,
    progress: ProgressMode<'_>,
) -> Result<u64, String> {
    if target.exists() && !overwrite {
        return Err(string_error(format!(
            "destination already exists: {}",
            target.display()
        )));
    }

    cleanup_stale_local_transfer_temps_for_target(&target);
    let temp_path = unique_sibling_path(&target, "download");
    let result = match progress {
        ProgressMode::Standalone { app, state } => {
            let destination = target.display().to_string();
            let temp_path_for_transfer = temp_path.clone();
            let target_for_retry = target.clone();
            let (transfer_id, cancel) = register_transfer(
                state,
                app,
                "download",
                source.clone(),
                destination,
                None,
            );
            let _permit = acquire_transfer_slot(state, app, transfer_id).await?;
            let cancel_for_body = cancel.clone();
            let result = run_with_progress(
                app,
                state,
                transfer_id,
                move |progress_cb| async move {
                    let mut progress_cb = progress_cb;
                    let first = download_remote_file_to_temp_once(
                        source_sftp.as_ref(),
                        &source,
                        &temp_path_for_transfer,
                        cancel_for_body.clone(),
                        &mut progress_cb,
                    )
                    .await
                    .map_err(ssh_error);
                    match first {
                        Ok(bytes) => Ok(bytes),
                        Err(err)
                            if !cancel_for_body.is_cancelled()
                                && retry_host_id.is_some()
                                && is_retryable_transfer_error(&err) =>
                        {
                            warn!(
                                source = %source,
                                destination = %target_for_retry.display(),
                                error = %err,
                                "download lost its SFTP channel, retrying once with a fresh channel"
                            );
                            let guard = open_ephemeral_sftp(
                                state,
                                app,
                                retry_host_id.expect("checked above"),
                            )
                            .await?;
                            download_remote_file_to_temp_once(
                                guard.sftp().as_ref(),
                                &source,
                                &temp_path_for_transfer,
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
            forget_transfer(state, transfer_id);
            result
        }
        ProgressMode::Aggregate(sink) => {
            let cancel = sink.cancel_token();
            let source_label = source.clone();
            let app_handle = sink.app_handle.clone();
            let sink_for_progress = sink.clone();
            let attempt_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let attempt_bytes_for_progress = Arc::clone(&attempt_bytes);
            let first = download_remote_file_to_temp_once(
                source_sftp.as_ref(),
                &source,
                &temp_path,
                cancel.clone(),
                &mut move |tick| {
                    use std::sync::atomic::Ordering;
                    let prev = attempt_bytes_for_progress.swap(tick.bytes_done, Ordering::SeqCst);
                    let delta = tick.bytes_done.saturating_sub(prev);
                    if delta > 0 {
                        sink_for_progress.add_bytes(delta, &source_label);
                    }
                },
            )
            .await
            .map_err(ssh_error);
            match first {
                Ok(bytes) => Ok(bytes),
                Err(err)
                    if !cancel.is_cancelled()
                        && retry_host_id.is_some()
                        && is_retryable_transfer_error(&err) =>
                {
                    let attempt_done = attempt_bytes.load(std::sync::atomic::Ordering::SeqCst);
                    if attempt_done > 0 {
                        sink.rewind_bytes(attempt_done);
                    }
                    warn!(
                        source = %source,
                        destination = %target.display(),
                        error = %err,
                        "aggregate download lost its SFTP channel, retrying current file once"
                    );
                    let state = app_handle.state::<AppState>();
                    let guard = open_ephemeral_sftp(
                        &state,
                        &app_handle,
                        retry_host_id.expect("checked above"),
                    )
                    .await?;
                    attempt_bytes.store(0, std::sync::atomic::Ordering::SeqCst);
                    let source_label = source.clone();
                    let sink_for_retry = sink.clone();
                    let attempt_bytes_for_retry = Arc::clone(&attempt_bytes);
                    download_remote_file_to_temp_once(
                        guard.sftp().as_ref(),
                        &source,
                        &temp_path,
                        cancel,
                        &mut move |tick| {
                            use std::sync::atomic::Ordering;
                            let prev =
                                attempt_bytes_for_retry.swap(tick.bytes_done, Ordering::SeqCst);
                            let delta = tick.bytes_done.saturating_sub(prev);
                            if delta > 0 {
                                sink_for_retry.add_bytes(delta, &source_label);
                            }
                        },
                    )
                    .await
                    .map_err(ssh_error)
                }
                Err(err) => Err(err),
            }
        }
        ProgressMode::None => download_remote_file_to_temp_once(
            source_sftp.as_ref(),
            &source,
            &temp_path,
            tokio_util::sync::CancellationToken::new(),
            &mut |_| {},
        )
        .await
        .map_err(ssh_error),
    };

    let bytes = match result {
        Ok(bytes) => bytes,
        Err(err) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(err);
        }
    };

    if let Err(err) = finalize_download_target(&temp_path, &target, overwrite).await {
        let _ = tokio::fs::remove_file(&temp_path).await;
        return Err(err);
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retryable_transfer_error_detects_structured_codes() {
        let payload = crate::sftp::ipc_error("CHANNEL_CLOSED", "channel closed by remote");
        assert!(is_retryable_transfer_error(&payload));

        let payload = crate::sftp::ipc_error("TIMEOUT", "transfer timed out");
        assert!(is_retryable_transfer_error(&payload));

        let payload = crate::sftp::ipc_error("OTHER", "ssh protocol error: Channel send error");
        assert!(is_retryable_transfer_error(&payload));

        let payload = crate::sftp::ipc_error("PERMISSION_DENIED", "permission denied");
        assert!(!is_retryable_transfer_error(&payload));
    }

    #[test]
    fn retryable_transfer_error_detects_plaintext_fallbacks() {
        assert!(is_retryable_transfer_error("broken pipe while uploading"));
        assert!(is_retryable_transfer_error("connection reset by peer"));
        assert!(is_retryable_transfer_error("operation timed out"));
        assert!(!is_retryable_transfer_error("permission denied"));
    }

    #[test]
    fn unique_sibling_path_stays_in_same_parent() {
        let target = Path::new("/tmp/example.txt");
        let temp = unique_sibling_path(target, "download");
        assert_eq!(temp.parent(), target.parent());
        assert!(temp
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap()
            .contains(".example.txt."));
        assert!(temp.to_string_lossy().contains("zeroterm-download"));
    }

    #[test]
    fn unique_remote_temp_path_appends_tagged_suffix() {
        let temp = unique_remote_temp_path("/var/log/app.log", "part");
        assert!(temp.starts_with("/var/log/app.log.zeroterm-part-"));
        assert_ne!(temp, "/var/log/app.log");
    }

    #[test]
    fn temp_name_detection_is_zero_term_specific() {
        let remote = format!("app.log.zeroterm-part-{}", uuid::Uuid::new_v4());
        assert!(is_zeroterm_remote_transfer_temp_name(&remote));
        assert!(!is_zeroterm_remote_transfer_temp_name(
            "app.log.zeroterm-part-not-a-uuid"
        ));
        assert!(!is_zeroterm_remote_transfer_temp_name("user.zeroterm-note"));

        assert!(is_zeroterm_local_transfer_temp_name(
            ".app.log.zeroterm-download-123-abc.part"
        ));
        assert!(is_zeroterm_local_transfer_temp_name(
            ".app.log.zeroterm-backup-123-abc.part"
        ));
        assert!(!is_zeroterm_local_transfer_temp_name(
            ".app.log.zeroterm-download-123-abc"
        ));
    }

    #[test]
    fn stale_temp_detection_uses_ttl() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(48 * 60 * 60);
        assert!(is_stale_modified_time(
            now - STALE_SFTP_TEMP_TTL - Duration::from_secs(1),
            now
        ));
        assert!(!is_stale_modified_time(now - Duration::from_secs(60), now));
    }
}
