# RFC-002: ZeroTerm 多端同步设计

| | |
|---|---|
| **状态** | Draft |
| **日期** | 2026-05-21 |
| **关联文档** | [RFC-001-architecture.md](./RFC-001-architecture.md) |

---

## 1. 摘要

ZeroTerm 的最终同步设计采用 **无账号、无专用服务端、端到端加密、文件仓库式同步**。

同步目标不是构建一个必须依赖官方账号或自托管服务端的云服务，而是定义一个开放的同步仓库格式。用户可以把同步仓库放在自己已有的存储位置，例如 SFTP 服务器、WebDAV、S3/R2/MinIO、本地文件夹、iCloud Drive、Dropbox 或 Syncthing。

核心原则：

- 不要求官方账号。
- 不要求用户为了 SSH 客户端额外部署同步服务端。
- 同步后端只负责存储密文文件。
- 客户端负责加密、解密、合并、冲突处理和空间清理。
- 同步协议以记录为单位，不同步整个 vault 文件。

---

## 2. 非目标

第一版最终同步不解决以下问题：

- 不做官方账号系统。
- 不做团队协作和权限管理。
- 不做实时协作式 CRDT。
- 不同步正在运行的终端会话。
- 不同步终端滚动日志。
- 不同步设备本地窗口位置、最近路径、临时 quick connect 记录。
- 不把 WebDAV/S3/SFTP 后端视为可信服务端。

这些可以在未来作为独立能力设计，但不能污染基础同步协议。

---

## 3. 用户模型

ZeroTerm 同步面向三类用户：

| 用户 | 推荐后端 | 说明 |
|---|---|---|
| 普通桌面用户 | 本地文件夹 + iCloud/Dropbox/Syncthing | 低门槛，不需要理解服务端 |
| SSH/VPS 用户 | SFTP | 最符合 SSH 客户端用户习惯 |
| NAS/自托管用户 | WebDAV / S3 / MinIO | 适合 Nextcloud、群晖、R2、MinIO |

专用 ZeroTerm Sync Server 可以以后作为高级可选后端，但不能成为默认依赖。

---

## 4. 高层架构

```
ZeroTerm Client
  ├─ Local Vault
  ├─ Sync Engine
  │   ├─ Record Diff
  │   ├─ E2E Crypto
  │   ├─ Conflict Resolver
  │   └─ Compaction
  └─ Sync Adapter
      ├─ Local Folder
      ├─ SFTP
      ├─ WebDAV
      └─ S3 Compatible

Sync Repository
  └─ Encrypted files only
```

客户端本地 vault 是权威当前态。同步仓库是多设备交换密文变更和快照的媒介。

---

## 5. 后端能力要求

同步后端只需要提供最小文件操作：

```text
list(prefix)
read(path)
write_new(path, bytes)
overwrite(path, bytes)
delete(path)
stat(path)
```

不同后端能力有差异：

| 后端 | 原子写 | CAS/ETag | 删除 | 适合程度 |
|---|---:|---:|---:|---|
| Local Folder | 中 | 否 | 是 | 高 |
| SFTP | 中 | 否 | 是 | 高 |
| WebDAV | 中 | 部分支持 | 是 | 高 |
| S3/R2/MinIO | 高 | 支持 | 是 | 高 |

设计上不能强依赖 CAS。事件文件应尽量只新增，不频繁覆盖同一个文件。

---

## 6. 同步仓库布局

同步仓库是一个普通目录：

```text
.zeroterm-sync/
  manifest.json
  keyring.json
  devices/
    dev_<device_id>.json
  snapshots/
    snapshot_<epoch>_<id>.ztsnap
  events/
    2026-05/
      event_<logical_clock>_<device_id>_<random>.ztlog
  conflicts/
    conflict_<record_id>_<timestamp>.ztconflict
  trash/
    deleted_<record_id>_<timestamp>.ztdel
  locks/
    compact.lock
```

### 6.1 `manifest.json`

`manifest.json` 是仓库入口，存放少量非敏感元数据：

