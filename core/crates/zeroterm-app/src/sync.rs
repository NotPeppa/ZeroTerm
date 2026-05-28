//! Sync workflow for the repo-based engine.
//!
//! Surface:
//!   - [`SyncProfile`] persisted in the vault as a `sync_profile` record.
//!   - [`App::list/save/update/delete_sync_profile`] thin vault CRUD.
//!   - [`SyncManager`] per-process cache of [`zeroterm_sync::engine::SyncEngine`]
//!     instances keyed by profile id.
//!   - [`App::sync_now`] one round-trip; underneath the engine pulls
//!     events from `events/`, applies them through [`VaultBackedStore`],
//!     then drains the vault's dirty rows back onto the wire.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use zeroterm_ssh::{HostKeyPolicy, Session};
use zeroterm_sync::adapter::{LocalAdapter, SftpAdapter};
use zeroterm_sync::engine::{SyncEngine, SyncReport};
use zeroterm_sync::error::Error as SyncErrorKind;
use zeroterm_sync::local_store::{LocalRecord, LocalRecordStore};

use crate::{App, AppError};

const SYNC_PROFILE_KIND: &str = "sync_profile";

/// Persisted backend configuration. Tagged on `backend` so future
/// variants slot in without breaking already-serialized rows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "backend", rename_all = "snake_case")]
pub enum SyncBackend {
    /// Sync via a directory the user maintains (iCloud Drive, Dropbox,
    /// Syncthing, USB stick, …). `zeroterm-sync/` lives under `root`.
    LocalFolder { root: String },
    /// SFTP placeholder — `host_ref` is the vault id of an existing
    /// host record + remote dir on that host. Resolved into an SFTP
    /// adapter at M6.
    Sftp {
        host_ref: String,
        remote_dir: String,
    },
    /// WebDAV backend (M7). `password` is *not* persisted in the
    /// profile — it lives in the OS keychain under a key derived from
    /// the profile id, matching the sync passphrase model.
    WebDav {
        #[serde(default, alias = "base_url")]
        url: String,
        #[serde(default)]
        root_path: String,
        username: String,
    },
    /// S3 / S3-compatible backend (M8). `secret_access_key` lives in
    /// the OS keychain (same family of entries as the WebDAV password)
    /// so a leaked profile record doesn't immediately leak the
    /// account. `session_token` is also keychain-side.
    S3 {
        region: String,
        bucket: String,
        #[serde(default)]
        prefix: String,
        #[serde(default)]
        endpoint: Option<String>,
        #[serde(default)]
        force_path_style: bool,
        access_key_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(flatten)]
    pub backend: SyncBackend,
}

/// Flattened [`SyncReport`] with the bits the UI cares about.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub profile_id: String,
    pub events_pulled: usize,
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
    pub events_pushed: usize,
    pub head_clock: u64,
    pub finished_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncJoinOutcome {
    pub repo_vault_id: String,
    pub events_pulled: usize,
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
}

