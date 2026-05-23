# Manual S3 sync test playbook (M8)

The S3 adapter (`crates/zeroterm-sync/src/adapter/s3.rs`) is gated
behind the `s3-backend` cargo feature; the desktop crate opts in by
default. Path/key math and CopyObject URL encoding are covered by
unit tests; this playbook verifies the network paths against a real
bucket. Works against any S3-compatible service — AWS S3, Cloudflare
R2, Backblaze B2, MinIO, SeaweedFS.

## Prerequisites

- Two ZeroTerm desktop builds (separate machines or two vault dirs +
  two `pnpm tauri dev` sessions on one machine).
- A bucket you can write to + an access key / secret pair with
  `s3:PutObject`, `s3:GetObject`, `s3:HeadObject`, `s3:ListBucket`,
  `s3:DeleteObject`, and `s3:CopyObject` (or the equivalent IAM /
  R2 token / B2 application key permissions).
- For non-AWS services:
  - **MinIO**: set `Endpoint = http://host:9000`, enable Path-style.
  - **Cloudflare R2**: set `Endpoint = https://<account>.r2.cloudflarestorage.com`,
    Path-style on, Region `auto`.
  - **Backblaze B2**: set `Endpoint = https://s3.<region>.backblazeb2.com`,
    Path-style on.

## Test 1 — create + join

1. Device A: Settings → Sync. Pick `S3` from the backend dropdown.
   Fill in Region, Bucket, optional Prefix (e.g. `zeroterm-test`),
   optional Endpoint + Path-style for non-AWS, Access Key ID + Secret
   Access Key. Set a sync passphrase. Click **Create repo**.
2. Inspect the bucket (web console or `aws s3 ls`):
   `<prefix>/.zeroterm-sync/manifest.json` and `keyring.json` exist.
3. Add a host record on Device A. The 4 s debounce auto-syncs;
   confirm `events/YYYY-MM/ev-*.json` appears under
   `<prefix>/.zeroterm-sync/events/`.
4. Device B: configure the same S3 profile (same region / bucket /
   prefix / credentials / passphrase). Click **Join repo**.
5. Click **Sync now**. The host A added shows up on B.

## Test 2 — concurrent-create collision (If-None-Match)

S3 (and most compatible services as of 2025) supports
`If-None-Match: *` for conditional create. The adapter uses this to
turn `write_new` collisions into `Error::AlreadyExists`.

1. Generate a single event on Device A but don't sync yet.
2. With the bucket browser, manually upload a file at the exact
   event key the next sync would write — easiest is to GET the event
   from Device A's local events queue, then PUT it manually with a
   different body.
3. **Sync now** on Device A. The push should fail with an
   `AlreadyExists` error. On a server that *doesn't* support
   `If-None-Match`, the second write would silently overwrite — that
   degrades to last-writer-wins, which is acceptable for ULID-named
   event files.

## Test 3 — rotation of secret_access_key

1. Edit the S3 profile on Device A — change only the prefix; leave
   the Secret Access Key field empty.
2. Save. **Sync now** still works (empty secret = "leave keychain
   entry intact"), same convention as WebDAV.
3. Type a wrong secret + save. **Sync now** fails with a 403.
4. Type the correct secret + save. **Sync now** works again.

## Test 4 — compact retention

Same as the other backends:
1. Generate ~10 events, sync both ways.
2. Click **Compact now** on Device A. A snapshot lands under
   `<prefix>/.zeroterm-sync/snapshots/`.
3. With default retention, recent events stay under `events/`; the
   compact report includes `kept N recent events`.
4. Older events get moved under `<prefix>/.zeroterm-sync/trash/<ts>/`
   via CopyObject + DeleteObject. Trash entries older than 30 days
   get deleted on the next compact.

## Known limitations

- **CopyObject + DeleteObject for rename** — if the delete leg fails,
  the source object lingers as garbage. The next compact's trash
  prune (30 day default) cleans it up. No data loss; only space
  amplification.
- **No try_lock** — no first-class S3 lock primitive. The engine's
  compact converges via manifest last-writer-wins, same as the SFTP
  and WebDAV backends.
- **`If-None-Match` requires recent S3 / MinIO** — AWS S3 (Nov 2024+)
  supports it natively; older S3 emulators silently ignore the header
  and degrade `write_new` to last-writer-wins. Event filenames are
  ULID-prefixed so a genuine collision indicates a protocol-level
  bug, not a normal operating mode.
- **Per-request HTTP timeout default** — the SDK uses its own
  defaults; long-haul links to a high-latency region may need
  `endpoint` to point at a closer mirror.

## Cleanup

Server-side: `aws s3 rm s3://<bucket>/<prefix>/.zeroterm-sync/ --recursive`
(or use the web console). Don't delete the bucket itself unless you
provisioned it just for this test.
Client-side: delete the sync profile on both devices. The OS keychain
entries (`sync-encryption:<id>`, `sync-backend-credential:<id>`,
`sync-backend-extra:<id>`) are also dropped — verify with Credential
Manager / Keychain Access / seahorse if you want to be thorough.
