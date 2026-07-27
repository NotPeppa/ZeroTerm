//! M5 integration coverage — compaction and the conflict resolution
//! path. These run against [`InMemoryStore`] just like
//! `local_roundtrip.rs`; production wires up `VaultBackedStore` from
//! `zeroterm-app`.

use std::sync::Arc;

use tempfile::tempdir;

use zeroterm_crypto::Argon2Params;
use zeroterm_sync::adapter::LocalAdapter;
use zeroterm_sync::engine::{RetentionPolicy, SyncEngine};
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

/// Drop the event-retention window so the test sees the trashed-path
/// behavior without sleeping 30 days. Tombstone retention is kept at
/// the default 90 days.
fn make_engine_no_retention(
    root: &std::path::Path,
    device_id: &str,
) -> (Arc<InMemoryStore>, SyncEngine) {
    let store = Arc::new(InMemoryStore::new());
    let trait_store: Arc<dyn LocalRecordStore> = store.clone();
    let engine = SyncEngine::new(LocalAdapter::new(root), trait_store, device_id).with_retention(
        RetentionPolicy {
            event_retention_days: 0,
            ..RetentionPolicy::default()
        },
    );
    (store, engine)
}

fn live_value(store: &InMemoryStore, id: &str) -> Option<Vec<u8>> {
    store
        .snapshot_live()
        .into_iter()
        .find(|(rid, _)| rid == id)
        .map(|(_, v)| v)
}

#[tokio::test(flavor = "current_thread")]
async fn compact_folds_events_into_snapshot_and_moves_them_to_trash() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine_no_retention(d.path(), "dev-A");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    // Push a few records and updates, generating a handful of events.
    store_a.put_local("r1", "host", b"v1".to_vec());
    store_a.put_local("r2", "host", b"v2".to_vec());
    engine_a.sync_once().await.unwrap();

    store_a.put_local("r1", "host", b"v1-bumped".to_vec());
    store_a.delete_local("r2");
    store_a.put_local("r3", "host", b"v3".to_vec());
    engine_a.sync_once().await.unwrap();

    let stats_before = engine_a.repo_stats().await.unwrap();
    assert!(
        stats_before.event_count >= 3,
        "expected at least 3 events on disk before compact, got {}",
        stats_before.event_count
    );

    let report = engine_a.compact().await.unwrap();
    assert!(report.events_compacted >= 3);
    assert_eq!(report.records_in_snapshot, 2, "r2 was tombstoned");
    assert!(report.events_trashed >= 3);
    assert_eq!(report.events_retained, 0);

    let stats_after = engine_a.repo_stats().await.unwrap();
    assert_eq!(stats_after.event_count, 0);
    assert_eq!(stats_after.snapshot_count, 1);
    assert!(stats_after.trash_bytes > 0);
}

#[tokio::test(flavor = "current_thread")]
async fn compact_retains_recent_events_in_place() {
    // Default retention is 30 days, so freshly written events should
    // stay in `events/` after compact — both for the cheap-replay
    // benefit and so applied_events doesn't get reset under their
    // feet.
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    store_a.put_local("r1", "host", b"v1".to_vec());
    store_a.put_local("r2", "host", b"v2".to_vec());
    engine_a.sync_once().await.unwrap();

    let stats_before = engine_a.repo_stats().await.unwrap();
    let events_before = stats_before.event_count;
    assert!(events_before >= 2);

    let report = engine_a.compact().await.unwrap();
    assert!(report.events_compacted >= 2);
    assert!(
        report.events_retained >= 2,
        "fresh events should be retained, got events_retained={} events_trashed={}",
        report.events_retained,
        report.events_trashed
    );
    assert_eq!(report.events_trashed, 0);

    let stats_after = engine_a.repo_stats().await.unwrap();
    assert_eq!(
        stats_after.event_count, events_before,
        "all events should still be under events/"
    );
    assert_eq!(stats_after.snapshot_count, 1);

    // Joining device picks up the snapshot AND replays the retained
    // events on top — both produce r1+r2. apply_event is idempotent.
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");
    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "r1").as_deref(), Some(&b"v1"[..]));
    assert_eq!(live_value(&store_b, "r2").as_deref(), Some(&b"v2"[..]));
}

