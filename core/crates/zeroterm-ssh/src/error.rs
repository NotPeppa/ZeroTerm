use thiserror::Error;

#[derive(Debug, Error)]
pub enum SshError {
    #[error("authentication failed")]
    AuthFailed,

    #[error("no authentication methods provided")]
    NoAuthMethod,

    #[error("channel closed by remote")]
    ChannelClosed,

    #[error("ssh protocol error: {0}")]
    Protocol(#[from] russh::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("key error: {0}")]
    Key(#[from] russh_keys::Error),

    #[error("sftp error: {0}")]
    Sftp(String),

    #[error("ssh agent unavailable: {0}")]
    AgentUnavailable(String),

    #[error("ssh agent error: {0}")]
    Agent(String),

    #[error("operation cancelled")]
    Cancelled,
}
