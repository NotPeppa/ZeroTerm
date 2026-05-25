use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("vault error: {0}")]
    Vault(#[from] zeroterm_vault::VaultError),

    #[error("host '{0}' is already saved — pick a different name")]
    HostNameTaken(String),

    #[error("no host found matching '{0}'")]
    HostNotFound(String),

    #[error("vault record was not valid host JSON: {0}")]
    BadHostRecord(serde_json::Error),

    #[error("vault record was not valid sync profile JSON: {0}")]
    BadSyncProfile(serde_json::Error),

    #[error("sync config error: {0}")]
    SyncConfig(String),

    #[error("sync engine error: {0}")]
    Sync(#[from] zeroterm_sync::error::Error),

    #[error("sync is not connected yet — please create or join a repo first")]
    SyncEngineMissing(String),

    #[error("no sync profile with id '{0}'")]
    SyncProfileNotFound(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
