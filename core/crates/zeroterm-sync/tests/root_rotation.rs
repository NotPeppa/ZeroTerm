use std::sync::Arc;

use tempfile::tempdir;
use zeroterm_crypto::Argon2Params;
use zeroterm_sync::adapter::{LocalAdapter, SyncAdapter};
use zeroterm_sync::crypto;
use zeroterm_sync::engine::SyncEngine;
use zeroterm_sync::error::Error;
use zeroterm_sync::event;
use zeroterm_sync::keyring::{self, Keyring};
use zeroterm_sync::local_store::{InMemoryStore, LocalRecordStore};
use zeroterm_sync::manifest::Manifest;
use zeroterm_sync::repo::RepoPaths;

fn fast_params() -> Argon2Params {
    Argon2Params {
        m_cost: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
    }
}

#[tokio::test]
async fn revoke_rotates_root_preserves_snapshot_and_rejects_old_device() {
    let dir = tempdir().unwrap();
    let store_a = Arc::new(InMemoryStore::new());
    store_a.put_local("live", "host", b"alpha".to_vec());
    store_a.put_local("dead", "host", b"remove-me".to_vec());
    let engine_a = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_a.clone() as Arc<dyn LocalRecordStore>,
        "dev-A",
    );
    engine_a
        .create_repo("old-pass", "vault-1", fast_params())
        .await
        .unwrap();
    store_a.delete_local("dead");
    engine_a.sync_once().await.unwrap();

    let store_b = Arc::new(InMemoryStore::new());
    let engine_b = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_b.clone() as Arc<dyn LocalRecordStore>,
        "dev-B",
    );
    engine_b.join_repo("old-pass").await.unwrap();
    assert_eq!(
        store_b.find("live").unwrap().unwrap().plaintext,
        b"alpha".to_vec()
    );
    assert!(store_b.find("dead").unwrap().unwrap().deleted);

    assert!(matches!(
        engine_a
            .revoke_device_and_rotate("dev-B", "old-pass", fast_params())
            .await,
        Err(Error::PassphraseNotRotated)
    ));

    let report = engine_a
        .revoke_device_and_rotate("dev-B", "new-pass", fast_params())
        .await
        .unwrap();
    assert_eq!(report.revoked_device_id, "dev-B");
    assert_eq!(report.root_epoch, 2);
    assert_eq!(report.retained_devices, 1);
    assert_eq!(report.records_reencrypted, 1);
    let adapter = LocalAdapter::new(dir.path());
    for object in adapter
        .list(RepoPaths::snapshots_dir(), true)
        .await
        .unwrap()
    {
        let snapshot: serde_json::Value = serde_json::from_slice(
            &adapter.read(&object.path).await.unwrap().unwrap(),
        )
        .unwrap();
        assert_eq!(
            snapshot["root_epoch"].as_u64(),
            Some(2),
            "rotation must not publish a current snapshot under the retiring root"
        );
    }

    // An already-running revoked replica has only the old root and
    // rejects the new-epoch manifest before it can read new data.
    assert!(matches!(engine_b.sync_once().await, Err(Error::Corrupt)));

    // A fresh process cannot use the old passphrase against the new
    // authenticated keyring.
    let rejected_store = Arc::new(InMemoryStore::new());
    let rejected = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        rejected_store as Arc<dyn LocalRecordStore>,
        "dev-B",
    );
    assert!(matches!(
        rejected.join_repo("old-pass").await,
        Err(Error::AuthenticationFailed)
    ));

    // A retained/new device with the replacement passphrase receives
    // both live state and the deletion tombstone from the re-encrypted
    // snapshot.
    let store_c = Arc::new(InMemoryStore::new());
    let engine_c = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_c.clone() as Arc<dyn LocalRecordStore>,
        "dev-C",
    );
    engine_c.join_repo("new-pass").await.unwrap();
    assert_eq!(
        store_c.find("live").unwrap().unwrap().plaintext,
        b"alpha".to_vec()
    );
    assert!(store_c.find("dead").unwrap().unwrap().deleted);

    store_a.put_local("after", "snippet", b"new epoch".to_vec());
    engine_a.sync_once().await.unwrap();
    engine_c.sync_once().await.unwrap();
    assert_eq!(
        store_c.find("after").unwrap().unwrap().plaintext,
        b"new epoch".to_vec()
    );
}