impl SyncOutcome {
    fn from_report(profile_id: &str, r: SyncReport) -> Self {
        Self {
            profile_id: profile_id.to_string(),
            events_pulled: r.events_pulled,
            upserts_applied: r.upserts_applied,
            deletes_applied: r.deletes_applied,
            conflicts_detected: r.conflicts_detected,
            already_seen: r.already_seen,
            skipped: r.skipped,
            events_pushed: r.events_pushed,
            head_clock: r.head_clock,
            finished_at: now_ms(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub profile_id: String,
    pub bootstrapped: bool,
    pub vault_id: Option<String>,
    pub head_clock: u64,
    /// `false` when the profile references resources that no longer
    /// exist (e.g. an SFTP profile whose `host_ref` host record got
    /// deleted). The UI uses this to surface a re-bind prompt instead
    /// of failing a `sync_now` blindly.
    pub profile_valid: bool,
    /// Machine-readable reason the profile is invalid. Currently only
    /// `"host_record_missing"` is emitted; left open for future
    /// validation checks. `None` when `profile_valid == true`.
    pub profile_issue: Option<String>,
}

/// User-facing view of an open conflict. Plaintext fields are stripped
/// of secret-bearing material — see [`conflict_preview`] for the rules.
#[derive(Debug, Clone, Serialize)]
pub struct ConflictView {
    pub id: String,
    pub record_id: String,
    pub kind: String,
    pub detected_at: i64,
    pub local_rev: String,
    pub remote_rev: String,
    pub local_preview: serde_json::Value,
    pub remote_preview: serde_json::Value,
}

/// Resolution choice from the UI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictResolution {
    /// Keep the local edits. Bumps `base_server_rev` to the remote
    /// revision so the next push references the remote's lineage —
    /// peers accept the override without a second-level conflict.
    KeepLocal,
    /// Adopt the remote payload. Marks the record clean.
    KeepRemote,
}

/// In-memory cache of bootstrapped [`SyncEngine`] instances.
pub struct SyncManager {
    engines: Mutex<std::collections::HashMap<String, Arc<SyncEngine>>>,
    /// Per-profile debounce timers. Mutation paths call
    /// [`SyncManager::schedule_debounced_sync`] to ask for "sync soon";
    /// rapid edits collapse into a single sync after the timer fires.
    pending: Mutex<std::collections::HashMap<String, tokio::task::JoinHandle<()>>>,
    /// Debounce window. Default matches RFC §20's 3–5 s suggestion.
    debounce: std::sync::Mutex<Duration>,
}

impl Default for SyncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncManager {
    pub fn new() -> Self {
        Self {
            engines: Mutex::new(std::collections::HashMap::new()),
            pending: Mutex::new(std::collections::HashMap::new()),
            debounce: std::sync::Mutex::new(Duration::from_secs(4)),
        }
    }

    pub fn debounce_duration(&self) -> Duration {
        *self.debounce.lock().unwrap()
    }

    /// Override the debounce window. `Duration::ZERO` disables auto-sync
    /// (every mutation must still call schedule, but the timer fires
    /// immediately). Mostly useful for tests.
    pub fn set_debounce_duration(&self, d: Duration) {
        *self.debounce.lock().unwrap() = d;
    }

    pub async fn get(&self, profile_id: &str) -> Option<Arc<SyncEngine>> {
        self.engines.lock().await.get(profile_id).cloned()
    }

    pub async fn insert(&self, profile_id: &str, engine: Arc<SyncEngine>) {
        self.engines
            .lock()
            .await
            .insert(profile_id.to_string(), engine);
    }

    pub async fn forget(&self, profile_id: &str) {
        self.engines.lock().await.remove(profile_id);
        self.cancel_pending(profile_id).await;
    }

    pub async fn forget_all(&self) {
        self.engines.lock().await.clear();
        let mut pending = self.pending.lock().await;
        for (_, h) in pending.drain() {
            h.abort();
        }
    }

    pub async fn is_bootstrapped(&self, profile_id: &str) -> bool {
        self.engines.lock().await.contains_key(profile_id)
    }

    /// IDs of every bootstrapped profile. Used by the debounce trigger
    /// so callers don't need to know the "active" profile.
    pub async fn bootstrapped_ids(&self) -> Vec<String> {
        self.engines.lock().await.keys().cloned().collect()
    }

    async fn cancel_pending(&self, profile_id: &str) {
        if let Some(h) = self.pending.lock().await.remove(profile_id) {
            h.abort();
        }
    }

    /// Re-arm the debounce timer for `profile_id`. If a previous timer
    /// for this profile is still pending, it's cancelled and replaced —
    /// the actual sync only fires `debounce` after the last call. The
    /// caller must hold an Arc to the manager so the timer can pull
    /// the engine out at fire time.
    pub fn schedule_debounced_sync(
        self: &Arc<Self>,
        app: Arc<App>,
        profile_id: String,
    ) {
        let manager = self.clone();
        let delay = self.debounce_duration();
        let app = app;
        // Spawn into the surrounding runtime; we expect to be on a
        // tokio context because this is always called from a #[tauri::command].
        tokio::spawn(async move {
            // Cancel any in-flight timer for the same profile first so
            // we collapse rapid edits.
            {
                let mut pending = manager.pending.lock().await;
                if let Some(prev) = pending.remove(&profile_id) {
                    prev.abort();
                }
            }
            let pid = profile_id.clone();
            let manager_inner = manager.clone();
            let app_inner = app.clone();
            let handle = tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                match app_inner.sync_now(&manager_inner, &pid).await {
                    Ok(_) => tracing::debug!(profile_id = %pid, "debounced sync ok"),
                    Err(e) => {
                        tracing::warn!(profile_id = %pid, error = %e, "debounced sync failed")
                    }
                }
                manager_inner.pending.lock().await.remove(&pid);
            });
            manager.pending.lock().await.insert(profile_id, handle);
        });
    }

