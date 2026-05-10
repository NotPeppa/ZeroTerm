//! Vault-aware host orchestration for ZeroTerm.
//!
//! Sits between `zeroterm-vault` (storage/crypto) and `zeroterm-ssh`
//! (protocol). Both the CLI and future native UIs talk to this crate
//! rather than the lower layers directly.

mod app;
mod error;
mod host;
pub mod keychain;

pub use app::App;
pub use error::AppError;
pub use host::{ForwardSpec, Host, HostAuth};

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