#[tokio::test(flavor = "current_thread")]
async fn compact_prunes_old_tombstones_via_store_hook() {
    // tombstone_retention_days=0 means every clean tombstone in the
    // store is fair game for pruning. We seed one via apply_delete (so
    // dirty=false and deleted_at_ms is stamped), then check it's gone
    // after compact.
    let d = tempdir().unwrap();
    let (store_a, engine_a_setup) = make_engine(d.path(), "dev-A");
    engine_a_setup
        .create_repo("pw", "vlt", fast_kdf())
        .await
        .unwrap();
    drop(engine_a_setup);

    // Replace the engine with one that prunes tombstones at 0 days but
    // keeps default event/snapshot retention.
    let trait_store: Arc<dyn LocalRecordStore> = store_a.clone();
    let engine_a = SyncEngine::new(LocalAdapter::new(d.path()), trait_store, "dev-A")
        .with_retention(RetentionPolicy {
            tombstone_retention_days: 0,
            ..RetentionPolicy::default()
        });
    engine_a.join_repo("pw").await.unwrap();

    // Seed a clean tombstone in the store. apply_delete stamps
    // deleted_at_ms = now, which with retention=0 days is "old enough".
    LocalRecordStore::apply_delete(&*store_a, "ghost", "srv-1", 1, "dev-X").unwrap();
    assert!(store_a.find("ghost").unwrap().is_some());

    let report = engine_a.compact().await.unwrap();
    assert_eq!(
        report.tombstones_pruned, 1,
        "tombstone should have been pruned"
    );
    assert!(store_a.find("ghost").unwrap().is_none());
}

#[tokio::test(flavor = "current_thread")]
async fn fresh_device_can_join_via_snapshot_after_compact() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine_no_retention(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("r1", "host", b"v1".to_vec());
    store_a.put_local("r2", "host", b"v2".to_vec());
    engine_a.sync_once().await.unwrap();

    engine_a.compact().await.unwrap();

    // Now a brand-new device joins. It should pick up r1 + r2 from the
    // snapshot alone — there are no events left in events/ (event
    // retention is 0).
    let (store_b, engine_b) = make_engine_no_retention(d.path(), "dev-B");
    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "r1").as_deref(), Some(&b"v1"[..]));
    assert_eq!(live_value(&store_b, "r2").as_deref(), Some(&b"v2"[..]));
}

#[tokio::test(flavor = "current_thread")]
async fn compact_can_run_twice_without_data_loss() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine_no_retention(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("r1", "host", b"v1".to_vec());
    engine_a.sync_once().await.unwrap();

    engine_a.compact().await.unwrap();

    // Subsequent edits + sync + compact still preserve r1 in the snapshot.
    store_a.put_local("r2", "host", b"v2".to_vec());
    engine_a.sync_once().await.unwrap();
    let r = engine_a.compact().await.unwrap();
    assert_eq!(r.records_in_snapshot, 2);

    // A third device should see both records.
    let (store_c, engine_c) = make_engine_no_retention(d.path(), "dev-C");
    engine_c.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_c, "r1").as_deref(), Some(&b"v1"[..]));
    assert_eq!(live_value(&store_c, "r2").as_deref(), Some(&b"v2"[..]));
}

#[tokio::test(flavor = "current_thread")]
async fn repo_stats_reflects_actual_disk_usage() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    let s0 = engine_a.repo_stats().await.unwrap();
    assert!(s0.manifest_bytes > 0);
    assert!(s0.keyring_bytes > 0);
    assert_eq!(s0.event_count, 0);

    store_a.put_local("r1", "host", b"hello".to_vec());
    engine_a.sync_once().await.unwrap();

    let s1 = engine_a.repo_stats().await.unwrap();
    assert!(s1.event_count >= 1);
    assert!(s1.events_bytes > 0);
    assert!(s1.total_bytes > s0.total_bytes);
}