```json
{
  "format": "zeroterm-sync-repo",
  "version": 1,
  "vaultId": "vault_01h...",
  "createdAt": 1779340800000,
  "updatedAt": 1779340800000,
  "latestSnapshot": "snapshots/snapshot_000120_abc.ztsnap",
  "minRetainedEvent": "events/2026-05/event_000121_dev_a_x.ztlog",
  "crypto": {
    "kdf": "argon2id",
    "cipher": "xchacha20poly1305",
    "compression": "zstd"
  },
  "retention": {
    "snapshotKeep": 2,
    "eventKeepDays": 30,
    "tombstoneKeepDays": 90
  }
}
```

`manifest.json` 不包含 host、用户名、密码、私钥、标签名等明文。

### 6.2 `keyring.json`

`keyring.json` 保存被同步口令加密后的 `sync_root_key`：

```json
{
  "version": 1,
  "kdf": {
    "name": "argon2id",
    "salt": "base64...",
    "memoryKiB": 65536,
    "iterations": 3,
    "parallelism": 4
  },
  "wrappedRootKey": {
    "cipher": "xchacha20poly1305",
    "nonce": "base64...",
    "ciphertext": "base64..."
  }
}
```

新设备需要同步仓库地址、访问凭据和同步口令，才能解开 `sync_root_key`。

---

## 7. 本地数据模型

本地 SQLite 需要从“只存当前记录”扩展为“当前记录 + 同步元数据”。

### 7.1 `records`

```sql
CREATE TABLE records (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  encrypted_payload  BLOB NOT NULL,
  nonce              BLOB NOT NULL,
  local_rev          TEXT NOT NULL,
  server_rev         TEXT,
  base_server_rev    TEXT,
  updated_at         INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  deleted            INTEGER NOT NULL DEFAULT 0,
  dirty              INTEGER NOT NULL DEFAULT 0,
  conflict_state     TEXT
);
```

### 7.2 `sync_state`

```sql
CREATE TABLE sync_state (
  key   TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
```

关键值：

```text
vault_id
device_id
last_applied_event
last_sync_at
latest_snapshot_id
logical_clock
```

### 7.3 `sync_conflicts`

```sql
CREATE TABLE sync_conflicts (
  id                  TEXT PRIMARY KEY,
  record_id           TEXT NOT NULL,
  kind                TEXT NOT NULL,
  local_payload       BLOB NOT NULL,
  remote_payload      BLOB NOT NULL,
  local_rev           TEXT NOT NULL,
  remote_rev          TEXT NOT NULL,
  detected_at         INTEGER NOT NULL,
  resolved_at         INTEGER
);
```

---

## 8. 同步记录类型

同步以记录为单位。建议第一批支持：

| 类型 | 是否默认同步 | 说明 |
|---|---:|---|
| `host` | 是 | 主机配置，不直接存 secret 明文 |
| `secret` | 是 | 密码、私钥、passphrase |
| `identity` | 是 | 可复用 SSH identity |
| `tag` | 是 | 标签 |
| `group` | 是 | 分组/目录 |
| `snippet` | 是 | 命令片段 |
| `known_host` | 是 | 已信任 host key |
| `terminal_profile` | 是 | 字体、配色、终端偏好 |
| `sftp_bookmark` | 是 | 常用远程路径 |
| `app_setting` | 部分 | 只同步跨设备有意义的设置 |

不默认同步：

| 类型 | 原因 |
|---|---|
| 打开的终端标签 | 会话是设备实时状态 |
| 终端日志 | 体积大且可能包含敏感输出 |
| 窗口位置和大小 | 设备相关 |
| 最近访问路径 | 设备相关，且可能泄露本地目录 |
| quick connect 临时记录 | 不属于持久 vault |
| OS keychain remember 状态 | 设备安全策略不同 |

---

## 9. Host 与 Secret 分离

`host` 记录不直接存密码或私钥，而是引用 `secret` 或 `identity`：

```json
{
  "id": "host_01h...",
  "kind": "host",
  "schemaVersion": 1,
  "name": "prod-web",
  "hostname": "1.2.3.4",
  "port": 22,
  "username": "root",
  "authRef": "secret_01h...",
  "tags": ["tag_01h..."],
  "groupId": "group_01h...",
  "proxyJump": "host_01h...",
  "forwards": [],
  "osType": "ubuntu"
}
```

