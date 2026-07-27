//! Repo-based sync engine — events-driven (M4 form).
//!
//! Shape of one `sync_once` pass:
//!   1. `apply_remote_events` — list everything under `events/`, drop
//!      already-seen ones, decrypt the rest, apply to the
//!      [`LocalRecordStore`] following the RFC-002 §13.2 decision
//!      table (insert / overwrite-when-clean / record-conflict /
//!      skip-already-applied / tombstone).
//!   2. `push_local_events` — drain `store.list_dirty()`, seal each
//!      one as an event, `write_new` it under `events/YYYY-MM/`, then
//!      `store.mark_clean`.
//!   3. Bump `manifest.head_clock` so the next reader knows there's
//!      fresh history.
//!
//! Snapshots stay around but only as compaction (M5) emits them; the
//! join path will fall back to reading the latest snapshot when one
//! exists.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use zeroterm_crypto::{Argon2Params, KEY_LEN};

use crate::adapter::SyncAdapter;
use crate::clock::LogicalClock;
use crate::crypto::{self, fresh_root_key, SyncRootKey};
use crate::error::Error;
use crate::event::{self, Op, RemoteEvent};
use crate::keyring::{self, Keyring};
use crate::local_store::{ApplyTally, LocalRecord, LocalRecordStore};
use crate::manifest::{Manifest, MANIFEST_SCHEMA};
use crate::repo::RepoPaths;
use crate::snapshot::Snapshot;

/// `sync_state` keys we own.
const KEY_LOGICAL_CLOCK: &str = "logical_clock";
const KEY_APPLIED_EVENTS: &str = "applied_events";
const KEY_LAST_SEEN_SNAPSHOT: &str = "last_seen_snapshot";
/// Highest manifest `meta_version` this device has seen/written (SYNC-8),
/// used to flag a rolled-back manifest.
const KEY_MANIFEST_META_VERSION: &str = "manifest_meta_version";
/// Sticky local downgrade guard. Once this device has verified or written a
/// MAC'd manifest, an unsigned one can only be a stripped/replayed downgrade.
const KEY_MANIFEST_MAC_REQUIRED: &str = "manifest_mac_required";
/// Highest root-key generation this device has accepted. Unlike
/// `meta_version`, this is a strict rollback boundary.
const KEY_ROOT_EPOCH: &str = "root_epoch";

/// Cap on keyring entries (other than our own) whose passphrase we'll
/// try during join, so a hostile backend can't force unbounded Argon2id
/// work (SYNC-13). Well above any real device count.
const MAX_JOIN_KEYRING_ATTEMPTS: usize = 64;
const MAX_KEYRING_ENTRIES: usize = MAX_JOIN_KEYRING_ATTEMPTS + 1;

/// Upper bound on a single repo object we'll pull into memory (SYNC-12).
/// Manifests/keyrings/events/snapshots are all far smaller in practice;
/// this stops a malicious or corrupt backend from returning a
/// multi-gigabyte object and OOM-ing the client.
pub(crate) const MAX_SYNC_OBJECT_BYTES: u64 = 64 * 1024 * 1024;

pub struct SyncEngine {
    adapter: Arc<dyn SyncAdapter>,
    device_id: String,
    device_name: String,
    store: Arc<dyn LocalRecordStore>,
    state: Mutex<EngineState>,
    /// Serialises whole engine passes (sync_once / compact / join /
    /// create). Overlapping passes on the same engine corrupt the
    /// `applied_events` set (each pass rewrites it wholesale) and can
    /// double-push dirty records, so every entry point takes this
    /// first.
    op_lock: Mutex<()>,
    /// Compaction retention knobs. Defaults follow RFC-002 §12.2; tests
    /// override them to exercise the older-than path without sleeping.
    retention: RetentionPolicy,
}

/// Tunable retention thresholds applied at compact time.
#[derive(Debug, Clone, Copy)]
pub struct RetentionPolicy {
    /// Events newer than this stay under `events/`; older ones move to
    /// `trash/<ts>/`.
    pub event_retention_days: u64,
    /// Tombstone rows older than this get physically removed from the
    /// local store.
    pub tombstone_retention_days: u64,
    /// Snapshots beyond this count get deleted from `snapshots/`.
    pub snapshot_keep: usize,
    /// Trash entries older than this get physically removed.
    pub trash_retention_days: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            event_retention_days: 30,
            tombstone_retention_days: 90,
            snapshot_keep: 2,
            trash_retention_days: 30,
        }
    }
}

#[derive(Default)]
struct EngineState {
    root_key: Option<SyncRootKey>,
    root_epoch: u64,
    vault_id: Option<String>,
    repo_id: Option<String>,
    clock: LogicalClock,
}

/// One pass's worth of changes. The UI shows a slimmed-down version.
#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    pub events_pulled: usize,
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
    pub events_pushed: usize,
    pub head_clock: u64,
}

