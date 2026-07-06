use std::collections::HashSet;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures_util::stream::StreamExt;
use tauri::{AppHandle, Manager};
use tracing::warn;
use zeroterm_ssh::Sftp;

use crate::sftp::file::{
    download_remote_file_to_local, ensure_remote_target_available, is_retryable_transfer_error,
    upload_local_path_to_remote_once, upload_reader_to_remote_atomic,
};
use crate::sftp::path::{
    detect_local_kind, detect_remote_kind, normalize_remote_path, remote_join_path, CopyNodeKind,
};
use crate::sftp::pool::SftpChannelGuard;
use crate::sftp::transfer::{
    acquire_transfer_slot, forget_transfer, register_transfer, run_tree_transfer,
    run_with_progress, ProgressMode, TransferSink,
};
use crate::sftp::{ipc_error, open_ephemeral_sftp, parse_ipc_error, ssh_error, string_error};
use crate::state::AppState;

/// Number of files downloaded concurrently when recursively pulling a remote
/// directory to local. Bounds round-trip stacking for many-small-files trees
/// without overwhelming the server's `MaxSessions` or local disk.
const DIR_DOWNLOAD_CONCURRENCY: usize = 4;

/// Number of independent target SFTP workers used when recursively pushing a
/// directory to a remote. Each worker owns its own SFTP channel/session and
/// uploads one file at a time; this keeps concurrency without interleaving
/// multiple file writes on a single fragile channel.
const DIR_UPLOAD_WORKERS: usize = 3;

#[derive(Debug, Clone)]
pub(crate) struct TransferIssue {
    path: String,
    error: String,
}

pub(crate) fn is_fatal_tree_error(err: &str) -> bool {
    if let Some(parsed) = parse_ipc_error(err) {
        match parsed.code.as_str() {
            "CHANNEL_CLOSED" | "TIMEOUT" => return true,
            _ => return is_fatal_tree_error(&parsed.message),
        }
    }

    let lower = err.to_ascii_lowercase();
    lower.contains("channel closed")
        || lower.contains("broken pipe")
        || lower.contains("connection lost")
        || lower.contains("connection reset")
        || lower.contains("no connection")
        || lower.contains("session closed")
        || lower.contains("timed out")
        || lower.contains("timeout")
        || lower.contains("transfer stalled")
}

pub(crate) fn record_transfer_issue(
    issues: &Mutex<Vec<TransferIssue>>,
    path: String,
    error: String,
) {
    issues.lock().unwrap().push(TransferIssue { path, error });
}

pub(crate) fn finish_transfer_issues(issues: &Mutex<Vec<TransferIssue>>) -> Result<(), String> {
    let issues = issues.lock().unwrap();
    if issues.is_empty() {
        return Ok(());
    }

    let total = issues.len();
    let preview = issues
        .iter()
        .take(5)
        .map(|issue| format!("{} ({})", issue.path, display_issue_error(&issue.error)))
        .collect::<Vec<_>>()
        .join("; ");
    let more = total.saturating_sub(5);
    if more > 0 {
        Err(string_error(format!(
            "completed with {total} skipped item(s): {preview}; and {more} more"
        )))
    } else {
        Err(string_error(format!(
            "completed with {total} skipped item(s): {preview}"
        )))
    }
}

pub(crate) fn merge_transfer_issue_result(
    issues: &Mutex<Vec<TransferIssue>>,
    worker_result: Result<(), String>,
) -> Result<(), String> {
    match (finish_transfer_issues(issues), worker_result) {
        (_, Err(err)) => Err(err),
        (Err(summary), Ok(())) => Err(summary),
        (Ok(()), Ok(())) => Ok(()),
    }
}

pub(crate) struct PlannedTreeCopy<Job> {
    pub(crate) file_jobs: Vec<Job>,
    pub(crate) total_bytes: u64,
    pub(crate) issues: Vec<TransferIssue>,
}

pub(crate) async fn ensure_remote_dir_exists(sftp: &Sftp, path: &str) -> Result<bool, String> {
    match sftp.create_dir(path).await {
        Ok(()) => Ok(true),
        Err(mkdir_err) => match sftp.stat(path).await {
            Ok(meta) if meta.kind == zeroterm_ssh::FileKind::Dir => Ok(false),
            Ok(_) => Err(string_error(format!(
                "destination is not a directory: {path}"
            ))),
            Err(stat_err) => Err(contextualize_error(
                format!(
                    "mkdir {path}: {}",
                    display_issue_error(&ssh_error(mkdir_err))
                ),
                ssh_error(stat_err),
                "stat after mkdir failed",
            )),
        },
    }
}

pub(crate) async fn remote_existing_names(
    sftp: &Sftp,
    path: &str,
    known_empty: bool,
) -> Result<HashSet<String>, String> {
    if known_empty {
        return Ok(HashSet::new());
    }
    sftp.list(path)
        .await
        .map_err(|e| contextualize_error(format!("list {path}"), ssh_error(e), ""))
        .map(|entries| entries.into_iter().map(|entry| entry.name).collect())
}

