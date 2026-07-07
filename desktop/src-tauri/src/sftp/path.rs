use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

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
    let mut parts: Vec<&str> = Vec::new();
    for seg in raw.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
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

fn resolve_local_path_for_containment(path: &Path) -> Result<PathBuf, String> {
    let original = path.to_path_buf();
    let mut cursor = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| string_error(format!("resolve current directory: {e}")))?
            .join(path)
    };
    let mut missing_tail: Vec<OsString> = Vec::new();

    loop {
        match fs::canonicalize(&cursor) {
            Ok(mut resolved) => {
                for segment in missing_tail.iter().rev() {
                    if segment == "." {
                        continue;
                    }
                    if segment == ".." {
                        resolved.pop();
                    } else {
                        resolved.push(segment);
                    }
                }
                return Ok(resolved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let Some(name) = cursor.file_name().map(|name| name.to_os_string()) else {
                    return Err(string_error(format!(
                        "resolve local path {}: {e}",
                        original.display()
                    )));
                };
                missing_tail.push(name);
                if !cursor.pop() {
                    return Err(string_error(format!(
                        "resolve local path {}: {e}",
                        original.display()
                    )));
                }
            }
            Err(e) => {
                return Err(string_error(format!(
                    "resolve local path {}: {e}",
                    original.display()
                )));
            }
        }
    }
}

pub(crate) fn is_local_path_within(path: &Path, parent: &Path) -> Result<bool, String> {
    let resolved_path = resolve_local_path_for_containment(path)?;
    let resolved_parent = resolve_local_path_for_containment(parent)?;
    Ok(resolved_path == resolved_parent || resolved_path.starts_with(&resolved_parent))
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
    fn normalize_remote_path_resolves_parent_segments() {
        assert_eq!(normalize_remote_path("/var/log/../tmp"), "/var/tmp");
        assert_eq!(normalize_remote_path("/tmp/.."), "/");
        assert_eq!(normalize_remote_path("/../../"), "/");
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

    fn unique_test_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "zeroterm-sftp-path-{name}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn local_path_within_resolves_missing_child_and_parent_segments() {
        let root = unique_test_dir("within");
        let source = root.join("src");
        let sibling = root.join("src-sibling");
        fs::create_dir_all(&source).expect("create source");
        fs::create_dir_all(&sibling).expect("create sibling");

        let nested = source.join("missing").join("child");
        assert!(is_local_path_within(&nested, &source).expect("nested containment"));
        assert!(
            is_local_path_within(&source.join("..").join("src").join("child"), &source)
                .expect("parent segment containment")
        );
        assert!(!is_local_path_within(&sibling, &source).expect("sibling containment"));

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn local_path_within_resolves_symlinked_parent() {
        let root = unique_test_dir("symlink");
        let real = root.join("real");
        let source = real.join("src");
        let link = root.join("link-to-real");
        fs::create_dir_all(&source).expect("create source");
        std::os::unix::fs::symlink(&real, &link).expect("create symlink");

        let target_via_link = link.join("src").join("child");
        assert!(
            is_local_path_within(&target_via_link, &source).expect("symlink containment"),
            "target through a symlinked parent should still be recognized inside source"
        );

        let _ = fs::remove_dir_all(root);
    }
}
