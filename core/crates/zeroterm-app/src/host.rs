use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Saved forward spec. Mirrors the subset of OpenSSH `-L`/`-D` syntax
/// we support today; remote forwards (`-R`) will get their own variant
/// once the SSH layer implements them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ForwardSpec {
    /// `ssh -L bind_addr:bind_port:target_host:target_port`
    Local {
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    },
    /// `ssh -D bind_addr:bind_port` (SOCKS5)
    Dynamic {
        #[serde(default = "default_bind_addr")]
        bind_addr: String,
        bind_port: u16,
    },
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
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => {
                if bind_addr == "127.0.0.1" {
                    format!("L {bind_port}:{target_host}:{target_port}")
                } else {
                    format!("L {bind_addr}:{bind_port}:{target_host}:{target_port}")
                }
            }
            ForwardSpec::Dynamic {
                bind_addr,
                bind_port,
            } => {
                if bind_addr == "127.0.0.1" {
                    format!("D {bind_port}")
                } else {
                    format!("D {bind_addr}:{bind_port}")
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