pub(crate) async fn plan_local_to_remote_copy<F>(
    source: &Path,
    target: &str,
    target_sftp: &Sftp,
    overwrite: bool,
    note_path: Option<&F>,
) -> Result<PlannedTreeCopy<(PathBuf, String)>, String>
where
    F: Fn(&str) + Send + Sync + ?Sized,
{
    let issues = Mutex::new(Vec::<TransferIssue>::new());
    let mut file_jobs = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut stack: Vec<(PathBuf, String, bool)> =
        vec![(source.to_path_buf(), target.to_string(), false)];

    while let Some((src_dir, dst_dir, dst_fresh)) = stack.pop() {
        if let Some(note) = note_path {
            note(&src_dir.display().to_string());
        }
        let existing = match remote_existing_names(target_sftp, &dst_dir, dst_fresh).await {
            Ok(existing) => existing,
            Err(err) => {
                if is_fatal_tree_error(&err) {
                    return Err(err);
                }
                record_transfer_issue(&issues, src_dir.display().to_string(), err);
                continue;
            }
        };
        let rd = match fs::read_dir(&src_dir) {
            Ok(rd) => rd,
            Err(e) => {
                let err = format!("read_dir {}: {e}", src_dir.display());
                if is_fatal_tree_error(&err) {
                    return Err(err);
                }
                record_transfer_issue(&issues, src_dir.display().to_string(), err);
                continue;
            }
        };
        for item in rd {
            let entry = match item {
                Ok(entry) => entry,
                Err(e) => {
                    let err = format!("read_dir entry {}: {e}", src_dir.display());
                    if is_fatal_tree_error(&err) {
                        return Err(err);
                    }
                    record_transfer_issue(&issues, src_dir.display().to_string(), err);
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let child_src = entry.path();
            let child_dst = remote_join_path(&dst_dir, &name);
            let kind = match detect_local_kind(&child_src) {
                Ok(kind) => kind,
                Err(err) => {
                    record_transfer_issue(&issues, child_src.display().to_string(), err);
                    continue;
                }
            };
            match kind {
                CopyNodeKind::File => {
                    if !overwrite && existing.contains(&name) {
                        record_transfer_issue(
                            &issues,
                            child_src.display().to_string(),
                            string_error(format!("destination already exists: {child_dst}")),
                        );
                        continue;
                    }
                    if let Ok(meta) = entry.metadata() {
                        total_bytes = total_bytes.saturating_add(meta.len());
                    }
                    file_jobs.push((child_src, child_dst));
                }
                CopyNodeKind::Dir => {
                    let fresh = match ensure_remote_dir_exists(target_sftp, &child_dst).await {
                        Ok(fresh) => fresh,
                        Err(err) => {
                            if is_fatal_tree_error(&err) {
                                return Err(err);
                            }
                            record_transfer_issue(&issues, child_src.display().to_string(), err);
                            continue;
                        }
                    };
                    stack.push((child_src, child_dst, fresh));
                }
            }
        }
    }

    Ok(PlannedTreeCopy {
        file_jobs,
        total_bytes,
        issues: issues.into_inner().unwrap(),
    })
}

pub(crate) async fn plan_remote_to_remote_copy<F>(
    source: &str,
    target: &str,
    source_sftp: &Sftp,
    target_sftp: &Sftp,
    overwrite: bool,
    note_path: Option<&F>,
) -> Result<PlannedTreeCopy<(String, String)>, String>
where
    F: Fn(&str) + Send + Sync + ?Sized,
{
    let issues = Mutex::new(Vec::<TransferIssue>::new());
    let mut file_jobs = Vec::new();
    let mut total_bytes: u64 = 0;
    let mut stack: Vec<(String, String, bool)> =
        vec![(source.to_string(), target.to_string(), false)];

    while let Some((src_dir, dst_dir, dst_fresh)) = stack.pop() {
        if let Some(note) = note_path {
            note(&src_dir);
        }
        let existing = match remote_existing_names(target_sftp, &dst_dir, dst_fresh).await {
            Ok(existing) => existing,
            Err(err) => {
                if is_fatal_tree_error(&err) {
                    return Err(err);
                }
                record_transfer_issue(&issues, src_dir.clone(), err);
                continue;
            }
        };
        let entries = match source_sftp.list(&src_dir).await {
            Ok(entries) => entries,
            Err(err) => {
                let err = ssh_error(err);
                if is_fatal_tree_error(&err) {
                    return Err(err);
                }
                record_transfer_issue(&issues, src_dir.clone(), err);
                continue;
            }
        };
        for entry in entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child_src = remote_join_path(&src_dir, &entry.name);
            let child_dst = remote_join_path(&dst_dir, &entry.name);
            let kind = match detect_remote_kind(&child_src, entry.kind) {
                Ok(kind) => kind,
                Err(err) => {
                    record_transfer_issue(&issues, child_src.clone(), err);
                    continue;
                }
            };
            match kind {
                CopyNodeKind::File => {
                    if !overwrite && existing.contains(&entry.name) {
                        record_transfer_issue(
                            &issues,
                            child_src.clone(),
                            string_error(format!("destination already exists: {child_dst}")),
                        );
                        continue;
                    }
                    total_bytes = total_bytes.saturating_add(entry.size);
                    file_jobs.push((child_src, child_dst));
                }
                CopyNodeKind::Dir => {
                    let fresh = match ensure_remote_dir_exists(target_sftp, &child_dst).await {
                        Ok(fresh) => fresh,
                        Err(err) => {
                            if is_fatal_tree_error(&err) {
                                return Err(err);
                            }
                            record_transfer_issue(&issues, child_src.clone(), err);
                            continue;
                        }
                    };
                    stack.push((child_src, child_dst, fresh));
                }
            }
        }
    }

    Ok(PlannedTreeCopy {
        file_jobs,
        total_bytes,
        issues: issues.into_inner().unwrap(),
    })
}

pub(crate) async fn copy_local_tree_to_local(
    source: &Path,
    target: &Path,
    root_kind: CopyNodeKind,
    overwrite: bool,
    progress_ctx: Option<(&AppHandle, &AppState)>,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            let progress = match progress_ctx {
                Some((app, state)) => ProgressMode::Standalone { app, state },
                None => ProgressMode::None,
            };
            stream_local_file_to_local(
                source.to_path_buf(),
                target.to_path_buf(),
                overwrite,
                progress,
            )
            .await
        }
        CopyNodeKind::Dir => {
            if !target.exists() {
                fs::create_dir_all(target)
                    .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            }

            let source = source.to_path_buf();
            let target = target.to_path_buf();

            run_tree_transfer(
                progress_ctx,
                "copy",
                source.display().to_string(),
                target.display().to_string(),
                move |sink_opt| async move {
                    let issues = Mutex::new(Vec::<TransferIssue>::new());
                    let mut file_jobs: Vec<(PathBuf, PathBuf)> = Vec::new();
                    let mut total_bytes: u64 = 0;
                    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(source.clone(), target.clone())];
                    while let Some((src_dir, dst_dir)) = stack.pop() {
                        if let Some(sink) = &sink_opt {
                            sink.note_path(&src_dir.display().to_string());
                        }
                        let rd = match fs::read_dir(&src_dir) {
                            Ok(rd) => rd,
                            Err(e) => {
                                let err = format!("read_dir {}: {e}", src_dir.display());
                                if is_fatal_tree_error(&err) {
                                    return Err(err);
                                }
                                record_transfer_issue(&issues, src_dir.display().to_string(), err);
                                continue;
                            }
                        };
                        for item in rd {
                            let entry = match item {
                                Ok(entry) => entry,
                                Err(e) => {
                                    let err = format!("read_dir entry {}: {e}", src_dir.display());
                                    if is_fatal_tree_error(&err) {
                                        return Err(err);
                                    }
                                    record_transfer_issue(
                                        &issues,
                                        src_dir.display().to_string(),
                                        err,
                                    );
                                    continue;
                                }
                            };
                            let name = entry.file_name();
                            let child_src = entry.path();
                            let child_dst = dst_dir.join(&name);
                            let kind = match detect_local_kind(&child_src) {
                                Ok(kind) => kind,
                                Err(err) => {
                                    record_transfer_issue(
                                        &issues,
                                        child_src.display().to_string(),
                                        err,
                                    );
                                    continue;
                                }
                            };
                            match kind {
                                CopyNodeKind::File => {
                                    if let Ok(meta) = entry.metadata() {
                                        total_bytes = total_bytes.saturating_add(meta.len());
                                    }
                                    file_jobs.push((child_src, child_dst));
                                }
                                CopyNodeKind::Dir => {
                                    if !child_dst.exists() {
                                        if let Err(e) = fs::create_dir_all(&child_dst) {
                                            let err = format!("mkdir {}: {e}", child_dst.display());
                                            if is_fatal_tree_error(&err) {
                                                return Err(err);
                                            }
                                            record_transfer_issue(
                                                &issues,
                                                child_src.display().to_string(),
                                                err,
                                            );
                                            continue;
                                        }
                                    }
                                    stack.push((child_src, child_dst));
                                }
                            }
                        }
                    }

                    if let Some(sink) = &sink_opt {
                        sink.set_total(total_bytes);
                        sink.set_files_total(file_jobs.len() as u64);
                    }

                    let issues = Arc::new(issues);
                    let mut stream = futures_util::stream::iter(file_jobs.into_iter().map(
                        |(child_src, child_dst)| {
                            let sink_opt = sink_opt.clone();
                            async move {
                                if let Some(s) = &sink_opt {
                                    s.note_path(&child_src.display().to_string());
                                }
                                let progress = match sink_opt {
                                    Some(s) => ProgressMode::Aggregate(s),
                                    None => ProgressMode::None,
                                };
                                stream_local_file_to_local(
                                    child_src.clone(),
                                    child_dst,
                                    overwrite,
                                    progress,
                                )
                                .await
                                .map_err(|err| (child_src.display().to_string(), err))
                            }
                        },
                    ))
                    .buffer_unordered(DIR_DOWNLOAD_CONCURRENCY);
                    while let Some(res) = stream.next().await {
                        match res {
                            Ok(()) => {
                                if let Some(sink) = &sink_opt {
                                    sink.note_file_done();
                                }
                            }
                            Err((_path, err)) if is_fatal_tree_error(&err) => return Err(err),
                            Err((path, err)) => record_transfer_issue(&issues, path, err),
                        }
                    }
                    finish_transfer_issues(&issues)
                },
            )
            .await
        }
    }
}

