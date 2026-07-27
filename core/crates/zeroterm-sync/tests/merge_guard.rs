//! Regression coverage for the 2026-07 audit's sync findings.
//!
//! Each test reproduces one of the audited data-loss scenarios and
//! asserts the post-fix behavior:
//!   - SYNC-1: a delayed old event must not overwrite newer state
//!   - SYNC-2: an edit made during the push upload window must survive
//!   - SYNC-3: a compacted-away delete must still reach late devices,
//!     and their compact must not resurrect the record
//!   - SYNC-4: both sides of a concurrent edit get a conflict entry and
//!     converge to the same deterministic winner
//!   - SYNC-5: one corrupt event object must not stall the whole repo
//!   - SYNC-6: a compact finishing mid-push must not lose its
//!     `latest_snapshot` pointer to the pusher's manifest rewrite

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tempfile::tempdir;

use zeroterm_crypto::Argon2Params;
use zeroterm_sync::adapter::{LocalAdapter, ObjectMeta, SyncAdapter};
use zeroterm_sync::engine::{RetentionPolicy, SyncEngine};
use zeroterm_sync::error::Error;
use zeroterm_sync::local_store::{InMemoryStore, LocalRecordStore};

fn fast_kdf() -> Argon2Params {
    Argon2Params {
        m_cost: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
    }
}

fn make_engine(root: &std::path::Path, device_id: &str) -> (Arc<InMemoryStore>, SyncEngine) {
    let store = Arc::new(InMemoryStore::new());
    let trait_store: Arc<dyn LocalRecordStore> = store.clone();
    let engine = SyncEngine::new(LocalAdapter::new(root), trait_store, device_id);
    (store, engine)
}

fn live_value(store: &InMemoryStore, id: &str) -> Option<Vec<u8>> {
    store
        .snapshot_live()
        .into_iter()
        .find(|(rid, _)| rid == id)
        .map(|(_, v)| v)
}

fn event_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let events_dir = root.join("zeroterm-sync/events");
    let mut out = Vec::new();
    let mut stack = vec![events_dir];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .extension()
                .map(|e| e == "ztlog" || e == "json")
                .unwrap_or(false)
            {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------
// SYNC-1: delayed old event must not overwrite newer state.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn stale_event_delivered_late_does_not_overwrite_newer_value() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    engine_a.sync_once().await.unwrap();
    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"v1"[..]));

    // A writes v2; its event is "delayed" (moved out of the repo before
    // B can see it — eventually-consistent backends deliver like this).
    let before = event_files(d.path());
    store_a.put_local("rec-1", "host", b"v2".to_vec());
    engine_a.sync_once().await.unwrap();
    let after = event_files(d.path());
    let delayed: Vec<_> = after.iter().filter(|p| !before.contains(p)).collect();
    assert_eq!(delayed.len(), 1);
    let delayed_path = delayed[0].clone();
    let stash = d.path().join("stashed-event.ztlog");
    std::fs::rename(&delayed_path, &stash).unwrap();

    // A writes v3; B sees it (v2 still in transit).
    store_a.put_local("rec-1", "host", b"v3".to_vec());
    engine_a.sync_once().await.unwrap();
    engine_b.sync_once().await.unwrap();
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"v3"[..]));

    // The delayed v2 event finally arrives. Pre-fix, B's clean replica
    // adopted it unconditionally and silently rolled back to v2.
    std::fs::rename(&stash, &delayed_path).unwrap();
    let report = engine_b.sync_once().await.unwrap();
    assert_eq!(
        live_value(&store_b, "rec-1").as_deref(),
        Some(&b"v3"[..]),
        "stale event must be dropped, not adopted"
    );
    assert!(report.skipped >= 1, "stale drop should be counted: {report:?}");

    // And A never regresses either.
    engine_a.sync_once().await.unwrap();
    assert_eq!(live_value(&store_a, "rec-1").as_deref(), Some(&b"v3"[..]));
}

