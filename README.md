# ZeroTerm

> 对标 Termius 量级的跨平台 SSH / SFTP 客户端 —— **Rust 核心 + 原生 UI**，无账号、端到端加密的多端同步。

ZeroTerm 是一款面向开发者和运维的严肃终端工具。SSH/SFTP 协议栈、加密 vault、同步引擎全部用 Rust 写一遍，桌面端用 Tauri 2 + xterm.js 承载，移动端通过 uniffi 复用同一套核心。

当前版本：**v0.1.11**（桌面端 macOS / Windows 已可用；Android 客户端 M0–M7 主路径可用：终端 / SFTP / 片段 / WebDAV·SFTP·S3 同步）。

---

## 核心特性

### 终端与连接
- **SSH 会话** —— 密码 / 私钥 / SSH Agent 认证，PTY 交互式 shell（xterm.js + WebGL）
- **本地终端** —— 内置 PTY，无需连远端也能开本地 shell
- **端口转发** —— 本地转发 `-L`、动态 SOCKS5 代理 `-D`
- **ProxyJump** —— 通过跳板机连接目标主机（单跳）
- **known_hosts 校验** —— 行为对齐 OpenSSH：可信静默、未知提示指纹、变更告警
- **Quick Connect** —— 临时 `user@host` 直连，不落 vault

### 文件传输
- **双栏 SFTP 浏览器** —— 列目录、上传、下载、重命名、删除、新建目录、改权限
- **面板间复制** —— 在两个 SFTP 面板 / 本地↔远端之间直接拷贝条目
- **流式传输** —— 分块传输 + 实时进度，可取消

### 凭据与安全
- **端到端加密 vault** —— Argon2id 派生主密钥，每条记录独立密钥，XChaCha20-Poly1305 加密
- **主密码 + 系统钥匙串解锁** —— macOS Keychain / Windows Credential Manager / Linux Secret Service
- **主机分组** —— 分组、标签管理大量主机

### 多端同步（无账号 / 无专用服务端）
- **端到端加密** —— 同步仓库只存密文，后端无法读取任何凭据
- **多后端** —— 本地文件夹 / SFTP / WebDAV / S3 兼容（R2 / MinIO / 群晖等）
- **记录级增量** —— 按记录同步变更，自动合并、冲突检测与解决、空间压缩
- 详见 [RFC-002](./RFC-002-sync-design.md)

### 效率与体验
- **命令片段（Snippets）** —— 分组管理、搜索、一键插入
- **AI 命令助手** —— 内置对话与流式输出，支持自定义 API / 模型（BYO key）
- **CLI 等待提醒** —— claude / codex 等 CLI 在后台标签等待确认或选择时，标签页出现琥珀色提示点（终端铃声 / 通知转义序列 / 提示文本识别三路信号）
- **主题与外观** —— 终端配色主题、系统字体选择、自定义背景图、透明 / 玻璃效果
- **自动更新** —— 内置 updater

---

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│  Rust Core (core/ workspace)                                 │
│  • zeroterm-ssh     russh 封装：连接/认证/PTY/SFTP/转发/Jump  │
│  • zeroterm-crypto  Argon2id · HKDF-SHA256 · XChaCha20-Poly1305│
│  • zeroterm-vault   端到端加密的凭据 / 配置存储               │
│  • zeroterm-store   SQLite，仅存不透明密文                    │
│  • zeroterm-app     vault 感知的主机编排 + 钥匙串缓存         │
│  • zeroterm-sync    E2E 同步引擎（local/sftp/webdav/s3 适配） │
│  • zeroterm-cli     交互式 SSH 命令行（zeroterm 可执行文件）  │
│  • zeroterm-ffi     uniffi 绑定（Swift / Kotlin）            │
└─────────────────────────────────────────────────────────────┘
        │ Tauri command (桌面)        │ uniffi (移动端)
        ▼                             ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ Desktop (desktop/)   │   │ iOS (SwiftUI) / Android (Compose) │
