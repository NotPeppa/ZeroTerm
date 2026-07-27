//! Layout of the `zeroterm-sync/` repository on the remote (RFC-002 §7).
//!
//! ```text
//! <root>/zeroterm-sync/
//! ├── manifest.json              # top-level pointers (head_clock, snapshots, …)
//! ├── keyring.json                # device entries (see [`crate::keyring`])
//! ├── snapshots/
//! │   └── snapshot-<clock>-<ulid>.bin
//! ├── events/
//! │   └── YYYY-MM/
//! │       └── ev-<clock>-<device>-<ulid>.json
//! ├── trash/
//! │   └── ...                      # soft-deleted snapshots/events pending GC
//! ├── locks/
//! │   └── compact.lock             # best-effort exclusion for compact runs
//! └── devices/
//!     └── <device_id>.json         # name, last-seen clock, etc.
//! ```
//!
//! This module only owns the **path helpers**. Reading/writing those
//! paths is the [`crate::engine`] (M2) and [`adapter`] (M2) job.

use std::path::PathBuf;

/// The directory name inside the user-chosen sync root.
///
/// No leading dot: a hidden directory like `.zeroterm-sync` hits adapter
/// quirks on some sync backends (iCloud Drive / Dropbox / WebDAV), so we
/// use a visible name. Don't reintroduce the dot — a batch of path tests
/// once hard-coded the dotted form and broke against this.
pub const REPO_DIR: &str = "zeroterm-sync";

/// Schema version of the *repo layout* itself. Distinct from the
/// keyring schema and the manifest schema — those are independent
/// version axes (RFC-002 §7.1).
pub const REPO_SCHEMA: u32 = 1;

/// Construct repo-relative paths. The struct is just a typed namespace —
/// there is no state.
#[derive(Debug, Clone, Copy)]
pub struct RepoPaths;

impl RepoPaths {
    pub fn manifest() -> &'static str {
        "manifest.json"
    }

    pub fn keyring() -> &'static str {
        "keyring.json"
    }

    pub fn keyrings_dir() -> &'static str {
        "keyrings"
    }

    pub fn keyring_filename(root_epoch: u64, id: &str) -> String {
        format!("keyrings/keyring-{root_epoch:012}-{id}.json")
    }

    pub fn is_keyring_path(path: &str) -> bool {
        path == Self::keyring()
            || (path.starts_with("keyrings/keyring-")
                && path.ends_with(".json")
                && !path.contains("..")
                && path.bytes().all(|b| {
                    b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.')
                }))
    }

    pub fn snapshots_dir() -> &'static str {
        "snapshots"
    }

    pub fn events_dir() -> &'static str {
        "events"
    }

    pub fn trash_dir() -> &'static str {
        "trash"
    }

    pub fn locks_dir() -> &'static str {
        "locks"
    }

    pub fn devices_dir() -> &'static str {
        "devices"
    }

    pub fn compact_lock() -> &'static str {
        "locks/compact.lock"
    }

    /// Bucket events by year-month so directories stay reasonable in
    /// size and listing a single month is cheap.
    pub fn event_bucket(unix_ms: i64) -> String {
        let (y, m) = year_month(unix_ms);
        format!("events/{y:04}-{m:02}")
    }

    /// `events/YYYY-MM/ev-<clock12>-<device>-<ulid>.json`.
    ///
    /// The JSON path stays around so callers can write the legacy
    /// format if they need to (e.g. for human-readable test fixtures);
    /// new writers should prefer [`Self::event_filename_ztlog`].
    pub fn event_filename(unix_ms: i64, lamport_clock: u64, device_id: &str, ulid: &str) -> String {
        let bucket = Self::event_bucket(unix_ms);
        // 12 zero-padded digits so lexicographic order matches numeric
        // order up to ~10^12 events. (uuidv7 is sortable too, but the
        // Lamport clock is the authoritative ordering.)
        format!("{bucket}/ev-{lamport_clock:012}-{device_id}-{ulid}.json")
    }

    /// `events/YYYY-MM/ev-<clock12>-<device>-<ulid>.ztlog`.
    ///
    /// Compact binary format introduced in M10. Same lex-sort
    /// invariant as the `.json` filename — both share the
    /// `ev-<clock12>-` prefix so a mixed directory still iterates in
    /// clock order.
    pub fn event_filename_ztlog(
        unix_ms: i64,
        lamport_clock: u64,
        device_id: &str,
        ulid: &str,
    ) -> String {
        let bucket = Self::event_bucket(unix_ms);
        format!("{bucket}/ev-{lamport_clock:012}-{device_id}-{ulid}.ztlog")
    }

    /// True if `path` looks like an event log file we should ingest.
    /// Used by the engine's apply / compact loops so old `.json`
    /// fixtures and new `.ztlog` writes both get picked up.
    pub fn is_event_path(path: &str) -> bool {
        path.ends_with(".json") || path.ends_with(".ztlog")
    }

    /// `snapshots/snapshot-<clock12>-<ulid>.bin`.
    pub fn snapshot_filename(lamport_clock: u64, ulid: &str) -> String {
        format!("snapshots/snapshot-{lamport_clock:012}-{ulid}.bin")
    }

    pub fn device_file(device_id: &str) -> String {
        format!("devices/{device_id}.json")
    }
}

