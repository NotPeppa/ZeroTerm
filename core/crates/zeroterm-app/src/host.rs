use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use zeroterm_ssh::AuthMethod;

/// A saved host configuration. Serialized as JSON inside a vault record;
/// `id` is populated from the vault record id when loading and skipped on
/// serialize so it never lands in the encrypted plaintext (it's already
/// the plaintext's identity in the store).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    #[serde(skip)]
    pub id: String,

    pub name: String,
    pub host: String,

    #[serde(default = "default_port")]
    pub port: u16,

    pub user: String,
    pub auth: HostAuth,

    /// Canonical OS tag detected from the remote endpoint, for example
    /// `ubuntu` / `debian` / `windows`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_type: Option<String>,

    /// Port forwards to start after this session authenticates. Empty
    /// for hosts saved before this field was introduced.
    #[serde(default)]
    pub forwards: Vec<ForwardSpec>,

    /// Id of another saved host to use as a ProxyJump. The jump host
    /// must already exist in the vault.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_jump_host_id: Option<String>,

    /// Vault id of the `host_group` this host belongs to, or `None` for
    /// the "Ungrouped" bucket. References that point to a non-existent /
    /// tombstoned group are treated as "Ungrouped" by the UI without
    /// rewriting the vault — see [`crate::host_group::HostGroup`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

fn default_port() -> u16 {
    22
}

/// How to authenticate. Mirrors [`zeroterm_ssh::AuthMethod`] but stores
/// material the vault can carry across devices (key bytes, not file
/// paths).
///
/// `Debug` is hand-written so `{:?}` never prints the password /
/// passphrase / private-key PEM (SSH-14 / CORE-9). `Serialize` still
/// emits the real fields — that ciphertext path is the vault's, and is
/// encrypted at rest.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostAuth {
    Password {
        value: String,
    },
    PrivateKey {
        key_pem: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    Agent,
}

impl std::fmt::Debug for HostAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostAuth::Password { .. } => f.write_str("Password { value: <redacted> }"),
            HostAuth::PrivateKey { passphrase, .. } => f
                .debug_struct("PrivateKey")
                .field("key_pem", &"<redacted>")
                .field(
                    "passphrase",
                    &if passphrase.is_some() { "<redacted>" } else { "None" },
                )
                .finish(),
            HostAuth::Agent => f.write_str("Agent"),
        }
    }
}

impl Drop for HostAuth {
    fn drop(&mut self) {
        match self {
            Self::Password { value } => value.zeroize(),
            Self::PrivateKey {
                key_pem,
                passphrase,
            } => {
                key_pem.zeroize();
                passphrase.zeroize();
            }
            Self::Agent => {}
        }
    }
}

/// Saved forward spec. Mirrors the subset of OpenSSH `-L`/`-R`/`-D` syntax
/// we support today.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardSpec {
    /// `ssh -L bind_addr:bind_port:target_host:target_port`
    Local {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    /// `ssh -R bind_addr:bind_port:target_host:target_port`
    Remote {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    /// `ssh -D bind_addr:bind_port` (SOCKS5)
    Dynamic {
        #[serde(default = "default_forward_enabled")]
        enabled: bool,
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
    },
}

fn default_forward_enabled() -> bool {
    true
}

fn default_bind_addr() -> String {
    "127.0.0.1".to_string()
}

impl ForwardSpec {
    /// Short human-readable summary, e.g. `L 8080:127.0.0.1:80` or
    /// `D 1080`. Used in CLI listings and the desktop terminal header.
    pub fn summary(&self) -> String {
        match self {
            ForwardSpec::Local {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => {
                let prefix = if *enabled { "L" } else { "L(off)" };
                if bind_addr == "127.0.0.1" {
                    format!("{prefix} {bind_port}:{target_host}:{target_port}")
                } else {
                    format!("{prefix} {bind_addr}:{bind_port}:{target_host}:{target_port}")
                }
            }
            ForwardSpec::Dynamic {
                enabled,
                bind_addr,
                bind_port,
            } => {
                let prefix = if *enabled { "D" } else { "D(off)" };
                if bind_addr == "127.0.0.1" {
                    format!("{prefix} {bind_port}")
                } else {
                    format!("{prefix} {bind_addr}:{bind_port}")
                }
            }
            ForwardSpec::Remote {
                enabled,
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => {
                let prefix = if *enabled { "R" } else { "R(off)" };
                if bind_addr == "127.0.0.1" {
                    format!("{prefix} {bind_port}:{target_host}:{target_port}")
                } else {
                    format!("{prefix} {bind_addr}:{bind_port}:{target_host}:{target_port}")
                }
            }
        }
    }
}

impl Host {
    /// Translate a saved host's auth into the SSH-layer enum, ready to
    /// hand to [`zeroterm_ssh::ConnectConfig::auth_methods`].
    pub fn to_auth_methods(&self) -> Vec<AuthMethod> {
        match &self.auth {
            HostAuth::Password { value } => vec![AuthMethod::Password(value.clone())],
            HostAuth::PrivateKey {
                key_pem,
                passphrase,
            } => vec![AuthMethod::PrivateKeyData {
                pem: key_pem.clone(),
                passphrase: passphrase.clone(),
            }],
            HostAuth::Agent => vec![AuthMethod::Agent],
        }
    }
}
