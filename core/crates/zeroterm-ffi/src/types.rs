//! FFI-shaped record / enum types. These are the types that actually
//! cross the boundary into Swift / Kotlin; they're simpler than the
//! internal Rust types and don't expose third-party crates.

#[derive(Debug, Clone, uniffi::Record)]
pub struct VaultStatus {
    pub path: String,
    pub exists: bool,
    pub unlocked: bool,
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct HostSummary {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_kind: AuthKind,
    pub group_id: Option<String>,
}

/// Full host for edit forms. Credentials are returned so the mobile UI
/// can re-save; treat as sensitive in the host process.
#[derive(Debug, Clone, uniffi::Record)]
pub struct HostDetail {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuthInput,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum AuthKind {
    Password,
    PrivateKey,
    Agent,
}

/// Input for save/update host. When `id` is set, update; otherwise insert.
#[derive(Debug, Clone, uniffi::Record)]
pub struct HostInput {
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuthInput,
    pub group_id: Option<String>,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum HostAuthInput {
    Password {
        value: String,
    },
    PrivateKey {
        key_pem: String,
        passphrase: Option<String>,
    },
    Agent,
}

/// Vault command snippet (kind `snippet`).
#[derive(Debug, Clone, uniffi::Record)]
pub struct SnippetRecord {
    pub id: String,
    pub title: String,
    pub command: String,
    /// Free-form group label; empty = ungrouped.
    pub group: String,
    pub sort_order: i32,
}

/// Create/update input. When `id` is set, update; otherwise insert.
#[derive(Debug, Clone, uniffi::Record)]
pub struct SnippetInput {
    pub id: Option<String>,
    pub title: String,
    pub command: String,
    pub group: String,
    pub sort_order: i32,
}

/// Information about a server's offered host key, surfaced to the
/// foreign UI when the user must decide whether to trust it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct HostKeyInfo {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// SHA256 fingerprint in OpenSSH style: `SHA256:<base64-no-pad>`.
    pub fingerprint: String,
}

impl From<zeroterm_ssh::HostKeyInfo> for HostKeyInfo {
    fn from(i: zeroterm_ssh::HostKeyInfo) -> Self {
        Self {
            host: i.host,
            port: i.port,
            key_type: i.key_type,
            fingerprint: i.fingerprint,
        }
    }
}

// -- conversions to/from internal types ------------------------------------

pub(crate) fn host_to_summary(h: zeroterm_app::Host) -> HostSummary {
    HostSummary {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        auth_kind: match h.auth {
            zeroterm_app::HostAuth::Password { .. } => AuthKind::Password,
            zeroterm_app::HostAuth::PrivateKey { .. } => AuthKind::PrivateKey,
            zeroterm_app::HostAuth::Agent => AuthKind::Agent,
        },
        group_id: h.group_id,
    }
}

pub(crate) fn host_to_detail(h: zeroterm_app::Host) -> HostDetail {
    HostDetail {
        id: h.id,
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        auth: match h.auth {
            zeroterm_app::HostAuth::Password { value } => HostAuthInput::Password { value },
            zeroterm_app::HostAuth::PrivateKey {
                key_pem,
                passphrase,
            } => HostAuthInput::PrivateKey {
                key_pem,
                passphrase,
            },
            zeroterm_app::HostAuth::Agent => HostAuthInput::Agent,
        },
        group_id: h.group_id,
    }
}

pub(crate) fn host_input_to_host(input: HostInput) -> zeroterm_app::Host {
    zeroterm_app::Host {
        id: input.id.unwrap_or_default(),
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        auth: match input.auth {
            HostAuthInput::Password { value } => zeroterm_app::HostAuth::Password { value },
            HostAuthInput::PrivateKey {
                key_pem,
                passphrase,
            } => zeroterm_app::HostAuth::PrivateKey {
                key_pem,
                passphrase,
            },
            HostAuthInput::Agent => zeroterm_app::HostAuth::Agent,
        },
        os_type: None,
        // Forwards / ProxyJump: preserve on update via get+merge in facade;
        // new hosts from FFI are forward-less (edit on desktop/CLI).
        forwards: Vec::new(),
        proxy_jump_host_id: None,
        group_id: input.group_id,
    }
}