async fn stream_local_file_to_local(
    source: PathBuf,
    target: PathBuf,
    overwrite: bool,
    progress: ProgressMode<'_>,
) -> Result<(), String> {
    if target.exists() && !overwrite {
        return Err(string_error(format!(
            "destination already exists: {}",
            target.display()
        )));
    }
    let to_err = |e: std::io::Error| {
        format!(
            "copy file {} -> {}: {e}",
            source.display(),
            target.display()
        )
    };
    match progress {
        ProgressMode::Standalone { app, state } => {
            let total = tokio::fs::metadata(&source).await.ok().map(|m| m.len());
            let (transfer_id, cancel) = register_transfer(
                state,
                app,
                "copy",
                source.display().to_string(),
                target.display().to_string(),
                total,
            );
            let _permit = acquire_transfer_slot(state, app, transfer_id).await?;
            let cancel_for_body = cancel.clone();
            let src = source.clone();
            let dst = target.clone();
            let result = run_with_progress(
                app,
                state,
                transfer_id,
                "copy",
                source.display().to_string(),
                target.display().to_string(),
                move |progress_cb| async move {
                    copy_local_file_chunked(&src, &dst, total, cancel_for_body, progress_cb)
                        .await
                        .map_err(|e| {
                            format!("copy file {} -> {}: {e}", src.display(), dst.display())
                        })
                },
            )
            .await;
            forget_transfer(state, transfer_id);
            result.map(|_| ())
        }
        ProgressMode::Aggregate(sink) => {
            let total = tokio::fs::metadata(&source).await.ok().map(|m| m.len());
            let cancel = sink.cancel_token();
            let src = source.clone();
            let dst = target.clone();
            let sink_for_cb = sink.clone();
            let source_label = source.display().to_string();
            let mut last_bytes: u64 = 0;
            copy_local_file_chunked(&src, &dst, total, cancel, move |tick| {
                let delta = tick.bytes_done.saturating_sub(last_bytes);
                if delta > 0 {
                    sink_for_cb.add_bytes(delta, &source_label);
                }
                last_bytes = tick.bytes_done;
            })
            .await
            .map_err(|e| {
                format!(
                    "copy file {} -> {}: {e}",
                    source.display(),
                    target.display()
                )
            })?;
            Ok(())
        }
        ProgressMode::None => tokio::fs::copy(&source, &target)
            .await
            .map(|_| ())
            .map_err(to_err),
    }
}

async fn copy_local_file_chunked<P>(
    source: &Path,
    target: &Path,
    total: Option<u64>,
    cancel: tokio_util::sync::CancellationToken,
    mut progress_cb: P,
) -> Result<u64, std::io::Error>
where
    P: FnMut(zeroterm_ssh::ProgressTick) + Send,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut reader = tokio::fs::File::open(source).await?;
    let mut writer = tokio::fs::File::create(target).await?;
    let mut buf = vec![0u8; zeroterm_ssh::DEFAULT_CHUNK];
    let mut done: u64 = 0;
    progress_cb(zeroterm_ssh::ProgressTick {
        bytes_done: 0,
        total,
    });
    loop {
        if cancel.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "transfer cancelled",
            ));
        }
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        done += n as u64;
        progress_cb(zeroterm_ssh::ProgressTick {
            bytes_done: done,
            total,
        });
    }
    writer.flush().await?;
    Ok(done)
}

