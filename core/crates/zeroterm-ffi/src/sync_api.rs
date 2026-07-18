//! Sync FFI surface (RFC-003 batch-6).

use std::sync::Arc;

use tracing::info;

use crate::error::{map_app_error, FfiError};
use crate::facade::ZeroTerm;

// -- types ------------------------------------------------------------------

#[derive(Debug, Clone, uniffi::Enum)]
pub enum SyncBackendKind {
    LocalFolder,
    Sftp,
    WebDav,
    S3,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncProfileSummary {
    pub id: String,
    pub name: String,
    pub backend: SyncBackendKind,
    /// Local folder root, or empty.
    pub root: String,
    /// SFTP host vault id, or empty.
    pub host_ref: String,
    /// SFTP remote dir / WebDAV root path / S3 prefix.
    pub remote_path: String,
    /// WebDAV URL or empty.
    pub url: String,
    /// WebDAV username or S3 access key id.
    pub username: String,
    pub region: String,
    pub bucket: String,
    pub endpoint: String,
    pub force_path_style: bool,
    pub created_at: i64,
}

/// Input for create/update. Secrets (passphrase, webdav password, s3 secret)
/// are optional — empty means "leave keychain entry unchanged".
#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncProfileInput {
    pub id: Option<String>,
    pub name: String,
    /// "local_folder" | "sftp" | "webdav" | "s3"
    pub backend: String,
    pub root: String,
    pub host_ref: String,
    pub remote_dir: String,
    pub url: String,
    pub root_path: String,
    pub username: String,
    /// WebDAV password or S3 secret access key (keychain).
    pub password: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub endpoint: String,
    pub force_path_style: bool,
    pub access_key_id: String,
    /// S3 session token (keychain extra).
    pub session_token: String,
    /// Sync encryption passphrase (keychain). Required on create/join.
    pub encryption_passphrase: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncStatusRecord {
    pub profile_id: String,
    pub bootstrapped: bool,
    pub vault_id: String,
    pub head_clock: u64,
    pub profile_valid: bool,
    pub profile_issue: String,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncDeviceRecord {
    pub device_id: String,
    pub name: String,
    pub last_seen_at: i64,
    pub is_current: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncRepoStatsRecord {
    pub total_bytes: u64,
    pub manifest_bytes: u64,
    pub keyring_bytes: u64,
    pub snapshots_bytes: u64,
    pub events_bytes: u64,
    pub trash_bytes: u64,
    pub devices_bytes: u64,
    pub snapshot_count: u32,
    pub event_count: u32,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncCompactRecord {
    pub events_compacted: u32,
    pub events_trashed: u32,
    pub events_retained: u32,
    pub records_in_snapshot: u32,
    pub head_clock: u64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct SyncOutcomeRecord {
    pub profile_id: String,
    pub events_pulled: u32,
    pub upserts_applied: u32,
    pub deletes_applied: u32,
    pub conflicts_detected: u32,
    pub already_seen: u32,
    pub skipped: u32,
    pub events_pushed: u32,
    pub head_clock: u64,
    pub finished_at: i64,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ConflictRecord {
    pub id: String,
    pub record_id: String,
    pub kind: String,
    pub detected_at: i64,
    pub local_rev: String,
    pub remote_rev: String,
    pub local_preview: String,
    pub remote_preview: String,
}

// -- helpers ----------------------------------------------------------------

fn profile_to_summary(p: zeroterm_app::SyncProfile) -> SyncProfileSummary {
    use zeroterm_app::SyncBackend;
    let mut s = SyncProfileSummary {
        id: p.id,
        name: p.name,
        backend: SyncBackendKind::LocalFolder,
        root: String::new(),
        host_ref: String::new(),
        remote_path: String::new(),
        url: String::new(),
        username: String::new(),
        region: String::new(),
        bucket: String::new(),
        endpoint: String::new(),
        force_path_style: false,
        created_at: p.created_at,
    };
    match p.backend {
        SyncBackend::LocalFolder { root } => {
            s.backend = SyncBackendKind::LocalFolder;
            s.root = root;
        }
        SyncBackend::Sftp {
            host_ref,
            remote_dir,
        } => {
            s.backend = SyncBackendKind::Sftp;
            s.host_ref = host_ref;
            s.remote_path = remote_dir;
        }
        SyncBackend::WebDav {
            url,
            root_path,
            username,
        } => {
            s.backend = SyncBackendKind::WebDav;
            s.url = url;
            s.remote_path = root_path;
            s.username = username;
        }
        SyncBackend::S3 {
            region,
            bucket,
            prefix,
            endpoint,
            force_path_style,
            access_key_id,
        } => {
            s.backend = SyncBackendKind::S3;
            s.region = region;
            s.bucket = bucket;
            s.remote_path = prefix;
            s.endpoint = endpoint.unwrap_or_default();
            s.force_path_style = force_path_style;
            s.username = access_key_id;
        }
    }
    s
}

fn input_to_backend(input: &SyncProfileInput) -> Result<zeroterm_app::SyncBackend, FfiError> {
    use zeroterm_app::SyncBackend;
    match input.backend.as_str() {
        "local_folder" => {
            if input.root.trim().is_empty() {
                return Err(FfiError::Other {
                    detail: "local folder root is required".into(),
                });
            }
            Ok(SyncBackend::LocalFolder {
                root: input.root.trim().to_string(),
            })
        }
        "sftp" => {
            if input.host_ref.trim().is_empty() {
                return Err(FfiError::Other {
                    detail: "sftp host_ref is required".into(),
                });
            }
            Ok(SyncBackend::Sftp {
                host_ref: input.host_ref.trim().to_string(),
                remote_dir: input.remote_dir.trim().to_string(),
            })
        }
        "webdav" => Ok(SyncBackend::WebDav {
            url: input.url.trim().to_string(),
            root_path: input.root_path.trim().to_string(),
            username: input.username.trim().to_string(),
        }),
        "s3" => Ok(SyncBackend::S3 {
            region: input.region.trim().to_string(),
            bucket: input.bucket.trim().to_string(),
            prefix: input.prefix.trim().to_string(),
            endpoint: {
                let e = input.endpoint.trim();
                if e.is_empty() {
                    None
                } else {
                    Some(e.to_string())
                }
            },
            force_path_style: input.force_path_style,
            access_key_id: input.access_key_id.trim().to_string(),
        }),
        other => Err(FfiError::Other {
            detail: format!("unknown sync backend '{other}'"),
        }),
    }
}

fn persist_secrets(profile_id: &str, input: &SyncProfileInput) {
    if !input.encryption_passphrase.is_empty() {
        let _ = zeroterm_app::keychain::save_sync_encryption_secret(
            profile_id,
            &input.encryption_passphrase,
        );
    }
    match input.backend.as_str() {
        "webdav" | "s3" => {
            if !input.password.is_empty() {
                let _ = zeroterm_app::keychain::save_sync_backend_credential(
                    profile_id,
                    &input.password,
                );
            }
            if input.backend == "s3" && !input.session_token.is_empty() {
                let _ = zeroterm_app::keychain::save_sync_backend_extra(
                    profile_id,
                    &input.session_token,
                );
            }
        }
        _ => {}
    }
}

fn app_arc(zt: &ZeroTerm) -> Result<Arc<zeroterm_app::App>, FfiError> {
    zt.inner
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or(FfiError::VaultLocked)
}

// -- ZeroTerm methods -------------------------------------------------------

#[uniffi::export(async_runtime = "tokio")]
impl ZeroTerm {
    pub fn list_sync_profiles(&self) -> Result<Vec<SyncProfileSummary>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let list = app.list_sync_profiles().map_err(map_app_error)?;
        Ok(list.into_iter().map(profile_to_summary).collect())
    }

    pub fn save_sync_profile(&self, input: SyncProfileInput) -> Result<String, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let backend = input_to_backend(&input)?;
        if let Some(ref id) = input.id {
            if !id.is_empty() {
                let p = zeroterm_app::SyncProfile {
                    id: id.clone(),
                    name: input.name.clone(),
                    created_at: app
                        .find_sync_profile(id)
                        .map(|x| x.created_at)
                        .unwrap_or(0),
                    backend,
                };
                app.update_sync_profile(&p).map_err(map_app_error)?;
                drop(guard);
                persist_secrets(id, &input);
                return Ok(id.clone());
            }
        }
        let p = zeroterm_app::SyncProfile {
            id: String::new(),
            name: input.name.clone(),
            created_at: 0,
            backend,
        };
        let id = app.save_sync_profile(&p).map_err(map_app_error)?;
        drop(guard);
        persist_secrets(&id, &input);
        Ok(id)
    }

    pub fn delete_sync_profile(&self, id: String) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        app.delete_sync_profile(&id).map_err(map_app_error)?;
        drop(guard);
        let _ = zeroterm_app::keychain::forget_sync_encryption_secret(&id);
        let _ = zeroterm_app::keychain::forget_sync_backend_credential(&id);
        let _ = zeroterm_app::keychain::forget_sync_backend_extra(&id);
        Ok(())
    }

    /// Create a new remote repo (first device). Requires encryption passphrase
    /// either in keychain or passed via prior `saveSyncProfile`.
    pub async fn sync_create_repo(
        &self,
        profile_id: String,
        passphrase: String,
    ) -> Result<u32, FfiError> {
        let app = app_arc(self)?;
        let pw = if passphrase.is_empty() {
            zeroterm_app::keychain::get_sync_encryption_secret(&profile_id)
                .map_err(|e| FfiError::Other {
                    detail: e.to_string(),
                })?
                .ok_or_else(|| FfiError::Other {
                    detail: "encryption passphrase required".into(),
                })?
        } else {
            let _ = zeroterm_app::keychain::save_sync_encryption_secret(&profile_id, &passphrase);
            passphrase
        };
        info!(%profile_id, "ffi: sync create_repo");
        let seeded = app
            .sync_create_repo(&self.sync_manager, &profile_id, &pw)
            .await
            .map_err(map_app_error)?;
        Ok(seeded as u32)
    }

    /// Join an existing remote repo (second device).
    pub async fn sync_join_repo(
        &self,
        profile_id: String,
        passphrase: String,
    ) -> Result<SyncOutcomeRecord, FfiError> {
        let app = app_arc(self)?;
        let pw = if passphrase.is_empty() {
            zeroterm_app::keychain::get_sync_encryption_secret(&profile_id)
                .map_err(|e| FfiError::Other {
                    detail: e.to_string(),
                })?
                .ok_or_else(|| FfiError::Other {
                    detail: "encryption passphrase required".into(),
                })?
        } else {
            let _ = zeroterm_app::keychain::save_sync_encryption_secret(&profile_id, &passphrase);
            passphrase
        };
        info!(%profile_id, "ffi: sync join_repo");
        let r = app
            .sync_join_repo(&self.sync_manager, &profile_id, &pw)
            .await
            .map_err(map_app_error)?;
        Ok(SyncOutcomeRecord {
            profile_id,
            events_pulled: r.events_pulled as u32,
            upserts_applied: r.upserts_applied as u32,
            deletes_applied: r.deletes_applied as u32,
            conflicts_detected: r.conflicts_detected as u32,
            already_seen: r.already_seen as u32,
            skipped: r.skipped as u32,
            events_pushed: 0,
            head_clock: 0,
            finished_at: 0,
        })
    }

    /// One sync round-trip. Engine must already be bootstrapped via
    /// createRepo or joinRepo.
    pub async fn sync_now(&self, profile_id: String) -> Result<SyncOutcomeRecord, FfiError> {
        let app = app_arc(self)?;
        // Auto-bootstrap if passphrase is in keychain but engine not loaded.
        if !self.sync_manager.is_bootstrapped(&profile_id).await {
            if let Ok(Some(pw)) =
                zeroterm_app::keychain::get_sync_encryption_secret(&profile_id)
            {
                let _ = app
                    .sync_join_repo(&self.sync_manager, &profile_id, &pw)
                    .await;
            }
        }
        info!(%profile_id, "ffi: sync_now");
        let r = app
            .sync_now(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)?;
        Ok(SyncOutcomeRecord {
            profile_id: r.profile_id,
            events_pulled: r.events_pulled as u32,
            upserts_applied: r.upserts_applied as u32,
            deletes_applied: r.deletes_applied as u32,
            conflicts_detected: r.conflicts_detected as u32,
            already_seen: r.already_seen as u32,
            skipped: r.skipped as u32,
            events_pushed: r.events_pushed as u32,
            head_clock: r.head_clock,
            finished_at: r.finished_at,
        })
    }

    pub async fn sync_status(&self, profile_id: String) -> Result<SyncStatusRecord, FfiError> {
        let app = app_arc(self)?;
        let s = app
            .sync_status(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)?;
        Ok(SyncStatusRecord {
            profile_id: s.profile_id,
            bootstrapped: s.bootstrapped,
            vault_id: s.vault_id.unwrap_or_default(),
            head_clock: s.head_clock,
            profile_valid: s.profile_valid,
            profile_issue: s.profile_issue.unwrap_or_default(),
        })
    }

    pub async fn sync_forget_engine(&self, profile_id: String) -> Result<(), FfiError> {
        self.sync_manager.forget(&profile_id).await;
        Ok(())
    }

    pub async fn sync_list_devices(
        &self,
        profile_id: String,
    ) -> Result<Vec<SyncDeviceRecord>, FfiError> {
        let app = app_arc(self)?;
        let devices = app
            .sync_list_devices(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)?;
        let current_device_id = zeroterm_app::local_device_id();
        Ok(devices
            .into_iter()
            .map(|device| SyncDeviceRecord {
                is_current: device.device_id == current_device_id,
                device_id: device.device_id,
                name: device.name,
                last_seen_at: device.last_seen_at,
            })
            .collect())
    }

    pub async fn sync_repo_stats(
        &self,
        profile_id: String,
    ) -> Result<SyncRepoStatsRecord, FfiError> {
        let app = app_arc(self)?;
        let stats = app
            .sync_repo_stats(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)?;
        Ok(SyncRepoStatsRecord {
            total_bytes: stats.total_bytes,
            manifest_bytes: stats.manifest_bytes,
            keyring_bytes: stats.keyring_bytes,
            snapshots_bytes: stats.snapshots_bytes,
            events_bytes: stats.events_bytes,
            trash_bytes: stats.trash_bytes,
            devices_bytes: stats.devices_bytes,
            snapshot_count: stats.snapshot_count as u32,
            event_count: stats.event_count as u32,
        })
    }

    pub async fn sync_compact(
        &self,
        profile_id: String,
    ) -> Result<SyncCompactRecord, FfiError> {
        let app = app_arc(self)?;
        let report = app
            .sync_compact(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)?;
        Ok(SyncCompactRecord {
            events_compacted: report.events_compacted as u32,
            events_trashed: report.events_trashed as u32,
            events_retained: report.events_retained as u32,
            records_in_snapshot: report.records_in_snapshot as u32,
            head_clock: report.head_clock,
        })
    }

    pub async fn sync_delete_remote_repo(&self, profile_id: String) -> Result<(), FfiError> {
        let app = app_arc(self)?;
        app.sync_delete_remote_repo(&self.sync_manager, &profile_id)
            .await
            .map_err(map_app_error)
    }

    pub fn list_open_conflicts(&self) -> Result<Vec<ConflictRecord>, FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let list = app.list_open_conflicts().map_err(map_app_error)?;
        Ok(list
            .into_iter()
            .map(|c| ConflictRecord {
                id: c.id,
                record_id: c.record_id,
                kind: c.kind,
                detected_at: c.detected_at,
                local_rev: c.local_rev,
                remote_rev: c.remote_rev,
                local_preview: c.local_preview.to_string(),
                remote_preview: c.remote_preview.to_string(),
            })
            .collect())
    }

    /// `keep_local = true` → KeepLocal; false → KeepRemote.
    pub fn resolve_conflict(&self, conflict_id: String, keep_local: bool) -> Result<(), FfiError> {
        let guard = self.inner.lock().unwrap();
        let app = guard.as_ref().ok_or(FfiError::VaultLocked)?;
        let res = if keep_local {
            zeroterm_app::ConflictResolution::KeepLocal
        } else {
            zeroterm_app::ConflictResolution::KeepRemote
        };
        app.resolve_conflict(&conflict_id, res).map_err(map_app_error)
    }
}