│ Tauri 2 + xterm.js   │   │ 复用 core，原生终端 UI（规划中）  │
│ 原生 HTML/JS 前端     │   │                                    │
└──────────────────────┘   └──────────────────────────────────┘
```

### 关键决策

1. **Rust 核心不写两遍** —— SSH 协议栈、加密、同步引擎是全部平台共享的，通过 `uniffi`（Swift/Kotlin）和 Tauri command（桌面）暴露。
2. **桌面用 Tauri 2 + xterm.js** —— WebView 在桌面没有移动端的 IME 坑；xterm.js + WebGL 是当前最强的终端渲染；包体小、性能好。前端刻意用原生 HTML/JS，IPC 契约不依赖任何 JS 框架，后续可平滑换 React/Vue。
3. **移动端坚决原生** —— 输入法、外接键盘、手势、后台保活、网络切换重连，只有原生 API 才能做透；终端组件用 SwiftTerm（iOS）/ 原生 widget（Android）。
4. **不做 Web** —— 浏览器无法直连 TCP，需中继服务，破坏端到端加密模型。

完整架构与 FFI 表面见 [RFC-001](./RFC-001-architecture.md)。

---

## 项目结构

```
ZeroTerm/
├── core/                      # Rust workspace（共享核心）
│   └── crates/
│       ├── zeroterm-ssh/      # SSH 协议层（russh 封装）
│       ├── zeroterm-crypto/   # 共享加密原语
│       ├── zeroterm-vault/    # 端到端加密存储
│       ├── zeroterm-store/    # SQLite 密文存储
│       ├── zeroterm-app/      # 主机编排 + 钥匙串缓存
│       ├── zeroterm-sync/     # E2E 同步客户端
│       ├── zeroterm-cli/      # 交互式 SSH CLI
│       └── zeroterm-ffi/      # uniffi 绑定（Swift/Kotlin）
├── desktop/                   # Tauri 2 桌面应用
│   ├── frontend/              # 原生 HTML/JS + xterm.js
│   └── src-tauri/             # Tauri 后端（commands / session / state）
├── android/                   # Kotlin + Compose Android 客户端（RFC-003）
├── docs/                      # 手动测试记录（SFTP / WebDAV / S3）
├── RFC-001-architecture.md    # 整体架构 RFC
├── RFC-002-sync-design.md     # 多端同步设计 RFC
└── RFC-003-android.md         # Android 设计 RFC
```

---

## 快速开始

### 桌面应用

**前置依赖**

- Rust 工具链（stable，建议 1.76+），通过 [rustup](https://rustup.rs/) 安装
- `tauri-cli` v2：`cargo install tauri-cli --version "^2"`
- Windows：WebView2 运行时（Win10 21H2+ / Win11 已预装）；macOS：Xcode 命令行工具；Linux：见 [Tauri 前置](https://tauri.app/start/prerequisites/)

**开发运行**

```powershell
cd desktop\src-tauri
cargo tauri dev
```

会编译 `core/` 与桌面 crate，打开窗口并从 `desktop/frontend/` 直出前端。改前端后窗口内 `Ctrl+R` 重载；改 Rust 由 watcher 自动重编。

**打包**

```powershell
cd desktop\src-tauri
cargo tauri build
```

  产物（`.msi` / `.app` / `.deb`，取决于宿主系统）位于 `desktop/src-tauri/target/release/bundle/`。

  > `tauri build` 需要图标。`tauri dev` 只需在 `desktop/src-tauri/icons/` 放任意 `icon.png` 占位即可。

  ### GitHub Actions 发布

  推送版本标签后，`.github/workflows/release.yml` 会：
  1. **根据 tag 自动改版本号**（`tauri.conf.json` / desktop `Cargo.toml` / Android `versionName`+`versionCode` / core workspace）
  2. 打包桌面 + Android
  3. 创建 **draft** Release

  本地不必先手改版本文件，只推 tag 即可：

  ```bash
  git tag 0.1.12
  git push origin 0.1.12
  # 或: git tag v0.1.12 && git push origin v0.1.12
  ```

  也可本地预览版本改写：
  ```bash
  ./scripts/set-version.sh 0.1.12
  ```

  | 产物 | 说明 |
  |------|------|
  | 桌面安装包 | macOS (arm64/x64)、Windows（Tauri；Linux 暂未发布） |
  | `latest.json` | 桌面自动更新清单（Tauri updater） |
  | Android APK | `ZeroTerm_<ver>_android-arm64.apk` |

  **桌面自动更新** endpoint：

  `https://github.com/NotPeppa/ZeroTerm/releases/latest/download/latest.json`

  **Android 检查更新**：读取同一仓库的 GitHub Releases API，下载 release 中的 `.apk` 并调起系统安装。

  **需要的 Secrets（仓库 Settings → Secrets）：**

  | Secret | 用途 |
  |--------|------|
  | `TAURI_SIGNING_PRIVATE_KEY` | 桌面 updater 签名私钥（与 `tauri.conf.json` 里 pubkey 配对） |
  | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（可空） |
  | `ANDROID_KEYSTORE_BASE64` | 可选；release 签名 keystore（base64）。未配置时用 debug 签名 |
  | `ANDROID_KEYSTORE_PASSWORD` | 可选 |
  | `ANDROID_KEY_ALIAS` | 可选 |
  | `ANDROID_KEY_PASSWORD` | 可选 |

  CI 完成后到 GitHub Releases 检查 draft，确认附件齐全后点 **Publish**。

  ### 命令行（CLI）