pub(crate) async fn build_upload_worker_pool(
    primary: Arc<zeroterm_ssh::Sftp>,
    progress_ctx: Option<(&AppHandle, &AppState)>,
    target_host_id: Option<&str>,
) -> (Vec<Arc<zeroterm_ssh::Sftp>>, Vec<SftpChannelGuard>) {
    let mut workers = vec![primary];
    let mut extra_handles = Vec::new();

    let (Some((app, state)), Some(host_id)) = (progress_ctx, target_host_id) else {
        return (workers, extra_handles);
    };

    for worker_index in 1..DIR_UPLOAD_WORKERS {
        match open_ephemeral_sftp(state, app, host_id).await {
            Ok(handle) => {
                workers.push(handle.sftp());
                extra_handles.push(handle);
            }
            Err(err) => {
                warn!(
                    host_id = %host_id,
                    worker_index,
                    error = %err,
                    "failed to open extra SFTP upload worker; continuing with fewer workers"
                );
                break;
            }
        }
    }

    (workers, extra_handles)
}

async fn run_local_to_remote_upload_workers(
    file_jobs: Vec<(PathBuf, String)>,
    workers: Vec<Arc<zeroterm_ssh::Sftp>>,
    overwrite: bool,
    retry_host_id: Option<String>,
    sink_opt: Option<Arc<TransferSink>>,
) -> Result<(), String> {
    let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::from(file_jobs)));
    let issues = Arc::new(Mutex::new(Vec::<TransferIssue>::new()));
    let mut joins = tokio::task::JoinSet::new();

    for target_sftp in workers {
        let queue = Arc::clone(&queue);
        let sink_opt = sink_opt.clone();
        let issues = Arc::clone(&issues);
        let retry_host_id = retry_host_id.clone();
        joins.spawn(async move {
            loop {
                if let Some(sink) = &sink_opt {
                    if sink.cancel_token().is_cancelled() {
                        break;
                    }
                }
                let next = {
                    let mut queue = queue.lock().await;
                    queue.pop_front()
                };
                let Some((child_src, child_dst)) = next else {
                    break;
                };
                if let Some(sink) = &sink_opt {
                    sink.note_path(&child_src.display().to_string());
                }
                let progress = match sink_opt.clone() {
                    Some(s) => ProgressMode::Aggregate(s),
                    None => ProgressMode::None,
                };
                match stream_local_file_to_remote(
                    Arc::clone(&target_sftp),
                    child_src.clone(),
                    child_dst,
                    overwrite,
                    true,
                    retry_host_id.as_deref(),
                    progress,
                )
                .await
                {
                    Ok(()) => {
                        if let Some(sink) = &sink_opt {
                            sink.note_file_done();
                        }
                    }
                    Err(err) if is_fatal_tree_error(&err) => return Err(err),
                    Err(err) => {
                        record_transfer_issue(&issues, child_src.display().to_string(), err)
                    }
                }
            }
            Ok::<(), String>(())
        });
    }

    while let Some(result) = joins.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if let Some(sink) = &sink_opt {
                    sink.cancel.cancel();
                }
                joins.shutdown().await;
                return Err(err);
            }
            Err(err) => {
                if let Some(sink) = &sink_opt {
                    sink.cancel.cancel();
                }
                joins.shutdown().await;
                return Err(format!("upload worker task failed: {err}"));
            }
        }
    }

    finish_transfer_issues(&issues)
}

async fn run_remote_to_remote_upload_workers(
    file_jobs: Vec<(String, String)>,
    source_sftp: Arc<zeroterm_ssh::Sftp>,
    target_workers: Vec<Arc<zeroterm_ssh::Sftp>>,
    overwrite: bool,
    source_host_id: Option<String>,
    target_host_id: Option<String>,
    sink_opt: Option<Arc<TransferSink>>,
) -> Result<(), String> {
    let queue = Arc::new(tokio::sync::Mutex::new(VecDeque::from(file_jobs)));
    let issues = Arc::new(Mutex::new(Vec::<TransferIssue>::new()));
    let mut joins = tokio::task::JoinSet::new();

    for target_sftp in target_workers {
        let queue = Arc::clone(&queue);
        let sink_opt = sink_opt.clone();
        let source_sftp = Arc::clone(&source_sftp);
        let issues = Arc::clone(&issues);
        let source_host_id = source_host_id.clone();
        let target_host_id = target_host_id.clone();
        joins.spawn(async move {
            loop {
                if let Some(sink) = &sink_opt {
                    if sink.cancel_token().is_cancelled() {
                        break;
                    }
                }
                let next = {
                    let mut queue = queue.lock().await;
                    queue.pop_front()
                };
                let Some((child_src, child_dst)) = next else {
                    break;
                };
                if let Some(sink) = &sink_opt {
                    sink.note_path(&child_src);
                }
                let progress = match sink_opt.clone() {
                    Some(s) => ProgressMode::Aggregate(s),
                    None => ProgressMode::None,
                };
                match stream_remote_file_to_remote(
                    Arc::clone(&source_sftp),
                    child_src.clone(),
                    Arc::clone(&target_sftp),
                    child_dst,
                    overwrite,
                    true,
                    source_host_id.as_deref(),
                    target_host_id.as_deref(),
                    progress,
                )
                .await
                {
                    Ok(()) => {
                        if let Some(sink) = &sink_opt {
                            sink.note_file_done();
                        }
                    }
                    Err(err) if is_fatal_tree_error(&err) => return Err(err),
                    Err(err) => record_transfer_issue(&issues, child_src, err),
                }
            }
            Ok::<(), String>(())
        });
    }

    while let Some(result) = joins.join_next().await {
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if let Some(sink) = &sink_opt {
                    sink.cancel.cancel();
                }
                joins.shutdown().await;
                return Err(err);
            }
            Err(err) => {
                if let Some(sink) = &sink_opt {
                    sink.cancel.cancel();
                }
                joins.shutdown().await;
                return Err(format!("copy worker task failed: {err}"));
            }
        }
    }

    finish_transfer_issues(&issues)
}

