// ZeroTerm desktop frontend (vanilla JS, no build step)

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;

const views = {
  unlock: document.getElementById("view-unlock"),
  hosts: document.getElementById("view-hosts"),
  terminal: document.getElementById("view-terminal"),
  files: document.getElementById("view-files"),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function joinPath(base, name) {
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

function parentPath(path) {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function localJoin(base, leaf) {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + leaf;
}

function basename(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const LOCALE_STORAGE_KEY = "zeroterm.locale";

const I18N = {
  en: {
    "unlock.checking": "checking vault...",
    "unlock.enter_password": "Enter your master password to continue.",
    "unlock.no_vault": "No vault yet. Choose a master password - it cannot be recovered.",
    "unlock.label.master": "Master password",
    "unlock.label.new_master": "New master password",
    "unlock.remember": "Remember password (store in OS keychain)",
    "unlock.button.unlock": "Unlock",
    "unlock.button.create": "Create vault",
    "unlock.confirm_placeholder": "Confirm master password",
    "unlock.path": "vault: {path}",
    "unlock.error.passwords_mismatch": "passwords do not match",
    "common.error": "error: {error}",
    "nav.hosts": "Hosts",
    "nav.keychain": "Keychain",
    "nav.port_forwarding": "Port Forwarding",
    "nav.known_hosts": "Known Hosts",
    "nav.logs": "Logs",
    "sidebar.terminals": "Terminals",
    "sidebar.new_window": "New Window",
    "sidebar.settings": "Settings",
    "sidebar.lock": "Lock Vault",
    "hosts.search.placeholder": "Find a host or ssh user@hostname...",
    "hosts.new_host": "+ New host",
    "hosts.connect_selected": "Connect Selected",
    "hosts.delete_selected": "Delete Selected",
    "hosts.selection.count": "{count} selected",
    "hosts.empty.search": "No host matched your search.",
    "hosts.empty.default": "No saved hosts yet. Click + New host or add from CLI.",
    "hosts.button.connect": "Connect",
    "hosts.button.files": "Files",
    "hosts.button.edit": "Edit",
    "hosts.button.delete": "Delete",
    "hosts.confirm.delete_selected": "Delete {count} selected host(s)?",
    "hosts.error.delete_failed_for": "delete failed for {name}: {error}",
    "hosts.confirm.delete_one": "Delete saved host \"{name}\"?",
    "hosts.error.delete_failed": "delete failed: {error}",
    "hosts.error.no_tabs": "No terminal tabs yet. Open a host first.",
    "hosts.error.load_failed": "error: {error}",
    "terminal.button.new_tab": "+ Tab",
    "terminal.button.split_v": "Split V",
    "terminal.button.split_h": "Split H",
    "terminal.button.close_split": "Close Split",
    "terminal.button.disconnect": "Disconnect Pane",
    "terminal.button.new_window": "New Window",
    "terminal.button.back_hosts": "Hosts",
    "terminal.empty": "No open terminal tabs. Open one from Hosts.",
    "terminal.new_tab_hint": "Select a host to open a new terminal tab.",
    "terminal.pane.empty": "Empty pane",
    "terminal.status.connecting": "connecting...",
    "terminal.status.connected": "connected",
    "terminal.status.disconnected": "disconnected",
    "terminal.via": "via {jump}",
    "terminal.error.connect_failed_status": "connect failed: {error}",
    "terminal.error.connect_failed_term": "failed to connect: {error}",
    "terminal.error.new_window_failed": "new window failed: {error}",
    "terminal.error.split_limit": "Current split mode supports up to 2 panes.",
    "terminal.error.no_host": "Active pane has no host to duplicate.",
    "terminal.closed.remote_exited": "[remote exited with status {code}]",
    "terminal.closed.disconnected": "[disconnected]",
    "host_key.unknown_title": "Unknown host",
    "host_key.unknown_body":
      "The authenticity of '{host}:{port}' cannot be established. Trusting this key adds it to known_hosts.",
    "host_key.changed_title": "Warning: host key changed",
    "host_key.changed_body":
      "This might indicate a man-in-the-middle attack. Trust only if you know why the key changed.",
    "host_key.changed_server_now": "Server now offers:",
    "host_key.changed_known_hosts_has": "known_hosts has:",
    "host_key.unknown_value": "(unknown)",
    "host_key.reject": "Cancel connection",
    "host_key.accept": "Trust and connect",
    "host_editor.title.add": "Add host",
    "host_editor.title.edit": "Edit host",
    "host_editor.label.name": "Name",
    "host_editor.label.user": "User",
    "host_editor.label.host": "Host",
    "host_editor.placeholder.host": "hostname or IP",
    "host_editor.label.port": "Port",
    "host_editor.label.auth": "Authentication",
    "host_editor.label.password": "Password",
    "host_editor.label.private_key": "Private key",
    "host_editor.label.passphrase": "Passphrase (optional)",
    "host_editor.label.proxy_jump": "ProxyJump (saved alias)",
    "host_editor.label.advanced": "ProxyJump and forwards",
    "host_editor.label.port_forwards": "Port forwards",
    "host_editor.button.add_forward": "+ Add forward",
    "host_editor.hint.forwards": "Supports local forward (-L) and dynamic SOCKS5 (-D).",
    "host_editor.button.choose_key": "Choose file...",
    "host_editor.button.cancel": "Cancel",
    "host_editor.button.save": "Save",
    "host_editor.auth.password": "Password",
    "host_editor.auth.key": "Private key",
    "host_editor.auth.agent": "SSH agent",
    "host_editor.key.none": "No key loaded",
    "host_editor.key.existing": "Existing key kept (choose a file to replace)",
    "host_editor.jump.none": "(none)",
    "host_editor.forward.none": "(no forwards)",
    "host_editor.forward.local": "Local (-L)",
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.bind": "bind",
    "host_editor.forward.port": "port",
    "host_editor.forward.target_host": "target host",
    "host_editor.forward.remove": "Remove",
    "host_editor.key.pick_title": "Choose a private key",
    "host_editor.key.loaded": "loaded {name} ({bytes} bytes)",
    "host_editor.key.read_failed": "read failed: {error}",
    "host_editor.error.pick_new_key": "Pick a new key file to replace existing key.",
    "host_editor.error.pick_key_first": "Pick a private key file first.",
    "host_editor.error.required_fields": "name, host and user are required",
    "host_editor.error.load_failed": "load failed: {error}",
    "host_editor.error.forward_bind_port": "forward {index}: invalid bind port",
    "host_editor.error.forward_target_host": "forward {index}: target host required",
    "host_editor.error.forward_target_port": "forward {index}: invalid target port",
    "files.title": "Files",
    "files.button.back": "Back",
    "files.button.up": "Up",
    "files.button.up_title": "Parent directory",
    "files.button.refresh": "Refresh",
    "files.button.new_folder": "New Folder",
    "files.button.upload": "Upload",
    "files.button.upload_many": "Upload Many",
    "files.select_all": "Select all",
    "files.button.download_selected": "Download Selected",
    "files.button.delete_selected": "Delete Selected",
    "files.drop.hint": "Drop files to upload to current directory",
    "files.menu.edit": "Edit",
    "files.menu.download": "Download",
    "files.menu.rename": "Rename",
    "files.menu.delete": "Delete",
    "files.selection.count": "{count} selected",
    "files.status.connecting": "Connecting...",
    "files.status.listing": "Listing {path}...",
    "files.error.mkdir_failed": "mkdir failed: {error}",
    "files.prompt.new_folder": "New folder name:",
    "files.empty": "(empty)",
    "files.error.open_failed": "open failed: {error}",
    "files.error.list_failed": "list failed: {error}",
    "files.status.downloaded_one": "Downloaded {name} ({size}).",
    "files.error.download_failed": "download failed: {error}",
    "files.prompt.rename": "Rename \"{name}\" to:",
    "files.error.rename_failed": "rename failed: {error}",
    "files.confirm.delete_entry": "Delete {path}?",
    "files.error.delete_failed": "delete failed: {error}",
    "files.confirm.delete_selected": "Delete {count} selected item(s)?",
    "files.error.delete_failed_for": "delete failed for {name}: {error}",
    "files.status.uploaded_one": "Uploaded {name} ({size}).",
    "files.error.upload_failed_for": "upload failed for {name}: {error}",
    "files.error.drag_upload_failed_for": "drag upload failed for {name}: {error}",
    "files.alert.download_selected_none":
      "Select at least one file (directories are skipped for bulk download).",
    "files.error.download_failed_for": "download failed for {name}: {error}",
    "files.status.downloaded_many_to": "Downloaded {count} file(s) to {folder}.",
    "files.progress.uploading": "Uploading",
    "files.progress.downloading": "Downloading",
    "files.progress.eta": "ETA {eta}",
    "files.button.cancel": "Cancel",
    "editor.title": "Edit Remote File",
    "editor.title.dirty": "Edit Remote File *",
    "editor.hint.default": "Supports common UTF-8 text files. Press Ctrl/Cmd + S to save.",
    "editor.hint.loading": "Loading file content...",
    "editor.hint.opening": "Opening...",
    "editor.hint.unavailable": "Unable to open this file in the inline editor.",
    "editor.hint.saved": "Saved {size} just now",
    "editor.hint.replaced_one": "Replaced 1 occurrence.",
    "editor.hint.replaced_many": "Replaced {count} occurrence(s).",
    "editor.hint.utf8_info": "UTF-8 text · {lines} lines · Ctrl/Cmd + S to save",
    "editor.find.placeholder": "Search...",
    "editor.replace.placeholder": "Replace...",
    "editor.match_case": "Match case",
    "editor.button.prev": "Prev",
    "editor.button.next": "Next",
    "editor.button.replace": "Replace",
    "editor.button.replace_all": "Replace All",
    "editor.button.close": "Close",
    "editor.button.save": "Save",
    "editor.error.ace_load_failed": "Ace editor failed to load.",
    "editor.error.enter_search": "Enter text in Search first.",
    "editor.error.no_matches": "No matches found.",
    "editor.error.no_matches_replace": "No matches found to replace.",
    "editor.error.no_selected_match": "No match selected to replace.",
    "editor.alert.unsupported":
      "This file type is not in the inline-edit list, or the file is too large.",
    "editor.alert.component_failed": "Editor component failed to load.",
    "editor.confirm.discard": "Discard unsaved editor changes?",
    "editor.confirm.close_unsaved": "You have unsaved changes. Close editor anyway?",
    "editor.error.open_failed": "open failed: {error}",
    "editor.error.save_failed": "save failed: {error}",
    "files.status.saved_path": "Saved {path}.",
    "settings.title": "Settings",
    "settings.language.label": "Language",
    "settings.language.hint": "Changes apply immediately and are saved locally.",
    "settings.button.close": "Close",
    "settings.language.zh": "Simplified Chinese",
    "settings.language.en": "English",
  },
  "zh-CN": {
    "unlock.checking": "正在检查保险库...",
    "unlock.enter_password": "请输入主密码继续。",
    "unlock.no_vault": "当前没有保险库。请设置主密码，主密码无法找回。",
    "unlock.label.master": "主密码",
    "unlock.label.new_master": "新主密码",
    "unlock.remember": "记住密码（保存到系统钥匙串）",
    "unlock.button.unlock": "解锁",
    "unlock.button.create": "创建保险库",
    "unlock.confirm_placeholder": "确认主密码",
    "unlock.path": "保险库：{path}",
    "unlock.error.passwords_mismatch": "两次输入的密码不一致",
    "common.error": "错误：{error}",
    "nav.hosts": "主机",
    "nav.keychain": "钥匙串",
    "nav.port_forwarding": "端口转发",
    "nav.known_hosts": "已知主机",
    "nav.logs": "日志",
    "sidebar.terminals": "终端",
    "sidebar.new_window": "新窗口",
    "sidebar.settings": "设置",
    "sidebar.lock": "锁定保险库",
    "hosts.search.placeholder": "搜索主机或 ssh user@hostname...",
    "hosts.new_host": "+ 新建主机",
    "hosts.connect_selected": "连接所选",
    "hosts.delete_selected": "删除所选",
    "hosts.selection.count": "已选 {count} 项",
    "hosts.empty.search": "没有匹配搜索条件的主机。",
    "hosts.empty.default": "还没有保存的主机。点击 + 新建主机，或在 CLI 中添加。",
    "hosts.button.connect": "连接",
    "hosts.button.files": "文件",
    "hosts.button.edit": "编辑",
    "hosts.button.delete": "删除",
    "hosts.confirm.delete_selected": "确认删除已选的 {count} 个主机？",
    "hosts.error.delete_failed_for": "删除 {name} 失败：{error}",
    "hosts.confirm.delete_one": "确认删除已保存主机“{name}”？",
    "hosts.error.delete_failed": "删除失败：{error}",
    "hosts.error.no_tabs": "当前没有终端标签页，请先打开一个主机。",
    "hosts.error.load_failed": "错误：{error}",
    "terminal.button.new_tab": "+ 标签页",
    "terminal.button.split_v": "垂直分屏",
    "terminal.button.split_h": "水平分屏",
    "terminal.button.close_split": "关闭分屏",
    "terminal.button.disconnect": "断开当前窗格",
    "terminal.button.new_window": "新窗口",
    "terminal.button.back_hosts": "主机",
    "terminal.empty": "当前没有打开的终端标签页，请从主机页打开。",
    "terminal.new_tab_hint": "请选择一个主机来打开新终端标签页。",
    "terminal.pane.empty": "空窗格",
    "terminal.status.connecting": "连接中...",
    "terminal.status.connected": "已连接",
    "terminal.status.disconnected": "已断开",
    "terminal.via": "经由 {jump}",
    "terminal.error.connect_failed_status": "连接失败：{error}",
    "terminal.error.connect_failed_term": "连接失败：{error}",
    "terminal.error.new_window_failed": "新窗口打开失败：{error}",
    "terminal.error.split_limit": "当前分屏模式最多支持 2 个窗格。",
    "terminal.error.no_host": "当前活动窗格没有可复制的主机。",
    "terminal.closed.remote_exited": "[远端退出状态 {code}]",
    "terminal.closed.disconnected": "[已断开]",
    "host_key.unknown_title": "未知主机",
    "host_key.unknown_body":
      "无法确认“{host}:{port}”的真实性。信任后会将该主机密钥写入 known_hosts。",
    "host_key.changed_title": "警告：主机密钥已变化",
    "host_key.changed_body": "这可能是中间人攻击，请确认变更原因后再继续。",
    "host_key.changed_server_now": "服务器当前提供：",
    "host_key.changed_known_hosts_has": "known_hosts 中记录：",
    "host_key.unknown_value": "（未知）",
    "host_key.reject": "取消连接",
    "host_key.accept": "信任并连接",
    "host_editor.title.add": "新增主机",
    "host_editor.title.edit": "编辑主机",
    "host_editor.label.name": "名称",
    "host_editor.label.user": "用户",
    "host_editor.label.host": "主机",
    "host_editor.placeholder.host": "主机名或 IP",
    "host_editor.label.port": "端口",
    "host_editor.label.auth": "认证方式",
    "host_editor.label.password": "密码",
    "host_editor.label.private_key": "私钥",
    "host_editor.label.passphrase": "私钥口令（可选）",
    "host_editor.label.proxy_jump": "ProxyJump（已保存别名）",
    "host_editor.label.advanced": "ProxyJump 与转发",
    "host_editor.label.port_forwards": "端口转发",
    "host_editor.button.add_forward": "+ 添加转发",
    "host_editor.hint.forwards": "支持本地转发（-L）和动态 SOCKS5（-D）。",
    "host_editor.button.choose_key": "选择文件...",
    "host_editor.button.cancel": "取消",
    "host_editor.button.save": "保存",
    "host_editor.auth.password": "密码",
    "host_editor.auth.key": "私钥",
    "host_editor.auth.agent": "SSH agent",
    "host_editor.key.none": "尚未加载私钥",
    "host_editor.key.existing": "保留已有私钥（选择文件可替换）",
    "host_editor.jump.none": "（无）",
    "host_editor.forward.none": "（无转发）",
    "host_editor.forward.local": "本地转发 (-L)",
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.bind": "监听地址",
    "host_editor.forward.port": "端口",
    "host_editor.forward.target_host": "目标主机",
    "host_editor.forward.remove": "移除",
    "host_editor.key.pick_title": "选择私钥文件",
    "host_editor.key.loaded": "已加载 {name}（{bytes} 字节）",
    "host_editor.key.read_failed": "读取失败：{error}",
    "host_editor.error.pick_new_key": "请先选择新的私钥文件以替换已有私钥。",
    "host_editor.error.pick_key_first": "请先选择私钥文件。",
    "host_editor.error.required_fields": "名称、主机、用户为必填项",
    "host_editor.error.load_failed": "加载失败：{error}",
    "host_editor.error.forward_bind_port": "第 {index} 条转发：监听端口无效",
    "host_editor.error.forward_target_host": "第 {index} 条转发：目标主机必填",
    "host_editor.error.forward_target_port": "第 {index} 条转发：目标端口无效",
    "files.title": "文件",
    "files.button.back": "返回",
    "files.button.up": "上级目录",
    "files.button.up_title": "返回父目录",
    "files.button.refresh": "刷新",
    "files.button.new_folder": "新建文件夹",
    "files.button.upload": "上传",
    "files.button.upload_many": "批量上传",
    "files.select_all": "全选",
    "files.button.download_selected": "下载所选",
    "files.button.delete_selected": "删除所选",
    "files.drop.hint": "拖拽文件到此处上传到当前目录",
    "files.menu.edit": "编辑",
    "files.menu.download": "下载",
    "files.menu.rename": "重命名",
    "files.menu.delete": "删除",
    "files.selection.count": "已选 {count} 项",
    "files.status.connecting": "连接中...",
    "files.status.listing": "正在列出 {path}...",
    "files.error.mkdir_failed": "创建目录失败：{error}",
    "files.prompt.new_folder": "新文件夹名称：",
    "files.empty": "（空）",
    "files.error.open_failed": "打开失败：{error}",
    "files.error.list_failed": "列表读取失败：{error}",
    "files.status.downloaded_one": "已下载 {name}（{size}）。",
    "files.error.download_failed": "下载失败：{error}",
    "files.prompt.rename": "将“{name}”重命名为：",
    "files.error.rename_failed": "重命名失败：{error}",
    "files.confirm.delete_entry": "确认删除 {path}？",
    "files.error.delete_failed": "删除失败：{error}",
    "files.confirm.delete_selected": "确认删除已选的 {count} 项？",
    "files.error.delete_failed_for": "删除 {name} 失败：{error}",
    "files.status.uploaded_one": "已上传 {name}（{size}）。",
    "files.error.upload_failed_for": "上传 {name} 失败：{error}",
    "files.error.drag_upload_failed_for": "拖拽上传 {name} 失败：{error}",
    "files.alert.download_selected_none": "请至少选择一个文件（目录会被跳过）。",
    "files.error.download_failed_for": "下载 {name} 失败：{error}",
    "files.status.downloaded_many_to": "已下载 {count} 个文件到 {folder}。",
    "files.progress.uploading": "上传中",
    "files.progress.downloading": "下载中",
    "files.progress.eta": "剩余 {eta}",
    "files.button.cancel": "取消",
    "editor.title": "编辑远程文件",
    "editor.title.dirty": "编辑远程文件 *",
    "editor.hint.default": "支持常见 UTF-8 文本文件。按 Ctrl/Cmd + S 保存。",
    "editor.hint.loading": "正在加载文件内容...",
    "editor.hint.opening": "正在打开...",
    "editor.hint.unavailable": "无法在内置编辑器中打开该文件。",
    "editor.hint.saved": "刚刚已保存 {size}",
    "editor.hint.replaced_one": "已替换 1 处。",
    "editor.hint.replaced_many": "已替换 {count} 处。",
    "editor.hint.utf8_info": "UTF-8 文本 · {lines} 行 · Ctrl/Cmd + S 保存",
    "editor.find.placeholder": "查找...",
    "editor.replace.placeholder": "替换...",
    "editor.match_case": "区分大小写",
    "editor.button.prev": "上一个",
    "editor.button.next": "下一个",
    "editor.button.replace": "替换",
    "editor.button.replace_all": "全部替换",
    "editor.button.close": "关闭",
    "editor.button.save": "保存",
    "editor.error.ace_load_failed": "Ace 编辑器加载失败。",
    "editor.error.enter_search": "请先输入要查找的文本。",
    "editor.error.no_matches": "未找到匹配项。",
    "editor.error.no_matches_replace": "没有可替换的匹配项。",
    "editor.error.no_selected_match": "当前没有可替换的匹配项。",
    "editor.alert.unsupported": "该文件类型不在内置编辑范围内，或文件过大。",
    "editor.alert.component_failed": "编辑器组件加载失败。",
    "editor.confirm.discard": "确认丢弃未保存的编辑内容？",
    "editor.confirm.close_unsaved": "有未保存修改，仍要关闭编辑器吗？",
    "editor.error.open_failed": "打开失败：{error}",
    "editor.error.save_failed": "保存失败：{error}",
    "files.status.saved_path": "已保存 {path}。",
    "settings.title": "设置",
    "settings.language.label": "语言",
    "settings.language.hint": "修改立即生效，并会保存在本地。",
    "settings.button.close": "关闭",
    "settings.language.zh": "简体中文",
    "settings.language.en": "English",
  },
};

function detectInitialLocale() {
  const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (saved && I18N[saved]) return saved;
  const langs = navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language || "en"];
  return langs.some((l) => String(l).toLowerCase().startsWith("zh")) ? "zh-CN" : "en";
}

let currentLocale = detectInitialLocale();

function t(key, vars = {}) {
  const dict = I18N[currentLocale] || I18N.en;
  const template = dict[key] ?? I18N.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) {
      return String(vars[name]);
    }
    return `{${name}}`;
  });
}

