# Manual WebDAV sync test playbook (M7)

The WebDAV adapter (`crates/zeroterm-sync/src/adapter/webdav.rs`) is
gated behind the `webdav-backend` cargo feature; the desktop crate
opts in by default so end users get it out of the box. Like the SFTP
adapter, end-to-end coverage requires a real server, so this is a
manual playbook. Path/URL helpers and PROPFIND parsing are covered by
unit tests in the module.

## Prerequisites

- Two ZeroTerm desktop builds (separate machines or two vault dirs +
  two `pnpm tauri dev` sessions on one machine).
- Any HTTP Basic-auth WebDAV server you have an account on. Common
  options:
  - **Nextcloud / ownCloud**: URL pattern
    `https://example.com/remote.php/dav/files/<user>`, plain account
    password (use an app password if 2FA is on).
  - **Apache `mod_dav` / nginx `dav_module`**: pick any path you can
    write to, e.g. `https://files.example.com/zeroterm/`.
  - **FastMail Files** / **Box** / **HiDrive** also work, though some
    rate-limit aggressively.
- A throw-away "Repo subpath" string, e.g. `zeroterm-test`. The
  adapter creates `<root>/.zeroterm-sync/` underneath it.

## Test 1 — create + join

1. Device A: Settings → Sync. Pick `WebDAV` from the backend dropdown.
   Fill in:
   - WebDAV 服务地址: full base URL (no `.zeroterm-sync/` suffix).
   - 仓库子路径 (optional): e.g. `zeroterm-test`.
   - 用户名 / 密码: the account credentials.
   Set a sync passphrase. Click **Create repo**.
2. Verify on the server (via any other WebDAV client or the web UI):
   `<root>/.zeroterm-sync/manifest.json` and `keyring.json` now exist.
3. Add one host record on Device A. The 4 s debounce auto-syncs;
   confirm `events/YYYY-MM/ev-*.json` appears server-side.
4. Device B: configure the same WebDAV profile (same URL / subpath /
   username / password / passphrase), click **Join repo**.
5. Click **Sync now**. The host added on A appears on B.

## Test 2 — password rotation

1. Edit the WebDAV profile on Device A — change only the URL or
   subpath; **leave the password field empty**.
2. Save. Verify subsequent **Sync now** still works (empty password
   field means "leave keychain entry intact").
3. Type a wrong password and save. **Sync now** must fail with a HTTP
   401 surfaced as an error.
4. Type the correct password and save. **Sync now** works again.

## Test 3 — record conflict

Same as the SFTP playbook (`docs/manual-sftp-test.md`, §Test 2):
edit the same host on both devices, sync one then the other, resolve
the conflict from the inbox, sync both ways, confirm convergence.

## Test 4 — compact retention

Trigger compact on Device A after generating ~10 events. Confirm:
- A `snapshots/snapshot-*.bin` appears server-side.
- Events within 30 days stay under `events/`.
- The compact status line reports `kept N recent events`.

## Known limitations

- **No bearer-token auth** — only HTTP Basic. Switch to an app password
  if your provider supports them and disable cookie/session-based auth
  for the account.
- **No LOCK/UNLOCK** — `try_lock` returns `None`, just like SFTP.
  Concurrent compact from two devices converges via the manifest's
  last-writer-wins semantics. Acceptable per RFC-002 §15.
- **Strict server requirement: PROPFIND with `Depth: infinity`** must
  be enabled. Apache `mod_dav` and Nextcloud allow this by default;
  bare Lighttpd disables it. If `list` returns empty when files
  obviously exist, that's the cause.
- **No URL percent-encoding on outbound paths** — repo paths only use
  ASCII characters (`events/2024-03/ev-<clock>-<device>-<ulid>.json`),
  so percent-encoding doesn't matter in practice. If we ever introduce
  non-ASCII path components, add a `percent_encode_path` helper to
  `WebDavPaths::url_of`.

## Cleanup

Server-side: delete the `.zeroterm-sync/` collection (or its parent if
you used a throwaway subpath).
Client-side: delete the sync profile on both devices. The OS keychain
entries (`sync-encryption:<id>`, `sync-backend-credential:<id>`) are
also dropped — verify with Credential Manager / Keychain Access /
seahorse if you want to be thorough.
