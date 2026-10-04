# RFC-004: ZeroTerm 堡垒机设计与实施方案（历史稿）

> 本文保留早期“ZeroTerm 为主入口”的设计记录。当前服务端以独立 Web 堡垒机为中心，权威设计为相邻仓库的 [zeroterm-terminal RFC-004](../zeroterm-terminal/docs/RFC-004-bastion-design.md)。本项目只负责 ZeroTerm 客户端；已实现的客户端行为、入口、契约差异与验证范围见 [堡垒机客户端接入](./docs/bastion-client.md)。下文待实现的服务端任务不属于本次客户端适配范围。


| 项目 | 内容 |
|---|---|
| 状态 | Draft，可作为第一版实现基线 |
| 日期 | 2026-10-04 |
| 适用对象 | 堡垒机后端、ZeroTerm Rust 核心、桌面端、Android 开发与测试人员 |
| 关联文档 | [项目说明](./README.md)、[整体架构](./RFC-001-architecture.md)、[同步设计](./RFC-002-sync-design.md)、[Android 设计](./RFC-003-android.md) |
| 实现状态 | 本文是设计；除明确标为现有能力的部分外，接口、类型、目录和配置均待实现 |

本文定义一个与 ZeroTerm 配合使用的自托管堡垒机。管理员在堡垒机配置目标 SSH 服务器及其账号凭据，用户在 ZeroTerm 登录堡垒机、选择授权资产即可连接。所有目标会话遵循 `ZeroTerm → 堡垒机 → 目标 SSH`，目标密码和私钥不下发给客户端。

设计采用 HTTPS 管理 API 与标准 SSH 会话代理。第一版保留 ZeroTerm 的交互终端、SFTP 和基于 exec 的服务器工具，提供用户授权、一次性连接票据、会话事件及终端输出录制。完整文件操作审计、精确命令控制、多节点高可用作为后续扩展。

文中的“必须”是实现约束，“默认”是可配置初始值，“建议”允许在保持协议与安全语义的前提下调整。容量和性能数字是验收目标，不是已测结果。

## 1. 需求与范围

### 1.1 核心用户流程

1. 管理员创建资产，例如生产应用服务器，并配置地址与 SSH 端口。
2. 管理员添加一个或多个目标账号，例如 deploy、ops，并录入密码或私钥及其口令。
3. 管理员审核目标主机密钥，分配用户对资产账号的访问能力。
4. 用户在 ZeroTerm 添加堡垒机 API 地址，登录自己的堡垒机账号。
5. ZeroTerm 展示可访问资产、可使用目标账号及能力。
6. 用户选择资产账号，打开终端、文件面板或服务器工具。
7. ZeroTerm 申请连接票据，连接 SSH 网关；网关用托管凭据登录目标并代理通道。
8. 管理员查看会话记录，必要时撤销授权并断开会话。

用户登录堡垒机的账号与目标系统账号是两个独立身份。登录用户 alice 可以被授权使用目标账号 deploy；目标系统是否具备 sudo 能力由目标账号自身决定。

### 1.2 第一版范围

| 功能 | 第一版行为 |
|---|---|
| 部署 | 单组织、单网关进程、自托管 Linux，PostgreSQL 持久化 |
| 用户 | 本地账号登录、密码修改、设备登录会话、注销、管理员停用 |
| 资产 | SSH 地址、端口、名称、标签、目标账号、主机密钥管理 |
| 目标认证 | 密码；PEM/OpenSSH 私钥与可选 passphrase |
| 授权 | 用户与资产账号的显式授权；shell、exec、sftp 能力 |
| 终端 | PTY、shell、尺寸变化、二进制数据、退出状态、取消与断开 |
| 文件 | SFTP subsystem 双向代理，兼容目标服务器支持的协议扩展 |
| 服务器工具 | 转发 exec；指标、Docker、systemd 等继续在目标执行 |
| 审计 | 管理变更、登录、票据、连接、通道、exec 请求、终端输出录制 |
| 客户端 | 桌面端完整接入；Android 复用同一核心与契约，随后交付 |

### 1.3 第一版不承诺的能力

- SSH 端口转发、SOCKS、X11、Agent 转发、任意 subsystem、网关登录 shell。
- Windows RDP、数据库代理、Kubernetes 登录、Mosh、多跳路由。
- SFTP 目录白名单、只读账户、逐项上传下载审计及文件内容检查。
- 交互式 shell 的精确命令识别或危险命令拦截。
- SSO、MFA、SSH 用户证书、外部 KMS、凭据自动轮换与多节点高可用。
- 在断线后恢复原来的 SSH 通道；持久任务使用目标上的 tmux 等机制。

第一版禁止某类协议能力，不代表阻止已获 shell/exec 权限的用户在目标系统执行等价程序。目标账号权限与目标网络策略共同决定实际访问边界。

## 2. 现有代码与改造依据

以下能力已从仓库代码确认；旧 RFC 的规划描述不作为当前实现状态依据。

| 现有位置 | 已有行为 | 本设计中的用途 |
|---|---|---|
| [host.rs](./core/crates/zeroterm-app/src/host.rs) | Host 持有目标地址、HostAuth 与 proxy_jump_host_id | 本地主机保持现有格式；新增独立堡垒机资源 |
| [session.rs](./core/crates/zeroterm-ssh/src/session.rs) | connect、connect_via、PTY、SFTP、exec、RTT 探测 | 客户端继续使用标准 SSH；补充结构化错误与连接抽象 |
| [connect.rs](./desktop/src-tauri/src/connect.rs) | 从本地 Vault 同步解析连接链 | 改为共享的异步连接编排入口 |
| [pool.rs](./desktop/src-tauri/src/sftp/pool.rs) | 按 host id 复用 SSH/SFTP，保存连接配置 | 改为按身份与目标隔离，失效后重新申请票据 |
| [commands.rs](./desktop/src-tauri/src/commands.rs) | 终端及服务器工具解析主机；指标等通过 exec 执行 | 所有目标功能接入统一入口，避免落到网关本机 |
| [facade.rs](./core/crates/zeroterm-ffi/src/facade.rs) | Android 等平台的会话、SFTP、exec 编排 | 暴露堡垒机登录、资产查询、连接方法 |
| [types.rs](./core/crates/zeroterm-ffi/src/types.rs) | HostInput/HostAuthInput 面向本地主机 | 增加独立连接目标类型，避免伪造本地凭据 |
| [sync.rs](./core/crates/zeroterm-app/src/sync.rs) | Vault 记录同步、冲突预览脱敏 | 新增记录需明确同步与脱敏边界 |
| [SessionManager.kt](./android/app/src/main/java/com/zeroterm/android/data/SessionManager.kt) | 移动会话生命周期 | 统一处理授权、重新登录、网络变化与重连 |