`secret` 示例：

```json
{
  "id": "secret_01h...",
  "kind": "secret",
  "schemaVersion": 1,
  "secretKind": "private_key",
  "value": "-----BEGIN OPENSSH PRIVATE KEY-----...",
  "passphraseRef": "secret_01h..."
}
```

这样可以避免修改 host 名称时重复写入私钥，减少空间占用和冲突概率。

---

## 10. 加密设计

### 10.1 密钥层级

```text
sync_passphrase
  -> Argon2id
  -> key_wrapping_key
  -> decrypt sync_root_key

sync_root_key
  -> HKDF("record", record_id)
  -> record_key
```

### 10.2 记录加密

```text
plaintext json
  -> zstd level 3
  -> XChaCha20-Poly1305
```

AAD：

```text
vault_id || record_id || kind || revision
```

每条记录使用独立随机 nonce。nonce 必须来自系统随机数。

### 10.3 事件加密

事件中的 payload 同样加密：

```json
{
  "eventId": "event_...",
  "deviceId": "dev_...",
  "recordId": "host_...",
  "kind": "host",
  "op": "upsert",
  "baseRev": "rev_...",
  "newRev": "rev_...",
  "nonce": "base64...",
  "ciphertext": "base64...",
  "createdAt": 1779340800000
}
```

`kind` 是否明文保留需要权衡。建议第一版明文保留粗粒度 `kind`，便于调试、过滤和增量处理。未来可以提供隐藏类型的高级模式。

---

## 11. 事件日志

事件日志只追加，不覆盖。

事件文件名：

```text
event_<logical_clock>_<device_id>_<random>.ztlog
```

示例：

```text
events/2026-05/event_0000000123_dev_macbook_a8f9.ztlog
```

事件操作：

| op | 说明 |
|---|---|
| `upsert` | 创建或更新记录 |
| `delete` | 删除记录，写 tombstone |
| `restore` | 从 tombstone 恢复 |

每次本地修改产生一个事件。客户端可以 debounce 3-5 秒批量写入，避免频繁小文件写入。

---

## 12. 快照与空间控制

事件日志不能无限增长。必须使用快照和压缩。

### 12.1 快照内容

快照是某一时刻完整当前态：

```json
{
  "snapshotId": "snapshot_000120_abc",
  "vaultId": "vault_...",
  "createdAt": 1779340800000,
  "lastIncludedEvent": "event_000120_dev_x_y.ztlog",
  "records": [
    {
      "id": "host_...",
      "kind": "host",
      "deleted": false,
      "rev": "rev_...",
      "nonce": "base64...",
      "ciphertext": "base64..."
    }
  ],
  "tombstones": []
}
```

整个快照文件也可以再做外层压缩和加密，但记录本身仍保持独立加密。

### 12.2 压缩策略

默认策略：

```text
每 100 次变更生成一个快照
或每 7 天生成一个快照
只保留最近 2 个快照
只保留最近 30 天事件日志
tombstone 保留 90 天
trash 保留 30 天
conflict 默认保留最近 10 个
```

空间目标：

| 用户类型 | 目标空间 |
|---|---:|
| 普通用户 | < 5 MB |
| 重度用户 | < 50 MB |
| 极端用户 | 默认不超过 100 MB |

空间上限可以作为高级设置。

### 12.3 Tombstone

删除必须先写 tombstone，不能立即彻底移除：

```json
{
  "recordId": "host_...",
  "kind": "host",
  "deletedAt": 1779340800000,
  "rev": "rev_..."
}
```

默认保留 90 天。如果未来维护设备同步水位，可以在所有已知设备都同步后提前清理。

---

## 13. 同步流程

一次同步分四步：

```text
1. Load manifest
2. Pull remote snapshot + events
3. Merge remote changes into local vault
4. Push local dirty events
5. Maybe compact
```

### 13.1 Pull

客户端读取 `manifest.json`，下载最新 snapshot，再下载 snapshot 之后的事件。

如果本地已有该 snapshot，只下载增量事件。

### 13.2 Apply Remote

对每个远端事件：

