# RFC-003: ZeroTerm Android 设计

| | |
|---|---|
| **状态** | Draft |
| **日期** | 2026-07-17 |
| **关联文档** | [RFC-001](./RFC-001-architecture.md) · [RFC-002](./RFC-002-sync-design.md) · [core/crates/zeroterm-ffi/README.md](./core/crates/zeroterm-ffi/README.md) |

---

## 1. 摘要

Android 原生客户端:**Kotlin + Jetpack Compose(Material 3)UI,复用 `core/` Rust 核心(uniffi Kotlin 绑定 + 按 ABI 交叉编译的 `.so`)**。SSH/加密/vault/同步一行不重写,Android 侧只做 UI、终端渲染、平台集成(生物识别、前台服务、SAF、IME)。

对标 Termius Android 的日常可用度:解锁 vault → 主机列表 → 连接 → 真机上 vim/tmux 顺手,SFTP、片段、E2E 同步齐备。

## 2. 非目标(v1)

- Mosh、远程转发 `-R`、多跳 ProxyJump(核心尚未支持,跟随核心节奏)
- 端口转发/ProxyJump 的**编辑** UI(已保存的规则连接时自动生效,编辑走桌面/CLI)
- AI 命令助手(v2,见 §10)
- 平板双栏/分屏优化、Wear OS、桌面小部件
- Google Play 之外的分发承诺(F-Droid 需要可复现构建,列为开放问题)

## 3. 技术选型

| 项 | 选型 | 说明 |
|---|---|---|
| 语言/UI | Kotlin 2.x + Compose(Material 3) | 单 Activity + Navigation Compose |
| minSdk / targetSdk | 26 / 最新(36) | 26 覆盖 98%+ 设备,FGS 类型、Keystore API 齐全 |
| ABI | arm64-v8a、armeabi-v7a、x86_64 | x86_64 供模拟器;**必须 16KB page-size 对齐**(Play 对 Android 15+ 的硬要求,NDK 链接参数 `-Wl,-z,max-page-size=16384`) |
| FFI | uniffi 生成 Kotlin + JNA(`net.java.dev.jna:jna@aar`) | 与现有 `zeroterm-ffi` 一致;启动时 `System.loadLibrary("zeroterm_ffi")` |
| Rust 构建 | cargo-ndk + Gradle task | `gradle assembleDebug` 自动交叉编译并拷贝 `jniLibs/`、重新生成绑定 |
| 生物识别/密码缓存 | androidx.biometric + Android Keystore(EncryptedSharedPreferences 或 DataStore + Tink) | 见 §6.2 |
| 依赖注入 | 手写 AppContainer(v1 不引 Hilt) | 面积小,少一层魔法 |

## 4. 工程结构与分层

```
android/
├── app/
│   └── src/main/
│       ├── java/com/zeroterm/android/
│       │   ├── ffi/            # uniffi 生成代码(build 产物,不手改)
│       │   ├── data/           # ZeroTermRepository:包装 FFI 对象,暴露 Flow/suspend
│       │   ├── service/        # SessionForegroundService(会话保活)
│       │   ├── terminal/       # 终端 View/渲染/IME(§5)
│       │   └── ui/             # Compose 屏幕:unlock/hosts/terminal/sftp/snippets/sync/settings
│       └── jniLibs/<abi>/libzeroterm_ffi.so   # build 产物
└── build-rust.gradle.kts       # cargo-ndk 集成
```

原则同 RFC-001:**UI 层不直接依赖任何 SSH/crypto 库**,全部经 `ZeroTermRepository` → FFI。回调(SessionListener 等)在 repository 层转成 `SharedFlow`,Compose 只消费状态。

## 5. 终端组件(RFC-001 §9.1 开放问题的解答)

这是安卓版唯一真正的技术风险,方案对比:

