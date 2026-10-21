//! Warpgate (<https://github.com/warp-tech/warpgate>) target directory.
//!
//! Warpgate keeps target addresses and credentials on the gateway. We only
//! read its target list (`GET /@warpgate/api/targets`, no IPs or secrets in
//! the response) and mirror each SSH target as an ordinary saved [`Host`]
//! that logs in to the gateway as `<warpgate user>:<target name>`. Terminal,
//! SFTP and exec-based tools then run on the normal host code paths.

use std::collections::HashMap;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::{App, AppError, Host, HostAuth, HostGroup};

const WARPGATE_PROFILE_KIND: &str = "warpgate_profile";

/// A Warpgate gateway. Stored in the local vault only (the kind is not
/// synced), so the API token and the Warpgate login never leave this
/// device. The SSH login (address, port, username, credential) is copied
/// into every mirrored target.
#[derive(Clone, Serialize, Deserialize)]
pub struct WarpgateProfile {
    #[serde(skip)]
    pub id: String,
    pub name: String,
    /// HTTPS origin, e.g. `https://gateway.example.com:8888`.
    pub api_url: String,
    pub token: String,
    /// Warpgate's SSH listener.
    pub ssh_host: String,
    pub ssh_port: u16,
    /// Warpgate username; targets log in as `<username>:<target name>`.
    pub username: String,
    /// The user's own Warpgate credential, not a target credential.
    pub auth: HostAuth,
    /// SHA-256 of the gateway's TLS certificate (hex, colons allowed).
    /// When set, this exact certificate is trusted instead of the web PKI —
    /// for Warpgate's default self-signed certificate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls_cert_sha256: Option<String>,
    /// Root host group holding the mirrored targets; created on first sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

impl std::fmt::Debug for WarpgateProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WarpgateProfile")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("api_url", &self.api_url)
            .field("token", &"<redacted>")
            .field("ssh_host", &self.ssh_host)
            .field("ssh_port", &self.ssh_port)
            .field("username", &self.username)
            .field("auth", &self.auth)
            .finish()
    }
}

impl Drop for WarpgateProfile {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

impl WarpgateProfile {
    /// The SSH login shared by every mirrored target, as a host template.
    fn gateway_host(&self) -> Host {
        Host {
            id: String::new(),
            name: self.name.clone(),
            host: self.ssh_host.clone(),
            port: self.ssh_port,
            user: self.username.clone(),
            auth: self.auth.clone(),
            os_type: None,
            forwards: Vec::new(),
            proxy_jump_host_id: None,
            group_id: None,
            warpgate: None,
        }
    }
}

/// Marks a host as mirrored from a Warpgate target. Keyed by the target's
/// Warpgate id so renames update the host instead of duplicating it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WarpgateRef {
    pub profile_id: String,
    pub target_id: String,
}

#[derive(Debug, Deserialize)]
pub struct WarpgateTarget {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub group: Option<WarpgateTargetGroup>,
}

#[derive(Debug, Deserialize)]
pub struct WarpgateTargetGroup {
    pub name: String,
}

fn err(msg: impl Into<String>) -> AppError {
    AppError::Warpgate(msg.into())
}

fn parse_fingerprint(s: &str) -> Result<[u8; 32], AppError> {
    let cleaned: String = s
        .trim()
        .trim_start_matches("SHA256:")
        .chars()
        .filter(|c| *c != ':' && !c.is_whitespace())
        .collect();
    hex::decode(&cleaned)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .ok_or_else(|| err("TLS fingerprint must be 64 hex digits (SHA-256)"))
}

/// Trusts exactly one certificate, by SHA-256 of its DER encoding. The
/// handshake signature is still verified, so only the holder of that
/// certificate's private key passes.
#[derive(Debug)]
struct PinnedCert {
    sha256: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCert {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if Sha256::digest(end_entity.as_ref()).as_slice() == self.sha256 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "TLS certificate does not match the pinned fingerprint".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn http_client(profile: &WarpgateProfile) -> Result<reqwest::Client, AppError> {
    let builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none());
    let builder = match profile.tls_cert_sha256.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(pin) => {
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let verifier = PinnedCert {
                sha256: parse_fingerprint(pin)?,
                provider: provider.clone(),
            };
            let tls = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| err(e.to_string()))?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            builder.use_preconfigured_tls(tls)
        }
        None => builder,
    };
    builder.build().map_err(|e| err(e.to_string()))
}