function setText(id, key, vars) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = t(key, vars);
}

function setPlaceholder(id, key, vars) {
  const el = document.getElementById(id);
  if (!el) return;
  el.placeholder = t(key, vars);
}

function setOptionText(selectId, value, key) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const opt = Array.from(sel.options).find((o) => o.value === value);
  if (!opt) return;
  opt.textContent = t(key);
}

function setAttr(id, attr, key, vars) {
  const el = document.getElementById(id);
  if (!el) return;
  el.setAttribute(attr, t(key, vars));
}

function authTypeLabel(kind) {
  if (kind === "password") return t("host_editor.auth.password");
  if (kind === "key") return t("host_editor.auth.key");
  if (kind === "agent") return t("host_editor.auth.agent");
  return kind;
}

function setLocale(locale) {
  if (!I18N[locale]) return;
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  applyI18n();
}

const FILE_EDITOR_MAX_BYTES = 2 * 1024 * 1024;

const EDITABLE_TEXT_EXTS = new Set([
  "txt", "log", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "cnf", "env", "sh", "bash", "zsh", "fish", "ps1",
  "sql", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx",
  "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "h",
  "cpp", "hpp", "cc", "cs", "vue", "svelte", "properties", "service",
]);

const EDITABLE_TEXT_BASENAMES = new Set([
  "dockerfile", "makefile", "readme", "readme.md", ".env", ".gitignore",
  ".gitattributes", ".bashrc", ".zshrc", ".profile", "nginx.conf",
  "sshd_config", "authorized_keys", "known_hosts", "config",
]);