`core/` 内置交互式 SSH 客户端，二进制名为 `zeroterm`：

```powershell
cd core
cargo build --release
```

```powershell
# 直连模式（不碰 vault）
zeroterm user@host
zeroterm user@host -i $HOME\.ssh\id_ed25519 -A      # 私钥 + SSH agent
zeroterm user@host -L 8080:127.0.0.1:80 -D 1080      # 端口转发 + SOCKS 代理
zeroterm user@target -J jumpuser@bastion             # ProxyJump

# vault 模式
zeroterm add prod root@10.0.0.10 -i $HOME\.ssh\id_ed25519
zeroterm list
zeroterm prod                                        # 按别名连接
zeroterm                                             # 交互式选择器
zeroterm sftp ls prod /var/log
```

CLI 与桌面应用共用同一个 vault（Windows 默认 `%APPDATA%\ZeroTerm\zeroterm.vault`），用 `--vault <path>` 覆盖。完整用法见 [core/README.md](./core/README.md)。

---

## 安全模型

凭据与配置全程端到端加密，明文永不落盘、永不出设备。

```
master_password ─Argon2id(m=64MiB, t=3, p=4)─→ master_key (32B, 内存中 Zeroizing)
record_key      = HKDF-SHA256(master_key, salt=record_id, info="zeroterm-record-v1")
ciphertext      = XChaCha20-Poly1305(record_key, nonce=24B, plaintext,
                                     aad = record_id || version)
```

- **主密码不存储** —— 用一个已知常量的验证 blob 反向解密来校验密码正确性。
- **每条记录独立密钥** —— 单条密文泄露不影响其他记录。
- **AAD 绑定 `record_id || version`** —— 阻断记录替换与版本回滚攻击。
- **同步仓库只存密文** —— WebDAV / S3 / SFTP 后端被视为不可信，仅负责存储；加解密、合并、冲突、压缩全在客户端完成。

详见 [RFC-001 §4](./RFC-001-architecture.md) 与 [RFC-002](./RFC-002-sync-design.md)。

---

## 技术栈

| 层 | 选型 |
|---|---|
| SSH / SFTP | russh · russh-keys · russh-sftp（0.45 / 2.x） |
| 加密 | Argon2id · HKDF-SHA256 · XChaCha20-Poly1305 · zeroize |
| 本地存储 | SQLite（rusqlite，bundled） |
| 钥匙串 | keyring（Keychain / Credential Manager / Secret Service） |
| 同步后端 | 本地文件夹 · SFTP · WebDAV（reqwest + quick-xml）· S3（aws-sdk-s3） |
| FFI | uniffi（Swift / Kotlin） |
| 桌面壳 | Tauri 2（updater / dialog / fs / opener 插件） |
| 桌面终端 | xterm.js + fit / search / unicode11 / web-links 插件 |
| 桌面 PTY | portable-pty |
| 桌面前端 | 原生 HTML / CSS / JS（无打包器） |

---

## 路线图与状态

**已完成**

- ✅ Rust 核心全部 crate（ssh / crypto / vault / store / app / sync / cli / ffi）
- ✅ 桌面端：vault、主机 CRUD + 分组、SSH/本地终端、双栏 SFTP、片段、E2E 同步、AI 助手、主题/字体/背景、自动更新

**进行中 / 规划**

- 🚧 终端 tabs / splits / 多窗口
- 🚧 SSH Agent 转发、本地 agent
- 🚧 Mosh 支持
- 🚧 导入：OpenSSH config / Termius / SecureCRT / PuTTY
- 🚧 移动端 App（iOS SwiftUI / Android Compose，复用现有 FFI）
- 🚧 远程端口转发 `-R`、多跳 ProxyJump、IPv6 bracket 语法

---

## 文档

- [RFC-001 — 整体架构](./RFC-001-architecture.md)
- [RFC-002 — 多端同步设计](./RFC-002-sync-design.md)
- [core/README.md](./core/README.md) — Rust 核心与 CLI 详解
- [desktop/README.md](./desktop/README.md) — 桌面端架构与 IPC 契约
- [docs/](./docs/) — SFTP / WebDAV / S3 / desktop SFTP 手动测试记录

---

## License

[MIT](./LICENSE) © 2026