async fn stream_local_file_to_remote(
    target_sftp: Arc<zeroterm_ssh::Sftp>,
    source: PathBuf,
    target: String,
    overwrite: bool,
    skip_overwrite_check: bool,
    retry_host_id: Option<&str>,
    progress: ProgressMode<'_>,
) -> Result<(), String> {
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|e| format!("stating {}: {e}", source.display()))?;
    let size_hint = Some(metadata.len());
    match progress {
        ProgressMode::Standalone { app, state } => {
            if !skip_overwrite_check && !overwrite {
                ensure_remote_target_available(target_sftp.as_ref(), &target).await?;
            }
            let skip_overwrite_check = true;
            let (transfer_id, cancel) = register_transfer(
                state,
                app,
                "copy",
                source.display().to_string(),
                target.clone(),
                size_hint,
            );
            let _permit = acquire_transfer_slot(state, app, transfer_id).await?;
            let cancel_for_body = cancel.clone();
            let result = run_with_progress(
                app,
                state,
                transfer_id,
                "copy",
                source.display().to_string(),
                target.clone(),
                move |progress_cb| async move {
                    let mut progress_cb = progress_cb;
                    let first = upload_local_path_to_remote_once(
                        target_sftp.as_ref(),
                        &source,
                        &target,
                        size_hint,
                        overwrite,
                        skip_overwrite_check,
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
                                source = %source.display(),
                                destination = %target,
                                error = %err,
                                "upload lost its SFTP channel, retrying once with a fresh channel"
                            );
                            let guard = open_ephemeral_sftp(
                                state,
                                app,
                                retry_host_id.expect("checked above"),
                            )
                            .await?;
                            upload_local_path_to_remote_once(
                                guard.sftp().as_ref(),
                                &source,
                                &target,
                                size_hint,
                                overwrite,
                                skip_overwrite_check,
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
            result.map(|_| ())
        }
        ProgressMode::Aggregate(sink) => {
            let cancel = sink.cancel_token();
            let source_label = source.display().to_string();
            let app_handle = sink.app_handle.clone();
            let sink_for_progress = sink.clone();
            let attempt_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let attempt_bytes_for_progress = Arc::clone(&attempt_bytes);
            let first = upload_local_path_to_remote_once(
                target_sftp.as_ref(),
                &source,
                &target,
                size_hint,
                overwrite,
                skip_overwrite_check,
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
                Ok(_) => {}
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
                        source = %source.display(),
                        destination = %target,
                        error = %err,
                        "aggregate upload lost its SFTP channel, retrying current file once"
                    );
                    let state = app_handle.state::<AppState>();
                    let guard = open_ephemeral_sftp(
                        &state,
                        &app_handle,
                        retry_host_id.expect("checked above"),
                    )
                    .await?;
                    attempt_bytes.store(0, std::sync::atomic::Ordering::SeqCst);
                    let source_label = source.display().to_string();
                    let sink_for_retry = sink.clone();
                    let attempt_bytes_for_retry = Arc::clone(&attempt_bytes);
                    upload_local_path_to_remote_once(
                        guard.sftp().as_ref(),
                        &source,
                        &target,
                        size_hint,
                        overwrite,
                        skip_overwrite_check,
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
                    .map_err(ssh_error)?;
                }
                Err(err) => return Err(err),
            }
            Ok(())
        }
        ProgressMode::None => {
            upload_local_path_to_remote_once(
                target_sftp.as_ref(),
                &source,
                &target,
                size_hint,
                overwrite,
                skip_overwrite_check,
                tokio_util::sync::CancellationToken::new(),
                &mut |_| {},
            )
            .await
            .map_err(ssh_error)?;
            Ok(())
        }
    }
}

pub(crate) async fn copy_local_tree_to_remote(
    source: &Path,
    target_sftp: &Arc<zeroterm_ssh::Sftp>,
    target: &str,
    target_host_id: Option<String>,
    root_kind: CopyNodeKind,
    overwrite: bool,
    progress_ctx: Option<(&AppHandle, &AppState)>,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            let progress = match progress_ctx {
                Some((app, state)) => ProgressMode::Standalone { app, state },
                None => ProgressMode::None,
            };
            stream_local_file_to_remote(
                Arc::clone(target_sftp),
                source.to_path_buf(),
                target.to_string(),
                overwrite,
                false,
                target_host_id.as_deref(),
                progress,
            )
            .await
        }
        CopyNodeKind::Dir => {
            ensure_remote_dir_exists(target_sftp, target).await?;

            let target_sftp = Arc::clone(target_sftp);
            let source = source.to_path_buf();
            let target = target.to_string();
            let worker_progress_ctx = progress_ctx;

            run_tree_transfer(
                progress_ctx,
                "upload",
                source.display().to_string(),
                target.clone(),
                move |sink_opt| async move {
                    let note_path = |path: &str| {
                        if let Some(sink) = &sink_opt {
                            sink.note_path(path);
                        }
                    };
                    let plan = plan_local_to_remote_copy(
                        &source,
                        &target,
                        target_sftp.as_ref(),
                        overwrite,
                        Some(&note_path),
                    )
                    .await?;
                    let issues = Mutex::new(plan.issues);

                    if let Some(sink) = &sink_opt {
                        sink.set_total(plan.total_bytes);
                        sink.set_files_total(plan.file_jobs.len() as u64);
                    }

                    let (worker_sftps, _worker_handles) = build_upload_worker_pool(
                        Arc::clone(&target_sftp),
                        worker_progress_ctx,
                        target_host_id.as_deref(),
                    )
                    .await;
                    let worker_result = run_local_to_remote_upload_workers(
                        plan.file_jobs,
                        worker_sftps,
                        overwrite,
                        target_host_id.clone(),
                        sink_opt,
                    )
                    .await;
                    merge_transfer_issue_result(&issues, worker_result)
                },
            )
            .await
        }
    }
}

async fn stream_one_remote_file_to_local(
    source_sftp: Arc<zeroterm_ssh::Sftp>,
    source: String,
    target: PathBuf,
    overwrite: bool,
    retry_host_id: Option<&str>,
    progress: ProgressMode<'_>,
) -> Result<(), String> {
    download_remote_file_to_local(
        source_sftp,
        source,
        target,
        overwrite,
        retry_host_id,
        progress,
    )
    .await
    .map(|_| ())
}

