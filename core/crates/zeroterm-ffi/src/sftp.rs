//! SFTP FFI surface (RFC-003 batch-4).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;
use tracing::info;
use zeroterm_ssh::{FileKind, HostKeyPolicy, ProgressTick, Session, Sftp};

use crate::error::{map_app_error, other, FfiError};
use crate::facade::{connect_session_chain, ZeroTerm};
use crate::listener::{ForeignHostKeyPrompt, HostKeyPromptCallback};

// -- types ------------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Enum)]
pub enum SftpFileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SftpDirEntry {
    pub name: String,
    pub kind: SftpFileKind,
    pub size: u64,
    pub modified_unix_ms: Option<i64>,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct TransferProgress {
    pub transfer_id: u64,
    /// "upload" | "download"
    pub kind: String,
    /// queued | running | success | error | cancelled
    pub status: String,
    pub source: String,
    pub destination: String,
    pub bytes_done: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

#[uniffi::export(with_foreign)]
pub trait TransferListener: Send + Sync {
    fn on_transfer(&self, event: TransferProgress);
}

// -- handle storage (on ZeroTerm via extension fields in facade) ------------

pub(crate) struct SftpEntry {
    /// A ProxyJump transport must outlive the target transport/channel.
    _jump_session: Option<Session>,
    /// Keep the SSH session alive for the SFTP channel lifetime.
    _session: Session,
    sftp: Arc<Sftp>,
}

pub(crate) type SftpMap = Arc<Mutex<HashMap<u64, SftpEntry>>>;
pub(crate) type CancelMap = Arc<Mutex<HashMap<u64, CancellationToken>>>;

// -- helpers ----------------------------------------------------------------

fn kind_from(k: FileKind) -> SftpFileKind {
    match k {
        FileKind::File => SftpFileKind::File,
        FileKind::Dir => SftpFileKind::Dir,
        FileKind::Symlink => SftpFileKind::Symlink,
        FileKind::Other => SftpFileKind::Other,
    }
}

fn map_ssh(e: zeroterm_ssh::SshError) -> FfiError {
    use zeroterm_ssh::SshError;
    match e {
        SshError::Cancelled => FfiError::Other {
            detail: "CANCELLED: transfer cancelled".into(),
        },
        SshError::Sftp { kind, message } => {
            let code = kind.code();
            FfiError::Other {
                detail: format!("{code}: {message}"),
            }
        }
        other => FfiError::Other {
            detail: other.to_string(),
        },
    }
}

// -- ZeroTerm SFTP methods --------------------------------------------------

#[uniffi::export(async_runtime = "tokio")]
impl ZeroTerm {
    /// Open an SFTP channel to a saved host. Host-key prompts use the same
    /// callback protocol as `connectHost`.
    pub async fn sftp_open(
        &self,
        host_id: String,
        host_key_prompt: Arc<dyn HostKeyPromptCallback>,
    ) -> Result<u64, FfiError> {
        let host = {
            let guard = self.inner.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
            app.find_host_by_id(&host_id)
                .map_err(map_app_error)?
                .ok_or_else(|| FfiError::NotFound {
                    detail: host_id.clone(),
                })?
        };

        let known_hosts = self.resolved_known_hosts()?;
        let prompt = Arc::new(ForeignHostKeyPrompt {
            foreign: host_key_prompt,
            pending: self.pending_host_key.clone(),
        });
        let policy = HostKeyPolicy::Interactive {
            store: known_hosts,
            prompt,
        };
        let (cfg, jump_cfg) = self.saved_host_connect_configs(&host, policy)?;

        info!(host = %host.host, "ffi: sftp open");
        let (jump_session, session) =
            connect_session_chain(cfg, jump_cfg).await.map_err(other)?;
        let sftp = session.sftp().await.map_err(map_ssh)?;
        let id = self.next_sftp_id.fetch_add(1, Ordering::SeqCst);
        self.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(
            id,
            SftpEntry {
                _jump_session: jump_session,
                _session: session,
                sftp: Arc::new(sftp),
            },
        );
        Ok(id)
    }

    pub async fn sftp_close(&self, sftp_id: u64) -> Result<(), FfiError> {
        let removed = self.sftp_handles.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&sftp_id);
        if removed.is_none() {
            return Err(FfiError::NotFound {
                detail: format!("sftp {sftp_id}"),
            });
        }
        Ok(())
    }

    pub async fn sftp_list(
        &self,
        sftp_id: u64,
        path: String,
    ) -> Result<Vec<SftpDirEntry>, FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        let entries = sftp.list(&path).await.map_err(map_ssh)?;
        let mut out: Vec<SftpDirEntry> = entries
            .into_iter()
            .filter(|e| e.name != "." && e.name != "..")
            .map(|e| SftpDirEntry {
                name: e.name,
                kind: kind_from(e.kind),
                size: e.size,
                modified_unix_ms: e.modified_unix_ms,
            })
            .collect();
        out.sort_by(|a, b| {
            let ad = matches!(a.kind, SftpFileKind::Dir);
            let bd = matches!(b.kind, SftpFileKind::Dir);
            bd.cmp(&ad).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    pub async fn sftp_mkdir(&self, sftp_id: u64, path: String) -> Result<(), FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        sftp.create_dir(&path).await.map_err(map_ssh)
    }

    pub async fn sftp_rename(
        &self,
        sftp_id: u64,
        from: String,
        to: String,
    ) -> Result<(), FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        sftp.rename(&from, &to).await.map_err(map_ssh)
    }

    pub async fn sftp_remove(&self, sftp_id: u64, path: String) -> Result<(), FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        sftp.remove_file(&path).await.map_err(map_ssh)
    }

