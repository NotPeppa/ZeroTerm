# RFC-001: ZeroTerm 架构

| | |
|---|---|
| **状态** | Draft |
| **作者** | （待填） |
| **日期** | 2026-05-08 |
| **关联文档** | [README.md](./README.md) — 完整方案与路线图 |

---

## 1. 摘要

ZeroTerm 采用 **Rust 共享核心 + 平台原生 UI** 架构。Rust 核心承载 SSH/SFTP 协议栈、密钥管理、加密 vault、同步引擎、本地存储；通过 `uniffi` 暴露给 Swift / Kotlin，通过 `napi-rs` 或 Tauri command 暴露给桌面 UI。

首发平台：**macOS + iOS**。商业模式：**核心开源 + 云同步订阅**。

---

## 2. 仓库结构

```
zeroterm/
├── core/                        # Rust workspace（开源）
│   ├── crates/
│   │   ├── zeroterm-ssh/        # russh 封装、PTY、SFTP
│   │   ├── zeroterm-vault/      # 加密存储、主密钥派生
│   │   ├── zeroterm-sync/       # 同步协议客户端
│   │   ├── zeroterm-store/      # SQLite schema + 迁移
│   │   └── zeroterm-ffi/        # uniffi 绑定汇总入口
│   └── bindings/                # 生成的 Swift / Kotlin 代码
├── desktop/                     # Tauri 2 应用（macOS / Windows）
├── ios/                         # SwiftUI 应用
├── android/                     # Compose 应用（第二批）
├── sync-server/                 # 同步后端（闭源 / 自托管二选一）
└── docs/
    └── rfcs/                    # 架构 RFC 归档
```

**原则**：UI 仓不直接依赖任何 SSH / crypto 库，全部通过 `zeroterm-ffi` 调 Rust。

---

## 3. Rust 核心公共 API（FFI 表面）

只列稳定的对外接口，内部实现细节不在 RFC 范围。

### 3.1 会话生命周期

```rust
pub trait SessionListener: Send + Sync {
    fn on_state(&self, state: SessionState);     // Connecting/Authenticated/Disconnected/Error
    fn on_data(&self, channel_id: u32, bytes: Vec<u8>);
    fn on_channel_close(&self, channel_id: u32, reason: String);
}

pub struct Session { /* opaque */ }

impl Session {
    pub fn connect(config: ConnectConfig, listener: Arc<dyn SessionListener>)
        -> Result<Arc<Session>, SshError>;
    pub fn open_shell(&self, pty: PtySize) -> Result<u32, SshError>;   // returns channel_id
    pub fn write(&self, channel_id: u32, data: Vec<u8>) -> Result<(), SshError>;
    pub fn resize(&self, channel_id: u32, size: PtySize) -> Result<(), SshError>;
    pub fn close_channel(&self, channel_id: u32);
    pub fn disconnect(&self);
}
```

### 3.2 Vault（凭据与配置）

```rust
pub struct Vault { /* opaque */ }

impl Vault {
    pub fn unlock(master_password: &str) -> Result<Arc<Vault>, VaultError>;
    pub fn list_hosts(&self) -> Vec<Host>;
    pub fn upsert_host(&self, host: Host) -> Result<HostId, VaultError>;
    pub fn delete_host(&self, id: HostId) -> Result<(), VaultError>;
    pub fn put_secret(&self, kind: SecretKind, value: Vec<u8>) -> Result<SecretId, VaultError>;
    pub fn get_secret(&self, id: SecretId) -> Result<Vec<u8>, VaultError>;
    pub fn lock(self);
}
```

`SecretKind` 包含 `Password` / `PrivateKey` / `Passphrase` / `Token`。

### 3.3 同步

```rust
pub trait SyncListener: Send + Sync {
    fn on_progress(&self, pulled: u32, pushed: u32);
    fn on_conflict(&self, record_id: String);
    fn on_error(&self, err: SyncError);
}

impl Vault {
    pub fn sync(&self, listener: Arc<dyn SyncListener>) -> Result<SyncReport, SyncError>;
}
```

### 3.4 SFTP

