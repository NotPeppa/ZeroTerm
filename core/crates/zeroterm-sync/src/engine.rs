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

pub struct SyncEngine {
    adapter: Arc<dyn SyncAdapter>,
    device_id: String,
    store: Arc<dyn LocalRecordStore>,
    state: Mutex<EngineState>,
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

/// Internal helper used by [`SyncEngine::compact`] to track the working
/// set across events without re-encrypting (event AAD matches the
/// snapshot-record AAD, so the ciphertext is verbatim transferable).
struct SnapshotSlot {
    kind: String,
    nonce: Vec<u8>,
    ct: Vec<u8>,
    revision: String,
    last_clock: u64,
}

impl SyncEngine {
    pub fn new<A: SyncAdapter + 'static>(
        adapter: A,
        store: Arc<dyn LocalRecordStore>,
        device_id: impl Into<String>,
    ) -> Self {
        Self {
            adapter: Arc::new(adapter),
            store,
            device_id: device_id.into(),
            state: Mutex::new(EngineState::default()),
            retention: RetentionPolicy::default(),
        }
    }

    /// Override the retention thresholds. Mostly useful for tests; the
    /// defaults already match RFC-002 §12.2.
    pub fn with_retention(mut self, retention: RetentionPolicy) -> Self {
        self.retention = retention;
        self
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
        if self.adapter.read(RepoPaths::manifest()).await?.is_some() {
            return Err(Error::AlreadyExists);
        }

        for dir in [
            RepoPaths::snapshots_dir(),
            RepoPaths::events_dir(),
            RepoPaths::trash_dir(),
            RepoPaths::locks_dir(),
            RepoPaths::devices_dir(),
        ] {
            self.adapter.mkdir_p(dir).await?;
        }

        let root_key = fresh_root_key();
        let entry = keyring::wrap_root_key(&self.device_id, passphrase, kdf_params, &root_key)?;
        let keyring_obj = Keyring {
            schema_version: keyring::KEYRING_SCHEMA,
            entries: vec![entry],
        };
        self.adapter
            .write_atomic(RepoPaths::keyring(), &keyring_obj.to_json()?)
            .await?;

        let repo_id = uuid::Uuid::now_v7().to_string();
        let manifest = Manifest::new(&repo_id, vault_id, &self.device_id, now_ms());
        self.adapter
            .write_atomic(RepoPaths::manifest(), &manifest.to_json()?)
            .await?;

        {
            let mut st = self.state.lock().await;
            st.root_key = Some(root_key);
            st.vault_id = Some(vault_id.to_string());
            st.repo_id = Some(repo_id);
            st.clock = LogicalClock::new(0);
        }

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
        let kr_bytes = self
            .adapter
            .read(RepoPaths::keyring())
            .await?
            .ok_or(Error::NotInitialized)?;
        let keyring_obj = Keyring::from_json(&kr_bytes)?;

        let mut root_key: Option<SyncRootKey> = None;
        for entry in &keyring_obj.entries {
            if let Ok(k) = keyring::unwrap_root_key(entry, passphrase) {
                root_key = Some(k);
                break;
            }
        }
        let root_key = root_key.ok_or(Error::AuthenticationFailed)?;

        let m_bytes = self
            .adapter
            .read(RepoPaths::manifest())
            .await?
            .ok_or(Error::NotInitialized)?;
        let manifest = Manifest::from_json(&m_bytes)?;

        // Add ourselves to the keyring if we're a fresh joiner.
        if keyring_obj.entry(&self.device_id).is_none() {
            let new_entry = keyring::wrap_root_key(
                &self.device_id,
                passphrase,
                Argon2Params::default(),
                &root_key,
            )?;
            let mut updated = keyring_obj.clone();
            updated.entries.push(new_entry);
            self.adapter
                .write_atomic(RepoPaths::keyring(), &updated.to_json()?)
                .await?;
        }

        {
            let mut st = self.state.lock().await;
            st.root_key = Some(root_key);
            st.vault_id = Some(manifest.vault_id.clone());
            st.repo_id = Some(manifest.repo_id.clone());
            st.clock = LogicalClock::new(manifest.head_clock);
        }

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

        let tally = self.apply_remote_events().await?;
        report.upserts_applied = tally.upserts_applied;
        report.deletes_applied = tally.deletes_applied;
        report.conflicts_detected = tally.conflicts_detected;
        report.already_seen = tally.already_seen;
        report.skipped = tally.skipped;
        report.events_pulled = tally.upserts_applied
            + tally.deletes_applied
            + tally.conflicts_detected
            + tally.already_seen
            + tally.skipped;

        report.events_pushed = self.push_local_events().await?;

        // Make sure the manifest's head_clock reflects the events we
        // just appended. Best-effort — overlapping writers will
        // converge through max() semantics on subsequent passes.
        let our_clock = {
            let st = self.state.lock().await;
            st.clock.get()
        };
        if report.events_pushed > 0 || our_clock > remote_manifest.head_clock {
            self.bump_manifest_head_clock(&remote_manifest, our_clock)
                .await?;
        }
        report.head_clock = our_clock;

        self.persist_logical_clock().await?;
        Ok(report)
    }

