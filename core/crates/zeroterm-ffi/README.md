# zeroterm-ffi

uniffi-generated FFI bindings for ZeroTerm core. Targets Swift (macOS,
iOS) and Kotlin (Android, JVM).

## Status

**Both batches done.** What's exposed:

### Vault + hosts (sync)
- `ZeroTerm` Object: `new`, `setVaultPath`, `lock`
- Vault lifecycle: `vaultStatus`, `unlock(password, remember)`,
  `create(password, remember)`, `tryKeychainUnlock` (returns Bool),
  `forgetKeychain`
- Host CRUD: `listHosts`, `saveHost`, `deleteHost`

### Session (async)
- `connectHost(hostId, cols, rows, listener, hostKeyPrompt)` — opens PTY shell
- `sendInput(sessionId, data)`
- `resizeSession(sessionId, cols, rows)`
- `disconnectSession(sessionId)`
- `respondHostKey(requestId, accept)`

### Foreign callbacks (`with_foreign`)
- `SessionListener` — `onData(bytes)`, `onClosed(exitCode?, message?)`
- `HostKeyPromptCallback` — `onPrompt(requestId, info, stored?)`

### Records / enums
- `VaultStatus`, `HostSummary`, `HostInput`, `HostKeyInfo`
- `AuthKind` (`password` / `privateKey`)
- `HostAuthInput.Password { value }` / `HostAuthInput.PrivateKey { keyPem, passphrase? }`

### Error
`FfiError` with `vaultLocked` / `authenticationFailed` /
`notInitialized` / `alreadyExists` / `notFound { message }` /
`other { message }`.

## Building

The FFI lib compiles like any other workspace crate:

```powershell
cd core
cargo build -p zeroterm-ffi --release
cargo test  -p zeroterm-ffi
```

Rust-side tests do real Argon2id derivations; expect 2-5 s per test in
debug builds. `cargo test --release -p zeroterm-ffi` runs them in a
fraction of a second.

## Generating Swift / Kotlin bindings

```powershell
cd core

# Swift
cargo run --bin uniffi-bindgen -- generate `
    --library target/release/zeroterm_ffi.dll `
    --language swift `
    --out-dir crates/zeroterm-ffi/bindings/swift

# Kotlin
cargo run --bin uniffi-bindgen -- generate `
    --library target/release/zeroterm_ffi.dll `
    --language kotlin `
    --out-dir crates/zeroterm-ffi/bindings/kotlin
```

(On macOS / Linux, swap `.dll` for `.dylib` / `.so`.)

The "swiftformat / ktlint not found" warnings are just post-format
prettifiers; the binding files generate fine without them.

## End-to-end usage from Swift

```swift
import ZeroTerm

// 1. Implement the two callback protocols
class MyListener: SessionListener {
    let onData: (Data) -> Void
    let onClose: (UInt32?, String?) -> Void
    init(onData: @escaping (Data) -> Void, onClose: @escaping (UInt32?, String?) -> Void) {
        self.onData = onData
        self.onClose = onClose
    }
    func onData(data: Data) { onData(data) }
    func onClosed(exitCode: UInt32?, message: String?) { onClose(exitCode, message) }
}

class MyHostKeyPrompt: HostKeyPromptCallback {
    weak var zt: ZeroTerm?
    func onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
        // show a SwiftUI alert; on Accept:
        try? zt?.respondHostKey(requestId: requestId, accept: true)
        // on Reject:
        try? zt?.respondHostKey(requestId: requestId, accept: false)
    }
}

// 2. Use it
let zt = ZeroTerm()

// First try the keychain — on cold start this lets you skip the prompt
// entirely if "Remember password" was set last time.
if try !zt.tryKeychainUnlock() {
    // Show your unlock UI, get pw + a "remember" toggle, then:
    try zt.unlock(password: pw, remember: rememberToggle)
}

let hosts = try zt.listHosts()
let host = hosts[0]

let listener = MyListener(
    onData: { bytes in terminal.write(bytes) },
    onClose: { code, msg in terminal.write("\n[disconnected]\n".data(using: .utf8)!) }
)
let prompt = MyHostKeyPrompt()
prompt.zt = zt

let sessionId = try await zt.connectHost(
    hostId: host.id,
    cols: 80, rows: 24,
    listener: listener,
    hostKeyPrompt: prompt
)

// keystrokes:
try await zt.sendInput(sessionId: sessionId, data: "ls\n".data(using: .utf8)!)

// terminal resize:
try await zt.resizeSession(sessionId: sessionId, cols: 100, rows: 30)

// done:
try await zt.disconnectSession(sessionId: sessionId)
```

## End-to-end usage from Kotlin

