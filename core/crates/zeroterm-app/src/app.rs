//! Vault-aware host orchestration.
//!
//! [`App`] sits between the storage/crypto layer (`zeroterm-vault`) and
//! the SSH layer (`zeroterm-ssh`). It handles the host CRUD that any UI
//! (CLI today, Tauri/iOS/Android later) needs, plus the conversion from
//! a stored [`Host`] into a ready-to-use [`zeroterm_ssh::ConnectConfig`].

use std::path::Path;
use std::time::Duration;

use zeroterm_ssh::{ConnectConfig, HostKeyPolicy};
use zeroterm_vault::Vault;

use crate::error::AppError;
use crate::host::Host;

const HOST_KIND: &str = "host";

pub struct App {
    vault: Vault,
}

impl App {
    /// Open an existing vault. Returns `VaultError::AuthenticationFailed`
    /// if the master password is wrong.
    pub fn open<P: AsRef<Path>>(path: P, master_password: &str) -> Result<Self, AppError> {
        let vault = Vault::unlock(path, master_password)?;
        Ok(Self { vault })
    }

    /// Create a brand-new vault at this path. Fails if one already exists.
    pub fn create<P: AsRef<Path>>(path: P, master_password: &str) -> Result<Self, AppError> {
        let vault = Vault::create(path, master_password)?;
        Ok(Self { vault })
    }

    /// Cheap existence check — does NOT unlock.
    pub fn vault_exists<P: AsRef<Path>>(path: P) -> bool {
        path.as_ref().exists()
    }

    // -- host CRUD ----------------------------------------------------------

    pub fn list_hosts(&self) -> Result<Vec<Host>, AppError> {
        let records = self.vault.list(HOST_KIND)?;
        let mut hosts = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<Host>(&plaintext) {
                Ok(mut h) => {
                    h.id = id;
                    hosts.push(h);
                }
                Err(e) => {
                    tracing::warn!(record_id = %id, error = %e, "skipping malformed host record");
                }
            }
        }
        // Sort by name for stable display.
        hosts.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(hosts)
    }

    pub fn find_host_by_name(&self, name: &str) -> Result<Option<Host>, AppError> {
        Ok(self.list_hosts()?.into_iter().find(|h| h.name == name))
    }

    pub fn find_host_by_id(&self, id: &str) -> Result<Option<Host>, AppError> {
        match self.vault.get(id) {
            Ok(plaintext) => {
                let mut h: Host =
                    serde_json::from_slice(&plaintext).map_err(AppError::BadHostRecord)?;
                h.id = id.to_string();
                Ok(Some(h))
            }
            Err(zeroterm_vault::VaultError::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Save a new host. Fails if a host with this name already exists.
    pub fn save_host(&self, host: &Host) -> Result<String, AppError> {
        if self.find_host_by_name(&host.name)?.is_some() {
            return Err(AppError::HostNameTaken(host.name.clone()));
        }
        let json = serde_json::to_vec(host).map_err(AppError::BadHostRecord)?;
        Ok(self.vault.insert(HOST_KIND, &json)?)
    }

    /// Replace an existing host by id.
    pub fn update_host(&self, host: &Host) -> Result<(), AppError> {
        let json = serde_json::to_vec(host).map_err(AppError::BadHostRecord)?;
        self.vault.update(&host.id, &json)?;
        Ok(())
    }

    pub fn delete_host(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
    }

    // -- ssh connect helper -------------------------------------------------

    /// Build the SSH-layer config for a saved host. The caller decides
    /// the host-key policy (different UIs prompt differently) and any
    /// timeouts.
    pub fn connect_config(
        &self,
        host: &Host,
        host_key_policy: HostKeyPolicy,
        connect_timeout: Option<Duration>,
    ) -> ConnectConfig {
        ConnectConfig {
            host: host.host.clone(),
            port: host.port,
            username: host.user.clone(),
            auth_methods: host.to_auth_methods(),
            connect_timeout,
            host_key_policy,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::HostAuth;
    use tempfile::tempdir;
    use zeroterm_vault::Argon2Params;

    fn fresh_app(dir: &Path) -> App {
        // Fast Argon2 params for tests — see vault tests for the same pattern.
        let path = dir.join("v.sqlite");
        let vault = Vault::create_with_params(
            &path,
            "pw",
            Argon2Params {
                m_cost: 8 * 1024,
                t_cost: 1,
                p_cost: 1,
            },
        )
        .unwrap();
        App { vault }
    }

    fn sample_host(name: &str) -> Host {
        Host {
            id: String::new(),
            name: name.into(),
            host: "10.0.0.1".into(),
            port: 22,
            user: "deploy".into(),
            auth: HostAuth::Password {
                value: "hunter2".into(),
            },
            os_type: None,
            forwards: Vec::new(),
            proxy_jump: None,
        }
    }

    #[test]
    fn save_and_list() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());

        let id_a = app.save_host(&sample_host("a")).unwrap();
        let id_b = app.save_host(&sample_host("b")).unwrap();
        assert_ne!(id_a, id_b);

        let hosts = app.list_hosts().unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].name, "a");
        assert_eq!(hosts[1].name, "b");
        // ids are populated from the vault on read.
        assert!(!hosts[0].id.is_empty());
    }

    #[test]
    fn save_duplicate_name_rejected() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());

        app.save_host(&sample_host("a")).unwrap();
        match app.save_host(&sample_host("a")) {
            Err(AppError::HostNameTaken(name)) => assert_eq!(name, "a"),
            other => panic!("expected HostNameTaken, got {other:?}"),
        }
    }

    #[test]
    fn find_by_name_and_id() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        let id = app.save_host(&sample_host("a")).unwrap();

        let by_name = app.find_host_by_name("a").unwrap().unwrap();
        assert_eq!(by_name.id, id);

        let by_id = app.find_host_by_id(&id).unwrap().unwrap();
        assert_eq!(by_id.name, "a");

        assert!(app.find_host_by_name("missing").unwrap().is_none());
        assert!(app.find_host_by_id("missing-id").unwrap().is_none());
    }

    #[test]
    fn delete_then_list() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        let id = app.save_host(&sample_host("a")).unwrap();

        app.delete_host(&id).unwrap();
        assert!(app.list_hosts().unwrap().is_empty());
    }

    #[test]
    fn connect_config_has_auth_method() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        app.save_host(&sample_host("a")).unwrap();

        let host = app.find_host_by_name("a").unwrap().unwrap();
        let cfg = app.connect_config(&host, HostKeyPolicy::AcceptAll, None);
        assert_eq!(cfg.host, "10.0.0.1");
        assert_eq!(cfg.port, 22);
        assert_eq!(cfg.username, "deploy");
        assert_eq!(cfg.auth_methods.len(), 1);
    }
}
