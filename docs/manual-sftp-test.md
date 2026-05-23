# Manual SFTP sync test playbook (M6)

Until an embedded `russh` server fixture is in place, the SFTP backend
is verified by hand against a real SSH server. The path-math layer is
covered in `crates/zeroterm-sync/src/adapter/sftp.rs::tests` and the
record-level engine is covered against the local-folder adapter, so
this playbook only needs to confirm that `SftpAdapter` calls the wire
protocol correctly.

## Prerequisites

- Two ZeroTerm desktop builds on separate machines (or two vault dirs
  + two `pnpm tauri dev` sessions on the same machine).
- An SSH host reachable from both clients with a writable scratch dir
  (e.g. `/home/<user>/zeroterm-sync-test/`).
- The host's credentials saved as a regular host record in each
  vault — the SFTP sync profile references this record via `host_ref`,
  so the host must already exist before the sync profile.

## Test 1 — create + join

1. Device A: in Settings → Sync, pick `SFTP` as the backend, select the
   saved host, set remote dir to the scratch path. Set a passphrase.
   Click **Create repo**.
2. Verify on the server: `.zeroterm-sync/{manifest.json,keyring.json}`
   exist under the scratch dir.
3. Device A: add one host record locally.
4. Click **Sync now**. Confirm `events/YYYY-MM/ev-*.json` appears on
   the server.
5. Device B: configure the same SFTP profile (same host, same remote
   dir, same passphrase), click **Join repo**.
6. Click **Sync now**. The host added on A appears on B.

## Test 2 — record-level conflict

1. With both devices joined, edit the same host on A and on B without
   syncing in between.
2. Sync A first, then sync B.
3. B's conflict inbox shows the divergence; resolving picks one side.
4. Sync both devices and confirm convergence.

## Test 3 — compact + retention

1. Generate ~10 events (insert/update/delete hosts on either device).
2. Sync both ways so the events log has multiple files.
3. On A click **Compact now**. The snapshot appears under
   `snapshots/` on the server.
4. With default retention, fresh events stay in `events/`; the report
   line includes `kept N recent events`. Older entries (rare in this
   flow) move to `trash/<ts>/`.
5. Confirm B can still **Sync now** without errors — applied-events
   bookkeeping survives compact.

## Cleanup

Delete `.zeroterm-sync/` on the server and the sync profile on both
clients.

## Known limitation

- `SftpAdapter::try_lock` is a no-op (no native SFTP lock primitive).
  Concurrent compact runs from two devices converge through
  manifest.json's last-writer-wins semantics; this is acceptable per
  RFC-002 §15 but means simultaneous compacts can both write a
  snapshot. Triggering this requires deliberately synchronized clicks
  — not a normal operating mode.