| 方案 | 内容 | 评估 |
|---|---|---|
| ~~移植 Termux~~ | terminal-emulator/terminal-view | **否决:GPLv3,与本项目 MIT 冲突**,代码都不宜参考粘贴 |
| ~~WebView + xterm.js~~ | 桌面方案平移 | 否决(RFC-001 已定):移动 WebView IME 坑、性能、包体 |
| **B(推荐)Rust 侧终端模拟** | core 新增 `zeroterm-term`(封装 `alacritty_terminal`,Apache-2.0):FFI 喂字节 → 拿脏行/单元格网格;Kotlin 用 Compose Canvas 画网格 + 自定义 InputConnection 收输入 | VT 解析正确性直接继承 Alacritty(truecolor/宽字符/鼠标/bracketed paste/回滚);符合"Rust 不写两遍";风险在 FFI 每帧传脏区的开销(JNA 慢,需按帧批量、必要时 JNI direct ByteBuffer) |
| A(备选)Java 模拟器 | fork Apache-2.0 的 jackpal/Android-Terminal-Emulator 或 ConnectBot vt320 | 无 FFI 开销;但两者都年久失修,truecolor/现代 xterm 特性要自己补,长期维护成本高 |

**决策方式:M1 做一周级 spike,B 先行,达不到退出标准再落 A。**

退出标准(真机,中端机型如骁龙 7 系):
1. 正确性:vim(语法高亮)、htop、tmux(分屏)、less、`ls --color`、CJK 宽字符、emoji 不错位;
2. 性能:`cat` 10MB 文本不失速不丢字;全屏滚动 ≥ 60fps;按键回显延迟 < 50ms;
3. 工程:选择/复制、回滚 1 万行、字号缩放可实现(不必 spike 内完成,但路径清晰)。

IME 与按键(两方案共用,是安卓终端的真正难点):
- 自定义 View `onCreateInputConnection` 处理组合输入(拼音等),`sendKeyEvent`/`commitText` 转义成终端字节;
- **extra-keys 行**:Esc / Tab / Ctrl / Alt / 方向键 / PgUp/PgDn / `|` `~` `-` 常用符号,Ctrl 可粘滞;
- 外接键盘全键位(含 Ctrl 组合、F1-F12),物理键盘直通不经 IME。

## 6. 平台差异与适配

### 6.1 数据目录
- vault:`context.filesDir/zeroterm.vault`,经现有 `setVaultPath()` 注入;
- known_hosts:**现有 `KnownHosts::at_default()` 依赖 `$HOME`,Android 上会连接失败** → FFI 增加 `setDataDir(path)`(或 `connectHost` 走 vault 同目录),M0 必修。

### 6.2 主密码缓存(生物识别解锁)
`keyring` crate 无 Android 后端,`tryKeychainUnlock` 永远 miss(核心已优雅处理)。Android 自己做:
- "记住密码"勾选 → 主密码写入 Keystore 加密的存储,读取以 BiometricPrompt(指纹/面部/设备凭据)门禁;
- 解锁流程:冷启动 → 有缓存则弹生物识别 → 成功后调 `unlock(password, remember=false)`(**永远传 false**,避免 Rust 侧 keyring 报警日志);
- "锁定"按钮 = `lock()` + 清除本地缓存,与桌面语义一致。

### 6.3 会话保活
- 有活跃会话时运行 **Foreground Service**(`dataSync` 类型),常驻通知显示会话数,点击回到终端;
- 进程被杀/网络切换:不做透明续命(那是 Mosh 的事),做**快速重连**——检测断开(ConnectivityManager + on_closed)后终端内提示一键重连;
- app 退到后台不主动断开;用户从通知栏"断开全部"可手动收尾。

### 6.4 Argon2id 参数
桌面默认 `m=64MiB, t=3, p=4`,现代手机可承受(解锁瞬时峰值);参数存于 vault_meta,跨端解锁自动跟随。**在手机上新建 vault** 时降为 `m=32MiB`(需 FFI 暴露 `createWithParams`,低优先)。

### 6.5 文件访问(SFTP)
- 下载:写 app 私有目录,完成后经 SAF(`ACTION_CREATE_DOCUMENT`)导出,或直接分享 sheet;
- 上传:`ACTION_OPEN_DOCUMENT` 拿 content URI → 拷入缓存 → 传路径给 FFI(v1 不做 fd 直通)。

## 7. FFI 扩展批次(Rust 侧工作)