// ---------------------------------------------------------------------
// SYNC-2: an edit during the push upload window must survive.
// ---------------------------------------------------------------------

type Hook = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// LocalAdapter wrapper that runs a one-shot async hook right before
/// the first `write_new` — the moment an event upload would be in
/// flight on a slow backend.
struct HookedAdapter {
    inner: LocalAdapter,
    before_write_new: Arc<Mutex<Option<Hook>>>,
}

#[async_trait]
impl SyncAdapter for HookedAdapter {
    fn kind(&self) -> &'static str {
        "hooked-local"
    }
    async fn read(&self, path: &str) -> Result<Option<Vec<u8>>, Error> {
        self.inner.read(path).await
    }
    async fn stat(&self, path: &str) -> Result<Option<ObjectMeta>, Error> {
        self.inner.stat(path).await
    }
    async fn list(&self, prefix: &str, recursive: bool) -> Result<Vec<ObjectMeta>, Error> {
        self.inner.list(prefix, recursive).await
    }
    async fn write_new(&self, path: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        let hook = self.before_write_new.lock().unwrap().take();
        if let Some(hook) = hook {
            hook().await;
        }
        self.inner.write_new(path, bytes).await
    }
    async fn write_atomic(&self, path: &str, bytes: &[u8]) -> Result<ObjectMeta, Error> {
        self.inner.write_atomic(path, bytes).await
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), Error> {
        self.inner.rename(from, to).await
    }
    async fn delete(&self, path: &str) -> Result<(), Error> {
        self.inner.delete(path).await
    }
    async fn mkdir_p(&self, path: &str) -> Result<(), Error> {
        self.inner.mkdir_p(path).await
    }
    async fn delete_repo_root_dir(&self) -> Result<(), Error> {
        self.inner.delete_repo_root_dir().await
    }
}

#[tokio::test(flavor = "current_thread")]
async fn edit_during_push_window_is_not_lost() {
    let d = tempdir().unwrap();

    let store_a = Arc::new(InMemoryStore::new());
    let hook_slot: Arc<Mutex<Option<Hook>>> = Arc::new(Mutex::new(None));
    let adapter = HookedAdapter {
        inner: LocalAdapter::new(d.path()),
        before_write_new: hook_slot.clone(),
    };
    let trait_store: Arc<dyn LocalRecordStore> = store_a.clone();
    let engine_a = SyncEngine::new(adapter, trait_store, "dev-A");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    store_a.put_local("rec-1", "host", b"v1".to_vec());
    // While v1's event upload is in flight, the user edits again.
    {
        let store = store_a.clone();
        *hook_slot.lock().unwrap() = Some(Box::new(move || {
            Box::pin(async move {
                store.put_local("rec-1", "host", b"v2-during-upload".to_vec());
            })
        }));
    }
    engine_a.sync_once().await.unwrap();

    // Pre-fix, mark_clean cleared the dirty flag unconditionally and
    // v2 was stranded forever. Post-fix the row stays dirty…
    let rec = store_a.find("rec-1").unwrap().unwrap();
    assert!(rec.dirty, "mid-push edit must remain dirty after the pass");
    assert_eq!(rec.plaintext, b"v2-during-upload");

    // …and the next pass pushes it, so a joiner sees the second edit.
    let report = engine_a.sync_once().await.unwrap();
    assert_eq!(report.events_pushed, 1, "v2 must be pushed on the next pass");

    let (store_b, engine_b) = make_engine(d.path(), "dev-B");
    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(
        live_value(&store_b, "rec-1").as_deref(),
        Some(&b"v2-during-upload"[..])
    );
    // The second push extends the first push's lineage — no conflict.
    assert!(store_b.conflicts().is_empty());
}

