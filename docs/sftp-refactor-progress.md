# SFTP Refactor Progress

Last updated: 2026-07-07

This file tracks implementation progress for the SFTP subsystem refactor.
It is separate from `docs/manual-desktop-sftp-test.md`, which is a manual
verification checklist rather than a delivery/progress record.

## Overall Status

Core architecture work is largely implemented.

Rough completion estimate:
- Core and backend architecture: mostly done
- Frontend migration for the new transfer model: mostly done
- Manual end-to-end validation on real servers: still pending
- Cleanup and extra test coverage: partially done
- Additional structured-error/retry edge tests: added

Practical status:
- The refactor is beyond prototype stage and compiles/tests cleanly.
- The main outstanding risk is real-environment validation rather than missing
  architectural pieces.

## Phase Status

### Phase 1: Core layer

Status: Done

Implemented:
- Added structured SFTP error typing in
  `core/crates/zeroterm-ssh/src/error.rs`
- Replaced the old collapsed `SshError::Sftp(String)` shape with structured
  `SshError::Sftp { kind, message }`
- Added `SftpErrorKind` classification for:
  - `NotFound`
  - `PermissionDenied`
  - `AlreadyExists`
  - `NotADirectory`
  - `Unsupported`
  - `ChannelClosed`
  - `Timeout`
  - `Other`
- Updated SFTP error mapping in
  `core/crates/zeroterm-ssh/src/sftp.rs`
- Changed `Session::sftp` from `&mut self` to `&self` in
  `core/crates/zeroterm-ssh/src/session.rs`
- Kept core streaming primitives intact:
  - `download_to_writer_parallel`
  - `upload_from_reader`

Verified:
- `cargo test -p zeroterm-ssh` passes

### Phase 2: Tauri layer modularization + connection pool

Status: Mostly done

Implemented:
- Split SFTP backend code into `desktop/src-tauri/src/sftp/`
- Added:
  - `mod.rs`
  - `pool.rs`
  - `path.rs`
  - `tree.rs`
  - `transfer.rs`
  - `file.rs`
- Added `SftpPool` with per-host pooled SSH session + multiplexed SFTP channels
- Replaced per-transfer fresh full SSH connection behavior with pooled channel
  acquisition for transfer workers
- Updated Tauri invoke registration so SFTP commands are now registered from the
  `sftp` module instead of living directly in `commands.rs`
- Preserved panel-handle semantics in app state while moving actual channel
  lifecycle management under the pool

Current shape:
- `commands.rs` is no longer the primary home of the SFTP subsystem
- Most SFTP-specific behavior now lives under `desktop/src-tauri/src/sftp/`

Still not fully finished:
- `commands.rs` still contains a few shared DTO/helper pieces that are reused by
  SFTP and non-SFTP code
- `build_connect_chain_for_host` still lives in `commands.rs` because it is
  effectively shared SSH connection setup logic

### Phase 3: Transfer manager + unified tree traversal + reconnect

Status: Mostly done

Implemented:
- Added `TransferManager` in `sftp/transfer.rs`
- Added bounded transfer queue via semaphore
- Added independent transfer cancellation by transfer id
- Added `sftp:transfer` event payload with status and structured error
- Removed the legacy `sftp:progress` event (2026-07-07): `sftp:transfer` now
  carries all progress fields and is the only transfer event
- Moved throttling / ETA / idle watchdog behavior into the new transfer layer
- Unified tree-copy logic under `sftp/tree.rs`
- Implemented atomic upload via temp remote file + rename
- Added overwrite checks for upload paths
- Added per-file retry on retryable disconnects/channel loss
- Added skip-and-summary handling for non-fatal item failures during tree copy
- Added pooled worker fan-out for directory upload / copy
- Added resilient panel command retry path through `with_resilient_panel_sftp`

Implemented across transfer paths:
- local -> remote
- remote -> local
- remote -> remote
- local -> local

