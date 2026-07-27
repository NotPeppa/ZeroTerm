//! OpenSSH-compatible `known_hosts` reader/writer.
//!
//! Format supported:
//!   - `host keytype base64`              (port 22)
//!   - `[host]:port keytype base64`       (non-default port)
//!   - comma-separated host lists
//!   - hashed hostnames (`|1|salt|hash`, HMAC-SHA1 — Debian/Ubuntu
//!     default `HashKnownHosts yes`)
//!   - `@revoked` marker lines (a matching revoked key is a hard reject)
//!   - `@cert-authority` host-certificate trust
//!   - wildcard and negated host patterns
//!   - `#` comments and blank lines
//!
//! Key comparison is done on the *key blob* (`public_key_base64()`),
//! not the negotiated algorithm name: modern OpenSSH negotiates
//! `rsa-sha2-256` / `rsa-sha2-512` for RSA host keys while the
//! known_hosts file stores the same key as `ssh-rsa`. Comparing the
//! algorithm names would mis-classify every legitimate RSA host as a
//! "HOST KEY CHANGED" mismatch and train users to click through real
//! MITM warnings. The stored keytype is normalised for display and for
//! what we write back.
//!
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use hmac::{Hmac, Mac};
use russh::keys::ssh_key::Fingerprint;
use russh::keys::{parse_public_key_base64, Certificate, HashAlg, PublicKey, PublicKeyBase64};
use sha1::Sha1;

/// Result of looking up a host's key in the store.
#[derive(Debug, Clone)]
pub enum KnownHostStatus {
    /// We have an entry for this host and the offered key matches.
    Trusted,
    /// We have no entry for this host yet.
    Unknown,
    /// We have an entry for this host but the offered key is different.
    /// `stored` is a human-readable summary of the previously trusted key.
    Mismatch { stored: String },
    /// The offered key is explicitly marked `@revoked` for this host.
    /// Must be treated as a hard reject — never prompt to accept.
    Revoked,
}

/// Result of checking an OpenSSH host certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KnownHostCertificateStatus {
    /// The certificate is valid and signed by a matching `@cert-authority`.
    Trusted,
    /// No certificate authority entry applies to this host.
    Unknown,
    /// The certificate's signing CA or subject key is explicitly revoked.
    Revoked,
    /// A CA entry applies, but the certificate failed a mandatory check.
    Invalid { reason: String },
}

/// A handle to a `known_hosts` file. Cheap to clone.
#[derive(Debug, Clone)]
pub struct KnownHosts {
    path: PathBuf,
}

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Default location: `$HOME/.ssh/known_hosts`. Returns None if no
    /// home directory could be determined.
    pub fn default_path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".ssh").join("known_hosts"))
    }

    pub fn at_default() -> Option<Self> {
        Self::default_path().map(Self::new)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Look up `(host, port)` and compare against `key`.
    ///
    /// I/O errors (file unreadable for reasons other than "doesn't exist")
    /// are returned. A missing file is treated as `Unknown`.
    pub fn check(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> std::io::Result<KnownHostStatus> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(KnownHostStatus::Unknown);
            }
            Err(e) => return Err(e),
        };
        // `Algorithm::as_str` borrows the Algorithm, so bind it.
        let algo = key.algorithm();
        Ok(check_content(
            &content,
            host,
            port,
            algo.as_str(),
            &key.public_key_base64(),
        ))
    }

    /// Validate an OpenSSH host certificate against matching
    /// `@cert-authority` entries.
    pub fn check_certificate(
        &self,
        host: &str,
        port: u16,
        certificate: &Certificate,
    ) -> std::io::Result<KnownHostCertificateStatus> {
        let content = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(KnownHostCertificateStatus::Unknown);
            }
            Err(e) => return Err(e),
        };
        Ok(check_certificate_content(&content, host, port, certificate))
    }

    /// Append a new trusted entry. Creates the file (and parent directory)
    /// if missing. Does NOT deduplicate — caller is expected to call this
    /// only for `Unknown` results.
    pub fn add(&self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let algo = key.algorithm();
        let line = format!(
            "{} {} {}\n",
            host_pattern(host, port),
            canonical_key_type(algo.as_str()),
            key.public_key_base64()
        );

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Replace all entries matching `(host, port)` with a single fresh key.
    /// Marker lines (`@revoked`, `@cert-authority`) are preserved.
    pub fn replace(&self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        let existing = match std::fs::read_to_string(&self.path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e),
        };

        let mut out = String::new();
        for raw in existing.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                out.push_str(raw);
                out.push('\n');
                continue;
            }
            let parsed = parse_line(line);
            let drop_it = match parsed {
                // Only plain entries are replaced; revocations and CA
                // designations always survive a key rotation.
                Some(p) if p.marker.is_none() => host_field_matches(p.host_field, host, port),
                _ => false,
            };
            if !drop_it {
                out.push_str(raw);
                out.push('\n');
            }
        }

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let algo = key.algorithm();
        out.push_str(&format!(
            "{} {} {}\n",
            host_pattern(host, port),
            canonical_key_type(algo.as_str()),
            key.public_key_base64()
        ));
        std::fs::write(&self.path, out)
    }
}