// ---------------------------------------------------------------------
// SYNC-3: deletes survive compaction; stale replicas don't resurrect.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn compacted_delete_reaches_offline_device_and_is_not_resurrected() {
    let d = tempdir().unwrap();

    let no_event_retention = RetentionPolicy {
        event_retention_days: 0,
        ..RetentionPolicy::default()
    };

    let store_a = Arc::new(InMemoryStore::new());
    let trait_store_a: Arc<dyn LocalRecordStore> = store_a.clone();
    let engine_a = SyncEngine::new(LocalAdapter::new(d.path()), trait_store_a, "dev-A")
        .with_retention(no_event_retention);

    let (store_b, engine_b) = make_engine(d.path(), "dev-B");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    store_a.put_local("rec-keep", "host", b"keep".to_vec());
    engine_a.sync_once().await.unwrap();

    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"v1"[..]));

    // B goes offline. A deletes rec-1, then compacts with zero event
    // retention: the delete event is trashed, only the snapshot remains.
    store_a.delete_local("rec-1");
    engine_a.sync_once().await.unwrap();
    let report = engine_a.compact().await.unwrap();
    assert!(report.events_trashed >= 1);
    assert_eq!(report.records_in_snapshot, 1, "only rec-keep is live");

    // B comes back online. The delete event is long gone — the
    // snapshot's tombstone must carry the deletion.
    engine_b.sync_once().await.unwrap();
    assert!(
        live_value(&store_b, "rec-1").is_none(),
        "offline device must learn the deletion from the snapshot"
    );
    let b_rec = store_b.find("rec-1").unwrap().unwrap();
    assert!(b_rec.deleted, "B must hold a tombstone, not nothing");

    // B compacts. Pre-fix, the safety net folded B's live copy back
    // into the snapshot and resurrected it fleet-wide.
    let b_report = engine_b.compact().await.unwrap();
    assert_eq!(b_report.records_in_snapshot, 1, "tombstone must not count as live");

    // A fresh device joining now must not see rec-1.
    let (store_c, engine_c) = make_engine(d.path(), "dev-C");
    engine_c.join_repo("pw").await.unwrap();
    assert!(
        live_value(&store_c, "rec-1").is_none(),
        "deleted record resurrected through compact safety net"
    );
    assert_eq!(live_value(&store_c, "rec-keep").as_deref(), Some(&b"keep"[..]));
    // C holds the tombstone too, so it is immune to stale upserts.
    let c_rec = store_c.find("rec-1").unwrap().unwrap();
    assert!(c_rec.deleted);
}

// ---------------------------------------------------------------------
// SYNC-4: concurrent edits — both replicas get a conflict entry and
// converge to the same winner.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn concurrent_edit_records_conflict_on_both_sides_and_converges() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"base".to_vec());
    engine_a.sync_once().await.unwrap();
    engine_b.join_repo("pw").await.unwrap();

    // Both edit from the same base without syncing.
    store_a.put_local("rec-1", "host", b"a-edited".to_vec());
    store_b.put_local("rec-1", "host", b"b-edited".to_vec());

    // A pushes first; B pushes second (B's event gets the higher clock,
    // so B's value is the deterministic winner).
    engine_a.sync_once().await.unwrap();
    let r_b = engine_b.sync_once().await.unwrap();
    assert!(r_b.conflicts_detected >= 1, "loser-side conflict on B: {r_b:?}");

    // A pulls B's winning event. Pre-fix this adopted silently — the
    // first pusher's edit vanished with zero signal anywhere.
    let r_a = engine_a.sync_once().await.unwrap();
    assert!(
        r_a.conflicts_detected >= 1,
        "overwritten side must get a conflict entry too: {r_a:?}"
    );

    // Converged: both replicas hold the same winner…
    engine_b.sync_once().await.unwrap();
    assert_eq!(live_value(&store_a, "rec-1"), live_value(&store_b, "rec-1"));
    assert_eq!(live_value(&store_a, "rec-1").as_deref(), Some(&b"b-edited"[..]));

    // …and each side's conflict log preserves the value that lost there.
    let a_conflicts = store_a.conflicts();
    assert_eq!(a_conflicts.len(), 1);
    assert_eq!(a_conflicts[0].local_payload, b"a-edited");
    assert_eq!(a_conflicts[0].remote_payload, b"b-edited");

    let b_conflicts = store_b.conflicts();
    assert_eq!(b_conflicts.len(), 1);
    assert_eq!(b_conflicts[0].local_payload, b"b-edited");
    assert_eq!(b_conflicts[0].remote_payload, b"a-edited");
}