pub(crate) async fn copy_remote_tree_to_local(
    source_sftp: &Arc<zeroterm_ssh::Sftp>,
    source: &str,
    target: &Path,
    root_kind: CopyNodeKind,
    overwrite: bool,
    source_host_id: Option<String>,
    progress_ctx: Option<(&AppHandle, &AppState)>,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            let progress = match progress_ctx {
                Some((app, state)) => ProgressMode::Standalone { app, state },
                None => ProgressMode::None,
            };
            stream_one_remote_file_to_local(
                Arc::clone(source_sftp),
                source.to_string(),
                target.to_path_buf(),
                overwrite,
                source_host_id.as_deref(),
                progress,
            )
            .await
        }
        CopyNodeKind::Dir => {
            if tokio::fs::metadata(target).await.is_err() {
                tokio::fs::create_dir_all(target)
                    .await
                    .map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            }

            let source_sftp = Arc::clone(source_sftp);
            let source = source.to_string();
            let target = target.to_path_buf();

            run_tree_transfer(
                progress_ctx,
                "download",
                source.clone(),
                target.display().to_string(),
                move |sink_opt| async move {
                    let issues = Mutex::new(Vec::<TransferIssue>::new());
                    let mut file_jobs: Vec<(String, PathBuf)> = Vec::new();
                    let mut total_bytes: u64 = 0;
                    let mut stack: Vec<(String, PathBuf)> = vec![(source.clone(), target.clone())];
                    while let Some((src_dir, dst_dir)) = stack.pop() {
                        if let Some(sink) = &sink_opt {
                            sink.note_path(&src_dir);
                        }
                        let entries = match source_sftp.list(&src_dir).await {
                            Ok(entries) => entries,
                            Err(err) => {
                                let err = ssh_error(err);
                                if is_fatal_tree_error(&err) {
                                    return Err(err);
                                }
                                record_transfer_issue(&issues, src_dir.clone(), err);
                                continue;
                            }
                        };
                        for entry in entries {
                            if entry.name == "." || entry.name == ".." {
                                continue;
                            }
                            let child_src = remote_join_path(&src_dir, &entry.name);
                            let child_dst = dst_dir.join(&entry.name);
                            let kind = match detect_remote_kind(&child_src, entry.kind) {
                                Ok(kind) => kind,
                                Err(err) => {
                                    record_transfer_issue(&issues, child_src.clone(), err);
                                    continue;
                                }
                            };
                            match kind {
                                CopyNodeKind::File => {
                                    total_bytes = total_bytes.saturating_add(entry.size);
                                    file_jobs.push((child_src, child_dst));
                                }
                                CopyNodeKind::Dir => {
                                    if tokio::fs::metadata(&child_dst).await.is_err() {
                                        if let Err(e) = tokio::fs::create_dir_all(&child_dst).await
                                        {
                                            let err = format!("mkdir {}: {e}", child_dst.display());
                                            if is_fatal_tree_error(&err) {
                                                return Err(err);
                                            }
                                            record_transfer_issue(&issues, child_src.clone(), err);
                                            continue;
                                        }
                                    }
                                    stack.push((child_src, child_dst));
                                }
                            }
                        }
                    }

                    if let Some(sink) = &sink_opt {
                        sink.set_total(total_bytes);
                        sink.set_files_total(file_jobs.len() as u64);
                    }

                    let issues = Arc::new(issues);
                    let mut stream = futures_util::stream::iter(file_jobs.into_iter().map(
                        |(child_src, child_dst)| {
                            let sink_opt = sink_opt.clone();
                            let source_sftp = Arc::clone(&source_sftp);
                            let source_host_id = source_host_id.clone();
                            async move {
                                if let Some(s) = &sink_opt {
                                    s.note_path(&child_src);
                                }
                                let progress = match sink_opt {
                                    Some(s) => ProgressMode::Aggregate(s),
                                    None => ProgressMode::None,
                                };
                                stream_one_remote_file_to_local(
                                    source_sftp,
                                    child_src.clone(),
                                    child_dst,
                                    overwrite,
                                    source_host_id.as_deref(),
                                    progress,
                                )
                                .await
                                .map_err(|err| (child_src, err))
                            }
                        },
                    ))
                    .buffer_unordered(DIR_DOWNLOAD_CONCURRENCY);
                    while let Some(res) = stream.next().await {
                        match res {
                            Ok(()) => {
                                if let Some(sink) = &sink_opt {
                                    sink.note_file_done();
                                }
                            }
                            Err((_path, err)) if is_fatal_tree_error(&err) => return Err(err),
                            Err((path, err)) => record_transfer_issue(&issues, path, err),
                        }
                    }
                    finish_transfer_issues(&issues)
                },
            )
            .await
        }
    }
}

async fn pipe_remote_file_to_remote<P>(
    source_sftp: Arc<zeroterm_ssh::Sftp>,
    source: String,
    target_sftp: Arc<zeroterm_ssh::Sftp>,
    target: String,
    size_hint: Option<u64>,
    overwrite: bool,
    skip_overwrite_check: bool,
    cancel: tokio_util::sync::CancellationToken,
    progress_cb: P,
) -> Result<u64, zeroterm_ssh::SshError>
where
    P: FnMut(zeroterm_ssh::ProgressTick) + Send,
{
    let (mut writer, mut reader) = tokio::io::duplex(zeroterm_ssh::DEFAULT_CHUNK * 2);

    let dl_source = source.clone();
    let dl_cancel = cancel.clone();
    let download = async move {
        let res = source_sftp
            .download_to_writer_parallel(
                &dl_source,
                &mut writer,
                zeroterm_ssh::DEFAULT_CHUNK,
                zeroterm_ssh::DEFAULT_DOWNLOAD_PARALLELISM,
                dl_cancel,
                |_| {},
            )
            .await;
        drop(writer);
        res
    };

    let upload = async move {
        upload_reader_to_remote_atomic(
            target_sftp.as_ref(),
            &target,
            &mut reader,
            size_hint,
            overwrite,
            skip_overwrite_check,
            cancel,
            progress_cb,
        )
        .await
    };

    let (dl, ul) = tokio::join!(download, upload);
    dl?;
    ul
}

