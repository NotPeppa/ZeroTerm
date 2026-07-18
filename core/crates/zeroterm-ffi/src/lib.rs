//! ZeroTerm FFI surface.
//!
//! Generated bindings (Swift, Kotlin) are produced by `uniffi-bindgen`
//! against the `cdylib` output of this crate — see `README.md` for the
//! commands.
//!
//! Coverage:
//!   - Vault: unlock / create / lock / status, host CRUD, snippets CRUD
//!   - Session: connect (async), input, resize, disconnect
//!   - Terminal: VT emulator (feed / takeDamage / resize / snapshot)
//!   - SFTP: open/list/mkdir/rename/remove + download/upload with progress
//!   - Sync: profiles, create/join repo, syncNow, conflicts
//!   - Foreign callbacks: SessionListener, HostKeyPromptCallback, TransferListener
//!   - Error: FfiError with stable, language-friendly variants

uniffi::setup_scaffolding!("zeroterm");

mod error;
mod facade;
mod listener;
mod sftp;
mod sync_api;
mod term;
mod types;

pub use error::FfiError;
pub use facade::ZeroTerm;
pub use listener::{HostKeyPromptCallback, SessionListener};
pub use sftp::{SftpDirEntry, SftpFileKind, TransferListener, TransferProgress};
pub use sync_api::{
    ConflictRecord, SyncBackendKind, SyncCompactRecord, SyncDeviceRecord, SyncOutcomeRecord,
    SyncProfileInput, SyncProfileSummary, SyncRepoStatsRecord, SyncStatusRecord,
};
pub use term::{DamageFrame, DamageLine, TermCell, Terminal, TerminalPalette};
pub use types::{
    AiChatMessage, AiChatResponse, AiProfileInput, AiProfileRecord, AuthKind, HostAuthInput,
    HostDetail, HostExecResult, HostGroupInput, HostGroupRecord, HostInput, HostKeyInfo, HostSummary,
    SnippetInput, SnippetRecord, VaultStatus,
};

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh(zt: &ZeroTerm, dir: &std::path::Path) {
        zt.set_vault_path(dir.join("v.sqlite").to_string_lossy().to_string());
    }

    fn with_data_dir(zt: &ZeroTerm, dir: &std::path::Path) {
        zt.set_data_dir(dir.to_string_lossy().to_string());
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
                id: None,
                name: "prod".into(),
                host: "10.0.0.1".into(),
                port: 22,
                user: "deploy".into(),
                auth: HostAuthInput::Password { value: "p".into() },
                group_id: None,
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
    fn host_groups_are_exposed_to_mobile_clients() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());
        zt.create("hunter2".into(), false).unwrap();

        let parent_id = zt
            .save_host_group(HostGroupInput {
                id: None,
                name: "Production".into(),
                parent_id: None,
                sort_order: 3,
            })
            .unwrap();

        let groups = zt.list_host_groups().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, parent_id);
        assert_eq!(groups[0].name, "Production");
        assert_eq!(groups[0].sort_order, 3);

        zt.save_host_group(HostGroupInput {
            id: Some(parent_id.clone()),
            name: "Prod".into(),
            parent_id: None,
            sort_order: 4,
        })
        .unwrap();
        assert_eq!(zt.list_host_groups().unwrap()[0].name, "Prod");

        zt.delete_host_group(parent_id).unwrap();
        assert!(zt.list_host_groups().unwrap().is_empty());
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

    #[test]
    fn set_data_dir_drives_default_vault_path() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        with_data_dir(&zt, dir.path());

        let status = zt.vault_status().unwrap();
        assert!(!status.exists);
        assert!(status.path.ends_with("zeroterm.vault"));

        zt.create("hunter2".into(), false).unwrap();
        assert!(dir.path().join("zeroterm.vault").exists());
        assert!(zt.vault_status().unwrap().unlocked);
    }

    #[test]
    fn get_and_update_host() {
        let dir = tempdir().unwrap();
        let zt = ZeroTerm::new();
        fresh(&zt, dir.path());
        zt.create("pw".into(), false).unwrap();

        let id = zt
            .save_host(HostInput {
                id: None,
                name: "box".into(),
                host: "1.2.3.4".into(),
                port: 22,
                user: "root".into(),
                auth: HostAuthInput::Password {
                    value: "secret".into(),
                },
                group_id: None,
            })
            .unwrap();

        let detail = zt.get_host(id.clone()).unwrap();
        assert_eq!(detail.name, "box");
        assert!(matches!(
            detail.auth,
            HostAuthInput::Password { value } if value == "secret"
        ));

        zt.save_host(HostInput {
            id: Some(id.clone()),
            name: "box2".into(),
            host: "5.6.7.8".into(),
            port: 2222,
            user: "admin".into(),
            auth: HostAuthInput::Password {
                value: "new".into(),
            },
            group_id: None,
        })
        .unwrap();

        let detail = zt.get_host(id).unwrap();
        assert_eq!(detail.name, "box2");
        assert_eq!(detail.host, "5.6.7.8");
        assert_eq!(detail.port, 2222);
        assert_eq!(detail.user, "admin");
    }
}
