use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SftpErrorKind {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotADirectory,
    Unsupported,
    ChannelClosed,
    Timeout,
    Other,
}

impl SftpErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::AlreadyExists => "ALREADY_EXISTS",
            Self::NotADirectory => "NOT_A_DIRECTORY",
            Self::Unsupported => "UNSUPPORTED",
            Self::ChannelClosed => "CHANNEL_CLOSED",
            Self::Timeout => "TIMEOUT",
            Self::Other => "OTHER",
        }
    }
}

impl std::fmt::Display for SftpErrorKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

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

    #[error("sftp error ({kind}): {message}")]
    Sftp {
        kind: SftpErrorKind,
        message: String,
    },

    #[error("ssh agent unavailable: {0}")]
    AgentUnavailable(String),

    #[error("ssh agent error: {0}")]
    Agent(String),

    #[error("operation cancelled")]
    Cancelled,
}