```text
如果本地没有该记录:
  解密并插入
如果本地记录未 dirty 且 baseRev 匹配:
  应用远端更新
如果本地记录 dirty 且远端修改了同一 baseRev:
  进入冲突
如果事件已应用:
  跳过
```

### 13.3 Push

本地 dirty 记录生成事件并写入 `events/`。

由于后端不一定支持事务，push 应尽量满足：

- 事件文件名唯一。
- 写入事件前不删除本地 dirty 状态。
- 写入成功后再标记 dirty 已同步。
- manifest 更新失败不影响下一次通过 list events 找到事件。

### 13.4 Compact

满足以下任一条件时可触发 compact：

- 事件数超过阈值。
- 距离上次快照超过 7 天。
- 仓库大小超过目标。
- 用户手动点击清理。

compact 可以抢占 `locks/compact.lock`，失败则跳过，避免多设备同时清理。

---

## 14. 冲突处理

不使用 CRDT。SSH 配置不是协作文档，记录级冲突更简单、可解释、可实现。

### 14.1 自动合并规则

```text
不同记录修改：自动合并
同一记录只有一端修改：自动应用
同一记录两端都修改：冲突
删除 vs 未修改：自动删除
删除 vs 修改：冲突
```

### 14.2 冲突 UI

host 冲突：

```text
主机 prod-web 在多台设备上都被修改

操作：
- 保留本机版本
- 使用远端版本
- 另存为副本
```

secret 冲突：

```text
认证信息在多台设备上都被修改

操作：
- 保留本机认证信息
- 使用远端认证信息
```

secret 不显示明文 diff。

---

## 15. 设备身份

每台设备首次启用同步时生成：

```text
device_id: 随机 UUID/ULID
device_name: 用户可编辑，例如 MacBook Pro
device_created_at
device_public_key: 未来可选
```

设备文件：

```json
{
  "deviceId": "dev_01h...",
  "deviceName": "MacBook Pro",
  "createdAt": 1779340800000,
  "lastSeenAt": 1779340800000,
  "appVersion": "0.1.8",
  "platform": "macos"
}
```

设备文件可以明文，也可以加密。第一版建议明文保留最小信息，方便用户识别设备和排查同步问题。

---

## 16. 新设备加入

新设备加入不需要账号。

方式一：手动配置

```text
选择后端
填写远端地址/目录
填写访问凭据
输入同步口令
拉取并解密 keyring
下载 snapshot + events
完成初始化
```

方式二：二维码 — **已弃用**

> 原设计是旧设备生成二维码,新设备扫码自动填入 backend kind / remote path /
> vault id。**该方式不在实现范围内**,新增设备只走"方式一:手动配置"。
> 取消理由:桌面端使用扫码体验拗,引入二维码依赖收益过小;手动配置同样能
> 满足新设备 join 的需求。

---

## 17. 后端适配

### 17.1 Local Folder

用于 iCloud Drive、Dropbox、Syncthing。

优点：

- 实现简单。
- 用户门槛最低。

注意：

- 需要处理同步软件尚未完成上传/下载时的临时状态。
- 写文件应采用临时文件 + rename。

### 17.2 SFTP

这是 ZeroTerm 最应该优先支持的后端。

用户流程：

```text
选择一个已保存主机
选择远端目录，例如 ~/.zeroterm-sync
设置同步口令
开始同步
```

优点：

- SSH 客户端用户天然有服务器。
- 不需要额外服务。
- 和产品定位高度一致。

注意：

- 需要支持递归 list。
- 写文件建议先写 `.tmp`，再 rename。
- compact 删除旧文件时要谨慎，失败可下次重试。

### 17.3 WebDAV

适配 Nextcloud、坚果云、NAS。

注意：

- 不同 WebDAV 服务对 ETag、MOVE、MKCOL 行为差异较大。
- 不应强依赖 WebDAV lock。

### 17.4 S3 Compatible

适配 AWS S3、Cloudflare R2、MinIO。

优点：

- 对象写入稳定。
- list prefix 适合仓库结构。
- 可以配置 lifecycle rule 辅助清理。

注意：

- 用户配置复杂度较高。
- R2/MinIO endpoint 和 path-style 需要 UI 支持。

---

## 18. 安全边界

后端泄露时：