Residual gaps:
- More high-level automated tests would still help for queue behavior and live
  pooled reconnect behavior
- Real-server fault injection validation is still pending

### Phase 4: Frontend transfer list + structured errors + navigation guard

Status: Mostly done

Implemented in `desktop/frontend/main.js`:
- Transfer dock evolved from one-item view to multi-item transfer list behavior
- Frontend listens to `sftp:transfer`
- Independent cancel action per transfer
- Retry button for failed transfers
- Structured error handling instead of brittle string-only logic
- Drag/drop large file staging via local temp path preparation instead of full
  in-memory JSON byte-array transfer as the main path
- Navigation request guard via `navToken`

Implemented in backend support:
- `prepare_staging_upload_path`
- `sftp_upload_bytes`
- structured transfer error payload flow

Residual gaps:
- No browser-style frontend test suite was added for the new SFTP UI
- Validation so far is compile/static-check level plus targeted reasoning, not a
  full interactive manual pass over all listed scenarios

### Phase 5: Non-invasive CWD follow

Status: Mostly done

Implemented:
- Replaced old intrusive follow-helper approach with OSC 7 consumption
- Frontend now registers an OSC 7 handler from terminal output stream
- Old polling/helper flow was removed from the active design
- Added user-facing follow hint text explaining OSC 7 dependence

Behavioral intent:
- If shell emits OSC 7, SFTP pane follows
- If shell does not emit OSC 7, pane simply stays where the user left it

Residual gap:
- Real-shell validation across multiple shell/distribution combinations is still
  pending

## Important Files

### Core

- `core/crates/zeroterm-ssh/src/error.rs`
- `core/crates/zeroterm-ssh/src/session.rs`
- `core/crates/zeroterm-ssh/src/sftp.rs`

### Tauri backend

- `desktop/src-tauri/src/sftp/mod.rs`
- `desktop/src-tauri/src/sftp/pool.rs`
- `desktop/src-tauri/src/sftp/path.rs`
- `desktop/src-tauri/src/sftp/tree.rs`
- `desktop/src-tauri/src/sftp/transfer.rs`
- `desktop/src-tauri/src/sftp/file.rs`
- `desktop/src-tauri/src/state.rs`
- `desktop/src-tauri/src/lib.rs`

### Frontend

- `desktop/frontend/main.js`
- `desktop/frontend/styles.css`
- `desktop/frontend/index.html`

### Docs

- `docs/manual-desktop-sftp-test.md`
- `docs/sftp-refactor-progress.md`

## Verification Status

### Automated checks currently passing

- Core:
  - `cd core && cargo test -p zeroterm-ssh`
- Desktop backend:
  - `cd desktop/src-tauri && cargo build`
  - `cd desktop/src-tauri && cargo test`
- Frontend static validation:
  - `node --check desktop/frontend/main.js`

Current desktop unit-test count:
- 21 tests passing

Current `zeroterm-ssh` unit-test count:
- 6 tests passing

Recent added coverage:
- Transfer structured error preservation and plaintext fallback classification
- SFTP pool retryable open-error classification for structured and plaintext
  disconnect/timeout cases
- Tree-copy contextual error wrapping while preserving structured error codes
- Remote path containment/join edge cases, including prefix-sibling protection
- Tree skipped-item summary preview limiting and worker-error precedence
- Core SFTP status/message mapping into `SftpErrorKind`

### Manual verification

Status: Not fully executed end-to-end yet

Available checklist:
- `docs/manual-desktop-sftp-test.md`

Planned manual coverage includes:
- panel open/list/navigation
- single-file upload/download
- queued transfers
- independent cancel/retry
- large drag/drop upload
- partial-failure directory transfer
- reconnect scenarios
- OSC 7 follow behavior

## What Is Still Not Done

These are the main remaining items:

- Run the full manual checklist in `docs/manual-desktop-sftp-test.md` against
  real SSH/SFTP servers