/// Normalise an SSH *signature algorithm* name to the *key type* name
/// used in known_hosts files. RSA host keys negotiate `rsa-sha2-256` /
/// `rsa-sha2-512` on modern servers, but the key material — and the
/// known_hosts entry — is `ssh-rsa` either way.
fn canonical_key_type(name: &str) -> &str {
    match name {
        "rsa-sha2-256" | "rsa-sha2-512" => "ssh-rsa",
        other => other,
    }
}

/// The host field OpenSSH writes for `(host, port)`.
fn host_pattern(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_ascii_lowercase()
    } else {
        format!("[{}]:{}", host.to_ascii_lowercase(), port)
    }
}

struct ParsedLine<'a> {
    /// `Some("revoked")` / `Some("cert-authority")` for marker lines.
    marker: Option<&'a str>,
    host_field: &'a str,
    keytype: &'a str,
    b64: &'a str,
}

fn parse_line(line: &str) -> Option<ParsedLine<'_>> {
    let (marker, rest) = match line.strip_prefix('@') {
        Some(rest) => {
            let (m, tail) = rest.split_once(char::is_whitespace)?;
            (Some(m), tail.trim_start())
        }
        None => (None, line),
    };
    let mut parts = rest.splitn(3, char::is_whitespace);
    let host_field = parts.next()?;
    let keytype = parts.next()?;
    let b64 = parts
        .next()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("");
    if host_field.is_empty() || keytype.is_empty() || b64.is_empty() {
        return None;
    }
    Some(ParsedLine {
        marker,
        host_field,
        keytype,
        b64,
    })
}

/// Pure decision core, split out so the comparison rules are testable
/// without generating real key material.
fn check_content(
    content: &str,
    host: &str,
    port: u16,
    offered_name: &str,
    offered_b64: &str,
) -> KnownHostStatus {
    let offered_type = canonical_key_type(offered_name);

    let mut trusted = false;
    let mut revoked = false;
    let mut mismatch_summary: Option<String> = None;
    let mut summary_same_family = false;

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(p) = parse_line(line) else {
            continue;
        };
        match p.marker {
            Some("revoked") => {
                // Revocation matches on the key itself; the host field
                // still has to match so revoking a key for one host
                // doesn't block it elsewhere (OpenSSH semantics allow
                // global revocation via a wildcard, which we don't
                // support — per-host is the conservative subset).
                if host_field_matches(p.host_field, host, port) && p.b64 == offered_b64 {
                    revoked = true;
                }
                continue;
            }
            Some(_) => continue, // @cert-authority etc.: not a plain entry
            None => {}
        }

        if !host_field_matches(p.host_field, host, port) {
            continue;
        }

        // Key blobs are self-describing (the type string is encoded
        // inside), so blob equality is the whole trust decision; the
        // keytype column only feeds the mismatch report.
        if p.b64 == offered_b64 {
            trusted = true;
            continue;
        }

        // Same host, different key — record for the mismatch report.
        // Prefer the first entry of the offered key's own type family;
        // users can read the file for full detail.
        let same_family = canonical_key_type(p.keytype) == offered_type;
        if mismatch_summary.is_none() || (same_family && !summary_same_family) {
            let preview = p.b64.chars().take(20).collect::<String>();
            mismatch_summary = Some(format!("{} {}…", p.keytype, preview));
            summary_same_family = same_family;
        }
    }

    if revoked {
        return KnownHostStatus::Revoked;
    }
    if trusted {
        return KnownHostStatus::Trusted;
    }
    match mismatch_summary {
        Some(stored) => KnownHostStatus::Mismatch { stored },
        None => KnownHostStatus::Unknown,
    }
}

