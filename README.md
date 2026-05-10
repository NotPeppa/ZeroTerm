# ZeroTerm 架构方案

> 目标：做一款对标 Termius 量级的跨平台 SSH 客户端
> 覆盖平台：macOS / Windows / iOS / Android（不做 Web）
> 记录时间：2026-05-08

---

## 一、整体架构：Rust 核心 + 平台原生 UI

```
┌─────────────────────────────────────────────────┐
│  Rust Core (shared library)                     │
│  • russh / russh-sftp（SSH/SFTP 协议栈）        │
│  • 会话/连接池/重连/Mosh                        │
│  • 密钥管理 + 加密 vault                        │
│  • 端口转发、ProxyJump、Agent 转发              │
│  • Sync 引擎（E2E 加密）                        │
│  • 本地存储（SQLite, sqlx）                     │
└─────────────────────────────────────────────────┘
         ↓ uniffi / flutter_rust_bridge / napi-rs
┌──────────────┬──────────────┬──────────────────┐
│ macOS / Win  │ iOS          │ Android          │
│ Tauri 2 +    │ SwiftUI +    │ Compose +        │
│ xterm.js +   │ 原生终端     │ 原生终端         │
│ WebGL        │ (SwiftTerm)  │ (自研/移植)       │
└──────────────┴──────────────┴──────────────────┘
```

### 关键决策

1. **Rust 核心不可妥协**
   SSH 协议栈、加密、sync engine 写两遍是自杀。`uniffi` 让 Swift / Kotlin 都能调，方案成熟。

2. **桌面用 Tauri 2 + xterm.js**
   - 桌面 WebView 没有移动端的 IME 坑
   - xterm.js + WebGL 渲染是当前最强，自研终端不划算
   - 包体小（~10MB），性能好
   - 后期若要极致 macOS 原生感可再上 SwiftUI，但收益边际递减

3. **移动端坚决用原生（不用 Flutter / Tauri Mobile）**
   - iOS：SwiftUI + **SwiftTerm**（开源，Blink 团队维护，生产可用）
   - Android：Jetpack Compose + 原生/移植终端 widget
   - 理由：
     - 输入法、外接键盘（iPad + Magic Keyboard）、手势、Haptic、Stage Manager、分屏 —— 这些只有原生才能做透
     - 后台连接保活、网络切换重连，原生 API 才完整
     - Flutter 终端 widget 渲染性能和文本细节（连字、CJK、双宽字符）目前都不到生产级
     - WebView + xterm.js 在移动端有 IME / 联想 / 自动纠错 / 软键盘适配等一系列隐性坑

4. **不做 Web**
   - 浏览器无法直连 TCP，需要中继服务，破坏端到端加密模型
   - 与"严肃工具"定位冲突
   - Termius Web 本身就是鸡肋功能

---

## 二、为什么不选其他方案

| 方案 | 否决原因 |
|---|---|
| Tauri 全平台（含移动） | Tauri 2 mobile 2024 才 GA，插件生态薄弱；WebView 移动端 IME 等输入坑严重 |
| Flutter 全平台 | xterm.dart 终端渲染性能/细节不到生产级；dartssh2 维护活跃度不如 russh |
| Electron 桌面 | 体积内存太重；移动端要另起 RN 工程，复用率低 |
| 全平台原生 UI | 桌面端不划算，xterm.js 已经是最优解 |

---

## 三、功能路线图（对标 Termius）

### P0 — 不做没法上线
- SSH（密码 / 密钥 / Agent 认证）
- SFTP
- known_hosts 管理
- ProxyJump
- 端口转发（本地 / 远程 / 动态 SOCKS）
- 会话分组、标签、搜索
- **E2E 加密的多端同步**（Termius 核心粘性）
- Snippets / 命令片段
- 系统 Keychain / Keystore / Secure Enclave 集成
- 主密码 + 生物识别解锁

### P1 — 决定专业用户去留
- 终端：tabs、splits、搜索、超大 scrollback、URL/IP 高亮跳转
- **Mosh 支持**（iOS 后台保活体验差异巨大）
- SSH agent 转发 + 本地 agent
- 主题、字体、配色（iTerm2 / Alacritty 主题导入）
- 导入：OpenSSH config、Termius、SecureCRT、PuTTY

### P2 — 差异化
- **自托管 sync 服务器**（Termius 没有，开发者社区会买账）
- Kubernetes / Docker exec 集成
- 团队共享（凭据 vault 共享，类似 1Password 团队）
- AI 命令辅助（本地或 BYO API key）

---

## 四、待确认的产品决策

1. **商业模式**：订阅制 / 一次买断 / 开源 + 付费云同步？
   - 推荐：**开源核心 + 付费云同步**（类似 Obsidian），对开发者社区友好
   - 决定 sync 后端怎么设计、是否做团队功能

2. **Sync 后端**：自建 vs SaaS（Cloudflare D1 / Supabase 等）
   - 自建：长期运维成本，但可控
   - SaaS：启动快，但被绑死

3. **开源策略**：核心开源 + 同步/团队功能收费

4. **首发平台**：建议 **macOS + iOS 先做透**
   - 这两端 Termius 最强、用户最挑剔
   - 做好了口碑爆发
   - Windows / Android 第二批

---

## 五、团队规模估算

满足 P0 + P1 大致需要：

| 角色 | 人数 |
|---|---|
| Rust 核心 | 1（6–12 个月到能用） |
| macOS / Windows（Tauri） | 1 |
| iOS 原生 | 1 |
| Android 原生 | 1 |
| 同步后端 + DevOps | 0.5 |

**单人路径**：砍范围到 macOS + iOS 先发，桌面 Tauri 一套覆盖 Mac/Win，移动端只做 iOS，预计 **12–18 个月到 MVP**。

---

## 六、下一步

不要直接写代码，先做：

1. **重度使用 Termius 一周**，列出受不了的细节 → 这就是差异化点
2. **写一份 1 页架构 RFC**：Rust 核心暴露什么 API、sync 协议怎么加密、首发平台、商业模式

这一页定了，团队 / 外包 / 未来的自己都不会跑偏。

---

## 附：技术选型速查

| 层 | 选型 |
|---|---|
| SSH 协议栈 | russh（纯 Rust，活跃） |
| SFTP | russh-sftp |
| FFI 绑定 | uniffi（Swift/Kotlin），napi-rs（Node/Tauri） |
| 桌面终端渲染 | xterm.js + xterm-addon-webgl + xterm-addon-fit |
| 桌面壳 | Tauri 2 |
| iOS 终端 | SwiftTerm |
| Android 终端 | 自研 / 移植（待调研） |
| 本地存储 | SQLite（rusqlite / sqlx） |
| 桌面 UI | React 或 Vue |
| 移动 UI | SwiftUI（iOS）/ Jetpack Compose（Android） |
| 密钥存储 | Keychain（macOS/iOS）、Credential Manager（Win）、Keystore（Android） |
