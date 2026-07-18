# ZeroTerm Android

Kotlin + Jetpack Compose (Material 3) client. Reuses `core/` via uniffi
Kotlin bindings + per-ABI `libzeroterm_ffi.so`. Design: [RFC-003](../RFC-003-android.md).

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
- [x] Sync profiles (WebDAV/SFTP/S3), create/join, sync now, conflicts
- [x] Foreground auto-sync (settings toggle + interval)
- [x] R8 keep rules (JNA/uniffi)
- [ ] CI smoke build (optional; release packaging is via tag → `release.yml`)
- [ ] Play internal testing / signed release (operator)
- [ ] Real-device exit criteria (vim/tmux/CJK/perf) — measure on device

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
OS keychain via core — not into the vault profile JSON.

## Notes

- FFI `unlock`/`create` always pass `remember=false`; password cache is
  Android-only (Keystore), per RFC-003 §6.2.
- Zero telemetry by default (RFC-003 M7).
- Do not paste Termux code (GPLv3).