#[tokio::test]
async fn authenticated_keyring_and_event_reject_splice_and_forged_delete() {
    let dir = tempdir().unwrap();
    let store_a = Arc::new(InMemoryStore::new());
    store_a.put_local("keep", "host", b"must survive".to_vec());
    let engine_a = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_a.clone() as Arc<dyn LocalRecordStore>,
        "dev-A",
    );
    engine_a
        .create_repo("old-pass", "vault-1", fast_params())
        .await
        .unwrap();

    let store_b = Arc::new(InMemoryStore::new());
    let engine_b = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_b as Arc<dyn LocalRecordStore>,
        "dev-B",
    );
    engine_b.join_repo("old-pass").await.unwrap();

    let adapter = LocalAdapter::new(dir.path());
    let before = Manifest::from_json(
        &adapter
            .read(RepoPaths::manifest())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let legacy_keyring =
        Keyring::from_json(&adapter.read(&before.keyring_path).await.unwrap().unwrap()).unwrap();
    let old_b_entry = legacy_keyring.entry("dev-B").unwrap().clone();
    let old_root =
        keyring::unwrap_root_key_for_epoch(&old_b_entry, "old-pass", 1).unwrap();

    engine_a
        .revoke_device_and_rotate("dev-B", "new-pass", fast_params())
        .await
        .unwrap();

    let store_c = Arc::new(InMemoryStore::new());
    let engine_c = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_c.clone() as Arc<dyn LocalRecordStore>,
        "dev-C",
    );
    engine_c.join_repo("new-pass").await.unwrap();

    // A revoked device can still upload bytes to a compromised/shared
    // backend. Its correctly MACed old-epoch delete must be ignored.
    let mut old_delete = event::new_delete(
        "old-delete",
        "dev-B",
        9_999,
        1,
        "vault-1",
        "keep",
        "host",
        "old-rev",
        None,
    );
    old_delete.root_epoch = 1;
    let old_event_key = crypto::derive_event_mac_key(&old_root);
    old_delete.sign(old_event_key.as_ref()).unwrap();
    adapter
        .write_new(
            &RepoPaths::event_filename_ztlog(1, 9_999, "dev-B", "old-delete"),
            &old_delete.to_bytes().unwrap(),
        )
        .await
        .unwrap();
    engine_c.sync_once().await.unwrap();
    assert!(!store_c.find("keep").unwrap().unwrap().deleted);

    // An unauthenticated delete that lies about being in the current
    // epoch is also rejected.
    let manifest =
        Manifest::from_json(&adapter.read(RepoPaths::manifest()).await.unwrap().unwrap()).unwrap();
    let mut forged = event::new_delete(
        "forged-delete",
        "attacker",
        10_000,
        2,
        "vault-1",
        "keep",
        "host",
        "forged-rev",
        None,
    );
    forged.root_epoch = manifest.root_epoch;
    adapter
        .write_new(
            &RepoPaths::event_filename_ztlog(2, 10_000, "attacker", "forged-delete"),
            &forged.to_bytes().unwrap(),
        )
        .await
        .unwrap();
    engine_c.sync_once().await.unwrap();
    assert!(!store_c.find("keep").unwrap().unwrap().deleted);

    // Splicing the revoked entry into the current keyring without the
    // new root invalidates its collection MAC.
    let original_bytes = adapter
        .read(&manifest.keyring_path)
        .await
        .unwrap()
        .unwrap();
    let mut tampered = Keyring::from_json(&original_bytes).unwrap();
    tampered.entries.push(old_b_entry);
    adapter
        .write_atomic(&manifest.keyring_path, &tampered.to_json().unwrap())
        .await
        .unwrap();

    let store_d = Arc::new(InMemoryStore::new());
    let engine_d = SyncEngine::new(
        LocalAdapter::new(dir.path()),
        store_d as Arc<dyn LocalRecordStore>,
        "dev-D",
    );
    assert!(matches!(
        engine_d.join_repo("new-pass").await,
        Err(Error::Corrupt)
    ));
}