```kotlin
import com.zeroterm.ffi.*

class MyListener(
    val onData: (ByteArray) -> Unit,
    val onClose: (UInt?, String?) -> Unit,
) : SessionListener {
    override fun onData(data: ByteArray) = onData.invoke(data)
    override fun onClosed(exitCode: UInt?, message: String?) = onClose.invoke(exitCode, message)
}

class MyHostKeyPrompt(val zt: ZeroTerm) : HostKeyPromptCallback {
    override fun onPrompt(requestId: String, info: HostKeyInfo, stored: String?) {
        // Show dialog; on Accept:
        zt.respondHostKey(requestId, accept = true)
    }
}

val zt = ZeroTerm()
if (!zt.tryKeychainUnlock()) {
    // Show unlock UI, then:
    zt.unlock("...", remember = rememberToggle)
}
val hosts = zt.listHosts()
val host = hosts.first()

val sessionId = zt.connectHost(
    hostId = host.id,
    cols = 80u, rows = 24u,
    listener = MyListener(
        onData = { bytes -> terminal.write(bytes) },
        onClose = { _, _ -> terminal.write("[disconnected]\n".toByteArray()) },
    ),
    hostKeyPrompt = MyHostKeyPrompt(zt),
)
zt.sendInput(sessionId, "ls\n".toByteArray())
```

## Architecture notes

### Why `respondHostKey` is a separate call (not async on the callback)

uniffi callbacks invoked from Rust are synchronous from the foreign
side's perspective. If the Rust handshake `await`-ed a foreign async
callback, every host-key prompt would block the SSH event loop while
the user reads the dialog. Worse, the dialog code runs on the UI
thread, where blocking is forbidden.

The split protocol — Rust emits a request id, foreign code shows a
dialog and returns immediately, Rust parks on a `oneshot`, the foreign
side calls `respondHostKey` when ready — keeps both sides ergonomic and
matches the Tauri implementation byte-for-byte.

### Why an indirection layer instead of exposing core types directly

The internal `AppError` has variants (`zeroterm_vault::VaultError`,
`zeroterm_store::StoreError`) that include third-party error types
(`russh::Error`, `rusqlite::Error`). Those aren't FFI-safe and dragging
them through `#[derive(uniffi::Error)]` would couple the Swift / Kotlin
surface to library version churn it doesn't care about.

`FfiError` collapses everything into the variants a host UI actually
switches on, funneling the rest into `other(message)`. That keeps the
FFI ABI stable across `russh` and `rusqlite` upgrades.

Same for records: `HostSummary` is a leaner shape than the internal
`Host` (no `auth` payload, just a kind enum) so a list call doesn't
expose stored credentials in clear text.

## Cross-compiling for mobile

### iOS / iOS simulator (xcframework)

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cd core
cargo build -p zeroterm-ffi --release --target aarch64-apple-ios
cargo build -p zeroterm-ffi --release --target aarch64-apple-ios-sim
xcodebuild -create-xcframework \
    -library target/aarch64-apple-ios/release/libzeroterm_ffi.a \
    -headers crates/zeroterm-ffi/bindings/swift \
    -library target/aarch64-apple-ios-sim/release/libzeroterm_ffi.a \
    -headers crates/zeroterm-ffi/bindings/swift \
    -output ZeroTerm.xcframework
```

### Android (per-ABI .so)

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
# requires the Android NDK; configure linkers in ~/.cargo/config.toml
cargo build -p zeroterm-ffi --release --target aarch64-linux-android
cargo build -p zeroterm-ffi --release --target armv7-linux-androideabi
cargo build -p zeroterm-ffi --release --target x86_64-linux-android
# drop the resulting .so files into app/src/main/jniLibs/<abi>/
```

Add `net.java.dev.jna:jna:5.13.0@aar` to gradle deps; uniffi's Kotlin
runtime uses JNA. Call `System.loadLibrary("zeroterm_ffi")` once at
startup before instantiating `ZeroTerm`.

## Layout

```
crates/zeroterm-ffi/
├── Cargo.toml
├── uniffi.toml             # Swift module name, Kotlin package name
└── src/
    ├── lib.rs              # setup_scaffolding! + tests
    ├── facade.rs           # ZeroTerm Object impl + session task
    ├── listener.rs         # SessionListener / HostKeyPromptCallback +
    │                       # ForeignHostKeyPrompt (HostKeyPrompt impl
    │                       # wrapping the foreign callback via oneshot)
    ├── error.rs            # FfiError + map_app_error
    ├── types.rs            # records / enums + conversions
    └── bin/
        └── uniffi-bindgen.rs   # binding generator entry point
```