    /// Remove a directory (non-recursive). Fails if not empty.
    pub async fn sftp_remove_dir(&self, sftp_id: u64, path: String) -> Result<(), FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        sftp.remove_dir(&path).await.map_err(map_ssh)
    }

    /// Download remote file to a local path. Returns transfer id.
    /// Progress via [listener]. Completes when the future resolves.
    pub async fn sftp_download(
        &self,
        sftp_id: u64,
        remote: String,
        local_path: String,
        overwrite: bool,
        listener: Arc<dyn TransferListener>,
    ) -> Result<u64, FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        let local = PathBuf::from(&local_path);
        if local.exists() && !overwrite {
            return Err(FfiError::AlreadyExists);
        }
        if let Some(parent) = local.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(other)?;
        }

        let transfer_id = self.next_transfer_id.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        self.transfer_cancels
            .lock()
            .unwrap()
            .insert(transfer_id, cancel.clone());

        let emit = |status: &str, done: u64, total: Option<u64>, err: Option<String>| {
            listener.on_transfer(TransferProgress {
                transfer_id,
                kind: "download".into(),
                status: status.into(),
                source: remote.clone(),
                destination: local_path.clone(),
                bytes_done: done,
                total,
                error: err,
            });
        };
        emit("queued", 0, None, None);
        emit("running", 0, None, None);

        // SSH-10: download into a sibling temp file and only rename over
        // the destination on success. The old code created (truncating)
        // the destination directly, so a mid-download failure with
        // `overwrite=true` destroyed the user's existing file. The temp
        // lives in the same directory so the final rename is atomic on
        // the same filesystem.
        let tmp = local.with_file_name(format!(
            "{}.zt-dl-{}.part",
            local
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("download"),
            transfer_id
        ));

        let result = async {
            let mut file = tokio::fs::File::create(&tmp).await.map_err(other)?;
            sftp.download_to_writer(
                &remote,
                &mut file,
                zeroterm_ssh::DEFAULT_CHUNK,
                cancel.clone(),
                |tick: ProgressTick| {
                    listener.on_transfer(TransferProgress {
                        transfer_id,
                        kind: "download".into(),
                        status: "running".into(),
                        source: remote.clone(),
                        destination: local_path.clone(),
                        bytes_done: tick.bytes_done,
                        total: tick.total,
                        error: None,
                    });
                },
            )
            .await
            .map_err(map_ssh)?;
            file.flush().await.map_err(other)?;
            drop(file);
            // Commit: atomically replace the destination only now that the
            // full payload is on disk.
            tokio::fs::rename(&tmp, &local).await.map_err(other)?;
            Ok::<(), FfiError>(())
        }
        .await;

        self.transfer_cancels.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&transfer_id);
        match result {
            Ok(()) => {
                emit("success", 0, None, None);
                Ok(transfer_id)
            }
            Err(e) => {
                let msg = e.to_string();
                let status = if msg.contains("CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };
                emit(status, 0, None, Some(msg.clone()));
                // Only the partial temp is removed; the user's existing
                // file (if any) was never touched.
                let _ = tokio::fs::remove_file(&tmp).await;
                Err(e)
            }
        }
    }

    /// Upload local file to remote path. Returns transfer id.
    pub async fn sftp_upload(
        &self,
        sftp_id: u64,
        local_path: String,
        remote: String,
        overwrite: bool,
        listener: Arc<dyn TransferListener>,
    ) -> Result<u64, FfiError> {
        let sftp = self.lookup_sftp(sftp_id)?;
        let local = PathBuf::from(&local_path);
        if !local.is_file() {
            return Err(FfiError::NotFound {
                detail: local_path.clone(),
            });
        }
        if !overwrite && sftp.stat(&remote).await.is_ok() {
            return Err(FfiError::AlreadyExists);
        }

        let meta = tokio::fs::metadata(&local).await.map_err(other)?;
        let size_total = meta.len();
        let size_hint = Some(size_total);

        let transfer_id = self.next_transfer_id.fetch_add(1, Ordering::SeqCst);
        let cancel = CancellationToken::new();
        self.transfer_cancels
            .lock()
            .unwrap()
            .insert(transfer_id, cancel.clone());

        let emit = |status: &str, done: u64, total: Option<u64>, err: Option<String>| {
            listener.on_transfer(TransferProgress {
                transfer_id,
                kind: "upload".into(),
                status: status.into(),
                source: local_path.clone(),
                destination: remote.clone(),
                bytes_done: done,
                total,
                error: err,
            });
        };
        emit("queued", 0, size_hint, None);
        emit("running", 0, size_hint, None);

        let result = async {
            let mut file = tokio::fs::File::open(&local).await.map_err(other)?;
            sftp.upload_from_reader(
                &remote,
                &mut file,
                zeroterm_ssh::DEFAULT_UPLOAD_CHUNK,
                size_hint,
                cancel.clone(),
                |tick: ProgressTick| {
                    listener.on_transfer(TransferProgress {
                        transfer_id,
                        kind: "upload".into(),
                        status: "running".into(),
                        source: local_path.clone(),
                        destination: remote.clone(),
                        bytes_done: tick.bytes_done,
                        total: tick.total.or(size_hint),
                        error: None,
                    });
                },
            )
            .await
            .map_err(map_ssh)?;
            Ok::<(), FfiError>(())
        }
        .await;

        self.transfer_cancels.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(&transfer_id);
        match result {
            Ok(()) => {
                emit("success", size_total, size_hint, None);
                Ok(transfer_id)
            }
            Err(e) => {
                let msg = e.to_string();
                let status = if msg.contains("CANCELLED") {
                    "cancelled"
                } else {
                    "error"
                };
                emit(status, 0, size_hint, Some(msg));
                Err(e)
            }
        }
    }

    pub fn sftp_cancel_transfer(&self, transfer_id: u64) -> Result<(), FfiError> {
        if let Some(token) = self.transfer_cancels.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&transfer_id) {
            token.cancel();
            Ok(())
        } else {
            Err(FfiError::NotFound {
                detail: format!("transfer {transfer_id}"),
            })
        }
    }
}

impl ZeroTerm {
    pub(crate) fn lookup_sftp(&self, sftp_id: u64) -> Result<Arc<Sftp>, FfiError> {
        self.sftp_handles
            .lock()
            .unwrap()
            .get(&sftp_id)
            .map(|e| e.sftp.clone())
            .ok_or_else(|| FfiError::NotFound {
                detail: format!("sftp {sftp_id}"),
            })
    }
}