- Validate reconnect behavior by forcing actual server-side disconnects
- Validate OSC 7 follow against real shells that emit and do not emit OSC 7
- Add more automated tests around:
  - connection pool lifecycle
  - transfer queue semantics
  - live reconnect/retry edge cases that require simulated or real SFTP sessions
  - panel command recovery paths
- Optional cleanup:
  - `editor.rs` now owns text-edit limits, remote text DTO, and editor decoding
  - `file_dto.rs` now owns shared file-list/permission DTOs and kind mapping
  - SFTP upload staging command and tree transfer concurrency constants now live
    under the SFTP modules
  - `connect.rs` now owns shared SSH connection-chain setup and session connect
    helpers used by terminal sessions, SFTP, and forwarding
  - add more backend module-level docs/comments for maintainability

## Hardening Pass (2026-07-07)

Follow-up fixes applied after a code review of the refactored subsystem:

- `SftpPool::refresh_channel` no longer tears down the shared host session
  up front; it reuses the live session and only reconnects when the SFTP
  open itself fails with a retryable error. SFTP subsystem opens are now
  bounded by a 30s timeout so half-open TCP connections fail over quickly.
- Recursive remote delete rejects non-absolute paths instead of silently
  rewriting them to root-level paths, and retries once on a refreshed
  channel after a retryable disconnect (tolerating "already fully deleted").
- `sftp_upload` / `sftp_upload_bytes` accept an optional `overwrite` flag
  that reuses the atomic temp+rename(+backup) replace path; the frontend
  upload flows (picker, drag/drop, in-pane copy) now prompt to overwrite on
  `ALREADY_EXISTS` instead of failing outright.
- `sftp_upload_bytes` enforces the 8 MiB editor hard cap; larger payloads
  must use the staged-file upload path.
- The legacy `sftp:progress` emission was removed backend and frontend;
  `sftp:transfer` is the single event stream.

## Hardening Pass 2 (2026-07-07, after live testing)

Live directory-upload testing surfaced three coupled failures: no overwrite
prompt for same-name folders, a mid-file stall, and "sftp channel limit
reached" right after cancelling the stalled transfer.

- Root cause of the stall: russh-sftp pipelines WRITE requests outside its
  timed request path (acks drain lazily, no `request_timeout` applies), so
  one lost ack hung the upload forever. Uploads now fail with a retryable
  `TIMEOUT` after 90s without any write acknowledgement
  (`WRITE_STALL_TIMEOUT` in `core/crates/zeroterm-ssh/src/sftp.rs`); the
  per-file retry then takes a fresh channel. READs already go through the
  timed request path.
- Cancellation now interrupts in-flight reads/writes via `tokio::select!`
  instead of only being checked between chunks — a cancelled transfer
  unwinds immediately and releases its pooled channels instead of pinning
  them until the 180s watchdog.
- Channel quota: raised `MAX_SFTP_CHANNELS_PER_HOST` 4 → 6 (a tree copy
  holds up to five, one slot stays free for ad-hoc operations). Quota
  exhaustion is now the structured `CHANNEL_LIMIT` code; single-entry pane
  copies fall back to sharing the panel channel instead of failing, and the
  same-host remote-copy worker builder falls back to the primary channels
  instead of hard-erroring.
- Directory copies now check the destination root before transferring
  (all four directions): a same-name folder yields `ALREADY_EXISTS` up
  front, which drives the existing frontend overwrite prompt, instead of
  silently merging and reporting skipped files afterwards.

## Summary

What is done:
- The core refactor goal has been implemented.
- The old brittle SFTP architecture has been replaced by a pooled,
  task-managed, structured-error-based design.
- The frontend has been updated to work with the new transfer model.

What remains:
- The main unfinished work is validation depth, not core architecture.
- The biggest remaining confidence gap is manual real-environment testing.
