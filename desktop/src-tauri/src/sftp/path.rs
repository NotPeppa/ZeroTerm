use std::fs;
use std::path::Path;

use zeroterm_ssh::FileKind;

use crate::sftp::string_error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CopyNodeKind {
    File,
    Dir,
}

pub(crate) fn remote_join_path(base: &str, leaf: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{leaf}")
    } else {
        format!("{base}/{leaf}")
    }
}

pub(crate) fn normalize_remote_path(path: &str) -> String {
    let raw = path.trim();
    if raw.is_empty() || raw == "/" {
        return "/".to_string();
    }
    let mut out = String::from("/");
    let mut first = true;
    for seg in raw.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if !first {
            out.push('/');
        }
        first = false;
        out.push_str(seg);
    }
    if out.is_empty() {
        "/".to_string()
    } else {
        out
    }
}

pub(crate) fn is_remote_path_within(path: &str, parent: &str) -> bool {
    let n_path = normalize_remote_path(path);
    let n_parent = normalize_remote_path(parent);
    if n_parent == "/" {
        return n_path != "/";
    }
    n_path == n_parent || n_path.starts_with(&(n_parent.clone() + "/"))
}

pub(crate) fn detect_local_kind(path: &Path) -> Result<CopyNodeKind, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| string_error(format!("symlink_metadata {}: {e}", path.display())))?;
    let ft = meta.file_type();
    if ft.is_file() {
        Ok(CopyNodeKind::File)
    } else if ft.is_dir() {
        Ok(CopyNodeKind::Dir)
    } else if ft.is_symlink() {
        Err(string_error(format!(
            "symlink is not supported for copy yet: {}",
            path.display()
        )))
    } else {
        Err(string_error(format!(
            "unsupported file type: {}",
            path.display()
        )))
    }
}

pub(crate) fn detect_remote_kind(path: &str, kind: FileKind) -> Result<CopyNodeKind, String> {
    match kind {
        FileKind::File => Ok(CopyNodeKind::File),
        FileKind::Dir => Ok(CopyNodeKind::Dir),
        FileKind::Symlink => Err(string_error(format!(
            "symlink is not supported for copy yet: {path}"
        ))),
        FileKind::Other => Err(string_error(format!("unsupported file type: {path}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_remote_path_collapses_empty_segments() {
        assert_eq!(
            normalize_remote_path(" /var//log/./nginx/ "),
            "/var/log/nginx"
        );
        assert_eq!(normalize_remote_path("/"), "/");
    }

    #[test]
    fn remote_path_within_checks_descendants() {
        assert!(is_remote_path_within("/var/log/nginx", "/var/log"));
        assert!(is_remote_path_within("/var/log", "/var/log"));
        assert!(!is_remote_path_within("/var/tmp", "/var/log"));
        assert!(!is_remote_path_within("/", "/"));
    }

    #[test]
    fn remote_path_within_does_not_match_prefix_siblings() {
        assert!(!is_remote_path_within("/var/logs", "/var/log"));
        assert!(!is_remote_path_within("/var/log-old/app", "/var/log"));
    }

    #[test]
    fn remote_join_path_handles_root_and_nested_base() {
        assert_eq!(remote_join_path("/", "tmp"), "/tmp");
        assert_eq!(remote_join_path("/var/log", "app.log"), "/var/log/app.log");
        assert_eq!(remote_join_path("/var/log/", "app.log"), "/var/log/app.log");
    }
}
