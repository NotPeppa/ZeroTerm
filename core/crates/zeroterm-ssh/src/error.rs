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

    pub fn infer_from_message(message: &str) -> Self {
        let lower = message.trim().to_lowercase();
        let compact = lower.replace(&['_', '-', ' '][..], "");

        if contains_any(
            &lower,
            &[
                "no such file",
                "not found",
                "does not exist",
                "cannot find",
                "could not find",
                "nonexistent",
                "enoent",
                "找不到",
                "不存在",
                "no existe",
            ],
        ) || compact.contains("filenotfound")
            || contains_os_error(&lower, 2)
        {
            Self::NotFound
        } else if contains_any(
            &lower,
            &[
                "permission denied",
                "access denied",
                "operation not permitted",
                "forbidden",
                "eacces",
                "eperm",
                "权限",
                "拒绝访问",
                "permiso denegado",
                "zugriff verweigert",
            ],
        ) || contains_os_error(&lower, 13)
        {
            Self::PermissionDenied
        } else if contains_any(
            &lower,
            &[
                "already exists",
                "file exists",
                "destination exists",
                "target exists",
                "eexist",
                "已存在",
                "ya existe",
                "existe déjà",
            ],
        ) || compact.contains("alreadyexists")
            || compact.contains("fileexists")
            || contains_os_error(&lower, 17)
        {
            Self::AlreadyExists
        } else if contains_any(
            &lower,
            &[
                "not a directory",
                "enotdir",
                "不是目录",
                "no es un directorio",
                "kein verzeichnis",
            ],
        ) || contains_os_error(&lower, 20)
        {
            Self::NotADirectory
        } else if contains_any(
            &lower,
            &[
                "unsupported",
                "not supported",
                "op unsupported",
                "operation unsupported",
                "not implemented",
                "not a regular file",
                "is a directory",
                "eisdir",
                "不支持",
                "未实现",
            ],
        ) || contains_os_error(&lower, 21)
        {
            Self::Unsupported
        } else if contains_any(
            &lower,
            &[
                "channel closed",
                // russh reports this when its client task has exited and a
                // request (such as opening the SFTP subsystem) can no
                // longer be queued. It is a disconnected session, not a
                // protocol feature error, so callers can reconnect safely.
                "channel send error",
                "broken pipe",
                "connection reset",
                "connection lost",
                "connection aborted",
                "connection refused",
                "no connection",
                "session closed",
                "socket closed",
                "closed by remote",
                "no route to host",
                "network is unreachable",
                "host unreachable",
                "econnreset",
                "econnaborted",
                "econnrefused",
                "ehostunreach",
                "enetunreach",
                "连接重置",
                "连接断开",
                "连接已关闭",
            ],
        ) || contains_os_error(&lower, 32)
            || contains_os_error(&lower, 54)
            || contains_os_error(&lower, 104)
        {
            Self::ChannelClosed
        } else if contains_any(
            &lower,
            &[
                "timeout",
                "timed out",
                "deadline",
                "elapsed",
                "transfer stalled",
                "stalled",
                "etimedout",
                "超时",
                "tiempo de espera",
                "zeitüberschreitung",
            ],
        ) || contains_os_error(&lower, 60)
            || contains_os_error(&lower, 110)
        {
            Self::Timeout
        } else {
            Self::Other
        }
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn contains_os_error(message: &str, code: u32) -> bool {
    let needle = format!("os error {code}");
    let mut rest = message;
    while let Some(idx) = rest.find(&needle) {
        let after = &rest[idx + needle.len()..];
        if !after.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
            return true;
        }
        rest = after;
    }
    false
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
    Key(#[from] russh::keys::Error),

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