现有 ProxyJump 是 SSH-over-SSH：客户端通过跳板的 direct-tcpip 建立目标 SSH，仍由客户端认证目标。托管凭据方案由网关终止客户端 SSH，并建立独立目标 SSH，不能仅修改 proxy_jump_host_id 达成。[OpenSSH ProxyJump](https://man.openbsd.org/ssh_config#ProxyJump)

## 3. 架构与信任边界

```mermaid
flowchart LR
    Z[ZeroTerm 桌面或 Android]
    A[HTTPS API 与管理界面]
    G[SSH 网关与会话管理]
    D[(PostgreSQL)]
    K[服务端密钥文件]
    R[本地录制存储]
    T[目标服务器 SSH]
    Z -->|登录 资产 票据| A
    Z <-->|SSH shell exec SFTP| G
    A --> D
    G --> D
    G --> K
    G --> R
    G <-->|托管凭据认证| T
```

### 3.1 控制面

HTTPS API 负责用户认证、资产目录、凭据写入、权限管理、票据签发、会话查询和断开。管理界面调用同一 API，不能另行绕过权限逻辑。用户操作与管理操作都使用同一服务层与审计事务。

API 与 SSH 网关第一版运行在同一个进程，共享权限检查和活动会话注册表。PostgreSQL 是票据、授权和审计元数据的权威来源。第一版不引入 Redis，也不使用仅靠内存判断的一次性票据。

### 3.2 数据面

SSH 网关为每条已认证客户端连接建立一条独立的目标 SSH 连接，绑定唯一 `(user_id, login_session_id, asset_id, account_id)`。该连接内的 shell、exec、SFTP 通道映射到同一目标。第一版不在不同客户端连接或用户之间共享目标 SSH 连接。

一个终端连接可以承载多个通道；客户端 SFTP 池或后台指标也可以建立自己的网关连接。这些新连接必须各自获得新票据，并作为独立 connection_id 审计。

### 3.3 加密与信任

- ZeroTerm 验证 API 的 TLS 证书与 SSH 网关主机密钥。
- 网关验证目标 SSH 主机密钥，然后才向目标提交托管凭据。
- 两段网络分别加密，网关处理明文会话；这不是客户端到目标的端到端加密。
- 服务端凭据加密保护数据库及备份泄露；拥有网关进程控制权且能访问密钥的管理员仍可能获得凭据。
- ZeroTerm 原有 Vault E2E 同步与堡垒机托管凭据是不同机制，不能把服务端能力描述为现有 E2E 模型。

### 3.4 连接时序

```mermaid
sequenceDiagram
    participant Z as ZeroTerm
    participant A as API
    participant D as 数据库
    participant G as SSH 网关
    participant T as 目标 SSH
    Z->>A: 登录后申请资产账号票据
    A->>D: 检查身份 授权 限额 写入票据与 pending connection
    D-->>A: 提交成功
    A-->>Z: ticket_secret 网关入口 connection_id
    Z->>G: 校验网关主机密钥后提交 SSH password 票据
    G->>D: 锁定策略与票据 复核授权 原子消费
    D-->>G: connecting 已持久化
    G-->>Z: SSH 认证成功
    G->>T: 握手 校验目标主机密钥 托管凭据认证
    T-->>G: 目标认证成功
    G->>D: connection active
    Z->>A: 查询 connection 状态
    A-->>Z: active
    Z->>G: 打开 PTY shell 或 exec 或 SFTP
    G->>T: 权限检查后代理通道请求
    T-->>G: 启动成功
    G-->>Z: 请求成功 开始流式数据
```

## 4. 服务端模块与工程组织

建议新增 `bastion/` 独立 Cargo workspace，使服务器依赖不进入移动端构建。

```text
bastion/
  Cargo.toml
  crates/
    bastion-domain/      领域模型、能力、策略与错误
    bastion-store/       PostgreSQL、迁移、事务、票据原子消费
    bastion-secrets/     凭据加密、密钥版本、解密生命周期
    bastion-gateway/     russh server/client、多通道桥接、录制
    bastion-api/         HTTPS API、认证、OpenAPI、管理资源
    bastion-server/      单进程装配、配置、CLI、优雅停机
  web/                  管理界面，首版可用原生 HTML/CSS/JS
  migrations/
  tests/                OpenSSH 目标、协议集成与故障注入
  deploy/               容器部署示例、备份恢复与运维说明

core/crates/zeroterm-bastion/  API 客户端、DTO、票据申请，待新增
```

依赖方向：domain 不依赖 UI 或 SSH；store、secrets、gateway、api 依赖 domain；server 装配模块。客户端 zeroterm-bastion 不依赖任何服务端 crate，API 类型以 OpenAPI 契约对齐。

| 项目 | 默认选择 | 约束 |
|---|---|---|
| 语言与异步 | Rust + Tokio | 与客户端核心一致，遵循结构化取消 |
| SSH | 仓库已使用的 russh 及兼容补丁 | 协议行为须用真实 OpenSSH 验证 |
| HTTP | Axum，客户端 reqwest | 实施时选择并锁定兼容版本，提交 Cargo.lock |
| 数据库 | PostgreSQL + SQLx 迁移 | 不同时维护 SQLite 服务端实现 |
| 序列化 | serde，JSON snake_case | /api/v1 协议；客户端忽略未知非关键字段 |
| 加密 | Argon2id；XChaCha20-Poly1305 | 可复用现有 crypto 原语，服务器密钥生命周期独立 |
| 观测 | tracing、结构化指标 | 日志脱敏，凭据类型禁止派生明文 Debug |
| 录制 | 服务端专用目录 | 元数据入数据库，输出分块流式写文件 |

跨 workspace 使用现有 russh 时，必须在 `bastion/Cargo.toml` 根声明相同的 `[patch.crates-io]` 指向 `../core/vendor/russh`；依赖 crate 自己的 patch 不会自动成为另一个 workspace 的根 patch。不得无意引入两个行为不同的 russh 版本。

现有 `Session::exec()` 会收集输出，`open_shell()` 封装了固定终端参数。网关不能直接以它们实现无限流输出和完整协议代理；应实现服务端专用的流式通道桥接，复用密钥解析、主机校验原语或抽取公共逻辑，不复制桌面业务代码。

## 5. 服务端数据模型

所有资源 ID 使用 UUID，时间以 UTC RFC 3339 返回，客户端按本地时区显示。数据库更新时间使用 timestamptz；授权、票据过期统一由服务端时钟判断。表名为设计建议，实施迁移必须落实下列约束。

| 表 | 主要字段 | 必须落实的约束 |
|---|---|---|
| users | id, username, password_hash, role, enabled, auth_revision, timestamps | username 规范化后唯一；role 为 admin/operator/auditor |
| server_settings | server_id, policy_revision, schema_version | 单组织 singleton；授权事务与消费使用同一策略锁 |
| login_sessions | id, user_id, device_label, refresh_hash, family_id, revoked_at, expires_at | 关联设备登录；refresh 轮换与重放检测 |
| refresh_tokens | id, login_session_id, token_hash, state, expires_at, rotated_at, replaced_by | 保存轮换历史哈希至 family 到期，供重放检测 |
| access_tokens | token_hash, login_session_id, expires_at | 高熵 token 仅存 SHA-256 哈希；索引查询 |
| assets | id, name, host, port, tags, enabled, config_revision | port 1–65535；host 是地址，不能含命令或 URL scheme |
| target_accounts | id, asset_id, username, credential_id, enabled, config_revision | UNIQUE(asset_id, username)；凭据不可跨资产随意引用 |
| credentials | id, kind, ciphertext, nonce, wrapped_dek, wrap_nonce, key_version, revision | kind=password/private_key；所有密文字段非空 |
| asset_host_keys | id, asset_id, algorithm, public_key, fingerprint, state, approved_by | 只使用 approved；原公钥必须保存，指纹用于展示 |
| grants | id, user_id, asset_id, account_id, capabilities, enabled, expires_at | 账号必须属于指定资产；能力只允许已知枚举 |
| connection_tickets | id, secret_hash, login_session_id, user_id, asset_id, account_id, capabilities, gateway_id, revisions, state, expires_at, consumed_at, connection_id | secret_hash 唯一；connection_id 唯一；原子单次消费 |
| connections | id, ticket_id, identity fields, purpose, state, gateway_id, revisions, started_at, ended_at, reason, byte counters | ticket_id 唯一；一票据对应一连接；保留身份快照 |
| channels | id, connection_id, upstream_channel_id, kind, state, timestamps, exit_code, recording_id | UNIQUE(connection_id, upstream_channel_id) |
| recordings | id, channel_id, relative_path, format_version, bytes, checksum, state, retention_until, wrapped_dek, wrap_nonce, key_version, nonce_prefix, last_written_seq, last_synced_seq | 服务端生成路径；状态区分完整、异常结束、缺失；密钥用途独立 |
| audit_events | id, occurred_at, actor_id, action, resource_type, resource_id, request_id, sanitized_payload | 追加写；管理操作与审计记录同事务 |

账号资产一致性通过 `target_accounts UNIQUE(id, asset_id)` 加 `grants(account_id, asset_id)` 复合外键等数据库约束实现，不能只依赖 UI。资产与账号停用采用逻辑删除；连接和审计历史不能被级联删除。用户名、资产名的修改不重写历史快照。

迁移必须包含 token_hash 唯一索引、grants(user_id, asset_id, account_id)、connection_tickets(state, expires_at)、connections(user_id, state)、audit_events(occurred_at, id) 与 recordings(state, retention_until) 查询索引。枚举状态、能力集合去重、revision 单调递增及 nonce 长度应在数据库或明确的 store 校验层落实。refresh_tokens 是历史权威来源，login_sessions.refresh_hash 仅为当前版本冗余索引，更新时必须同事务。API 的通用 revision 映射到 user.auth_revision、asset/account.config_revision；其他可编辑资源需增加独立 revision。

### 5.1 授权语义

- operator 仅能访问显式授权的资产账号；auditor 能查看全局审计与录制，不能申请 SSH 票据。
- admin 能管理资源和断开会话，**仍需显式资产授权才可取得目标 SSH 连接**；管理权限不自动等于目标登录权限。
- 第一版 grant 是用户级 allow 规则，不实现群组继承或 deny 规则。多个有效 grant 的能力取并集。
- user、login_session、asset、account 必须均有效；grant 未过期且账号所属资产正确。
- 申请能力必须全部被允许，否则返回 403，不静默降权。
- 连接内有效能力是票据能力与当前权限的交集。授权扩大不提升旧连接能力；授权缩减按撤销流程关闭受影响连接。
- `purpose=metrics` 仅是审计用途标签，不赋予受限的只读语义。第一版 exec 权限允许执行任意目标命令。

shell 与 exec 都允许在目标运行程序，不能用“禁用 sftp”承诺用户无法通过 shell 传文件。真正只读或命令限制应由目标受限账号或后续专门执行服务实现。

### 5.2 修订号

users.auth_revision、assets.config_revision、target_accounts.config_revision 与服务端全局 policy_revision 用于使票据和客户端缓存失效。授权修改在同一事务提升 policy_revision。票据保存签发时各修订号，消费时任一变化即返回 TICKET_STALE，客户端重新申请。

已有会话不因无关授权变更全部断开，而是对变更影响的 user/asset/account 重新计算权限。凭据轮换默认不关闭已建立目标连接，但旧未消费票据失效，新连接使用新版本。主机密钥删除、资产目标地址变化默认关闭该资产旧连接，防止用户误认连接目标。

## 6. 用户登录与凭据保护

### 6.1 本地账号认证

首次部署使用服务端 CLI 创建管理员，密码从交互 stdin 读取；禁止默认密码和在启动参数中传密码。用户密码使用独立随机 salt 的 Argon2id PHC 格式保存，不可逆加密。初始参数建议沿用现有 crypto 的 64 MiB 内存级别，并在部署硬件上压测，限制并发验证任务，避免登录请求耗尽内存。

客户端通过 HTTPS 提交用户名、密码与设备标签。登录响应包含 access_token、refresh_token、login_session_id 和用户角色。access_token 默认 10 分钟；refresh_token 默认最长 7 天，到期重新登录。

两类 token 都是至少 32 字节密码学随机数的 base64url 无填充文本。数据库只存 SHA-256 哈希，不使用可脱离数据库验证的 JWT，便于停用和注销立即阻止新请求。API access token 与 SSH 票据不能互换。

刷新在事务中轮换 refresh token，撤销旧 token；保留旧哈希用于检测重放，重放时撤销该登录会话整个 family。客户端按登录会话 singleflight 刷新，禁止多个后台任务同时刷新同一 token。刷新响应丢失后不自动反复提交旧 refresh，转为重新登录。

停用用户、修改密码时撤销该用户全部 login_sessions、access_tokens 和未消费票据，并关闭其活动连接。普通注销默认只撤销当前 login_session 及对应活动连接；“注销所有设备”明确作用于全部会话。

用户角色变更提升 auth_revision，撤销旧登录会话与活动连接，要求重新登录，使管理权限缩减立即生效。API 每次查询 token 时均检查 login_session 与 user 状态，不仅检查 token 自身 expires_at。

默认登录限制为每 IP 每分钟 10 次、每规范化用户名每分钟 5 次失败；失败使用统一响应与退避，不暴露用户是否存在。限流是默认起点，需支持配置与可信反向代理地址规则。

MFA 后续通过 API 登录流程扩展，不依赖 ZeroTerm 当前尚未封装的 SSH keyboard-interactive。第一版不能宣传具备 MFA。

### 6.2 目标凭据加密

每个 credential 使用随机 32 字节 DEK 加密密码或私钥 JSON，使用 XChaCha20-Poly1305 与随机 24 字节 nonce；再用版本化 KEK 加密 DEK，wrap_nonce 独立随机生成。AAD 绑定组织标识、credential_id、kind、revision；包装 AAD 另加固定用途标识，防止交换密文记录。

KEK 存在独立挂载文件，权限 0600，目录 0700，不入数据库、镜像、日志或代码仓库。配置保存文件路径与 key_version，不保存密钥文本。启动时校验密钥长度、权限、所有者；生产模式无法读取密钥则拒绝启动。

解密只在目标连接认证期间进行，尽快释放并使用 zeroize 降低残留；第三方库内部副本的清零能力需评估，不能承诺所有副本绝无残留。不得为方便连接池长期缓存明文密码或私钥。

凭据管理 API 只提供写入、替换、类型及修订元数据，不提供读取明文或导出功能。测试连接也只能返回结构化结果。审计记录“凭据已替换”，不记录新旧内容。

KEK 轮换先写入新密钥版本，再逐条重包 DEK；全部迁移与备份验证后才移除旧 KEK。重包更新 key_version 与 wrap_nonce，避免改变数据密文 AAD。凭据替换则生成新 DEK 与完整密文。密钥备份必须与数据库备份分开保管，并在恢复演练中验证二者匹配。

## 7. HTTPS API 契约

### 7.1 通用约定

- 路径以 `/api/v1` 开头，JSON Content-Type；字段 snake_case。
- 认证使用 `Authorization: Bearer <access_token>`；管理浏览器第一版仅在内存保存 token，使用 Authorization 调用同源 API，不写 localStorage。
- 响应提供 `X-Request-Id`；错误返回稳定 code、脱敏 message 和 request_id。
- HTTPS 强制证书校验；私有 CA 通过明确配置的证书文件导入，不提供默认跳过校验开关。
- token、票据响应带 `Cache-Control: no-store`；token 不放 URL、Referer 或浏览器下载链接。
- CORS 默认关闭跨源访问；管理界面静态资源同源部署；使用严格 CSP 和输出编码防止 XSS。
- 列表使用不透明 cursor，默认 50、最大 200；按 `(created_at, id)` 稳定分页，服务端始终过滤权限。
- 管理更新使用资源 revision 与 `If-Match: "<revision>"`；缺失返回 428，冲突返回 412。
- 网络重试只自动用于 GET 等安全读取。票据签发、凭据写入、刷新都不盲目重放。

错误示例：

```json
{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "当前账号没有该资产账号的连接权限",
    "request_id": "req-7f13"
  }
}
```

### 7.2 API 清单

| 方法与路径 | 权限 | 输入与返回 |
|---|---|---|
| GET /info | 匿名 | server_id、protocol_version、最低客户端协议、网关公开入口与主机公钥；不含资产 |
| POST /auth/login | 匿名，限流 | username/password/device_label → 用户与 token |
| POST /auth/refresh | refresh token | 轮换 token，不接受 access token 代替 |
| POST /auth/logout | 已登录 | 撤销当前登录会话，幂等 |
| POST /auth/logout-all | 已登录 | 撤销本人全部设备登录及活动连接 |
| GET /me | 已登录 | 用户、login_session_id、policy_revision |
| GET /assets | operator/admin | 已授权资产元数据、允许的目标账号与各账号能力 |
| GET /assets/{asset_id} | 有资产权限 | 资产详情；无权限与不存在统一 404 |
| POST /connection-tickets | operator/admin 且有授权 | asset_id/account_id/capabilities/purpose → 一次性票据与 connection_id |
| GET /connections/{id} | 连接所有者/admin/auditor | 状态、故障 code、通道摘要；不含凭据 |
| GET /connections | 自己；admin/auditor 可全局 | 可分页连接列表 |
| POST /connections/{id}/disconnect | 所有者/admin | 原因、request_id；请求关闭，返回 202，已关闭返回当前状态 |
| GET /recordings/{id}/content | 所有者/admin/auditor | 受鉴权的输出录制流，不接受路径参数 |
| GET /audit-events | admin/auditor | 时间、actor、资源等过滤与分页 |
| POST /admin/users | admin | 用户创建，首次密码或受控重置流程 |
| PATCH /admin/users/{id} | admin | 启停、角色等，带 If-Match |
| POST /admin/users/{id}/reset-password | admin | 替换密码并撤销该用户全部登录，带 If-Match，记录审计 |
| POST /me/password | 本人 | 当前密码、新密码；成功撤销本人全部会话 |
| GET/POST /admin/assets | admin | 列表、创建资产 |
| PATCH /admin/assets/{id} | admin | 名称、地址、端口、标签、启停，带 If-Match |
| POST /admin/assets/{id}/accounts | admin | 创建目标账号与凭据；响应只含元数据 |
| PATCH /admin/accounts/{id} | admin | 用户名、启停，带 If-Match |
| PUT /admin/accounts/{id}/credential | admin | 替换密码或私钥，带 If-Match；禁止明文 GET |
| POST /admin/assets/{id}/host-key-scan | admin | 无凭据握手，返回待审核公钥，不自动信任 |
| POST /admin/assets/{id}/host-keys | admin | 批准扫描候选或导入已核验公钥 |
| DELETE /admin/assets/{id}/host-keys/{key_id} | admin | 撤销受信任密钥、提升修订、关闭相关连接 |
| POST /admin/accounts/{id}/test | admin | 校验目标密钥与认证，可选固定探测命令，审计 |
| GET/POST /admin/grants | admin | 查询、创建用户资产账号授权 |
| PATCH/DELETE /admin/grants/{id} | admin | 更新或撤销授权，事务审计，通知活动连接 |

每个管理资源都需要 GET 详情返回 revision；表中的列表/详情可在 OpenAPI 中展开。DELETE 对 grant 是逻辑撤销。资产与账号通过 enabled=false 停用，第一版不提供级联物理删除。

管理 API 的创建输入要求如下；密钥与密码仅出现在受 HTTPS 保护的写入请求中：

| 资源 | 必需字段 | 校验 |
|---|---|---|
| user | username, password, role | username 1–64 字符，规范化唯一；密码 12–1024 UTF-8 字节，不截断 |
| asset | name, host, port | name 1–128 字符；host 为 IP 或合法 DNS 名，IPv6 输入不带 URL 方括号 |
| target account | username, credential | username 1–128 UTF-8 字节，拒绝 NUL/控制字符；不插入本地 shell 命令 |
| password credential | type=password, password | 原值不 trim，1 字节至 16 KiB，第一版拒绝空密码 |
| private key credential | type=private_key, key_pem, passphrase 可选 | 不超过 128 KiB；写入前解析并校验口令；不存私钥路径 |
| grant | user_id, asset_id, account_id, capabilities | 能力非空，集合只含 shell/exec/sftp；账号资产一致 |
| host key approval | algorithm, public_key, candidate_id 可选 | 公钥解析、算法一致、候选属于本资产；不只接收指纹 |

用户密码初始下限为产品策略，可按部署修改；不强制周期性改密。初次创建或重置密码由管理员通过可信渠道交付，界面不回显已有密码。目标用户名是 SSH 原始认证字段，不通过 `ssh user@host` 命令字符串拼接。

资产返回示例，地址可由服务端隐藏，客户端连接不依赖目标 host：

```json
{
  "items": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "生产应用服务器",
    "tags": ["production", "linux"],
    "revision": 3,
    "accounts": [{
      "id": "22222222-2222-4222-8222-222222222222",
      "username": "deploy",
      "capabilities": ["shell", "exec", "sftp"]
    }]
  }],
  "next_cursor": null,
  "policy_revision": 12
}
```

### 7.3 票据申请

```http
POST /api/v1/connection-tickets
Authorization: Bearer <access_token>
Content-Type: application/json
```

```json
{
  "asset_id": "11111111-1111-4111-8111-111111111111",
  "account_id": "22222222-2222-4222-8222-222222222222",
  "capabilities": ["shell", "exec", "sftp"],
  "purpose": "terminal"
}
```

成功返回 201，ticket_secret 仅在本次响应出现：

```json
{
  "protocol_version": 1,
  "ticket_id": "33333333-3333-4333-8333-333333333333",
  "ticket_secret": "<32随机字节的base64url文本>",
  "connection_id": "44444444-4444-4444-8444-444444444444",
  "expires_at": "2026-10-04T08:00:30Z",
  "gateway": {
    "id": "gateway-main",
    "host": "bastion.example.com",
    "port": 2222,
    "username": "zt1:33333333-3333-4333-8333-333333333333"
  },
  "capabilities": ["shell", "exec", "sftp"]
}
```

上例 ID 与 token 是示意。有效期默认从数据库签发时间起 30 秒。客户端拿到票据后立即连接，票据到期不使已认证连接到期。连接时长另由策略控制。

purpose 枚举为 terminal/sftp/metrics/server_tool，只有审计意义。服务端根据 capability 决策，不能信任 purpose 推断命令安全。

票据创建事务同时建立 pending connection 记录；SSH 连接完全没到达也可在过期清理时标记为 expired。响应丢失后客户端可以重新申请，旧票据自然过期；服务端限额包含尚未过期的 pending 记录，防止无限签发。

## 8. SSH 认证与票据状态机

### 8.1 网关协议

第一版只接受 SSH `password` 认证承载一次性票据，遵循 SSH 密码认证消息格式。[RFC 4252](https://www.rfc-editor.org/rfc/rfc4252#section-8)

```text
SSH server: gateway.host:gateway.port
SSH username: zt1:<ticket_id>
SSH password: ticket_secret
```

username 不直接携带目标 host 或目标账号。服务端只从已存储票据查出目标，避免客户端修改用户名选择其他地址。`none` 认证必须拒绝并只公布 password；publickey 探测、keyboard-interactive 与旧版用户名格式均拒绝，不消费票据。

password 回调中的票据哈希比较、权限复核、原子消费与 connection 状态转移在事务内完成。未知 ticket、错 secret、过期、已消费、撤销或修订变化均拒绝 SSH 认证，不通过认证差异泄露资源信息。详细失败 code 仅可经已鉴权的连接查询获得。

### 8.2 签发与消费

```mermaid
stateDiagram-v2
    [*] --> issued
    issued --> consumed: 正确秘密且权限有效 原子消费
    issued --> expired: 到期
    issued --> revoked: 登录或授权撤销
    issued --> revoked: 配置修订变化
    consumed --> [*]
    expired --> [*]
    revoked --> [*]
```

票据按 ID 行锁检查。错误 secret 不得消费真实票据，记录限流事件即可。消费必须事务化，不能“先 SELECT 判断，再异步 UPDATE”；下面 SQL 是关键操作示意，实际事务还必须锁定相关策略版本并复核授权：

```sql
UPDATE connection_tickets
SET state = 'consumed', consumed_at = clock_timestamp()
WHERE id = $1
  AND secret_hash = $2
  AND state = 'issued'
  AND expires_at > clock_timestamp()
RETURNING connection_id, user_id, asset_id, account_id, capabilities;
```

只有影响一行才能接受认证。授权修改与消费遵循固定锁顺序：policy revision 行 → user/login_session → asset/account → ticket，消费事务在锁内重读权限，避免撤销与接受交叉。票据消费后，connection 从 pending 转为 connecting；两次并发正确提交只能产生一个成功连接。

过期检查使用 PostgreSQL clock_timestamp() 的实际检查时间，不能以长时间等待行锁之前的事务开始时间放行已过期票据。事务总超时默认 2 秒，超时回滚且不接受认证；授权有效期与登录过期也在锁内按当前时间复核。[PostgreSQL 时间函数](https://www.postgresql.org/docs/current/functions-datetime.html)

事务提交但 SSH 认证响应丢失时，票据仍保持 consumed，不能恢复 issued。重连必须重新申请；目标连接失败、握手失败、网关崩溃都不恢复票据。

### 8.3 目标连接建立

认证成功后注册不可变连接上下文并启动目标连接任务。依次执行地址策略、DNS 解析、TCP、目标 SSH 握手、主机密钥校验、凭据解密及认证。成功后状态 active，失败则 failed 并关闭上游连接。

上游在 connecting 时的通道请求等待目标初始化，受超时与限额约束，不允许无界排队。票据认证成功不代表目标认证成功；UI 直到 shell、SFTP 或 exec 启动成功才显示“已连接目标”。失败信息通过 connection_id 查询，不能把私钥口令或目标认证协议原文直接返回用户。

网关响应 password 认证前必须确认初始连接记录和审计持久化成功；若数据库故障则拒绝。目标握手期间不持有数据库事务、全局锁或服务端整个 SSH Handler 锁。

## 9. SSH 通道代理规范

SSH session channel 可以启动 shell、exec 或 subsystem，每个 channel 仅允许一个启动请求成功；通道有独立标识、窗口与关闭语义。[RFC 4254](https://www.rfc-editor.org/rfc/rfc4254#section-5)

### 9.1 通道映射与请求矩阵

维护 `(upstream_connection_id, upstream_channel_id) → downstream_channel_id`，两端 channel id 不能假定相等。每个通道有独立状态与取消令牌，绝不能跨连接复用映射。

| 请求或事件 | 第一版处理 |
|---|---|
| channel_open session | 检查连接有效与通道限额，建立本地 pending 通道 |
| pty-req | 要求 shell 能力；转发终端名、尺寸与 terminal modes，使用独立目标通道 |
| shell | 要求 shell 能力，转发启动结果；首个终端输出来自目标 |
| exec | 要求 exec 能力；转发原始 command bytes，记录脱敏请求摘要 |
| subsystem sftp | 要求 sftp 能力，目标请求成功后开始原始字节流桥接 |
| env | 启动前允许 LANG、LC_ALL、LC_CTYPE 白名单与长度检查；拒绝其他变量 |
| window-change | 已有 PTY 才转发，尺寸做范围检查；不修改数据流 |
| signal | 转发合法 SSH signal 名称；不在网关本地执行 kill |
| data | 原始字节双向转发，不做 UTF-8 解码、换行转换或 ANSI 清洗 |
| extended-data | 转发原类型，至少保留 stderr 类型 1 |
| exit-status / exit-signal | 向上游保留退出信息，再完成关闭握手 |
| EOF | 对向发送 EOF，标记半关闭；继续排空另一方向输出 |
| close | 两端幂等关闭，回收映射；不得关闭同连接其他正常通道 |
| direct-tcpip / tcpip-forward | 第一版明确拒绝，不能变成任意网络代理 |
| X11 / Agent / 其他 subsystem | 明确拒绝并审计，不退回网关 shell |
| 未知 want_reply 请求 | 返回失败；无 want_reply 时不发额外成功响应 |

PTY 申请与 shell 启动可能是两个请求；上游 pty-req 的响应取决于目标实际响应。env 可以暂存于有界 pending 通道，建立目标通道后按顺序提交。若目标不支持 env，可返回失败但不破坏客户端后续正常启动。

对带 want_reply 的请求只在目标完成或明确拒绝后回复，不能无条件 success。SSH 层不支持任意失败文本字段时，通过连接状态 API 展示稳定原因。

### 9.2 状态与调度

```text
allocated → configuring → starting → streaming → draining → closed
      任意非终态 → failed → closed
```

每通道最多一个启动任务；shell/exec/subsystem 重复请求返回失败。异步任务等待目标与流控，不阻塞其他通道。读取循环、写入循环与审计写入通过有界队列协作，按字节量限制内存，不能仅限制消息个数。

每通道两方向初始各限 256 KiB 应用缓冲，分块最大 32 KiB；每连接所有通道应用缓冲总计默认不超过 16 MiB。russh 协议窗口与内部缓冲另需测量和限制，不能把应用队列上限当成进程总内存上限。队列满时暂停读取，遵循窗口背压，不丢数据。

EOF 不等于 close：目标可能在收到 stdin EOF 后仍输出结果。必须排空可读方向并保留退出状态，才能 close。目标返回 EOF 后不能立即取消仍在途的 exit-status/exit-signal。close 与取消竞态通过 once 状态转移处理。

### 9.3 SFTP 与 exec 边界

SFTP v1 在完成目标 subsystem 请求后直接桥接字节流，文件数据不进入终端录制。因不解析请求，第一版只记录 SFTP 通道及流量，不能宣称具备文件级审计、只读、目录限制或文件删除拦截。未经授权的 subsystem 直接失败。

exec 使用流式桥接，必须区分 stdout、stderr 与退出码；命令可很长且含用户秘密。exec 审计默认只记录 command 长度和 SHA-256，不保存原始完整命令。可选摘要功能默认关闭；明确开启后先脱敏，最多 4 KiB，并告知脱敏不保证识别所有秘密。自定义命令权限依赖目标账号；服务器工具取得 exec 即有相同执行能力。

### 9.4 RTT 与空通道

ZeroTerm 当前 probe_rtt_ms 打开一个 session channel 后立即关闭，不启动程序。网关须允许这种已授权连接上的空通道；在 pty/shell/exec/subsystem 真正请求前不创建目标 channel，避免每几秒消耗目标 MaxSessions。

空通道不创建终端录制，事件按连接计数聚合。此 RTT 只测 ZeroTerm 到网关的通道往返，UI 必须标为“网关延迟”；目标连接耗时或链路探测应单独展示，不能冒充完整链路延迟。

## 10. 生命周期与权限撤销

### 10.1 连接状态

```mermaid
stateDiagram-v2
    [*] --> pending: 票据签发
    pending --> connecting: SSH 认证消费票据
    pending --> expired: 票据到期
    pending --> revoked: 撤销未消费票据
    connecting --> active: 目标 SSH 认证成功
    connecting --> failed: 目标初始化失败
    connecting --> closing: 撤销或客户端取消
    active --> closing: 断开 超时 撤销 链路故障
    closing --> closed: 通道清理与审计完成
    active --> interrupted: 网关进程异常结束
    connecting --> interrupted: 网关进程异常结束
```

closed/failed/expired/revoked/interrupted 都是终态，不能恢复为 active。客户端重连生成新的 ticket_id 与 connection_id，原有窗口可保留终端滚动历史，但不能将新旧会话录制拼成一个服务端会话。

### 10.2 撤销步骤

管理事务按顺序修改授权或资源状态、提升相应修订、撤销未消费票据、追加 audit_event。提交成功后通知进程内活动会话注册表，对受影响连接重新计算当前权限，取消 connecting 任务、关闭相关 active 连接。权限缩减即使只移除一个 capability，也关闭该连接并让客户端按新能力重新连接。

连接在注册后立即复核授权和修订，处理“事务已消费，但尚未进入注册表时管理员撤销”的竞态。新通道启动前再次复核；后台每 2 秒复查活动连接权限，补偿通知丢失。票据成功消费也不允许绕过此复查。

第一版正常运行时，撤销提交至相关连接开始关闭的验收目标为不超过 3 秒。这不是对已在目标开始执行的命令的事务撤回：短命令可能已经完成，已脱离 SSH 的后台进程不会保证退出。严格阻止目标进程继续执行需后续受控执行环境。

断开动作在网关停止接受新数据，向两端发送关闭，取消代理任务并回收目标连接。数据库不可用时禁止新连接及新通道；现有连接最多允许 5 秒权限复核故障宽限，随后关闭，不能永久凭缓存放行。

### 10.3 登录与客户端锁定

access_token 到期不自动断开已有 SSH；refresh/login_session 被撤销、用户停用、授权过期则按撤销流程关闭。到期连接另有 absolute session limit。

ZeroTerm Vault 手动锁定或堡垒机注销时，清除内存 access/refresh/票据并关闭该堡垒机的活动连接和池。单纯切换窗口或 Android 退到后台不注销，仍遵循已有前台服务保活与系统限制。

### 10.4 进程退出与启动恢复

优雅停机先停止签发票据和接受新 SSH，readiness 返回失败；给管理请求与审计写入最长 10 秒收尾，再关闭活动连接。数据库连接状态与录制完成状态独立保存，不能只写“正常完成”。

启动获得单网关运行锁，扫描本 gateway_id 的 connecting/active/closing 记录，标记 interrupted，封存未完成录制并追加恢复事件。第一版部署一个副本；多进程共享同一 gateway_id 不受支持，启动必须拒绝第二实例。

## 11. 主机校验与目标地址策略

### 11.1 网关身份

HTTPS `/info` 提供 server_id 与网关入口用于发现，不是目标授权。客户端配置绑定稳定 server_id；API 返回另一个 server_id 时显示配置异常，不默默替换原身份。

网关 SSH 主机私钥首次部署生成并持久化，升级及容器重建不能自动重置。ZeroTerm 沿用已知主机校验：未知密钥展示 host、port、算法与指纹，用户通过管理员提供的独立渠道核验；密钥变更阻止自动连接，需明确审核后更新。

TLS API 返回的网关公钥可作为核对信息，但第一版不无条件写入 known_hosts。HTTP 代理仅改变底层运输，不能关闭 TLS 或 SSH 身份校验。网关入口变更后重新校验入口主机密钥。

### 11.2 目标主机密钥

资产创建后，管理员扫描得到候选公钥，与目标控制台或其他独立来源指纹对照，再批准入库。扫描只做 SSH 握手，不提交目标凭据。未知密钥、密钥不一致、受信任列表为空均阻止用户连接，返回 TARGET_HOST_KEY_UNKNOWN/CHANGED。

批准的是具体公钥，可同时保留多个已核验算法/轮换密钥；不能仅保存一条指纹字符串后接受任意算法。批准、删除与轮换都写审计并提升资产修订。目标握手的校验回调必须先成功，才执行密码或私钥认证。

### 11.3 地址与出站边界

管理员可配置资产 host，但用户不能通过票据提交任意 host/port。默认出站 CIDR allowlist 由部署配置明确给出，只允许实际目标网段；denylist 优先拒绝云元数据、回环与 link-local，不能用“所有内网地址都安全”作为假设。

每次连接解析 DNS，检查所有候选 IP 的出站规则，只向允许的解析结果创建 TCP socket；SSH 拨号使用选定 IP，不再次以原 hostname 解析，避免 DNS rebinding。逻辑资产身份仍按 asset_id 校验其批准公钥。无允许地址返回 TARGET_ADDRESS_DENIED。

目标防火墙或安全组限制 SSH 仅接受堡垒机地址；若用户还持有目标凭据且有直连网络，堡垒机无法单独消除绕过路径。

## 12. 审计与终端输出录制

### 12.1 审计事件

默认记录以下结构化事件：user.login_success/login_failure/logout/disabled、credential.created/replaced、host_key.approved/revoked、grant.created/updated/revoked、ticket.issued/consumed/rejected、connection.connecting/active/failed/closed/interrupted、channel.started/closed、exec.requested、recording.failed/viewed。

每条事件包含 actor、login_session_id、connection_id、asset/account 身份快照、request_id、源地址与稳定 reason_code。匿名失败不写用户不存在的详细原因。管理写入与事件同事务；连接接受前的关键事件持久化失败则拒绝连接。

运行日志不含密码、私钥、passphrase、access/refresh token、ticket_secret 或原始授权头。HTTP 请求体采集默认关闭；数据库 bind 参数日志禁用；secret 类型手写 Debug。源 IP 只接受直接 socket 或显式 trusted_proxy_cidrs，不能任意信任 X-Forwarded-For。

### 12.2 录制范围与格式

第一版录制已授权 shell 通道的**目标输出与终端尺寸事件**，不主动录制键盘输入，不录制 SFTP 二进制，不默认保存 exec stdout/stderr。目标回显可能仍包含用户命令与敏感文本，因此录制本身必须受保护，不能承诺彻底脱敏。

不录制输入意味着密码提示期间未回显的输入不会被主动采集，但也不具备完整输入取证能力。需要完整双向录制时另行扩展策略、展示用户告知并评估敏感数据范围。

每个 shell channel 创建独立 recording_id。内部逻辑事件格式 v1：

```json
{
  "seq": 1,
  "elapsed_us": 12345,
  "type": "output",
  "stream": "stdout",
  "data_base64": "aGVsbG8NCg=="
}
```

其他 type 为 meta（format_version、term、cols、rows）、resize（cols/rows）、exit（exit_code/exit_signal）、end（reason）。时间使用通道单调时钟的 elapsed_us，seq 从 0 严格递增；原始字节以 base64 表示，回放解码后逐块送入终端模拟器，不能逐块 UTF-8 解码。初始 PTY 尺寸写入首个 meta 事件，output 示例的 seq=1 表示其后第一条输出。

存储格式 `.ztrec` 为版本头与加密分块，头包含 format_version、recording_id、算法与随机 nonce prefix。每份录制生成独立 DEK，由 KEK 包装后存入 recording 元数据；使用用途 AAD，与目标凭据 DEK 隔离。外层 XChaCha nonce 为随机 16 字节 prefix + u64 分块序号，AAD 绑定头哈希、recording_id、序号；同 DEK 不得重用序号。

第一版文件字节布局固定如下，整数为大端；不压缩，禁止在解析器中猜测其他格式：

```text
file = magic[8] + header_length[u32] + header_json[header_length] + frame*
magic = ASCII "ZTREC001"
header_json = {format_version:1, recording_id:UUID文本,
               algorithm:"XChaCha20-Poly1305", nonce_prefix:base64url文本}
frame = chunk_seq[u64] + ciphertext_length[u32] + ciphertext[ciphertext_length]
nonce = decode(nonce_prefix)[16] + chunk_seq[u64]
aad = ASCII "zt-record-v1" + SHA256(magic + header_length + header_json)
      + recording_uuid原始16字节 + chunk_seq[u64]
plaintext = 一条或多条完整事件JSON行，每行以 LF 结束
```

header_length 最大 16 KiB；chunk_seq 从 0 连续递增，与事件 seq 是不同计数。ciphertext_length 包含 16 字节 AEAD tag，最大为 256 KiB + 16；数据库 last_written_seq/last_synced_seq 指分块序号。头字段与数据库 recording_id/nonce_prefix 必须一致；长度超限、序号跳变、认证失败或尾部不完整均标记 partial/corrupt，不继续解码不受信数据。

`GET /recordings/{id}/content` 由服务端鉴权、解密和校验后返回 `application/x-ndjson` 事件流，带 no-store；不向浏览器下发 DEK/KEK。第一版不支持 Range 和随机事件跳转，回放按流推进。文件损坏不能把已显示前缀伪装成完整录制，响应中断后 UI 显示校验失败。API JSON 普通 body 上限不适用于这个受控流式响应。

每块明文不超过 256 KiB；输出事件原始数据不超过 32 KiB；写入批次最多等待 250 ms。文件异常后封存，不在重启时沿用同密钥从未知序号追加。final checksum 与 bytes 入库用于故障检查，不声称能抵抗已控制网关管理员对文件和数据库的共同篡改。

### 12.3 录制可靠性

第一版 shell 的 output_recording 固定为 required。启动 shell 前必须成功创建 recording 元数据与文件。输出先进入有界录制队列并由写入任务确认已写入文件，再向客户端发送；磁盘慢触发背压，持续超过 5 秒或磁盘错误则关闭该 shell，并将录制标为 failed/partial，不能继续提供未记录的 shell。

“写入文件”不是每块都 fsync；默认每秒同步一次，并在正常结束时同步后封存。主机掉电可能丢失最近约一个同步周期，实际文件系统保证需部署验证。严格逐事件持久性属于后续可选模式，会降低性能。metadata 记录最后确认序号和同步序号，异常恢复只承诺可校验的已落盘前缀。

录制解析失败或权限不足不能退回公开文件路径。下载使用 recording_id 查数据库、校验所属连接与访问角色，再解析受控相对路径；拒绝符号链接和目录穿越。每次读取审计，管理界面回放在终端模拟器中展示，不把输出作为 HTML 执行。

默认录制保留 30 天、结构化事件 180 天，均可配置。清理任务按元数据删除文件并标记 expired，保留删除事件；缺文件标为 missing 并告警。清理不能删除 active 录制；达到磁盘低水位时停止接受新 shell，现有 shell 按失败策略关闭。

## 13. ZeroTerm 客户端数据与连接编排

### 13.1 独立数据类型

保持现有 `Host` 与 HostAuth 的 JSON 兼容，新资源不伪装成带空密码的 Host。新增 Vault record kind 为 `bastion_profile` 与 `bastion_bookmark`，DTO 示意：

```rust
// 设计接口；尚未实现，不是可直接粘贴编译的代码。
pub struct BastionProfile {
    pub id: String,
    pub name: String,
    pub api_url: String,
    pub expected_server_id: Option<String>,
}

pub struct BastionBookmark {
    pub id: String,
    pub profile_id: String,
    pub asset_id: String,
    pub account_id: String,
    pub display_name: String,
}

pub enum ConnectionTarget {
    LocalHost { host_id: String },
    BastionAsset {
        profile_id: String,
        asset_id: String,
        account_id: String,
    },
}

pub enum ConnectionPurpose { Terminal, Sftp, Metrics, ServerTool }

pub struct PoolKey {
    pub profile_id: String,
    pub server_id: String,
    pub user_id: String,
    pub login_session_id: String,
    pub asset_id: String,
    pub account_id: String,
    pub capability_set: Vec<String>,
    pub auth_epoch: u64,
}
```

访问 token、refresh token 与票据不放进 Profile/Bookmark，不参与同步。access_token 在 Rust 内存；refresh_token 默认仅在当前进程内存。用户选择“记住登录”时使用现有系统安全存储机制，Android 经 Keystore 封装，与 Vault 主密码条目分开。票据始终只在 Rust 内存短时存在，不传入 JS、Compose UI 或日志。

资产列表缓存是带 `server_id/user_id/login_session_id/fetched_at` 的设备本地缓存，必要持久化时加密。可缓存名称与授权摘要，不缓存目标凭据。离线可显示收藏，但连接必须取得服务器实时票据；缓存不是授权依据。账号切换立即清理前用户缓存。

### 13.2 共享连接服务

新增 zeroterm-bastion 封装 API，zeroterm-app 或独立共享编排模块依赖它。公共连接入口示意：

```rust
// 设计接口；已成功的 Session 才能返回到功能层。
async fn open_connection(
    target: ConnectionTarget,
    purpose: ConnectionPurpose,
    capabilities: CapabilitySet,
    cancel: CancellationToken,
) -> Result<EstablishedConnection, ConnectionError>;
```

本地主机路径保留现有 Vault → ConnectConfig → 可选 ProxyJump。堡垒机路径为读取 profile/身份 → 必要时刷新 access token → 实时申请票据 → 校验网关入口/密钥 → 创建仅含 Password(ticket_secret) 的短命 ConnectConfig → SSH 认证 → 确认目标初始化成功。

`open_connection` 在 SSH 认证后查询 connection_id，轮询间隔从 200 ms 退避至 1 秒，直到 active 或终态，总等待不超过 45 秒；只在建立阶段轮询，不对已活跃连接持续按该频率查询。active 后返回 EstablishedConnection，功能层再开 shell/SFTP/exec 通道；该通道启动成功后 UI 才进入最终就绪状态。任何阶段取消都关闭已取得的 SSH Session，服务端据断开收尾。

`EstablishedConnection` 包含 SSH Session、连接目标、有效能力、服务端 connection_id 与取消句柄，不含可复用的票据。不能将含票据的 ConnectConfig 保存进当前 SftpPool 的长期配置。连接失败后配置中的秘密清零。

堡垒机网络操作使当前同步 `build_connect_chain_for_host()` 不再足够。应拆成短时间快照本地配置与身份，再释放 mutex，异步申请/连接。不能在 Vault 锁、AppState 锁或 FFI inner 锁内等待网络或用户主机密钥确认。

### 13.3 连接池与身份隔离

- SFTP 与后台 exec 可以复用同一 PoolKey 的活跃连接；不能把不同能力、用户、login_session 或目标账号合并。
- 第一版不让文件面板与可见终端共享同一连接所有权，避免关闭终端误杀传输；同一后台池可开多个通道。
- capability_set 规范化排序后加入 key。需求变化无法由旧票据提升权限，应打开新连接。
- auth_epoch 是客户端身份失效计数，注销、账号切换、权限变更使旧池失效；不能用字符串 host_id 避免身份检查。
- 无会话时，按 PoolKey singleflight 创建，多个请求等待同一个建立任务。失败广播给等待者，清掉占位符。
- 池保存 ConnectionTarget 与连接工厂；断开重建调用工厂重新签票据，不重放旧配置。
- 每个通道使用独立 lease/cancel，取消一个文件操作不能关闭其他正常 lease；授权撤销则关闭全池。
- 池最大存活时间默认 30 分钟、空闲 5 分钟回收；目标账号/地址修订变化后即失效。

### 13.4 功能入口与能力

| 入口 | 所需能力 | 客户端行为 |
|---|---|---|
| 打开终端 | shell；若侧栏需要额外功能可申请相应能力 | 无 shell 时禁用并说明权限 |
| SFTP 独立窗口/侧栏/编辑器 | sftp | 通过共享池，不从显示 host 拼直连配置 |
| 指标、Docker、服务、端口、tmux 工具 | exec | 在目标执行，明确展示该账号身份 |
| SSH 端口转发中心 | 第一版未支持 | 堡垒机资产不提供此入口 |
| 远端跨主机复制 | sftp | 对堡垒机相关端点强制客户端中转 |
| 系统类型探测 | exec | 无权限时使用未知标识，不为探测提升权限 |
| AI 执行与上下文 | shell/exec，沿用客户端现有批准机制 | 不绕过服务端权限；录制告知可见 |
| SFTP 同步后端 | 第一版仅已有本地主机引用 | 不自动将堡垒机资产用于现有 host_ref 同步 |

远端直传逻辑可能临时修改 authorized_keys 或转发 Agent。堡垒机端点必须禁用现有 server-to-server 快路径，采用 `目标A → 网关A → ZeroTerm → 网关B → 目标B`；任一端点属于堡垒机即可触发客户端中转，明确满足既定网络路径。

### 13.5 UI 与错误表现

桌面主机列表新增“堡垒机”来源区，展示登录状态、资产标签、目标账号与授权能力。多账号选择后标签标题包含资产名与目标 username；不能只显示网关域名，避免在错误机器执行命令。

连接过程分为“验证登录”“申请连接授权”“连接网关”“连接目标”“启动终端/文件通道”。后台工具不重复弹登录窗口，统一聚合到堡垒机登录提示。权限错误暂停后台轮询，不把永久失败当网络故障循环重试。

网关失联显示“堡垒机连接中断”，目标失联显示“目标连接中断”。权限撤销关闭终端并保留历史；重连按钮只有重新取得权限后才可成功。禁止自动重放上一条 exec 命令，也不能在新 shell 自动输入未确认的历史命令。

Android 登录、资产列表和账号选择通过 FFI 实现，后台保活沿用 SessionForegroundService。网络变化使连接断开后重新申请票据；无法恢复原通道。UI 不获取 ticket_secret，设备标签是展示信息，第一版不是设备绑定的密码学凭据。

### 13.6 同步与旧客户端

可 E2E 同步 Profile 的 name/api_url/expected_server_id 以及 Bookmark 的标识与显示名。私有 CA 文件路径、主机信任接受记录、访问/刷新 token、资产缓存与票据均为设备本地。

新增 record kind 需检查 zeroterm-app CRUD、VaultBackedStore、冲突预览、快照/事件及导入导出。堡垒机记录只展示明确白名单字段，不因“这是配置”就允许未来所有字段在预览中明文显示。

发布前必须验证旧客户端接收未知 record kind 后原样保留，且压缩、清理、冲突处理不丢失。若不能保证，第一版默认仅本地保存堡垒机配置并关闭这些 kind 的同步；完成版本能力协商后再启用。禁止写入现有 Host 后让旧客户端误把网关当目标。

## 14. 错误契约与重试

客户端使用稳定错误 code 决定行为，message 只用于显示。SSH 认证可能只能返回通用失败；客户端利用票据关联 connection_id 查询详细失败，API 同时不可达时显示 AUTH_OR_GATEWAY_FAILED，不猜测密码错误。

| code | API 状态 | 客户端动作 |
|---|---|---|
| INVALID_ARGUMENT / UNKNOWN_CAPABILITY | 400 | 修正输入或协议，不自动重试 |
| UNAUTHENTICATED / ACCESS_TOKEN_EXPIRED | 401 | singleflight 刷新一次；失败要求登录 |
| LOGIN_SESSION_REVOKED / USER_DISABLED | 401/403 | 清身份、池、票据并断开 |
| PERMISSION_DENIED | 403 | 禁止连接/工具，停止后台轮询 |
| RESOURCE_NOT_FOUND | 404 | 隐藏或标记收藏失效，不泄露无权资产 |
| TICKET_EXPIRED / TICKET_STALE | 409 | 若操作尚未启动，可重新申请一次 |
| TICKET_USED / TICKET_INVALID | 409 | 不重放；人工操作可发起新连接 |
| CLIENT_PROTOCOL_UNSUPPORTED | 426 | 提示升级，禁用该堡垒机连接 |
| RATE_LIMITED / CONNECTION_LIMIT | 429 | 遵循 Retry-After 与有抖动退避 |
| TARGET_HOST_KEY_UNKNOWN / CHANGED | 409 | 管理员审核；用户不绕过校验 |
| TARGET_ADDRESS_DENIED | 403 | 管理员修正出站或资产配置 |
| TARGET_UNREACHABLE / TARGET_TIMEOUT | 502/504 | 显示目标故障；可手动新建连接 |
| TARGET_AUTH_FAILED | 502 | 管理员更新托管凭据；不向用户索取目标密码 |
| CHANNEL_PERMISSION_DENIED | 403 | 禁用对应功能，其他许可通道可继续 |
| TARGET_REQUEST_REJECTED | 502 | 显示目标未支持 shell/exec/SFTP 请求 |
| RECORDING_UNAVAILABLE | 503 | 不启动或关闭 shell，提示管理员检查存储 |
| POLICY_STORE_UNAVAILABLE | 503 | 禁新请求；活动连接遵循宽限后关闭 |
| INTERNAL_ERROR | 500 | 显示 request_id，禁止暴露内部栈与密文 |

表中目标故障等 code 可由 `GET /connections/{id}` 的 200 状态响应中的 `failure.code` 返回；并不意味着该 GET 要返回 502。HTTP 状态列用于同步操作或管理测试接口。ticket secret 验证失败的 SSH 响应仍保持统一拒绝。

自动重试仅限尚未开始目标操作的连接建立阶段，以及安全 GET；退避初值 1 秒、上限 30 秒、加入抖动，后台连续失败 3 次暂停并提示。exec、删除文件、移动文件、服务重启等有副作用操作不得在结果不明时自动重放。

SFTP 大文件断开后第一版重建连接、由用户重新发起传输，沿用现有覆盖/原子替换策略，不承诺自动断点续传。取消上传需处理目标临时文件；不能用“SSH 已断开”直接判断目标文件没有变化。

## 15. 默认限制与超时

以下默认值用于起步，必须可配置并在测试报告记录实际值。

| 参数 | 默认 | 语义 |
|---|---|---|
| ticket_ttl | 30 秒 | 仅限制 SSH 认证消费窗口 |
| api_access_ttl | 10 分钟 | API access token 有效期 |
| refresh_max_age | 7 天 | 从初次登录算起，不无限滑动延期 |
| ssh_auth_timeout | 15 秒 | 网关入站握手及认证上限 |
| target_connect_timeout | 15 秒 | DNS/TCP/SSH 握手总上限 |
| target_auth_timeout | 15 秒 | 目标认证上限 |
| channel_start_timeout | 10 秒 | 目标已 active 后配置/启动请求上限 |
| first_channel_wait_timeout | 45 秒 | 包含目标初始化的上游首次请求等待 |
| api_request_timeout | 15 秒 | 不包括受控录制流下载 |
| policy_check_interval | 2 秒 | 活动权限复核与过期检查 |
| policy_failure_grace | 5 秒 | 权限存储故障后的活动连接宽限 |
| max_connection_duration | 8 小时 | 每连接绝对时长，提前 5 分钟提示 |
| connection_idle_timeout | 30 分钟 | 无业务通道数据、启动请求或有效 resize；keepalive/空探测不续期 |
| ssh_keepalive | 30 秒，3 次未响应 | 网关两侧独立检测链路 |
| max_connections_global | 100 | 含 connecting/active/closing，pending 单列限额 |
| max_connections_per_user | 10 | 同一用户全部 login_sessions 合计 |
| max_pending_tickets_per_user | 20 | 未过期未消费票据，签发事务检查 |
| max_channels_per_connection | 16 | 包含 allocated，不仅 streaming |
| max_channels_per_user | 64 | 防止多连接规避通道限额 |
| max_http_json_body | 1 MiB | 另限制凭据大小，拒绝超大命令与环境变量 |
| max_private_key_bytes | 128 KiB | 解析前检查，禁止多密钥容器与不支持格式 |
| max_exec_command_bytes | 64 KiB | 拒绝 NUL，保持其他合法原始字节语义 |
| channel_buffer_each_direction | 256 KiB | 配合 SSH 窗口背压 |
| connection_buffer_total | 16 MiB | 应用队列总额，不含协议库内部缓冲 |
| recording_write_timeout | 5 秒 | 超时关闭 shell 并标记 partial |
| recording_retention | 30 天 | 完成后计算保留期 |
| audit_retention | 180 天 | 不受录制文件清理影响 |

第一版总连接限额在进程注册表原子计数，同时与数据库 connection 状态核对。签发和消费都检查限额；pending 不预占目标 socket，但必须限量。allocated 空通道 10 秒无启动请求即清理，防止通道资源占用。

只读 SFTP 列表与后台指标会产生业务活动，因此会保持其后台池，客户端池另有空闲回收；不能把纯 keepalive 或 RTT 探测视为用户活动。开始传输后背压暂停读写不算业务空闲，使用传输超时与连接绝对时长控制。

## 16. 部署与运维

### 16.1 初始部署拓扑

一台 Linux 主机运行一个 bastion-server，API 默认内网监听 127.0.0.1:8080，由反向代理终止 TLS 并对外提供 443；SSH 网关监听 2222；PostgreSQL 不暴露公网。SSH 端口不能交给 HTTP reverse proxy 转发，使用直连或明确支持 TCP 的网络组件。

生产可部署独立数据库；示例容器使用持久卷保存数据库、SSH host key、KEK、录制。服务器进程使用非 root 用户，2222 无需特权端口。容器镜像不内置真实密钥，首次初始化是独立受控步骤。

配置示意，全部字段均待实现，示例网段需替换为实际目标网段：

```toml
[server]
server_id = "bastion-production"
gateway_id = "gateway-main"
api_listen = "127.0.0.1:8080"
ssh_listen = "0.0.0.0:2222"
public_api_url = "https://bastion.example.com"
public_ssh_host = "bastion.example.com"
public_ssh_port = 2222
trusted_proxy_cidrs = ["127.0.0.1/32", "::1/128"]

[database]
url_file = "/run/secrets/database-url"
max_connections = 20
transaction_timeout_seconds = 2

[keys]
ssh_host_key_file = "/var/lib/bastion/keys/ssh_host_ed25519_key"
active_kek_version = 1
kek_files = { "1" = "/run/secrets/bastion-kek-v1" }

[network]
target_allow_cidrs = ["10.20.0.0/16"]
target_deny_cidrs = ["127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10"]

[recording]
directory = "/var/lib/bastion/recordings"
required = true
retention_days = 30
free_space_min_bytes = 1073741824

[limits]
max_connections_global = 100
max_connections_per_user = 10
max_channels_per_connection = 16
max_pending_tickets_per_user = 20
```

API HTTP 仅允许受信任本机或隔离网络反向代理到达。外部 URL 必须是 HTTPS；若不使用反向代理，则 bastion-server 需提供直接 TLS 配置。客户端 API URL 不允许携带 userinfo 或 token；凭据不可通过普通重定向发往另一 origin。

### 16.2 服务端 CLI

首版提供以下命令；敏感值均从 stdin 或受限文件读取，不能放命令行参数：

```text
bastion-server init          创建初始目录、网关密钥与版本化 KEK
bastion-server migrate       执行数据库迁移，失败不启动服务
bastion-server create-admin  交互创建首个管理员
bastion-server reset-user    受控恢复账号并撤销其全部登录会话
bastion-server serve         校验配置后运行单网关进程
bastion-server verify-backup 验证数据库、密钥版本与录制样本可恢复
```

迁移采用前向版本，禁止在客户端启动时改服务端 schema。升级先备份，执行迁移，再启动新进程；涉及破坏性 schema 时显式提供兼容窗口和恢复方案。回滚不能假定旧二进制可读新 schema。

### 16.3 健康检查与指标

- liveness 只判断事件循环存活；readiness 检查数据库、密钥、迁移、运行锁及录制存储容量。
- metrics 仅在受限运维地址提供，不暴露用户、资产名和 token。
- 记录活跃/待连接/待消费票据数、各故障 code、通道类型、目标初始化耗时、字节流量、队列峰值、录制失败与权限关闭延迟。
- 进程崩溃、主机密钥变化、录制写入失败、数据库故障和密钥版本缺失产生可关联 request_id/connection_id 的告警。

### 16.4 备份恢复

备份包含数据库、SSH 主机私钥、全部在用 KEK 版本与录制文件。数据库和录制一致性通过 recording 状态与清单校验，备份任务记录快照时间与边界。恢复后标记旧活动连接 interrupted，已消费票据不可重新启用，未消费票据统一撤销，用户重新登录。

恢复演练至少验证：目标凭据可解密、网关 host key 未变、代表性录制可回放、授权正确、旧票据不能使用。恢复缺失某 KEK 时明确标记对应凭据或录制不可用，不能自动生成同版本新密钥替代。

## 17. 分阶段实施与代码任务

每阶段必须保留既有本地直连与 ProxyJump 功能。先完成协议原型与真实 OpenSSH 测试，再接 UI，避免做完资产列表后才发现协议不能支持服务器工具。

| 阶段 | 开发任务 | 退出标准 |
|---|---|---|
| M0 协议原型 | 新建 bastion workspace；固定测试资产；SSH password 票据；独立目标连接；多通道流式代理 | 标准客户端和 ZeroTerm 能开 shell、exec、SFTP；EOF/退出码正确；无网关本机 shell |
| M1 服务端基础 | PostgreSQL 迁移、CLI 初始化、用户登录、资产账号、凭据加密、目标密钥、grant、真实票据消费 | 重放/越权拒绝；凭据不下发；停用和过期有效；测试连接先校验密钥 |
| M2 桌面接入 | zeroterm-bastion；ConnectionTarget；异步连接服务；UI 资产列表；SFTP/exec 池工厂 | 终端、文件、指标、Docker/systemd 连接同一正确目标；新连接使用新票据 |
| M3 审计与运维 | 录制、回放、管理界面、断开、撤销、故障宽限、备份恢复、限流、指标 | 录制失败不继续 shell；权限关闭延迟达标；恢复不复活票据 |
| M4 Android | FFI 类型/API、Repository、资产 UI、Keystore、会话保活与重连 | 真机终端、SFTP、exec 通过网关；后台恢复重新签票据；身份不串用 |
| M5 发布验收 | 完整集成、负载、日志脱敏、旧客户端同步兼容、部署说明 | 满足第 18 节阻断条件，生成测试报告与版本兼容表 |

M0/M1 只作为开发验证，不能以缺少凭据加密、目标校验或审计的状态对外提供生产服务。桌面第一版可先发布；Android 未完成时在 `/info` 和客户端支持表明确其协议版本与支持状态。

### 17.1 客户端改造清单

| 文件或模块 | 必须改动 |
|---|---|
| core/Cargo.toml | 新增客户端 crate，依赖不引入服务端/SQLx |
| zeroterm-bastion | info/auth/assets/ticket/connection API；安全 token 容器；刷新 singleflight；取消 |
| zeroterm-app | Profile/Bookmark CRUD；ConnectionTarget 编排；安全存储接口；不跨锁等待 |
| zeroterm-ssh | 保持现有客户端协议；必要时扩展流式事件/结构化失败，不内置业务授权 |
| desktop/src-tauri/src/connect.rs | 移除功能层直接依赖同步 host-only 解析，包装共享连接服务 |
| desktop/src-tauri/src/sftp/pool.rs | 连接工厂、复合 PoolKey、lease/失效/重建，不长期存票据 cfg |
| desktop/src-tauri/src/commands.rs | 终端、指标、Docker、服务、端口、tmux、SFTP 入口统一目标类型 |
| desktop/src-tauri/src/sftp/direct.rs | 堡垒机相关传输禁用目标直传/Agent 快路径 |
| desktop/src-tauri/src/session.rs | 连接阶段、撤销事件与“网关延迟”语义 |
| desktop/frontend/main.js 等 | 堡垒机管理、资产列表、账号选择、能力状态、登录聚合与故障显示 |
| zeroterm-ffi facade.rs/types.rs | 增加堡垒机 DTO 与目标连接 API，保留旧 HostInput 接口 |
| Android Repository/SessionManager/SftpManager | 共享目标标识、生命周期、错误、登录与安全存储 |
| zeroterm-app/src/sync.rs | 新记录过滤、白名单预览、旧版本兼容验证 |

### 17.2 建议的实现提交顺序

1. 引入领域类型、OpenAPI 草案与错误枚举，先固定请求响应契约。
2. 实现票据存储、事务授权复核与身份上下文，写重放及撤销竞态测试。
3. 实现网关 session channel 与 shell 流式代理，随后 exec、SFTP。
4. 加入主机密钥、凭据加密、地址策略、限额和超时，完成真实目标集成。
5. 客户端增加异步连接服务与池工厂，迁移功能入口后再接 UI。
6. 加入录制、撤销管理、健康检查与故障恢复，完成桌面端验收。
7. 扩展 FFI/Android，完成跨端与旧版本同步测试，编写部署和恢复说明。

M0 可暂时使用内存假票据和测试密钥，但必须与生产装配隔离，编译或配置不能意外以开发认证运行生产。后续实现不得通过跳过目标密钥校验来让原型测试通过。

## 18. 测试方案与验收标准

### 18.1 测试环境

集成环境包含网关、PostgreSQL 和至少两个真实 OpenSSH 目标；目标 A/B 的 hostname、文件内容与账号权限故意不同，用于检测串资产。测试覆盖密码、加密私钥、已知密钥、多种 host key、受限账号、SFTP 禁用和 MaxSessions 较小的服务器。

协议测试同时使用 OpenSSH ssh/sftp 与 ZeroTerm。票据测试客户端可将临时 secret 放入测试进程内存/受限 stdin；禁止出现在 CI 命令行、环境转储或日志。测试数据与录制均使用虚构凭据。

### 18.2 必须通过的功能与安全测试

| 编号 | 场景 | 验收断言 |
|---|---|---|
| AUTH-01 | 正常、错误密码、禁用用户、过期 token | 身份与错误正确；错误不泄露用户名存在性 |
| AUTH-02 | 多个后台任务刷新；刷新 token 重放 | 客户端只刷新一次；旧 token 撤销 family |
| TICKET-01 | 20 个请求并发消费同一票据 | 恰好一个成功；无多条目标连接 |
| TICKET-02 | 错 secret、到期、修订变化、消费后断线 | 不误消费；不复活；必须新票据 |
| TICKET-03 | 登录注销、角色变更、授权撤销与消费并发 | 不能凭旧授权继续创建可用通道 |
| ACL-01 | A 用户申请 B 用户资产/账号 | 拒绝；更改 asset_id/account_id 不越权 |
| ACL-02 | 仅有 sftp，尝试 shell/exec/未知 subsystem | 请求失败；无网关本机执行 |
| ACL-03 | admin 无显式资产授权 | 管理可用；目标登录拒绝 |
| TARGET-01 | 未核验与变化的 host key | 在提交目标认证凭据前拒绝 |
| TARGET-02 | DNS 切换到回环/元数据地址 | 出站规则阻止；无二次 DNS 绕过 |
| SSH-01 | vim、less、tmux、中文、emoji、二进制输出 | 字节不改写；尺寸与终端 modes 正确 |
| SSH-02 | exec 同时输出 stdout/stderr，退出 7 | 两流分别一致；退出码为 7 |
| SSH-03 | stdin EOF 后继续输出，exit-signal，双向 close 竞态 | 输出排空；退出信号保留；无挂起/泄漏 |
| SSH-04 | 16 并发通道与空 RTT channel | 通道隔离；探测不消耗目标 session |
| SFTP-01 | 文件操作、编辑、权限、符号链接、扩展能力 | 结果与直连一致；不误报文件级审计 |
| SFTP-02 | ≥1 GiB 随机文件上传下载与取消 | SHA-256 一致；内存有界；取消释放资源 |
| CLIENT-01 | A/B 目标各开终端、SFTP、指标/工具 | 每个入口操作预期目标；绝不落到网关 |
| CLIENT-02 | 同目标不同 user/login_session/account | 池隔离；退出账号后不能使用旧连接 |
| CLIENT-03 | 底层连接断开后后台池重建 | 使用新票据；失败占位符清除 |
| COPY-01 | 堡垒机端点参与跨主机复制 | 客户端中转；不启动 Agent/authorized_keys 快路径 |
| REVOKE-01 | 活跃 shell/SFTP/exec 撤销 | 正常环境 3 秒内开始关闭；目标后台进程边界说明准确 |
| RECORD-01 | 回放中文和跨 UTF-8 分块、resize、异常结束 | 字节/尺寸正确；partial 明确展示 |
| RECORD-02 | 磁盘满、写入阻塞、权限错误、文件损坏 | shell 拒绝/关闭；不静默丢录制 |
| LOG-01 | 在密码/私钥/token 中放唯一测试标记 | API JSON/运行日志/审计摘要不出现凭据标记 |
| FAILURE-01 | 数据库中断、权限通知丢失、网关强杀 | 新连接失败；宽限后关闭；重启标 interrupted |
| RESTORE-01 | DB/录制/密钥从备份恢复 | 可解密与回放；host key 不变；旧票据失效 |
| SYNC-01 | 旧客户端读取与压缩新增 kind | 原样保留或首版明确不启用这些 kind 同步 |
| MOBILE-01 | Android 后台、断网、切网、进程重启 | 状态正确；不复用一次性票据；登录存储边界成立 |

LOG-01 对运行日志和 API 凭据字段做断言，不能对授权终端的加密输出录制要求“用户自己打印的秘密绝不出现”。后者属于录制访问保护与敏感内容政策。

### 18.3 性能验收

在记录 CPU、内存、磁盘、网络 RTT、目标 OpenSSH 配置与版本的受控环境中测试。初始基线使用 4 vCPU、8 GiB 内存、SSD，以下为目标：

- 50 条活跃终端连接持续 1 小时，无代理任务、channel 或文件描述符持续泄漏。
- 同时 4 路 ≥1 GiB 文件传输与 20 条终端，按键回显不因文件队列出现长期阻塞。
- 相同目标与网络环境下，网关代理吞吐至少达到直接 SFTP 基线的 70%；实际报告同时列两段 RTT 与网关录制开销，未达标需分析后调整验收或实现。
- 稳态连接期间应用缓冲符合第 9/15 节；不能把目标文件全部读入内存或以无界队列“改善吞吐”。
- 记录权限撤销 P50/P95/最大延迟，正常负载最大不超过 3 秒；数据库失联关闭符合 5 秒宽限策略。
- 记录 required 输出录制模式下的磁盘写入、同步耗时与终端回显增加量，不以关闭录制的结果代表生产表现。

### 18.4 发布阻断条件

出现串身份/串目标、凭据下发或日志泄露、票据可重放、目标密钥绕过、网关本机命令执行、代理数据损坏、撤销无法生效、无界内存或 required 录制静默失败，均阻断发布。性能目标偏离必须有实测说明与可接受配置，不能静默删除验收项。

## 19. 后续扩展与兼容策略

| 扩展 | 前置工作 | 对协议的影响 |
|---|---|---|
| MFA/SSO | API 登录挑战、设备授权、安全浏览器回调 | SSH 继续使用票据；auth API 增加协商能力 |
| SSH 用户证书 | 客户端证书认证与 CA 生命周期 | 新票据绑定证书公钥，不能默认依赖现有 Agent |
| 端口转发 | 明确目标侧出口、地址端口规则、转发审计 | 新增能力枚举与网关请求实现，旧客户端保持禁用 |
| 文件操作审计/只读 | SFTP 请求解析与 handle 跟踪、扩展覆盖测试 | API 返回细粒度文件能力；不能在字节代理上仅加 UI 开关 |
| 受限命令工具 | 服务端命令模板与参数校验、目标最小权限 | 新增明确工具 API，不能将自由 exec 假装受限 |
| KMS 与密钥轮换 | KeyProvider 抽象、审计、恢复与离线策略 | 保留 envelope 记录与 key_version |
| 多网关 | 网关注册、心跳租约、定向票据、共享撤销总线 | gateway_id 成为路由约束；票据不跨节点重试复用 |
| 组织与群组 | tenant_id 隔离、授权模型与数据库约束升级 | /api/v2 或兼容协商；不得仅增加 UI 组织筛选 |
| 防篡改审计 | 外部追加存储、独立签名与验证信任 | 需独立于网关管理员的密钥/存储边界 |

`/info.protocol_version=1` 表示本设计 SSH 票据路由格式。API 扩展可增加非关键字段；未知能力不能自动允许，新的必需认证方法、路由或能力语义应升级协议并返回升级提示。第一版至少保存一张“客户端版本 × API/SSH 协议版本”兼容表。

## 20. 决策记录与实施产物

### 20.1 已选定的设计

| 决策 | 原因 |
|---|---|
| 标准 SSH 代理承载数据 | 复用 ZeroTerm 终端/SFTP/exec；无需重写 WebSocket 传输 |
| API 认证后取得一次性票据 | 目标凭据留在服务端；登录授权与数据面分离 |
| 一条上游连接绑定一个资产账号 | 路由清晰，服务器工具与文件通道不会串目标 |
| opaque token 与数据库单次消费 | 第一版便于注销、撤销与重放防护，无 JWT 撤销表复杂度 |
| PostgreSQL，单进程单网关 | 原子授权、票据与审计；先完成可靠性，再扩展分布式 |
| 本地 Host 格式保持兼容 | 不破坏现有直连、ProxyJump、Vault 与多端同步 |
| SFTP 第一版字节代理 | 保留兼容性，明确排除文件级权限与审计承诺 |
| shell 输出录制 required | 对录制失败给出确定行为，避免静默失去会话记录 |
| 堡垒机端点跨主机复制客户端中转 | 满足规定网络路径，避免目标间直连和临时凭据授权 |

### 20.2 实现期间必须补齐的产物

1. 与第 7/14 节一致的 OpenAPI 文件，包含枚举、长度、状态码、revision 与错误示例。
2. PostgreSQL 版本化迁移与约束，票据消费、授权撤销和 token 轮换事务实现。
3. 网关通道状态机与真实 OpenSSH 集成测试，覆盖 EOF、退出信息和并发。
4. 密钥初始化、轮换、备份恢复 CLI 及运维说明。
5. ZeroTerm 共享连接接口、桌面/FFI DTO 与能力映射，所有入口迁移清单。
6. `.ztrec` 字节级格式规范、版本头、加密/AAD 说明与回放验证器。
7. 自动化功能/安全测试报告、性能报告、客户端协议兼容表与已知限制。

这些是实现阶段交付物，不是本文已生成的代码。协议变更应先更新本 RFC 和契约，再同时修改客户端与服务端；不得在 UI 或临时脚本中引入未记录的旁路连接。

### 20.3 参考资料

- [OpenSSH ProxyJump](https://man.openbsd.org/ssh_config#ProxyJump)：用于区分 TCP 跳转与托管凭据会话代理。
- [RFC 4252 SSH 用户认证](https://www.rfc-editor.org/rfc/rfc4252)：SSH password 认证的基础格式，本文票据载荷为自定义约定。
- [RFC 4254 SSH 连接协议](https://www.rfc-editor.org/rfc/rfc4254)：通道、PTY、shell、exec、subsystem、流控与退出事件。
- [RFC 6750 Bearer Token 使用](https://www.rfc-editor.org/rfc/rfc6750#section-5)：Bearer secret 的 TLS、泄露与重放风险；本文本地认证不宣称实现完整 OAuth 服务。
- [Axum](https://docs.rs/axum/latest/axum/)、[SQLx](https://docs.rs/sqlx/latest/sqlx/)与[reqwest](https://docs.rs/reqwest/latest/reqwest/)：HTTP、数据库和客户端选型参考；版本在实施时锁定。
- [PostgreSQL 时间函数](https://www.postgresql.org/docs/current/functions-datetime.html)：票据在等待事务锁后仍按实际时间判断过期。
- [Rust SSH 服务端接口](./core/vendor/russh/src/server/mod.rs)与[服务端示例](./core/vendor/russh/examples/echoserver.rs)：实现前以当前仓库接口为准。
- [现有 SSH 核心](./core/crates/zeroterm-ssh/src/session.rs)、[桌面连接池](./desktop/src-tauri/src/sftp/pool.rs)与[同步冲突预览](./core/crates/zeroterm-app/src/sync.rs)：客户端改造依据。
