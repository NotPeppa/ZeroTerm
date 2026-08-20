# ZeroTerm

> 对标 Termius 量级的跨平台 SSH / SFTP 客户端 —— **Rust 核心 + 原生 UI**，无账号、端到端加密的多端同步。

ZeroTerm 是一款面向开发者和运维的严肃终端工具。SSH/SFTP 协议栈、加密 vault、同步引擎全部用 Rust 写一遍，桌面端用 Tauri 2 + xterm.js 承载，移动端通过 uniffi 复用同一套核心。

当前版本：**v0.1.11**。

| 平台 | 当前状态 |
|---|---|
| macOS / Windows 桌面端 | 可用：SSH、本地终端、SFTP、AI 助手、服务器管理、端口转发和端到端加密同步 |
| Android | M0–M7 主路径可用：SSH 终端、SFTP、AI、片段、主题和 WebDAV / SFTP / S3 同步 |
| 命令行 `zeroterm` | 可用：直连、Vault 主机、SFTP、端口转发和 ProxyJump |
| iOS | 规划中 |

---

## 功能总览

### 桌面终端与连接

- **SSH 会话** —— 密码、私钥（含 passphrase）和系统 SSH Agent 认证，完整 PTY 交互式 shell。
- **主机管理** —— 主机新增、编辑、复制、删除和搜索；支持多级分组、折叠状态与系统类型识别。
- **Quick Connect** —— 使用密码、私钥或 Agent 临时直连，不写入 Vault。
- **本地终端** —— 内置本地 PTY，可选择 shell 和默认工作目录；Windows 本地输出支持 UTF-8，并对旧工具的 GBK 输出做兼容解码。
- **标签页、分屏与窗口** —— 多终端标签页、水平/垂直双窗格、独立新窗口、窗格尺寸自适应和会话关闭清理。
- **终端交互** —— `Ctrl/Cmd + F` 搜索、URL/IP 链接识别、复制粘贴、IME/CJK/Unicode 支持，以及可排序的选中文本右键菜单（复制、执行、交给 AI、搜索、打开链接、跳转 SFTP）。
- **符合原生终端习惯的滚动** —— 位于底部时自动跟随 Codex、Claude Code 等流式输出；用户一旦向上滚动就保留历史位置，重新滚到底部后恢复跟随。
- **连接状态** —— 实时延迟、无响应检测、断线提示与一键重连。
- **known_hosts 校验** —— 已知密钥静默通过；未知主机显示算法与指纹；密钥变更时支持拒绝、仅本次接受或替换记录。
- **ProxyJump** —— 通过已保存的跳板机连接目标主机，当前支持单跳。
- **端口转发中心** —— 独立于终端启动和管理本地转发 `-L`、远程转发 `-R` 与动态 SOCKS5 `-D`；规则可搜索、编辑、同步，并在隧道意外断开后指数退避自动重连。

### 桌面服务器工具

- **系统指标** —— 查看主机、系统、架构、运行时长、IPv4/IPv6 出站类型、CPU、内存、Swap、磁盘和网卡实时流量。
- **服务管理** —— 搜索和查看远端或本地 Linux 的 systemd 系统/用户服务，支持详情、启动、停止、重启及 unit 文件查看。
- **监听端口** —— 按协议/地址查看监听端口、关联进程与 PID，支持结束或强制结束进程。
- **Docker 管理** —— 容器列表、状态、镜像、端口与详情；支持启动、停止、重启、删除、日志、进入容器终端、复制容器名，以及按 Compose 项目批量操作和 `pull` / `up -d`。
- **命令片段（Snippets）** —— 创建、编辑、删除、分组、重命名分组和搜索；可插入当前终端或直接执行。
- **CLI 等待提醒** —— Claude Code、Codex 等 CLI 在后台标签等待确认或选择时显示提示点；窗口在后台时可闪烁 Windows 任务栏图标或跳动 macOS Dock 图标。

### AI 终端助手

- **自带密钥** —— 支持 OpenAI 与 OpenAI-compatible API、自定义 Base URL / 模型、模型列表刷新、`reasoning_effort` 和全局提示词；可保存多个配置并即时切换，API Key 存入系统钥匙串。
- **终端上下文** —— 可附带当前终端最近内容和命令结果，并在发送前自动脱敏常见密码、令牌、私钥等敏感信息。
- **流式会话** —— Markdown/代码块渲染、推理内容折叠、停止与重试、持久会话和临时会话。
- **命令工作流** —— AI 生成的命令支持复制、逐条批准、执行后采集输出并继续分析，同时避免重复执行。
- **三级终端权限** —— “每次询问”“自动只读”“本会话自动”；删除、提权、重启、管道、重定向、远程操作等高风险命令始终停下等待批准，包含未替换密钥/令牌占位符的命令不会执行。

> 当前 AI 请求协议是 OpenAI-compatible；Anthropic、Gemini、Ollama 等可通过兼容网关接入，原生协议尚未实现。

### 桌面 SFTP 与文件工具

