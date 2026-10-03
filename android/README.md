# ZeroTerm Android

Kotlin + Jetpack Compose (Material 3) client. Reuses `core/` via uniffi
Kotlin bindings + per-ABI `libzeroterm_ffi.so`. Design: [RFC-003](../RFC-003-android.md).
The Gradle build generates Kotlin bindings directly from the packaged library
using the host-side `zeroterm-bindgen` tool, keeping UniFFI checksums in sync.

## Status

### M0
- [x] Gradle scaffold (minSdk 26, targetSdk 36, Compose M3)
- [x] `cargo-ndk` integration (`build-rust.gradle.kts`)
- [x] Load `.so`, `setDataDir` / vault path
- [x] Unlock / create vault UI
- [x] Biometric + EncryptedSharedPreferences password cache
- [x] Hosts list after unlock

### M1 / M2
- [x] `zeroterm-term` (alacritty_terminal 0.24.2) + FFI `Terminal`
- [x] Connect host → PTY → feed VT → Compose Canvas paint
- [x] Host-key prompt dialog
- [x] Extra-keys row (Esc/Tab/Ctrl/arrows/…)
- [x] Soft IME via custom `InputConnection`
- [x] Session FGS while connected
- [x] Host add / edit / delete
- [x] Disconnect banner + one-tap reconnect
- [x] Scrollback (finger drag / Scr↑↓ / jump to bottom)
- [x] Selection (long-press + drag) + copy / paste
- [x] Settings (theme System/Dark/Light, font size)
- [x] Pinch-zoom terminal font (persisted)
- [x] Quick Connect (`connectDirect`)
- [x] SFTP browser (list/mkdir/rename/delete + SAF upload/download + cancel)
- [x] Snippets CRUD + insert into terminal
- [x] tmux drawer: list/create/attach/switch/detach/rename/end sessions over the active SSH connection (including Quick Connect)
- [x] Port forwarding in the left workspace drawer: synced local/remote/SOCKS5 rules, independent start/stop, host groups, and reconnects
- [x] Sync profiles (WebDAV/SFTP/S3), create/join, sync now, conflicts
- [x] Foreground auto-sync (settings toggle + interval)
- [x] R8 keep rules (JNA/uniffi)
- [ ] CI smoke build (optional; release packaging is via tag → `release.yml`)
- [ ] Play internal testing / signed release (operator)
- [ ] Real-device exit criteria (vim/tmux/CJK/perf) — measure on device

## tmux sessions

Open the terminal tools drawer and select **tmux**. The server must have tmux
installed. Create a detached session, then enter it from a shell prompt. For
sessions entered through this panel, switching and detaching target only this
APP client, including with a custom tmux prefix. Rename and end-session actions
use a separate SSH channel; ending a session requires confirmation. Manually
attached sessions should be detached before entering through the panel. The
panel manages the default tmux socket and refreshes when opened, after session
actions, or when the refresh button is tapped; it does not poll periodically.
Initial attach prepares a private, one-use launcher over the SSH exec channel,
so the terminal does not echo client bookkeeping commands when detaching. Normal
detach is quiet; attach errors remain visible. The launcher deletes itself.

## Port forwarding

Open the left workspace drawer and select **Port Forwarding**. Choose a saved
SSH host and create a local (-L), remote (-R), or SOCKS5 (-D) rule. Local and
SOCKS5 listeners run on the phone; remote listeners run on the SSH server and
connect back to a target the phone can reach. Rules use the same independent
Vault records as the desktop client and sync with it.

Forwards run independently of terminal sessions, remain active when leaving
the page, and reconnect after a dropped SSH connection. A foreground notification
keeps active tunnels and terminal sessions running together. Its **Disconnect all**
action stops both. Editing a running rule stops it before saving; start it again
to apply the new configuration. Deleting its rule/host or locking the Vault also
stops the tunnel. Restarting the app does not automatically start saved rules.

## Prerequisites