```rust
impl Session {
    pub fn sftp(&self) -> Result<Sftp, SshError>;
}

impl Sftp {
    pub fn list(&self, path: &str) -> Result<Vec<DirEntry>, SshError>;
    pub fn open(&self, path: &str, flags: OpenFlags) -> Result<File, SshError>;
    pub fn rename(&self, from: &str, to: &str) -> Result<(), SshError>;
    pub fn remove(&self, path: &str) -> Result<(), SshError>;
    // 流式读写通过 File 句柄，避免大文件全量加载
}
```

### 3.5 错误

所有错误走 `thiserror`，FFI 层映射成各平台异常类型。**不要把 `Result` 拆成 `(value, error)` 二元组返回**——uniffi 已支持错误枚举。

---

## 4. Vault 加密设计

### 4.1 密钥派生

```
master_password ─Argon2id(t=3, m=64MiB, p=4, salt=device-salt)─→ master_key (32B)
```

- `device-salt` 在首次创建 vault 时生成，存储在系统 Keychain / Keystore 中
- `master_key` 仅在内存，进程退出或锁定后清零（`zeroize` crate）

### 4.2 记录加密

每条记录（host、secret、snippet）独立加密：

```
record_key = HKDF-SHA256(master_key, info = "zeroterm-record-v1" || record_id)
ciphertext = XChaCha20-Poly1305(record_key, nonce, plaintext, aad = record_id || version)
```

- 24 字节 nonce 随机生成，与密文一同存储
- `aad` 绑定 `record_id` 防止记录替换攻击

### 4.3 本地存储

SQLite 表只存密文：

```sql
CREATE TABLE records (
  id            TEXT PRIMARY KEY,           -- UUID v7
  kind          TEXT NOT NULL,              -- 'host' | 'secret' | 'snippet' | ...
  ciphertext    BLOB NOT NULL,
  nonce         BLOB NOT NULL,
  version       INTEGER NOT NULL,           -- 单调递增，用于同步
  updated_at    INTEGER NOT NULL,           -- 客户端时钟（仅作显示）
  deleted       INTEGER NOT NULL DEFAULT 0  -- tombstone
);
```

明文字段（搜索用的标题、host、port）**不另存**——搜索在解密后内存中做。第一版可接受，未来若性能不够再考虑加密索引（如 SSE 方案）。

---

## 5. 同步协议

### 5.1 设计原则

- **服务器零知识**：只看到密文 blob 和版本号，无法读取任何字段
- **支持自托管**：协议对接 HTTP，不绑死任何云厂商
- **冲突可解**：客户端做最后一步合并，服务器只做存储和版本检查

### 5.2 协议

HTTP/JSON，三个端点：

```
POST /v1/auth/login       { email, password_hash }  → access_token
GET  /v1/records?since=N  → [{ id, version, ciphertext, nonce, deleted }]
POST /v1/records          [{ id, base_version, ciphertext, nonce, deleted }]
                          → { accepted: [...], conflicts: [{ id, server_version }] }
```

- `password_hash` 由客户端做 Argon2id（与 vault 主密钥派生使用**不同的 salt**和不同 info），服务器再做一次 bcrypt 存储
- `since=N` 是客户端持有的服务器最高版本号；服务器返回所有 `version > N` 的记录
- 推送时若 `base_version` 与服务器当前版本不一致 → 冲突，客户端拉取后重试

### 5.3 冲突解决

记录级 last-write-wins（按客户端时钟 + 客户端 ID 打破平局）。**这够用**，理由：

- SSH 配置不像协作文档，多端同时编辑同一条 host 是极低频事件
- CRDT / Automerge 的复杂度对当前数据模型收益不抵成本

未来若加入团队共享、协作编辑，再升级到字段级 CRDT。

### 5.4 多设备主密钥

用户在新设备登录：

1. 输入邮箱 + 主密码
2. 客户端用主密码派生 `master_key`
3. 拉取该用户的密文记录
4. 用 `master_key` 解密 → 失败说明密码错误（服务器无法验证）

**不在服务器存任何与主密钥相关的验证 hash**——这是端到端加密的底线。代价：忘记主密码 = 数据彻底丢失，必须在 UI 极其明显地告知用户。

