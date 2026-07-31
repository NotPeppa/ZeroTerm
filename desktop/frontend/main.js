// ZeroTerm desktop frontend (vanilla JS, no build step)

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window?.getCurrentWindow?.() || null;
const tauriFs = window.__TAURI__.fs || null;
const tauriFsBaseDirectory = tauriFs?.BaseDirectory || null;

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;
const SearchAddon = window.SearchAddon?.SearchAddon || null;
const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || null;

const views = {
  unlock: document.getElementById("view-unlock"),
  hosts: document.getElementById("view-hosts"),
};

const isMacPlatform =
  /mac/i.test(navigator.userAgentData?.platform || "") ||
  /mac/i.test(navigator.platform || "");
const isWindowsPlatform =
  /win/i.test(navigator.userAgentData?.platform || "") ||
  /win/i.test(navigator.platform || "");
document.documentElement.classList.toggle("platform-macos", isMacPlatform);
document.documentElement.classList.toggle("platform-windows", isWindowsPlatform);

function show(name) {
  for (const [key, el] of Object.entries(views)) {
    if (!el) continue;
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
  const raw = String(path || "").trim();
  if (!raw || raw === "/") return "/";
  const normalized = raw.replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return "/";
  return normalized.slice(0, idx);
}

function localPaneHasEntryAtPath(pane, directoryPath, entryName) {
  if (!pane || !isLocalPane(pane) || !entryName) return false;
  return normalizeLocalPath(pane.path) === normalizeLocalPath(directoryPath)
    && pane.entries.some((entry) => entry.name === entryName);
}

function showOverwriteConfirm(path) {
  return openConfirmDialog({
    title: t("files.confirm.overwrite.title"),
    message: t("files.confirm.overwrite", { path }),
    okText: t("files.button.overwrite"),
    cancelText: t("files.button.cancel"),
    danger: false,
  });
}

async function planOverwriteForLocalPath(path, options = {}) {
  const directoryPath = String(options.directoryPath || parentPath(path));
  const entryName = String(options.entryName || basename(path));
  let exists = false;
  if (localPaneHasEntryAtPath(options.pane, directoryPath, entryName)) {
    exists = true;
  } else {
    try {
      exists = await invoke("local_path_exists", { path });
    } catch {
      exists = false;
    }
  }
  if (!exists) return { proceed: true, overwrite: false };
  const ok = await showOverwriteConfirm(path);
  return { proceed: ok, overwrite: ok };
}

function normalizeSftpError(error) {
  if (error && typeof error === "object") {
    const message = String(error.message || error.error || "");
    const reportedCode = String(error.code || error.kind || "OTHER").toUpperCase();
    // Some older backend paths serialize a dead SSH sender as OTHER. Recover
    // this known disconnect from its message so the panel's retry logic runs.
    const code = reportedCode === "OTHER" && /channel send error|channel closed|session closed|broken pipe/i.test(message)
      ? "CHANNEL_CLOSED"
      : reportedCode;
    return { code, message };
  }

  const message = String(error || "");
  if (message.startsWith("{")) {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === "object") {
        return normalizeSftpError(parsed);
      }
    } catch {
      // Fall back to legacy string heuristics below.
    }
  }
  const lower = message.toLowerCase();
  let code = "OTHER";
  if (lower.includes("destination already exists") || lower.includes("already exists")) {
    code = "ALREADY_EXISTS";
  } else if (lower.includes("permission denied")) {
    code = "PERMISSION_DENIED";
  } else if (lower.includes("not found") || lower.includes("no such file")) {
    code = "NOT_FOUND";
  } else if (lower.includes("not a directory")) {
    code = "NOT_A_DIRECTORY";
  } else if (lower.includes("timed out") || lower.includes("timeout")) {
    code = "TIMEOUT";
  } else if (lower.includes("cancelled") || lower.includes("canceled")) {
    code = "CANCELLED";
  } else if (
    lower.includes("channel closed")
    || lower.includes("channel send error")
    || lower.includes("session closed")
    || lower.includes("broken pipe")
  ) {
    code = "CHANNEL_CLOSED";
  }
  return { code, message };
}

function isWindowsLocalPath(path) {
  const raw = String(path || "");
  return /^[A-Za-z]:([\\/]|$)/.test(raw) || raw.startsWith("\\\\") || raw.includes("\\");
}

function extractWindowsDriveRoot(path) {
  const m = String(path || "").match(/^([A-Za-z]:)(?:[\\/]|$)/);
  return m ? `${m[1].toUpperCase()}\\` : "";
}

function normalizeLocalPath(path, styleHint = null) {
  const raw = String(path || "").trim();
  if (!raw) return "/";

  const useWindows =
    styleHint === "windows" ||
    isWindowsLocalPath(raw) ||
    (styleHint !== "posix" && /^[A-Za-z]:/.test(raw));

  if (!useWindows) {
    return normalizeAbsolutePath(raw.startsWith("/") ? raw : `/${raw}`);
  }

  const cleaned = raw.replace(/\//g, "\\");

  if (cleaned.startsWith("\\\\")) {
    const tokens = cleaned.split("\\").filter(Boolean);
    if (tokens.length < 2) return "\\\\";
    const root = `\\\\${tokens[0]}\\${tokens[1]}`;
    const stack = [];
    for (const part of tokens.slice(2)) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(part);
    }
    return stack.length > 0 ? `${root}\\${stack.join("\\")}` : root;
  }

  const driveMatch = cleaned.match(/^([A-Za-z]:)(?:\\(.*)|$)/);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const restRaw = driveMatch[2] || "";
    const stack = [];
    for (const part of restRaw.split("\\").filter(Boolean)) {
      if (!part || part === ".") continue;
      if (part === "..") {
        if (stack.length > 0) stack.pop();
        continue;
      }
      stack.push(part);
    }
    return stack.length > 0 ? `${drive}\\${stack.join("\\")}` : `${drive}\\`;
  }

  const stack = [];
  for (const part of cleaned.split("\\").filter(Boolean)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `\\${stack.join("\\")}`;
}

function localJoin(base, leaf) {
  const rawBase = String(base || "").trim();
  const rawLeaf = String(leaf || "").replace(/^[\\/]+/, "");
  if (!rawBase) return rawLeaf;
  const windowsStyle = isWindowsLocalPath(rawBase);
  const sep = windowsStyle ? "\\" : "/";
  const joined = rawBase.replace(/[\\/]+$/, "") + sep + rawLeaf;
  return normalizeLocalPath(joined, windowsStyle ? "windows" : "posix");
}

function resolveLocalTargetPath(basePath, rawInput) {
  const base = normalizeLocalPath(basePath || "/");
  const raw = String(rawInput || "").trim();
  if (!raw) return base;

  const windowsBase = isWindowsLocalPath(base);
  const looksAbsolute =
    raw.startsWith("/") ||
    raw.startsWith("\\\\") ||
    /^[A-Za-z]:([\\/]|$)/.test(raw) ||
    (windowsBase && raw.startsWith("\\"));

  if (looksAbsolute) {
    if (windowsBase && (raw === "/" || raw === "\\")) {
      const driveRoot = extractWindowsDriveRoot(base);
      return driveRoot || "\\";
    }
    if (
      windowsBase &&
      raw.startsWith("/") &&
      !raw.startsWith("//") &&
      !/^[A-Za-z]:/.test(raw)
    ) {
      const driveRoot = extractWindowsDriveRoot(base);
      if (driveRoot) {
        return normalizeLocalPath(
          `${driveRoot}${raw.replace(/^\/+/, "\\")}`,
          "windows",
        );
      }
    }
    return normalizeLocalPath(raw, windowsBase ? "windows" : "posix");
  }

  return normalizeLocalPath(
    localJoin(base, raw),
    windowsBase ? "windows" : "posix",
  );
}

function localParentPath(path) {
  const normalized = normalizeLocalPath(path);
  if (!isWindowsLocalPath(normalized)) return parentPath(normalized);

  if (normalized.startsWith("\\\\")) {
    const tokens = normalized.split("\\").filter(Boolean);
    if (tokens.length < 2) return "\\\\";
    const root = `\\\\${tokens[0]}\\${tokens[1]}`;
    if (tokens.length <= 2) return root;
    return `${root}\\${tokens.slice(2, -1).join("\\")}`;
  }

  const driveRoot = extractWindowsDriveRoot(normalized);
  const lower = normalized.toLowerCase();
  if (driveRoot && lower === driveRoot.toLowerCase()) return driveRoot;

  const trimmed = normalized.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf("\\");
  if (idx <= 2) return driveRoot || "\\";
  return trimmed.slice(0, idx);
}

function basename(path) {
  return String(path).split(/[\\/]/).pop() || String(path);
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const LOCALE_STORAGE_KEY = "zeroterm.locale";
// Group tree expand/collapse state is a per-device UI preference, kept in
// localStorage. The group records themselves (and host→group membership)
// live in the encrypted vault and sync across devices.
const GROUP_STATE_STORAGE_KEY = "zeroterm.vault.group.state";

const I18N = {
  en: {
    "unlock.checking": "loading...",
    "unlock.enter_password": "Enter your master password to continue.",
    "unlock.no_vault": "First time? Choose a master password - it cannot be recovered.",
    "unlock.label.master": "Master password",
    "unlock.label.new_master": "New master password",
    "unlock.remember": "Remember password (store in OS keychain)",
    "unlock.button.unlock": "Unlock",
    "unlock.button.create": "Get Started",
    "unlock.confirm_placeholder": "Confirm master password",
    "unlock.path": "data: {path}",
    "unlock.error.passwords_mismatch": "passwords do not match",
    "common.error": "error: {error}",
    "common.ok": "OK",
    "common.group": "Group",
    "nav.hosts": "Hosts",
    "nav.keychain": "Keychain",
    "nav.port_forwarding": "Port Forwarding",
    "nav.known_hosts": "Known Hosts",
    "nav.logs": "Logs",
    "sidebar.terminals": "Terminals",
    "sidebar.new_window": "New Window",
    "sidebar.settings": "Settings",
    "sidebar.quick_connect": "Quick connect",
    "sidebar.local_terminal": "Local terminal",
    "sidebar.lock": "Lock",
    "sidebar.collapse": "Collapse",
    "sidebar.expand": "Expand",
    "metrics.title": "Metrics",
    "metrics.subtitle": "Current terminal session",
    "metrics.refresh": "Refresh",
    "metrics.empty.title": "No active terminal",
    "metrics.empty.desc": "Open a terminal session to view system metrics.",
    "metrics.system": "System",
    "metrics.host": "Host",
    "metrics.arch": "Arch",
    "metrics.os": "System",
    "metrics.uptime": "Uptime",
    "metrics.cpu": "CPU",
    "metrics.cpu.cores": "{count} cores",
    "metrics.cpu.avg": "Average usage",
    "metrics.memory": "Memory",
    "metrics.ram": "RAM",
    "metrics.swap": "Swap",
    "metrics.network": "Network",
    "metrics.disk": "Disk",
    "metrics.loading": "Collecting metrics...",
    "metrics.error": "Failed to collect metrics: {error}",
    "terminal_sftp.title": "SFTP",
    "terminal_sftp.pin": "Bookmarks",
    "terminal_sftp.pin.add_dir": "Bookmark current directory",
    "terminal_sftp.pin.add_folder": "Bookmark this folder",
    "terminal_sftp.pin.unpin": "Remove bookmark",
    "terminal_sftp.pin.empty": "No bookmarks",
    "terminal_sftp.pin.remove": "Remove",
    "terminal_sftp.subtitle": "Current terminal files",
    "terminal_sftp.empty.title": "No current terminal",
    "terminal_sftp.empty.desc": "Open a terminal session to browse files here.",
    "window.minimize": "Minimize",
    "window.maximize": "Maximize",
    "window.restore": "Restore",
    "window.close": "Close",
    "workspace.tab.vaults": "Hosts",
    "workspace.tab.sftp": "SFTP",
    "sftp.side.left": "Left",
    "sftp.side.right": "Right",
    "sftp.host.placeholder": "Select host...",
    "sftp.host.local": "Local",
    "sftp.host.group.empty": "No hosts in this group",
    "sftp.host.group.folder": "Group",
    "sftp.button.connect": "Connect",
    "sftp.button.disconnect": "Disconnect",
    "sftp.button.filter": "Filter",
    "sftp.button.actions": "Actions",
    "sftp.empty.connect_title": "Connect to host",
    "sftp.empty.connect_desc": "Please choose the host to connect above.",
    "sftp.empty.select_host": "Select host",
    "sftp.filter.title": "Filter",
    "sftp.filter.prompt": "Filter current pane by file/folder name (empty to clear):",
    "sftp.filter.placeholder": "e.g. log, conf, docker",
    "sftp.path.placeholder": "Enter path and press Enter (e.g. /var/log)",
    "hosts.search.placeholder": "Find a host or ssh user@hostname...",
    "hosts.new_host": "New host",
    "hosts.new_group": "New group",
    "hosts.empty.search": "No host matched your search.",
    "hosts.empty.title": "No saved hosts yet",
    "hosts.empty.default": "Click the button below to add your first host.",
    "hosts.empty.search.desc": "Try another keyword or clear the search filter.",
    "select.search.placeholder": "Type to filter...",
    "select.search.empty": "No matches",
    "hosts.button.connect": "Connect",
    "hosts.button.files": "Files",
    "hosts.button.edit": "Edit",
    "hosts.button.delete": "Delete",
    "hosts.menu.connect": "Connect",
    "hosts.menu.edit": "Edit",
    "hosts.menu.copy": "Copy",
    "hosts.menu.delete": "Delete",
    "groups.menu.add_host": "Add host",
    "groups.menu.add_subgroup": "Create subgroup",
    "groups.menu.expand": "Expand group",
    "groups.menu.expand_all": "Expand all groups",
    "groups.menu.collapse": "Collapse group",
    "groups.menu.collapse_all": "Collapse all groups",
    "groups.menu.edit": "Edit group",
    "groups.menu.delete": "Delete group",
    "groups.option.ungrouped": "(Ungrouped)",
    "groups.prompt.add.title": "Add group",
    "groups.prompt.add.message": "Enter group name",
    "groups.prompt.add.placeholder": "e.g. Production",
    "groups.prompt.add_sub.title": "Create subgroup",
    "groups.prompt.add_sub.message": "Parent group: {name}",
    "groups.prompt.add_sub.placeholder": "Enter subgroup name",
    "groups.confirm.delete": "Delete group \"{name}\"?",
    "hosts.copy.title": "Copy",
    "hosts.copy.message": "Connection info",
    "hosts.confirm.delete_one": "Delete saved host \"{name}\"?",
    "hosts.error.delete_failed": "delete failed: {error}",
    "hosts.error.no_tabs": "No terminal tabs yet. Open a host first.",
    "hosts.error.load_failed": "error: {error}",
    "terminal.button.new_tab": "+ Tab",
    "terminal.button.split_v": "Split V",
    "terminal.button.split_h": "Split H",
    "terminal.button.close_split": "Close Split",
    "terminal.button.new_window": "New Window",
    "terminal.button.back_hosts": "Hosts",
    "snippets.title": "Command Snippets",
    "snippets.subtitle": "Save frequent commands for quick reuse",
    "snippets.add": "Add command snippet",
    "snippets.empty.title": "No command snippets yet",
    "snippets.empty.desc": "Save frequently used commands here, then reuse them with one click.",
    "snippets.search.placeholder": "Search name or command",
    "snippets.ungrouped": "Ungrouped",
    "snippets.dialog.title": "Command snippet",
    "snippets.dialog.add_title": "Add command snippet",
    "snippets.dialog.edit_title": "Edit command snippet",
    "snippets.dialog.name": "Name",
    "snippets.dialog.name_placeholder": "e.g. View Docker logs",
    "snippets.dialog.group": "Group",
    "snippets.dialog.command": "Command",
    "snippets.dialog.command_placeholder": "e.g. docker logs -f app",
    "snippets.dialog.cancel": "Cancel",
    "snippets.dialog.save": "Save",
    "snippets.action.run": "Run",
    "snippets.action.insert": "Insert into terminal",
    "snippets.toast.ran": "Command snippet executed",
    "snippets.toast.inserted": "Inserted into current terminal",
    "snippets.toast.migrated": "Migrated {count} command snippets to the sync vault",
    "snippets.error.no_terminal": "There is no writable terminal session.",
    "snippets.error.create_failed": "Failed to add command snippet: {error}",
    "snippets.error.save_failed": "Failed to save command snippet: {error}",
    "snippets.error.delete_failed": "Failed to delete command snippet: {error}",
    "snippets.error.run_failed": "Failed to run command snippet: {error}",
    "snippets.error.insert_failed": "Failed to insert into terminal: {error}",
    "snippets.menu.add": "Add snippet",
    "snippets.menu.edit_group": "Edit group",
    "snippets.menu.delete_group": "Delete group",
    "snippets.menu.edit": "Edit",
    "snippets.menu.delete": "Delete",
    "snippets.group.edit_title": "Edit group",
    "snippets.group.edit_message": "Enter a new group name",
    "snippets.group.placeholder": "e.g. Docker",
    "snippets.group.rename_failed": "Failed to rename group: {error}",
    "snippets.group.delete_failed": "Failed to delete group: {error}",
    "terminal.empty": "No open terminal tabs. Open one from Hosts.",
    "terminal.new_tab_hint": "Select a host to open a new terminal tab.",
    "terminal.pane.empty": "Empty pane",
    "terminal.status.connecting": "connecting...",
    "terminal.status.connected": "connected",
    "terminal.status.unresponsive": "unresponsive",
    "terminal.status.disconnected": "disconnected",
    "terminal.button.reconnect": "Reconnect",
    "terminal.status.local": "local",
    "terminal.pane.local_title": "Local Terminal",
    "terminal.search.unavailable": "Search unavailable",
    "terminal.via": "via {jump}",
    "terminal.error.connect_failed_status": "connect failed: {error}",
    "terminal.error.connect_failed_term": "failed to connect: {error}",
    "terminal.error.new_window_failed": "new window failed: {error}",
    "terminal.error.split_limit": "Current split mode supports up to 2 panes.",
    "terminal.error.no_host": "Active pane has no host to duplicate.",
    "terminal.closed.remote_exited": "[remote exited with status {code}]",
    "terminal.closed.disconnected": "[disconnected]",
    "terminal.attention.tooltip": "Session is waiting for your confirmation / input",
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
    "host_key.accept_once": "Connect once",
    "host_key.accept": "Trust and connect",
    "host_key.accept_replace": "Trust and update key",
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
    "host_editor.label.proxy_jump": "Jump host (saved host)",
    "host_editor.label.advanced": "Jump host",
    "host_editor.label.port_forwards": "Port forwards",
    "host_editor.button.add_forward": "+ Add forward",
    "host_editor.hint.forwards": "Port forwards are now managed and synced as independent records from the Port Forwarding page.",
    "host_editor.button.choose_key": "Choose file...",
    "host_editor.button.cancel": "Cancel",
    "host_editor.button.save": "Save",
    "quick_connect.title": "Quick connect",
    "quick_connect.user": "User",
    "quick_connect.host": "Host",
    "quick_connect.port": "Port",
    "quick_connect.auth": "Authentication",
    "quick_connect.auth.password": "Password",
    "quick_connect.auth.key": "Private key",
    "quick_connect.auth.agent": "SSH agent",
    "quick_connect.password": "Password",
    "quick_connect.key": "Private key",
    "quick_connect.key_passphrase": "Passphrase (optional)",
    "quick_connect.key.pick": "Choose file...",
    "quick_connect.key.none": "No key loaded",
    "quick_connect.error.pick_key": "Please choose a private key file",
    "quick_connect.error.required_password": "user / host / password required",
    "quick_connect.error.required_host_user": "user / host required",
    "quick_connect.cancel": "Cancel",
    "quick_connect.connect": "Connect",
    "host_editor.auth.password": "Password",
    "host_editor.auth.key": "Private key",
    "host_editor.auth.agent": "SSH agent",
    "host_editor.key.none": "No key loaded",
    "host_editor.key.existing": "Existing key kept (choose a file to replace)",
    "host_editor.jump.none": "(none)",
    "host_editor.forward.none": "(no forwards)",
    "host_editor.forward.local": "Local (-L)",
    "host_editor.forward.remote": "Remote (-R)",
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.enabled": "Enabled",
    "host_editor.forward.bind": "bind",
    "host_editor.forward.port": "port",
    "host_editor.forward.target_host": "remote host",
    "host_editor.forward.remove": "Remove",
    "host_editor.key.pick_title": "Choose a private key",
    "host_editor.key.loaded": "loaded {name} ({bytes} bytes)",
    "host_editor.key.read_failed": "read failed: {error}",
    "password.toggle.show": "Show password",
    "password.toggle.hide": "Hide password",
    "passphrase.toggle.show": "Show passphrase",
    "passphrase.toggle.hide": "Hide passphrase",
    "host_editor.error.pick_new_key": "Pick a new key file to replace existing key.",
    "host_editor.error.pick_key_first": "Pick a private key file first.",
    "host_editor.error.required_fields": "name, host and user are required",
    "host_editor.error.load_failed": "load failed: {error}",
    "host_editor.error.forward_bind_port": "forward {index}: invalid bind port",
    "host_editor.error.forward_target_host": "forward {index}: remote host required",
    "host_editor.error.forward_target_port": "forward {index}: invalid remote port",
    "port_forward.title": "Port Forwarding",
    "port_forward.subtitle": "Start SSH forwards independently without opening a terminal session.",
    "port_forward.create": "New forward",
    "port_forward.refresh": "Refresh",
    "port_forward.search.placeholder": "Search host, port, or remote address...",
    "port_forward.empty.title": "No port forwards yet",
    "port_forward.empty.search_title": "No matching forwards",
    "port_forward.empty.desc": "Click \"New forward\", choose a host, then add an independent forwarding rule.",
    "port_forward.empty.search_desc": "Try another keyword, such as host name, port, or remote address.",
    "port_forward.title.dynamic": "SOCKS5 proxy: {bindAddr}:{bindPort}",
    "port_forward.title.local": "Open local {bindPort} to reach {targetHost}:{targetPort}",
    "port_forward.title.remote": "Open remote {bindPort} to reach local {targetHost}:{targetPort}",
    "port_forward.detail.dynamic": "App proxy address: {bindAddr}:{bindPort}",
    "port_forward.detail.local": "Open local {bindAddr}:{bindPort} to connect to {targetHost}:{targetPort} on the server",
    "port_forward.detail.remote": "Open server {bindAddr}:{bindPort} to connect back to local {targetHost}:{targetPort}",
    "port_forward.status.running": "running",
    "port_forward.status.reconnecting": "reconnecting…",
    "port_forward.status.stopped": "stopped",
    "port_forward.action.start": "Start",
    "port_forward.action.stop": "Stop",
    "port_forward.action.starting": "Starting...",
    "port_forward.action.stopping": "Stopping...",
    "port_forward.action.edit": "Edit",
    "port_forward.action.delete": "Delete",
    "port_forward.confirm.delete.title": "Delete port forward?",
    "port_forward.confirm.delete": "This rule will be removed from synced data. If it is running, ZeroTerm will stop it first.",
    "port_forward.confirm.close_app.title": "Active port forwards detected",
    "port_forward.confirm.close_app": "There are {count} active port forward(s). Closing ZeroTerm will stop them. Continue?",
    "port_forward.editor.title.create": "New forward",
    "port_forward.editor.title.edit": "Edit forward - {hostName}",
    "port_forward.editor.subtitle": "Forward rules sync independently from host connection details.",
    "port_forward.editor.host": "Host",
    "port_forward.editor.kind": "Forward type",
    "port_forward.editor.kind.local": "Local forward (-L)",
    "port_forward.editor.kind.remote": "Remote forward (-R)",
    "port_forward.editor.kind.dynamic": "SOCKS5 (-D)",
    "port_forward.editor.bind": "Bind address",
    "port_forward.editor.bind_port": "Bind port",
    "port_forward.editor.target_host": "Remote address",
    "port_forward.editor.target_port": "Target port",
    "port_forward.editor.bind_local": "Listen address (this computer)",
    "port_forward.editor.bind_remote": "Listen address (SSH server)",
    "port_forward.editor.bind_port_local": "Listen port (this computer)",
    "port_forward.editor.bind_port_remote": "Listen port (SSH server)",
    "port_forward.editor.target_local": "Target address (reached from the server)",
    "port_forward.editor.target_remote": "Target address (reached from this computer)",
    "port_forward.editor.hint.local": "Listen on THIS computer, then forward over SSH to a target the SERVER can reach. e.g. 127.0.0.1:3000 → (server) localhost:3000",
    "port_forward.editor.hint.remote": "Listen on the SSH SERVER, then forward back to a target THIS computer can reach. e.g. (server) 0.0.0.0:8080 → localhost:80",
    "port_forward.editor.hint.dynamic": "SOCKS5 listens on a local proxy port; the target address is chosen by the client request.",
    "port_forward.editor.error.host_required": "Please choose a host",
    "port_forward.editor.close": "Close",
    "port_forward.editor.cancel": "Cancel",
    "port_forward.editor.save": "Save",
    "files.title": "Files",
    "files.button.back": "Back",
    "files.button.up": "Up",
    "files.button.up_title": "Parent directory",
    "files.button.refresh": "Refresh",
    "files.button.new_folder": "New Folder",
    "files.button.new_file": "New File",
    "files.button.upload": "Upload",
    "files.button.upload_many": "Upload Many",
    "files.select_all": "Select all",
    "files.button.download_selected": "Download Selected",
    "files.button.delete_selected": "Delete Selected",
    "files.drop.hint": "Drop files to upload to current directory",
    "files.menu.edit": "Edit",
    "files.menu.download": "Download",
    "files.menu.open": "Open",
    "files.menu.open_with": "Open with...",
    "files.menu.copy_to_target": "Copy to target directory",
    "files.menu.rename": "Rename",
    "files.menu.delete": "Delete",
    "files.menu.show_hidden": "Show Hidden Files",
    "files.menu.hide_hidden": "Hide Hidden Files",
    "files.menu.permissions": "Edit Permissions",
    "files.menu.select_all": "Select All",
    "files.menu.close": "Disconnect",
    "files.selection.count": "{count} selected",
    "files.status.connecting": "Connecting...",
    "files.status.listing": "Listing {path}...",
    "files.error.mkdir_failed": "mkdir failed: {error}",
    "files.prompt.new_folder": "New folder name:",
    "files.prompt.new_file": "New file name:",
    "files.status.created_file": "Created file {path}.",
    "files.error.create_file_failed": "create file failed: {error}",
    "files.prompt.copy_target_dir": "Target directory path:",
    "files.prompt.permissions": "Enter octal permissions (for example 644 or 755):",
    "files.empty": "(empty)",
    "files.error.open_failed": "open failed: {error}",
    "files.error.list_failed": "list failed: {error}",
    "files.status.downloaded_one": "Downloaded {name} ({size}).",
    "files.status.downloaded_dir_to": "Downloaded folder {name} to {folder}.",
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
    "files.status.copied_to": "Copied {name} to {path}.",
    "files.status.copying_many": "Copying {count} item(s) to {path}...",
    "files.status.copied_many": "Copied {count} item(s) to {path}.",
    "files.status.hidden_shown": "Showing hidden files.",
    "files.status.hidden_hidden": "Hidden files are now hidden.",
    "files.status.selected_all": "Selected {count} item(s).",
    "files.error.copy_not_supported": "Copy to target directory is not available for this item yet.",
    "files.error.copy_failed": "copy failed: {error}",
    "files.error.copy_entry_failed": "copy {name} failed: {error}",
    "files.error.copy_partial": "Copied {ok}/{total} item(s), first error: {error}",
    "files.confirm.overwrite": "{path} already exists. Overwrite it?",
    "files.error.permissions_invalid": "Permissions must be a 3- or 4-digit octal value, for example 644 or 755.",
    "files.status.permissions_updated": "Permissions updated: {name} -> {mode}",
    "files.error.permissions_not_supported": "Editing permissions is not available yet.",
    "files.permissions.title": "Edit Permissions",
    "files.permissions.octal": "Octal permissions",
    "files.permissions.owner": "Owner",
    "files.permissions.group": "Group",
    "files.permissions.other": "Other",
    "files.permissions.read": "Read",
    "files.permissions.write": "Write",
    "files.permissions.exec": "Execute",
    "files.progress.uploading": "Uploading",
    "files.progress.downloading": "Downloading",
    "files.progress.deleting": "Deleting",
    "files.progress.eta": "ETA {eta}",
    "files.progress.preparing": "Preparing transfer...",
    "files.button.cancel": "Cancel",
    "files.button.overwrite": "Overwrite",
    "files.confirm.overwrite.title": "Replace existing file?",
    "files.transfer.queued": "Queued",
    "files.transfer.running": "Running",
    "files.transfer.finalizing": "Finalizing…",
    "files.transfer.success": "Done",
    "files.transfer.error": "Failed",
    "files.transfer.cancelled": "Cancelled",
    "files.transfer.retry": "Retry",
    "files.transfer.retry_failed": "Retry failed: {error}",
    "files.transfer.retry_unavailable": "Transfer retry is unavailable because the source or destination pane is disconnected.",
    "files.transfer.dismiss": "Dismiss",
    "files.transfer.title": "Transfers",
    "files.transfer.active_count": "{count} active",
    "files.transfer.done_count": "{count} finished",
    "files.transfer.clear_finished": "Clear finished",
    "files.transfer.collapse": "Collapse",
    "files.transfer.expand": "Expand",
    "files.transfer.files_progress": "{done}/{total} files",
    "files.transfer.items_progress": "{done}/{total} items",
    "files.transfer.route.direct": "direct",
    "files.transfer.route.direct_hint": "Copied server to server — the data never passed through this machine.",
    "files.transfer.route.relay": "via this PC",
    "files.transfer.route.relay_hint": "The source server can't reach the destination directly, so the data is being relayed through this machine. Speed is limited by your own connection.",
    "files.transfer.route.relay_reason": "Reason: ",
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
    "editor.button.close_inline": "✕",
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
    "sftp.status.not_connected": "Not connected",
    "sftp.status.connecting": "Connecting...",
    "sftp.status.connected": "Connected: {name}",
    "sftp.status.local": "Local: {path}",
    "sftp.error.connect_failed": "connect failed: {error}",
    "settings.title": "Settings",
    "settings.general.title": "General",
    "settings.general.desc": "Configure language, network proxy, session history, and SFTP-related options.",
    "settings.nav.pref": "Preferences",
    "settings.nav.general": "General",
    "settings.nav.terminal": "Terminal",
    "settings.nav.ai": "AI",
    "settings.nav.sync": "Sync",
    "settings.nav.data": "Data",
    "settings.nav.about": "About",
    "settings.general.subtab.basic": "Basic",
    "settings.general.subtab.sftp": "SFTP",
    "settings.proxy.label": "Network Proxy",
    "settings.proxy.hint": "Route built-in app traffic through one HTTP proxy URL. Example: http://127.0.0.1:7890",
    "settings.proxy.url_label": "Proxy URL",
    "settings.proxy.note": "New requests apply immediately. Existing SSH/SFTP sessions need reconnecting.",
    "settings.proxy.save": "Save",
    "settings.proxy.clear": "Clear",
    "settings.proxy.placeholder": "http://127.0.0.1:7890",
    "settings.proxy.error.required": "Proxy URL is required.",
    "settings.proxy.status.current": "Current proxy: {url}",
    "settings.proxy.status.saved": "Proxy saved. New network requests will use it right away.",
    "settings.proxy.status.cleared": "Proxy cleared. New network requests now connect directly.",
    "settings.proxy.status.disabled": "No proxy is configured.",
    "settings.proxy.status.failed": "Could not save proxy: {error}",
    "settings.bg.label": "Background Image",
    "settings.bg.hint": "Use a custom image as the app background.",
    "settings.bg.empty": "No image",
    "settings.bg.choose": "Choose Image",
    "settings.bg.remove": "Remove",
    "settings.bg.opacity": "Opacity",
    "settings.bg.blur": "Blur",
    "settings.bg.status.applied": "Background applied",
    "settings.bg.status.cleared": "Background removed",
    "settings.bg.status.failed": "Could not load image: {error}",
    "settings.bg.status.too_large": "Image is too large (max 16 MB).",
    "settings.winsize.label": "Startup Window Layout",
    "settings.winsize.hint": "Resize the window and the left/right side panels to your liking, then save them as the layout the app opens with.",
    "settings.winsize.saved": "Saved — window {win}, left sidebar {left}, right sidebar {right}",
    "settings.winsize.default": "Default — window {win}, left sidebar {left}, right sidebar {right}",
    "settings.winsize.save": "Save current layout",
    "settings.winsize.reset": "Reset to default",
    "settings.winsize.status.saved": "Saved the current window and sidebar layout.",
    "settings.winsize.status.reset": "Cleared the saved layout; defaults apply on next launch.",
    "settings.winsize.status.failed": "Could not save the layout: {error}",
    "ai.assistant.title": "AI Assistant",
    "ai.retry": "Retry",
    "ai.assistant.subtitle": "Current SSH session",
    "ai.model.unconfigured": "No model configured",
    "ai.model.current": "Current AI model: {label}",
    "ai.model.pill_title": "Current AI model",
    "ai.model.switch_title": "Switch AI model",
    "ai.model.empty": "Refresh models in Settings first",
    "ai.model.section": "Models",
    "ai.profile.section": "Configs",
    "ai.profile.empty": "No configs yet — add one in Settings",
    "ai.profile.manage": "Manage configs…",
    "ai.hero.kicker": "Natural language operation",
    "ai.hero.title": "Tell the AI your goal — no commands needed.",
    "ai.hero.desc": "The AI inspects the server, lays out a plan, then asks before acting. Commands and logs are folded by default; expand them when you want detail.",
    "ai.step.1.title": "Understand the goal",
    "ai.step.1.desc": "Break your request down into runnable tasks.",
    "ai.step.2.title": "Plan",
    "ai.step.2.desc": "Run read-only checks first, then explain what changes are needed.",
    "ai.step.3.title": "Confirm before running",
    "ai.step.3.desc": "Risky actions like delete, overwrite, and restart prompt for confirmation.",
    "ai.examples.title": "Try saying",
    "ai.example.1": "Get this project up and running",
    "ai.example.2": "Check whether this server is healthy",
    "ai.example.3": "Explain the error in the terminal just now",
    "ai.example.4": "Make a tarball backup of this directory",
    "ai.compose.placeholder": "Describe your goal, e.g. Get this project running",
    "ai.compose.hint": "Enter to send, Shift+Enter for newline",
    "ai.compose.send": "Send to AI",
    "terminal.selection.copy": "Copy",
    "terminal.selection.execute": "Execute",
    "terminal.selection.ai": "AI",
    "terminal.selection.sftp": "SFTP to directory",
    "terminal.selection.open": "Open",
    "terminal.selection.search": "Search",
    "terminal.selection.open_url": "Open link",
    "terminal.selection.copy_failed": "Copy failed: {error}",
    "terminal.selection.execute_failed": "Execute failed: {error}",
    "terminal.selection.search_failed": "Search failed: {error}",
    "terminal.selection.open_url_failed": "Open link failed: {error}",
    "terminal.selection.sftp_failed": "SFTP jump failed: {error}",
    "terminal.selection.ai_busy": "AI is still working. Please wait for this turn to finish.",
    "ai.context.toggle.title": "Toggle attaching current terminal output",
    "ai.context.toggle.label": "Auto-include terminal context",
    "ai.context.mode.always": "Always include terminal",
    "ai.context.mode.off": "No terminal context",
    "ai.session.title": "AI Sessions",
    "ai.session.desc.current": "Only showing AI sessions for {scope}.",
    "ai.session.desc.all": "Showing all AI sessions saved on this device.",
    "ai.session.scope.global": "Global",
    "ai.session.scope.local": "Local terminal",
    "ai.session.scope.ssh": "SSH host",
    "ai.session.temp_title": "Temporary session",
    "ai.session.temp_button": "Temporary session",
    "ai.session.temp_meta": "Unsaved temporary session",
    "ai.session.new_title": "New session",
    "ai.session.close": "Close",
    "ai.session.filter.aria": "AI session scope",
    "ai.session.filter.current": "Current host",
    "ai.session.filter.all": "All sessions",
    "ai.session.empty.current": "No sessions for current host",
    "ai.session.empty.all": "No sessions",
    "ai.session.clear.current": "Clear current host sessions",
    "ai.session.clear.all": "Clear all sessions",
    "ai.session.confirm.new": "Start a new session? The current session will remain in the session list.",
    "ai.session.confirm.new_temp": "Start a new session? The current temporary session will not be saved.",
    "ai.session.confirm.clear_current": "Clear AI sessions for {scope}?",
    "ai.session.confirm.clear_all": "Clear all AI sessions?",
    "ai.session.toast.need_scope": "Switch to the matching host before continuing this AI session.",
    "ai.session.toast.cleared_current": "Current host AI sessions cleared",
    "ai.session.toast.cleared_all": "AI sessions cleared",
    "ai.session.toast.clear_failed": "Failed to clear AI sessions: {error}",
    "ai.session.meta.messages": "{count} messages",
    "ai.panel.aria": "AI Assistant",
    "ai.panel.expand": "Open AI Assistant",
    "ai.panel.collapse": "Close AI Assistant",
    "ai.workflow.aria": "AI workflow",
    "ai.examples.aria": "Example goals",
    "settings.sync.desc": "Manage your sync repo for ZeroTerm.",
    "settings.sync.status.loaded": "Loaded {count} profile(s)",
    "settings.sync.status.none": "No sync profile",
    "settings.sync.status.saved": "Profile saved",
    "settings.sync.status.updated": "Profile updated",
    "settings.sync.status.sync_now": "Sync complete: pulled {pulled}, pushed {pushed}",
    "settings.sync.status.repo_created": "New sync repo created and seeded",
    "settings.sync.status.repo_created_seeded": "New sync repo created and seeded {count} record(s)",
    "settings.sync.status.creating_repo": "Creating sync repo...",
    "settings.sync.alert.repo_created": "Sync repo created successfully.",
    "settings.sync.alert.repo_failed": "Create repo failed:\n{error}",
    "settings.sync.error.not_connected": "Sync is not connected yet. Please create or join a repo first.",
    "settings.sync.status.joined": "Joined existing sync repo",
    "settings.sync.status.joined_detail": "Joined existing sync repo: pulled {pulled}, applied {applied}, conflicts {conflicts}",
    "settings.sync.status.aborted": "Aborted — data source mismatch",
    "settings.sync.status.forgotten": "Engine forgotten (passphrase required to resume)",
    "settings.sync.status.cleared_all": "Cleared {count} sync profile(s)",
    "settings.sync.status.remote_deleted": "Remote repo contents cleared (directory may remain)",
    "settings.sync.confirm.clear_all": "Delete all sync profiles and credentials? This cannot be undone.",
    "settings.sync.confirm.delete_remote": "Clear remote repo contents now? This affects all devices and cannot be undone.",
    "settings.sync.confirm.delete_remote.title": "Clear remote repo contents",
    "settings.sync.confirm.delete_remote.message": "Type DELETE to confirm clearing remote repo contents.",
    "settings.sync.confirm.delete_remote.placeholder": "Type DELETE",
    "settings.sync.confirm.delete_remote.keyword": "DELETE",
    "settings.sync.confirm.delete_remote.mismatch": "Confirmation text mismatch. Deletion cancelled.",
    "settings.sync.status.no_profile": "No sync profile configured",
    "settings.sync.status.bootstrapped": "Connected",
    "settings.sync.status.not_bootstrapped": "Not connected — Create or Join the repo to begin",
    "settings.sync.status.invalid.host_record_missing": "The SFTP host this profile points at was deleted — pick another host below and save again.",
    "settings.sync.status.invalid.profile_missing": "The sync profile no longer exists. Recreate it to continue.",
    "settings.sync.status.invalid.generic": "Sync profile is invalid ({reason}).",
    "settings.sync.status.title": "Sync Status",
    "settings.sync.error.root_required": "Pick a sync folder first",
    "settings.sync.error.passphrase_required": "Enter the sync passphrase first",
    "settings.sync.error.host_required": "Pick an SFTP host first",
    "settings.sync.error.remote_dir_required": "Enter the remote directory first",
    "settings.sync.error.webdav_url_required": "Enter the WebDAV server URL first",
    "settings.sync.error.webdav_user_required": "Enter the WebDAV username first",
    "settings.sync.error.s3_region_required": "Enter the S3 region first",
    "settings.sync.error.s3_bucket_required": "Enter the S3 bucket first",
    "settings.sync.error.s3_ak_required": "Enter the S3 access key ID first",
    "settings.sync.sftp.host": "SFTP host",
    "settings.sync.sftp.remote_dir": "Remote directory",
    "settings.sync.sftp.no_hosts": "Add an SSH host first",
    "settings.sync.webdav.url": "WebDAV Server URL",
    "settings.sync.webdav.root_path": "Repo Subpath (optional)",
    "settings.sync.webdav.username": "Username",
    "settings.sync.webdav.password": "Password",
    "settings.sync.webdav.password_placeholder": "WebDAV server password",
    "settings.sync.s3.region": "S3 Region",
    "settings.sync.s3.bucket": "Bucket",
    "settings.sync.s3.prefix": "Repo Prefix (optional)",
    "settings.sync.s3.endpoint": "Endpoint (optional)",
    "settings.sync.s3.path_style": "Path-style URL (usually needed for MinIO/R2)",
    "settings.sync.s3.access_key_id": "Access Key ID",
    "settings.sync.s3.secret_access_key": "Secret Access Key",
    "settings.sync.s3.session_token": "Session Token (optional)",
    "settings.sync.s3.secret_access_key_placeholder": "Leave empty to keep existing key",
    "settings.sync.s3.session_token_placeholder": "Optional STS temporary credential",
    "settings.sync.backend.sftp": "SFTP",
    "settings.sync.backend.webdav": "WebDAV",
    "settings.sync.backend.s3": "S3",
    "settings.sync.confirm.vault_mismatch": "This repo was created from a different data source (id = {remote}). Syncing will be rejected every time. Proceed anyway?",
    "settings.sync.devices.title": "Joined Devices",
    "settings.sync.devices.empty": "Device list appears after you join a repo and run sync.",
    "settings.sync.devices.no_profile": "Configure sync to view joined devices.",
    "settings.sync.devices.this_device": "This device",
    "settings.sync.devices.current_badge": "Current",
    "settings.sync.devices.last_seen": "Last seen {when}",
    "settings.sync.devices.revoke": "Revoke",
    "settings.sync.devices.revoke_title": "Revoke device and rotate keys",
    "settings.sync.devices.revoke_confirm": "Revoke {device}? The passphrase currently entered above becomes the new sync passphrase. The repository root key and complete snapshot will be rotated; every retained device must reconnect with the new passphrase.",
    "settings.sync.devices.revoke_progress": "Rotating the sync root key and re-encrypting the repository...",
    "settings.sync.devices.revoke_done": "Device revoked. Root key rotated to epoch {epoch}; share the new passphrase with retained devices.",
    "settings.sync.devices.revoke_failed": "Device revocation failed: {error}",
    "settings.sync.devices.new_passphrase_required": "Enter a new sync passphrase above before revoking a device.",
    "settings.sync.conflicts.title": "Conflict Inbox",
    "settings.sync.conflicts.empty": "No conflicts pending.",
    "settings.sync.conflicts.no_profile": "Configure a sync profile to see conflicts.",
    "settings.sync.conflicts.local": "Local",
    "settings.sync.conflicts.remote": "Remote",
    "settings.sync.conflicts.local_hint": "Version on this device",
    "settings.sync.conflicts.remote_hint": "Version from the sync repo / other device",
    "settings.sync.conflicts.record_fallback": "Unnamed record",
    "settings.sync.conflicts.detected_unknown": "Detected time unknown",
    "settings.sync.conflicts.summary": "Both sides changed this record. Pick the version you want to keep; the other version will be overwritten on the next sync.",
    "settings.sync.conflicts.preview_empty": "No readable fields in this version. It may be an old, deleted, or incompatible record.",
    "settings.sync.conflicts.field_name": "Name",
    "settings.sync.conflicts.field_host": "Host",
    "settings.sync.conflicts.field_port": "Port",
    "settings.sync.conflicts.field_user": "User",
    "settings.sync.conflicts.field_auth": "Auth",
    "settings.sync.conflicts.field_group": "Group",
    "settings.sync.conflicts.field_os": "OS",
    "settings.sync.conflicts.field_forwards": "Forwards",
    "settings.sync.conflicts.field_host_id": "Host ID",
    "settings.sync.conflicts.tombstone": "(deleted upstream)",
    "settings.sync.conflicts.redacted": "(secret content, {bytes} bytes)",
    "settings.sync.conflicts.keep_local": "Keep local",
    "settings.sync.conflicts.keep_remote": "Keep remote",
    "settings.sync.conflicts.resolved": "Conflict resolved",
    "settings.sync.host_diag.malformed": "Synced host records include {bad} malformed item(s); showing {ok}/{total} valid hosts.",
    "settings.sync.stats.no_profile": "Configure a sync profile to see stats.",
    "settings.sync.stats.total": "Total",
    "settings.sync.stats.manifest": "manifest.json",
    "settings.sync.stats.keyring": "keyring.json",
    "settings.sync.stats.snapshots": "snapshots/",
    "settings.sync.stats.events": "events/",
    "settings.sync.stats.trash": "trash/",
    "settings.sync.compact.done": "Compacted {events} events into a snapshot of {records} records",
    "settings.sync.compact.retained": " · kept {kept} recent events",
    "settings.sync.compact.tombstones": " · pruned {tombstones} old tombstones",
    "settings.sync.button.refresh_stats": "Refresh stats",
    "settings.sync.button.compact_now": "Compact now",
    "settings.sync.repo_stats.title": "Repo Size",
    "settings.sync.repo_stats.empty": "Stats not loaded yet",
    "settings.sync.bootstrap.hint": "First device: Create a new repo. Other devices: use the same passphrase to Join.",
    "settings.sync.remember_passphrase": "Remember passphrase (OS keychain)",
    "settings.sync.title": "Sync",
    "settings.sync.auto.title": "Auto-sync",
    "settings.sync.auto.enabled": "Enable auto-sync",
    "settings.sync.auto.interval": "Heartbeat interval",
    "settings.sync.auto.interval_suffix": "seconds (30–600)",
    "settings.sync.auto.on_visibility": "Sync immediately when window becomes visible",
    "sync.indicator.idle": "Sync ready",
    "sync.indicator.syncing": "Syncing…",
    "sync.indicator.ok": "Synced {when}",
    "sync.indicator.failed": "Sync failed (retry #{n})",
    "sync.indicator.auto_off": "Auto-sync off",
    "sync.indicator.no_profile": "No sync profile",
    "sync.indicator.just_now": "just now",
    "sync.indicator.seconds_ago": "{n}s ago",
    "sync.indicator.minutes_ago": "{n}m ago",
    "sync.indicator.hours_ago": "{n}h ago",
    "sync.conflict_modal.title": "Sync conflicts detected",
    "sync.conflict_modal.body": "{n} record(s) have conflicting changes from another device. Open the sync settings to choose which version to keep.",
    "sync.conflict_modal.later": "Later",
    "sync.conflict_modal.go": "Open sync settings",
    "settings.sync.method": "Sync Method",
    "settings.sync.button.save": "Save Config",
    "settings.sync.button.browse": "Browse",
    "settings.sync.button.now": "Sync Now",
    "settings.sync.button.create_repo": "Create Repo",
    "settings.sync.button.join_repo": "Join Repo",
    "settings.sync.button.forget_engine": "Disconnect",
    "settings.sync.button.clear_all": "Clear all",
    "settings.sync.button.delete_remote": "Clear remote contents",
    "settings.sync.button.busy.save": "Saving...",
    "settings.sync.button.busy.create_repo": "Creating...",
    "settings.sync.button.busy.join_repo": "Joining...",
    "settings.sync.button.busy.now": "Syncing...",
    "settings.sync.button.busy.refresh_stats": "Refreshing...",
    "settings.sync.button.busy.compact_now": "Compacting...",
    "settings.sync.button.busy.forget_engine": "Disconnecting...",
    "settings.sync.button.busy.clear_all": "Clearing...",
    "settings.sync.button.busy.delete_remote": "Deleting...",
    "settings.sync.button.busy.resolve_conflict": "Resolving...",
    "settings.data.title": "Data Management",
    "settings.data.desc": "Choose exactly which local data to clear. This action cannot be undone.",
    "settings.data.button.clear": "Clear Data",
    "settings.data.dialog.title": "Clear data",
    "settings.data.dialog.message": "Select the data items to clear. This action cannot be undone.",
    "settings.data.dialog.warning": "Only selected items will be cleared.",
    "settings.data.dialog.confirm": "Clear selected",
    "settings.data.dialog.none": "Select at least one item to clear.",
    "settings.data.item.local_settings": "Local app settings",
    "settings.data.item.local_settings.desc": "Appearance, terminal settings, proxy, background image, window layout, SFTP preferences, auto-sync options, and local UI state.",
    "settings.data.item.vault_data": "Vault data",
    "settings.data.item.vault_data.desc": "All encrypted Vault records, including saved hosts, groups, snippets, port forwards, and Vault-stored metadata.",
    "settings.data.item.sync_profiles": "Sync profiles",
    "settings.data.item.sync_profiles.desc": "Local sync profiles and cached sync engine/keychain state. Remote repository contents are not deleted.",
    "settings.data.item.ai_profiles": "AI profiles",
    "settings.data.item.ai_profiles.desc": "Saved AI provider configurations and their stored API keys.",
    "settings.data.item.ai_sessions": "AI session history",
    "settings.data.item.ai_sessions.desc": "Saved AI chat sessions on this device.",
    "settings.data.item.remembered_password": "Remembered unlock password",
    "settings.data.item.remembered_password.desc": "The cached Vault unlock password in the system keychain.",
    "settings.data.status.cleared_selected": "Cleared: {items}",
    "settings.update.status.installing": "Installing update...",
    "settings.sync.backend.local_folder": "Local Folder",
    "settings.sync.label.path": "Sync Folder",
    "settings.sync.placeholder.enc_password": "sync passphrase",
    "settings.sync.hint.keychain_keep": "Stored in system keychain; leave empty to keep unchanged.",
    "settings.sync.tip.local": "Local Folder mode requires iCloud/Dropbox/Syncthing (or similar) to sync across devices.",
    "settings.sync.enc.title": "Sync Passphrase",
    "theme.menu.edit": "Edit theme",
    "theme.menu.duplicate": "Duplicate as custom",
    "theme.menu.delete": "Delete theme",
    "theme.create.title": "Create theme",
    "theme.edit.title": "Edit theme",
    "theme.edit.name": "Theme name",
    "theme.edit.background": "Background",
    "theme.edit.foreground": "Foreground",
    "theme.edit.cursor": "Cursor",
    "theme.edit.selection": "Selection",
    "theme.edit.reset": "Reset",
    "theme.edit.cancel": "Cancel",
    "theme.edit.save": "Save",
    "theme.prompt.duplicate.title": "Duplicate as custom",
    "theme.prompt.duplicate.message": "Enter a new theme name",
    "theme.confirm.delete.title": "Delete theme?",
    "theme.confirm.delete": "Delete theme \"{name}\"? This cannot be undone.",
    "theme.error.delete_current": "The current theme cannot be deleted",
    "theme.error.name_required": "Please enter a theme name",
    "theme.mode.button": "Theme mode",
    "theme.mode.system": "System",
    "theme.mode.dark": "Dark",
    "theme.mode.light": "Light",
    "settings.nav.sftp": "SFTP",
    "settings.nav.hotkeys": "Hotkeys",
    "settings.terminal.desc": "Configure terminal themes and visual behavior.",
    "settings.ai.title": "AI Assistant",
    "settings.ai.desc": "Configure the model service and what the assistant is allowed to do.",
    "settings.ai.provider.title": "AI Service",
    "settings.ai.provider.desc": "Configure model services for the terminal assistant. Save multiple configs and switch anytime; keys are stored in the OS keychain.",
    "settings.ai.provider.label": "Provider",
    "settings.ai.provider.openai_compatible": "OpenAI Compatible",
    "settings.ai.provider.openai": "OpenAI",
    "settings.ai.provider.anthropic": "Anthropic",
    "settings.ai.provider.gemini": "Gemini",
    "settings.ai.provider.ollama": "Ollama",
    "settings.ai.model.label": "Model",
    "settings.ai.model.custom_label": "Custom model",
    "settings.ai.model.placeholder": "e.g. gpt-4.1 or qwen2.5-coder",
    "settings.ai.model.refresh": "Refresh",
    "settings.ai.base_url.label": "Base URL",
    "settings.ai.base_url.placeholder": "e.g. https://api.example.com/v1",
    "settings.ai.api_key.label": "API Key",
    "settings.ai.api_key.placeholder": "Leave blank to keep the saved key",
    "settings.ai.status.unsaved": "AI config has not been saved yet.",
    "settings.ai.status.saved": "AI config saved locally.",
    "settings.ai.status.ready": "AI config is ready.",
    "settings.ai.status.no_key": "AI config loaded. Add an API Key before chatting.",
    "settings.ai.button.save": "Save config",
    "settings.ai.button.busy.refresh": "Refreshing…",
    "settings.ai.status.models_fetched": "Fetched {count} model(s).",
    "settings.ai.toast.models_refreshed": "Model list refreshed.",
    "settings.ai.name.label": "Name",
    "settings.ai.name.placeholder": "e.g. OpenAI work / local Ollama",
    "settings.ai.add": "New config",
    "settings.ai.cancel": "Cancel",
    "settings.ai.empty": "No AI configs yet. Click \"New config\" to add one.",
    "settings.ai.profile.active": "Active",
    "settings.ai.profile.no_key": "no key",
    "settings.ai.profile.set_active": "Switch",
    "settings.ai.profile.edit": "Edit",
    "settings.ai.profile.delete": "Delete",
    "settings.ai.profile.confirm_delete": "Delete config \"{name}\"? Its saved API key will be removed.",
    "settings.ai.profile.new": "New config",
    "settings.ai.profile.edit_title": "Edit config",
    "settings.ai.reasoning_effort.label": "Reasoning effort",
    "settings.ai.reasoning_effort.default": "Default (auto)",
    "settings.ai.reasoning_effort.low": "Low",
    "settings.ai.reasoning_effort.medium": "Medium",
    "settings.ai.reasoning_effort.high": "High",
    "settings.language.label": "Language",
    "settings.language.hint": "Changes apply immediately and are saved locally.",
    "settings.version.label": "Version",
    "settings.about.title": "About",
    "settings.about.author": "Author",
    "settings.about.repo": "GitHub Repository",
    "settings.about.tagline": "Next-gen, blazing-fast, modern cross-platform SSH terminal.",
    "settings.update.install": "Update",
    "settings.update.title": "System Update",
    "settings.update.checking": "Checking for updates or already up to date...",
    "settings.update.signature_invalid": "Update unavailable: the release server's signature isn't ready yet. Try again later.",
    "settings.update.latest": "You are on the latest version ({version}).",
    "settings.update.available": "Update available: {current} -> {latest}",
    "settings.update.failed": "Update failed: {error}",
    "settings.update.dialog.title": "What's New",
    "settings.update.dialog.version": "New version: {version}",
    "settings.update.dialog.cancel": "Cancel",
    "settings.update.dialog.confirm": "Update",
    "settings.update.dialog.no_notes": "No release notes are available for this update.",
    "settings.terminal_theme.title": "Theme",
    "settings.terminal_theme.subtitle": "Preview and tune terminal colors live",
    "settings.terminal_theme.light_title": "Light Terminal Themes",
    "settings.terminal_theme.dark_title": "Dark Terminal Themes",
    "settings.terminal_theme.add": "+ New Theme",
    "settings.terminal_theme.label": "Theme",
    "terminal.theme.name.tokyo_day": "Mist Paper",
    "terminal.theme.name.catppuccin_latte": "Cloud Latte",
    "terminal.theme.name.sage_light": "Sage Field",
    "terminal.theme.name.termark_dark": "Midnight Slate",
    "terminal.theme.name.kanagawa_wave": "Ink Garden",
    "terminal.theme.name.catppuccin_mocha": "Violet Dusk",
    "settings.terminal_font.title": "Font Settings",
    "settings.terminal_font.hint": "Set font family, size, and line height together with live preview.",
    "settings.terminal_font.family": "Font",
    "settings.terminal_font.size": "Size",
    "settings.terminal_font.line_height": "Line Height",
    "settings.terminal.subtab.theme": "Theme",
    "settings.terminal.subtab.font": "Font",
    "settings.terminal.title": "Terminal",
    "settings.terminal.desc": "Configure the shell used by local terminal tabs.",
    "settings.terminal.shell.label": "Local terminal shell",
    "settings.terminal.shell.hint": "Path to the shell executable launched for Local terminal tabs. Leave empty to use the system default.",
    "settings.terminal.shell.browse": "Browse",
    "settings.terminal.shell.reset": "Reset",
    "settings.terminal.shell.system_default": "System default",
    "settings.terminal.shell.current": "Used when empty: {shell}",
    "settings.terminal.cwd.label": "Working directory",
    "settings.terminal.cwd.hint": "Open Local terminal tabs in this directory. Leave empty to use the default.",
    "settings.terminal.cwd.placeholder": "e.g. D:\\projects",
    "settings.terminal.cwd.browse": "Browse",
    "settings.terminal.selection_menu_order.label": "Context menu order",
    "settings.terminal.selection_menu_order.hint": "Drag items to customize the right-click menu order shown after selecting terminal text.",
    "settings.terminal.selection_menu_order.reset": "Reset order",
    "settings.terminal.attention_flash.label": "Flash the taskbar icon while a background tab waits",
    "settings.terminal.attention_flash.hint": "When a CLI in a background tab is waiting for your confirmation, flash the taskbar icon (bounce the Dock icon on macOS). Stops as soon as you return to the window.",
    "settings.sftp.title": "SFTP",
    "settings.sftp.follow.label": "Directory follow",
    "settings.sftp.follow.hint": "Remote directory follow uses shell OSC 7 hints. If the shell does not emit OSC 7, the SFTP pane stays where you leave it.",
    "settings.sftp.local_dir.label": "Default local open directory",
    "settings.sftp.local_dir.hint": "Optional. When opening SFTP workspace, local file pane starts here; empty uses user home.",
    "settings.sftp.local_dir.placeholder": "e.g. /Users/username/Downloads",
    "settings.sftp.local_dir.browse": "Browse",
    "settings.button.close": "Close",
    "settings.language.zh": "Simplified Chinese",
    "settings.language.en": "English",
    "input.title": "Input",
    "input.button.cancel": "Cancel",
    "input.button.confirm": "OK",
    "input.placeholder": "Enter value...",
  },
  "zh-CN": {
    "unlock.checking": "正在加载...",
    "unlock.enter_password": "请输入主密码继续。",
    "unlock.no_vault": "首次使用，请设置主密码。主密码无法找回。",
    "unlock.label.master": "主密码",
    "unlock.label.new_master": "新主密码",
    "unlock.remember": "记住密码（保存到系统钥匙串）",
    "unlock.button.unlock": "解锁",
    "unlock.button.create": "开始使用",
    "unlock.confirm_placeholder": "确认主密码",
    "unlock.path": "数据位置：{path}",
    "unlock.error.passwords_mismatch": "两次输入的密码不一致",
    "common.error": "错误：{error}",
    "common.ok": "确定",
    "common.group": "分组",
    "nav.hosts": "主机",
    "nav.keychain": "钥匙串",
    "nav.port_forwarding": "端口转发",
    "nav.known_hosts": "已知主机",
    "nav.logs": "日志",
    "sidebar.terminals": "终端",
    "sidebar.new_window": "新窗口",
    "sidebar.settings": "设置",
    "sidebar.quick_connect": "临时连接",
    "sidebar.local_terminal": "本地终端",
    "sidebar.lock": "锁定",
    "sidebar.collapse": "收起",
    "sidebar.expand": "展开",
    "metrics.title": "指标监控",
    "metrics.subtitle": "当前终端会话",
    "metrics.refresh": "刷新",
    "metrics.empty.title": "没有活动终端",
    "metrics.empty.desc": "打开一个终端会话后查看系统指标。",
    "metrics.system": "系统",
    "metrics.host": "主机",
    "metrics.arch": "架构",
    "metrics.os": "系统",
    "metrics.uptime": "运行时长",
    "metrics.cpu": "CPU",
    "metrics.cpu.cores": "{count} 核",
    "metrics.cpu.avg": "平均使用率",
    "metrics.memory": "内存",
    "metrics.ram": "RAM",
    "metrics.swap": "Swap",
    "metrics.network": "网络",
    "metrics.disk": "磁盘",
    "metrics.loading": "正在采集指标...",
    "metrics.error": "指标采集失败：{error}",
    "terminal_sftp.title": "SFTP",
    "terminal_sftp.pin": "书签",
    "terminal_sftp.pin.add_dir": "将当前目录添加为书签",
    "terminal_sftp.pin.add_folder": "添加为书签",
    "terminal_sftp.pin.unpin": "移除书签",
    "terminal_sftp.pin.empty": "暂无书签",
    "terminal_sftp.pin.remove": "移除",
    "terminal_sftp.subtitle": "当前终端文件",
    "terminal_sftp.empty.title": "没有当前终端",
    "terminal_sftp.empty.desc": "打开终端会话后，可在这里浏览当前主机文件。",
    "window.minimize": "最小化",
    "window.maximize": "最大化",
    "window.restore": "还原",
    "window.close": "关闭",
    "workspace.tab.vaults": "主机",
    "workspace.tab.sftp": "SFTP",
    "sftp.side.left": "左侧",
    "sftp.side.right": "右侧",
    "sftp.host.placeholder": "选择主机...",
    "sftp.host.local": "本地",
    "sftp.host.group.empty": "该分组下暂无主机",
    "sftp.host.group.folder": "分组",
    "sftp.button.connect": "连接",
    "sftp.button.disconnect": "断开",
    "sftp.button.filter": "筛选",
    "sftp.button.actions": "操作",
    "sftp.empty.connect_title": "连接到主机",
    "sftp.empty.connect_desc": "请在上方选择要连接的主机",
    "sftp.empty.select_host": "选择主机",
    "sftp.filter.title": "筛选",
    "sftp.filter.prompt": "按文件/目录名称筛选当前窗格（留空可清除）：",
    "sftp.filter.placeholder": "例如 log、conf、docker",
    "sftp.path.placeholder": "输入路径后按回车跳转（例如 /var/log）",
    "hosts.search.placeholder": "搜索主机或 ssh user@hostname...",
    "hosts.new_host": "新建主机",
    "hosts.new_group": "新建分组",
    "hosts.empty.search": "没有匹配搜索条件的主机。",
    "hosts.empty.title": "还没有保存的主机",
    "hosts.empty.default": "点击下面的按钮添加第一台主机。",
    "hosts.empty.search.desc": "试试其他关键词，或清空搜索条件。",
    "select.search.placeholder": "输入以筛选...",
    "select.search.empty": "没有匹配项",
    "hosts.button.connect": "连接",
    "hosts.button.files": "文件",
    "hosts.button.edit": "编辑",
    "hosts.button.delete": "删除",
    "hosts.menu.connect": "连接",
    "hosts.menu.edit": "编辑",
    "hosts.menu.copy": "复制",
    "hosts.menu.delete": "删除",
    "groups.menu.add_host": "添加主机",
    "groups.menu.add_subgroup": "创建子分组",
    "groups.menu.expand": "展开分组",
    "groups.menu.expand_all": "展开全部分组",
    "groups.menu.collapse": "折叠分组",
    "groups.menu.collapse_all": "折叠全部分组",
    "groups.menu.edit": "编辑分组",
    "groups.menu.delete": "删除分组",
    "groups.option.ungrouped": "（未分组）",
    "groups.prompt.add.title": "添加分组",
    "groups.prompt.add.message": "请输入分组名称",
    "groups.prompt.add.placeholder": "例如：生产环境",
    "groups.prompt.add_sub.title": "创建子分组",
    "groups.prompt.add_sub.message": "父分组：{name}",
    "groups.prompt.add_sub.placeholder": "请输入子分组名称",
    "groups.confirm.delete": "删除分组“{name}”？",
    "hosts.copy.title": "复制",
    "hosts.copy.message": "连接信息",
    "hosts.confirm.delete_one": "确认删除已保存主机“{name}”？",
    "hosts.error.delete_failed": "删除失败：{error}",
    "hosts.error.no_tabs": "当前没有终端标签页，请先打开一个主机。",
    "hosts.error.load_failed": "错误：{error}",
    "terminal.button.new_tab": "+ 标签页",
    "terminal.button.split_v": "垂直分屏",
    "terminal.button.split_h": "水平分屏",
    "terminal.button.close_split": "关闭分屏",
    "terminal.button.new_window": "新窗口",
    "terminal.button.back_hosts": "主机",
    "snippets.title": "命令片段",
    "snippets.subtitle": "保存常用命令，快速复制",
    "snippets.add": "新增命令片段",
    "snippets.empty.title": "还没有命令片段",
    "snippets.empty.desc": "把常用命令保存在这里，后面可以一键复制。",
    "snippets.search.placeholder": "搜索名称或命令",
    "snippets.ungrouped": "未分组",
    "snippets.dialog.title": "命令片段",
    "snippets.dialog.add_title": "新增命令片段",
    "snippets.dialog.edit_title": "编辑命令片段",
    "snippets.dialog.name": "名称",
    "snippets.dialog.name_placeholder": "例如：查看 Docker 日志",
    "snippets.dialog.group": "分组",
    "snippets.dialog.command": "命令",
    "snippets.dialog.command_placeholder": "例如：docker logs -f app",
    "snippets.dialog.cancel": "取消",
    "snippets.dialog.save": "保存",
    "snippets.action.run": "执行",
    "snippets.action.insert": "填入",
    "snippets.toast.ran": "已执行命令片段",
    "snippets.toast.inserted": "已填入当前终端",
    "snippets.toast.migrated": "已迁移 {count} 条命令片段到同步库",
    "snippets.error.no_terminal": "当前没有可写入的终端会话",
    "snippets.error.create_failed": "新增命令片段失败: {error}",
    "snippets.error.save_failed": "保存命令片段失败: {error}",
    "snippets.error.delete_failed": "删除命令片段失败: {error}",
    "snippets.error.run_failed": "执行命令片段失败: {error}",
    "snippets.error.insert_failed": "填入终端失败: {error}",
    "snippets.menu.add": "新增片段",
    "snippets.menu.edit_group": "编辑分组",
    "snippets.menu.delete_group": "删除分组",
    "snippets.menu.edit": "编辑",
    "snippets.menu.delete": "删除",
    "snippets.group.edit_title": "编辑分组",
    "snippets.group.edit_message": "请输入新的分组名称",
    "snippets.group.placeholder": "例如：Docker",
    "snippets.group.rename_failed": "重命名分组失败: {error}",
    "snippets.group.delete_failed": "删除分组失败: {error}",
    "terminal.empty": "当前没有打开的终端标签页，请从主机页打开。",
    "terminal.new_tab_hint": "请选择一个主机来打开新终端标签页。",
    "terminal.pane.empty": "空窗格",
    "terminal.status.connecting": "连接中...",
    "terminal.status.connected": "已连接",
    "terminal.status.unresponsive": "无响应",
    "terminal.status.disconnected": "已断开",
    "terminal.button.reconnect": "重新连接",
    "terminal.status.local": "本地",
    "terminal.pane.local_title": "本地终端",
    "terminal.search.unavailable": "搜索不可用",
    "terminal.via": "经由 {jump}",
    "terminal.error.connect_failed_status": "连接失败：{error}",
    "terminal.error.connect_failed_term": "连接失败：{error}",
    "terminal.error.new_window_failed": "新窗口打开失败：{error}",
    "terminal.error.split_limit": "当前分屏模式最多支持 2 个窗格。",
    "terminal.error.no_host": "当前活动窗格没有可复制的主机。",
    "terminal.closed.remote_exited": "[远端退出状态 {code}]",
    "terminal.closed.disconnected": "[已断开]",
    "terminal.attention.tooltip": "会话正在等待确认 / 输入",
    "host_key.unknown_title": "未知主机",
    "host_key.unknown_body":
      "无法确认“{host}:{port}”的真实性。信任后会将该主机密钥写入 known_hosts。",
    "host_key.changed_title": "警告：主机密钥已变化",
    "host_key.changed_body": "这可能是中间人攻击，请确认变更原因后再继续。",
    "host_key.changed_server_now": "服务器当前提供：",
    "host_key.changed_known_hosts_has": "known_hosts 中记录：",
    "host_key.unknown_value": "（未知）",
    "host_key.reject": "取消连接",
    "host_key.accept_once": "仅本次连接",
    "host_key.accept": "信任并连接",
    "host_key.accept_replace": "信任并更新密钥",
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
    "host_editor.label.proxy_jump": "跳板机（已保存主机）",
    "host_editor.label.advanced": "跳板机",
    "host_editor.label.port_forwards": "端口转发",
    "host_editor.button.add_forward": "+ 添加转发",
    "host_editor.hint.forwards": "端口转发现在请到“端口转发”页面管理，并会作为独立记录同步。",
    "host_editor.button.choose_key": "选择文件...",
    "host_editor.button.cancel": "取消",
    "host_editor.button.save": "保存",
    "quick_connect.title": "临时连接",
    "quick_connect.user": "用户",
    "quick_connect.host": "主机",
    "quick_connect.port": "端口",
    "quick_connect.auth": "认证方式",
    "quick_connect.auth.password": "密码",
    "quick_connect.auth.key": "私钥",
    "quick_connect.auth.agent": "SSH Agent",
    "quick_connect.password": "密码",
    "quick_connect.key": "私钥",
    "quick_connect.key_passphrase": "私钥口令（可选）",
    "quick_connect.key.pick": "选择文件...",
    "quick_connect.key.none": "未加载私钥",
    "quick_connect.error.pick_key": "请先选择私钥文件",
    "quick_connect.error.required_password": "请填写用户 / 主机 / 密码",
    "quick_connect.error.required_host_user": "请填写用户 / 主机",
    "quick_connect.cancel": "取消",
    "quick_connect.connect": "连接",
    "host_editor.auth.password": "密码",
    "host_editor.auth.key": "私钥",
    "host_editor.auth.agent": "SSH agent",
    "host_editor.key.none": "尚未加载私钥",
    "host_editor.key.existing": "保留已有私钥（选择文件可替换）",
    "host_editor.jump.none": "（无）",
    "host_editor.forward.none": "（无转发）",
    "host_editor.forward.local": "本地转发 (-L)",
    "host_editor.forward.remote": "远程转发 (-R)",
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.enabled": "启用",
    "host_editor.forward.bind": "监听地址",
    "host_editor.forward.port": "端口",
    "host_editor.forward.target_host": "远端地址",
    "host_editor.forward.remove": "移除",
    "host_editor.key.pick_title": "选择私钥文件",
    "host_editor.key.loaded": "已加载 {name}（{bytes} 字节）",
    "host_editor.key.read_failed": "读取失败：{error}",
    "password.toggle.show": "显示密码",
    "password.toggle.hide": "隐藏密码",
    "passphrase.toggle.show": "显示口令",
    "passphrase.toggle.hide": "隐藏口令",
    "host_editor.error.pick_new_key": "请先选择新的私钥文件以替换已有私钥。",
    "host_editor.error.pick_key_first": "请先选择私钥文件。",
    "host_editor.error.required_fields": "名称、主机、用户为必填项",
    "host_editor.error.load_failed": "加载失败：{error}",
    "host_editor.error.forward_bind_port": "第 {index} 条转发：监听端口无效",
    "host_editor.error.forward_target_host": "第 {index} 条转发：远端地址必填",
    "host_editor.error.forward_target_port": "第 {index} 条转发：远端端口无效",
    "port_forward.title": "端口转发",
    "port_forward.subtitle": "独立启动 SSH 转发，无需打开终端会话。",
    "port_forward.create": "新建转发",
    "port_forward.refresh": "刷新",
    "port_forward.search.placeholder": "搜索主机、端口或远端地址...",
    "port_forward.empty.title": "暂无端口转发",
    "port_forward.empty.search_title": "没有匹配的转发",
    "port_forward.empty.desc": "点击“新建转发”，选择主机后即可添加独立转发规则。",
    "port_forward.empty.search_desc": "换个关键词试试，例如主机名、端口号或远端地址。",
    "port_forward.title.dynamic": "SOCKS5 代理：{bindAddr}:{bindPort}",
    "port_forward.title.local": "访问本机端口 {bindPort} 连接远程 {targetHost}:{targetPort}",
    "port_forward.title.remote": "访问远程端口 {bindPort} 连接本机 {targetHost}:{targetPort}",
    "port_forward.detail.dynamic": "应用代理地址：{bindAddr}:{bindPort}",
    "port_forward.detail.local": "访问本机 {bindAddr}:{bindPort}，会连接到服务器上的 {targetHost}:{targetPort}",
    "port_forward.detail.remote": "访问服务器 {bindAddr}:{bindPort}，会反连到本机 {targetHost}:{targetPort}",
    "port_forward.status.running": "运行中",
    "port_forward.status.reconnecting": "重连中…",
    "port_forward.status.stopped": "未启动",
    "port_forward.action.start": "启动",
    "port_forward.action.stop": "停止",
    "port_forward.action.starting": "启动中...",
    "port_forward.action.stopping": "停止中...",
    "port_forward.action.edit": "编辑",
    "port_forward.action.delete": "删除",
    "port_forward.confirm.delete.title": "删除端口转发？",
    "port_forward.confirm.delete": "这条规则会从同步数据中删除。如果正在运行，ZeroTerm 会先停止转发。",
    "port_forward.confirm.close_app.title": "检测到正在运行的端口转发",
    "port_forward.confirm.close_app": "当前有 {count} 个正在运行的端口转发。关闭 ZeroTerm 会停止它们。确定继续关闭吗？",
    "port_forward.editor.title.create": "新建转发",
    "port_forward.editor.title.edit": "编辑转发 - {hostName}",
    "port_forward.editor.subtitle": "转发规则会独立于主机连接信息同步。",
    "port_forward.editor.host": "主机",
    "port_forward.editor.kind": "转发类型",
    "port_forward.editor.kind.local": "本地转发 (-L)",
    "port_forward.editor.kind.remote": "远程转发 (-R)",
    "port_forward.editor.kind.dynamic": "SOCKS5 (-D)",
    "port_forward.editor.bind": "监听地址",
    "port_forward.editor.bind_port": "监听端口",
    "port_forward.editor.target_host": "远端地址",
    "port_forward.editor.target_port": "目标端口",
    "port_forward.editor.bind_local": "监听地址（本机）",
    "port_forward.editor.bind_remote": "监听地址（服务器）",
    "port_forward.editor.bind_port_local": "监听端口（本机）",
    "port_forward.editor.bind_port_remote": "监听端口（服务器）",
    "port_forward.editor.target_local": "目标地址（服务器可达）",
    "port_forward.editor.target_remote": "目标地址（本机可达）",
    "port_forward.editor.hint.local": "在【本机】监听，经 SSH 转发到【服务器能访问】的目标。例：本机 127.0.0.1:3000 →（服务器）localhost:3000",
    "port_forward.editor.hint.remote": "在【服务器】监听，经 SSH 反向转发到【本机能访问】的目标。例：（服务器）0.0.0.0:8080 → 本机 localhost:80",
    "port_forward.editor.hint.dynamic": "SOCKS5 会在本机监听一个代理端口，目标地址由客户端请求决定。",
    "port_forward.editor.error.host_required": "请选择主机",
    "port_forward.editor.close": "关闭",
    "port_forward.editor.cancel": "取消",
    "port_forward.editor.save": "保存",
    "files.title": "文件",
    "files.button.back": "返回",
    "files.button.up": "上级目录",
    "files.button.up_title": "返回父目录",
    "files.button.refresh": "刷新",
    "files.button.new_folder": "新建文件夹",
    "files.button.new_file": "新建文件",
    "files.button.upload": "上传",
    "files.button.upload_many": "批量上传",
    "files.select_all": "全选",
    "files.button.download_selected": "下载所选",
    "files.button.delete_selected": "删除所选",
    "files.drop.hint": "拖拽文件到此处上传到当前目录",
    "files.menu.edit": "编辑",
    "files.menu.download": "下载",
    "files.menu.open": "打开",
    "files.menu.open_with": "打开方式...",
    "files.menu.copy_to_target": "复制到目标目录",
    "files.menu.rename": "重命名",
    "files.menu.delete": "删除",
    "files.menu.show_hidden": "显示隐藏文件",
    "files.menu.hide_hidden": "不显示隐藏文件",
    "files.menu.permissions": "编辑权限",
    "files.menu.select_all": "全选",
    "files.menu.close": "断开连接",
    "files.selection.count": "已选 {count} 项",
    "files.status.connecting": "连接中...",
    "files.status.listing": "正在列出 {path}...",
    "files.error.mkdir_failed": "创建目录失败：{error}",
    "files.prompt.new_folder": "新文件夹名称：",
    "files.prompt.new_file": "新文件名称：",
    "files.status.created_file": "已创建文件 {path}。",
    "files.error.create_file_failed": "创建文件失败：{error}",
    "files.prompt.copy_target_dir": "目标目录路径：",
    "files.prompt.permissions": "请输入八进制权限（例如 644 或 755）：",
    "files.empty": "（空）",
    "files.error.open_failed": "打开失败：{error}",
    "files.error.list_failed": "列表读取失败：{error}",
    "files.status.downloaded_one": "已下载 {name}（{size}）。",
    "files.status.downloaded_dir_to": "已将文件夹 {name} 下载到 {folder}。",
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
    "files.status.copied_to": "已将 {name} 复制到 {path}。",
    "files.status.copying_many": "正在复制 {count} 项到 {path}...",
    "files.status.copied_many": "已复制 {count} 项到 {path}。",
    "files.status.hidden_shown": "已显示隐藏文件。",
    "files.status.hidden_hidden": "已不显示隐藏文件。",
    "files.status.selected_all": "已选择 {count} 项。",
    "files.error.copy_not_supported": "当前项目暂不支持复制到目标目录。",
    "files.error.copy_failed": "复制失败：{error}",
    "files.error.copy_entry_failed": "复制 {name} 失败：{error}",
    "files.error.copy_partial": "已复制 {ok}/{total} 项，首个错误：{error}",
    "files.confirm.overwrite": "{path} 已存在，是否覆盖？",
    "files.error.permissions_invalid": "权限必须是 3 位或 4 位八进制值，例如 644 或 755。",
    "files.status.permissions_updated": "权限已更新：{name} -> {mode}",
    "files.error.permissions_not_supported": "暂不支持编辑权限。",
    "files.permissions.title": "编辑权限",
    "files.permissions.octal": "八进制权限",
    "files.permissions.owner": "所有者",
    "files.permissions.group": "用户组",
    "files.permissions.other": "其他人",
    "files.permissions.read": "读",
    "files.permissions.write": "写",
    "files.permissions.exec": "执行",
    "files.progress.uploading": "上传中",
    "files.progress.downloading": "下载中",
    "files.progress.deleting": "删除中",
    "files.progress.eta": "剩余 {eta}",
    "files.progress.preparing": "正在准备传输...",
    "files.button.cancel": "取消",
    "files.button.overwrite": "覆盖",
    "files.confirm.overwrite.title": "覆盖已有文件？",
    "files.transfer.queued": "排队中",
    "files.transfer.running": "传输中",
    "files.transfer.finalizing": "正在完成…",
    "files.transfer.success": "已完成",
    "files.transfer.error": "失败",
    "files.transfer.cancelled": "已取消",
    "files.transfer.retry": "重试",
    "files.transfer.retry_failed": "重试失败：{error}",
    "files.transfer.retry_unavailable": "源或目标面板已断开，当前无法重试该传输。",
    "files.transfer.dismiss": "关闭",
    "files.transfer.title": "传输",
    "files.transfer.active_count": "{count} 项进行中",
    "files.transfer.done_count": "{count} 项已结束",
    "files.transfer.clear_finished": "清除已完成",
    "files.transfer.collapse": "收起",
    "files.transfer.expand": "展开",
    "files.transfer.files_progress": "文件 {done}/{total}",
    "files.transfer.items_progress": "项目 {done}/{total}",
    "files.transfer.route.direct": "服务器直连",
    "files.transfer.route.direct_hint": "数据在两台服务器之间直接传输,未经过本机。",
    "files.transfer.route.relay": "经本机中转",
    "files.transfer.route.relay_hint": "源服务器无法直接连到目标服务器,数据正经由本机中转,速度受本机带宽限制。",
    "files.transfer.route.relay_reason": "原因：",
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
    "editor.button.close_inline": "✕",
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
    "sftp.status.not_connected": "未连接",
    "sftp.status.connecting": "连接中...",
    "sftp.status.connected": "已连接：{name}",
    "sftp.status.local": "本地：{path}",
    "sftp.error.connect_failed": "连接失败：{error}",
    "settings.title": "设置",
    "settings.general.title": "常规",
    "settings.general.desc": "配置界面语言、网络代理、会话历史和 SFTP 相关选项",
    "settings.nav.pref": "偏好",
    "settings.nav.general": "常规",
    "settings.nav.terminal": "终端",
    "settings.nav.ai": "AI",
    "settings.nav.sync": "同步",
    "settings.nav.data": "数据管理",
    "settings.nav.about": "关于",
    "settings.general.subtab.basic": "基础",
    "settings.general.subtab.sftp": "SFTP",
    "settings.proxy.label": "网络代理",
    "settings.proxy.hint": "为应用内置网络请求统一配置一个 HTTP 代理地址，例如：http://127.0.0.1:7890",
    "settings.proxy.url_label": "代理地址",
    "settings.proxy.note": "新的网络请求会立即生效；已建立的 SSH/SFTP 会话需要重连。",
    "settings.proxy.save": "保存",
    "settings.proxy.clear": "清除",
    "settings.proxy.placeholder": "http://127.0.0.1:7890",
    "settings.proxy.error.required": "请输入代理地址。",
    "settings.proxy.status.current": "当前代理：{url}",
    "settings.proxy.status.saved": "代理已保存，新的网络请求会立即走代理。",
    "settings.proxy.status.cleared": "代理已清除，新的网络请求将直接连接。",
    "settings.proxy.status.disabled": "当前未配置代理。",
    "settings.proxy.status.failed": "保存代理失败：{error}",
    "settings.bg.label": "背景图片",
    "settings.bg.hint": "使用自定义图片作为软件背景。",
    "settings.bg.empty": "暂无图片",
    "settings.bg.choose": "选择图片",
    "settings.bg.remove": "移除",
    "settings.bg.opacity": "不透明度",
    "settings.bg.blur": "模糊",
    "settings.bg.status.applied": "背景已应用",
    "settings.bg.status.cleared": "背景已移除",
    "settings.bg.status.failed": "无法加载图片：{error}",
    "settings.bg.status.too_large": "图片过大（上限 16 MB）。",
    "settings.winsize.label": "启动窗口布局",
    "settings.winsize.hint": "把窗口和左右两侧的面板调整到喜欢的大小，再保存为应用启动时的布局。",
    "settings.winsize.saved": "已保存 — 窗口 {win}，左侧栏 {left}，右侧栏 {right}",
    "settings.winsize.default": "使用默认 — 窗口 {win}，左侧栏 {left}，右侧栏 {right}",
    "settings.winsize.save": "记录当前布局",
    "settings.winsize.reset": "恢复默认",
    "settings.winsize.status.saved": "已记录当前窗口与侧边栏布局。",
    "settings.winsize.status.reset": "已清除保存的布局，下次启动使用默认值。",
    "settings.winsize.status.failed": "保存布局失败：{error}",
    "ai.assistant.title": "AI 助手",
    "ai.retry": "重试",
    "ai.assistant.subtitle": "当前 SSH 会话",
    "ai.model.unconfigured": "未配置模型",
    "ai.model.current": "当前 AI 模型：{label}",
    "ai.model.pill_title": "当前 AI 模型",
    "ai.model.switch_title": "切换 AI 模型",
    "ai.model.empty": "请先在设置里刷新模型列表",
    "ai.model.section": "模型",
    "ai.profile.section": "配置",
    "ai.profile.empty": "还没有配置，去设置里添加",
    "ai.profile.manage": "管理配置…",
    "ai.hero.kicker": "自然语言操作",
    "ai.hero.title": "告诉 AI 你的目标，不需要会命令。",
    "ai.hero.desc": "AI 会理解当前服务器环境，先说明计划，确认后再操作。命令和日志默认折叠，需要时可以展开查看。",
    "ai.step.1.title": "理解目标",
    "ai.step.1.desc": "把你的描述拆成可执行任务。",
    "ai.step.2.title": "制定计划",
    "ai.step.2.desc": "先做只读检查，再说明需要的操作。",
    "ai.step.3.title": "确认后执行",
    "ai.step.3.desc": "删除、覆盖、重启等风险动作会单独确认。",
    "ai.examples.title": "试着这样说",
    "ai.example.1": "帮我把当前项目运行起来",
    "ai.example.2": "检查这台服务器是否正常",
    "ai.example.3": "解释刚才终端里的错误",
    "ai.example.4": "把这个目录打包备份一下",
    "ai.compose.placeholder": "描述你的目标，例如：帮我把这个项目运行起来",
    "ai.compose.hint": "Enter 发送，Shift+Enter 换行",
    "ai.compose.send": "发送给 AI",
    "terminal.selection.copy": "拷贝",
    "terminal.selection.execute": "执行",
    "terminal.selection.ai": "AI",
    "terminal.selection.sftp": "SFTP 跳转到目录",
    "terminal.selection.open": "访问",
    "terminal.selection.search": "搜索",
    "terminal.selection.open_url": "打开链接",
    "terminal.selection.copy_failed": "复制失败：{error}",
    "terminal.selection.execute_failed": "执行失败：{error}",
    "terminal.selection.search_failed": "搜索失败：{error}",
    "terminal.selection.open_url_failed": "打开链接失败：{error}",
    "terminal.selection.sftp_failed": "SFTP 跳转失败：{error}",
    "terminal.selection.ai_busy": "AI 正在处理中，请等当前这轮完成后再试。",
    "ai.context.toggle.title": "切换是否附带当前终端内容",
    "ai.context.toggle.label": "智能判断终端内容",
    "ai.context.mode.always": "总是附带终端内容",
    "ai.context.mode.off": "不附带终端内容",
    "ai.session.title": "AI 会话",
    "ai.session.desc.current": "当前只显示 {scope} 的 AI 会话。",
    "ai.session.desc.all": "当前显示本机保存的全部 AI 会话。",
    "ai.session.scope.global": "全局",
    "ai.session.scope.local": "本地终端",
    "ai.session.scope.ssh": "SSH 主机",
    "ai.session.temp_title": "临时会话",
    "ai.session.temp_button": "临时会话",
    "ai.session.temp_meta": "未保存的临时会话",
    "ai.session.new_title": "新会话",
    "ai.session.close": "关闭",
    "ai.session.filter.aria": "AI 会话范围",
    "ai.session.filter.current": "当前机器",
    "ai.session.filter.all": "全部会话",
    "ai.session.empty.current": "当前机器暂无会话",
    "ai.session.empty.all": "暂无会话",
    "ai.session.clear.current": "清空当前机器会话",
    "ai.session.clear.all": "清空全部会话",
    "ai.session.confirm.new": "开始新会话？当前会话会保留在会话列表中。",
    "ai.session.confirm.new_temp": "开始新会话？当前临时会话不会被保存。",
    "ai.session.confirm.clear_current": "清空 {scope} 的 AI 会话？",
    "ai.session.confirm.clear_all": "清空所有 AI 会话？",
    "ai.session.toast.need_scope": "请切换到对应机器后再继续这个 AI 会话",
    "ai.session.toast.cleared_current": "当前机器 AI 会话已清空",
    "ai.session.toast.cleared_all": "AI 会话已清空",
    "ai.session.toast.clear_failed": "清空 AI 会话失败：{error}",
    "ai.session.meta.messages": "{count} 条消息",
    "ai.panel.aria": "AI 助手",
    "ai.panel.expand": "展开 AI 助手",
    "ai.panel.collapse": "收起 AI 助手",
    "ai.workflow.aria": "AI 工作流程",
    "ai.examples.aria": "示例目标",
    "settings.sync.desc": "管理 ZeroTerm 同步仓库。",
    "settings.sync.status.loaded": "已加载 {count} 个配置",
    "settings.sync.status.none": "暂无同步配置",
    "settings.sync.status.saved": "配置已保存",
    "settings.sync.status.updated": "配置已更新",
    "settings.sync.status.sync_now": "同步完成：拉取 {pulled}，推送 {pushed}",
    "settings.sync.status.repo_created": "已创建新同步仓库并写入快照",
    "settings.sync.status.repo_created_seeded": "已创建新同步仓库，初始化写入 {count} 条记录",
    "settings.sync.status.creating_repo": "正在创建同步仓库...",
    "settings.sync.alert.repo_created": "同步仓库创建成功。",
    "settings.sync.alert.repo_failed": "创建仓库失败：\n{error}",
    "settings.sync.error.not_connected": "同步尚未连接，请先创建或加入仓库。",
    "settings.sync.status.joined": "已加入现有同步仓库",
    "settings.sync.status.joined_detail": "已加入现有同步仓库：拉取 {pulled}，应用 {applied}，冲突 {conflicts}",
    "settings.sync.status.aborted": "已中止 — 数据源不匹配",
    "settings.sync.status.forgotten": "已断开会话（需要密码重新连接）",
    "settings.sync.status.cleared_all": "已清空 {count} 个同步配置",
    "settings.sync.status.remote_deleted": "已清空远端仓库内容（目录可能保留）",
    "settings.sync.confirm.clear_all": "确定要删除所有同步配置和凭据吗？此操作不可撤销。",
    "settings.sync.confirm.delete_remote": "确定清空远端仓库内容吗？这会影响所有设备，且不可撤销。",
    "settings.sync.confirm.delete_remote.title": "清空远端仓库内容",
    "settings.sync.confirm.delete_remote.message": "请输入 DELETE 以确认清空远端仓库内容。",
    "settings.sync.confirm.delete_remote.placeholder": "请输入 DELETE",
    "settings.sync.confirm.delete_remote.keyword": "DELETE",
    "settings.sync.confirm.delete_remote.mismatch": "确认文本不匹配，已取消删除。",
    "settings.sync.status.no_profile": "尚未配置同步",
    "settings.sync.status.bootstrapped": "已连接",
    "settings.sync.status.not_bootstrapped": "未连接 — 请创建或加入仓库",
    "settings.sync.status.invalid.host_record_missing": "该 SFTP 仓库引用的主机已被删除,请在下方重新选择主机后保存。",
    "settings.sync.status.invalid.profile_missing": "同步配置已不存在,请重新创建。",
    "settings.sync.status.invalid.generic": "同步配置已失效({reason})。",
    "settings.sync.status.title": "同步状态",
    "settings.sync.error.root_required": "请先选择同步文件夹",
    "settings.sync.error.passphrase_required": "请先输入同步密码",
    "settings.sync.error.host_required": "请先选择 SFTP 主机",
    "settings.sync.error.remote_dir_required": "请输入远端目录",
    "settings.sync.error.webdav_url_required": "请先填写 WebDAV 服务地址",
    "settings.sync.error.webdav_user_required": "请先填写 WebDAV 用户名",
    "settings.sync.error.s3_region_required": "请先填写 S3 Region",
    "settings.sync.error.s3_bucket_required": "请先填写 S3 Bucket",
    "settings.sync.error.s3_ak_required": "请先填写 S3 Access Key ID",
    "settings.sync.sftp.host": "SFTP 主机",
    "settings.sync.sftp.remote_dir": "远端目录",
    "settings.sync.sftp.no_hosts": "请先添加 SSH 主机",
    "settings.sync.webdav.url": "WebDAV 服务地址",
    "settings.sync.webdav.root_path": "仓库子路径(可选)",
    "settings.sync.webdav.username": "用户名",
    "settings.sync.webdav.password": "密码",
    "settings.sync.webdav.password_placeholder": "WebDAV 服务密码",
    "settings.sync.s3.region": "S3 Region",
    "settings.sync.s3.bucket": "Bucket",
    "settings.sync.s3.prefix": "仓库前缀(可选)",
    "settings.sync.s3.endpoint": "Endpoint(可选)",
    "settings.sync.s3.path_style": "Path-style 地址(MinIO/R2 一般需要)",
    "settings.sync.s3.access_key_id": "Access Key ID",
    "settings.sync.s3.secret_access_key": "Secret Access Key",
    "settings.sync.s3.session_token": "Session Token(可选)",
    "settings.sync.s3.secret_access_key_placeholder": "留空保留旧密钥",
    "settings.sync.s3.session_token_placeholder": "STS 临时凭据(可选)",
    "settings.sync.backend.sftp": "SFTP",
    "settings.sync.backend.webdav": "WebDAV",
    "settings.sync.backend.s3": "S3",
    "settings.sync.confirm.vault_mismatch": "该仓库来自另一台设备的不同数据源（id = {remote}）。继续将导致每次同步被拒。仍要继续吗？",
    "settings.sync.devices.title": "已加入设备",
    "settings.sync.devices.empty": "设备列表会在加入仓库并完成同步后显示。",
    "settings.sync.devices.no_profile": "请先配置同步以查看已加入设备。",
    "settings.sync.devices.this_device": "本机",
    "settings.sync.devices.current_badge": "当前设备",
    "settings.sync.devices.last_seen": "最后在线 {when}",
    "settings.sync.devices.revoke": "撤销",
    "settings.sync.devices.revoke_title": "撤销设备并轮换密钥",
    "settings.sync.devices.revoke_confirm": "确定撤销 {device} 吗？上方当前输入的密码将成为新的同步密码。仓库根密钥和完整快照会被轮换，所有保留设备都必须使用新密码重新连接。",
    "settings.sync.devices.revoke_progress": "正在轮换同步根密钥并重新加密仓库...",
    "settings.sync.devices.revoke_done": "设备已撤销，根密钥已轮换到第 {epoch} 代；请把新密码安全地提供给保留设备。",
    "settings.sync.devices.revoke_failed": "撤销设备失败：{error}",
    "settings.sync.devices.new_passphrase_required": "撤销设备前，请先在上方输入一个新的同步密码。",
    "settings.sync.conflicts.title": "冲突收件箱",
    "settings.sync.conflicts.empty": "暂无待解决冲突。",
    "settings.sync.conflicts.no_profile": "请先配置同步以查看冲突。",
    "settings.sync.conflicts.local": "本地",
    "settings.sync.conflicts.remote": "远端",
    "settings.sync.conflicts.local_hint": "当前这台设备上的版本",
    "settings.sync.conflicts.remote_hint": "同步仓库 / 其他设备上的版本",
    "settings.sync.conflicts.record_fallback": "未命名记录",
    "settings.sync.conflicts.detected_unknown": "发现时间未知",
    "settings.sync.conflicts.summary": "这条记录在本地和远端都被改过，无法自动判断保留哪份。请选择要保留的版本，另一份会在下次同步时被覆盖。",
    "settings.sync.conflicts.preview_empty": "这一版没有可显示字段，可能是旧版本、已删除或格式不兼容的记录。",
    "settings.sync.conflicts.field_name": "名称",
    "settings.sync.conflicts.field_host": "主机",
    "settings.sync.conflicts.field_port": "端口",
    "settings.sync.conflicts.field_user": "用户",
    "settings.sync.conflicts.field_auth": "认证",
    "settings.sync.conflicts.field_group": "分组",
    "settings.sync.conflicts.field_os": "系统",
    "settings.sync.conflicts.field_forwards": "端口转发",
    "settings.sync.conflicts.field_host_id": "主机 ID",
    "settings.sync.conflicts.tombstone": "（远端已删除）",
    "settings.sync.conflicts.redacted": "（私密内容，{bytes} 字节）",
    "settings.sync.conflicts.keep_local": "保留本地",
    "settings.sync.conflicts.keep_remote": "保留远端",
    "settings.sync.conflicts.resolved": "冲突已解决",
    "settings.sync.host_diag.malformed": "同步到的主机记录里有 {bad} 条格式不兼容，当前显示 {ok}/{total} 条可解析主机。",
    "settings.sync.stats.no_profile": "请先配置同步以查看大小。",
    "settings.sync.stats.total": "总计",
    "settings.sync.stats.manifest": "manifest.json",
    "settings.sync.stats.keyring": "keyring.json",
    "settings.sync.stats.snapshots": "snapshots/",
    "settings.sync.stats.events": "events/",
    "settings.sync.stats.trash": "trash/",
    "settings.sync.compact.done": "压缩 {events} 个事件 → {records} 条记录的新快照",
    "settings.sync.compact.retained": " · 保留最近 {kept} 个事件",
    "settings.sync.compact.tombstones": " · 清理 {tombstones} 个过期墓碑",
    "settings.sync.button.refresh_stats": "刷新统计",
    "settings.sync.button.compact_now": "立即压缩",
    "settings.sync.repo_stats.title": "仓库大小",
    "settings.sync.repo_stats.empty": "尚未拉取统计",
    "settings.sync.bootstrap.hint": "首台设备点\"创建仓库\"；其他设备用同样的密码点\"加入仓库\"。",
    "settings.sync.remember_passphrase": "记住密码（系统钥匙串）",
    "settings.sync.title": "同步",
    "settings.sync.auto.title": "自动同步",
    "settings.sync.auto.enabled": "启用自动同步",
    "settings.sync.auto.interval": "心跳间隔",
    "settings.sync.auto.interval_suffix": "秒（30–600）",
    "settings.sync.auto.on_visibility": "窗口恢复可见时立即同步",
    "sync.indicator.idle": "同步就绪",
    "sync.indicator.syncing": "同步中…",
    "sync.indicator.ok": "已同步 {when}",
    "sync.indicator.failed": "同步失败（重试 #{n}）",
    "sync.indicator.auto_off": "自动同步已关闭",
    "sync.indicator.no_profile": "未配置同步",
    "sync.indicator.just_now": "刚刚",
    "sync.indicator.seconds_ago": "{n} 秒前",
    "sync.indicator.minutes_ago": "{n} 分钟前",
    "sync.indicator.hours_ago": "{n} 小时前",
    "sync.conflict_modal.title": "发现同步冲突",
    "sync.conflict_modal.body": "有 {n} 条记录与其他设备的修改产生冲突，请前往同步设置选择保留哪一份。",
    "sync.conflict_modal.later": "稍后处理",
    "sync.conflict_modal.go": "前往同步设置",
    "settings.sync.method": "同步方式",
    "settings.sync.button.save": "保存配置",
    "settings.sync.button.browse": "浏览",
    "settings.sync.button.now": "立即同步",
    "settings.sync.button.create_repo": "创建仓库",
    "settings.sync.button.join_repo": "加入仓库",
    "settings.sync.button.forget_engine": "断开会话",
    "settings.sync.button.clear_all": "清空配置",
    "settings.sync.button.delete_remote": "清空远端内容",
    "settings.sync.button.busy.save": "保存中...",
    "settings.sync.button.busy.create_repo": "创建中...",
    "settings.sync.button.busy.join_repo": "加入中...",
    "settings.sync.button.busy.now": "同步中...",
    "settings.sync.button.busy.refresh_stats": "刷新中...",
    "settings.sync.button.busy.compact_now": "压缩中...",
    "settings.sync.button.busy.forget_engine": "断开中...",
    "settings.sync.button.busy.clear_all": "清空中...",
    "settings.sync.button.busy.delete_remote": "删除中...",
    "settings.sync.button.busy.resolve_conflict": "处理中...",
    "settings.data.title": "数据管理",
    "settings.data.desc": "选择要清空的本地数据项。此操作不可撤销。",
    "settings.data.button.clear": "清空数据",
    "settings.data.dialog.title": "清空数据",
    "settings.data.dialog.message": "选择要清空的数据项。此操作不可撤销。",
    "settings.data.dialog.warning": "只会清空你勾选的项目。",
    "settings.data.dialog.confirm": "清空所选",
    "settings.data.dialog.none": "请至少选择一个要清空的数据项。",
    "settings.data.item.local_settings": "本地应用设置",
    "settings.data.item.local_settings.desc": "界面外观、终端设置、代理、背景图、窗口布局、SFTP 偏好、自动同步选项和本地 UI 状态。",
    "settings.data.item.vault_data": "Vault 数据",
    "settings.data.item.vault_data.desc": "加密 Vault 内的全部记录，包括主机、分组、片段、端口转发和 Vault 内元数据。",
    "settings.data.item.sync_profiles": "同步配置",
    "settings.data.item.sync_profiles.desc": "本地同步配置和缓存的同步会话/钥匙串状态；不会删除远端仓库内容。",
    "settings.data.item.ai_profiles": "AI 配置",
    "settings.data.item.ai_profiles.desc": "保存的 AI 服务配置及其系统钥匙串中的 API Key。",
    "settings.data.item.ai_sessions": "AI 会话历史",
    "settings.data.item.ai_sessions.desc": "保存在本机的 AI 聊天会话。",
    "settings.data.item.remembered_password": "记住的解锁密码",
    "settings.data.item.remembered_password.desc": "系统钥匙串中缓存的 Vault 解锁密码。",
    "settings.data.status.cleared_selected": "已清空：{items}",
    "settings.update.status.installing": "正在安装更新...",
    "settings.sync.backend.local_folder": "本地文件夹",
    "settings.sync.label.path": "同步文件夹",
    "settings.sync.placeholder.enc_password": "同步密码",
    "settings.sync.hint.keychain_keep": "已保存在系统钥匙串；留空表示不修改。",
    "settings.sync.tip.local": "本地文件夹模式需配合 iCloud/Dropbox/Syncthing 等目录同步工具实现多端同步。",
    "settings.sync.enc.title": "同步密码",
    "theme.menu.edit": "编辑主题",
    "theme.menu.duplicate": "复制为自定义",
    "theme.menu.delete": "删除主题",
    "theme.create.title": "新建主题",
    "theme.edit.title": "编辑主题",
    "theme.edit.name": "主题名称",
    "theme.edit.background": "背景",
    "theme.edit.foreground": "前景",
    "theme.edit.cursor": "光标",
    "theme.edit.selection": "选区",
    "theme.edit.reset": "重置",
    "theme.edit.cancel": "取消",
    "theme.edit.save": "保存",
    "theme.prompt.duplicate.title": "复制为自定义",
    "theme.prompt.duplicate.message": "请输入新主题名称",
    "theme.confirm.delete.title": "删除主题？",
    "theme.confirm.delete": "删除主题 \"{name}\"？此操作无法撤销。",
    "theme.error.delete_current": "正在使用的主题不能删除",
    "theme.error.name_required": "请输入主题名称",
    "theme.mode.button": "主题模式",
    "theme.mode.system": "跟随系统",
    "theme.mode.dark": "深色",
    "theme.mode.light": "浅色",
    "settings.nav.sftp": "SFTP",
    "settings.nav.hotkeys": "快捷键",
    "settings.terminal.desc": "配置终端主题与视觉表现。",
    "settings.ai.title": "AI 助手",
    "settings.ai.desc": "配置模型服务，以及 AI 可以执行哪些操作。",
    "settings.ai.provider.title": "AI 服务",
    "settings.ai.provider.desc": "配置终端助手使用的模型服务。可保存多个配置并随时切换；密钥保存到系统钥匙串。",
    "settings.ai.provider.label": "服务商",
    "settings.ai.provider.openai_compatible": "OpenAI 兼容接口",
    "settings.ai.provider.openai": "OpenAI",
    "settings.ai.provider.anthropic": "Anthropic",
    "settings.ai.provider.gemini": "Gemini",
    "settings.ai.provider.ollama": "Ollama",
    "settings.ai.model.label": "模型",
    "settings.ai.model.custom_label": "自定义模型",
    "settings.ai.model.placeholder": "例如：gpt-4.1 或 qwen2.5-coder",
    "settings.ai.model.refresh": "刷新",
    "settings.ai.base_url.label": "接口地址",
    "settings.ai.base_url.placeholder": "例如：https://api.example.com/v1",
    "settings.ai.api_key.label": "API Key",
    "settings.ai.api_key.placeholder": "留空则沿用已保存的密钥",
    "settings.ai.status.unsaved": "AI 配置尚未保存。",
    "settings.ai.status.saved": "AI 配置已保存到本地。",
    "settings.ai.status.ready": "AI 配置已就绪。",
    "settings.ai.status.no_key": "AI 配置已加载，请先填写 API Key 再开始聊天。",
    "settings.ai.button.save": "保存配置",
    "settings.ai.button.busy.refresh": "刷新中…",
    "settings.ai.status.models_fetched": "已获取 {count} 个模型。",
    "settings.ai.toast.models_refreshed": "模型列表已刷新。",
    "settings.ai.name.label": "名称",
    "settings.ai.name.placeholder": "例如：OpenAI 工作号 / 本地 Ollama",
    "settings.ai.add": "新建配置",
    "settings.ai.cancel": "取消",
    "settings.ai.empty": "还没有任何 AI 配置，点击「新建配置」添加一个。",
    "settings.ai.profile.active": "当前",
    "settings.ai.profile.no_key": "未设密钥",
    "settings.ai.profile.set_active": "切换",
    "settings.ai.profile.edit": "编辑",
    "settings.ai.profile.delete": "删除",
    "settings.ai.profile.confirm_delete": "删除配置「{name}」？其保存的密钥也会被一并清除。",
    "settings.ai.profile.new": "新建配置",
    "settings.ai.profile.edit_title": "编辑配置",
    "settings.ai.reasoning_effort.label": "推理强度",
    "settings.ai.reasoning_effort.default": "默认（不指定）",
    "settings.ai.reasoning_effort.low": "低",
    "settings.ai.reasoning_effort.medium": "中",
    "settings.ai.reasoning_effort.high": "高",
    "settings.language.label": "语言",
    "settings.language.hint": "修改立即生效，并会保存在本地。",
    "settings.version.label": "版本",
    "settings.about.title": "关于",
    "settings.about.author": "作者",
    "settings.about.repo": "GitHub 仓库",
    "settings.about.tagline": "下一代极速、现代的跨平台 SSH 终端工具",
    "settings.update.install": "更新",
    "settings.update.title": "系统升级",
    "settings.update.checking": "正在检查更新或已经是最新版本...",
    "settings.update.signature_invalid": "暂时无法更新：发布服务器还没准备好签名，请稍后再试。",
    "settings.update.latest": "当前已是最新版本（{version}）",
    "settings.update.available": "发现新版本：{current} -> {latest}",
    "settings.update.failed": "更新失败：{error}",
    "settings.update.dialog.title": "更新内容",
    "settings.update.dialog.version": "新版本：{version}",
    "settings.update.dialog.cancel": "取消",
    "settings.update.dialog.confirm": "更新",
    "settings.update.dialog.no_notes": "本次更新暂无更新说明。",
    "settings.terminal_theme.title": "主题",
    "settings.terminal_theme.subtitle": "实时预览并调整终端配色",
    "settings.terminal_theme.light_title": "亮色终端主题",
    "settings.terminal_theme.dark_title": "暗色终端主题",
    "settings.terminal_theme.add": "+ 新建主题",
    "settings.terminal_theme.label": "主题",
    "terminal.theme.name.tokyo_day": "雾纸",
    "terminal.theme.name.catppuccin_latte": "云拿铁",
    "terminal.theme.name.sage_light": "鼠尾草原",
    "terminal.theme.name.termark_dark": "午夜石板",
    "terminal.theme.name.kanagawa_wave": "墨庭",
    "terminal.theme.name.catppuccin_mocha": "紫暮",
    "settings.terminal_font.title": "字体配置",
    "settings.terminal_font.hint": "字体、字号和行高在同一行设置，下方实时预览。",
    "settings.terminal_font.family": "字体",
    "settings.terminal_font.size": "字号",
    "settings.terminal_font.line_height": "行高",
    "settings.terminal.subtab.theme": "主题",
    "settings.terminal.subtab.font": "字体",
    "settings.terminal.title": "终端",
    "settings.terminal.desc": "配置本地终端标签页使用的 Shell。",
    "settings.terminal.shell.label": "本地终端 Shell",
    "settings.terminal.shell.hint": "打开「本地」终端标签页时启动的 shell 可执行文件路径。留空则使用系统默认。",
    "settings.terminal.shell.browse": "浏览",
    "settings.terminal.shell.reset": "恢复默认",
    "settings.terminal.shell.system_default": "系统默认",
    "settings.terminal.shell.current": "留空时使用：{shell}",
    "settings.terminal.cwd.label": "工作目录",
    "settings.terminal.cwd.hint": "配置后，每次打开「本地」终端标签页都会自动切换到该目录。留空则使用默认目录。",
    "settings.terminal.cwd.placeholder": "例如：D:\\projects",
    "settings.terminal.cwd.browse": "浏览",
    "settings.terminal.selection_menu_order.label": "右键菜单排序",
    "settings.terminal.selection_menu_order.hint": "拖动调整选中终端文本后右键菜单里的功能展示顺序。",
    "settings.terminal.selection_menu_order.reset": "恢复默认",
    "settings.terminal.attention_flash.label": "后台等待时闪烁任务栏图标",
    "settings.terminal.attention_flash.hint": "后台标签页里的 CLI 等待确认时，闪烁任务栏图标提醒你（macOS 为跳动 Dock 图标）；回到窗口后自动停止。",
    "settings.sftp.title": "SFTP",
    "settings.sftp.follow.label": "目录跟随",
    "settings.sftp.follow.hint": "远端目录跟随现在依赖 shell 发出的 OSC 7 提示；如果 shell 不发送 OSC 7，SFTP 面板会保持在你当前停留的位置。",
    "settings.sftp.local_dir.label": "本地默认打开目录",
    "settings.sftp.local_dir.hint": "可选。打开 SFTP 工作区时，本地文件面板默认进入该目录；留空则使用用户主目录。",
    "settings.sftp.local_dir.placeholder": "例如：/Users/username/Downloads",
    "settings.sftp.local_dir.browse": "浏览",
    "settings.button.close": "关闭",
    "settings.language.zh": "简体中文",
    "settings.language.en": "English",
    "input.title": "输入",
    "input.button.cancel": "取消",
    "input.button.confirm": "确定",
    "input.placeholder": "请输入内容...",
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
  const svg = el.querySelector("svg");
  if (svg) {
    let span = el.querySelector("span.zt-btn-text");
    if (!span) {
      span = document.createElement("span");
      span.className = "zt-btn-text";
      Array.from(el.childNodes).forEach(node => {
        if (node !== svg) {
          span.appendChild(node);
        }
      });
      el.appendChild(span);
    }
    span.textContent = t(key, vars);
  } else {
    el.textContent = t(key, vars);
  }
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

function detectHostOsBadge(host) {
  const rawOsType = String(host?.osType || "").trim().toLowerCase();
  const fromSaved = (() => {
    switch (rawOsType) {
      case "windows":
        return { label: "Windows", iconClass: "devicon-windows11-original" };
      case "ubuntu":
        return { label: "Ubuntu", iconClass: "devicon-ubuntu-plain" };
      case "debian":
        return { label: "Debian", iconClass: "devicon-debian-plain" };
      case "centos":
        return { label: "CentOS", iconClass: "devicon-centos-plain" };
      case "redhat":
        return { label: "Red Hat", iconClass: "devicon-redhat-plain" };
      case "fedora":
        return { label: "Fedora", iconClass: "devicon-fedora-plain" };
      case "archlinux":
        return { label: "Arch Linux", iconClass: "devicon-archlinux-plain" };
      case "rockylinux":
        return { label: "Rocky Linux", iconClass: "devicon-rockylinux-plain" };
      case "almalinux":
        return { label: "AlmaLinux", iconClass: "devicon-almalinux-plain" };
      case "opensuse":
        return { label: "openSUSE", iconClass: "devicon-opensuse-plain" };
      case "kalilinux":
        return { label: "Kali Linux", iconClass: "devicon-kalilinux-plain" };
      case "linuxmint":
        return { label: "Linux Mint", iconClass: "devicon-linuxmint-plain" };
      case "macos":
        return { label: "macOS", iconClass: "devicon-apple-original" };
      case "linux":
        return { label: "Linux", iconClass: "devicon-linux-plain" };
      default:
        return null;
    }
  })();
  if (fromSaved) return fromSaved;

  const source = `${host?.name || ""} ${host?.host || ""}`.toLowerCase();
  const has = (re) => re.test(source);

  if (has(/\b(windows|win10|win11|win\d)\b/)) {
    return { label: "Windows", iconClass: "devicon-windows11-original" };
  }
  if (has(/\b(ubuntu)\b/)) {
    return { label: "Ubuntu", iconClass: "devicon-ubuntu-plain" };
  }
  if (has(/\b(debian)\b/)) {
    return { label: "Debian", iconClass: "devicon-debian-plain" };
  }
  if (has(/\b(centos)\b/)) {
    return { label: "CentOS", iconClass: "devicon-centos-plain" };
  }
  if (has(/\b(redhat|rhel)\b/)) {
    return { label: "Red Hat", iconClass: "devicon-redhat-plain" };
  }
  if (has(/\b(fedora)\b/)) {
    return { label: "Fedora", iconClass: "devicon-fedora-plain" };
  }
  if (has(/\b(arch|archlinux)\b/)) {
    return { label: "Arch Linux", iconClass: "devicon-archlinux-plain" };
  }
  if (has(/\b(rocky|rockylinux)\b/)) {
    return { label: "Rocky Linux", iconClass: "devicon-rockylinux-plain" };
  }
  if (has(/\b(alma|almalinux)\b/)) {
    return { label: "AlmaLinux", iconClass: "devicon-almalinux-plain" };
  }
  if (has(/\b(opensuse|suse)\b/)) {
    return { label: "openSUSE", iconClass: "devicon-opensuse-plain" };
  }
  if (has(/\b(kali)\b/)) {
    return { label: "Kali Linux", iconClass: "devicon-kalilinux-plain" };
  }
  if (has(/\b(mint|linuxmint)\b/)) {
    return { label: "Linux Mint", iconClass: "devicon-linuxmint-plain" };
  }
  if (has(/\b(mac|macos|osx|darwin)\b/)) {
    return { label: "macOS", iconClass: "devicon-apple-original" };
  }
  return { label: "Linux", iconClass: "devicon-linux-plain" };
}

function setLocale(locale) {
  if (!I18N[locale]) return;
  currentLocale = locale;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  applyI18n();
}

const FILE_EDITOR_MAX_BYTES = 5 * 1024 * 1024;
const LOG_FILE_EDITOR_MAX_BYTES = 50 * 1024 * 1024;

const EDITABLE_TEXT_EXTS = new Set([
  "txt", "log", "md", "markdown", "json", "jsonc", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "cnf", "env", "sh", "bash", "zsh", "fish", "ps1",
  "sql", "xml", "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx",
  "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "h",
  "cpp", "hpp", "cc", "cs", "vue", "svelte", "properties", "service",
  "bat", "cmd",
]);

const EDITABLE_TEXT_BASENAMES = new Set([
  "dockerfile", "makefile", "readme", "readme.md", ".env", ".gitignore",
  ".gitattributes", ".bashrc", ".zshrc", ".profile", "nginx.conf",
  "sshd_config", "authorized_keys", "known_hosts", "config",
]);

const ACE_BASE_PATH = "./assets/ace";
const TERMINAL_FONT_STACK = [
  '"ZeroTerm Meslo NF"',
  "monospace",
].join(", ");
const TERMINAL_FONT_CANDIDATES = [
  { label: "ZeroTerm Meslo NF", family: "ZeroTerm Meslo NF", value: '"ZeroTerm Meslo NF", monospace' },
  { label: "SF Mono", family: "SF Mono", value: '"SF Mono", monospace' },
  { label: "Menlo", family: "Menlo", value: 'Menlo, monospace' },
  { label: "Monaco", family: "Monaco", value: 'Monaco, monospace' },
  { label: "JetBrains Mono", family: "JetBrains Mono", value: '"JetBrains Mono", monospace' },
  { label: "Cascadia Mono", family: "Cascadia Mono", value: '"Cascadia Mono", monospace' },
  { label: "Consolas", family: "Consolas", value: 'Consolas, monospace' },
  { label: "Courier New", family: "Courier New", value: '"Courier New", monospace' },
  { label: "Ubuntu Mono", family: "Ubuntu Mono", value: '"Ubuntu Mono", monospace' },
  { label: "DejaVu Sans Mono", family: "DejaVu Sans Mono", value: '"DejaVu Sans Mono", monospace' },
  { label: "Liberation Mono", family: "Liberation Mono", value: '"Liberation Mono", monospace' },
  { label: "Noto Sans Mono", family: "Noto Sans Mono", value: '"Noto Sans Mono", monospace' },
];
let systemTerminalFontFamilies = null;
const TERMINAL_RESIZE_DEBOUNCE_MS = 56;

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

function fileEditorMaxBytesForName(name) {
  const lower = String(name || "").toLowerCase();
  return lower.endsWith(".log") ? LOG_FILE_EDITOR_MAX_BYTES : FILE_EDITOR_MAX_BYTES;
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
    unlockPath.title = status.path || "";

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
const hostsEmptyTitle = document.getElementById("hosts-empty-title");
const hostsEmptyDesc = document.getElementById("hosts-empty-desc");
const hostsEmptyAdd = document.getElementById("hosts-empty-add");
const hostSearch = document.getElementById("host-search");
const hostsContextMenu = document.getElementById("hosts-context-menu");
const hostsMenuConnect = document.getElementById("hosts-menu-connect");
const hostsMenuEdit = document.getElementById("hosts-menu-edit");
const hostsMenuCopy = document.getElementById("hosts-menu-copy");
const hostsMenuDelete = document.getElementById("hosts-menu-delete");
const groupsContextMenu = document.getElementById("groups-context-menu");
const groupsMenuAddHost = document.getElementById("groups-menu-add-host");
const groupsMenuAddSub = document.getElementById("groups-menu-add-sub");
const groupsMenuExpand = document.getElementById("groups-menu-expand");
const groupsMenuExpandAll = document.getElementById("groups-menu-expand-all");
const groupsMenuCollapse = document.getElementById("groups-menu-collapse");
const groupsMenuCollapseAll = document.getElementById("groups-menu-collapse-all");
const groupsMenuEdit = document.getElementById("groups-menu-edit");
const groupsMenuDelete = document.getElementById("groups-menu-delete");
const workspaceTabVaults = document.getElementById("workspace-tab-vaults");
const workspaceTabSftp = document.getElementById("workspace-tab-sftp");
const workspaceNavVaults = document.getElementById("workspace-nav-vaults");
const workspaceNavSftp = document.getElementById("workspace-nav-sftp");
const workspaceSidebarToggle = document.getElementById("workspace-sidebar-toggle");
const workspaceSidebarToggleRight = document.getElementById("workspace-sidebar-toggle-right");
const appShell = document.querySelector("#view-hosts .app-shell");
const panelVaults = document.getElementById("panel-vaults");
const panelTerminal = document.getElementById("panel-terminal");
const panelSftp = document.getElementById("panel-sftp");
const sftpTransferDock = document.getElementById("sftp-transfer-dock");
const sftpTransferList = document.getElementById("sftp-transfer-list");
const sftpTransferTitleEl = document.getElementById("sftp-transfer-title");
const sftpTransferSummaryEl = document.getElementById("sftp-transfer-summary");
const sftpTransferClearBtn = document.getElementById("sftp-transfer-clear");
const sftpTransferCollapseBtn = document.getElementById("sftp-transfer-collapse");
const settingsPage = document.getElementById("settings-page");
const vaultWelcome = document.getElementById("vault-welcome");
const terminalSessionLayout = document.getElementById("terminal-session-layout");
const terminalSidebarRail = document.getElementById("terminal-sidebar-rail");
const terminalSidebarSnippetsToggle = document.getElementById("terminal-sidebar-snippets-toggle");
const terminalSidebarAiToggle = document.getElementById("terminal-sidebar-ai-toggle");
const terminalSidePanels = document.getElementById("terminal-side-panels");
const terminalSnippetsPanel = document.getElementById("terminal-snippets-panel");
const terminalAiPanel = document.getElementById("terminal-ai-panel");
const terminalMetricsPanel = document.getElementById("terminal-metrics-panel");
const terminalSidebarMetricsToggle = document.getElementById("terminal-sidebar-metrics-toggle");
const terminalMetricsBody = document.getElementById("terminal-metrics-body");
const terminalMetricsRefresh = document.getElementById("terminal-metrics-refresh");
const terminalSftpPanel = document.getElementById("terminal-sftp-panel");
const terminalSidebarSftpToggle = document.getElementById("terminal-sidebar-sftp-toggle");
const terminalThemePanel = document.getElementById("terminal-theme-panel");
const terminalSidebarThemeToggle = document.getElementById("terminal-sidebar-theme-toggle");
const terminalDockerPanel = document.getElementById("terminal-docker-panel");
const terminalSidebarDockerToggle = document.getElementById("terminal-sidebar-docker-toggle");
const terminalDockerBody = document.getElementById("terminal-docker-body");
const terminalDockerRefresh = document.getElementById("terminal-docker-refresh");
const terminalSftpRefresh = document.getElementById("terminal-sftp-refresh");
const terminalSftpTitle = document.getElementById("terminal-sftp-title");
const terminalSftpSubtitle = document.getElementById("terminal-sftp-subtitle");
const terminalSnippetsAdd = document.getElementById("terminal-snippets-add");
const terminalSnippetsSearch = document.getElementById("terminal-snippets-search");
const terminalSnippetsEmpty = document.getElementById("terminal-snippets-empty");
const terminalSnippetsList = document.getElementById("terminal-snippets-list");
const aiPanelSplitter = document.getElementById("terminal-side-panel-splitter");
const snippetEditOverlay = document.getElementById("snippet-edit-overlay");
const snippetEditTitle = document.getElementById("snippet-edit-title");
const snippetEditForm = document.getElementById("snippet-edit-form");
const snippetEditCancel = document.getElementById("snippet-edit-cancel");
const snippetEditName = document.getElementById("snippet-edit-name");
const snippetEditGroup = document.getElementById("snippet-edit-group");
const snippetEditCommand = document.getElementById("snippet-edit-command");
const snippetItemContextMenu = document.getElementById("snippet-item-context-menu");
const snippetItemMenuEdit = document.getElementById("snippet-item-menu-edit");
const snippetItemMenuDelete = document.getElementById("snippet-item-menu-delete");
const terminalSelectionMenu = document.getElementById("terminal-selection-menu");
const terminalSelectionMenuUrl = document.getElementById("terminal-selection-menu-url");
const terminalSelectionMenuSearch = document.getElementById("terminal-selection-menu-search");
const terminalSelectionMenuCopy = document.getElementById("terminal-selection-menu-copy");
const terminalSelectionMenuExecute = document.getElementById("terminal-selection-menu-execute");
const terminalSelectionMenuSftp = document.getElementById("terminal-selection-menu-sftp");
const terminalSelectionMenuAi = document.getElementById("terminal-selection-menu-ai");
const aiComposeForm = document.getElementById("ai-compose-form");
const aiComposeInput = document.getElementById("ai-compose-input");
const aiChatLog = document.getElementById("ai-chat-log");
const aiEmptyState = document.getElementById("ai-empty-state");
const aiAssistantSubtitle = document.getElementById("ai-assistant-subtitle");
const aiSessionModeBadge = document.getElementById("ai-session-mode-badge");
const aiTempChatButton = document.getElementById("ai-temp-chat");
const aiNewChatButton = document.getElementById("ai-new-chat");
const aiSessionToggle = document.getElementById("ai-session-toggle");
const aiSessionOverlay = document.getElementById("ai-session-overlay");
const aiSessionClose = document.getElementById("ai-session-close");
const aiSessionList = document.getElementById("ai-session-list");
const aiSessionEmpty = document.getElementById("ai-session-empty");
const aiSessionClear = document.getElementById("ai-session-clear");
const aiSessionScopeLabel = document.getElementById("ai-session-scope-label");
const aiSessionCurrentFilter = document.getElementById("ai-session-current-filter");
const aiSessionAllFilter = document.getElementById("ai-session-all-filter");
const aiContextToggle = document.getElementById("ai-context-toggle");
const aiAssistantBody = document.querySelector(".ai-assistant-body");
const aiModelPill = document.getElementById("ai-model-pill");
const aiModelMenu = document.getElementById("ai-model-menu");
const vaultsContent = document.getElementById("vaults-content");
const vaultLayout = document.querySelector(".vault-layout");
const vaultSplitter = document.getElementById("vault-splitter");
const sftpLeftContent = document.getElementById("sftp-left-content");
const sftpRightContent = document.getElementById("sftp-right-content");
const newWindowButton = document.getElementById("new-window-button");
const settingsButton = document.getElementById("settings-button");
const quickConnectButton = document.getElementById("quick-connect-button");
const localTerminalButton = document.getElementById("local-terminal-button");
const portForwardButton = document.getElementById("port-forward-button");
const portForwardPage = document.getElementById("port-forward-page");
const portForwardList = document.getElementById("port-forward-list");
const portForwardEmpty = document.getElementById("port-forward-empty");
const portForwardSearch = document.getElementById("port-forward-search");
const portForwardRefresh = document.getElementById("port-forward-refresh");
const portForwardCreate = document.getElementById("port-forward-create");
const portForwardEditor = document.getElementById("port-forward-editor");
const portForwardEditorOverlay = document.getElementById("port-forward-editor-overlay");
const portForwardEditorTitle = document.getElementById("port-forward-editor-title");
const portForwardEditorHostWrap = document.getElementById("port-forward-editor-host-wrap");
const portForwardEditorHost = document.getElementById("port-forward-editor-host");
const portForwardEditorClose = document.getElementById("port-forward-editor-close");
const portForwardEditorAdd = document.getElementById("port-forward-editor-add");
const portForwardEditorList = document.getElementById("port-forward-editor-list");
const portForwardEditorKind = document.getElementById("port-forward-editor-kind");
const portForwardEditorKindTabs = document.getElementById("port-forward-editor-kind-tabs");
const portForwardEditorBind = document.getElementById("port-forward-editor-bind");
const portForwardEditorBindPort = document.getElementById("port-forward-editor-bind-port");
const portForwardEditorArrow = document.getElementById("port-forward-editor-arrow");
const portForwardEditorTargetHostWrap = document.getElementById("port-forward-editor-target-host-wrap");
const portForwardEditorTargetPortWrap = document.getElementById("port-forward-editor-target-port-wrap");
const portForwardEditorTargetHost = document.getElementById("port-forward-editor-target-host");
const portForwardEditorTargetPort = document.getElementById("port-forward-editor-target-port");
const portForwardEditorHint = document.getElementById("port-forward-editor-hint");
const portForwardEditorError = document.getElementById("port-forward-editor-error");
const portForwardEditorCancel = document.getElementById("port-forward-editor-cancel");
const portForwardEditorSave = document.getElementById("port-forward-editor-save");
const vaultBottomSettingsButton = document.getElementById("vault-bottom-settings");
const vaultBottomSettingsRow = document.getElementById("vault-bottom-settings-row");
const themeModeButton = document.getElementById("theme-mode-button");
const themeModeMenu = document.getElementById("theme-mode-menu");
const themeModeSystem = document.getElementById("theme-mode-system");
const themeModeDark = document.getElementById("theme-mode-dark");
const themeModeLight = document.getElementById("theme-mode-light");
const settingsBackButton = document.getElementById("settings-back");
const settingsNavGeneral = document.getElementById("settings-nav-general");
const settingsNavTerminal = document.getElementById("settings-nav-terminal");
const settingsNavAi = document.getElementById("settings-nav-ai");
const settingsNavSync = document.getElementById("settings-nav-sync");
const settingsGeneralPanel = document.getElementById("settings-general-panel");
const settingsTerminalPanel = document.getElementById("settings-terminal-panel");
const settingsAiPanel = document.getElementById("settings-ai-panel");
const settingsSyncPanel = document.getElementById("settings-sync-panel");
const settingsPageBody = document.querySelector(".settings-page-body");
const settingsAiProvider = document.getElementById("settings-ai-provider");
const settingsAiModel = document.getElementById("settings-ai-model");
const settingsAiModelCustom = document.getElementById("settings-ai-model-custom");
const settingsAiRefreshModels = document.getElementById("settings-ai-refresh-models");
const settingsAiBaseUrl = document.getElementById("settings-ai-base-url");
const settingsAiApiKey = document.getElementById("settings-ai-api-key");
const settingsAiSave = document.getElementById("settings-ai-save");
const settingsAiStatus = document.getElementById("settings-ai-status");
const settingsAiAdd = document.getElementById("settings-ai-add");
const settingsAiProfiles = document.getElementById("settings-ai-profiles");
const settingsAiEmpty = document.getElementById("settings-ai-empty");
const settingsAiSystemPrompt = document.getElementById("settings-ai-system-prompt");
const aiConfigOverlay = document.getElementById("ai-config-overlay");
const aiConfigTitle = document.getElementById("ai-config-title");
const settingsAiName = document.getElementById("settings-ai-name");
const settingsAiReasoningEffort = document.getElementById("settings-ai-reasoning-effort");
const settingsAiCancel = document.getElementById("settings-ai-cancel");
const settingsSyncRefresh = document.getElementById("settings-sync-refresh");
const settingsSyncSave = document.getElementById("settings-sync-save");
const settingsSyncStatus = document.getElementById("settings-sync-status");
const settingsSyncStatusLine = document.getElementById("settings-sync-status-line");
const settingsSyncTip = document.getElementById("settings-sync-tip");
const settingsSyncNow = document.getElementById("settings-sync-now");
const settingsSyncCreateRepo = document.getElementById("settings-sync-create-repo");
const settingsSyncJoinRepo = document.getElementById("settings-sync-join-repo");
const settingsSyncForgetEngine = document.getElementById("settings-sync-forget-engine");
const settingsSyncClearAll = document.getElementById("settings-sync-clear-all");
const settingsSyncDeleteRemote = document.getElementById("settings-sync-delete-remote");
const settingsSyncBackend = document.getElementById("settings-sync-backend");
const settingsSyncRoot = document.getElementById("settings-sync-root");
const settingsSyncRootRow = document.getElementById("settings-sync-root-row");
const settingsSyncRootBrowse = document.getElementById("settings-sync-root-browse");
const settingsSyncEncPassword = document.getElementById("settings-sync-enc-password");
const settingsSyncEncPasswordToggle = document.getElementById("settings-sync-enc-password-toggle");
const settingsSyncRememberPassphrase = document.getElementById("settings-sync-remember-passphrase");
const settingsSyncDevicesList = document.getElementById("settings-sync-devices-list");
const settingsSyncDevicesEmpty = document.getElementById("settings-sync-devices-empty");
const settingsSyncConflictsList = document.getElementById("settings-sync-conflicts-list");
const settingsSyncConflictsEmpty = document.getElementById("settings-sync-conflicts-empty");
const settingsSyncRepoStatsList = document.getElementById("settings-sync-repo-stats-list");
const settingsSyncRepoStatsEmpty = document.getElementById("settings-sync-repo-stats-empty");
const settingsSyncRefreshStats = document.getElementById("settings-sync-refresh-stats");
const settingsSyncCompactNow = document.getElementById("settings-sync-compact-now");
const settingsSyncCompactStatus = document.getElementById("settings-sync-compact-status");

if (hostsContextMenu && hostsContextMenu.parentElement !== document.body) {
  document.body.appendChild(hostsContextMenu);
}
if (groupsContextMenu && groupsContextMenu.parentElement !== document.body) {
  document.body.appendChild(groupsContextMenu);
}

let toastHost = null;
function ensureToastHost() {
  if (toastHost) return toastHost;
  toastHost = document.createElement("div");
  toastHost.className = "zt-toast-host";
  document.body.appendChild(toastHost);
  return toastHost;
}

function showToast(message, kind = "info", timeoutMs = 2600) {
  const host = ensureToastHost();
  const node = document.createElement("div");
  node.className = `zt-toast zt-toast-${kind}`;
  node.textContent = String(message || "");
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  window.setTimeout(() => {
    node.classList.remove("show");
    window.setTimeout(() => node.remove(), 180);
  }, timeoutMs);
}

let sftpTransferHideTimer = null;
let sftpTransferDockCollapsed = false;
const sftpTransferItems = new Map();
const sftpTransferDismissTimers = new Map();
const sftpPendingRetryPlans = new Map();

function formatTransferEta(seconds) {
  const secs = Math.max(0, Math.round(Number(seconds) || 0));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

function finiteTransferNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSftpTransferKind(kind) {
  const raw = String(kind || "download");
  return raw === "upload" || raw === "download" || raw === "copy" || raw === "delete"
    ? raw
    : "download";
}

function sftpTransferPercent(item) {
  if (!Number.isFinite(item.total) || item.total <= 0) return null;
  return Math.max(0, Math.min(100, (item.bytesDone / item.total) * 100));
}

// Stable row title: the target name never changes mid-transfer, unlike the
// current file which is relegated to the meta line for directory copies.
function sftpTransferTitle(item) {
  return (
    basename(item.destination || "") || basename(item.source || "") || `#${item.transferId}`
  );
}

function sftpTransferStatsText(item) {
  if (item.status !== "running") return labelSftpTransferStatus(item.status);
  const bits = [];
  const percent = sftpTransferPercent(item);
  if (percent !== null) bits.push(`${Math.floor(percent)}%`);
  if (Number.isFinite(item.bytesPerSec) && item.bytesPerSec > 0) {
    bits.push(`${formatSize(item.bytesPerSec)}/s`);
  }
  if (Number.isFinite(item.etaSeconds) && item.etaSeconds >= 0) {
    bits.push(t("files.progress.eta", { eta: formatTransferEta(item.etaSeconds) }));
  }
  return bits.join(" · ") || labelSftpTransferStatus("running");
}

function sftpTransferMetaText(item) {
  if (item.status === "error" && item.error?.message) return item.error.message;
  const bits = [];
  if (Number.isFinite(item.total) && item.total > 0) {
    bits.push(`${formatSize(item.bytesDone)} / ${formatSize(item.total)}`);
  } else if (item.bytesDone > 0) {
    bits.push(formatSize(item.bytesDone));
  }
  if (Number.isFinite(item.filesTotal) && item.filesTotal > 0) {
    bits.push(
      t(item.kind === "delete" ? "files.transfer.items_progress" : "files.transfer.files_progress", {
        done: Number.isFinite(item.filesDone) ? item.filesDone : 0,
        total: item.filesTotal,
      }),
    );
  }
  if (item.status === "running" && item.currentFile) {
    bits.push(basename(item.currentFile));
  }
  if (bits.length === 0 && item.status === "running") {
    if (item.kind === "delete") return t("files.progress.deleting");
    return t("files.progress.preparing");
  }
  return bits.join(" · ");
}

function isSftpTransferTerminal(item) {
  return item?.status === "success" || item?.status === "error" || item?.status === "cancelled";
}

function clearSftpTransferDismissTimer(transferId) {
  const timer = sftpTransferDismissTimers.get(transferId);
  if (timer) {
    window.clearTimeout(timer);
    sftpTransferDismissTimers.delete(transferId);
  }
}

function fingerprintSftpTransfer(kind, source, destination) {
  return `${String(kind || "")}\u0000${String(source || "")}\u0000${String(destination || "")}`;
}

function enqueuePendingSftpRetryPlan(plan) {
  const entry = { token: Symbol("sftp-transfer-retry"), plan };
  const key = fingerprintSftpTransfer(plan.matchKind, plan.source, plan.destination);
  const queue = sftpPendingRetryPlans.get(key) || [];
  queue.push(entry);
  sftpPendingRetryPlans.set(key, queue);
  return { key, token: entry.token };
}

function releasePendingSftpRetryPlan(handle) {
  if (!handle?.key || !handle?.token) return;
  const queue = sftpPendingRetryPlans.get(handle.key);
  if (!queue || queue.length === 0) return;
  const next = queue.filter((entry) => entry.token !== handle.token);
  if (next.length > 0) {
    sftpPendingRetryPlans.set(handle.key, next);
  } else {
    sftpPendingRetryPlans.delete(handle.key);
  }
}

function claimPendingSftpRetryPlan(kind, source, destination) {
  const key = fingerprintSftpTransfer(kind, source, destination);
  const queue = sftpPendingRetryPlans.get(key);
  if (!queue || queue.length === 0) return null;
  const entry = queue.shift();
  if (queue.length > 0) {
    sftpPendingRetryPlans.set(key, queue);
  } else {
    sftpPendingRetryPlans.delete(key);
  }
  return entry?.plan?.retry || null;
}

async function invokeSftpTransferWithRetry(plan, run) {
  const handle = enqueuePendingSftpRetryPlan(plan);
  try {
    return await run();
  } finally {
    releasePendingSftpRetryPlan(handle);
  }
}

function scheduleSftpTransferDismiss(item) {
  if (!item || !isSftpTransferTerminal(item) || item.status === "error") {
    clearSftpTransferDismissTimer(item?.transferId);
    return;
  }
  clearSftpTransferDismissTimer(item.transferId);
  const delay = item.status === "success" ? 1600 : 6000;
  const stamp = item.updatedAt;
  const timer = window.setTimeout(() => {
    const current = sftpTransferItems.get(item.transferId);
    if (!current || current.updatedAt !== stamp || current.status !== item.status) return;
    sftpTransferItems.delete(item.transferId);
    sftpTransferDismissTimers.delete(item.transferId);
    renderSftpTransferDock();
  }, delay);
  sftpTransferDismissTimers.set(item.transferId, timer);
}

function hideSftpTransferDockSoon(delay = 350) {
  if (sftpTransferHideTimer) {
    window.clearTimeout(sftpTransferHideTimer);
    sftpTransferHideTimer = null;
  }
  sftpTransferHideTimer = window.setTimeout(() => {
    if (!sftpTransferDock || sftpTransferItems.size > 0) return;
    sftpTransferDock.classList.remove("show");
    sftpTransferDock.hidden = true;
  }, delay);
}

function labelSftpTransferStatus(status) {
  switch (status) {
    case "queued":
      return t("files.transfer.queued");
    case "running":
      return t("files.transfer.running");
    case "finalizing":
      return t("files.transfer.finalizing");
    case "success":
      return t("files.transfer.success");
    case "error":
      return t("files.transfer.error");
    case "cancelled":
      return t("files.transfer.cancelled");
    default:
      return status || t("files.progress.preparing");
  }
}

function canRetrySftpTransfer(item) {
  return item?.status === "error" && Boolean(item.retryPlan);
}

function transferKindForPaneCopy(sourcePane, targetPane) {
  if (isLocalPane(sourcePane) && !isLocalPane(targetPane)) return "upload";
  if (!isLocalPane(sourcePane) && isLocalPane(targetPane)) return "download";
  return "copy";
}

function requireConnectedRetryPane(key) {
  const pane = getSftpPane(key);
  if (!pane || !isPaneConnected(pane)) {
    throw new Error(t("files.transfer.retry_unavailable"));
  }
  return pane;
}

function buildUploadRetryPlan(pane, localPath, remotePath, overwrite = false) {
  return {
    matchKind: "upload",
    source: localPath,
    destination: remotePath,
    retry: {
      action: "uploadLocal",
      paneKey: pane.key,
      localPath,
      remotePath,
      overwrite,
      refreshPaneKeys: [pane.key],
    },
  };
}

function uploadLocalPathToPane(pane, localPath, remotePath, overwrite = false) {
  return invokeSftpTransferWithRetry(
    buildUploadRetryPlan(pane, localPath, remotePath, overwrite),
    () =>
      invoke("sftp_upload", {
        sftpId: pane.sftpId,
        local: localPath,
        remote: remotePath,
        overwrite,
      }),
  );
}

async function refreshRetryPlanPanes(paneKeys = []) {
  const seen = new Set();
  for (const key of paneKeys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const pane = getSftpPane(key);
    if (!pane || !isPaneConnected(pane)) continue;
    try {
      await navigateSftpPane(pane, pane.path, { source: "system" });
    } catch {}
  }
}

async function executeSftpTransferRetryPlan(plan) {
  switch (plan?.action) {
    case "uploadLocal": {
      const pane = requireConnectedRetryPane(plan.paneKey);
      await uploadLocalPathToPane(pane, plan.localPath, plan.remotePath, Boolean(plan.overwrite));
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    case "uploadBrowserFile": {
      const pane = requireConnectedRetryPane(plan.paneKey);
      const staging = await stageBrowserFileForUpload(plan.file);
      try {
        await invokeSftpTransferWithRetry(
          {
            matchKind: "upload",
            source: staging.absolutePath,
            destination: plan.remotePath,
            retry: {
              action: "uploadBrowserFile",
              paneKey: plan.paneKey,
              file: plan.file,
              remotePath: plan.remotePath,
              overwrite: Boolean(plan.overwrite),
              refreshPaneKeys: plan.refreshPaneKeys,
            },
          },
          () =>
            invoke("sftp_upload", {
              sftpId: pane.sftpId,
              local: staging.absolutePath,
              remote: plan.remotePath,
              overwrite: Boolean(plan.overwrite),
            }),
        );
      } finally {
        try {
          await invoke("local_remove", { path: staging.absolutePath });
        } catch {}
      }
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    case "downloadFile": {
      const pane = requireConnectedRetryPane(plan.paneKey);
      await invokeSftpTransferWithRetry(
        {
          matchKind: "download",
          source: plan.remotePath,
          destination: plan.localPath,
          retry: plan,
        },
        () =>
          invoke("sftp_download", {
            sftpId: pane.sftpId,
            remote: plan.remotePath,
            local: plan.localPath,
            overwrite: plan.overwrite,
          }),
      );
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    case "copyToLocalDirectory": {
      const pane = requireConnectedRetryPane(plan.paneKey);
      await invokeSftpTransferWithRetry(
        {
          matchKind: "download",
          source: plan.sourcePath,
          destination: plan.destinationPath,
          retry: plan,
        },
        () =>
          invoke("sftp_copy_entry_between_panes", {
            sourceSftpId: pane.sftpId,
            sourcePath: plan.sourcePath,
            destinationSftpId: null,
            destinationDir: plan.destinationDir,
            overwrite: plan.overwrite,
          }),
      );
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    case "copyBetweenPanes": {
      const sourcePane = getSftpPane(plan.sourcePaneKey);
      const destinationPane = getSftpPane(plan.destinationPaneKey);
      if (!sourcePane || !destinationPane) {
        throw new Error(t("files.transfer.retry_unavailable"));
      }
      const sourceSftpId = paneSftpIdOrNull(sourcePane);
      const destinationSftpId = paneSftpIdOrNull(destinationPane);
      if (!isLocalPane(sourcePane) && sourceSftpId === null) {
        throw new Error(t("files.transfer.retry_unavailable"));
      }
      if (!isLocalPane(destinationPane) && destinationSftpId === null) {
        throw new Error(t("files.transfer.retry_unavailable"));
      }
      const sourceName = basename(plan.sourcePath);
      const destinationPath = isLocalPane(destinationPane)
        ? localJoin(plan.destinationDir, sourceName)
        : joinPath(plan.destinationDir, sourceName);
      await invokeSftpTransferWithRetry(
        {
          matchKind: transferKindForPaneCopy(sourcePane, destinationPane),
          source: plan.sourcePath,
          destination: destinationPath,
          retry: plan,
        },
        () =>
          invoke("sftp_copy_entry_between_panes", {
            sourceSftpId,
            sourcePath: plan.sourcePath,
            destinationSftpId,
            destinationDir: plan.destinationDir,
            overwrite: plan.overwrite,
          }),
      );
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    case "uploadBytes": {
      const pane = requireConnectedRetryPane(plan.paneKey);
      await invokeSftpTransferWithRetry(
        {
          matchKind: "upload",
          source: plan.sourceLabel,
          destination: plan.remotePath,
          retry: plan,
        },
        () =>
          invoke("sftp_upload_bytes", {
            sftpId: pane.sftpId,
            remote: plan.remotePath,
            data: plan.data,
            sourceLabel: plan.sourceLabel,
            overwrite: Boolean(plan.overwrite),
          }),
      );
      await refreshRetryPlanPanes(plan.refreshPaneKeys);
      return;
    }
    default:
      throw new Error(t("files.transfer.retry_unavailable"));
  }
}

async function retrySftpTransfer(item) {
  if (!canRetrySftpTransfer(item)) return;
  clearSftpTransferDismissTimer(item.transferId);
  sftpTransferItems.delete(item.transferId);
  renderSftpTransferDock();
  try {
    await executeSftpTransferRetryPlan(item.retryPlan);
  } catch (e) {
    const err = normalizeSftpError(e);
    const restored = {
      ...item,
      error: err,
      updatedAt: Date.now(),
    };
    sftpTransferItems.set(item.transferId, restored);
    renderSftpTransferDock();
    showToast(t("files.transfer.retry_failed", { error: err.message }), "error", 3600);
  }
}

function sftpTransferOrderWeight(item) {
  switch (item?.status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "error":
      return 2;
    case "cancelled":
      return 3;
    default:
      return 4;
  }
}

function sortSftpTransferItems() {
  return Array.from(sftpTransferItems.values()).sort((a, b) => {
    const weight = sftpTransferOrderWeight(a) - sftpTransferOrderWeight(b);
    if (weight !== 0) return weight;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

const SFTP_TRANSFER_KIND_ICONS = {
  upload:
    '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"></path><path d="m5.5 11.5 6.5-6.5 6.5 6.5"></path></svg>',
  download:
    '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"></path><path d="m5.5 12.5 6.5 6.5 6.5-6.5"></path></svg>',
  copy: '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5h13"></path><path d="m13.5 4.5 4 4-4 4"></path><path d="M20 15.5H7"></path><path d="m10.5 11.5-4 4 4 4"></path></svg>',
  delete:
    '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path></svg>',
};

function buildSftpTransferRow(item) {
  const terminal = isSftpTransferTerminal(item);
  const row = document.createElement("div");
  row.className = `sftp-transfer-row status-${item.status || "running"}`;

  const icon = document.createElement("div");
  icon.className = "sftp-transfer-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = SFTP_TRANSFER_KIND_ICONS[item.kind] || SFTP_TRANSFER_KIND_ICONS.copy;

  const body = document.createElement("div");
  body.className = "sftp-transfer-body";

  const top = document.createElement("div");
  top.className = "sftp-transfer-top";
  const name = document.createElement("span");
  name.className = "sftp-transfer-name";
  name.textContent = sftpTransferTitle(item);
  name.title = `${item.source || ""} → ${item.destination || ""}`;
  top.append(name);
  // Only remote→remote copies carry a route. The relay badge is the one that
  // earns its place: it tells the user why a copy between two fast servers is
  // running at this machine's uplink speed.
  if (item.route === "direct" || item.route === "relay") {
    const route = document.createElement("span");
    route.className = `sftp-transfer-route is-${item.route}`;
    route.textContent = t(`files.transfer.route.${item.route}`);
    // The relay hint carries the concrete DirectUnavailable reason when the
    // backend attempted a direct copy — "which precondition failed" beats
    // the generic explanation.
    route.title = item.route === "relay" && item.routeReason
      ? `${t("files.transfer.route.relay_hint")}\n\n${t("files.transfer.route.relay_reason")}${item.routeReason}`
      : t(`files.transfer.route.${item.route}_hint`);
    top.append(route);
  }
  const stats = document.createElement("span");
  stats.className = "sftp-transfer-stats";
  stats.textContent = sftpTransferStatsText(item);
  top.append(stats);

  const progress = document.createElement("div");
  progress.className = "sftp-transfer-progress";
  const progressBar = document.createElement("div");
  progressBar.className = "sftp-transfer-progress-bar";
  const percent = sftpTransferPercent(item);
  if (item.status === "success") {
    progressBar.style.width = "100%";
  } else if (percent !== null) {
    progressBar.style.width = `${percent}%`;
  } else if (item.status === "running") {
    progress.classList.add("indeterminate");
  } else {
    progressBar.style.width = "0%";
  }
  progress.appendChild(progressBar);

  const meta = document.createElement("div");
  meta.className = `sftp-transfer-meta${item.status === "error" ? " is-error" : ""}`;
  const metaText = sftpTransferMetaText(item);
  meta.textContent = metaText;
  meta.title = metaText;

  body.append(top, progress, meta);

  const actions = document.createElement("div");
  actions.className = "sftp-transfer-actions";
  if (canRetrySftpTransfer(item)) {
    const retryButton = document.createElement("button");
    retryButton.type = "button";
    retryButton.className = "sftp-transfer-retry";
    retryButton.textContent = t("files.transfer.retry");
    retryButton.addEventListener("click", async () => {
      await retrySftpTransfer(item);
    });
    actions.appendChild(retryButton);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sftp-transfer-cancel";
  button.innerHTML =
    '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10"></path><path d="M17 7 7 17"></path></svg>';
  if (terminal) {
    button.setAttribute("aria-label", t("files.transfer.dismiss"));
    button.title = t("files.transfer.dismiss");
    button.addEventListener("click", () => {
      clearSftpTransferDismissTimer(item.transferId);
      sftpTransferItems.delete(item.transferId);
      renderSftpTransferDock();
    });
  } else {
    button.setAttribute("aria-label", t("files.button.cancel"));
    button.title = t("files.button.cancel");
    button.addEventListener("click", async () => {
      try {
        await invoke("sftp_cancel_transfer", { transferId: item.transferId });
      } catch (e) {
        showToast(String(e), "error", 3200);
      }
    });
  }
  actions.appendChild(button);

  row.append(icon, body, actions);
  return row;
}

function renderSftpTransferHeader(items) {
  const active = items.filter((item) => !isSftpTransferTerminal(item));
  const finished = items.length - active.length;

  if (sftpTransferTitleEl) {
    sftpTransferTitleEl.textContent = t("files.transfer.title");
  }
  if (sftpTransferSummaryEl) {
    const bits = [];
    if (active.length > 0) {
      bits.push(t("files.transfer.active_count", { count: active.length }));
      const speed = active.reduce(
        (sum, item) =>
          sum +
          (Number.isFinite(item.bytesPerSec) && item.status === "running" ? item.bytesPerSec : 0),
        0,
      );
      if (speed > 0) bits.push(`${formatSize(speed)}/s`);
    } else if (finished > 0) {
      bits.push(t("files.transfer.done_count", { count: finished }));
    }
    sftpTransferSummaryEl.textContent = bits.join(" · ");
  }
  if (sftpTransferClearBtn) {
    sftpTransferClearBtn.hidden = finished === 0;
    sftpTransferClearBtn.textContent = t("files.transfer.clear_finished");
  }
  if (sftpTransferCollapseBtn) {
    sftpTransferCollapseBtn.setAttribute("aria-expanded", String(!sftpTransferDockCollapsed));
    const label = sftpTransferDockCollapsed
      ? t("files.transfer.expand")
      : t("files.transfer.collapse");
    sftpTransferCollapseBtn.title = label;
    sftpTransferCollapseBtn.setAttribute("aria-label", label);
  }
}

function renderSftpTransferDock() {
  if (!sftpTransferDock || !sftpTransferList) return;
  const items = sortSftpTransferItems();
  if (items.length === 0) {
    hideSftpTransferDockSoon();
    return;
  }
  if (sftpTransferHideTimer) {
    window.clearTimeout(sftpTransferHideTimer);
    sftpTransferHideTimer = null;
  }

  renderSftpTransferHeader(items);
  sftpTransferDock.classList.toggle("collapsed", sftpTransferDockCollapsed);

  sftpTransferList.innerHTML = "";
  if (!sftpTransferDockCollapsed) {
    for (const item of items) {
      sftpTransferList.appendChild(buildSftpTransferRow(item));
    }
  }

  sftpTransferDock.hidden = false;
  requestAnimationFrame(() => sftpTransferDock.classList.add("show"));
}

if (sftpTransferCollapseBtn) {
  sftpTransferCollapseBtn.addEventListener("click", () => {
    sftpTransferDockCollapsed = !sftpTransferDockCollapsed;
    renderSftpTransferDock();
  });
}

if (sftpTransferClearBtn) {
  sftpTransferClearBtn.addEventListener("click", () => {
    for (const [transferId, item] of Array.from(sftpTransferItems.entries())) {
      if (isSftpTransferTerminal(item)) {
        clearSftpTransferDismissTimer(transferId);
        sftpTransferItems.delete(transferId);
      }
    }
    renderSftpTransferDock();
  });
}

listen("sftp:transfer", (ev) => {
  const payload = ev?.payload || {};
  const transferId = Number(payload.transferId ?? payload.transfer_id);
  if (!Number.isFinite(transferId)) return;

  const bytesPerSecRaw = payload.bytesPerSec ?? payload.bytes_per_sec;
  const etaSecondsRaw = payload.etaSeconds ?? payload.eta_seconds;
  const currentFileRaw = payload.currentFile ?? payload.current_file;
  const filesDoneRaw = payload.filesDone ?? payload.files_done;
  const filesTotalRaw = payload.filesTotal ?? payload.files_total;
  const bytesDone = finiteTransferNumber(payload.bytesDone ?? payload.bytes_done) ?? 0;
  const total = finiteTransferNumber(payload.total);
  const bytesPerSec = finiteTransferNumber(bytesPerSecRaw);
  const etaSeconds = finiteTransferNumber(etaSecondsRaw);
  const filesDone = finiteTransferNumber(filesDoneRaw);
  const filesTotal = finiteTransferNumber(filesTotalRaw);
  const item = {
    transferId,
    kind: normalizeSftpTransferKind(payload.kind),
    status: String(payload.status || "running"),
    source: String(payload.source || ""),
    destination: String(payload.destination || ""),
    bytesDone,
    total,
    bytesPerSec,
    etaSeconds,
    currentFile: currentFileRaw ? String(currentFileRaw) : null,
    filesDone,
    filesTotal,
    // Sticky: once a remote→remote copy has picked a route, keep showing it
    // even if a later event omits the field.
    route: payload.route ?? sftpTransferItems.get(transferId)?.route ?? null,
    routeReason: payload.routeReason
      ?? payload.route_reason
      ?? sftpTransferItems.get(transferId)?.routeReason
      ?? null,
    error: payload.error
      ? {
          code: String(payload.error.code || "OTHER"),
          message: String(payload.error.message || ""),
        }
      : null,
    retryPlan: sftpTransferItems.get(transferId)?.retryPlan
      || claimPendingSftpRetryPlan(
        normalizeSftpTransferKind(payload.kind),
        String(payload.source || ""),
        String(payload.destination || ""),
      ),
    updatedAt: Date.now(),
  };
  sftpTransferItems.set(transferId, item);
  scheduleSftpTransferDismiss(item);
  renderSftpTransferDock();
});

let aiMessages = [];
const aiRequestStateByPane = new Map();
let aiStreamUnlistenPromise = null;
let aiConfigLoaded = false;
let aiConfigLoadPromise = null;
const aiConversationByPane = new Map();
const aiSessionIdentityByPane = new Map();
let aiCurrentSessionId = "";
let aiCurrentSessionCreatedAt = 0;
let aiCurrentSessionTemporary = false;
let aiSessionItems = [];
let aiSessionOpen = false;
let aiSessionFilter = "current";
let aiActivePaneKey = null;
let aiPanelCollapsed = true;
let terminalActiveSidePanel = null;
const terminalSidePanelByPane = new Map();
let metricsRefreshTimer = null;
let metricsRefreshToken = 0;
let terminalCommandSnippets = [];
let terminalSnippetSearchQuery = "";
let snippetGroupMenuTarget = "";
let snippetItemMenuTargetId = "";
const TERMINAL_COMMAND_SNIPPETS_KEY = "zt.terminal.commandSnippets";
const TERMINAL_SNIPPETS_MIGRATED_KEY = "zt.terminal.snippetsMigrated";
const TERMINAL_SNIPPET_GROUP_STATE_KEY = "zt.terminal.commandSnippetGroups";
let terminalSnippetGroupExpanded = {};
const AI_CONTEXT_MODES = ["always", "off"];
let aiContextMode = localStorage.getItem("zt.ai.contextMode") || "always";
if (!AI_CONTEXT_MODES.includes(aiContextMode)) aiContextMode = "always";
let lastAutoAiModelsKey = "";
let aiModelsRefreshedOnFirstOpen = false;
let currentAiModelLabel = "";
/// True only when the backend has an API key on file *and* a non-empty
/// model is configured. The header pill switches to the "未配置" label
/// whenever either is missing, instead of showing the default `gpt-4.1`
/// stub from `default_ai_config()`.
let aiConfigured = false;
// Multi-profile AI config store mirrored from the backend (`get_ai_config`).
let aiStore = { version: 2, profiles: [], activeProfileId: "" };
// null = editor closed; "" = adding a new profile; "<id>" = editing existing.
let aiEditingProfileId = null;
let pendingAiCommandCounter = 0;
const aiMultiCommandState = new WeakMap();
const aiMessageByNode = new WeakMap();
let snippetEditResolver = null;
const TERMINAL_SCROLLBACK = 3000;

function getAiRequestState(paneKey = getAiPaneKey()) {
  const key = paneKey || "no-terminal";
  let state = aiRequestStateByPane.get(key);
  if (!state) {
    state = { sending: false, activeRequestId: "", canceling: false };
    aiRequestStateByPane.set(key, state);
  }
  return state;
}

function isAiSendingForPane(paneKey = getAiPaneKey()) {
  return getAiRequestState(paneKey).sending;
}

function setAiPaneMessages(paneKey, messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  aiConversationByPane.set(paneKey, normalized);
  if (paneKey === getAiPaneKey()) {
    aiMessages = normalized;
    renderAiConversation();
  }
}

async function loadTerminalCommandSnippets() {
  // Snippets now live in the encrypted vault (kind "snippet") so they
  // sync across devices. While the vault is locked `list_snippets`
  // errors — treat that as "nothing to show" rather than surfacing an
  // error, mirroring how the hosts list behaves before unlock.
  try {
    const list = await invoke("list_snippets");
    terminalCommandSnippets = Array.isArray(list)
      ? list.map((item) => ({
        id: String(item?.id || ""),
        group: String(item?.group || "").trim(),
        title: String(item?.title || ""),
        command: String(item?.command || ""),
        sortOrder: Number(item?.sortOrder || 0),
      }))
      : [];
  } catch (e) {
    console.warn("load snippets failed", e);
    terminalCommandSnippets = [];
  }
}

async function refreshSnippetsAndRender() {
  await loadTerminalCommandSnippets();
  renderTerminalCommandSnippets();
}

/// One-time migration of pre-sync snippets from localStorage into the
/// vault. Runs once after unlock: imports each legacy entry via
/// `create_snippet`, stashes the old array under a `.bak` key, then sets
/// a migrated flag so we never re-import (which would resurrect snippets
/// the user has since deleted on this or another device).
async function migrateLocalSnippetsToVault() {
  if (localStorage.getItem(TERMINAL_SNIPPETS_MIGRATED_KEY) === "1") return;
  let legacy = [];
  try {
    legacy = JSON.parse(localStorage.getItem(TERMINAL_COMMAND_SNIPPETS_KEY) || "[]");
  } catch {
    legacy = [];
  }
  if (Array.isArray(legacy) && legacy.length) {
    let imported = 0;
    for (const item of legacy) {
      const title = String(item?.title || "").trim();
      const command = String(item?.command || "").trim();
      if (!title || !command) continue;
      try {
        await invoke("create_snippet", {
          input: { title, command, group: normalizeSnippetGroup(item?.group), sortOrder: 0 },
        });
        imported += 1;
      } catch (e) {
        console.warn("snippet migration: skipped one entry", e);
      }
    }
    // Keep a backup of the pre-migration array just in case.
    localStorage.setItem(`${TERMINAL_COMMAND_SNIPPETS_KEY}.bak`, JSON.stringify(legacy));
    if (imported) showToast(t("snippets.toast.migrated", { count: imported }), "success", 2600);
  }
  localStorage.removeItem(TERMINAL_COMMAND_SNIPPETS_KEY);
  localStorage.setItem(TERMINAL_SNIPPETS_MIGRATED_KEY, "1");
}

function loadTerminalSnippetGroupState() {
  try {
    const raw = localStorage.getItem(TERMINAL_SNIPPET_GROUP_STATE_KEY);
    const parsed = JSON.parse(raw || "{}");
    terminalSnippetGroupExpanded = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    terminalSnippetGroupExpanded = {};
  }
}

function saveTerminalSnippetGroupState() {
  localStorage.setItem(TERMINAL_SNIPPET_GROUP_STATE_KEY, JSON.stringify(terminalSnippetGroupExpanded));
}

function defaultSnippetGroupLabel() {
  return t("snippets.ungrouped");
}

function isDefaultSnippetGroupLabel(group) {
  const s = String(group || "").trim();
  return !s || s === "未分组" || s === "Ungrouped" || s === defaultSnippetGroupLabel();
}

// The default group bucket is stored as an empty group string in the
// vault, so every write path normalizes before sending and the renderer
// maps empty back to the localized label.
function normalizeSnippetGroup(group) {
  const s = String(group || "").trim();
  return isDefaultSnippetGroupLabel(s) ? "" : s;
}

function getTerminalSnippetGroups() {
  const defaultGroup = defaultSnippetGroupLabel();
  const groups = new Set([defaultGroup]);
  for (const snippet of terminalCommandSnippets) {
    groups.add(String(snippet.group || defaultGroup).trim() || defaultGroup);
  }
  return Array.from(groups).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

function syncSnippetGroupSelectOptions(currentValue = defaultSnippetGroupLabel()) {
  if (!snippetEditGroup) return;
  const value = isDefaultSnippetGroupLabel(currentValue) ? defaultSnippetGroupLabel() : String(currentValue || "").trim();
  const groups = getTerminalSnippetGroups();
  if (!groups.includes(value)) groups.push(value);
  snippetEditGroup.dataset.customValue = "";
  snippetEditGroup.innerHTML = "";
  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group;
    option.textContent = group;
    snippetEditGroup.appendChild(option);
  }
  snippetEditGroup.value = value;
  syncCustomSelect("snippet-edit-group");
}

function closeSnippetEditDialog(result) {
  if (!snippetEditResolver) return;
  const resolve = snippetEditResolver;
  snippetEditResolver = null;
  if (snippetEditOverlay) snippetEditOverlay.hidden = true;
  if (snippetEditForm) snippetEditForm.reset();
  if (snippetEditGroup) {
    snippetEditGroup.dataset.customValue = "";
    syncSnippetGroupSelectOptions(defaultSnippetGroupLabel());
  }
  resolve(result);
}

function openSnippetEditDialog({
  title = t("snippets.dialog.title"),
  name = "",
  group = defaultSnippetGroupLabel(),
  command = "",
} = {}) {
  if (snippetEditResolver) closeSnippetEditDialog(null);
  return new Promise((resolve) => {
    snippetEditResolver = resolve;
    if (snippetEditTitle) snippetEditTitle.textContent = title;
    if (snippetEditName) snippetEditName.value = name;
    syncSnippetGroupSelectOptions(group);
    if (snippetEditCommand) snippetEditCommand.value = command;
    if (snippetEditOverlay) snippetEditOverlay.hidden = false;
    requestAnimationFrame(() => {
      snippetEditName?.focus();
      snippetEditName?.select();
    });
  });
}

async function sendSnippetToActiveTerminal(command) {
  const pane = getActivePane();
  if (!pane || pane.sessionId === null) {
    alert(t("snippets.error.no_terminal"));
    return;
  }
  await sendTextToPane(pane, joinSnippetForInsert(command), { fill: true });
  pane.term?.focus?.();
}

// Flatten a multi-line snippet into one line for "Insert": join non-empty,
// non-comment lines with "; " so the whole thing fills the prompt as a single
// unexecuted command (the user presses Enter to run). Comment-only lines (#...)
// are dropped so they don't swallow the rest of the joined line. Note: this
// intentionally does not preserve multi-line shell blocks (for/if/heredoc) —
// use "Run" for those.
function joinSnippetForInsert(command) {
  return String(command || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/;+\s*$/, "").trim())
    .filter((line) => line.length > 0)
    .join("; ");
}

function escapeMetricText(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function svgIcon(paths) {
  return `<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}

function pct(n) {
  return `${Math.max(0, Math.min(100, Math.round(Number(n) || 0)))}%`;
}

function metricMeterMarkup(value, tone = "good") {
  const p = pct(value);
  return `<div class="metric-bar metric-${tone}"><span style="width:${p}"></span></div>`;
}

function metricGaugeMarkup(value, tone = "good", { showValue = true } = {}) {
  const p = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  return `<div class="metric-gauge metric-${tone}" style="--metric:${p}">${showValue ? `<span class="metric-gauge-value"><strong>${p}</strong><em>%</em></span>` : ""}</div>`;
}

function formatMetricBytes(bytes) {
  const n = Number(bytes) || 0;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
}

function formatMetricUptime(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  return `${hours} 小时`;
}

function metricTone(value) {
  const n = Number(value) || 0;
  if (n >= 95) return "danger";
  if (n >= 85) return "warn";
  return "good";
}

function renderMetricsData(metrics) {
  const cpu = Number(metrics.cpuUsage) || 0;
  const ram = metrics.memoryTotal > 0 ? (metrics.memoryUsed / metrics.memoryTotal) * 100 : 0;
  const swap = metrics.swapTotal > 0 ? (metrics.swapUsed / metrics.swapTotal) * 100 : 0;
  const disks = Array.isArray(metrics.disks) ? metrics.disks.slice(0, 8) : [];
  const networks = Array.isArray(metrics.networks) ? metrics.networks.slice(0, 6) : [];
  terminalMetricsBody?.classList.remove("metrics-loading");
  terminalMetricsBody.innerHTML = `
    <section class="metrics-card metrics-system-card">
      <div class="metrics-card-head"><span>${t("metrics.system")}</span></div>
      <div class="metrics-kv-grid">
        <div><small>${t("metrics.host")}</small><strong>${escapeMetricText(metrics.host || "--")}</strong></div>
        <div><small>${t("metrics.arch")}</small><strong>${escapeMetricText(metrics.arch || "--")}</strong></div>
        <div><small>${t("metrics.os")}</small><strong>${escapeMetricText(metrics.os || "--")}</strong></div>
        <div><small>${t("metrics.uptime")}</small><strong>${formatMetricUptime(metrics.uptimeSeconds)}</strong></div>
      </div>
    </section>
    <section class="metrics-card metrics-compact-card">
      <div class="metrics-card-head"><span><i aria-hidden="true">⚙</i>${t("metrics.cpu")}</span><em>${t("metrics.cpu.cores", { count: metrics.cpuCores || 1 })}</em></div>
      <div class="metric-row metric-row-gauge">${metricGaugeMarkup(cpu, metricTone(cpu))}<div><strong>${t("metrics.cpu.avg")}</strong>${metricMeterMarkup(cpu, metricTone(cpu))}</div><b>${cpu.toFixed(1)}%</b></div>
    </section>
    <section class="metrics-card metrics-compact-card">
      <div class="metrics-card-head"><span><i aria-hidden="true">▥</i>${t("metrics.memory")}</span></div>
      <div class="metric-row metric-row-gauge">${metricGaugeMarkup(ram, metricTone(ram))}<div><strong>${t("metrics.ram")}</strong>${metricMeterMarkup(ram, metricTone(ram))}<small>${formatMetricBytes(metrics.memoryUsed)} / ${formatMetricBytes(metrics.memoryTotal)}</small></div><b>${ram.toFixed(1)}%</b></div>
      <div class="metric-line"><span>${t("metrics.swap")}</span><b>${swap.toFixed(0)}%</b>${metricMeterMarkup(swap, metricTone(swap))}<small>${formatMetricBytes(metrics.swapUsed)} / ${formatMetricBytes(metrics.swapTotal)}</small></div>
    </section>
    <section class="metrics-card">
      <div class="metrics-card-head"><span>${t("metrics.network")}</span></div>
      ${networks.length ? networks.map((n) => `<div class="metrics-net-row"><strong>${escapeMetricText(n.name)}</strong><span>↑ ${formatMetricBytes(n.txBytesPerSec)}/s</span><span>↓ ${formatMetricBytes(n.rxBytesPerSec)}/s</span></div>`).join("") : `<div class="metrics-net-row"><strong>--</strong><span>↑ 0 B/s</span><span>↓ 0 B/s</span></div>`}
    </section>
    <section class="metrics-card">
      <div class="metrics-card-head"><span>${t("metrics.disk")}</span></div>
      ${disks.map((d) => `<div class="metric-line"><span>${escapeMetricText(d.mount)}</span><b class="${d.usage >= 90 ? "danger" : ""}">${Number(d.usage || 0).toFixed(0)}%</b>${metricMeterMarkup(d.usage, metricTone(d.usage))}<small>${formatMetricBytes(d.used)} / ${formatMetricBytes(d.total)}</small></div>`).join("")}
    </section>
  `;
}

async function renderMetricsPanel(options = {}) {
  if (!terminalMetricsBody) return;
  const silent = Boolean(options.silent);
  const token = ++metricsRefreshToken;
  const pane = getActivePane();
  terminalMetricsBody.classList.remove("metrics-loading");
  if (!pane) {
    terminalMetricsBody.innerHTML = `<div class="terminal-side-empty"><strong>${t("metrics.empty.title")}</strong><p>${t("metrics.empty.desc")}</p></div>`;
    return;
  }
  if (!silent || !terminalMetricsBody.querySelector(".metrics-card")) {
    terminalMetricsBody.classList.add("metrics-loading");
    terminalMetricsBody.innerHTML = `<div class="terminal-side-empty metrics-loading-card"><strong>${t("metrics.loading")}</strong><p>${escapeMetricText(pane.host?.name || pane.host?.host || "Local")}</p></div>`;
  }
  try {
    const metrics = await invoke("collect_system_metrics", { hostId: pane.host?.id || null });
    if (token !== metricsRefreshToken || terminalActiveSidePanel !== "metrics") return;
    renderMetricsData(metrics);
  } catch (e) {
    if (token !== metricsRefreshToken || terminalActiveSidePanel !== "metrics") return;
    terminalMetricsBody.classList.remove("metrics-loading");
    if (silent && terminalMetricsBody.querySelector(".metrics-card")) return;
    terminalMetricsBody.innerHTML = `<div class="terminal-side-empty"><strong>${escapeMetricText(t("metrics.error", { error: String(e) }))}</strong><p>${escapeMetricText(pane.host?.name || pane.host?.host || "Local")}</p></div>`;
  }
}

function startMetricsAutoRefresh() {
  if (metricsRefreshTimer) clearInterval(metricsRefreshTimer);
  metricsRefreshTimer = setInterval(() => {
    if (terminalActiveSidePanel === "metrics") renderMetricsPanel({ silent: true });
  }, 5000);
}

function stopMetricsAutoRefresh() {
  if (metricsRefreshTimer) clearInterval(metricsRefreshTimer);
  metricsRefreshTimer = null;
  metricsRefreshToken += 1;
}

// ---------- Docker panel ----------
let dockerRefreshToken = 0;
const dockerExpanded = new Set();
// Groups the user has explicitly expanded. Empty by default → every group
// starts collapsed.
const dockerExpandedGroups = new Set();
let dockerLastRows = [];
// Sentinel group key for containers without a compose project. Contains a ":"
// which is not a valid compose project name char, so it never collides.
const DOCKER_UNGROUPED = "::ungrouped";

async function dockerExec(args) {
  const pane = getActivePane();
  return invoke("docker_exec", { hostId: pane?.host?.id || null, args });
}

// `docker ps --format {{json .}}` exposes labels as a single comma-joined
// "k=v,k=v" string. Split into a map so we can read the compose labels.
function parseDockerLabels(str) {
  const map = {};
  String(str || "").split(",").forEach((pair) => {
    const eq = pair.indexOf("=");
    if (eq <= 0) return;
    map[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  });
  return map;
}

function parseDockerPsLines(stdout) {
  const rows = [];
  String(stdout || "").split("\n").forEach((line) => {
    const s = line.trim();
    if (!s) return;
    try {
      const o = JSON.parse(s);
      const labels = parseDockerLabels(o.Labels);
      rows.push({
        id: o.ID || o.Id || "",
        name: o.Names || o.Name || "",
        image: o.Image || "",
        state: String(o.State || "").toLowerCase(),
        status: o.Status || "",
        ports: o.Ports || "",
        project: labels["com.docker.compose.project"] || "",
        service: labels["com.docker.compose.service"] || "",
        configFiles: labels["com.docker.compose.project.config_files"] || "",
      });
    } catch (e) {}
  });
  return rows;
}

function dockerStateTone(state) {
  if (state === "running") return "ok";
  if (state === "paused" || state === "restarting" || state === "created") return "warn";
  return "muted";
}

async function renderDockerPanel(options = {}) {
  if (!terminalDockerBody) return;
  const silent = Boolean(options.silent);
  const token = ++dockerRefreshToken;
  const pane = getActivePane();
  if (!pane) {
    terminalDockerBody.innerHTML = `<div class="terminal-side-empty"><strong>没有可用的终端会话</strong><p>请先连接或聚焦一个终端标签页。</p></div>`;
    return;
  }
  if (!silent || !terminalDockerBody.querySelector(".docker-card")) {
    terminalDockerBody.innerHTML = `<div class="terminal-side-empty"><strong>正在读取容器…</strong><p>${escapeMetricText(pane.host?.name || pane.host?.host || "本地")}</p></div>`;
  }
  try {
    const res = await dockerExec(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
    if (token !== dockerRefreshToken || terminalActiveSidePanel !== "docker") return;
    if (res.code !== 0) {
      const msg = String(res.stderr || res.stdout || "").trim();
      const friendly = /not found|command not found|not recognized|docker daemon|Cannot connect|permission denied/i.test(msg)
        ? "未检测到 Docker，或守护进程未运行 / 权限不足。" : (msg || "执行失败。");
      terminalDockerBody.innerHTML = `<div class="terminal-side-empty"><strong>无法获取容器列表</strong><p>${escapeMetricText(friendly)}</p></div>`;
      return;
    }
    renderDockerList(parseDockerPsLines(res.stdout));
  } catch (e) {
    if (token !== dockerRefreshToken || terminalActiveSidePanel !== "docker") return;
    terminalDockerBody.innerHTML = `<div class="terminal-side-empty"><strong>无法获取容器列表</strong><p>${escapeMetricText(String(e))}</p></div>`;
  }
}

function renderDockerList(rows) {
  if (!terminalDockerBody) return;
  hideDockerGroupMenu();
  dockerLastRows = rows;
  if (!rows.length) {
    terminalDockerBody.innerHTML = `<div class="terminal-side-empty"><strong>没有容器</strong><p>该主机上未发现任何 Docker 容器。</p></div>`;
    return;
  }
  // Group by compose project, preserving first-seen order within each group.
  const groups = new Map();
  rows.forEach((c) => {
    const key = c.project || DOCKER_UNGROUPED;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  });
  // Compose projects sorted alphabetically; the ungrouped bucket always last.
  const keys = [...groups.keys()].filter((k) => k !== DOCKER_UNGROUPED).sort((a, b) => a.localeCompare(b));
  if (groups.has(DOCKER_UNGROUPED)) keys.push(DOCKER_UNGROUPED);
  // Nothing belongs to a compose project → render a flat list (old behaviour).
  const onlyUngrouped = keys.length === 1 && keys[0] === DOCKER_UNGROUPED;
  terminalDockerBody.innerHTML = keys.map((key) => {
    const items = groups.get(key);
    if (onlyUngrouped) return items.map(dockerCardHtml).join("");
    return dockerGroupHtml(key, items);
  }).join("");
  dockerExpanded.forEach((id) => {
    if (rows.some((r) => r.id === id)) loadDockerDetail(id);
  });
}

function dockerCardHtml(c) {
  const tone = dockerStateTone(c.state);
  const running = c.state === "running";
  const expanded = dockerExpanded.has(c.id);
  const idAttr = escapeMetricText(c.id);
  return `
    <section class="docker-card" data-id="${idAttr}">
      <button type="button" class="docker-card-toggle" data-act="detail" data-id="${idAttr}">
        <span class="docker-state docker-state-${tone}"></span>
        <span class="docker-name">${escapeMetricText(c.name || c.id.slice(0, 12))}</span>
        <span class="docker-caret ${expanded ? "open" : ""}">›</span>
      </button>
      <div class="docker-meta">
        <span class="docker-image" title="${escapeMetricText(c.image)}">${escapeMetricText(c.image)}</span>
        <span class="docker-status">${escapeMetricText(c.status)}</span>
      </div>
      ${c.ports ? `<div class="docker-ports">${escapeMetricText(c.ports)}</div>` : ""}
      <div class="docker-actions">
        ${running
          ? `<button type="button" class="docker-btn" data-act="stop" data-id="${idAttr}">停止</button><button type="button" class="docker-btn" data-act="restart" data-id="${idAttr}">重启</button><button type="button" class="docker-btn" data-act="terminal" data-id="${idAttr}">终端</button>`
          : `<button type="button" class="docker-btn docker-btn-success" data-act="start" data-id="${idAttr}">启动</button>`}
        <button type="button" class="docker-btn" data-act="logs" data-id="${idAttr}" data-name="${escapeMetricText(c.name)}">日志</button>
        <button type="button" class="docker-btn docker-btn-danger" data-act="remove" data-id="${idAttr}" data-name="${escapeMetricText(c.name)}">删除</button>
      </div>
      <div class="docker-detail" data-id="${idAttr}" ${expanded ? "" : "hidden"}></div>
    </section>`;
}

function dockerGroupHtml(key, items) {
  const ungrouped = key === DOCKER_UNGROUPED;
  const total = items.length;
  const running = items.filter((c) => c.state === "running").length;
  const tone = running === 0 ? "muted" : (running === total ? "ok" : "warn");
  const collapsed = !dockerExpandedGroups.has(key);
  const keyAttr = escapeMetricText(key);
  const label = ungrouped ? "未分组" : key;
  const configFiles = ungrouped ? "" : (items.find((c) => c.configFiles)?.configFiles || "");
  const hidden = collapsed ? "hidden" : "";
  const menuBtn = ungrouped ? "" : `<button type="button" class="docker-group-menu-btn" data-act="group-menu" data-project="${keyAttr}" title="批量操作" aria-label="批量操作">
          <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
        </button>`;
  return `
    <section class="docker-group${ungrouped ? " docker-group-ungrouped" : ""}" data-project="${keyAttr}">
      <header class="docker-group-head" data-act="group-toggle" data-project="${keyAttr}"${configFiles ? ` title="${escapeMetricText(configFiles)}"` : ""}>
        <span class="docker-group-caret${collapsed ? "" : " open"}">›</span>
        <span class="docker-state docker-state-${tone}"></span>
        <span class="docker-group-name">${escapeMetricText(label)}</span>
        <span class="docker-group-count">${running}/${total}</span>
        ${menuBtn}
      </header>
      <div class="docker-group-body" ${hidden}>
        ${items.map(dockerCardHtml).join("")}
      </div>
    </section>`;
}

function toggleDockerGroup(key, headerEl) {
  const section = headerEl?.closest(".docker-group");
  if (!section || !key) return;
  const expanded = dockerExpandedGroups.has(key);
  if (expanded) dockerExpandedGroups.delete(key); else dockerExpandedGroups.add(key);
  const nowCollapsed = expanded;
  section.querySelector(".docker-group-body")?.toggleAttribute("hidden", nowCollapsed);
  section.querySelector(".docker-group-caret")?.classList.toggle("open", !nowCollapsed);
}

async function dockerGroupAction(project, op, btn) {
  const ids = dockerLastRows.filter((r) => r.project === project && r.id).map((r) => r.id);
  if (!ids.length) return;
  if (btn) btn.disabled = true;
  try {
    const res = await dockerExec([op, ...ids]);
    if (res.code !== 0) {
      showToast(String(res.stderr || res.stdout || "操作失败。").trim(), "error", 4200);
    }
  } catch (e) {
    showToast(String(e), "error", 4200);
  } finally {
    renderDockerPanel({ silent: true });
  }
}

let dockerGroupMenuProject = "";

function ensureDockerGroupMenu() {
  let menu = document.getElementById("docker-group-menu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "docker-group-menu";
  menu.className = "hosts-context-menu docker-group-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" class="success" data-op="start">
      <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4 20 12 6 20Z"/></svg>
      <span>全部启动</span>
    </button>
    <button type="button" data-op="restart">
      <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><polyline points="22 5 22 11 16 11"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L22 11"/></svg>
      <span>全部重启</span>
    </button>
    <button type="button" class="danger" data-op="stop">
      <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      <span>全部停止</span>
    </button>`;
  document.body.appendChild(menu);
  menu.addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-op]");
    if (!b) return;
    const op = b.getAttribute("data-op");
    const project = dockerGroupMenuProject;
    hideDockerGroupMenu();
    if (project) dockerGroupAction(project, op);
  });
  document.addEventListener("click", (ev) => {
    if (!menu.hidden && !menu.contains(ev.target)) hideDockerGroupMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !menu.hidden) { ev.stopPropagation(); hideDockerGroupMenu(); }
  });
  return menu;
}

function hideDockerGroupMenu() {
  const menu = document.getElementById("docker-group-menu");
  if (menu) menu.hidden = true;
  dockerGroupMenuProject = "";
}

function openDockerGroupMenu(project, anchorBtn) {
  const menu = ensureDockerGroupMenu();
  // Re-clicking the same group's button closes the menu (toggle).
  if (!menu.hidden && dockerGroupMenuProject === project) { hideDockerGroupMenu(); return; }
  dockerGroupMenuProject = project || "";
  menu.style.left = "0px";
  menu.style.top = "0px";
  menu.hidden = false;
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  const anchor = anchorBtn.getBoundingClientRect();
  let left = anchor.right - rect.width;       // right-align under the button
  let top = anchor.bottom + 4;                // drop below it
  if (left < pad) left = pad;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, anchor.top - rect.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function dockerDetailEl(id) {
  return terminalDockerBody?.querySelector(`.docker-detail[data-id="${id}"]`) || null;
}

function toggleDockerDetail(id) {
  const el = dockerDetailEl(id);
  const caret = terminalDockerBody?.querySelector(`.docker-card-toggle[data-id="${id}"] .docker-caret`);
  if (dockerExpanded.has(id)) {
    dockerExpanded.delete(id);
    if (el) { el.hidden = true; el.innerHTML = ""; }
    caret?.classList.remove("open");
  } else {
    dockerExpanded.add(id);
    if (el) { el.hidden = false; el.innerHTML = `<p class="muted tiny">加载中…</p>`; }
    caret?.classList.add("open");
    loadDockerDetail(id);
  }
}

async function loadDockerDetail(id) {
  const el = dockerDetailEl(id);
  if (!el) return;
  try {
    const res = await dockerExec(["inspect", "--format", "{{json .}}", id]);
    if (!dockerExpanded.has(id)) return;
    if (res.code !== 0) {
      el.innerHTML = `<p class="muted tiny">${escapeMetricText(String(res.stderr || res.stdout || "无法读取详情").trim())}</p>`;
      return;
    }
    let info;
    try { info = JSON.parse(res.stdout.trim()); } catch (e) { el.innerHTML = `<p class="muted tiny">详情解析失败</p>`; return; }
    el.innerHTML = renderDockerDetail(info);
  } catch (e) {
    el.innerHTML = `<p class="muted tiny">${escapeMetricText(String(e))}</p>`;
  }
}

function renderDockerDetail(info) {
  const net = info?.NetworkSettings?.Networks || {};
  const ips = [];
  Object.entries(net).forEach(([name, n]) => { if (n?.IPAddress) ips.push(`${name}: ${n.IPAddress}`); });
  const topIp = info?.NetworkSettings?.IPAddress;
  if (topIp && !ips.length) ips.push(topIp);
  const created = info?.Created ? String(info.Created).replace("T", " ").slice(0, 19) : "";
  const cmd = Array.isArray(info?.Config?.Cmd) ? info.Config.Cmd.join(" ") : "";
  const restart = info?.HostConfig?.RestartPolicy?.Name || "";
  const mounts = Array.isArray(info?.Mounts)
    ? info.Mounts.map((m) => `${m.Source || m.Name || ""} → ${m.Destination || ""}`)
    : [];
  const labels = info?.Config?.Labels || {};
  const composeProject = labels["com.docker.compose.project"];
  const composeService = labels["com.docker.compose.service"];
  const rows = [["IP", ips.length ? ips.join("、") : "—"]];
  if (composeProject) rows.push(["Compose", composeService ? `${composeProject} / ${composeService}` : composeProject]);
  if (created) rows.push(["创建", created]);
  if (info?.Config?.Image) rows.push(["镜像", info.Config.Image]);
  if (restart) rows.push(["重启策略", restart]);
  if (cmd) rows.push(["命令", cmd]);
  const lines = rows.map(([k, v]) => `<div class="docker-detail-row"><span>${escapeMetricText(k)}</span><b>${escapeMetricText(v)}</b></div>`).join("");
  const mountLines = mounts.length
    ? `<div class="docker-detail-row docker-detail-mounts"><span>挂载</span><div>${mounts.map((m) => `<code>${escapeMetricText(m)}</code>`).join("")}</div></div>`
    : "";
  return lines + mountLines;
}

async function dockerAction(args, btn) {
  if (btn) btn.disabled = true;
  try {
    const res = await dockerExec(args);
    if (res.code !== 0) {
      showToast(String(res.stderr || res.stdout || "操作失败。").trim(), "error", 4200);
    }
  } catch (e) {
    showToast(String(e), "error", 4200);
  } finally {
    renderDockerPanel({ silent: true });
  }
}

async function dockerRemove(id, name) {
  if (!confirm(`确定删除容器 ${name || id}？此操作不可恢复。`)) return;
  dockerExpanded.delete(id);
  await dockerAction(["rm", "-f", id]);
}

async function dockerEnterTerminal(id) {
  const pane = getActivePane();
  if (!pane || pane.sessionId == null) { showToast("没有可用的终端会话", "error"); return; }
  setTerminalSidePanel(null);
  try {
    await sendTextToPane(pane, `docker exec -it ${id} sh`, { submit: true });
    pane.term?.focus?.();
  } catch (e) {
    showToast(String(e), "error");
  }
}

async function dockerShowLogs(id, name) {
  const overlay = ensureDockerLogsOverlay();
  const titleEl = overlay.querySelector(".docker-logs-title");
  const cmdEl = overlay.querySelector(".docker-logs-cmd");
  const bodyEl = overlay.querySelector(".docker-logs-body");
  const label = name || id.slice(0, 12);
  titleEl.textContent = `日志 · ${label}`;
  if (cmdEl) cmdEl.textContent = `docker logs --tail 300 ${label}`;
  bodyEl.textContent = "加载中…";
  overlay.hidden = false;
  try {
    const res = await dockerExec(["logs", "--tail", "300", id]);
    const text = `${res.stdout || ""}${res.stderr ? `\n${res.stderr}` : ""}`.trim() || "(无日志输出)";
    bodyEl.textContent = text;
    bodyEl.scrollTop = bodyEl.scrollHeight;
  } catch (e) {
    bodyEl.textContent = String(e);
  }
}

function ensureDockerLogsOverlay() {
  let overlay = document.getElementById("docker-logs-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "docker-logs-overlay";
  overlay.className = "overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <section class="dialog docker-logs-dialog" role="dialog" aria-modal="true">
      <header class="docker-logs-head">
        <div class="docker-logs-titlewrap">
          <strong class="docker-logs-title">日志</strong>
          <code class="docker-logs-cmd"></code>
        </div>
        <button type="button" class="docker-logs-close">关闭</button>
      </header>
      <pre class="docker-logs-body"></pre>
    </section>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.hidden = true; };
  overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelector(".docker-logs-close").addEventListener("click", close);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) { ev.stopPropagation(); close(); }
  });
  return overlay;
}


function setTerminalSidePanel(panel, { skipSftpConnect = false } = {}) {
  terminalActiveSidePanel = panel || null;
  const paneKey = getAiPaneKey();
  if (paneKey !== "no-terminal") {
    terminalSidePanelByPane.set(paneKey, terminalActiveSidePanel);
  }
  aiPanelCollapsed = !terminalActiveSidePanel;
  terminalSessionLayout?.classList.toggle("ai-collapsed", !terminalActiveSidePanel);
  if (terminalSidePanels) terminalSidePanels.hidden = !terminalActiveSidePanel;
  if (terminalAiPanel) terminalAiPanel.hidden = terminalActiveSidePanel !== "ai";
  if (terminalSnippetsPanel) terminalSnippetsPanel.hidden = terminalActiveSidePanel !== "snippets";
  if (terminalMetricsPanel) terminalMetricsPanel.hidden = terminalActiveSidePanel !== "metrics";
  if (terminalSftpPanel) terminalSftpPanel.hidden = terminalActiveSidePanel !== "sftp";
  if (terminalThemePanel) terminalThemePanel.hidden = terminalActiveSidePanel !== "theme";
  if (terminalDockerPanel) terminalDockerPanel.hidden = terminalActiveSidePanel !== "docker";
  terminalSidebarAiToggle?.classList.toggle("active", terminalActiveSidePanel === "ai");
  if (terminalSidebarAiToggle) {
    const label = terminalActiveSidePanel === "ai" ? t("ai.panel.collapse") : t("ai.panel.expand");
    terminalSidebarAiToggle.title = label;
    terminalSidebarAiToggle.setAttribute("aria-label", label);
  }
  terminalSidebarSnippetsToggle?.classList.toggle("active", terminalActiveSidePanel === "snippets");
  terminalSidebarMetricsToggle?.classList.toggle("active", terminalActiveSidePanel === "metrics");
  terminalSidebarSftpToggle?.classList.toggle("active", terminalActiveSidePanel === "sftp");
  terminalSidebarThemeToggle?.classList.toggle("active", terminalActiveSidePanel === "theme");
  terminalSidebarDockerToggle?.classList.toggle("active", terminalActiveSidePanel === "docker");
  if (terminalActiveSidePanel === "ai") refreshAiModelsOnFirstPanelOpen();
  if (terminalActiveSidePanel === "metrics") {
    renderMetricsPanel();
    startMetricsAutoRefresh();
  } else {
    stopMetricsAutoRefresh();
  }
  if (terminalActiveSidePanel === "sftp" && !skipSftpConnect) {
    connectTerminalSftpToActivePane().catch((e) => console.warn("terminal sftp connect failed", e));
  }
  if (terminalActiveSidePanel === "theme") {
    renderTerminalThemeCards();
    if (settingsTerminalFontFamily) {
      populateTerminalFontFamilyOptionsAsync().catch((e) => {
        console.warn("populateTerminalFontFamilyOptionsAsync failed", e);
      });
    }
    if (settingsTerminalFontSize) settingsTerminalFontSize.value = String(getTerminalFontSize());
    if (settingsTerminalLineHeight) settingsTerminalLineHeight.value = String(getTerminalLineHeight());
    syncTerminalFontPreview();
  }
  if (terminalActiveSidePanel === "docker") renderDockerPanel();
  refitActiveTerminalPanes({ reason: "side-panel-toggle", forceBottom: true });
}

function applyTerminalSidePanelForActivePane() {
  const paneKey = getAiPaneKey();
  const panel = paneKey === "no-terminal" ? null : (terminalSidePanelByPane.get(paneKey) || null);
  setTerminalSidePanel(panel);
}

function refitActiveTerminalPanes({ reason = "", forceBottom = false, frames = 2 } = {}) {
  const tab = getActiveTab();
  if (!tab?.panes?.length) return;
  const panes = tab.panes.filter((pane) => pane?.term);
  if (!panes.length) return;

  const fitOnce = () => {
    for (const pane of panes) {
      try {
        requestPaneFit(pane, { immediate: true });
        refreshPaneTerminal(pane);
        if (forceBottom) keepPaneTerminalAtBottom(pane, { force: true });
      } catch (e) {
        if (reason) console.warn(`terminal refit failed (${reason})`, e);
      }
    }
  };

  fitOnce();
  let remaining = Math.max(0, frames);
  const tick = () => {
    if (remaining <= 0) return;
    remaining -= 1;
    requestAnimationFrame(() => {
      fitOnce();
      tick();
    });
  };
  tick();
}

function hideSnippetGroupContextMenu() {
  if (!snippetGroupContextMenu) return;
  snippetGroupContextMenu.hidden = true;
}

function showSnippetGroupContextMenu(group, x, y) {
  if (!snippetGroupContextMenu) return;
  snippetGroupMenuTarget = group || "";
  snippetGroupContextMenu.style.left = "0px";
  snippetGroupContextMenu.style.top = "0px";
  snippetGroupContextMenu.hidden = false;

  const pad = 8;
  const rect = snippetGroupContextMenu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  snippetGroupContextMenu.style.left = `${left}px`;
  snippetGroupContextMenu.style.top = `${top}px`;
}

function hideSnippetItemContextMenu() {
  if (!snippetItemContextMenu) return;
  snippetItemContextMenu.hidden = true;
}

function showSnippetItemContextMenu(snippetId, x, y) {
  if (!snippetItemContextMenu) return;
  snippetItemMenuTargetId = snippetId || "";
  snippetItemContextMenu.style.left = "0px";
  snippetItemContextMenu.style.top = "0px";
  snippetItemContextMenu.hidden = false;

  const pad = 8;
  const rect = snippetItemContextMenu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  snippetItemContextMenu.style.left = `${left}px`;
  snippetItemContextMenu.style.top = `${top}px`;
}

async function editSnippetById(snippetId) {
  const snippet = terminalCommandSnippets.find((item) => item.id === snippetId);
  if (!snippet) return;
  const next = await openSnippetEditDialog({
    title: t("snippets.dialog.edit_title"),
    name: snippet.title,
    group: snippet.group || defaultSnippetGroupLabel(),
    command: snippet.command,
  });
  if (!next) return;
  try {
    await invoke("update_snippet", {
      id: snippet.id,
      input: {
        title: next.name,
        command: next.command,
        group: normalizeSnippetGroup(next.group),
        sortOrder: snippet.sortOrder || 0,
      },
    });
  } catch (e) {
    alert(t("snippets.error.save_failed", { error: e }));
    return;
  }
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
}

async function deleteSnippetById(snippetId) {
  if (!snippetId) return;
  try {
    await invoke("delete_snippet", { id: snippetId });
  } catch (e) {
    alert(t("snippets.error.delete_failed", { error: e }));
    return;
  }
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
}

function fuzzyMatchText(query, text) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return true;
  const source = String(text || "").toLowerCase();
  let qi = 0;
  for (let i = 0; i < source.length && qi < q.length; i += 1) {
    if (source[i] === q[qi]) qi += 1;
  }
  return qi === q.length;
}

function renderTerminalCommandSnippets() {
  if (!terminalSnippetsList || !terminalSnippetsEmpty) return;
  terminalSnippetsList.innerHTML = "";
  const hasSearch = Boolean(String(terminalSnippetSearchQuery || "").trim());
  const filteredSnippets = terminalCommandSnippets.filter((snippet) => fuzzyMatchText(
    terminalSnippetSearchQuery,
    `${snippet.title}\n${snippet.command}`,
  ));
  const hasSnippets = filteredSnippets.length > 0;
  terminalSnippetsEmpty.hidden = hasSnippets;
  terminalSnippetsList.hidden = !hasSnippets;
  const grouped = new Map();
  for (const snippet of filteredSnippets) {
    const group = snippet.group || defaultSnippetGroupLabel();
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(snippet);
  }
  for (const [group, items] of grouped) {
    const section = document.createElement("section");
    section.className = "terminal-snippet-group";
    const expanded = hasSearch ? true : terminalSnippetGroupExpanded[group] === true;
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "terminal-snippet-group-title";
    heading.setAttribute("aria-expanded", expanded ? "true" : "false");
    heading.innerHTML = `<span class="terminal-snippet-group-label">${escapeMetricText(group)}</span><span class="terminal-snippet-group-meta"><span class="terminal-snippet-group-count">${items.length}</span><span class="terminal-snippet-group-chevron">${expanded ? "▾" : "▸"}</span></span>`;
    heading.addEventListener("click", () => {
      terminalSnippetGroupExpanded[group] = !expanded;
      saveTerminalSnippetGroupState();
      renderTerminalCommandSnippets();
    });
    heading.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showSnippetGroupContextMenu(group, ev.clientX, ev.clientY);
    });
    section.appendChild(heading);
    if (!expanded) {
      terminalSnippetsList.appendChild(section);
      continue;
    }
    for (const snippet of items) {
    const card = document.createElement("article");
    card.className = "terminal-snippet-card";
    card.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showSnippetItemContextMenu(snippet.id, ev.clientX, ev.clientY);
    });

    const title = document.createElement("h4");
    title.textContent = snippet.title;

    const pre = document.createElement("pre");
    pre.textContent = snippet.command;

    const actions = document.createElement("div");
    actions.className = "terminal-snippet-actions";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.textContent = t("snippets.action.run");
    runBtn.addEventListener("click", async () => {
      try {
        await runSnippetInActiveTerminal(snippet.command);
        showToast(t("snippets.toast.ran"), "success", 1800);
      } catch (e) {
        alert(t("snippets.error.run_failed", { error: e }));
      }
    });

    const insertBtn = document.createElement("button");
    insertBtn.type = "button";
    insertBtn.textContent = t("snippets.action.insert");
    insertBtn.addEventListener("click", async () => {
      try {
        await sendSnippetToActiveTerminal(snippet.command);
        showToast(t("snippets.toast.inserted"), "success", 1800);
      } catch (e) {
        alert(t("snippets.error.insert_failed", { error: e }));
      }
    });

    actions.append(runBtn, insertBtn);
    card.append(title, pre, actions);
    section.appendChild(card);
    }
    terminalSnippetsList.appendChild(section);
  }
}

function syncAiContextToggle() {
  if (!aiContextToggle) return;
  const labels = {
    always: t("ai.context.mode.always"),
    off: t("ai.context.mode.off"),
  };
  aiContextToggle.textContent = labels[aiContextMode];
  aiContextToggle.dataset.mode = aiContextMode;
}

function updateAiSendButton() {
  const button = aiComposeForm?.querySelector("button[type='submit']");
  if (!button) return;
  const state = getAiRequestState();
  button.disabled = state.canceling;
  button.setAttribute("aria-label", state.sending ? "停止 AI 分析" : "发送给 AI");
  button.title = state.sending ? "停止 AI 分析" : "发送给 AI";
  button.classList.toggle("is-stop", state.sending);
  button.innerHTML = state.sending
    ? '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'
    : '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(24 0) scale(-1 1)"><path d="M4 12 20 5l-4 14-4.5-5-3 1.5 1.5-3Z"></path><path d="M10 14 20 5"></path></g></svg>';
}

async function cancelAiStreaming() {
  const state = getAiRequestState();
  if (!state.sending || !state.activeRequestId || state.canceling) return;
  state.canceling = true;
  updateAiSendButton();
  try {
    await invoke("cancel_ai_chat_stream", { requestId: state.activeRequestId });
  } catch (e) {
    showToast(String(e), "error", 2600);
  } finally {
    state.canceling = false;
    updateAiSendButton();
  }
}

function getAiModelValue() {
  return settingsAiModel?.value || settingsAiModelCustom?.value || "";
}

function syncAiModelPill(model) {
  if (!aiModelPill) return;
  const active = getActiveAiProfile();
  const value = String(model || (active ? active.model : "") || currentAiModelLabel || "").trim();
  if (value) currentAiModelLabel = value;
  // Only show the model name when the active profile is fully usable (key + model).
  const label = aiConfigured && value ? value : t("ai.model.unconfigured");
  aiModelPill.replaceChildren();
  const dot = document.createElement("span");
  dot.setAttribute("aria-hidden", "true");
  aiModelPill.append(dot, document.createTextNode(label));
  aiModelPill.title = aiConfigured && active
    ? `${active.name || active.provider} · ${value} · ${t("ai.model.switch_title")}`
    : t("ai.model.unconfigured");
  aiModelPill.classList.toggle("ai-pill-unconfigured", !aiConfigured || !value);
}

function getActiveAiProfile() {
  return aiStore.profiles.find((p) => p.id === aiStore.activeProfileId) || null;
}

// Mirror the backend store into local state + refresh the pill and the
// settings list. Called after every command that returns the store.
function applyAiStore(store) {
  aiStore = store && Array.isArray(store.profiles)
    ? store
    : { version: 2, profiles: [], activeProfileId: "" };
  aiConfigLoaded = true;
  const active = getActiveAiProfile();
  aiConfigured = Boolean(active && active.hasApiKey && String(active.model || "").trim());
  currentAiModelLabel = active ? String(active.model || "") : "";
  syncAiModelPill(active ? active.model : "");
  renderAiProfileList();
}

function renderAiProfileList() {
  if (!settingsAiProfiles) return;
  settingsAiProfiles.replaceChildren();
  const profiles = Array.isArray(aiStore.profiles) ? aiStore.profiles : [];
  if (settingsAiEmpty) settingsAiEmpty.hidden = profiles.length > 0;
  for (const p of profiles) {
    const isActive = p.id === aiStore.activeProfileId;
    const row = document.createElement("div");
    row.className = "settings-ai-profile" + (isActive ? " active" : "");

    const info = document.createElement("div");
    info.className = "settings-ai-profile-info";
    const name = document.createElement("strong");
    name.textContent = p.name || p.provider || p.id;
    if (isActive) {
      const badge = document.createElement("span");
      badge.className = "settings-ai-profile-badge";
      badge.textContent = t("settings.ai.profile.active");
      name.appendChild(badge);
    }
    const meta = document.createElement("small");
    const bits = [p.provider, p.model].filter(Boolean);
    meta.textContent = bits.join(" · ") + (p.hasApiKey ? "" : ` · ${t("settings.ai.profile.no_key")}`);
    info.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "settings-ai-profile-actions";
    if (!isActive) {
      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.title = t("settings.ai.profile.set_active");
      useBtn.setAttribute("aria-label", useBtn.title);
      useBtn.innerHTML = svgIcon('<path d="M19 7H6.8"></path><path d="m14.5 3 4 4-4 4"></path><path d="M5 17h12.2"></path><path d="m9.5 21-4-4 4-4"></path>');
      useBtn.addEventListener("click", () => setActiveAiProfileById(p.id));
      actions.appendChild(useBtn);
    }
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.title = t("settings.ai.profile.edit");
    editBtn.setAttribute("aria-label", editBtn.title);
    editBtn.innerHTML = svgIcon('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>');
    editBtn.addEventListener("click", () => editAiProfile(p.id));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "danger";
    delBtn.title = t("settings.ai.profile.delete");
    delBtn.setAttribute("aria-label", delBtn.title);
    delBtn.innerHTML = svgIcon('<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>');
    delBtn.addEventListener("click", () => deleteAiProfileById(p.id));
    actions.append(editBtn, delBtn);

    row.append(info, actions);
    settingsAiProfiles.appendChild(row);
  }
}

function setAiModelMenuOpen(open) {
  if (!aiModelMenu || !aiModelPill) return;
  aiModelPill.setAttribute("aria-expanded", open ? "true" : "false");
  aiModelMenu.hidden = !open;
  if (open) {
    renderAiModelMenu();
    loadAiConfig().then(() => {
      if (aiModelMenu?.hidden === false) renderAiModelMenu();
    }).catch(() => {});
  }
}

async function setActiveAiProfileById(id) {
  try {
    const store = await invoke("set_active_ai_profile", { id });
    applyAiStore(store);
    showToast(t("settings.ai.status.saved"), "success", 1500);
  } catch (e) {
    showToast(String(e), "error", 4200);
  }
}

async function switchActiveProfileFromPill(id) {
  setAiModelMenuOpen(false);
  await setActiveAiProfileById(id);
}

async function switchActiveProfileModelFromPill(model) {
  const active = getActiveAiProfile();
  if (!active) return;
  setAiModelMenuOpen(false);
  try {
    const store = await invoke("set_ai_profile_model", { input: { id: active.id, model } });
    applyAiStore(store);
  } catch (e) {
    showToast(String(e), "error", 4200);
  }
}

function showAiEditor(show) {
  if (!aiConfigOverlay) return;
  aiConfigOverlay.hidden = !show;
}

function startNewAiProfile() {
  aiEditingProfileId = "";
  if (settingsAiName) settingsAiName.value = "";
  if (settingsAiProvider) {
    settingsAiProvider.value = "openai-compatible";
    syncCustomSelect("settings-ai-provider");
  }
  if (settingsAiBaseUrl) settingsAiBaseUrl.value = "";
  if (settingsAiApiKey) settingsAiApiKey.value = "";
  setAiModelOptions([], "");
  if (settingsAiReasoningEffort) settingsAiReasoningEffort.value = "";
  if (settingsAiStatus) settingsAiStatus.textContent = t("settings.ai.status.unsaved");
  lastAutoAiModelsKey = "";
  if (aiConfigTitle) aiConfigTitle.textContent = t("settings.ai.profile.new");
  showAiEditor(true);
  settingsAiName?.focus?.();
}

function editAiProfile(id) {
  const p = aiStore.profiles.find((x) => x.id === id);
  if (!p) return;
  aiEditingProfileId = id;
  if (settingsAiName) settingsAiName.value = p.name || "";
  if (settingsAiProvider) {
    settingsAiProvider.value = p.provider || "openai-compatible";
    syncCustomSelect("settings-ai-provider");
  }
  if (settingsAiBaseUrl) settingsAiBaseUrl.value = p.baseUrl || "";
  if (settingsAiApiKey) settingsAiApiKey.value = "";
  if (settingsAiReasoningEffort) settingsAiReasoningEffort.value = p.reasoningEffort || "";
  setAiModelOptions(Array.isArray(p.models) ? p.models : [], p.model || "");
  if (settingsAiStatus) {
    settingsAiStatus.textContent = p.hasApiKey
      ? t("settings.ai.status.ready")
      : t("settings.ai.status.no_key");
  }
  lastAutoAiModelsKey = "";
  if (aiConfigTitle) aiConfigTitle.textContent = t("settings.ai.profile.edit_title");
  showAiEditor(true);
  maybeAutoRefreshAiModels().catch(() => {});
}

function cancelAiEditor() {
  aiEditingProfileId = null;
  showAiEditor(false);
}

async function deleteAiProfileById(id) {
  const p = aiStore.profiles.find((x) => x.id === id);
  const label = p ? (p.name || p.provider || id) : id;
  if (!confirm(t("settings.ai.profile.confirm_delete", { name: label }))) return;
  try {
    const store = await invoke("delete_ai_profile", { id });
    applyAiStore(store);
    if (aiEditingProfileId === id) cancelAiEditor();
  } catch (e) {
    showToast(String(e), "error", 4200);
  }
}

function renderAiModelMenu() {
  if (!aiModelMenu) return;
  aiModelMenu.replaceChildren();
  const active = getActiveAiProfile();

  // --- Section: profiles (switch the global active config) ---
  const profHeader = document.createElement("div");
  profHeader.className = "ai-model-menu-section";
  profHeader.textContent = t("ai.profile.section");
  aiModelMenu.appendChild(profHeader);

  const profiles = Array.isArray(aiStore.profiles) ? aiStore.profiles : [];
  if (profiles.length === 0) {
    const empty = document.createElement("div");
    empty.className = "ai-model-menu-empty";
    empty.textContent = t("ai.profile.empty");
    aiModelMenu.appendChild(empty);
  } else {
    for (const p of profiles) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ai-model-menu-item ai-profile-menu-item" + (active && p.id === active.id ? " active" : "");
      const name = document.createElement("span");
      name.textContent = p.name || p.provider || p.id;
      const meta = document.createElement("small");
      meta.textContent = p.model || "—";
      item.append(name, meta);
      item.addEventListener("click", (ev) => {
        ev.stopPropagation();
        switchActiveProfileFromPill(p.id);
      });
      aiModelMenu.appendChild(item);
    }
  }

  // --- Section: models within the active profile (quick model switch) ---
  if (active) {
    const modHeader = document.createElement("div");
    modHeader.className = "ai-model-menu-section";
    modHeader.textContent = t("ai.model.section");
    aiModelMenu.appendChild(modHeader);

    const list = [];
    for (const m of [active.model, ...(Array.isArray(active.models) ? active.models : [])]) {
      const v = String(m || "").trim();
      if (v && !list.includes(v)) list.push(v);
    }
    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ai-model-menu-empty";
      empty.textContent = t("ai.model.empty");
      aiModelMenu.appendChild(empty);
    } else {
      for (const m of list) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "ai-model-menu-item" + (m === active.model ? " active" : "");
        item.textContent = m;
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          switchActiveProfileModelFromPill(m);
        });
        aiModelMenu.appendChild(item);
      }
    }

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ai-model-menu-refresh";
    refresh.textContent = t("settings.ai.model.refresh");
    refresh.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      try {
        const res = await invoke("list_ai_models_for_profile", { id: active.id });
        const cur = getActiveAiProfile();
        if (cur) cur.models = res?.models || [];
        renderAiModelMenu();
        showToast(t("settings.ai.toast.models_refreshed"), "success", 1800);
      } catch (e) {
        showToast(String(e), "error", 4200);
      }
    });
    aiModelMenu.appendChild(refresh);
  }

  // --- Manage profiles in Settings ---
  const manage = document.createElement("button");
  manage.type = "button";
  manage.className = "ai-model-menu-manage";
  manage.textContent = t("ai.profile.manage");
  manage.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setAiModelMenuOpen(false);
    openSettingsPage();
    setSettingsSection("ai");
  });
  aiModelMenu.appendChild(manage);
}

async function refreshAiModelsOnFirstPanelOpen() {
  if (aiModelsRefreshedOnFirstOpen) return;
  await loadAiConfig().catch(() => {});
  aiModelsRefreshedOnFirstOpen = true;
  const active = getActiveAiProfile();
  if (!active || !active.hasApiKey) return;
  try {
    const res = await invoke("list_ai_models_for_profile", { id: active.id });
    const cur = getActiveAiProfile();
    if (cur) cur.models = res?.models || [];
    if (aiModelMenu?.hidden === false) renderAiModelMenu();
  } catch (e) {
    console.warn("refresh AI models on first panel open failed", e);
  }
}

function setAiModelOptions(models, selected) {
  if (!settingsAiModel) return;
  const current = selected || getAiModelValue();
  settingsAiModel.textContent = "";
  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = t("settings.ai.model.custom_label");
  settingsAiModel.appendChild(custom);
  for (const model of models || []) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    settingsAiModel.appendChild(option);
  }
  if (current && Array.from(settingsAiModel.options).some((o) => o.value === current)) {
    settingsAiModel.value = current;
    if (settingsAiModelCustom) settingsAiModelCustom.value = "";
  } else {
    settingsAiModel.value = "";
    if (settingsAiModelCustom) settingsAiModelCustom.value = current || "";
  }
  syncCustomSelect("settings-ai-model");
}

function cycleAiContextMode() {
  const idx = AI_CONTEXT_MODES.indexOf(aiContextMode);
  aiContextMode = AI_CONTEXT_MODES[(idx + 1) % AI_CONTEXT_MODES.length];
  localStorage.setItem("zt.ai.contextMode", aiContextMode);
  syncAiContextToggle();
}

function isAiPanelNearBottom() {
  if (!aiAssistantBody) return true;
  return aiAssistantBody.scrollHeight - aiAssistantBody.scrollTop - aiAssistantBody.clientHeight < 80;
}

function scrollAiPanelToBottom({ force = false } = {}) {
  if (!aiAssistantBody) return;
  if (!force && !isAiPanelNearBottom()) return;
  requestAnimationFrame(() => {
    aiAssistantBody.scrollTop = aiAssistantBody.scrollHeight;
  });
}

function setAiPanelCollapsed(collapsed) {
  setTerminalSidePanel(collapsed ? null : "ai");
  if (terminalSidebarAiToggle) {
    const label = aiPanelCollapsed ? t("ai.panel.expand") : t("ai.panel.collapse");
    terminalSidebarAiToggle.title = label;
    terminalSidebarAiToggle.setAttribute("aria-label", label);
  }
}

function toggleAiPanel() {
  setTerminalSidePanel(terminalActiveSidePanel === "ai" ? null : "ai");
}

function getAiPaneKey() {
  const pane = getActivePane();
  if (!pane) return "no-terminal";
  return pane.sessionId !== null ? `session:${pane.sessionId}` : `pane:${pane.id}`;
}

// FE-3: drop every per-pane / per-session Map entry for a torn-down pane or
// session so these Maps don't grow unbounded. session:/pane: keys are minted
// monotonically and never reused, so an evicted key is never looked up again.
// `no-terminal` is the shared fallback key and must never be evicted here.
function forgetAiPaneState(paneKey) {
  if (!paneKey || paneKey === "no-terminal") return;
  aiRequestStateByPane.delete(paneKey);
  aiConversationByPane.delete(paneKey);
  terminalSidePanelByPane.delete(paneKey);
  // aiSessionIdentityByPane is keyed by `${scopeType}:${scopeId}:${paneKey}`,
  // so evict every scope whose entry belongs to this pane/session.
  const suffix = `:${paneKey}`;
  for (const key of Array.from(aiSessionIdentityByPane.keys())) {
    if (key.endsWith(suffix)) aiSessionIdentityByPane.delete(key);
  }
}

function getAiSessionScope() {
  const pane = getActivePane();
  if (!pane) {
    return { scopeType: "global", scopeId: "global", scopeLabel: t("ai.session.scope.global") };
  }
  if (pane.isLocal) {
    return { scopeType: "local", scopeId: "local", scopeLabel: t("ai.session.scope.local") };
  }
  const host = pane.host;
  if (host?.id) {
    const user = String(host.user || "").trim();
    const hostname = String(host.host || "").trim();
    const port = Number(host.port || 22);
    const target = [user, hostname].filter(Boolean).join("@");
    const label = host.name || (target ? `${target}${port && port !== 22 ? `:${port}` : ""}` : t("ai.session.scope.ssh"));
    return { scopeType: "host", scopeId: String(host.id), scopeLabel: label };
  }
  return { scopeType: "global", scopeId: "global", scopeLabel: t("ai.session.scope.global") };
}

function isAiSessionInCurrentScope(item) {
  const scope = getAiSessionScope();
  return String(item?.scopeType || "global") === scope.scopeType
    && String(item?.scopeId || item?.scopeType || "global") === scope.scopeId;
}

function aiSessionIdentityKey() {
  const scope = getAiSessionScope();
  return `${scope.scopeType}:${scope.scopeId}:${getAiPaneKey()}`;
}

function newAiSessionId() {
  return `ai-session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function aiSessionTitle(messages = aiMessages) {
  const firstUser = (messages || []).find((m) => m.role === "user" && String(m.content || "").trim());
  const raw = String(firstUser?.content || t("ai.session.new_title")).replace(/\s+/g, " ").trim();
  return raw.length > 36 ? `${raw.slice(0, 36)}...` : raw;
}

function resetAiSessionIdentity() {
  aiCurrentSessionId = "";
  aiCurrentSessionCreatedAt = 0;
  aiCurrentSessionTemporary = false;
  aiSessionIdentityByPane.delete(aiSessionIdentityKey());
}

function clearAiSessionIdentitiesForScope(scope = null) {
  if (!scope) {
    aiSessionIdentityByPane.clear();
    resetAiSessionIdentity();
    return;
  }
  const prefix = `${scope.scopeType}:${scope.scopeId}:`;
  for (const key of Array.from(aiSessionIdentityByPane.keys())) {
    if (key.startsWith(prefix)) aiSessionIdentityByPane.delete(key);
  }
  resetAiSessionIdentity();
}

function normalizeAiSessionMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: String(message?.role || "user"),
      content: String(message?.content || ""),
      reasoningContent: String(message?.reasoningContent || ""),
      commandResults: Array.isArray(message?.commandResults)
        ? message.commandResults.map((result) => ({
          command: String(result?.command || ""),
          output: typeof result?.output === "string" ? result.output : "",
        })).filter((result) => result.command.trim())
        : [],
      continuedCommandCount: message?.continuedCommandCount === null || message?.continuedCommandCount === undefined
        ? null
        : Number.isFinite(Number(message.continuedCommandCount))
          ? Number(message.continuedCommandCount)
          : null,
    }))
    .filter((message) => ["user", "assistant", "error"].includes(message.role) && (message.content.trim() || message.reasoningContent.trim()));
}

async function persistCurrentAiSession() {
  const messages = normalizeAiSessionMessages(aiMessages);
  if (!messages.length) return;
  if (aiCurrentSessionTemporary) return;
  const now = Date.now();
  if (!aiCurrentSessionId) {
    aiCurrentSessionId = newAiSessionId();
    aiCurrentSessionCreatedAt = now;
  }
  const scope = getAiSessionScope();
  const input = {
    id: aiCurrentSessionId,
    title: aiSessionTitle(messages),
    createdAt: aiCurrentSessionCreatedAt || now,
    updatedAt: now,
    paneKey: getAiPaneKey(),
    scopeType: scope.scopeType,
    scopeId: scope.scopeId,
    scopeLabel: scope.scopeLabel,
    messages,
  };
  try {
    const saved = await invoke("save_ai_session", { input });
    aiCurrentSessionCreatedAt = saved?.createdAt || input.createdAt;
    aiSessionIdentityByPane.set(aiSessionIdentityKey(), {
      id: aiCurrentSessionId,
      createdAt: aiCurrentSessionCreatedAt,
      temporary: false,
    });
    await loadAiSessions({ render: true });
  } catch (e) {
    console.warn("save AI session failed", e);
  }
}

function formatAiSessionTime(ts) {
  const n = Number(ts || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderAiSessions() {
  if (!aiSessionList || !aiSessionEmpty) return;
  syncAiSessionModeUi();
  aiSessionList.textContent = "";
  const scope = getAiSessionScope();
  if (aiSessionScopeLabel) {
    aiSessionScopeLabel.textContent = aiSessionFilter === "current"
      ? t("ai.session.desc.current", { scope: scope.scopeLabel })
      : t("ai.session.desc.all");
  }
  aiSessionCurrentFilter?.classList.toggle("active", aiSessionFilter === "current");
  aiSessionAllFilter?.classList.toggle("active", aiSessionFilter === "all");
  if (aiSessionClear) {
    aiSessionClear.textContent = aiSessionFilter === "current" ? t("ai.session.clear.current") : t("ai.session.clear.all");
  }
  const allItems = Array.isArray(aiSessionItems) ? aiSessionItems : [];
  const items = aiSessionFilter === "current" ? allItems.filter(isAiSessionInCurrentScope) : allItems;
  const hasTemporary = aiCurrentSessionTemporary;
  aiSessionEmpty.hidden = hasTemporary || items.length > 0;
  aiSessionEmpty.textContent = aiSessionFilter === "current" ? t("ai.session.empty.current") : t("ai.session.empty.all");
  if (hasTemporary) {
    const row = document.createElement("div");
    row.setAttribute("role", "status");
    row.className = "ai-session-item active temporary";
    const title = document.createElement("strong");
    title.textContent = t("ai.session.temp_title");
    const meta = document.createElement("span");
    const scope = getAiSessionScope();
    meta.textContent = aiSessionFilter === "all"
      ? `${scope.scopeLabel} | ${t("ai.session.temp_meta")}`
      : t("ai.session.temp_meta");
    row.append(title, meta);
    aiSessionList.appendChild(row);
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    row.className = "ai-session-item";
    row.classList.toggle("active", item.id === aiCurrentSessionId);
    const inCurrentScope = isAiSessionInCurrentScope(item);
    row.classList.toggle("out-of-scope", !inCurrentScope);
    if (!inCurrentScope) row.title = t("ai.session.toast.need_scope");
    const title = document.createElement("strong");
    title.textContent = item.title || aiSessionTitle(item.messages);
    const meta = document.createElement("span");
    const scopeLabel = item.scopeLabel || t("ai.session.scope.global");
    const messageCount = t("ai.session.meta.messages", { count: (item.messages || []).length });
    meta.textContent = aiSessionFilter === "all"
      ? `${scopeLabel} · ${formatAiSessionTime(item.updatedAt)} · ${messageCount}`
      : `${formatAiSessionTime(item.updatedAt)} · ${messageCount}`;
    row.append(title, meta);
    row.addEventListener("click", () => restoreAiSessionItem(item));
    row.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      restoreAiSessionItem(item);
    });
    aiSessionList.appendChild(row);
  }
}

async function loadAiSessions({ render = false } = {}) {
  try {
    aiSessionItems = await invoke("list_ai_sessions");
  } catch (e) {
    console.warn("load AI sessions failed", e);
    aiSessionItems = [];
  }
  if (render) renderAiSessions();
}

function setAiSessionOpen(open) {
  aiSessionOpen = Boolean(open);
  if (aiSessionOverlay) aiSessionOverlay.hidden = !aiSessionOpen;
  aiSessionToggle?.classList.toggle("active", aiSessionOpen);
  if (aiSessionOpen) {
    loadAiSessions({ render: true });
  }
}

function restoreAiSessionItem(item) {
  if (!isAiSessionInCurrentScope(item)) {
    showToast(t("ai.session.toast.need_scope"), "error", 3200);
    return;
  }
  aiCurrentSessionId = String(item?.id || "");
  aiCurrentSessionCreatedAt = Number(item?.createdAt || item?.updatedAt || Date.now());
  aiCurrentSessionTemporary = false;
  aiMessages = normalizeAiSessionMessages(item?.messages || []);
  storeAiConversationForActivePane({ persist: false });
  renderAiConversation();
  renderAiSessions();
  setAiSessionOpen(false);
}

function startNewAiConversation({ temporary = false } = {}) {
  aiMessages = [];
  resetAiSessionIdentity();
  aiCurrentSessionTemporary = Boolean(temporary);
  storeAiConversationForActivePane({ persist: false });
  renderAiConversation();
  renderAiSessions();
}

function renderAiConversation() {
  if (!aiChatLog) return;
  syncAiSessionModeUi();
  aiChatLog.textContent = "";
  const messages = aiMessages || [];
  aiChatLog.hidden = messages.length === 0;
  if (aiEmptyState) aiEmptyState.hidden = messages.length > 0;
  for (const message of messages) {
    appendAiMessage(message.role, message.content, { skipStore: true, message });
  }
}

function syncAiConversationToActivePane() {
  const key = getAiPaneKey();
  if (key === aiActivePaneKey) return;
  aiActivePaneKey = key;
  aiMessages = aiConversationByPane.get(key) || [];
  const identity = aiSessionIdentityByPane.get(aiSessionIdentityKey()) || {};
  aiCurrentSessionId = identity.id || "";
  aiCurrentSessionCreatedAt = identity.createdAt || 0;
  aiCurrentSessionTemporary = identity.temporary === true;
  renderAiConversation();
  updateAiSendButton();
}

function syncAiSessionModeUi() {
  if (aiTempChatButton) aiTempChatButton.classList.toggle("active", aiCurrentSessionTemporary);
  if (aiSessionModeBadge) {
    aiSessionModeBadge.hidden = !aiCurrentSessionTemporary;
    aiSessionModeBadge.textContent = t("ai.session.temp_title");
  }
  if (aiAssistantSubtitle) {
    aiAssistantSubtitle.textContent = aiCurrentSessionTemporary
      ? `${t("ai.assistant.subtitle")} · ${t("ai.session.temp_meta")}`
      : t("ai.assistant.subtitle");
  }
}

function storeAiConversationForActivePane({ persist = true } = {}) {
  const key = getAiPaneKey();
  aiActivePaneKey = key;
  aiConversationByPane.set(key, aiMessages);
  aiSessionIdentityByPane.set(aiSessionIdentityKey(), {
    id: aiCurrentSessionId,
    createdAt: aiCurrentSessionCreatedAt,
    temporary: aiCurrentSessionTemporary,
  });
  if (persist) {
    persistCurrentAiSession();
  }
}

// FE-6: AI-returned markdown links are attacker-influenced, so restrict the
// href to a safe-protocol allowlist. Strips control chars / surrounding
// whitespace and parses defensively; `javascript:`, `data:`, etc. (in any
// case) fall back to "#".
function safeAiLinkHref(raw) {
  const cleaned = String(raw ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned) return "#";
  let url;
  try {
    url = new URL(cleaned);
  } catch {
    return "#";
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
    return url.href;
  }
  return "#";
}

function renderAiMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  let tableLines = null;
  let codeLines = null;
  let codeLang = "";

  const renderInline = (value) => {
    const frag = document.createDocumentFragment();
    const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    String(value || "").replace(re, (match, _token, offset) => {
      if (offset > last) frag.appendChild(document.createTextNode(value.slice(last, offset)));
      if (match.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = match.slice(1, -1);
        if (looksRunnableInlineCommand(code.textContent)) {
          code.classList.add("ai-inline-command");
          code.title = "点击批准执行";
          code.addEventListener("click", () => requestAiCommandApproval(code.textContent));
        }
        frag.appendChild(code);
      } else if (match.startsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = match.slice(2, -2);
        frag.appendChild(strong);
      } else {
        const link = match.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const a = document.createElement("a");
        a.textContent = link?.[1] || match;
        a.href = safeAiLinkHref(link?.[2]);
        a.target = "_blank";
        a.rel = "noreferrer";
        frag.appendChild(a);
      }
      last = offset + match.length;
      return match;
    });
    if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
    return frag;
  };

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement("p");
    p.appendChild(renderInline(paragraph.join("\n")));
    fragment.appendChild(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    fragment.appendChild(list);
    list = null;
  };
  const flushTable = () => {
    if (!tableLines?.length || tableLines.length < 2) {
      tableLines = null;
      return;
    }
    const rows = tableLines.map(splitMarkdownTableCells).filter((cells) => cells.length);
    if (rows.length < 2) {
      tableLines = null;
      return;
    }
    const wrap = document.createElement("div");
    wrap.className = "ai-table-wrap";
    const table = document.createElement("table");
    table.className = "ai-md-table";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    rows[0].forEach((cell) => {
      const th = document.createElement("th");
      const status = markdownTableCellStatus(cell);
      if (status) th.classList.add(`is-${status}`);
      th.appendChild(renderInline(cell));
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    if (rows.length > 2) {
      const tbody = document.createElement("tbody");
      rows.slice(2).forEach((cells) => {
        const tr = document.createElement("tr");
        rows[0].forEach((_cell, index) => {
          const td = document.createElement("td");
          const cell = cells[index] || "";
          const status = markdownTableCellStatus(cell);
          if (status) td.classList.add(`is-${status}`);
          td.appendChild(renderInline(cell));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
    }
    wrap.appendChild(table);
    fragment.appendChild(wrap);
    tableLines = null;
  };
  const flushCode = () => {
    if (!codeLines) return;
    const block = document.createElement("div");
    block.className = "ai-code-block";
    block.dataset.lang = (codeLang || "").toLowerCase();
    if (codeLang) {
      const label = document.createElement("div");
      label.className = "ai-code-label";
      label.textContent = codeLang;
      block.appendChild(label);
    }
    const pre = document.createElement("pre");
    pre.textContent = codeLines.join("\n");
    block.appendChild(pre);
    fragment.appendChild(block);
    codeLines = null;
    codeLang = "";
  };

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const fence = rawLine.match(/^\s*```\s*([\w-]+)?\s*$/);
    if (fence) {
      if (codeLines) {
        flushCode();
      } else {
        flushParagraph();
        flushList();
        flushTable();
        codeLines = [];
        codeLang = fence[1] || "";
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(rawLine);
      continue;
    }
    const line = rawLine.trim();
    if (tableLines) {
      if (isMarkdownTableRow(line)) {
        tableLines.push(line);
        continue;
      }
      flushTable();
    }
    if (!line) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      const level = Math.min(heading[1].length + 1, 5);
      const h = document.createElement(`h${level}`);
      h.className = "ai-md-heading";
      h.appendChild(renderInline(heading[2]));
      fragment.appendChild(h);
      continue;
    }
    if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
      flushParagraph();
      flushList();
      flushTable();
      const hr = document.createElement("hr");
      hr.className = "ai-md-divider";
      fragment.appendChild(hr);
      continue;
    }
    const nextLine = String(lines[i + 1] || "").trim();
    if (isMarkdownTableRow(line) && isMarkdownTableDivider(nextLine)) {
      flushParagraph();
      flushList();
      tableLines = [line, nextLine];
      i += 1;
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      flushTable();
      if (!list) list = document.createElement(numbered ? "ol" : "ul");
      const li = document.createElement("li");
      li.appendChild(renderInline((bullet || numbered)[1]));
      list.appendChild(li);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushCode();
  flushParagraph();
  flushList();
  flushTable();
  return fragment;
}

function isMarkdownTableRow(line) {
  const text = String(line || "").trim();
  return text.includes("|") && /^\|?.+\|.+\|?$/.test(text);
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitMarkdownTableCells(line) {
  const text = String(line || "").trim();
  if (!text) return [];
  const normalized = text.replace(/^\|/, "").replace(/\|$/, "");
  return normalized.split("|").map((cell) => cell.trim());
}

function markdownTableCellStatus(cell) {
  const text = String(cell || "").trim();
  if (!text) return "";
  if (/^(?:✅|✔️|✓)\b/.test(text)) return "ok";
  if (/^(?:⚠️|⚠|!+)\b/.test(text)) return "warn";
  if (/^(?:❌|✖|✗|x)\b/i.test(text)) return "danger";
  return "";
}

function ensureAiMessageParts(node) {
  const body = node?.querySelector?.(".ai-message-body");
  if (!body) return null;

  let contentWrap = body.querySelector(":scope > .ai-message-content");
  if (!contentWrap) {
    contentWrap = document.createElement("div");
    contentWrap.className = "ai-message-content";
  }

  let actionsSlot = body.querySelector(":scope > .ai-message-actions-slot");
  if (!actionsSlot) {
    actionsSlot = document.createElement("div");
    actionsSlot.className = "ai-message-actions-slot";
  }

  const thinkingBlock = body.querySelector(":scope > .ai-thinking-block");
  if (thinkingBlock) body.appendChild(thinkingBlock);
  body.appendChild(contentWrap);
  body.appendChild(actionsSlot);

  return { body, thinkingBlock, contentWrap, actionsSlot };
}

function looksRunnableInlineCommand(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 140 || text.includes("\n")) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(text)) return false;
  if (looksLikeHeredocStart(text)) return false;
  if (/^(if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b/.test(text)) return false;
  return /^(sudo\s+)?[a-z][\w.-]*(\s+|$)/i.test(text);
}

function setAiMessageContent(node, content) {
  const body = node?.querySelector?.(".ai-message-body");
  if (!body) return;
  const shouldStickToBottom = isAiPanelNearBottom();
  if (node.classList.contains("ai-message-assistant")) {
    const parts = ensureAiMessageParts(node);
    if (!parts) return;
    parts.thinkingBlock?.remove();
    parts.contentWrap.textContent = "";
    parts.contentWrap.appendChild(renderAiMarkdown(content));
    enhanceAiCodeBlocks(body);
  } else if (node.classList.contains("ai-message-error")) {
    body.textContent = "";
    body.appendChild(renderAiError(content));
  } else {
    body.textContent = "";
    body.textContent = content;
  }
  scrollAiPanelToBottom({ force: shouldStickToBottom });
}

function updateAiMessageWithReasoning(node, reasoning, content) {
  const parts = ensureAiMessageParts(node);
  if (!parts) return;
  const { body, contentWrap } = parts;
  const shouldStickToBottom = isAiPanelNearBottom();
  // Preserve user's manual expand state on the thinking block
  let thinkingBlock = parts.thinkingBlock;
  const wasOpen = thinkingBlock?.open;
  if (reasoning) {
    if (!thinkingBlock) {
      thinkingBlock = renderAiThinkingBlock(reasoning);
      body.insertBefore(thinkingBlock, contentWrap);
    } else {
      const contentDiv = thinkingBlock.querySelector(".ai-thinking-content");
      if (contentDiv) {
        contentDiv.textContent = "";
        contentDiv.appendChild(renderAiMarkdown(reasoning));
      }
    }
    if (wasOpen) thinkingBlock.open = true;
  } else if (thinkingBlock) {
    thinkingBlock.remove();
    thinkingBlock = null;
  }
  if (content) {
    contentWrap.textContent = "";
    contentWrap.appendChild(renderAiMarkdown(content));
  } else {
    contentWrap.textContent = "";
  }
  ensureAiMessageParts(node);
  enhanceAiCodeBlocks(body);
  scrollAiPanelToBottom({ force: shouldStickToBottom });
}

function renderAiThinkingBlock(reasoning) {
  const details = document.createElement("details");
  details.className = "ai-thinking-block";
  const summary = document.createElement("summary");
  summary.className = "ai-thinking-summary";
  summary.textContent = "🤔 思考过程";
  details.appendChild(summary);
  const content = document.createElement("div");
  content.className = "ai-thinking-content";
  content.appendChild(renderAiMarkdown(reasoning));
  details.appendChild(content);
  return details;
}

function parseAiErrorMessage(error) {
  const raw = String(error || "");
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const err = parsed.error || parsed;
      return {
        title: err.message || "AI 请求失败",
        detail: err.param || err.code || err.type || "",
      };
    } catch {}
  }
  const status = raw.match(/\((\d{3})\s+([^)]+)\)/);
  return {
    title: status ? `AI 请求失败：${status[1]} ${status[2]}` : raw,
    detail: "",
  };
}

function renderAiError(content) {
  const info = parseAiErrorMessage(content);
  const wrap = document.createElement("div");
  wrap.className = "ai-error-card";
  const title = document.createElement("strong");
  title.textContent = info.title;
  wrap.appendChild(title);
  if (info.detail) {
    const detail = document.createElement("p");
    detail.textContent = info.detail;
    wrap.appendChild(detail);
  }
  return wrap;
}

async function runCommandInActiveTerminal(command) {
  const pane = getActivePane();
  if (!pane?.sessionId) {
    showToast("当前没有可执行命令的终端会话。", "error", 3600);
    return;
  }
  const text = normalizeAiCommandBlock(command);
  if (!text) return;
  const ok = confirm(`将执行以下命令：\n\n${text}`);
  if (!ok) return;
  try {
    await sendTextToPane(pane, text, { submit: true });
    pane.term?.focus?.();
  } catch (e) {
    showToast(String(e), "error", 4200);
  }
}

async function requestAiCommandApproval(command) {
  const text = normalizeAiCommandBlock(command);
  if (!text) return;
  try {
    await executeAiCommand(text);
  } catch {
    // executeAiCommand() surfaces failures via toast. Swallow here so the
    // inline click handler never produces an unhandled promise rejection.
  }
}

async function executeAiCommand(command) {
  const pane = getActivePane();
  if (!pane?.sessionId) {
    showToast("当前没有可执行命令的终端会话。", "error", 3600);
    return;
  }
  // Reaching this function requires an explicit click on “批准执行” (or on an
  // inline command labelled as click-to-approve). That click is the user's
  // per-command authorization; do not ask for the same approval twice.
  refitActiveTerminalPanes({ reason: "ai-command-before", forceBottom: true, frames: 1 });
  const buffer = pane.term?.buffer?.active;
  const cursor = buffer ? buffer.length : 0;
  const before = getActiveTerminalSnapshot(240);
  try {
    await sendTextToPane(pane, command, { submit: true });
    pane.term?.focus?.();
    await waitForTerminalOutputSettle(before, { maxMs: commandWaitMaxMs(command) });
    refitActiveTerminalPanes({ reason: "ai-command-after", forceBottom: true, frames: 2 });
    keepPaneTerminalAtBottom(pane, { force: true });
    return cursor;
  } catch (e) {
    showToast(String(e), "error", 4200);
    throw e;
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Run a (possibly multi-line) command snippet line by line: each non-trailing
// line is submitted on its own so the shell executes them sequentially, exactly
// as if typed. Internal blank lines are preserved (heredocs / multi-line blocks
// rely on them); only trailing blank lines are dropped.
async function runSnippetInActiveTerminal(command) {
  const pane = getActivePane();
  if (!pane?.sessionId) {
    showToast("当前没有可执行命令的终端会话。", "error", 3600);
    throw new Error("no terminal session");
  }
  await runCommandTextInPane(pane, command);
}

async function runCommandTextInPane(pane, command) {
  if (!pane?.sessionId) throw new Error("no terminal session");
  const normalized = String(command || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0) return;
  for (let i = 0; i < lines.length; i += 1) {
    await sendTextToPane(pane, lines[i], { submit: true });
    if (i < lines.length - 1) await wait(80);
  }
  keepPaneTerminalAtBottom(pane, { force: true });
  pane.term?.focus?.();
}

// Terminal input regression checklist:
// 1. Windows local cmd.exe: AI click-to-run executes immediately.
// 2. Windows local snippets: single-click snippet executes immediately.
// 3. SSH/Linux shell: AI click-to-run still submits exactly once.
// 4. Manual keyboard typing/paste: Enter and paste behavior remain unchanged.
async function sendTextToPane(pane, text, { submit = false, fill = false } = {}) {
  if (!pane?.sessionId) throw new Error("pane session is not available");
  let payload;
  if (submit) payload = buildApprovedCommandPayload(text, pane);
  else if (fill) payload = buildFillCommandPayload(text, pane);
  else payload = String(text || "");
  const bytes = Array.from(new TextEncoder().encode(payload));
  await invoke("send_input", { sessionId: pane.sessionId, data: bytes });
}

function buildApprovedCommandPayload(command, pane) {
  const text = String(command || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const enter = isWindowsPlatform && pane?.isLocal ? "\r" : "\n";
  return text.endsWith("\n") ? text.slice(0, -1) + enter : `${text}${enter}`;
}

// Fill (插入但不执行): normalize internal newlines to the pane's Enter char so
// multi-line snippets advance correctly on Windows-local shells, but strip any
// trailing newline so the final line is left unexecuted for the user to confirm.
function buildFillCommandPayload(command, pane) {
  const text = String(command || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  const enter = isWindowsPlatform && pane?.isLocal ? "\r" : "\n";
  return text.replace(/\n/g, enter);
}

async function waitForTerminalOutputSettle(before, { quietMs = 900, maxMs = 15000 } = {}) {
  const started = Date.now();
  let last = before || "";
  let lastChanged = Date.now();
  let firstQuietAt = 0;
  while (Date.now() - started < maxMs) {
    await wait(250);
    const current = getActiveTerminalSnapshot(260);
    if (current !== last) {
      last = current;
      lastChanged = Date.now();
      firstQuietAt = 0;
      continue;
    }
    if (Date.now() - lastChanged >= quietMs) {
      if (looksLikeTerminalPromptReady(current)) return;
      if (!firstQuietAt) firstQuietAt = Date.now();
      if (Date.now() - firstQuietAt >= 900) return;
    }
  }
}

function looksLikeTerminalPromptReady(snapshot) {
  const lines = String(snapshot || "").split("\n").map((line) => line.trimEnd()).filter(Boolean);
  const tail = lines.slice(-4);
  return tail.some((line) => /(?:^|\s)(?:[\w.-]+@)?[\w.-]+(?::[^\n]*)?[#$>]\s*$/.test(line)
    || /^[>$]\s*$/.test(line));
}

function commandWaitMaxMs(command) {
  const sleeps = Array.from(String(command || "").matchAll(/\bsleep\s+(\d+(?:\.\d+)?)/g))
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!sleeps.length) return 15000;
  const totalSleepMs = sleeps.reduce((sum, n) => sum + n * 1000, 0);
  return Math.min(90000, Math.max(15000, totalSleepMs + 8000));
}

function scanTerminalFromCursor(cursor) {
  const buffer = getActivePane()?.term?.buffer?.active;
  if (!buffer) return "";
  const maxLines = buffer.length || 0;
  if (cursor > 0 && cursor < maxLines && buffer.getLine(cursor)) {
    const rows = [];
    for (let i = cursor; i < maxLines; i++) {
      rows.push(buffer.getLine(i)?.translateToString?.(true) || "");
    }
    return rows.join("\n");
  }
  const start = Math.max(0, maxLines - 200);
  const rows = [];
  for (let i = start; i < maxLines; i++) {
    rows.push(buffer.getLine(i)?.translateToString?.(true) || "");
  }
  return rows.join("\n").trim();
}

function buildConversationSummary(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const parts = [];
  if (lastUser?.content) {
    const text = String(lastUser.content).replace(/```[\s\S]*?```/g, "").trim().slice(0, 200);
    if (text) parts.push(`用户的原始问题：${text}`);
  }
  if (lastAssistant?.content) {
    const text = String(lastAssistant.content).replace(/```[\s\S]*?```/g, "").trim().slice(0, 150);
    if (text) parts.push(`AI 上一步的建议摘要：${text}`);
  }
  return parts.join("\n");
}

async function continueAiAfterCommands(results, { totalCommands = 0 } = {}) {
  const executed = Array.isArray(results) ? results.filter((item) => item?.command) : [];
  const includeCommandOutput = aiContextMode !== "off";
  const summary = buildConversationSummary(aiMessages);
  const commands = executed.map((item) => item.command);
  const earliestCursor = executed.reduce((min, item) => {
    const c = typeof item.cursor === "number" ? item.cursor : 0;
    return c > 0 && (min === 0 || c < min) ? c : min;
  }, 0);
  const terminalOutput = includeCommandOutput ? scanTerminalFromCursor(earliestCursor) : "";
  const systemParts = executed.length
    ? [
      "你是 ZeroTerm 的 AI 助手。用户刚在同一条 AI 回复里批准执行了多条命令，需要你继续分析。",
      "综合这些已执行命令的终端输出继续推进用户目标，但不要假装未执行的命令已经执行。",
      "如果证据已经足够，必须停止继续排查，直接给出：结论、依据、影响、建议下一步。",
      "如果当前结果已经能回答问题，不要再重复建议同类检查命令。",
      "只有在缺少一个关键事实时，才给下一条最有用的命令。",
      "每次最多建议一条命令，且每个 fenced code block 只能包含一条命令。",
      "引用终端输出、报错或日志时必须使用 ```terminal 代码块；只有真正需要用户批准执行的命令才使用 ```bash。",
      "不要重复建议已经执行过或等价的检查命令。",
      `用户已执行的命令：${commands.join(", ")}`,
    ]
    : [
      "你是 ZeroTerm 的 AI 助手。用户点击了“继续分析”，但这次不一定是通过对话里的批准按钮执行命令，也可能是手动在终端里执行过。",
      "优先根据当前终端内容继续推进用户目标，不要假装知道用户具体执行了哪条命令。",
      "如果证据已经足够，必须停止继续排查，直接给出：结论、依据、影响、建议下一步。",
      "如果当前终端内容已经能回答问题，不要再重复建议同类检查命令。",
      "只有在缺少一个关键事实时，才给下一条最有用的命令。",
      "每次最多建议一条命令，且每个 fenced code block 只能包含一条命令。",
      "引用终端输出、报错或日志时必须使用 ```terminal 代码块；只有真正需要用户批准执行的命令才使用 ```bash。",
      totalCommands > 0
        ? `这条 AI 回复里原本给出了 ${totalCommands} 条可执行命令，但当前没有记录到通过按钮执行的命令；用户可能改为手动执行。`
        : "当前没有记录到通过按钮执行的命令；用户可能是在终端中手动执行后再回来继续分析。",
    ];
  if (summary) systemParts.push(`\n对话摘要：\n${summary}`);
  if (!includeCommandOutput) systemParts.push("用户当前选择了不附带终端内容，不要基于终端输出做判断。");
  systemParts.push(aiExecutableCommandFormatPrompt());
  const messages = [{ role: "system", content: withGlobalAiPrompt(systemParts.join("\n")) }];
  if (terminalOutput) {
    const label = executed.length ? "从终端获取到的命令执行输出" : "从当前终端获取到的最新内容";
    messages.push({ role: "system", content: `${label}：\n\`\`\`terminal\n${redactSensitiveText(terminalOutput)}\n\`\`\`` });
  }
  messages.push({ role: "user", content: "继续分析" });
  await runAiTurn(messages, executed.length ? "正在分析已执行命令..." : "正在基于当前终端继续分析...");
}

/// Run a single AI turn (initial send or retry) under shared "sending" state
/// so the compose button reflects in-flight/cancelable status and concurrent
/// turns are prevented uniformly. Returns once the request hands off to the
/// stream listener or fails.
async function runAiTurn(messages, pendingText = "正在思考...") {
  const paneKey = getAiPaneKey();
  const requestState = getAiRequestState(paneKey);
  if (requestState.sending) return;
  requestState.sending = true;
  updateAiSendButton();
  try {
    await streamAiMessages(messages, pendingText, paneKey);
  } finally {
    requestState.sending = false;
    requestState.activeRequestId = "";
    requestState.canceling = false;
    updateAiSendButton();
  }
}

async function streamAiMessages(messages, pendingText = "正在思考...", paneKey = getAiPaneKey()) {
  await ensureAiStreamListener();
  if (!window.__ztAiStreams) window.__ztAiStreams = new Map();
  const pendingNode = appendAiMessage("assistant", pendingText, { pending: true });
  const requestId = `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestState = getAiRequestState(paneKey);
  requestState.activeRequestId = requestId;
  updateAiSendButton();
  window.__ztAiStreams.set(requestId, {
    node: pendingNode,
    content: "",
    reasoning: "",
    messages,
    pendingText,
    paneKey,
    conversationMessages: aiConversationByPane.get(paneKey) || aiMessages,
  });
  const timeoutId = window.setTimeout(() => {
    const state = window.__ztAiStreams?.get?.(requestId);
    if (!state) return;
    showAiTurnError(state.node, "AI 响应超时，请重试。", state.messages, state.pendingText);
    const req = getAiRequestState(state.paneKey);
    if (req.activeRequestId === requestId) req.activeRequestId = "";
    req.sending = false;
    req.canceling = false;
    updateAiSendButton();
    window.__ztAiStreams.delete(requestId);
  }, 45000);
  window.__ztAiStreams.get(requestId).timeoutId = timeoutId;
  try {
    await invoke("ai_chat_stream", {
      input: {
        requestId,
        messages,
        profileId: aiStore.activeProfileId || null,
      },
    });
  } catch (e) {
    const state = window.__ztAiStreams?.get?.(requestId);
    if (!state) return;
    if (state.timeoutId) window.clearTimeout(state.timeoutId);
    try {
      const fallback = await invoke("ai_chat", { messages, profileId: aiStore.activeProfileId || null });
      const content = fallback?.content || "";
      const reasoningContent = fallback?.reasoningContent || "";
      if (content.trim() || reasoningContent.trim()) {
        state.node.classList.remove("pending");
        state.node.className = "ai-message ai-message-assistant";
        if (reasoningContent) {
          updateAiMessageWithReasoning(state.node, reasoningContent, content);
        } else {
          setAiMessageContent(state.node, content);
        }
        const assistantMessage = { role: "assistant", content, commandResults: [], reasoningContent };
        state.conversationMessages.push(assistantMessage);
        aiMessageByNode.set(state.node, assistantMessage);
        setAiPaneMessages(state.paneKey, state.conversationMessages);
        if (state.paneKey === getAiPaneKey()) storeAiConversationForActivePane();
      } else {
        showAiTurnError(state.node, "AI 流式响应失败，且非流式重试没有返回内容。", messages, pendingText);
      }
    } catch (fallbackError) {
      showAiTurnError(state.node, `AI 响应失败：${String(fallbackError || e)}`, messages, pendingText);
    } finally {
      const req = getAiRequestState(state.paneKey);
      if (req.activeRequestId === requestId) req.activeRequestId = "";
      req.sending = false;
      req.canceling = false;
      window.__ztAiStreams.delete(requestId);
    }
  }
}


function normalizeAiCommandBlock(command) {
  return String(command || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/\s+#\s+.*$/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function splitAiCommandBlockForApproval(command) {
  const text = normalizeAiCommandBlock(command);
  if (!text) return [];
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length <= 1) return lines;
  if (shouldApproveAiCommandBlockAsScript(lines)) return [text];
  return lines;
}

function getAiContinuedCommandCount(message) {
  const value = Number(message?.continuedCommandCount);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function storeAiContinuedCommandCountForMessage(messageNode, count) {
  const message = aiMessageByNode.get(messageNode);
  if (!message) return;
  message.continuedCommandCount = count;
  storeAiConversationForActivePane();
}

function ensureAiMultiCommandControls(messageNode, totalCommands) {
  if (!messageNode || totalCommands < 1) return null;
  let state = aiMultiCommandState.get(messageNode);
  if (!state) {
    state = {
      totalCommands,
      executedCount: 0,
      lastContinuedCount: null,
      results: [],
      continuing: false,
      controls: null,
      hint: null,
      button: null,
    };
    const message = aiMessageByNode.get(messageNode);
    const storedResults = Array.isArray(message?.commandResults) ? message.commandResults : [];
    state.lastContinuedCount = getAiContinuedCommandCount(message);
    if (storedResults.length) {
      state.results = storedResults.map((item) => ({
        command: String(item?.command || ""),
        output: typeof item?.output === "string" ? item.output : "",
      })).filter((item) => item.command.trim());
      state.executedCount = state.results.length;
    }
    aiMultiCommandState.set(messageNode, state);
  } else {
    state.totalCommands = Math.max(state.totalCommands || 0, totalCommands);
  }
  if (!state.controls || !state.controls.isConnected) {
    const parts = ensureAiMessageParts(messageNode);
    if (!parts) return state;
    const controls = document.createElement("div");
    controls.className = "ai-message-actions";
    const hint = document.createElement("div");
    hint.className = "ai-message-action-hint";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-continue-analysis";
    button.addEventListener("click", async () => {
      const current = aiMultiCommandState.get(messageNode);
      if (!current || current.continuing) return;
      if (current.lastContinuedCount !== null && current.lastContinuedCount >= current.executedCount) return;
      current.lastContinuedCount = current.executedCount;
      storeAiContinuedCommandCountForMessage(messageNode, current.lastContinuedCount);
      current.continuing = true;
      updateAiMultiCommandControls(messageNode);
      try {
        await continueAiAfterCommands(current.results, { totalCommands: current.totalCommands });
      } finally {
        current.continuing = false;
        updateAiMultiCommandControls(messageNode);
      }
    });
    controls.append(hint, button);
    parts.actionsSlot.textContent = "";
    parts.actionsSlot.appendChild(controls);
    state.controls = controls;
    state.hint = hint;
    state.button = button;
  }
  ensureAiMessageParts(messageNode);
  updateAiMultiCommandControls(messageNode);
  return state;
}

function updateAiMultiCommandControls(messageNode) {
  const state = aiMultiCommandState.get(messageNode);
  if (!state?.controls || !state.hint || !state.button) return;
  const executed = state.executedCount || 0;
  const total = state.totalCommands || 0;
  const pending = Math.max(0, total - executed);
  state.hint.textContent = executed
    ? `这条回复里有 ${total} 条可执行命令，已执行 ${executed} 条${pending ? `，剩余 ${pending} 条` : ""}。你也可以手动执行后直接继续分析。`
    : `这条回复里有 ${total} 条可执行命令；你可以手动执行后，直接点“继续分析”。`;
  if (state.continuing) {
    state.button.disabled = true;
    state.button.textContent = "分析中...";
    return;
  }
  if (state.lastContinuedCount !== null && state.lastContinuedCount >= executed) {
    state.button.disabled = true;
    state.button.textContent = "已分析";
    return;
  }
  state.button.disabled = false;
  state.button.textContent = "继续分析";
}

function storeAiCommandResultForMessage(messageNode, result) {
  const message = aiMessageByNode.get(messageNode);
  if (!message || !result?.command) return;
  if (!Array.isArray(message.commandResults)) message.commandResults = [];
  message.commandResults = message.commandResults.filter((item) => item.command !== result.command);
  message.commandResults.push({ command: result.command });
  storeAiConversationForActivePane();
}

function looksLikeHeredocStart(line) {
  return /<<-?\s*(?:['"][^'"\s]+['"]|[^\s<]+)$/.test(String(line || "").trim());
}

function shouldApproveAiCommandBlockAsScript(lines) {
  if (!Array.isArray(lines) || lines.length <= 1) return false;
  if (lines.some((line) => looksLikeHeredocStart(line))) return true;
  if (lines.some((line) => /[\\|&]$/.test(line))) return true;
  if (lines.some((line) => /^(if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b/.test(line))) return true;
  if (lines.some((line) => /^(\{|\})$/.test(line))) return true;
  return !lines.every((line) => looksLikeRunnableCommandLine(line));
}

function getActiveTerminalSnapshot(maxLines = 160) {
  const pane = getActivePane();
  const term = pane?.term;
  const buffer = term?.buffer?.active;
  if (!buffer) return "";
  const rows = [];
  const length = buffer.length || 0;
  const start = Math.max(0, length - maxLines);
  for (let i = start; i < length; i += 1) {
    const line = buffer.getLine(i)?.translateToString?.(true) || "";
    rows.push(line);
  }
  return rows.join("\n").trim();
}

// 终端内容脱敏实现在 redact.js(经典脚本,先于本模块加载),便于 Node 单测复用
const { redactSensitiveText } = globalThis.ZeroTermRedact;

function buildAiTerminalContext() {
  const snapshot = getActiveTerminalSnapshot();
  if (!snapshot) return "";
  const redacted = redactSensitiveText(snapshot);
  return [
    "下面是当前活动终端最近的屏幕内容，已在本地做基础脱敏后才发送给你。用户可能会说“我执行了”“看结果”等，你要优先根据这些终端内容判断。",
    "如果看到 [REDACTED_*]，说明原始终端内容里存在可能敏感的信息；不要要求用户贴出原文，除非确实必要。",
    "",
    "```terminal",
    redacted,
    "```",
  ].join("\n");
}

function shouldAttachTerminalContext(text) {
  if (aiContextMode === "off") return false;
  return true;
}

function stripTerminalContentFromAiText(text) {
  return String(text || "")
    .replace(/```terminal[\s\S]*?```/gi, "```terminal\n[终端内容已按当前设置省略]\n```")
    .replace(/本次终端输出（已本地脱敏）：[\s\S]*?(?=\n\S|$)/g, "本次终端输出已按当前设置省略。")
    .replace(/下面是当前活动终端最近的屏幕内容[\s\S]*?(?=\n\S|$)/g, "当前活动终端内容已按当前设置省略。");
}

function redactAiMessagesForRequest(messages, { includeTerminalContent = true } = {}) {
  return messages.map((message) => ({
    ...message,
    content: redactSensitiveText(includeTerminalContent ? message.content : stripTerminalContentFromAiText(message.content)),
    commandResults: includeTerminalContent ? message.commandResults : [],
  }));
}

function enhanceAiCodeBlocks(root) {
  const blocks = Array.from(root.querySelectorAll?.(".ai-code-block:not([data-enhanced])") || []);
  if (!blocks.length) return;
  const executable = [];
  blocks.forEach((block) => {
    block.dataset.enhanced = "1";
    const pre = block.querySelector("pre");
    const command = normalizeAiCommandBlock(pre?.textContent || "");
    if (!isExecutableCodeBlock(block, command)) return;
    const commands = splitAiCommandBlockForApproval(command);
    if (!commands.length) return;
    executable.push({ block, commands });
  });
  if (!executable.length) return;
  const messageNode = root.closest?.(".ai-message-assistant");
  const totalCommands = executable.reduce((sum, item) => sum + item.commands.length, 0);
  const commandState = ensureAiMultiCommandControls(messageNode, totalCommands);
  executable.forEach(({ block, commands }) => {
    const tools = document.createElement("div");
    tools.className = "ai-code-tools";
    commands.slice(0, 4).forEach((singleCommand, index) => {
      const restoredResult = commandState?.results?.find?.((item) => item.command === singleCommand);
      const run = document.createElement("button");
      run.type = "button";
      run.textContent = restoredResult ? "已执行" : (commands.length > 1 ? `批准 ${index + 1}` : "批准执行");
      run.disabled = Boolean(restoredResult);
      run.title = singleCommand;
      run.addEventListener("click", async () => {
        run.disabled = true;
        run.textContent = "运行中";
        block.classList.add("approved");
        try {
          const cursor = await executeAiCommand(singleCommand);
          if (commandState) {
            const result = { command: singleCommand, cursor: cursor || 0 };
            commandState.results.push(result);
            commandState.executedCount += 1;
            storeAiCommandResultForMessage(messageNode, result);
            updateAiMultiCommandControls(messageNode);
          }
          run.textContent = "已执行";
        } catch (e) {
          if (commandState) updateAiMultiCommandControls(messageNode);
          run.textContent = "失败";
        }
      });
      tools.appendChild(run);
    });
    block.appendChild(tools);
  });
}

function isExecutableCodeBlock(block, command) {
  const lang = (block?.dataset?.lang || "").toLowerCase();
  const lines = String(command || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return false;
  if (lines.some((line) => looksLikeTerminalOutput(line))) return false;
  if (["output", "terminal", "text", "log", "txt"].includes(lang)) return false;
  if (["bash", "sh", "shell", "zsh", "powershell", "pwsh", "ps1", "cmd", "bat", "batch"].includes(lang)) return true;
  return false;
}

function looksLikeTerminalOutput(line) {
  return /^-?(bash|sh|zsh|ash):/i.test(line)
    || /\b(command not found|no such file or directory|permission denied|not found)\b/i.test(line)
    || /^\w[\w.-]*:\s+/.test(line);
}

function looksLikeRunnableCommandLine(line) {
  if (!line || line.startsWith("#")) return false;
  if (/^[-–—]/.test(line)) return false;
  if (looksLikeTerminalOutput(line)) return false;
  return /^(sudo\s+)?[a-zA-Z0-9_./-]+(\s|$)/.test(line);
}

function appendAiMessage(role, content, { pending = false, skipStore = false, message = null } = {}) {
  if (!aiChatLog) return null;
  aiChatLog.hidden = false;
  if (aiEmptyState) aiEmptyState.hidden = true;
  const node = document.createElement("article");
  node.className = `ai-message ai-message-${role}`;
  if (pending) node.classList.add("pending");

  const label = document.createElement("div");
  label.className = "ai-message-label";
  label.textContent = role === "user" ? "你" : "AI";

  const body = document.createElement("div");
  body.className = "ai-message-body";

  node.append(label, body);
  aiChatLog.appendChild(node);
  if (message) aiMessageByNode.set(node, message);
  const reasoning = message?.reasoningContent || "";
  if (reasoning && !pending) {
    updateAiMessageWithReasoning(node, reasoning, content);
  } else {
    setAiMessageContent(node, content);
  }
  scrollAiPanelToBottom({ force: true });
  if (!skipStore) storeAiConversationForActivePane();
  return node;
}

function setAiPendingMessage(node, content, kind = "assistant") {
  if (!node) return;
  node.classList.remove("pending");
  node.className = `ai-message ai-message-${kind}`;
  setAiMessageContent(node, content);
}

/// Mark an AI turn's message node as failed and attach a Retry button that
/// re-runs the exact same request. All AI failure paths funnel through here so
/// a network/timeout/empty failure is always recoverable with one click.
function showAiTurnError(node, text, messages, pendingText) {
  if (!node) return;
  node.classList.remove("pending");
  node.className = "ai-message ai-message-error";
  setAiMessageContent(node, text);
  attachAiRetryButton(node, messages, pendingText);
}

/// Append a Retry control to a failed AI message node. Clicking it removes the
/// failed node and re-issues the same turn with the original messages. The
/// button is a sibling of `.ai-message-body`, which `setAiMessageContent` only
/// rewrites — so it won't be clobbered.
function attachAiRetryButton(node, messages, pendingText) {
  if (!node || !Array.isArray(messages) || messages.length === 0) return;
  node.querySelector(".ai-message-retry")?.remove();
  const bar = document.createElement("div");
  bar.className = "ai-message-retry";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ai-retry-button";
  btn.textContent = t("ai.retry");
  btn.addEventListener("click", () => {
    if (isAiSendingForPane()) return; // a turn is already in flight for this pane
    node.remove();
    runAiTurn(messages, pendingText).catch((e) => console.warn("ai retry failed", e));
  });
  bar.appendChild(btn);
  node.appendChild(bar);
}

async function ensureAiStreamListener() {
  if (aiStreamUnlistenPromise) return;
  aiStreamUnlistenPromise = listen("ai:stream", (ev) => {
    const payload = ev.payload || {};
    const state = window.__ztAiStreams?.get?.(payload.requestId);
    if (!state) return;
    if (payload.error) {
      if (state.timeoutId) window.clearTimeout(state.timeoutId);
      if (payload.error === "canceled") {
        state.node.remove();
      } else {
        showAiTurnError(state.node, payload.error, state.messages, state.pendingText);
      }
      const req = getAiRequestState(state.paneKey);
      if (req.activeRequestId === payload.requestId) req.activeRequestId = "";
      req.sending = false;
      req.canceling = false;
      updateAiSendButton();
      window.__ztAiStreams.delete(payload.requestId);
      return;
    }
    const reasoningDelta = payload.reasoningDelta || "";
    const contentDelta = payload.delta || "";
    if (reasoningDelta) {
      state.reasoning = (state.reasoning || "") + reasoningDelta;
    }
    if (contentDelta) {
      state.content = (state.content || "") + contentDelta;
    }
    if (reasoningDelta || contentDelta) {
      state.node.classList.remove("pending");
      state.node.className = "ai-message ai-message-assistant";
      updateAiMessageWithReasoning(state.node, state.reasoning || "", state.content || "");
      if (state.timeoutId) {
        window.clearTimeout(state.timeoutId);
      }
      state.timeoutId = window.setTimeout(() => {
        const s = window.__ztAiStreams?.get?.(payload.requestId);
        if (!s) return;
        showAiTurnError(s.node, "AI 响应超时，请重试。", s.messages, s.pendingText);
        const req = getAiRequestState(s.paneKey);
        if (req.activeRequestId === payload.requestId) req.activeRequestId = "";
        req.sending = false;
        req.canceling = false;
        updateAiSendButton();
        window.__ztAiStreams.delete(payload.requestId);
      }, 45000);
    }
    if (payload.done) {
      if (state.timeoutId) window.clearTimeout(state.timeoutId);
      state.node.classList.remove("pending");
      const req = getAiRequestState(state.paneKey);
      if (req.activeRequestId === payload.requestId) req.activeRequestId = "";
      req.sending = false;
      req.canceling = false;
      const finalContent = (state.content || "").trim();
      const finalReasoning = (state.reasoning || "").trim();
      if (!finalContent && !finalReasoning) {
        if (state.fallbackTried) {
          showAiTurnError(state.node, "AI 没有返回内容，请重试。", state.messages, state.pendingText);
          updateAiSendButton();
          window.__ztAiStreams.delete(payload.requestId);
          return;
        }
        state.fallbackTried = true;
        tryFallbackAiChat(state, payload.requestId);
        return;
      }
      const assistantMessage = { role: "assistant", content: finalContent, commandResults: [], reasoningContent: finalReasoning };
      state.conversationMessages.push(assistantMessage);
      aiMessageByNode.set(state.node, assistantMessage);
      setAiPaneMessages(state.paneKey, state.conversationMessages);
      if (state.paneKey === getAiPaneKey()) storeAiConversationForActivePane();
      window.__ztAiStreams.delete(payload.requestId);
    }
  });
}

async function tryFallbackAiChat(state, requestId) {
  try {
    if (getAiRequestState(state.paneKey).activeRequestId !== requestId) return;
    const fallback = await invoke("ai_chat", {
      messages: state.messages,
      profileId: aiStore.activeProfileId || null,
    });
    if (getAiRequestState(state.paneKey).activeRequestId !== requestId) return;
    const content = fallback?.content || "";
    const reasoningContent = fallback?.reasoningContent || "";
    if (content.trim() || reasoningContent.trim()) {
      state.node.classList.remove("pending");
      state.node.className = "ai-message ai-message-assistant";
      if (reasoningContent) {
        updateAiMessageWithReasoning(state.node, reasoningContent, content);
      } else {
        setAiMessageContent(state.node, content);
      }
      const assistantMessage = { role: "assistant", content, commandResults: [], reasoningContent };
      state.conversationMessages.push(assistantMessage);
      aiMessageByNode.set(state.node, assistantMessage);
      setAiPaneMessages(state.paneKey, state.conversationMessages);
      if (state.paneKey === getAiPaneKey()) storeAiConversationForActivePane();
      const req = getAiRequestState(state.paneKey);
      if (req.activeRequestId === requestId) req.activeRequestId = "";
      req.sending = false;
      req.canceling = false;
      updateAiSendButton();
      window.__ztAiStreams.delete(requestId);
      return;
    }
  } catch (_) {}
  const req = getAiRequestState(state.paneKey);
  if (req.activeRequestId !== requestId) return;
  showAiTurnError(state.node, "AI 没有返回内容，请重试。", state.messages, state.pendingText);
  req.activeRequestId = "";
  req.sending = false;
  req.canceling = false;
  updateAiSendButton();
  window.__ztAiStreams.delete(requestId);
}

const SETTINGS_KEY_AI_SYSTEM_PROMPT = "zeroterm.settings.ai.system_prompt";

function getAiGlobalSystemPrompt() {
  try {
    return (localStorage.getItem(SETTINGS_KEY_AI_SYSTEM_PROMPT) || "").trim();
  } catch (e) {
    return "";
  }
}

function withGlobalAiPrompt(system) {
  const extra = getAiGlobalSystemPrompt();
  return extra ? `${system}\n\n用户的自定义全局要求（请优先遵守）：\n${extra}` : system;
}

function aiExecutableCommandFormatPrompt() {
  return [
    "ZeroTerm executable command format:",
    "- If the user needs to run something, provide the exact runnable command in a fenced code block whose language is one of: bash, sh, shell, zsh, powershell, pwsh, ps1, cmd, bat, batch.",
    "- Short inline code is also runnable only when it is one line, 140 characters or less, starts with a command name or sudo, and is not a URL, domain, heredoc starter, or shell control keyword.",
    "- Do not put runnable commands in terminal, text, log, output, or txt fenced blocks; ZeroTerm treats those as non-executable output.",
    "- Do not mix terminal prompts, command output, explanations, or error logs inside runnable command blocks.",
    "- Prefer one command per runnable fenced block. Use a multi-line command block only when it must run as one script, such as heredoc, control flow, continuation, or grouped commands.",
    "- Use ```terminal fenced blocks only for observed terminal output, logs, or errors.",
    "- Do not merely say in prose that the user should run a command. When execution is needed, include the command in one of the executable formats above.",
  ].join("\n");
}

async function loadAiConfig() {
  if (aiConfigLoaded) return aiStore;
  if (aiConfigLoadPromise) return aiConfigLoadPromise;
  aiConfigLoadPromise = (async () => {
    try {
      const store = await invoke("get_ai_config");
      applyAiStore(store);
      aiConfigLoaded = true;
      return aiStore;
    } catch (e) {
      if (settingsAiStatus) settingsAiStatus.textContent = String(e);
      throw e;
    } finally {
      aiConfigLoadPromise = null;
    }
  })();
  return aiConfigLoadPromise;
}

async function saveAiProfileFromForm() {
  const models = settingsAiModel
    ? Array.from(settingsAiModel.options).map((o) => String(o.value || "").trim()).filter(Boolean)
    : [];
  const input = {
    id: aiEditingProfileId || "",
    name: settingsAiName?.value?.trim() || "",
    provider: settingsAiProvider?.value || "openai-compatible",
    model: getAiModelValue(),
    baseUrl: settingsAiBaseUrl?.value || "",
    apiKey: settingsAiApiKey?.value || "",
    models,
    reasoningEffort: settingsAiReasoningEffort?.value || "",
  };
  const store = await invoke("save_ai_profile", { input });
  if (settingsAiApiKey) settingsAiApiKey.value = "";
  applyAiStore(store);
  if (settingsAiStatus) settingsAiStatus.textContent = t("settings.ai.status.saved");
  cancelAiEditor();
  return store;
}

async function refreshAiModels() {
  // Editing a saved profile with no freshly-typed key -> use its stored key.
  if (aiEditingProfileId && !(settingsAiApiKey?.value || "").trim()) {
    const res = await invoke("list_ai_models_for_profile", { id: aiEditingProfileId });
    setAiModelOptions(res?.models || [], getAiModelValue());
    if (settingsAiStatus) {
      settingsAiStatus.textContent = t("settings.ai.status.models_fetched", {
        count: res?.models?.length || 0,
      });
    }
    return;
  }
  const input = {
    provider: settingsAiProvider?.value || "openai-compatible",
    model: getAiModelValue(),
    baseUrl: settingsAiBaseUrl?.value || "",
    apiKey: settingsAiApiKey?.value || "",
    safeMode: true,
    autoRead: false,
    showCommands: false,
  };
  const result = await invoke("list_ai_models", { input });
  setAiModelOptions(result?.models || [], input.model);
  if (settingsAiStatus) {
    settingsAiStatus.textContent = t("settings.ai.status.models_fetched", {
      count: result?.models?.length || 0,
    });
  }
}

async function maybeAutoRefreshAiModels() {
  if (aiEditingProfileId === null) return;
  if (!settingsAiBaseUrl?.value) return;
  const keyReady = !!settingsAiApiKey?.value || !/no_key|尚未保存/.test(settingsAiStatus?.textContent || "");
  if (!keyReady) return;
  const key = `${settingsAiProvider?.value || ""}|${settingsAiBaseUrl.value}`;
  if (key === lastAutoAiModelsKey) return;
  lastAutoAiModelsKey = key;
  try {
    await refreshAiModels();
  } catch (e) {
    lastAutoAiModelsKey = "";
  }
}

async function sendAiMessage(text) {
  syncAiConversationToActivePane();
  if (isAiSendingForPane()) return;
  // A fresh turn supersedes any earlier failed turn: drop stale Retry buttons
  // so a later click can't replay an out-of-date conversation snapshot.
  clearAiRetryButtons();
  aiMessages.push({ role: "user", content: text, commandResults: [] });
  storeAiConversationForActivePane();
  appendAiMessage("user", text);
  const system = "你是 ZeroTerm 的 AI 助手。用户是普通用户，不一定懂命令。请先用人话解释和规划，不要假装已经执行命令。需要用户执行命令时，一次只建议下一条最有用的命令；每个 bash/shell fenced code block 只能包含一条命令。引用终端输出、报错或日志时必须使用 ```terminal 代码块，不要使用 bash。";
  const systemWithCommandFormat = [system, aiExecutableCommandFormatPrompt()].join("\n");
  const terminalContext = shouldAttachTerminalContext(text) ? buildAiTerminalContext() : "";
  const messages = [{ role: "system", content: withGlobalAiPrompt(systemWithCommandFormat) }];
  if (terminalContext) messages.push({ role: "system", content: terminalContext });
  messages.push(...redactAiMessagesForRequest(aiMessages.slice(-10), { includeTerminalContent: aiContextMode !== "off" }));
  try {
    await runAiTurn(messages);
  } catch (e) {
    appendAiMessage("error", String(e));
  }
}

/// Remove Retry buttons from all currently-displayed failed AI messages.
/// Called when a new turn begins so an obsolete failed turn can't be replayed.
function clearAiRetryButtons() {
  aiChatLog?.querySelectorAll(".ai-message-retry").forEach((el) => el.remove());
}

async function runSyncButtonAction(button, busyLabel, task) {
  const prevLabel = button ? button.textContent : "";
  if (button) {
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
  }
  try {
    return await task();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = prevLabel;
    }
  }
}

function userFriendlySyncError(err) {
  const msg = String(err || "");
  if (msg.includes("sync is not connected yet")) {
    return t("settings.sync.error.not_connected");
  }
  return msg;
}
const settingsSyncHostRef = document.getElementById("settings-sync-host-ref");
const settingsSyncHostRefField = document.getElementById("settings-sync-host-ref-field");
const settingsSyncRemoteDir = document.getElementById("settings-sync-remote-dir");
const settingsSyncRemoteDirField = document.getElementById("settings-sync-remote-dir-field");
const settingsSyncWebDavUrl = document.getElementById("settings-sync-webdav-url");
const settingsSyncWebDavUrlField = document.getElementById("settings-sync-webdav-url-field");
const settingsSyncWebDavRoot = document.getElementById("settings-sync-webdav-root");
const settingsSyncWebDavRootField = document.getElementById("settings-sync-webdav-root-field");
const settingsSyncWebDavUser = document.getElementById("settings-sync-webdav-user");
const settingsSyncWebDavUserField = document.getElementById("settings-sync-webdav-user-field");
const settingsSyncWebDavPw = document.getElementById("settings-sync-webdav-pw");
const settingsSyncWebDavPwField = document.getElementById("settings-sync-webdav-pw-field");
const settingsSyncS3Region = document.getElementById("settings-sync-s3-region");
const settingsSyncS3RegionField = document.getElementById("settings-sync-s3-region-field");
const settingsSyncS3Bucket = document.getElementById("settings-sync-s3-bucket");
const settingsSyncS3BucketField = document.getElementById("settings-sync-s3-bucket-field");
const settingsSyncS3Prefix = document.getElementById("settings-sync-s3-prefix");
const settingsSyncS3PrefixField = document.getElementById("settings-sync-s3-prefix-field");
const settingsSyncS3Endpoint = document.getElementById("settings-sync-s3-endpoint");
const settingsSyncS3EndpointField = document.getElementById("settings-sync-s3-endpoint-field");
const settingsSyncS3PathStyle = document.getElementById("settings-sync-s3-path-style");
const settingsSyncS3PathStyleField = document.getElementById("settings-sync-s3-path-style-field");
const settingsSyncS3Ak = document.getElementById("settings-sync-s3-ak");
const settingsSyncS3AkField = document.getElementById("settings-sync-s3-ak-field");
const settingsSyncS3Sk = document.getElementById("settings-sync-s3-sk");
const settingsSyncS3SkField = document.getElementById("settings-sync-s3-sk-field");
const settingsSyncS3Token = document.getElementById("settings-sync-s3-token");
const settingsSyncS3TokenField = document.getElementById("settings-sync-s3-token-field");
const settingsSyncS3St = settingsSyncS3Token;
const settingsSyncS3StField = settingsSyncS3TokenField;
const settingsSyncS3StToggle = null;
const settingsSyncS3SkToggle = null;
const settingsSyncPasswordToggle = null;
const settingsSyncRootField = document.getElementById("settings-sync-root-field");
const settingsNavAbout = document.getElementById("settings-nav-about");
const settingsNavData = document.getElementById("settings-nav-data");
const settingsAboutPanel = document.getElementById("settings-about-panel");
const settingsDataPanel = document.getElementById("settings-data-panel");
const settingsDataClearOpen = document.getElementById("settings-data-clear-open");
const settingsDataStatus = document.getElementById("settings-data-status");
const settingsDataClearOverlay = document.getElementById("settings-data-clear-overlay");
const settingsDataClearTitle = document.getElementById("settings-data-clear-title");
const settingsDataClearMessage = document.getElementById("settings-data-clear-message");
const settingsDataClearOptions = document.getElementById("settings-data-clear-options");
const settingsDataClearWarning = document.getElementById("settings-data-clear-warning");
const settingsDataClearCancel = document.getElementById("settings-data-clear-cancel");
const settingsDataClearConfirm = document.getElementById("settings-data-clear-confirm");
const settingsGeneralSubtabBasic = document.getElementById("settings-general-subtab-basic");
const settingsGeneralSubtabSftp = document.getElementById("settings-general-subtab-sftp");
const settingsGeneralBasicSection = document.getElementById("settings-general-basic-section");
const settingsGeneralSftpSection = document.getElementById("settings-general-sftp-section");
const settingsGeneralTitle = document.getElementById("settings-general-title");
const settingsGeneralDesc = document.getElementById("settings-general-desc");
const settingsLanguageSelect = document.getElementById("settings-language-select");
const settingsProxyUrl = document.getElementById("settings-proxy-url");
const settingsProxySave = document.getElementById("settings-proxy-save");
const settingsProxyClear = document.getElementById("settings-proxy-clear");
const settingsProxyStatus = document.getElementById("settings-proxy-status");
const settingsBgPreview = document.getElementById("settings-bg-preview");
const settingsBgChoose = document.getElementById("settings-bg-choose");
const settingsBgClear = document.getElementById("settings-bg-clear");
const settingsBgOptions = document.getElementById("settings-bg-options");
const settingsBgOpacity = document.getElementById("settings-bg-opacity");
const settingsBgBlur = document.getElementById("settings-bg-blur");
const settingsBgStatus = document.getElementById("settings-bg-status");
const settingsWinsizeCurrent = document.getElementById("settings-winsize-current");
const settingsWinsizeSave = document.getElementById("settings-winsize-save");
const settingsWinsizeReset = document.getElementById("settings-winsize-reset");
const settingsWinsizeStatus = document.getElementById("settings-winsize-status");
const settingsAboutTitle = document.getElementById("settings-about-title");
const settingsAboutVersionLabel = document.getElementById("settings-about-version-label");
const settingsAboutVersionValue = document.getElementById("settings-about-version-value");
const settingsUpdateInstall = document.getElementById("settings-update-install");
const settingsUpdateStatus = document.getElementById("settings-update-status");
const updateDialogOverlay = document.getElementById("update-dialog-overlay");
const updateDialogVersion = document.getElementById("update-dialog-version");
const updateDialogNotes = document.getElementById("update-dialog-notes");
const updateDialogCancel = document.getElementById("update-dialog-cancel");
const updateDialogConfirm = document.getElementById("update-dialog-confirm");
let latestUpdateInfo = null;
const settingsTerminalTheme = document.getElementById("settings-terminal-theme");
const settingsTerminalSubtabTheme = document.getElementById("settings-terminal-subtab-theme");
const settingsTerminalSubtabFont = document.getElementById("settings-terminal-subtab-font");
const settingsTerminalThemeSection = document.getElementById("settings-terminal-theme-section");
const settingsTerminalFontSection = document.getElementById("settings-terminal-font-section");
const settingsTerminalFontFamily = document.getElementById("settings-terminal-font-family");
const settingsTerminalFontSize = document.getElementById("settings-terminal-font-size");
const settingsTerminalLineHeight = document.getElementById("settings-terminal-line-height");
const settingsTerminalShell = document.getElementById("settings-terminal-shell");
const settingsTerminalShellBrowse = document.getElementById("settings-terminal-shell-browse");
const settingsTerminalShellReset = document.getElementById("settings-terminal-shell-reset");
const settingsTerminalShellCurrent = document.getElementById("settings-terminal-shell-current");
const settingsTerminalCwd = document.getElementById("settings-terminal-cwd");
const settingsTerminalCwdBrowse = document.getElementById("settings-terminal-cwd-browse");
const settingsTerminalSelectionMenuOrder = document.getElementById("settings-terminal-selection-menu-order");
const settingsTerminalSelectionMenuOrderReset = document.getElementById("settings-terminal-selection-menu-order-reset");
const settingsTerminalAttentionFlash = document.getElementById("settings-terminal-attention-flash");
const settingsTerminalFontPreview = document.getElementById("settings-terminal-font-preview");
const terminalThemeListLight = document.getElementById("terminal-theme-list-light");
const terminalThemeListDark = document.getElementById("terminal-theme-list-dark");
const terminalThemeAddLight = document.getElementById("terminal-theme-add-light");
const terminalThemeAddDark = document.getElementById("terminal-theme-add-dark");
const themeCardMenu = document.getElementById("theme-card-menu");
const themeMenuEdit = document.getElementById("theme-menu-edit");
const themeMenuDuplicate = document.getElementById("theme-menu-duplicate");
const themeMenuDelete = document.getElementById("theme-menu-delete");
const snippetGroupContextMenu = document.getElementById("snippet-group-context-menu");
const snippetGroupMenuAdd = document.getElementById("snippet-group-menu-add");
const snippetGroupMenuEdit = document.getElementById("snippet-group-menu-edit");
const snippetGroupMenuDelete = document.getElementById("snippet-group-menu-delete");
const themeEditOverlay = document.getElementById("theme-edit-overlay");
const themeEditTitle = document.getElementById("theme-edit-title");
const themeEditForm = document.getElementById("theme-edit-form");
const themeEditCancel = document.getElementById("theme-edit-cancel");
const themeEditReset = document.getElementById("theme-edit-reset");
const themeEditPreview = document.getElementById("theme-edit-preview");
const themeEditName = document.getElementById("theme-edit-name");
const themeColorBg = document.getElementById("theme-color-bg");
const themeColorFg = document.getElementById("theme-color-fg");
const themeColorCursor = document.getElementById("theme-color-cursor");
const themeColorSelection = document.getElementById("theme-color-selection");
const themeHexBg = document.getElementById("theme-hex-bg");
const themeHexFg = document.getElementById("theme-hex-fg");
const themeHexCursor = document.getElementById("theme-hex-cursor");
const themeHexSelection = document.getElementById("theme-hex-selection");
const settingsSftpLocalDir = document.getElementById("settings-sftp-local-dir");
const settingsSftpLocalDirBrowse = document.getElementById("settings-sftp-local-dir-browse");
const workspaceTitlebar = document.getElementById("workspace-titlebar");
const vaultLeftTopbar = document.querySelector(".vault-left-topbar");
const vaultRightTopbar = document.querySelector(".vault-right-topbar");
const windowControls = document.getElementById("window-controls");
const windowMinimizeButton = document.getElementById("window-minimize");
const windowMaximizeButton = document.getElementById("window-maximize");
const windowCloseButton = document.getElementById("window-close");
const textInputOverlay = document.getElementById("text-input-overlay");
const textInputTitle = document.getElementById("text-input-title");
const textInputMessage = document.getElementById("text-input-message");
const textInputValue = document.getElementById("text-input-value");
const textInputCancelButton = document.getElementById("text-input-cancel");
const textInputConfirmButton = document.getElementById("text-input-confirm");
const confirmOverlay = document.getElementById("confirm-overlay");
const confirmTitle = document.getElementById("confirm-title");
const confirmMessage = document.getElementById("confirm-message");
const confirmCancelButton = document.getElementById("confirm-cancel");
const confirmOkButton = document.getElementById("confirm-ok");
const permissionsOverlay = document.getElementById("permissions-overlay");
const permissionsTitle = document.getElementById("permissions-title");
const permissionsMessage = document.getElementById("permissions-message");
const permissionsOctal = document.getElementById("permissions-octal");
const permissionsError = document.getElementById("permissions-error");
const permissionsCancelButton = document.getElementById("permissions-cancel");
const permissionsConfirmButton = document.getElementById("permissions-confirm");
const permissionCheckboxes = {
  ownerRead: document.getElementById("permissions-owner-read"),
  ownerWrite: document.getElementById("permissions-owner-write"),
  ownerExec: document.getElementById("permissions-owner-exec"),
  groupRead: document.getElementById("permissions-group-read"),
  groupWrite: document.getElementById("permissions-group-write"),
  groupExec: document.getElementById("permissions-group-exec"),
  otherRead: document.getElementById("permissions-other-read"),
  otherWrite: document.getElementById("permissions-other-write"),
  otherExec: document.getElementById("permissions-other-exec"),
};
const quickConnectOverlay = document.getElementById("quick-connect-overlay");
const quickConnectForm = document.getElementById("quick-connect-form");
const quickConnectUser = document.getElementById("qc-user");
const quickConnectHost = document.getElementById("qc-host");
const quickConnectPort = document.getElementById("qc-port");
const quickConnectAuthType = document.getElementById("qc-auth-type");
const quickConnectPasswordBlock = document.getElementById("qc-password-block");
const quickConnectPassword = document.getElementById("qc-password");
const quickConnectKeyBlock = document.getElementById("qc-key-block");
const quickConnectKeyPick = document.getElementById("qc-key-pick");
const quickConnectKeyStatus = document.getElementById("qc-key-status");
const quickConnectKeyPassphrase = document.getElementById("qc-key-passphrase");
const quickConnectCancel = document.getElementById("quick-connect-cancel");
const quickConnectError = document.getElementById("quick-connect-error");
let quickConnectKeyPem = null;

let hostsCache = [];
let workspaceMode = "vaults";
let textInputResolver = null;
let confirmResolver = null;
let permissionsResolver = null;
let permissionsSyncingFromOctal = false;
let permissionsSyncingFromChecks = false;
let windowIsMaximized = false;
let workspaceSidebarCollapsed = false;
let selectedVaultHostId = null;
let vaultSidebarWidth = 320;
let hostGroups = [];
let groupExpandedState = {};
let groupStateInitialized = false;
let draggingHostId = null;
let hostsContextHostId = null;
let groupsContextGroupId = null;
let terminalSelectionMenuPaneId = null;
let terminalSelectionMenuText = "";
let terminalSelectionMenuUrlValue = "";
let terminalSelectionMenuSftpPath = "";
const SETTINGS_KEY_SFTP_LOCAL_DIR = "zeroterm.settings.sftp.local_dir";
const SETTINGS_KEY_SYNC_AUTO = "zeroterm.settings.sync.auto";
const SETTINGS_KEY_SYNC_ACTIVE_PROFILE = "zeroterm.settings.sync.active_profile";
const SETTINGS_KEY_APP_THEME_MODE = "zeroterm.settings.app_theme_mode";
const SETTINGS_KEY_TERMINAL_THEME = "zeroterm.settings.terminal.theme";
const SETTINGS_KEY_TERMINAL_CUSTOM_THEMES = "zeroterm.settings.terminal.custom_themes";
const SETTINGS_KEY_TERMINAL_HIDDEN_BUILTIN_THEMES = "zeroterm.settings.terminal.hidden_builtin_themes";
const SETTINGS_KEY_TERMINAL_FONT_FAMILY = "zeroterm.settings.terminal.font_family";
const SETTINGS_KEY_TERMINAL_FONT_SIZE = "zeroterm.settings.terminal.font_size";
const SETTINGS_KEY_TERMINAL_LOCAL_SHELL = "zeroterm.settings.terminal.local_shell";
const SETTINGS_KEY_TERMINAL_LOCAL_CWD = "zeroterm.settings.terminal.local_cwd";
const SETTINGS_KEY_TERMINAL_LINE_HEIGHT = "zeroterm.settings.terminal.line_height";
const SETTINGS_KEY_TERMINAL_SELECTION_MENU_ORDER = "zeroterm.settings.terminal.selection_menu_order";
const SETTINGS_KEY_TERMINAL_ATTENTION_FLASH = "zeroterm.settings.terminal.attention_flash";
const TERMINAL_SELECTION_MENU_DEFAULT_ORDER = Object.freeze(["url", "search", "copy", "execute", "sftp", "ai"]);
const SETTINGS_KEY_APP_BG_OPACITY = "zeroterm.settings.app_background.opacity";
const SETTINGS_KEY_APP_BG_BLUR = "zeroterm.settings.app_background.blur";
const SETTINGS_KEY_APP_BG_ENABLED = "zeroterm.settings.app_background.enabled";
let settingsSection = "general";
let settingsTerminalSubtab = "font";
let settingsGeneralSubtab = "basic";
let syncProfiles = [];
let syncEditingId = null;
let settingsSftpHomeCache = null;
let appVersionCache = null;
let syncSingleProfileId = null;
let syncSecretsLoadToken = 0;
const syncDraftByBackend = {
  local_folder: null,
  webdav: null,
  s3: null,
};

const TERMINAL_THEMES = {
  "termark-dark": {
    background: "#10151f",
    foreground: "#d7e2f0",
    cursor: "#7dd3fc",
    selectionBackground: "#27384f",
    black: "#101624",
    red: "#ff6b7a",
    green: "#51d88a",
    yellow: "#f5c96b",
    blue: "#6aa5ff",
    magenta: "#c792ea",
    cyan: "#57d4ff",
    white: "#dbe7ff",
    brightBlack: "#60708c",
    brightRed: "#ff8793",
    brightGreen: "#7ee6a7",
    brightYellow: "#f8d98a",
    brightBlue: "#8dbbff",
    brightMagenta: "#d7a7f4",
    brightCyan: "#83e3ff",
    brightWhite: "#ffffff",
  },
  "kanagawa-wave": {
    background: "#151714",
    foreground: "#d8d3bb",
    cursor: "#a7c080",
    selectionBackground: "#30382c",
    black: "#111219",
    red: "#d8616b",
    green: "#8fb573",
    yellow: "#d6b56d",
    blue: "#7aa2e3",
    magenta: "#b18bd6",
    cyan: "#78b6a5",
    white: "#e4d8b4",
    brightBlack: "#5d6070",
    brightRed: "#ee7b84",
    brightGreen: "#a8c985",
    brightYellow: "#e8ca86",
    brightBlue: "#93b8ee",
    brightMagenta: "#c3a0e4",
    brightCyan: "#91c9b8",
    brightWhite: "#fff2c7",
  },
  "catppuccin-mocha": {
    background: "#1b1724",
    foreground: "#e8def2",
    cursor: "#c4b5fd",
    selectionBackground: "#3a3150",
    black: "#17131b",
    red: "#ff7a93",
    green: "#a6e3a1",
    yellow: "#f6d67b",
    blue: "#8aadff",
    magenta: "#f0a9df",
    cyan: "#91d7e3",
    white: "#f0dff1",
    brightBlack: "#66566e",
    brightRed: "#ff99ab",
    brightGreen: "#b9efb4",
    brightYellow: "#f9e29d",
    brightBlue: "#a7c1ff",
    brightMagenta: "#f7c2ea",
    brightCyan: "#a9e5ee",
    brightWhite: "#fff7ff",
  },
  nord: {
    background: "#111827",
    foreground: "#d6e4f0",
    cursor: "#9ed8ff",
    selectionBackground: "#263a52",
    black: "#0b1220",
    red: "#e97b83",
    green: "#9ccf91",
    yellow: "#e6c981",
    blue: "#8ab6df",
    magenta: "#c4a5d9",
    cyan: "#8dd4d8",
    white: "#d6e4f0",
    brightBlack: "#607080",
    brightRed: "#f0939a",
    brightGreen: "#b1dda7",
    brightYellow: "#efd79b",
    brightBlue: "#a5c9ec",
    brightMagenta: "#d5b9e5",
    brightCyan: "#a4e1e4",
    brightWhite: "#f8fbff",
  },
  "tokyo-day": {
    background: "#f4efe3",
    foreground: "#334155",
    cursor: "#2563eb",
    selectionBackground: "#d8e5f3",
    black: "#2f3a4a",
    red: "#c7444e",
    green: "#4f7d45",
    yellow: "#a56d24",
    blue: "#2f6f9f",
    magenta: "#8d5ca6",
    cyan: "#287f7a",
    white: "#f6f1e7",
    brightBlack: "#7f8793",
    brightRed: "#d85b64",
    brightGreen: "#629657",
    brightYellow: "#bd8438",
    brightBlue: "#4484b6",
    brightMagenta: "#a373ba",
    brightCyan: "#3b9992",
    brightWhite: "#fffaf1",
  },
  "catppuccin-latte": {
    background: "#f8fafc",
    foreground: "#334155",
    cursor: "#7c3aed",
    selectionBackground: "#e3e8f4",
    black: "#3f4560",
    red: "#c83e4d",
    green: "#3f8f59",
    yellow: "#b37718",
    blue: "#3f73d8",
    magenta: "#b45fc5",
    cyan: "#1f8c96",
    white: "#f7f8fc",
    brightBlack: "#9298ad",
    brightRed: "#d85a67",
    brightGreen: "#55a86e",
    brightYellow: "#ca8f2b",
    brightBlue: "#5b8be5",
    brightMagenta: "#c778d4",
    brightCyan: "#37a3ac",
    brightWhite: "#ffffff",
  },
  "sage-light": {
    background: "#eef4ed",
    foreground: "#2f3f37",
    cursor: "#15803d",
    selectionBackground: "#d6e4d8",
    black: "#2e3f38",
    red: "#b85d5b",
    green: "#4b855f",
    yellow: "#9a7a32",
    blue: "#3f6f8f",
    magenta: "#8a6695",
    cyan: "#3d837b",
    white: "#eef3ec",
    brightBlack: "#7d8a83",
    brightRed: "#c87573",
    brightGreen: "#62a176",
    brightYellow: "#b08f49",
    brightBlue: "#5687a7",
    brightMagenta: "#9f7daa",
    brightCyan: "#569b93",
    brightWhite: "#fbfff9",
  },
};


const TERMINAL_THEME_META = {
  "tokyo-day": { labelKey: "terminal.theme.name.tokyo_day", group: "light" },
  "catppuccin-latte": { labelKey: "terminal.theme.name.catppuccin_latte", group: "light" },
  "sage-light": { labelKey: "terminal.theme.name.sage_light", group: "light" },
  "termark-dark": { labelKey: "terminal.theme.name.termark_dark", group: "dark" },
  "kanagawa-wave": { labelKey: "terminal.theme.name.kanagawa_wave", group: "dark" },
  "catppuccin-mocha": { labelKey: "terminal.theme.name.catppuccin_mocha", group: "dark" },
};

function builtinTerminalThemeLabel(id) {
  const key = TERMINAL_THEME_META[id]?.labelKey;
  return key ? t(key) : id;
}

let terminalCustomThemes = [];
let terminalHiddenBuiltinThemes = [];
let terminalEditingThemeId = null;
let themeMenuTargetId = null;
let themeEditOriginal = null;
let themeEditOriginalLabel = "";
let themeEditIsNew = false;
let systemThemeMedia = null;

function loadCustomThemes() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY_TERMINAL_CUSTOM_THEMES) || "[]";
    const parsed = JSON.parse(raw);
    terminalCustomThemes = Array.isArray(parsed) ? parsed : [];
  } catch {
    terminalCustomThemes = [];
  }
  try {
    const rawHidden = localStorage.getItem(SETTINGS_KEY_TERMINAL_HIDDEN_BUILTIN_THEMES) || "[]";
    const parsedHidden = JSON.parse(rawHidden);
    terminalHiddenBuiltinThemes = Array.isArray(parsedHidden) ? parsedHidden.filter((id) => TERMINAL_THEME_META[id]) : [];
  } catch {
    terminalHiddenBuiltinThemes = [];
  }
}

function saveCustomThemes() {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_CUSTOM_THEMES, JSON.stringify(terminalCustomThemes));
  localStorage.setItem(SETTINGS_KEY_TERMINAL_HIDDEN_BUILTIN_THEMES, JSON.stringify(terminalHiddenBuiltinThemes));
}

function allTerminalThemes() {
  const customMap = {};
  const builtinMap = {};
  for (const [id] of Object.entries(TERMINAL_THEME_META)) {
    const theme = TERMINAL_THEMES[id];
    if (!theme) continue;
    if (!terminalHiddenBuiltinThemes.includes(id)) builtinMap[id] = theme;
  }
  for (const t of terminalCustomThemes) {
    customMap[t.id] = t.theme;
  }
  return { ...builtinMap, ...customMap };
}

function getTerminalThemeName() {
  const saved = localStorage.getItem(SETTINGS_KEY_TERMINAL_THEME);
  const allThemes = allTerminalThemes();

  // Whatever the user explicitly picked wins, regardless of the app's
  // light/dark mode. A terminal theme is a self-contained colour scheme,
  // so a light terminal theme is allowed under a dark app and vice versa.
  // (Custom themes were never constrained; built-in themes used to be
  // force-reverted here when their group didn't match the app mode — that
  // inconsistency is what this removes.) applyTerminalThemeToAllPanes()
  // already adapts the pane backdrop when the terminal theme doesn't match
  // the app mode, so text contrast stays fine.
  if (saved && allThemes[saved]) {
    return saved;
  }

  // No (valid) saved choice yet → default to one that matches the app mode.
  const appTheme = getResolvedAppTheme();
  const preferred = appTheme === "light" ? "tokyo-day" : "termark-dark";
  return allThemes[preferred] ? preferred : (Object.keys(allThemes)[0] || preferred);
}

function getAppThemeMode() {
  const saved = localStorage.getItem(SETTINGS_KEY_APP_THEME_MODE) || "system";
  return ["system", "dark", "light"].includes(saved) ? saved : "system";
}

function getResolvedAppTheme() {
  const mode = getAppThemeMode();
  if (mode === "dark" || mode === "light") return mode;
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function applyAppTheme() {
  try {
    document.body.dataset.appTheme = getResolvedAppTheme();
    if (themeModeButton) {
      const mode = getAppThemeMode();
      themeModeButton.dataset.mode = mode;
      themeModeButton.setAttribute("title", `${t("theme.mode.button")}: ${t(`theme.mode.${mode}`)}`);
      themeModeButton.setAttribute("aria-label", `${t("theme.mode.button")}: ${t(`theme.mode.${mode}`)}`);
    }
    themeModeSystem?.classList.toggle("active", getAppThemeMode() === "system");
    themeModeDark?.classList.toggle("active", getAppThemeMode() === "dark");
    themeModeLight?.classList.toggle("active", getAppThemeMode() === "light");

    // Apply changes to terminal views instantly
    applyTerminalThemeToAllPanes();
  } catch (e) {
    console.warn("applyAppTheme failed", e);
  }
}

function setAppThemeMode(mode) {
  localStorage.setItem(SETTINGS_KEY_APP_THEME_MODE, mode);
  applyAppTheme();
}

// --- Custom background image ----------------------------------------------
//
// The image itself lives on disk (managed by the Rust backend) and is read
// back as a base64 data URL — too large for localStorage, so only the
// opacity/blur/enabled preferences are persisted in localStorage. The data
// URL is held in memory for the session.

let appBackgroundDataUrl = null;
let appNetworkProxyConfig = null;

function applyNetworkProxySettingsUI(cfg) {
  appNetworkProxyConfig = cfg && cfg.enabled && String(cfg.url || "").trim()
    ? { enabled: true, url: String(cfg.url).trim() }
    : null;
  if (settingsProxyUrl) settingsProxyUrl.value = appNetworkProxyConfig?.url || "";
  if (settingsProxyClear) settingsProxyClear.hidden = !appNetworkProxyConfig;
}

async function loadNetworkProxyConfig(options = {}) {
  const quiet = options?.quiet === true;
  try {
    const cfg = await invoke("get_network_proxy_config");
    applyNetworkProxySettingsUI(cfg);
    if (settingsProxyStatus && !quiet) {
      settingsProxyStatus.textContent = cfg?.url
        ? t("settings.proxy.status.current", { url: cfg.url })
        : t("settings.proxy.status.disabled");
    }
  } catch (e) {
    if (settingsProxyStatus) settingsProxyStatus.textContent = String(e);
  }
}

async function saveNetworkProxyConfigFromForm() {
  const url = String(settingsProxyUrl?.value || "").trim();
  if (!url) {
    if (settingsProxyStatus) settingsProxyStatus.textContent = t("settings.proxy.error.required");
    return;
  }
  const cfg = await invoke("save_network_proxy_config", {
    input: { enabled: true, url },
  });
  applyNetworkProxySettingsUI(cfg);
  if (settingsProxyStatus) settingsProxyStatus.textContent = t("settings.proxy.status.saved");
  showToast(t("settings.proxy.status.saved"), "success");
}

async function clearNetworkProxyConfigFromForm() {
  await invoke("clear_network_proxy_config");
  applyNetworkProxySettingsUI(null);
  if (settingsProxyStatus) settingsProxyStatus.textContent = t("settings.proxy.status.cleared");
  showToast(t("settings.proxy.status.cleared"), "success");
}

function getAppBgOpacity() {
  const n = Number(localStorage.getItem(SETTINGS_KEY_APP_BG_OPACITY));
  return Number.isFinite(n) && n >= 5 && n <= 100 ? n : 40;
}

function getAppBgBlur() {
  const n = Number(localStorage.getItem(SETTINGS_KEY_APP_BG_BLUR));
  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : 0;
}

function appBgEnabled() {
  return localStorage.getItem(SETTINGS_KEY_APP_BG_ENABLED) === "true";
}

/// Push the current background image + opacity/blur to the DOM layer.
function applyAppBackground() {
  const layer = document.getElementById("app-bg-layer");
  if (!layer) return;
  const active = appBgEnabled() && !!appBackgroundDataUrl;
  if (active) {
    // Set styles directly (not via a CSS custom property) — data: URLs
    // inside var() substitution are unreliable in WebView2.
    layer.style.backgroundImage = `url("${appBackgroundDataUrl}")`;
    layer.style.opacity = String(getAppBgOpacity() / 100);
    layer.style.filter = `blur(${getAppBgBlur()}px)`;
    document.body.classList.add("has-app-bg");
  } else {
    layer.style.backgroundImage = "none";
    layer.style.opacity = "0";
    layer.style.filter = "none";
    document.body.classList.remove("has-app-bg");
  }
}

/// Load the saved image from the backend once on startup.
async function initAppBackground() {
  try {
    const dataUrl = await invoke("get_background_image");
    appBackgroundDataUrl = dataUrl || null;
  } catch (e) {
    console.warn("load background image failed", e);
    appBackgroundDataUrl = null;
  }
  applyAppBackground();
}

/// Reflect the current background state into the settings panel controls.
function syncBackgroundSettingsUI() {
  const hasImage = !!appBackgroundDataUrl;
  if (settingsBgPreview) {
    settingsBgPreview.dataset.empty = hasImage ? "false" : "true";
    settingsBgPreview.style.backgroundImage = hasImage
      ? `url("${appBackgroundDataUrl}")`
      : "";
  }
  if (settingsBgClear) settingsBgClear.hidden = !hasImage;
  if (settingsBgOptions) settingsBgOptions.hidden = !hasImage;
  if (settingsBgOpacity) settingsBgOpacity.value = String(getAppBgOpacity());
  if (settingsBgBlur) settingsBgBlur.value = String(getAppBgBlur());
}

async function chooseBackgroundImage() {
  let chosen;
  try {
    chosen = await invoke("plugin:dialog|open", {
      options: {
        multiple: false,
        directory: false,
        filters: [
          { name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        ],
      },
    });
  } catch (e) {
    if (settingsBgStatus) {
      settingsBgStatus.textContent = t("settings.bg.status.failed", { error: String(e) });
    }
    return;
  }
  if (!chosen) return;

  try {
    const dataUrl = await invoke("set_background_image", { path: String(chosen) });
    appBackgroundDataUrl = dataUrl;
    localStorage.setItem(SETTINGS_KEY_APP_BG_ENABLED, "true");
    applyAppBackground();
    syncBackgroundSettingsUI();
    if (settingsBgStatus) settingsBgStatus.textContent = t("settings.bg.status.applied");
  } catch (e) {
    if (settingsBgStatus) {
      settingsBgStatus.textContent = t("settings.bg.status.failed", { error: String(e) });
    }
  }
}

async function clearBackgroundImage() {
  try {
    await invoke("clear_background_image");
  } catch (e) {
    console.warn("clear background image failed", e);
  }
  appBackgroundDataUrl = null;
  localStorage.setItem(SETTINGS_KEY_APP_BG_ENABLED, "false");
  applyAppBackground();
  syncBackgroundSettingsUI();
  if (settingsBgStatus) settingsBgStatus.textContent = t("settings.bg.status.cleared");
}

// --- Startup window layout ------------------------------------------------
// "Layout" = the window size plus the left (vault) and right (terminal side
// panel) sidebar widths. The window size is persisted by the backend
// (config_dir/ZeroTerm/window.json) and applied in the Rust `setup` hook
// before the window is shown. The two sidebar widths are pure frontend CSS
// state, so they're kept in localStorage and applied synchronously at
// startup (no flash). One "save" action captures all three; one "reset"
// clears all three.

const DEFAULT_WINDOW_WIDTH = 1500;
const DEFAULT_WINDOW_HEIGHT = 860;

// Sidebar widths. Left bounds reuse VAULT_SIDEBAR_MIN/MAX; right bounds match
// the clamp in installAiPanelResize() and the CSS default of --ai-panel-width.
const SETTINGS_KEY_SIDEBAR_LEFT = "zeroterm.settings.sidebar.left_width";
const SETTINGS_KEY_SIDEBAR_RIGHT = "zeroterm.settings.sidebar.right_width";
const DEFAULT_VAULT_SIDEBAR_WIDTH = 320;
const AI_PANEL_MIN = 300;
const AI_PANEL_MAX = 620;
const DEFAULT_AI_PANEL_WIDTH = 390;

/// Format a logical size as "W × H" with rounded integers.
function formatWindowSize(width, height) {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/// Read a saved sidebar width from localStorage, or `null` if absent/invalid.
function getSavedSidebarWidth(key, min, max) {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

/// Apply a width to the right-side terminal panel (clamped), mirroring how
/// the splitter drag sets --ai-panel-width. Returns the clamped value.
function applyAiPanelWidth(width) {
  const clamped = Math.max(AI_PANEL_MIN, Math.min(AI_PANEL_MAX, Math.round(width)));
  terminalSessionLayout?.style.setProperty("--ai-panel-width", `${clamped}px`);
  return clamped;
}

/// Current effective right-panel width, read from the resolved CSS custom
/// property (reflects an inline drag value or the stylesheet default).
function getCurrentAiPanelWidth() {
  if (!terminalSessionLayout) return DEFAULT_AI_PANEL_WIDTH;
  const raw = getComputedStyle(terminalSessionLayout).getPropertyValue("--ai-panel-width");
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : DEFAULT_AI_PANEL_WIDTH;
}

/// Reflect the saved layout into the settings panel: show the saved values
/// (with a Reset button), or the defaults when nothing is saved.
async function syncWindowLayoutSettingsUI() {
  let savedWin = null;
  try {
    savedWin = await invoke("get_window_size_setting");
  } catch (e) {
    console.warn("load window size setting failed", e);
  }
  const savedLeft = getSavedSidebarWidth(SETTINGS_KEY_SIDEBAR_LEFT, VAULT_SIDEBAR_MIN, VAULT_SIDEBAR_MAX);
  const savedRight = getSavedSidebarWidth(SETTINGS_KEY_SIDEBAR_RIGHT, AI_PANEL_MIN, AI_PANEL_MAX);
  const hasSaved = !!savedWin || savedLeft != null || savedRight != null;

  if (settingsWinsizeCurrent) {
    const win = savedWin
      ? formatWindowSize(savedWin.width, savedWin.height)
      : formatWindowSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT);
    const left = `${savedLeft ?? DEFAULT_VAULT_SIDEBAR_WIDTH}px`;
    const right = `${savedRight ?? DEFAULT_AI_PANEL_WIDTH}px`;
    settingsWinsizeCurrent.textContent = t(
      hasSaved ? "settings.winsize.saved" : "settings.winsize.default",
      { win, left, right },
    );
  }
  if (settingsWinsizeReset) settingsWinsizeReset.hidden = !hasSaved;
}

/// Record the current window size + both sidebar widths as the startup layout.
async function recordWindowLayout() {
  // Sidebar widths are frontend state — persist them locally.
  localStorage.setItem(SETTINGS_KEY_SIDEBAR_LEFT, String(vaultSidebarWidth));
  localStorage.setItem(SETTINGS_KEY_SIDEBAR_RIGHT, String(getCurrentAiPanelWidth()));
  // Window size is captured by the backend from the live window.
  try {
    await invoke("save_window_size");
    await syncWindowLayoutSettingsUI();
    if (settingsWinsizeStatus) {
      settingsWinsizeStatus.textContent = t("settings.winsize.status.saved");
    }
  } catch (e) {
    if (settingsWinsizeStatus) {
      settingsWinsizeStatus.textContent = t("settings.winsize.status.failed", { error: String(e) });
    }
  }
}

/// Forget the saved layout; the app reverts to defaults on next launch. Like
/// the window size, this only clears the saved values — the live sidebars
/// keep their current width until the next launch.
async function resetWindowLayout() {
  localStorage.removeItem(SETTINGS_KEY_SIDEBAR_LEFT);
  localStorage.removeItem(SETTINGS_KEY_SIDEBAR_RIGHT);
  try {
    await invoke("clear_window_size_setting");
  } catch (e) {
    console.warn("clear window size setting failed", e);
  }
  await syncWindowLayoutSettingsUI();
  if (settingsWinsizeStatus) settingsWinsizeStatus.textContent = t("settings.winsize.status.reset");
}

async function resetLocalSettingsToDefaults() {
  const localKeysToRemove = [
    "zt.ai.contextMode",
    SETTINGS_KEY_AI_SYSTEM_PROMPT,
    SETTINGS_KEY_SFTP_LOCAL_DIR,
    SETTINGS_KEY_SYNC_AUTO_ENABLED,
    SETTINGS_KEY_SYNC_AUTO_INTERVAL,
    SETTINGS_KEY_SYNC_AUTO_ON_VISIBILITY,
    "zeroterm.sync.last",
    SETTINGS_KEY_APP_THEME_MODE,
    SETTINGS_KEY_TERMINAL_THEME,
    SETTINGS_KEY_TERMINAL_CUSTOM_THEMES,
    SETTINGS_KEY_TERMINAL_HIDDEN_BUILTIN_THEMES,
    SETTINGS_KEY_TERMINAL_FONT_FAMILY,
    SETTINGS_KEY_TERMINAL_FONT_SIZE,
    SETTINGS_KEY_TERMINAL_LOCAL_SHELL,
    SETTINGS_KEY_TERMINAL_LOCAL_CWD,
    SETTINGS_KEY_TERMINAL_LINE_HEIGHT,
    SETTINGS_KEY_TERMINAL_SELECTION_MENU_ORDER,
    SETTINGS_KEY_TERMINAL_ATTENTION_FLASH,
    SETTINGS_KEY_APP_BG_OPACITY,
    SETTINGS_KEY_APP_BG_BLUR,
    SETTINGS_KEY_APP_BG_ENABLED,
    GROUP_STATE_STORAGE_KEY,
    TERMINAL_SNIPPET_GROUP_STATE_KEY,
    SFTP_PINNED_PATHS_KEY,
  ];
  for (const key of localKeysToRemove) {
    localStorage.removeItem(key);
  }

  try {
    await invoke("clear_network_proxy_config");
  } catch (e) {
    console.warn("clear network proxy config failed", e);
  }
  applyNetworkProxySettingsUI(null);
  if (settingsProxyStatus) settingsProxyStatus.textContent = t("settings.proxy.status.disabled");

  await clearBackgroundImage();
  await resetWindowLayout();

  aiContextMode = "always";
  syncAiContextToggle();
  if (settingsAiSystemPrompt) settingsAiSystemPrompt.value = "";

  groupExpandedState = {};
  terminalSnippetGroupExpanded = {};

  if (settingsSftpLocalDir) {
    settingsSftpLocalDir.value = "";
    fillSftpLocalDirDefaultIfEmpty().catch(() => {});
  }

  loadCustomThemes();
  terminalEditingThemeId = getTerminalThemeName();
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
  if (settingsTerminalTheme) {
    settingsTerminalTheme.value = getTerminalThemeName();
    syncCustomSelect("settings-terminal-theme");
  }
  if (settingsTerminalFontFamily) {
    await populateTerminalFontFamilyOptionsAsync().catch((e) => {
      console.warn("populateTerminalFontFamilyOptionsAsync failed", e);
    });
  }
  if (settingsTerminalFontSize) settingsTerminalFontSize.value = String(getTerminalFontSize());
  if (settingsTerminalLineHeight) settingsTerminalLineHeight.value = String(getTerminalLineHeight());
  populateLocalShellSelect();
  updateLocalShellCurrentHint();
  if (settingsTerminalCwd) settingsTerminalCwd.value = getLocalCwd();
  if (settingsTerminalAttentionFlash) {
    settingsTerminalAttentionFlash.checked = isTerminalAttentionFlashEnabled();
  }
  applyAppTheme();
  applyTerminalThemeToAllPanes();
  syncTerminalFontPreview();
  syncTerminalThemeEditor();

  syncBackgroundSettingsUI();
  scheduleAutoSync();
  updateSyncIndicator();
  const autoSyncEnabledEl = document.getElementById("settings-sync-auto-enabled");
  const autoSyncIntervalEl = document.getElementById("settings-sync-auto-interval");
  const autoSyncVisibilityEl = document.getElementById("settings-sync-auto-visibility");
  if (autoSyncEnabledEl) autoSyncEnabledEl.checked = autoSyncEnabled();
  if (autoSyncIntervalEl) autoSyncIntervalEl.value = String(autoSyncInterval());
  if (autoSyncVisibilityEl) autoSyncVisibilityEl.checked = autoSyncOnVisibility();
}



function hideThemeModeMenu() {
  if (themeModeMenu) themeModeMenu.hidden = true;
}

function toggleThemeModeMenu(anchor) {
  if (!themeModeMenu || !anchor) return;
  if (!themeModeMenu.hidden) {
    hideThemeModeMenu();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  themeModeMenu.hidden = false;
  themeModeMenu.style.left = `${Math.max(8, rect.right - themeModeMenu.offsetWidth)}px`;
  themeModeMenu.style.top = `${Math.max(8, rect.top - themeModeMenu.offsetHeight - 8)}px`;
}

try {
  if (window.matchMedia) {
    systemThemeMedia = window.matchMedia("(prefers-color-scheme: light)");
    systemThemeMedia.addEventListener?.("change", () => {
      if (getAppThemeMode() === "system") applyAppTheme();
    });
  }

  applyAppTheme();
} catch (e) {
  console.warn("theme init failed", e);
}

// Load any saved background image and apply it (async; the layer stays
// empty until the image comes back).
initAppBackground();


function getTerminalThemeConfig() {
  return allTerminalThemes()[getTerminalThemeName()] || TERMINAL_THEMES["termark-dark"];
}

function getTerminalFontFamily() {
  return localStorage.getItem(SETTINGS_KEY_TERMINAL_FONT_FAMILY) || TERMINAL_FONT_STACK;
}

function normalizeTerminalFontFamily(savedValue, candidates = TERMINAL_FONT_CANDIDATES) {
  const value = String(savedValue || "").trim();
  if (!value) return TERMINAL_FONT_STACK;
  if (candidates.some((candidate) => candidate.value === value)) return value;

  if (value === '"SF Mono", Menlo, Monaco, Consolas, monospace') {
    const alias = ["SF Mono", "Menlo", "Monaco", "Consolas"];
    const matched = candidates.find((candidate) => alias.includes(candidate.family));
    return matched?.value || TERMINAL_FONT_STACK;
  }

  return value;
}

function isFontFamilyAvailable(fontFamily) {
  const family = String(fontFamily || "").trim();
  if (!family) return false;

  if (family === "ZeroTerm Meslo NF") return true;

  const sample = "mmmmmmmmmwwwwwiiiillll@@@#%&0123456789";
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;

  const quotedFamily = JSON.stringify(family);
  const measure = (font) => {
    context.font = `16px ${font}`;
    return context.measureText(sample).width;
  };

  const monospaceWidth = measure("monospace");
  const serifWidth = measure("serif");
  const sansWidth = measure("sans-serif");
  const targetMonoWidth = measure(`${quotedFamily}, monospace`);
  const targetSerifWidth = measure(`${quotedFamily}, serif`);
  const targetSansWidth = measure(`${quotedFamily}, sans-serif`);

  return targetMonoWidth !== monospaceWidth || targetSerifWidth !== serifWidth || targetSansWidth !== sansWidth;
}

function isLikelyMonospaceFont(fontFamily) {
  const family = String(fontFamily || "").trim();
  if (!family) return false;
  if (family === "ZeroTerm Meslo NF") return true;

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return false;

  const quotedFamily = JSON.stringify(family);
  const chars = ["i", "W", ".", "0", "@", "M", "1", " "];
  const widths = chars.map((char) => {
    context.font = `16px ${quotedFamily}, monospace`;
    return context.measureText(char).width;
  });
  const first = widths[0];
  return widths.every((width) => Math.abs(width - first) < 0.25);
}

function quoteFontFamily(fontFamily) {
  return JSON.stringify(String(fontFamily || "").trim());
}

function buildTerminalFontOptions(families) {
  const seen = new Set();
  const normalizedFamilies = [];
  for (const family of families) {
    const normalized = String(family || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    normalizedFamilies.push(normalized);
  }

  const prioritized = normalizedFamilies.filter((family) => family === "ZeroTerm Meslo NF");
  const sorted = normalizedFamilies
    .filter((family) => family !== "ZeroTerm Meslo NF")
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));

  return [...prioritized, ...sorted].map((family) => ({
    label: family,
    family,
    value: `${quoteFontFamily(family)}, monospace`,
  }));
}

async function loadSystemTerminalFonts() {
  if (Array.isArray(systemTerminalFontFamilies)) return systemTerminalFontFamilies;
  const fonts = await invoke("list_system_fonts");
  systemTerminalFontFamilies = Array.isArray(fonts)
    ? fonts.map((font) => String(font?.family || "").trim()).filter(Boolean)
    : [];
  return systemTerminalFontFamilies;
}

function populateTerminalFontFamilyOptions(candidates = TERMINAL_FONT_CANDIDATES, { validateAvailability = true } = {}) {
  if (!settingsTerminalFontFamily) return;
  try {
    const availableFonts = validateAvailability
      ? candidates.filter((candidate) => isFontFamilyAvailable(candidate.family))
      : candidates;
    const savedValue = normalizeTerminalFontFamily(getTerminalFontFamily(), availableFonts);
    const currentValue = normalizeTerminalFontFamily(settingsTerminalFontFamily.value, availableFonts);
    const nextValue = availableFonts.some((candidate) => candidate.value === savedValue)
      ? savedValue
      : availableFonts.some((candidate) => candidate.value === currentValue)
        ? currentValue
        : TERMINAL_FONT_STACK;

    settingsTerminalFontFamily.innerHTML = "";
    for (const candidate of availableFonts) {
      const option = document.createElement("option");
      option.value = candidate.value;
      option.textContent = candidate.label;
      settingsTerminalFontFamily.appendChild(option);
    }

    if (!availableFonts.some((candidate) => candidate.value === nextValue)) {
      const fallback = document.createElement("option");
      fallback.value = TERMINAL_FONT_STACK;
      fallback.textContent = "ZeroTerm Meslo NF";
      settingsTerminalFontFamily.appendChild(fallback);
    }

    settingsTerminalFontFamily.value = nextValue;
    localStorage.setItem(SETTINGS_KEY_TERMINAL_FONT_FAMILY, nextValue);
    syncCustomSelect("settings-terminal-font-family");
    syncTerminalFontPreview();
    applyTerminalThemeToAllPanes();
  } catch (e) {
    console.warn("populateTerminalFontFamilyOptions failed", e);
    settingsTerminalFontFamily.innerHTML = '<option value="\"ZeroTerm Meslo NF\", monospace">ZeroTerm Meslo NF</option>';
    settingsTerminalFontFamily.value = TERMINAL_FONT_STACK;
    syncCustomSelect("settings-terminal-font-family");
  }
}

async function populateTerminalFontFamilyOptionsAsync() {
  try {
    const systemFamilies = await loadSystemTerminalFonts();
    const monospaceFamilies = systemFamilies.filter((family) => isLikelyMonospaceFont(family));
    const systemOptions = buildTerminalFontOptions(["ZeroTerm Meslo NF", ...monospaceFamilies]);
    if (systemOptions.length > 0) {
      populateTerminalFontFamilyOptions(systemOptions, { validateAvailability: false });
      return;
    }
  } catch (e) {
    console.warn("loadSystemTerminalFonts failed", e);
  }

  populateTerminalFontFamilyOptions();
}

function getLocalShellPath() {
  return (localStorage.getItem(SETTINGS_KEY_TERMINAL_LOCAL_SHELL) || "").trim();
}

function getLocalCwd() {
  return (localStorage.getItem(SETTINGS_KEY_TERMINAL_LOCAL_CWD) || "").trim();
}

function defaultLocalShellLabel() {
  return isWindowsPlatform ? "cmd.exe" : "$SHELL";
}

const LOCAL_SHELL_SUGGESTIONS = isWindowsPlatform
  ? ["cmd.exe", "powershell.exe", "pwsh.exe", "wsl.exe", "C:\\Program Files\\Git\\bin\\bash.exe"]
  : ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/bin/fish"];

// Effective shell path shown in the settings combobox: a typed/browsed custom
// value (dataset.customValue) wins, otherwise the selected preset option.
function readLocalShellFromSelect() {
  if (!settingsTerminalShell) return "";
  return (settingsTerminalShell.dataset.customValue || settingsTerminalShell.value || "").trim();
}

function saveLocalShellFromSelect() {
  const v = readLocalShellFromSelect();
  if (v) localStorage.setItem(SETTINGS_KEY_TERMINAL_LOCAL_SHELL, v);
  else localStorage.removeItem(SETTINGS_KEY_TERMINAL_LOCAL_SHELL);
}

// Build the custom-dropdown options (system default + common shells) and select
// the saved value — as a preset option when it matches one, else a custom entry.
function populateLocalShellSelect() {
  if (!settingsTerminalShell) return;
  const saved = getLocalShellPath();
  const options = [`<option value="">${t("settings.terminal.shell.system_default")}</option>`]
    .concat(LOCAL_SHELL_SUGGESTIONS.map((s) => `<option value="${s}">${s}</option>`));
  settingsTerminalShell.innerHTML = options.join("");
  if (saved && LOCAL_SHELL_SUGGESTIONS.includes(saved)) {
    settingsTerminalShell.value = saved;
    settingsTerminalShell.dataset.customValue = "";
  } else {
    settingsTerminalShell.value = "";
    settingsTerminalShell.dataset.customValue = saved || "";
  }
  syncCustomSelect("settings-terminal-shell");
}

function updateLocalShellCurrentHint() {
  if (!settingsTerminalShellCurrent) return;
  settingsTerminalShellCurrent.textContent = t("settings.terminal.shell.current", { shell: defaultLocalShellLabel() });
}

function getTerminalFontSize() {
  const n = Number(localStorage.getItem(SETTINGS_KEY_TERMINAL_FONT_SIZE) || 13);
  return Number.isFinite(n) ? Math.min(24, Math.max(10, n)) : 13;
}

function getTerminalLineHeight() {
  const n = Number(localStorage.getItem(SETTINGS_KEY_TERMINAL_LINE_HEIGHT) || 1.25);
  return Number.isFinite(n) ? Math.min(2, Math.max(1, n)) : 1.25;
}

function applyTerminalThemeToAllPanes() {
  if (typeof termState === "undefined" || !termState || !termState.tabs) return;
  // While the theme editor is open, terminalEditingThemeId points at the
  // theme being edited (which may differ from the saved/active theme), so we
  // preview it live in the terminal. Outside the editor it tracks the active
  // theme (setTerminalTheme keeps it in sync), so this is a no-op there.
  const themeName = terminalEditingThemeId || getTerminalThemeName();
  const theme = allTerminalThemes()[themeName] || getTerminalThemeConfig();
  const resolvedAppTheme = getResolvedAppTheme();
  
  const customTheme = terminalCustomThemes.find((t) => t.id === themeName);
  const themeGroup = customTheme ? customTheme.group : (TERMINAL_THEME_META[themeName]?.group || "dark");
  const isDarkTerminal = themeGroup !== "light";
  const hasAppBg = document.body.classList.contains("has-app-bg");
  // With a background image set, force the terminal background transparent so
  // the image shows through (glass mode). The Canvas renderer composites glyphs
  // crisply over the transparent backdrop (unlike WebGL, whose alpha halo made
  // text look washed-out over bright parts of the image), so no scrim is
  // needed. Without an image, use the theme's own background colour.
  const xtermTheme = hasAppBg ? { ...theme, background: "#00000000" } : theme;

  for (const tab of termState.tabs) {
    for (const pane of tab.panes) {
      if (!pane.term) continue;
      // xterm 5.x removed setOption(); options are mutated directly and
      // take effect on the next render. The old setOption(...) calls threw
      // "is not a function" on the very first line here, which is why live
      // theme/font switching never actually reached an open terminal (and
      // aborted the rest of setTerminalTheme, including the card highlight).
      pane.term.options.theme = xtermTheme;
      pane.term.options.fontFamily = getTerminalFontFamily();
      pane.term.options.fontSize = getTerminalFontSize();
      pane.term.options.lineHeight = getTerminalLineHeight();
      
      // Pane container chrome — the glass backdrop when a background image
      // is set, or the solid theme-aware background otherwise — is owned by
      // CSS (`.term-pane` / `.pane-body` / `.pane-header`, keyed off
      // `body.has-app-bg` and `[data-app-theme]`). We must NOT set it inline
      // here: inline wins over CSS and would, e.g., paint an rgba tint over
      // the transparent `.term-pane`, which is exactly what broke the
      // see-through background after switching themes (this block only began
      // running once the setOption→options fix landed). Kept for reference
      // but intentionally disabled so CSS stays in charge.
      if (false && pane.rootEl && pane.bodyEl) {
        const header = pane.rootEl.querySelector(".pane-header");

        if (hasAppBg) {
          // Glassmorphic mode with custom background image
          // Apply a continuous frosted glass card backdrop to the entire pane (including header)
          pane.rootEl.style.backdropFilter = "blur(25px)";
          pane.rootEl.style.webkitBackdropFilter = "blur(25px)";
          pane.rootEl.style.border = "none";
          
          pane.bodyEl.style.background = "transparent";
          pane.bodyEl.style.backdropFilter = "none";
          pane.bodyEl.style.webkitBackdropFilter = "none";
          pane.bodyEl.style.border = "none";
          
          if (isDarkTerminal) {
            pane.rootEl.style.background = "rgba(8, 11, 20, 0.45)";
            
            if (header) {
              header.style.background = "transparent";
              header.style.borderBottom = "1px solid rgba(255, 255, 255, 0.12)";
              header.style.color = "rgba(221, 233, 255, 0.85)";
              const title = header.querySelector(".pane-title");
              if (title) title.style.color = "rgba(221, 233, 255, 0.85)";
            }
          } else {
            pane.rootEl.style.background = "rgba(255, 255, 255, 0.30)";
            
            if (header) {
              header.style.background = "transparent";
              header.style.borderBottom = "1px solid rgba(0, 0, 0, 0.12)";
              header.style.color = "#1e2030";
              const title = header.querySelector(".pane-title");
              if (title) title.style.color = "#1e2030";
            }
          }
        } else {
          // Standard solid theme background
          pane.bodyEl.style.background = "";
          pane.bodyEl.style.backdropFilter = "";
          pane.bodyEl.style.webkitBackdropFilter = "";
          pane.bodyEl.style.border = "";
          
          pane.rootEl.style.backdropFilter = "";
          pane.rootEl.style.webkitBackdropFilter = "";
          pane.rootEl.style.border = "";
          
          if (resolvedAppTheme === "light" && isDarkTerminal) {
            pane.rootEl.style.background = "#0f1424";
            if (header) {
              header.style.background = "rgba(13, 20, 38, 0.95)";
              header.style.borderBottom = "1px solid rgba(255, 255, 255, 0.08)";
              header.style.color = "rgba(221, 233, 255, 0.85)";
              const title = header.querySelector(".pane-title");
              if (title) title.style.color = "rgba(221, 233, 255, 0.85)";
            }
          } else if (resolvedAppTheme === "dark" && !isDarkTerminal) {
            pane.rootEl.style.background = "#eff1f5";
            if (header) {
              header.style.background = "rgba(240, 242, 247, 0.95)";
              header.style.borderBottom = "1px solid rgba(0, 0, 0, 0.08)";
              header.style.color = "#1e2030";
              const title = header.querySelector(".pane-title");
              if (title) title.style.color = "#1e2030";
            }
          } else {
            pane.rootEl.style.background = "";
            if (header) {
              header.style.background = "";
              header.style.borderBottom = "";
              header.style.color = "";
              const title = header.querySelector(".pane-title");
              if (title) title.style.color = "";
            }
          }
        }
      }
      
      requestPaneFit(pane, { immediate: true });
    }
  }
}

function syncTerminalFontPreview() {
  const pre = settingsTerminalFontPreview?.querySelector("pre");
  if (!pre) return;
  pre.style.fontFamily = getTerminalFontFamily();
  pre.style.fontSize = `${getTerminalFontSize()}px`;
  pre.style.lineHeight = String(getTerminalLineHeight());
}

function syncTerminalThemeCardsActive() {
  const active = getTerminalThemeName();
  const terminalThemeCards = Array.from(document.querySelectorAll(".terminal-theme-card"));
  for (const card of terminalThemeCards) {
    card.classList.toggle("active", card.dataset.theme === active);
  }
}

function setTerminalTheme(themeId) {
  const themes = allTerminalThemes();
  const next = themes[themeId] ? themeId : (Object.keys(themes)[0] || "termark-dark");
  terminalEditingThemeId = next;
  localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, next);
  if (settingsTerminalTheme) {
    settingsTerminalTheme.value = next;
    syncCustomSelect("settings-terminal-theme");
  }
  // Reflect the choice in the UI (card highlight + editor) BEFORE touching
  // live terminals, and isolate the pane apply in try/catch. Otherwise an
  // error while applying to an open terminal aborts setTerminalTheme and
  // leaves the selected-card highlight stuck on the previous theme — the
  // choice still persisted, which is why it "fixed itself" on reopening
  // settings.
  syncTerminalThemeCardsActive();
  syncTerminalThemeEditor();
  try {
    applyTerminalThemeToAllPanes();
  } catch (e) {
    console.warn("applyTerminalThemeToAllPanes failed", e);
  }
}

function makeThemePreviewBlock(themeName, themeConfig) {
  const themeGroup = resolveTerminalThemeGroup(themeName);
  const p = document.createElement("pre");
  p.className = "terminal-theme-preview " + themeGroup;
  p.textContent = "root@termark$ ls\ndrwxr-xr-x 1 root  boot\ndrwxr-xr-x 1 root  data";
  if (themeConfig) {
    if (isFullyTransparentColor(themeConfig.background)) {
      // Keep CSS fallback preview background for transparent terminal themes.
      p.style.background = "";
    } else {
      p.style.background = toOpaqueHex(themeConfig.background);
    }
    p.style.color = toOpaqueHex(themeConfig.foreground);
  }
  return p;
}

function renderTerminalThemeCards() {
  if (!terminalThemeListLight || !terminalThemeListDark) return;
  terminalThemeListLight.innerHTML = "";
  terminalThemeListDark.innerHTML = "";

  const themes = allTerminalThemes();

  const addCard = (id, label, group) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "terminal-theme-card";
    card.dataset.theme = id;
    const name = document.createElement("div");
    name.className = "terminal-theme-name";
    name.textContent = label;
    card.append(name, makeThemePreviewBlock(id, themes[id]));
    // Click / context-menu are handled by delegation on the stable list
    // containers (bound once below), so a card responds even if it's the
    // static HTML fallback that renderTerminalThemeCards hasn't replaced.
    terminalThemeListLight.appendChild(card);
  };

  Object.entries(TERMINAL_THEME_META).forEach(([id, meta]) => {
    if (terminalHiddenBuiltinThemes.includes(id)) return;
    const override = terminalCustomThemes.find((t) => t.id === id);
    addCard(id, override?.label || builtinTerminalThemeLabel(id), override?.group || meta.group);
  });
  terminalCustomThemes
    .filter((t) => !TERMINAL_THEME_META[t.id])
    .forEach((t) => addCard(t.id, t.label, t.group));
  syncTerminalThemeCardsActive();
}

// Delegate theme-card clicks on the stable list containers. Binding here
// once (instead of per-card inside renderTerminalThemeCards) means a card
// responds even if the per-card render hasn't run — e.g. the static HTML
// cards on first paint, or an init that got interrupted. This fixes the
// intermittent "clicking a theme card does nothing until restart".
for (const themeListContainer of [terminalThemeListLight, terminalThemeListDark]) {
  if (!themeListContainer) continue;
  themeListContainer.addEventListener("click", (ev) => {
    const card = ev.target.closest?.(".terminal-theme-card");
    if (card && themeListContainer.contains(card) && card.dataset.theme) {
      setTerminalTheme(card.dataset.theme);
    }
  });
  themeListContainer.addEventListener("contextmenu", (ev) => {
    const card = ev.target.closest?.(".terminal-theme-card");
    if (card && themeListContainer.contains(card) && card.dataset.theme) {
      ev.preventDefault();
      themeMenuTargetId = card.dataset.theme;
      showThemeCardMenu(ev.clientX, ev.clientY);
    }
  });
}

function generateCustomThemeId() {
  let id = `custom-${Date.now()}`;
  while (terminalCustomThemes.some((t) => t.id === id)) {
    id = `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  }
  return id;
}

function showThemeCardMenu(x, y) {
  if (!themeCardMenu) return;
  const currentTheme = getTerminalThemeName();
  const exists = Boolean(themeMenuTargetId && allTerminalThemes()[themeMenuTargetId]);
  if (themeMenuEdit) {
    themeMenuEdit.disabled = !exists;
  }
  if (themeMenuDelete) {
    themeMenuDelete.disabled = !exists || themeMenuTargetId === currentTheme;
  }
  themeCardMenu.style.left = "0px";
  themeCardMenu.style.top = "0px";
  themeCardMenu.hidden = false;

  const pad = 8;
  const rect = themeCardMenu.getBoundingClientRect();
  let left = x;
  let top = y;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, window.innerHeight - rect.height - pad);
  }
  themeCardMenu.style.left = `${left}px`;
  themeCardMenu.style.top = `${top}px`;
}

function toOpaqueHex(color) {
  if (!color) return "#000000";
  if (color.length === 9) return color.slice(0, 7);
  if (color.length === 7) return color;
  return "#000000";
}

function isFullyTransparentColor(color) {
  if (!color) return true;
  const normalized = String(color).trim().toLowerCase();
  const hexMatch = normalized.match(/^#([0-9a-f]{8})$/);
  if (hexMatch) return hexMatch[1].slice(6, 8) === "00";
  const rgbaMatch = normalized.match(
    /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(-?\d*\.?\d+)\s*\)$/,
  );
  if (rgbaMatch) return Number(rgbaMatch[1]) === 0;
  return false;
}

function resolveTerminalThemeGroup(themeName) {
  const customTheme = terminalCustomThemes.find((t) => t.id === themeName);
  return customTheme?.group || TERMINAL_THEME_META[themeName]?.group || "dark";
}

function getDefaultTerminalThemeForGroup(group) {
  const preferredGroup = group === "light" ? "light" : "dark";
  return Object.entries(TERMINAL_THEME_META)
    .find(([id, meta]) => meta.group === preferredGroup && !terminalHiddenBuiltinThemes.includes(id))?.[0]
    || Object.keys(allTerminalThemes())[0]
    || "termark-dark";
}

function syncTerminalThemeEditor() {
  const currentId = terminalEditingThemeId || getTerminalThemeName();
  const customTheme = terminalCustomThemes.find((t) => t.id === currentId);
  const theme = allTerminalThemes()[currentId] || getTerminalThemeConfig();
  if (themeEditTitle) {
    themeEditTitle.textContent = t(themeEditIsNew ? "theme.create.title" : "theme.edit.title");
  }
  if (themeEditName) themeEditName.value = customTheme?.label || "";
  if (themeColorBg) themeColorBg.value = toOpaqueHex(theme.background);
  if (themeColorFg) themeColorFg.value = toOpaqueHex(theme.foreground);
  if (themeColorCursor) themeColorCursor.value = toOpaqueHex(theme.cursor);
  if (themeColorSelection) themeColorSelection.value = toOpaqueHex(theme.selectionBackground);
  if (themeHexBg) themeHexBg.value = toOpaqueHex(theme.background);
  if (themeHexFg) themeHexFg.value = toOpaqueHex(theme.foreground);
  if (themeHexCursor) themeHexCursor.value = toOpaqueHex(theme.cursor);
  if (themeHexSelection) themeHexSelection.value = toOpaqueHex(theme.selectionBackground);
  if (themeMenuDelete) themeMenuDelete.disabled = currentId === getTerminalThemeName();
  updateThemeEditPreview(theme);
}

function updateThemeEditPreview(theme) {
  if (!themeEditPreview) return;
  const pre = themeEditPreview.querySelector("pre");
  if (!pre) return;
  const themeName = terminalEditingThemeId || getTerminalThemeName();
  const themeGroup = resolveTerminalThemeGroup(themeName);
  if (isFullyTransparentColor(theme.background)) {
    pre.style.background = themeGroup === "light" ? "#eff1f5" : "#0a1020";
  } else {
    pre.style.background = toOpaqueHex(theme.background);
  }
  pre.style.color = toOpaqueHex(theme.foreground);
}

function updateCustomThemeColor(key, value) {
  const currentId = terminalEditingThemeId || getTerminalThemeName();
  const idx = terminalCustomThemes.findIndex((t) => t.id === currentId);
  if (idx < 0) return;
  terminalCustomThemes[idx].theme[key] = value;
  updateThemeEditPreview(terminalCustomThemes[idx].theme);
  if (!themeEditIsNew) saveCustomThemes();
  applyTerminalThemeToAllPanes();
  renderTerminalThemeCards();
  syncTerminalThemeCardsActive();
}

function updateCustomThemeLabel(label) {
  const currentId = terminalEditingThemeId || getTerminalThemeName();
  const idx = terminalCustomThemes.findIndex((t) => t.id === currentId);
  if (idx < 0) return;
  terminalCustomThemes[idx].label = label;
  renderTerminalThemeCards();
  syncTerminalThemeCardsActive();
}

function openThemeCreateDialog(group) {
  const activeCardThemeId = document.querySelector(".terminal-theme-card.active")?.dataset?.theme;
  const sourceThemeId = activeCardThemeId || getTerminalThemeName();
  const sourceTheme = allTerminalThemes()[sourceThemeId] || getTerminalThemeConfig();
  const baseTheme = JSON.parse(JSON.stringify(sourceTheme));
  const id = generateCustomThemeId();
  terminalCustomThemes.push({ id, label: "", group: group || resolveTerminalThemeGroup(sourceThemeId), theme: baseTheme });
  terminalEditingThemeId = id;
  themeEditOriginal = JSON.parse(JSON.stringify(baseTheme));
  themeEditOriginalLabel = "";
  themeEditIsNew = true;
  syncTerminalThemeEditor();
  if (themeEditOverlay) themeEditOverlay.hidden = false;
  requestAnimationFrame(() => {
    themeEditName?.focus();
    themeEditName?.select();
  });
}

function openThemeEditDialog(themeId) {
  let idx = terminalCustomThemes.findIndex((t) => t.id === themeId);
  if (idx < 0) {
    const builtinTheme = TERMINAL_THEMES[themeId];
    const meta = TERMINAL_THEME_META[themeId];
    if (!builtinTheme || !meta || terminalHiddenBuiltinThemes.includes(themeId)) return;
    terminalCustomThemes.push({
      id: themeId,
      label: builtinTerminalThemeLabel(themeId),
      group: meta.group,
      theme: JSON.parse(JSON.stringify(builtinTheme)),
    });
    idx = terminalCustomThemes.length - 1;
    saveCustomThemes();
  }
  terminalEditingThemeId = themeId;
  themeEditOriginal = JSON.parse(JSON.stringify(terminalCustomThemes[idx].theme));
  themeEditOriginalLabel = terminalCustomThemes[idx].label || "";
  themeEditIsNew = false;
  syncTerminalThemeEditor();
  if (themeEditOverlay) themeEditOverlay.hidden = false;
}

function rebuildTerminalThemeSelectOptions() {
  if (!settingsTerminalTheme) return;
  const selected = getTerminalThemeName();
  settingsTerminalTheme.innerHTML = "";
  Object.entries(TERMINAL_THEME_META).forEach(([id, meta]) => {
    if (terminalHiddenBuiltinThemes.includes(id)) return;
    const override = terminalCustomThemes.find((theme) => theme.id === id);
    const o = document.createElement("option");
    o.value = id;
    o.textContent = override?.label || builtinTerminalThemeLabel(id);
    settingsTerminalTheme.appendChild(o);
  });
  terminalCustomThemes.filter((t) => !TERMINAL_THEME_META[t.id]).forEach((t) => {
    const o = document.createElement("option");
    o.value = t.id;
    o.textContent = t.label;
    settingsTerminalTheme.appendChild(o);
  });
  settingsTerminalTheme.value = selected;
  syncCustomSelect("settings-terminal-theme");
}

const VAULT_SIDEBAR_MIN = 240;
const VAULT_SIDEBAR_MAX = 700;

function loadGroupExpansionState() {
  // Product decision: always start with all groups collapsed.
  // We still update/save the state during runtime for immediate UX,
  // but on next app launch we reset to collapsed again.
  groupExpandedState = {};
}

function saveGroupExpansionState() {
  localStorage.setItem(GROUP_STATE_STORAGE_KEY, JSON.stringify(groupExpandedState));
}

function expandGroupWithAncestors(groupId) {
  let current = String(groupId || "");
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    groupExpandedState[current] = true;
    const g = hostGroups.find((it) => it.id === current);
    current = g?.parentId ? String(g.parentId) : "";
  }
}

/// Pull the host_group list from the vault and stash it in memory.
/// Detects cycles and breaks them in-memory only — the vault stays
/// unchanged so a concurrent edit on another device that breaks the
/// cycle "naturally" wins next sync. Orphan child references (parent_id
/// points at a group that no longer exists) are also cleared in memory
/// so the tree renders them as roots.
async function reloadHostGroupsFromVault() {
  try {
    const dtos = await invoke("list_host_groups");
    hostGroups = Array.isArray(dtos)
      ? dtos.map((g) => ({
          id: String(g.id || ""),
          name: String(g.name || ""),
          parentId: g.parentId ? String(g.parentId) : "",
          sortOrder: Number.isFinite(g.sortOrder) ? Number(g.sortOrder) : 0,
        }))
      : [];
  } catch (e) {
    console.warn("list_host_groups failed", e);
    hostGroups = [];
  }
  reconcileHostGroupTree();
}

/// Walk the in-memory `hostGroups` and clear `parentId` when:
///   - the parent doesn't exist (orphan child),
///   - the chain of parents loops back to the node itself (cycle).
/// Mutates `hostGroups[*].parentId` only — never touches the vault.
function reconcileHostGroupTree() {
  const byId = new Map(hostGroups.map((g) => [g.id, g]));
  for (const g of hostGroups) {
    if (!g.parentId) continue;
    if (!byId.has(g.parentId)) {
      g.parentId = "";
      continue;
    }
    const seen = new Set([g.id]);
    let cursor = byId.get(g.parentId);
    let cycle = false;
    while (cursor) {
      if (seen.has(cursor.id)) {
        cycle = true;
        break;
      }
      seen.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null;
    }
    if (cycle) g.parentId = "";
  }
}

function populateHostGroupOptions(selectedGroupId = "") {
  if (!hfGroup) return;
  hfGroup.dataset.emptyDisplay = "";
  hfGroup.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("groups.option.ungrouped");
  hfGroup.appendChild(none);

  const roots = hostGroups.filter((g) => !g.parentId);
  const appendGroup = (group, depth) => {
    const opt = document.createElement("option");
    opt.value = group.id;
    opt.textContent = `${"  ".repeat(depth)}${group.name}`;
    hfGroup.appendChild(opt);
    for (const child of hostGroups.filter((g) => (g.parentId || "") === group.id)) {
      appendGroup(child, depth + 1);
    }
  };
  for (const g of roots) appendGroup(g, 0);
  hfGroup.value = selectedGroupId || "";
  syncCustomSelect("hf-group");
}

function applyVaultSidebarWidth(width) {
  const clamped = Math.max(VAULT_SIDEBAR_MIN, Math.min(VAULT_SIDEBAR_MAX, Math.round(width)));
  vaultSidebarWidth = clamped;
  vaultLayout?.style.setProperty("--vault-sidebar-width", `${clamped}px`);
}

function setWindowMaximizeButtonState(maximized) {
  windowIsMaximized = Boolean(maximized);
  if (!windowMaximizeButton) return;
  windowMaximizeButton.dataset.maximized = windowIsMaximized ? "true" : "false";
  windowMaximizeButton.innerHTML = windowIsMaximized
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5h6.5v6.5"></path><path d="M4 6h6v6H4z"></path></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2"></rect></svg>';
  windowMaximizeButton.setAttribute("title", t(windowIsMaximized ? "window.restore" : "window.maximize"));
}

async function syncWindowMaximizeButtonState() {
  if (!isWindowsPlatform || !appWindow || typeof appWindow.isMaximized !== "function") {
    setWindowMaximizeButtonState(false);
    return;
  }
  try {
    const maximized = await appWindow.isMaximized();
    setWindowMaximizeButtonState(maximized);
  } catch (e) {
    console.warn("isMaximized failed", e);
  }
}

function isTitlebarInteractiveTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  if (target.closest(".term-tab-scroll-wrap") && !target.closest("button, .tab-item")) return false;
  return Boolean(
    target.closest(
      "button, input, select, textarea, a, .tab-item, .workspace-tab, .workspace-icon-btn, [data-tauri-drag-region='false']",
    ),
  );
}

if (workspaceTitlebar && appWindow?.startDragging) {
  bindDragOnBar(workspaceTitlebar);
}
bindDragOnBar(vaultLeftTopbar);
bindDragOnBar(vaultRightTopbar);

if (windowControls) {
  windowControls.hidden = !isWindowsPlatform;
}

if (appWindow) {
  if (workspaceTitlebar) {
    bindDblclickMaximizeOnBar(workspaceTitlebar);
  }
  bindDblclickMaximizeOnBar(vaultLeftTopbar);
  bindDblclickMaximizeOnBar(vaultRightTopbar);
  window.addEventListener("resize", () => {
    syncWindowMaximizeButtonState();
  });
}

let windowCloseRequestPromise = null;

async function getActivePortForwardsForCloseCheck() {
  try {
    const rows = await invoke("list_port_forward_status");
    return Array.isArray(rows) ? rows.filter((row) => row?.active) : [];
  } catch (e) {
    console.warn("list_port_forward_status for close check failed", e);
    return Array.isArray(portForwardRowsCache) ? portForwardRowsCache.filter((row) => row?.active) : [];
  }
}

async function closeAppWindowNow() {
  await invoke("destroy_current_window");
}

async function requestWindowClose() {
  if (!appWindow) return;
  if (windowCloseRequestPromise) return windowCloseRequestPromise;
  windowCloseRequestPromise = (async () => {
    const activeForwards = await getActivePortForwardsForCloseCheck();
    if (!activeForwards.length) {
      await closeAppWindowNow();
      return;
    }
    const ok = await openConfirmDialog({
      title: t("port_forward.confirm.close_app.title"),
      message: t("port_forward.confirm.close_app", { count: activeForwards.length }),
      okText: t("window.close"),
      cancelText: t("snippets.dialog.cancel"),
    });
    if (!ok) return;
    await closeAppWindowNow();
  })()
    .catch((e) => {
      console.warn("requestWindowClose failed", e);
    })
    .finally(() => {
      windowCloseRequestPromise = null;
    });
  return windowCloseRequestPromise;
}

function installWindowCloseInterceptor() {
  if (!appWindow || typeof appWindow.onCloseRequested !== "function") return;
  try {
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      requestWindowClose();
    });
  } catch (e) {
    console.warn("install close interceptor failed", e);
  }
}

if (isWindowsPlatform && appWindow) {
  if (windowMinimizeButton) {
    windowMinimizeButton.addEventListener("click", () => {
      appWindow.minimize().catch((e) => {
        console.warn("minimize failed", e);
      });
    });
  }
  if (windowMaximizeButton) {
    windowMaximizeButton.addEventListener("click", () => {
      appWindow.toggleMaximize().catch((e) => {
        console.warn("toggleMaximize failed", e);
      }).finally(() => {
        syncWindowMaximizeButtonState();
      });
    });
  }
  if (windowCloseButton) {
    windowCloseButton.addEventListener("click", () => {
      requestWindowClose();
    });
  }
  syncWindowMaximizeButtonState();
}

installWindowCloseInterceptor();

function closeTextInputDialog(result) {
  if (!textInputResolver) return;
  const resolve = textInputResolver;
  textInputResolver = null;
  textInputOverlay.hidden = true;
  textInputValue.value = "";
  textInputMessage.textContent = "";
  resolve(result);
}

function openTextInputDialog({ title, message = "", defaultValue = "", placeholder = "" }) {
  if (textInputResolver) {
    closeTextInputDialog(null);
  }

  return new Promise((resolve) => {
    textInputResolver = resolve;
    textInputTitle.textContent = title || t("input.title");
    textInputMessage.textContent = message;
    textInputValue.placeholder = placeholder || t("input.placeholder");
    textInputValue.value = defaultValue;
    textInputOverlay.hidden = false;
    requestAnimationFrame(() => {
      textInputValue.focus();
      textInputValue.select();
    });
  });
}

function closeConfirmDialog(result) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  if (confirmOverlay) confirmOverlay.hidden = true;
  resolve(Boolean(result));
}

function openConfirmDialog({ title, message = "", okText = "OK", cancelText = "Cancel", danger = true } = {}) {
  if (confirmResolver) closeConfirmDialog(false);
  return new Promise((resolve) => {
    if (!confirmOverlay || !confirmTitle || !confirmMessage || !confirmOkButton || !confirmCancelButton) {
      resolve(false);
      return;
    }
    confirmResolver = resolve;
    confirmTitle.textContent = title || "Confirm";
    confirmMessage.textContent = message;
    confirmOkButton.textContent = okText;
    confirmCancelButton.textContent = cancelText;
    confirmOkButton.classList.toggle("confirm-danger-text", danger);
    confirmOkButton.classList.toggle("primary", !danger);
    confirmOverlay.hidden = false;
    requestAnimationFrame(() => confirmOkButton.focus());
  });
}

function permissionsModeToCheckboxes(modeText) {
  const normalized = normalizePermissionModeInput(modeText) || "000";
  const mode = Number.parseInt(normalized, 8) & 0o777;
  return {
    ownerRead: Boolean(mode & 0o400),
    ownerWrite: Boolean(mode & 0o200),
    ownerExec: Boolean(mode & 0o100),
    groupRead: Boolean(mode & 0o040),
    groupWrite: Boolean(mode & 0o020),
    groupExec: Boolean(mode & 0o010),
    otherRead: Boolean(mode & 0o004),
    otherWrite: Boolean(mode & 0o002),
    otherExec: Boolean(mode & 0o001),
  };
}

function permissionsCheckboxesToMode() {
  let mode = 0;
  if (permissionCheckboxes.ownerRead?.checked) mode |= 0o400;
  if (permissionCheckboxes.ownerWrite?.checked) mode |= 0o200;
  if (permissionCheckboxes.ownerExec?.checked) mode |= 0o100;
  if (permissionCheckboxes.groupRead?.checked) mode |= 0o040;
  if (permissionCheckboxes.groupWrite?.checked) mode |= 0o020;
  if (permissionCheckboxes.groupExec?.checked) mode |= 0o010;
  if (permissionCheckboxes.otherRead?.checked) mode |= 0o004;
  if (permissionCheckboxes.otherWrite?.checked) mode |= 0o002;
  if (permissionCheckboxes.otherExec?.checked) mode |= 0o001;
  return mode.toString(8).padStart(3, "0");
}

function syncPermissionsCheckboxesFromOctal() {
  if (!permissionsOctal) return;
  const modeText = normalizePermissionModeInput(permissionsOctal.value);
  if (!modeText) return;
  permissionsSyncingFromOctal = true;
  const next = permissionsModeToCheckboxes(modeText);
  for (const [key, value] of Object.entries(next)) {
    if (permissionCheckboxes[key]) permissionCheckboxes[key].checked = value;
  }
  permissionsSyncingFromOctal = false;
}

function syncPermissionsOctalFromCheckboxes() {
  if (!permissionsOctal || permissionsSyncingFromOctal) return;
  permissionsSyncingFromChecks = true;
  permissionsOctal.value = permissionsCheckboxesToMode();
  permissionsSyncingFromChecks = false;
}

function closePermissionsDialog(result) {
  if (!permissionsResolver) return;
  const resolve = permissionsResolver;
  permissionsResolver = null;
  permissionsOverlay.hidden = true;
  permissionsError.hidden = true;
  permissionsError.textContent = "";
  permissionsOctal.value = "";
  resolve(result);
}

function openPermissionsDialog({ defaultValue = "644" } = {}) {
  if (permissionsResolver) closePermissionsDialog(null);
  return new Promise((resolve) => {
    permissionsResolver = resolve;
    permissionsTitle.textContent = t("files.permissions.title");
    permissionsMessage.textContent = t("files.prompt.permissions");
    permissionsError.hidden = true;
    permissionsError.textContent = "";
    permissionsOctal.value = normalizePermissionModeInput(defaultValue) || "644";
    syncPermissionsCheckboxesFromOctal();
    permissionsOverlay.hidden = false;
    requestAnimationFrame(() => {
      permissionsOctal.focus();
      permissionsOctal.select();
    });
  });
}

async function refreshHostsCacheFromVault({ silent = false } = {}) {
  try {
    hostsCache = await invoke("list_hosts");
    renderHosts();
    syncSftpHostOptions();
  } catch (e) {
    if (silent) {
      console.warn("refresh hosts cache failed", e);
      return;
    }
    throw e;
  }
}

// Re-pull every vault-backed view after a sync/join. Hosts, host groups
// and snippets all live in the vault, so any pull can touch all three —
// refresh them together so the UI never needs a manual page reload.
async function refreshAllSyncedViewsFromVault() {
  try {
    await refreshHostsCacheFromVault({ silent: true });
  } catch (e) {
    console.warn("post-sync hosts refresh failed", e);
  }
  try {
    if (typeof reloadHostGroupsFromVault === "function") await reloadHostGroupsFromVault();
  } catch (e) {
    console.warn("post-sync host-groups refresh failed", e);
  }
  const hostsView = document.getElementById("view-hosts");
  if (hostsView && !hostsView.hidden && typeof renderHosts === "function") renderHosts();
  try {
    if (typeof refreshSnippetsAndRender === "function") await refreshSnippetsAndRender();
  } catch (e) {
    console.warn("post-sync snippets refresh failed", e);
  }
}

async function warnIfMalformedSyncedHosts() {
  try {
    const d = await invoke("host_sync_diagnostics");
    const bad = Number(d?.malformedHosts ?? 0);
    if (bad > 0) {
      showToast(
        t("settings.sync.host_diag.malformed", {
          bad,
          ok: Number(d?.parsedHosts ?? 0),
          total: Number(d?.rawHostRecords ?? 0),
        }),
        "warning",
        6200,
      );
    }
  } catch {
    // Best-effort diagnostics only.
  }
}

function setWorkspaceMode(mode) {
  workspaceMode = mode;
  if (mode !== "sftp") {
    hideFilesContextMenu();
  }
  const showingSftp = mode === "sftp";
  const showingTerminal = mode === "terminal";
  const showingSettings = mode === "settings";
  const showingPortForward = mode === "port-forward";
  panelVaults.hidden = false;
  panelTerminal.hidden = true;
  panelSftp.hidden = mode !== "sftp";
  if (settingsPage) settingsPage.hidden = !showingSettings;
  if (vaultWelcome) vaultWelcome.hidden = showingTerminal || showingSftp || showingSettings || showingPortForward;
  if (portForwardPage) portForwardPage.hidden = !showingPortForward;
  if (terminalSessionLayout) terminalSessionLayout.hidden = !showingTerminal;
  else if (terminalWorkspace) terminalWorkspace.hidden = !showingTerminal;
  terminalSessionLayout?.classList.toggle("ai-collapsed", aiPanelCollapsed);
  workspaceTabVaults.classList.toggle("active", mode === "vaults");
  workspaceTabSftp.classList.toggle("active", mode === "sftp");
  workspaceNavVaults?.classList.toggle("active", mode === "vaults");
  workspaceNavSftp?.classList.toggle("active", mode === "sftp");
  portForwardButton?.classList.toggle("active", showingPortForward);
  if (mode === "terminal") {
    renderTerminalWorkspace();
  } else if (mode === "sftp") {
    ensureDefaultSftpPaneState();
  } else if (mode === "settings") {
    setSettingsSection(settingsSection);
    if (settingsLanguageSelect) settingsLanguageSelect.value = currentLocale;
    syncCustomSelect("settings-language-select");
    if (settingsSftpLocalDir) {
      settingsSftpLocalDir.value = localStorage.getItem(SETTINGS_KEY_SFTP_LOCAL_DIR) || "";
      fillSftpLocalDirDefaultIfEmpty().catch(() => {});
    }
    if (settingsTerminalTheme) {
      settingsTerminalTheme.value = getTerminalThemeName();
      syncCustomSelect("settings-terminal-theme");
    }
    if (settingsTerminalFontFamily) {
      populateTerminalFontFamilyOptionsAsync().catch((e) => {
        console.warn("populateTerminalFontFamilyOptionsAsync failed", e);
      });
    }
    if (settingsTerminalFontSize) settingsTerminalFontSize.value = String(getTerminalFontSize());
    if (settingsTerminalLineHeight) settingsTerminalLineHeight.value = String(getTerminalLineHeight());
    populateLocalShellSelect();
    updateLocalShellCurrentHint();
    if (settingsTerminalCwd) settingsTerminalCwd.value = getLocalCwd();
    if (settingsTerminalAttentionFlash) {
      settingsTerminalAttentionFlash.checked = isTerminalAttentionFlashEnabled();
    }
    renderTerminalSelectionMenuOrderSettings();
    syncTerminalFontPreview();
    syncTerminalThemeCardsActive();
  } else if (showingPortForward) {
    loadPortForwardPage().catch((e) => {
      console.warn("loadPortForwardPage failed", e);
    });
  }
}

function summarizeForwardSpec(spec) {
  const kind = spec?.kind || spec?.type;
  const bindAddr = spec?.bindAddr ?? spec?.bind_addr ?? "127.0.0.1";
  const bindPort = spec?.bindPort ?? spec?.bind_port ?? "";
  if (kind === "dynamic") return `D ${bindAddr}:${bindPort}`;
  const targetHost = spec?.targetHost ?? spec?.target_host ?? "";
  const targetPort = spec?.targetPort ?? spec?.target_port ?? "";
  if (kind === "remote") return `R ${bindAddr}:${bindPort} -> ${targetHost}:${targetPort}`;
  return `L ${bindAddr}:${bindPort} -> ${targetHost}:${targetPort}`;
}

function friendlyForwardTitle(spec) {
  const kind = spec?.kind || spec?.type;
  const bindAddr = spec?.bindAddr ?? spec?.bind_addr ?? "127.0.0.1";
  const bindPort = spec?.bindPort ?? spec?.bind_port ?? "";
  if (kind === "dynamic") return t("port_forward.title.dynamic", { bindAddr, bindPort });
  const targetHost = spec?.targetHost ?? spec?.target_host ?? "";
  const targetPort = spec?.targetPort ?? spec?.target_port ?? "";
  if (kind === "remote") return t("port_forward.title.remote", { bindPort, targetHost, targetPort });
  return t("port_forward.title.local", { bindPort, targetHost, targetPort });
}

function friendlyForwardDetail(spec) {
  const kind = spec?.kind || spec?.type;
  const bindAddr = spec?.bindAddr ?? spec?.bind_addr ?? "127.0.0.1";
  const bindPort = spec?.bindPort ?? spec?.bind_port ?? "";
  if (kind === "dynamic") return t("port_forward.detail.dynamic", { bindAddr, bindPort });
  const targetHost = spec?.targetHost ?? spec?.target_host ?? "";
  const targetPort = spec?.targetPort ?? spec?.target_port ?? "";
  if (kind === "remote") return t("port_forward.detail.remote", { bindAddr, bindPort, targetHost, targetPort });
  return t("port_forward.detail.local", { bindAddr, bindPort, targetHost, targetPort });
}

let portForwardEditorHostId = null;
let portForwardEditorForwards = [];
let portForwardEditorMode = "edit";
let portForwardEditorIndex = null;
let portForwardRowsCache = [];

async function loadPortForwardPage() {
  if (!portForwardList || !portForwardEmpty) return;
  try {
    await invoke("migrate_port_forward_rules");
  } catch (e) {
    console.warn("migrate_port_forward_rules failed", e);
  }
  portForwardRowsCache = await invoke("list_port_forward_status");
  renderPortForwardRows();
}

function portForwardSearchText(row) {
  return [
    row.hostName,
    friendlyForwardTitle(row.forward),
    friendlyForwardDetail(row.forward),
    summarizeForwardSpec(row.forward),
  ].join(" ").toLowerCase();
}

function portForwardMatchesSearch(row, query) {
  const text = portForwardSearchText(row);
  if (/^\d+$/.test(query)) {
    return text.includes(query);
  }
  return text.includes(query) || fuzzyMatchSelectOption(text, query);
}

function renderPortForwardRows() {
  if (!portForwardList || !portForwardEmpty) return;
  portForwardList.innerHTML = "";
  const query = (portForwardSearch?.value || "").trim().toLowerCase();
  const rows = query
    ? portForwardRowsCache.filter((row) => portForwardMatchesSearch(row, query))
    : portForwardRowsCache;
  portForwardEmpty.hidden = rows.length > 0;
  if (!rows.length) {
    const strong = portForwardEmpty.querySelector("strong");
    const desc = portForwardEmpty.querySelector("p");
    if (strong) strong.textContent = query ? t("port_forward.empty.search_title") : t("port_forward.empty.title");
    if (desc) desc.textContent = query ? t("port_forward.empty.search_desc") : t("port_forward.empty.desc");
  }

  for (const row of rows) {
    const reconnecting = row.active?.state === "reconnecting";
    const card = document.createElement("article");
    card.className =
      "port-forward-card" + (row.active ? (reconnecting ? " reconnecting" : " active") : "");

    const head = document.createElement("div");
    head.className = "port-forward-card-head";
    const title = document.createElement("div");
    title.innerHTML = `<strong></strong><span></span>`;
    title.querySelector("strong").textContent = friendlyForwardTitle(row.forward);
    const statusKey = row.active
      ? reconnecting
        ? "port_forward.status.reconnecting"
        : "port_forward.status.running"
      : "port_forward.status.stopped";
    title.querySelector("span").textContent = `${row.hostName} · ${t(statusKey)}`;

    const action = document.createElement("button");
    action.type = "button";
    action.className = `port-forward-icon-action ${row.active ? "is-stop" : "is-start"}`;
    action.title = row.active ? t("port_forward.action.stop") : t("port_forward.action.start");
    action.setAttribute("aria-label", action.title);
    action.innerHTML = row.active
      ? svgIcon('<rect x="6" y="6" width="12" height="12" rx="2"></rect>')
      : svgIcon('<path d="M8 5v14l11-7z"></path>');
    action.addEventListener("click", async () => {
      action.disabled = true;
      action.title = row.active ? t("port_forward.action.stopping") : t("port_forward.action.starting");
      action.setAttribute("aria-label", action.title);
      try {
        if (row.active) {
          await invoke("stop_port_forward", { id: row.active.id });
        } else {
          await invoke("start_port_forward", { ruleId: row.id });
        }
        await loadPortForwardPage();
      } catch (e) {
        action.disabled = false;
        action.title = row.active ? t("port_forward.action.stop") : t("port_forward.action.start");
        action.setAttribute("aria-label", action.title);
        alert(String(e));
      }
    });
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "port-forward-icon-action";
    edit.title = t("port_forward.action.edit");
    edit.setAttribute("aria-label", edit.title);
    edit.innerHTML = svgIcon('<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>');
    edit.addEventListener("click", () => openPortForwardEditor(row));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "port-forward-icon-action is-delete";
    remove.title = t("port_forward.action.delete");
    remove.setAttribute("aria-label", remove.title);
    remove.innerHTML = svgIcon('<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>');
    remove.addEventListener("click", async () => {
      const ok = await openConfirmDialog({
        title: t("port_forward.confirm.delete.title"),
        message: t("port_forward.confirm.delete"),
        okText: t("port_forward.action.delete"),
        cancelText: t("snippets.dialog.cancel"),
      });
      if (!ok) return;
      remove.disabled = true;
      try {
        if (row.active) await invoke("stop_port_forward", { id: row.active.id });
        await invoke("delete_port_forward_rule", { id: row.id });
        await loadPortForwardPage();
      } catch (e) {
        remove.disabled = false;
        alert(String(e));
      }
    });

    const actions = document.createElement("div");
    actions.className = "port-forward-card-actions";
    actions.append(edit, action, remove);
    head.append(title, actions);

    const list = document.createElement("div");
    list.className = "port-forward-specs";
    const specs = [friendlyForwardDetail(row.forward)];
    for (const spec of specs) {
      const item = document.createElement("code");
      item.textContent = spec;
      list.appendChild(item);
    }

    const raw = document.createElement("code");
    raw.className = "muted";
    raw.textContent = summarizeForwardSpec(row.forward);
    list.appendChild(raw);

    card.append(head, list);
    portForwardList.appendChild(card);
  }
}

function openPortForwardEditor(row) {
  if (!portForwardEditor) return;
  portForwardEditorMode = "edit";
  portForwardEditorHostId = row.hostId;
  portForwardEditorIndex = row.id;
  portForwardEditorForwards = [forwardFromIO(row.forward)];
  if (portForwardEditorTitle) portForwardEditorTitle.textContent = t("port_forward.editor.title.edit", { hostName: row.hostName });
  if (portForwardEditorHostWrap) portForwardEditorHostWrap.hidden = true;
  if (portForwardEditorAdd) portForwardEditorAdd.hidden = true;
  if (portForwardEditorError) {
    portForwardEditorError.hidden = true;
    portForwardEditorError.textContent = "";
  }
  syncPortForwardEditorFormFromState();
  if (portForwardEditorOverlay) portForwardEditorOverlay.hidden = false;
}

async function openPortForwardCreateEditor() {
  if (!portForwardEditor || !portForwardEditorHost) return;
  await refreshHostsCacheFromVault({ silent: true });
  portForwardEditorMode = "create";
  portForwardEditorIndex = null;
  portForwardEditorHostId = "";
  portForwardEditorForwards = [{
    kind: "local",
    enabled: true,
    bindAddr: "127.0.0.1",
    bindPort: "",
    targetHost: "localhost",
    targetPort: "",
  }];
  portForwardEditorHost.innerHTML = "";
  for (const host of hostsCache) {
    const opt = document.createElement("option");
    opt.value = host.id;
    opt.textContent = `${host.name} (${host.user}@${host.host}:${host.port})`;
    portForwardEditorHost.appendChild(opt);
  }
  portForwardEditorHostId = portForwardEditorHost.value || "";
  syncCustomSelect("port-forward-editor-host");
  if (portForwardEditorTitle) portForwardEditorTitle.textContent = t("port_forward.editor.title.create");
  if (portForwardEditorHostWrap) portForwardEditorHostWrap.hidden = false;
  if (portForwardEditorAdd) portForwardEditorAdd.hidden = true;
  if (portForwardEditorError) {
    portForwardEditorError.hidden = true;
    portForwardEditorError.textContent = "";
  }
  syncPortForwardEditorFormFromState();
  if (portForwardEditorOverlay) portForwardEditorOverlay.hidden = false;
}

function closePortForwardEditor() {
  if (portForwardEditorOverlay) portForwardEditorOverlay.hidden = true;
  if (portForwardEditorAdd) portForwardEditorAdd.hidden = false;
  portForwardEditorHostId = null;
  portForwardEditorForwards = [];
  portForwardEditorMode = "edit";
  portForwardEditorIndex = null;
}

function showPortForwardEditorError(message) {
  if (!portForwardEditorError) return;
  portForwardEditorError.textContent = message;
  portForwardEditorError.hidden = false;
}

function syncPortForwardEditorKind() {
  const isDynamic = portForwardEditorKind?.value === "dynamic";
  const isRemote = portForwardEditorKind?.value === "remote";
  portForwardEditorKindTabs?.querySelectorAll(".port-forward-kind-tab").forEach((tab) => {
    const active = tab.dataset.kind === portForwardEditorKind?.value;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (portForwardEditorTargetHostWrap) portForwardEditorTargetHostWrap.hidden = isDynamic;
  if (portForwardEditorTargetPortWrap) portForwardEditorTargetPortWrap.hidden = isDynamic;
  if (portForwardEditorArrow) portForwardEditorArrow.hidden = isDynamic;
  // Bind/target labels flip meaning between -L and -R (which machine listens vs
  // which side the target is reachable from), so name the machine explicitly.
  setText("port-forward-editor-bind-label", isRemote ? "port_forward.editor.bind_remote" : "port_forward.editor.bind_local");
  setText("port-forward-editor-bind-port-label", isRemote ? "port_forward.editor.bind_port_remote" : "port_forward.editor.bind_port_local");
  if (!isDynamic) {
    setText("port-forward-editor-target-host-label", isRemote ? "port_forward.editor.target_remote" : "port_forward.editor.target_local");
    setText("port-forward-editor-target-port-label", "port_forward.editor.target_port");
  }
  if (portForwardEditorHint) {
    portForwardEditorHint.textContent = isDynamic
      ? t("port_forward.editor.hint.dynamic")
      : isRemote
        ? t("port_forward.editor.hint.remote")
        : t("port_forward.editor.hint.local");
  }
}

function syncPortForwardEditorFormFromState() {
  const fwd = portForwardEditorForwards[0] || {
    kind: "local",
    enabled: true,
    bindAddr: "127.0.0.1",
    bindPort: "",
    targetHost: "localhost",
    targetPort: "",
  };
  if (portForwardEditorKind) {
    portForwardEditorKind.value = fwd.kind || "local";
  }
  if (portForwardEditorBind) portForwardEditorBind.value = fwd.bindAddr || "127.0.0.1";
  if (portForwardEditorBindPort) portForwardEditorBindPort.value = fwd.bindPort || "";
  if (portForwardEditorTargetHost) portForwardEditorTargetHost.value = fwd.targetHost || "localhost";
  if (portForwardEditorTargetPort) portForwardEditorTargetPort.value = fwd.targetPort || "";
  syncPortForwardEditorKind();
}

function readPortForwardEditorForm() {
  const kind = portForwardEditorKind?.value || "local";
  const fwd = {
    kind,
    enabled: true,
    bindAddr: portForwardEditorBind?.value || "127.0.0.1",
    bindPort: portForwardEditorBindPort?.value || "",
  };
  if (kind === "local" || kind === "remote") {
    fwd.targetHost = portForwardEditorTargetHost?.value || "localhost";
    fwd.targetPort = portForwardEditorTargetPort?.value || "";
  }
  return fwd;
}

async function savePortForwardEditor() {
  if (portForwardEditorMode === "create") {
    portForwardEditorHostId = portForwardEditorHost?.value || "";
    if (!portForwardEditorHostId) {
      showPortForwardEditorError(t("port_forward.editor.error.host_required"));
      return;
    }
  }
  if (!portForwardEditorHostId) return;
  if (portForwardEditorError) portForwardEditorError.hidden = true;

  const forwards = [];
  for (const [i, fwd] of [readPortForwardEditorForm()].entries()) {
    const bindPort = parseInt(fwd.bindPort, 10);
    if (!bindPort || bindPort < 1 || bindPort > 65535) {
      showPortForwardEditorError(t("host_editor.error.forward_bind_port", { index: i + 1 }));
      return;
    }
    if (fwd.kind === "local" || fwd.kind === "remote") {
      if (!fwd.targetHost?.trim()) {
        showPortForwardEditorError(t("host_editor.error.forward_target_host", { index: i + 1 }));
        return;
      }
      const targetPort = parseInt(fwd.targetPort, 10);
      if (!targetPort || targetPort < 1 || targetPort > 65535) {
        showPortForwardEditorError(t("host_editor.error.forward_target_port", { index: i + 1 }));
        return;
      }
      forwards.push({
        kind: fwd.kind,
        enabled: fwd.enabled !== false,
        bind_addr: fwd.bindAddr || "127.0.0.1",
        bind_port: bindPort,
        target_host: fwd.targetHost.trim(),
        target_port: targetPort,
      });
    } else {
      forwards.push({
        kind: "dynamic",
        enabled: fwd.enabled !== false,
        bind_addr: fwd.bindAddr || "127.0.0.1",
        bind_port: bindPort,
      });
    }
  }

  portForwardEditorSave.disabled = true;
  try {
    const input = {
      hostId: portForwardEditorHostId,
      forward: forwards[0],
    };
    if (portForwardEditorMode === "edit" && portForwardEditorIndex) {
      await invoke("update_port_forward_rule", { id: portForwardEditorIndex, input });
    } else {
      await invoke("create_port_forward_rule", { input });
    }
    closePortForwardEditor();
    await loadPortForwardPage();
    await refreshHostsCacheFromVault({ silent: true });
  } catch (e) {
    showPortForwardEditorError(String(e));
  } finally {
    portForwardEditorSave.disabled = false;
  }
}

function setSettingsSection(section) {
  settingsSection = section === "terminal"
    ? "terminal"
    : section === "ai"
      ? "ai"
      : section === "sync"
        ? "sync"
        : section === "data"
          ? "data"
        : section === "about"
          ? "about"
          : "general";
  settingsNavGeneral?.classList.toggle("active", settingsSection === "general");
  settingsNavTerminal?.classList.toggle("active", settingsSection === "terminal");
  settingsNavAi?.classList.toggle("active", settingsSection === "ai");
  settingsNavSync?.classList.toggle("active", settingsSection === "sync");
  settingsNavData?.classList.toggle("active", settingsSection === "data");
  settingsNavAbout?.classList.toggle("active", settingsSection === "about");
  if (settingsGeneralPanel) settingsGeneralPanel.hidden = settingsSection !== "general";
  if (settingsTerminalPanel) settingsTerminalPanel.hidden = settingsSection !== "terminal";
  if (settingsAiPanel) settingsAiPanel.hidden = settingsSection !== "ai";
  if (settingsSyncPanel) settingsSyncPanel.hidden = settingsSection !== "sync";
  settingsPageBody?.classList.toggle("settings-sync-scrollbar", settingsSection === "sync");
  if (settingsDataPanel) settingsDataPanel.hidden = settingsSection !== "data";
  if (settingsAboutPanel) settingsAboutPanel.hidden = settingsSection !== "about";
  if (settingsSection === "ai") {
    loadAiConfig()
      .then(() => maybeAutoRefreshAiModels().catch(() => {}))
      .catch(() => {});
  }
  if (settingsGeneralTitle) {
    settingsGeneralTitle.textContent = settingsSection === "terminal"
        ? t("settings.terminal.title")
        : settingsSection === "ai"
        ? t("settings.ai.title")
        : settingsSection === "sync"
          ? t("settings.nav.sync")
          : settingsSection === "data"
            ? t("settings.nav.data")
          : settingsSection === "about"
            ? t("settings.nav.about")
        : t("settings.general.title");
  }
  if (settingsGeneralDesc) {
    settingsGeneralDesc.textContent = settingsSection === "terminal"
        ? t("settings.terminal.desc")
        : settingsSection === "ai"
        ? t("settings.ai.desc")
        : settingsSection === "sync"
          ? t("settings.sync.desc")
          : settingsSection === "data"
            ? t("settings.data.desc")
          : settingsSection === "about"
            ? ""
        : t("settings.general.desc");
  }
  if (settingsSection === "sync") {
    loadSyncProfiles().catch((e) => {
      if (settingsSyncStatus) settingsSyncStatus.textContent = userFriendlySyncError(e);
    });
  } else if (settingsSection === "about") {
    loadAppVersion().then((v) => {
      if (settingsAboutVersionValue) settingsAboutVersionValue.textContent = v;
    });
    refreshUpdateStatus().catch(() => {});
  } else if (settingsSection === "data") {
    if (settingsDataStatus) settingsDataStatus.textContent = "";
  } else {
    setSettingsGeneralSubtab(settingsGeneralSubtab);
  }
}

async function loadSyncProfiles() {
  syncProfiles = await invoke("list_sync_profiles");
  const activeProfileId = localStorage.getItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE) || "";
  if (syncProfiles.length > 0) {
    const pick = activeProfileId && syncProfiles.some((p) => p.id === activeProfileId)
      ? activeProfileId
      : syncEditingId && syncProfiles.some((p) => p.id === syncEditingId)
        ? syncEditingId
        : syncProfiles[0].id;
    syncSingleProfileId = pick;
    localStorage.setItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE, pick);
    applySyncProfileToForm(syncProfiles.find((p) => p.id === pick) || null);
  } else {
    syncSingleProfileId = null;
    localStorage.removeItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE);
    applySyncProfileToForm(null);
  }
  if (settingsSyncStatus) {
    settingsSyncStatus.textContent = syncProfiles.length > 0
      ? t("settings.sync.status.loaded", { count: syncProfiles.length })
      : t("settings.sync.status.none");
  }
  await refreshSyncStatusLine();
  await refreshSyncDevices();
  await refreshSyncConflicts();
  await refreshSyncRepoStats();
  await refreshRememberPassphraseFlag();
}

async function refreshRememberPassphraseFlag() {
  if (!settingsSyncRememberPassphrase) return;
  const id = activeSyncProfileId();
  if (!id) {
    settingsSyncRememberPassphrase.checked = false;
    return;
  }
  try {
    settingsSyncRememberPassphrase.checked = await invoke("sync_has_remembered_passphrase", {
      profileId: id,
    });
  } catch {
    settingsSyncRememberPassphrase.checked = false;
  }
}

function syncFormToInput() {
  const backend = String(settingsSyncBackend?.value || "local_folder");
  return {
    name: "ZeroTerm Sync",
    backend,
    root:
      backend === "local_folder"
        ? String(settingsSyncRoot?.value || "").trim() || null
        : null,
    hostRef:
      backend === "sftp"
        ? String(settingsSyncHostRef?.value || "").trim() || null
        : null,
    remoteDir:
      backend === "sftp"
        ? String(settingsSyncRemoteDir?.value || "").trim() || null
        : null,
    url:
      backend === "webdav"
        ? String(settingsSyncWebDavUrl?.value || "").trim() || null
        : null,
    rootPath:
      backend === "webdav"
        ? String(settingsSyncWebDavRoot?.value || "").trim() || null
        : null,
    username:
      backend === "webdav"
        ? String(settingsSyncWebDavUser?.value || "").trim() || null
        : null,
    // Password is sent only when the user typed one; empty string =
    // leave keychain entry intact. backend uses this convention to
    // distinguish "no change" from "clear".
    password:
      backend === "webdav"
        ? String(settingsSyncWebDavPw?.value || "") || null
        : null,
    region:
      backend === "s3"
        ? String(settingsSyncS3Region?.value || "").trim() || null
        : null,
    bucket:
      backend === "s3"
        ? String(settingsSyncS3Bucket?.value || "").trim() || null
        : null,
    prefix:
      backend === "s3"
        ? String(settingsSyncS3Prefix?.value || "").trim() || null
        : null,
    endpoint:
      backend === "s3"
        ? String(settingsSyncS3Endpoint?.value || "").trim() || null
        : null,
    forcePathStyle:
      backend === "s3" ? Boolean(settingsSyncS3PathStyle?.checked) : null,
    accessKeyId:
      backend === "s3"
        ? String(settingsSyncS3Ak?.value || "").trim() || null
        : null,
    secretAccessKey:
      backend === "s3"
        ? String(settingsSyncS3Sk?.value || "") || null
        : null,
    sessionToken:
      backend === "s3"
        ? String(settingsSyncS3Token?.value || "") || null
        : null,
  };
}

function collectSyncClientState() {
  // Repo-based sync (M3+) doesn't piggy-back client UI state through the
  // sync layer — host groups and host→group membership now ride along in
  // the vault via the `host_group` kind and `Host.group_id`. The only
  // group-related state still client-local is expand/collapse, which is
  // intentionally per-device.
  return null;
}

async function ensureSyncProfileReadyForActions() {
  const input = syncFormToInput();
  if (input.backend === "local_folder" && !input.root) {
    throw new Error(t("settings.sync.error.root_required"));
  }
  if (input.backend === "sftp") {
    if (!input.hostRef) throw new Error(t("settings.sync.error.host_required"));
    if (!input.remoteDir) throw new Error(t("settings.sync.error.remote_dir_required"));
  }
  if (input.backend === "webdav") {
    if (!input.url) throw new Error(t("settings.sync.error.webdav_url_required"));
    if (!input.username) throw new Error(t("settings.sync.error.webdav_user_required"));
  }
  if (input.backend === "s3") {
    if (!input.region) throw new Error(t("settings.sync.error.s3_region_required"));
    if (!input.bucket) throw new Error(t("settings.sync.error.s3_bucket_required"));
    if (!input.accessKeyId) throw new Error(t("settings.sync.error.s3_ak_required"));
  }
  const existingId = syncSingleProfileId || syncEditingId || localStorage.getItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE);
  if (existingId) {
    await invoke("update_sync_profile", { id: existingId, input });
    syncSingleProfileId = existingId;
    syncEditingId = existingId;
    localStorage.setItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE, existingId);
    return existingId;
  }
  const id = await invoke("save_sync_profile", { input });
  syncSingleProfileId = id;
  syncEditingId = id;
  localStorage.setItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE, id);
  return id;
}

function applyClientSettingsFromState(_state) {
  // Repo-based sync no longer carries client settings inside the sync
  // payload — settings sync needs its own record kind (future milestone).
}

function applySyncProfileToForm(p) {
  if (!p) {
    syncEditingId = null;
    if (settingsSyncRoot) settingsSyncRoot.value = "";
    if (settingsSyncHostRef) settingsSyncHostRef.value = "";
    if (settingsSyncRemoteDir) settingsSyncRemoteDir.value = "";
    if (settingsSyncWebDavUrl) settingsSyncWebDavUrl.value = "";
    if (settingsSyncWebDavRoot) settingsSyncWebDavRoot.value = "";
    if (settingsSyncWebDavUser) settingsSyncWebDavUser.value = "";
    if (settingsSyncWebDavPw) settingsSyncWebDavPw.value = "";
    if (settingsSyncS3Region) settingsSyncS3Region.value = "";
    if (settingsSyncS3Bucket) settingsSyncS3Bucket.value = "";
    if (settingsSyncS3Prefix) settingsSyncS3Prefix.value = "";
    if (settingsSyncS3Endpoint) settingsSyncS3Endpoint.value = "";
    if (settingsSyncS3PathStyle) settingsSyncS3PathStyle.checked = false;
    if (settingsSyncS3Ak) settingsSyncS3Ak.value = "";
    if (settingsSyncS3Sk) settingsSyncS3Sk.value = "";
    if (settingsSyncS3Token) settingsSyncS3Token.value = "";
    if (settingsSyncEncPassword) settingsSyncEncPassword.value = "";
    if (settingsSyncRememberPassphrase) settingsSyncRememberPassphrase.checked = false;
    syncFormToggleBackendFields(settingsSyncBackend?.value || "local_folder");
    return;
  }
  syncEditingId = p.id;
  const backend = p.backend || "local_folder";
  if (settingsSyncBackend) {
    settingsSyncBackend.value = backend;
    syncCustomSelect("settings-sync-backend");
  }
  if (settingsSyncRoot) settingsSyncRoot.value = p.root || "";
  if (settingsSyncHostRef) {
    refreshSftpHostOptions(p.hostRef || "");
  }
  if (settingsSyncRemoteDir) settingsSyncRemoteDir.value = p.remoteDir || "";
  if (settingsSyncWebDavUrl) settingsSyncWebDavUrl.value = p.url || "";
  if (settingsSyncWebDavRoot) settingsSyncWebDavRoot.value = p.rootPath || "";
  if (settingsSyncWebDavUser) settingsSyncWebDavUser.value = p.username || "";
  // Backend passwords / secrets live in the OS keychain — never echo
  // them back. Empty input on save = "leave keychain intact".
  if (settingsSyncWebDavPw) settingsSyncWebDavPw.value = "";
  if (settingsSyncS3Region) settingsSyncS3Region.value = p.region || "";
  if (settingsSyncS3Bucket) settingsSyncS3Bucket.value = p.bucket || "";
  if (settingsSyncS3Prefix) settingsSyncS3Prefix.value = p.prefix || "";
  if (settingsSyncS3Endpoint) settingsSyncS3Endpoint.value = p.endpoint || "";
  if (settingsSyncS3PathStyle) settingsSyncS3PathStyle.checked = !!p.forcePathStyle;
  if (settingsSyncS3Ak) settingsSyncS3Ak.value = p.accessKeyId || "";
  if (settingsSyncS3Sk) settingsSyncS3Sk.value = "";
  if (settingsSyncS3Token) settingsSyncS3Token.value = "";
  syncFormToggleBackendFields(backend);
  // Passphrase is per-session, never echoed back from disk — leave empty
  // so the user is prompted on Create/Join.
}

function syncFormToggleBackendFields(backend) {
  const isLocal = backend === "local_folder";
  const isSftp = backend === "sftp";
  const isWebDav = backend === "webdav";
  const isS3 = backend === "s3";
  if (settingsSyncRootField) settingsSyncRootField.hidden = !isLocal;
  if (settingsSyncHostRefField) settingsSyncHostRefField.hidden = !isSftp;
  if (settingsSyncRemoteDirField) settingsSyncRemoteDirField.hidden = !isSftp;
  if (settingsSyncWebDavUrlField) settingsSyncWebDavUrlField.hidden = !isWebDav;
  if (settingsSyncWebDavRootField) settingsSyncWebDavRootField.hidden = !isWebDav;
  if (settingsSyncWebDavUserField) settingsSyncWebDavUserField.hidden = !isWebDav;
  if (settingsSyncWebDavPwField) settingsSyncWebDavPwField.hidden = !isWebDav;
  if (settingsSyncS3RegionField) settingsSyncS3RegionField.hidden = !isS3;
  if (settingsSyncS3BucketField) settingsSyncS3BucketField.hidden = !isS3;
  if (settingsSyncS3PrefixField) settingsSyncS3PrefixField.hidden = !isS3;
  if (settingsSyncS3EndpointField) settingsSyncS3EndpointField.hidden = !isS3;
  if (settingsSyncS3PathStyleField) settingsSyncS3PathStyleField.hidden = !isS3;
  if (settingsSyncS3AkField) settingsSyncS3AkField.hidden = !isS3;
  if (settingsSyncS3SkField) settingsSyncS3SkField.hidden = !isS3;
  if (settingsSyncS3TokenField) settingsSyncS3TokenField.hidden = !isS3;
  if (settingsSyncTip) settingsSyncTip.hidden = !isLocal;
}

function refreshSftpHostOptions(selectedId) {
  if (!settingsSyncHostRef) return;
  const hosts = hostsCache || [];
  settingsSyncHostRef.innerHTML = "";
  if (hosts.length === 0) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = t("settings.sync.sftp.no_hosts");
    settingsSyncHostRef.appendChild(placeholder);
    return;
  }
  for (const h of hosts) {
    const opt = document.createElement("option");
    opt.value = h.id;
    opt.textContent = `${h.name} (${h.user}@${h.host}:${h.port})`;
    settingsSyncHostRef.appendChild(opt);
  }
  if (selectedId && hosts.some((h) => h.id === selectedId)) {
    settingsSyncHostRef.value = selectedId;
  }
}

async function refreshSyncStatusLine() {
  const target = settingsSyncStatusLine;
  if (!target) return;
  const id = syncSingleProfileId || localStorage.getItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE);
  if (!id) {
    target.textContent = t("settings.sync.status.no_profile");
    return;
  }
  try {
    const status = await invoke("sync_status", { profileId: id });
    if (status.profileValid === false) {
      const reason = status.profileIssue || "invalid";
      const key = `settings.sync.status.invalid.${reason}`;
      const msg = t(key);
      target.textContent = msg === key
        ? t("settings.sync.status.invalid.generic", { reason })
        : msg;
      target.classList.add("sync-status-invalid");
    } else {
      target.classList.remove("sync-status-invalid");
      if (status.bootstrapped) {
        target.textContent = t("settings.sync.status.bootstrapped", {
          clock: status.headClock || 0,
        });
      } else {
        target.textContent = t("settings.sync.status.not_bootstrapped");
      }
    }
  } catch (e) {
    target.textContent = String(e);
  }
}

function activeSyncProfileId() {
  return syncSingleProfileId || localStorage.getItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE) || null;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function syncStat(stats, camel, snake, fallback = 0) {
  const v = stats?.[camel];
  if (v !== undefined && v !== null) return v;
  const s = stats?.[snake];
  if (s !== undefined && s !== null) return s;
  return fallback;
}

async function refreshSyncDevices() {
  if (!settingsSyncDevicesList) return;
  const id = activeSyncProfileId();
  settingsSyncDevicesList.innerHTML = "";
  if (!id) {
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = t("settings.sync.devices.no_profile");
    settingsSyncDevicesList.appendChild(li);
    return;
  }
  try {
    const devices = await invoke("sync_list_devices", { profileId: id });
    const visibleDevices = Array.isArray(devices)
      ? devices.filter((device) => (device.deviceId || device.device_id) !== "device-unknown")
      : [];
    if (visibleDevices.length === 0) {
      const li = document.createElement("li");
      li.className = "muted tiny";
      li.textContent = t("settings.sync.devices.empty");
      settingsSyncDevicesList.appendChild(li);
      return;
    }
    for (const device of visibleDevices) {
      const deviceId = device.deviceId || device.device_id || "";
      const deviceName = device.name || deviceId || t("settings.sync.devices.this_device");
      const isCurrent = Boolean(device.isCurrent || device.is_current);
      const li = document.createElement("li");
      li.className = "settings-sync-device-row";
      const main = document.createElement("div");
      main.className = "settings-sync-device-main";
      const name = document.createElement("strong");
      name.textContent = deviceName;
      if (isCurrent) {
        const badge = document.createElement("em");
        badge.className = "settings-sync-device-current";
        badge.textContent = t("settings.sync.devices.current_badge");
        name.appendChild(document.createTextNode(" "));
        name.appendChild(badge);
      }
      const idText = document.createElement("span");
      idText.textContent = deviceId;
      main.append(name, idText);
      const side = document.createElement("div");
      side.className = "settings-sync-device-side";
      const lastSeen = document.createElement("span");
      lastSeen.className = "settings-sync-device-seen";
      const at = Number(device.lastSeenAt ?? device.last_seen_at ?? 0);
      lastSeen.textContent = at > 0
        ? t("settings.sync.devices.last_seen", { when: formatRelativeTime(at) })
        : "";
      side.appendChild(lastSeen);
      if (!isCurrent && deviceId) {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "settings-sync-device-revoke";
        revoke.textContent = t("settings.sync.devices.revoke");
        revoke.addEventListener("click", async () => {
          const newPassphrase = settingsSyncEncPassword?.value || "";
          if (!newPassphrase) {
            if (settingsSyncStatus) {
              settingsSyncStatus.textContent = t("settings.sync.devices.new_passphrase_required");
            }
            settingsSyncEncPassword?.focus();
            return;
          }
          const confirmed = await openConfirmDialog({
            title: t("settings.sync.devices.revoke_title"),
            message: t("settings.sync.devices.revoke_confirm", { device: deviceName }),
            okText: t("settings.sync.devices.revoke"),
            cancelText: t("input.button.cancel"),
            danger: true,
          });
          if (!confirmed) return;
          revoke.disabled = true;
          if (settingsSyncStatus) {
            settingsSyncStatus.textContent = t("settings.sync.devices.revoke_progress");
          }
          try {
            const report = await invoke("sync_revoke_device", {
              profileId: id,
              deviceId,
              newPassphrase,
              rememberPassphrase: Boolean(settingsSyncRememberPassphrase?.checked),
            });
            if (settingsSyncEncPassword) settingsSyncEncPassword.value = "";
            if (settingsSyncStatus) {
              settingsSyncStatus.textContent = t("settings.sync.devices.revoke_done", {
                epoch: report.rootEpoch ?? report.root_epoch ?? "?",
              });
            }
            await Promise.all([
              refreshSyncDevices(),
              refreshSyncRepoStats(),
              refreshSyncStatusLine(),
            ]);
          } catch (error) {
            revoke.disabled = false;
            if (settingsSyncStatus) {
              settingsSyncStatus.textContent = t("settings.sync.devices.revoke_failed", {
                error: userFriendlySyncError(error),
              });
            }
          }
        });
        side.appendChild(revoke);
      }
      li.append(main, side);
      settingsSyncDevicesList.appendChild(li);
    }
  } catch (e) {
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = userFriendlySyncError(e);
    settingsSyncDevicesList.appendChild(li);
  }
}

async function refreshSyncRepoStats() {
  if (!settingsSyncRepoStatsList) return;
  const id = activeSyncProfileId();
  if (!id) {
    settingsSyncRepoStatsList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = t("settings.sync.stats.no_profile");
    settingsSyncRepoStatsList.appendChild(li);
    return;
  }
  try {
    const stats = await invoke("sync_repo_stats", { profileId: id });
    const totalBytes = syncStat(stats, "totalBytes", "total_bytes");
    const manifestBytes = syncStat(stats, "manifestBytes", "manifest_bytes");
    const keyringBytes = syncStat(stats, "keyringBytes", "keyring_bytes");
    const snapshotsBytes = syncStat(stats, "snapshotsBytes", "snapshots_bytes");
    const snapshotCount = syncStat(stats, "snapshotCount", "snapshot_count");
    const eventsBytes = syncStat(stats, "eventsBytes", "events_bytes");
    const eventCount = syncStat(stats, "eventCount", "event_count");
    const trashBytes = syncStat(stats, "trashBytes", "trash_bytes");
    const rows = [
      [t("settings.sync.stats.total"), formatBytes(totalBytes)],
      [t("settings.sync.stats.manifest"), formatBytes(manifestBytes)],
      [t("settings.sync.stats.keyring"), formatBytes(keyringBytes)],
      [
        t("settings.sync.stats.snapshots"),
        `${formatBytes(snapshotsBytes)} (${snapshotCount})`,
      ],
      [
        t("settings.sync.stats.events"),
        `${formatBytes(eventsBytes)} (${eventCount})`,
      ],
      [t("settings.sync.stats.trash"), formatBytes(trashBytes)],
    ];
    settingsSyncRepoStatsList.innerHTML = "";
    rows.forEach(([label, value], idx) => {
      const li = document.createElement("li");
      li.className = "settings-sync-stat-row";
      if (idx === 0) li.classList.add("is-total");
      const k = document.createElement("span");
      k.className = "settings-sync-stat-key";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "settings-sync-stat-value";
      v.textContent = value;
      li.appendChild(k);
      li.appendChild(v);
      settingsSyncRepoStatsList.appendChild(li);
    });
  } catch (e) {
    settingsSyncRepoStatsList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = userFriendlySyncError(e);
    settingsSyncRepoStatsList.appendChild(li);
  }
}

async function refreshSyncConflicts() {
  if (!settingsSyncConflictsList) return;
  const id = activeSyncProfileId();
  if (!id) {
    settingsSyncConflictsList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = t("settings.sync.conflicts.no_profile");
    settingsSyncConflictsList.appendChild(li);
    return;
  }
  try {
    const conflicts = await invoke("sync_list_conflicts", { profileId: id });
    settingsSyncConflictsList.innerHTML = "";
    if (!conflicts.length) {
      const li = document.createElement("li");
      li.className = "muted tiny";
      li.textContent = t("settings.sync.conflicts.empty");
      settingsSyncConflictsList.appendChild(li);
      return;
    }
    for (const c of conflicts) {
      settingsSyncConflictsList.appendChild(renderConflictItem(id, c));
    }
  } catch (e) {
    settingsSyncConflictsList.innerHTML = "";
    const li = document.createElement("li");
    li.className = "muted tiny";
    li.textContent = userFriendlySyncError(e);
    settingsSyncConflictsList.appendChild(li);
  }
}

function renderConflictItem(profileId, conflict) {
  const li = document.createElement("li");
  li.className = "settings-sync-conflict";
  li.dataset.id = conflict.id;

  const header = document.createElement("div");
  header.className = "settings-sync-conflict-header";
  const title = document.createElement("strong");
  title.textContent = conflictTitle(conflict);
  header.appendChild(title);

  const when = document.createElement("span");
  when.className = "muted tiny";
  when.textContent = formatConflictDetectedAt(conflictValue(conflict, "detectedAt", "detected_at"));
  header.appendChild(when);
  li.appendChild(header);

  const summary = document.createElement("p");
  summary.className = "settings-sync-conflict-summary muted tiny";
  summary.textContent = t("settings.sync.conflicts.summary");
  li.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "settings-sync-conflict-grid";

  const localBox = document.createElement("div");
  localBox.className = "settings-sync-conflict-side";
  const localLabel = document.createElement("div");
  localLabel.className = "settings-sync-conflict-side-label";
  localLabel.textContent = t("settings.sync.conflicts.local");
  const localHint = document.createElement("span");
  localHint.className = "settings-sync-conflict-side-hint";
  localHint.textContent = t("settings.sync.conflicts.local_hint");
  const localPre = document.createElement("pre");
  localPre.className = "settings-sync-conflict-preview";
  localPre.textContent = previewToText(conflictValue(conflict, "localPreview", "local_preview"));
  localBox.appendChild(localLabel);
  localBox.appendChild(localHint);
  localBox.appendChild(localPre);
  grid.appendChild(localBox);

  const remoteBox = document.createElement("div");
  remoteBox.className = "settings-sync-conflict-side";
  const remoteLabel = document.createElement("div");
  remoteLabel.className = "settings-sync-conflict-side-label";
  remoteLabel.textContent = t("settings.sync.conflicts.remote");
  const remoteHint = document.createElement("span");
  remoteHint.className = "settings-sync-conflict-side-hint";
  remoteHint.textContent = t("settings.sync.conflicts.remote_hint");
  const remotePre = document.createElement("pre");
  remotePre.className = "settings-sync-conflict-preview";
  remotePre.textContent = previewToText(conflictValue(conflict, "remotePreview", "remote_preview"));
  remoteBox.appendChild(remoteLabel);
  remoteBox.appendChild(remoteHint);
  remoteBox.appendChild(remotePre);
  grid.appendChild(remoteBox);

  li.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "settings-sync-conflict-actions";
  const keepLocal = document.createElement("button");
  keepLocal.type = "button";
  keepLocal.textContent = t("settings.sync.conflicts.keep_local");
  keepLocal.addEventListener("click", () =>
    resolveConflict(profileId, conflict.id, "keep_local", keepLocal),
  );
  const keepRemote = document.createElement("button");
  keepRemote.type = "button";
  keepRemote.textContent = t("settings.sync.conflicts.keep_remote");
  keepRemote.addEventListener("click", () =>
    resolveConflict(profileId, conflict.id, "keep_remote", keepRemote),
  );
  actions.appendChild(keepLocal);
  actions.appendChild(keepRemote);
  li.appendChild(actions);

  return li;
}

function conflictTitle(conflict) {
  const kind = conflictValue(conflict, "kind", "kind") ? String(conflictValue(conflict, "kind", "kind")) : "record";
  const recordId = conflictValue(conflict, "recordId", "record_id");
  const id = recordId ? String(recordId) : t("settings.sync.conflicts.record_fallback");
  return `${kind} · ${id}`;
}

function conflictValue(conflict, camelKey, snakeKey) {
  if (!conflict || typeof conflict !== "object") return undefined;
  if (conflict[camelKey] !== undefined && conflict[camelKey] !== null) return conflict[camelKey];
  return conflict[snakeKey];
}

function formatConflictDetectedAt(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return t("settings.sync.conflicts.detected_unknown");
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return t("settings.sync.conflicts.detected_unknown");
  return date.toLocaleString();
}

function previewToText(preview) {
  if (preview && typeof preview === "object" && preview.tombstone) {
    return t("settings.sync.conflicts.tombstone");
  }
  if (preview && typeof preview === "object" && preview.redacted) {
    return t("settings.sync.conflicts.redacted", { bytes: preview.bytes ?? 0 });
  }
  const summary = conflictPreviewSummary(preview);
  if (summary) return summary;
  if (preview === undefined || preview === null || preview === "") {
    return t("settings.sync.conflicts.preview_empty");
  }
  try {
    return JSON.stringify(preview, null, 2);
  } catch {
    return String(preview);
  }
}

function conflictPreviewSummary(preview) {
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return "";
  const lines = [];
  const add = (label, value) => {
    if (value === undefined || value === null || value === "") return;
    lines.push(`${label}: ${String(value)}`);
  };

  const name = preview.name ?? preview.title;
  const host = preview.host ?? preview.hostname ?? preview.address;
  const hostId = preview.host_id ?? preview.hostId;
  const spec = preview.spec && typeof preview.spec === "object" ? preview.spec : null;
  const port = preview.port;
  const user = preview.user ?? preview.username;
  const group = preview.group_id ?? preview.groupId;
  const os = preview.os_type ?? preview.osType;
  const forwards = Array.isArray(preview.forwards) ? preview.forwards : [];

  add(t("settings.sync.conflicts.field_name"), name);
  add(t("settings.sync.conflicts.field_host_id"), hostId);
  add(t("settings.sync.conflicts.field_host"), host);
  add(t("settings.sync.conflicts.field_port"), port);
  add(t("settings.sync.conflicts.field_user"), user);
  if (preview.auth && typeof preview.auth === "object") {
    add(t("settings.sync.conflicts.field_auth"), preview.auth.type ?? preview.auth.kind);
  }
  add(t("settings.sync.conflicts.field_group"), group);
  add(t("settings.sync.conflicts.field_os"), os);
  if (forwards.length) {
    add(t("settings.sync.conflicts.field_forwards"), forwards.map(formatForwardPreview).join("; "));
  }
  if (spec) {
    add(t("settings.sync.conflicts.field_forwards"), formatForwardPreview(spec));
  }

  if (!lines.length) return "";
  return lines.join("\n");
}

function formatForwardPreview(forward) {
  if (!forward || typeof forward !== "object") return String(forward);
  const kind = forward.kind || "forward";
  const bind = [forward.bind_addr ?? forward.bindAddr, forward.bind_port ?? forward.bindPort].filter(Boolean).join(":");
  const target = [forward.target_host ?? forward.targetHost, forward.target_port ?? forward.targetPort].filter(Boolean).join(":");
  return target ? `${kind} ${bind} -> ${target}` : `${kind} ${bind}`;
}

async function resolveConflict(profileId, conflictId, resolution, button) {
  await runSyncButtonAction(button, t("settings.sync.button.busy.resolve_conflict"), async () => {
    try {
      await invoke("sync_resolve_conflict", {
        profileId,
        conflictId,
        resolution,
      });
      if (settingsSyncStatus) {
        settingsSyncStatus.textContent = t("settings.sync.conflicts.resolved");
      }
      await refreshSyncConflicts();
      await refreshHostsCacheFromVault({ silent: true });
      showToast(t("settings.sync.conflicts.resolved"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
}

// --- Auto-sync engine ------------------------------------------------------
//
// Heartbeat-based: on each tick we run `sync_now`, which is a pull+push
// round trip in the engine. Triggers:
//   - heartbeat (every N seconds while the vault is unlocked)
//   - on_unlock (immediately after the vault is unlocked)
//   - visibility (when the window goes from hidden to visible)
//   - manual (user-pressed "sync now")
//
// Single-flight: only one sync runs at a time. Backoff: consecutive
// failures stretch the next heartbeat (60→120→240→480→600s) until a
// success resets the counter. Manual sync resets backoff too.
//
// Hidden window: heartbeat stretches to 5 minutes to be considerate, and
// resumes the normal cadence on the next `visibilitychange` event.
//
// Conflicts that come back in the outcome bubble up as a modal because
// they need user action to resolve and shouldn't get lost in a toast.
const SETTINGS_KEY_SYNC_AUTO_ENABLED = "zeroterm.settings.sync.auto.enabled";
const SETTINGS_KEY_SYNC_AUTO_INTERVAL = "zeroterm.settings.sync.auto.interval";
const SETTINGS_KEY_SYNC_AUTO_ON_VISIBILITY = "zeroterm.settings.sync.auto.on_visibility";

const AUTO_SYNC_DEFAULT_INTERVAL_SEC = 30;
const AUTO_SYNC_MIN_INTERVAL_SEC = 30;
const AUTO_SYNC_MAX_INTERVAL_SEC = 600;
const AUTO_SYNC_HIDDEN_INTERVAL_SEC = 300;
// Failure backoff schedule; index = (consecutiveFailures - 1), clamped.
const AUTO_SYNC_BACKOFF_STEPS_SEC = [60, 120, 240, 480, 600];

const autoSync = {
  timer: null,
  inFlight: false,
  pendingReason: null,
  consecutiveFailures: 0,
  lastOutcome: null,
  running: false,
};

function autoSyncEnabled() {
  const v = localStorage.getItem(SETTINGS_KEY_SYNC_AUTO_ENABLED);
  return v === null ? true : v === "true";
}

function autoSyncInterval() {
  const raw = parseInt(localStorage.getItem(SETTINGS_KEY_SYNC_AUTO_INTERVAL) || "", 10);
  if (Number.isFinite(raw) && raw >= AUTO_SYNC_MIN_INTERVAL_SEC && raw <= AUTO_SYNC_MAX_INTERVAL_SEC) {
    return raw;
  }
  return AUTO_SYNC_DEFAULT_INTERVAL_SEC;
}

function autoSyncOnVisibility() {
  const v = localStorage.getItem(SETTINGS_KEY_SYNC_AUTO_ON_VISIBILITY);
  return v === null ? true : v === "true";
}

function computeNextSyncIntervalSec() {
  if (autoSync.consecutiveFailures > 0) {
    const idx = Math.min(autoSync.consecutiveFailures - 1, AUTO_SYNC_BACKOFF_STEPS_SEC.length - 1);
    return AUTO_SYNC_BACKOFF_STEPS_SEC[idx];
  }
  if (document.hidden) return AUTO_SYNC_HIDDEN_INTERVAL_SEC;
  return autoSyncInterval();
}

function isAutoSyncEnabled() {
  return autoSyncEnabled();
}

function autoSyncProfileId() {
  // Reuse the active-profile bookkeeping the manual sync button uses.
  // Falls back to localStorage when `activeSyncProfileId` isn't ready
  // yet (e.g. during the very first tick right after unlock).
  if (typeof activeSyncProfileId === "function") {
    const id = activeSyncProfileId();
    if (id) return id;
  }
  return localStorage.getItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE) || syncSingleProfileId || null;
}

function clearAutoSyncTimer() {
  if (autoSync.timer !== null) {
    clearTimeout(autoSync.timer);
    autoSync.timer = null;
  }
}

function scheduleAutoSync() {
  // Public hook used by mutation paths. The backend has its own 4s
  // debounce that pushes local changes shortly after a CRUD, so the
  // frontend doesn't need to layer a second debounce on top — we just
  // make sure the heartbeat is armed and let the backend handle the
  // immediate push.
  if (!autoSync.running) return;
  clearAutoSyncTimer();
  if (!autoSyncEnabled()) {
    updateSyncIndicator();
    return;
  }
  const sec = computeNextSyncIntervalSec();
  autoSync.timer = window.setTimeout(() => {
    autoSync.timer = null;
    runAutoSync("heartbeat").catch(() => {});
  }, sec * 1000);
  updateSyncIndicator();
}

function autoSyncAfterDataChange() {
  // Backend debounce (SyncManager) handles the actual push 4s after a
  // CRUD. Frontend just re-arms its heartbeat so the UI's "last synced"
  // indicator catches the new state quickly afterwards.
  scheduleAutoSync();
}

async function runAutoSync(reason) {
  if (!autoSync.running) return null;
  if (!autoSyncEnabled()) return null;
  if (autoSync.inFlight) {
    autoSync.pendingReason = reason;
    return null;
  }
  const profileId = autoSyncProfileId();
  if (!profileId) {
    autoSync.lastOutcome = { at: Date.now(), ok: true, action: reason, skipped: true };
    updateSyncIndicator();
    if (reason === "heartbeat") scheduleAutoSync();
    return null;
  }

  autoSync.inFlight = true;
  updateSyncIndicator();

  let outcome = null;
  let error = null;
  try {
    outcome = await invoke("sync_now", { profileId });
    autoSync.consecutiveFailures = 0;
  } catch (e) {
    error = e;
    autoSync.consecutiveFailures += 1;
  } finally {
    autoSync.inFlight = false;
  }

  if (outcome) {
    const pulled = outcome.eventsPulled ?? 0;
    const pushed = outcome.eventsPushed ?? 0;
    const conflicts = outcome.conflictsDetected ?? 0;
    autoSync.lastOutcome = {
      at: Date.now(),
      ok: true,
      action: reason,
      pulled,
      pushed,
      conflicts,
    };
    markSyncLast(reason, pushed, { pulled, ok: true, conflicts });
    if (pulled > 0) {
      await refreshAllSyncedViewsFromVault();
    }
    if (conflicts > 0) {
      openConflictModal(conflicts, profileId);
    }
  } else if (error) {
    const errorText = String(error);
    const syncStillBootstrapping = reason === "on_unlock" && errorText.includes("sync is not connected yet");
    autoSync.lastOutcome = {
      at: Date.now(),
      ok: syncStillBootstrapping,
      action: reason,
      skipped: syncStillBootstrapping,
      error: errorText,
    };
    if (syncStillBootstrapping) {
      autoSync.consecutiveFailures = 0;
    } else {
      markSyncLast(reason, 0, { ok: false, error: errorText });
    }
    if (reason !== "heartbeat" && !syncStillBootstrapping) {
      // Manual / on_unlock / visibility failures get a toast so the user
      // isn't left wondering. Heartbeat failures are silent — the
      // indicator carries the status.
      try {
        showToast(userFriendlySyncError(error), "error", 4200);
      } catch {}
    }
  }

  updateSyncIndicator();
  const pending = autoSync.pendingReason;
  autoSync.pendingReason = null;
  // Always re-arm the timer when running, regardless of pull/push direction.
  scheduleAutoSync();
  if (pending) {
    runAutoSync(pending).catch(() => {});
  }
  return outcome;
}

function startAutoSync() {
  if (autoSync.running) return;
  autoSync.running = true;
  autoSync.consecutiveFailures = 0;
  autoSync.lastOutcome = null;
  ensureSyncIndicator();
  ensureAutoSyncSettingsControls();
  // Give the backend's background sync bootstrap a moment to connect after
  // unlock, then catch up on anything that happened while locked / offline.
  window.setTimeout(() => {
    runAutoSync("on_unlock").catch(() => {});
  }, 3000);
}

function stopAutoSync() {
  autoSync.running = false;
  clearAutoSyncTimer();
  autoSync.inFlight = false;
  autoSync.pendingReason = null;
  autoSync.consecutiveFailures = 0;
  autoSync.lastOutcome = null;
  updateSyncIndicator();
}

document.addEventListener("visibilitychange", () => {
  if (!autoSync.running) return;
  if (!autoSyncEnabled()) {
    updateSyncIndicator();
    return;
  }
  if (!autoSyncOnVisibility()) {
    scheduleAutoSync();
    return;
  }
  if (!document.hidden) {
    // Window came back. Run immediately to catch up; this resets the
    // heartbeat to the visible-cadence afterwards.
    runAutoSync("visibility").catch(() => {});
  } else {
    // Going hidden — re-arm the timer with the stretched interval.
    scheduleAutoSync();
  }
});

// --- Sync status indicator -------------------------------------------------
//
// Small floating chip pinned to the top-right of the hosts view. Click
// to jump to the sync settings page. State machine driven entirely by
// `autoSync.lastOutcome` and `autoSync.inFlight`.
let syncIndicatorEl = null;
let syncIndicatorRefreshTimer = null;

function ensureSyncIndicator() {
  if (syncIndicatorEl) return syncIndicatorEl;
  const el = document.createElement("button");
  el.id = "sync-indicator";
  el.type = "button";
  el.className = "sync-indicator";
  el.setAttribute("aria-live", "polite");
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (typeof openSettingsSyncPanel === "function") {
      openSettingsSyncPanel();
    } else if (settingsButton) {
      settingsButton.click();
      // best-effort: switch to sync nav after settings opens
      setTimeout(() => settingsNavSync?.click(), 30);
    }
  });
  
  // Insert inside the vault-bottom-settings-row (sidebar settings footer)
  const settingsRow = document.getElementById("vault-bottom-settings-row");
  if (settingsRow) {
    settingsRow.appendChild(el);
  } else {
    document.body.appendChild(el);
  }
  
  syncIndicatorEl = el;
  // Refresh the "N minutes ago" label without re-syncing.
  if (syncIndicatorRefreshTimer === null) {
    syncIndicatorRefreshTimer = window.setInterval(updateSyncIndicator, 15_000);
  }
  return el;
}

function formatRelativeTime(ms) {
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.round(delta / 1000);
  if (sec < 10) return t("sync.indicator.just_now");
  if (sec < 60) return t("sync.indicator.seconds_ago", { n: sec });
  const min = Math.round(sec / 60);
  if (min < 60) return t("sync.indicator.minutes_ago", { n: min });
  const hr = Math.round(min / 60);
  return t("sync.indicator.hours_ago", { n: hr });
}

function updateSyncIndicator() {
  const el = syncIndicatorEl;
  if (!el) return;
  const hostsView = document.getElementById("view-hosts");
  // Only visible while inside an unlocked vault and sync is configured and enabled
  const isConfigured = autoSyncEnabled() && autoSyncProfileId();
  el.hidden = !(autoSync.running && hostsView && !hostsView.hidden && isConfigured);

  let state = "idle";
  let label = "";
  if (!autoSyncEnabled()) {
    state = "off";
    label = t("sync.indicator.auto_off");
  } else if (!autoSyncProfileId()) {
    state = "unconfigured";
    label = t("sync.indicator.no_profile");
  } else if (autoSync.inFlight) {
    state = "syncing";
    label = t("sync.indicator.syncing");
  } else if (autoSync.lastOutcome && !autoSync.lastOutcome.ok) {
    state = "error";
    const n = autoSync.consecutiveFailures;
    label = t("sync.indicator.failed", { n });
  } else if (autoSync.lastOutcome) {
    state = "ok";
    label = t("sync.indicator.ok", { when: formatRelativeTime(autoSync.lastOutcome.at) });
  } else {
    state = "idle";
    label = t("sync.indicator.idle");
  }
  el.dataset.state = state;
  el.textContent = "";
  el.setAttribute("title", label);
}

// --- Conflict modal --------------------------------------------------------
//
// Auto-sync surfaces conflicts via a modal because they need user
// action to resolve. Suppressed for 60 seconds after a "Later" so a
// rapid heartbeat doesn't re-poke the user repeatedly.
let conflictModalEl = null;
let conflictModalSuppressedUntil = 0;

function ensureConflictModal() {
  if (conflictModalEl) return conflictModalEl;
  const overlay = document.createElement("div");
  overlay.id = "sync-conflict-overlay";
  overlay.className = "sync-conflict-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="sync-conflict-card" role="dialog" aria-modal="true" aria-labelledby="sync-conflict-title">
      <h3 id="sync-conflict-title"></h3>
      <p id="sync-conflict-body"></p>
      <div class="sync-conflict-actions">
        <button type="button" id="sync-conflict-later"></button>
        <button type="button" id="sync-conflict-go" class="primary"></button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  conflictModalEl = overlay;
  overlay.querySelector("#sync-conflict-later")?.addEventListener("click", () => {
    overlay.hidden = true;
    conflictModalSuppressedUntil = Date.now() + 60_000;
  });
  overlay.querySelector("#sync-conflict-go")?.addEventListener("click", () => {
    overlay.hidden = true;
    if (typeof openSettingsSyncPanel === "function") {
      openSettingsSyncPanel();
    } else if (settingsButton) {
      settingsButton.click();
      setTimeout(() => settingsNavSync?.click(), 30);
    }
  });
  return overlay;
}

function openConflictModal(count, _profileId) {
  if (!count || count <= 0) return;
  if (Date.now() < conflictModalSuppressedUntil) return;
  const overlay = ensureConflictModal();
  const title = overlay.querySelector("#sync-conflict-title");
  const body = overlay.querySelector("#sync-conflict-body");
  const later = overlay.querySelector("#sync-conflict-later");
  const go = overlay.querySelector("#sync-conflict-go");
  if (title) title.textContent = t("sync.conflict_modal.title");
  if (body) body.textContent = t("sync.conflict_modal.body", { n: count });
  if (later) later.textContent = t("sync.conflict_modal.later");
  if (go) go.textContent = t("sync.conflict_modal.go");
  overlay.hidden = false;
}

// --- Auto-sync settings controls -------------------------------------------
//
// The setting panel doesn't have static markup for these toggles, so we
// inject them at the bottom of the sync panel on first display. Values
// persist via localStorage; changes take effect immediately via
// scheduleAutoSync().
function ensureAutoSyncSettingsControls() {
  if (!settingsSyncPanel) return;
  if (document.getElementById("settings-sync-auto-block")) return;

  const block = document.createElement("div");
  block.id = "settings-sync-auto-block";
  block.className = "settings-sync-auto-block settings-section settings-sync-card";
  block.innerHTML = `
    <div class="settings-item-title" id="settings-sync-auto-title"></div>
    <label class="settings-sync-auto-row">
      <input type="checkbox" id="settings-sync-auto-enabled" />
      <span id="settings-sync-auto-enabled-label"></span>
    </label>
    <label class="settings-sync-auto-row">
      <span id="settings-sync-auto-interval-label"></span>
      <input type="number" id="settings-sync-auto-interval" min="30" max="600" step="10" />
      <span id="settings-sync-auto-interval-suffix"></span>
    </label>
    <label class="settings-sync-auto-row">
      <input type="checkbox" id="settings-sync-auto-visibility" />
      <span id="settings-sync-auto-visibility-label"></span>
    </label>
  `;
  settingsSyncPanel.appendChild(block);

  const enabledEl = document.getElementById("settings-sync-auto-enabled");
  const intervalEl = document.getElementById("settings-sync-auto-interval");
  const visibilityEl = document.getElementById("settings-sync-auto-visibility");

  // i18n
  document.getElementById("settings-sync-auto-title").textContent = t("settings.sync.auto.title");
  document.getElementById("settings-sync-auto-enabled-label").textContent = t("settings.sync.auto.enabled");
  document.getElementById("settings-sync-auto-interval-label").textContent = t("settings.sync.auto.interval");
  document.getElementById("settings-sync-auto-interval-suffix").textContent = t("settings.sync.auto.interval_suffix");
  document.getElementById("settings-sync-auto-visibility-label").textContent = t("settings.sync.auto.on_visibility");

  // initial values
  enabledEl.checked = autoSyncEnabled();
  intervalEl.value = String(autoSyncInterval());
  visibilityEl.checked = autoSyncOnVisibility();

  enabledEl.addEventListener("change", () => {
    localStorage.setItem(SETTINGS_KEY_SYNC_AUTO_ENABLED, enabledEl.checked ? "true" : "false");
    scheduleAutoSync();
    updateSyncIndicator();
  });
  intervalEl.addEventListener("change", () => {
    let n = parseInt(intervalEl.value, 10);
    if (!Number.isFinite(n)) n = AUTO_SYNC_DEFAULT_INTERVAL_SEC;
    n = Math.max(AUTO_SYNC_MIN_INTERVAL_SEC, Math.min(AUTO_SYNC_MAX_INTERVAL_SEC, n));
    intervalEl.value = String(n);
    localStorage.setItem(SETTINGS_KEY_SYNC_AUTO_INTERVAL, String(n));
    scheduleAutoSync();
  });
  visibilityEl.addEventListener("change", () => {
    localStorage.setItem(SETTINGS_KEY_SYNC_AUTO_ON_VISIBILITY, visibilityEl.checked ? "true" : "false");
  });
}

function openSettingsSyncPanel() {
  if (settingsButton) settingsButton.click();
  setTimeout(() => settingsNavSync?.click(), 30);
}

function markSyncLast(action, events = 0, extra = {}) {
  localStorage.setItem("zeroterm.sync.last", JSON.stringify({
    at: Date.now(),
    action,
    events,
    ...extra,
  }));
}

async function runImmediateSync(_opts) {
  const id = await ensureSyncProfileReadyForActions();
  try {
    const outcome = await invoke("sync_now", { profileId: id });
    autoSync.consecutiveFailures = 0;
    autoSync.lastOutcome = {
      at: Date.now(),
      ok: true,
      action: "manual",
      pulled: outcome.eventsPulled ?? 0,
      pushed: outcome.eventsPushed ?? 0,
      conflicts: outcome.conflictsDetected ?? 0,
    };
    if ((outcome.conflictsDetected ?? 0) > 0) {
      openConflictModal(outcome.conflictsDetected, id);
    }
    updateSyncIndicator();
    scheduleAutoSync();
    return outcome;
  } catch (e) {
    autoSync.consecutiveFailures += 1;
    autoSync.lastOutcome = { at: Date.now(), ok: false, action: "manual", error: String(e) };
    updateSyncIndicator();
    scheduleAutoSync();
    throw e;
  }
}

async function fillSftpLocalDirDefaultIfEmpty() {
  if (!settingsSftpLocalDir) return;
  const current = String(settingsSftpLocalDir.value || "").trim();
  if (current) return;

  if (!settingsSftpHomeCache) {
    try {
      settingsSftpHomeCache = await invoke("local_home_path");
    } catch {
      settingsSftpHomeCache = "";
    }
  }
  if (!settingsSftpHomeCache) return;

  settingsSftpLocalDir.value = settingsSftpHomeCache;
  if (!localStorage.getItem(SETTINGS_KEY_SFTP_LOCAL_DIR)) {
    localStorage.setItem(SETTINGS_KEY_SFTP_LOCAL_DIR, settingsSftpHomeCache);
  }
}

async function loadAppVersion() {
  if (appVersionCache) return appVersionCache;
  try {
    appVersionCache = await invoke("app_version");
  } catch {
    appVersionCache = "-";
  }
  return appVersionCache;
}

async function refreshUpdateStatus() {
  try {
    const info = await invoke("check_for_update");
    latestUpdateInfo = info;
    if (settingsUpdateInstall) settingsUpdateInstall.disabled = !info.available;
    if (!info.available) {
      if (settingsUpdateStatus) {
        settingsUpdateStatus.textContent = t("settings.update.latest", { version: info.currentVersion });
      }
      return;
    }
    if (settingsUpdateStatus) {
      settingsUpdateStatus.textContent = t("settings.update.available", {
        current: info.currentVersion,
        latest: info.version || "?",
      });
    }
  } catch (e) {
    latestUpdateInfo = null;
    if (settingsUpdateInstall) settingsUpdateInstall.disabled = true;
    if (settingsUpdateStatus) settingsUpdateStatus.textContent = t("settings.update.failed", { error: String(e) });
  }
}

function setSettingsGeneralSubtab(subtab) {
  settingsGeneralSubtab = subtab === "sftp" ? "sftp" : "basic";
  settingsGeneralSubtabBasic?.classList.toggle("active", settingsGeneralSubtab === "basic");
  settingsGeneralSubtabSftp?.classList.toggle("active", settingsGeneralSubtab === "sftp");
  if (settingsGeneralBasicSection) settingsGeneralBasicSection.hidden = settingsGeneralSubtab !== "basic";
  if (settingsGeneralSftpSection) settingsGeneralSftpSection.hidden = settingsGeneralSubtab !== "sftp";
  if (settingsGeneralSubtab === "basic" && typeof syncBackgroundSettingsUI === "function") {
    loadNetworkProxyConfig({ quiet: true }).catch(() => {});
    syncBackgroundSettingsUI();
    syncWindowLayoutSettingsUI();
  }
}

function setSettingsTerminalSubtab(subtab) {
  settingsTerminalSubtab = "font";
  settingsTerminalSubtabTheme?.classList.toggle("active", settingsTerminalSubtab === "theme");
  settingsTerminalSubtabFont?.classList.toggle("active", settingsTerminalSubtab === "font");
  if (settingsTerminalThemeSection) settingsTerminalThemeSection.hidden = settingsTerminalSubtab !== "theme";
  if (settingsTerminalFontSection) settingsTerminalFontSection.hidden = settingsTerminalSubtab !== "font";
}

function bindDragOnBar(el) {
  if (!el || !appWindow?.startDragging) return;
  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (ev.detail > 1) return;
    if (isTitlebarInteractiveTarget(ev.target)) return;
    appWindow.startDragging().catch((e) => {
      console.warn("startDragging failed", e);
    });
  });
}

function bindDblclickMaximizeOnBar(el) {
  if (!el || !appWindow?.toggleMaximize) return;
  el.addEventListener("dblclick", (ev) => {
    if (ev.button !== 0) return;
    if (isTitlebarInteractiveTarget(ev.target)) return;
    appWindow.toggleMaximize().catch((e) => {
      console.warn("toggleMaximize failed", e);
    }).finally(() => {
      syncWindowMaximizeButtonState();
    });
  });
}

function sidebarToggleIconMarkup(collapsed) {
  const arrowPath = collapsed ? "m11 9 3 3-3 3" : "m14 9-3 3 3 3";
  return `
    <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2"></rect>
      <path d="M9 4v16"></path>
      <path d="${arrowPath}"></path>
    </svg>
  `;
}

function syncSidebarToggleButton(button, collapsed) {
  if (!button) return;
  button.innerHTML = sidebarToggleIconMarkup(collapsed);
  const labelKey = collapsed ? "sidebar.expand" : "sidebar.collapse";
  button.setAttribute("title", t(labelKey));
  button.setAttribute("aria-label", t(labelKey));
}

function setWorkspaceSidebarCollapsed(collapsed) {
  workspaceSidebarCollapsed = Boolean(collapsed);
  appShell?.classList.toggle("sidebar-collapsed", workspaceSidebarCollapsed);
  syncSidebarToggleButton(workspaceSidebarToggle, workspaceSidebarCollapsed);
  syncSidebarToggleButton(workspaceSidebarToggleRight, workspaceSidebarCollapsed);
  if (!workspaceSidebarCollapsed) {
    applyVaultSidebarWidth(vaultSidebarWidth);
  }
  if (vaultsContent) vaultsContent.hidden = workspaceSidebarCollapsed;
}

function hideHostsContextMenu() {
  if (!hostsContextMenu) return;
  hostsContextMenu.hidden = true;
  hostsContextHostId = null;
}

function hideGroupsContextMenu() {
  if (!groupsContextMenu) return;
  groupsContextMenu.hidden = true;
  groupsContextGroupId = null;
}

function getTerminalSelectionMenuElement(itemId) {
  switch (itemId) {
    case "url":
      return terminalSelectionMenuUrl;
    case "search":
      return terminalSelectionMenuSearch;
    case "copy":
      return terminalSelectionMenuCopy;
    case "execute":
      return terminalSelectionMenuExecute;
    case "sftp":
      return terminalSelectionMenuSftp;
    case "ai":
      return terminalSelectionMenuAi;
    default:
      return null;
  }
}

function getTerminalSelectionMenuLabelKey(itemId) {
  switch (itemId) {
    case "url":
      return "terminal.selection.open";
    case "search":
      return "terminal.selection.search";
    case "copy":
      return "terminal.selection.copy";
    case "execute":
      return "terminal.selection.execute";
    case "ai":
      return "terminal.selection.ai";
    default:
      return "";
  }
}

function getTerminalSelectionMenuOrderLabel(itemId) {
  if (itemId === "sftp") return "SFTP";
  return t(getTerminalSelectionMenuLabelKey(itemId));
}

function normalizeTerminalSelectionMenuOrder(order) {
  const known = new Set(TERMINAL_SELECTION_MENU_DEFAULT_ORDER);
  const next = [];
  if (Array.isArray(order)) {
    for (const item of order) {
      if (known.has(item) && !next.includes(item)) next.push(item);
    }
  }
  for (const item of TERMINAL_SELECTION_MENU_DEFAULT_ORDER) {
    if (next.includes(item)) continue;
    const defaultIndex = TERMINAL_SELECTION_MENU_DEFAULT_ORDER.indexOf(item);
    let insertAt = next.length;
    for (let i = defaultIndex + 1; i < TERMINAL_SELECTION_MENU_DEFAULT_ORDER.length; i += 1) {
      const nextDefaultItem = TERMINAL_SELECTION_MENU_DEFAULT_ORDER[i];
      const nextIndex = next.indexOf(nextDefaultItem);
      if (nextIndex >= 0) {
        insertAt = nextIndex;
        break;
      }
    }
    next.splice(insertAt, 0, item);
  }
  return next;
}

function getTerminalSelectionMenuOrder() {
  try {
    return normalizeTerminalSelectionMenuOrder(JSON.parse(localStorage.getItem(SETTINGS_KEY_TERMINAL_SELECTION_MENU_ORDER) || "[]"));
  } catch {
    return [...TERMINAL_SELECTION_MENU_DEFAULT_ORDER];
  }
}

function saveTerminalSelectionMenuOrder(order) {
  const next = normalizeTerminalSelectionMenuOrder(order);
  localStorage.setItem(SETTINGS_KEY_TERMINAL_SELECTION_MENU_ORDER, JSON.stringify(next));
  applyTerminalSelectionMenuOrder();
  renderTerminalSelectionMenuOrderSettings();
}

function applyTerminalSelectionMenuOrder() {
  if (!terminalSelectionMenu) return;
  for (const itemId of getTerminalSelectionMenuOrder()) {
    const el = getTerminalSelectionMenuElement(itemId);
    if (el) terminalSelectionMenu.appendChild(el);
  }
}

function syncTerminalSelectionMenuFirstVisible() {
  let found = false;
  for (const itemId of getTerminalSelectionMenuOrder()) {
    const el = getTerminalSelectionMenuElement(itemId);
    if (!el) continue;
    el.classList.remove("first-visible");
    if (!found && !el.hidden) {
      el.classList.add("first-visible");
      found = true;
    }
  }
}

const SETTINGS_DATA_CLEAR_ITEMS = Object.freeze([
  "local_settings",
  "vault_data",
  "sync_profiles",
  "ai_profiles",
  "ai_sessions",
  "remembered_password",
]);

function getSettingsDataClearItemLabel(itemId) {
  return t(`settings.data.item.${itemId}`);
}

function setSettingsDataClearConfirmEnabled() {
  if (!settingsDataClearConfirm || !settingsDataClearOptions) return;
  const checked = settingsDataClearOptions.querySelectorAll("input[type='checkbox']:checked").length;
  settingsDataClearConfirm.disabled = checked === 0;
}

function renderSettingsDataClearOptions() {
  if (!settingsDataClearOptions) return;
  settingsDataClearOptions.textContent = "";
  for (const itemId of SETTINGS_DATA_CLEAR_ITEMS) {
    const label = document.createElement("label");
    label.className = "settings-data-clear-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = itemId;
    checkbox.addEventListener("change", setSettingsDataClearConfirmEnabled);

    const body = document.createElement("span");
    body.className = "settings-data-clear-option-body";
    const title = document.createElement("strong");
    title.textContent = getSettingsDataClearItemLabel(itemId);
    const desc = document.createElement("small");
    desc.textContent = t(`settings.data.item.${itemId}.desc`);
    body.append(title, desc);
    label.append(checkbox, body);
    settingsDataClearOptions.appendChild(label);
  }
  setSettingsDataClearConfirmEnabled();
}

function setSettingsDataClearDialogOpen(open) {
  if (!settingsDataClearOverlay) return;
  settingsDataClearOverlay.hidden = !open;
  if (open) {
    renderSettingsDataClearOptions();
    requestAnimationFrame(() => {
      settingsDataClearOptions?.querySelector("input[type='checkbox']")?.focus();
    });
  }
}

function getSelectedSettingsDataClearItems() {
  if (!settingsDataClearOptions) return [];
  return Array.from(settingsDataClearOptions.querySelectorAll("input[type='checkbox']:checked"))
    .map((input) => input.value)
    .filter((value) => SETTINGS_DATA_CLEAR_ITEMS.includes(value));
}

async function clearAllAiProfiles() {
  await loadAiConfig().catch(() => {});
  const ids = Array.isArray(aiStore.profiles) ? aiStore.profiles.map((profile) => profile.id).filter(Boolean) : [];
  let latestStore = null;
  for (const id of ids) {
    latestStore = await invoke("delete_ai_profile", { id });
  }
  if (latestStore) applyAiStore(latestStore);
  else applyAiStore({ version: 2, profiles: [], activeProfileId: "" });
  if (aiEditingProfileId) cancelAiEditor();
}

async function clearAllAiSessionHistory() {
  const wasTemporary = aiCurrentSessionTemporary;
  await invoke("clear_ai_sessions");
  aiSessionItems = [];
  clearAiSessionIdentitiesForScope();
  if (aiMessages.length) {
    aiCurrentSessionTemporary = wasTemporary;
    storeAiConversationForActivePane({ persist: false });
  }
  renderAiSessions();
}

async function clearSelectedSettingsData(itemIds) {
  const selected = new Set(itemIds);
  if (selected.has("local_settings")) {
    await resetLocalSettingsToDefaults();
  }
  if (selected.has("remembered_password")) {
    await invoke("forget_keychain");
  }
  if (selected.has("ai_profiles")) {
    await clearAllAiProfiles();
  }
  if (selected.has("ai_sessions")) {
    await clearAllAiSessionHistory();
  }
  if (selected.has("sync_profiles") && !selected.has("vault_data")) {
    await invoke("delete_all_sync_profiles");
    await loadSyncProfiles().catch(() => {});
  }
  if (selected.has("vault_data")) {
    await invoke("clear_vault_data");
    await refreshAllSyncedViewsFromVault();
    await loadSyncProfiles().catch(() => {});
  }
}

function renderTerminalSelectionMenuOrderSettings() {
  if (!settingsTerminalSelectionMenuOrder) return;
  const order = getTerminalSelectionMenuOrder();
  settingsTerminalSelectionMenuOrder.textContent = "";
  order.forEach((itemId) => {
    const row = document.createElement("div");
    row.className = "terminal-menu-order-item";
    row.draggable = true;
    row.dataset.menuItem = itemId;
    row.title = getTerminalSelectionMenuOrderLabel(itemId);

    const handle = document.createElement("span");
    handle.className = "terminal-menu-order-handle";
    handle.textContent = "⋮⋮";
    handle.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "terminal-menu-order-label";
    label.textContent = getTerminalSelectionMenuOrderLabel(itemId);

    row.addEventListener("dragstart", (ev) => {
      row.classList.add("dragging");
      ev.dataTransfer?.setData("text/plain", itemId);
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
    });
    row.addEventListener("dragend", () => row.classList.remove("dragging"));
    row.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const dragged = ev.dataTransfer?.getData("text/plain") || "";
      if (!dragged || dragged === itemId) return;
      const next = getTerminalSelectionMenuOrder().filter((item) => item !== dragged);
      const targetIndex = next.indexOf(itemId);
      if (targetIndex < 0) return;
      const rect = row.getBoundingClientRect();
      const afterTarget = ev.clientX > rect.left + rect.width / 2;
      next.splice(targetIndex + (afterTarget ? 1 : 0), 0, dragged);
      saveTerminalSelectionMenuOrder(next);
    });

    row.append(handle, label);
    settingsTerminalSelectionMenuOrder.appendChild(row);
  });
}

function hideTerminalSelectionMenu() {
  if (!terminalSelectionMenu) return;
  terminalSelectionMenu.hidden = true;
  terminalSelectionMenuPaneId = null;
  terminalSelectionMenuText = "";
  terminalSelectionMenuUrlValue = "";
  terminalSelectionMenuSftpPath = "";
}

function normalizeOpenableSelectionUrl(text) {
  const value = String(text || "").trim();
  if (!value || /\s/.test(value)) return "";
  const urlPattern = /^(https?:\/\/|www\.)[^\s<>'"`]+$/i;
  const ipv4Pattern = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?(?:\/[\w\-./?%&=+#:]*)?$/;
  if (!urlPattern.test(value) && !ipv4Pattern.test(value)) return "";
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

function normalizeTerminalSelectionPath(text) {
  let value = String(text || "").trim();
  if (!value || value.length > 512) return "";
  value = value.replace(/^[`"'([{<]+/, "").replace(/[`"',;:)\]}>]+$/, "").trim();
  if (!value || /\r|\n|\t/.test(value)) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return "";
  if (/^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) return "";
  if (value.includes("\0")) return "";

  const posixRooted = value.startsWith("/");
  const homeRooted = /^~(?:\/|$)/.test(value);
  const relativeRooted = /^(?:\.{1,2})(?:\/|\\|$)/.test(value);
  const windowsDrive = /^[A-Za-z]:[\\/]/.test(value);
  const windowsUnc = /^\\\\[^\\]+\\[^\\]+/.test(value);
  const hasSeparator = /[\\/]/.test(value);
  if (!(posixRooted || homeRooted || relativeRooted || windowsDrive || windowsUnc)) return "";
  if (!hasSeparator && !homeRooted) return "";
  return value;
}

function showTerminalSelectionMenu(pane, text, x, y) {
  if (!terminalSelectionMenu || !pane) return;
  const selectedText = String(text || "");
  if (!selectedText.trim()) {
    hideTerminalSelectionMenu();
    return;
  }
  terminalSelectionMenuPaneId = pane.id;
  terminalSelectionMenuText = selectedText;
  terminalSelectionMenuUrlValue = normalizeOpenableSelectionUrl(selectedText);
  terminalSelectionMenuSftpPath = normalizeTerminalSelectionPath(selectedText);
  applyTerminalSelectionMenuOrder();
  if (terminalSelectionMenuUrl) {
    terminalSelectionMenuUrl.hidden = !terminalSelectionMenuUrlValue;
  }
  if (terminalSelectionMenuSftp) {
    terminalSelectionMenuSftp.hidden = !terminalSelectionMenuSftpPath;
  }
  syncTerminalSelectionMenuFirstVisible();
  terminalSelectionMenu.style.left = "0px";
  terminalSelectionMenu.style.top = "0px";
  terminalSelectionMenu.hidden = false;
  requestAnimationFrame(() => {
    const rect = terminalSelectionMenu.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    terminalSelectionMenu.style.left = `${left}px`;
    terminalSelectionMenu.style.top = `${top}px`;
  });
}

async function copyTerminalSelectionMenuText() {
  if (!terminalSelectionMenuText) return;
  try {
    await navigator.clipboard.writeText(terminalSelectionMenuText);
  } catch (e) {
    showToast(t("terminal.selection.copy_failed", { error: e }), "error", 3200);
    throw e;
  }
}

async function executeTerminalSelectionText() {
  if (!terminalSelectionMenuText.trim()) return;
  const pane = activateTerminalPaneById(terminalSelectionMenuPaneId);
  if (!pane?.sessionId) throw new Error("no terminal session");
  await runCommandTextInPane(pane, terminalSelectionMenuText);
}

async function openTerminalSelectionUrl() {
  if (!terminalSelectionMenuUrlValue) return;
  try {
    await invoke("plugin:opener|open_url", { url: terminalSelectionMenuUrlValue });
  } catch (e) {
    try {
      const opened = window.open(terminalSelectionMenuUrlValue, "_blank", "noopener");
      if (opened) return;
    } catch {}
    showToast(t("terminal.selection.open_url_failed", { error: e }), "error", 3200);
    throw e;
  }
}

function buildTerminalSelectionSearchUrl(text) {
  const query = String(text || "").trim().replace(/\s+/g, " ");
  if (!query) return "";
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

async function searchTerminalSelectionText() {
  const url = buildTerminalSelectionSearchUrl(terminalSelectionMenuText);
  if (!url) return;
  try {
    await invoke("plugin:opener|open_url", { url });
  } catch (e) {
    try {
      const opened = window.open(url, "_blank", "noopener");
      if (opened) return;
    } catch {}
    showToast(t("terminal.selection.search_failed", { error: e }), "error", 3200);
    throw e;
  }
}

function focusAiPanelForPaneId(paneId) {
  const tab = getActiveTab();
  if (tab && paneId) tab.activePaneId = paneId;
  syncAiConversationToActivePane();
  setTerminalSidePanel("ai");
  aiComposeInput?.focus();
}

function activateTerminalPaneById(paneId) {
  const tab = getActiveTab();
  if (!tab || !paneId) return null;
  const pane = tab.panes.find((item) => item.id === paneId) || null;
  if (!pane) return null;
  if (tab.activePaneId !== pane.id) {
    tab.activePaneId = pane.id;
    renderTerminalWorkspace();
  }
  return pane;
}

function resolveTerminalSelectionPathForSftpPane(sftpPane, rawPath, terminalPane) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";
  if (isLocalPane(sftpPane)) {
    return resolveLocalTargetPath(sftpPane.path || "/", raw);
  }
  const unixRaw = raw.replace(/\\/g, "/");
  if (unixRaw.startsWith("/")) return normalizeAbsolutePath(unixRaw);
  if (unixRaw === "~" || unixRaw.startsWith("~/")) {
    const user = String(terminalPane?.host?.user || "").trim();
    const home = user === "root" ? "/root" : user ? `/home/${user}` : "/";
    return unixRaw === "~" ? home : normalizeAbsolutePath(joinPath(home, unixRaw.slice(2)));
  }
  return normalizeAbsolutePath(joinPath(sftpPane.path || "/", unixRaw));
}

async function openTerminalSelectionPathInSftp() {
  const rawPath = terminalSelectionMenuSftpPath;
  if (!rawPath) return;
  const terminalPane = activateTerminalPaneById(terminalSelectionMenuPaneId);
  if (!terminalPane) return;
  setTerminalSidePanel("sftp", { skipSftpConnect: true });
  const sftpPane = sftpPanes.terminal;
  await connectTerminalSftpToActivePane();
  if (!sftpPane || !isPaneConnected(sftpPane)) {
    throw new Error(sftpPane?.statusEl?.textContent || t("sftp.status.not_connected"));
  }
  const targetPath = resolveTerminalSelectionPathForSftpPane(sftpPane, rawPath, terminalPane);
  if (!targetPath) return;
  await navigateSftpPane(sftpPane, targetPath, { source: "user" });
}

async function sendTerminalSelectionToAi() {
  if (!terminalSelectionMenuText) return;
  focusAiPanelForPaneId(terminalSelectionMenuPaneId);
  if (isAiSendingForPane()) {
    showToast(t("terminal.selection.ai_busy"), "error", 2600);
    return;
  }
  await sendAiMessage(terminalSelectionMenuText);
}

function showHostsContextMenu(host, ev) {
  if (!hostsContextMenu || !host) return;
  hostsContextHostId = host.id;
  hostsContextMenu.hidden = false;
  const pad = 8;
  requestAnimationFrame(() => {
    const rect = hostsContextMenu.getBoundingClientRect();
    let left = ev.clientX;
    let top = ev.clientY;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    hostsContextMenu.style.left = `${left}px`;
    hostsContextMenu.style.top = `${top}px`;
  });
}

function showGroupsContextMenu(group, ev) {
  if (!groupsContextMenu || !group) return;
  groupsContextGroupId = group.id;
  groupsContextMenu.hidden = false;
  const pad = 8;
  requestAnimationFrame(() => {
    const rect = groupsContextMenu.getBoundingClientRect();
    let left = ev.clientX;
    let top = ev.clientY;
    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, window.innerHeight - rect.height - pad);
    }
    groupsContextMenu.style.left = `${left}px`;
    groupsContextMenu.style.top = `${top}px`;
  });
}

const customSelectState = {
  openId: null,
};

function fuzzyMatchSelectOption(label, query) {
  const text = String(label || "").toLowerCase();
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  if (text.includes(needle)) return true;
  let qi = 0;
  for (let i = 0; i < text.length && qi < needle.length; i += 1) {
    if (text[i] === needle[qi]) qi += 1;
  }
  return qi === needle.length;
}

function buildCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customSelectBound === "1") return;
  const isSftpHostSelectMenu = selectEl.id === "sftp-left-host" || selectEl.id === "sftp-right-host";
  const localHostValue = "__local__";
  const wrap = document.createElement("div");
  wrap.className = "zt-select-wrap";
  const trigger = document.createElement("div");
  trigger.className = "zt-select-trigger";
  trigger.tabIndex = 0;
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const triggerInput = document.createElement("input");
  triggerInput.type = "text";
  triggerInput.className = "zt-select-trigger-input";
  triggerInput.autocomplete = "off";
  triggerInput.spellcheck = false;
  const triggerCaret = document.createElement("span");
  triggerCaret.className = "zt-select-trigger-caret";
  trigger.append(triggerInput, triggerCaret);
  const menu = document.createElement("div");
  menu.className = "zt-select-menu";
  menu.hidden = true;
  const optionsBox = document.createElement("div");
  optionsBox.className = "zt-select-options";
  const empty = document.createElement("div");
  empty.className = "zt-select-empty";
  empty.textContent = t("select.search.empty");
  empty.hidden = true;
  menu.append(optionsBox, empty);

  const parent = selectEl.parentElement;
  if (!parent) return;
  selectEl.dataset.customSelectBound = "1";
  selectEl.classList.add("zt-select-native");
  parent.insertBefore(wrap, selectEl);
  wrap.append(trigger, menu);
  wrap.appendChild(selectEl);

  let selectedLabel = "";
  let customValue = "";
  let menuPortaled = false;
  let sftpHostBrowseGroupId = "";

  if (isSftpHostSelectMenu) {
    wrap.classList.add("zt-select-wrap-sftp-host");
    menu.classList.add("zt-select-menu-sftp-host");
  }

  const usesPortalMenu = () => Boolean(wrap.closest("#host-edit-overlay") || wrap.closest("#ai-config-overlay"));
  const resetPortalMenu = () => {
    if (!menuPortaled) return;
    menuPortaled = false;
    menu.classList.remove("zt-select-menu-portal");
    menu.style.position = "";
    menu.style.left = "";
    menu.style.right = "";
    menu.style.top = "";
    menu.style.width = "";
    menu.style.maxHeight = "";
    menu.style.zIndex = "";
    wrap.insertBefore(menu, selectEl);
  };

  const positionPortalMenu = () => {
    if (!usesPortalMenu() || menu.hidden) return;
    if (menu.parentElement !== document.body) {
      document.body.appendChild(menu);
      menuPortaled = true;
      menu.classList.add("zt-select-menu-portal");
    }
    const rect = trigger.getBoundingClientRect();
    const gap = 6;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const below = Math.max(0, viewportHeight - rect.bottom - gap - 8);
    const above = Math.max(0, rect.top - gap - 8);
    const openUp = below < 180 && above > below;
    const available = openUp ? above : below;
    const maxHeight = Math.max(120, Math.min(280, available));
    menu.style.position = "fixed";
    menu.style.left = `${Math.round(rect.left)}px`;
    menu.style.right = "auto";
    menu.style.width = `${Math.round(rect.width)}px`;
    menu.style.top = openUp
      ? `${Math.max(8, Math.round(rect.top - gap - maxHeight))}px`
      : `${Math.round(rect.bottom + gap)}px`;
    menu.style.maxHeight = `${Math.round(maxHeight)}px`;
    menu.style.zIndex = "10000";
  };

  const onPortalViewportChange = () => positionPortalMenu();

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    triggerInput.value = customValue || selectedLabel;
    if (isSftpHostSelectMenu) sftpHostBrowseGroupId = "";
    if (customSelectState.openId === selectEl.id) {
      customSelectState.openId = null;
    }
    stackingAncestor?.classList.remove("zt-select-open");
    window.removeEventListener("resize", onPortalViewportChange);
    window.removeEventListener("scroll", onPortalViewportChange, true);
    resetPortalMenu();
  };

  let suppressLabelRestore = false;

  // The nearest card-like ancestor that creates a stacking context (it has
  // backdrop-filter), which would otherwise clip the dropdown menu inside
  // its own bounds. We toggle a class on it so the open card sits above
  // sibling cards and the menu can extend across them.
  const stackingAncestor = wrap.closest(".settings-section");

  const open = ({ preserveQuery = false } = {}) => {
    if (customSelectState.openId && customSelectState.openId !== selectEl.id) {
      const current = document.querySelector(`select#${customSelectState.openId}`);
      current?.dispatchEvent(new CustomEvent("zt-select-close"));
    }
    // Unhide first so sync() doesn't restore selectedLabel into the input,
    // then clear the search query so all options are visible.
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    customSelectState.openId = selectEl.id;
    if (isSftpHostSelectMenu) {
      if (!preserveQuery) {
        sftpHostBrowseGroupId = "";
        triggerInput.value = "";
      }
    } else if (!preserveQuery) {
      triggerInput.value = "";
    }
    suppressLabelRestore = true;
    sync();
    suppressLabelRestore = false;
    stackingAncestor?.classList.add("zt-select-open");
    positionPortalMenu();
    if (usesPortalMenu()) {
      window.addEventListener("resize", onPortalViewportChange);
      window.addEventListener("scroll", onPortalViewportChange, true);
    }
  };

  const compareSelectMenuLabels = (a, b) =>
    String(a || "").localeCompare(String(b || ""), undefined, {
      sensitivity: "base",
      numeric: true,
    });

  const renderSftpHostMenu = () => {
    const query = (triggerInput.value || "").trim();
    const groupsById = new Map(hostGroups.map((group) => [group.id, group]));

    const buildOption = ({ label, meta = "", active = false, kind = "host", onClick }) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `zt-select-option zt-select-option-${kind}` + (active ? " active" : "");

      const text = document.createElement("span");
      text.className = "zt-select-option-text";
      const title = document.createElement("span");
      title.className = "zt-select-option-label";
      title.textContent = label;
      text.appendChild(title);
      if (meta) {
        const sub = document.createElement("span");
        sub.className = "zt-select-option-meta";
        sub.textContent = meta;
        text.appendChild(sub);
      }
      item.appendChild(text);

      if (kind === "group") {
        const next = document.createElement("span");
        next.className = "zt-select-option-next";
        next.textContent = "›";
        item.appendChild(next);
      }

      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      optionsBox.appendChild(item);
    };

    // When the user types, search hosts across all groups (flat fuzzy match)
    // instead of the hierarchical group browser.
    if (query) {
      optionsBox.innerHTML = "";
      empty.textContent = t("select.search.empty");
      const localLabel = t("sftp.host.local");
      if (fuzzyMatchSelectOption(localLabel, query)) {
        buildOption({
          label: localLabel,
          active: selectEl.value === localHostValue,
          kind: "host",
          onClick: () => {
            selectEl.value = localHostValue;
            selectEl.dataset.customValue = "";
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            sync();
            close();
          },
        });
      }
      const matches = hostsCache
        .filter((host) => fuzzyMatchSelectOption(`${host.name} ${host.user}@${host.host}:${host.port}`, query))
        .sort((a, b) =>
          compareSelectMenuLabels(a.name, b.name)
          || compareSelectMenuLabels(`${a.user}@${a.host}:${a.port}`, `${b.user}@${b.host}:${b.port}`));
      for (const host of matches) {
        buildOption({
          label: host.name,
          meta: `${host.user}@${host.host}:${host.port}`,
          active: selectEl.value === host.id,
          kind: "host",
          onClick: () => {
            selectEl.value = host.id;
            selectEl.dataset.customValue = "";
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));
            sync();
            close();
          },
        });
      }
      empty.hidden = optionsBox.childElementCount > 0;
      return;
    }

    const currentGroup = sftpHostBrowseGroupId ? groupsById.get(sftpHostBrowseGroupId) || null : null;
    const currentGroupId = currentGroup?.id || "";
    const groupChildren = hostGroups
      .filter((group) => (group.parentId || "") === currentGroupId)
      .sort((a, b) =>
        Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || compareSelectMenuLabels(a.name, b.name));
    const hostRows = hostsCache
      .filter((host) => {
        const gid = String(host.groupId || "");
        if (!currentGroup) return !gid || !groupsById.has(gid);
        return gid === currentGroup.id;
      })
      .sort((a, b) =>
        compareSelectMenuLabels(a.name, b.name)
        || compareSelectMenuLabels(`${a.user}@${a.host}:${a.port}`, `${b.user}@${b.host}:${b.port}`));

    empty.textContent = currentGroup ? t("sftp.host.group.empty") : t("select.search.empty");
    optionsBox.innerHTML = "";

    if (currentGroup) {
      buildOption({
        label: t("files.button.back"),
        meta: currentGroup.name,
        kind: "back",
        onClick: () => {
          sftpHostBrowseGroupId = currentGroup.parentId || "";
          renderSftpHostMenu();
          positionPortalMenu();
        },
      });
    } else {
      buildOption({
        label: t("sftp.host.local"),
        active: selectEl.value === localHostValue,
        kind: "host",
        onClick: () => {
          selectEl.value = localHostValue;
          selectEl.dataset.customValue = "";
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          sync();
          close();
        },
      });
    }

    for (const group of groupChildren) {
      buildOption({
        label: group.name,
        meta: "",
        kind: "group",
        onClick: () => {
          sftpHostBrowseGroupId = group.id;
          renderSftpHostMenu();
          positionPortalMenu();
        },
      });
    }

    for (const host of hostRows) {
      buildOption({
        label: host.name,
        meta: `${host.user}@${host.host}:${host.port}`,
        active: selectEl.value === host.id,
        kind: "host",
        onClick: () => {
          selectEl.value = host.id;
          selectEl.dataset.customValue = "";
          selectEl.dispatchEvent(new Event("change", { bubbles: true }));
          sync();
          close();
        },
      });
    }

    empty.hidden = optionsBox.childElementCount > 0;
  };

  const sync = () => {
    const opts = Array.from(selectEl.options);
    const current = opts.find((o) => o.value === selectEl.value) || opts[0];
    selectedLabel = current ? current.textContent || "" : "";
    customValue = selectEl.dataset.customValue || "";
    if (current?.value === "" && selectEl.dataset.emptyDisplay !== undefined) {
      selectedLabel = selectEl.dataset.emptyDisplay;
    }
    if (document.activeElement !== triggerInput || menu.hidden) {
      if (!suppressLabelRestore) {
        triggerInput.value = customValue || selectedLabel;
      }
    }
    if (isSftpHostSelectMenu) {
      renderSftpHostMenu();
      return;
    }
    empty.textContent = t("select.search.empty");
    optionsBox.innerHTML = "";
    const query = triggerInput.value || "";
    const visible = opts.filter((opt) => fuzzyMatchSelectOption(opt.textContent, query));
    empty.hidden = visible.length > 0;
    for (const opt of visible) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "zt-select-option" + (opt.value === selectEl.value ? " active" : "");
      item.textContent = opt.textContent;
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dataset.customValue = "";
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
      });
      optionsBox.appendChild(item);
    }
  };

  trigger.addEventListener("mousedown", (ev) => ev.stopPropagation());
  trigger.addEventListener("click", (ev) => ev.stopPropagation());
  menu.addEventListener("mousedown", (ev) => ev.stopPropagation());
  menu.addEventListener("click", (ev) => ev.stopPropagation());
  wrap.addEventListener("zt-select-close", close);
  document.addEventListener("click", (ev) => {
    if (!wrap.contains(ev.target)) close();
  });
  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });
  triggerInput.addEventListener("focus", () => {
    open();
    triggerInput.select();
    sync();
  });
  triggerInput.addEventListener("click", () => {
    open();
  });
  triggerInput.addEventListener("input", () => {
    if (selectEl.dataset.allowCustom === "1") {
      selectEl.dataset.customValue = triggerInput.value.trim();
    }
    open({ preserveQuery: true });
    sync();
  });
  triggerInput.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      optionsBox.querySelector(".zt-select-option")?.focus();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const first = optionsBox.querySelector(".zt-select-option");
      if (first) {
        first.click();
      } else if (selectEl.dataset.allowCustom === "1") {
        selectEl.dataset.customValue = triggerInput.value.trim();
        close();
      }
    }
  });

  selectEl.addEventListener("change", sync);
  selectEl._ztSync = sync;
  sync();
}

function syncCustomSelect(selectId) {
  const el = document.getElementById(selectId);
  if (!el) return;
  buildCustomSelect(el);
  if (typeof el._ztSync === "function") el._ztSync();
}

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

  setText("workspace-tab-vaults", "workspace.tab.vaults");
  setText("workspace-tab-sftp", "workspace.tab.sftp");
  const vaultLocalTitle = document.getElementById("vault-local-title");
  if (vaultLocalTitle) vaultLocalTitle.textContent = "ZeroTerm";
  setText("vault-settings-text", "sidebar.settings");
  setAttr("workspace-nav-vaults", "title", "workspace.tab.vaults");
  setAttr("workspace-nav-sftp", "title", "workspace.tab.sftp");
  setAttr("new-window-button", "title", "sidebar.new_window");
  setAttr("settings-button", "title", "sidebar.settings");
  setAttr("quick-connect-button", "title", "sidebar.quick_connect");
  setAttr("local-terminal-button", "title", "sidebar.local_terminal");
  setText("port-forward-title", "port_forward.title");
  setText("port-forward-subtitle", "port_forward.subtitle");
  setAttr("port-forward-create", "title", "port_forward.create");
  setAttr("port-forward-create", "aria-label", "port_forward.create");
  setAttr("port-forward-refresh", "title", "port_forward.refresh");
  setAttr("port-forward-refresh", "aria-label", "port_forward.refresh");
  setPlaceholder("port-forward-search", "port_forward.search.placeholder");
  setText("port-forward-editor-subtitle", "port_forward.editor.subtitle");
  setAttr("port-forward-editor-close", "aria-label", "port_forward.editor.close");
  setText("port-forward-editor-host-label", "port_forward.editor.host");
  setText("port-forward-editor-kind-label", "port_forward.editor.kind");
  setOptionText("port-forward-editor-kind", "local", "port_forward.editor.kind.local");
  setOptionText("port-forward-editor-kind", "remote", "port_forward.editor.kind.remote");
  setOptionText("port-forward-editor-kind", "dynamic", "port_forward.editor.kind.dynamic");
  setText("port-forward-kind-local", "port_forward.editor.kind.local");
  setText("port-forward-kind-remote", "port_forward.editor.kind.remote");
  setText("port-forward-kind-dynamic", "port_forward.editor.kind.dynamic");
  setText("port-forward-editor-bind-label", "port_forward.editor.bind");
  setText("port-forward-editor-bind-port-label", "port_forward.editor.bind_port");
  setText("port-forward-editor-target-host-label", "port_forward.editor.target_host");
  setText("port-forward-editor-target-port-label", "port_forward.editor.target_port");
  setText("port-forward-editor-cancel", "port_forward.editor.cancel");
  setText("port-forward-editor-save", "port_forward.editor.save");
  if (portForwardEditorTitle) {
    portForwardEditorTitle.textContent = portForwardEditorMode === "create"
      ? t("port_forward.editor.title.create")
      : portForwardEditorTitle.textContent;
  }
  syncPortForwardEditorKind();
  renderPortForwardRows();
  setAttr("terminal-sidebar-metrics-toggle", "title", "metrics.title");
  setAttr("terminal-sidebar-metrics-toggle", "aria-label", "metrics.title");
  setText("terminal-metrics-title", "metrics.title");
  setText("terminal-metrics-subtitle", "metrics.subtitle");
  setAttr("terminal-metrics-refresh", "title", "metrics.refresh");
  setAttr("terminal-sidebar-sftp-toggle", "title", "terminal_sftp.title");
  setAttr("terminal-sidebar-sftp-toggle", "aria-label", "terminal_sftp.title");
  setText("terminal-sftp-title", "terminal_sftp.title");
  setText("terminal-sftp-subtitle", "terminal_sftp.subtitle");
  setAttr("terminal-sftp-refresh", "title", "metrics.refresh");
  setAttr("terminal-sftp-pin", "title", "terminal_sftp.pin");
  setAttr("lock-button", "title", "sidebar.lock");
  setAttr("window-minimize", "title", "window.minimize");
  setAttr("window-close", "title", "window.close");
  setWindowMaximizeButtonState(windowIsMaximized);

  setPlaceholder("host-search", "hosts.search.placeholder");
  setAttr("add-host-button", "title", "hosts.new_host");
  setAttr("add-group-button", "title", "hosts.new_group");
  setText("hosts-empty-title", "hosts.empty.title");
  setText("hosts-empty-desc", "hosts.empty.default");
  setText("hosts-empty-add", "hosts.new_host");

  setPlaceholder("sftp-left-path-input", "sftp.path.placeholder");
  setPlaceholder("sftp-right-path-input", "sftp.path.placeholder");
  setText("sftp-left-filter-label", "sftp.button.filter");
  setText("sftp-right-filter-label", "sftp.button.filter");
  setText("sftp-terminal-filter-label", "sftp.button.filter");
  setPlaceholder("sftp-left-filter-input", "sftp.filter.placeholder");
  setPlaceholder("sftp-right-filter-input", "sftp.filter.placeholder");
  setPlaceholder("sftp-terminal-filter-input", "sftp.filter.placeholder");
  setText("sftp-right-empty-title", "sftp.empty.connect_title");
  setText("sftp-right-empty-desc", "sftp.empty.connect_desc");
  setText("files-menu-open", "files.menu.open");
  setText("files-menu-open-with", "files.menu.open_with");
  setText("files-menu-copy", "files.menu.copy_to_target");
  setText("files-menu-refresh", "files.button.refresh");
  setText("files-menu-mkdir", "files.button.new_folder");
  setText("files-menu-new-file", "files.button.new_file");
  setText("files-menu-upload", "files.button.upload");
  setText("files-menu-hidden", "files.menu.show_hidden");
  setText("files-menu-permissions", "files.menu.permissions");
  setText("files-menu-select-all", "files.menu.select_all");
  setText("files-menu-edit", "files.menu.edit");
  setText("files-menu-download", "files.menu.download");
  setText("files-menu-rename", "files.menu.rename");
  setText("files-menu-delete", "files.menu.delete");
  setText("files-menu-close", "files.menu.close");

  setText("hk-reject", "host_key.reject");
  setText("hk-accept-once", "host_key.accept_once");
  setText("hk-accept", "host_key.accept");
  setText("hk-title", "host_key.title");

  setText("hf-name-label", "host_editor.label.name");
  setText("hf-user-label", "host_editor.label.user");
  setText("hf-host-label", "host_editor.label.host");
  setText("hf-port-label", "host_editor.label.port");
  setText("hf-auth-label", "host_editor.label.auth");
  setText("hf-group-label", "common.group");
  setText("hf-password-label", "host_editor.label.password");
  setText("hf-key-label", "host_editor.label.private_key");
  setText("hf-key-passphrase-label", "host_editor.label.passphrase");
  setText("hf-jump-label", "host_editor.label.proxy_jump");
  setText("hf-advanced-legend", "host_editor.label.advanced");
  setText("hf-key-pick", "host_editor.button.choose_key");
  setText("host-edit-cancel", "host_editor.button.cancel");
  setText("host-edit-save", "host_editor.button.save");
  setText("host-edit-title", editingHostId ? "host_editor.title.edit" : "host_editor.title.add");
  if (!hfKeyPem) {
    setText("hf-key-status", editingHostId ? "host_editor.key.existing" : "host_editor.key.none");
  }
  setText("quick-connect-title", "quick_connect.title");
  setText("qc-user-label", "quick_connect.user");
  setText("qc-host-label", "quick_connect.host");
  setText("qc-port-label", "quick_connect.port");
  setText("qc-auth-label", "quick_connect.auth");
  setOptionText("qc-auth-type", "password", "quick_connect.auth.password");
  setOptionText("qc-auth-type", "key", "quick_connect.auth.key");
  setOptionText("qc-auth-type", "agent", "quick_connect.auth.agent");
  syncCustomSelect("qc-auth-type");
  setText("qc-password-label", "quick_connect.password");
  setText("qc-key-label", "quick_connect.key");
  setText("qc-key-passphrase-label", "quick_connect.key_passphrase");
  setText("qc-key-pick", "quick_connect.key.pick");
  setText("qc-key-status", "quick_connect.key.none");
  setText("quick-connect-cancel", "quick_connect.cancel");
  setText("quick-connect-submit", "quick_connect.connect");
  setText("hosts-menu-connect", "hosts.menu.connect");
  setText("hosts-menu-edit", "hosts.menu.edit");
  setText("hosts-menu-copy", "hosts.menu.copy");
  setText("hosts-menu-delete", "hosts.menu.delete");
  setText("groups-menu-add-host", "groups.menu.add_host");
  setText("groups-menu-add-sub", "groups.menu.add_subgroup");
  setText("groups-menu-expand", "groups.menu.expand");
  setText("groups-menu-expand-all", "groups.menu.expand_all");
  setText("groups-menu-collapse", "groups.menu.collapse");
  setText("groups-menu-collapse-all", "groups.menu.collapse_all");
  setText("groups-menu-edit", "groups.menu.edit");
  setText("groups-menu-delete", "groups.menu.delete");
  setPlaceholder("hf-host", "host_editor.placeholder.host");
  setOptionText("hf-auth-type", "password", "host_editor.auth.password");
  setOptionText("hf-auth-type", "key", "host_editor.auth.key");
  setOptionText("hf-auth-type", "agent", "host_editor.auth.agent");
  syncCustomSelect("hf-auth-type");

  setText("terminal-snippets-title", "snippets.title");
  setText("terminal-snippets-subtitle", "snippets.subtitle");
  setText("terminal-snippets-empty-title", "snippets.empty.title");
  setText("terminal-snippets-empty-desc", "snippets.empty.desc");
  setAttr("terminal-snippets-add", "title", "snippets.add");
  setAttr("terminal-sidebar-snippets-toggle", "title", "snippets.title");
  setAttr("terminal-sidebar-snippets-toggle", "aria-label", "snippets.title");
  setPlaceholder("terminal-snippets-search", "snippets.search.placeholder");
  setText("snippet-group-menu-add", "snippets.menu.add");
  setText("snippet-group-menu-edit", "snippets.menu.edit_group");
  setText("snippet-group-menu-delete", "snippets.menu.delete_group");
  setText("snippet-item-menu-edit", "snippets.menu.edit");
  setText("snippet-item-menu-delete", "snippets.menu.delete");
  setText("snippet-edit-title", "snippets.dialog.title");
  setText("snippet-edit-name-label", "snippets.dialog.name");
  setText("snippet-edit-group-label", "snippets.dialog.group");
  setText("snippet-edit-command-label", "snippets.dialog.command");
  setText("snippet-edit-cancel", "snippets.dialog.cancel");
  setText("snippet-edit-save", "snippets.dialog.save");
  setPlaceholder("snippet-edit-name", "snippets.dialog.name_placeholder");
  setPlaceholder("snippet-edit-command", "snippets.dialog.command_placeholder");
  if (snippetEditGroup) syncSnippetGroupSelectOptions(snippetEditGroup.value || defaultSnippetGroupLabel());
  renderTerminalCommandSnippets();

  setPlaceholder("file-editor-find", "editor.find.placeholder");
  setPlaceholder("file-editor-replace", "editor.replace.placeholder");
  setPlaceholder("file-editor-find-inline", "editor.find.placeholder");
  setPlaceholder("file-editor-replace-inline", "editor.replace.placeholder");
  setText("editor-match-case-label", "editor.match_case");
  setText("file-editor-find-prev", "editor.button.prev");
  setText("file-editor-find-next", "editor.button.next");
  setText("file-editor-replace-one", "editor.button.replace");
  setText("file-editor-replace-all", "editor.button.replace_all");
  setText("file-editor-inline-close", "editor.button.close_inline");
  setText("file-editor-cancel", "editor.button.close");
  setText("file-editor-save", "editor.button.save");
  setText("theme-menu-edit", "theme.menu.edit");
  setText("theme-menu-duplicate", "theme.menu.duplicate");
  setText("theme-menu-delete", "theme.menu.delete");
  setAttr("theme-mode-button", "title", "theme.mode.button");
  setAttr("theme-mode-button", "aria-label", "theme.mode.button");
  setText("theme-mode-system", "theme.mode.system");
  setText("theme-mode-dark", "theme.mode.dark");
  setText("theme-mode-light", "theme.mode.light");
  setText("theme-edit-title", "theme.edit.title");
  setText("theme-edit-name-label", "theme.edit.name");
  setText("theme-edit-bg-label", "theme.edit.background");
  setText("theme-edit-fg-label", "theme.edit.foreground");
  setText("theme-edit-cursor-label", "theme.edit.cursor");
  setText("theme-edit-selection-label", "theme.edit.selection");
  setText("theme-edit-reset", "theme.edit.reset");
  setText("theme-edit-cancel", "theme.edit.cancel");
  setText("theme-edit-save", "theme.edit.save");
  applyAppTheme();

  setText("settings-title", "settings.title");
  setText("settings-general-title", "settings.general.title");
  setText("settings-general-desc", "settings.general.desc");
  setText("settings-nav-pref", "settings.nav.pref");
  setText("settings-nav-general", "settings.nav.general");
  setText("settings-nav-terminal", "settings.nav.terminal");
  setText("settings-nav-ai", "settings.nav.ai");
  setText("settings-nav-sync", "settings.nav.sync");
  setText("settings-nav-data", "settings.nav.data");
  setText("settings-nav-about", "settings.nav.about");
  setText("settings-general-subtab-basic", "settings.general.subtab.basic");
  setText("settings-general-subtab-sftp", "settings.general.subtab.sftp");
  setText("settings-proxy-label", "settings.proxy.label");
  setText("settings-proxy-hint", "settings.proxy.hint");
  setText("settings-proxy-url-label", "settings.proxy.url_label");
  setText("settings-proxy-note", "settings.proxy.note");
  setText("settings-proxy-save", "settings.proxy.save");
  setText("settings-proxy-clear", "settings.proxy.clear");
  setPlaceholder("settings-proxy-url", "settings.proxy.placeholder");
  setText("settings-bg-label", "settings.bg.label");
  setText("settings-bg-hint", "settings.bg.hint");
  setText("settings-bg-preview-empty", "settings.bg.empty");
  setText("settings-bg-choose", "settings.bg.choose");
  setText("settings-bg-clear", "settings.bg.remove");
  setText("settings-bg-opacity-label", "settings.bg.opacity");
  setText("settings-bg-blur-label", "settings.bg.blur");
  setText("settings-winsize-label", "settings.winsize.label");
  setText("settings-winsize-hint", "settings.winsize.hint");
  setText("settings-winsize-save", "settings.winsize.save");
  setText("settings-winsize-reset", "settings.winsize.reset");
  // The "current layout" line is locale-dependent — re-render it in the new language.
  syncWindowLayoutSettingsUI();

  // --- AI Assistant panel -------------------------------------------------
  setText("ai-assistant-title", "ai.assistant.title");
  setText("ai-assistant-subtitle", "ai.assistant.subtitle");
  setText("ai-hero-kicker", "ai.hero.kicker");
  setText("ai-hero-title", "ai.hero.title");
  setText("ai-hero-desc", "ai.hero.desc");
  setText("ai-step-1-title", "ai.step.1.title");
  setText("ai-step-1-desc", "ai.step.1.desc");
  setText("ai-step-2-title", "ai.step.2.title");
  setText("ai-step-2-desc", "ai.step.2.desc");
  setText("ai-step-3-title", "ai.step.3.title");
  setText("ai-step-3-desc", "ai.step.3.desc");
  setText("ai-examples-title", "ai.examples.title");
  setText("ai-example-1", "ai.example.1");
  setText("ai-example-2", "ai.example.2");
  setText("ai-example-3", "ai.example.3");
  setText("ai-example-4", "ai.example.4");
  setText("ai-compose-hint", "ai.compose.hint");
  setPlaceholder("ai-compose-input", "ai.compose.placeholder");
  setAttr("terminal-selection-menu-url", "aria-label", "terminal.selection.open_url");
  setAttr("terminal-selection-menu-url", "title", "terminal.selection.open_url");
  setAttr("terminal-selection-menu-search", "aria-label", "terminal.selection.search");
  setAttr("terminal-selection-menu-search", "title", "terminal.selection.search");
  setText("terminal-selection-menu-url-label", "terminal.selection.open");
  setText("terminal-selection-menu-copy-label", "terminal.selection.copy");
  setText("terminal-selection-menu-execute-label", "terminal.selection.execute");
  setText("terminal-selection-menu-sftp-label", "terminal.selection.sftp");
  setText("terminal-selection-menu-ai-label", "terminal.selection.ai");
  setAttr("ai-context-toggle", "title", "ai.context.toggle.title");
  setText("ai-session-dialog-title", "ai.session.title");
  setText("ai-session-close", "ai.session.close");
  setText("ai-session-current-filter", "ai.session.filter.current");
  setText("ai-session-all-filter", "ai.session.filter.all");
  setAttr("ai-session-filter", "aria-label", "ai.session.filter.aria");
  setAttr("ai-temp-chat", "title", "ai.session.temp_button");
  setAttr("ai-temp-chat", "aria-label", "ai.session.temp_button");
  setAttr("ai-new-chat", "title", "ai.session.new_title");
  setAttr("ai-new-chat", "aria-label", "ai.session.new_title");
  if (terminalSidebarAiToggle) {
    const aiToggleLabel = terminalActiveSidePanel === "ai" ? t("ai.panel.collapse") : t("ai.panel.expand");
    terminalSidebarAiToggle.title = aiToggleLabel;
    terminalSidebarAiToggle.setAttribute("aria-label", aiToggleLabel);
  }
  renderAiSessions();
  syncAiContextToggle();
  setAttr("ai-model-pill", "title", "ai.model.pill_title");
  // The aria-labels on the panel sections / send button.
  const aiPanel = document.querySelector(".ai-assistant-panel");
  if (aiPanel) aiPanel.setAttribute("aria-label", t("ai.panel.aria"));
  const aiWorkflow = document.querySelector(".ai-process-card");
  if (aiWorkflow) aiWorkflow.setAttribute("aria-label", t("ai.workflow.aria"));
  const aiExamples = document.querySelector(".ai-examples");
  if (aiExamples) aiExamples.setAttribute("aria-label", t("ai.examples.aria"));
  const aiSendBtn = document.querySelector(".ai-send-button");
  if (aiSendBtn) aiSendBtn.setAttribute("aria-label", t("ai.compose.send"));
  // Refresh the model pill so its "未配置模型" / "No model configured"
  // fallback follows the current language.
  if (typeof syncAiModelPill === "function") syncAiModelPill();
  setText("settings-terminal-subtab-theme", "settings.terminal.subtab.theme");
  setText("settings-terminal-subtab-font", "settings.terminal.subtab.font");
  setText("settings-terminal-shell-label", "settings.terminal.shell.label");
  setText("settings-terminal-shell-hint", "settings.terminal.shell.hint");
  setText("settings-terminal-shell-browse", "settings.terminal.shell.browse");
  setText("settings-terminal-shell-reset", "settings.terminal.shell.reset");
  setText("settings-terminal-cwd-label", "settings.terminal.cwd.label");
  setText("settings-terminal-cwd-hint", "settings.terminal.cwd.hint");
  setText("settings-terminal-cwd-browse", "settings.terminal.cwd.browse");
  setPlaceholder("settings-terminal-cwd", "settings.terminal.cwd.placeholder");
  setText("settings-terminal-selection-menu-order-label", "settings.terminal.selection_menu_order.label");
  setText("settings-terminal-selection-menu-order-hint", "settings.terminal.selection_menu_order.hint");
  setText("settings-terminal-selection-menu-order-reset", "settings.terminal.selection_menu_order.reset");
  setText("settings-terminal-attention-flash-label", "settings.terminal.attention_flash.label");
  setText("settings-terminal-attention-flash-hint", "settings.terminal.attention_flash.hint");
  renderTerminalSelectionMenuOrderSettings();
  updateLocalShellCurrentHint();
  setText("settings-nav-sftp", "settings.nav.sftp");
  setText("settings-nav-hotkeys", "settings.nav.hotkeys");
  setText("settings-language-label", "settings.language.label");
  setText("settings-language-hint", "settings.language.hint");
  setText("settings-about-title", "settings.about.title");
  setText("settings-about-version-label", "settings.version.label");
  setText("settings-about-author-label", "settings.about.author");
  setText("settings-about-repo-label", "settings.about.repo");
  setText("settings-about-tagline", "settings.about.tagline");
  setText("settings-update-title", "settings.update.title");
  setText("settings-update-install", "settings.update.install");
  setText("update-dialog-title", "settings.update.dialog.title");
  setText("update-dialog-cancel", "settings.update.dialog.cancel");
  setText("update-dialog-confirm", "settings.update.dialog.confirm");
  // Note: settings-update-status is owned by refreshUpdateStatus() which
  // re-applies the localized message whenever the About section opens; we
  // don't reset it here to avoid stomping on a real "Update available" line.
  setText("settings-terminal-theme-title", "settings.terminal_theme.title");
  setText("terminal-theme-panel-title", "settings.terminal_theme.title");
  setText("terminal-theme-panel-subtitle", "settings.terminal_theme.subtitle");
  setAttr("terminal-sidebar-theme-toggle", "title", "settings.terminal_theme.title");
  setAttr("terminal-sidebar-theme-toggle", "aria-label", "settings.terminal_theme.title");
  renderTerminalThemeCards();
  setText("terminal-theme-light-title", "settings.terminal_theme.light_title");
  setText("terminal-theme-dark-title", "settings.terminal_theme.dark_title");
  setAttr("terminal-theme-add-light", "title", "theme.create.title");
  setAttr("terminal-theme-add-light", "aria-label", "theme.create.title");
  setAttr("terminal-theme-add-dark", "title", "theme.create.title");
  setAttr("terminal-theme-add-dark", "aria-label", "theme.create.title");
  setText("settings-terminal-theme-label", "settings.terminal_theme.label");
  setText("settings-terminal-font-title", "settings.terminal_font.title");
  setText("settings-terminal-font-hint", "settings.terminal_font.hint");
  setText("settings-terminal-font-family-label", "settings.terminal_font.family");
  setText("settings-terminal-font-size-label", "settings.terminal_font.size");
  setText("settings-terminal-line-height-label", "settings.terminal_font.line_height");
  setText("settings-ai-provider-title", "settings.ai.provider.title");
  setText("settings-ai-provider-desc", "settings.ai.provider.desc");
  syncAiModelPill();
  setText("settings-ai-provider-label", "settings.ai.provider.label");
  setText("settings-ai-model-label", "settings.ai.model.label");
  setText("settings-ai-model-custom-label", "settings.ai.model.custom_label");
  setText("settings-ai-refresh-models", "settings.ai.model.refresh");
  setText("settings-ai-base-url-label", "settings.ai.base_url.label");
  setText("settings-ai-api-key-label", "settings.ai.api_key.label");
  setText("settings-ai-status", "settings.ai.status.unsaved");
  setText("settings-ai-save", "settings.ai.button.save");
  setAttr("settings-ai-add", "title", "settings.ai.add");
  setAttr("settings-ai-add", "aria-label", "settings.ai.add");
  setText("settings-ai-name-label", "settings.ai.name.label");
  setText("settings-ai-cancel", "settings.ai.cancel");
  setText("settings-ai-empty", "settings.ai.empty");
  setPlaceholder("settings-ai-name", "settings.ai.name.placeholder");
  if (typeof renderAiProfileList === "function") renderAiProfileList();
  setPlaceholder("settings-ai-model", "settings.ai.model.placeholder");
  setPlaceholder("settings-ai-model-custom", "settings.ai.model.placeholder");
  setPlaceholder("settings-ai-base-url", "settings.ai.base_url.placeholder");
  setPlaceholder("settings-ai-api-key", "settings.ai.api_key.placeholder");
  setText("settings-ai-reasoning-effort-label", "settings.ai.reasoning_effort.label");
  setOptionText("settings-ai-reasoning-effort", "", "settings.ai.reasoning_effort.default");
  setOptionText("settings-ai-reasoning-effort", "low", "settings.ai.reasoning_effort.low");
  setOptionText("settings-ai-reasoning-effort", "medium", "settings.ai.reasoning_effort.medium");
  setOptionText("settings-ai-reasoning-effort", "high", "settings.ai.reasoning_effort.high");
  setOptionText("settings-ai-provider", "openai-compatible", "settings.ai.provider.openai_compatible");
  setOptionText("settings-ai-provider", "openai", "settings.ai.provider.openai");
  setOptionText("settings-ai-provider", "anthropic", "settings.ai.provider.anthropic");
  setOptionText("settings-ai-provider", "gemini", "settings.ai.provider.gemini");
  setOptionText("settings-ai-provider", "ollama", "settings.ai.provider.ollama");
  // Re-render the model dropdown so the "Custom model" placeholder option
  // picks up the new language (the dropdown is built dynamically and would
  // otherwise keep its previous-language label).
  if (typeof setAiModelOptions === "function" && settingsAiModel) {
    const existingModels = Array.from(settingsAiModel.options)
      .filter((o) => o.value)
      .map((o) => o.value);
    setAiModelOptions(existingModels, getAiModelValue());
  }
  syncCustomSelect("settings-ai-model");
  syncCustomSelect("settings-ai-provider");
  syncCustomSelect("settings-ai-reasoning-effort");
  setText("settings-sftp-title", "settings.sftp.title");
  setText("settings-sftp-follow-label", "settings.sftp.follow.label");
  setText("settings-sftp-follow-hint", "settings.sftp.follow.hint");
  setText("settings-sftp-local-dir-label", "settings.sftp.local_dir.label");
  setText("settings-sftp-local-dir-hint", "settings.sftp.local_dir.hint");
  setAttr("settings-sftp-local-dir", "placeholder", "settings.sftp.local_dir.placeholder");
  setText("settings-sftp-local-dir-browse", "settings.sftp.local_dir.browse");
  setText("settings-sync-title", "settings.sync.title");
  setText("settings-sync-method-title", "settings.sync.method");
  setText("settings-sync-tip", "settings.sync.tip.local");
  setText("settings-sync-root-label", "settings.sync.label.path");
  setText("settings-sync-webdav-url-label", "settings.sync.webdav.url");
  setText("settings-sync-webdav-root-label", "settings.sync.webdav.root_path");
  setText("settings-sync-webdav-user-label", "settings.sync.webdav.username");
  setText("settings-sync-webdav-pw-label", "settings.sync.webdav.password");
  setText("settings-sync-s3-region-label", "settings.sync.s3.region");
  setText("settings-sync-s3-bucket-label", "settings.sync.s3.bucket");
  setText("settings-sync-s3-prefix-label", "settings.sync.s3.prefix");
  setText("settings-sync-s3-endpoint-label", "settings.sync.s3.endpoint");
  setText("settings-sync-s3-path-style-label", "settings.sync.s3.path_style");
  setText("settings-sync-s3-ak-label", "settings.sync.s3.access_key_id");
  setText("settings-sync-s3-sk-label", "settings.sync.s3.secret_access_key");
  setText("settings-sync-s3-token-label", "settings.sync.s3.session_token");
  setText("settings-sync-enc-title", "settings.sync.enc.title");
  setText("settings-sync-status-title", "settings.sync.status.title");
  setText("settings-sync-devices-title", "settings.sync.devices.title");
  setText("settings-sync-conflicts-title", "settings.sync.conflicts.title");
  setText("settings-sync-bootstrap-hint", "settings.sync.bootstrap.hint");
  setText("settings-sync-save", "settings.sync.button.save");
  setText("settings-sync-root-browse", "settings.sync.button.browse");
  setText("settings-sync-now", "settings.sync.button.now");
  setText("settings-sync-create-repo", "settings.sync.button.create_repo");
  setText("settings-sync-join-repo", "settings.sync.button.join_repo");
  setText("settings-sync-forget-engine", "settings.sync.button.forget_engine");
  setText("settings-sync-clear-all", "settings.sync.button.clear_all");
  setText("settings-sync-delete-remote", "settings.sync.button.delete_remote");
  setText("settings-sync-remember-passphrase-label", "settings.sync.remember_passphrase");
  setText("settings-sync-webdav-pw-hint", "settings.sync.hint.keychain_keep");
  setText("settings-sync-enc-password-hint", "settings.sync.hint.keychain_keep");
  setText("settings-sync-devices-empty", "settings.sync.devices.empty");
  setText("settings-sync-conflicts-title", "settings.sync.conflicts.title");
  setText("settings-sync-conflicts-empty", "settings.sync.conflicts.empty");
  setText("settings-sync-repo-stats-title", "settings.sync.repo_stats.title");
  setText("settings-sync-repo-stats-empty", "settings.sync.repo_stats.empty");
  setText("settings-sync-refresh-stats", "settings.sync.button.refresh_stats");
  setText("settings-sync-compact-now", "settings.sync.button.compact_now");
  setText("settings-data-title", "settings.data.title");
  setText("settings-data-desc", "settings.data.desc");
  setText("settings-data-clear-open", "settings.data.button.clear");
  setText("settings-data-clear-title", "settings.data.dialog.title");
  setText("settings-data-clear-message", "settings.data.dialog.message");
  setText("settings-data-clear-warning", "settings.data.dialog.warning");
  setText("settings-data-clear-cancel", "input.button.cancel");
  setText("settings-data-clear-confirm", "settings.data.dialog.confirm");
  renderSettingsDataClearOptions();
  setOptionText("settings-sync-backend", "local_folder", "settings.sync.backend.local_folder");
  setOptionText("settings-sync-backend", "sftp", "settings.sync.backend.sftp");
  setOptionText("settings-sync-backend", "webdav", "settings.sync.backend.webdav");
  setOptionText("settings-sync-backend", "s3", "settings.sync.backend.s3");
  syncCustomSelect("settings-sync-backend");
  setText("settings-sync-host-ref-label", "settings.sync.sftp.host");
  setText("settings-sync-remote-dir-label", "settings.sync.sftp.remote_dir");
  setPlaceholder("settings-sync-webdav-pw", "settings.sync.webdav.password_placeholder");
  setPlaceholder("settings-sync-s3-sk", "settings.sync.s3.secret_access_key_placeholder");
  setPlaceholder("settings-sync-s3-token", "settings.sync.s3.session_token_placeholder");
  setPlaceholder("settings-sync-enc-password", "settings.sync.placeholder.enc_password");
  setOptionText("settings-language-select", "zh-CN", "settings.language.zh");
  setOptionText("settings-language-select", "en", "settings.language.en");
  syncCustomSelect("settings-language-select");
  if (settingsLanguageSelect) settingsLanguageSelect.value = currentLocale;
  if (textInputOverlay.hidden) {
    setText("text-input-title", "input.title");
  }
  setText("text-input-cancel", "input.button.cancel");
  setText("text-input-confirm", "input.button.confirm");
  setText("permissions-title", "files.permissions.title");
  setText("permissions-message", "files.prompt.permissions");
  setText("permissions-octal-label", "files.permissions.octal");
  setText("permissions-owner-title", "files.permissions.owner");
  setText("permissions-group-title", "files.permissions.group");
  setText("permissions-other-title", "files.permissions.other");
  setText("permissions-read-label", "files.permissions.read");
  setText("permissions-write-label", "files.permissions.write");
  setText("permissions-exec-label", "files.permissions.exec");
  setText("permissions-read-label-2", "files.permissions.read");
  setText("permissions-write-label-2", "files.permissions.write");
  setText("permissions-exec-label-2", "files.permissions.exec");
  setText("permissions-read-label-3", "files.permissions.read");
  setText("permissions-write-label-3", "files.permissions.write");
  setText("permissions-exec-label-3", "files.permissions.exec");
  setText("permissions-cancel", "input.button.cancel");
  setText("permissions-confirm", "input.button.confirm");
  setPlaceholder("text-input-value", "input.placeholder");

  if (!views.hosts.hidden) {
    renderHosts();
    syncSftpHostOptions();
    renderAllSftpPanes();
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
      fileEditorHint.textContent = fileEditorTextInfo(fileEditorGetValue());
    }
  }

  updateSftpConnectButtons();
}

hostSearch.addEventListener("input", () => renderHosts());
buildCustomSelect(document.getElementById("hf-auth-type"));
buildCustomSelect(document.getElementById("qc-auth-type"));
buildCustomSelect(document.getElementById("hf-group"));
buildCustomSelect(document.getElementById("hf-jump"));
buildCustomSelect(document.getElementById("settings-language-select"));
buildCustomSelect(document.getElementById("settings-ai-provider"));
buildCustomSelect(document.getElementById("settings-ai-model"));
buildCustomSelect(document.getElementById("settings-terminal-theme"));
buildCustomSelect(document.getElementById("settings-terminal-font-family"));
buildCustomSelect(document.getElementById("settings-sync-profile"));
buildCustomSelect(document.getElementById("settings-sync-backend"));
buildCustomSelect(document.getElementById("snippet-edit-group"));
installAiPanelResize();
syncAiContextToggle();
syncCustomSelect("settings-sync-backend");
buildCustomSelect(document.getElementById("sftp-left-host"));
buildCustomSelect(document.getElementById("sftp-right-host"));
workspaceTabVaults.addEventListener("click", () => setWorkspaceMode("vaults"));
workspaceTabSftp.addEventListener("click", () => setWorkspaceMode("sftp"));
workspaceNavVaults?.addEventListener("click", () => setWorkspaceMode("vaults"));
workspaceNavSftp?.addEventListener("click", () => setWorkspaceMode("sftp"));
portForwardButton?.addEventListener("click", () => setWorkspaceMode("port-forward"));
portForwardRefresh?.addEventListener("click", () => loadPortForwardPage().catch((e) => alert(String(e))));
portForwardSearch?.addEventListener("input", renderPortForwardRows);
portForwardCreate?.addEventListener("click", () => openPortForwardCreateEditor().catch((e) => alert(String(e))));
portForwardEditorHost?.addEventListener("change", () => {
  portForwardEditorHostId = portForwardEditorHost.value;
});
portForwardEditorClose?.addEventListener("click", closePortForwardEditor);
portForwardEditorCancel?.addEventListener("click", closePortForwardEditor);
portForwardEditorOverlay?.addEventListener("click", (ev) => {
  if (ev.target === portForwardEditorOverlay) closePortForwardEditor();
});
portForwardEditorKind?.addEventListener("change", syncPortForwardEditorKind);
portForwardEditorKindTabs?.addEventListener("click", (ev) => {
  const tab = ev.target.closest?.(".port-forward-kind-tab");
  if (!tab || !portForwardEditorKind) return;
  portForwardEditorKind.value = tab.dataset.kind || "local";
  portForwardEditorKind.dispatchEvent(new Event("change", { bubbles: true }));
});
portForwardEditorSave?.addEventListener("click", () => savePortForwardEditor());
workspaceSidebarToggle?.addEventListener("click", () => {
  setWorkspaceSidebarCollapsed(!workspaceSidebarCollapsed);
});
workspaceSidebarToggleRight?.addEventListener("click", () => {
  setWorkspaceSidebarCollapsed(!workspaceSidebarCollapsed);
});
terminalThemeAddLight?.addEventListener("click", () => openThemeCreateDialog(getResolvedAppTheme() === "light" ? "light" : "dark"));
terminalThemeAddDark?.addEventListener("click", () => openThemeCreateDialog("dark"));
document.getElementById("add-group-button")?.addEventListener("click", async () => {
  const name = await openTextInputDialog({
    title: t("groups.prompt.add.title"),
    message: t("groups.prompt.add.message"),
    placeholder: t("groups.prompt.add.placeholder"),
  });
  if (!name) return;
  try {
    const id = await invoke("create_host_group", { input: { name, parentId: null, sortOrder: 0 } });
    groupExpandedState[id] = true;
    saveGroupExpansionState();
    await reloadHostGroupsFromVault();
    autoSyncAfterDataChange();
    renderHosts();
  } catch (e) {
    alert(String(e));
  }
});

if (vaultSplitter) {
  vaultSplitter.addEventListener("mousedown", (ev) => {
    if (workspaceSidebarCollapsed) return;
    if (ev.button !== 0) return;
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = vaultSidebarWidth;
    appShell?.classList.add("resizing-sidebar");

    const onMove = (moveEv) => {
      const delta = moveEv.clientX - startX;
      applyVaultSidebarWidth(startWidth + delta);
      const activeTab = getActiveTab();
      if (activeTab?.panes?.length) {
        for (const pane of activeTab.panes) {
          requestPaneFit(pane);
        }
      }
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      appShell?.classList.remove("resizing-sidebar");
      const activeTab = getActiveTab();
      if (activeTab?.panes?.length) {
        requestAnimationFrame(() => {
          for (const pane of activeTab.panes) {
            requestPaneFit(pane, { immediate: true });
          }
        });
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

// Restore saved startup sidebar widths (the window size is restored by the
// Rust setup hook). Left updates the tracked vaultSidebarWidth var; right only
// sets the CSS var when a value was saved, otherwise the responsive CSS
// default stands. localStorage is synchronous, so this applies before paint.
const savedLeftWidth = getSavedSidebarWidth(SETTINGS_KEY_SIDEBAR_LEFT, VAULT_SIDEBAR_MIN, VAULT_SIDEBAR_MAX);
if (savedLeftWidth != null) vaultSidebarWidth = savedLeftWidth;
applyVaultSidebarWidth(vaultSidebarWidth);
const savedRightWidth = getSavedSidebarWidth(SETTINGS_KEY_SIDEBAR_RIGHT, AI_PANEL_MIN, AI_PANEL_MAX);
if (savedRightWidth != null) applyAiPanelWidth(savedRightWidth);
setWorkspaceSidebarCollapsed(false);

document.getElementById("lock-button").addEventListener("click", async () => {
  stopAutoSync();
  for (const pane of Object.values(sftpPanes)) {
    await disconnectSftpPane(pane);
  }
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
hostsEmptyAdd?.addEventListener("click", () => openHostEditor());
hostsMenuConnect?.addEventListener("click", () => {
  const host = hostsCache.find((h) => h.id === hostsContextHostId);
  hideHostsContextMenu();
  if (!host) return;
  openHostInTerminal(host);
});
hostsMenuEdit?.addEventListener("click", () => {
  const id = hostsContextHostId;
  hideHostsContextMenu();
  if (!id) return;
  openHostEditor(id);
});
hostsMenuCopy?.addEventListener("click", async () => {
  const host = hostsCache.find((h) => h.id === hostsContextHostId);
  hideHostsContextMenu();
  if (!host) return;
  const text = `${host.user}@${host.host}:${host.port}`;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await openTextInputDialog({
      title: t("hosts.copy.title"),
      message: t("hosts.copy.message"),
      defaultValue: text,
      placeholder: "",
    });
  }
});
hostsMenuDelete?.addEventListener("click", async () => {
  const host = hostsCache.find((h) => h.id === hostsContextHostId);
  hideHostsContextMenu();
  if (!host) return;
  if (!confirm(t("hosts.confirm.delete_one", { name: host.name }))) return;
  try {
    await invoke("delete_host", { id: host.id });
    autoSyncAfterDataChange();
    await enterHosts();
  } catch (e) {
    alert(t("hosts.error.delete_failed", { error: e }));
  }
});

groupsMenuAddHost?.addEventListener("click", () => {
  const groupId = groupsContextGroupId;
  hideGroupsContextMenu();
  openHostEditor(null, groupId || "");
});

groupsMenuAddSub?.addEventListener("click", async () => {
  const parentId = groupsContextGroupId;
  hideGroupsContextMenu();
  if (!parentId) return;
  const parent = hostGroups.find((g) => g.id === parentId);
  if (!parent) return;
  const name = await openTextInputDialog({
    title: t("groups.prompt.add_sub.title"),
    message: t("groups.prompt.add_sub.message", { name: parent.name }),
    placeholder: t("groups.prompt.add_sub.placeholder"),
  });
  if (!name) return;
  try {
    const id = await invoke("create_host_group", { input: { name, parentId, sortOrder: 0 } });
    groupExpandedState[parentId] = true;
    groupExpandedState[id] = true;
    saveGroupExpansionState();
    await reloadHostGroupsFromVault();
    autoSyncAfterDataChange();
    renderHosts();
  } catch (e) {
    alert(String(e));
  }
});

groupsMenuExpand?.addEventListener("click", () => {
  if (!groupsContextGroupId) return;
  groupExpandedState[groupsContextGroupId] = true;
  saveGroupExpansionState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuExpandAll?.addEventListener("click", () => {
  for (const g of hostGroups) groupExpandedState[g.id] = true;
  saveGroupExpansionState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuCollapse?.addEventListener("click", () => {
  if (!groupsContextGroupId) return;
  groupExpandedState[groupsContextGroupId] = false;
  saveGroupExpansionState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuCollapseAll?.addEventListener("click", () => {
  for (const g of hostGroups) groupExpandedState[g.id] = false;
  saveGroupExpansionState();
  hideGroupsContextMenu();
  renderHosts();
});

  groupsMenuEdit?.addEventListener("click", async () => {
  const group = hostGroups.find((g) => g.id === groupsContextGroupId);
  hideGroupsContextMenu();
  if (!group) return;
  const name = await openTextInputDialog({
    title: t("groups.menu.edit"),
    message: t("groups.menu.edit") + "：",
    defaultValue: group.name,
  });
  if (!name) return;
  try {
    await invoke("update_host_group", {
      id: group.id,
      input: { name, parentId: group.parentId || null, sortOrder: group.sortOrder || 0 },
    });
    await reloadHostGroupsFromVault();
    autoSyncAfterDataChange();
    renderHosts();
  } catch (e) {
    alert(String(e));
  }
});

groupsMenuDelete?.addEventListener("click", async () => {
  const groupId = groupsContextGroupId;
  const group = hostGroups.find((g) => g.id === groupId);
  hideGroupsContextMenu();
  if (!group) return;
  if (!confirm(t("groups.confirm.delete", { name: group.name }))) return;
  // Collect descendants so we can delete the whole subtree. Member
  // hosts (and any "stranger" children that were never resolved here
  // because their parent was tombstoned on another device) are left
  // alone — they'll render as Ungrouped / root via the fallback path.
  const toDelete = new Set([groupId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of hostGroups) {
      if (toDelete.has(g.id)) continue;
      if (toDelete.has(g.parentId || "")) {
        toDelete.add(g.id);
        changed = true;
      }
    }
  }
  try {
    for (const gid of toDelete) {
      await invoke("delete_host_group", { id: gid });
    }
  } catch (e) {
    alert(String(e));
  }
  for (const gid of toDelete) {
    delete groupExpandedState[gid];
  }
  saveGroupExpansionState();
  await reloadHostGroupsFromVault();
  autoSyncAfterDataChange();
  renderHosts();
});

// FE-8: last-resort logging for promise rejections that nothing else handled,
// so failures in fire-and-forget async work don't vanish silently.
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event?.reason);
});

window.addEventListener("click", () => hideHostsContextMenu());
window.addEventListener("click", () => hideGroupsContextMenu());
window.addEventListener("click", () => hideThemeModeMenu());
window.addEventListener("blur", () => hideHostsContextMenu());
window.addEventListener("blur", () => hideGroupsContextMenu());
window.addEventListener("keydown", handleGlobalTerminalFindShortcut, true);
window.addEventListener("keydown", handleGlobalTerminalFindNav, true);
settingsButton.addEventListener("click", openSettingsPage);
quickConnectButton?.addEventListener("click", openQuickConnectOverlay);
localTerminalButton?.addEventListener("click", () => {
  openLocalTerminalInTab().catch((e) => alert(String(e)));
});
vaultBottomSettingsButton?.addEventListener("click", openSettingsPage);
themeModeButton?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  toggleThemeModeMenu(themeModeButton);
});
themeModeSystem?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setAppThemeMode("system");
  hideThemeModeMenu();
});
themeModeDark?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setAppThemeMode("dark");
  hideThemeModeMenu();
});
themeModeLight?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setAppThemeMode("light");
  hideThemeModeMenu();
});
settingsBackButton?.addEventListener("click", () => setWorkspaceMode("vaults"));
settingsNavGeneral?.addEventListener("click", () => setSettingsSection("general"));
settingsNavTerminal?.addEventListener("click", () => setSettingsSection("terminal"));
settingsNavAi?.addEventListener("click", () => setSettingsSection("ai"));
settingsNavSync?.addEventListener("click", () => setSettingsSection("sync"));
settingsNavData?.addEventListener("click", () => setSettingsSection("data"));
settingsNavAbout?.addEventListener("click", () => setSettingsSection("about"));
settingsAiSave?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsAiSave, t("settings.sync.button.busy.save"), async () => {
    try {
      await saveAiProfileFromForm();
      showToast(t("settings.ai.status.saved"), "success");
    } catch (e) {
      const msg = String(e);
      if (settingsAiStatus) settingsAiStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});
settingsAiAdd?.addEventListener("click", () => startNewAiProfile());
if (settingsAiSystemPrompt) {
  settingsAiSystemPrompt.value = getAiGlobalSystemPrompt();
  settingsAiSystemPrompt.addEventListener("input", () => {
    try {
      localStorage.setItem(SETTINGS_KEY_AI_SYSTEM_PROMPT, settingsAiSystemPrompt.value);
    } catch (e) {}
  });
}
settingsAiCancel?.addEventListener("click", () => cancelAiEditor());
aiConfigOverlay?.addEventListener("click", (ev) => {
  if (ev.target === aiConfigOverlay) cancelAiEditor();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && aiConfigOverlay && !aiConfigOverlay.hidden) {
    ev.stopPropagation();
    cancelAiEditor();
  }
}, true);
settingsAiRefreshModels?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsAiRefreshModels, t("settings.ai.button.busy.refresh"), async () => {
    try {
      await refreshAiModels();
      showToast(t("settings.ai.toast.models_refreshed"), "success");
    } catch (e) {
      const msg = String(e);
      if (settingsAiStatus) settingsAiStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});
aiModelPill?.addEventListener("click", (ev) => {
  ev.stopPropagation();
  setAiModelMenuOpen(aiModelMenu?.hidden !== false);
});
aiModelMenu?.addEventListener("click", (ev) => ev.stopPropagation());
document.addEventListener("click", () => setAiModelMenuOpen(false));
settingsDataClearOpen?.addEventListener("click", () => setSettingsDataClearDialogOpen(true));
settingsDataClearCancel?.addEventListener("click", () => setSettingsDataClearDialogOpen(false));
settingsDataClearOverlay?.addEventListener("click", (ev) => {
  if (ev.target === settingsDataClearOverlay) setSettingsDataClearDialogOpen(false);
});
settingsDataClearConfirm?.addEventListener("click", async () => {
  const selected = getSelectedSettingsDataClearItems();
  if (!selected.length) {
    showToast(t("settings.data.dialog.none"), "error", 2200);
    return;
  }
  setSettingsDataClearDialogOpen(false);
  await runSyncButtonAction(settingsDataClearOpen, t("settings.data.dialog.confirm"), async () => {
    try {
      await clearSelectedSettingsData(selected);
      const labels = selected.map(getSettingsDataClearItemLabel).join(", ");
      const message = t("settings.data.status.cleared_selected", { items: labels });
      if (settingsDataStatus) settingsDataStatus.textContent = message;
      showToast(message, "success", 2600);
    } catch (e) {
      const msg = String(e);
      if (settingsDataStatus) settingsDataStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});
function openUpdateDialog() {
  if (!updateDialogOverlay) return;
  const info = latestUpdateInfo;
  if (updateDialogVersion) {
    updateDialogVersion.textContent = info?.version
      ? t("settings.update.dialog.version", { version: info.version })
      : "";
  }
  if (updateDialogNotes) {
    const notes = String(info?.notes || "").trim();
    updateDialogNotes.textContent = "";
    if (notes) {
      updateDialogNotes.appendChild(renderAiMarkdown(notes));
    } else {
      updateDialogNotes.textContent = t("settings.update.dialog.no_notes");
    }
  }
  if (updateDialogConfirm) updateDialogConfirm.disabled = false;
  updateDialogOverlay.hidden = false;
}

function closeUpdateDialog() {
  if (updateDialogOverlay) updateDialogOverlay.hidden = true;
}

settingsUpdateInstall?.addEventListener("click", () => {
  openUpdateDialog();
});

updateDialogCancel?.addEventListener("click", closeUpdateDialog);
updateDialogOverlay?.addEventListener("click", (ev) => {
  if (ev.target === updateDialogOverlay) closeUpdateDialog();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && updateDialogOverlay && !updateDialogOverlay.hidden) {
    ev.stopPropagation();
    closeUpdateDialog();
  }
});

updateDialogConfirm?.addEventListener("click", async () => {
  await runSyncButtonAction(updateDialogConfirm, t("settings.update.status.installing"), async () => {
    try {
      if (settingsUpdateStatus) settingsUpdateStatus.textContent = t("settings.update.status.installing");
      await invoke("install_update");
    } catch (e) {
      // The Rust side maps the common "release manifest signature is a
      // placeholder" base64 decode error to this sentinel — translate it
      // into a friendly localized message instead of the raw error.
      const raw = String(e);
      const friendly = raw.includes("update_signature_invalid")
        ? t("settings.update.signature_invalid")
        : t("settings.update.failed", { error: raw });
      if (settingsUpdateStatus) settingsUpdateStatus.textContent = friendly;
      showToast(friendly, "error", 4200);
      closeUpdateDialog();
    }
  });
});
settingsGeneralSubtabBasic?.addEventListener("click", () => setSettingsGeneralSubtab("basic"));
settingsGeneralSubtabSftp?.addEventListener("click", () => setSettingsGeneralSubtab("sftp"));
settingsTerminalSubtabTheme?.addEventListener("click", () => setSettingsTerminalSubtab("theme"));
settingsTerminalSubtabFont?.addEventListener("click", () => setSettingsTerminalSubtab("font"));

settingsBgChoose?.addEventListener("click", () => {
  chooseBackgroundImage().catch((e) => console.warn("choose background failed", e));
});
settingsBgClear?.addEventListener("click", () => {
  clearBackgroundImage().catch((e) => console.warn("clear background failed", e));
});
settingsBgOpacity?.addEventListener("input", () => {
  localStorage.setItem(SETTINGS_KEY_APP_BG_OPACITY, String(settingsBgOpacity.value));
  applyAppBackground();
});
settingsBgBlur?.addEventListener("input", () => {
  localStorage.setItem(SETTINGS_KEY_APP_BG_BLUR, String(settingsBgBlur.value));
  applyAppBackground();
});
settingsWinsizeSave?.addEventListener("click", () => {
  recordWindowLayout().catch((e) => console.warn("save window layout failed", e));
});
settingsWinsizeReset?.addEventListener("click", () => {
  resetWindowLayout().catch((e) => console.warn("reset window layout failed", e));
});
vaultBottomSettingsRow?.addEventListener("click", (ev) => {
  if (ev.target?.closest?.("#vault-bottom-settings") || ev.target?.closest?.("#theme-mode-button")) return;
  openSettingsPage();
});
vaultBottomSettingsRow?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" && ev.key !== " ") return;
  ev.preventDefault();
  openSettingsPage();
});
settingsLanguageSelect.addEventListener("change", () => {
  setLocale(settingsLanguageSelect.value);
});
settingsProxySave?.addEventListener("click", async () => {
  settingsProxySave.disabled = true;
  if (settingsProxyClear) settingsProxyClear.disabled = true;
  try {
    await saveNetworkProxyConfigFromForm();
  } catch (e) {
    if (settingsProxyStatus) {
      settingsProxyStatus.textContent = t("settings.proxy.status.failed", { error: String(e) });
    }
  } finally {
    settingsProxySave.disabled = false;
    if (settingsProxyClear) settingsProxyClear.disabled = false;
  }
});
settingsProxyClear?.addEventListener("click", async () => {
  settingsProxySave && (settingsProxySave.disabled = true);
  settingsProxyClear.disabled = true;
  try {
    await clearNetworkProxyConfigFromForm();
  } catch (e) {
    if (settingsProxyStatus) {
      settingsProxyStatus.textContent = t("settings.proxy.status.failed", { error: String(e) });
    }
  } finally {
    settingsProxySave && (settingsProxySave.disabled = false);
    settingsProxyClear.disabled = false;
  }
});
settingsSyncBackend?.addEventListener("change", () => {
  syncFormToggleBackendFields(settingsSyncBackend.value || "local_folder");
  if (settingsSyncBackend.value === "sftp") {
    refreshSftpHostOptions(settingsSyncHostRef?.value || "");
  }
});

settingsSyncRootBrowse?.addEventListener("click", async () => {
  try {
    const picked = await invoke("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        title: t("settings.sync.button.browse"),
      },
    });
    const resolved = Array.isArray(picked) ? picked[0] : picked;
    if (!resolved || typeof resolved !== "string") return;
    if (settingsSyncRoot) settingsSyncRoot.value = resolved;
  } catch (e) {
    if (settingsSyncStatus) settingsSyncStatus.textContent = String(e);
  }
});

settingsSyncSave?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncSave, t("settings.sync.button.busy.save"), async () => {
    try {
    const input = syncFormToInput();
    if (input.backend === "local_folder" && !input.root) {
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.root_required");
      return;
    }
    if (input.backend === "sftp") {
      if (!input.hostRef) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.host_required");
        return;
      }
      if (!input.remoteDir) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.remote_dir_required");
        return;
      }
    }
    if (input.backend === "webdav") {
      if (!input.url) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.webdav_url_required");
        return;
      }
      if (!input.username) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.webdav_user_required");
        return;
      }
    }
    if (input.backend === "s3") {
      if (!input.region) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.s3_region_required");
        return;
      }
      if (!input.bucket) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.s3_bucket_required");
        return;
      }
      if (!input.accessKeyId) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.s3_ak_required");
        return;
      }
    }
    const existingId = syncSingleProfileId || syncEditingId;
    if (existingId) {
      await invoke("update_sync_profile", { id: existingId, input });
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.updated");
    } else {
      const id = await invoke("save_sync_profile", { input });
      syncEditingId = id;
      syncSingleProfileId = id;
      if (id) localStorage.setItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE, id);
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.saved");
    }
    await loadSyncProfiles();
    showToast(settingsSyncStatus?.textContent || t("settings.sync.status.saved"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncCreateRepo?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncCreateRepo, t("settings.sync.button.busy.create_repo"), async () => {
    try {
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.creating_repo");
      const id = await ensureSyncProfileReadyForActions();
      const passphrase = String(settingsSyncEncPassword?.value || "");
      if (!passphrase) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.passphrase_required");
        return;
      }
      const rememberPassphrase = Boolean(settingsSyncRememberPassphrase?.checked);
      const r = await invoke("sync_create_repo", { profileId: id, passphrase, rememberPassphrase });
      if (settingsSyncStatus) {
        settingsSyncStatus.textContent = t("settings.sync.status.repo_created_seeded", {
          count: Number(r?.seededRecords ?? 0),
        });
      }
      showToast(t("settings.sync.alert.repo_created"), "success");
      await refreshSyncStatusLine();
      await refreshSyncDevices();
      await refreshSyncRepoStats();
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(t("settings.sync.alert.repo_failed", { error: msg }), "error", 5200);
    }
  });
});

settingsSyncJoinRepo?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncJoinRepo, t("settings.sync.button.busy.join_repo"), async () => {
    try {
      const id = await ensureSyncProfileReadyForActions();
      const passphrase = String(settingsSyncEncPassword?.value || "");
      if (!passphrase) {
        if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.error.passphrase_required");
        return;
      }
      const rememberPassphrase = Boolean(settingsSyncRememberPassphrase?.checked);
      const r = await invoke("sync_join_repo", { profileId: id, passphrase, rememberPassphrase });
      if (!r.localVaultIdMatches) {
        const ok = confirm(t("settings.sync.confirm.vault_mismatch", { remote: r.repoVaultId }));
        if (!ok) {
          await invoke("sync_forget_engine", { profileId: id });
          if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.aborted");
          return;
        }
      }
      if (settingsSyncStatus) {
        settingsSyncStatus.textContent = t("settings.sync.status.joined_detail", {
          pulled: Number(r?.eventsPulled ?? 0),
          applied: Number((r?.upsertsApplied ?? 0) + (r?.deletesApplied ?? 0)),
          conflicts: Number(r?.conflictsDetected ?? 0),
        });
      }
      await refreshSyncStatusLine();
      await refreshAllSyncedViewsFromVault();
      await warnIfMalformedSyncedHosts();
      await refreshSyncDevices();
      await refreshSyncConflicts();
      await refreshSyncRepoStats();
      showToast(settingsSyncStatus?.textContent || t("settings.sync.status.joined"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncForgetEngine?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncForgetEngine, t("settings.sync.button.busy.forget_engine"), async () => {
    try {
      const id = syncSingleProfileId || syncEditingId;
      if (!id) return;
      await invoke("sync_forget_engine", { profileId: id });
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.forgotten");
      await refreshSyncStatusLine();
      showToast(t("settings.sync.status.forgotten"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncClearAll?.addEventListener("click", async () => {
  const ok = confirm(t("settings.sync.confirm.clear_all"));
  if (!ok) return;
  await runSyncButtonAction(settingsSyncClearAll, t("settings.sync.button.busy.clear_all"), async () => {
    try {
      const r = await invoke("delete_all_sync_profiles");
      syncSingleProfileId = null;
      syncEditingId = null;
      localStorage.removeItem(SETTINGS_KEY_SYNC_ACTIVE_PROFILE);
      if (settingsSyncStatus) {
        settingsSyncStatus.textContent = t("settings.sync.status.cleared_all", {
          count: r?.deletedCount ?? r?.deleted_count ?? 0,
        });
      }
      showToast(
        t("settings.sync.status.cleared_all", {
          count: r?.deletedCount ?? r?.deleted_count ?? 0,
        }),
        "success",
      );
      await loadSyncProfiles();
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncDeleteRemote?.addEventListener("click", async () => {
  const id = activeSyncProfileId();
  if (!id) return;
  const confirmText = await openTextInputDialog({
    title: t("settings.sync.confirm.delete_remote.title"),
    message: t("settings.sync.confirm.delete_remote.message"),
    placeholder: t("settings.sync.confirm.delete_remote.placeholder"),
  });
  if (String(confirmText || "").trim().toUpperCase() !== t("settings.sync.confirm.delete_remote.keyword")) {
    showToast(t("settings.sync.confirm.delete_remote.mismatch"), "error", 3200);
    return;
  }
  await runSyncButtonAction(settingsSyncDeleteRemote, t("settings.sync.button.busy.delete_remote"), async () => {
    try {
      await invoke("sync_delete_remote_repo", { profileId: id });
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.remote_deleted");
      showToast(t("settings.sync.status.remote_deleted"), "success");
      await refreshSyncStatusLine();
      await refreshSyncDevices();
      await refreshSyncRepoStats();
      await refreshSyncConflicts();
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncNow?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncNow, t("settings.sync.button.busy.now"), async () => {
    try {
      const outcome = await runImmediateSync({});
      if (settingsSyncStatus) {
        settingsSyncStatus.textContent = t("settings.sync.status.sync_now", {
          pulled: outcome.eventsPulled ?? outcome.pulled ?? 0,
          pushed: outcome.eventsPushed ?? 0,
        });
      }
      markSyncLast("sync_now", outcome.eventsPushed ?? 0, {
        pulled: outcome.eventsPulled ?? 0,
      });
      await refreshAllSyncedViewsFromVault();
      await warnIfMalformedSyncedHosts();
      await refreshSyncStatusLine();
      await refreshSyncDevices();
      await refreshSyncConflicts();
      await refreshSyncRepoStats();
      showToast(settingsSyncStatus?.textContent || t("settings.sync.button.now"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncStatus) settingsSyncStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncRefreshStats?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsSyncRefreshStats, t("settings.sync.button.busy.refresh_stats"), async () => {
    try {
      await refreshSyncRepoStats();
      showToast(t("settings.sync.button.refresh_stats"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncCompactStatus) settingsSyncCompactStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

settingsSyncCompactNow?.addEventListener("click", async () => {
  const id = activeSyncProfileId();
  if (!id) return;
  await runSyncButtonAction(settingsSyncCompactNow, t("settings.sync.button.busy.compact_now"), async () => {
    try {
      const r = await invoke("sync_compact_now", { profileId: id });
      if (settingsSyncCompactStatus) {
        let line = t("settings.sync.compact.done", {
          events: r.eventsCompacted ?? 0,
          records: r.recordsInSnapshot ?? 0,
        });
        if ((r.eventsRetained ?? 0) > 0) {
          line += t("settings.sync.compact.retained", { kept: r.eventsRetained });
        }
        if ((r.tombstonesPruned ?? 0) > 0) {
          line += t("settings.sync.compact.tombstones", {
            tombstones: r.tombstonesPruned,
          });
        }
        settingsSyncCompactStatus.textContent = line;
      }
      await refreshSyncRepoStats();
      await refreshSyncStatusLine();
      showToast(t("settings.sync.button.compact_now"), "success");
    } catch (e) {
      const msg = userFriendlySyncError(e);
      if (settingsSyncCompactStatus) settingsSyncCompactStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});

quickConnectCancel?.addEventListener("click", closeQuickConnectOverlay);
quickConnectAuthType?.addEventListener("change", syncQuickConnectAuthSections);
quickConnectKeyPick?.addEventListener("click", () => {
  pickQuickConnectKeyFile().catch((e) => {
    if (quickConnectKeyStatus) quickConnectKeyStatus.textContent = String(e);
  });
});
// Backdrop click intentionally doesn't close — too easy to lose typed
// credentials. Use the Cancel button or Esc instead.
quickConnectForm?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (quickConnectError) {
    quickConnectError.hidden = true;
    quickConnectError.textContent = "";
  }
  const input = {
    user: String(quickConnectUser?.value || "").trim(),
    host: String(quickConnectHost?.value || "").trim(),
    port: parseInt(String(quickConnectPort?.value || "22"), 10) || 22,
    auth: null,
  };
  const authType = quickConnectAuthType?.value || "password";
  if (authType === "password") {
    const pw = String(quickConnectPassword?.value || "");
    input.auth = { type: "password", value: pw };
    if (!pw) {
    if (quickConnectError) {
      quickConnectError.textContent = t("quick_connect.error.required_password");
      quickConnectError.hidden = false;
    }
      return;
    }
  } else if (authType === "key") {
    if (!quickConnectKeyPem) {
      if (quickConnectError) {
        quickConnectError.textContent = t("quick_connect.error.pick_key");
        quickConnectError.hidden = false;
      }
      return;
    }
    input.auth = {
      type: "private_key",
      key_pem: quickConnectKeyPem,
      passphrase: String(quickConnectKeyPassphrase?.value || "") || null,
    };
  } else {
    input.auth = { type: "agent" };
  }

  if (!input.user || !input.host) {
    if (quickConnectError) {
      quickConnectError.textContent = t("quick_connect.error.required_host_user");
      quickConnectError.hidden = false;
    }
    return;
  }
  try {
    closeQuickConnectOverlay();
    await connectQuickHostAndOpenTerminal(input);
  } catch (e) {
    if (quickConnectError) {
      quickConnectError.textContent = String(e);
      quickConnectError.hidden = false;
      quickConnectOverlay.hidden = false;
    }
  }
});
settingsSftpLocalDir?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_SFTP_LOCAL_DIR, settingsSftpLocalDir.value.trim());
});
settingsSftpLocalDirBrowse?.addEventListener("click", async () => {
  try {
    const picked = await invoke("plugin:dialog|open", {
      options: {
        directory: true,
        multiple: false,
        title: t("settings.sftp.local_dir.browse"),
      },
    });
    const resolved = Array.isArray(picked) ? picked[0] : picked;
    if (!resolved || typeof resolved !== "string") return;
    settingsSftpLocalDir.value = resolved;
    localStorage.setItem(SETTINGS_KEY_SFTP_LOCAL_DIR, resolved);
  } catch (e) {
    if (settingsSyncStatus) settingsSyncStatus.textContent = userFriendlySyncError(e);
  }
});
settingsTerminalTheme?.addEventListener("change", () => {
  setTerminalTheme(settingsTerminalTheme.value);
});
settingsTerminalFontFamily?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_FONT_FAMILY, settingsTerminalFontFamily.value);
  applyTerminalThemeToAllPanes();
  syncTerminalFontPreview();
  syncCustomSelect("settings-terminal-font-family");
});
settingsTerminalFontSize?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_FONT_SIZE, String(settingsTerminalFontSize.value || "13"));
  applyTerminalThemeToAllPanes();
  syncTerminalFontPreview();
});
settingsTerminalShell?.addEventListener("change", saveLocalShellFromSelect);
// Custom-typed paths don't fire `change`; persist them when focus leaves the combobox.
settingsTerminalPanel?.addEventListener("focusout", () => {
  if (settingsTerminalShell) saveLocalShellFromSelect();
});
settingsTerminalShellBrowse?.addEventListener("click", async () => {
  if (!settingsTerminalShell) return;
  try {
    const options = { multiple: false, directory: false, title: t("settings.terminal.shell.browse") };
    if (isWindowsPlatform) options.filters = [{ name: "Executable", extensions: ["exe", "bat", "cmd"] }];
    const picked = await invoke("plugin:dialog|open", { options });
    const resolved = Array.isArray(picked) ? picked[0] : picked;
    if (!resolved || typeof resolved !== "string") return;
    settingsTerminalShell.dataset.customValue = resolved;
    settingsTerminalShell.value = "";
    settingsTerminalShell._ztSync?.();
    saveLocalShellFromSelect();
  } catch (e) {
    console.warn("pick local shell failed", e);
  }
});
settingsTerminalShellReset?.addEventListener("click", () => {
  if (!settingsTerminalShell) return;
  settingsTerminalShell.dataset.customValue = "";
  settingsTerminalShell.value = "";
  settingsTerminalShell._ztSync?.();
  saveLocalShellFromSelect();
});
settingsTerminalCwd?.addEventListener("change", () => {
  const v = settingsTerminalCwd.value.trim();
  settingsTerminalCwd.value = v;
  if (v) localStorage.setItem(SETTINGS_KEY_TERMINAL_LOCAL_CWD, v);
  else localStorage.removeItem(SETTINGS_KEY_TERMINAL_LOCAL_CWD);
});
settingsTerminalCwdBrowse?.addEventListener("click", async () => {
  if (!settingsTerminalCwd) return;
  try {
    const picked = await invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: t("settings.terminal.cwd.browse") },
    });
    const resolved = Array.isArray(picked) ? picked[0] : picked;
    if (!resolved || typeof resolved !== "string") return;
    settingsTerminalCwd.value = resolved;
    localStorage.setItem(SETTINGS_KEY_TERMINAL_LOCAL_CWD, resolved);
  } catch (e) {
    console.warn("pick local cwd failed", e);
  }
});
settingsTerminalSelectionMenuOrderReset?.addEventListener("click", () => {
  localStorage.removeItem(SETTINGS_KEY_TERMINAL_SELECTION_MENU_ORDER);
  applyTerminalSelectionMenuOrder();
  renderTerminalSelectionMenuOrderSettings();
});
settingsTerminalAttentionFlash?.addEventListener("change", () => {
  localStorage.setItem(
    SETTINGS_KEY_TERMINAL_ATTENTION_FLASH,
    settingsTerminalAttentionFlash.checked ? "true" : "false"
  );
  if (!settingsTerminalAttentionFlash.checked) cancelWindowAttentionFlash();
});
settingsTerminalLineHeight?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_LINE_HEIGHT, String(settingsTerminalLineHeight.value || "1.25"));
  applyTerminalThemeToAllPanes();
  syncTerminalFontPreview();
});
setTimeout(() => {
  refreshUpdateStatus().catch(() => {});
}, 10000);
// Command snippets now live in the encrypted vault — load them after
// unlock in enterHosts(), not here. The group expand/collapse state is
// device-local UI and stays in localStorage.
loadTerminalSnippetGroupState();
loadCustomThemes();
rebuildTerminalThemeSelectOptions();
renderTerminalThemeCards();
syncTerminalThemeEditor();

themeColorBg?.addEventListener("input", () => updateCustomThemeColor("background", themeColorBg.value));
themeColorFg?.addEventListener("input", () => updateCustomThemeColor("foreground", themeColorFg.value));
themeColorCursor?.addEventListener("input", () => updateCustomThemeColor("cursor", themeColorCursor.value));
themeColorSelection?.addEventListener("input", () => updateCustomThemeColor("selectionBackground", themeColorSelection.value));
themeColorBg?.addEventListener("input", () => { if (themeHexBg) themeHexBg.value = themeColorBg.value; });
themeColorFg?.addEventListener("input", () => { if (themeHexFg) themeHexFg.value = themeColorFg.value; });
themeColorCursor?.addEventListener("input", () => { if (themeHexCursor) themeHexCursor.value = themeColorCursor.value; });
themeColorSelection?.addEventListener("input", () => { if (themeHexSelection) themeHexSelection.value = themeColorSelection.value; });

function bindHexInput(hexEl, apply) {
  hexEl?.addEventListener("change", () => {
    const v = String(hexEl.value || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) return;
    apply(v.toLowerCase());
  });
}
bindHexInput(themeHexBg, (v) => {
  if (themeColorBg) themeColorBg.value = v;
  updateCustomThemeColor("background", v);
});
bindHexInput(themeHexFg, (v) => {
  if (themeColorFg) themeColorFg.value = v;
  updateCustomThemeColor("foreground", v);
});
bindHexInput(themeHexCursor, (v) => {
  if (themeColorCursor) themeColorCursor.value = v;
  updateCustomThemeColor("cursor", v);
});
bindHexInput(themeHexSelection, (v) => {
  if (themeColorSelection) themeColorSelection.value = v;
  updateCustomThemeColor("selectionBackground", v);
});

themeMenuEdit?.addEventListener("click", () => {
  const id = themeMenuTargetId;
  themeCardMenu.hidden = true;
  if (!id) return;
  if (!allTerminalThemes()[id]) return;
  openThemeEditDialog(id);
});

themeMenuDuplicate?.addEventListener("click", async () => {
  const id = themeMenuTargetId;
  themeCardMenu.hidden = true;
  if (!id) return;
  const baseTheme = allTerminalThemes()[id];
  if (!baseTheme) return;
  const label = await openTextInputDialog({
    title: t("theme.prompt.duplicate.title"),
    message: t("theme.prompt.duplicate.message"),
    placeholder: "例如：My Theme",
  });
  if (!label) return;
  const newId = `custom-${Date.now()}`;
  terminalCustomThemes.push({
    id: newId,
    label,
    group: TERMINAL_THEME_META[id]?.group === "light" ? "light" : "dark",
    theme: { ...baseTheme },
  });
  saveCustomThemes();
  localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, newId);
  terminalEditingThemeId = newId;
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
  syncTerminalThemeEditor();
  applyTerminalThemeToAllPanes();
});

themeMenuDelete?.addEventListener("click", async () => {
  const id = themeMenuTargetId;
  themeCardMenu.hidden = true;
  if (!id || !allTerminalThemes()[id]) return;
  if (getTerminalThemeName() === id) {
    showToast(t("theme.error.delete_current"), "error", 2600);
    return;
  }
  const target = terminalCustomThemes.find((theme) => theme.id === id);
  const label = target?.label || builtinTerminalThemeLabel(id);
  const ok = await openConfirmDialog({
    title: t("theme.confirm.delete.title"),
    message: t("theme.confirm.delete", { name: label }),
    okText: t("snippets.menu.delete"),
    cancelText: t("snippets.dialog.cancel"),
  });
  if (!ok) return;
  const deletedWasEditing = terminalEditingThemeId === id;
  terminalCustomThemes = terminalCustomThemes.filter((theme) => theme.id !== id);
  if (TERMINAL_THEME_META[id] && !terminalHiddenBuiltinThemes.includes(id)) {
    terminalHiddenBuiltinThemes.push(id);
  }
  saveCustomThemes();
  terminalEditingThemeId = deletedWasEditing ? getTerminalThemeName() : terminalEditingThemeId;
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
  syncTerminalThemeEditor();
});

themeEditCancel?.addEventListener("click", () => {
  const id = terminalEditingThemeId;
  const idx = terminalCustomThemes.findIndex((t) => t.id === id);
  if (idx >= 0 && themeEditOriginal) {
    if (themeEditIsNew) {
      terminalCustomThemes.splice(idx, 1);
      rebuildTerminalThemeSelectOptions();
      renderTerminalThemeCards();
      syncTerminalThemeCardsActive();
    } else {
      terminalCustomThemes[idx].theme = JSON.parse(JSON.stringify(themeEditOriginal));
      terminalCustomThemes[idx].label = themeEditOriginalLabel;
      saveCustomThemes();
      applyTerminalThemeToAllPanes();
      rebuildTerminalThemeSelectOptions();
      renderTerminalThemeCards();
      syncTerminalThemeEditor();
    }
  }
  themeEditIsNew = false;
  themeEditOriginal = null;
  themeEditOriginalLabel = "";
  terminalEditingThemeId = null;
  // Editor closed → drop the live preview and restore the active theme.
  applyTerminalThemeToAllPanes();
  if (themeEditOverlay) themeEditOverlay.hidden = true;
});

themeEditReset?.addEventListener("click", () => {
  if (!themeEditOriginal) return;
  const id = terminalEditingThemeId;
  const idx = terminalCustomThemes.findIndex((t) => t.id === id);
  if (idx < 0) return;
  terminalCustomThemes[idx].theme = JSON.parse(JSON.stringify(themeEditOriginal));
  terminalCustomThemes[idx].label = themeEditOriginalLabel;
  if (!themeEditIsNew) saveCustomThemes();
  applyTerminalThemeToAllPanes();
  syncTerminalThemeEditor();
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
});

themeEditName?.addEventListener("input", () => {
  updateCustomThemeLabel(themeEditName.value);
});

themeEditForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const id = terminalEditingThemeId;
  const idx = terminalCustomThemes.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const label = String(themeEditName?.value || "").trim();
  if (!label) {
    alert(t("theme.error.name_required"));
    themeEditName?.focus();
    return;
  }
  terminalCustomThemes[idx].label = label;
  saveCustomThemes();
  themeEditIsNew = false;
  themeEditOriginal = null;
  themeEditOriginalLabel = "";
  terminalEditingThemeId = null;
  if (themeEditOverlay) themeEditOverlay.hidden = true;
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
  // Activate the just-saved theme so it takes effect immediately.
  setTerminalTheme(id);
});

document.addEventListener("click", (ev) => {
  if (!themeCardMenu || themeCardMenu.hidden) return;
  if (themeCardMenu.contains(ev.target)) return;
  themeCardMenu.hidden = true;
});
textInputCancelButton.addEventListener("click", () => closeTextInputDialog(null));
textInputConfirmButton.addEventListener("click", () => {
  closeTextInputDialog(textInputValue.value.trim());
});
textInputOverlay.addEventListener("click", (ev) => {
  if (ev.target === textInputOverlay) {
    closeTextInputDialog(null);
  }
});
textInputValue.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeTextInputDialog(null);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    closeTextInputDialog(textInputValue.value.trim());
  }
});

confirmCancelButton?.addEventListener("click", () => closeConfirmDialog(false));
confirmOkButton?.addEventListener("click", () => closeConfirmDialog(true));
confirmOverlay?.addEventListener("click", (ev) => {
  if (ev.target === confirmOverlay) closeConfirmDialog(false);
});
confirmOverlay?.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeConfirmDialog(false);
  }
});

permissionsCancelButton.addEventListener("click", () => closePermissionsDialog(null));
permissionsConfirmButton.addEventListener("click", () => {
  const modeText = normalizePermissionModeInput(permissionsOctal.value);
  if (!modeText) {
    permissionsError.textContent = t("files.error.permissions_invalid");
    permissionsError.hidden = false;
    return;
  }
  closePermissionsDialog(modeText);
});
permissionsOverlay.addEventListener("click", (ev) => {
  if (ev.target === permissionsOverlay) closePermissionsDialog(null);
});
permissionsOctal.addEventListener("input", () => {
  permissionsError.hidden = true;
  if (!permissionsSyncingFromChecks) syncPermissionsCheckboxesFromOctal();
});
permissionsOctal.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closePermissionsDialog(null);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    permissionsConfirmButton.click();
  }
});
Object.values(permissionCheckboxes).forEach((checkbox) => {
  checkbox?.addEventListener("change", () => {
    permissionsError.hidden = true;
    syncPermissionsOctalFromCheckboxes();
  });
});

newWindowButton.addEventListener("click", () => {
  invoke("open_new_window").catch((e) => alert(t("terminal.error.new_window_failed", { error: e })));
});

async function enterHosts() {
  show("hosts");
  setWorkspaceMode("vaults");
  hostSearch.value = "";
  if (!groupStateInitialized) {
    loadGroupExpansionState();
    groupStateInitialized = true;
  }
  await reloadHostGroupsFromVault();
  // Snippets live in the vault now — migrate any legacy localStorage
  // entries once, then load the synced set for display.
  await migrateLocalSnippetsToVault();
  await loadTerminalCommandSnippets();
  renderTerminalCommandSnippets();
  startAutoSync();
  updateSyncIndicator();

  try {
    await refreshHostsCacheFromVault();
  } catch (e) {
    hostsCache = [];
    hostsEmpty.hidden = false;
    if (hostsEmptyTitle) hostsEmptyTitle.textContent = t("hosts.error.load_failed", { error: e });
    if (hostsEmptyDesc) hostsEmptyDesc.textContent = "";
    if (hostsEmptyAdd) hostsEmptyAdd.hidden = true;
    return;
  }
}

async function moveHostToGroup(hostId, groupId) {
  try {
    await invoke("set_host_group", { hostId, groupId: groupId || null });
  } catch (e) {
    alert(String(e));
    return;
  }
  const cached = hostsCache.find((h) => h.id === hostId);
  if (cached) cached.groupId = groupId || null;
  autoSyncAfterDataChange();
  renderHosts();
}

function renderHosts() {
  hostsList.innerHTML = "";

  const q = hostSearch.value.trim().toLowerCase();
  const searching = q.length > 0;
  const rows = q
    ? hostsCache.filter((h) =>
      `${h.name} ${h.user} ${h.host} ${h.port}`.toLowerCase().includes(q)
    )
    : hostsCache;

  if (rows.length === 0) {
    hostsEmpty.hidden = false;
    if (hostsEmptyTitle) hostsEmptyTitle.textContent = q ? t("hosts.empty.search") : t("hosts.empty.title");
    if (hostsEmptyDesc) hostsEmptyDesc.textContent = q ? t("hosts.empty.search.desc") : t("hosts.empty.default");
    if (hostsEmptyAdd) hostsEmptyAdd.hidden = !!q;
  } else {
    hostsEmpty.hidden = true;
  }

  function renderHostItem(host, grouped = false) {
    const li = document.createElement("li");
    li.className = "host-card";
    if (grouped) li.classList.add("host-card-grouped");
    li.tabIndex = 0;
    li.draggable = true;
    li.dataset.hostId = host.id;
    li.dataset.conn = `${host.user}@${host.host}:${host.port}`;
    li.setAttribute("aria-label", `${host.name} ${host.user}@${host.host}:${host.port}`);
    if (host.id === selectedVaultHostId) {
      li.classList.add("selected");
    }

    const top = document.createElement("div");
    top.className = "row-top";

    const badge = document.createElement("div");
    badge.className = "badge os-badge";
    const osBadge = detectHostOsBadge(host);
    badge.title = osBadge.label;
    badge.setAttribute("aria-label", osBadge.label);
    const osIcon = document.createElement("i");
    osIcon.className = `${osBadge.iconClass} colored host-os-icon`;
    osIcon.setAttribute("aria-hidden", "true");
    badge.appendChild(osIcon);

    const info = document.createElement("div");
    info.style.minWidth = "0";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = host.name;

    const conn = document.createElement("span");
    conn.className = "host-conn-inline";
    conn.textContent = `${host.user}@${host.host}:${host.port}`;

    const target = document.createElement("div");
    target.className = "target";
    target.textContent = `${host.user}@${host.host}:${host.port}`;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = authTypeLabel(host.authType);

    info.append(name, conn, target, meta);
    top.append(badge, info);

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
    filesBtn.addEventListener("click", () => {
      assignHostToSftpPane(host).catch((e) => {
        console.warn("assignHostToSftpPane failed", e);
      });
      setWorkspaceMode("sftp");
    });

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
    li.addEventListener("click", () => {
      selectedVaultHostId = host.id;
      renderHosts();
    });
    li.addEventListener("dblclick", () => {
      openHostInTerminal(host);
    });
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        openHostInTerminal(host);
      }
    });
    li.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      selectedVaultHostId = host.id;
      renderHosts();
      showHostsContextMenu(host, ev);
    });
    li.addEventListener("dragstart", (ev) => {
      draggingHostId = host.id;
      li.classList.add("dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", host.id);
      }
    });
    li.addEventListener("dragend", () => {
      draggingHostId = null;
      li.classList.remove("dragging");
      for (const row of hostsList.querySelectorAll(".group-row.drop-target")) {
        row.classList.remove("drop-target");
      }
    });
    hostsList.appendChild(li);
  }

  if (searching) {
    for (const host of rows) {
      renderHostItem(host, false);
    }
    return;
  }

  const groupedRows = new Map();
  for (const g of hostGroups) groupedRows.set(g.id, []);
  const ungroupedRows = [];

  for (const host of rows) {
    const gid = host.groupId || "";
    if (gid && groupedRows.has(gid)) {
      groupedRows.get(gid).push(host);
    } else {
      // Orphan reference: host.groupId points at a tombstoned/missing
      // group. Render as Ungrouped without rewriting the vault — a peer
      // may still have that group alive and re-introduce it.
      ungroupedRows.push(host);
    }
  }

  function renderGroupNode(group, depth) {
    const items = groupedRows.get(group.id) || [];
    const expanded = groupExpandedState[group.id] === true;

    const row = document.createElement("li");
    row.className = "group-row";
    row.style.paddingLeft = `${4 + depth * 14}px`;
    const left = document.createElement("span");
    left.className = "group-left";
    const caret = document.createElement("span");
    caret.className = "group-caret";
    caret.textContent = expanded ? "▾" : "▸";
    const name = document.createElement("span");
    name.textContent = group.name;
    const count = document.createElement("span");
    count.className = "group-count";
    count.textContent = String(items.length);
    left.append(caret, name);
    row.append(left, count);
    row.addEventListener("click", () => {
      groupExpandedState[group.id] = !expanded;
      saveGroupExpansionState();
      renderHosts();
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      hideHostsContextMenu();
      showGroupsContextMenu(group, ev);
    });
    row.addEventListener("dragover", (ev) => {
      if (!draggingHostId) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => {
      row.classList.remove("drop-target");
    });
    row.addEventListener("drop", async (ev) => {
      ev.preventDefault();
      row.classList.remove("drop-target");
      const hostId = (ev.dataTransfer && ev.dataTransfer.getData("text/plain")) || draggingHostId;
      if (!hostId) return;
      await moveHostToGroup(hostId, group.id);
    });
    hostsList.appendChild(row);

    if (!expanded) return;
    const children = hostGroups.filter((g) => (g.parentId || "") === group.id);
    for (const child of children) renderGroupNode(child, depth + 1);
    for (const host of items) {
      renderHostItem(host, true);
    }
  }

  if (hostGroups.length > 0) {
    const roots = hostGroups.filter((g) => !g.parentId);
    for (const group of roots) renderGroupNode(group, 0);
  }

  for (const host of ungroupedRows) {
    renderHostItem(host, false);
  }
}

// --------------------------------------------------------------------------
// Terminal tabs / splits
// --------------------------------------------------------------------------

const termTabStrip = document.getElementById("term-tab-strip");
const termTabScrollWrap = document.querySelector(".term-tab-scroll-wrap");
const termTabScrollLeft = document.getElementById("term-tab-scroll-left");
const termTabScrollRight = document.getElementById("term-tab-scroll-right");
const terminalWorkspace = document.getElementById("terminal-workspace");

const termState = {
  tabs: [],
  activeTabId: null,
};

function getActiveTab() {
  return termState.tabs.find((t) => t.id === termState.activeTabId) || null;
}

function getActivePane() {
  const tab = getActiveTab();
  if (!tab) return null;
  return tab.panes.find((p) => p.id === tab.activePaneId) || tab.panes[0] || null;
}

function sanitizeTerminalTabs() {
  const before = termState.tabs.length;
  termState.tabs = termState.tabs.filter((tab) => Array.isArray(tab.panes) && tab.panes.length > 0);
  if (before !== termState.tabs.length) {
    if (!termState.tabs.find((tab) => tab.id === termState.activeTabId)) {
      termState.activeTabId = termState.tabs[0]?.id ?? null;
    }
  }
}

function createPane(host) {
  const isLocal = host?.id?.startsWith?.("local-") || host?.port === 0;
  return {
    id: uniqueId("pane"),
    host,
    isLocal,
    reconnectFactory: null,
    sessionId: null,
    rootEl: null,
    bodyEl: null,
    titleEl: null,
    latencyEl: null,
    statusEl: null,
    reconnectBtn: null,
    term: null,
    fitAddon: null,
    searchAddon: null,
    ipLinkProviderDispose: null,
    searchQuery: "",
    searchMatches: [],
    searchIndex: -1,
    findBarEl: null,
    findInputEl: null,
    findCountEl: null,
    savedStatus: null,
    dataUnlisten: null,
    latencyUnlisten: null,
    latencyStoppedUnlisten: null,
    closedUnlisten: null,
    lastAliveAt: 0,
    aliveWatchdogArmed: false,
    aliveWatchdogTimer: null,
    unresponsiveSince: null,
    preUnresponsiveStatus: null,
    osc7HandlerDispose: null,
    attention: null,
    attnQuietTimer: null,
    attnAcknowledgedScreen: null,
    attnHandlerDisposes: null,
    resizeObserver: null,
    pendingResizeTimer: null,
    pendingFitRaf: null,
    lastSentCols: 0,
    lastSentRows: 0,
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

  setWorkspaceMode("terminal");
  renderTerminalWorkspace();
  await connectPaneSession(pane);
  pane.reconnectFactory = async () => {
    await connectPaneSession(pane);
  };
}

function openQuickConnectOverlay() {
  if (quickConnectError) {
    quickConnectError.hidden = true;
    quickConnectError.textContent = "";
  }
  if (quickConnectForm) quickConnectForm.reset();
  if (quickConnectPort) quickConnectPort.value = "22";
  if (quickConnectAuthType) quickConnectAuthType.value = "password";
  quickConnectKeyPem = null;
  if (quickConnectKeyStatus) quickConnectKeyStatus.textContent = t("quick_connect.key.none");
  if (quickConnectKeyPassphrase) quickConnectKeyPassphrase.value = "";
  syncQuickConnectAuthSections();
  if (quickConnectOverlay) quickConnectOverlay.hidden = false;
  quickConnectUser?.focus();
}

function closeQuickConnectOverlay() {
  if (quickConnectOverlay) quickConnectOverlay.hidden = true;
}

async function connectQuickHostAndOpenTerminal(input) {
  let tab = {
    id: uniqueId("tab"),
    title: `${input.user}@${input.host}`,
    layout: "single",
    panes: [],
    activePaneId: null,
  };
  const pane = createPane({
    id: `quick-${Date.now()}`,
    name: `${input.user}@${input.host}`,
    host: input.host,
    port: input.port,
    user: input.user,
  });
  tab.panes.push(pane);
  tab.activePaneId = pane.id;
  termState.tabs.push(tab);
  termState.activeTabId = tab.id;
  setWorkspaceMode("terminal");
  renderTerminalWorkspace();

  await connectQuickIntoPane(pane, input);
  pane.reconnectFactory = async () => {
    await connectQuickIntoPane(pane, input);
  };
}

async function connectQuickIntoPane(pane, input) {
  const cols = pane.term ? pane.term.cols : 80;
  const rows = pane.term ? pane.term.rows : 24;
  const sessionId = await invoke("connect_quick_host", {
    input: {
      user: input.user,
      host: input.host,
      port: input.port,
      auth: input.auth,
    },
    cols,
    rows,
  });
  pane.sessionId = sessionId;
  if (pane.statusEl) pane.statusEl.textContent = t("terminal.status.connected");
  if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;
  await wirePaneSessionEvents(pane, sessionId);
}

function syncQuickConnectAuthSections() {
  const mode = quickConnectAuthType?.value || "password";
  if (quickConnectPasswordBlock) quickConnectPasswordBlock.hidden = mode !== "password";
  if (quickConnectKeyBlock) quickConnectKeyBlock.hidden = mode !== "key";
}

async function pickQuickConnectKeyFile() {
  // Route through the backend picker so the chosen path is authorized
  // for read_local_text_file (webview-supplied paths are refused).
  const chosen = await invoke("pick_local_file", {
    title: t("host_editor.key.pick_title"),
  });
  if (!chosen) return;
  const path = String(chosen);
  try {
    const text = await invoke("read_local_text_file", { path });
    quickConnectKeyPem = text;
    if (quickConnectKeyStatus) {
      quickConnectKeyStatus.textContent = t("host_editor.key.loaded", {
        name: basename(path),
        bytes: text.length,
      });
    }
  } catch (e) {
    if (quickConnectKeyStatus) {
      quickConnectKeyStatus.textContent = t("host_editor.key.read_failed", { error: e });
    }
  }
}

async function openLocalTerminalInTab() {
  let tab = {
    id: uniqueId("tab"),
    title: "Local",
    layout: "single",
    panes: [],
    activePaneId: null,
  };
  const pane = createPane({
    id: `local-${Date.now()}`,
    name: "Local",
    host: "localhost",
    port: 0,
    user: "local",
  });
  tab.panes.push(pane);
  tab.activePaneId = pane.id;
  termState.tabs.push(tab);
  termState.activeTabId = tab.id;
  setWorkspaceMode("terminal");
  renderTerminalWorkspace();

  // Mirror the SSH connect path: wait for the terminal font to load and the
  // pane size to settle before sizing the PTY. Otherwise the cell size is
  // measured with the fallback font and the PTY's column count can disagree
  // with what xterm renders.
  ensurePaneTerminal(pane);
  await preparePaneTerminalForSession(pane, 2);

  const cols = pane.term ? pane.term.cols : 80;
  const rows = pane.term ? pane.term.rows : 24;
  const sessionId = await invoke("create_local_terminal_session", { cols, rows, shell: getLocalShellPath() || null, cwd: getLocalCwd() || null });
  pane.sessionId = sessionId;
  pane.lastSentCols = cols;
  pane.lastSentRows = rows;
  pane.statusEl.textContent = t("terminal.status.local");
  if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;
  await wirePaneSessionEvents(pane, sessionId);
  pane.reconnectFactory = async () => {
    await preparePaneTerminalForSession(pane, 1);
    const cols2 = pane.term ? pane.term.cols : 80;
    const rows2 = pane.term ? pane.term.rows : 24;
    const sid2 = await invoke("create_local_terminal_session", { cols: cols2, rows: rows2, shell: getLocalShellPath() || null, cwd: getLocalCwd() || null });
    pane.sessionId = sid2;
    pane.lastSentCols = cols2;
    pane.lastSentRows = rows2;
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.status.local");
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;
    await wirePaneSessionEvents(pane, sid2);
  };
}

function renderTerminalWorkspace() {
  sanitizeTerminalTabs();
  syncTerminalAttentionOnWorkspaceRender();
  renderTabStrip();
  syncAiConversationToActivePane();
  applyTerminalSidePanelForActivePane();
  renderTerminalCommandSnippets();
  if (terminalActiveSidePanel === "metrics") renderMetricsPanel();
  if (terminalActiveSidePanel === "docker") renderDockerPanel();
  if (terminalActiveSidePanel === "sftp") connectTerminalSftpToActivePane().catch((e) => console.warn("terminal sftp sync failed", e));

  terminalWorkspace.innerHTML = "";
  const tab = getActiveTab();
  const hasTerminalTab = !!tab;
  terminalSessionLayout?.classList.toggle("no-terminal-sidebar", !hasTerminalTab);
  if (terminalSidebarRail) terminalSidebarRail.hidden = !hasTerminalTab;
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
    try {
      ensurePaneElements(pane, tab);
      if (!pane.rootEl) continue;
      if (pane.reconnectBtn) pane.reconnectBtn.textContent = t("terminal.button.reconnect");
      pane.rootEl.classList.toggle("active", pane.id === tab.activePaneId);
      terminalWorkspace.appendChild(pane.rootEl);
      ensurePaneTerminal(pane);
    } catch (e) {
      console.warn("ensurePaneElements failed", e);
    }
  }

  if (terminalWorkspace.children.length === 0) {
    const empty = document.createElement("div");
    empty.className = "term-empty";
    empty.textContent = t("terminal.empty");
    terminalWorkspace.appendChild(empty);
    return;
  }

  requestAnimationFrame(() => {
    for (const pane of tab.panes) {
      requestPaneFit(pane, { immediate: true });
    }
    const active = getActivePane();
    if (active?.term) {
      active.term.focus();
    }
  });
}

function installAiPanelResize() {
  if (!aiPanelSplitter || !terminalSessionLayout) return;
  aiPanelSplitter.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    aiPanelSplitter.setPointerCapture?.(ev.pointerId);
    document.body.classList.add("resizing-ai-panel");
    const rect = terminalSessionLayout.getBoundingClientRect();
    const onMove = (moveEv) => {
      const width = Math.round(rect.right - moveEv.clientX);
      const clamped = Math.max(300, Math.min(620, width));
      terminalSessionLayout.style.setProperty("--ai-panel-width", `${clamped}px`);
      if (aiPanelCollapsed) setAiPanelCollapsed(false);
      refitActiveTerminalPanes({ reason: "side-panel-resize", frames: 0 });
    };
    const onUp = () => {
      document.body.classList.remove("resizing-ai-panel");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      refitActiveTerminalPanes({ reason: "side-panel-resize-end", forceBottom: true, frames: 2 });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  });
}

terminalSidebarAiToggle?.addEventListener("click", () => {
  toggleAiPanel();
});

terminalSidebarSnippetsToggle?.addEventListener("click", () => {
  setTerminalSidePanel(terminalActiveSidePanel === "snippets" ? null : "snippets");
});

terminalSidebarMetricsToggle?.addEventListener("click", () => {
  setTerminalSidePanel(terminalActiveSidePanel === "metrics" ? null : "metrics");
});

terminalMetricsRefresh?.addEventListener("click", renderMetricsPanel);

terminalSidebarDockerToggle?.addEventListener("click", () => {
  setTerminalSidePanel(terminalActiveSidePanel === "docker" ? null : "docker");
});

terminalDockerRefresh?.addEventListener("click", () => renderDockerPanel());

terminalDockerBody?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.getAttribute("data-act");
  const project = btn.getAttribute("data-project");
  if (act === "group-toggle") return toggleDockerGroup(project, btn);
  if (act === "group-menu") { ev.stopPropagation(); return openDockerGroupMenu(project, btn); }
  const id = btn.getAttribute("data-id");
  if (!id) return;
  if (act === "detail") return toggleDockerDetail(id);
  if (act === "start") return dockerAction(["start", id], btn);
  if (act === "stop") return dockerAction(["stop", id], btn);
  if (act === "restart") return dockerAction(["restart", id], btn);
  if (act === "remove") return dockerRemove(id, btn.getAttribute("data-name") || id);
  if (act === "logs") return dockerShowLogs(id, btn.getAttribute("data-name"));
  if (act === "terminal") return dockerEnterTerminal(id);
});

terminalSidebarSftpToggle?.addEventListener("click", () => {
  setTerminalSidePanel(terminalActiveSidePanel === "sftp" ? null : "sftp");
});

terminalSidebarThemeToggle?.addEventListener("click", () => {
  setTerminalSidePanel(terminalActiveSidePanel === "theme" ? null : "theme");
});

terminalSftpRefresh?.addEventListener("click", () => {
  const pane = sftpPanes.terminal;
  if (pane && isPaneConnected(pane)) navigateSftpPane(pane, pane.path, { source: "system" });
  else connectTerminalSftpToActivePane().catch((e) => console.warn("terminal sftp refresh failed", e));
});

terminalSnippetsAdd?.addEventListener("click", async () => {
  const next = await openSnippetEditDialog({
    title: t("snippets.dialog.add_title"),
    group: defaultSnippetGroupLabel(),
  });
  if (!next) return;
  try {
    await invoke("create_snippet", {
      input: { title: next.name, command: next.command, group: normalizeSnippetGroup(next.group), sortOrder: 0 },
    });
  } catch (e) {
    alert(t("snippets.error.create_failed", { error: e }));
    return;
  }
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
  setTerminalSidePanel("snippets");
});

terminalSnippetsSearch?.addEventListener("input", () => {
  terminalSnippetSearchQuery = terminalSnippetsSearch.value || "";
  renderTerminalCommandSnippets();
});

snippetGroupMenuAdd?.addEventListener("click", async () => {
  const group = snippetGroupMenuTarget || defaultSnippetGroupLabel();
  hideSnippetGroupContextMenu();
  const next = await openSnippetEditDialog({
    title: t("snippets.dialog.add_title"),
    group,
  });
  if (!next) return;
  try {
    await invoke("create_snippet", {
      input: { title: next.name, command: next.command, group: normalizeSnippetGroup(next.group), sortOrder: 0 },
    });
  } catch (e) {
    alert(t("snippets.error.create_failed", { error: e }));
    return;
  }
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
  setTerminalSidePanel("snippets");
});

snippetGroupMenuEdit?.addEventListener("click", async () => {
  const current = snippetGroupMenuTarget || "";
  hideSnippetGroupContextMenu();
  if (!current) return;
  const next = await openTextInputDialog({
    title: t("snippets.group.edit_title"),
    message: t("snippets.group.edit_message"),
    defaultValue: current,
    placeholder: t("snippets.group.placeholder"),
  });
  if (!next) return;
  const nextName = next.trim();
  if (!nextName || nextName === current) return;
  try {
    await invoke("rename_snippet_group", {
      oldName: normalizeSnippetGroup(current),
      newName: normalizeSnippetGroup(nextName),
    });
  } catch (e) {
    alert(t("snippets.group.rename_failed", { error: e }));
    return;
  }
  if (terminalSnippetGroupExpanded[current] !== undefined) {
    terminalSnippetGroupExpanded[nextName] = terminalSnippetGroupExpanded[current];
    delete terminalSnippetGroupExpanded[current];
    saveTerminalSnippetGroupState();
  }
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
});

snippetGroupMenuDelete?.addEventListener("click", async () => {
  const current = snippetGroupMenuTarget || "";
  hideSnippetGroupContextMenu();
  if (!current) return;
  try {
    await invoke("delete_snippet_group", { name: normalizeSnippetGroup(current) });
  } catch (e) {
    alert(t("snippets.group.delete_failed", { error: e }));
    return;
  }
  delete terminalSnippetGroupExpanded[current];
  saveTerminalSnippetGroupState();
  await refreshSnippetsAndRender();
  autoSyncAfterDataChange();
});

snippetItemMenuEdit?.addEventListener("click", async () => {
  const snippetId = snippetItemMenuTargetId || "";
  hideSnippetItemContextMenu();
  await editSnippetById(snippetId);
});

snippetItemMenuDelete?.addEventListener("click", async () => {
  const snippetId = snippetItemMenuTargetId || "";
  hideSnippetItemContextMenu();
  await deleteSnippetById(snippetId);
});

snippetEditCancel?.addEventListener("click", () => closeSnippetEditDialog(null));
snippetEditForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const name = String(snippetEditName?.value || "").trim();
  const group = String(snippetEditGroup?.dataset.customValue || snippetEditGroup?.value || "").trim() || defaultSnippetGroupLabel();
  const command = String(snippetEditCommand?.value || "").trim();
  if (!name) {
    snippetEditName?.focus();
    return;
  }
  if (!command) {
    snippetEditCommand?.focus();
    return;
  }
  closeSnippetEditDialog({ name, group, command });
});

document.addEventListener("click", (ev) => {
  if (snippetGroupContextMenu && !snippetGroupContextMenu.hidden && !snippetGroupContextMenu.contains(ev.target)) {
    hideSnippetGroupContextMenu();
  }
  if (snippetItemContextMenu && !snippetItemContextMenu.hidden && !snippetItemContextMenu.contains(ev.target)) {
    hideSnippetItemContextMenu();
  }
});

// --- Terminal attention -----------------------------------------------------
// Badge a tab when a CLI inside it is waiting on the user (claude / codex /
// gemini approval menus, plain y/n confirmations). Three signals set the badge:
//   1. BEL — a hint to scan the current prompt after output settles;
//   2. OSC 9 / OSC 777 — alert only when their text itself asks for input;
//   3. prompt scan — output goes quiet while the bottom rows of the screen
//      show a selection menu or confirmation question.
// The badge only appears while the pane is out of the user's view (background
// tab, other workspace, unfocused window) and clears as soon as the user looks
// at the tab again or types into the pane.
//
// A badge is invisible when the whole window is behind other apps, so in that
// case we also ask the OS for attention: on Windows the taskbar icon flashes
// until the window is focused (WeChat-style), on macOS the dock icon bounces,
// on Linux the urgency hint is set. Off switch: Settings › Terminal.

const TERMINAL_ATTENTION_QUIET_MS = 450;

let termAttentionLastActiveTabId = null;
// Whether we currently have an outstanding OS attention request. Guards against
// re-flashing on every bell while the window is already flashing, and tells us
// whether the stop call is worth making.
let termAttentionFlashActive = false;

function isTerminalAttentionFlashEnabled() {
  return localStorage.getItem(SETTINGS_KEY_TERMINAL_ATTENTION_FLASH) !== "false";
}

// Only flashes when the window itself is in the background: a flash aimed at a
// window the user is already looking at is noise (and a no-op on Windows/macOS
// anyway) — the tab badge covers the background-tab-in-focused-window case.
function requestWindowAttentionFlash() {
  if (termAttentionFlashActive || document.hasFocus()) return;
  if (!isTerminalAttentionFlashEnabled()) return;
  termAttentionFlashActive = true;
  invoke("request_window_attention", { flash: true }).catch((e) => {
    termAttentionFlashActive = false;
    console.warn("request_window_attention failed", e);
  });
}

function cancelWindowAttentionFlash() {
  if (!termAttentionFlashActive) return;
  termAttentionFlashActive = false;
  invoke("request_window_attention", { flash: false }).catch((e) => {
    console.warn("cancel window attention failed", e);
  });
}

function findTerminalTabForPane(pane) {
  return termState.tabs.find((tab) => tab.panes.includes(pane)) || null;
}

// The user can only be looking at a pane when its tab is active, the terminal
// workspace is showing, and the window itself has focus.
function isPaneOnUserScreen(pane) {
  if (workspaceMode !== "terminal" || !document.hasFocus()) return false;
  const tab = findTerminalTabForPane(pane);
  return !!tab && tab.id === termState.activeTabId;
}

function triggerPaneAttention(pane, kind) {
  if (!pane || pane.sessionId === null) return;
  if (isPaneOnUserScreen(pane)) return;
  requestWindowAttentionFlash();
  if (pane.attention) {
    pane.attention = kind;
    return;
  }
  pane.attention = kind;
  renderTabStrip();
}

function clearPaneAttention(pane, { rerender = true } = {}) {
  if (!pane) return false;
  if (pane.attnQuietTimer !== null && pane.attnQuietTimer !== undefined) {
    clearTimeout(pane.attnQuietTimer);
    pane.attnQuietTimer = null;
  }
  const visibleScreen = paneLiveVisibleScreen(pane);
  if (visibleScreen !== null) pane.attnAcknowledgedScreen = visibleScreen;
  if (!pane.attention) return false;
  pane.attention = null;
  if (rerender) renderTabStrip();
  const anotherPaneNeedsAttention = termState.tabs.some((tab) =>
    tab.panes.some((candidate) => candidate.attention)
  );
  if (!anotherPaneNeedsAttention) cancelWindowAttentionFlash();
  return true;
}

function clearTabAttention(tab, { rerender = true } = {}) {
  if (!tab) return;
  let changed = false;
  for (const pane of tab.panes) {
    if (clearPaneAttention(pane, { rerender: false })) changed = true;
  }
  if (changed && rerender) renderTabStrip();
}

function schedulePaneAttentionScan(pane, delay = TERMINAL_ATTENTION_QUIET_MS) {
  if (!pane || pane.sessionId === null) return;
  if (pane.attnQuietTimer !== null && pane.attnQuietTimer !== undefined) {
    clearTimeout(pane.attnQuietTimer);
  }
  pane.attnQuietTimer = setTimeout(() => {
    pane.attnQuietTimer = null;
    evaluatePaneAttentionPrompt(pane);
  }, delay);
}

// Return only the live terminal screen. When viewportY is behind baseY the
// user is reading scrollback history, which must never be interpreted as a
// current prompt.
function paneLiveVisibleScreen(pane) {
  const buffer = pane?.term?.buffer?.active;
  return window.ZeroTermAttention?.terminalLiveVisibleText(
    buffer,
    pane?.term?.rows
  ) ?? null;
}

function evaluatePaneAttentionPrompt(pane) {
  if (!pane?.term || pane.sessionId === null) return;
  if (isPaneOnUserScreen(pane)) {
    const visibleScreen = paneLiveVisibleScreen(pane);
    if (visibleScreen !== null) pane.attnAcknowledgedScreen = visibleScreen;
    if (pane.attention === "prompt") clearPaneAttention(pane);
    return;
  }
  const screen = paneLiveVisibleScreen(pane);
  // A scrollback viewport is historical by definition. It can contain genuine
  // old approval dialogs, but they are not pending now.
  if (screen === null) {
    if (pane.attention === "prompt") clearPaneAttention(pane);
    return;
  }
  // Focusing/clicking ZeroTerm acknowledges the exact screen that caused the
  // alert. Do not flash again for it after the window loses focus.
  if (screen === pane.attnAcknowledgedScreen) return;
  const needsAttention = Boolean(
    screen && window.ZeroTermAttention?.terminalTextNeedsAttention(screen)
  );
  if (needsAttention) {
    triggerPaneAttention(pane, "prompt");
  } else if (pane.attention === "prompt") {
    // The waiting UI disappeared (for example the CLI continued or returned
    // to a shell prompt) while ZeroTerm remained in the background.
    clearPaneAttention(pane);
  }
}

function registerPaneAttentionHandlers(pane) {
  if (!pane?.term || pane.attnHandlerDisposes) return;
  const disposes = [];
  try {
    if (typeof pane.term.onBell === "function") {
      // BEL is also used for completion/error beeps, so it is not sufficient
      // evidence by itself. The normal output listener schedules the same
      // scan; doing it here also covers bells emitted without printable text.
      disposes.push(pane.term.onBell(() => schedulePaneAttentionScan(pane)));
    }
  } catch (e) {
    console.warn("bell handler registration failed", e);
  }
  const parser = pane.term.parser;
  if (parser?.registerOscHandler) {
    try {
      // OSC 9 — iTerm2/ConEmu-style desktop notification. Ignore the ConEmu
      // control subcommands shells emit routinely: "4;" taskbar progress and
      // "9;" cwd reporting (Windows Terminal).
      disposes.push(
        parser.registerOscHandler(9, (data) => {
          const message = String(data || "");
          if (
            !/^(?:4|9);/.test(message) &&
            window.ZeroTermAttention?.terminalTextNeedsAttention(message)
          ) {
            triggerPaneAttention(pane, "prompt");
          }
          return true;
        })
      );
      // OSC 777 — urxvt-style notification: "notify;title;body".
      disposes.push(
        parser.registerOscHandler(777, (data) => {
          const message = String(data || "");
          if (
            /^notify;/i.test(message) &&
            window.ZeroTermAttention?.terminalTextNeedsAttention(message)
          ) {
            triggerPaneAttention(pane, "prompt");
          }
          return true;
        })
      );
    } catch (e) {
      console.warn("attention OSC handler registration failed", e);
    }
  }
  pane.attnHandlerDisposes = disposes;
}

function disposePaneAttentionHandlers(pane) {
  if (!pane?.attnHandlerDisposes) return;
  for (const d of pane.attnHandlerDisposes) {
    try {
      d?.dispose?.();
    } catch {}
  }
  pane.attnHandlerDisposes = null;
}

// Called from renderTerminalWorkspace before the tab strip re-renders: clears
// the badge on the tab the user is now looking at, and gives the tab they just
// left an immediate prompt scan (its CLI may already be sitting on a menu).
function syncTerminalAttentionOnWorkspaceRender() {
  const activeId = termState.activeTabId;
  if (termAttentionLastActiveTabId !== activeId) {
    const prevTab = termState.tabs.find((tab) => tab.id === termAttentionLastActiveTabId);
    if (prevTab) {
      for (const pane of prevTab.panes) schedulePaneAttentionScan(pane, 0);
    }
    termAttentionLastActiveTabId = activeId;
  }
  if (workspaceMode === "terminal" && document.hasFocus()) {
    // Safety net in case the window regained focus without a DOM focus event:
    // a stale flash flag would otherwise block the next flash.
    cancelWindowAttentionFlash();
    clearTabAttention(getActiveTab(), { rerender: false });
  }
}

window.addEventListener("focus", () => {
  // Stop the taskbar flash whatever workspace the user lands in — they're back.
  cancelWindowAttentionFlash();
  // The user may land in AI/files rather than the terminal workspace. Mark
  // every current live screen as seen so the same prompt cannot immediately
  // restart the OS alert when the window is sent to the background again.
  for (const tab of termState.tabs) {
    for (const pane of tab.panes) {
      const visibleScreen = paneLiveVisibleScreen(pane);
      if (visibleScreen !== null) pane.attnAcknowledgedScreen = visibleScreen;
    }
  }
  if (workspaceMode !== "terminal") return;
  clearTabAttention(getActiveTab());
});

window.addEventListener("blur", () => {
  if (workspaceMode !== "terminal") return;
  const tab = getActiveTab();
  if (!tab) return;
  for (const pane of tab.panes) schedulePaneAttentionScan(pane, 0);
});

function renderTabStrip() {
  termTabStrip.innerHTML = "";

  for (const tab of termState.tabs) {
    const el = document.createElement("div");
    const needsAttention = tab.panes.some((pane) => pane.attention);
    el.className =
      "tab-item" +
      (tab.id === termState.activeTabId ? " active" : "") +
      (needsAttention ? " attention" : "");
    if (needsAttention) el.title = t("terminal.attention.tooltip");
    el.setAttribute("data-tauri-drag-region", "false");

    const title = document.createElement("span");
    title.textContent = tab.title;
    title.setAttribute("data-tauri-drag-region", "false");

    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.setAttribute("data-tauri-drag-region", "false");
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeTab(tab.id).catch((e) => {
        console.warn("closeTab failed", e);
      });
    });

    el.append(title, close);
    el.addEventListener("click", () => {
      termState.activeTabId = tab.id;
      setWorkspaceMode("terminal");
      renderTerminalWorkspace();
    });

    termTabStrip.appendChild(el);
  }

  updateTabOverflowControls();

  const activeTabEl = termTabStrip.querySelector(".tab-item.active");
  activeTabEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateTabOverflowControls() {
  if (!termTabStrip || !termTabScrollLeft || !termTabScrollRight) return;

  if (termState.tabs.length === 0) {
    termTabScrollLeft.hidden = true;
    termTabScrollRight.hidden = true;
    return;
  }

  const canOverflow = termTabStrip.scrollWidth > termTabStrip.clientWidth + 1;
  const maxScrollLeft = Math.max(0, termTabStrip.scrollWidth - termTabStrip.clientWidth);
  const scrollLeft = termTabStrip.scrollLeft;

  termTabScrollLeft.hidden = !canOverflow;
  termTabScrollRight.hidden = !canOverflow;
  termTabScrollLeft.disabled = !canOverflow || scrollLeft <= 1;
  termTabScrollRight.disabled = !canOverflow || scrollLeft >= maxScrollLeft - 1;
}

function scrollTermTabs(direction) {
  if (!termTabStrip) return;
  const distance = Math.max(180, Math.floor(termTabStrip.clientWidth * 0.65));
  termTabStrip.scrollBy({ left: direction * distance, behavior: "smooth" });
  window.setTimeout(updateTabOverflowControls, 220);
}

termTabScrollLeft?.addEventListener("click", () => scrollTermTabs(-1));
termTabScrollRight?.addEventListener("click", () => scrollTermTabs(1));
termTabStrip?.addEventListener("scroll", updateTabOverflowControls, { passive: true });
window.addEventListener("resize", updateTabOverflowControls);

function ensurePaneElements(pane, tab) {
  if (pane.rootEl) return;

  const root = document.createElement("div");
  root.className = "term-pane";

  const header = document.createElement("div");
  header.className = "pane-header";

  const title = document.createElement("span");
  title.className = "pane-title";
  title.textContent = pane.host
    ? (pane.isLocal
      ? t("terminal.pane.local_title")
      : `${pane.host.name} (${pane.host.user}@${pane.host.host}:${pane.host.port})`)
    : t("terminal.pane.empty");

  const status = document.createElement("span");
  status.className = "pane-status";
  status.textContent = t("terminal.status.connecting");

  const latency = document.createElement("span");
  latency.className = "pane-latency";
  latency.hidden = true;

  const reconnectBtn = document.createElement("button");
  reconnectBtn.type = "button";
  reconnectBtn.className = "pane-reconnect-btn";
  reconnectBtn.textContent = t("terminal.button.reconnect");
  reconnectBtn.hidden = true;
  reconnectBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const runReconnect = pane.reconnectFactory || (() => connectPaneSession(pane));
    runReconnect().catch((e) => {
      console.warn("reconnect failed", e);
    });
  });

  const meta = document.createElement("div");
  meta.className = "pane-meta";
  meta.append(latency, status, reconnectBtn);

  const body = document.createElement("div");
  body.className = "pane-body";

  const findBar = document.createElement("div");
  findBar.className = "pane-findbar";
  findBar.hidden = true;
  const findInput = document.createElement("input");
  findInput.type = "text";
  findInput.placeholder = "Search";
  const findCount = document.createElement("span");
  findCount.className = "pane-findbar-count";
  findCount.textContent = "0/0";
  const findPrev = document.createElement("button");
  findPrev.type = "button";
  findPrev.textContent = "↑";
  const findNext = document.createElement("button");
  findNext.type = "button";
  findNext.textContent = "↓";
  const findClose = document.createElement("button");
  findClose.type = "button";
  findClose.textContent = "✕";
  findBar.append(findInput, findCount, findPrev, findNext, findClose);

  header.append(title, meta);
  root.append(header, body, findBar);

  root.addEventListener("click", () => {
    if (tab.activePaneId !== pane.id) {
      tab.activePaneId = pane.id;
      renderTerminalWorkspace();
      return;
    }
    if (pane.term) pane.term.focus();
  });
  body.addEventListener("mousedown", () => {
    if (pane.term) pane.term.focus();
  });

  pane.rootEl = root;
  pane.bodyEl = body;
  pane.titleEl = title;
  pane.latencyEl = latency;
  pane.statusEl = status;
  pane.reconnectBtn = reconnectBtn;
  pane.findBarEl = findBar;
  pane.findInputEl = findInput;
  pane.findCountEl = findCount;

  findInput.addEventListener("input", () => {
    pane.searchQuery = findInput.value || "";
    pane.searchIndex = -1;
    if (!pane.searchQuery) {
      pane.searchMatches = [];
      if (pane.findCountEl) pane.findCountEl.textContent = "0/0";
      try {
        pane.term?.clearSelection?.();
      } catch {}
      try {
        pane.searchAddon?.clearDecorations?.();
      } catch {}
      return;
    }
    runPaneFind(pane, "next", { resetIndex: true });
  });
  findInput.addEventListener("mousedown", (ev) => ev.stopPropagation());
  findInput.addEventListener("click", (ev) => ev.stopPropagation());
  findInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      hidePaneFindBar(pane);
      pane.term?.focus();
      return;
    }
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    runPaneFind(pane, ev.shiftKey ? "prev" : "next");
  });
  findPrev.addEventListener("click", (ev) => {
    ev.stopPropagation();
    runPaneFind(pane, "prev");
  });
  findPrev.addEventListener("mousedown", (ev) => ev.stopPropagation());
  findNext.addEventListener("click", (ev) => {
    ev.stopPropagation();
    runPaneFind(pane, "next");
  });
  findNext.addEventListener("mousedown", (ev) => ev.stopPropagation());
  findClose.addEventListener("click", (ev) => {
    ev.stopPropagation();
    hidePaneFindBar(pane);
    pane.term?.focus();
  });
  findClose.addEventListener("mousedown", (ev) => ev.stopPropagation());
  findBar.addEventListener("mousedown", (ev) => ev.stopPropagation());
  findBar.addEventListener("click", (ev) => ev.stopPropagation());
}

function ensurePaneTerminal(pane) {
  if (pane.term || !pane.bodyEl || !pane.bodyEl.isConnected) return;

  pane.term = new Terminal({
    fontFamily: getTerminalFontFamily(),
    fontSize: getTerminalFontSize(),
    lineHeight: getTerminalLineHeight(),
    fontWeight: "400",
    fontWeightBold: "700",
    theme: getTerminalThemeConfig(),
    allowTransparency: true,
    // Off (1). This was once raised on macOS to compensate for the WebGL
    // renderer drawing dim text (e.g. zsh-autosuggestions) with reduced alpha,
    // but it also recoloured ordinary mid-contrast output and looked worse. The
    // Canvas renderer (used on macOS now) composites faint text correctly, like
    // the DOM renderer, so no contrast boosting is needed on any platform.
    minimumContrastRatio: 1,
    cursorBlink: true,
    allowProposedApi: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: false,
    scrollback: TERMINAL_SCROLLBACK,
    convertEol: false,
    reflowCursorLine: false,
  });

  pane.fitAddon = new FitAddon();
  pane.term.loadAddon(pane.fitAddon);
  if (SearchAddon) {
    try {
      pane.searchAddon = new SearchAddon();
      pane.term.loadAddon(pane.searchAddon);
    } catch (e) {
      console.warn("search addon init failed", e);
    }
  }
  if (WebLinksAddon) {
    try {
      const linksAddon = new WebLinksAddon((event, uri) => {
        if (!uri) return;
        // Mac: Cmd+Click; Windows/Linux: Ctrl+Click
        if (isMacPlatform ? !event?.metaKey : !event?.ctrlKey) return;
        event?.preventDefault?.();
        const url = /^https?:\/\//i.test(uri) ? uri : `http://${uri}`;
        invoke("plugin:opener|open_url", { url }).catch(() => {
          window.open(url, "_blank", "noopener");
        });
      });
      pane.term.loadAddon(linksAddon);
    } catch (e) {
      console.warn("weblinks addon init failed", e);
    }
  }
  installIpLinkProvider(pane);
  if (window.Unicode11Addon?.Unicode11Addon) {
    try {
      const unicode11Addon = new window.Unicode11Addon.Unicode11Addon();
      pane.term.loadAddon(unicode11Addon);
      pane.term.unicode.activeVersion = "11";
    } catch (e) {
      console.warn("unicode11 addon init failed", e);
    }
  }
  try {
    pane.term.open(pane.bodyEl);
    registerPaneOsc7Handler(pane);
    registerPaneAttentionHandlers(pane);
    // Use the Canvas renderer on macOS. Like WebGL it draws each glyph at an
    // absolute cell position, fixing the cumulative left-to-right character
    // drift the DOM renderer exhibits on Retina/macOS with a custom monospace
    // font (garbled lines when zsh redraws the input line on history recall).
    // Unlike WebGL it composites glyphs through a 2D context, so over a
    // transparent backdrop (glass mode, background image) text stays crisp
    // instead of developing the washed-out alpha halo WebGL produces — which
    // was the reported "blurry over bright parts of the wallpaper" problem.
    // Gated to macOS so the confirmed-good Windows DOM rendering is untouched.
    try {
      const CanvasAddonCtor = window.CanvasAddon?.CanvasAddon;
      if (isMacPlatform && CanvasAddonCtor) {
        const canvas = new CanvasAddonCtor();
        pane.term.loadAddon(canvas);
        pane.rendererAddon = canvas;
        // The renderer caches glyphs in a texture atlas built at the DPR/font
        // in effect when the addon loads — here, before the custom font has
        // finished loading and before the macOS window's devicePixelRatio has
        // settled. Rebuild the atlas once fonts are ready, and again on DPR
        // changes (dragging between Retina and an external display), so glyphs
        // are always rasterised at native resolution.
        rebuildRendererAtlasWhenReady(pane);
        observePaneDevicePixelRatio(pane);
      }
    } catch (e) {
      console.warn("canvas renderer unavailable, falling back to DOM renderer", e);
      pane.rendererAddon = null;
    }
    pane.bodyEl.addEventListener("contextmenu", (ev) => {
      const selected = pane.term?.getSelection?.() || "";
      if (!selected.trim()) {
        hideTerminalSelectionMenu();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      showTerminalSelectionMenu(pane, selected, ev.clientX, ev.clientY);
    });
    pane.bodyEl.addEventListener("wheel", (ev) => {
      if (!pane.term) return;
      if (!terminalSelectionMenu?.hidden) hideTerminalSelectionMenu();
      const cellHeight = pane.term?._core?._renderService?.dimensions?.css?.cell?.height || 18;
      const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / Math.max(1, cellHeight)));
      pane.term.scrollLines(ev.deltaY > 0 ? lines : -lines);
      syncPaneViewportScroll(pane);
      ev.preventDefault();
    }, { passive: false });
    applyTerminalThemeToAllPanes();
    requestPaneFit(pane, { immediate: true });
    pane.term.focus();
  } catch (e) {
    console.warn("terminal open/fit failed", e);
  }

  pane.term.onData((d) => {
    if (pane.attention) clearPaneAttention(pane);
    if (pane.sessionId === null) return;
    sendTextToPane(pane, d).catch((e) => {
      console.warn("send_input failed", e);
    });
  });

  pane.term.onScroll(() => {
    hideTerminalSelectionMenu();
    syncPaneViewportScroll(pane);
  });

  pane.term.onSelectionChange(() => {
    if (terminalSelectionMenuPaneId !== pane.id) return;
    const selected = pane.term?.getSelection?.() || "";
    if (!selected.trim()) hideTerminalSelectionMenu();
  });

  pane.term.attachCustomKeyEventHandler((ev) => {
    const key = ev.key?.toLowerCase?.();
    const isKeydown = ev.type === "keydown";

    // Robust clipboard shortcuts in terminal panes.
    // macOS: Cmd+C copies current selection; Cmd+V pastes from system clipboard.
    if (isMacPlatform && isKeydown && ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (key === "c") {
        const selected = pane.term?.getSelection?.() || "";
        if (selected) {
          ev.preventDefault();
          navigator.clipboard.writeText(selected).catch((e) => {
            console.warn("terminal copy failed", e);
          });
          return false;
        }
        return true;
      }
      if (key === "v") {
        // Prefer native paste path on macOS so WebView clipboard permissions
        // do not block Cmd+V when the terminal textarea is focused.
        return true;
      }
    }

    // Non-mac fallback: Ctrl+Shift+C / Ctrl+Shift+V
    if (!isMacPlatform && isKeydown && ev.ctrlKey && ev.shiftKey && !ev.metaKey && !ev.altKey) {
      if (key === "c") {
        const selected = pane.term?.getSelection?.() || "";
        if (selected) {
          ev.preventDefault();
          navigator.clipboard.writeText(selected).catch((e) => {
            console.warn("terminal copy failed", e);
          });
          return false;
        }
        return true;
      }
      if (key === "v") {
        // Keep native behavior first; this avoids a "blocked key with failed
        // clipboard read" dead path on some platforms/webviews.
        return true;
      }
    }

    const isF = ev.key?.toLowerCase?.() === "f";
    const withFindModifier = ev.ctrlKey || ev.metaKey;
    if (!isF || !withFindModifier || ev.type !== "keydown") return true;
    ev.preventDefault();
    openPaneFindPrompt(pane).catch((e) => console.warn("open find prompt failed", e));
    return false;
  });

  pane.resizeObserver = new ResizeObserver(() => {
    requestPaneFit(pane);
  });
  pane.resizeObserver.observe(pane.bodyEl);
}

function installIpLinkProvider(pane) {
  if (!pane?.term?.registerLinkProvider) return;
  if (pane.ipLinkProviderDispose) {
    try {
      pane.ipLinkProviderDispose.dispose();
    } catch {}
    pane.ipLinkProviderDispose = null;
  }

  const ipv4WithPort = /\b((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?(?:\/[\w\-./?%&=+#:]*)?)\b/g;
  const urlRegex = /\b((?:https?:\/\/|www\.)[^\s<>'"`]+)\b/g;
  pane.ipLinkProviderDispose = pane.term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = pane.term.buffer.active.getLine(y - 1);
      const text = line?.translateToString?.(true) || "";
      if (!text) return cb([]);

      const links = [];
      let um;
      while ((um = urlRegex.exec(text)) !== null) {
        const value = um[1];
        if (!value) continue;
        const start = um.index + 1;
        const end = start + value.length;
        links.push({
          range: {
            start: { x: start, y },
            end: { x: end, y },
          },
          text: value,
          activate: (event) => {
            if (isMacPlatform ? !event?.metaKey : !event?.ctrlKey) return;
            const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            invoke("plugin:opener|open_url", { url }).catch(() => {
              window.open(url, "_blank", "noopener");
            });
          },
        });
      }
      let m;
      while ((m = ipv4WithPort.exec(text)) !== null) {
        const value = m[1];
        if (!value) continue;
        const start = m.index + 1;
        const end = start + value.length;
        links.push({
          range: {
            start: { x: start, y },
            end: { x: end, y },
          },
          text: value,
          activate: (event) => {
            if (isMacPlatform ? !event?.metaKey : !event?.ctrlKey) return;
            const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            invoke("plugin:opener|open_url", { url }).catch(() => {
              window.open(url, "_blank", "noopener");
            });
          },
        });
      }
      cb(links);
    },
  });
}

function showPaneFindBar(pane) {
  if (!pane?.findBarEl || !pane?.findInputEl) return;
  if (pane.findBarEl.hidden && pane.statusEl) {
    pane.savedStatus = pane.statusEl.textContent;
  }
  pane.findBarEl.hidden = false;
  pane.findInputEl.value = pane.searchQuery || "";
  pane.findInputEl.focus();
  pane.findInputEl.select();
}

function hidePaneFindBar(pane) {
  if (!pane?.findBarEl) return;
  pane.findBarEl.hidden = true;
  pane.searchMatches = [];
  pane.searchIndex = -1;
  if (pane.findCountEl) pane.findCountEl.textContent = "0/0";
  if (pane.statusEl && pane.savedStatus != null) {
    pane.statusEl.textContent = pane.savedStatus;
    pane.savedStatus = null;
  }
  try {
    pane.term?.clearSelection?.();
  } catch {}
  try {
    pane.searchAddon?.clearDecorations?.();
  } catch {}
}

async function openPaneFindPrompt(pane) {
  if (!pane) return;
  showPaneFindBar(pane);
  if (!pane.searchQuery) return;
  runPaneFind(pane, "next", { resetIndex: true });
}

function countPaneMatches(pane, query) {
  if (!pane?.term || !query) return 0;
  const buf = pane.term.buffer?.active;
  if (!buf) return 0;
  const needle = String(query).toLowerCase();
  if (!needle) return 0;
  let total = 0;
  for (let y = 0; y < buf.length; y += 1) {
    const text = buf.getLine(y)?.translateToString?.(true)?.toLowerCase?.() || "";
    if (!text) continue;
    let i = 0;
    while (i <= text.length - needle.length) {
      const at = text.indexOf(needle, i);
      if (at < 0) break;
      total += 1;
      i = at + Math.max(needle.length, 1);
    }
  }
  return total;
}

function runPaneFind(pane, direction = "next", { resetIndex = false } = {}) {
  if (!pane?.term || !pane?.searchQuery) return false;
  if (!pane.searchAddon) {
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.search.unavailable");
    return false;
  }
  const q = pane.searchQuery;
  const opts = {
    caseSensitive: false,
    regex: false,
    incremental: false,
    decorations: {
      activeMatchColorOverviewRuler: "#7fb2ff",
      matchBackground: "rgba(127, 178, 255, 0.28)",
      matchBorder: "#7fb2ff",
      matchOverviewRuler: "rgba(127, 178, 255, 0.6)",
    },
  };
  if (resetIndex) {
    pane.searchIndex = -1;
  }

  let found = direction === "prev"
    ? pane.searchAddon.findPrevious(q, opts)
    : pane.searchAddon.findNext(q, opts);
  if (!found) {
    found = direction === "prev"
      ? pane.searchAddon.findNext(q, opts)
      : pane.searchAddon.findPrevious(q, opts);
  }
  const total = countPaneMatches(pane, q);
  if (!found) {
    pane.searchIndex = -1;
    pane.searchMatches = [];
    if (pane.statusEl) pane.statusEl.textContent = `no match: ${q}`;
    return false;
  }
  pane.searchMatches = new Array(total).fill(0);
  if (total > 0) {
    if (direction === "prev") {
      pane.searchIndex = pane.searchIndex <= 0 ? total - 1 : pane.searchIndex - 1;
    } else {
      pane.searchIndex = pane.searchIndex >= total - 1 ? 0 : pane.searchIndex + 1;
    }
  }
  if (pane.findCountEl) {
    pane.findCountEl.textContent = total > 0 ? `${pane.searchIndex + 1}/${total}` : `0/0`;
  }
  if (pane.statusEl) {
    pane.statusEl.textContent = total > 0 ? `find: ${q} (${total})` : `find: ${q}`;
  }
  return true;
}

function handleGlobalTerminalFindShortcut(ev) {
  const isF = ev.key?.toLowerCase?.() === "f";
  const withFindModifier = ev.ctrlKey || ev.metaKey;
  if (!isF || !withFindModifier) return;
  if (workspaceMode !== "terminal") return;
  const pane = getActivePane();
  if (!pane) return;
  ev.preventDefault();
  ev.stopPropagation();
  openPaneFindPrompt(pane).catch((e) => console.warn("open find prompt failed", e));
}

function handleGlobalTerminalFindNav(ev) {
  if (workspaceMode !== "terminal") return;
  const pane = getActivePane();
  if (!pane?.searchQuery) return;
  const isEnter = ev.key === "Enter";
  if (!isEnter) return;
  const inFindInput = ev.target === pane.findInputEl;
  if (!inFindInput && !ev.ctrlKey && !ev.metaKey) return;
  const isShift = ev.shiftKey;
  ev.preventDefault();
  ev.stopPropagation();
  runPaneFind(pane, isShift ? "prev" : "next");
}

function requestPaneFit(pane, { immediate = false } = {}) {
  if (!pane) return;

  if (immediate) {
    if (pane.pendingResizeTimer !== null) {
      clearTimeout(pane.pendingResizeTimer);
      pane.pendingResizeTimer = null;
    }
    if (pane.pendingFitRaf !== null) {
      cancelAnimationFrame(pane.pendingFitRaf);
      pane.pendingFitRaf = null;
    }
    fitPane(pane);
    return;
  }

  if (pane.pendingResizeTimer !== null) {
    clearTimeout(pane.pendingResizeTimer);
  }

  pane.pendingResizeTimer = setTimeout(() => {
    pane.pendingResizeTimer = null;
    if (pane.pendingFitRaf !== null) return;
    pane.pendingFitRaf = requestAnimationFrame(() => {
      pane.pendingFitRaf = null;
      fitPane(pane);
    });
  }, TERMINAL_RESIZE_DEBOUNCE_MS);
}

function fitPane(pane) {
  if (!pane.term || !pane.fitAddon) return;
  clampPaneBodyHeight(pane);
  try {
    pane.fitAddon.fit();
  } catch {
    return;
  }
  syncPaneViewportScroll(pane);
  if (pane.sessionId !== null) {
    const { cols, rows } = pane.term;
    if (cols === pane.lastSentCols && rows === pane.lastSentRows) return;
    pane.lastSentCols = cols;
    pane.lastSentRows = rows;
    invoke("resize_session", {
      sessionId: pane.sessionId,
      cols,
      rows,
    }).catch(() => {});
  }
}

function clampPaneBodyHeight(pane) {
  const body = pane?.bodyEl;
  const root = pane?.rootEl;
  if (!body || !root) return;
  const headerHeight = root.querySelector?.(".pane-header")?.getBoundingClientRect?.().height || 0;
  const availableHeight = Math.floor(root.getBoundingClientRect().height - headerHeight);
  if (availableHeight > 0) body.style.height = `${availableHeight}px`;
}

function syncPaneViewportScroll(pane) {
  const viewport = pane?.bodyEl?.querySelector?.(".xterm-viewport");
  const buffer = pane?.term?.buffer?.active;
  const term = pane?.term;
  if (!viewport || !buffer || !term) return;
  const bottomY = Math.max(0, buffer.baseY + buffer.cursorY);
  const bufferAtBottom = Math.abs(buffer.viewportY + term.rows - 1 - bottomY) <= 1;
  if (bufferAtBottom) {
    const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    if (Math.abs(viewport.scrollTop - maxTop) > 1) viewport.scrollTop = maxTop;
    return;
  }
  const lineHeight = pane.term?._core?._renderService?.dimensions?.css?.cell?.height || 0;
  if (lineHeight <= 0) return;
  const expectedTop = Math.max(0, buffer.viewportY * lineHeight);
  if (Math.abs(viewport.scrollTop - expectedTop) > 1) viewport.scrollTop = expectedTop;
}

function isPaneTerminalNearBottom(pane) {
  const buffer = pane?.term?.buffer?.active;
  if (!buffer || !pane?.term) return true;
  const bottomY = Math.max(0, buffer.baseY + buffer.cursorY);
  return Math.abs(buffer.viewportY + pane.term.rows - 1 - bottomY) <= 1;
}

function keepPaneTerminalAtBottom(pane, { force = false } = {}) {
  if (!pane?.term) return;
  if (!force && !isPaneTerminalNearBottom(pane)) return;
  requestAnimationFrame(() => {
    if (!pane.term) return;
    pane.term.scrollToBottom();
    syncPaneViewportScroll(pane);
  });
}

function refreshPaneTerminal(pane) {
  if (!pane?.term) return;
  try {
    pane.term.refresh(0, Math.max(0, pane.term.rows - 1));
  } catch {
    // Older xterm builds may not expose refresh; writes still proceed normally.
  }
}

function writePaneTerminalData(pane, data, { stickToBottom = false, onParsed = null } = {}) {
  if (!pane?.term) return;
  pane.term.write(data, () => {
    if (!pane.term) return;
    if (stickToBottom) pane.term.scrollToBottom();
    syncPaneViewportScroll(pane);
    refreshPaneTerminal(pane);
    if (typeof onParsed === "function") onParsed();
  });
}

function parseOsc7Path(data) {
  const raw = String(data || "").trim().replace(/^;+/, "");
  if (!raw) return null;

  if (raw.startsWith("/")) {
    return normalizeAbsolutePath(decodeURIComponent(raw));
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "file:") return null;
    return normalizeAbsolutePath(decodeURIComponent(url.pathname || "/"));
  } catch {
    return null;
  }
}

function handleTerminalOsc7(pane, data) {
  if (!pane?.host?.id || pane.isLocal) return true;
  const cwd = parseOsc7Path(data);
  if (!cwd || cwd === "/") return true;

  for (const sftpPane of Object.values(sftpPanes)) {
    if (!sftpPane || isLocalPane(sftpPane) || sftpPane.sftpId === null) continue;
    if (sftpPane.host?.id !== pane.host.id) continue;
    if (sftpPane.followLockedByUser) continue;
    if (samePanePath(sftpPane, sftpPane.path, cwd)) continue;
    navigateSftpPane(sftpPane, cwd, { source: "follow" }).catch((e) => {
      console.warn("OSC 7 follow navigation failed", e);
    });
  }
  return true;
}

function registerPaneOsc7Handler(pane) {
  if (!pane?.term?.parser?.registerOscHandler || pane.osc7HandlerDispose) return;
  try {
    pane.osc7HandlerDispose = pane.term.parser.registerOscHandler(7, (data) =>
      handleTerminalOsc7(pane, data)
    );
  } catch (e) {
    console.warn("OSC 7 handler registration failed", e);
    pane.osc7HandlerDispose = null;
  }
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let terminalFontsReadyPromise = null;

function refreshPaneFontMetrics(pane) {
  const term = pane?.term;
  const core = term?._core;
  if (!term || !core) return;
  try {
    // xterm measures cell geometry when the terminal opens. If our bundled
    // web font finishes loading afterwards, the renderer can repaint glyphs
    // with the new font while selection/hit-testing still uses fallback-font
    // cell metrics for a frame or longer. Re-measure first, then rebuild the
    // renderer dimensions from those updated character metrics.
    core._charSizeService?.measure?.();
    core._renderService?.handleResize?.(term.cols, term.rows);
  } catch (e) {
    console.warn("terminal font metric refresh failed", e);
  }
}

/// Force the active renderer (Canvas/WebGL) to re-rasterise its glyph texture
/// atlas once the custom terminal font is actually loaded. Without this the
/// atlas keeps the fallback-font glyphs baked in at load time and text stays
/// blurry.
function rebuildRendererAtlasWhenReady(pane) {
  waitForTerminalFonts()
    .then(() => {
      // The pane may have been torn down meanwhile.
      if (!pane.term) return;
      try {
        refreshPaneFontMetrics(pane);
        pane.rendererAddon?.clearTextureAtlas?.();
        // Canvas's clearTextureAtlas only drops the cache; force a redraw so
        // the now-correct glyphs are repainted (WebGL self-requests one).
        requestPaneFit(pane, { immediate: true });
        refreshPaneTerminal(pane);
      } catch (e) {
        console.warn("renderer atlas rebuild failed", e);
      }
    })
    .catch(() => {});
}

/// Watch for devicePixelRatio changes (display switch, OS zoom) and rebuild the
/// renderer atlas each time so glyphs are re-rasterised at the new native
/// resolution instead of being scaled up blurry. `matchMedia` resolution
/// queries fire once per change, so we re-arm a fresh listener after each hit.
function observePaneDevicePixelRatio(pane) {
  if (typeof window.matchMedia !== "function") return;
  const arm = () => {
    if (!pane.term || !pane.rendererAddon) return;
    const dpr = window.devicePixelRatio || 1;
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      if (pane.term && pane.rendererAddon) {
        try {
          pane.rendererAddon.clearTextureAtlas();
          refreshPaneTerminal(pane);
        } catch (e) {
          console.warn("renderer atlas rebuild on dpr change failed", e);
        }
      }
      arm(); // re-arm for the next DPR value
    };
    try {
      mql.addEventListener("change", onChange, { once: true });
    } catch {
      // Safari/WebKit fallback: older addListener signature.
      const legacy = () => {
        mql.removeListener(legacy);
        onChange();
      };
      mql.addListener(legacy);
    }
    pane.dprMediaQuery = mql;
  };
  arm();
}

async function waitForTerminalFonts() {
  if (terminalFontsReadyPromise) return terminalFontsReadyPromise;
  terminalFontsReadyPromise = (async () => {
    if (!document.fonts || typeof document.fonts.ready === "undefined") return;
    try {
      await Promise.allSettled([
        document.fonts.load('13px "ZeroTerm Meslo NF"'),
        document.fonts.load('700 13px "ZeroTerm Meslo NF"'),
        document.fonts.load('italic 13px "ZeroTerm Meslo NF"'),
        document.fonts.load('italic 700 13px "ZeroTerm Meslo NF"'),
      ]);
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);
    } catch {
      // Ignore font readiness failures and continue with fallback metrics.
    }
  })();
  return terminalFontsReadyPromise;
}

async function stabilizePaneSize(pane, rounds = 2) {
  if (!pane.term || !pane.fitAddon) return;
  for (let i = 0; i < rounds; i += 1) {
    await nextFrame();
    refreshPaneFontMetrics(pane);
    fitPane(pane);
  }
}

async function preparePaneTerminalForSession(pane, rounds = 2) {
  if (!pane?.term) return;
  await waitForTerminalFonts();
  refreshPaneFontMetrics(pane);
  await stabilizePaneSize(pane, rounds);
}

async function connectPaneSession(pane) {
  if (!pane.host) return;
  if (!pane.bodyEl || !pane.bodyEl.isConnected) {
    renderTerminalWorkspace();
    await nextFrame();
  }
  ensurePaneTerminal(pane);
  if (!pane.term) {
    renderTerminalWorkspace();
    await nextFrame();
    ensurePaneTerminal(pane);
  }
  if (!pane.term) {
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.error.connect_failed_status", { error: "terminal init failed" });
    return;
  }
  await preparePaneTerminalForSession(pane, 2);

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
    pane.lastSentCols = cols;
    pane.lastSentRows = rows;
    pane.statusEl.textContent = t("terminal.status.connected");
    if (pane.latencyEl) pane.latencyEl.hidden = true;
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;

    await wirePaneSessionEvents(pane, sessionId);
    await stabilizePaneSize(pane, 1);

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

    // The backend may persist detected remote OS during connect.
    // Pull latest host summaries so badges can refresh without restart.
    refreshHostsCacheFromVault({ silent: true }).catch(() => {});
  } catch (e) {
    pane.statusEl.textContent = t("terminal.error.connect_failed_status", { error: e });
    if (pane.latencyEl) pane.latencyEl.hidden = true;
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = false;
    if (pane.term) {
      writePaneTerminalData(pane, `\x1b[31m${t("terminal.error.connect_failed_term", { error: e })}\x1b[0m\r\n`, { stickToBottom: true });
    }
  }
}

async function wirePaneSessionEvents(pane, sessionId) {
  if (pane.dataUnlisten) {
    pane.dataUnlisten();
    pane.dataUnlisten = null;
  }
  if (pane.latencyUnlisten) {
    pane.latencyUnlisten();
    pane.latencyUnlisten = null;
  }
  if (pane.latencyStoppedUnlisten) {
    pane.latencyStoppedUnlisten();
    pane.latencyStoppedUnlisten = null;
  }
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }
  stopPaneAliveWatchdog(pane);

  // Liveness watchdog. The backend streams an RTT probe every 3s; once that
  // stream has started, silence (no latency AND no data events) means the
  // link is stalling even though no `session:closed` has arrived yet — the
  // backend needs ~20s of consecutive probe timeouts before it declares
  // death. Downgrade the status to "unresponsive" in the meantime so the
  // user isn't staring at a stale "connected". Armed only after the first
  // latency event: servers that refuse extra session channels never emit
  // any, and the backend tells us via `session:latency-stopped` when it
  // gives up on probing, so we don't misread that silence as a hang.
  pane.lastAliveAt = Date.now();
  pane.aliveWatchdogArmed = false;
  const markPaneAlive = () => {
    pane.lastAliveAt = Date.now();
    if (pane.unresponsiveSince == null) return;
    pane.unresponsiveSince = null;
    if (pane.statusEl && pane.preUnresponsiveStatus != null) {
      pane.statusEl.textContent = pane.preUnresponsiveStatus;
    }
    pane.preUnresponsiveStatus = null;
  };
  const UNRESPONSIVE_AFTER_MS = 12000;
  pane.aliveWatchdogTimer = setInterval(() => {
    if (!pane.aliveWatchdogArmed || pane.sessionId !== sessionId) return;
    if (pane.unresponsiveSince != null) return;
    if (Date.now() - pane.lastAliveAt < UNRESPONSIVE_AFTER_MS) return;
    pane.unresponsiveSince = Date.now();
    if (pane.statusEl) {
      pane.preUnresponsiveStatus = pane.statusEl.textContent;
      pane.statusEl.textContent = t("terminal.status.unresponsive");
    }
  }, 3000);

  pane.dataUnlisten = await listen("session:data", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    markPaneAlive();
    if (!pane.term) return;
    const stickToBottom = isPaneTerminalNearBottom(pane);
    writePaneTerminalData(pane, new Uint8Array(ev.payload.data), {
      stickToBottom,
      // xterm parses writes asynchronously. Start the quiet-period timer only
      // after this chunk is reflected in its buffer; otherwise a short final
      // prompt can be scanned before it exists on screen.
      onParsed: () => {
        if (pane.sessionId === sessionId) schedulePaneAttentionScan(pane);
      },
    });
  });

  pane.latencyUnlisten = await listen("session:latency", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    pane.aliveWatchdogArmed = true;
    markPaneAlive();
    if (!pane.latencyEl) return;
    const rtt = Number(ev.payload.rttMs);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    pane.latencyEl.textContent = `${Math.round(rtt)}ms`;
    pane.latencyEl.hidden = false;
  });

  pane.latencyStoppedUnlisten = await listen("session:latency-stopped", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    // Probe permanently disabled server-side — its silence no longer means
    // anything, so stop watching and drop the stale RTT reading.
    pane.aliveWatchdogArmed = false;
    markPaneAlive();
    if (pane.latencyEl) pane.latencyEl.hidden = true;
  });

  pane.closedUnlisten = await listen("session:closed", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    const tail = ev.payload.message
      ? `\r\n\x1b[31m${ev.payload.message}\x1b[0m\r\n`
      : ev.payload.exitCode != null
        ? `\r\n\x1b[2m${t("terminal.closed.remote_exited", { code: ev.payload.exitCode })}\x1b[0m\r\n`
        : `\r\n\x1b[2m${t("terminal.closed.disconnected")}\x1b[0m\r\n`;

    pane.sessionId = null;
    stopPaneAliveWatchdog(pane);
    clearPaneAttention(pane);
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.status.disconnected");
    if (pane.latencyEl) pane.latencyEl.hidden = true;
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = false;
    if (pane.term) writePaneTerminalData(pane, tail, { stickToBottom: true });
  });

}

function stopPaneAliveWatchdog(pane) {
  if (pane.aliveWatchdogTimer != null) {
    clearInterval(pane.aliveWatchdogTimer);
    pane.aliveWatchdogTimer = null;
  }
  pane.aliveWatchdogArmed = false;
  pane.unresponsiveSince = null;
  pane.preUnresponsiveStatus = null;
}

async function disconnectPaneSession(pane, { dispose }) {
  const sid = pane.sessionId;
  pane.sessionId = null;
  pane.lastSentCols = 0;
  pane.lastSentRows = 0;
  clearPaneAttention(pane, { rerender: false });

  if (sid !== null) {
    try {
      await invoke("disconnect_session", { sessionId: sid });
    } catch (e) {
      console.warn("disconnect_session failed", e);
    }
    // FE-3: the session key is dead the moment its session is torn down —
    // including the reconnect path, which mints a fresh session id. Drop its
    // per-session AI/side-panel Map entries so they don't accumulate.
    forgetAiPaneState(`session:${sid}`);
  }

  if (pane.dataUnlisten) {
    pane.dataUnlisten();
    pane.dataUnlisten = null;
  }
  if (pane.latencyUnlisten) {
    pane.latencyUnlisten();
    pane.latencyUnlisten = null;
  }
  if (pane.latencyStoppedUnlisten) {
    pane.latencyStoppedUnlisten();
    pane.latencyStoppedUnlisten = null;
  }
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }
  stopPaneAliveWatchdog(pane);

  if (dispose) {
    if (pane.pendingResizeTimer !== null) {
      clearTimeout(pane.pendingResizeTimer);
    }
    pane.pendingResizeTimer = null;
    if (pane.pendingFitRaf !== null) {
      cancelAnimationFrame(pane.pendingFitRaf);
    }
    pane.pendingFitRaf = null;

    if (pane.resizeObserver && pane.bodyEl) {
      pane.resizeObserver.disconnect();
    }
    pane.resizeObserver = null;

    if (pane.osc7HandlerDispose) {
      try {
        pane.osc7HandlerDispose.dispose?.();
      } catch {}
      pane.osc7HandlerDispose = null;
    }

    disposePaneAttentionHandlers(pane);

    if (pane.term) pane.term.dispose();
    pane.term = null;
    pane.fitAddon = null;
    pane.rendererAddon = null;
    if (pane.dprMediaQuery) {
      // Listener was added with { once: true } / addListener; drop our
      // reference so a pending (not-yet-fired) listener can't rebuild an atlas
      // on a disposed pane. The once-listener itself also guards on pane.term.
      pane.dprMediaQuery = null;
    }
    if (pane.ipLinkProviderDispose) {
      try {
        pane.ipLinkProviderDispose.dispose();
      } catch {}
      pane.ipLinkProviderDispose = null;
    }

    if (pane.rootEl?.parentNode) pane.rootEl.parentNode.removeChild(pane.rootEl);
    pane.rootEl = null;
    pane.bodyEl = null;
    pane.titleEl = null;
    pane.latencyEl = null;
    pane.statusEl = null;
    pane.reconnectBtn = null;
  }
}

async function closeTab(tabId) {
  const idx = termState.tabs.findIndex((t) => t.id === tabId);
  if (idx < 0) return;
  const tab = termState.tabs[idx];

  await Promise.all(tab.panes.map((pane) => disconnectPaneSession(pane, { dispose: true })));

  // FE-3: the panes are disposed for good, so also drop the Map entries keyed
  // by their disconnected-state `pane:${id}` key. (Their `session:${sid}`
  // entries were already evicted inside disconnectPaneSession.)
  for (const pane of tab.panes) forgetAiPaneState(`pane:${pane.id}`);

  termState.tabs.splice(idx, 1);

  if (termState.tabs.length === 0) {
    termState.activeTabId = null;
  } else if (termState.activeTabId === tabId) {
    termState.activeTabId = termState.tabs[Math.max(0, idx - 1)].id;
  }

  renderTabStrip();

  if (termState.tabs.length === 0) {
    setWorkspaceMode("vaults");
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

async function closeActiveSplit() {
  const tab = getActiveTab();
  if (!tab || tab.panes.length <= 1) return;

  const active = getActivePane();
  let removeIndex = tab.panes.findIndex((p) => p.id === active?.id);
  if (removeIndex < 0) removeIndex = tab.panes.length - 1;
  const pane = tab.panes[removeIndex];

  await disconnectPaneSession(pane, { dispose: true });
  // FE-3: pane disposed for good — drop its disconnected-state `pane:${id}`
  // Map entries (session key already evicted inside disconnectPaneSession).
  forgetAiPaneState(`pane:${pane.id}`);
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
const hkAcceptOnce = document.getElementById("hk-accept-once");
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
    hkAcceptOnce.hidden = true;
    hkAccept.textContent = t("host_key.accept");
  } else {
    hkTitle.textContent = t("host_key.changed_title");
    hkBody.textContent = t("host_key.changed_body");
    hkDetail.textContent =
      `${t("host_key.changed_server_now")}\n  ${currentHostKey.keyType} ${currentHostKey.fingerprint}\n` +
      `${t("host_key.changed_known_hosts_has")}\n  ${currentHostKey.stored ?? t("host_key.unknown_value")}`;
    hkAcceptOnce.hidden = false;
    hkAccept.textContent = t("host_key.accept_replace");
  }

  hkOverlay.hidden = false;
});

listen("host:os_type_updated", () => {
  refreshHostsCacheFromVault({ silent: true }).catch(() => {});
});

// A port forward changed state on the backend (started, stopped, passively
// disconnected, or auto-reconnected). Refresh the page live if it's showing.
listen("port-forward:changed", () => {
  if (workspaceMode === "port-forward") {
    loadPortForwardPage().catch((e) => console.warn("port-forward refresh failed", e));
  }
});

hkAccept.addEventListener("click", () => {
  const mode = currentHostKey?.kind === "mismatch" ? "accept_and_replace" : null;
  respondHostKey(true, mode);
});
hkAcceptOnce?.addEventListener("click", () => respondHostKey(true, "accept_once"));
hkReject.addEventListener("click", () => respondHostKey(false));

async function respondHostKey(accept, mode = null) {
  if (!currentHostKey) return;
  const id = currentHostKey.requestId;
  currentHostKey = null;
  hkOverlay.hidden = true;
  try {
    await invoke("respond_host_key", { requestId: id, accept, mode });
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
const hfGroup = document.getElementById("hf-group");
const hfPasswordBlock = document.getElementById("hf-password-block");
const hfPassword = document.getElementById("hf-password");
const hfPasswordToggle = document.getElementById("hf-password-toggle");
const hfKeyBlock = document.getElementById("hf-key-block");
const hfKeyPick = document.getElementById("hf-key-pick");
const hfKeyStatus = document.getElementById("hf-key-status");
const hfKeyPassphrase = document.getElementById("hf-key-passphrase");
const hfKeyPassphraseToggle = document.getElementById("hf-key-passphrase-toggle");
const hfJump = document.getElementById("hf-jump");
let hfForwardsList = document.getElementById("hf-forwards");
const hfForwardAdd = document.getElementById("hf-forward-add");
const hostError = document.getElementById("host-edit-error");
const hostReadonly = document.getElementById("host-edit-readonly");
const hostSecretRevealOverlay = document.getElementById("host-secret-reveal-overlay");
const hostSecretRevealForm = document.getElementById("host-secret-reveal-form");
const hostSecretRevealPassword = document.getElementById("host-secret-reveal-password");
const hostSecretRevealError = document.getElementById("host-secret-reveal-error");
const hostSecretRevealCancel = document.getElementById("host-secret-reveal-cancel");

let editingHostId = null;
let hfKeyPem = null;
let hfForwards = [];
let resolveHostSecretReveal = null;

hfAuthType.addEventListener("change", () => syncAuthSections());
hfKeyPick.addEventListener("click", pickKeyFile);
function syncPasswordToggleButton(button, visible, labels) {
  if (!button) return;
  button.innerHTML = visible
    ? "<svg class=\"zt-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M3 3l18 18\"></path><path d=\"M2 12s3.5-6 10-6c1.8 0 3.3.4 4.6 1\"></path><path d=\"M22 12s-3.5 6-10 6c-1.8 0-3.3-.4-4.6-1\"></path><circle cx=\"12\" cy=\"12\" r=\"3.2\"></circle></svg>"
    : "<svg class=\"zt-icon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path d=\"M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z\"></path><circle cx=\"12\" cy=\"12\" r=\"3.2\"></circle></svg>";
  const title = visible ? labels.hide : labels.show;
  button.setAttribute("title", title);
  button.setAttribute("aria-label", title);
}

hfPasswordToggle?.addEventListener("click", async () => {
  if (!hfPassword.value && editingHostId) {
    await revealHostCredential("password");
    return;
  }
  const show = hfPassword.type === "password";
  hfPassword.type = show ? "text" : "password";
  syncPasswordToggleButton(hfPasswordToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
hfKeyPassphraseToggle?.addEventListener("click", async () => {
  if (!hfKeyPassphrase.value && editingHostId) {
    await revealHostCredential("keyPassphrase");
    return;
  }
  const show = hfKeyPassphrase.type === "password";
  hfKeyPassphrase.type = show ? "text" : "password";
  syncPasswordToggleButton(hfKeyPassphraseToggle, show, { show: "显示口令", hide: "隐藏口令" });
});

function closeHostSecretReveal(masterPassword = null) {
  hostSecretRevealOverlay.hidden = true;
  hostSecretRevealPassword.value = "";
  const resolve = resolveHostSecretReveal;
  resolveHostSecretReveal = null;
  resolve?.(masterPassword);
}

function requestHostSecretRevealPassword() {
  hostSecretRevealError.hidden = true;
  hostSecretRevealError.textContent = "";
  hostSecretRevealPassword.value = "";
  hostSecretRevealOverlay.hidden = false;
  hostSecretRevealPassword.focus();
  return new Promise((resolve) => {
    resolveHostSecretReveal = resolve;
  });
}

hostSecretRevealCancel?.addEventListener("click", () => closeHostSecretReveal());
hostSecretRevealForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const password = hostSecretRevealPassword.value;
  if (!password) {
    hostSecretRevealError.textContent = "请输入主密码。";
    hostSecretRevealError.hidden = false;
    return;
  }
  closeHostSecretReveal(password);
});

async function revealHostCredential(kind) {
  if (!editingHostId) return;
  const masterPassword = await requestHostSecretRevealPassword();
  if (masterPassword === null) return;
  try {
    const credential = await invoke("reveal_host_credential", {
      id: editingHostId,
      kind,
      masterPassword,
    });
    const input = kind === "password" ? hfPassword : hfKeyPassphrase;
    const toggle = kind === "password" ? hfPasswordToggle : hfKeyPassphraseToggle;
    input.value = credential;
    input.type = "text";
    syncPasswordToggleButton(toggle, true, kind === "password"
      ? { show: "显示密码", hide: "隐藏密码" }
      : { show: "显示口令", hide: "隐藏口令" });
  } catch (e) {
    showHostError(String(e));
  }
}
settingsSyncPasswordToggle?.addEventListener("click", () => {
  if (!settingsSyncPassword) return;
  const show = settingsSyncPassword.type === "password";
  settingsSyncPassword.type = show ? "text" : "password";
  syncPasswordToggleButton(settingsSyncPasswordToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
settingsSyncEncPasswordToggle?.addEventListener("click", () => {
  if (!settingsSyncEncPassword) return;
  const show = settingsSyncEncPassword.type === "password";
  settingsSyncEncPassword.type = show ? "text" : "password";
  syncPasswordToggleButton(settingsSyncEncPasswordToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
settingsSyncS3SkToggle?.addEventListener("click", () => {
  if (!settingsSyncS3Sk) return;
  const show = settingsSyncS3Sk.type === "password";
  settingsSyncS3Sk.type = show ? "text" : "password";
  syncPasswordToggleButton(settingsSyncS3SkToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
settingsSyncS3StToggle?.addEventListener("click", () => {
  if (!settingsSyncS3St) return;
  const show = settingsSyncS3St.type === "password";
  settingsSyncS3St.type = show ? "text" : "password";
  syncPasswordToggleButton(settingsSyncS3StToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
hfForwardAdd?.addEventListener("click", () => {
  hfForwards.push({
    kind: "local",
    enabled: true,
    bindAddr: "127.0.0.1",
    bindPort: "",
    targetHost: "",
    targetPort: "",
  });
  renderForwards();
});
document.getElementById("host-edit-cancel").addEventListener("click", closeHostEditor);
hostForm.addEventListener("submit", saveHostForm);

async function openHostEditor(id = null, defaultGroupId = "") {
  editingHostId = id;
  hostError.hidden = true;
  hostError.textContent = "";
  hostReadonly.hidden = true;
  hostReadonly.textContent = "";
  hfKeyPem = null;
  hfKeyStatus.textContent = t("host_editor.key.none");
  hfPassword.value = "";
  hfKeyPassphrase.value = "";
  hfPassword.placeholder = id ? "已保存；点击眼睛并验证主密码后显示" : "";
  hfKeyPassphrase.placeholder = id ? "已保存；点击眼睛并验证主密码后显示" : "";
  if (hfPassword) hfPassword.type = "password";
  if (hfKeyPassphrase) hfKeyPassphrase.type = "password";
  syncPasswordToggleButton(hfPasswordToggle, false, { show: "显示密码", hide: "隐藏密码" });
  syncPasswordToggleButton(hfKeyPassphraseToggle, false, { show: "显示口令", hide: "隐藏口令" });
  hfForwards = [];
  await reloadHostGroupsFromVault();

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

      populateHostGroupOptions(h.groupId || "");

      hfJump.value = h.proxyJumpHostId ?? "";
      hfForwards = [];
    } catch (e) {
      hostError.textContent = t("host_editor.error.load_failed", { error: e });
      hostError.hidden = false;
    }
  } else {
    hostTitle.textContent = t("host_editor.title.add");
    hfName.value = "";
    hfHost.value = "";
    hfPort.value = "22";
    hfUser.value = "root";
    hfAuthType.value = "password";
    populateHostGroupOptions(defaultGroupId || "");
    hfJump.value = "";
  }

  syncAuthSections();
  renderForwards();
  hostOverlay.hidden = false;
  hfName.focus();
}

function closeHostEditor() {
  if (!hostSecretRevealOverlay.hidden) closeHostSecretReveal();
  hostOverlay.hidden = true;
  editingHostId = null;
  hfKeyPem = null;
  hfForwards = [];
  hostForm.reset();
}

async function populateJumpOptions(currentId) {
  hfJump.dataset.emptyDisplay = "";
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
      opt.value = h.id;
      opt.textContent = `${h.name} (${h.user}@${h.host}:${h.port})`;
      hfJump.appendChild(opt);
    }
  } catch (e) {
    console.warn("populateJumpOptions failed", e);
  }

  syncCustomSelect("hf-jump");
}

function forwardFromIO(spec) {
  const enabled = spec?.enabled !== false;
  const bindAddr = spec?.bindAddr ?? spec?.bind_addr ?? "";
  const bindPort = spec?.bindPort ?? spec?.bind_port ?? "";
  const targetHost = spec?.targetHost ?? spec?.target_host ?? "";
  const targetPort = spec?.targetPort ?? spec?.target_port ?? "";
  const kind =
    spec?.kind ||
    spec?.type ||
    (targetHost || targetPort ? "local" : "dynamic");

    if (kind === "local" || kind === "remote") {
      return {
        kind,
        enabled,
        bindAddr,
      bindPort: String(bindPort),
      targetHost,
      targetPort: String(targetPort),
    };
  }
  return {
    kind: "dynamic",
    enabled,
    bindAddr,
    bindPort: String(bindPort),
  };
}

function renderForwards(listEl = hfForwardsList, forwards = hfForwards, rerender = renderForwards) {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (forwards.length === 0) {
    const empty = document.createElement("li");
    empty.style.gridTemplateColumns = "1fr";
    empty.style.color = "var(--muted)";
    empty.textContent = t("host_editor.hint.forwards");
    listEl.appendChild(empty);
    return;
  }

  forwards.forEach((fwd, idx) => {
    const li = document.createElement("li");

    const enabledRow = document.createElement("label");
    enabledRow.className = "checkbox slim";
    enabledRow.style.gridColumn = "1 / -1";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = fwd.enabled !== false;
    enabledInput.addEventListener("change", () => {
      fwd.enabled = enabledInput.checked;
    });
    enabledInput.setAttribute("aria-label", t("host_editor.forward.enabled"));
    enabledInput.setAttribute("title", t("host_editor.forward.enabled"));
    enabledRow.append(enabledInput);
    li.appendChild(enabledRow);

    const kind = document.createElement("select");
    [["local", t("host_editor.forward.local")], ["remote", t("host_editor.forward.remote")], ["dynamic", t("host_editor.forward.dynamic")]].forEach(([v, label]) => {
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
      rerender();
    });
    li.appendChild(kind);
    buildCustomSelect(kind);

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

    if (fwd.kind === "local" || fwd.kind === "remote") {
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
      forwards.splice(idx, 1);
      rerender();
    });

    li.append(fields, remove);
    listEl.appendChild(li);
  });
}

function syncAuthSections() {
  const t = hfAuthType.value;
  hfPasswordBlock.hidden = t !== "password";
  hfKeyBlock.hidden = t !== "key";
}

async function pickKeyFile() {
  // Backend picker authorizes the path for read_local_text_file.
  const chosen = await invoke("pick_local_file", {
    title: t("host_editor.key.pick_title"),
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
  if (!editingHostId && !hfKeyPem) {
    showHostError(t("host_editor.error.pick_key_first"));
    return null;
  }
  return {
    type: "private_key",
    // On edit, omit the key unless the user explicitly selected a
    // replacement. The backend preserves the stored key in that case.
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

  let resolvedGroupId = hfGroup?.value || null;
  const customGroupName = String(hfGroup?.dataset.customValue || "").trim();
  if (customGroupName) {
    const existing = hostGroups.find((group) => String(group.name || "").trim() === customGroupName);
    if (existing) {
      resolvedGroupId = existing.id;
    } else {
      resolvedGroupId = await invoke("create_host_group", {
        input: { name: customGroupName, parentId: null, sortOrder: 0 },
      });
      await reloadHostGroupsFromVault();
      populateHostGroupOptions(resolvedGroupId || "");
    }
  }

  const input = {
    name: hfName.value.trim(),
    host: hfHost.value.trim(),
    port: parseInt(hfPort.value, 10),
    user: hfUser.value.trim(),
    auth,
    forwards: [],
    proxyJumpHostId: hfJump.value || null,
    groupId: resolvedGroupId || null,
  };

  if (!input.name || !input.host || !input.user) {
    showHostError(t("host_editor.error.required_fields"));
    return;
  }

  try {
    let savedHostId = editingHostId;
    if (editingHostId) {
      await invoke("update_host", { id: editingHostId, input });
    } else {
      savedHostId = await invoke("save_host", { input });
    }

    if (input.groupId) {
      expandGroupWithAncestors(input.groupId);
      saveGroupExpansionState();
    }

    autoSyncAfterDataChange();
    closeHostEditor();
    await enterHosts();
  } catch (e) {
    showHostError(String(e));
  }
}

// --------------------------------------------------------------------------
// SFTP split view + remote file editor
// --------------------------------------------------------------------------

const fileEditorOverlay = document.getElementById("file-editor-overlay");
const fileEditorTitle = document.getElementById("file-editor-title");
const fileEditorPath = document.getElementById("file-editor-path");
const fileEditorHint = document.getElementById("file-editor-hint");
const fileEditorFindInput = document.getElementById("file-editor-find");
const fileEditorReplaceInput = document.getElementById("file-editor-replace");
const fileEditorToolsInline = document.getElementById("file-editor-tools-inline");
const fileEditorFindInline = document.getElementById("file-editor-find-inline");
const fileEditorReplaceInline = document.getElementById("file-editor-replace-inline");
const fileEditorInlineClose = document.getElementById("file-editor-inline-close");
const fileEditorMatchCaseInput = document.getElementById("file-editor-match-case");
const fileEditorFindPrevButton = document.getElementById("file-editor-find-prev");
const fileEditorFindNextButton = document.getElementById("file-editor-find-next");
const fileEditorReplaceOneButton = document.getElementById("file-editor-replace-one");
const fileEditorReplaceAllButton = document.getElementById("file-editor-replace-all");
const fileEditorError = document.getElementById("file-editor-error");
const fileEditorSaveButton = document.getElementById("file-editor-save");
const fileEditorCancelButton = document.getElementById("file-editor-cancel");

const filesContextMenu = document.getElementById("files-context-menu");
const filesMenuOpen = document.getElementById("files-menu-open");
const filesMenuOpenWith = document.getElementById("files-menu-open-with");
const filesMenuCopy = document.getElementById("files-menu-copy");
const filesMenuRename = document.getElementById("files-menu-rename");
const filesMenuDelete = document.getElementById("files-menu-delete");
const filesMenuEntrySeparator = document.getElementById("files-menu-entry-separator");
const filesMenuRefresh = document.getElementById("files-menu-refresh");
const filesMenuMkdir = document.getElementById("files-menu-mkdir");
const filesMenuNewFile = document.getElementById("files-menu-new-file");
const filesMenuUpload = document.getElementById("files-menu-upload");
const filesMenuHidden = document.getElementById("files-menu-hidden");
const filesMenuPermissions = document.getElementById("files-menu-permissions");
const filesMenuSelectAll = document.getElementById("files-menu-select-all");
const filesMenuEdit = document.getElementById("files-menu-edit");
const filesMenuDownload = document.getElementById("files-menu-download");
const filesMenuCloseSeparator = document.getElementById("files-menu-close-separator");
const filesMenuClose = document.getElementById("files-menu-close");
const filesMenuPin = document.getElementById("files-menu-pin");
const LOCAL_HOST_ID = "__local__";

if (filesContextMenu && filesContextMenu.parentElement !== document.body) {
  document.body.appendChild(filesContextMenu);
}

function isLocalPane(pane) {
  return pane.hostId === LOCAL_HOST_ID;
}

function isPaneConnected(pane) {
  return pane.localConnected || pane.sftpId !== null;
}

function isRightPaneHostEmpty(pane) {
  return pane.key === "right" && !pane.hostId;
}

function isTerminalSideSftpPane(pane) {
  return pane?.key === "terminal";
}

// ----- Pinned SFTP paths (per-host favorites for the terminal SFTP panel) -----
const SFTP_PINNED_PATHS_KEY = "zt.sftp.pinnedPaths";

function pinnedHostKey(pane) {
  // Pinned paths are scoped per host (a path on host A is meaningless on host B).
  return pane?.hostId || null;
}

function loadPinnedPaths() {
  try {
    const obj = JSON.parse(localStorage.getItem(SFTP_PINNED_PATHS_KEY) || "{}");
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function savePinnedPaths(obj) {
  try {
    localStorage.setItem(SFTP_PINNED_PATHS_KEY, JSON.stringify(obj));
  } catch {}
}

function getPinnedForPane(pane) {
  const key = pinnedHostKey(pane);
  if (!key) return [];
  const list = loadPinnedPaths()[key];
  return Array.isArray(list) ? list.filter((p) => typeof p === "string" && p) : [];
}

function isPinned(pane, path) {
  return getPinnedForPane(pane).includes(path);
}

function addPinnedPath(pane, path) {
  const key = pinnedHostKey(pane);
  if (!key || !path) return;
  const all = loadPinnedPaths();
  const list = Array.isArray(all[key]) ? all[key] : [];
  if (!list.includes(path)) {
    list.push(path);
    all[key] = list;
    savePinnedPaths(all);
  }
}

function removePinnedPath(pane, path) {
  const key = pinnedHostKey(pane);
  if (!key) return;
  const all = loadPinnedPaths();
  const list = Array.isArray(all[key]) ? all[key] : [];
  all[key] = list.filter((p) => p !== path);
  savePinnedPaths(all);
}

// The path a "pin" action targets: a right-clicked folder -> that folder,
// otherwise (blank area / file) the current directory.
function getPinTargetPath(pane) {
  const entry = filesContextEntry;
  if (entry && entry.kind === "dir") return joinPanePath(pane, entry.name);
  return pane.path;
}

function buildSftpPane(key) {
  const filterInput = document.getElementById(`sftp-${key}-filter-input`);
  return {
    key,
    hostId: key === "left" ? LOCAL_HOST_ID : "",
    host: null,
    connectedHostId: null,
    sftpId: null,
    localConnected: false,
    path: "/",
    entries: [],
    rootEl: document.getElementById(`sftp-${key}-pane`),
    hostSelect: document.getElementById(`sftp-${key}-host`),
    upButton: document.getElementById(`sftp-${key}-up`),
    forwardButton: document.getElementById(`sftp-${key}-forward`),
    pathbarEl: document.getElementById(`sftp-${key}-pathbar`),
    breadcrumbsEl: document.getElementById(`sftp-${key}-breadcrumbs`),
    pathInputEl: document.getElementById(`sftp-${key}-path-input`),
    filterLabel: document.getElementById(`sftp-${key}-filter-label`),
    filterInput,
    filterWrap: filterInput ? filterInput.closest(".sftp-inline-filter") : null,
    statusEl: document.getElementById(`sftp-${key}-status`),
    listEl: document.getElementById(`sftp-${key}-list`),
    emptyStateEl: document.getElementById(`sftp-${key}-empty`),
    emptySelectButton: document.getElementById(`sftp-${key}-empty-select`),
    pathEditing: false,
    filterQuery: "",
    showHidden: false,
    selectedEntries: new Set(),
    navToken: 0,
    followLockedByUser: false,
    autoConnectQueue: Promise.resolve(),
    connectingPromise: null,
    connectingHostId: null,
  };
}

function buildTerminalSftpPane() {
  const key = "terminal";
  const filterInput = document.getElementById("sftp-terminal-filter-input");
  return {
    key,
    hostId: "",
    host: null,
    connectedHostId: null,
    sftpId: null,
    localConnected: false,
    path: "/",
    entries: [],
    rootEl: document.getElementById("sftp-terminal-pane"),
    hostSelect: document.getElementById("sftp-terminal-host"),
    upButton: document.getElementById("sftp-terminal-up"),
    forwardButton: document.getElementById("sftp-terminal-forward"),
    pathbarEl: document.getElementById("sftp-terminal-pathbar"),
    breadcrumbsEl: document.getElementById("sftp-terminal-breadcrumbs"),
    pathInputEl: document.getElementById("sftp-terminal-path-input"),
    filterLabel: document.getElementById("sftp-terminal-filter-label"),
    filterInput,
    filterWrap: filterInput ? filterInput.closest(".sftp-inline-filter") : null,
    statusEl: document.getElementById("sftp-terminal-status"),
    listEl: document.getElementById("sftp-terminal-list"),
    emptyStateEl: null,
    emptySelectButton: null,
    pathEditing: false,
    filterQuery: "",
    showHidden: false,
    selectedEntries: new Set(),
    navToken: 0,
    followLockedByUser: false,
    autoConnectQueue: Promise.resolve(),
    connectingPromise: null,
    connectingHostId: null,
    terminalSidePane: true,
  };
}

const sftpPanes = {
  left: buildSftpPane("left"),
  right: buildSftpPane("right"),
  terminal: buildTerminalSftpPane(),
};

const sftpDragState = {
  sourcePaneKey: null,
  entryNames: [],
  targetPaneKey: null,
  targetDir: null,
};
const SFTP_DRAG_MIME = "application/x-zeroterm-sftp-drag";

let filesContextEntry = null;
let filesContextPaneKey = null;
let fileEditorAce = null;
const fileEditorState = {
  open: false,
  paneKey: null,
  path: "",
  originalContent: "",
  encoding: "UTF-8",
  dirty: false,
  saving: false,
};

function getSftpPane(key) {
  if (key === "terminal") return sftpPanes.terminal;
  return key === "right" ? sftpPanes.right : sftpPanes.left;
}

function joinPanePath(pane, leaf) {
  return isLocalPane(pane) ? localJoin(pane.path, leaf) : joinPath(pane.path, leaf);
}

function paneSftpIdOrNull(pane) {
  return isLocalPane(pane) ? null : pane.sftpId;
}

function clearSftpDropVisuals() {
  for (const pane of Object.values(sftpPanes)) {
    pane.rootEl?.classList.remove("sftp-drop-target");
    const highlighted = pane.listEl?.querySelector(".sftp-row.drop-target");
    if (highlighted) highlighted.classList.remove("drop-target");
  }
}

function resetSftpDragState() {
  clearSftpDropVisuals();
  sftpDragState.sourcePaneKey = null;
  sftpDragState.entryNames = [];
  sftpDragState.targetPaneKey = null;
  sftpDragState.targetDir = null;
}

function beginSftpDrag(pane, entryName, ev) {
  if (!isPaneConnected(pane) || !entryName || entryName === "..") return false;
  const selected = pane.selectedEntries.has(entryName)
    ? getSelectedEntries(pane)
    : pane.entries.filter((entry) => entry.name === entryName);
  const names = Array.from(
    new Set(
      selected
        .map((entry) => String(entry.name || ""))
        .filter((name) => name && name !== ".." && name !== "."),
    ),
  );
  if (names.length === 0) return false;

  sftpDragState.sourcePaneKey = pane.key;
  sftpDragState.entryNames = names;
  sftpDragState.targetPaneKey = null;
  sftpDragState.targetDir = null;

  if (ev?.dataTransfer) {
    ev.dataTransfer.effectAllowed = "copy";
    ev.dataTransfer.setData(
      SFTP_DRAG_MIME,
      JSON.stringify({ paneKey: pane.key, names }),
    );
    ev.dataTransfer.setData("text/plain", names.join("\n"));
  }
  return true;
}

function hydrateSftpDragStateFromEvent(ev) {
  if (!ev?.dataTransfer) return;
  if (sftpDragState.sourcePaneKey && sftpDragState.entryNames.length > 0) return;
  let payload = "";
  try {
    payload = ev.dataTransfer.getData(SFTP_DRAG_MIME) || "";
  } catch (_) {
    return;
  }
  if (!payload) return;
  try {
    const parsed = JSON.parse(payload);
    const paneKey = parsed?.paneKey === "right" ? "right" : parsed?.paneKey === "left" ? "left" : null;
    const names = Array.isArray(parsed?.names)
      ? parsed.names.map((n) => String(n || "").trim()).filter(Boolean)
      : [];
    if (!paneKey || names.length === 0) return;
    sftpDragState.sourcePaneKey = paneKey;
    sftpDragState.entryNames = names;
  } catch (_) {
    // ignore malformed payload
  }
}

function canAcceptSftpDrag(targetPane, ev = null) {
  hydrateSftpDragStateFromEvent(ev);
  return (
    Boolean(sftpDragState.sourcePaneKey) &&
    sftpDragState.entryNames.length > 0 &&
    isPaneConnected(targetPane)
  );
}

function hasExternalFileDrag(ev) {
  const dt = ev?.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []).map((type) => String(type || ""));
  if (
    types.includes("Files") ||
    types.some((type) => /file-url/i.test(type) || /public\.file-url/i.test(type))
  ) {
    return true;
  }
  if (dt.files && dt.files.length > 0) return true;
  if (!dt.items || dt.items.length === 0) return false;
  return Array.from(dt.items).some((item) => item.kind === "file");
}

function canAcceptExternalUploadDrop(targetPane, ev = null) {
  return !isLocalPane(targetPane) && targetPane.sftpId !== null && hasExternalFileDrag(ev);
}

function canAcceptPaneDrop(targetPane, ev = null) {
  return canAcceptSftpDrag(targetPane, ev) || canAcceptExternalUploadDrop(targetPane, ev);
}

function getDataTransferEntry(item) {
  if (!item) return null;
  if (typeof item.getAsEntry === "function") {
    try {
      return item.getAsEntry();
    } catch (_) {
      return null;
    }
  }
  if (typeof item.webkitGetAsEntry === "function") {
    try {
      return item.webkitGetAsEntry();
    } catch (_) {
      return null;
    }
  }
  return null;
}

function normalizeDroppedRelativePath(path) {
  const raw = String(path || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const stack = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

function readFileFromFileEntry(entry) {
  return new Promise((resolve, reject) => {
    try {
      entry.file(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const out = [];
    function pump() {
      reader.readEntries(
        (entries) => {
          if (!entries || entries.length === 0) {
            resolve(out);
            return;
          }
          out.push(...entries);
          pump();
        },
        (err) => reject(err),
      );
    }
    pump();
  });
}

async function collectDroppedUploadPayload(ev) {
  const dt = ev?.dataTransfer;
  const files = [];
  const dirSet = new Set();
  const seen = new Set();

  const pushFile = (file, relPathHint = "") => {
    if (!file) return;
    const rel = normalizeDroppedRelativePath(
      relPathHint || file.webkitRelativePath || file.name,
    );
    if (!rel) return;
    const key = `${rel}::${file.size ?? -1}::${file.lastModified ?? -1}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ file, relativePath: rel });
  };

  const walkEntry = async (entry) => {
    if (!entry) return;
    const relPath = normalizeDroppedRelativePath(entry.fullPath || entry.name);
    if (entry.isDirectory) {
      if (relPath) dirSet.add(relPath);
      const reader = entry.createReader();
      const children = await readAllDirectoryEntries(reader);
      for (const child of children) {
        await walkEntry(child);
      }
      return;
    }
    if (entry.isFile) {
      const file = await readFileFromFileEntry(entry);
      pushFile(file, relPath || entry.name || file?.name);
    }
  };

  const items = Array.from(dt?.items || []).filter((item) => item.kind === "file");
  let usedEntryApi = false;
  for (const item of items) {
    const entry = getDataTransferEntry(item);
    if (!entry) continue;
    usedEntryApi = true;
    await walkEntry(entry);
  }

  if (!usedEntryApi) {
    const directFiles = Array.from(dt?.files || []);
    for (const file of directFiles) {
      pushFile(file, file.webkitRelativePath || file.name);
    }
  }

  return {
    files,
    directories: Array.from(dirSet).sort((a, b) => a.length - b.length || a.localeCompare(b)),
  };
}

async function ensureRemoteDirectoryPath(sftpId, absolutePath, cache) {
  const normalized = normalizeAbsolutePath(absolutePath);
  if (normalized === "/") return;
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    if (cache.has(current)) continue;
    try {
      await invoke("sftp_mkdir", { sftpId, path: current });
    } catch (e) {
      try {
        await invoke("sftp_list", { sftpId, path: current });
      } catch (_) {
        throw e;
      }
    }
    cache.add(current);
  }
}

async function stageBrowserFileForUpload(file) {
  if (!tauriFs?.writeFile || !tauriFsBaseDirectory) {
    throw new Error("streamed file staging is unavailable in this build");
  }
  if (!file?.stream || typeof file.stream !== "function") {
    throw new Error("browser file stream is unavailable");
  }

  const staging = await invoke("prepare_staging_upload_path", {
    fileName: String(file?.name || "upload.bin"),
  });

  try {
    await tauriFs.writeFile(
      staging.relativePath,
      file.stream(),
      { baseDir: tauriFsBaseDirectory.AppCache },
    );
    return staging;
  } catch (e) {
    try {
      await invoke("local_remove", { path: staging.absolutePath });
    } catch {}
    throw e;
  }
}

async function uploadDroppedPayloadToPane(pane, payload) {
  if (!pane || pane.sftpId === null || !payload) return;
  const remoteBase = normalizeAbsolutePath(pane.path);
  const createdDirs = new Set();

  for (const relDir of payload.directories || []) {
    const targetDir = normalizeAbsolutePath(joinPath(remoteBase, relDir));
    await ensureRemoteDirectoryPath(pane.sftpId, targetDir, createdDirs);
  }

  let uploaded = 0;
  for (const item of payload.files || []) {
    const relPath = normalizeDroppedRelativePath(item.relativePath || item.file?.name);
    if (!relPath) continue;
    const remotePath = normalizeAbsolutePath(joinPath(remoteBase, relPath));
    const parentDir = parentPath(remotePath);
    await ensureRemoteDirectoryPath(pane.sftpId, parentDir, createdDirs);

    try {
      const nativePath = typeof item.file?.path === "string" ? item.file.path : "";
      if (nativePath) {
        try {
          await uploadLocalPathToPane(pane, nativePath, remotePath, false);
        } catch (e) {
          const err = normalizeSftpError(e);
          if (err.code !== "ALREADY_EXISTS") throw err;
          const ok = await showOverwriteConfirm(remotePath);
          if (!ok) continue;
          await uploadLocalPathToPane(pane, nativePath, remotePath, true);
        }
      } else {
        const staging = await stageBrowserFileForUpload(item.file);
        try {
          const uploadStaged = (overwrite) =>
            invokeSftpTransferWithRetry(
              {
                matchKind: "upload",
                source: staging.absolutePath,
                destination: remotePath,
                retry: {
                  action: "uploadBrowserFile",
                  paneKey: pane.key,
                  file: item.file,
                  remotePath,
                  overwrite,
                  refreshPaneKeys: [pane.key],
                },
              },
              () =>
                invoke("sftp_upload", {
                  sftpId: pane.sftpId,
                  local: staging.absolutePath,
                  remote: remotePath,
                  overwrite,
                }),
            );
          try {
            await uploadStaged(false);
          } catch (e) {
            const err = normalizeSftpError(e);
            if (err.code !== "ALREADY_EXISTS") throw err;
            const ok = await showOverwriteConfirm(remotePath);
            if (!ok) continue;
            await uploadStaged(true);
          }
        } finally {
          try {
            await invoke("local_remove", { path: staging.absolutePath });
          } catch {}
        }
      }
      uploaded += 1;
      pane.statusEl.textContent = t("files.status.uploaded_one", {
        name: relPath,
        size: formatSize(item.file?.size || 0),
      });
    } catch (e) {
      const err = normalizeSftpError(e);
      pane.statusEl.textContent = t("files.error.drag_upload_failed_for", {
        name: relPath,
        error: err.message,
      });
      throw err;
    }
  }

  if (uploaded > 0 || (payload.directories && payload.directories.length > 0)) {
    await navigateSftpPane(pane, pane.path);
  }
}

async function copyDraggedEntriesToPane(sourcePane, targetPane, targetDir) {
  const names = Array.from(new Set(sftpDragState.entryNames))
    .map((name) => String(name || "").trim())
    .filter((name) => name && name !== "." && name !== "..");
  if (names.length === 0) return;

  const sourceSftpId = paneSftpIdOrNull(sourcePane);
  const destinationSftpId = paneSftpIdOrNull(targetPane);
  if (!isLocalPane(sourcePane) && sourceSftpId === null) return;
  if (!isLocalPane(targetPane) && destinationSftpId === null) return;

  const destinationDir = String(targetDir || targetPane.path || "").trim() || targetPane.path;
  const copyQueue = [];

  for (const name of names) {
    const destinationPath = joinPath(destinationDir, name);
    if (destinationSftpId === null) {
      const plan = await planOverwriteForLocalPath(destinationPath, {
        pane: targetPane,
        directoryPath: destinationDir,
        entryName: name,
      });
      if (!plan.proceed) {
        continue;
      }
      copyQueue.push({
        name,
        sourcePath: joinPanePath(sourcePane, name),
        destinationPath,
        overwrite: plan.overwrite,
      });
      continue;
    }
    copyQueue.push({
      name,
      sourcePath: joinPanePath(sourcePane, name),
      destinationPath,
      overwrite: false,
    });
  }

  if (copyQueue.length === 0) return;

  targetPane.statusEl.textContent = t("files.status.copying_many", {
    count: copyQueue.length,
    path: destinationDir,
  });

  let copied = 0;
  const errors = [];

  for (const item of copyQueue) {
    try {
      await invokeSftpTransferWithRetry(
        {
          matchKind: transferKindForPaneCopy(sourcePane, targetPane),
          source: item.sourcePath,
          destination: item.destinationPath,
          retry: {
            action: "copyBetweenPanes",
            sourcePaneKey: sourcePane.key,
            sourcePath: item.sourcePath,
            destinationPaneKey: targetPane.key,
            destinationDir,
            overwrite: item.overwrite,
            refreshPaneKeys:
              sourcePane.key === targetPane.key
                ? [targetPane.key]
                : [targetPane.key, sourcePane.key],
          },
        },
        () =>
          invoke("sftp_copy_entry_between_panes", {
            sourceSftpId,
            sourcePath: item.sourcePath,
            destinationSftpId,
            destinationDir,
            overwrite: item.overwrite,
          }),
      );
      copied += 1;
    } catch (e) {
      const err = normalizeSftpError(e);
      if (!item.overwrite && err.code === "ALREADY_EXISTS") {
        const ok = await showOverwriteConfirm(item.destinationPath);
        if (ok) {
          try {
            await invokeSftpTransferWithRetry(
              {
                matchKind: transferKindForPaneCopy(sourcePane, targetPane),
                source: item.sourcePath,
                destination: item.destinationPath,
                retry: {
                  action: "copyBetweenPanes",
                  sourcePaneKey: sourcePane.key,
                  sourcePath: item.sourcePath,
                  destinationPaneKey: targetPane.key,
                  destinationDir,
                  overwrite: true,
                  refreshPaneKeys:
                    sourcePane.key === targetPane.key
                      ? [targetPane.key]
                      : [targetPane.key, sourcePane.key],
                },
              },
              () =>
                invoke("sftp_copy_entry_between_panes", {
                  sourceSftpId,
                  sourcePath: item.sourcePath,
                  destinationSftpId,
                  destinationDir,
                  overwrite: true,
                }),
            );
            copied += 1;
            continue;
          } catch (e2) {
            errors.push({ name: item.name, error: normalizeSftpError(e2).message });
            continue;
          }
        }
        continue;
      }
      errors.push({ name: item.name, error: err.message });
    }
  }

  await navigateSftpPane(targetPane, targetPane.path);
  if (sourcePane.key === targetPane.key) {
    await navigateSftpPane(sourcePane, sourcePane.path);
  }

  if (errors.length === 0) {
    targetPane.statusEl.textContent = t("files.status.copied_many", {
      count: copied,
      path: destinationDir,
    });
    return;
  }

  if (copied === 0) {
    targetPane.statusEl.textContent = t("files.error.copy_entry_failed", {
      name: errors[0].name,
      error: errors[0].error,
    });
    return;
  }

  targetPane.statusEl.textContent = t("files.error.copy_partial", {
    ok: copied,
    total: copyQueue.length,
    error: `${errors[0].name}: ${errors[0].error}`,
  });
}

function normalizeAbsolutePath(path) {
  const raw = String(path || "").trim();
  if (!raw) return "/";
  const isAbsolute = raw.startsWith("/");
  const parts = raw.split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(part);
  }
  const normalized = "/" + stack.join("/");
  if (isAbsolute) return normalized;
  return normalized;
}

function normalizePanePath(pane, path) {
  if (isLocalPane(pane)) {
    const styleHint = isWindowsLocalPath(pane.path) ? "windows" : null;
    return normalizeLocalPath(path, styleHint);
  }
  return normalizeAbsolutePath(path);
}

function samePanePath(pane, a, b) {
  const left = normalizePanePath(pane, a);
  const right = normalizePanePath(pane, b);
  if (isLocalPane(pane) && (isWindowsLocalPath(left) || isWindowsLocalPath(right))) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function paneParentPath(pane, path) {
  return isLocalPane(pane) ? localParentPath(path) : parentPath(path);
}

function resolveSftpTargetPath(pane, rawInput) {
  if (isLocalPane(pane)) {
    return resolveLocalTargetPath(pane.path, rawInput);
  }
  const raw = String(rawInput || "").trim();
  if (!raw) return pane.path;
  if (raw.startsWith("/")) {
    return normalizeAbsolutePath(raw);
  }
  return normalizeAbsolutePath(joinPath(pane.path, raw));
}

function buildLocalBreadcrumbs(path) {
  const normalized = normalizeLocalPath(path);
  if (!isWindowsLocalPath(normalized)) {
    const segments = [{ label: "/", target: "/" }];
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current += `/${part}`;
      segments.push({ label: part, target: current || "/" });
    }
    return segments;
  }

  if (normalized.startsWith("\\\\")) {
    const tokens = normalized.split("\\").filter(Boolean);
    if (tokens.length < 2) return [{ label: "\\\\", target: "\\\\" }];
    const root = `\\\\${tokens[0]}\\${tokens[1]}`;
    const segments = [{ label: root, target: root }];
    let current = root;
    for (const part of tokens.slice(2)) {
      current = `${current}\\${part}`;
      segments.push({ label: part, target: current });
    }
    return segments;
  }

  const driveRoot = extractWindowsDriveRoot(normalized);
  if (driveRoot) {
    const segments = [{ label: driveRoot, target: driveRoot }];
    const rest = normalized.slice(driveRoot.length).split("\\").filter(Boolean);
    let current = driveRoot.replace(/\\$/, "");
    for (const part of rest) {
      current = `${current}\\${part}`;
      segments.push({ label: part, target: current });
    }
    return segments;
  }

  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const segments = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}\\${part}` : part;
    segments.push({ label: part, target: current });
  }
  return segments;
}

function buildRemoteBreadcrumbs(path) {
  const normalized = normalizeAbsolutePath(path);
  const segments = [{ label: "/", target: "/" }];
  const parts = normalized.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    segments.push({ label: part, target: current || "/" });
  }
  return segments;
}

function setSftpPathEditMode(pane, editing) {
  pane.pathEditing = Boolean(editing);
  if (pane.pathbarEl) {
    pane.pathbarEl.classList.toggle("editing", pane.pathEditing);
  }
  if (!pane.pathInputEl) return;
  if (pane.pathEditing) {
    pane.pathInputEl.value = pane.path;
    pane.pathInputEl.focus();
    pane.pathInputEl.select();
  } else {
    pane.pathInputEl.value = pane.path;
  }
}

function renderSftpPathBar(pane) {
  if (!pane.breadcrumbsEl || !pane.pathInputEl) return;

  if (!pane.pathEditing && document.activeElement !== pane.pathInputEl) {
    pane.pathInputEl.value = pane.path;
  }

  pane.breadcrumbsEl.innerHTML = "";
  const crumbs = isLocalPane(pane)
    ? buildLocalBreadcrumbs(pane.path)
    : buildRemoteBreadcrumbs(pane.path);

  for (let i = 0; i < crumbs.length; i += 1) {
    const crumb = crumbs[i];
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sftp-crumb-sep";
      sep.textContent = "›";
      pane.breadcrumbsEl.appendChild(sep);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sftp-crumb-btn" + (samePanePath(pane, pane.path, crumb.target) ? " active" : "");
    btn.textContent = crumb.label;
    btn.addEventListener("click", () => {
      if (!isPaneConnected(pane) || samePanePath(pane, pane.path, crumb.target)) return;
      navigateSftpPane(pane, crumb.target);
    });
    pane.breadcrumbsEl.appendChild(btn);
  }
}

function syncSftpHostOptions() {
  for (const pane of Object.values(sftpPanes)) {
    if (isTerminalSideSftpPane(pane)) continue;
    const selected = pane.hostId || pane.host?.id || "";
    pane.hostSelect.dataset.emptyDisplay = "";
    pane.hostSelect.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = t("sftp.host.placeholder");
    pane.hostSelect.appendChild(empty);

    const local = document.createElement("option");
    local.value = LOCAL_HOST_ID;
    local.textContent = t("sftp.host.local");
    local.title = t("sftp.host.local");
    pane.hostSelect.appendChild(local);

    for (const host of hostsCache) {
      const opt = document.createElement("option");
      opt.value = host.id;
      opt.textContent = host.name;
      opt.title = `${host.user}@${host.host}:${host.port}`;
      pane.hostSelect.appendChild(opt);
    }
    if (pane.key === "left" && !selected) {
      pane.hostId = LOCAL_HOST_ID;
    }
    pane.hostSelect.value = pane.key === "left" ? pane.hostId || LOCAL_HOST_ID : selected;
    if (!pane.hostSelect.value) pane.hostSelect.value = "";
    const localSelected = pane.hostSelect.value === LOCAL_HOST_ID;
    const selectedHost = hostsCache.find((h) => h.id === pane.hostSelect.value) || null;
    pane.hostSelect.title = localSelected
      ? t("sftp.host.local")
      : selectedHost
        ? `${selectedHost.user}@${selectedHost.host}:${selectedHost.port}`
        : t("sftp.host.placeholder");

    // Keep custom select UI in sync after we rebuild native options.
    if (pane.hostSelect?.id) {
      syncCustomSelect(pane.hostSelect.id);
    }
  }
}

function ensureDefaultSftpPaneState() {
  const left = sftpPanes.left;
  if (!left.hostId) {
    left.hostId = LOCAL_HOST_ID;
    left.host = null;
  }

  syncSftpHostOptions();

  if (left.hostId === LOCAL_HOST_ID && !left.localConnected && left.sftpId === null) {
    left.hostSelect.value = LOCAL_HOST_ID;
    left.hostSelect.dispatchEvent(new Event("change"));
    // Left pane will re-render after local auto-connect, but right pane has
    // no auto-connect path and still needs an initial paint so its empty
    // state is visible immediately.
    renderSftpPane(sftpPanes.right);
    return;
  }

  renderAllSftpPanes();
}

function updateSftpConnectButtons() {
  // Connection is now auto-managed by host selection.
}

function updateSftpPaneFilterButton(pane) {
  if (!pane.filterWrap) return;
  pane.filterWrap.classList.toggle("active", Boolean(pane.filterQuery));
  pane.filterWrap.title = pane.filterQuery
    ? `${t("sftp.button.filter")}: ${pane.filterQuery}`
    : t("sftp.button.filter");
  if (pane.filterInput && document.activeElement !== pane.filterInput) {
    pane.filterInput.value = pane.filterQuery;
  }
}

function getVisibleEntriesForPane(pane) {
  const filter = pane.filterQuery.trim().toLowerCase();
  return pane.entries.filter((entry) => {
    const name = String(entry.name || "");
    if (!pane.showHidden && name.startsWith(".") && name !== "..") return false;
    if (!filter) return true;
    return name.toLowerCase().includes(filter);
  });
}

function normalizePaneSelection(pane) {
  if (!pane.selectedEntries || !(pane.selectedEntries instanceof Set)) {
    pane.selectedEntries = new Set();
    return;
  }
  const validNames = new Set(pane.entries.map((entry) => entry.name));
  for (const name of pane.selectedEntries) {
    if (!validNames.has(name)) {
      pane.selectedEntries.delete(name);
    }
  }
}

function selectSingleEntry(pane, entryName) {
  pane.selectedEntries = new Set([entryName]);
}

function toggleEntrySelection(pane, entryName) {
  const next = new Set(pane.selectedEntries);
  if (next.has(entryName)) {
    next.delete(entryName);
  } else {
    next.add(entryName);
  }
  pane.selectedEntries = next;
}

function getSelectedEntries(pane) {
  if (!pane.selectedEntries || pane.selectedEntries.size === 0) return [];
  const selectedNames = pane.selectedEntries;
  return pane.entries.filter((entry) => selectedNames.has(entry.name));
}

function getPrimarySelectedEntry(pane) {
  const selected = getSelectedEntries(pane);
  return selected.length === 1 ? selected[0] : null;
}

async function connectSftpPane(pane, host) {
  if (pane.connectingPromise) {
    if (pane.connectingHostId === host.id) return pane.connectingPromise;
    await pane.connectingPromise;
    return connectSftpPane(pane, host);
  }

  pane.connectingHostId = host.id;
  pane.connectingPromise = connectSftpPaneNow(pane, host).finally(() => {
    pane.connectingPromise = null;
    pane.connectingHostId = null;
  });
  return pane.connectingPromise;
}

async function connectSftpPaneNow(pane, host) {
  await disconnectSftpPane(pane);
  pane.localConnected = false;
  pane.statusEl.textContent = t("sftp.status.connecting");
  try {
    pane.sftpId = await invoke("sftp_open", { hostId: host.id });
    pane.connectedHostId = host.id;
    pane.hostId = host.id;
    pane.host = host;
    pane.followLockedByUser = false;
    pane.hostSelect.title = `${host.user}@${host.host}:${host.port}`;
    pane.path = "/";
    pane.statusEl.textContent = t("sftp.status.connected", { name: host.name });
    await navigateSftpPane(pane, "/", { source: "system" });
  } catch (e) {
    const err = normalizeSftpError(e);
    pane.statusEl.textContent = t("sftp.error.connect_failed", { error: err.message });
  }
  updateSftpConnectButtons();
}

async function connectLocalPane(pane) {
  await disconnectSftpPane(pane);
  pane.hostId = LOCAL_HOST_ID;
  pane.host = null;
  pane.connectedHostId = null;
  pane.localConnected = false;
  pane.hostSelect.title = t("sftp.host.local");
  pane.statusEl.textContent = t("sftp.status.connecting");
  try {
    const configuredLocalPath = (localStorage.getItem(SETTINGS_KEY_SFTP_LOCAL_DIR) || "").trim();
    const home = await invoke("local_home_path");
    pane.path = configuredLocalPath || home || "/";
    pane.localConnected = true;
    await navigateSftpPane(pane, pane.path);
    renderSftpPane(pane);
  } catch (e) {
    pane.localConnected = false;
    pane.statusEl.textContent = t("sftp.error.connect_failed", { error: e });
  }
}

async function connectTerminalSftpToActivePane() {
  const pane = sftpPanes.terminal;
  const active = getActivePane();
  if (!pane) return;
  if (!active) {
    await disconnectSftpPane(pane);
    if (terminalSftpSubtitle) terminalSftpSubtitle.textContent = t("terminal_sftp.subtitle");
    pane.statusEl.textContent = t("terminal_sftp.empty.desc");
    renderSftpPane(pane);
    return;
  }
  if (active.isLocal || active.host?.id?.startsWith?.("local-")) {
    if (terminalSftpSubtitle) terminalSftpSubtitle.textContent = t("terminal.status.local");
    if (pane.hostId !== LOCAL_HOST_ID || !pane.localConnected) {
      await connectLocalPane(pane);
    }
    return;
  }
  const host = active.host;
  if (!host?.id) {
    await disconnectSftpPane(pane);
    if (terminalSftpSubtitle) terminalSftpSubtitle.textContent = t("terminal_sftp.subtitle");
    pane.statusEl.textContent = t("terminal_sftp.empty.desc");
    renderSftpPane(pane);
    return;
  }
  if (terminalSftpSubtitle) terminalSftpSubtitle.textContent = host.name || host.host || t("terminal_sftp.subtitle");
  if (pane.sftpId !== null && pane.connectedHostId === host.id) {
    await navigateSftpPane(pane, pane.path, { source: "system" });
    return;
  }
  await connectSftpPane(pane, host);
}

async function disconnectSftpPane(pane) {
  if (pane.sftpId !== null) {
    try {
      await invoke("sftp_close", { sftpId: pane.sftpId });
    } catch (e) {
      console.warn("sftp_close failed", e);
    }
  }
  pane.sftpId = null;
  pane.connectedHostId = null;
  pane.localConnected = false;
  pane.entries = [];
  pane.filterQuery = "";
  pane.selectedEntries = new Set();
  pane.path = "/";
  pane.followLockedByUser = false;
  setSftpPathEditMode(pane, false);
  pane.statusEl.textContent = t("sftp.status.not_connected");
  updateSftpPaneFilterButton(pane);
  renderSftpPathBar(pane);
  renderSftpPane(pane);
  updateSftpConnectButtons();
}

async function navigateSftpPane(pane, path, { source = "user", retryOnReconnect = true } = {}) {
  if (source === "user") {
    pane.followLockedByUser = true;
  }
  const local = isLocalPane(pane);
  if (!local && pane.sftpId === null) return;
  const navToken = (pane.navToken || 0) + 1;
  pane.navToken = navToken;
  pane.statusEl.textContent = t("files.status.listing", { path });
  try {
    setSftpPathEditMode(pane, false);
    const entries = local
      ? await invoke("local_list", { path })
      : await invoke("sftp_list", { sftpId: pane.sftpId, path });
    if (pane.navToken !== navToken) return;
    pane.path = path;
    pane.entries = entries;
    normalizePaneSelection(pane);
    renderSftpPathBar(pane);
    pane.statusEl.textContent = local
      ? ""
      : pane.host
        ? t("sftp.status.connected", { name: pane.host.name })
        : "";
    renderSftpPane(pane);
  } catch (e) {
    if (pane.navToken !== navToken) return;
    const err = normalizeSftpError(e);
    const shouldReconnect =
      retryOnReconnect &&
      !local &&
      pane.host &&
      pane.hostId &&
      (err.code === "CHANNEL_CLOSED" || err.code === "TIMEOUT");

    if (shouldReconnect) {
      try {
        pane.statusEl.textContent = t("sftp.status.connecting");
        await connectSftpPane(pane, pane.host);
        await navigateSftpPane(pane, path, { source: "system", retryOnReconnect: false });
        return;
      } catch {
        // fall through to visible error below
      }
    }
    pane.statusEl.textContent = t("files.error.list_failed", { error: err.message });
  }
}

function renderSftpPane(pane) {
  renderSftpPathBar(pane);
  updateSftpPaneFilterButton(pane);
  const connected = isPaneConnected(pane);
  const showRightEmpty = isRightPaneHostEmpty(pane);
  pane.upButton.disabled = !connected || samePanePath(pane, pane.path, paneParentPath(pane, pane.path));
  pane.forwardButton.disabled = true;
  pane.listEl.innerHTML = "";

  if (pane.emptyStateEl) {
    pane.emptyStateEl.hidden = !showRightEmpty;
  }
  pane.statusEl.hidden = showRightEmpty;
  pane.listEl.hidden = showRightEmpty;
  if (pane.rootEl) {
    pane.rootEl.classList.toggle("sftp-pane-empty", showRightEmpty);
  }

  if (!connected) {
    pane.statusEl.textContent = t("sftp.status.not_connected");
  } else if (isLocalPane(pane) && pane.statusEl.textContent === t("sftp.status.not_connected")) {
    pane.statusEl.textContent = "";
  }
  if (showRightEmpty) {
    pane.selectedEntries = new Set();
    pane.statusEl.textContent = t("sftp.status.not_connected");
    return;
  }
  if (isTerminalSideSftpPane(pane) && !pane.hostId) {
    pane.selectedEntries = new Set();
    const empty = document.createElement("li");
    empty.className = "file-row terminal-sftp-empty-row";
    empty.style.gridTemplateColumns = "1fr";
    empty.innerHTML = `<strong>${t("terminal_sftp.empty.title")}</strong><span>${t("terminal_sftp.empty.desc")}</span>`;
    pane.listEl.appendChild(empty);
    return;
  }
  if (!pane.hostId) {
    pane.selectedEntries = new Set();
    const empty = document.createElement("li");
    empty.className = "file-row";
    empty.style.gridTemplateColumns = "1fr";
    empty.style.justifyContent = "center";
    empty.style.color = "var(--muted)";
    empty.textContent = t("sftp.host.placeholder");
    pane.listEl.appendChild(empty);
    return;
  }

  normalizePaneSelection(pane);
  const visibleEntries = getVisibleEntriesForPane(pane);

  if (visibleEntries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "file-row";
    empty.style.gridTemplateColumns = "1fr";
    empty.style.justifyContent = "center";
    empty.style.color = "var(--muted)";
    empty.textContent = pane.filterQuery ? `${t("files.empty")} · ${t("sftp.button.filter")}` : t("files.empty");
    pane.listEl.appendChild(empty);
    return;
  }

  for (const entry of visibleEntries) {
    const row = document.createElement("li");
    const selectedClass = pane.selectedEntries.has(entry.name) ? " selected" : "";
    row.className = `file-row sftp-row${entry.kind === "dir" ? " dir" : ""}${selectedClass}`;
    row.dataset.entryName = entry.name;
    row.dataset.entryKind = entry.kind;
    const rowDraggable = entry.name !== ".." && entry.name !== ".";
    row.draggable = rowDraggable;
    if (rowDraggable) {
      row.setAttribute("draggable", "true");
    } else {
      row.removeAttribute("draggable");
    }
    row.addEventListener("click", (ev) => {
      if (ev.metaKey || ev.ctrlKey) {
        toggleEntrySelection(pane, entry.name);
      } else {
        selectSingleEntry(pane, entry.name);
      }
      renderSftpPane(pane);
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      selectSingleEntry(pane, entry.name);
      renderSftpPane(pane);
      showFilesContextMenu(pane, entry, ev.clientX, ev.clientY);
    });
    row.addEventListener("dblclick", async () => {
      if (entry.kind === "dir") {
        await navigateSftpPane(pane, joinPanePath(pane, entry.name));
      } else if (canInlineEditEntry(entry)) {
        await openRemoteEditor(pane, entry);
      }
    });
    row.addEventListener("dragstart", (ev) => {
      if (!beginSftpDrag(pane, entry.name, ev)) {
        ev.preventDefault();
      }
    });
    row.addEventListener("dragend", () => {
      resetSftpDragState();
    });
    row.addEventListener("dragenter", (ev) => {
      if (!canAcceptPaneDrop(pane, ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    });
    row.addEventListener("dragover", (ev) => {
      if (!canAcceptPaneDrop(pane, ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
      clearSftpDropVisuals();
      pane.rootEl?.classList.add("sftp-drop-target");
      if (
        canAcceptSftpDrag(pane, ev) &&
        entry.kind === "dir" &&
        entry.name !== ".." &&
        entry.name !== "."
      ) {
        row.classList.add("drop-target");
        sftpDragState.targetDir = joinPanePath(pane, entry.name);
      } else {
        sftpDragState.targetDir = pane.path;
      }
      sftpDragState.targetPaneKey = pane.key;
    });
    row.addEventListener("dragleave", (ev) => {
      if (!ev.currentTarget.contains(ev.relatedTarget)) {
        row.classList.remove("drop-target");
      }
    });
    row.addEventListener("drop", async (ev) => {
      if (!canAcceptPaneDrop(pane, ev)) return;
      ev.preventDefault();
      ev.stopPropagation();
      try {
        if (canAcceptSftpDrag(pane, ev)) {
          const sourcePane = getSftpPane(sftpDragState.sourcePaneKey);
          const targetDir =
            entry.kind === "dir" && entry.name !== ".." && entry.name !== "."
              ? joinPanePath(pane, entry.name)
              : pane.path;
          await copyDraggedEntriesToPane(sourcePane, pane, targetDir);
        } else if (canAcceptExternalUploadDrop(pane, ev)) {
          const payload = await collectDroppedUploadPayload(ev);
          await uploadDroppedPayloadToPane(pane, payload);
        }
      } finally {
        resetSftpDragState();
      }
    });

    const marker = document.createElement("span");
    marker.className = "marker";
    marker.innerHTML = kindMarker(entry.kind);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = entry.kind === "dir" ? `${entry.name}/` : entry.name;
    if (entry.kind === "dir") {
      name.addEventListener("click", (ev) => {
        ev.stopPropagation();
        navigateSftpPane(pane, joinPanePath(pane, entry.name));
      });
    }

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = entry.kind === "dir" ? "—" : formatSize(entry.size);

    row.append(marker, name, size);
    pane.listEl.appendChild(row);
  }
}

function renderAllSftpPanes() {
  renderSftpPane(sftpPanes.left);
  renderSftpPane(sftpPanes.right);
}

function pickSftpPaneForHost() {
  if (!sftpPanes.right.hostId) return sftpPanes.right;
  if (isLocalPane(sftpPanes.left)) return sftpPanes.right;
  if (!sftpPanes.left.hostId) return sftpPanes.left;
  return sftpPanes.right;
}

async function assignHostToSftpPane(host) {
  const pane = pickSftpPaneForHost();
  pane.hostId = host.id;
  pane.host = host;
  syncSftpHostOptions();
  pane.hostSelect.value = host.id;
  await connectSftpPane(pane, host);
}

function canInlineEditEntry(entry) {
  return (
    entry.kind === "file" &&
    entry.size <= fileEditorMaxBytesForName(entry.name) &&
    isLikelyEditableTextName(entry.name)
  );
}

function kindMarker(kind) {
  if (kind === "dir") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="zt-icon sftp-item-icon sftp-icon-dir"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
  }
  if (kind === "file") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="zt-icon sftp-item-icon sftp-icon-file"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;
  }
  if (kind === "symlink") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="zt-icon sftp-item-icon sftp-icon-link"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="zt-icon sftp-item-icon sftp-icon-unknown"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
}

function setFilesContextNodeVisible(el, visible) {
  if (!el) return;
  el.hidden = !visible;
}

function showFilesContextMenu(pane, entry, x, y) {
  const connected = isPaneConnected(pane);
  const local = isLocalPane(pane);
  const isTerminalPane = isTerminalSideSftpPane(pane);
  const selectedEntries = connected ? getSelectedEntries(pane) : [];
  let targetEntry = entry || null;
  if (!targetEntry && selectedEntries.length === 1) {
    targetEntry = selectedEntries[0];
  }
  const hasSingleTarget = Boolean(targetEntry);
  const selectedCount = selectedEntries.length;
  const hasDeleteTarget = hasSingleTarget || selectedCount > 0;
  const isFile = hasSingleTarget && targetEntry.kind === "file";
  const canDownload = hasSingleTarget && (targetEntry.kind === "file" || targetEntry.kind === "dir");
  const canInlineEdit = isFile && canInlineEditEntry(targetEntry);

  filesContextEntry = targetEntry;
  filesContextPaneKey = pane.key;

  setFilesContextNodeVisible(filesMenuOpen, true);
  setFilesContextNodeVisible(filesMenuOpenWith, true);
  setFilesContextNodeVisible(filesMenuCopy, !isTerminalPane);
  setFilesContextNodeVisible(filesMenuRename, true);
  setFilesContextNodeVisible(filesMenuDelete, true);
  setFilesContextNodeVisible(filesMenuEntrySeparator, true);
  setFilesContextNodeVisible(filesMenuRefresh, true);
  setFilesContextNodeVisible(filesMenuMkdir, true);
  setFilesContextNodeVisible(filesMenuNewFile, isTerminalPane);
  setFilesContextNodeVisible(filesMenuUpload, true);
  setFilesContextNodeVisible(filesMenuHidden, true);
  setFilesContextNodeVisible(filesMenuPermissions, true);
  setFilesContextNodeVisible(filesMenuSelectAll, true);
  setFilesContextNodeVisible(filesMenuEdit, true);
  setFilesContextNodeVisible(filesMenuDownload, true);
  setFilesContextNodeVisible(filesMenuCloseSeparator, true);
  setFilesContextNodeVisible(filesMenuClose, true);

  filesMenuOpen.disabled = !(connected && hasSingleTarget);
  filesMenuOpenWith.disabled = !(connected && isFile);
  filesMenuCopy.disabled = !(connected && !local && !isTerminalPane && hasSingleTarget && isFile);
  filesMenuRename.disabled = !(connected && hasSingleTarget);
  filesMenuDelete.disabled = !(connected && hasDeleteTarget);
  filesMenuRefresh.disabled = !connected;
  filesMenuMkdir.disabled = !connected;
  filesMenuNewFile.disabled = !(connected && isTerminalPane);
  filesMenuUpload.disabled = !connected || local;
  filesMenuHidden.disabled = !connected;
  filesMenuPermissions.disabled = !(connected && hasSingleTarget);
  filesMenuSelectAll.disabled = !(connected && getVisibleEntriesForPane(pane).length > 0);
  filesMenuEdit.disabled = !(connected && canInlineEdit);
  filesMenuDownload.disabled = !(connected && !local && canDownload);
  filesMenuClose.disabled = !connected;
  filesMenuHidden.textContent = pane.showHidden ? t("files.menu.hide_hidden") : t("files.menu.show_hidden");

  // "Pin path" is only offered in the terminal-side SFTP panel.
  setFilesContextNodeVisible(filesMenuPin, isTerminalPane);
  if (isTerminalPane) {
    const pinTargetIsDir = hasSingleTarget && targetEntry.kind === "dir";
    const pinTargetPath = pinTargetIsDir ? joinPanePath(pane, targetEntry.name) : pane.path;
    const alreadyPinned = connected && isPinned(pane, pinTargetPath);
    filesMenuPin.textContent = alreadyPinned
      ? t("terminal_sftp.pin.unpin")
      : pinTargetIsDir
        ? t("terminal_sftp.pin.add_folder")
        : t("terminal_sftp.pin.add_dir");
    filesMenuPin.disabled = !connected || !pinTargetPath;
  }

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

function hideFilesContextMenu() {
  filesContextMenu.hidden = true;
  filesContextEntry = null;
  filesContextPaneKey = null;
}

async function sftpDownloadFile(pane, entry) {
  if (!pane || pane.sftpId === null || !entry) return;
  if (entry.kind === "dir") {
    const destination = await invoke("plugin:dialog|open", {
      options: { multiple: false, directory: true },
    });
    if (!destination) return;
    const destinationDir = Array.isArray(destination) ? String(destination[0] || "") : String(destination);
    if (!destinationDir) return;
    const destinationPath = joinPath(destinationDir, entry.name);
    const plan = await planOverwriteForLocalPath(destinationPath, {
      directoryPath: destinationDir,
      entryName: entry.name,
    });
    if (!plan.proceed) return;
    try {
      pane.statusEl.textContent = t("files.progress.downloading");
      const sourcePath = joinPanePath(pane, entry.name);
      await invokeSftpTransferWithRetry(
        {
          matchKind: "download",
          source: sourcePath,
          destination: destinationPath,
          retry: {
            action: "copyToLocalDirectory",
            paneKey: pane.key,
            sourcePath,
            destinationPath,
            destinationDir,
            overwrite: plan.overwrite,
            refreshPaneKeys: [],
          },
        },
        () =>
          invoke("sftp_copy_entry_between_panes", {
            sourceSftpId: pane.sftpId,
            sourcePath,
            destinationSftpId: null,
            destinationDir,
            overwrite: plan.overwrite,
          }),
      );
      pane.statusEl.textContent = t("files.status.downloaded_dir_to", {
        name: entry.name,
        folder: destinationDir,
      });
  } catch (e) {
    const err = normalizeSftpError(e);
    if (!plan.overwrite && err.code === "ALREADY_EXISTS") {
      const ok = await showOverwriteConfirm(destinationPath);
        if (ok) {
          try {
            pane.statusEl.textContent = t("files.progress.downloading");
            const sourcePath = joinPanePath(pane, entry.name);
            await invokeSftpTransferWithRetry(
              {
                matchKind: "download",
                source: sourcePath,
                destination: destinationPath,
                retry: {
                  action: "copyToLocalDirectory",
                  paneKey: pane.key,
                  sourcePath,
                  destinationPath,
                  destinationDir,
                  overwrite: true,
                  refreshPaneKeys: [],
                },
              },
              () =>
                invoke("sftp_copy_entry_between_panes", {
                  sourceSftpId: pane.sftpId,
                  sourcePath,
                  destinationSftpId: null,
                  destinationDir,
                  overwrite: true,
                }),
            );
            pane.statusEl.textContent = t("files.status.downloaded_dir_to", {
              name: entry.name,
              folder: destinationDir,
            });
            return;
          } catch (e2) {
            pane.statusEl.textContent = t("files.error.download_failed", { error: normalizeSftpError(e2).message });
            return;
          }
        }
        return;
      }
      pane.statusEl.textContent = t("files.error.download_failed", { error: err.message });
    }
    return;
  }

  const local = await invoke("plugin:dialog|save", {
    options: { defaultPath: entry.name },
  });
  if (!local) return;
  const plan = await planOverwriteForLocalPath(String(local), {
    entryName: entry.name,
  });
  if (!plan.proceed) return;
  try {
    pane.statusEl.textContent = t("files.progress.downloading");
    const remotePath = joinPanePath(pane, entry.name);
    const n = await invokeSftpTransferWithRetry(
      {
        matchKind: "download",
        source: remotePath,
        destination: String(local),
        retry: {
          action: "downloadFile",
          paneKey: pane.key,
          remotePath,
          localPath: String(local),
          overwrite: plan.overwrite,
          refreshPaneKeys: [],
        },
      },
      () =>
        invoke("sftp_download", {
          sftpId: pane.sftpId,
          remote: remotePath,
          local,
          overwrite: plan.overwrite,
        }),
    );
    pane.statusEl.textContent = t("files.status.downloaded_one", { name: entry.name, size: formatSize(n) });
  } catch (e) {
    const err = normalizeSftpError(e);
    if (!plan.overwrite && err.code === "ALREADY_EXISTS") {
      const ok = await showOverwriteConfirm(local);
      if (ok) {
        try {
          pane.statusEl.textContent = t("files.progress.downloading");
          const remotePath = joinPanePath(pane, entry.name);
          const n = await invokeSftpTransferWithRetry(
            {
              matchKind: "download",
              source: remotePath,
              destination: String(local),
              retry: {
                action: "downloadFile",
                paneKey: pane.key,
                remotePath,
                localPath: String(local),
                overwrite: true,
                refreshPaneKeys: [],
              },
            },
            () =>
              invoke("sftp_download", {
                sftpId: pane.sftpId,
                remote: remotePath,
                local,
                overwrite: true,
              }),
          );
          pane.statusEl.textContent = t("files.status.downloaded_one", { name: entry.name, size: formatSize(n) });
          return;
        } catch (e2) {
          pane.statusEl.textContent = t("files.error.download_failed", { error: normalizeSftpError(e2).message });
          return;
        }
      }
      return;
    }
    pane.statusEl.textContent = t("files.error.download_failed", { error: err.message });
  }
}

async function openEntryWithLocalApp(pane, entry) {
  if (!pane || !entry || entry.kind !== "file") return;
  const defaultAppPath = isMacPlatform
    ? "/Applications"
    : isWindowsPlatform
      ? "C:\\Program Files"
      : "/usr/bin";
  // Backend picker authorizes the chosen application path so
  // open_with_app will accept it (webview-supplied app paths are
  // refused unless they live under a system apps directory).
  const picked = await invoke("pick_local_file", {
    title: t("files.menu.open_with"),
    defaultPath: defaultAppPath,
  });
  if (!picked) return;

  let localPath = "";
  if (isLocalPane(pane)) {
    localPath = joinPanePath(pane, entry.name);
  } else {
    localPath = await invoke("temp_open_path", { fileName: entry.name });
    await invoke("sftp_download", {
      sftpId: pane.sftpId,
      remote: joinPanePath(pane, entry.name),
      local: localPath,
      overwrite: true,
    });
  }

  await invoke("open_with_app", {
    filePath: localPath,
    appPath: String(picked),
  });
}

async function sftpRenameEntry(pane, entry) {
  const next = await openTextInputDialog({
    title: t("files.menu.rename"),
    message: t("files.prompt.rename", { name: entry.name }),
    defaultValue: entry.name,
  });
  if (!next || next === entry.name) return;
  try {
    if (isLocalPane(pane)) {
      await invoke("local_rename", {
        from: joinPanePath(pane, entry.name),
        to: joinPanePath(pane, next),
      });
    } else {
      await invoke("sftp_rename", {
        sftpId: pane.sftpId,
        from: joinPanePath(pane, entry.name),
        to: joinPanePath(pane, next),
      });
    }
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    pane.statusEl.textContent = t("files.error.rename_failed", { error: normalizeSftpError(e).message });
  }
}

async function sftpDeleteEntry(pane, entry) {
  const target = joinPanePath(pane, entry.name);
  if (!confirm(t("files.confirm.delete_entry", { path: target }))) return;
  try {
    if (isLocalPane(pane)) {
      const command = entry.kind === "dir" ? "local_remove_dir" : "local_remove";
      await invoke(command, { path: target });
    } else {
      const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
      await invoke(command, { sftpId: pane.sftpId, path: target });
    }
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    pane.statusEl.textContent = t("files.error.delete_failed", { error: normalizeSftpError(e).message });
  }
}

async function sftpMkdir(pane) {
  if (!isPaneConnected(pane)) return;
  const name = await openTextInputDialog({
    title: t("files.button.new_folder"),
    message: t("files.prompt.new_folder"),
  });
  if (!name) return;
  try {
    if (isLocalPane(pane)) {
      await invoke("local_mkdir", { path: joinPanePath(pane, name) });
    } else {
      await invoke("sftp_mkdir", {
        sftpId: pane.sftpId,
        path: joinPanePath(pane, name),
      });
    }
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    pane.statusEl.textContent = t("files.error.mkdir_failed", { error: normalizeSftpError(e).message });
  }
}

async function sftpCreateFile(pane) {
  if (!isPaneConnected(pane)) return;
  const name = await openTextInputDialog({
    title: t("files.button.new_file"),
    message: t("files.prompt.new_file"),
  });
  if (!name) return;
  const path = joinPanePath(pane, name);
  try {
    if (isLocalPane(pane)) {
      await invoke("local_write_text", { path, content: "" });
    } else {
      await invoke("sftp_write_text", {
        sftpId: pane.sftpId,
        path,
        content: "",
      });
    }
    pane.statusEl.textContent = t("files.status.created_file", { path });
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    pane.statusEl.textContent = t("files.error.create_file_failed", { error: normalizeSftpError(e).message });
  }
}

async function sftpUpload(pane) {
  if (pane.sftpId === null) return;
  const local = await invoke("plugin:dialog|open", {
    options: { multiple: true, directory: false },
  });
  if (!local) return;
  const paths = Array.isArray(local) ? local.map(String) : [String(local)];
  for (const path of paths) {
    const name = basename(path);
    const remotePath = joinPanePath(pane, name);
    try {
      let n;
      try {
        n = await uploadLocalPathToPane(pane, path, remotePath, false);
      } catch (e) {
        const err = normalizeSftpError(e);
        if (err.code !== "ALREADY_EXISTS") throw err;
        const ok = await showOverwriteConfirm(remotePath);
        if (!ok) continue;
        n = await uploadLocalPathToPane(pane, path, remotePath, true);
      }
      pane.statusEl.textContent = t("files.status.uploaded_one", { name, size: formatSize(n) });
    } catch (e) {
      pane.statusEl.textContent = t("files.error.upload_failed_for", {
        name,
        error: normalizeSftpError(e).message,
      });
      break;
    }
  }
  await navigateSftpPane(pane, pane.path);
}

async function sftpCopyEntry(pane, entry) {
  if (!pane || pane.sftpId === null || !entry || entry.kind !== "file") return;
  if (!canInlineEditEntry(entry)) {
    pane.statusEl.textContent = t("files.error.copy_not_supported");
    return;
  }

  const rawTargetDir = await openTextInputDialog({
    title: t("files.menu.copy_to_target"),
    message: t("files.prompt.copy_target_dir"),
    defaultValue: pane.path,
    placeholder: pane.path,
  });
  if (!rawTargetDir) return;

  const targetDir = resolveSftpTargetPath(pane, rawTargetDir);
  const sourcePath = joinPanePath(pane, entry.name);
  const targetPath = joinPath(targetDir, entry.name);

  try {
    const doc = await invoke("sftp_read_text", {
      sftpId: pane.sftpId,
      path: sourcePath,
      maxBytes: FILE_EDITOR_MAX_BYTES,
    });
    const data = Array.from(new TextEncoder().encode(doc.content));
    const sourceLabel = `copy:${sourcePath}`;
    const uploadCopyBytes = (overwrite) =>
      invokeSftpTransferWithRetry(
        {
          matchKind: "upload",
          source: sourceLabel,
          destination: targetPath,
          retry: {
            action: "uploadBytes",
            paneKey: pane.key,
            remotePath: targetPath,
            data,
            sourceLabel,
            overwrite,
            refreshPaneKeys: targetDir === pane.path ? [pane.key] : [],
          },
        },
        () =>
          invoke("sftp_upload_bytes", {
            sftpId: pane.sftpId,
            remote: targetPath,
            data,
            sourceLabel,
            overwrite,
          }),
      );
    try {
      await uploadCopyBytes(false);
    } catch (e) {
      const err = normalizeSftpError(e);
      if (err.code !== "ALREADY_EXISTS") throw err;
      const ok = await showOverwriteConfirm(targetPath);
      if (!ok) return;
      await uploadCopyBytes(true);
    }
    pane.statusEl.textContent = t("files.status.copied_to", { name: entry.name, path: targetDir });
    if (targetDir === pane.path) {
      await navigateSftpPane(pane, pane.path);
    }
  } catch (e) {
    pane.statusEl.textContent = t("files.error.copy_failed", { error: normalizeSftpError(e).message });
  }
}

function normalizePermissionModeInput(raw) {
  const text = String(raw || "").trim();
  if (!/^[0-7]{3,4}$/.test(text)) return null;
  return text.length === 4 && text.startsWith("0") ? text.slice(1) : text;
}

async function editEntryPermissions(pane, entry) {
  if (!pane || !entry) return;
  const target = joinPanePath(pane, entry.name);
  let defaultMode = "644";
  try {
    const info = isLocalPane(pane)
      ? await invoke("local_permission_mode", { path: target })
      : await invoke("sftp_permission_mode", { sftpId: pane.sftpId, path: target });
    if (info?.mode !== undefined && info?.mode !== null) {
      defaultMode = Number(info.mode).toString(8).padStart(3, "0");
    }
  } catch (e) {
    console.warn("read permission mode failed", e);
  }
  const rawMode = await openPermissionsDialog({ defaultValue: defaultMode });
  if (rawMode === null) return;
  const modeText = normalizePermissionModeInput(rawMode);
  if (!modeText) {
    pane.statusEl.textContent = t("files.error.permissions_invalid");
    return;
  }
  const mode = Number.parseInt(modeText, 8);
  try {
    if (isLocalPane(pane)) {
      await invoke("local_chmod", { path: target, mode });
    } else {
      await invoke("sftp_chmod", { sftpId: pane.sftpId, path: target, mode });
    }
    pane.statusEl.textContent = t("files.status.permissions_updated", {
      name: entry.name,
      mode: modeText,
    });
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    pane.statusEl.textContent = String(e);
  }
}

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
    exec: () => saveRemoteEditor(),
  });
  fileEditorAce.commands.addCommand({
    name: "closeRemoteEditor",
    bindKey: { win: "Esc", mac: "Esc" },
    exec: () => closeRemoteEditor(),
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

function fileEditorSetModeByPath(path) {
  if (!ensureFileEditorAce()) return;
  const mode = detectAceModeByName(basename(path));
  fileEditorAce.session.setMode(`ace/mode/${mode}`);
}

function fileEditorFocus() {
  if (!ensureFileEditorAce()) return;
  fileEditorAce.focus();
}

function refreshFileEditorLayout() {
  if (!fileEditorAce) return;
  requestAnimationFrame(() => {
    if (!fileEditorAce) return;
    fileEditorAce.resize(true);
    fileEditorAce.renderer.updateFull();
  });
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

function openEditorFindInline(withReplace = false) {
  if (!fileEditorToolsInline) return;
  fileEditorToolsInline.hidden = false;
  if (fileEditorFindInline) {
    fileEditorFindInline.value = fileEditorFindInput.value || "";
  }
  if (fileEditorReplaceInline) {
    fileEditorReplaceInline.value = fileEditorReplaceInput.value || "";
    fileEditorReplaceInline.style.display = withReplace ? "" : "none";
  }
  requestAnimationFrame(() => {
    fileEditorFindInline?.focus();
    fileEditorFindInline?.select();
  });
}

function closeEditorFindInline() {
  if (!fileEditorToolsInline) return;
  fileEditorToolsInline.hidden = true;
  if (fileEditorReplaceInline) fileEditorReplaceInline.style.display = "none";
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

  if (!searchInEditor()) return;
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
  fileEditorState.paneKey = null;
  fileEditorState.path = "";
  fileEditorState.originalContent = "";
  fileEditorState.encoding = "UTF-8";
  fileEditorState.dirty = false;
  fileEditorState.saving = false;
  if (fileEditorAce) {
    fileEditorSetValue("");
    fileEditorSetReadOnly(false);
    fileEditorAce.session.setMode("ace/mode/text");
    fileEditorAce.clearSelection();
  }
  fileEditorFindInput.value = "";
  fileEditorReplaceInput.value = "";
  if (fileEditorFindInline) fileEditorFindInline.value = "";
  if (fileEditorReplaceInline) fileEditorReplaceInline.value = "";
  closeEditorFindInline();
  fileEditorMatchCaseInput.checked = false;
  fileEditorPath.textContent = "";
  fileEditorHint.textContent = t("editor.hint.default");
  fileEditorTitle.textContent = t("editor.title");
  fileEditorSaveButton.disabled = false;
  fileEditorCancelButton.disabled = false;
  setFileEditorError("");
}

function fileEditorTextInfo(content) {
  const encoding = fileEditorState.encoding || "UTF-8";
  const lines = String(content || "").split(/\r?\n/).length;
  const suffix = encoding === "UTF-8" ? "Ctrl/Cmd + S to save" : "read-only";
  return `${encoding} text · ${lines} lines · ${suffix}`;
}

async function openRemoteEditor(pane, entry) {
  if (!canInlineEditEntry(entry)) {
    alert(t("editor.alert.unsupported"));
    return;
  }
  if (!isPaneConnected(pane)) return;
  if (!ensureFileEditorAce()) {
    alert(t("editor.alert.component_failed"));
    return;
  }
  if (fileEditorState.open && fileEditorState.dirty) {
    const ok = confirm(t("editor.confirm.discard"));
    if (!ok) return;
  }

  resetFileEditorState();
  const path = joinPanePath(pane, entry.name);
  const maxBytes = fileEditorMaxBytesForName(entry.name);
  fileEditorOverlay.hidden = false;
  fileEditorTitle.textContent = t("editor.hint.opening");
  fileEditorPath.textContent = path;
  fileEditorHint.textContent = t("editor.hint.loading");
  fileEditorSetReadOnly(true);
  fileEditorSaveButton.disabled = true;
  refreshFileEditorLayout();

  try {
    const readCommand = isLocalPane(pane) ? "local_read_text" : "sftp_read_text";
    const readArgs = isLocalPane(pane)
      ? {
        path,
        maxBytes,
      }
      : {
        sftpId: pane.sftpId,
        path,
        maxBytes,
      };
    const doc = await invoke(readCommand, readArgs);
    fileEditorState.open = true;
    fileEditorState.paneKey = pane.key;
    fileEditorState.path = doc.path;
    fileEditorState.originalContent = doc.content;
    fileEditorState.encoding = String(doc.encoding || "UTF-8");
    fileEditorSetValue(doc.content);
    fileEditorSetModeByPath(doc.path);
    fileEditorPath.textContent = `${doc.path} · ${formatSize(doc.size)}`;
    fileEditorHint.textContent = fileEditorTextInfo(doc.content);
    const editable = fileEditorState.encoding === "UTF-8";
    fileEditorSetReadOnly(!editable);
    fileEditorSaveButton.disabled = !editable;
    setFileEditorDirty(false);
    refreshFileEditorLayout();
    fileEditorFocus();
  } catch (e) {
    fileEditorState.open = false;
    setFileEditorError(t("editor.error.open_failed", { error: e }));
    fileEditorHint.textContent = t("editor.hint.unavailable");
    fileEditorTitle.textContent = t("editor.title");
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
  if (!fileEditorState.open || fileEditorState.saving || !fileEditorState.paneKey) return;
  const pane = getSftpPane(fileEditorState.paneKey);
  if (!pane || !isPaneConnected(pane)) return;

  const content = fileEditorGetValue();
  fileEditorState.saving = true;
  fileEditorSaveButton.disabled = true;
  fileEditorCancelButton.disabled = true;
  setFileEditorError("");

  try {
    const writeCommand = isLocalPane(pane) ? "local_write_text" : "sftp_write_text";
    const writeArgs = isLocalPane(pane)
      ? {
        path: fileEditorState.path,
        content,
      }
      : {
        sftpId: pane.sftpId,
        path: fileEditorState.path,
        content,
      };
    const bytes = await invoke(writeCommand, writeArgs);
    fileEditorState.originalContent = content;
    setFileEditorDirty(false);
    fileEditorHint.textContent = t("editor.hint.saved", { size: formatSize(bytes) });
    pane.statusEl.textContent = t("files.status.saved_path", { path: fileEditorState.path });
    await navigateSftpPane(pane, pane.path);
  } catch (e) {
    setFileEditorError(t("editor.error.save_failed", { error: e }));
  } finally {
    fileEditorState.saving = false;
    fileEditorSaveButton.disabled = !fileEditorState.open;
    fileEditorCancelButton.disabled = false;
  }
}

for (const pane of Object.values(sftpPanes)) {
  pane.rootEl.addEventListener("dragenter", (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  pane.rootEl.addEventListener("dragover", (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  pane.rootEl.addEventListener("drop", async (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    const listTarget = pane.listEl && pane.listEl.contains(ev.target);
    if (listTarget) return;
    ev.preventDefault();
    try {
      if (canAcceptSftpDrag(pane, ev)) {
        const sourcePane = getSftpPane(sftpDragState.sourcePaneKey);
        const targetDir = pane.path;
        await copyDraggedEntriesToPane(sourcePane, pane, targetDir);
      } else if (canAcceptExternalUploadDrop(pane, ev)) {
        const payload = await collectDroppedUploadPayload(ev);
        await uploadDroppedPayloadToPane(pane, payload);
      }
    } finally {
      resetSftpDragState();
    }
  });

  pane.hostSelect.addEventListener("change", () => {
    pane.hostId = pane.hostSelect.value;
    pane.host = pane.hostId === LOCAL_HOST_ID
      ? null
      : hostsCache.find((h) => h.id === pane.hostId) || null;
    pane.hostSelect.title = pane.hostId === LOCAL_HOST_ID
      ? t("sftp.host.local")
      : pane.host
        ? `${pane.host.user}@${pane.host.host}:${pane.host.port}`
        : t("sftp.host.placeholder");
    updateSftpConnectButtons();

    const selectedHostId = pane.hostId;
    const selectedHost = pane.host;
    pane.autoConnectQueue = pane.autoConnectQueue
      .catch(() => {})
      .then(async () => {
        if (pane.hostId !== selectedHostId) return;
        if (selectedHostId === LOCAL_HOST_ID) {
          await connectLocalPane(pane);
          return;
        }
        if (!selectedHost) {
          if (isPaneConnected(pane)) {
            await disconnectSftpPane(pane);
          }
          return;
        }
        if (pane.sftpId !== null && pane.connectedHostId === selectedHost.id) {
          return;
        }
        await connectSftpPane(pane, selectedHost);
      })
      .catch((e) => {
        console.warn("auto connect failed", e);
      });
  });

  if (pane.emptySelectButton) {
    pane.emptySelectButton.addEventListener("click", () => {
      pane.hostSelect.focus();
      if (typeof pane.hostSelect.showPicker === "function") {
        pane.hostSelect.showPicker();
      } else {
        pane.hostSelect.click();
      }
    });
  }

  pane.pathbarEl.addEventListener("click", (ev) => {
    if (!isPaneConnected(pane)) return;
    if (pane.pathEditing) return;
    if (ev.target.closest(".sftp-crumb-btn")) return;
    setSftpPathEditMode(pane, true);
  });

  pane.upButton.addEventListener("click", async () => {
    if (!isPaneConnected(pane)) return;
    await navigateSftpPane(pane, paneParentPath(pane, pane.path));
  });

  pane.forwardButton.addEventListener("click", (ev) => {
    ev.preventDefault();
  });

  pane.filterInput.addEventListener("input", () => {
    pane.filterQuery = pane.filterInput.value.trim();
    renderSftpPane(pane);
  });

  pane.filterInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      pane.filterInput.value = "";
      pane.filterQuery = "";
      renderSftpPane(pane);
      pane.filterInput.blur();
      ev.preventDefault();
    }
  });

  pane.pathInputEl.addEventListener("keydown", async (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      setSftpPathEditMode(pane, false);
      return;
    }
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    if (!isPaneConnected(pane)) {
      setSftpPathEditMode(pane, false);
      return;
    }
    const target = resolveSftpTargetPath(pane, pane.pathInputEl.value);
    await navigateSftpPane(pane, target);
  });
  pane.pathInputEl.addEventListener("blur", () => {
    setSftpPathEditMode(pane, false);
  });

  pane.listEl.addEventListener("contextmenu", (ev) => {
    if (ev.target.closest(".sftp-row")) return;
    ev.preventDefault();
    showFilesContextMenu(pane, null, ev.clientX, ev.clientY);
  });
  pane.listEl.addEventListener("dragenter", (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  pane.listEl.addEventListener("dragover", (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
    const row = ev.target.closest(".sftp-row");
    if (row && canAcceptSftpDrag(pane, ev)) return;
    clearSftpDropVisuals();
    pane.rootEl?.classList.add("sftp-drop-target");
    sftpDragState.targetPaneKey = pane.key;
    sftpDragState.targetDir = pane.path;
  });
  pane.listEl.addEventListener("drop", async (ev) => {
    if (!canAcceptPaneDrop(pane, ev)) return;
    ev.preventDefault();
    const row = ev.target.closest(".sftp-row");
    if (row && canAcceptSftpDrag(pane, ev)) return;
    try {
      if (canAcceptSftpDrag(pane, ev)) {
        const sourcePane = getSftpPane(sftpDragState.sourcePaneKey);
        const targetDir = sftpDragState.targetDir || pane.path;
        await copyDraggedEntriesToPane(sourcePane, pane, targetDir);
      } else if (canAcceptExternalUploadDrop(pane, ev)) {
        const payload = await collectDroppedUploadPayload(ev);
        await uploadDroppedPayloadToPane(pane, payload);
      }
    } finally {
      resetSftpDragState();
    }
  });
  pane.listEl.addEventListener("dragleave", (ev) => {
    if (!ev.currentTarget.contains(ev.relatedTarget)) {
      clearSftpDropVisuals();
    }
  });
  pane.listEl.addEventListener("scroll", () => hideFilesContextMenu());
}

function getFilesContextPane() {
  return filesContextPaneKey ? getSftpPane(filesContextPaneKey) : null;
}

function getFilesContextEntry(pane) {
  if (!pane) return null;
  if (filesContextEntry) {
    const found = pane.entries.find((entry) => entry.name === filesContextEntry.name);
    if (found) return found;
  }
  return getPrimarySelectedEntry(pane);
}

function getFilesContextDeleteEntries(pane) {
  if (!pane) return [];
  const selected = getSelectedEntries(pane);
  if (selected.length > 0) return selected;
  const one = getFilesContextEntry(pane);
  return one ? [one] : [];
}

async function openSftpEntry(pane, entry, { forceEditor = false } = {}) {
  if (!pane || !isPaneConnected(pane) || !entry) return;
  if (entry.kind === "dir") {
    await navigateSftpPane(pane, joinPanePath(pane, entry.name));
    return;
  }
  if (entry.kind !== "file") return;
  const local = isLocalPane(pane);
  if (forceEditor || canInlineEditEntry(entry)) {
    if (!canInlineEditEntry(entry)) {
      alert(t("editor.alert.unsupported"));
      return;
    }
    await openRemoteEditor(pane, entry);
    return;
  }
  if (local) return;
  await sftpDownloadFile(pane, entry);
}

async function sftpDeleteEntries(pane, entries) {
  if (!pane || !isPaneConnected(pane) || entries.length === 0) return;
  if (entries.length === 1) {
    await sftpDeleteEntry(pane, entries[0]);
    pane.selectedEntries.delete(entries[0].name);
    return;
  }
  if (!confirm(t("files.confirm.delete_selected", { count: entries.length }))) return;

  for (const entry of entries) {
    const target = joinPanePath(pane, entry.name);
    try {
      if (isLocalPane(pane)) {
        const command = entry.kind === "dir" ? "local_remove_dir" : "local_remove";
        await invoke(command, { path: target });
      } else {
        const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
        await invoke(command, { sftpId: pane.sftpId, path: target });
      }
      pane.selectedEntries.delete(entry.name);
    } catch (e) {
      pane.statusEl.textContent = t("files.error.delete_failed_for", {
        name: entry.name,
        error: normalizeSftpError(e).message,
      });
      await navigateSftpPane(pane, pane.path);
      return;
    }
  }

  await navigateSftpPane(pane, pane.path);
}

filesMenuOpen.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !entry) return;
  await openSftpEntry(pane, entry);
});

filesMenuOpenWith.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !entry || entry.kind !== "file") return;
  await openEntryWithLocalApp(pane, entry);
});

filesMenuCopy.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane) || !entry) return;
  await sftpCopyEntry(pane, entry);
});

filesMenuRename.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !entry) return;
  await sftpRenameEntry(pane, entry);
});

filesMenuDelete.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entries = getFilesContextDeleteEntries(pane);
  hideFilesContextMenu();
  if (!pane || entries.length === 0) return;
  await sftpDeleteEntries(pane, entries);
});

filesMenuRefresh.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  await navigateSftpPane(pane, pane.path);
});

filesMenuMkdir.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  await sftpMkdir(pane);
});

filesMenuNewFile.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  await sftpCreateFile(pane);
});

filesMenuUpload.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || pane.sftpId === null) return;
  await sftpUpload(pane);
});

filesMenuHidden.addEventListener("click", () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  pane.showHidden = !pane.showHidden;
  renderSftpPane(pane);
  pane.statusEl.textContent = pane.showHidden ? t("files.status.hidden_shown") : t("files.status.hidden_hidden");
});

filesMenuPin.addEventListener("click", () => {
  const pane = getFilesContextPane();
  const path = pane ? getPinTargetPath(pane) : null;
  hideFilesContextMenu();
  if (!pane || !isTerminalSideSftpPane(pane) || !isPaneConnected(pane) || !path) return;
  if (isPinned(pane, path)) removePinnedPath(pane, path);
  else addPinnedPath(pane, path);
  renderPinMenu();
});

// ----- Pinned paths dropdown, anchored to the terminal SFTP 📌 button -----
const terminalSftpPin = document.getElementById("terminal-sftp-pin");
const terminalSftpPinMenu = document.getElementById("terminal-sftp-pin-menu");

if (terminalSftpPinMenu && terminalSftpPinMenu.parentElement !== document.body) {
  document.body.appendChild(terminalSftpPinMenu);
}

function renderPinMenu() {
  if (!terminalSftpPinMenu) return;
  const pane = sftpPanes.terminal;
  const connected = Boolean(pane && isPaneConnected(pane));
  terminalSftpPinMenu.innerHTML = "";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "sftp-pin-menu-add";
  addBtn.textContent = t("terminal_sftp.pin.add_dir");
  addBtn.disabled = !connected;
  addBtn.addEventListener("click", () => {
    if (connected) addPinnedPath(pane, pane.path);
    renderPinMenu();
  });
  terminalSftpPinMenu.appendChild(addBtn);

  const sep = document.createElement("div");
  sep.className = "menu-separator";
  terminalSftpPinMenu.appendChild(sep);

  const list = pane ? getPinnedForPane(pane) : [];
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sftp-pin-menu-empty";
    empty.textContent = t("terminal_sftp.pin.empty");
    terminalSftpPinMenu.appendChild(empty);
    return;
  }

  for (const p of list) {
    const row = document.createElement("div");
    row.className = "sftp-pin-menu-item";

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "sftp-pin-menu-jump";
    jump.title = p;
    jump.textContent = p;
    jump.disabled = !connected;
    jump.addEventListener("click", async () => {
      hidePinMenu();
      if (connected) await navigateSftpPane(pane, p);
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sftp-pin-menu-remove";
    del.title = t("terminal_sftp.pin.remove");
    del.setAttribute("aria-label", t("terminal_sftp.pin.remove"));
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removePinnedPath(pane, p);
      renderPinMenu();
    });

    row.appendChild(jump);
    row.appendChild(del);
    terminalSftpPinMenu.appendChild(row);
  }
}

function hidePinMenu() {
  if (terminalSftpPinMenu) terminalSftpPinMenu.hidden = true;
}

function showPinMenu() {
  if (!terminalSftpPinMenu || !terminalSftpPin) return;
  renderPinMenu();
  terminalSftpPinMenu.style.left = "0px";
  terminalSftpPinMenu.style.top = "0px";
  terminalSftpPinMenu.hidden = false;
  const pad = 8;
  const btn = terminalSftpPin.getBoundingClientRect();
  const rect = terminalSftpPinMenu.getBoundingClientRect();
  let left = btn.right - rect.width;
  let top = btn.bottom + 4;
  if (left < pad) left = pad;
  if (left + rect.width + pad > window.innerWidth) {
    left = Math.max(pad, window.innerWidth - rect.width - pad);
  }
  if (top + rect.height + pad > window.innerHeight) {
    top = Math.max(pad, btn.top - rect.height - 4);
  }
  terminalSftpPinMenu.style.left = `${left}px`;
  terminalSftpPinMenu.style.top = `${top}px`;
}

if (terminalSftpPin) {
  terminalSftpPin.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (terminalSftpPinMenu && terminalSftpPinMenu.hidden) showPinMenu();
    else hidePinMenu();
  });
}

window.addEventListener("click", (ev) => {
  if (
    terminalSftpPinMenu &&
    !terminalSftpPinMenu.hidden &&
    !terminalSftpPinMenu.contains(ev.target) &&
    ev.target !== terminalSftpPin &&
    !(terminalSftpPin && terminalSftpPin.contains(ev.target))
  ) {
    hidePinMenu();
  }
});

window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && terminalSftpPinMenu && !terminalSftpPinMenu.hidden) {
    hidePinMenu();
  }
});

filesMenuPermissions.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane) || !entry) return;
  await editEntryPermissions(pane, entry);
});

filesMenuSelectAll.addEventListener("click", () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  const visible = getVisibleEntriesForPane(pane);
  pane.selectedEntries = new Set(visible.map((entry) => entry.name));
  renderSftpPane(pane);
  pane.statusEl.textContent = t("files.status.selected_all", { count: pane.selectedEntries.size });
});

filesMenuEdit.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !entry || entry.kind !== "file") return;
  await openRemoteEditor(pane, entry);
});

filesMenuDownload.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  const entry = getFilesContextEntry(pane);
  hideFilesContextMenu();
  if (!pane || !entry || (entry.kind !== "file" && entry.kind !== "dir")) return;
  await sftpDownloadFile(pane, entry);
});

filesMenuClose.addEventListener("click", async () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  await disconnectSftpPane(pane);
  pane.hostId = "";
  pane.host = null;
  pane.connectedHostId = null;
  pane.hostSelect.value = "";
  pane.hostSelect.title = t("sftp.host.placeholder");
  if (pane.hostSelect?.id) syncCustomSelect(pane.hostSelect.id);
  renderSftpPane(pane);
});

document.querySelectorAll("[data-ai-example-key]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!aiComposeInput) return;
    const key = button.getAttribute("data-ai-example-key");
    aiComposeInput.value = key ? t(key) : button.textContent || "";
    aiComposeInput.focus();
  });
});

terminalSelectionMenuUrl?.addEventListener("click", () => {
  openTerminalSelectionUrl()
    .then(() => hideTerminalSelectionMenu())
    .catch(() => {});
});

terminalSelectionMenuSearch?.addEventListener("click", () => {
  searchTerminalSelectionText()
    .then(() => hideTerminalSelectionMenu())
    .catch(() => {});
});

terminalSelectionMenuCopy?.addEventListener("click", async () => {
  try {
    await copyTerminalSelectionMenuText();
    hideTerminalSelectionMenu();
  } catch {}
});

terminalSelectionMenuExecute?.addEventListener("click", () => {
  executeTerminalSelectionText()
    .catch((e) => {
      showToast(t("terminal.selection.execute_failed", { error: e }), "error", 3600);
    })
    .finally(() => hideTerminalSelectionMenu());
});

terminalSelectionMenuSftp?.addEventListener("click", () => {
  openTerminalSelectionPathInSftp()
    .catch((e) => {
      showToast(t("terminal.selection.sftp_failed", { error: e }), "error", 3600);
    })
    .finally(() => hideTerminalSelectionMenu());
});

terminalSelectionMenuAi?.addEventListener("click", () => {
  sendTerminalSelectionToAi()
    .then(() => hideTerminalSelectionMenu())
    .catch((e) => {
      hideTerminalSelectionMenu();
      appendAiMessage("error", String(e));
    });
});

aiComposeInput?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey) return;
  ev.preventDefault();
  aiComposeForm?.requestSubmit();
});

aiContextToggle?.addEventListener("click", cycleAiContextMode);

aiNewChatButton?.addEventListener("click", () => {
  if (aiMessages.length && !confirm(t(aiCurrentSessionTemporary ? "ai.session.confirm.new_temp" : "ai.session.confirm.new"))) return;
  startNewAiConversation();
  setAiSessionOpen(false);
  aiComposeInput?.focus();
});

aiTempChatButton?.addEventListener("click", () => {
  if (aiMessages.length && !confirm(t(aiCurrentSessionTemporary ? "ai.session.confirm.new_temp" : "ai.session.confirm.new"))) return;
  startNewAiConversation({ temporary: true });
  setAiSessionOpen(false);
  aiComposeInput?.focus();
});

aiSessionToggle?.addEventListener("click", () => {
  setAiSessionOpen(!aiSessionOpen);
});

aiSessionCurrentFilter?.addEventListener("click", () => {
  aiSessionFilter = "current";
  renderAiSessions();
});

aiSessionAllFilter?.addEventListener("click", () => {
  aiSessionFilter = "all";
  renderAiSessions();
});

aiSessionClose?.addEventListener("click", () => setAiSessionOpen(false));

aiSessionOverlay?.addEventListener("click", (ev) => {
  if (ev.target === aiSessionOverlay) setAiSessionOpen(false);
});

aiSessionClear?.addEventListener("click", async () => {
  const currentOnly = aiSessionFilter === "current";
  const scope = getAiSessionScope();
  const wasTemporary = aiCurrentSessionTemporary;
  const confirmText = currentOnly
    ? t("ai.session.confirm.clear_current", { scope: scope.scopeLabel })
    : t("ai.session.confirm.clear_all");
  if (!confirm(confirmText)) return;
  try {
    if (currentOnly) {
      const deletedCurrentSession = aiSessionItems.some((item) => item.id === aiCurrentSessionId && isAiSessionInCurrentScope(item));
      await invoke("clear_ai_sessions_for_scope", {
        input: {
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
        },
      });
      aiSessionItems = aiSessionItems.filter((item) => !isAiSessionInCurrentScope(item));
      clearAiSessionIdentitiesForScope(scope);
      if (!deletedCurrentSession && aiMessages.length) {
        aiCurrentSessionTemporary = wasTemporary;
        storeAiConversationForActivePane({ persist: false });
      }
    } else {
      await invoke("clear_ai_sessions");
      aiSessionItems = [];
      clearAiSessionIdentitiesForScope();
      if (aiMessages.length) {
        aiCurrentSessionTemporary = wasTemporary;
        storeAiConversationForActivePane({ persist: false });
      }
    }
    renderAiSessions();
    showToast(currentOnly ? t("ai.session.toast.cleared_current") : t("ai.session.toast.cleared_all"), "success", 1800);
  } catch (e) {
    showToast(t("ai.session.toast.clear_failed", { error: e }), "error", 3600);
  }
});

aiComposeForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (isAiSendingForPane()) {
    cancelAiStreaming().catch((e) => showToast(String(e), "error", 2600));
    return;
  }
  const text = aiComposeInput?.value.trim();
  if (!text) return;
  aiComposeInput.value = "";
  sendAiMessage(text).catch((e) => {
    appendAiMessage("error", String(e));
  });
});

updateAiSendButton();

fileEditorCancelButton.addEventListener("click", () => closeRemoteEditor());
fileEditorSaveButton.addEventListener("click", () => saveRemoteEditor());
// NOTE: clicking the backdrop intentionally does NOT close the editor —
// it's far too easy to nuke unsaved edits with a stray click. Use the
// Close button or Esc instead.
fileEditorFindPrevButton.addEventListener("click", () => searchInEditor({ backwards: true }));
fileEditorFindNextButton.addEventListener("click", () => searchInEditor());
fileEditorReplaceOneButton.addEventListener("click", () => replaceInEditor());
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
fileEditorInlineClose?.addEventListener("click", () => {
  closeEditorFindInline();
  fileEditorFocus();
});
fileEditorFindInline?.addEventListener("input", () => {
  fileEditorFindInput.value = fileEditorFindInline.value;
});
fileEditorReplaceInline?.addEventListener("input", () => {
  fileEditorReplaceInput.value = fileEditorReplaceInline.value;
});
fileEditorFindInline?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    fileEditorFindInput.value = fileEditorFindInline.value;
    searchInEditor({ backwards: ev.shiftKey });
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeEditorFindInline();
    fileEditorFocus();
  }
});
fileEditorReplaceInline?.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    fileEditorFindInput.value = fileEditorFindInline.value;
    fileEditorReplaceInput.value = fileEditorReplaceInline.value;
    replaceInEditor({ all: ev.shiftKey });
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeEditorFindInline();
    fileEditorFocus();
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && aiSessionOpen) {
    setAiSessionOpen(false);
    return;
  }
  if (fileEditorOverlay.hidden) return;
  const key = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key === "f") {
    ev.preventDefault();
    openEditorFindInline(false);
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && key === "r") {
    ev.preventDefault();
    openEditorFindInline(true);
  }
});

document.addEventListener("pointerdown", (ev) => {
  if (!filesContextMenu.hidden && !filesContextMenu.contains(ev.target)) {
    hideFilesContextMenu();
  }
  if (terminalSelectionMenu && !terminalSelectionMenu.hidden && !terminalSelectionMenu.contains(ev.target)) {
    hideTerminalSelectionMenu();
  }
});
document.addEventListener("dragend", () => {
  resetSftpDragState();
});
document.addEventListener("drop", () => {
  resetSftpDragState();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !filesContextMenu.hidden) {
    hideFilesContextMenu();
  }
  if (ev.key === "Escape" && terminalSelectionMenu && !terminalSelectionMenu.hidden) {
    hideTerminalSelectionMenu();
  }
  if (ev.key === "Escape" && settingsDataClearOverlay && !settingsDataClearOverlay.hidden) {
    setSettingsDataClearDialogOpen(false);
  }
});
window.addEventListener("resize", () => {
  if (!filesContextMenu.hidden) hideFilesContextMenu();
  if (terminalSelectionMenu && !terminalSelectionMenu.hidden) hideTerminalSelectionMenu();
  resetSftpDragState();
});
window.addEventListener("blur", () => hideTerminalSelectionMenu());

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

applyTerminalSelectionMenuOrder();
applyI18n();
loadNetworkProxyConfig({ quiet: true }).catch(() => {});
refreshVaultStatus();
function openSettingsPage() {
  setWorkspaceMode("settings");
}