    /// Convenience wrapper that arms a timer for every bootstrapped
    /// profile. The mutation-side commands call this — they don't need
    /// to know which profile is "active".
    pub fn schedule_debounced_sync_for_all(
        self: &Arc<Self>,
        app: Arc<App>,
    ) {
        let manager = self.clone();
        tokio::spawn(async move {
            let ids = manager.bootstrapped_ids().await;
            for id in ids {
                manager.schedule_debounced_sync(app.clone(), id);
            }
        });
    }
}

/// Stable identifier for this device. Format: `device-<sanitized hostname>`.
/// Keeping it stable means the keyring isn't littered with throwaway
/// entries across runs.
pub fn local_device_id() -> String {
    format!("device-{}", hostname_best_effort())
}

fn hostname_best_effort() -> String {
    if let Some(h) = std::env::var_os("COMPUTERNAME").and_then(|s| s.into_string().ok()) {
        return sanitize_id(&h);
    }
    if let Some(h) = std::env::var_os("HOSTNAME").and_then(|s| s.into_string().ok()) {
        return sanitize_id(&h);
    }
    "unknown".to_string()
}

fn sanitize_id(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl App {
    pub fn list_sync_profile_ids_raw(&self) -> Result<Vec<String>, AppError> {
        Ok(self
            .vault
            .list(SYNC_PROFILE_KIND)?
            .into_iter()
            .map(|(id, _)| id)
            .collect())
    }

    pub fn list_sync_profiles(&self) -> Result<Vec<SyncProfile>, AppError> {
        let records = self.vault.list(SYNC_PROFILE_KIND)?;
        let mut out = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<SyncProfile>(&plaintext) {
                Ok(mut p) => {
                    p.id = id;
                    out.push(p);
                }
                Err(e) => {
                    return Err(AppError::SyncConfig(format!(
                        "malformed sync profile '{id}': {e}"
                    )));
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn find_sync_profile(&self, id: &str) -> Result<SyncProfile, AppError> {
        let plaintext = self.vault.get(id).map_err(|e| match e {
            zeroterm_vault::VaultError::NotFound(_) => {
                AppError::SyncProfileNotFound(id.to_string())
            }
            other => AppError::Vault(other),
        })?;
        let mut p: SyncProfile =
            serde_json::from_slice(&plaintext).map_err(AppError::BadSyncProfile)?;
        p.id = id.to_string();
        Ok(p)
    }

    pub fn save_sync_profile(&self, profile: &SyncProfile) -> Result<String, AppError> {
        let mut to_store = profile.clone();
        if to_store.created_at == 0 {
            to_store.created_at = now_ms();
        }
        let payload = serde_json::to_vec(&to_store).map_err(AppError::BadSyncProfile)?;
        Ok(self.vault.insert(SYNC_PROFILE_KIND, &payload)?)
    }

    pub fn update_sync_profile(&self, profile: &SyncProfile) -> Result<(), AppError> {
        let payload = serde_json::to_vec(profile).map_err(AppError::BadSyncProfile)?;
        self.vault.update(&profile.id, &payload)?;
        Ok(())
    }

    pub fn delete_sync_profile(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
    }

    /// Build a fresh [`SyncEngine`] for `profile` over a vault-backed
    /// local store. For SFTP profiles this opens a live SSH connection;
    /// for local-folder profiles it's pure path setup.
    pub async fn engine_for_profile(
        self: &Arc<Self>,
        profile: &SyncProfile,
    ) -> Result<Arc<SyncEngine>, AppError> {
        let store: Arc<dyn LocalRecordStore> =
            Arc::new(VaultBackedStore::new(self.clone()));
        let device_id = local_device_id();
        match &profile.backend {
            SyncBackend::LocalFolder { root } => {
                let p = PathBuf::from(root);
                if !p.is_absolute() {
                    return Err(AppError::SyncConfig(format!(
                        "sync root must be an absolute path, got '{root}'"
                    )));
                }
                let adapter = LocalAdapter::new(p);
                Ok(Arc::new(SyncEngine::new(adapter, store, device_id)))
            }
            SyncBackend::Sftp {
                host_ref,
                remote_dir,
            } => {
                if remote_dir.trim().is_empty() {
                    return Err(AppError::SyncConfig(
                        "sftp remote_dir is required".to_string(),
                    ));
                }
                let host = self
                    .find_host_by_id(host_ref)?
                    .ok_or_else(|| AppError::HostNotFound(host_ref.clone()))?;

                let cfg = self.connect_config(
                    &host,
                    // AcceptAll for sync: we don't have an interactive
                    // host-key prompt here, and the sync passphrase
                    // (not the SSH host key) is what guards record
                    // confidentiality. M7+ should plumb a non-interactive
                    // KnownHosts-only policy through.
                    HostKeyPolicy::AcceptAll,
                    Some(Duration::from_secs(15)),
                );

                let jump_cfg = if let Some(alias) = host.proxy_jump.as_deref() {
                    let jump_host = self.find_host_by_name(alias)?.ok_or_else(|| {
                        AppError::SyncConfig(format!(
                            "ProxyJump alias '{alias}' not found in vault"
                        ))
                    })?;
                    Some(self.connect_config(
                        &jump_host,
                        HostKeyPolicy::AcceptAll,
                        Some(Duration::from_secs(15)),
                    ))
                } else {
                    None
                };

                let (jump_session, mut session) = match jump_cfg {
                    Some(jc) => {
                        let j = Session::connect(jc)
                            .await
                            .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                        let t = Session::connect_via(cfg, &j)
                            .await
                            .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                        (Some(j), t)
                    }
                    None => {
                        let s = Session::connect(cfg)
                            .await
                            .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                        (None, s)
                    }
                };
                let sftp = session
                    .sftp()
                    .await
                    .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                let adapter =
                    SftpAdapter::new(Arc::new(sftp), session, jump_session, remote_dir);
                Ok(Arc::new(SyncEngine::new(adapter, store, device_id)))
            }
            #[cfg(feature = "webdav-backend")]
            SyncBackend::WebDav {
                url,
                root_path,
                username,
            } => {
                use zeroterm_sync::adapter::{WebDavAdapter, WebDavConfig};

                if url.trim().is_empty() {
                    return Err(AppError::SyncConfig(
                        "webdav url is required".to_string(),
                    ));
                }
                if username.trim().is_empty() {
                    return Err(AppError::SyncConfig(
                        "webdav username is required".to_string(),
                    ));
                }
                let password = crate::keychain::get_sync_backend_credential(&profile.id)
                    .map_err(|e| AppError::SyncConfig(format!("keychain: {e}")))?
                    .ok_or_else(|| {
                        AppError::SyncConfig(
                            "webdav password not in keychain — re-save the profile".into(),
                        )
                    })?;

                let adapter = WebDavAdapter::new(WebDavConfig {
                    base_url: url.clone(),
                    root_path: root_path.clone(),
                    username: username.clone(),
                    password,
                    timeout: None,
                })
                .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                Ok(Arc::new(SyncEngine::new(adapter, store, device_id)))
            }
            #[cfg(not(feature = "webdav-backend"))]
            SyncBackend::WebDav { .. } => Err(AppError::SyncConfig(
                "this build was compiled without the webdav-backend feature".into(),
            )),
            #[cfg(feature = "s3-backend")]
            SyncBackend::S3 {
                region,
                bucket,
                prefix,
                endpoint,
                force_path_style,
                access_key_id,
            } => {
                use zeroterm_sync::adapter::{S3Adapter, S3Config};

                if region.trim().is_empty() {
                    return Err(AppError::SyncConfig("s3 region is required".into()));
                }
                if bucket.trim().is_empty() {
                    return Err(AppError::SyncConfig("s3 bucket is required".into()));
                }
                if access_key_id.trim().is_empty() {
                    return Err(AppError::SyncConfig(
                        "s3 access_key_id is required".into(),
                    ));
                }
                let secret = crate::keychain::get_sync_backend_credential(&profile.id)
                    .map_err(|e| AppError::SyncConfig(format!("keychain: {e}")))?
                    .ok_or_else(|| {
                        AppError::SyncConfig(
                            "s3 secret access key not in keychain — re-save the profile".into(),
                        )
                    })?;

                // Optional session token lives in the keychain too,
                // under a sibling entry. Absence is normal (no STS).
                let session_token = crate::keychain::get_sync_backend_extra(&profile.id)
                    .ok()
                    .flatten();

                let adapter = S3Adapter::new(S3Config {
                    region: region.clone(),
                    bucket: bucket.clone(),
                    prefix: prefix.clone(),
                    endpoint: endpoint.clone(),
                    force_path_style: *force_path_style,
                    access_key_id: access_key_id.clone(),
                    secret_access_key: secret,
                    session_token,
                })
                .await
                .map_err(|e| AppError::SyncConfig(e.to_string()))?;
                Ok(Arc::new(SyncEngine::new(adapter, store, device_id)))
            }
            #[cfg(not(feature = "s3-backend"))]
            SyncBackend::S3 { .. } => Err(AppError::SyncConfig(
                "this build was compiled without the s3-backend feature".into(),
            )),
        }
    }

    pub async fn sync_create_repo(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
        passphrase: &str,
    ) -> Result<usize, AppError> {
        let profile = self.find_sync_profile(profile_id)?;
        let engine = self.engine_for_profile(&profile).await?;
        let seeded = engine
            .create_repo(passphrase, self.vault_id(), Default::default())
            .await?;
        manager.insert(profile_id, engine).await;
        Ok(seeded)
    }

    pub async fn sync_join_repo(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
        passphrase: &str,
    ) -> Result<SyncJoinOutcome, AppError> {
        let profile = self.find_sync_profile(profile_id)?;
        let engine = self.engine_for_profile(&profile).await?;
        let report = engine.join_repo_with_report(passphrase).await?;
        manager.insert(profile_id, engine).await;
        Ok(SyncJoinOutcome {
            repo_vault_id: report.vault_id,
            events_pulled: report.events_pulled,
            upserts_applied: report.upserts_applied,
            deletes_applied: report.deletes_applied,
            conflicts_detected: report.conflicts_detected,
            already_seen: report.already_seen,
            skipped: report.skipped,
        })
    }

    pub async fn sync_now(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
    ) -> Result<SyncOutcome, AppError> {
        let engine = manager
            .get(profile_id)
            .await
            .ok_or_else(|| AppError::SyncEngineMissing(profile_id.to_string()))?;
        let report = engine.sync_once().await?;
        Ok(SyncOutcome::from_report(profile_id, report))
    }

    pub async fn sync_status(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
    ) -> Result<SyncStatus, AppError> {
        let engine = manager.get(profile_id).await;
        let (vault_id, head_clock) = match engine {
            Some(e) => (e.vault_id().await, e.head_clock().await),
            None => (None, 0),
        };

        // Validate that the profile still points at resources that
        // exist. For SFTP profiles, the only failure mode is the
        // referenced host record getting deleted out from under us —
        // surface that to the UI as `profile_issue` instead of letting
        // the next sync_now blow up with HostNotFound.
        let (profile_valid, profile_issue) = match self.find_sync_profile(profile_id) {
            Ok(profile) => match &profile.backend {
                SyncBackend::LocalFolder { .. } => (true, None),
                SyncBackend::Sftp { host_ref, .. } => {
                    match self.find_host_by_id(host_ref)? {
                        Some(_) => (true, None),
                        None => (false, Some("host_record_missing".to_string())),
                    }
                }
                SyncBackend::WebDav { .. } => {
                    // The password lives in the OS keychain. If it's
                    // missing the engine_for_profile call will surface
                    // a useful error already; we treat the profile as
                    // valid here so the UI doesn't lock the user out
                    // of re-saving (a re-save lands fresh credentials).
                    (true, None)
                }
                SyncBackend::S3 { .. } => {
                    // Same story as WebDAV: secret_access_key lives in
                    // the keychain, missing creds surface as a sync_now
                    // error rather than an invalid-profile state.
                    (true, None)
                }
            },
            Err(AppError::SyncProfileNotFound(_)) => {
                (false, Some("profile_missing".to_string()))
            }
            Err(e) => return Err(e),
        };

        Ok(SyncStatus {
            profile_id: profile_id.to_string(),
            bootstrapped: manager.is_bootstrapped(profile_id).await,
            vault_id,
            head_clock,
            profile_valid,
            profile_issue,
        })
    }

    pub async fn sync_compact(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
    ) -> Result<zeroterm_sync::engine::CompactReport, AppError> {
        let engine = manager
            .get(profile_id)
            .await
            .ok_or_else(|| AppError::SyncEngineMissing(profile_id.to_string()))?;
        let report = engine.compact().await?;
        // Also trim resolved conflicts to the most recent 10.
        let _ = self.vault.trim_resolved_conflicts(10);
        Ok(report)
    }

    pub async fn sync_repo_stats(
        self: &Arc<Self>,
        manager: &SyncManager,
        profile_id: &str,
    ) -> Result<zeroterm_sync::engine::RepoStats, AppError> {
        let engine = manager
            .get(profile_id)
            .await
            .ok_or_else(|| AppError::SyncEngineMissing(profile_id.to_string()))?;
        Ok(engine.repo_stats().await?)
    }

    // -- conflict inbox --------------------------------------------------

    pub fn list_open_conflicts(&self) -> Result<Vec<ConflictView>, AppError> {
        let rows = self.vault.list_open_conflicts()?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(ConflictView {
                id: row.id,
                record_id: row.record_id,
                kind: row.kind.clone(),
                detected_at: row.detected_at,
                local_rev: row.local_rev,
                remote_rev: row.remote_rev,
                local_preview: conflict_preview(&row.kind, &row.local_payload),
                remote_preview: conflict_preview(&row.kind, &row.remote_payload),
            });
        }
        Ok(out)
    }

    pub fn resolve_conflict(
        &self,
        conflict_id: &str,
        resolution: ConflictResolution,
    ) -> Result<(), AppError> {
        let row = self
            .vault
            .get_conflict(conflict_id)?
            .ok_or_else(|| AppError::SyncProfileNotFound(conflict_id.to_string()))?;
        if row.resolved_at.is_some() {
            // Idempotent: already resolved.
            return Ok(());
        }

        match resolution {
            ConflictResolution::KeepLocal => {
                self.vault
                    .bump_base_server_rev(&row.record_id, &row.remote_rev)?;
            }
            ConflictResolution::KeepRemote => {
                if row.remote_payload.is_empty() {
                    // Remote was a tombstone → adopt delete.
                    self.vault
                        .apply_remote_delete(&row.record_id, &row.remote_rev)?;
                } else {
                    self.vault.apply_remote_upsert(
                        &row.record_id,
                        &row.kind,
                        &row.remote_payload,
                        &row.remote_rev,
                    )?;
                }
            }
        }
        self.vault.resolve_conflict(conflict_id)?;
        Ok(())
    }
}

/// Turn a raw record payload into something the UI can render safely.
///
/// Rules:
///   - `host` records get parsed as JSON and stripped of `auth.value`
///     (password) / `auth.passphrase`. We surface the *names* of secret
///     fields that are present so the user knows there's an override.
///   - anything else gets a `{ "redacted": true }` marker so the diff
///     UI can show "secret content differs" without leaking bytes.
fn conflict_preview(kind: &str, payload: &[u8]) -> serde_json::Value {
    if payload.is_empty() {
        return serde_json::json!({ "tombstone": true });
    }
    if kind == "host_group" {
        return match serde_json::from_slice::<serde_json::Value>(payload) {
            Ok(v) => v,
            Err(_) => serde_json::json!({ "redacted": true, "bytes": payload.len() }),
        };
    }
    if kind != "host" {
        return serde_json::json!({ "redacted": true, "bytes": payload.len() });
    }
    match serde_json::from_slice::<serde_json::Value>(payload) {
        Ok(mut v) => {
            // Mask the password / passphrase fields if present.
            if let Some(auth) = v.get_mut("auth").and_then(|x| x.as_object_mut()) {
                if let Some(val) = auth.get_mut("value") {
                    if val.is_string() {
                        *val = serde_json::Value::String("***".into());
                    }
                }
                if let Some(pp) = auth.get_mut("passphrase") {
                    if pp.is_string() {
                        *pp = serde_json::Value::String("***".into());
                    }
                }
                if let Some(key_pem) = auth.get_mut("key_pem") {
                    if key_pem.is_string() {
                        *key_pem = serde_json::Value::String("<private key>".into());
                    }
                }
            }
            v
        }
        Err(_) => serde_json::json!({ "redacted": true, "bytes": payload.len() }),
    }
}

/// `LocalRecordStore` impl backed by the unlocked vault + its SQLite
/// store. Holds an `Arc<App>` so it can outlive a single command call
/// without taking out the master vault mutex on every operation.
pub struct VaultBackedStore {
    app: Arc<App>,
}

impl VaultBackedStore {
    pub fn new(app: Arc<App>) -> Self {
        Self { app }
    }
}

fn map_vault_err(e: zeroterm_vault::VaultError) -> SyncErrorKind {
    tracing::error!(error = ?e, "vault error in sync path");
    // The sync trait surface doesn't expose vault detail; collapse to
    // Corrupt since other variants (Crypto, NotFound) all indicate the
    // sync layer is operating on an inconsistent local state.
    SyncErrorKind::Corrupt
}

impl LocalRecordStore for VaultBackedStore {
    fn list_dirty(&self) -> Result<Vec<LocalRecord>, SyncErrorKind> {
        let dirty = self.app.vault.list_dirty().map_err(map_vault_err)?;
        Ok(dirty
            .into_iter()
            .map(|d| LocalRecord {
                id: d.id,
                kind: d.kind,
                plaintext: d.plaintext,
                deleted: d.deleted,
                local_rev: d.local_rev,
                base_server_rev: d.base_server_rev,
                dirty: true,
            })
            .collect())
    }

    fn find(&self, id: &str) -> Result<Option<LocalRecord>, SyncErrorKind> {
        let full = self.app.vault.find_full(id).map_err(map_vault_err)?;
        Ok(full.map(|f| LocalRecord {
            id: f.id,
            kind: f.kind,
            plaintext: f.plaintext,
            deleted: f.deleted,
            local_rev: f.local_rev.unwrap_or_default(),
            base_server_rev: f.base_server_rev,
            dirty: f.dirty,
        }))
    }

    fn apply_upsert(
        &self,
        id: &str,
        kind: &str,
        plaintext: &[u8],
        server_rev: &str,
    ) -> Result<(), SyncErrorKind> {
        self.app
            .vault
            .apply_remote_upsert(id, kind, plaintext, server_rev)
            .map_err(map_vault_err)
    }

    fn apply_delete(&self, id: &str, server_rev: &str) -> Result<(), SyncErrorKind> {
        self.app
            .vault
            .apply_remote_delete(id, server_rev)
            .map_err(map_vault_err)
    }

    fn mark_clean(&self, id: &str, server_rev: &str) -> Result<(), SyncErrorKind> {
        self.app
            .vault
            .mark_clean(id, server_rev)
            .map_err(map_vault_err)
    }

    fn record_conflict(
        &self,
        record_id: &str,
        kind: &str,
        local_payload: &[u8],
        remote_payload: &[u8],
        local_rev: &str,
        remote_rev: &str,
    ) -> Result<(), SyncErrorKind> {
        self.app
            .vault
            .record_conflict(
                record_id,
                kind,
                local_payload,
                remote_payload,
                local_rev,
                remote_rev,
            )
            .map_err(map_vault_err)
    }

    fn list_all_live(&self) -> Result<Vec<LocalRecord>, SyncErrorKind> {
        let live = self.app.vault.list_all_live().map_err(map_vault_err)?;
        Ok(live
            .into_iter()
            .map(|f| LocalRecord {
                id: f.id,
                kind: f.kind,
                plaintext: f.plaintext,
                deleted: false,
                local_rev: f.local_rev.unwrap_or_default(),
                base_server_rev: f.base_server_rev,
                dirty: f.dirty,
            })
            .collect())
    }

    fn get_sync_state(&self, key: &str) -> Result<Option<Vec<u8>>, SyncErrorKind> {
        self.app.vault.get_sync_state(key).map_err(map_vault_err)
    }

    fn put_sync_state(&self, key: &str, value: &[u8]) -> Result<(), SyncErrorKind> {
        self.app
            .vault
            .put_sync_state(key, value)
            .map_err(map_vault_err)
    }

    fn prune_old_tombstones(&self, max_age_days: u64) -> Result<usize, SyncErrorKind> {
        self.app
            .vault
            .prune_old_tombstones(max_age_days)
            .map_err(map_vault_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_debounce_is_four_seconds() {
        let mgr = SyncManager::new();
        assert_eq!(mgr.debounce_duration(), Duration::from_secs(4));
    }

    #[test]
    fn set_debounce_duration_is_visible() {
        let mgr = SyncManager::new();
        mgr.set_debounce_duration(Duration::from_millis(250));
        assert_eq!(mgr.debounce_duration(), Duration::from_millis(250));
    }

    #[tokio::test]
    async fn empty_manager_reports_no_bootstrapped_ids() {
        let mgr = SyncManager::new();
        assert!(mgr.bootstrapped_ids().await.is_empty());
        assert!(!mgr.is_bootstrapped("anything").await);
    }
}