---

## 6. 首发平台决策

| 平台 | 首发 | 理由 |
|---|---|---|
| **macOS** | ✅ | 开发者用户最密集；Tauri 桌面成熟；与 iOS 共享 Keychain 体验 |
| **iOS** | ✅ | 移动端 SSH 用户付费意愿最高；SwiftTerm 可用；与 macOS Handoff/iCloud 联动是差异化 |
| Windows | 第二批 | Tauri 同一份代码，主要是 Credential Manager 集成和 ConPTY 调试 |
| Android | 第二批 | 终端 widget 没有现成生产级方案，需要自研，工作量大 |

**首发不发 Windows 的代价**：会损失一部分企业用户。但 Termius 的 macOS+iOS 体验就是它的护城河，从这里切入正面对撞，比在 Windows 上和 MobaXterm 等老牌工具拼细节更容易立住口碑。

---

## 7. 商业模式

**采用：核心开源（MIT/Apache-2.0）+ 云同步订阅 + 自托管同步免费**

- **客户端开源**：所有平台 UI、Rust 核心、加密协议全部开源
- **官方云同步**：付费订阅（参考 Obsidian Sync $4–8/月）
- **自托管同步服务器**：开源（或源码可见 + 商业许可），允许个人/企业自建

理由：

- SSH 客户端用户群高度重合开源开发者，闭源会被天然抵制
- 端到端加密天然适合零知识 SaaS：服务器再小成本也能跑
- 自托管选项是 vs Termius 的硬差异化点
- 核心粘性来自"多端无缝同步 + 加密保障"，开源核心不削弱付费动机

**第一年不做团队功能**——团队 vault 共享需要密钥分发协议（类似 1Password 的 SRP + 公钥包装），复杂度高，等单用户产品立住再做。

---

## 8. 替代方案

| 方案 | 否决原因 |
|---|---|
| Tauri 全平台（含移动） | 移动端 WebView IME 坑；插件生态薄；与"严肃工具"目标不匹配 |
| Flutter 全平台 | xterm.dart / dartssh2 生产级度不够 |
| 不做 sync，纯本地 | 无差异化护城河，对标不到 Termius |
| 服务器侧加密（非 E2E） | 用户托付的是 SSH 凭据，零知识是必须的 |
| CRDT 同步 | 当前数据模型用不上，复杂度溢出 |

---

## 9. 待解决的开放问题

1. **Android 终端 widget**：自研 vs 移植 Termux 的渲染层 vs 用 Compose Canvas 重写——需要做技术 spike
2. **Mosh 的实现**：Mosh 协议自带 UDP + 状态同步，是否值得在 Rust 核心实现一份，还是 fork 现有 C 实现做 FFI
3. **iOS 后台连接**：VoIP push 续命 vs 接受断开 + 快速重连 vs Mosh —— 决定 P1 阶段的工程量
4. **Sync server 实现语言**：Rust（与核心一致，可共享 schema）vs Go（运维社区更熟）
5. **Beta 渠道**：TestFlight / 自家服务器 + Sparkle —— 影响 sync server 上线时间表
6. **支付通道**：iOS 强制走 IAP（Apple 抽 30/15%），桌面用 Stripe 直收——是否做"在网页订阅、客户端通过账号同步授权"的绕开方案

---

## 10. 接下来 4 周的里程碑

| 周 | 目标 |
|---|---|
| W1 | Rust 核心：`zeroterm-ssh` 跑通"密码认证 + 打开 shell + PTY 双向流"；命令行 demo |
| W2 | `zeroterm-vault` 跑通"主密码解锁 + 加密存储/读取一条 host"；`zeroterm-store` SQLite schema 落地 |
| W3 | `uniffi` 暴露 Vault + Session API，生成 Swift / Kotlin 绑定；Tauri 桌面端跑通"列表点击 → 连接 → 终端输出" |
| W4 | iOS demo：SwiftTerm 集成，调用 Rust 核心连接一台真实 host；同步协议 RFC（独立文档）起草 |

W4 结束时若上述都成立，这套架构就算被验证了，可以扩团队 / 投入正式开发。