const ACE_BASE_PATH = "https://cdn.jsdelivr.net/npm/ace-builds@1.42.0/src-min-noconflict";

const MODE_BY_EXTENSION = {
  txt: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  conf: "ini",
  cfg: "ini",
  cnf: "ini",
  env: "sh",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
  html: "html",
  htm: "html",
  css: "css",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "golang",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  c: "c_cpp",
  h: "c_cpp",
  cc: "c_cpp",
  cpp: "c_cpp",
  hpp: "c_cpp",
  cs: "csharp",
  vue: "vue",
  svelte: "svelte",
  properties: "properties",
  service: "ini",
};

function isLikelyEditableTextName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return false;
  if (EDITABLE_TEXT_BASENAMES.has(lower)) return true;
  if (lower.startsWith(".env")) return true;

  const idx = lower.lastIndexOf(".");
  if (idx <= 0 || idx === lower.length - 1) return false;
  const ext = lower.slice(idx + 1);
  return EDITABLE_TEXT_EXTS.has(ext);
}

function detectAceModeByName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower) return "text";
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";
  if (lower === "nginx.conf") return "nginx";

  const idx = lower.lastIndexOf(".");
  if (idx <= 0 || idx === lower.length - 1) return "text";
  const ext = lower.slice(idx + 1);
  return MODE_BY_EXTENSION[ext] || "text";
}

// --------------------------------------------------------------------------
// Unlock flow
// --------------------------------------------------------------------------

const unlockForm = document.getElementById("unlock-form");
const unlockStatus = document.getElementById("unlock-status");
const unlockLabel = document.getElementById("unlock-label");
const unlockButton = document.getElementById("unlock-button");
const unlockPassword = document.getElementById("unlock-password");
const unlockConfirm = document.getElementById("unlock-confirm");
const unlockRemember = document.getElementById("unlock-remember");
const unlockError = document.getElementById("unlock-error");
const unlockPath = document.getElementById("unlock-path");

let vaultExists = false;

async function refreshVaultStatus({ tryKeychain = true } = {}) {
  try {
    const status = await invoke("vault_status");
    vaultExists = status.exists;
    unlockPath.textContent = t("unlock.path", { path: status.path });

    if (status.unlocked) {
      await enterHosts();
      return;
    }

    if (status.exists) {
      if (tryKeychain) {
        try {
          const ok = await invoke("try_keychain_unlock");
          if (ok) {
            await enterHosts();
            return;
          }
        } catch (e) {
          console.warn("try_keychain_unlock failed", e);
        }
      }

      unlockStatus.textContent = t("unlock.enter_password");
      unlockLabel.textContent = t("unlock.label.master");
      unlockButton.textContent = t("unlock.button.unlock");
      unlockConfirm.hidden = true;
    } else {
      unlockStatus.textContent = t("unlock.no_vault");
      unlockLabel.textContent = t("unlock.label.new_master");
      unlockButton.textContent = t("unlock.button.create");
      unlockConfirm.hidden = false;
    }

    unlockRemember.checked = false;
    unlockForm.hidden = false;
    unlockPassword.focus();
  } catch (e) {
    unlockStatus.textContent = t("common.error", { error: e });
  }
}

unlockForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  unlockError.hidden = true;

  const password = unlockPassword.value;
  const remember = unlockRemember.checked;

  try {
    if (vaultExists) {
      await invoke("unlock_vault", { password, remember });
    } else {
      if (password !== unlockConfirm.value) {
        throw new Error(t("unlock.error.passwords_mismatch"));
      }
      await invoke("create_vault", { password, remember });
    }

    unlockPassword.value = "";
    unlockConfirm.value = "";
    unlockRemember.checked = false;
    await enterHosts();
  } catch (e) {
    unlockError.textContent = String(e);
    unlockError.hidden = false;
  }
});

// --------------------------------------------------------------------------
// Hosts view
// --------------------------------------------------------------------------

const hostsList = document.getElementById("hosts-list");
const hostsEmpty = document.getElementById("hosts-empty");
const hostSearch = document.getElementById("host-search");
const hostsSelectionHint = document.getElementById("hosts-selection-hint");
const hostsConnectSelected = document.getElementById("hosts-connect-selected");
const hostsDeleteSelected = document.getElementById("hosts-delete-selected");
const openTerminalsButton = document.getElementById("open-terminals-button");
const newWindowButton = document.getElementById("new-window-button");
const settingsButton = document.getElementById("settings-button");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsCloseButton = document.getElementById("settings-close-button");
const settingsLanguageSelect = document.getElementById("settings-language-select");

let hostsCache = [];
const selectedHostIds = new Set();

function applyI18n() {
  document.documentElement.lang = currentLocale === "zh-CN" ? "zh-CN" : "en";

  setText("unlock-remember-text", "unlock.remember");
  setPlaceholder("unlock-confirm", "unlock.confirm_placeholder");
  if (unlockForm.hidden) {
    setText("unlock-status", "unlock.checking");
  } else if (vaultExists) {
    setText("unlock-status", "unlock.enter_password");
    setText("unlock-label", "unlock.label.master");
    setText("unlock-button", "unlock.button.unlock");
  } else {
    setText("unlock-status", "unlock.no_vault");
    setText("unlock-label", "unlock.label.new_master");
    setText("unlock-button", "unlock.button.create");
  }

  setText("nav-hosts", "nav.hosts");
  setText("nav-keychain", "nav.keychain");
  setText("nav-port-forwarding", "nav.port_forwarding");
  setText("nav-known-hosts", "nav.known_hosts");
  setText("nav-logs", "nav.logs");
  setText("open-terminals-button", "sidebar.terminals");
  setText("new-window-button", "sidebar.new_window");
  setText("settings-button", "sidebar.settings");
  setText("lock-button", "sidebar.lock");

  setPlaceholder("host-search", "hosts.search.placeholder");
  setText("add-host-button", "hosts.new_host");
  setText("hosts-connect-selected", "hosts.connect_selected");
  setText("hosts-delete-selected", "hosts.delete_selected");

  setText("new-tab-button", "terminal.button.new_tab");
  setText("split-vertical-button", "terminal.button.split_v");
  setText("split-horizontal-button", "terminal.button.split_h");
  setText("close-split-button", "terminal.button.close_split");
  setText("disconnect-button", "terminal.button.disconnect");
  setText("term-new-window-button", "terminal.button.new_window");
  setText("back-button", "terminal.button.back_hosts");

  setText("files-title", "files.title");
  setText("files-back", "files.button.back");
  setText("files-up", "files.button.up");
  setAttr("files-up", "title", "files.button.up_title");
  setText("files-refresh", "files.button.refresh");
  setText("files-mkdir", "files.button.new_folder");
  setText("files-upload", "files.button.upload");
  setText("files-upload-many", "files.button.upload_many");
  setText("files-select-all-label", "files.select_all");
  setText("files-download-selected", "files.button.download_selected");
  setText("files-delete-selected", "files.button.delete_selected");
  setText("progress-cancel", "files.button.cancel");
  setText("files-drop-overlay", "files.drop.hint");
  setText("files-menu-edit", "files.menu.edit");
  setText("files-menu-download", "files.menu.download");
  setText("files-menu-rename", "files.menu.rename");
  setText("files-menu-delete", "files.menu.delete");

  setText("hk-reject", "host_key.reject");
  setText("hk-accept", "host_key.accept");

  setText("hf-name-label", "host_editor.label.name");
  setText("hf-user-label", "host_editor.label.user");
  setText("hf-host-label", "host_editor.label.host");
  setText("hf-port-label", "host_editor.label.port");
  setText("hf-auth-label", "host_editor.label.auth");
  setText("hf-password-label", "host_editor.label.password");
  setText("hf-key-label", "host_editor.label.private_key");
  setText("hf-key-passphrase-label", "host_editor.label.passphrase");
  setText("hf-jump-label", "host_editor.label.proxy_jump");
  setText("hf-advanced-legend", "host_editor.label.advanced");
  setText("hf-forwards-label", "host_editor.label.port_forwards");
  setText("hf-forward-add", "host_editor.button.add_forward");
  setText("hf-forwards-hint", "host_editor.hint.forwards");
  setText("hf-key-pick", "host_editor.button.choose_key");
  setText("host-edit-cancel", "host_editor.button.cancel");
  setText("host-edit-save", "host_editor.button.save");
  setPlaceholder("hf-host", "host_editor.placeholder.host");
  setOptionText("hf-auth-type", "password", "host_editor.auth.password");
  setOptionText("hf-auth-type", "key", "host_editor.auth.key");
  setOptionText("hf-auth-type", "agent", "host_editor.auth.agent");

  setPlaceholder("file-editor-find", "editor.find.placeholder");
  setPlaceholder("file-editor-replace", "editor.replace.placeholder");
  setText("editor-match-case-label", "editor.match_case");
  setText("file-editor-find-prev", "editor.button.prev");
  setText("file-editor-find-next", "editor.button.next");
  setText("file-editor-replace-one", "editor.button.replace");
  setText("file-editor-replace-all", "editor.button.replace_all");
  setText("file-editor-cancel", "editor.button.close");
  setText("file-editor-save", "editor.button.save");

  setText("settings-title", "settings.title");
  setText("settings-language-label", "settings.language.label");
  setText("settings-language-hint", "settings.language.hint");
  setText("settings-close-button", "settings.button.close");
  setOptionText("settings-language-select", "zh-CN", "settings.language.zh");
  setOptionText("settings-language-select", "en", "settings.language.en");
  if (settingsLanguageSelect) settingsLanguageSelect.value = currentLocale;

  updateHostsSelectionState();
  updateFilesSelectionState();

  if (!views.hosts.hidden) renderHosts();
  if (!views.terminal.hidden) renderTerminalWorkspace();
  if (!views.files.hidden) {
    renderFilesList(filesEntries);
    if (filesHost) {
      filesTitle.textContent = `${filesHost.name} (${filesHost.user}@${filesHost.host}:${filesHost.port})`;
    }
  }
  if (!hostOverlay.hidden) {
    hostTitle.textContent = editingHostId ? t("host_editor.title.edit") : t("host_editor.title.add");
    if (!hfKeyPem && hfAuthType.value === "key") {
      hfKeyStatus.textContent = editingHostId
        ? t("host_editor.key.existing")
        : t("host_editor.key.none");
    }
    renderForwards();
  }

  if (fileEditorOverlay.hidden) {
    setText("file-editor-title", "editor.title");
    setText("file-editor-hint", "editor.hint.default");
  } else {
    setText("file-editor-title", fileEditorState.dirty ? "editor.title.dirty" : "editor.title");
    if (fileEditorState.open) {
      setText("file-editor-hint", "editor.hint.utf8_info", {
        lines: fileEditorGetValue().split(/\r?\n/).length,
      });
    }
  }
}

