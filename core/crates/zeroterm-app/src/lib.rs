//! Vault-aware host orchestration for ZeroTerm.
//!
//! Sits between `zeroterm-vault` (storage/crypto) and `zeroterm-ssh`
//! (protocol). Both the CLI and future native UIs talk to this crate
//! rather than the lower layers directly.

mod app;
mod error;
mod host;
mod host_group;
pub mod keychain;
mod port_forward;
mod snippet;
mod sync;

pub use app::{App, HostDiagnostics};
pub use error::AppError;
pub use host::{ForwardSpec, Host, HostAuth};
pub use host_group::HostGroup;
pub use port_forward::PortForwardRule;
pub use snippet::Snippet;
pub use sync::{
    local_device_id, set_sync_known_hosts_path, ConflictResolution, ConflictView, SyncBackend,
    SyncJoinOutcome, SyncManager, SyncOutcome, SyncProfile, SyncStatus,
};

// Re-exported so consumers can pattern-match on the inner vault error
// without taking a direct dependency on `zeroterm-vault`.
pub use zeroterm_vault::VaultError;

/// Default vault location, following each OS's user-data conventions:
///   - Windows: `%APPDATA%\ZeroTerm\zeroterm.vault`
///   - macOS:   `~/Library/Application Support/ZeroTerm/zeroterm.vault`
///   - Linux:   `~/.local/share/ZeroTerm/zeroterm.vault`
///
/// Returns `None` if the OS doesn't expose a data dir (rare; CI containers).
pub fn default_vault_path() -> Option<std::path::PathBuf> {
    dirs::data_dir().map(|d| d.join("ZeroTerm").join("zeroterm.vault"))
}