fn targets_url(api_url: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(api_url.trim()).map_err(|_| err("invalid Warpgate URL"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.query().is_some()
    {
        return Err(err("Warpgate URL must be a plain https:// address"));
    }
    Ok(format!("{}/@warpgate/api/targets", url.as_str().trim_end_matches('/')))
}

/// Full `Display` chain: reqwest hides the TLS/IO cause in `source()`.
fn describe(e: &(dyn std::error::Error + 'static)) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        out.push_str(": ");
        out.push_str(&s.to_string());
        cur = s.source();
    }
    out
}

/// SSH targets the token's user is authorized for.
pub async fn fetch_ssh_targets(profile: &WarpgateProfile) -> Result<Vec<WarpgateTarget>, AppError> {
    let resp = http_client(profile)?
        .get(targets_url(&profile.api_url)?)
        .header("X-Warpgate-Token", &profile.token)
        .send()
        .await
        .map_err(|e| err(describe(&e)))?;
    match resp.status().as_u16() {
        200 => {}
        401 | 403 => return Err(err("API token was rejected")),
        s => return Err(err(format!("server returned HTTP {s}"))),
    }
    let targets: Vec<WarpgateTarget> = resp.json().await.map_err(|e| err(describe(&e)))?;
    Ok(targets.into_iter().filter(|t| t.kind == "Ssh").collect())
}

/// Build the host records for `targets`, reusing ids from `existing`
/// (keyed by target id). Returns the hosts plus ids of hosts whose target
/// is gone. Pure so the mapping is testable without a vault or network.
fn mirror_hosts(
    profile_id: &str,
    gateway: &Host,
    targets: &[WarpgateTarget],
    mut existing: HashMap<String, Host>,
    mut group_for: impl FnMut(Option<&str>) -> Result<String, AppError>,
) -> Result<(Vec<Host>, Vec<String>), AppError> {
    let mut hosts = Vec::with_capacity(targets.len());
    for t in targets {
        let prev = existing.remove(&t.id);
        hosts.push(Host {
            id: prev.as_ref().map(|h| h.id.clone()).unwrap_or_default(),
            name: t.name.clone(),
            host: gateway.host.clone(),
            port: gateway.port,
            user: format!("{}:{}", gateway.user, t.name),
            auth: gateway.auth.clone(),
            os_type: prev.as_ref().and_then(|h| h.os_type.clone()),
            forwards: prev.as_ref().map(|h| h.forwards.clone()).unwrap_or_default(),
            proxy_jump_host_id: gateway.proxy_jump_host_id.clone(),
            group_id: Some(group_for(t.group.as_ref().map(|g| g.name.as_str()))?),
            warpgate: Some(WarpgateRef {
                profile_id: profile_id.to_string(),
                target_id: t.id.clone(),
            }),
        });
    }
    let removed = existing.into_values().map(|h| h.id.clone()).collect();
    Ok((hosts, removed))
}

impl App {
    pub fn list_warpgate_profiles(&self) -> Result<Vec<WarpgateProfile>, AppError> {
        let mut out = Vec::new();
        for (id, plaintext) in self.vault.list(WARPGATE_PROFILE_KIND)? {
            match serde_json::from_slice::<WarpgateProfile>(&plaintext) {
                Ok(mut p) => {
                    p.id = id;
                    out.push(p);
                }
                Err(e) => {
                    tracing::warn!(record_id = %id, error = %e, "skipping malformed warpgate profile")
                }
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn find_warpgate_profile(&self, id: &str) -> Result<Option<WarpgateProfile>, AppError> {
        Ok(self.list_warpgate_profiles()?.into_iter().find(|p| p.id == id))
    }

    /// Insert (empty `id`) or replace a profile. Returns its id.
    pub fn save_warpgate_profile(&self, profile: &WarpgateProfile) -> Result<String, AppError> {
        targets_url(&profile.api_url)?;
        if let Some(pin) = profile.tls_cert_sha256.as_deref().filter(|s| !s.trim().is_empty()) {
            parse_fingerprint(pin)?;
        }
        if profile.name.trim().is_empty() || profile.token.trim().is_empty() {
            return Err(err("name and API token are required"));
        }
        if profile.ssh_host.trim().is_empty() || profile.ssh_port == 0 {
            return Err(err("SSH address and port are required"));
        }
        // ':' and '#' separate user from target in Warpgate's SSH username.
        if profile.username.trim().is_empty() || profile.username.contains([':', '#']) {
            return Err(err("Warpgate username is required and cannot contain ':' or '#'"));
        }
        match &profile.auth {
            HostAuth::Password { value } if value.is_empty() => return Err(err("password is required")),
            HostAuth::PrivateKey { key_pem, .. } if key_pem.trim().is_empty() => {
                return Err(err("private key is required"))
            }
            _ => {}
        }
        let json = serde_json::to_vec(profile).map_err(AppError::BadHostRecord)?;
        if profile.id.is_empty() {
            Ok(self.vault.insert(WARPGATE_PROFILE_KIND, &json)?)
        } else {
            self.vault.update(&profile.id, &json)?;
            Ok(profile.id.clone())
        }
    }

    /// Delete the profile together with its mirrored hosts and groups.
    pub fn delete_warpgate_profile(&self, id: &str) -> Result<(), AppError> {
        for h in self.list_hosts()? {
            if h.warpgate.as_ref().is_some_and(|w| w.profile_id == id) {
                self.delete_host(&h.id)?;
            }
        }
        if let Some(root) = self.find_warpgate_profile(id)?.and_then(|p| p.group_id.clone()) {
            for g in self.list_host_groups()? {
                if g.id == root || g.parent_id.as_deref() == Some(root.as_str()) {
                    self.delete_host_group(&g.id)?;
                }
            }
        }
        self.vault.delete(id)?;
        Ok(())
    }

    /// Mirror the gateway's current SSH targets into saved hosts: create
    /// new ones, update existing ones, delete revoked ones. Returns the
    /// number of targets.
    pub async fn sync_warpgate(&self, profile_id: &str) -> Result<usize, AppError> {
        let mut profile = self
            .find_warpgate_profile(profile_id)?
            .ok_or_else(|| err("no such Warpgate profile"))?;
        let gateway = profile.gateway_host();
        let targets = fetch_ssh_targets(&profile).await?;

        let groups = self.list_host_groups()?;
        let root = match profile.group_id.clone().filter(|id| groups.iter().any(|g| &g.id == id)) {
            Some(id) => id,
            None => {
                let id = self.save_host_group(&HostGroup {
                    id: String::new(),
                    name: profile.name.clone(),
                    parent_id: None,
                    sort_order: 0,
                })?;
                profile.group_id = Some(id.clone());
                self.save_warpgate_profile(&profile)?;
                id
            }
        };
        let mut subgroups: HashMap<String, String> = groups
            .iter()
            .filter(|g| g.parent_id.as_deref() == Some(root.as_str()))
            .map(|g| (g.name.clone(), g.id.clone()))
            .collect();

        // Two devices syncing before they see each other's writes can leave
        // duplicates for one target; keep one and delete the rest.
        let mut existing = HashMap::new();
        let mut duplicates = Vec::new();
        for h in self.list_hosts()? {
            let Some(target_id) = h
                .warpgate
                .as_ref()
                .filter(|w| w.profile_id == profile_id)
                .map(|w| w.target_id.clone())
            else {
                continue;
            };
            if let Some(dup) = existing.insert(target_id, h) {
                duplicates.push(dup.id.clone());
            }
        }

        let (hosts, removed) = mirror_hosts(profile_id, &gateway, &targets, existing, |group| {
            let Some(name) = group else { return Ok(root.clone()) };
            if let Some(id) = subgroups.get(name) {
                return Ok(id.clone());
            }
            let id = self.save_host_group(&HostGroup {
                id: String::new(),
                name: name.to_string(),
                parent_id: Some(root.clone()),
                sort_order: 0,
            })?;
            subgroups.insert(name.to_string(), id.clone());
            Ok(id)
        })?;
        for h in &hosts {
            if h.id.is_empty() {
                self.save_host(h)?;
            } else {
                self.update_host(h)?;
            }
        }
        for id in removed.iter().chain(&duplicates) {
            self.delete_host(id)?;
        }
        Ok(hosts.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gateway() -> Host {
        Host {
            id: "gw".into(),
            name: "Warpgate".into(),
            host: "gateway.lan".into(),
            port: 2222,
            user: "admin".into(),
            auth: HostAuth::Password { value: "pw".into() },
            os_type: None,
            forwards: vec![],
            proxy_jump_host_id: None,
            group_id: None,
            warpgate: None,
        }
    }

    fn target(id: &str, name: &str, group: Option<&str>) -> WarpgateTarget {
        WarpgateTarget {
            id: id.into(),
            name: name.into(),
            kind: "Ssh".into(),
            group: group.map(|g| WarpgateTargetGroup { name: g.into() }),
        }
    }

    #[test]
    fn mirrors_targets_through_the_gateway_login() {
        let mut old = gateway();
        old.id = "host-1".into();
        old.name = "old-name".into();
        old.os_type = Some("ubuntu".into());
        let mut gone = gateway();
        gone.id = "host-2".into();
        let existing = HashMap::from([("t1".to_string(), old), ("t-gone".to_string(), gone)]);
        let targets = [target("t1", "prod-01", Some("Prod")), target("t2", "dev-01", None)];

        let (hosts, removed) = mirror_hosts("p", &gateway(), &targets, existing, |g| {
            Ok(g.map_or("root".into(), |g| format!("grp-{g}")))
        })
        .unwrap();

        assert_eq!(removed, vec!["host-2".to_string()]);
        let (a, b) = (&hosts[0], &hosts[1]);
        assert_eq!((a.id.as_str(), a.name.as_str(), a.user.as_str()), ("host-1", "prod-01", "admin:prod-01"));
        assert_eq!((a.host.as_str(), a.port), ("gateway.lan", 2222));
        assert_eq!(a.os_type.as_deref(), Some("ubuntu"));
        assert_eq!(a.group_id.as_deref(), Some("grp-Prod"));
        assert!(matches!(&a.auth, HostAuth::Password { value } if value == "pw"));
        assert_eq!(a.warpgate, Some(WarpgateRef { profile_id: "p".into(), target_id: "t1".into() }));
        assert_eq!((b.id.as_str(), b.group_id.as_deref()), ("", Some("root")));
    }

    #[test]
    fn parses_targets_response_and_keeps_only_ssh() {
        let body = r#"[{"id":"t1","name":"prod-01","description":"","kind":"Ssh","external_host":null,
            "group":{"id":"g","name":"Prod","color":null},"default_database_name":null},
            {"id":"t2","name":"web","description":"","kind":"Http","group":null}]"#;
        let all: Vec<WarpgateTarget> = serde_json::from_str(body).unwrap();
        let ssh: Vec<_> = all.into_iter().filter(|t| t.kind == "Ssh").collect();
        assert_eq!(ssh.len(), 1);
        assert_eq!(ssh[0].group.as_ref().unwrap().name, "Prod");
    }

    #[test]
    fn pinned_verifier_accepts_only_the_pinned_certificate() {
        let v = PinnedCert {
            sha256: Sha256::digest([1u8, 2, 3]).into(),
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        };
        let name = ServerName::try_from("gw").unwrap();
        let check = |der: Vec<u8>| v.verify_server_cert(&der.into(), &[], &name, &[], UnixTime::now());
        assert!(check(vec![1, 2, 3]).is_ok());
        assert!(check(vec![9]).is_err());

        // reqwest only accepts a preconfigured rustls config of its own
        // rustls version; a mismatch fails here instead of at runtime.
        let mut p = WarpgateProfile {
            id: String::new(),
            name: "gw".into(),
            api_url: "https://gw".into(),
            token: "t".into(),
            ssh_host: "gateway.lan".into(),
            ssh_port: 2222,
            username: "admin".into(),
            auth: HostAuth::Password { value: "pw".into() },
            tls_cert_sha256: Some("00".repeat(32)),
            group_id: None,
        };
        assert!(http_client(&p).is_ok());
        p.tls_cert_sha256 = None;
        assert!(http_client(&p).is_ok());
    }

    /// Self-signed HTTPS server answering one `/targets` request per
    /// connection, like Warpgate's default install.
    async fn fake_warpgate() -> (String, String) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let cert = rcgen::generate_simple_self_signed(vec!["warpgate.local".into()]).unwrap();
        let der = cert.cert.der().clone();
        let pin = hex::encode(Sha256::digest(der.as_ref()));
        let key = rustls::pki_types::PrivateKeyDer::try_from(cert.key_pair.serialize_der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![der], key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("https://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let Ok(mut tls) = acceptor.accept(tcp).await else { continue };
                let mut buf = vec![0u8; 4096];
                let n = tls.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_ascii_lowercase();
                let (status, body) = if !req.starts_with("get /@warpgate/api/targets ") {
                    ("404 Not Found", "[]")
                } else if req.contains("x-warpgate-token: secret\r\n") {
                    ("200 OK", r#"[{"id":"t1","name":"prod-01","kind":"Ssh","group":null},{"id":"t2","name":"db","kind":"Postgres","group":null}]"#)
                } else {
                    ("401 Unauthorized", "{}")
                };
                let resp = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(resp.as_bytes()).await;
                let _ = tls.shutdown().await;
            }
        });
        (url, pin)
    }

    #[tokio::test]
    async fn fetches_targets_only_from_the_pinned_certificate() {
        let (url, pin) = fake_warpgate().await;
        let mut p = WarpgateProfile {
            id: String::new(),
            name: "gw".into(),
            api_url: url,
            token: "secret".into(),
            ssh_host: "gateway.lan".into(),
            ssh_port: 2222,
            username: "admin".into(),
            auth: HostAuth::Password { value: "pw".into() },
            tls_cert_sha256: Some(pin),
            group_id: None,
        };
        let targets = fetch_ssh_targets(&p).await.unwrap();
        assert_eq!(targets.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["prod-01"]);

        p.token = "wrong".into();
        assert!(fetch_ssh_targets(&p).await.unwrap_err().to_string().contains("token"));
        p.token = "secret".into();
        p.tls_cert_sha256 = Some("00".repeat(32));
        assert!(fetch_ssh_targets(&p).await.is_err(), "wrong pin must fail");
        p.tls_cert_sha256 = None;
        assert!(fetch_ssh_targets(&p).await.is_err(), "self-signed must fail without a pin");
    }

    #[tokio::test]
    async fn sync_creates_updates_and_removes_mirrored_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = zeroterm_vault::Vault::create_with_params(
            dir.path().join("v.sqlite"),
            "pw",
            zeroterm_vault::Argon2Params { m_cost: 19 * 1024, t_cost: 2, p_cost: 1 },
        )
        .unwrap();
        let app = App { vault };
        let (url, pin) = fake_warpgate().await;
        let profile_id = app
            .save_warpgate_profile(&WarpgateProfile {
                id: String::new(),
                name: "Lab".into(),
                api_url: url,
                token: "secret".into(),
                ssh_host: "gateway.lan".into(),
                ssh_port: 2222,
                username: "admin".into(),
                auth: HostAuth::Password { value: "pw".into() },
                tls_cert_sha256: Some(pin),
                group_id: None,
            })
            .unwrap();

        assert_eq!(app.sync_warpgate(&profile_id).await.unwrap(), 1);
        assert_eq!(app.sync_warpgate(&profile_id).await.unwrap(), 1, "second sync must not duplicate");
        let mirrored: Vec<_> = app.list_hosts().unwrap().into_iter().filter(|h| h.warpgate.is_some()).collect();
        assert_eq!(mirrored.len(), 1);
        assert_eq!(mirrored[0].user, "admin:prod-01");
        assert_eq!((mirrored[0].host.as_str(), mirrored[0].port), ("gateway.lan", 2222));
        let root = app.find_warpgate_profile(&profile_id).unwrap().unwrap().group_id.clone().unwrap();
        assert_eq!(mirrored[0].group_id.as_deref(), Some(root.as_str()));

        app.delete_warpgate_profile(&profile_id).unwrap();
        assert!(app.list_hosts().unwrap().is_empty());
        assert!(app.find_host_group_by_id(&root).unwrap().is_none());
    }

    #[test]
    fn rejects_non_https_urls_and_bad_fingerprints() {
        assert!(targets_url("http://gw").is_err());
        assert!(targets_url("https://user@gw").is_err());
        assert_eq!(targets_url("https://gw:8888/").unwrap(), "https://gw:8888/@warpgate/api/targets");
        assert_eq!(parse_fingerprint(&"AB".repeat(32)).unwrap(), [0xAB; 32]);
        let colons = vec!["ab"; 32].join(":");
        assert_eq!(parse_fingerprint(&format!("SHA256:{colons}")).unwrap(), [0xAB; 32]);
        assert!(parse_fingerprint("abcd").is_err());
    }
}