hostSearch.addEventListener("input", () => renderHosts());

document.getElementById("lock-button").addEventListener("click", async () => {
  try {
    await invoke("forget_keychain");
  } catch (e) {
    console.warn("forget_keychain failed", e);
  }
  await invoke("lock_vault");
  show("unlock");
  refreshVaultStatus({ tryKeychain: false });
});

document.getElementById("add-host-button").addEventListener("click", () => openHostEditor());
settingsButton.addEventListener("click", () => {
  settingsLanguageSelect.value = currentLocale;
  settingsOverlay.hidden = false;
});
settingsCloseButton.addEventListener("click", () => {
  settingsOverlay.hidden = true;
});
settingsOverlay.addEventListener("click", (ev) => {
  if (ev.target === settingsOverlay) {
    settingsOverlay.hidden = true;
  }
});
settingsLanguageSelect.addEventListener("change", () => {
  setLocale(settingsLanguageSelect.value);
});

hostsConnectSelected.addEventListener("click", async () => {
  const picked = hostsCache.filter((h) => selectedHostIds.has(h.id));
  if (picked.length === 0) return;
  for (const host of picked) {
    await openHostInTerminal(host);
  }
});

hostsDeleteSelected.addEventListener("click", async () => {
  const picked = hostsCache.filter((h) => selectedHostIds.has(h.id));
  if (picked.length === 0) return;
  if (!confirm(t("hosts.confirm.delete_selected", { count: picked.length }))) return;

  for (const host of picked) {
    try {
      await invoke("delete_host", { id: host.id });
    } catch (e) {
      alert(t("hosts.error.delete_failed_for", { name: host.name, error: e }));
      break;
    }
  }
  await enterHosts();
});

openTerminalsButton.addEventListener("click", () => {
  if (termState.tabs.length === 0) {
    alert(t("hosts.error.no_tabs"));
    return;
  }
  show("terminal");
  renderTerminalWorkspace();
});

newWindowButton.addEventListener("click", () => {
  invoke("open_new_window").catch((e) => alert(t("terminal.error.new_window_failed", { error: e })));
});

async function enterHosts() {
  show("hosts");
  selectedHostIds.clear();
  hostSearch.value = "";

  try {
    hostsCache = await invoke("list_hosts");
  } catch (e) {
    hostsCache = [];
    hostsEmpty.hidden = false;
    hostsEmpty.textContent = t("hosts.error.load_failed", { error: e });
    return;
  }

  renderHosts();
}