/// Build an absolute on-disk path from a sync `root` (the user's chosen
/// directory) and a repo-relative key.
pub fn join(root: &std::path::Path, key: &str) -> PathBuf {
    let mut p = root.join(REPO_DIR);
    for part in key.split('/') {
        if !part.is_empty() {
            p.push(part);
        }
    }
    p
}

fn year_month(unix_ms: i64) -> (u32, u32) {
    // Lightweight days-since-epoch → (Y, M) conversion. Good through 2400
    // and gives stable bucket names independent of the local timezone.
    // Algorithm: Howard Hinnant's `civil_from_days` (variant Rata Die).
    let days = unix_ms.max(0) / 86_400_000 + 719_468; // 1970-01-01 → 719468
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let doe = (days - era * 146_097) as u32; // [0, 146097)
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as u32, m)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_known_paths_are_stable() {
        assert_eq!(RepoPaths::manifest(), "manifest.json");
        assert_eq!(RepoPaths::keyring(), "keyring.json");
        assert_eq!(RepoPaths::compact_lock(), "locks/compact.lock");
    }

    #[test]
    fn event_filename_is_lexicographically_sortable() {
        // Same bucket, two different clocks: the lower clock sorts first.
        let a = RepoPaths::event_filename(1_700_000_000_000, 5, "dev-A", "01J");
        let b = RepoPaths::event_filename(1_700_000_000_000, 1000, "dev-A", "01J");
        assert!(a < b, "{a} should sort before {b}");
    }

    #[test]
    fn event_filename_ztlog_uses_ztlog_extension() {
        let p = RepoPaths::event_filename_ztlog(1_710_460_800_000, 42, "dev-A", "01J");
        assert!(p.starts_with("events/2024-03/ev-"));
        assert!(p.ends_with(".ztlog"));
    }

    #[test]
    fn mixed_event_files_sort_by_clock() {
        // .json and .ztlog at the same clock interleave deterministically;
        // ordering between them at equal (clock, device, ulid) is decided
        // by extension, but the engine relies only on the (clock) prefix.
        let json_path = RepoPaths::event_filename(1_710_460_800_000, 5, "dev-A", "01J");
        let zt_path = RepoPaths::event_filename_ztlog(1_710_460_800_000, 1000, "dev-A", "01J");
        assert!(json_path < zt_path);
    }

    #[test]
    fn is_event_path_recognises_both_formats() {
        assert!(RepoPaths::is_event_path("events/2024-03/ev-foo.json"));
        assert!(RepoPaths::is_event_path("events/2024-03/ev-foo.ztlog"));
        assert!(!RepoPaths::is_event_path("events/2024-03/ev-foo.txt"));
    }

    #[test]
    fn event_bucket_groups_by_year_month() {
        // 2024-03-15 00:00 UTC = 1_710_460_800_000 ms.
        assert_eq!(RepoPaths::event_bucket(1_710_460_800_000), "events/2024-03");
    }

    #[test]
    fn join_resolves_under_repo_dir() {
        let root = std::path::Path::new("/tmp/sync-root");
        let p = join(root, "events/2024-03/foo.json");
        assert!(p.starts_with("/tmp/sync-root/zeroterm-sync"));
        assert!(p.ends_with("foo.json"));
    }
}