| 批次 | 内容 | 服务里程碑 |
|---|---|---|
| batch-3 主机完整化 | `getHost`/`updateHost`(含 forwards/jump 只读回显)、`HostInput` 增加 `groupId`、分组 CRUD、`connectDirect(user,host,port,auth,...)`(Quick Connect)、`setDataDir`、连接中途密码/passphrase 提示回调 | M0/M2 |
| batch-4 SFTP | `sftpOpen/Close/List/Mkdir/Rename/Remove/RemoveDir`、`sftpDownload/Upload`(async + 进度回调 + cancel token),对齐桌面 `sftp:transfer` 事件形状 | M4 |
| batch-5 片段 | snippets CRUD + 分组重命名/删除 | M5 |
| batch-6 同步 | 后端配置(sftp/webdav/s3)、`syncNow` + 进度/冲突回调、冲突列表与解决、同步状态查询;新设备加入只走手动配置(RFC-002 §16,二维码方案已弃用) | M6 |
| batch-7 终端(若 §5 选 B) | `zeroterm-term`:`feed(bytes)`、`takeDamage() -> 脏行单元格数组`、`resize`、`scrollback(n)`、选择辅助 | M1/M2 |

每批次交付:Rust 单测 + 重新生成 Swift/Kotlin 绑定(iOS 免费受益)+ ffi README 更新。

## 8. 里程碑

| | 目标 | 验收标准 |
|---|---|---|
| **M0 工程底座** | `android/` 脚手架、cargo-ndk Gradle 集成、CI(rust 三 target + assemble)、加载 `.so`、解锁/创建/生物识别记住密码;`setDataDir` 落地 | 桌面创建的 vault 拷入手机可解锁并列出主机 |
| **M1 终端 spike(闸门)** | §5 方案 B PoC(必要时 A 对照),按退出标准测真机 | 数据齐、方案定案、本 RFC 更新为 Accepted |
| **M2 主机与会话 v1** | 主机列表/分组/搜索 + CRUD(batch-3)、连接流程、host-key 弹窗、终端 v1、extra-keys 行、FGS 保活、断线重连 | 真机对生产机器 vim/tmux 日常可用 |
| **M3 终端打磨** | IME/中文输入、外接键盘全键位、选择复制粘贴、回滚、主题与字体(移植桌面主题表)、捏合缩放字号 | 中文注释编辑、tmux 长会话、外接键盘无失灵键 |
| **M4 SFTP** | batch-4 + 单栏浏览器(面包屑导航)、上传/下载进度与取消、SAF 导入导出 | 与桌面互传 100MB 文件,进度/取消/覆盖确认正确 |
| **M5 片段与设置** | snippets 管理与终端一键插入、Quick Connect、设置页(主题/终端/行为) | — |
| **M6 同步** | batch-6 + 同步设置 UI、手动 join 流程、冲突解决 UI、前台自动 + 手动触发 | 手机 ↔ 桌面经 WebDAV/S3 双向同步,冲突可解 |
| **M7 发布** | 图标/品牌、R8 keep 规则(JNA/uniffi)、签名与 CI 产物、Play internal testing、崩溃收集策略(默认零遥测)、文档 | 内测包发出,README/路线图更新 |

顺序依赖:M0 → M1 → M2 → M3/M4 可并行 → M5 → M6 → M7。M1 是唯一闸门,其余失败均可回退局部。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 终端方案 B 的 FFI 每帧开销超标 | spike 内先测纯吞吐;JNA → JNI direct buffer 有一档退路;最终退 A |
| GPL 污染 | 禁止参考/粘贴 Termux 代码;依赖清单 CI 审计 license |
| IME 兼容(各家输入法行为不一) | M3 真机矩阵:Gboard/搜狗/微软 SwiftKey;物理键盘直通不走 IME |
| 厂商激进杀后台(MIUI 等) | FGS + 引导用户加白名单;断开后重连体验兜底 |
| 16KB page size 不达标被 Play 拒 | M0 就把链接参数进 CI,`llvm-readelf` 校验对齐 |
| `alacritty_terminal` API 变动 | 锁版本,同 russh pin 策略 |
| Argon2 64MiB 在低端机 OOM | 解锁放后台线程 + 失败兜底提示;移动端建 vault 用低参数 |

## 10. 开放问题

1. F-Droid 分发:Rust 交叉编译的可复现构建成本,v1 是否只做 Play + APK 直发?
2. AI 助手上移动端的时机;若做,**建议把桌面 `redact.js` 的脱敏规则下沉为 core 的 Rust 实现**,三端共享(桌面 Tauri command / 移动 FFI),避免 Kotlin/Swift 再写两遍。
3. iOS 与 Android 的节奏:batch-3~6 的 FFI 面是共享的,iOS 启动时可直接吃现成绑定——是否 M4 后并行启动 iOS?
4. 终端主题/配色表的跨端共享格式(桌面现为 JS 内嵌,可提为 JSON 资源三端复用)。
