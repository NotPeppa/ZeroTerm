//! Sync credentials are local to each device. Android's keyring backend is a
//! non-persistent mock, so store its credentials as vault-encrypted local state.
//! This state is excluded from sync events and snapshots.

use crate::{keychain, App, AppError};

#[derive(Clone, Copy)]
pub enum SyncSecret {
    EncryptionPassphrase,
    BackendCredential,
    BackendExtra,
}

impl SyncSecret {
    #[cfg(any(target_os = "android", test))]
    fn local_key(self, profile_id: &str) -> String {
        let kind = match self {
            Self::EncryptionPassphrase => "encryption",
            Self::BackendCredential => "credential",
            Self::BackendExtra => "extra",
        };
        format!("local-sync-secret:{profile_id}:{kind}")
    }

    fn get_keychain(self, profile_id: &str) -> Result<Option<String>, keychain::KeychainError> {
        match self {
            Self::EncryptionPassphrase => keychain::get_sync_encryption_secret(profile_id),
            Self::BackendCredential => keychain::get_sync_backend_credential(profile_id),
            Self::BackendExtra => keychain::get_sync_backend_extra(profile_id),
        }
    }
}

fn keychain_error(error: keychain::KeychainError) -> AppError {
    AppError::SyncConfig(format!("keychain: {error}"))
}

impl App {
    pub fn get_sync_secret(
        &self,
        profile_id: &str,
        kind: SyncSecret,
    ) -> Result<Option<String>, AppError> {
        #[cfg(target_os = "android")]
        {
            let key = kind.local_key(profile_id);
            if self.vault.get_sync_state(&key)?.is_some() {
                return self.get_local_sync_secret(profile_id, kind);
            }
            // Preserve credentials entered earlier in this running process.
            let secret = kind.get_keychain(profile_id).map_err(keychain_error)?;
            if let Some(secret) = secret.as_deref() {
                self.save_local_sync_secret(profile_id, kind, Some(secret))?;
            }
            Ok(secret)
        }
        #[cfg(not(target_os = "android"))]
        kind.get_keychain(profile_id).map_err(keychain_error)
    }

    pub fn save_sync_secret(
        &self,
        profile_id: &str,
        kind: SyncSecret,
        secret: &str,
    ) -> Result<(), AppError> {
        #[cfg(target_os = "android")]
        return self.save_local_sync_secret(profile_id, kind, Some(secret));
        #[cfg(not(target_os = "android"))]
        match kind {
            SyncSecret::EncryptionPassphrase => {
                keychain::save_sync_encryption_secret(profile_id, secret)
            }
            SyncSecret::BackendCredential => {
                keychain::save_sync_backend_credential(profile_id, secret)
            }
            SyncSecret::BackendExtra => keychain::save_sync_backend_extra(profile_id, secret),
        }
        .map_err(keychain_error)
    }

    pub fn forget_sync_secret(&self, profile_id: &str, kind: SyncSecret) -> Result<(), AppError> {
        #[cfg(target_os = "android")]
        self.save_local_sync_secret(profile_id, kind, None)?;
        match kind {
            SyncSecret::EncryptionPassphrase => keychain::forget_sync_encryption_secret(profile_id),
            SyncSecret::BackendCredential => keychain::forget_sync_backend_credential(profile_id),
            SyncSecret::BackendExtra => keychain::forget_sync_backend_extra(profile_id),
        }
        .map_err(keychain_error)
    }

    #[cfg(any(target_os = "android", test))]
    fn save_local_sync_secret(
        &self,
        profile_id: &str,
        kind: SyncSecret,
        secret: Option<&str>,
    ) -> Result<(), AppError> {
        let key = kind.local_key(profile_id);
        let blob = match secret {
            Some(secret) => self.vault.encrypt_local_blob(&key, secret.as_bytes())?,
            // A marker prevents migration from resurrecting a deleted secret.
            None => Vec::new(),
        };
        self.vault.put_sync_state(&key, &blob)?;
        Ok(())
    }

    #[cfg(any(target_os = "android", test))]
    fn get_local_sync_secret(
        &self,
        profile_id: &str,
        kind: SyncSecret,
    ) -> Result<Option<String>, AppError> {
        let key = kind.local_key(profile_id);
        let Some(blob) = self.vault.get_sync_state(&key)? else {
            return Ok(None);
        };
        if blob.is_empty() {
            return Ok(None);
        }
        let plaintext = self.vault.decrypt_local_blob(&key, &blob)?;
        String::from_utf8(plaintext.to_vec())
            .map(Some)
            .map_err(|_| AppError::SyncConfig("saved sync secret is not valid UTF-8".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_secrets_survive_reopen_and_stay_out_of_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault");
        let app = App::create(&path, "master").unwrap();
        for (kind, value) in [
            (SyncSecret::EncryptionPassphrase, "sync-passphrase"),
            (SyncSecret::BackendCredential, "s3-secret"),
            (SyncSecret::BackendExtra, "session-token"),
        ] {
            app.save_local_sync_secret("profile", kind, Some(value))
                .unwrap();
            let blob = app
                .vault
                .get_sync_state(&kind.local_key("profile"))
                .unwrap()
                .unwrap();
            assert!(!blob
                .windows(value.len())
                .any(|bytes| bytes == value.as_bytes()));
        }
        assert!(app.vault.list_all_records().unwrap().is_empty());
        drop(app);
        let app = App::open(&path, "master").unwrap();
        assert_eq!(
            app.get_local_sync_secret("profile", SyncSecret::BackendCredential)
                .unwrap()
                .as_deref(),
            Some("s3-secret")
        );
        assert_eq!(
            app.get_local_sync_secret("profile", SyncSecret::EncryptionPassphrase)
                .unwrap()
                .as_deref(),
            Some("sync-passphrase")
        );
        assert_eq!(
            app.get_local_sync_secret("profile", SyncSecret::BackendExtra)
                .unwrap()
                .as_deref(),
            Some("session-token")
        );
        assert!(app
            .get_local_sync_secret("other", SyncSecret::BackendCredential)
            .unwrap()
            .is_none());
        app.save_local_sync_secret("profile", SyncSecret::BackendCredential, None)
            .unwrap();
        drop(app);
        let app = App::open(&path, "master").unwrap();
        assert!(app
            .get_local_sync_secret("profile", SyncSecret::BackendCredential)
            .unwrap()
            .is_none());
    }

    #[test]
    fn encrypted_secrets_cannot_be_swapped_between_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::create(dir.path().join("vault"), "master").unwrap();
        let kind = SyncSecret::BackendCredential;
        app.save_local_sync_secret("first", kind, Some("s3-secret"))
            .unwrap();
        let blob = app
            .vault
            .get_sync_state(&kind.local_key("first"))
            .unwrap()
            .unwrap();
        app.vault
            .put_sync_state(&kind.local_key("second"), &blob)
            .unwrap();
        assert!(app.get_local_sync_secret("second", kind).is_err());
    }
}