- **双栏文件管理器** —— 本地和远端目录均可作为面板，支持路径导航、前进/返回、筛选、书签、隐藏文件和多选。
- **完整文件操作** —— 上传、下载、面板间复制、重命名、删除、新建文件/目录、权限查看与 `chmod`。
- **跨主机复制** —— 支持本地↔远端及远端↔远端复制；条件允许时尝试服务器直传，否则使用安全的中转路径。
- **可靠传输** —— 分块流式传输、队列、总进度、当前文件、速度、ETA、覆盖确认、原子替换、失败重试、卡住检测和取消。
- **内置文本编辑器** —— 本地/远端 UTF-8 文本可直接编辑并用 `Ctrl/Cmd + S` 保存；GBK、Windows-1252、Shift_JIS、EUC-KR 可识别并以只读方式打开。
- **外部编辑** —— 可用系统应用打开远端文件，监控本地改动后上传回服务器，并显示待上传/冲突状态。
- **终端侧栏 SFTP** —— 在当前 SSH 会话旁浏览文件；支持从终端选中路径跳转，并通过 shell 的 OSC 7 信息跟随当前工作目录。

### Vault、凭据与安全

- **端到端加密 Vault** —— Argon2id 派生主密钥，每条记录通过 HKDF-SHA256 派生独立密钥，再用 XChaCha20-Poly1305 加密。
- **主密码不落盘** —— 只保存可验证主密码是否正确的加密校验数据；主密钥在内存释放时清零。
- **系统钥匙串解锁** —— 可选择把主密码缓存到 macOS Keychain、Windows Credential Manager 或 Linux Secret Service；手动锁定时同时清除缓存。
- **敏感凭据保护** —— 主机密码、私钥、同步密码与 AI API Key 分别保存在加密 Vault 或系统钥匙串；查看已保存主机凭据需要再次验证主密码。
- **选择性数据清理** —— 可分别清除本地设置、Vault 数据、同步配置、AI 配置、AI 会话或钥匙串中的解锁密码。

### 多端同步（无账号 / 无专用服务端）

- **端到端加密** —— 同步仓库只保存密文，存储服务无法读取主机凭据、分组、命令片段或端口转发规则。
- **多配置、多后端** —— 本地文件夹、SFTP、WebDAV 和 S3-compatible（AWS S3、Cloudflare R2、MinIO、群晖等），支持自定义 endpoint、prefix、path-style 与临时 session token。
- **创建或加入仓库** —— 首台设备创建加密仓库，其他设备使用相同同步密码加入；同步密码可保存到系统钥匙串。
- **自动与手动同步** —— CRUD 变更后防抖推送、可配置心跳、窗口恢复可见时立即同步，也可随时手动同步。
- **记录级增量与冲突处理** —— 自动合并独立修改；同一记录发生并发编辑时进入冲突收件箱，可选择保留本地或远端版本。
- **设备与密钥管理** —— 查看已加入设备、最后在线时间；撤销设备时轮换仓库根密钥并重新加密快照。
- **仓库维护** —— 查看 manifest/keyring/snapshot/event/trash 空间占用，手动压缩事件、清理旧墓碑，或清空远端仓库。

同步协议与安全设计详见 [RFC-002](./RFC-002-sync-design.md)。

### 外观、设置与更新

- 简体中文 / English，系统、浅色、深色外观模式。
- 多套内置终端主题，自定义/复制/编辑主题，系统字体、字号和行高实时预览。
- 自定义背景图、透明度、模糊与玻璃效果。
- 保存启动窗口大小、左右侧栏宽度；支持可折叠、可拖动侧栏。
- 内置 HTTP 网络代理设置，新建 SSH/SFTP 会话及受支持的应用请求可走代理。
- 桌面内置签名更新检查与安装；Android 可从 GitHub Release 下载 APK 并调起系统安装。

### Android 客户端

- **原生终端** —— Kotlin + Compose Canvas 渲染共享 Rust VT 核心，支持 true color、宽字符、软键盘、自定义扩展键、手势回滚、跳到底部、长按选择、复制粘贴和双指缩放字号。
- **移动连接体验** —— Vault 创建/解锁、生物识别记住密码、主机 CRUD、Quick Connect、主机密钥确认、网络变化提示、一键重连和前台服务保活。
- **移动 SFTP** —— 浏览、上传、下载、取消、重命名、新建和删除，通过 Android Storage Access Framework 选择文件。
- **移动 AI** —— OpenAI-compatible 配置、模型选择、系统提示词、推理强度、聊天、停止、思考内容、终端上下文、命令插入/执行与继续分析。
- **移动会话工具** —— 终端抽屉内可管理/插入命令片段、查看系统指标、管理 Docker 容器并实时切换终端主题。
- **移动同步** —— WebDAV、SFTP、S3/R2/MinIO，多配置、创建/加入、全部同步、冲突处理、设备/仓库信息、压缩和前台定时同步。
- **移动外观** —— 中英文、明暗主题、自定义终端调色板、应用背景、顶栏/抽屉透明度、HTTP 代理和厂商后台运行引导。

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
│  • zeroterm-term    共享 VT 终端状态机（Android 渲染）       │
│  • zeroterm-cli     交互式 SSH 命令行（zeroterm 可执行文件）  │
│  • zeroterm-ffi     uniffi 绑定（Swift / Kotlin）            │
└─────────────────────────────────────────────────────────────┘
        │ Tauri command (桌面)        │ uniffi (移动端)
        ▼                             ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ Desktop (desktop/)   │   │ Android (Compose) / iOS (规划中) │
