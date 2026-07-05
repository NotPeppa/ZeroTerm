# ZeroTerm Desktop

Tauri 2 desktop app for ZeroTerm. Built on top of [`core/`](../core/) — the
Rust workspace this depends on via path. The frontend is intentionally
plain HTML/JS so the backend wiring can be validated without a JS build
pipeline; React/Vue can be swapped in later without changing any
`#[tauri::command]` signatures.

## Status

W3 step 2 — first cut. What works:

- Vault unlock / first-run create
- **Auto-unlock from OS keychain** when "Remember password" was checked previously
- **Host CRUD** — add / edit / delete hosts via modal form (key picked from disk via the file dialog)
- **Per-host port forwards & ProxyJump editor** in the same modal — persisted, auto-applied on connect
- Click → connect → interactive PTY-backed shell (xterm.js)
- **Files button → SFTP browser** (list, navigate, upload, download, rename, delete, mkdir)
- Resize forwarding
- Async host-key prompt with accept/reject overlay
- Lock vault button (forgets the cached password too — full re-auth required next launch)

Known gaps (deliberate):

- No tabs / splits / multiple windows
- No drag-and-drop upload, no recursive operations, no bulk select
- No SSH agent
- No app icon polish (placeholder required for `tauri build`)

## Prerequisites

1. **Rust + tauri-cli**
   ```powershell
   cargo install tauri-cli --version "^2"
   ```