fn check_certificate_content(
    content: &str,
    host: &str,
    port: u16,
    certificate: &Certificate,
) -> KnownHostCertificateStatus {
    let mut ca_fingerprints: Vec<Fingerprint> = Vec::new();
    let mut applicable_ca_line = false;

    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(parsed) = parse_line(line) else {
            continue;
        };
        if !host_field_matches(parsed.host_field, host, port) {
            continue;
        }

        let parsed_key = parse_public_key_base64(parsed.b64).ok();
        match parsed.marker {
            Some("revoked")
                if parsed_key.as_ref().is_some_and(|key| {
                    key.key_data() == certificate.signature_key()
                        || key.key_data() == certificate.public_key()
                }) =>
            {
                return KnownHostCertificateStatus::Revoked;
            }
            Some("cert-authority") => {
                applicable_ca_line = true;
                if let Some(key) = parsed_key {
                    ca_fingerprints.push(key.fingerprint(HashAlg::Sha256));
                }
            }
            _ => {}
        }
    }

    if !applicable_ca_line {
        return KnownHostCertificateStatus::Unknown;
    }
    if ca_fingerprints.is_empty() {
        return invalid_certificate("matching @cert-authority entry has an invalid key");
    }
    if !certificate.cert_type().is_host() {
        return invalid_certificate("certificate is not a host certificate");
    }
    if !certificate.critical_options().is_empty() {
        return invalid_certificate("certificate contains unsupported critical options");
    }
    if !certificate.valid_principals().is_empty()
        && !certificate
            .valid_principals()
            .iter()
            .any(|principal| glob_matches(principal, host))
    {
        return invalid_certificate("certificate is not valid for the requested host");
    }
    if certificate.validate(ca_fingerprints.iter()).is_err() {
        return invalid_certificate("certificate signature, CA, or validity window is invalid");
    }

    KnownHostCertificateStatus::Trusted
}

fn invalid_certificate(reason: &str) -> KnownHostCertificateStatus {
    KnownHostCertificateStatus::Invalid {
        reason: reason.to_string(),
    }
}

/// Does `host_field` (a comma-separated list from a known_hosts line) match
/// the target `(host, port)`? Hostname comparison is ASCII
/// case-insensitive (OpenSSH treats hostnames case-insensitively);
/// hashed entries (`|1|salt|hash`) are matched via HMAC-SHA1.
fn host_field_matches(host_field: &str, host: &str, port: u16) -> bool {
    let target = host_pattern(host, port);
    let mut positive_match = false;
    // Bare-host entries only count for the default port; the bracketed
    // pattern covers the rest. Hashed entries hash whichever form
    // OpenSSH would have written, i.e. exactly `target`.
    for entry in host_field.split(',') {
        let mut entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let negated = entry.starts_with('!');
        if negated {
            entry = &entry[1..];
        }

        // Hashed form: |1|base64(salt)|base64(hmac_sha1(salt, host))
        let matched = if let Some(rest) = entry.strip_prefix("|1|") {
            if let Some((salt_b64, hash_b64)) = rest.split_once('|') {
                if let (Ok(salt), Ok(hash)) = (B64.decode(salt_b64), B64.decode(hash_b64)) {
                    hashed_host_matches(&salt, &hash, &target)
                } else {
                    false
                }
            } else {
                false
            }
        } else if let Some(rest) = entry.strip_prefix('[') {
            if let Some((h, p)) = rest.split_once("]:") {
                glob_matches(h, host) && p.parse::<u16>().ok() == Some(port)
            } else {
                false
            }
        } else {
            port == 22 && glob_matches(entry, host)
        };

        if matched && negated {
            return false;
        }
        if matched {
            positive_match = true;
        }
    }
    positive_match
}

/// OpenSSH-style `*` / `?` matching for ASCII hostnames.
fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_ascii_lowercase();
    let value = value.to_ascii_lowercase();
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut p, mut v) = (0, 0);
    let (mut star, mut retry_v) = (None, 0);

    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry_v = v;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            retry_v += 1;
            v = retry_v;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