1. **JDK 17+**
2. **Android SDK** + **NDK r28+** (16KB page size). Default path:
   `%LOCALAPPDATA%\Android\Sdk`, NDK `28.2.13676358`
3. **Rust** with Android targets:
   ```bash
   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
   cargo install cargo-ndk
   ```
4. Env (optional if SDK is in the default location):
   ```bash
   set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
   set ANDROID_NDK_HOME=%ANDROID_HOME%\ndk\28.2.13676358
   ```

## Build

```powershell
cd android
.\gradlew.bat assembleDebug
```

`preBuild` runs `cargoNdkBuild` → cross-compiles `zeroterm-ffi` for
`arm64-v8a` + `x86_64` (debug) or all three ABIs (release), copies
`.so` into `app/src/main/jniLibs/`, and copies Kotlin bindings from
`core/crates/zeroterm-ffi/bindings/kotlin/`.

Override ABIs:

```powershell
.\gradlew.bat assembleDebug -Pzeroterm.abis=arm64-v8a
```

### Automatic release signing

Run `./gradlew assembleRelease` (`.\gradlew.bat assembleRelease` on Windows).
The first local release build creates a private, persistent signing key under
`~/.zeroterm/android-signing/com.zeroterm.android/identity/`; subsequent builds
reuse it. Back up the entire directory and restore it when changing computers.
Debug builds keep their separate debug signature. Set `-Pzeroterm.signingDir=...`
to use a different private directory.

For GitHub releases, run `python3 scripts/setup-android-signing.py` once from the
repository root, with JDK 17, Python 3 and an authenticated GitHub CLI available.
It generates/reuses the local key and stores its encrypted configuration in the
`ANDROID_SIGNING_BUNDLE` repository Secret. Existing repository signing secrets
are preserved. Subsequent tag builds restore that same key automatically, never
generate a different key on an ephemeral runner, and never publish key files.
Existing complete `ANDROID_KEYSTORE_*` / `ANDROID_KEY_*` environment variables
or the four legacy repository Secrets remain supported. Partial configurations
fail instead of silently choosing a new signing identity.

Older APKs signed with a debug certificate cannot be directly replaced by the
new release signature. Back up data before migrating from those builds.

## First run

1. Install APK on device/emulator
2. Create a vault with a master password (or copy a desktop
   `zeroterm.vault` into the app files dir and unlock)
3. Hosts from the vault appear in the list
4. Optional: enable “Remember with biometrics” for cold-start unlock

Vault path on device: `filesDir/zeroterm.vault`.

## Layout

```
android/
├── app/src/main/
│   ├── java/com/zeroterm/android/
│   │   ├── data/           # AppContainer, ZeroTermRepository, biometric
│   │   ├── service/        # SessionForegroundService (M2 wiring)
│   │   ├── ui/             # unlock, hosts, theme, nav
│   │   ├── MainActivity.kt
│   │   └── ZeroTermApp.kt  # System.loadLibrary("zeroterm_ffi")
│   ├── java/com/zeroterm/ffi/   # uniffi bindings (copied at build)
│   └── jniLibs/<abi>/libzeroterm_ffi.so
└── build-rust.gradle.kts
```

## Sync

Hosts menu → **Sync**:

1. Add WebDAV / SFTP / S3 profile (same encryption passphrase as desktop).
2. **Join existing** (or **Create new** on the first device).
3. **Sync now**, or enable **Auto-sync in foreground** under Settings.

Secrets (WebDAV password, S3 secret, encryption passphrase) go to the
vault's encrypted local state via core. They survive app restarts, are only
available while the vault is unlocked, and are excluded from sync events and
snapshots. They are not stored in the profile JSON. Older APKs only cached
these secrets in memory; re-enter them once when editing an existing profile.

## Notes

- FFI `unlock`/`create` always pass `remember=false`; password cache is
  Android-only (Keystore), per RFC-003 §6.2.
- Zero telemetry by default (RFC-003 M7).
- Do not paste Termux code (GPLv3).