// ---------------------------------------------------------------------
// SYNC-5: one corrupt event object must not stall the repo.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn corrupt_event_object_does_not_stall_sync_or_join() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    // A truncated / garbage object lands in events/ (crashed writer).
    let junk_dir = d.path().join("zeroterm-sync/events/2024-03");
    std::fs::create_dir_all(&junk_dir).unwrap();
    let junk = junk_dir.join("ev-000000000099-dev-X-junk.ztlog");
    std::fs::write(&junk, b"ZTLG\x01garbage-not-a-frame").unwrap();

    // Sync still works and real events still flow.
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    let report = engine_a.sync_once().await.unwrap();
    assert_eq!(report.events_pushed, 1);
    assert!(report.skipped >= 1, "corrupt object counted as skipped: {report:?}");

    // Joining a repo containing the corrupt object also works.
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");
    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"v1"[..]));
    let _ = store_b;

    // Fresh corrupt files are left alone (a legacy writer might still
    // be uploading).
    assert!(junk.exists(), "fresh corrupt file must not be quarantined yet");
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn old_corrupt_event_object_is_quarantined_to_trash() {
    let d = tempdir().unwrap();
    let (_store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    let junk_dir = d.path().join("zeroterm-sync/events/2024-03");
    std::fs::create_dir_all(&junk_dir).unwrap();
    let junk = junk_dir.join("ev-000000000099-dev-X-junk.ztlog");
    std::fs::write(&junk, b"ZTLG\x01garbage-not-a-frame").unwrap();
    // Age the file past the quarantine grace window.
    let status = std::process::Command::new("touch")
        .args(["-t", "202001010000", junk.to_str().unwrap()])
        .status()
        .unwrap();
    assert!(status.success());

    engine_a.sync_once().await.unwrap();

    assert!(!junk.exists(), "old corrupt object should be quarantined");
    let trash = d.path().join("zeroterm-sync/trash");
    let mut found = false;
    let mut stack = vec![trash];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().map(|n| n == "ev-000000000099-dev-X-junk.ztlog") == Some(true) {
                found = true;
            }
        }
    }
    assert!(found, "quarantined object should land under trash/");
}

// ---------------------------------------------------------------------
// SYNC-6: a compact finishing mid-push must not lose latest_snapshot.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn manifest_bump_mid_pass_does_not_clobber_concurrent_compact() {
    let d = tempdir().unwrap();

    // Engine A: normal, will compact.
    let store_a = Arc::new(InMemoryStore::new());
    let trait_store_a: Arc<dyn LocalRecordStore> = store_a.clone();
    let engine_a = Arc::new(SyncEngine::new(
        LocalAdapter::new(d.path()),
        trait_store_a,
        "dev-A",
    ));
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    engine_a.sync_once().await.unwrap();

    // Engine B: joins, then pushes a record. A's compact lands exactly
    // between B's manifest read (start of pass) and B's manifest write
    // (end of pass) — the audited lost-update window.
    let store_b = Arc::new(InMemoryStore::new());
    let hook_slot: Arc<Mutex<Option<Hook>>> = Arc::new(Mutex::new(None));
    let adapter_b = HookedAdapter {
        inner: LocalAdapter::new(d.path()),
        before_write_new: hook_slot.clone(),
    };
    let trait_store_b: Arc<dyn LocalRecordStore> = store_b.clone();
    let engine_b = SyncEngine::new(adapter_b, trait_store_b, "dev-B");
    engine_b.join_repo("pw").await.unwrap();

    store_b.put_local("rec-2", "host", b"v2".to_vec());
    {
        let a = engine_a.clone();
        *hook_slot.lock().unwrap() = Some(Box::new(move || {
            Box::pin(async move {
                a.compact().await.unwrap();
            })
        }));
    }
    engine_b.sync_once().await.unwrap();

    // The manifest B wrote at the end of its pass must still reference
    // the snapshot A published mid-pass. Pre-fix, B copied the stale
    // pass-start manifest and the pointer regressed to None.
    let manifest_bytes = std::fs::read(d.path().join("zeroterm-sync/manifest.json")).unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).unwrap();
    let latest = manifest["latest_snapshot"].as_str().unwrap_or("");
    assert!(
        latest.starts_with("snapshots/snapshot-"),
        "latest_snapshot pointer lost by concurrent bump: {manifest}"
    );
}

