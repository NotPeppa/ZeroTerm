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

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}
