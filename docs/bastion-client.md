# ZeroTerm 堡垒机客户端接入

本项目按 `zeroterm-terminal/docs/RFC-004-bastion-design.md` 的 Web 堡垒机设计提供 **ZeroTerm 集成客户端**。用户、资产授权、目标凭据、录制和撤销由独立堡垒机服务端负责；ZeroTerm 通过 HTTPS 控制面申请一次性票据，通过标准 SSH 使用目标 shell、exec 和 SFTP。

## 使用

桌面主机列表顶部的盾牌按钮打开堡垒机配置；Android 从工作区侧栏进入“堡垒机”。先解锁 Vault，两端使用相同的添加流程：

- HTTPS origin，例如 `https://bastion.example.com`，不带 `/api/v1`、查询参数或用户名密码。
- 名称可选，留空默认使用 HTTPS 主机名。
- 用户名和密码与地址在同一表单填写，账户随这条连接配置保存。默认勾选“将密码保存到加密 Vault”；取消勾选时密码仅用于本次登录，并删除原先保存的密码。
- 使用私有 TLS CA 时，在折叠的“高级”设置中导入公开的 CA PEM；证书校验始终开启。

点击“读取并核验”后，共享 Rust 核心通过严格校验证书、不跟随重定向的 HTTPS 请求 `/api/v1/info`，自动读取 `server_id`、SSH 网关地址和端口，并由 `gateway.public_key` 算出 SHA256 指纹。界面展示完整的只读身份卡片；如有疑问可与管理员核对。点击“确认并登录”后，将身份和账户一起保存到 Vault 并登录，无需再次填写账户。确认之前不向服务端发送密码。取消、读取失败或修改 URL/CA 都不会保存探测结果；修改 URL/CA 后必须重新读取并确认。已有连接可“保存并登录”，也可仅“保存”修改。

每次登录、读取资产和申请新票据都核对已固定的服务身份、SSH 入口和指纹，变化时拒绝请求并撤销旧登录及连接，不自动替换信任值。SSH 握手仍校验真实网关密钥，在发送票据前拒绝密钥变化。修改名称沿用已固定的身份，无需重新读取。

登录使用堡垒机用户的密码。桌面登录成功后关闭配置弹窗，直接切换到对应堡垒机的资产树；全部授权资产和目标账号自动显示在树中，配置弹窗不再重复显示“授权资产”列表或逐个添加入口。资产刷新在侧栏完成。Android 仍在堡垒机页面选择资产和账号。SFTP-only 账号不显示终端入口。终端和文件连接显示资产名、账号、当前能力及服务端 `connection_id`。服务器工具需要 exec 权限，purpose 仅作审计用途，不代表只读命令。

连接配置、堡垒机用户名及可选登录密码保存在同一条加密 Vault 记录，可随正常记录同步；前端仅收到用户名和 `has_password`，不会回填保存的密码。留空密码使用原值，输入新密码替换原值，修改用户名或信任配置时不沿用旧密码。解锁 Vault 后可直接使用保存的账户登录；关闭再打开配置弹窗保留侧栏中的有效目录，不重复请求资产。收藏的认证字段仅含 `profile_id/asset_id/account_id`。目标密码、私钥、票据及 access/refresh token 不进入 Vault、同步、前端存储或日志。登录令牌仍仅保存在 Rust 内存中，退出应用、锁定/清空 Vault 后清除；注销不删除保存的账户。修改或删除配置、重新登录、注销、令牌刷新失败都会使旧登录的连接失效。

网关终止 SSH，能够读取和录制目标会话；此路径不具备客户端到目标的端到端加密。网关校验目标 host key；客户端只校验网关 host key。

## CLI

可使用桌面/Android 保存的配置与资产收藏。CLI 解锁 Vault 后优先使用已保存的堡垒机账户登录；未保存密码时交互要求登录，密码从隐藏输入读取：

```sh
zeroterm bastion --profile public-profile.json
zeroterm bastion
zeroterm '<资产名> · <账号>'
zeroterm sftp ls '<资产名> · <账号>' /var/log
```