async fn stream_remote_file_to_remote(
    source_sftp: Arc<zeroterm_ssh::Sftp>,
    source: String,
    target_sftp: Arc<zeroterm_ssh::Sftp>,
    target: String,
    overwrite: bool,
    skip_overwrite_check: bool,
    source_retry_host_id: Option<&str>,
    target_retry_host_id: Option<&str>,
    progress: ProgressMode<'_>,
) -> Result<(), String> {
    match progress {
        ProgressMode::Standalone { app, state } => {
            if !skip_overwrite_check && !overwrite {
                ensure_remote_target_available(target_sftp.as_ref(), &target).await?;
            }
            let skip_overwrite_check = true;
            let size_hint = source_sftp.stat(&source).await.ok().map(|m| m.size);
            let (transfer_id, cancel) = register_transfer(
                state,
                app,
                "copy",
                source.clone(),
                target.clone(),
                size_hint,
            );
            let _permit = acquire_transfer_slot(state, app, transfer_id).await?;
            let cancel_for_body = cancel.clone();
            let result = run_with_progress(
                app,
                state,
                transfer_id,
                "copy",
                source.clone(),
                target.clone(),
                move |progress_cb| async move {
                    let mut progress_cb = progress_cb;
                    let first = pipe_remote_file_to_remote(
                        Arc::clone(&source_sftp),
                        source.clone(),
                        Arc::clone(&target_sftp),
                        target.clone(),
                        size_hint,
                        overwrite,
                        skip_overwrite_check,
                        cancel_for_body.clone(),
                        &mut progress_cb,
                    )
                    .await
                    .map_err(ssh_error);
                    match first {
                        Ok(bytes) => Ok(bytes),
                        Err(err)
                            if !cancel_for_body.is_cancelled()
                                && (source_retry_host_id.is_some()
                                    || target_retry_host_id.is_some())
                                && is_retryable_transfer_error(&err) =>
                        {
                            warn!(
                                source = %source,
                                destination = %target,
                                error = %err,
                                "remote copy lost its SFTP channel, retrying current file once"
                            );
                            let retry_source = match source_retry_host_id {
                                Some(host_id) => {
                                    open_ephemeral_sftp(state, app, host_id).await?.sftp()
                                }
                                None => Arc::clone(&source_sftp),
                            };
                            let retry_target = match target_retry_host_id {
                                Some(host_id) => {
                                    open_ephemeral_sftp(state, app, host_id).await?.sftp()
                                }
                                None => Arc::clone(&target_sftp),
                            };
                            pipe_remote_file_to_remote(
                                retry_source,
                                source,
                                retry_target,
                                target,
                                size_hint,
                                overwrite,
                                skip_overwrite_check,
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
            result.map(|_| ())
        }
        ProgressMode::Aggregate(sink) => {
            let cancel = sink.cancel_token();
            let source_label = source.clone();
            let app_handle = sink.app_handle.clone();
            let sink_for_progress = sink.clone();
            let attempt_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let attempt_bytes_for_progress = Arc::clone(&attempt_bytes);
            let first: Result<u64, String> = pipe_remote_file_to_remote(
                Arc::clone(&source_sftp),
                source.clone(),
                Arc::clone(&target_sftp),
                target.clone(),
                None,
                overwrite,
                skip_overwrite_check,
                cancel.clone(),
                &mut move |tick: zeroterm_ssh::ProgressTick| {
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
                Ok(_) => Ok(()),
                Err(err)
                    if !cancel.is_cancelled()
                        && (source_retry_host_id.is_some() || target_retry_host_id.is_some())
                        && is_retryable_transfer_error(&err) =>
                {
                    let attempt_done = attempt_bytes.load(std::sync::atomic::Ordering::SeqCst);
                    if attempt_done > 0 {
                        sink.rewind_bytes(attempt_done);
                    }
                    warn!(
                        source = %source,
                        destination = %target,
                        error = %err,
                        "aggregate remote copy lost its SFTP channel, retrying current file once"
                    );
                    let state = app_handle.state::<AppState>();
                    let retry_source = match source_retry_host_id {
                        Some(host_id) => open_ephemeral_sftp(&state, &app_handle, host_id)
                            .await?
                            .sftp(),
                        None => Arc::clone(&source_sftp),
                    };
                    let retry_target = match target_retry_host_id {
                        Some(host_id) => open_ephemeral_sftp(&state, &app_handle, host_id)
                            .await?
                            .sftp(),
                        None => Arc::clone(&target_sftp),
                    };
                    attempt_bytes.store(0, std::sync::atomic::Ordering::SeqCst);
                    let source_label = source.clone();
                    let sink_for_retry = sink.clone();
                    let attempt_bytes_for_retry = Arc::clone(&attempt_bytes);
                    pipe_remote_file_to_remote(
                        retry_source,
                        source,
                        retry_target,
                        target,
                        None,
                        overwrite,
                        skip_overwrite_check,
                        cancel,
                        &mut move |tick: zeroterm_ssh::ProgressTick| {
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
                    .map(|_| ())
                    .map_err(ssh_error)
                }
                Err(err) => Err(err),
            }
        }
        ProgressMode::None => pipe_remote_file_to_remote(
            source_sftp,
            source,
            target_sftp,
            target,
            None,
            overwrite,
            skip_overwrite_check,
            tokio_util::sync::CancellationToken::new(),
            |_| {},
        )
        .await
        .map(|_| ())
        .map_err(ssh_error),
    }
}

pub(crate) async fn copy_remote_tree_to_remote(
    source_sftp: &Arc<zeroterm_ssh::Sftp>,
    source: &str,
    target_sftp: &Arc<zeroterm_ssh::Sftp>,
    target: &str,
    source_host_id: Option<String>,
    target_host_id: Option<String>,
    root_kind: CopyNodeKind,
    overwrite: bool,
    progress_ctx: Option<(&AppHandle, &AppState)>,
) -> Result<(), String> {
    match root_kind {
        CopyNodeKind::File => {
            let progress = match progress_ctx {
                Some((app, state)) => ProgressMode::Standalone { app, state },
                None => ProgressMode::None,
            };
            stream_remote_file_to_remote(
                Arc::clone(source_sftp),
                source.to_string(),
                Arc::clone(target_sftp),
                target.to_string(),
                overwrite,
                false,
                source_host_id.as_deref(),
                target_host_id.as_deref(),
                progress,
            )
            .await
        }
        CopyNodeKind::Dir => {
            ensure_remote_dir_exists(target_sftp, target).await?;

            let source_sftp = Arc::clone(source_sftp);
            let target_sftp = Arc::clone(target_sftp);
            let source = source.to_string();
            let target = target.to_string();
            let worker_progress_ctx = progress_ctx;

            run_tree_transfer(
                progress_ctx,
                "copy",
                source.clone(),
                target.clone(),
                move |sink_opt| async move {
                    let note_path = |path: &str| {
                        if let Some(sink) = &sink_opt {
                            sink.note_path(path);
                        }
                    };
                    let plan = plan_remote_to_remote_copy(
                        &source,
                        &target,
                        source_sftp.as_ref(),
                        target_sftp.as_ref(),
                        overwrite,
                        Some(&note_path),
                    )
                    .await?;
                    let issues = Mutex::new(plan.issues);

                    if let Some(sink) = &sink_opt {
                        sink.set_total(plan.total_bytes);
                        sink.set_files_total(plan.file_jobs.len() as u64);
                    }

                    let (target_workers, _worker_handles) = build_upload_worker_pool(
                        Arc::clone(&target_sftp),
                        worker_progress_ctx,
                        target_host_id.as_deref(),
                    )
                    .await;
                    let worker_result = run_remote_to_remote_upload_workers(
                        plan.file_jobs,
                        Arc::clone(&source_sftp),
                        target_workers,
                        overwrite,
                        source_host_id.clone(),
                        target_host_id.clone(),
                        sink_opt,
                    )
                    .await;
                    merge_transfer_issue_result(&issues, worker_result)
                },
            )
            .await
        }
    }
}

pub(crate) async fn sftp_remove_dir_recursive(sftp: &Sftp, path: &str) -> Result<(), String> {
    let root = normalize_remote_path(path);
    if root == "/" {
        return Err(string_error("refusing to delete remote root directory `/`"));
    }

    let mut stack: Vec<(String, bool)> = vec![(root, false)];
    while let Some((current, visited)) = stack.pop() {
        if visited {
            sftp.remove_dir(&current).await.map_err(ssh_error)?;
            continue;
        }

        stack.push((current.clone(), true));
        let entries = sftp.list(&current).await.map_err(ssh_error)?;
        for entry in entries {
            if entry.name == "." || entry.name == ".." {
                continue;
            }
            let child = remote_join_path(&current, &entry.name);
            match entry.kind {
                zeroterm_ssh::FileKind::Dir => stack.push((child, false)),
                zeroterm_ssh::FileKind::File
                | zeroterm_ssh::FileKind::Symlink
                | zeroterm_ssh::FileKind::Other => {
                    sftp.remove_file(&child).await.map_err(ssh_error)?;
                }
            }
        }
    }

    Ok(())
}

fn display_issue_error(error: &str) -> String {
    parse_ipc_error(error)
        .map(|parsed| parsed.message)
        .unwrap_or_else(|| error.to_string())
}

fn contextualize_error(prefix: String, error: String, separator: &str) -> String {
    if let Some(parsed) = parse_ipc_error(&error) {
        let message = if separator.is_empty() {
            format!("{prefix}: {}", parsed.message)
        } else {
            format!("{prefix}; {separator}: {}", parsed.message)
        };
        ipc_error(parsed.code, message)
    } else if separator.is_empty() {
        string_error(format!("{prefix}: {error}"))
    } else {
        string_error(format!("{prefix}; {separator}: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_channel_closed_is_fatal() {
        let err = ipc_error("CHANNEL_CLOSED", "channel closed by remote");
        assert!(is_fatal_tree_error(&err));
    }

    #[test]
    fn finish_transfer_issues_uses_human_messages() {
        let issues = Mutex::new(vec![TransferIssue {
            path: "/tmp/file".to_string(),
            error: string_error("destination already exists: /tmp/file"),
        }]);
        let summary = finish_transfer_issues(&issues).expect_err("should summarize issues");
        let parsed = parse_ipc_error(&summary).expect("structured summary");
        assert_eq!(parsed.code, "ALREADY_EXISTS");
        assert!(parsed
            .message
            .contains("/tmp/file (destination already exists: /tmp/file)"));
        assert!(!parsed.message.contains("\"code\""));
    }

    #[test]
    fn finish_transfer_issues_limits_preview_and_reports_more() {
        let issues = Mutex::new(
            (0..7)
                .map(|i| TransferIssue {
                    path: format!("/tmp/file-{i}"),
                    error: string_error(format!("permission denied: /tmp/file-{i}")),
                })
                .collect(),
        );
        let summary = finish_transfer_issues(&issues).expect_err("should summarize issues");
        let parsed = parse_ipc_error(&summary).expect("structured summary");
        assert_eq!(parsed.code, "PERMISSION_DENIED");
        assert!(parsed.message.contains("completed with 7 skipped item(s)"));
        assert!(parsed.message.contains("/tmp/file-4"));
        assert!(!parsed.message.contains("/tmp/file-5"));
        assert!(parsed.message.contains("and 2 more"));
    }

    #[test]
    fn merge_transfer_issue_result_prefers_worker_error() {
        let issues = Mutex::new(vec![TransferIssue {
            path: "/tmp/skipped".to_string(),
            error: string_error("permission denied: /tmp/skipped"),
        }]);
        let err = merge_transfer_issue_result(
            &issues,
            Err(ipc_error("CHANNEL_CLOSED", "channel closed by remote")),
        )
        .expect_err("worker error should win");
        let parsed = parse_ipc_error(&err).expect("structured error");
        assert_eq!(parsed.code, "CHANNEL_CLOSED");
        assert_eq!(parsed.message, "channel closed by remote");
    }

    #[test]
    fn contextualize_error_preserves_structured_code() {
        let err = contextualize_error(
            "copy failed for /src/file".to_string(),
            ipc_error("PERMISSION_DENIED", "permission denied: /dst/file"),
            "destination",
        );
        let parsed = parse_ipc_error(&err).expect("structured error");
        assert_eq!(parsed.code, "PERMISSION_DENIED");
        assert_eq!(
            parsed.message,
            "copy failed for /src/file; destination: permission denied: /dst/file"
        );
    }

    #[test]
    fn contextualize_plaintext_error_gets_classified() {
        let err = contextualize_error(
            "copy failed for /src/file".to_string(),
            "destination already exists: /dst/file".to_string(),
            "destination",
        );
        let parsed = parse_ipc_error(&err).expect("structured error");
        assert_eq!(parsed.code, "ALREADY_EXISTS");
        assert_eq!(
            parsed.message,
            "copy failed for /src/file; destination: destination already exists: /dst/file"
        );
    }
}