- 攻击者能看到文件名、文件大小、更新时间、粗粒度记录类型。
- 攻击者不能解密 host、用户名、密码、私钥、snippet 内容。

同步口令泄露时：

- 攻击者可以解密同步仓库。
- UI 必须明确提示同步口令的重要性。

设备丢失时：

- 如果本地 vault 解锁密码强度足够，设备本地数据仍受保护。
- 远端同步仓库不依赖该设备。

忘记同步口令时：

- 无法在新设备解密同步仓库。
- 已解锁设备可以重新生成新的同步仓库。

---

## 19. UI 设计建议

设置页中同步入口应保持简单：

```text
Sync
  Status: Synced / Syncing / Offline / Conflict
  Backend: SFTP / Local Folder / WebDAV / S3
  Last synced
  Sync now
  Devices
  Conflicts
  Advanced
```

创建同步：

```text
1. 选择同步位置
2. 设置同步口令
3. 创建同步仓库
4. 上传当前数据
```

加入同步：

```text
1. 选择已有同步位置
2. 输入同步口令
3. 预览将导入的数据
4. 合并到本地 vault
```

高级设置：

```text
自动同步
空间上限
保留天数
手动清理
导出 recovery 信息
```

---

## 20. 触发时机

默认触发：

```text
应用启动并解锁后
应用回到前台
网络恢复后
本地记录修改后 debounce 3-5 秒
用户点击 Sync now
```

不需要实时强同步。SSH 客户端同步的目标是可靠收敛，不是协作编辑。

---

## 21. 实施阶段

### Phase 1: 同步仓库基础

- 定义 repository layout。
- 实现 Local Folder adapter。
- 实现 keyring 创建和解锁。
- 实现 record encrypt/decrypt。
- 实现 snapshot 创建和恢复。
- 实现手动 push/pull。

### Phase 2: SFTP 后端

- 基于现有 SFTP 能力实现 sync adapter。
- 支持递归 list/read/write/delete/rename。
- 支持 `.tmp` 写入再 rename。
- UI 支持选择已保存主机作为同步后端。

### Phase 3: 记录级同步

- 本地 store 增加 sync metadata。
- host/secret/tag/group/snippet 分离。
- 实现 dirty record diff。
- 实现 event 写入和 replay。
- 实现 tombstone。

### Phase 4: 冲突与清理

- 实现记录级冲突检测。
- 实现冲突 UI。
- 实现 compact。
- 实现仓库空间统计。
- 实现保留策略。

### Phase 5: WebDAV/S3

- WebDAV adapter。
- S3 compatible adapter。
- 后端连接测试。
- 高级配置和错误提示优化。

---

## 22. 与现有实现的关系

当前代码中已有的 `zeroterm-sync` adapter 可以继续复用后端抽象思路，但不应继续以单个 `sync-state.json` 作为最终协议。

建议迁移方向：

```text
当前 sync-state.json
  -> Phase 1 作为 legacy import/export
  -> 新同步使用 .zeroterm-sync repository
```

现有 vault 的 `records.version` 和 tombstone 设计可以保留并扩展到同步元数据。

---

## 23. 开放问题

- 第一版是否明文暴露 record kind？
- 是否需要 recovery key，而不是只依赖 sync passphrase？
- SFTP 同步是否允许使用当前 vault 中的 host secret？
- 如果同步后端凭据也来自同步数据，如何避免 bootstrap 循环？
- 是否允许多个同步仓库同时存在？
- 是否需要提供只同步 hosts、不同步 secrets 的模式？

---

## 24. 推荐决策

最终推荐方案：

```text
默认同步模型：文件仓库式 E2E 记录级同步
优先后端：SFTP + Local Folder
第二批后端：WebDAV + S3 Compatible
加密：sync_root_key + Argon2id-wrapped keyring + per-record HKDF
数据组织：snapshot + append-only events + compaction
冲突：记录级冲突，不做 CRDT
空间控制：默认 2 snapshots + 30 days events + 90 days tombstones
```

这套设计符合 ZeroTerm 的开源定位，也符合 SSH 客户端用户的真实使用方式：不需要账号，不需要额外部署服务，只需要一个自己掌控的文件存储位置。