`--profile` 文件只包含公开配置，例如：

```json
{
  "name": "Production",
  "api_url": "https://bastion.example.com",
  "server_id": "bastion-production",
  "ssh_host": "bastion.example.com",
  "ssh_port": 2222,
  "ssh_host_key_sha256": "SHA256:<管理员核验的真实指纹>",
  "ca_pem": null
}
```

示例指纹是占位符，必须替换。CLI 导入会创建配置，然后登录、选择账号并收藏；拥有 shell 时打开终端，否则提示使用已有 SFTP 命令。票据和登录密码没有命令行参数。

## 协议与兼容边界

使用 `/api/v1` 的 snake_case JSON：

1. `GET /info`：核对 server_id、SSH 入口和指纹；要求 protocol_version 和 ssh_protocol_version 为 1、minimum_client_protocol_version 不高于 1，并显式提供 production_ready、原生 SSH features 和必需录制契约。缺少这些字段或未知必需协议版本时拒绝连接；资产能力与服务端当前可用的 SSH features 取交集。
2. `POST /auth/login`：发送 username、password、device_label 和 `client_type=zeroterm`，解析 access_token、refresh_token、access_expires_at。
3. `GET /assets`：处理不透明 cursor；每次新 SSH 连接另读 `/assets/{asset_id}`，按最新授权申请能力，未知能力拒绝。
4. `POST /integrations/zeroterm/connection-tickets`：签发独立 SSH 票据，发送 asset_id/account_id/capabilities/purpose。
5. 校验票据版本、UUID、到期时间、返回的网关地址、`zt1:<ticket_id>` 用户名及完整能力集合。仅用 ticket_secret 做 SSH password 认证，不回退到 Agent、目标密码或直连。
6. SSH 握手失败查询 `/connections/{connection_id}` 的 failure.code；无法确认时显示 `AUTH_OR_GATEWAY_FAILED`。网关密钥变化显示 `GATEWAY_HOST_KEY_CHANGED`。

每次 `Session::connect` 都重新执行控制面步骤，连接池仅保留解析器，不缓存票据。新连接使用新的 connection_id；不恢复旧通道或重放 SSH 密码。GET 可由用户重试；票据、刷新及其他 POST 不自动重放，包括 HTTP 库内部自动重试。access 到期前进行串行 refresh；并发请求共用一次轮换。刷新结果不明确时清除登录，要求重新登录。

相邻 `zeroterm-terminal` 服务端已提供 `/api/v1/integrations/zeroterm/connection-tickets` 和上述 `/info` 字段。本次连接表单变更位于 ZeroTerm 客户端仓库。

首版禁止 ProxyJump、端口转发、SOCKS 和 Agent 转发。跨资产复制使用本机 SFTP 中转，不把凭据或票据转交目标。堡垒机终端断线后需手动重建；文件传输/修改/删除结果不明确时不自动重放。重新传输由用户决定，沿用覆盖确认和原子替换，不承诺断点续传。

## 验证

- 真实 TLS 测试端点：证书验证、协议和服务身份、opaque cursor 编码、并发 refresh 单次轮换、刷新失败、锁定与登录并发、新票据及注销生命周期。
- 自动发现测试覆盖完整身份读取、未信任 CA 的拒绝、缺失/无效网关公钥，以及 SSH 入口或指纹变化时在登录凭据发出前拒绝并撤销旧连接。
- `desktop/tests/bastion-profile.html` 为无依赖的浏览器回归检查：在 `desktop/` 启动静态 HTTP 服务后打开 `/tests/bastion-profile.html`，检查读取后确认、取消及焦点、URL/CA 变更后重读、读取失败不保存和改名保留信任值。
- 账户持久化检查覆盖 Vault 重开后登录、密码不出现在公开配置或磁盘明文中、服务身份变化时不发送密码、切换账户/地址不复用密码、取消保存密码和旧记录兼容。浏览器检查同时覆盖同一表单填写、确认后保存并登录、密码不回填、重开恢复显示、一次性密码及登录失败。
- 进程内 SSH 网关：每次连接调用新凭据提供器、错误网关密钥在 password 前拒绝、能力约束、转发禁用、PTY/resize、stdout/stderr、EOF 后 exit status、退出信号和注销关闭。
- 桌面现有回归套件、Chrome 中的堡垒机入口流程检查、Tauri 编译、共享 FFI 编译及 Android arm64 Kotlin 构建。FFI 的系统钥匙串交互测试 `try_keychain_unlock_without_remembered_password_returns_false` 本次跳过；真实 OpenSSH 测试仍需显式配置测试服务器。