    async fn apply_remote_events(&self) -> Result<ApplyTally, Error> {
        let mut tally = ApplyTally::default();

        let root_key = self.clone_root_key().await?;
        let vault_id = self.vault_id_required().await?;

        let mut applied = self.load_applied_events().await?;

        let listed = self.adapter.list(RepoPaths::events_dir(), true).await?;
        let mut event_paths: Vec<String> = listed
            .into_iter()
            .filter(|m| RepoPaths::is_event_path(&m.path))
            .map(|m| m.path)
            .collect();
        event_paths.sort();

        for path in event_paths {
            let Some(bytes) = self.adapter.read(&path).await? else {
                continue;
            };
            let ev = decode_event(&bytes)?;

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
                tally.skipped += 1;
                applied.insert(ev.event_id);
                continue;
            }

            self.apply_event(&ev, &root_key, &vault_id, &mut tally)?;
            applied.insert(ev.event_id);
        }

        self.persist_applied_events(&applied).await?;
        Ok(tally)
    }

    fn apply_event(
        &self,
        ev: &RemoteEvent,
        root_key: &SyncRootKey,
        vault_id: &str,
        tally: &mut ApplyTally,
    ) -> Result<(), Error> {
        let local = self.store.find(&ev.record_id)?;
        match (local, ev.op) {
            // Brand-new record from a remote upsert → land it.
            (None, Op::Upsert) => {
                let plain = decrypt_upsert(ev, root_key, vault_id)?;
                self.store
                    .apply_upsert(&ev.record_id, &ev.kind, &plain, &ev.revision)?;
                tally.upserts_applied += 1;
            }
            // Brand-new tombstone (we never had the record) — record
            // it so a later upsert from a third device doesn't resurrect.
            (None, Op::Delete) => {
                self.store.apply_delete(&ev.record_id, &ev.revision)?;
                tally.deletes_applied += 1;
            }
            // Local replica is clean (no pending edits) → adopt remote.
            (Some(loc), Op::Upsert) if !loc.dirty => {
                let plain = decrypt_upsert(ev, root_key, vault_id)?;
                self.store
                    .apply_upsert(&ev.record_id, &ev.kind, &plain, &ev.revision)?;
                tally.upserts_applied += 1;
            }
            (Some(loc), Op::Delete) if !loc.dirty => {
                self.store.apply_delete(&loc.id, &ev.revision)?;
                tally.deletes_applied += 1;
            }
            // Both sides edited → conflict. Surface it; leave local
            // copy alone for now. (M5 lifts this into the inbox UI.)
            (Some(loc), Op::Upsert) => {
                let remote_plain = decrypt_upsert(ev, root_key, vault_id)?;
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
            (Some(loc), Op::Delete) => {
                self.store.record_conflict(
                    &loc.id,
                    &loc.kind,
                    &loc.plaintext,
                    &[],
                    &loc.local_rev,
                    &ev.revision,
                )?;
                tally.conflicts_detected += 1;
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

            let ev = if rec.deleted {
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

            let path = RepoPaths::event_filename_ztlog(now, clock, &self.device_id, &event_id);
            self.adapter.write_new(&path, &ev.to_bytes()?).await?;

            // Our own event must be marked applied so the next apply
            // pass doesn't try to re-ingest it.
            applied.insert(event_id);

            self.store.mark_clean(&rec.id, &revision)?;

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
            let ev = event::new_upsert(
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

            let path = RepoPaths::event_filename_ztlog(now, clock, &self.device_id, &event_id);
            self.adapter.write_new(&path, &ev.to_bytes()?).await?;
            applied.insert(event_id);
            self.store.mark_clean(&rec.id, &revision)?;
            pushed += 1;
        }

        self.persist_applied_events(&applied).await?;
        Ok(pushed)
    }

    async fn apply_snapshot_if_new(
        &self,
        snap_path: &str,
        vault_id: &str,
    ) -> Result<(), Error> {
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
        for rec in snap.records {
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
            // Snapshots are authoritative for their head_clock; treat
            // them like a clean upsert.
            if self
                .store
                .find(&rec.record_id)?
                .map(|r| r.dirty)
                .unwrap_or(false)
            {
                // Local dirty — keep local, but flag the conflict.
                let loc = self.store.find(&rec.record_id)?.unwrap();
                self.store.record_conflict(
                    &loc.id,
                    &loc.kind,
                    &loc.plaintext,
                    &plain,
                    &loc.local_rev,
                    &rec.revision,
                )?;
            } else {
                self.store
                    .apply_upsert(&rec.record_id, &rec.kind, &plain, &rec.revision)?;
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

    async fn bump_manifest_head_clock(
        &self,
        current: &Manifest,
        our_clock: u64,
    ) -> Result<(), Error> {
        let new_head = current.head_clock.max(our_clock);
        if new_head == current.head_clock && current.updated_by_device == self.device_id {
            return Ok(());
        }
        let new_manifest = Manifest {
            schema_version: MANIFEST_SCHEMA,
            repo_id: current.repo_id.clone(),
            vault_id: current.vault_id.clone(),
            head_clock: new_head,
            latest_snapshot: current.latest_snapshot.clone(),
            keyring_version: current.keyring_version,
            updated_at: now_ms(),
            updated_by_device: self.device_id.clone(),
        };
        self.adapter
            .write_atomic(RepoPaths::manifest(), &new_manifest.to_json()?)
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

    // --- compaction + retention ----------------------------------------

    /// Fold the events log into a fresh snapshot. Best-effort lock via
    /// `locks/compact.lock` (adapters that don't support locking just
    /// rely on serial calls from a single process).
    pub async fn compact(&self) -> Result<CompactReport, Error> {
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

        let mut working: std::collections::HashMap<String, SnapshotSlot> =
            std::collections::HashMap::new();

        if let Some(snap_path) = manifest.latest_snapshot.as_deref() {
            if let Some(bytes) = self.adapter.read(snap_path).await? {
                let snap = Snapshot::from_json(&bytes)?;
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

        let mut applied_count = 0;
        let mut max_clock = manifest.head_clock;
        // Remember each event's `created_at` so the retention sweep
        // below can spare recent files without re-reading them.
        let mut event_ages: Vec<(String, i64)> = Vec::with_capacity(paths.len());

        for meta in &paths {
            let Some(bytes) = self.adapter.read(&meta.path).await? else {
                continue;
            };
            let ev = decode_event(&bytes)?;
            if ev.vault_id != vault_id {
                continue;
            }
            max_clock = max_clock.max(ev.lamport_clock);
            applied_count += 1;
            event_ages.push((meta.path.clone(), ev.created_at));
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
                        },
                    );
                }
                Op::Delete => {
                    working.remove(&ev.record_id);
                }
            }
        }

        let snap_id = uuid::Uuid::now_v7().to_string();
        let mut snap = Snapshot::new(&snap_id, &vault_id, max_clock, now_ms());
        for (id, slot) in &working {
            snap.push(
                id,
                &slot.kind,
                &slot.revision,
                &slot.nonce,
                &slot.ct,
                slot.last_clock,
            );
        }
        let snap_path = RepoPaths::snapshot_filename(max_clock, &snap_id);
        self.adapter
            .write_atomic(&snap_path, &snap.to_json()?)
            .await?;

        // RFC-002 §12.2 retention: keep events newer than the configured
        // window in `events/` for incremental sync; trash the older
        // ones. The snapshot we just wrote covers everything either way,
        // so freshness only matters for joiners who want a cheap replay.
        let now = now_ms();
        let event_retention_ms: i64 =
            (self.retention.event_retention_days as i64) * 86_400_000;
        let trash_dir = format!("trash/{now}");
        let mut trashed = 0;
        let mut retained = 0;
        for (path, created_at) in &event_ages {
            if event_retention_ms > 0 && now - *created_at <= event_retention_ms {
                retained += 1;
                continue;
            }
            let dest = format!("{trash_dir}/{path}");
            if self.adapter.rename(path, &dest).await.is_ok() {
                trashed += 1;
            }
        }

        let new_manifest = Manifest {
            schema_version: MANIFEST_SCHEMA,
            repo_id: manifest.repo_id.clone(),
            vault_id: manifest.vault_id.clone(),
            head_clock: max_clock,
            latest_snapshot: Some(snap_path.clone()),
            keyring_version: manifest.keyring_version,
            updated_at: now,
            updated_by_device: self.device_id.clone(),
        };
        self.adapter
            .write_atomic(RepoPaths::manifest(), &new_manifest.to_json()?)
            .await?;

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
        // events log. We deliberately leave it alone here: any
        // retained events that were already applied still need to be
        // skipped on the next sync (clearing the set would resurface
        // them and risk false conflicts against local dirty edits made
        // between compact and the next pull). Trashed events stay in
        // the set as harmless dead weight — they're tiny UUID strings.
        self.store
            .put_sync_state(KEY_LAST_SEEN_SNAPSHOT, snap_path.as_bytes())?;

        Ok(CompactReport {
            events_compacted: applied_count,
            events_trashed: trashed,
            events_retained: retained,
            records_in_snapshot: snap.records.len(),
            snapshot_path: snap_path,
            head_clock: max_clock,
            old_snapshots_pruned: pruned_snapshots,
            trash_entries_pruned: pruned_trash,
            tombstones_pruned: pruned_tombstones,
        })
    }

    async fn prune_old_snapshots(
        &self,
        keep_recent: usize,
        current: &str,
    ) -> Result<usize, Error> {
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
            if entry.modified_unix_ms < cutoff
                && self.adapter.delete(&entry.path).await.is_ok()
            {
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
        if let Some(m) = self.adapter.stat(RepoPaths::keyring()).await? {
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

    // --- internals ------------------------------------------------------

    async fn read_manifest_required(&self) -> Result<Manifest, Error> {
        let bytes = self
            .adapter
            .read(RepoPaths::manifest())
            .await?
            .ok_or(Error::NotInitialized)?;
        Manifest::from_json(&bytes)
    }

    async fn clone_root_key(&self) -> Result<SyncRootKey, Error> {
        let st = self.state.lock().await;
        let k = st.root_key.as_ref().ok_or(Error::NotInitialized)?;
        Ok(clone_root(k))
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
    kind == "host"
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
            m_cost: 8 * 1024,
            t_cost: 1,
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
        engine.create_repo("pw", "vlt", fast_params()).await.unwrap();
        let err = engine.create_repo("pw", "vlt", fast_params()).await;
        assert!(matches!(err, Err(Error::AlreadyExists)));
    }
}