fn hashed_host_matches(salt: &[u8], expected: &[u8], target: &str) -> bool {
    let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(salt) else {
        return false;
    };
    mac.update(target.as_bytes());
    mac.verify_slice(expected).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand_ssh::{rngs::StdRng, SeedableRng};
    use russh::keys::ssh_key::certificate::{Builder, CertType};
    use russh::keys::{Algorithm, PrivateKey};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn certificate_fixture(
        principal: &str,
        cert_type: CertType,
        critical_option: bool,
        expired: bool,
    ) -> (PrivateKey, Certificate) {
        let mut rng = StdRng::from_seed([42; 32]);
        let ca = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let subject = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let (valid_after, valid_before) = if expired {
            (now.saturating_sub(120), now.saturating_sub(60))
        } else {
            (now.saturating_sub(60), now + 3600)
        };
        let mut builder =
            Builder::new([7; 16], subject.public_key(), valid_after, valid_before).unwrap();
        builder.cert_type(cert_type).unwrap();
        builder.valid_principal(principal).unwrap();
        if critical_option {
            builder
                .critical_option("source-address", "127.0.0.1/32")
                .unwrap();
        }
        let certificate = builder.sign(&ca).unwrap();
        (ca, certificate)
    }

    #[test]
    fn matches_bare_host_on_default_port() {
        assert!(host_field_matches("example.com", "example.com", 22));
        assert!(!host_field_matches("example.com", "example.com", 2222));
    }

    #[test]
    fn matches_bracketed_host_with_port() {
        assert!(host_field_matches(
            "[example.com]:2222",
            "example.com",
            2222
        ));
        assert!(!host_field_matches("[example.com]:2222", "example.com", 22));
    }

    #[test]
    fn matches_one_in_comma_list() {
        assert!(host_field_matches("a.com,b.com,c.com", "b.com", 22));
    }

    #[test]
    fn matches_wildcards_and_honours_negation() {
        assert!(host_field_matches("*.example.com", "api.example.com", 22));
        assert!(host_field_matches(
            "[*.example.com]:2222",
            "api.example.com",
            2222
        ));
        assert!(!host_field_matches(
            "*.example.com,!blocked.example.com",
            "blocked.example.com",
            22
        ));
    }

    #[test]
    fn hostname_matching_is_case_insensitive() {
        assert!(host_field_matches("Example.COM", "example.com", 22));
        assert!(host_field_matches("example.com", "EXAMPLE.com", 22));
        assert!(host_field_matches(
            "[Example.COM]:2222",
            "example.com",
            2222
        ));
    }

    #[test]
    fn matches_hashed_hostname_entry() {
        // Entry generated the way OpenSSH does: HMAC-SHA1(salt, host).
        let salt = b"0123456789abcdef0123";
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(b"example.com");
        let hash = mac.finalize().into_bytes();
        let field = format!("|1|{}|{}", B64.encode(salt), B64.encode(hash));

        assert!(host_field_matches(&field, "example.com", 22));
        assert!(!host_field_matches(&field, "other.com", 22));
        // Non-default port hashes the bracketed form.
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(b"[example.com]:2222");
        let hash = mac.finalize().into_bytes();
        let field = format!("|1|{}|{}", B64.encode(salt), B64.encode(hash));
        assert!(host_field_matches(&field, "example.com", 2222));
        assert!(!host_field_matches(&field, "example.com", 22));
    }

    // --- SSH-1: RSA algorithm-name vs key-type normalisation ---------

    #[test]
    fn rsa_sha2_offered_key_matches_stored_ssh_rsa_entry() {
        // The audited bug: a modern server negotiates rsa-sha2-512 for
        // an RSA host key; the known_hosts line says ssh-rsa with the
        // identical blob. That must be Trusted, not Mismatch.
        let content = "example.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC-fake-blob\n";
        let status = check_content(
            content,
            "example.com",
            22,
            "rsa-sha2-512",
            "AAAAB3NzaC1yc2EAAAADAQABAAABAQC-fake-blob",
        );
        assert!(matches!(status, KnownHostStatus::Trusted), "{status:?}");

        let status = check_content(
            content,
            "example.com",
            22,
            "rsa-sha2-256",
            "AAAAB3NzaC1yc2EAAAADAQABAAABAQC-fake-blob",
        );
        assert!(matches!(status, KnownHostStatus::Trusted), "{status:?}");
    }

    #[test]
    fn different_rsa_blob_is_still_a_mismatch() {
        let content = "example.com ssh-rsa AAAA-stored-blob\n";
        let status = check_content(
            content,
            "example.com",
            22,
            "rsa-sha2-512",
            "AAAA-other-blob",
        );
        assert!(
            matches!(status, KnownHostStatus::Mismatch { .. }),
            "{status:?}"
        );
    }

    #[test]
    fn unknown_host_is_unknown_even_with_other_entries() {
        let content = "other.com ssh-ed25519 AAAA-blob\n";
        let status = check_content(content, "example.com", 22, "ssh-ed25519", "AAAA-blob");
        assert!(matches!(status, KnownHostStatus::Unknown), "{status:?}");
    }

    #[test]
    fn canonical_key_type_maps_rsa_variants_only() {
        assert_eq!(canonical_key_type("rsa-sha2-512"), "ssh-rsa");
        assert_eq!(canonical_key_type("rsa-sha2-256"), "ssh-rsa");
        assert_eq!(canonical_key_type("ssh-rsa"), "ssh-rsa");
        assert_eq!(canonical_key_type("ssh-ed25519"), "ssh-ed25519");
    }

    // --- SSH-2: @revoked / @cert-authority handling ------------------

    #[test]
    fn revoked_key_is_rejected_even_if_also_listed_as_trusted() {
        let content = "\
example.com ssh-ed25519 AAAA-blob
@revoked example.com ssh-ed25519 AAAA-blob
";
        let status = check_content(content, "example.com", 22, "ssh-ed25519", "AAAA-blob");
        assert!(matches!(status, KnownHostStatus::Revoked), "{status:?}");
    }

    #[test]
    fn cert_authority_lines_are_not_misread_as_host_entries() {
        // A CA line for the host must neither trust nor mismatch a
        // directly-offered host key.
        let content = "@cert-authority example.com ssh-ed25519 AAAA-ca-blob\n";
        let status = check_content(content, "example.com", 22, "ssh-ed25519", "AAAA-ca-blob");
        assert!(matches!(status, KnownHostStatus::Unknown), "{status:?}");
    }

    #[test]
    fn valid_host_certificate_is_trusted_by_matching_ca() {
        let (ca, certificate) =
            certificate_fixture("api.example.com", CertType::Host, false, false);
        let content = format!(
            "@cert-authority *.example.com {} {}\n",
            ca.algorithm().as_str(),
            ca.public_key().public_key_base64()
        );
        assert_eq!(
            check_certificate_content(&content, "api.example.com", 22, &certificate),
            KnownHostCertificateStatus::Trusted
        );
    }

    #[test]
    fn certificate_principal_type_options_and_validity_are_enforced() {
        let cases = [
            certificate_fixture("other.example.com", CertType::Host, false, false),
            certificate_fixture("api.example.com", CertType::User, false, false),
            certificate_fixture("api.example.com", CertType::Host, true, false),
            certificate_fixture("api.example.com", CertType::Host, false, true),
        ];
        for (ca, certificate) in cases {
            let content = format!(
                "@cert-authority *.example.com {} {}\n",
                ca.algorithm().as_str(),
                ca.public_key().public_key_base64()
            );
            assert!(matches!(
                check_certificate_content(&content, "api.example.com", 22, &certificate),
                KnownHostCertificateStatus::Invalid { .. }
            ));
        }
    }

    #[test]
    fn revoked_ca_overrides_matching_authority() {
        let (ca, certificate) =
            certificate_fixture("api.example.com", CertType::Host, false, false);
        let ca_blob = ca.public_key().public_key_base64();
        let content = format!(
            "@cert-authority *.example.com ssh-ed25519 {ca_blob}\n\
             @revoked *.example.com ssh-ed25519 {ca_blob}\n"
        );
        assert_eq!(
            check_certificate_content(&content, "api.example.com", 22, &certificate),
            KnownHostCertificateStatus::Revoked
        );
    }

    #[test]
    fn hashed_entry_with_different_key_reports_mismatch_not_unknown() {
        // Debian-style hashed entry for the host with a DIFFERENT key:
        // must surface as Mismatch (key changed!), not the soft
        // "unknown host" prompt an attacker would prefer.
        let salt = b"0123456789abcdef0123";
        let mut mac = Hmac::<Sha1>::new_from_slice(salt).unwrap();
        mac.update(b"example.com");
        let hash = mac.finalize().into_bytes();
        let content = format!(
            "|1|{}|{} ssh-ed25519 AAAA-stored-blob\n",
            B64.encode(salt),
            B64.encode(hash)
        );
        let status = check_content(&content, "example.com", 22, "ssh-ed25519", "AAAA-evil-blob");
        assert!(
            matches!(status, KnownHostStatus::Mismatch { .. }),
            "{status:?}"
        );

        let status = check_content(
            &content,
            "example.com",
            22,
            "ssh-ed25519",
            "AAAA-stored-blob",
        );
        assert!(matches!(status, KnownHostStatus::Trusted), "{status:?}");
    }
}