// ---------------------------------------------------------------------
// SYNC-8: a manifest tampered with by the backend (no root key) is
// rejected on the next read.
// ---------------------------------------------------------------------

#[tokio::test(flavor = "current_thread")]
async fn tampered_manifest_is_rejected() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    engine_a.sync_once().await.unwrap();

    // A well-formed sync pass succeeds (manifest MAC verifies).
    engine_a.sync_once().await.unwrap();

    // Simulate a malicious backend that redirects `latest_snapshot`
    // without the root key: edit the field but leave the MAC intact.
    let manifest_path = d.path().join("zeroterm-sync/manifest.json");
    let bytes = std::fs::read(&manifest_path).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    // Confirm the repo actually stamped a MAC (SYNC-8 is active).
    assert!(
        manifest["mac_b64"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
        "manifest should carry a MAC: {manifest}"
    );
    manifest["latest_snapshot"] = serde_json::Value::String("snapshots/evil.bin".into());
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    // The next pass must refuse the tampered manifest.
    let err = engine_a.sync_once().await;
    assert!(
        matches!(err, Err(Error::Corrupt)),
        "tampered manifest must be rejected, got {err:?}"
    );

    // A fresh device joining against the tampered manifest is also refused.
    let (_store_b, engine_b) = make_engine(d.path(), "dev-B");
    let join = engine_b.join_repo("pw").await;
    assert!(
        matches!(join, Err(Error::Corrupt)),
        "join against tampered manifest must be rejected, got {join:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn stripped_manifest_mac_is_rejected_for_existing_and_fresh_devices() {
    let d = tempdir().unwrap();
    let (_store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    let manifest_path = d.path().join("zeroterm-sync/manifest.json");
    let bytes = std::fs::read(&manifest_path).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(manifest["meta_version"].as_u64().unwrap() > 0);
    manifest["mac_b64"] = serde_json::Value::String(String::new());
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    assert!(
        matches!(engine_a.sync_once().await, Err(Error::Corrupt)),
        "an existing device must reject a stripped MAC"
    );

    let (_store_b, engine_b) = make_engine(d.path(), "dev-B");
    assert!(
        matches!(engine_b.join_repo("pw").await, Err(Error::Corrupt)),
        "meta_version proves to a fresh device that this is not a legacy manifest"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn sticky_mac_requirement_survives_manifest_version_erasure() {
    let d = tempdir().unwrap();
    let (_store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    let manifest_path = d.path().join("zeroterm-sync/manifest.json");
    let bytes = std::fs::read(&manifest_path).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    manifest["mac_b64"] = serde_json::Value::String(String::new());
    manifest["meta_version"] = serde_json::Value::Number(0_u64.into());
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    assert!(
        matches!(engine_a.sync_once().await, Err(Error::Corrupt)),
        "the local sticky marker must reject a full MAC/version downgrade"
    );
}
