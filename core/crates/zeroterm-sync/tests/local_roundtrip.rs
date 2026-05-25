//! Two-device events roundtrip — the M4 integration target.
//!
//! Drives two [`SyncEngine`] instances pointed at the same temp dir
//! (each backed by its own [`InMemoryStore`]) through a realistic
//! lifecycle: create → put → sync → join → sync → cross-edit → sync →
//! tombstone → sync → concurrent edit → conflict.

use std::sync::Arc;

use tempfile::tempdir;

use zeroterm_crypto::Argon2Params;
use zeroterm_sync::adapter::LocalAdapter;
use zeroterm_sync::engine::SyncEngine;
use zeroterm_sync::local_store::{InMemoryStore, LocalRecordStore};

fn fast_kdf() -> Argon2Params {
    Argon2Params {
        m_cost: 8 * 1024,
        t_cost: 1,
        p_cost: 1,
    }
}

fn make_engine(
    root: &std::path::Path,
    device_id: &str,
) -> (Arc<InMemoryStore>, SyncEngine) {
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

#[tokio::test(flavor = "current_thread")]
async fn two_devices_share_records_through_events() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");

    // A creates the repo and adds rec-1 first.
    engine_a
        .create_repo("shared-passphrase", "vlt-1", fast_kdf())
        .await
        .expect("create_repo");
    store_a.put_local("rec-1", "host", b"hello-from-A".to_vec());
    engine_a.sync_once().await.expect("A: first sync");

    // B joins → join_repo replays existing events, so rec-1 is present
    // without an extra sync_once.
    let vault_id = engine_b
        .join_repo("shared-passphrase")
        .await
        .expect("join_repo");
    assert_eq!(vault_id, "vlt-1");
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"hello-from-A"[..]));

    // B writes its own record and pushes it.
    store_b.put_local("rec-2", "host", b"hello-from-B".to_vec());
    let r_b = engine_b.sync_once().await.expect("B: first sync");
    assert_eq!(r_b.events_pushed, 1);

    // A pulls B's event.
    let r_a = engine_a.sync_once().await.expect("A: second sync");
    assert!(
        r_a.upserts_applied >= 1,
        "expected A to apply B's upsert, got {r_a:?}"
    );
    assert_eq!(live_value(&store_a, "rec-2").as_deref(), Some(&b"hello-from-B"[..]));

    // Update an existing record on A; B should adopt the new value.
    store_a.put_local("rec-1", "host", b"hello-from-A-v2".to_vec());
    engine_a.sync_once().await.unwrap();
    engine_b.sync_once().await.unwrap();
    assert_eq!(
        live_value(&store_b, "rec-1").as_deref(),
        Some(&b"hello-from-A-v2"[..])
    );

    // Tombstone propagation: B deletes rec-2, A should stop seeing it.
    store_b.delete_local("rec-2");
    engine_b.sync_once().await.unwrap();
    engine_a.sync_once().await.unwrap();
    assert!(
        live_value(&store_a, "rec-2").is_none(),
        "tombstone failed to propagate"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn concurrent_local_and_remote_edit_records_conflict() {
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    let (store_b, engine_b) = make_engine(d.path(), "dev-B");

    engine_a
        .create_repo("pw", "vlt", fast_kdf())
        .await
        .unwrap();
    store_a.put_local("rec-1", "host", b"a-v1".to_vec());
    engine_a.sync_once().await.unwrap();

    engine_b.join_repo("pw").await.unwrap();
    assert_eq!(live_value(&store_b, "rec-1").as_deref(), Some(&b"a-v1"[..]));

    // Both edit rec-1 before either has synced again.
    store_a.put_local("rec-1", "host", b"a-edited".to_vec());
    store_b.put_local("rec-1", "host", b"b-edited".to_vec());

    // A wins the race to push.
    engine_a.sync_once().await.unwrap();

    // B sees A's edit but already has its own pending edit → conflict.
    let r = engine_b.sync_once().await.unwrap();
    assert!(
        r.conflicts_detected >= 1,
        "expected a conflict, got {r:?}"
    );
    let cs = store_b.conflicts();
    assert_eq!(cs.len(), 1);
    assert_eq!(cs[0].record_id, "rec-1");
    assert_eq!(cs[0].local_payload, b"b-edited");
    assert_eq!(cs[0].remote_payload, b"a-edited");
}

#[tokio::test(flavor = "current_thread")]
async fn join_with_wrong_passphrase_is_rejected() {
    let d = tempdir().unwrap();
    let (_store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a
        .create_repo("correct-pw", "vlt-1", fast_kdf())
        .await
        .unwrap();

    let (_store_b, engine_b) = make_engine(d.path(), "dev-B");
    let err = engine_b.join_repo("WRONG-PW").await;
    assert!(
        matches!(err, Err(zeroterm_sync::error::Error::AuthenticationFailed)),
        "expected AuthenticationFailed, got {err:?}"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn join_on_uninitialized_dir_errors() {
    let d = tempdir().unwrap();
    let (_store, engine) = make_engine(d.path(), "dev-A");
    let err = engine.join_repo("anything").await;
    assert!(matches!(
        err,
        Err(zeroterm_sync::error::Error::NotInitialized)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn idempotent_sync_does_not_redo_events() {
    // Second sync_once on the same state should report no new
    // pushes/applies — verifies applied_events is doing its job.
    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    let (_store_b, engine_b) = make_engine(d.path(), "dev-B");

    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();
    store_a.put_local("rec-1", "host", b"v1".to_vec());
    engine_a.sync_once().await.unwrap();

    engine_b.join_repo("pw").await.unwrap();
    let r1 = engine_b.sync_once().await.unwrap();
    let r2 = engine_b.sync_once().await.unwrap();
    assert_eq!(r2.upserts_applied, 0, "redundant apply on second sync");
    assert_eq!(r2.events_pushed, 0);
    // r1 may or may not report extra applies (join already covered the
    // initial replay) — what we care about is `r2 == steady-state`.
    drop(r1);
}

#[tokio::test(flavor = "current_thread")]
async fn new_writes_are_ztlog_and_old_json_still_decodes() {
    use zeroterm_sync::event::RemoteEvent;

    let d = tempdir().unwrap();
    let (store_a, engine_a) = make_engine(d.path(), "dev-A");
    engine_a.create_repo("pw", "vlt", fast_kdf()).await.unwrap();

    // Hand-write a legacy `.json` event before any sync runs. The
    // engine should still read it back on the next apply pass.
    let legacy_event = zeroterm_sync::event::new_delete(
        "evt-legacy",
        "dev-OLD",
        7,
        1_700_000_000_000,
        "vlt-OTHER", // mismatched vault — will be skipped, but proves parser ran
        "rec-legacy",
        "host",
        "rev-legacy",
        None,
    );
    let legacy_path = d
        .path()
        .join(".zeroterm-sync/events/2024-03/ev-000000000007-dev-OLD-legacy.json");
    std::fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
    std::fs::write(&legacy_path, legacy_event.to_json().unwrap()).unwrap();

    // Now generate a real local edit and sync — this triggers a
    // .ztlog write.
    store_a.put_local("rec-1", "host", b"hello".to_vec());
    let report = engine_a.sync_once().await.unwrap();
    assert!(report.events_pushed >= 1);
    assert!(report.skipped >= 1, "legacy .json event must be observed");

    // Walk the events dir and confirm: at least one .ztlog (new
    // writer), and the .json fixture is still around (we never
    // touch foreign-vault events).
    let mut found_ztlog = false;
    let mut found_json = false;
    let mut min_ztlog_bytes = usize::MAX;
    let mut max_json_bytes = 0usize;
    for entry in walkdir(d.path()) {
        let name = entry.to_string_lossy().replace('\\', "/");
        if !name.contains(".zeroterm-sync") {
            continue;
        }
        if name.ends_with(".ztlog") {
            found_ztlog = true;
            let bytes = std::fs::read(&entry).unwrap();
            assert!(RemoteEvent::looks_like_ztlog(&bytes));
            // Confirm the frame really is parseable end-to-end.
            let _ev = RemoteEvent::from_bytes(&bytes).unwrap();
            min_ztlog_bytes = min_ztlog_bytes.min(bytes.len());
        }
        if name.ends_with(".json") && name.contains("/events/") {
            found_json = true;
            let bytes = std::fs::read(&entry).unwrap();
            max_json_bytes = max_json_bytes.max(bytes.len());
        }
    }
    assert!(found_ztlog, "expected at least one .ztlog file after sync");
    assert!(found_json, "expected the legacy .json fixture to survive");

    // Size sanity: both files describe a record-level event; the
    // .ztlog header is ~46 B plus shorter ids while the .json wraps
    // each field with quotes + key names. We don't pin an exact
    // ratio — sample sizes are too small — but the binary should
    // never exceed the JSON.
    assert!(
        min_ztlog_bytes <= max_json_bytes,
        "ztlog size ({min_ztlog_bytes} B) should not exceed json ({max_json_bytes} B)"
    );
}

fn walkdir(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out
}