function renderHosts() {
  hostsList.innerHTML = "";

  const q = hostSearch.value.trim().toLowerCase();
  const rows = q
    ? hostsCache.filter((h) =>
      `${h.name} ${h.user} ${h.host} ${h.port}`.toLowerCase().includes(q)
    )
    : hostsCache;

  if (rows.length === 0) {
    hostsEmpty.hidden = false;
    hostsEmpty.textContent = q
      ? t("hosts.empty.search")
      : t("hosts.empty.default");
  } else {
    hostsEmpty.hidden = true;
  }

  for (const host of rows) {
    const li = document.createElement("li");
    li.className = "host-card";

    const top = document.createElement("div");
    top.className = "row-top";

    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.checked = selectedHostIds.has(host.id);
    pick.addEventListener("change", () => {
      if (pick.checked) selectedHostIds.add(host.id);
      else selectedHostIds.delete(host.id);
      updateHostsSelectionState();
    });

    const badge = document.createElement("div");
    badge.className = "badge";

    const info = document.createElement("div");
    info.style.minWidth = "0";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = host.name;

    const target = document.createElement("div");
    target.className = "target";
    target.textContent = `${host.user}@${host.host}:${host.port}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = authTypeLabel(host.authType);

    info.append(name, target, meta);
    top.append(pick, badge, info);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.textContent = t("hosts.button.connect");
    connectBtn.className = "primary";
    connectBtn.addEventListener("click", () => openHostInTerminal(host));

    const filesBtn = document.createElement("button");
    filesBtn.type = "button";
    filesBtn.textContent = t("hosts.button.files");
    filesBtn.addEventListener("click", () => openFiles(host));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = t("hosts.button.edit");
    editBtn.addEventListener("click", () => openHostEditor(host.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = t("hosts.button.delete");
    delBtn.className = "danger";
    delBtn.addEventListener("click", async () => {
      if (!confirm(t("hosts.confirm.delete_one", { name: host.name }))) return;
      try {
        await invoke("delete_host", { id: host.id });
        await enterHosts();
      } catch (e) {
        alert(t("hosts.error.delete_failed", { error: e }));
      }
    });

    actions.append(connectBtn, filesBtn, editBtn, delBtn);
    li.append(top, actions);
    hostsList.appendChild(li);
  }

  updateHostsSelectionState();
}

function updateHostsSelectionState() {
  const count = selectedHostIds.size;
  hostsSelectionHint.textContent = t("hosts.selection.count", { count });
  hostsConnectSelected.disabled = count === 0;
  hostsDeleteSelected.disabled = count === 0;
}

// --------------------------------------------------------------------------
// Terminal tabs / splits
// --------------------------------------------------------------------------

const termTabStrip = document.getElementById("term-tab-strip");
const terminalWorkspace = document.getElementById("terminal-workspace");
const backButton = document.getElementById("back-button");
const newTabButton = document.getElementById("new-tab-button");
const splitVerticalButton = document.getElementById("split-vertical-button");
const splitHorizontalButton = document.getElementById("split-horizontal-button");
const closeSplitButton = document.getElementById("close-split-button");
const disconnectButton = document.getElementById("disconnect-button");
const termNewWindowButton = document.getElementById("term-new-window-button");

const termState = {
  tabs: [],
  activeTabId: null,
};

backButton.addEventListener("click", () => {
  show("hosts");
});

newTabButton.addEventListener("click", () => {
  show("hosts");
  alert(t("terminal.new_tab_hint"));
});

splitVerticalButton.addEventListener("click", () => splitActiveTab("vertical"));
splitHorizontalButton.addEventListener("click", () => splitActiveTab("horizontal"));
closeSplitButton.addEventListener("click", closeActiveSplit);

disconnectButton.addEventListener("click", async () => {
  const pane = getActivePane();
  if (!pane || pane.sessionId === null) return;
  try {
    await invoke("disconnect_session", { sessionId: pane.sessionId });
  } catch (e) {
    console.warn("disconnect session failed", e);
  }
});

termNewWindowButton.addEventListener("click", () => {
  invoke("open_new_window").catch((e) => alert(t("terminal.error.new_window_failed", { error: e })));
});

function getActiveTab() {
  return termState.tabs.find((t) => t.id === termState.activeTabId) || null;
}

function getActivePane() {
  const tab = getActiveTab();
  if (!tab) return null;
  return tab.panes.find((p) => p.id === tab.activePaneId) || tab.panes[0] || null;
}

function createPane(host) {
  return {
    id: uniqueId("pane"),
    host,
    sessionId: null,
    rootEl: null,
    bodyEl: null,
    titleEl: null,
    statusEl: null,
    term: null,
    fitAddon: null,
    dataUnlisten: null,
    closedUnlisten: null,
    resizeObserver: null,
  };
}

async function openHostInTerminal(host) {
  let tab = {
    id: uniqueId("tab"),
    title: host.name,
    layout: "single",
    panes: [],
    activePaneId: null,
  };

  const pane = createPane(host);
  tab.panes.push(pane);
  tab.activePaneId = pane.id;
  termState.tabs.push(tab);
  termState.activeTabId = tab.id;

  show("terminal");
  renderTerminalWorkspace();
  await connectPaneSession(pane);
}

function renderTerminalWorkspace() {
  renderTabStrip();

  terminalWorkspace.innerHTML = "";
  const tab = getActiveTab();
  if (!tab) {
    terminalWorkspace.className = "terminal-workspace layout-single";
    const empty = document.createElement("div");
    empty.className = "term-empty";
    empty.textContent = t("terminal.empty");
    terminalWorkspace.appendChild(empty);
    return;
  }

  const layout = tab.layout === "vertical"
    ? "layout-vertical"
    : tab.layout === "horizontal"
      ? "layout-horizontal"
      : "layout-single";
  terminalWorkspace.className = `terminal-workspace ${layout}`;

  for (const pane of tab.panes) {
    ensurePaneElements(pane, tab);
    pane.rootEl.classList.toggle("active", pane.id === tab.activePaneId);
    terminalWorkspace.appendChild(pane.rootEl);
  }

  requestAnimationFrame(() => {
    for (const pane of tab.panes) {
      fitPane(pane);
    }
  });
}

function renderTabStrip() {
  termTabStrip.innerHTML = "";

  for (const tab of termState.tabs) {
    const el = document.createElement("div");
    el.className = "tab-item" + (tab.id === termState.activeTabId ? " active" : "");

    const title = document.createElement("span");
    title.textContent = tab.title;

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTab(tab.id);
    });

    el.append(title, close);
    el.addEventListener("click", () => {
      termState.activeTabId = tab.id;
      renderTerminalWorkspace();
    });

    termTabStrip.appendChild(el);
  }
}

function ensurePaneElements(pane, tab) {
  if (pane.rootEl) return;

  const root = document.createElement("div");
  root.className = "term-pane";

  const header = document.createElement("div");
  header.className = "pane-header";

  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = pane.host
    ? `${pane.host.name} (${pane.host.user}@${pane.host.host}:${pane.host.port})`
    : t("terminal.pane.empty");

  const status = document.createElement("span");
  status.className = "pane-status";
  status.textContent = t("terminal.status.connecting");

  const body = document.createElement("div");
  body.className = "pane-body";

  header.append(title, status);
  root.append(header, body);

  root.addEventListener("click", () => {
    tab.activePaneId = pane.id;
    renderTerminalWorkspace();
  });

  pane.rootEl = root;
  pane.bodyEl = body;
  pane.titleEl = title;
  pane.statusEl = status;

  ensurePaneTerminal(pane);
}

function ensurePaneTerminal(pane) {
  if (pane.term || !pane.bodyEl) return;

  pane.term = new Terminal({
    fontFamily: '"JetBrains Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
    fontSize: 13,
    theme: {
      background: "#05080f",
      foreground: "#e7ecff",
      cursor: "#9cc3ff",
    },
    cursorBlink: true,
    scrollback: 10000,
    convertEol: false,
  });

  pane.fitAddon = new FitAddon();
  pane.term.loadAddon(pane.fitAddon);
  pane.term.open(pane.bodyEl);
  pane.fitAddon.fit();

  pane.term.onData((d) => {
    if (pane.sessionId === null) return;
    const bytes = Array.from(new TextEncoder().encode(d));
    invoke("send_input", { sessionId: pane.sessionId, data: bytes }).catch((e) => {
      console.warn("send_input failed", e);
    });
  });

  pane.resizeObserver = new ResizeObserver(() => {
    fitPane(pane);
  });
  pane.resizeObserver.observe(pane.bodyEl);
}

function fitPane(pane) {
  if (!pane.term || !pane.fitAddon) return;
  try {
    pane.fitAddon.fit();
  } catch {
    return;
  }
  if (pane.sessionId !== null) {
    invoke("resize_session", {
      sessionId: pane.sessionId,
      cols: pane.term.cols,
      rows: pane.term.rows,
    }).catch(() => {});
  }
}

async function connectPaneSession(pane) {
  if (!pane.host) return;
  ensurePaneTerminal(pane);

  if (pane.sessionId !== null) {
    await disconnectPaneSession(pane, { dispose: false });
  }

  const cols = pane.term ? pane.term.cols : 80;
  const rows = pane.term ? pane.term.rows : 24;

  try {
    const sessionId = await invoke("connect_host", {
      hostId: pane.host.id,
      cols,
      rows,
    });
    pane.sessionId = sessionId;
    pane.statusEl.textContent = t("terminal.status.connected");

    await wirePaneSessionEvents(pane, sessionId);

    try {
      const info = await invoke("session_info", { sessionId });
      const bits = [];
      if (info.jump) bits.push(t("terminal.via", { jump: info.jump }));
      if (info.forwards.length > 0) bits.push(info.forwards.join(", "));
      if (bits.length > 0) {
        pane.statusEl.textContent = bits.join(" · ");
      }
    } catch (e) {
      console.warn("session_info failed", e);
    }
  } catch (e) {
    pane.statusEl.textContent = t("terminal.error.connect_failed_status", { error: e });
    if (pane.term) {
      pane.term.write(`\x1b[31m${t("terminal.error.connect_failed_term", { error: e })}\x1b[0m\r\n`);
    }
  }
}

async function wirePaneSessionEvents(pane, sessionId) {
  if (pane.dataUnlisten) {
    pane.dataUnlisten();
    pane.dataUnlisten = null;
  }
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }

  pane.dataUnlisten = await listen("session:data", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    if (!pane.term) return;
    pane.term.write(new Uint8Array(ev.payload.data));
  });

  pane.closedUnlisten = await listen("session:closed", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    const tail = ev.payload.message
      ? `\r\n\x1b[31m${ev.payload.message}\x1b[0m\r\n`
      : ev.payload.exitCode != null
        ? `\r\n\x1b[2m${t("terminal.closed.remote_exited", { code: ev.payload.exitCode })}\x1b[0m\r\n`
        : `\r\n\x1b[2m${t("terminal.closed.disconnected")}\x1b[0m\r\n`;

    pane.sessionId = null;
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.status.disconnected");
    if (pane.term) pane.term.write(tail);
  });
}

async function disconnectPaneSession(pane, { dispose }) {
  const sid = pane.sessionId;
  pane.sessionId = null;

  if (sid !== null) {
    try {
      await invoke("disconnect_session", { sessionId: sid });
    } catch (e) {
      console.warn("disconnect_session failed", e);
    }
  }

  if (pane.dataUnlisten) {
    pane.dataUnlisten();
    pane.dataUnlisten = null;
  }
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }

  if (dispose) {
    if (pane.resizeObserver && pane.bodyEl) {
      pane.resizeObserver.disconnect();
    }
    pane.resizeObserver = null;

    if (pane.term) pane.term.dispose();
    pane.term = null;
    pane.fitAddon = null;

    if (pane.rootEl?.parentNode) pane.rootEl.parentNode.removeChild(pane.rootEl);
    pane.rootEl = null;
    pane.bodyEl = null;
    pane.titleEl = null;
    pane.statusEl = null;
  }
}

function closeTab(tabId) {
  const idx = termState.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = termState.tabs[idx];

  tab.panes.forEach((pane) => {
    disconnectPaneSession(pane, { dispose: true });
  });

  termState.tabs.splice(idx, 1);

  if (termState.tabs.length === 0) {
    termState.activeTabId = null;
  } else if (termState.activeTabId === tabId) {
    termState.activeTabId = termState.tabs[Math.max(0, idx - 1)].id;
  }

  if (termState.tabs.length === 0) {
    show("hosts");
  } else {
    renderTerminalWorkspace();
  }
}

async function splitActiveTab(orientation) {
  const tab = getActiveTab();
  if (!tab) return;

  if (tab.panes.length >= 2) {
    alert(t("terminal.error.split_limit"));
    return;
  }

  const source = getActivePane();
  if (!source || !source.host) {
    alert(t("terminal.error.no_host"));
    return;
  }

  const newPane = createPane(source.host);
  tab.panes.push(newPane);
  tab.activePaneId = newPane.id;
  tab.layout = orientation;

  renderTerminalWorkspace();
  await connectPaneSession(newPane);
}

function closeActiveSplit() {
  const tab = getActiveTab();
  if (!tab || tab.panes.length <= 1) return;

  const active = getActivePane();
  let removeIndex = tab.panes.findIndex((p) => p.id === active?.id);
  if (removeIndex < 0) removeIndex = tab.panes.length - 1;
  const pane = tab.panes[removeIndex];

  disconnectPaneSession(pane, { dispose: true });
  tab.panes.splice(removeIndex, 1);
  tab.layout = "single";
  tab.activePaneId = tab.panes[0].id;
  renderTerminalWorkspace();
}

// --------------------------------------------------------------------------
// Host-key prompt
// --------------------------------------------------------------------------

const hkOverlay = document.getElementById("host-key-overlay");
const hkTitle = document.getElementById("hk-title");
const hkBody = document.getElementById("hk-body");
const hkDetail = document.getElementById("hk-detail");
const hkAccept = document.getElementById("hk-accept");
const hkReject = document.getElementById("hk-reject");

let currentHostKey = null;

listen("host-key-prompt", (ev) => {
  currentHostKey = ev.payload;

  if (currentHostKey.kind === "unknown") {
    hkTitle.textContent = t("host_key.unknown_title");
    hkBody.textContent = t("host_key.unknown_body", {
      host: currentHostKey.host,
      port: currentHostKey.port,
    });
    hkDetail.textContent = `${currentHostKey.keyType}\n${currentHostKey.fingerprint}`;
  } else {
    hkTitle.textContent = t("host_key.changed_title");
    hkBody.textContent = t("host_key.changed_body");
    hkDetail.textContent =
      `${t("host_key.changed_server_now")}\n  ${currentHostKey.keyType} ${currentHostKey.fingerprint}\n` +
      `${t("host_key.changed_known_hosts_has")}\n  ${currentHostKey.stored ?? t("host_key.unknown_value")}`;
  }

  hkOverlay.hidden = false;
});

hkAccept.addEventListener("click", () => respondHostKey(true));
hkReject.addEventListener("click", () => respondHostKey(false));

async function respondHostKey(accept) {
  if (!currentHostKey) return;
  const id = currentHostKey.requestId;
  currentHostKey = null;
  hkOverlay.hidden = true;
  try {
    await invoke("respond_host_key", { requestId: id, accept });
  } catch (e) {
    console.warn("respond_host_key failed", e);
  }
}

// --------------------------------------------------------------------------
// Host editor
// --------------------------------------------------------------------------

const hostOverlay = document.getElementById("host-edit-overlay");
const hostForm = document.getElementById("host-edit-form");
const hostTitle = document.getElementById("host-edit-title");
const hfName = document.getElementById("hf-name");
const hfHost = document.getElementById("hf-host");
const hfPort = document.getElementById("hf-port");
const hfUser = document.getElementById("hf-user");
const hfAuthType = document.getElementById("hf-auth-type");
const hfPasswordBlock = document.getElementById("hf-password-block");
const hfPassword = document.getElementById("hf-password");
const hfKeyBlock = document.getElementById("hf-key-block");
const hfKeyPick = document.getElementById("hf-key-pick");
const hfKeyStatus = document.getElementById("hf-key-status");
const hfKeyPassphrase = document.getElementById("hf-key-passphrase");
const hfJump = document.getElementById("hf-jump");
const hfForwardsList = document.getElementById("hf-forwards");
const hfForwardAdd = document.getElementById("hf-forward-add");
const hostError = document.getElementById("host-edit-error");
const hostReadonly = document.getElementById("host-edit-readonly");

let editingHostId = null;
let hfKeyPem = null;
let hfForwards = [];

hfAuthType.addEventListener("change", () => syncAuthSections());
hfKeyPick.addEventListener("click", pickKeyFile);
hfForwardAdd.addEventListener("click", () => {
  hfForwards.push({
    kind: "local",
    bindAddr: "127.0.0.1",
    bindPort: "",
    targetHost: "",
    targetPort: "",
  });
  renderForwards();
});
document.getElementById("host-edit-cancel").addEventListener("click", closeHostEditor);
hostForm.addEventListener("submit", saveHostForm);

async function openHostEditor(id = null) {
  editingHostId = id;
  hostError.hidden = true;
  hostError.textContent = "";
  hostReadonly.hidden = true;
  hostReadonly.textContent = "";
  hfKeyPem = null;
  hfKeyStatus.textContent = t("host_editor.key.none");
  hfPassword.value = "";
  hfKeyPassphrase.value = "";
  hfForwards = [];

  await populateJumpOptions(id);

  if (id) {
    hostTitle.textContent = t("host_editor.title.edit");
    try {
      const h = await invoke("get_host", { id });
      hfName.value = h.name;
      hfHost.value = h.host;
      hfPort.value = h.port;
      hfUser.value = h.user;
      hfAuthType.value = h.authType;

      if (h.authType === "password") {
        hfPassword.value = h.password ?? "";
      } else if (h.authType === "key") {
        hfKeyStatus.textContent = t("host_editor.key.existing");
        hfKeyPassphrase.value = h.keyPassphrase ?? "";
      }

      hfJump.value = h.proxyJump ?? "";
      hfForwards = h.forwards.map(forwardFromIO);
    } catch (e) {
      hostError.textContent = t("host_editor.error.load_failed", { error: e });
      hostError.hidden = false;
    }
  } else {
    hostTitle.textContent = t("host_editor.title.add");
    hfName.value = "";
    hfHost.value = "";
    hfPort.value = "22";
    hfUser.value = "";
    hfAuthType.value = "password";
    hfJump.value = "";
  }

  syncAuthSections();
  renderForwards();
  hostOverlay.hidden = false;
  hfName.focus();
}

function closeHostEditor() {
  hostOverlay.hidden = true;
  editingHostId = null;
  hfKeyPem = null;
  hfForwards = [];
  hostForm.reset();
}

async function populateJumpOptions(currentId) {
  hfJump.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("host_editor.jump.none");
  hfJump.appendChild(none);

  try {
    const hosts = await invoke("list_hosts");
    for (const h of hosts) {
      if (h.id === currentId) continue;
      const opt = document.createElement("option");
      opt.value = h.name;
      opt.textContent = `${h.name} (${h.user}@${h.host}:${h.port})`;
      hfJump.appendChild(opt);
    }
  } catch (e) {
    console.warn("populateJumpOptions failed", e);
  }
}

function forwardFromIO(spec) {
  if (spec.kind === "local") {
    return {
      kind: "local",
      bindAddr: spec.bindAddr,
      bindPort: String(spec.bindPort),
      targetHost: spec.targetHost,
      targetPort: String(spec.targetPort),
    };
  }
  return {
    kind: "dynamic",
    bindAddr: spec.bindAddr,
    bindPort: String(spec.bindPort),
  };
}

function renderForwards() {
  hfForwardsList.innerHTML = "";

  if (hfForwards.length === 0) {
    const empty = document.createElement("li");
    empty.style.gridTemplateColumns = "1fr";
    empty.style.color = "var(--muted)";
    empty.textContent = t("host_editor.forward.none");
    hfForwardsList.appendChild(empty);
    return;
  }

  hfForwards.forEach((fwd, idx) => {
    const li = document.createElement("li");

    const kind = document.createElement("select");
    [["local", t("host_editor.forward.local")], ["dynamic", t("host_editor.forward.dynamic")]].forEach(([v, label]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      kind.appendChild(o);
    });
    kind.value = fwd.kind;
    kind.addEventListener("change", () => {
      fwd.kind = kind.value;
      if (fwd.kind === "dynamic") {
        delete fwd.targetHost;
        delete fwd.targetPort;
      } else {
        fwd.targetHost = fwd.targetHost ?? "";
        fwd.targetPort = fwd.targetPort ?? "";
      }
      renderForwards();
    });

    const fields = document.createElement("div");
    fields.className = "fields";

    const bind = document.createElement("input");
    bind.className = "bind";
    bind.type = "text";
    bind.placeholder = t("host_editor.forward.bind");
    bind.value = fwd.bindAddr;
    bind.addEventListener("input", () => (fwd.bindAddr = bind.value));
    fields.appendChild(bind);

    const bp = document.createElement("input");
    bp.className = "short";
    bp.type = "number";
    bp.placeholder = t("host_editor.forward.port");
    bp.min = 1;
    bp.max = 65535;
    bp.value = fwd.bindPort;
    bp.addEventListener("input", () => (fwd.bindPort = bp.value));
    fields.appendChild(bp);

    if (fwd.kind === "local") {
      const arrow = document.createElement("span");
      arrow.textContent = "->";
      arrow.style.alignSelf = "center";
      arrow.style.color = "var(--muted)";
      fields.appendChild(arrow);

      const th = document.createElement("input");
      th.className = "medium";
      th.type = "text";
      th.placeholder = t("host_editor.forward.target_host");
      th.value = fwd.targetHost ?? "";
      th.addEventListener("input", () => (fwd.targetHost = th.value));
      fields.appendChild(th);

      const tp = document.createElement("input");
      tp.className = "short";
      tp.type = "number";
      tp.placeholder = t("host_editor.forward.port");
      tp.min = 1;
      tp.max = 65535;
      tp.value = fwd.targetPort ?? "";
      tp.addEventListener("input", () => (fwd.targetPort = tp.value));
      fields.appendChild(tp);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = t("host_editor.forward.remove");
    remove.className = "danger";
    remove.addEventListener("click", () => {
      hfForwards.splice(idx, 1);
      renderForwards();
    });

    li.append(kind, fields, remove);
    hfForwardsList.appendChild(li);
  });
}

function syncAuthSections() {
  const t = hfAuthType.value;
  hfPasswordBlock.hidden = t !== "password";
  hfKeyBlock.hidden = t !== "key";
}

async function pickKeyFile() {
  const chosen = await invoke("plugin:dialog|open", {
    options: {
      multiple: false,
      directory: false,
      title: t("host_editor.key.pick_title"),
    },
  });

  if (!chosen) return;
  const path = String(chosen);

  try {
    const text = await invoke("read_local_text_file", { path });
    hfKeyPem = text;
    hfKeyStatus.textContent = t("host_editor.key.loaded", {
      name: basename(path),
      bytes: text.length,
    });
  } catch (e) {
    hfKeyStatus.textContent = t("host_editor.key.read_failed", { error: e });
  }
}

async function buildKeyAuth() {
  if (editingHostId && !hfKeyPem) {
    showHostError(t("host_editor.error.pick_new_key"));
    return null;
  }
  if (!editingHostId && !hfKeyPem) {
    showHostError(t("host_editor.error.pick_key_first"));
    return null;
  }
  return {
    type: "private_key",
    key_pem: hfKeyPem,
    passphrase: hfKeyPassphrase.value || null,
  };
}

function showHostError(msg) {
  hostError.textContent = msg;
  hostError.hidden = false;
}

async function saveHostForm(ev) {
  ev.preventDefault();
  hostError.hidden = true;

  let auth;
  if (hfAuthType.value === "password") {
    auth = { type: "password", value: hfPassword.value };
  } else if (hfAuthType.value === "key") {
    auth = await buildKeyAuth();
    if (auth === null) return;
  } else {
    auth = { type: "agent" };
  }

  const forwards = [];
  for (const [i, fwd] of hfForwards.entries()) {
    const bindPort = parseInt(fwd.bindPort, 10);
    if (!bindPort || bindPort < 1 || bindPort > 65535) {
      showHostError(t("host_editor.error.forward_bind_port", { index: i + 1 }));
      return;
    }

    if (fwd.kind === "local") {
      if (!fwd.targetHost?.trim()) {
        showHostError(t("host_editor.error.forward_target_host", { index: i + 1 }));
        return;
      }
      const targetPort = parseInt(fwd.targetPort, 10);
      if (!targetPort || targetPort < 1 || targetPort > 65535) {
        showHostError(t("host_editor.error.forward_target_port", { index: i + 1 }));
        return;
      }

      forwards.push({
        kind: "local",
        bind_addr: fwd.bindAddr || "127.0.0.1",
        bind_port: bindPort,
        target_host: fwd.targetHost.trim(),
        target_port: targetPort,
      });
    } else {
      forwards.push({
        kind: "dynamic",
        bind_addr: fwd.bindAddr || "127.0.0.1",
        bind_port: bindPort,
      });
    }
  }

  const input = {
    name: hfName.value.trim(),
    host: hfHost.value.trim(),
    port: parseInt(hfPort.value, 10),
    user: hfUser.value.trim(),
    auth,
    forwards,
    proxy_jump: hfJump.value || null,
  };

  if (!input.name || !input.host || !input.user) {
    showHostError(t("host_editor.error.required_fields"));
    return;
  }

  try {
    if (editingHostId) {
      await invoke("update_host", { id: editingHostId, input });
    } else {
      await invoke("save_host", { input });
    }
    closeHostEditor();
    await enterHosts();
  } catch (e) {
    showHostError(String(e));
  }
}

// --------------------------------------------------------------------------
// Files view: bulk actions + drag and drop
// --------------------------------------------------------------------------

const filesTitle = document.getElementById("files-title");
const filesPath = document.getElementById("files-path");
const filesList = document.getElementById("files-list");
const filesStatus = document.getElementById("files-status");
const filesProgress = document.getElementById("files-progress");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const progressCancel = document.getElementById("progress-cancel");
const filesDropOverlay = document.getElementById("files-drop-overlay");
const filesSelectAll = document.getElementById("files-select-all");
const filesUploadMany = document.getElementById("files-upload-many");
const filesDownloadSelected = document.getElementById("files-download-selected");
const filesDeleteSelected = document.getElementById("files-delete-selected");
const filesSelectionHint = document.getElementById("files-selection-hint");
const fileEditorOverlay = document.getElementById("file-editor-overlay");
const fileEditorTitle = document.getElementById("file-editor-title");
const fileEditorPath = document.getElementById("file-editor-path");
const fileEditorHint = document.getElementById("file-editor-hint");
const fileEditorContent = document.getElementById("file-editor-content");
const fileEditorFindInput = document.getElementById("file-editor-find");
const fileEditorReplaceInput = document.getElementById("file-editor-replace");
const fileEditorMatchCaseInput = document.getElementById("file-editor-match-case");
const fileEditorFindPrevButton = document.getElementById("file-editor-find-prev");
const fileEditorFindNextButton = document.getElementById("file-editor-find-next");
const fileEditorReplaceOneButton = document.getElementById("file-editor-replace-one");
const fileEditorReplaceAllButton = document.getElementById("file-editor-replace-all");
const fileEditorError = document.getElementById("file-editor-error");
const fileEditorSaveButton = document.getElementById("file-editor-save");
const fileEditorCancelButton = document.getElementById("file-editor-cancel");
const filesContextMenu = document.getElementById("files-context-menu");
const filesMenuEdit = document.getElementById("files-menu-edit");
const filesMenuDownload = document.getElementById("files-menu-download");
const filesMenuRename = document.getElementById("files-menu-rename");
const filesMenuDelete = document.getElementById("files-menu-delete");

let filesSftpId = null;
let filesCurrentPath = "/";
let filesHost = null;
let filesEntries = [];
let filesSelected = new Set();
let activeTransferId = null;
let pendingCancel = false;
let progressUnlisten = null;
let dragDepth = 0;
let filesContextEntry = null;
const fileEditorState = {
  open: false,
  path: "",
  originalContent: "",
  dirty: false,
  saving: false,
};
let fileEditorAce = null;

const filesDropTarget = document.querySelector(".files-drop-zone-wrap");

function ensureFileEditorAce() {
  if (fileEditorAce) return true;

  if (!window.ace) {
    setFileEditorError(t("editor.error.ace_load_failed"));
    return false;
  }

  window.ace.config.set("basePath", ACE_BASE_PATH);
  window.ace.config.set("modePath", ACE_BASE_PATH);
  window.ace.config.set("themePath", ACE_BASE_PATH);
  window.ace.config.set("workerPath", ACE_BASE_PATH);
  fileEditorAce = window.ace.edit("file-editor-content");
  fileEditorAce.setTheme("ace/theme/tomorrow_night_bright");
  fileEditorAce.session.setMode("ace/mode/text");
  fileEditorAce.session.setUseWrapMode(false);
  fileEditorAce.setShowPrintMargin(false);
  fileEditorAce.setOptions({
    fontSize: "13px",
    tabSize: 2,
    useSoftTabs: true,
    showLineNumbers: true,
    showGutter: true,
    highlightActiveLine: true,
  });

  fileEditorAce.session.on("change", () => {
    if (!fileEditorState.open) return;
    setFileEditorDirty(fileEditorGetValue() !== fileEditorState.originalContent);
  });

  fileEditorAce.commands.addCommand({
    name: "saveRemoteFile",
    bindKey: { win: "Ctrl-S", mac: "Command-S" },
    exec: () => {
      saveRemoteEditor();
    },
  });
  fileEditorAce.commands.addCommand({
    name: "closeRemoteEditor",
    bindKey: { win: "Esc", mac: "Esc" },
    exec: () => {
      closeRemoteEditor();
    },
  });

  return true;
}

function fileEditorSetValue(content) {
  if (!ensureFileEditorAce()) return;
  fileEditorAce.setValue(content, -1);
}

function fileEditorGetValue() {
  if (!ensureFileEditorAce()) return "";
  return fileEditorAce.getValue();
}

function fileEditorSetReadOnly(readOnly) {
  if (!ensureFileEditorAce()) return;
  fileEditorAce.setReadOnly(readOnly);
}

function fileEditorFocus() {
  if (!ensureFileEditorAce()) return;
  fileEditorAce.focus();
}

function fileEditorSetModeByPath(path) {
  if (!ensureFileEditorAce()) return;
  const mode = detectAceModeByName(basename(path));
  fileEditorAce.session.setMode(`ace/mode/${mode}`);
}

function hideFilesContextMenu() {
  filesContextMenu.hidden = true;
  filesContextEntry = null;
}

function showFilesContextMenu(entry, x, y) {
  if (!filesSftpId) return;
  filesContextEntry = entry;

  const isFile = entry.kind === "file";
  filesMenuEdit.disabled = !(isFile && canInlineEditEntry(entry));
  filesMenuDownload.disabled = !isFile;
  filesMenuRename.disabled = false;
  filesMenuDelete.disabled = false;

  filesContextMenu.style.left = "0px";
  filesContextMenu.style.top = "0px";
  filesContextMenu.hidden = false;

  const pad = 8;
  const rect = filesContextMenu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  filesContextMenu.style.left = `${left}px`;
  filesContextMenu.style.top = `${top}px`;
}

function refreshFileEditorLayout() {
  if (!fileEditorAce) return;
  requestAnimationFrame(() => {
    if (!fileEditorAce) return;
    fileEditorAce.resize(true);
    fileEditorAce.renderer.updateFull();
  });
}

document.getElementById("files-back").addEventListener("click", () => closeFiles());
document.getElementById("files-up").addEventListener("click", () => {
  if (!filesSftpId) return;
  navigateTo(parentPath(filesCurrentPath));
});
document.getElementById("files-refresh").addEventListener("click", () => {
  if (!filesSftpId) return;
  navigateTo(filesCurrentPath);
});
document.getElementById("files-mkdir").addEventListener("click", async () => {
  if (!filesSftpId) return;
  const name = prompt(t("files.prompt.new_folder"));
  if (!name) return;
  try {
    await invoke("sftp_mkdir", {
      sftpId: filesSftpId,
      path: joinPath(filesCurrentPath, name),
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(t("files.error.mkdir_failed", { error: e }));
  }
});
document.getElementById("files-upload").addEventListener("click", uploadHere);
filesUploadMany.addEventListener("click", uploadManyHere);
filesDownloadSelected.addEventListener("click", downloadSelectedFiles);
filesDeleteSelected.addEventListener("click", deleteSelectedFiles);
fileEditorCancelButton.addEventListener("click", () => closeRemoteEditor());
fileEditorSaveButton.addEventListener("click", () => saveRemoteEditor());
fileEditorOverlay.addEventListener("click", (ev) => {
  if (ev.target === fileEditorOverlay) {
    closeRemoteEditor();
  }
});
fileEditorFindPrevButton.addEventListener("click", () => searchInEditor({ backwards: true }));
fileEditorFindNextButton.addEventListener("click", () => searchInEditor({ backwards: false }));
fileEditorReplaceOneButton.addEventListener("click", () => replaceInEditor({ all: false }));
fileEditorReplaceAllButton.addEventListener("click", () => replaceInEditor({ all: true }));
fileEditorFindInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    searchInEditor({ backwards: ev.shiftKey });
  }
});
fileEditorReplaceInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    replaceInEditor({ all: ev.shiftKey });
  }
});
filesMenuEdit.addEventListener("click", async () => {
  const entry = filesContextEntry;
  hideFilesContextMenu();
  if (!entry) return;
  if (entry.kind === "file" && canInlineEditEntry(entry)) {
    await openRemoteEditor(entry);
  }
});
filesMenuDownload.addEventListener("click", async () => {
  const entry = filesContextEntry;
  hideFilesContextMenu();
  if (!entry || entry.kind !== "file") return;
  await downloadEntry(entry);
});
filesMenuRename.addEventListener("click", async () => {
  const entry = filesContextEntry;
  hideFilesContextMenu();
  if (!entry) return;
  await renameEntry(entry);
});
filesMenuDelete.addEventListener("click", async () => {
  const entry = filesContextEntry;
  hideFilesContextMenu();
  if (!entry) return;
  await deleteEntry(entry);
});
document.addEventListener("pointerdown", (ev) => {
  if (filesContextMenu.hidden) return;
  if (!filesContextMenu.contains(ev.target)) {
    hideFilesContextMenu();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !filesContextMenu.hidden) {
    hideFilesContextMenu();
  }
});
filesList.addEventListener("scroll", () => {
  if (!filesContextMenu.hidden) hideFilesContextMenu();
});
window.addEventListener("resize", () => {
  if (!filesContextMenu.hidden) hideFilesContextMenu();
});
filesSelectAll.addEventListener("change", () => {
  if (filesSelectAll.checked) {
    for (const entry of filesEntries) filesSelected.add(entry.name);
  } else {
    filesSelected.clear();
  }
  renderFilesList(filesEntries);
  updateFilesSelectionState();
});

progressCancel.addEventListener("click", cancelActiveTransfer);

filesDropTarget.addEventListener("dragenter", (ev) => {
  ev.preventDefault();
  if (views.files.hidden) return;
  dragDepth += 1;
  filesDropOverlay.hidden = false;
});

filesDropTarget.addEventListener("dragover", (ev) => {
  ev.preventDefault();
  if (views.files.hidden) return;
  filesDropOverlay.hidden = false;
});

filesDropTarget.addEventListener("dragleave", (ev) => {
  ev.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) filesDropOverlay.hidden = true;
});

filesDropTarget.addEventListener("drop", async (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  filesDropOverlay.hidden = true;
  if (filesSftpId === null) return;

  const dropped = Array.from(ev.dataTransfer?.files || []);
  if (dropped.length === 0) return;

  await uploadDroppedFiles(dropped);
});

function canInlineEditEntry(entry) {
  return (
    entry.kind === "file" &&
    entry.size <= FILE_EDITOR_MAX_BYTES &&
    isLikelyEditableTextName(entry.name)
  );
}

function setFileEditorError(message) {
  if (!message) {
    fileEditorError.hidden = true;
    fileEditorError.textContent = "";
    return;
  }
  fileEditorError.hidden = false;
  fileEditorError.textContent = message;
}

function setFileEditorDirty(dirty) {
  fileEditorState.dirty = dirty;
  fileEditorTitle.textContent = dirty ? t("editor.title.dirty") : t("editor.title");
}

function editorSearchOptions({ backwards = false } = {}) {
  return {
    backwards,
    wrap: true,
    caseSensitive: fileEditorMatchCaseInput.checked,
    wholeWord: false,
    regExp: false,
  };
}

function searchInEditor({ backwards = false } = {}) {
  if (!fileEditorState.open || !ensureFileEditorAce()) return false;
  const needle = fileEditorFindInput.value;
  if (!needle) {
    setFileEditorError(t("editor.error.enter_search"));
    return false;
  }

  const range = fileEditorAce.find(needle, editorSearchOptions({ backwards }));
  if (!range) {
    setFileEditorError(t("editor.error.no_matches"));
    return false;
  }
  setFileEditorError("");
  return true;
}

function replaceInEditor({ all = false } = {}) {
  if (!fileEditorState.open || !ensureFileEditorAce()) return;
  const needle = fileEditorFindInput.value;
  if (!needle) {
    setFileEditorError(t("editor.error.enter_search"));
    return;
  }

  const replacement = fileEditorReplaceInput.value ?? "";
  const opts = editorSearchOptions();

  if (all) {
    const replaced = fileEditorAce.replaceAll(replacement, { ...opts, needle });
    if (!replaced) {
      setFileEditorError(t("editor.error.no_matches_replace"));
      return;
    }
    setFileEditorError("");
    fileEditorHint.textContent = t("editor.hint.replaced_many", { count: replaced });
    return;
  }

  if (!searchInEditor({ backwards: false })) return;
  const replaced = fileEditorAce.replace(replacement);
  if (replaced == null) {
    setFileEditorError(t("editor.error.no_selected_match"));
    return;
  }

  setFileEditorError("");
  fileEditorHint.textContent = t("editor.hint.replaced_one");
}

function resetFileEditorState() {
  fileEditorState.open = false;
  fileEditorState.path = "";
  fileEditorState.originalContent = "";
  fileEditorState.dirty = false;
  fileEditorState.saving = false;
  if (fileEditorAce) {
    fileEditorSetValue("");
    fileEditorSetReadOnly(false);
    fileEditorAce.session.setMode("ace/mode/text");
    fileEditorAce.clearSelection();
  }
  fileEditorSaveButton.disabled = false;
  fileEditorCancelButton.disabled = false;
  fileEditorFindInput.value = "";
  fileEditorReplaceInput.value = "";
  fileEditorMatchCaseInput.checked = false;
  fileEditorPath.textContent = "";
  fileEditorHint.textContent = t("editor.hint.default");
  fileEditorTitle.textContent = t("editor.title");
  setFileEditorError("");
}

async function openRemoteEditor(entry) {
  if (!canInlineEditEntry(entry)) {
    alert(t("editor.alert.unsupported"));
    return;
  }
  if (filesSftpId === null) return;
  if (!ensureFileEditorAce()) {
    alert(t("editor.alert.component_failed"));
    return;
  }

  if (fileEditorState.open && fileEditorState.dirty) {
    const ok = confirm(t("editor.confirm.discard"));
    if (!ok) return;
  }

  resetFileEditorState();
  const path = joinPath(filesCurrentPath, entry.name);
  fileEditorOverlay.hidden = false;
  fileEditorTitle.textContent = t("editor.hint.opening");
  fileEditorPath.textContent = path;
  fileEditorHint.textContent = t("editor.hint.loading");
  refreshFileEditorLayout();
  fileEditorSetReadOnly(true);
  fileEditorSaveButton.disabled = true;

  try {
    const doc = await invoke("sftp_read_text", {
      sftpId: filesSftpId,
      path,
      maxBytes: FILE_EDITOR_MAX_BYTES,
    });

    fileEditorState.open = true;
    fileEditorState.path = doc.path;
    fileEditorState.originalContent = doc.content;
    fileEditorSetValue(doc.content);
    fileEditorSetModeByPath(doc.path);
    fileEditorPath.textContent = `${doc.path} · ${formatSize(doc.size)}`;
    fileEditorHint.textContent = t("editor.hint.utf8_info", {
      lines: doc.content.split(/\r?\n/).length,
    });
    fileEditorSetReadOnly(false);
    fileEditorSaveButton.disabled = false;
    setFileEditorDirty(false);
    refreshFileEditorLayout();
    fileEditorFocus();
  } catch (e) {
    fileEditorState.open = false;
    setFileEditorError(t("editor.error.open_failed", { error: e }));
    fileEditorTitle.textContent = t("editor.title");
    fileEditorHint.textContent = t("editor.hint.unavailable");
  }
}

function closeRemoteEditor({ force = false } = {}) {
  if (fileEditorOverlay.hidden) return true;
  if (!force && fileEditorState.saving) return false;
  if (!force && fileEditorState.open && fileEditorState.dirty && !fileEditorState.saving) {
    const ok = confirm(t("editor.confirm.close_unsaved"));
    if (!ok) return false;
  }
  fileEditorOverlay.hidden = true;
  resetFileEditorState();
  return true;
}

async function saveRemoteEditor() {
  if (!fileEditorState.open || fileEditorState.saving) return;

  const content = fileEditorGetValue();
  fileEditorState.saving = true;
  fileEditorSaveButton.disabled = true;
  fileEditorCancelButton.disabled = true;
  setFileEditorError("");

  try {
    const bytes = await invoke("sftp_write_text", {
      sftpId: filesSftpId,
      path: fileEditorState.path,
      content,
    });
    fileEditorState.originalContent = content;
    setFileEditorDirty(false);
    fileEditorHint.textContent = t("editor.hint.saved", { size: formatSize(bytes) });
    filesStatus.textContent = t("files.status.saved_path", { path: fileEditorState.path });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    setFileEditorError(t("editor.error.save_failed", { error: e }));
  } finally {
    fileEditorState.saving = false;
    fileEditorSaveButton.disabled = !fileEditorState.open;
    fileEditorCancelButton.disabled = false;
  }
}

async function openFiles(host) {
  hideFilesContextMenu();
  filesHost = host;
  filesCurrentPath = "/";
  filesEntries = [];
  filesSelected.clear();
  filesSelectAll.checked = false;

  show("files");
  filesTitle.textContent = `${host.name} (${host.user}@${host.host}:${host.port})`;
  filesPath.textContent = "/";
  filesList.innerHTML = "";
  filesStatus.textContent = t("files.status.connecting");

  if (progressUnlisten) {
    progressUnlisten();
    progressUnlisten = null;
  }

  progressUnlisten = await listen("sftp:progress", (ev) => {
    const p = ev.payload;

    if (activeTransferId === "pending") {
      activeTransferId = p.transferId;
      if (pendingCancel) {
        pendingCancel = false;
        invoke("sftp_cancel_transfer", { transferId: activeTransferId }).catch(() => {});
      }
    }

    if (activeTransferId !== p.transferId) return;

    if (p.finished) {
      hideProgress();
      return;
    }
    showProgress(p);
  });

  try {
    filesSftpId = await invoke("sftp_open", { hostId: host.id });
    await navigateTo("/");
  } catch (e) {
    showFilesError(t("files.error.open_failed", { error: e }));
  }
}

async function closeFiles() {
  hideFilesContextMenu();
  if (!closeRemoteEditor()) return;
  cancelActiveTransfer();
  filesDropOverlay.hidden = true;
  dragDepth = 0;

  if (progressUnlisten) {
    progressUnlisten();
    progressUnlisten = null;
  }

  if (filesSftpId !== null) {
    try {
      await invoke("sftp_close", { sftpId: filesSftpId });
    } catch (e) {
      console.warn("sftp_close failed", e);
    }
  }

  filesSftpId = null;
  filesHost = null;
  filesEntries = [];
  filesSelected.clear();
  filesList.innerHTML = "";
  hideProgress();

  await enterHosts();
}

async function navigateTo(path) {
  hideFilesContextMenu();
  if (filesSftpId === null) return;
  filesStatus.textContent = t("files.status.listing", { path });

  try {
    const entries = await invoke("sftp_list", { sftpId: filesSftpId, path });
    filesCurrentPath = path;
    filesEntries = entries;
    filesSelected.clear();
    filesSelectAll.checked = false;

    filesPath.textContent = path;
    renderFilesList(entries);
    updateFilesSelectionState();
    filesStatus.textContent = "";
  } catch (e) {
    showFilesError(t("files.error.list_failed", { error: e }));
  }
}

function renderFilesList(entries) {
  filesList.innerHTML = "";

  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "file-row";
    empty.style.gridTemplateColumns = "1fr";
    empty.style.justifyContent = "center";
    empty.style.color = "var(--muted)";
    empty.textContent = t("files.empty");
    filesList.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("li");
    row.className = `file-row${entry.kind === "dir" ? " dir" : ""}`;
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showFilesContextMenu(entry, ev.clientX, ev.clientY);
    });

    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.checked = filesSelected.has(entry.name);
    pick.addEventListener("change", () => {
      if (pick.checked) filesSelected.add(entry.name);
      else filesSelected.delete(entry.name);
      updateFilesSelectionState();
    });

    const marker = document.createElement("span");
    marker.textContent = kindMarker(entry.kind);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.kind === "dir" ? `${entry.name}/` : entry.name;
    if (entry.kind === "dir") {
      name.addEventListener("click", () => navigateTo(joinPath(filesCurrentPath, entry.name)));
    }

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = entry.kind === "dir" ? "—" : formatSize(entry.size);

    row.append(pick, marker, name, size);
    filesList.appendChild(row);
  }
}

function updateFilesSelectionState() {
  const count = filesSelected.size;
  filesSelectionHint.textContent = t("files.selection.count", { count });
  filesDownloadSelected.disabled = count === 0;
  filesDeleteSelected.disabled = count === 0;

  const allCount = filesEntries.length;
  filesSelectAll.checked = allCount > 0 && count === allCount;
}

function showFilesError(msg) {
  filesStatus.textContent = msg;
  console.error(msg);
}

function kindMarker(k) {
  switch (k) {
    case "dir":
      return "📁";
    case "file":
      return "📄";
    case "symlink":
      return "↪";
    default:
      return "?";
  }
}

async function downloadEntry(entry) {
  const remote = joinPath(filesCurrentPath, entry.name);
  const local = await invoke("plugin:dialog|save", {
    options: { defaultPath: entry.name },
  });
  if (!local) return;

  beginTransfer(`${t("files.progress.downloading")} ${entry.name}`);
  try {
    const n = await invoke("sftp_download", {
      sftpId: filesSftpId,
      remote,
      local,
    });
    filesStatus.textContent = t("files.status.downloaded_one", {
      name: entry.name,
      size: formatSize(n),
    });
  } catch (e) {
    showFilesError(t("files.error.download_failed", { error: e }));
  } finally {
    hideProgress();
    activeTransferId = null;
  }
}

async function renameEntry(entry) {
  const next = prompt(t("files.prompt.rename", { name: entry.name }), entry.name);
  if (!next || next === entry.name) return;
  try {
    await invoke("sftp_rename", {
      sftpId: filesSftpId,
      from: joinPath(filesCurrentPath, entry.name),
      to: joinPath(filesCurrentPath, next),
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(t("files.error.rename_failed", { error: e }));
  }
}

async function deleteEntry(entry) {
  const target = joinPath(filesCurrentPath, entry.name);
  if (!confirm(t("files.confirm.delete_entry", { path: target }))) return;

  const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
  try {
    await invoke(command, {
      sftpId: filesSftpId,
      path: target,
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(t("files.error.delete_failed", { error: e }));
  }
}

async function deleteSelectedFiles() {
  const picked = filesEntries.filter((e) => filesSelected.has(e.name));
  if (picked.length === 0) return;
  if (!confirm(t("files.confirm.delete_selected", { count: picked.length }))) return;

  for (const entry of picked) {
    const path = joinPath(filesCurrentPath, entry.name);
    const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
    try {
      await invoke(command, { sftpId: filesSftpId, path });
    } catch (e) {
      showFilesError(t("files.error.delete_failed_for", { name: entry.name, error: e }));
      break;
    }
  }

  await navigateTo(filesCurrentPath);
}

async function uploadHere() {
  const local = await invoke("plugin:dialog|open", {
    options: { multiple: false, directory: false },
  });
  if (!local) return;

  await uploadLocalPath(String(local));
  await navigateTo(filesCurrentPath);
}

async function uploadManyHere() {
  const local = await invoke("plugin:dialog|open", {
    options: { multiple: true, directory: false },
  });
  if (!local) return;

  const paths = Array.isArray(local) ? local.map(String) : [String(local)];
  for (const path of paths) {
    await uploadLocalPath(path);
  }

  await navigateTo(filesCurrentPath);
}

async function uploadLocalPath(localPath) {
  const name = basename(localPath);
  const remote = joinPath(filesCurrentPath, name);

  beginTransfer(`${t("files.progress.uploading")} ${name}`);
  try {
    const n = await invoke("sftp_upload", {
      sftpId: filesSftpId,
      local: localPath,
      remote,
    });
    filesStatus.textContent = t("files.status.uploaded_one", { name, size: formatSize(n) });
  } catch (e) {
    showFilesError(t("files.error.upload_failed_for", { name, error: e }));
  } finally {
    hideProgress();
    activeTransferId = null;
  }
}

async function uploadDroppedFiles(fileList) {
  for (const file of fileList) {
    const remote = joinPath(filesCurrentPath, file.name || "dropped.bin");

    try {
      if (file.path) {
        await uploadLocalPath(String(file.path));
        continue;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      beginTransfer(`${t("files.progress.uploading")} ${file.name}`);
      const n = await invoke("sftp_upload_bytes", {
        sftpId: filesSftpId,
        remote,
        data: Array.from(bytes),
        sourceLabel: file.name,
      });
      filesStatus.textContent = t("files.status.uploaded_one", {
        name: file.name,
        size: formatSize(n),
      });
    } catch (e) {
      showFilesError(t("files.error.drag_upload_failed_for", { name: file.name, error: e }));
    } finally {
      hideProgress();
      activeTransferId = null;
    }
  }

  await navigateTo(filesCurrentPath);
}

async function downloadSelectedFiles() {
  const picked = filesEntries.filter((e) => filesSelected.has(e.name) && e.kind === "file");
  if (picked.length === 0) {
    alert(t("files.alert.download_selected_none"));
    return;
  }

  const base = await invoke("plugin:dialog|open", {
    options: { directory: true, multiple: false },
  });
  if (!base) return;

  const folder = String(base);

  for (const entry of picked) {
    const remote = joinPath(filesCurrentPath, entry.name);
    const local = localJoin(folder, entry.name);

    beginTransfer(`${t("files.progress.downloading")} ${entry.name}`);
    try {
      await invoke("sftp_download", {
        sftpId: filesSftpId,
        remote,
        local,
      });
    } catch (e) {
      showFilesError(t("files.error.download_failed_for", { name: entry.name, error: e }));
      break;
    } finally {
      hideProgress();
      activeTransferId = null;
    }
  }

  filesStatus.textContent = t("files.status.downloaded_many_to", {
    count: picked.length,
    folder,
  });
}

function beginTransfer(label) {
  activeTransferId = "pending";
  pendingCancel = false;
  progressLabel.textContent = label;
  progressBar.removeAttribute("value");
  filesProgress.hidden = false;
}

function showProgress(p) {
  const verb = p.kind === "upload" ? t("files.progress.uploading") : t("files.progress.downloading");
  let suffix = "";
  if (p.bytesPerSec != null && p.bytesPerSec > 0) {
    suffix += ` · ${formatSize(p.bytesPerSec)}/s`;
  }
  if (p.etaSeconds != null) {
    suffix += ` · ${t("files.progress.eta", { eta: formatEta(p.etaSeconds) })}`;
  }

  if (p.total != null && p.total > 0) {
    progressBar.max = 100;
    progressBar.value = (p.bytesDone / p.total) * 100;
    progressLabel.textContent = `${verb} ${formatSize(p.bytesDone)} / ${formatSize(p.total)}${suffix}`;
  } else {
    progressBar.removeAttribute("value");
    progressLabel.textContent = `${verb} ${formatSize(p.bytesDone)}${suffix}`;
  }
}

function hideProgress() {
  filesProgress.hidden = true;
  progressBar.value = 0;
}

function cancelActiveTransfer() {
  if (typeof activeTransferId === "number") {
    invoke("sftp_cancel_transfer", { transferId: activeTransferId }).catch(() => {});
  } else if (activeTransferId === "pending") {
    pendingCancel = true;
  }
}

function formatEta(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h${String(m).padStart(2, "0")}m`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

applyI18n();
refreshVaultStatus();
