//! OpenSSH-compatible `known_hosts` reader/writer.
//!
//! Format supported:
//!   - `host keytype base64`              (port 22)
//!   - `[host]:port keytype base64`       (non-default port)
//!   - comma-separated host lists
//!   - `#` comments and blank lines
//!
//! Not yet supported (intentional W2 cut):
//!   - hashed hostnames (`|1|salt|hash`)
//!   - wildcard / negation patterns
//!   - certificate authorities (`@cert-authority`)
//!   - revoked entries (`@revoked`)
//!
//! These will be revisited when we move from "make it work" to
//! "fully OpenSSH-compatible".

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use russh_keys::key::PublicKey;
use russh_keys::PublicKeyBase64;

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

        let target_b64 = key.public_key_base64();
        let target_name = key.name();

        let mut mismatch_summary: Option<String> = None;

        for raw in content.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let mut parts = line.splitn(3, char::is_whitespace);
            let host_field = parts.next().unwrap_or("");
            let keytype = parts.next().unwrap_or("");
            let b64 = parts.next().unwrap_or("").split_whitespace().next().unwrap_or("");

            if !host_field_matches(host_field, host, port) {
                continue;
            }

            if keytype == target_name && b64 == target_b64 {
                return Ok(KnownHostStatus::Trusted);
            }

            // Same host, different key — record for the mismatch report.
            // Keep the first one we see; users can read the file for full detail.
            if mismatch_summary.is_none() {
                let preview = b64.chars().take(20).collect::<String>();
                mismatch_summary = Some(format!("{} {}…", keytype, preview));
            }
        }

        Ok(match mismatch_summary {
            Some(stored) => KnownHostStatus::Mismatch { stored },
            None => KnownHostStatus::Unknown,
        })
    }

    /// Append a new trusted entry. Creates the file (and parent directory)
    /// if missing. Does NOT deduplicate — caller is expected to call this
    /// only for `Unknown` results.
    pub fn add(&self, host: &str, port: u16, key: &PublicKey) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let host_part = if port == 22 {
            host.to_string()
        } else {
            format!("[{}]:{}", host, port)
        };
        let line = format!("{} {} {}\n", host_part, key.name(), key.public_key_base64());

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }

    /// Replace all entries matching `(host, port)` with a single fresh key.
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
            let host_field = line.split_whitespace().next().unwrap_or("");
            if !host_field_matches(host_field, host, port) {
                out.push_str(raw);
                out.push('\n');
            }
        }

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let host_part = if port == 22 {
            host.to_string()
        } else {
            format!("[{}]:{}", host, port)
        };
        out.push_str(&format!("{} {} {}\n", host_part, key.name(), key.public_key_base64()));
        std::fs::write(&self.path, out)
    }
}

/// Does `host_field` (a comma-separated list from a known_hosts line) match
/// the target `(host, port)`?
fn host_field_matches(host_field: &str, host: &str, port: u16) -> bool {
    for entry in host_field.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }

        // [host]:port form
        if let Some(rest) = entry.strip_prefix('[') {
            if let Some((h, p)) = rest.split_once("]:") {
                if h == host && p.parse::<u16>().ok() == Some(port) {
                    return true;
                }
                continue;
            }
        }

        // bare host — only counts for the default port
        if entry == host && port == 22 {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_bare_host_on_default_port() {
        assert!(host_field_matches("example.com", "example.com", 22));
        assert!(!host_field_matches("example.com", "example.com", 2222));
    }

    #[test]
    fn matches_bracketed_host_with_port() {
        assert!(host_field_matches("[example.com]:2222", "example.com", 2222));
        assert!(!host_field_matches("[example.com]:2222", "example.com", 22));
    }

    #[test]
    fn matches_one_in_comma_list() {
        assert!(host_field_matches("a.com,b.com,c.com", "b.com", 22));
    }
}