2026-10-06 连接表单验证：14 项共享核心堡垒机测试、27 项桌面回归测试及上述浏览器检查通过；Tauri 检查和 Android arm64 原生库/Kotlin 编译通过。Windows 上 Android 单元测试有两项既有 shell 执行测试因固定使用 `/bin/sh` 无法运行，临时排除这两项后其余 30 项通过、7 项既有跳过；未修改测试代码。未进行 Android 真机或真实堡垒机联调。

2026-10-06 账户与配置合并验证：15 项共享核心堡垒机测试、27 项桌面回归测试，以及 Chrome 中的统一表单与账户保存检查通过；检查了桌面深浅主题与窄屏布局。Tauri、CLI 检查和 Android arm64 原生库/Kotlin 编译通过。未进行 Android 真机或真实堡垒机联调。

这些测试不替代 RFC ZT-01/ZT-02 的完整服务端验收。服务端集成路由就绪后，还需使用真实 PostgreSQL、网关与两个 OpenSSH 目标完成终端、SFTP、exec、撤销、录制、并发隔离和大文件联调。

## 桌面资产树与服务端分组

桌面侧栏提供“本地 / 堡垒机”切换。本地视图沿用 Vault 的主机与分组，仅显示普通主机；堡垒机视图通过连接选择器选择服务端，登录成功后自动切换到该连接并清除原有搜索条件，直接读取全部授权目录，按“服务端分组 → 资产 → 目标账号”展开。无需先收藏资产，配置弹窗只管理连接与账户。账号叶子按授权能力显示终端与文件入口；本地不能修改堡垒机分组。搜索分组名、资产名、标签或账号时保留祖先分组。目录读取失败时在资产树显示重试入口，刷新按钮重新读取目录。

资产树数据只保留在前端内存，不同步到本地分组。打开连接仍使用现有收藏引用与一次性票据流程；收藏引用不显示在本地主机树。切换连接会清除旧目录，迟到的响应不能覆盖当前视图。注销、重新登录和锁定 Vault 会清理或重新获取目录。

当前 RFC 和服务端的 `GET /api/v1/assets` 尚未包含分组。本客户端预留以下**可选协议扩展**，需要服务端提供真实分组后才能显示真实层级；没有分组字段的旧返回仍兼容，资产归入“未分组”。不使用标签猜测分组。

```json
{
  "groups": [
    { "id": "production", "name": "生产环境", "parent_id": null, "sort_order": 0 },
    { "id": "apps", "name": "应用服务", "parent_id": "production", "sort_order": 10 }
  ],
  "items": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "name": "应用服务器 01",
    "group_id": "apps",
    "tags": [],
    "accounts": [{
      "id": "22222222-2222-4222-8222-222222222222",
      "username": "deploy",
      "capabilities": ["shell", "sftp"]
    }]
  }],
  "next_cursor": null
}
```

服务端可在每页携带全部分组，或随分页返回部分分组。客户端取完分页后按分组 id 去重合并。分组应包含已授权资产的祖先，`parent_id` 与资产的 `group_id` 引用同一组 id；`sort_order` 可省略，默认 0。服务端负责分组元数据的授权过滤。客户端不显示没有授权资产的空分组；断开的父引用、循环引用和未知分组引用不会丢失资产，未知分组引用归入“未分组”。
