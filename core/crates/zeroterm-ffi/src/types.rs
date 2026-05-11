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
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum AuthKind {
    Password,
    PrivateKey,
    Agent,
}

/// Input for [`crate::ZeroTerm::save_host`]. `id` is assigned by the
/// vault on insert, so callers don't supply one.
#[derive(Debug, Clone, uniffi::Record)]
pub struct HostInput {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: HostAuthInput,
}

#[derive(Debug, Clone, uniffi::Enum)]
pub enum HostAuthInput {
    Password { value: String },
    PrivateKey {
        key_pem: String,
        passphrase: Option<String>,
    },
    Agent,
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
    }
}

pub(crate) fn host_input_to_host(input: HostInput) -> zeroterm_app::Host {
    zeroterm_app::Host {
        id: String::new(),
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        auth: match input.auth {
            HostAuthInput::Password { value } => zeroterm_app::HostAuth::Password { value },
            HostAuthInput::PrivateKey { key_pem, passphrase } => {
                zeroterm_app::HostAuth::PrivateKey {
                    key_pem,
                    passphrase,
                }
            }
            HostAuthInput::Agent => zeroterm_app::HostAuth::Agent,
        },
        os_type: None,
        // FFI doesn't (yet) accept forward / ProxyJump configuration —
        // saved hosts coming from the FFI side are forward-less. Edit
        // via CLI to add them.
        forwards: Vec::new(),
        proxy_jump: None,
    }
}