#[derive(Debug, Clone)]
pub struct JoinReport {
    pub vault_id: String,
    pub events_pulled: usize,
    pub upserts_applied: usize,
    pub deletes_applied: usize,
    pub conflicts_detected: usize,
    pub already_seen: usize,
    pub skipped: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct AppliedEventsBlob {
    ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct CompactReport {
    pub events_compacted: usize,
    pub events_trashed: usize,
    pub events_retained: usize,
    pub records_in_snapshot: usize,
    pub snapshot_path: String,
    pub head_clock: u64,
    pub old_snapshots_pruned: usize,
    pub trash_entries_pruned: usize,
    pub tombstones_pruned: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct RepoStats {
    pub manifest_bytes: u64,
    pub keyring_bytes: u64,
    pub snapshots_bytes: u64,
    pub events_bytes: u64,
    pub trash_bytes: u64,
    pub devices_bytes: u64,
    pub total_bytes: u64,
    pub snapshot_count: usize,
    pub event_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct RekeyReport {
    pub revoked_device_id: String,
    pub retained_devices: usize,
    pub root_epoch: u64,
    pub records_reencrypted: usize,
    pub snapshot_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub last_seen_at: i64,
}

/// Internal helper used by [`SyncEngine::compact`] to track the working
/// set across events without re-encrypting (event AAD matches the
/// snapshot-record AAD, so the ciphertext is verbatim transferable).
/// Tombstones stay in the working set (`deleted = true`) so the folded
/// snapshot still teaches late joiners about deletions instead of
/// letting their stale copies resurrect (SYNC-3).
struct SnapshotSlot {
    kind: String,
    nonce: Vec<u8>,
    ct: Vec<u8>,
    revision: String,
    last_clock: u64,
    deleted: bool,
    /// Epoch-millis of the delete event; 0 for live slots. Drives
    /// tombstone retention inside the snapshot.
    deleted_at: i64,
}

impl SyncEngine {
    pub fn new<A: SyncAdapter + 'static>(
        adapter: A,
        store: Arc<dyn LocalRecordStore>,
        device_id: impl Into<String>,
    ) -> Self {
        let device_id = device_id.into();
        Self {
            adapter: Arc::new(adapter),
            store,
            device_name: device_id.clone(),
            device_id,
            state: Mutex::new(EngineState::default()),
            op_lock: Mutex::new(()),
            retention: RetentionPolicy::default(),
        }
    }

    pub fn with_device_name(mut self, device_name: impl Into<String>) -> Self {
        let name = device_name.into();
        if !name.trim().is_empty() {
            self.device_name = name;
        }
        self
    }

    /// Override the retention thresholds. Mostly useful for tests; the
    /// defaults already match RFC-002 §12.2.
    pub fn with_retention(mut self, retention: RetentionPolicy) -> Self {
        self.retention = retention;
        self
    }

    pub async fn delete_remote_repo_dir(&self) -> Result<(), Error> {
        self.adapter.delete_repo_root_dir().await
    }

    // --- bootstrap ------------------------------------------------------

    /// Initialise a brand-new repo. Fails if a manifest is already there.
    /// Existing local records get seeded as fresh events (so other devices
    /// can join and replay).
    pub async fn create_repo(
        &self,
        passphrase: &str,
        vault_id: &str,
        kdf_params: Argon2Params,
    ) -> Result<usize, Error> {
        let _guard = self.op_lock.lock().await;
        if self.adapter.read(RepoPaths::manifest()).await?.is_some() {
            return Err(Error::AlreadyExists);
        }

        for dir in [
            RepoPaths::keyrings_dir(),
            RepoPaths::snapshots_dir(),
            RepoPaths::events_dir(),
            RepoPaths::trash_dir(),
            RepoPaths::locks_dir(),
            RepoPaths::devices_dir(),
        ] {
            self.adapter.mkdir_p(dir).await?;
        }

        let root_key = fresh_root_key();
        let root_epoch = 1;
        let entry = keyring::wrap_root_key_for_epoch(
            &self.device_id,
            passphrase,
            kdf_params,
            &root_key,
            root_epoch,
        )?;
        let mut keyring_obj = Keyring {
            schema_version: keyring::KEYRING_SCHEMA,
            root_epoch,
            entries: vec![entry],
            mac_b64: String::new(),
        };
        let keyring_mac_key = crypto::derive_keyring_mac_key(&root_key);
        keyring_obj.sign(keyring_mac_key.as_ref())?;
        self.adapter
            .write_atomic(RepoPaths::keyring(), &keyring_obj.to_json()?)
            .await?;

        let repo_id = uuid::Uuid::now_v7().to_string();
        let mut manifest = Manifest::new(&repo_id, vault_id, &self.device_id, now_ms());
        manifest.root_epoch = root_epoch;

        {
            let mut st = self.state.lock().await;
            st.root_key = Some(root_key);
            st.root_epoch = root_epoch;
            st.vault_id = Some(vault_id.to_string());
            st.repo_id = Some(repo_id);
            st.clock = LogicalClock::new(0);
        }

        // Sign + write the manifest now that the root key is in state
        // (SYNC-8). meta_version starts at 1.
        self.sign_and_write_manifest(manifest, 0).await?;
        self.store_root_epoch(root_epoch).await;
        self.touch_device().await?;

        // Seed: every existing local record needs to land on the wire.
        // The store's view of "what's dirty" already includes all
        // freshly inserted local rows.
        let mut seeded = self.push_local_events().await?;

        // For records that aren't yet dirty but exist (e.g. callers
        // back-filled them via apply_upsert prior to create_repo), push
        // them now as upsert events too so first bootstrap always seeds
        // the full local dataset. This also covers the "re-bootstrap"
        // path where rows are already marked clean.
        seeded += self.push_clean_seed_events().await?;

        self.persist_logical_clock().await?;
        Ok(seeded)
    }

    /// Connect to an existing repo. Reads the keyring, unwraps with the
    /// shared passphrase, then bootstraps from the latest snapshot (if
    /// any) and replays every event since.
    pub async fn join_repo(&self, passphrase: &str) -> Result<String, Error> {
        Ok(self.join_repo_with_report(passphrase).await?.vault_id)
    }

    pub async fn join_repo_with_report(&self, passphrase: &str) -> Result<JoinReport, Error> {
        let _guard = self.op_lock.lock().await;
        // Parse the manifest first to discover the immutable keyring
        // selected by this root epoch. It is not trusted until after the
        // root has been unwrapped and its MAC verified below.
        let m_bytes = self
            .adapter
            .read(RepoPaths::manifest())
            .await?
            .ok_or(Error::NotInitialized)?;
        let mut manifest = Manifest::from_json(&m_bytes)?;
        if !RepoPaths::is_keyring_path(&manifest.keyring_path) {
            return Err(Error::Corrupt);
        }
        let seen_epoch = self.load_root_epoch().await;
        if manifest.root_epoch < seen_epoch {
            tracing::error!(
                remote = manifest.root_epoch,
                seen = seen_epoch,
                "sync root epoch regressed"
            );
            return Err(Error::Corrupt);
        }

        let kr_bytes = self
            .adapter
            .read(&manifest.keyring_path)
            .await?
            .ok_or(Error::NotInitialized)?;
        let keyring_obj = Keyring::from_json(&kr_bytes)?;
        if keyring_obj.root_epoch != manifest.root_epoch {
            return Err(Error::Corrupt);
        }

        // SYNC-13: each keyring entry we try costs one full-quota Argon2id
        // derivation. A hostile backend could stuff the keyring with
        // hundreds of 256 MiB / 10-iter entries and make join burn
        // minutes of CPU + GB of RAM. Bound the work two ways: try our own
        // device's entry first (the common case unwraps in one
        // derivation), and cap how many other entries we'll attempt.
        let mut root_key: Option<SyncRootKey> = None;
        if let Some(own) = keyring_obj.entry(&self.device_id) {
            if let Ok(k) =
                keyring::unwrap_root_key_for_epoch(own, passphrase, keyring_obj.root_epoch)
            {
                root_key = Some(k);
            }
        }
        if root_key.is_none() {
            for entry in keyring_obj
                .entries
                .iter()
                .filter(|e| e.device_id != self.device_id)
                .take(MAX_JOIN_KEYRING_ATTEMPTS)
            {
                if let Ok(k) =
                    keyring::unwrap_root_key_for_epoch(entry, passphrase, keyring_obj.root_epoch)
                {
                    root_key = Some(k);
                    break;
                }
            }
        }
        let root_key = root_key.ok_or(Error::AuthenticationFailed)?;

        let keyring_mac_key = crypto::derive_keyring_mac_key(&root_key);
        match keyring_obj.verify_mac(keyring_mac_key.as_ref()) {
            keyring::KeyringMacStatus::Valid => {}
            keyring::KeyringMacStatus::Absent if keyring_obj.root_epoch == 0 => {}
            keyring::KeyringMacStatus::Absent | keyring::KeyringMacStatus::Invalid => {
                tracing::error!("keyring MAC missing or invalid");
                return Err(Error::Corrupt);
            }
        }

        // SYNC-8: authenticate the manifest with the root key we just
        // unwrapped (state isn't populated yet at this point). A wrong
        // MAC means a backend without the root key tampered with it.
        {
            let mac_key = crypto::derive_manifest_mac_key(&root_key);
            match manifest.verify_mac(mac_key.as_ref()) {
                crate::manifest::ManifestMacStatus::Valid => {
                    self.store_manifest_mac_required().await;
                }
                crate::manifest::ManifestMacStatus::Absent => {
                    if manifest.meta_version > 0 || self.manifest_mac_required().await {
                        tracing::error!(
                            "manifest MAC missing after authenticated metadata was established"
                        );
                        return Err(Error::Corrupt);
                    }
                    tracing::debug!("joining legacy unsigned manifest; next write will upgrade it");
                }
                crate::manifest::ManifestMacStatus::Invalid => {
                    tracing::error!("manifest MAC invalid at join — refusing tampered manifest");
                    return Err(Error::Corrupt);
                }
            }
        }

        {
            let mut st = self.state.lock().await;
            st.root_key = Some(clone_root(&root_key));
            st.root_epoch = manifest.root_epoch;
            st.vault_id = Some(manifest.vault_id.clone());
            st.repo_id = Some(manifest.repo_id.clone());
            st.clock = LogicalClock::new(manifest.head_clock);
        }
        self.store_root_epoch(manifest.root_epoch).await;

        // Add ourselves to the authenticated keyring if we're a fresh
        // joiner. Epoch 1+ uses an immutable keyring object and publishes
        // the pointer in the MACed manifest last, so a crash cannot leave
        // a half-written mutable keyring.
        if keyring_obj.entry(&self.device_id).is_none() {
            if keyring_obj.entries.len() >= MAX_KEYRING_ENTRIES {
                return Err(Error::Corrupt);
            }
            let new_entry = keyring::wrap_root_key_for_epoch(
                &self.device_id,
                passphrase,
                Argon2Params::default(),
                &root_key,
                keyring_obj.root_epoch,
            )?;
            let mut updated = keyring_obj.clone();
            updated.entries.push(new_entry);
            if updated.root_epoch > 0 {
                updated.schema_version = keyring::KEYRING_SCHEMA;
                updated.sign(keyring_mac_key.as_ref())?;
                let path = RepoPaths::keyring_filename(
                    updated.root_epoch,
                    &uuid::Uuid::now_v7().to_string(),
                );
                self.adapter.write_new(&path, &updated.to_json()?).await?;
                manifest.keyring_path = path;
                manifest.keyring_version = manifest.keyring_version.saturating_add(1);
                manifest.updated_at = now_ms();
                manifest.updated_by_device = self.device_id.clone();
                let prev = manifest.meta_version;
                self.sign_and_write_manifest(manifest.clone(), prev).await?;
            } else {
                // Preserve the legacy shape until an explicit rotation.
                updated.schema_version = 1;
                updated.mac_b64.clear();
                self.adapter
                    .write_atomic(RepoPaths::keyring(), &updated.to_json()?)
                    .await?;
            }
        }
        self.touch_device().await?;

        // Restore Lamport clock + applied_events from sync_state so
        // re-joins are idempotent (we don't re-apply events that
        // landed in the local store on a previous run).
        self.restore_logical_clock().await?;

        // If there's a snapshot we haven't applied yet, apply it. The
        // snapshot is the cheap bootstrap path — replaying every event
        // since the start would work too, just slower.
        if let Some(snap_path) = manifest.latest_snapshot.as_deref() {
            self.apply_snapshot_if_new(snap_path, &manifest.vault_id)
                .await?;
        }

        // Then replay any events the snapshot didn't already cover.
        let tally = self.apply_remote_events().await?;

        self.persist_logical_clock().await?;
        Ok(JoinReport {
            vault_id: manifest.vault_id,
            events_pulled: tally.upserts_applied
                + tally.deletes_applied
                + tally.conflicts_detected
                + tally.already_seen
                + tally.skipped,
            upserts_applied: tally.upserts_applied,
            deletes_applied: tally.deletes_applied,
            conflicts_detected: tally.conflicts_detected,
            already_seen: tally.already_seen,
            skipped: tally.skipped,
        })
    }

    // --- workhorse ------------------------------------------------------

    pub async fn sync_once(&self) -> Result<SyncReport, Error> {
        let _guard = self.op_lock.lock().await;
        let mut report = SyncReport::default();

        // Validate vault_id every pass — surfaces config drift early.
        let remote_manifest = self.read_manifest_required().await?;
        {
            let st = self.state.lock().await;
            match &st.vault_id {
                Some(local) if local != &remote_manifest.vault_id => {
                    return Err(Error::VaultIdMismatch {
                        local: local.clone(),
                        remote: remote_manifest.vault_id.clone(),
                    });
                }
                None => return Err(Error::NotInitialized),
                _ => {}
            }
        }

        // Fold in any snapshot published since we last looked (a peer's
        // compact). This is how a device that slept through a delete
        // event's whole retention window still learns the deletion: the
        // snapshot carries tombstones (SYNC-3). Idempotent — guarded by
        // the last-seen snapshot path + per-record clock comparison.
        if let Some(snap_path) = remote_manifest.latest_snapshot.as_deref() {
            self.apply_snapshot_if_new(snap_path, &remote_manifest.vault_id)
                .await?;
        }

        let tally = self.apply_remote_events().await?;
        report.upserts_applied = tally.upserts_applied;
        report.deletes_applied = tally.deletes_applied;
        report.conflicts_detected = tally.conflicts_detected;
        report.already_seen = tally.already_seen;
        report.skipped = tally.skipped + tally.stale_dropped + tally.corrupt_skipped;
        report.events_pulled = tally.upserts_applied
            + tally.deletes_applied
            + tally.conflicts_detected
            + tally.already_seen
            + report.skipped;

        report.events_pushed = self.push_local_events().await?;

        // Make sure the manifest's head_clock reflects the events we
        // just appended. Best-effort — overlapping writers will
        // converge through max() semantics on subsequent passes.
        let our_clock = {
            let st = self.state.lock().await;
            st.clock.get()
        };
        if report.events_pushed > 0 || our_clock > remote_manifest.head_clock {
            self.bump_manifest_head_clock(our_clock).await?;
        }
        report.head_clock = our_clock;

        self.persist_logical_clock().await?;
        self.touch_device().await?;
        Ok(report)
    }

    async fn apply_remote_events(&self) -> Result<ApplyTally, Error> {
        let mut tally = ApplyTally::default();

        let root_key = self.clone_root_key().await?;
        let root_epoch = self.root_epoch().await?;
        let event_mac_key = crypto::derive_event_mac_key(&root_key);
        let vault_id = self.vault_id_required().await?;

        let mut applied = self.load_applied_events().await?;

        let listed = self.adapter.list(RepoPaths::events_dir(), true).await?;
        let mut event_metas: Vec<_> = listed
            .into_iter()
            .filter(|m| RepoPaths::is_event_path(&m.path))
            .collect();
        // Apply in Lamport order. Filenames embed the zero-padded clock
        // (`ev-<clock12>-<device>-…`), so sorting by *basename* gives
        // clock order even across `events/YYYY-MM/` buckets — sorting
        // by full path would let a wall-clock rollback across a month
        // boundary replay events out of order (SYNC-7). Correctness no
        // longer depends on this (the merge guard below is
        // order-independent), but in-order application avoids spurious
        // conflict entries.
        event_metas.sort_by(|a, b| event_sort_key(&a.path).cmp(event_sort_key(&b.path)));

        for meta in event_metas {
            let path = &meta.path;
            let Some(bytes) = self.adapter.read(path).await? else {
                continue;
            };
            // A single undecodable object must not stall the entire
            // repo: quarantine it (after a grace period, in case a
            // legacy-client writer is still mid-upload) and move on
            // (SYNC-5). Schema-too-new events are left in place for the
            // newer client that understands them.
            let ev = match decode_event(&bytes) {
                Ok(ev) => ev,
                Err(Error::SchemaTooNew { .. }) => {
                    tally.skipped += 1;
                    continue;
                }
                Err(e) => {
                    tracing::warn!(path = %path, error = %e, "skipping undecodable event");
                    self.quarantine_event(path, meta.modified_unix_ms).await;
                    tally.corrupt_skipped += 1;
                    continue;
                }
            };

            if ev.root_epoch != root_epoch {
                // Objects from an old root generation are not corrupt;
                // they are simply outside the current authenticated log.
                tally.skipped += 1;
                continue;
            }
            if root_epoch > 0
                && ev.verify_mac(event_mac_key.as_ref()) != event::EventMacStatus::Valid
            {
                tracing::warn!(path = %path, "skipping event with invalid envelope MAC");
                self.quarantine_event(path, meta.modified_unix_ms).await;
                tally.corrupt_skipped += 1;
                continue;
            }

            if applied.contains(&ev.event_id) {
                tally.already_seen += 1;
                continue;
            }

            // Take the remote clock into account even when we end up
            // skipping the event — its mere existence advances causal
            // history we should observe.
            {
                let st = self.state.lock().await;
                st.clock.observe(ev.lamport_clock);
            }

            if ev.vault_id != vault_id {
                tally.skipped += 1;
                applied.insert(ev.event_id);
                continue;
            }

            if !is_syncable_kind(&ev.kind) {
                // Forward-compat: do NOT mark an unsupported-kind event
                // applied. A later build that learns to sync this kind
                // must be able to pick the event up on a future pass —
                // marking it applied here is exactly what stranded early
                // `snippet` events on devices that first saw them under a
                // build whose `is_syncable_kind` predated snippet support.
                // The Lamport clock was already observed above, so causal
                // history stays correct; we just re-evaluate it next pass.
                tally.skipped += 1;
                continue;
            }

            // Decrypt before touching the store so crypto failures
            // (tampered / truncated payloads) can be isolated to this
            // one object; store errors below still abort the pass.
            let remote_plain = match ev.op {
                Op::Delete => Vec::new(),
                Op::Upsert => match decrypt_upsert(&ev, &root_key, &vault_id) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(path = %path, error = %e, "skipping undecryptable event");
                        self.quarantine_event(path, meta.modified_unix_ms).await;
                        tally.corrupt_skipped += 1;
                        continue;
                    }
                },
            };

            self.apply_event(&ev, remote_plain, &mut tally)?;
            applied.insert(ev.event_id);
        }

        self.persist_applied_events(&applied).await?;
        Ok(tally)
    }

    /// Move a broken event object into `trash/corrupt-<ts>/` so it
    /// stops being retried every pass. Only files older than a grace
    /// window are moved — a fresh file might still be mid-upload by a
    /// writer without atomic `write_new` (older app versions).
    /// Best-effort: failures just leave the object for the next pass.
    async fn quarantine_event(&self, path: &str, modified_unix_ms: i64) {
        const GRACE_MS: i64 = 15 * 60 * 1000;
        let now = now_ms();
        if modified_unix_ms <= 0 || now - modified_unix_ms < GRACE_MS {
            return;
        }
        let dest = format!("trash/corrupt-{now}/{path}");
        match self.adapter.rename(path, &dest).await {
            Ok(()) => tracing::warn!(path = %path, dest = %dest, "quarantined corrupt event"),
            Err(e) => tracing::debug!(path = %path, error = %e, "quarantine rename failed"),
        }
    }

    /// The RFC-002 §13.2 merge, rebuilt around causal metadata instead
    /// of the local dirty flag alone:
    ///
    /// 1. **Idempotent** — the event's revision is already our
    ///    `server_rev` → no-op.
    /// 2. **Stale** — the event loses the `(lamport_clock, device_id)`
    ///    total order against what this replica last incorporated →
    ///    drop it. This is what stops a delayed old event from
    ///    silently overwriting newer state (SYNC-1) and a stale delete
    ///    from killing a newer record (SYNC-3).
    /// 3. **Local dirty** — an unpushed local edit exists → keep local
    ///    and log the remote value as a conflict. Convergence: our
    ///    clock already observed this event, so the eventual push of
    ///    the local edit outranks it on every replica.
    /// 4. **Fast-forward** — the event's `parent_revision` extends our
    ///    lineage → adopt silently.
    /// 5. **Concurrent fork** — the event is newer by clock but built
    ///    on a different parent → adopt (LWW on `(clock, device)`;
    ///    deterministic, so every replica converges to the same value)
    ///    *and* log the overwritten local value as a conflict, so the
    ///    losing edit is always recoverable on the replica that held
    ///    it (SYNC-4 symmetry: the loser gets the signal).
    fn apply_event(
        &self,
        ev: &RemoteEvent,
        remote_plain: Vec<u8>,
        tally: &mut ApplyTally,
    ) -> Result<(), Error> {
        let Some(loc) = self.store.find(&ev.record_id)? else {
            // Brand-new record (or tombstone) for this replica → land it.
            // Tombstones are materialised so a later stale upsert from a
            // third device can't resurrect the record.
            match ev.op {
                Op::Upsert => {
                    self.store.apply_upsert(
                        &ev.record_id,
                        &ev.kind,
                        &remote_plain,
                        &ev.revision,
                        ev.lamport_clock,
                        &ev.device_id,
                    )?;
                    tally.upserts_applied += 1;
                }
                Op::Delete => {
                    self.store.apply_delete(
                        &ev.record_id,
                        &ev.revision,
                        ev.lamport_clock,
                        &ev.device_id,
                    )?;
                    tally.deletes_applied += 1;
                }
            }
            return Ok(());
        };

        // (1) Idempotent redelivery of the revision we already carry.
        if loc.server_rev.as_deref() == Some(ev.revision.as_str()) {
            tally.already_seen += 1;
            return Ok(());
        }

        // (2) Causal guard.
        let ev_wins = ev.lamport_clock > loc.last_clock
            || (ev.lamport_clock == loc.last_clock && ev.device_id > loc.last_device);
        if !ev_wins {
            tally.stale_dropped += 1;
            return Ok(());
        }

        // (3) Unpushed local edit → keep local, preserve remote value.
        if loc.dirty {
            self.store.record_conflict(
                &loc.id,
                &loc.kind,
                &loc.plaintext,
                &remote_plain,
                &loc.local_rev,
                &ev.revision,
            )?;
            tally.conflicts_detected += 1;
            return Ok(());
        }

        // (4) vs (5): does the event extend the lineage we're on?
        // `server_rev == None` means this replica has no recorded
        // lineage for the row (legacy / locally-seeded) — treat as
        // fast-forward.
        let fast_forward = loc.server_rev.is_none()
            || ev.parent_revision.as_deref() == loc.server_rev.as_deref();
        // Don't log a "conflict" when both sides already agree on the
        // outcome (delete-vs-delete, or byte-identical payloads).
        let same_outcome = match ev.op {
            Op::Delete => loc.deleted,
            Op::Upsert => !loc.deleted && loc.plaintext == remote_plain,
        };
        if !fast_forward && !same_outcome {
            self.store.record_conflict(
                &loc.id,
                &loc.kind,
                &loc.plaintext,
                &remote_plain,
                &loc.local_rev,
                &ev.revision,
            )?;
            tally.conflicts_detected += 1;
        }
        match ev.op {
            Op::Upsert => {
                self.store.apply_upsert(
                    &ev.record_id,
                    &ev.kind,
                    &remote_plain,
                    &ev.revision,
                    ev.lamport_clock,
                    &ev.device_id,
                )?;
                tally.upserts_applied += 1;
            }
            Op::Delete => {
                self.store
                    .apply_delete(&loc.id, &ev.revision, ev.lamport_clock, &ev.device_id)?;
                tally.deletes_applied += 1;
            }
        }
        Ok(())
    }

    async fn push_local_events(&self) -> Result<usize, Error> {
        let dirty: Vec<LocalRecord> = self
            .store
            .list_dirty()?
            .into_iter()
            .filter(|r| is_syncable_kind(&r.kind))
            .collect();
        if dirty.is_empty() {
            return Ok(0);
        }

        let root_key = self.clone_root_key().await?;
        let root_epoch = self.root_epoch().await?;
        let event_mac_key = crypto::derive_event_mac_key(&root_key);
        let vault_id = self.vault_id_required().await?;
        let now = now_ms();

        let mut applied = self.load_applied_events().await?;
        let mut pushed = 0usize;

        for rec in dirty {
            let (clock, event_id, revision) = {
                let st = self.state.lock().await;
                let clock = st.clock.tick();
                let event_id = uuid::Uuid::now_v7().to_string();
                let revision = uuid::Uuid::now_v7().to_string();
                (clock, event_id, revision)
            };

            let mut ev = if rec.deleted {
                event::new_delete(
                    &event_id,
                    &self.device_id,
                    clock,
                    now,
                    &vault_id,
                    &rec.id,
                    &rec.kind,
                    &revision,
                    rec.base_server_rev.clone(),
                )
            } else {
                let (nonce, ct) = crypto::seal_record(
                    &root_key,
                    &vault_id,
                    &rec.id,
                    &rec.kind,
                    &revision,
                    &rec.plaintext,
                )?;
                event::new_upsert(
                    &event_id,
                    &self.device_id,
                    clock,
                    now,
                    &vault_id,
                    &rec.id,
                    &rec.kind,
                    &revision,
                    rec.base_server_rev.clone(),
                    &nonce,
                    &ct,
                )
            };
            ev.root_epoch = root_epoch;
            if root_epoch > 0 {
                ev.sign(event_mac_key.as_ref())?;
            }

            let path = RepoPaths::event_filename_ztlog(now, clock, &self.device_id, &event_id);
            self.adapter.write_new(&path, &ev.to_bytes()?).await?;

            // Our own event must be marked applied so the next apply
            // pass doesn't try to re-ingest it.
            applied.insert(event_id);

            // Compare-and-clear (SYNC-2): only drop the dirty flag if
            // the row's local_rev is still the one we read at the top
            // of the loop. An edit made while the upload was in flight
            // keeps its dirty flag — its lineage now points at the
            // event we just wrote (`server_rev`/`base_server_rev`
            // advance unconditionally), so the next pass pushes it as a
            // clean fast-forward instead of losing it forever.
            let cleaned = self.store.mark_clean(
                &rec.id,
                &revision,
                &rec.local_rev,
                clock,
                &self.device_id,
            )?;
            if !cleaned {
                tracing::debug!(
                    record_id = %rec.id,
                    "record edited during push window; kept dirty for next pass"
                );
            }

            pushed += 1;
        }

        self.persist_applied_events(&applied).await?;
        Ok(pushed)
    }

    async fn push_clean_seed_events(&self) -> Result<usize, Error> {
        let clean_live: Vec<LocalRecord> = self
            .store
            .list_all_live()?
            .into_iter()
            .filter(|r| !r.dirty && is_syncable_kind(&r.kind))
            .collect();
        if clean_live.is_empty() {
            return Ok(0);
        }

        let root_key = self.clone_root_key().await?;
        let root_epoch = self.root_epoch().await?;
        let event_mac_key = crypto::derive_event_mac_key(&root_key);
        let vault_id = self.vault_id_required().await?;
        let now = now_ms();

        let mut applied = self.load_applied_events().await?;
        let mut pushed = 0usize;

        for rec in clean_live {
            let (clock, event_id, revision) = {
                let st = self.state.lock().await;
                let clock = st.clock.tick();
                let event_id = uuid::Uuid::now_v7().to_string();
                let revision = if rec.local_rev.is_empty() {
                    uuid::Uuid::now_v7().to_string()
                } else {
                    rec.local_rev.clone()
                };
                (clock, event_id, revision)
            };

            let (nonce, ct) = crypto::seal_record(
                &root_key,
                &vault_id,
                &rec.id,
                &rec.kind,
                &revision,
                &rec.plaintext,
            )?;
            let mut ev = event::new_upsert(
                &event_id,
                &self.device_id,
                clock,
                now,
                &vault_id,
                &rec.id,
                &rec.kind,
                &revision,
                rec.base_server_rev.clone(),
                &nonce,
                &ct,
            );
            ev.root_epoch = root_epoch;
            if root_epoch > 0 {
                ev.sign(event_mac_key.as_ref())?;
            }

            let path = RepoPaths::event_filename_ztlog(now, clock, &self.device_id, &event_id);
            self.adapter.write_new(&path, &ev.to_bytes()?).await?;
            applied.insert(event_id);
            self.store
                .mark_clean(&rec.id, &revision, &rec.local_rev, clock, &self.device_id)?;
            pushed += 1;
        }

        self.persist_applied_events(&applied).await?;
        Ok(pushed)
    }

    async fn apply_snapshot_if_new(&self, snap_path: &str, vault_id: &str) -> Result<(), Error> {
        let last_seen = self
            .store
            .get_sync_state(KEY_LAST_SEEN_SNAPSHOT)?
            .and_then(|b| String::from_utf8(b).ok())
            .unwrap_or_default();
        if last_seen == snap_path {
            return Ok(());
        }

        let Some(bytes) = self.adapter.read(snap_path).await? else {
            return Ok(());
        };
        let snap = Snapshot::from_json(&bytes)?;

        let root_key = self.clone_root_key().await?;
        let root_epoch = self.root_epoch().await?;
        if snap.root_epoch != root_epoch {
            return Err(Error::Corrupt);
        }
        if root_epoch > 0 {
            let mac_key = crypto::derive_snapshot_mac_key(&root_key);
            if snap.verify_mac(mac_key.as_ref())
                != crate::snapshot::SnapshotMacStatus::Valid
            {
                return Err(Error::Corrupt);
            }
        }
        if snap.vault_id != vault_id {
            return Err(Error::Corrupt);
        }
        for rec in snap.records {
            // Same causal guard as apply_event: a snapshot entry only
            // lands if it is ahead of what this replica already
            // incorporated. Snapshot entries carry no device id, so
            // strictly-greater is the rule; ties mean "already there".
            let local = self.store.find(&rec.record_id)?;
            if let Some(loc) = &local {
                if rec.last_clock <= loc.last_clock {
                    continue;
                }
            }

            if rec.deleted {
                // Tombstone entry: materialise the deletion (unless a
                // newer local dirty edit exists — keep it, flag it).
                match &local {
                    Some(loc) if loc.dirty => {
                        self.store.record_conflict(
                            &loc.id,
                            &loc.kind,
                            &loc.plaintext,
                            &[],
                            &loc.local_rev,
                            &rec.revision,
                        )?;
                    }
                    _ => {
                        self.store.apply_delete(
                            &rec.record_id,
                            &rec.revision,
                            rec.last_clock,
                            "",
                        )?;
                    }
                }
                continue;
            }

            let nonce = rec.decode_nonce()?;
            let ct = rec.decode_ciphertext()?;
            let plain = crypto::open_record(
                &root_key,
                vault_id,
                &rec.record_id,
                &rec.kind,
                &rec.revision,
                &nonce,
                &ct,
            )?;
            match &local {
                Some(loc) if loc.dirty => {
                    // Local dirty — keep local, but flag the conflict.
                    self.store.record_conflict(
                        &loc.id,
                        &loc.kind,
                        &loc.plaintext,
                        &plain,
                        &loc.local_rev,
                        &rec.revision,
                    )?;
                }
                _ => {
                    self.store.apply_upsert(
                        &rec.record_id,
                        &rec.kind,
                        &plain,
                        &rec.revision,
                        rec.last_clock,
                        "",
                    )?;
                }
            }
        }

        {
            let st = self.state.lock().await;
            st.clock.observe(snap.head_clock);
        }

        self.store
            .put_sync_state(KEY_LAST_SEEN_SNAPSHOT, snap_path.as_bytes())?;
        Ok(())
    }

    /// Advance `manifest.head_clock` to at least `our_clock`.
    ///
    /// The manifest is re-read immediately before the write and merged
    /// (`max` on head_clock, keep the newer `latest_snapshot`) instead
    /// of reusing the copy read at the start of the pass — a concurrent
    /// compact could have pointed `latest_snapshot` at a fresh snapshot
    /// in the meantime, and blindly copying the stale pointer would
    /// orphan that snapshot while its folded events sit in trash
    /// (SYNC-6). Adapters have no conditional write, so a millisecond
    /// race window remains; the re-read shrinks it from "the whole
    /// sync pass" to "one round-trip".
    async fn bump_manifest_head_clock(&self, our_clock: u64) -> Result<(), Error> {
        let fresh = self.read_manifest_required().await?;
        let new_head = fresh.head_clock.max(our_clock);
        if new_head == fresh.head_clock && fresh.updated_by_device == self.device_id {
            return Ok(());
        }
        let new_manifest = Manifest {
            schema_version: MANIFEST_SCHEMA,
            repo_id: fresh.repo_id.clone(),
            vault_id: fresh.vault_id.clone(),
            head_clock: new_head,
            latest_snapshot: fresh.latest_snapshot.clone(),
            keyring_version: fresh.keyring_version,
            root_epoch: fresh.root_epoch,
            keyring_path: fresh.keyring_path.clone(),
            updated_at: now_ms(),
            updated_by_device: self.device_id.clone(),
            meta_version: 0,
            mac_b64: String::new(),
        };
        self.sign_and_write_manifest(new_manifest, fresh.meta_version)
            .await?;
        Ok(())
    }

    // --- accessors used by tests / UI ----------------------------------

    pub async fn vault_id(&self) -> Option<String> {
        self.state.lock().await.vault_id.clone()
    }

    pub async fn repo_id(&self) -> Option<String> {
        self.state.lock().await.repo_id.clone()
    }

    pub async fn head_clock(&self) -> u64 {
        self.state.lock().await.clock.get()
    }

    /// Revoke one enrolled device and rotate the repository to a fresh
    /// root key. A replacement passphrase is mandatory: the revoked
    /// device knows both the old root and old passphrase, so deleting its
    /// keyring row alone would provide no security.
    ///
    /// Publication order is crash-safe:
    /// complete new snapshot -> immutable authenticated keyring ->
    /// authenticated manifest pointer. Until the last step, readers stay
    /// on the complete old epoch.
    pub async fn revoke_device_and_rotate(
        &self,
        revoked_device_id: &str,
        new_passphrase: &str,
        kdf_params: Argon2Params,
    ) -> Result<RekeyReport, Error> {
        if revoked_device_id == self.device_id {
            return Err(Error::CannotRevokeCurrentDevice);
        }
        if new_passphrase.is_empty() {
            return Err(Error::EmptyPassphrase);
        }

        let _guard = self.op_lock.lock().await;
        let lock = self
            .adapter
            .try_lock("rekey", Duration::from_secs(120))
            .await?;
        let result = self
            .revoke_device_and_rotate_inner(revoked_device_id, new_passphrase, kdf_params)
            .await;
        if let Some(tok) = lock {
            let _ = self.adapter.unlock(&tok).await;
        }
        result
    }

    async fn revoke_device_and_rotate_inner(
        &self,
        revoked_device_id: &str,
        new_passphrase: &str,
        kdf_params: Argon2Params,
    ) -> Result<RekeyReport, Error> {
        let initial_manifest = self.read_manifest_required().await?;
        let old_root = self.clone_root_key().await?;
        let old_epoch = self.root_epoch().await?;
        if initial_manifest.root_epoch != old_epoch
            || !RepoPaths::is_keyring_path(&initial_manifest.keyring_path)
        {
            return Err(Error::Corrupt);
        }

        let keyring_bytes = self
            .adapter
            .read(&initial_manifest.keyring_path)
            .await?
            .ok_or(Error::Corrupt)?;
        let old_keyring = Keyring::from_json(&keyring_bytes)?;
        if old_keyring.root_epoch != old_epoch {
            return Err(Error::Corrupt);
        }
        if old_keyring.entries.len() > MAX_KEYRING_ENTRIES {
            return Err(Error::Corrupt);
        }
        if old_epoch > 0 {
            let mac_key = crypto::derive_keyring_mac_key(&old_root);
            if old_keyring.verify_mac(mac_key.as_ref())
                != keyring::KeyringMacStatus::Valid
            {
                return Err(Error::Corrupt);
            }
        }
        if old_keyring.entry(revoked_device_id).is_none() {
            return Err(Error::DeviceNotEnrolled);
        }
        if old_keyring.entry(&self.device_id).is_none() {
            return Err(Error::Corrupt);
        }
        // Deleting the revoked row is not enough if the replacement
        // passphrase can still unwrap *any* old entry: keyring entries
        // are public objects and device ids are not secrets, so the
        // revoked party could use the known old passphrase against a
        // retained device's freshly wrapped row. Make passphrase
        // rotation a cryptographic precondition, not a UI suggestion.
        for entry in &old_keyring.entries {
            if let Ok(candidate) =
                keyring::unwrap_root_key_for_epoch(entry, new_passphrase, old_epoch)
            {
                if zeroterm_crypto::constant_time_eq(candidate.as_ref(), old_root.as_ref()) {
                    return Err(Error::PassphraseNotRotated);
                }
            }
        }

        // Converge remote state, but never publish a complete current
        // snapshot (or unsent local edits) under the retiring root: a
        // revoked device still has that root and could fetch data it had
        // not seen before the cutoff. Rotation therefore requires a
        // clean local store; callers can run ordinary sync first.
        if !self.store.list_dirty()?.is_empty() {
            return Err(Error::RekeyConcurrentEdit);
        }
        if let Some(path) = initial_manifest.latest_snapshot.as_deref() {
            self.apply_snapshot_if_new(path, &initial_manifest.vault_id)
                .await?;
        }
        self.apply_remote_events().await?;
        if !self.store.list_dirty()?.is_empty() {
            return Err(Error::RekeyConcurrentEdit);
        }

        let new_epoch = old_epoch.checked_add(1).ok_or(Error::Corrupt)?;
        let new_root = fresh_root_key();
        let new_snapshot_id = uuid::Uuid::now_v7().to_string();
        let snapshot_clock = {
            let st = self.state.lock().await;
            st.clock.get().max(initial_manifest.head_clock)
        };
        let mut new_snapshot = Snapshot::new(
            &new_snapshot_id,
            &initial_manifest.vault_id,
            snapshot_clock,
            now_ms(),
        );
        new_snapshot.root_epoch = new_epoch;
        let mut records_reencrypted = 0usize;
        for rec in self.store.list_all_records()? {
            if !(is_syncable_kind(&rec.kind) || rec.deleted && rec.kind == "tombstone") {
                continue;
            }
            let revision = rec
                .server_rev
                .as_deref()
                .filter(|revision| !revision.is_empty())
                .unwrap_or(&rec.local_rev);
            if revision.is_empty() {
                return Err(Error::Corrupt);
            }
            if rec.deleted {
                new_snapshot.push_tombstone(
                    &rec.id,
                    &rec.kind,
                    revision,
                    rec.last_clock,
                    now_ms(),
                );
                continue;
            }
            let (new_nonce, new_ct) = crypto::seal_record(
                &new_root,
                &initial_manifest.vault_id,
                &rec.id,
                &rec.kind,
                revision,
                &rec.plaintext,
            )?;
            new_snapshot.push(
                &rec.id,
                &rec.kind,
                revision,
                &new_nonce,
                &new_ct,
                rec.last_clock,
            );
            records_reencrypted += 1;
        }
        if !self.store.list_dirty()?.is_empty() {
            return Err(Error::RekeyConcurrentEdit);
        }
        let snapshot_mac_key = crypto::derive_snapshot_mac_key(&new_root);
        new_snapshot.sign(snapshot_mac_key.as_ref())?;
        let new_snapshot_path =
            RepoPaths::snapshot_filename(new_snapshot.head_clock, &new_snapshot_id);
        self.adapter
            .write_new(&new_snapshot_path, &new_snapshot.to_json()?)
            .await?;

        let mut new_keyring = Keyring {
            schema_version: keyring::KEYRING_SCHEMA,
            root_epoch: new_epoch,
            entries: Vec::new(),
            mac_b64: String::new(),
        };
        for entry in old_keyring
            .entries
            .iter()
            .filter(|entry| entry.device_id != revoked_device_id)
        {
            new_keyring
                .entries
                .push(keyring::wrap_root_key_for_epoch(
                    &entry.device_id,
                    new_passphrase,
                    kdf_params,
                    &new_root,
                    new_epoch,
                )?);
        }
        let retained_devices = new_keyring.entries.len();
        let keyring_mac_key = crypto::derive_keyring_mac_key(&new_root);
        new_keyring.sign(keyring_mac_key.as_ref())?;
        let keyring_path =
            RepoPaths::keyring_filename(new_epoch, &uuid::Uuid::now_v7().to_string());
        self.adapter
            .write_new(&keyring_path, &new_keyring.to_json()?)
            .await?;

        // Re-read the old manifest after compaction so its clock and
        // monotonic metadata version are current, then publish the new
        // epoch in one final mutable write signed by the *new* root.
        let current = self.read_manifest_required().await?;
        if current.root_epoch != old_epoch {
            return Err(Error::Corrupt);
        }
        let seen_meta = self.load_manifest_meta_version().await;
        let mut next = Manifest {
            schema_version: MANIFEST_SCHEMA,
            repo_id: current.repo_id,
            vault_id: current.vault_id,
            head_clock: current.head_clock.max(new_snapshot.head_clock),
            latest_snapshot: Some(new_snapshot_path.clone()),
            keyring_version: current.keyring_version.saturating_add(1),
            root_epoch: new_epoch,
            keyring_path,
            updated_at: now_ms(),
            updated_by_device: self.device_id.clone(),
            meta_version: current.meta_version.max(seen_meta).saturating_add(1),
            mac_b64: String::new(),
        };
        let manifest_mac_key = crypto::derive_manifest_mac_key(&new_root);
        next.sign(manifest_mac_key.as_ref())?;
        self.adapter
            .write_atomic(RepoPaths::manifest(), &next.to_json()?)
            .await?;

        {
            let mut st = self.state.lock().await;
            st.root_key = Some(new_root);
            st.root_epoch = new_epoch;
            st.clock.observe(next.head_clock);
        }
        self.store_root_epoch(new_epoch).await;
        self.store_manifest_meta_version(next.meta_version).await;
        self.store_manifest_mac_required().await;
        self.store
            .put_sync_state(KEY_LAST_SEEN_SNAPSHOT, new_snapshot_path.as_bytes())?;
        self.persist_applied_events(&HashSet::new()).await?;

        // Device presence files are informational, but removing the
        // revoked row keeps the UI aligned with the authenticated set.
        let _ = self
            .adapter
            .delete(&RepoPaths::device_file(revoked_device_id))
            .await;
        self.touch_device().await?;

        Ok(RekeyReport {
            revoked_device_id: revoked_device_id.to_string(),
            retained_devices,
            root_epoch: new_epoch,
            records_reencrypted,
            snapshot_path: new_snapshot_path,
        })
    }

    // --- compaction + retention ----------------------------------------

    /// Fold the events log into a fresh snapshot. Best-effort lock via
    /// `locks/compact.lock` (adapters that don't support locking just
    /// rely on serial calls from a single process).
    pub async fn compact(&self) -> Result<CompactReport, Error> {
        let _guard = self.op_lock.lock().await;
        let lock = self
            .adapter
            .try_lock("compact", Duration::from_secs(60))
            .await?;
        let result = self.compact_inner().await;
        if let Some(tok) = lock {
            let _ = self.adapter.unlock(&tok).await;
        }
        result
    }

    async fn compact_inner(&self) -> Result<CompactReport, Error> {
        let manifest = self.read_manifest_required().await?;
        let vault_id = self.vault_id_required().await?;
        let root_key = self.clone_root_key().await?;
        let root_epoch = self.root_epoch().await?;
        let event_mac_key = crypto::derive_event_mac_key(&root_key);

        let mut working: std::collections::HashMap<String, SnapshotSlot> =
            std::collections::HashMap::new();

        if let Some(snap_path) = manifest.latest_snapshot.as_deref() {
            if let Some(bytes) = self.adapter.read(snap_path).await? {
                let snap = Snapshot::from_json(&bytes)?;
                if snap.root_epoch != root_epoch {
                    return Err(Error::Corrupt);
                }
                if root_epoch > 0 {
                    let mac_key = crypto::derive_snapshot_mac_key(&root_key);
                    if snap.verify_mac(mac_key.as_ref())
                        != crate::snapshot::SnapshotMacStatus::Valid
                    {
                        return Err(Error::Corrupt);
                    }
                }
                for rec in snap.records {
                    let nonce = rec.decode_nonce()?;
                    let ct = rec.decode_ciphertext()?;
                    working.insert(
                        rec.record_id.clone(),
                        SnapshotSlot {
                            kind: rec.kind,
                            nonce,
                            ct,
                            revision: rec.revision,
                            last_clock: rec.last_clock,
                            deleted: rec.deleted,
                            deleted_at: rec.deleted_at,
                        },
                    );
                }
            }
        }

        let listed = self.adapter.list(RepoPaths::events_dir(), true).await?;
        let mut paths: Vec<_> = listed
            .into_iter()
            .filter(|m| RepoPaths::is_event_path(&m.path))
            .collect();
        paths.sort_by(|a, b| a.path.cmp(&b.path));

        // Decode everything first so the fold can run in Lamport order
        // regardless of month-bucket boundaries (SYNC-7), and so a
        // single corrupt object skips instead of aborting the whole
        // compact (SYNC-5). A schema-too-new event *does* abort: this
        // build cannot fold what it cannot read, and compacting around
        // it would eventually trash it.
        let mut applied_count = 0;
        let mut events: Vec<RemoteEvent> = Vec::with_capacity(paths.len());
        // Remember each event's `created_at` (for the retention sweep to
        // spare recent files) and `event_id` (so trashed events can be
        // dropped from the applied-events set — SYNC-11).
        let mut event_ages: Vec<(String, i64, String)> = Vec::with_capacity(paths.len());

        for meta in &paths {
            let Some(bytes) = self.adapter.read(&meta.path).await? else {
                continue;
            };
            let ev = match decode_event(&bytes) {
                Ok(ev) => ev,
                Err(e @ Error::SchemaTooNew { .. }) => return Err(e),
                Err(e) => {
                    tracing::warn!(path = %meta.path, error = %e, "compact: skipping undecodable event");
                    continue;
                }
            };
            if ev.vault_id != vault_id {
                continue;
            }
            if ev.root_epoch != root_epoch {
                continue;
            }
            if root_epoch > 0
                && ev.verify_mac(event_mac_key.as_ref()) != event::EventMacStatus::Valid
            {
                tracing::warn!(path = %meta.path, "compact: skipping event with invalid MAC");
                continue;
            }
            applied_count += 1;
            event_ages.push((meta.path.clone(), ev.created_at, ev.event_id.clone()));
            events.push(ev);
        }
        events.sort_by(|a, b| {
            (a.lamport_clock, a.device_id.as_str()).cmp(&(b.lamport_clock, b.device_id.as_str()))
        });

        let mut max_clock = manifest.head_clock;
        for ev in events {
            max_clock = max_clock.max(ev.lamport_clock);
            // Last-writer-wins fold, mirroring apply_event's guard: an
            // event older than what the slot already reflects (as seeded
            // from the previous snapshot) must not roll it back.
            if let Some(slot) = working.get(&ev.record_id) {
                if ev.lamport_clock <= slot.last_clock {
                    continue;
                }
            }
            match ev.op {
                Op::Upsert => {
                    let nonce = ev.decode_nonce()?;
                    let ct = ev.decode_ciphertext()?;
                    working.insert(
                        ev.record_id.clone(),
                        SnapshotSlot {
                            kind: ev.kind,
                            nonce,
                            ct,
                            revision: ev.revision,
                            last_clock: ev.lamport_clock,
                            deleted: false,
                            deleted_at: 0,
                        },
                    );
                }
                Op::Delete => {
                    // Keep a tombstone slot instead of dropping the id:
                    // the snapshot must teach late joiners about the
                    // deletion or their stale copies resurrect (SYNC-3).
                    working.insert(
                        ev.record_id.clone(),
                        SnapshotSlot {
                            kind: ev.kind,
                            nonce: Vec::new(),
                            ct: Vec::new(),
                            revision: ev.revision,
                            last_clock: ev.lamport_clock,
                            deleted: true,
                            deleted_at: ev.created_at,
                        },
                    );
                }
            }
        }

        // Expire tombstone slots older than the retention window (never
        // shorter than event retention: a delete event still visible in
        // events/ must always have its snapshot tombstone alongside).
        let tombstone_retention_ms = (self
            .retention
            .tombstone_retention_days
            .max(self.retention.event_retention_days) as i64)
            * 86_400_000;
        let now_for_tombstones = now_ms();
        working.retain(|_, slot| {
            !(slot.deleted
                && slot.deleted_at > 0
                && now_for_tombstones - slot.deleted_at > tombstone_retention_ms)
        });

        // Safety net (RFC-002 §4: the local vault is the authoritative
        // current state). The working set above was rebuilt purely from
        // the repo's last snapshot + surviving events — so any record that
        // is live locally but whose creating events were already trashed by
        // a prior retention sweep, and that never made it into the last
        // snapshot, would be silently dropped from the new snapshot. That
        // is exactly how a compact can strand snippets / host groups. Fold
        // in every *clean* local live record the working set is still
        // missing, re-sealing its plaintext under the same per-record AAD
        // (vault||id||kind||revision) so joiners decrypt it identically.
        // Dirty rows are skipped — they haven't been pushed yet and will
        // sync through `push_local_events`. Tombstone slots count as
        // "present" here: a record the repo knows to be deleted must NOT
        // be folded back in by a replica that never learned about the
        // deletion (SYNC-3 resurrection).
        for rec in self.store.list_all_live()? {
            if rec.deleted || rec.dirty || working.contains_key(&rec.id) {
                continue;
            }
            let revision = if rec.local_rev.is_empty() {
                uuid::Uuid::now_v7().to_string()
            } else {
                rec.local_rev.clone()
            };
            let (nonce, ct) = crypto::seal_record(
                &root_key,
                &vault_id,
                &rec.id,
                &rec.kind,
                &revision,
                &rec.plaintext,
            )?;
            working.insert(
                rec.id.clone(),
                SnapshotSlot {
                    kind: rec.kind,
                    nonce: nonce.to_vec(),
                    ct,
                    revision,
                    last_clock: max_clock,
                    deleted: false,
                    deleted_at: 0,
                },
            );
        }

        let snap_id = uuid::Uuid::now_v7().to_string();
        let mut snap = Snapshot::new(&snap_id, &vault_id, max_clock, now_ms());
        snap.root_epoch = root_epoch;
        let mut live_in_snapshot = 0usize;
        for (id, slot) in &working {
            if slot.deleted {
                snap.push_tombstone(id, &slot.kind, &slot.revision, slot.last_clock, slot.deleted_at);
            } else {
                live_in_snapshot += 1;
                snap.push(
                    id,
                    &slot.kind,
                    &slot.revision,
                    &slot.nonce,
                    &slot.ct,
                    slot.last_clock,
                );
            }
        }
        if root_epoch > 0 {
            let mac_key = crypto::derive_snapshot_mac_key(&root_key);
            snap.sign(mac_key.as_ref())?;
        }
        let snap_path = RepoPaths::snapshot_filename(max_clock, &snap_id);
        self.adapter
            .write_atomic(&snap_path, &snap.to_json()?)
            .await?;

        // Publish the manifest BEFORE trashing any events (SYNC-6): if
        // the ordering were trash-first and this process died (or a
        // concurrent pass re-published a stale pointer) in between, a
        // joiner would see the old snapshot + an events/ dir missing the
        // folded events. Re-read the manifest at write time and merge so
        // a concurrent writer's head_clock / newer snapshot pointer
        // isn't clobbered with our stale copy.
        let now = now_ms();
        let fresh = self.read_manifest_required().await.unwrap_or(manifest);
        let latest_snapshot = match fresh.latest_snapshot.as_deref() {
            // Snapshot filenames embed the zero-padded head clock, so a
            // lexicographically greater path is the newer snapshot.
            Some(other) if other > snap_path.as_str() => Some(other.to_string()),
            _ => Some(snap_path.clone()),
        };
        let new_manifest = Manifest {
            schema_version: MANIFEST_SCHEMA,
            repo_id: fresh.repo_id.clone(),
            vault_id: fresh.vault_id.clone(),
            head_clock: fresh.head_clock.max(max_clock),
            latest_snapshot,
            keyring_version: fresh.keyring_version,
            root_epoch: fresh.root_epoch,
            keyring_path: fresh.keyring_path.clone(),
            updated_at: now,
            updated_by_device: self.device_id.clone(),
            meta_version: 0,
            mac_b64: String::new(),
        };
        self.sign_and_write_manifest(new_manifest, fresh.meta_version)
            .await?;

        // RFC-002 §12.2 retention: keep events newer than the configured
        // window in `events/` for incremental sync; trash the older
        // ones. The snapshot we just published covers everything either
        // way, so freshness only matters for joiners who want a cheap
        // replay.
        let event_retention_ms: i64 = (self.retention.event_retention_days as i64) * 86_400_000;
        let trash_dir = format!("trash/{now}");
        let mut trashed = 0;
        let mut retained = 0;
        let mut trashed_ids: Vec<String> = Vec::new();
        for (path, created_at, event_id) in &event_ages {
            if event_retention_ms > 0 && now - *created_at <= event_retention_ms {
                retained += 1;
                continue;
            }
            let dest = format!("{trash_dir}/{path}");
            if self.adapter.rename(path, &dest).await.is_ok() {
                trashed += 1;
                trashed_ids.push(event_id.clone());
            }
        }

        let pruned_snapshots = self
            .prune_old_snapshots(self.retention.snapshot_keep, &snap_path)
            .await?;
        let pruned_trash = self
            .prune_old_trash(self.retention.trash_retention_days)
            .await
            .unwrap_or(0);
        let pruned_tombstones = self
            .store
            .prune_old_tombstones(self.retention.tombstone_retention_days)
            .unwrap_or(0);

        // `applied_events` is the per-device idempotency set for the
        // events log. Retained events must stay in it (clearing them
        // would resurface those events on the next pull). Trashed events,
        // however, can be *dropped* now (SYNC-11): they're no longer
        // under `events/`, and even if a stale copy reappears the causal
        // merge guard treats it as idempotent/stale — so the set no
        // longer has to grow without bound. Prune the trashed ids to keep
        // it proportional to the live event log rather than to all
        // history ever seen.
        if !trashed_ids.is_empty() {
            let mut applied = self.load_applied_events().await?;
            for id in &trashed_ids {
                applied.remove(id);
            }
            self.persist_applied_events(&applied).await?;
        }
        self.store
            .put_sync_state(KEY_LAST_SEEN_SNAPSHOT, snap_path.as_bytes())?;

        Ok(CompactReport {
            events_compacted: applied_count,
            events_trashed: trashed,
            events_retained: retained,
            records_in_snapshot: live_in_snapshot,
            snapshot_path: snap_path,
            head_clock: max_clock,
            old_snapshots_pruned: pruned_snapshots,
            trash_entries_pruned: pruned_trash,
            tombstones_pruned: pruned_tombstones,
        })
    }

    async fn prune_old_snapshots(&self, keep_recent: usize, current: &str) -> Result<usize, Error> {
        let listed = self.adapter.list(RepoPaths::snapshots_dir(), false).await?;
        let mut snaps: Vec<_> = listed
            .into_iter()
            .filter(|m| m.path.ends_with(".bin") && m.path != current)
            .collect();
        snaps.sort_by(|a, b| b.path.cmp(&a.path));
        let drop_start = keep_recent.saturating_sub(1);
        let to_drop: Vec<_> = if drop_start >= snaps.len() {
            Vec::new()
        } else {
            snaps[drop_start..].to_vec()
        };
        let mut pruned = 0;
        for old in to_drop {
            if self.adapter.delete(&old.path).await.is_ok() {
                pruned += 1;
            }
        }
        Ok(pruned)
    }

    async fn prune_old_trash(&self, max_age_days: u64) -> Result<usize, Error> {
        let listed = self.adapter.list(RepoPaths::trash_dir(), true).await?;
        let cutoff = now_ms().saturating_sub((max_age_days as i64) * 86_400_000);
        let mut pruned = 0;
        for entry in listed {
            if entry.modified_unix_ms < cutoff && self.adapter.delete(&entry.path).await.is_ok() {
                pruned += 1;
            }
        }
        Ok(pruned)
    }

    /// Summary of how much space the repo is using, broken out by area.
    pub async fn repo_stats(&self) -> Result<RepoStats, Error> {
        let mut stats = RepoStats::default();
        if let Some(m) = self.adapter.stat(RepoPaths::manifest()).await? {
            stats.manifest_bytes = m.size;
        }
        let keyring_path = self.read_manifest_required().await?.keyring_path;
        if let Some(m) = self.adapter.stat(&keyring_path).await? {
            stats.keyring_bytes = m.size;
        }
        for entry in self.adapter.list(RepoPaths::snapshots_dir(), true).await? {
            stats.snapshots_bytes += entry.size;
            stats.snapshot_count += 1;
        }
        for entry in self.adapter.list(RepoPaths::events_dir(), true).await? {
            stats.events_bytes += entry.size;
            stats.event_count += 1;
        }
        for entry in self.adapter.list(RepoPaths::trash_dir(), true).await? {
            stats.trash_bytes += entry.size;
        }
        for entry in self.adapter.list(RepoPaths::devices_dir(), true).await? {
            stats.devices_bytes += entry.size;
        }
        stats.total_bytes = stats.manifest_bytes
            + stats.keyring_bytes
            + stats.snapshots_bytes
            + stats.events_bytes
            + stats.trash_bytes
            + stats.devices_bytes;
        Ok(stats)
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceInfo>, Error> {
        let manifest = self.read_manifest_required().await?;
        let keyring_bytes = self
            .adapter
            .read(&manifest.keyring_path)
            .await?
            .ok_or(Error::Corrupt)?;
        let keyring = Keyring::from_json(&keyring_bytes)?;
        if keyring.root_epoch != manifest.root_epoch {
            return Err(Error::Corrupt);
        }
        let enrolled: HashSet<&str> = keyring
            .entries
            .iter()
            .map(|entry| entry.device_id.as_str())
            .collect();
        if keyring.root_epoch > 0 {
            let root = self.clone_root_key().await?;
            let mac_key = crypto::derive_keyring_mac_key(&root);
            if keyring.verify_mac(mac_key.as_ref()) != keyring::KeyringMacStatus::Valid {
                return Err(Error::Corrupt);
            }
        }
        let mut out = Vec::new();
        for entry in self.adapter.list(RepoPaths::devices_dir(), true).await? {
            if !entry.path.ends_with(".json") {
                continue;
            }
            let Some(bytes) = self.adapter.read(&entry.path).await? else {
                continue;
            };
            if let Ok(mut device) = serde_json::from_slice::<DeviceInfo>(&bytes) {
                if device.device_id.is_empty() {
                    device.device_id = entry
                        .path
                        .rsplit('/')
                        .next()
                        .unwrap_or_default()
                        .trim_end_matches(".json")
                        .to_string();
                }
                if !enrolled.contains(device.device_id.as_str()) {
                    continue;
                }
                if self.device_id != "device-unknown" && device.device_id == "device-unknown" {
                    continue;
                }
                out.push(device);
            }
        }
        out.sort_by(|a, b| {
            b.last_seen_at
                .cmp(&a.last_seen_at)
                .then_with(|| a.device_id.cmp(&b.device_id))
        });
        Ok(out)
    }

    // --- internals ------------------------------------------------------

    async fn read_manifest_required(&self) -> Result<Manifest, Error> {
        // SYNC-10: the SFTP adapter's `write_atomic` is remove-then-rename,
        // so a concurrent writer can leave a brief window where the
        // manifest doesn't exist. The manifest always exists on an
        // initialised repo, so a `None` here is far more likely that
        // transient gap than genuine de-initialisation — retry a few
        // times with a short backoff before surfacing NotInitialized.
        let mut last = Error::NotInitialized;
        for attempt in 0..4 {
            match self.adapter.read(RepoPaths::manifest()).await {
                Ok(Some(bytes)) => {
                    let manifest = Manifest::from_json(&bytes)?;
                    self.verify_manifest(&manifest).await?;
                    return Ok(manifest);
                }
                Ok(None) => last = Error::NotInitialized,
                Err(e) => last = e,
            }
            if attempt < 3 {
                tokio::time::sleep(Duration::from_millis(50 * (attempt as u64 + 1))).await;
            }
        }
        Err(last)
    }

    /// Authenticate a manifest against the root-key MAC and check its
    /// monotonic version (SYNC-8).
    ///
    /// A present-but-wrong MAC is a hard error: only a party without the
    /// root key (i.e. a malicious/buggy backend) could produce it. A
    /// missing MAC is accepted only for a genuine legacy manifest
    /// (`meta_version == 0`) on a device that has never observed an
    /// authenticated manifest. Once a valid MAC is seen/written, a sticky
    /// local marker makes MAC stripping a hard error. The `meta_version`
    /// regression check is a *soft* signal:
    /// because two devices bump the counter independently, a lower value
    /// can legitimately arise from a concurrent writer, so it's logged as
    /// a possible rollback rather than hard-failed. The MAC is the real
    /// integrity guarantee; the version is a rollback hint.
    async fn verify_manifest(&self, manifest: &Manifest) -> Result<(), Error> {
        let (root, current_epoch) = {
            let st = self.state.lock().await;
            (st.root_key.as_ref().map(clone_root), st.root_epoch)
        };
        let Some(root) = root else {
            return Ok(()); // pre-init / no key yet — nothing to verify against
        };
        let seen_epoch = self.load_root_epoch().await;
        if manifest.root_epoch != current_epoch || manifest.root_epoch < seen_epoch {
            tracing::error!(
                remote = manifest.root_epoch,
                current = current_epoch,
                seen = seen_epoch,
                "manifest root epoch mismatch or rollback"
            );
            return Err(Error::Corrupt);
        }
        if !RepoPaths::is_keyring_path(&manifest.keyring_path) {
            return Err(Error::Corrupt);
        }
        let mac_key = crypto::derive_manifest_mac_key(&root);
        match manifest.verify_mac(mac_key.as_ref()) {
            crate::manifest::ManifestMacStatus::Valid => {
                self.store_manifest_mac_required().await;
            }
            crate::manifest::ManifestMacStatus::Absent => {
                if manifest.meta_version > 0 || self.manifest_mac_required().await {
                    tracing::error!(
                        remote = manifest.meta_version,
                        "manifest MAC missing after authenticated metadata was established"
                    );
                    return Err(Error::Corrupt);
                }
                tracing::debug!("manifest has no MAC (legacy); will be stamped on next write");
            }
            crate::manifest::ManifestMacStatus::Invalid => {
                tracing::error!("manifest MAC verification failed — refusing tampered manifest");
                return Err(Error::Corrupt);
            }
        }
        let seen = self.load_manifest_meta_version().await;
        if manifest.meta_version < seen {
            tracing::warn!(
                remote = manifest.meta_version,
                seen,
                "manifest meta_version regressed — possible rollback by the backend"
            );
        }
        Ok(())
    }

    /// Stamp the manifest's `meta_version` and MAC, then write it (SYNC-8).
    /// `prev_meta_version` is the version of the manifest this write is
    /// derived from; the new version is `max(prev, locally-seen) + 1` so
    /// it moves forward even across devices.
    async fn sign_and_write_manifest(
        &self,
        mut manifest: Manifest,
        prev_meta_version: u64,
    ) -> Result<(), Error> {
        let seen = self.load_manifest_meta_version().await;
        manifest.meta_version = prev_meta_version.max(seen).saturating_add(1);
        if let Some(root) = self.state.lock().await.root_key.as_ref().map(clone_root) {
            let mac_key = crypto::derive_manifest_mac_key(&root);
            manifest.sign(mac_key.as_ref())?;
        }
        self.adapter
            .write_atomic(RepoPaths::manifest(), &manifest.to_json()?)
            .await?;
        self.store_manifest_meta_version(manifest.meta_version).await;
        self.store_manifest_mac_required().await;
        self.store_root_epoch(manifest.root_epoch).await;
        Ok(())
    }

    async fn load_manifest_meta_version(&self) -> u64 {
        self.store
            .get_sync_state(KEY_MANIFEST_META_VERSION)
            .ok()
            .flatten()
            .and_then(|b| b.try_into().ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0)
    }

    async fn store_manifest_meta_version(&self, v: u64) {
        let cur = self.load_manifest_meta_version().await;
        if v > cur {
            let _ = self
                .store
                .put_sync_state(KEY_MANIFEST_META_VERSION, &v.to_le_bytes());
        }
    }

    async fn manifest_mac_required(&self) -> bool {
        self.store
            .get_sync_state(KEY_MANIFEST_MAC_REQUIRED)
            .ok()
            .flatten()
            .is_some_and(|value| value.as_slice() == b"1")
    }

    async fn store_manifest_mac_required(&self) {
        let _ = self
            .store
            .put_sync_state(KEY_MANIFEST_MAC_REQUIRED, b"1");
    }

    async fn load_root_epoch(&self) -> u64 {
        self.store
            .get_sync_state(KEY_ROOT_EPOCH)
            .ok()
            .flatten()
            .and_then(|b| b.try_into().ok())
            .map(u64::from_le_bytes)
            .unwrap_or(0)
    }

    async fn store_root_epoch(&self, epoch: u64) {
        if epoch > self.load_root_epoch().await {
            let _ = self
                .store
                .put_sync_state(KEY_ROOT_EPOCH, &epoch.to_le_bytes());
        }
    }

    async fn touch_device(&self) -> Result<(), Error> {
        let info = DeviceInfo {
            device_id: self.device_id.clone(),
            name: self.device_name.clone(),
            last_seen_at: now_ms(),
        };
        self.adapter
            .write_atomic(
                &RepoPaths::device_file(&self.device_id),
                &serde_json::to_vec_pretty(&info)?,
            )
            .await?;
        if self.device_id != "device-unknown" {
            let legacy_path = RepoPaths::device_file("device-unknown");
            if self.adapter.stat(&legacy_path).await?.is_some() {
                let _ = self.adapter.delete(&legacy_path).await;
            }
        }
        Ok(())
    }

    async fn clone_root_key(&self) -> Result<SyncRootKey, Error> {
        let st = self.state.lock().await;
        let k = st.root_key.as_ref().ok_or(Error::NotInitialized)?;
        Ok(clone_root(k))
    }

    async fn root_epoch(&self) -> Result<u64, Error> {
        let st = self.state.lock().await;
        if st.root_key.is_none() {
            return Err(Error::NotInitialized);
        }
        Ok(st.root_epoch)
    }

    async fn vault_id_required(&self) -> Result<String, Error> {
        self.state
            .lock()
            .await
            .vault_id
            .clone()
            .ok_or(Error::NotInitialized)
    }

    async fn load_applied_events(&self) -> Result<HashSet<String>, Error> {
        let Some(bytes) = self.store.get_sync_state(KEY_APPLIED_EVENTS)? else {
            return Ok(HashSet::new());
        };
        let blob: AppliedEventsBlob = serde_json::from_slice(&bytes)?;
        Ok(blob.ids.into_iter().collect())
    }

    async fn persist_applied_events(&self, ids: &HashSet<String>) -> Result<(), Error> {
        let mut v: Vec<String> = ids.iter().cloned().collect();
        v.sort();
        let blob = AppliedEventsBlob { ids: v };
        let bytes = serde_json::to_vec(&blob)?;
        self.store.put_sync_state(KEY_APPLIED_EVENTS, &bytes)?;
        Ok(())
    }

    async fn restore_logical_clock(&self) -> Result<(), Error> {
        if let Some(bytes) = self.store.get_sync_state(KEY_LOGICAL_CLOCK)? {
            if bytes.len() == 8 {
                let mut arr = [0u8; 8];
                arr.copy_from_slice(&bytes);
                let value = u64::from_le_bytes(arr);
                let st = self.state.lock().await;
                st.clock.observe(value);
            }
        }
        Ok(())
    }

    async fn persist_logical_clock(&self) -> Result<(), Error> {
        let value = {
            let st = self.state.lock().await;
            st.clock.get()
        };
        self.store
            .put_sync_state(KEY_LOGICAL_CLOCK, &value.to_le_bytes())?;
        Ok(())
    }
}

/// Decode an event read from the repo. Auto-detects which format the
/// caller wrote based on the leading magic bytes:
///   - `.ztlog` frames are length-bounded binary and start with `b"ZTLG"`
///     (no JSON document does).
///   - Anything else is fed to [`RemoteEvent::from_json`]. Pre-M10
///     repos with `.json` files keep working without a migration step.
fn decode_event(bytes: &[u8]) -> Result<RemoteEvent, Error> {
    if RemoteEvent::looks_like_ztlog(bytes) {
        RemoteEvent::from_bytes(bytes)
    } else {
        RemoteEvent::from_json(bytes)
    }
}

/// Sort key for applying events: the basename, which starts with
/// `ev-<clock12>-<device>-…` — lexicographic order on it matches
/// `(lamport_clock, device_id)` order even across `events/YYYY-MM/`
/// bucket boundaries (the full path would sort by wall-clock month
/// first).
fn event_sort_key(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn decrypt_upsert(
    ev: &RemoteEvent,
    root_key: &SyncRootKey,
    vault_id: &str,
) -> Result<Vec<u8>, Error> {
    let nonce = ev.decode_nonce()?;
    let ct = ev.decode_ciphertext()?;
    crypto::open_record(
        root_key,
        vault_id,
        &ev.record_id,
        &ev.kind,
        &ev.revision,
        &nonce,
        &ct,
    )
}

fn clone_root(root: &SyncRootKey) -> SyncRootKey {
    let mut copy: SyncRootKey = Zeroizing::new([0u8; KEY_LEN]);
    copy.as_mut().copy_from_slice(root.as_ref());
    copy
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_syncable_kind(kind: &str) -> bool {
    matches!(kind, "host" | "host_group" | "snippet")
}

// Suppress dead-code warning for the LocalRecord import — the file uses
// it in a doc-only comment via the import name resolution path.
fn _force_use(_: LocalRecord) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::LocalAdapter;
    use crate::local_store::InMemoryStore;
    use tempfile::tempdir;

    fn fast_params() -> Argon2Params {
        Argon2Params {
            m_cost: 19 * 1024,
            t_cost: 2,
            p_cost: 1,
        }
    }

    #[tokio::test]
    async fn create_repo_writes_keyring_and_manifest() {
        let d = tempdir().unwrap();
        let store = Arc::new(InMemoryStore::new()) as Arc<dyn LocalRecordStore>;
        let engine = SyncEngine::new(LocalAdapter::new(d.path()), store, "dev-A");
        engine
            .create_repo("hunter2", "vlt-1", fast_params())
            .await
            .unwrap();

        let a = LocalAdapter::new(d.path());
        assert!(a.read(RepoPaths::manifest()).await.unwrap().is_some());
        assert!(a.read(RepoPaths::keyring()).await.unwrap().is_some());
        assert_eq!(engine.vault_id().await.as_deref(), Some("vlt-1"));
    }

    #[tokio::test]
    async fn create_repo_rejects_existing_repo() {
        let d = tempdir().unwrap();
        let store = Arc::new(InMemoryStore::new()) as Arc<dyn LocalRecordStore>;
        let engine = SyncEngine::new(LocalAdapter::new(d.path()), store, "dev-A");
        engine
            .create_repo("pw", "vlt", fast_params())
            .await
            .unwrap();
        let err = engine.create_repo("pw", "vlt", fast_params()).await;
        assert!(matches!(err, Err(Error::AlreadyExists)));
    }
}
