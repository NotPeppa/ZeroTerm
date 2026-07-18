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
use crate::ai::AiProfile;
use crate::host::Host;
use crate::host_group::HostGroup;
use crate::port_forward::PortForwardRule;
use crate::snippet::Snippet;

const HOST_KIND: &str = "host";
const HOST_GROUP_KIND: &str = "host_group";
const PORT_FORWARD_KIND: &str = "port_forward";
const SNIPPET_KIND: &str = "snippet";
const AI_PROFILE_KIND: &str = "ai_profile";

#[derive(Debug, Clone)]
pub struct HostDiagnostics {
    pub raw_host_records: usize,
    pub parsed_hosts: usize,
    pub malformed_hosts: usize,
}

pub struct App {
    pub(crate) vault: Vault,
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

    /// Vault-level identifier, stable across reopens. Stamped into sync
    /// repos so two devices can verify they share the same vault.
    pub fn vault_id(&self) -> &str {
        self.vault.vault_id()
    }

    // -- AI profile CRUD ---------------------------------------------------

    pub fn list_ai_profiles(&self) -> Result<Vec<AiProfile>, AppError> {
        let records = self.vault.list(AI_PROFILE_KIND)?;
        let mut profiles = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<AiProfile>(&plaintext) {
                Ok(mut profile) => {
                    profile.id = id;
                    profiles.push(profile);
                }
                Err(error) => {
                    tracing::warn!(record_id = %id, %error, "skipping malformed AI profile");
                }
            }
        }
        profiles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(profiles)
    }

    pub fn find_ai_profile_by_id(&self, id: &str) -> Result<Option<AiProfile>, AppError> {
        match self.vault.get(id) {
            Ok(plaintext) => {
                let mut profile: AiProfile = serde_json::from_slice(&plaintext)
                    .map_err(AppError::BadAiProfileRecord)?;
                profile.id = id.to_string();
                Ok(Some(profile))
            }
            Err(zeroterm_vault::VaultError::NotFound(_)) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_ai_profile(&self, profile: &AiProfile) -> Result<String, AppError> {
        validate_ai_profile(profile)?;
        let json = serde_json::to_vec(profile).map_err(AppError::BadAiProfileRecord)?;
        Ok(self.vault.insert(AI_PROFILE_KIND, &json)?)
    }

    pub fn update_ai_profile(&self, profile: &AiProfile) -> Result<(), AppError> {
        if profile.id.is_empty() {
            return Err(AppError::BadAiProfile("id is required for update".into()));
        }
        validate_ai_profile(profile)?;
        let json = serde_json::to_vec(profile).map_err(AppError::BadAiProfileRecord)?;
        self.vault.update(&profile.id, &json)?;
        Ok(())
    }

    pub fn delete_ai_profile(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
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

    pub fn host_diagnostics(&self) -> Result<HostDiagnostics, AppError> {
        let records = self.vault.list(HOST_KIND)?;
        let mut parsed_hosts = 0usize;
        let mut malformed_hosts = 0usize;
        for (id, plaintext) in records.iter() {
            match serde_json::from_slice::<Host>(plaintext) {
                Ok(_) => parsed_hosts += 1,
                Err(e) => {
                    malformed_hosts += 1;
                    tracing::warn!(record_id = %id, error = %e, "malformed host record while collecting diagnostics");
                }
            }
        }
        Ok(HostDiagnostics {
            raw_host_records: records.len(),
            parsed_hosts,
            malformed_hosts,
        })
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

    /// Save a new host.
    pub fn save_host(&self, host: &Host) -> Result<String, AppError> {
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

    // -- standalone port forward CRUD --------------------------------------

    pub fn list_port_forwards(&self) -> Result<Vec<PortForwardRule>, AppError> {
        let records = self.vault.list(PORT_FORWARD_KIND)?;
        let mut rules = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<PortForwardRule>(&plaintext) {
                Ok(mut r) => {
                    r.id = id;
                    rules.push(r);
                }
                Err(e) => {
                    tracing::warn!(record_id = %id, error = %e, "skipping malformed port_forward record");
                }
            }
        }
        Ok(rules)
    }

    pub fn find_port_forward_by_id(&self, id: &str) -> Result<Option<PortForwardRule>, AppError> {
        match self.vault.get(id) {
            Ok(plaintext) => {
                let mut r: PortForwardRule =
                    serde_json::from_slice(&plaintext).map_err(AppError::BadHostRecord)?;
                r.id = id.to_string();
                Ok(Some(r))
            }
            Err(zeroterm_vault::VaultError::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save_port_forward(&self, rule: &PortForwardRule) -> Result<String, AppError> {
        if self.find_host_by_id(&rule.host_id)?.is_none() {
            return Err(AppError::HostNotFound(rule.host_id.clone()));
        }
        let json = serde_json::to_vec(rule).map_err(AppError::BadHostRecord)?;
        Ok(self.vault.insert(PORT_FORWARD_KIND, &json)?)
    }

    pub fn update_port_forward(&self, rule: &PortForwardRule) -> Result<(), AppError> {
        if rule.id.is_empty() {
            return Err(AppError::HostNotFound("port forward id is required".into()));
        }
        if self.find_host_by_id(&rule.host_id)?.is_none() {
            return Err(AppError::HostNotFound(rule.host_id.clone()));
        }
        let json = serde_json::to_vec(rule).map_err(AppError::BadHostRecord)?;
        self.vault.update(&rule.id, &json)?;
        Ok(())
    }

    pub fn delete_port_forward(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
    }

    pub fn migrate_embedded_port_forwards(&self) -> Result<usize, AppError> {
        let mut migrated = 0usize;
        for mut host in self.list_hosts()? {
            if host.forwards.is_empty() {
                continue;
            }
            let forwards = std::mem::take(&mut host.forwards);
            for spec in forwards {
                let rule = PortForwardRule {
                    id: String::new(),
                    host_id: host.id.clone(),
                    spec,
                };
                self.save_port_forward(&rule)?;
                migrated += 1;
            }
            self.update_host(&host)?;
        }
        Ok(migrated)
    }

    pub fn clear_vault_data(&self) -> Result<(), AppError> {
        self.vault.clear_all_data()?;
        Ok(())
    }

    // -- host group CRUD ----------------------------------------------------

    pub fn list_host_groups(&self) -> Result<Vec<HostGroup>, AppError> {
        let records = self.vault.list(HOST_GROUP_KIND)?;
        let mut groups = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<HostGroup>(&plaintext) {
                Ok(mut g) => {
                    g.id = id;
                    groups.push(g);
                }
                Err(e) => {
                    tracing::warn!(record_id = %id, error = %e, "skipping malformed host_group record");
                }
            }
        }
        groups.sort_by(|a, b| {
            a.sort_order
                .cmp(&b.sort_order)
                .then_with(|| a.name.cmp(&b.name))
        });
        Ok(groups)
    }

    pub fn find_host_group_by_id(&self, id: &str) -> Result<Option<HostGroup>, AppError> {
        match self.vault.get(id) {
            Ok(plaintext) => {
                let mut g: HostGroup =
                    serde_json::from_slice(&plaintext).map_err(AppError::BadHostRecord)?;
                g.id = id.to_string();
                Ok(Some(g))
            }
            Err(zeroterm_vault::VaultError::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Insert a new host group. Pre-validates parent existence and rejects
    /// pointing at a non-existent group. Caller assigns no id; the vault
    /// returns one.
    pub fn save_host_group(&self, group: &HostGroup) -> Result<String, AppError> {
        if let Some(pid) = group.parent_id.as_deref() {
            if pid.is_empty() {
                return Err(AppError::BadHostGroup("parent_id cannot be empty".into()));
            }
            if self.find_host_group_by_id(pid)?.is_none() {
                return Err(AppError::BadHostGroup(format!(
                    "parent host_group {pid} does not exist"
                )));
            }
        }
        if group.name.trim().is_empty() {
            return Err(AppError::BadHostGroup("name cannot be empty".into()));
        }
        let json = serde_json::to_vec(group).map_err(AppError::BadHostRecord)?;
        Ok(self.vault.insert(HOST_GROUP_KIND, &json)?)
    }

    /// Replace an existing host group by id. Rejects self-parenting,
    /// parents that don't exist, and any change that would form a cycle.
    pub fn update_host_group(&self, group: &HostGroup) -> Result<(), AppError> {
        if group.id.is_empty() {
            return Err(AppError::BadHostGroup("id is required for update".into()));
        }
        if group.name.trim().is_empty() {
            return Err(AppError::BadHostGroup("name cannot be empty".into()));
        }
        if let Some(pid) = group.parent_id.as_deref() {
            if pid == group.id {
                return Err(AppError::BadHostGroup(
                    "group cannot be its own parent".into(),
                ));
            }
            if self.find_host_group_by_id(pid)?.is_none() {
                return Err(AppError::BadHostGroup(format!(
                    "parent host_group {pid} does not exist"
                )));
            }
            // Walk up from the proposed parent; if we hit `group.id`, the
            // change would form a cycle (group becomes its own ancestor).
            let all = self.list_host_groups()?;
            let mut cursor = pid.to_string();
            let mut steps = 0usize;
            while let Some(parent) = all.iter().find(|g| g.id == cursor) {
                if let Some(next) = parent.parent_id.as_deref() {
                    if next == group.id {
                        return Err(AppError::BadHostGroup("move would create a cycle".into()));
                    }
                    cursor = next.to_string();
                    steps += 1;
                    if steps > all.len() {
                        // Existing data already has a cycle. Refuse the
                        // write so we don't entrench it; the caller can
                        // break the cycle by clearing parent_id elsewhere.
                        return Err(AppError::BadHostGroup(
                            "cannot traverse parents: existing cycle".into(),
                        ));
                    }
                } else {
                    break;
                }
            }
        }
        let json = serde_json::to_vec(group).map_err(AppError::BadHostRecord)?;
        self.vault.update(&group.id, &json)?;
        Ok(())
    }

    /// Delete a host group. Member hosts and child groups are NOT
    /// rewritten — the UI treats orphan references as "Ungrouped" / root
    /// respectively. See [`HostGroup`] doc.
    pub fn delete_host_group(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
    }

    // -- snippet CRUD -------------------------------------------------------

    pub fn list_snippets(&self) -> Result<Vec<Snippet>, AppError> {
        let records = self.vault.list(SNIPPET_KIND)?;
        let mut snippets = Vec::with_capacity(records.len());
        for (id, plaintext) in records {
            match serde_json::from_slice::<Snippet>(&plaintext) {
                Ok(mut s) => {
                    s.id = id;
                    snippets.push(s);
                }
                Err(e) => {
                    tracing::warn!(record_id = %id, error = %e, "skipping malformed snippet record");
                }
            }
        }
        // Stable display order: group, then explicit sort_order, then title.
        snippets.sort_by(|a, b| {
            a.group
                .cmp(&b.group)
                .then_with(|| a.sort_order.cmp(&b.sort_order))
                .then_with(|| a.title.cmp(&b.title))
        });
        Ok(snippets)
    }

    pub fn find_snippet_by_id(&self, id: &str) -> Result<Option<Snippet>, AppError> {
        match self.vault.get(id) {
            Ok(plaintext) => {
                let mut s: Snippet =
                    serde_json::from_slice(&plaintext).map_err(AppError::BadSnippetRecord)?;
                s.id = id.to_string();
                Ok(Some(s))
            }
            Err(zeroterm_vault::VaultError::NotFound(_)) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Save a new snippet. Caller assigns no id; the vault returns one.
    pub fn save_snippet(&self, snippet: &Snippet) -> Result<String, AppError> {
        if snippet.title.trim().is_empty() {
            return Err(AppError::BadSnippet("title cannot be empty".into()));
        }
        if snippet.command.trim().is_empty() {
            return Err(AppError::BadSnippet("command cannot be empty".into()));
        }
        let json = serde_json::to_vec(snippet).map_err(AppError::BadSnippetRecord)?;
        Ok(self.vault.insert(SNIPPET_KIND, &json)?)
    }

    /// Replace an existing snippet by id.
    pub fn update_snippet(&self, snippet: &Snippet) -> Result<(), AppError> {
        if snippet.id.is_empty() {
            return Err(AppError::BadSnippet("id is required for update".into()));
        }
        if snippet.title.trim().is_empty() {
            return Err(AppError::BadSnippet("title cannot be empty".into()));
        }
        if snippet.command.trim().is_empty() {
            return Err(AppError::BadSnippet("command cannot be empty".into()));
        }
        let json = serde_json::to_vec(snippet).map_err(AppError::BadSnippetRecord)?;
        self.vault.update(&snippet.id, &json)?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<(), AppError> {
        self.vault.delete(id)?;
        Ok(())
    }

    /// Rename a group across every snippet currently in it. A snippet's
    /// group is just a string field, so "renaming a group" means
    /// rewriting that field on each member — one vault update per
    /// snippet. Returns the number of snippets touched.
    pub fn rename_snippet_group(&self, old: &str, new: &str) -> Result<usize, AppError> {
        let mut touched = 0usize;
        for mut s in self.list_snippets()? {
            if s.group == old {
                s.group = new.to_string();
                self.update_snippet(&s)?;
                touched += 1;
            }
        }
        Ok(touched)
    }

    /// Delete every snippet in a group, mirroring the original frontend
    /// behaviour where removing a group dropped its members. Returns the
    /// number of snippets deleted.
    pub fn delete_snippet_group(&self, group: &str) -> Result<usize, AppError> {
        let mut deleted = 0usize;
        for s in self.list_snippets()? {
            if s.group == group {
                self.delete_snippet(&s.id)?;
                deleted += 1;
            }
        }
        Ok(deleted)
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

fn validate_ai_profile(profile: &AiProfile) -> Result<(), AppError> {
    if profile.name.trim().is_empty() {
        return Err(AppError::BadAiProfile("name cannot be empty".into()));
    }
    if profile.base_url.trim().is_empty() {
        return Err(AppError::BadAiProfile("base URL cannot be empty".into()));
    }
    if profile.model.trim().is_empty() {
        return Err(AppError::BadAiProfile("model cannot be empty".into()));
    }
    Ok(())
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
            proxy_jump_host_id: None,
            group_id: None,
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
    fn save_duplicate_name_allowed() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());

        let id_a = app.save_host(&sample_host("a")).unwrap();
        let id_b = app.save_host(&sample_host("a")).unwrap();
        assert_ne!(id_a, id_b);
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

    // -- snippet tests ------------------------------------------------------

    fn sample_snippet(title: &str, group: &str) -> Snippet {
        Snippet {
            id: String::new(),
            title: title.into(),
            command: format!("echo {title}"),
            group: group.into(),
            sort_order: 0,
        }
    }

    #[test]
    fn snippet_save_list_update_delete() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());

        let id = app.save_snippet(&sample_snippet("ps", "docker")).unwrap();
        app.save_snippet(&sample_snippet("ls", "")).unwrap();

        let all = app.list_snippets().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|s| !s.id.is_empty()));

        let mut first = app.find_snippet_by_id(&id).unwrap().unwrap();
        assert_eq!(first.title, "ps");
        first.command = "docker ps -a".into();
        app.update_snippet(&first).unwrap();
        assert_eq!(
            app.find_snippet_by_id(&id).unwrap().unwrap().command,
            "docker ps -a"
        );

        app.delete_snippet(&id).unwrap();
        let rest = app.list_snippets().unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].title, "ls");
    }

    #[test]
    fn snippet_rejects_empty_title_or_command() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        assert!(app.save_snippet(&sample_snippet("", "g")).is_err());
        let mut blank_cmd = sample_snippet("t", "g");
        blank_cmd.command = "   ".into();
        assert!(app.save_snippet(&blank_cmd).is_err());
    }

    #[test]
    fn rename_snippet_group_rewrites_only_matching_members() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        app.save_snippet(&sample_snippet("a", "old")).unwrap();
        app.save_snippet(&sample_snippet("b", "old")).unwrap();
        app.save_snippet(&sample_snippet("c", "keep")).unwrap();

        let touched = app.rename_snippet_group("old", "new").unwrap();
        assert_eq!(touched, 2);

        let all = app.list_snippets().unwrap();
        assert_eq!(all.iter().filter(|s| s.group == "new").count(), 2);
        assert_eq!(all.iter().filter(|s| s.group == "keep").count(), 1);
        assert_eq!(all.iter().filter(|s| s.group == "old").count(), 0);
    }

    #[test]
    fn delete_snippet_group_removes_all_members() {
        let dir = tempdir().unwrap();
        let app = fresh_app(dir.path());
        app.save_snippet(&sample_snippet("a", "trash")).unwrap();
        app.save_snippet(&sample_snippet("b", "trash")).unwrap();
        app.save_snippet(&sample_snippet("c", "keep")).unwrap();

        let deleted = app.delete_snippet_group("trash").unwrap();
        assert_eq!(deleted, 2);
        let all = app.list_snippets().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].group, "keep");
    }
}