2. **Tauri OS prerequisites**
   - Windows: WebView2 runtime (preinstalled on Win10 21H2+ and Win11)
   - macOS: Xcode command-line tools
   - Linux: see [Tauri prereqs](https://tauri.app/start/prerequisites/)
3. **Icons** (only required for `tauri build`, not `tauri dev`)
   ```powershell
   # generate the full icon set from any source PNG/SVG (>= 512x512 recommended)
   cd desktop/src-tauri
   cargo tauri icon path\to\source-icon.png
   ```
   For dev/run, drop any PNG named `icon.png` into `desktop/src-tauri/icons/`
   to satisfy the bundler's reference; quality doesn't matter.

## Run in dev

```powershell
cd desktop\src-tauri
cargo tauri dev
```

This compiles `core/` plus the desktop crate, opens a window, and serves
the frontend straight from `desktop/frontend/`. Edits to `frontend/*`
take effect on window reload (`Ctrl+R` inside the dev window). Edits to
Rust trigger a recompile via `tauri dev`'s watcher.

The vault path is the same one the CLI uses
(`%APPDATA%\ZeroTerm\zeroterm.vault` on Windows), so a vault you populated
with `zeroterm add ...` shows up immediately.

## Build a redistributable bundle

```powershell
cd desktop\src-tauri
cargo tauri build
```

Outputs an `.msi` / `.app` / `.deb` (depending on host OS) under
`desktop/src-tauri/target/release/bundle/`.

## Architecture

```
Frontend (HTML/JS, no bundler)
   │
   │  invoke('command', ...)             listen('event', ...)
   ▼                                            ▲
Tauri IPC                                       │
   │                                            │
   ▼                                            │
src-tauri/src/commands.rs    src-tauri/src/session.rs
   │                              │
   │                              │ tokio::select! over channel.recv()
   │                              │   and the per-session control mpsc
   ▼                              ▼
zeroterm-app  ──►  zeroterm-vault  ──►  zeroterm-store
                                   ▲
zeroterm-app  ──►  zeroterm-ssh ───┘
```

### Boot flow

1. Frontend calls `vault_status`.
2. If `unlocked`, jump straight to the hosts view.
3. If the vault `exists`, frontend calls `try_keychain_unlock` — on
   `true`, jump to hosts (no dialog). On `false`, show the unlock form.
4. Otherwise show the create form (with password + confirm fields).

The unlock form has a **"Remember password"** checkbox; when ticked,
`unlock_vault` / `create_vault` save the password to the OS keychain
(the same store the CLI's `--remember` uses, keyed by vault path). The
**Lock** button in the hosts view clears both the in-memory vault and
the keychain entry — that's the way to require a fresh password prompt
on the next launch. To stay auto-unlocked across launches, just close
the window without clicking Lock.

### Frontend ↔ Backend protocol

Commands (frontend → backend):

| Command | Args | Returns |
|---|---|---|
| `vault_status` | — | `{ path, exists, unlocked }` |
| `unlock_vault` | `{ password, remember }` | — |
| `create_vault` | `{ password, remember }` | — |
| `lock_vault`   | — | — |
| `try_keychain_unlock` | — | `boolean` (true = unlocked from cache) |
| `forget_keychain` | — | — |
| `list_hosts`   | — | `HostSummary[]` |
| `save_host`    | `{ input: HostInput }` | new `id` |
| `update_host`  | `{ id, input: HostInput }` | — (preserves saved forwards / ProxyJump) |
| `delete_host`  | `{ id }` | — |
| `get_host`     | `{ id }` | `HostFull` (password is sent back; key bytes never are) |
| `read_local_text_file` | `{ path }` | file contents — used by the host modal to load a key the user just picked |
| `connect_host` | `{ hostId, cols?, rows? }` | `sessionId: number` |
| `send_input`   | `{ sessionId, data: number[] }` | — |
| `resize_session` | `{ sessionId, cols, rows }` | — |
| `disconnect_session` | `{ sessionId }` | — |
| `session_info` | `{ sessionId }` | `{ forwards: string[], jump?: string }` — what's currently set up for this session |
| `respond_host_key` | `{ requestId, accept }` | — |
| `sftp_open` | `{ hostId }` | `sftpId: number` (separate SSH connection from shell) |
| `sftp_close` | `{ sftpId }` | — |
| `sftp_list` | `{ sftpId, path }` | `DirEntryDto[] = { name, kind: "file"\|"dir"\|"symlink"\|"other", size }` |
| `sftp_download` | `{ sftpId, remote, local }` | bytes written. Streams in 32 KiB chunks; progress flows back via `sftp:progress` events |
| `sftp_upload` | `{ sftpId, local, remote }` | bytes uploaded. Same streaming + progress shape |
| `sftp_remove` | `{ sftpId, path }` | — (file only) |
| `sftp_remove_dir` | `{ sftpId, path }` | — |
| `sftp_rename` | `{ sftpId, from, to }` | — |
| `sftp_mkdir` | `{ sftpId, path }` | — |
| `sftp_cancel_transfer` | `{ transferId }` | — (no-op if the transfer already finished) |

Manual validation:

- Desktop SFTP reliability playbook: [`docs/manual-desktop-sftp-test.md`](../docs/manual-desktop-sftp-test.md)

Events (backend → frontend):

| Event | Payload |
|---|---|
| `session:data` | `{ sessionId, data: number[] }` (PTY bytes) |
| `session:closed` | `{ sessionId, exitCode?, message? }` |
| `host-key-prompt` | `{ requestId, kind: "unknown"\|"mismatch", host, port, keyType, fingerprint, stored? }` |
| `sftp:progress` | `{ transferId, kind: "download"\|"upload", source, destination, bytesDone, total?, finished }` (throttled to ~10/s; one final event with `finished=true`) |
| `sftp:transfer` | `{ transferId, kind, status: "queued"\|"running"\|"success"\|"error"\|"cancelled", source, destination, bytesDone, total?, bytesPerSec?, etaSeconds?, currentFile?, error?: { code, message } }` |

### Session task

Each connected session lives in its own `tokio::spawn`'d task that:

1. `select!`s between `ShellChannel::recv()` (remote → frontend) and an
   mpsc receiver of `SessionCommand` (frontend → remote).
2. Emits `session:data` for stream output.
3. On exit / close, emits `session:closed` and removes itself from the
   `AppState::sessions` map.

Locks held by commands are short and never crossed with `await`. The
session task itself owns its `ShellChannel` and never touches the state
mutexes once it's spawned.

### Host-key prompt

The async trait `HostKeyPrompt` is implemented over Tauri events:

1. SSH layer calls `on_unknown` / `on_mismatch` during the handshake.
2. Backend creates a `oneshot` and stashes the sender in
   `AppState::pending_host_key` keyed by a fresh request id.
3. Backend emits `host-key-prompt`; the SSH handshake is parked on the
   `oneshot` receiver.
4. Frontend shows a dialog, calls `respond_host_key { requestId, accept }`.
5. The command pulls the sender out of the map and resolves; the
   handshake either continues or is rejected.

If the frontend never responds (window closed, etc.), the receiver drops
and the prompt resolves to "reject" — never to silent acceptance.

## Swapping the frontend

Nothing in `commands.rs` or events depends on the vanilla setup. To
move to React/Vite:

1. `npm create vite@latest` inside `desktop/`.
2. Update `tauri.conf.json`:
   - `build.frontendDist` → `"../dist"` (or wherever Vite outputs)
   - Add `build.devUrl` → `"http://localhost:5173"` (Vite default — this is a
     real URL and the schema only accepts URLs here, which is why our
     vanilla setup omits the field entirely).
   - Add `build.beforeDevCommand` / `beforeBuildCommand` to run npm scripts.
3. Set `app.withGlobalTauri` to `false` and import from
   `@tauri-apps/api/core` and `@tauri-apps/api/event` instead.

The IPC contract above stays identical.