│ Tauri 2 + xterm.js   │   │ Android 已复用 core 与 term       │
│ 原生 HTML/CSS/JS     │   │ 原生 Canvas 终端 UI               │
└──────────────────────┘   └──────────────────────────────────┘
```

### 关键决策

1. **Rust 核心不写两遍** —— SSH 协议栈、加密、同步引擎是全部平台共享的，通过 `uniffi`（Swift/Kotlin）和 Tauri command（桌面）暴露。
2. **桌面用 Tauri 2 + xterm.js** —— 包体小、性能好；Windows 使用 xterm.js 默认渲染路径，macOS 使用 Canvas renderer 改善 Retina 与透明背景上的字形清晰度。前端刻意使用原生 HTML/CSS/JS，IPC 契约不依赖任何 JS 框架。
3. **移动端坚持原生** —— 输入法、外接键盘、手势、后台保活和网络切换重连需要原生能力。Android 已用 Compose + Canvas 实现，并通过 uniffi 复用 Rust 核心；iOS 仍在规划中。
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
│       ├── zeroterm-term/     # VT 解析与终端网格（Android 复用）
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

1. **根据 tag 自动改版本号**（`tauri.conf.json` / desktop `Cargo.toml` / Android `versionName`+`versionCode` / core workspace）。
2. 打包桌面 + Android。
3. 创建 **draft** Release。

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

### Android

需要 JDK 17、Android SDK、NDK r28+、Rust Android targets 和 `cargo-ndk`：

```powershell
cd android
.\gradlew.bat assembleDebug
```

Gradle 会自动交叉编译 Rust FFI、复制 Kotlin bindings 和对应 ABI 的 `.so`。详细环境、ABI 覆盖方式与首次运行说明见 [android/README.md](./android/README.md)。

---

## 安全模型

Vault 中的凭据和可同步记录全程端到端加密；同步后端只能看到密文。AI API Key、同步后端密码等独立秘密由系统钥匙串保存。

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
| SSH / SFTP | russh 0.62 · russh-sftp 2.3（仓库内 vendored patch） |
| 加密 | Argon2id · HKDF-SHA256 · XChaCha20-Poly1305 · zeroize |
| 本地存储 | SQLite（rusqlite，bundled） |
| 钥匙串 | keyring（Keychain / Credential Manager / Secret Service） |
| 同步后端 | 本地文件夹 · SFTP · WebDAV（reqwest + quick-xml）· S3（aws-sdk-s3） |
| FFI | uniffi（Swift / Kotlin） |
| 桌面壳 | Tauri 2（updater / dialog / fs / opener 插件） |
| 桌面终端 | xterm.js + fit / search / unicode11 / web-links 插件 |
| 桌面 PTY | portable-pty |
| 桌面前端 | 原生 HTML / CSS / JS（无打包器） |
| Android | Kotlin · Jetpack Compose · Material 3 · Compose Canvas |
| Android 终端 | zeroterm-term（alacritty_terminal） |

---

## 路线图与状态

**已完成**

- ✅ Rust 核心全部 crate（ssh / crypto / vault / store / app / sync / term / cli / ffi）
- ✅ 桌面端：Vault、主机/多级分组、SSH/本地终端、标签页/分屏/多窗口、双栏 SFTP、独立 `-L`/`-R`/`-D`、服务器工具、AI 助手、E2E 同步、主题和自动更新
- ✅ Android：Vault、生物识别解锁、SSH 终端、SFTP、AI、片段、E2E 同步、主题和 APK 更新
- ✅ CLI：直连/Vault 连接、Agent 认证、SFTP、`-L`/`-D` 与单跳 ProxyJump

**进行中 / 规划**

- 🚧 iOS SwiftUI 客户端
- 🚧 Android 真机兼容性验收与应用商店发布
- 🚧 Linux 桌面安装包发布与发行版验证
- 🚧 面向普通终端会话的 SSH Agent 转发开关
- 🚧 Mosh 支持
- 🚧 导入：OpenSSH config / Termius / SecureCRT / PuTTY
- 🚧 多跳 ProxyJump、IPv6 bracket 语法
- 🚧 Anthropic / Gemini 等原生 AI 协议（目前使用 OpenAI-compatible API）

---

## 文档

- [RFC-001 — 整体架构](./RFC-001-architecture.md)
- [RFC-002 — 多端同步设计](./RFC-002-sync-design.md)
- [RFC-003 — Android 设计](./RFC-003-android.md)
- [core/README.md](./core/README.md) — Rust 核心与 CLI 详解
- [desktop/README.md](./desktop/README.md) — 桌面端架构与 IPC 契约
- [android/README.md](./android/README.md) — Android 构建、功能状态与同步说明
- [docs/](./docs/) — SFTP / WebDAV / S3 / desktop SFTP 手动测试记录

---

## License

[MIT](./LICENSE) © 2026
