//! ZeroTerm FFI surface.
//!
//! Generated bindings (Swift, Kotlin) are produced by `uniffi-bindgen`
//! against the `cdylib` output of this crate — see `README.md` for the
//! commands.
//!
//! Coverage:
//!   - Vault: unlock / create / lock / status, host CRUD
//!   - Session: connect (async), input, resize, disconnect
//!   - Foreign callbacks: SessionListener for PTY data, HostKeyPromptCallback
//!     for trust dialogs
//!   - Error: FfiError with stable, language-friendly variants

uniffi::setup_scaffolding!("zeroterm");

mod error;
mod facade;
mod listener;
mod types;

pub use error::FfiError;
pub use facade::ZeroTerm;
pub use listener::{HostKeyPromptCallback, SessionListener};
pub use types::{AuthKind, HostAuthInput, HostInput, HostKeyInfo, HostSummary, VaultStatus};

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh(zt: &ZeroTerm, dir: &std::path::Path) {
        zt.set_vault_path(dir.join("v.sqlite").to_string_lossy().to_string());
    }

    #[test]
    fn vault_lifecycle() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        let status = zt.vault_status().unwrap();
        assert!(!status.exists);
        assert!(!status.unlocked);

        zt.create("hunter2".into(), false).unwrap();
        let status = zt.vault_status().unwrap();
        assert!(status.exists);
        assert!(status.unlocked);

        let id = zt
            .save_host(HostInput {
                name: "prod".into(),
                host: "10.0.0.1".into(),
                port: 22,
                user: "deploy".into(),
                auth: HostAuthInput::Password { value: "p".into() },
            })
            .unwrap();
        let hosts = zt.list_hosts().unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, id);
        assert!(matches!(hosts[0].auth_kind, AuthKind::Password));

        zt.delete_host(id).unwrap();
        assert!(zt.list_hosts().unwrap().is_empty());

        zt.lock();
        match zt.list_hosts() {
            Err(FfiError::VaultLocked) => {}
            other => panic!("expected VaultLocked, got {other:?}"),
        }

        match zt.unlock("WRONG".into(), false) {
            Err(FfiError::AuthenticationFailed) => {}
            other => panic!("expected AuthenticationFailed, got {other:?}"),
        }

        zt.unlock("hunter2".into(), false).unwrap();
        assert!(zt.list_hosts().unwrap().is_empty());
    }

    #[test]
    fn locked_operations_rejected() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        match zt.list_hosts() {
            Err(FfiError::VaultLocked) => {}
            other => panic!("expected VaultLocked, got {other:?}"),
        }
    }

    #[test]
    fn create_twice_rejected() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        zt.create("a".into(), false).unwrap();
        zt.lock();
        match zt.create("b".into(), false) {
            Err(FfiError::AlreadyExists) => {}
            other => panic!("expected AlreadyExists, got {other:?}"),
        }
    }

    #[test]
    fn unlock_missing_vault_rejected() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        match zt.unlock("any".into(), false) {
            Err(FfiError::NotInitialized) => {}
            other => panic!("expected NotInitialized, got {other:?}"),
        }
    }

    #[test]
    fn respond_host_key_for_unknown_id_errors() {
        let zt = ZeroTerm::new();
        match zt.respond_host_key("does-not-exist".into(), true) {
            Err(FfiError::NotFound { .. }) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn try_keychain_unlock_with_no_vault_returns_false() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        // Vault doesn't exist yet → must short-circuit to false, not error.
        assert!(!zt.try_keychain_unlock().unwrap());
    }

    #[test]
    fn try_keychain_unlock_without_remembered_password_returns_false() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());

        // Vault exists but no `remember` was ever passed → keychain has
        // nothing for this brand-new tempdir path, so try should miss.
        zt.create("pw".into(), false).unwrap();
        zt.lock();
        assert!(!zt.try_keychain_unlock().unwrap());
    }
}
