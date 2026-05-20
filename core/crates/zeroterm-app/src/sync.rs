use serde::{Deserialize, Serialize};
use zeroterm_sync::{EncryptedEvent, SyncError};

use crate::{App, AppError};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncBackendKind {
    Filesystem,
    WebDav,
    S3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SyncProfile {
    pub id: String,
    pub name: String,
    pub backend: SyncBackendKind,
    pub root: Option<String>,
    pub endpoint: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub path: Option<String>,
    pub s3_endpoint: Option<String>,
    pub s3_path_style: Option<bool>,
}

const SYNC_PROFILE_KIND: &str = "sync_profile";

impl App {
    pub fn list_sync_profiles(&self) -> Result<Vec<SyncProfile>, AppError> {
        let records = self.vault.list(SYNC_PROFILE_KIND)?;
        let mut out = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            if let Ok(mut p) = serde_json::from_slice::<SyncProfile>(&plaintext) {
                p.id = id;
                out.push(p);
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn save_sync_profile(&self, profile: &SyncProfile) -> Result<String, AppError> {
        let payload = serde_json::to_vec(profile).map_err(AppError::BadSyncProfile)?;
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

    fn preview_host_events(&self) -> Result<Vec<EncryptedEvent>, AppError> {
        let hosts = self.list_hosts()?;
        let mut events = Vec::with_capacity(hosts.len());
        for (i, host) in hosts.iter().enumerate() {
            let plaintext = serde_json::to_vec(host).map_err(AppError::BadHostRecord)?;
            let ev = zeroterm_sync::new_event(
                "local-device",
                i as u64 + 1,
                "host",
                host.id.clone(),
                "upsert",
                "",
                String::from_utf8_lossy(&plaintext).to_string(),
                1,
            );
            events.push(ev);
        }

        Ok(events)
    }

    pub async fn sync_pull_preview(&self, profile: &SyncProfile) -> Result<Vec<EncryptedEvent>, AppError> {
        match profile.backend {
            SyncBackendKind::Filesystem => {
                let root = profile
                    .root
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("filesystem root is required".to_string()))?;
                let adapter = zeroterm_sync::FsAdapter::new(root);
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                let events = engine.pull_events_under_prefix("events").await.map_err(AppError::Sync)?;
                Ok(events)
            }
            SyncBackendKind::WebDav => {
                let endpoint = profile
                    .endpoint
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav endpoint is required".to_string()))?;
                let path = profile.path.as_deref().unwrap_or("zeroterm");
                let user = profile
                    .username
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav username is required".to_string()))?;
                let pass = profile
                    .password
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav password is required".to_string()))?;
                let adapter = zeroterm_sync::WebDavAdapter::new(endpoint, path, user, pass).map_err(AppError::Sync)?;
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                let events = engine.pull_events_under_prefix("events").await.map_err(AppError::Sync)?;
                Ok(events)
            }
            SyncBackendKind::S3 => {
                let bucket = profile
                    .bucket
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("s3 bucket is required".to_string()))?;
                let region = profile.region.as_deref().unwrap_or("us-east-1");
                let prefix = profile.path.as_deref().unwrap_or("zeroterm");
                let adapter = zeroterm_sync::S3Adapter::new(region, bucket, prefix).await.map_err(AppError::Sync)?;
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                let events = engine.pull_events_under_prefix("events").await.map_err(AppError::Sync)?;
                Ok(events)
            }
        }
    }

    pub async fn sync_push_preview(&self, profile: &SyncProfile) -> Result<usize, AppError> {
        let events = self.preview_host_events()?;
        match profile.backend {
            SyncBackendKind::Filesystem => {
                let root = profile
                    .root
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("filesystem root is required".to_string()))?;
                let adapter = zeroterm_sync::FsAdapter::new(root);
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                engine.push_events(&events).await.map_err(AppError::Sync)?;
            }
            SyncBackendKind::WebDav => {
                let endpoint = profile
                    .endpoint
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav endpoint is required".to_string()))?;
                let path = profile.path.as_deref().unwrap_or("zeroterm");
                let user = profile
                    .username
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav username is required".to_string()))?;
                let pass = profile
                    .password
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("webdav password is required".to_string()))?;
                let adapter = zeroterm_sync::WebDavAdapter::new(endpoint, path, user, pass).map_err(AppError::Sync)?;
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                engine.push_events(&events).await.map_err(AppError::Sync)?;
            }
            SyncBackendKind::S3 => {
                let bucket = profile
                    .bucket
                    .as_deref()
                    .ok_or_else(|| AppError::SyncConfig("s3 bucket is required".to_string()))?;
                let region = profile.region.as_deref().unwrap_or("us-east-1");
                let prefix = profile.path.as_deref().unwrap_or("zeroterm");
                let adapter = zeroterm_sync::S3Adapter::new(region, bucket, prefix).await.map_err(AppError::Sync)?;
                let engine = zeroterm_sync::SyncEngine::new(adapter);
                engine.push_events(&events).await.map_err(AppError::Sync)?;
            }
        }

        Ok(events.len())
    }
}

impl From<SyncError> for AppError {
    fn from(value: SyncError) -> Self {
        AppError::Sync(value)
    }
}
