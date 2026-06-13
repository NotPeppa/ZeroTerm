// ZeroTerm desktop frontend (vanilla JS, no build step)

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window?.getCurrentWindow?.() || null;

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
    "sftp.button.connect": "Connect",
    "sftp.button.disconnect": "Disconnect",
    "sftp.button.filter": "Filter",
    "sftp.button.actions": "Actions",
    "sftp.helper.install.prompt": "SFTP directory follow is not configured on this host. Install now?",
    "sftp.helper.install.ok": "Install",
    "sftp.helper.install.cancel": "Later",
    "sftp.helper.install.success": "SFTP helper installed",
    "sftp.helper.install.failed": "SFTP helper install failed: {error}",
    "sftp.empty.connect_title": "Connect to host",
    "sftp.empty.connect_desc": "Please choose the host to connect above.",
    "sftp.empty.select_host": "Select host",
    "sftp.filter.title": "Filter",
    "sftp.filter.prompt": "Filter current pane by file/folder name (empty to clear):",
    "sftp.filter.placeholder": "e.g. log, conf, docker",
    "sftp.path.placeholder": "Enter path and press Enter (e.g. /var/log)",
    "hosts.search.placeholder": "Find a host or ssh user@hostname...",
    "hosts.new_host": "+ New host",
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
    "port_forward.status.stopped": "stopped",
    "port_forward.action.start": "Start",
    "port_forward.action.stop": "Stop",
    "port_forward.action.starting": "Starting...",
    "port_forward.action.stopping": "Stopping...",
    "port_forward.action.edit": "Edit",
    "port_forward.action.delete": "Delete",
    "port_forward.confirm.delete.title": "Delete port forward?",
    "port_forward.confirm.delete": "This rule will be removed from synced data. If it is running, ZeroTerm will stop it first.",
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
    "port_forward.editor.target_port": "Remote port",
    "port_forward.editor.hint.local": "Local forwards listen on a local port and access the remote service over SSH.",
    "port_forward.editor.hint.remote": "Remote forwards listen on the SSH server and connect back to a local service on this computer.",
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
    "settings.general.desc": "Configure language, session history, and SFTP-related options.",
    "settings.nav.pref": "Preferences",
    "settings.nav.general": "General",
    "settings.nav.terminal": "Terminal",
    "settings.nav.ai": "AI",
    "settings.nav.sync": "Sync",
    "settings.nav.data": "Data",
    "settings.nav.about": "About",
    "settings.general.subtab.basic": "Basic",
    "settings.general.subtab.sftp": "SFTP",
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
    "ai.context.toggle.title": "Toggle attaching current terminal output",
    "ai.context.toggle.label": "Auto-include terminal context",
    "ai.context.mode.smart": "Auto terminal context",
    "ai.context.mode.always": "Always include terminal",
    "ai.context.mode.off": "No terminal context",
    "ai.session.title": "AI Sessions",
    "ai.session.desc.current": "Only showing AI sessions for {scope}.",
    "ai.session.desc.all": "Showing all AI sessions saved on this device.",
    "ai.session.scope.global": "Global",
    "ai.session.scope.local": "Local terminal",
    "ai.session.scope.ssh": "SSH host",
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
    "settings.data.desc": "Clear all saved records and sync metadata. This action cannot be undone.",
    "settings.data.button.clear_vault": "Clear All Data",
    "settings.data.confirm.clear_vault": "Clear all data now? This cannot be undone.",
    "settings.data.status.cleared": "All data cleared",
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
    "settings.language.label": "Language",
    "settings.language.hint": "Changes apply immediately and are saved locally.",
    "settings.version.label": "Version",
    "settings.about.title": "About",
    "settings.about.author": "Author",
    "settings.about.repo": "GitHub Repository",
    "settings.about.tagline": "Next-gen, blazing-fast, modern cross-platform SSH terminal.",
    "settings.update.install": "Install & Restart",
    "settings.update.title": "System Update",
    "settings.update.checking": "Checking for updates or already up to date...",
    "settings.update.signature_invalid": "Update unavailable: the release server's signature isn't ready yet. Try again later.",
    "settings.update.latest": "You are on the latest version ({version}).",
    "settings.update.available": "Update available: {current} -> {latest}",
    "settings.update.failed": "Update failed: {error}",
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
    "settings.sftp.title": "SFTP",
    "settings.sftp.auto.label": "Auto-detect directory follow",
    "settings.sftp.auto.hint": "When opening SFTP, detect whether remote shell has directory-follow configured and prompt to install if missing.",
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
    "sftp.button.connect": "连接",
    "sftp.button.disconnect": "断开",
    "sftp.button.filter": "筛选",
    "sftp.button.actions": "操作",
    "sftp.helper.install.prompt": "该主机尚未配置 SFTP 目录跟随，是否现在安装？",
    "sftp.helper.install.ok": "安装",
    "sftp.helper.install.cancel": "稍后",
    "sftp.helper.install.success": "SFTP 辅助配置已安装",
    "sftp.helper.install.failed": "SFTP 辅助配置安装失败：{error}",
    "sftp.empty.connect_title": "连接到主机",
    "sftp.empty.connect_desc": "请在上方选择要连接的主机",
    "sftp.empty.select_host": "选择主机",
    "sftp.filter.title": "筛选",
    "sftp.filter.prompt": "按文件/目录名称筛选当前窗格（留空可清除）：",
    "sftp.filter.placeholder": "例如 log、conf、docker",
    "sftp.path.placeholder": "输入路径后按回车跳转（例如 /var/log）",
    "hosts.search.placeholder": "搜索主机或 ssh user@hostname...",
    "hosts.new_host": "+ 新建主机",
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
    "snippets.action.insert": "填入终端",
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
    "port_forward.status.stopped": "未启动",
    "port_forward.action.start": "启动",
    "port_forward.action.stop": "停止",
    "port_forward.action.starting": "启动中...",
    "port_forward.action.stopping": "停止中...",
    "port_forward.action.edit": "编辑",
    "port_forward.action.delete": "删除",
    "port_forward.confirm.delete.title": "删除端口转发？",
    "port_forward.confirm.delete": "这条规则会从同步数据中删除。如果正在运行，ZeroTerm 会先停止转发。",
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
    "port_forward.editor.target_port": "远端端口",
    "port_forward.editor.hint.local": "本地转发会监听本机端口，并通过 SSH 连接访问远端服务。",
    "port_forward.editor.hint.remote": "远程转发会监听服务器端口，并通过 SSH 反连到本机服务。",
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
    "settings.general.desc": "配置界面语言、会话历史和 SFTP 相关选项",
    "settings.nav.pref": "偏好",
    "settings.nav.general": "常规",
    "settings.nav.terminal": "终端",
    "settings.nav.ai": "AI",
    "settings.nav.sync": "同步",
    "settings.nav.data": "数据管理",
    "settings.nav.about": "关于",
    "settings.general.subtab.basic": "基础",
    "settings.general.subtab.sftp": "SFTP",
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
    "ai.context.toggle.title": "切换是否附带当前终端内容",
    "ai.context.toggle.label": "智能判断终端内容",
    "ai.context.mode.smart": "智能判断终端内容",
    "ai.context.mode.always": "总是附带终端内容",
    "ai.context.mode.off": "不附带终端内容",
    "ai.session.title": "AI 会话",
    "ai.session.desc.current": "当前只显示 {scope} 的 AI 会话。",
    "ai.session.desc.all": "当前显示本机保存的全部 AI 会话。",
    "ai.session.scope.global": "全局",
    "ai.session.scope.local": "本地终端",
    "ai.session.scope.ssh": "SSH 主机",
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
    "settings.data.desc": "清空当前保存的全部记录与同步元数据。此操作不可撤销。",
    "settings.data.button.clear_vault": "清空所有数据",
    "settings.data.confirm.clear_vault": "确定要清空全部数据吗？此操作不可撤销。",
    "settings.data.status.cleared": "数据已清空",
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
    "settings.language.label": "语言",
    "settings.language.hint": "修改立即生效，并会保存在本地。",
    "settings.version.label": "版本",
    "settings.about.title": "关于",
    "settings.about.author": "作者",
    "settings.about.repo": "GitHub 仓库",
    "settings.about.tagline": "下一代极速、现代的跨平台 SSH 终端工具",
    "settings.update.install": "安装并重启",
    "settings.update.title": "系统升级",
    "settings.update.checking": "正在检查更新或已经是最新版本...",
    "settings.update.signature_invalid": "暂时无法更新：发布服务器还没准备好签名，请稍后再试。",
    "settings.update.latest": "当前已是最新版本（{version}）。",
    "settings.update.available": "发现新版本：{current} -> {latest}",
    "settings.update.failed": "更新失败：{error}",
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
    "settings.sftp.title": "SFTP",
    "settings.sftp.auto.label": "自动检测目录配置",
    "settings.sftp.auto.hint": "打开 SFTP 标签页时，自动检测远端 shell 是否已配置目录跟随，未配置时提示自动安装。",
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
const aiComposeForm = document.getElementById("ai-compose-form");
const aiComposeInput = document.getElementById("ai-compose-input");
const aiChatLog = document.getElementById("ai-chat-log");
const aiEmptyState = document.getElementById("ai-empty-state");
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
const aiConfigOverlay = document.getElementById("ai-config-overlay");
const aiConfigTitle = document.getElementById("ai-config-title");
const settingsAiName = document.getElementById("settings-ai-name");
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

let aiMessages = [];
let aiSending = false;
let aiActiveRequestId = "";
let aiCanceling = false;
let aiStreamUnlistenPromise = null;
const aiConversationByPane = new Map();
const aiSessionIdentityByPane = new Map();
let aiCurrentSessionId = "";
let aiCurrentSessionCreatedAt = 0;
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
const AI_CONTEXT_MODES = ["smart", "always", "off"];
let aiContextMode = localStorage.getItem("zt.ai.contextMode") || "smart";
if (!AI_CONTEXT_MODES.includes(aiContextMode)) aiContextMode = "smart";
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
  await sendTextToPane(pane, String(command || ""), { submit: true });
  pane.term?.focus?.();
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
    terminalMetricsBody.innerHTML = `<div class="terminal-side-empty"><strong>${t("metrics.error", { error: String(e) })}</strong><p>${escapeMetricText(pane.host?.name || pane.host?.host || "Local")}</p></div>`;
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

function setTerminalSidePanel(panel) {
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
  if (terminalActiveSidePanel === "ai") refreshAiModelsOnFirstPanelOpen();
  if (terminalActiveSidePanel === "metrics") {
    renderMetricsPanel();
    startMetricsAutoRefresh();
  } else {
    stopMetricsAutoRefresh();
  }
  if (terminalActiveSidePanel === "sftp") {
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
}

function applyTerminalSidePanelForActivePane() {
  const paneKey = getAiPaneKey();
  const panel = paneKey === "no-terminal" ? null : (terminalSidePanelByPane.get(paneKey) || null);
  setTerminalSidePanel(panel);
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
    heading.innerHTML = `<span class="terminal-snippet-group-label">${group}</span><span class="terminal-snippet-group-meta"><span class="terminal-snippet-group-count">${items.length}</span><span class="terminal-snippet-group-chevron">${expanded ? "▾" : "▸"}</span></span>`;
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
        await executeAiCommand(snippet.command, { autoContinue: false });
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
    smart: t("ai.context.mode.smart"),
    always: t("ai.context.mode.always"),
    off: t("ai.context.mode.off"),
  };
  aiContextToggle.textContent = labels[aiContextMode];
  aiContextToggle.dataset.mode = aiContextMode;
}

function updateAiSendButton() {
  const button = aiComposeForm?.querySelector("button[type='submit']");
  if (!button) return;
  button.disabled = aiCanceling;
  button.setAttribute("aria-label", aiSending ? "停止 AI 分析" : "发送给 AI");
  button.title = aiSending ? "停止 AI 分析" : "发送给 AI";
  button.classList.toggle("is-stop", aiSending);
  button.innerHTML = aiSending
    ? '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'
    : '<svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true"><g transform="translate(24 0) scale(-1 1)"><path d="M4 12 20 5l-4 14-4.5-5-3 1.5 1.5-3Z"></path><path d="M10 14 20 5"></path></g></svg>';
}

async function cancelAiStreaming() {
  if (!aiSending || !aiActiveRequestId || aiCanceling) return;
  aiCanceling = true;
  updateAiSendButton();
  try {
    await invoke("cancel_ai_chat_stream", { requestId: aiActiveRequestId });
  } catch (e) {
    showToast(String(e), "error", 2600);
  } finally {
    aiCanceling = false;
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
  if (open) renderAiModelMenu();
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
      commandResults: Array.isArray(message?.commandResults)
        ? message.commandResults.map((result) => ({
          command: String(result?.command || ""),
          output: String(result?.output || ""),
        })).filter((result) => result.command.trim())
        : [],
    }))
    .filter((message) => ["user", "assistant", "error"].includes(message.role) && message.content.trim());
}

async function persistCurrentAiSession() {
  const messages = normalizeAiSessionMessages(aiMessages);
  if (!messages.length) return;
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
  aiSessionEmpty.hidden = items.length > 0;
  aiSessionEmpty.textContent = aiSessionFilter === "current" ? t("ai.session.empty.current") : t("ai.session.empty.all");
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
  aiMessages = normalizeAiSessionMessages(item?.messages || []);
  storeAiConversationForActivePane({ persist: false });
  renderAiConversation();
  renderAiSessions();
  setAiSessionOpen(false);
}

function startNewAiConversation() {
  aiMessages = [];
  resetAiSessionIdentity();
  storeAiConversationForActivePane({ persist: false });
  renderAiConversation();
  renderAiSessions();
}

function renderAiConversation() {
  if (!aiChatLog) return;
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
  renderAiConversation();
}

function storeAiConversationForActivePane({ persist = true } = {}) {
  const key = getAiPaneKey();
  aiActivePaneKey = key;
  aiConversationByPane.set(key, aiMessages);
  aiSessionIdentityByPane.set(aiSessionIdentityKey(), {
    id: aiCurrentSessionId,
    createdAt: aiCurrentSessionCreatedAt,
  });
  if (persist) {
    persistCurrentAiSession();
  }
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
        a.href = link?.[2] || "#";
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
  body.textContent = "";
  if (node.classList.contains("ai-message-assistant")) {
    body.appendChild(renderAiMarkdown(content));
    enhanceAiCodeBlocks(body);
  } else if (node.classList.contains("ai-message-error")) {
    body.appendChild(renderAiError(content));
  } else {
    body.textContent = content;
  }
  scrollAiPanelToBottom({ force: shouldStickToBottom });
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

function requestAiCommandApproval(command) {
  const text = normalizeAiCommandBlock(command);
  if (!text) return;
  return executeAiCommand(text, { autoContinue: false });
}

async function executeAiCommand(command, { autoContinue = true } = {}) {
  const pane = getActivePane();
  if (!pane?.sessionId) {
    showToast("当前没有可执行命令的终端会话。", "error", 3600);
    return;
  }
  const before = getActiveTerminalSnapshot(240);
  try {
    await sendTextToPane(pane, command, { submit: true });
    pane.term?.focus?.();
    await waitForTerminalOutputSettle(before, { maxMs: commandWaitMaxMs(command) });
    keepPaneTerminalAtBottom(pane, { force: true });
    const after = getActiveTerminalSnapshot(260);
    const output = after.startsWith(before) ? after.slice(before.length).trim() : after;
    const finalOutput = output || after;
    if (autoContinue) await continueAiAfterCommand(command, finalOutput);
    return finalOutput;
  } catch (e) {
    showToast(String(e), "error", 4200);
    throw e;
  }
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Terminal input regression checklist:
// 1. Windows local cmd.exe: AI click-to-run executes immediately.
// 2. Windows local snippets: single-click snippet executes immediately.
// 3. SSH/Linux shell: AI click-to-run still submits exactly once.
// 4. Manual keyboard typing/paste: Enter and paste behavior remain unchanged.
async function sendTextToPane(pane, text, { submit = false } = {}) {
  if (!pane?.sessionId) throw new Error("pane session is not available");
  const payload = submit ? buildApprovedCommandPayload(text, pane) : String(text || "");
  const bytes = Array.from(new TextEncoder().encode(payload));
  await invoke("send_input", { sessionId: pane.sessionId, data: bytes });
}

function buildApprovedCommandPayload(command, pane) {
  const text = String(command || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const enter = isWindowsPlatform && pane?.isLocal ? "\r" : "\n";
  return text.endsWith("\n") ? text.slice(0, -1) + enter : `${text}${enter}`;
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

async function continueAiAfterCommand(command, output) {
  const userGoal = [...aiMessages].reverse().find((m) => m.role === "user")?.content || "";
  const includeCommandOutput = aiContextMode !== "off";
  await streamAiMessages([
    {
      role: "system",
      content: [
        "你是 ZeroTerm 的 AI 助手。用户刚批准执行了一条命令。",
        "你的任务是根据这次命令输出继续推进用户目标，但不要为了推进而反复检查。",
        "先判断当前输出是否已经回答了用户的问题，或者已经暴露了明确异常。",
        "如果证据已经足够，必须停止继续排查，直接给出：结论、依据、影响、建议下一步。",
        "如果问题是配置缺失、服务未运行、依赖不存在、权限不足、资源不足、网络不通等，应给出可执行的修复方向，而不是继续搜集同类信息。",
        "只有在当前输出无法支持结论，且缺少一个关键事实时，才给下一条最有用的命令。",
        "每次最多建议一条命令，且每个 fenced code block 只能包含一条命令。",
        "引用终端输出、报错或日志时必须使用 ```terminal 代码块；只有真正需要用户批准执行的命令才使用 ```bash。",
        "不要重复建议已经执行过或等价的检查命令。",
        "不要假装执行未执行的命令。",
      ].join("\n"),
    },
    ...redactAiMessagesForRequest(aiMessages.slice(-6), { includeTerminalContent: includeCommandOutput }),
    { role: "user", content: userGoal },
    {
      role: "system",
      content: includeCommandOutput
        ? [
          "已批准并执行的命令：",
          "```bash",
          command,
          "```",
          "本次终端输出（已本地脱敏）：",
          "```terminal",
          redactSensitiveText(output),
          "```",
        ].join("\n")
        : [
          "已批准并执行的命令：",
          "```bash",
          command,
          "```",
          "用户当前选择了“不附带终端内容”，因此不要基于终端输出做判断，也不要声称看到了命令输出。",
        ].join("\n"),
    },
  ], "正在分析执行结果...");
}

async function continueAiAfterCommands(results, { totalCommands = 0 } = {}) {
  const executed = Array.isArray(results) ? results.filter((item) => item?.command) : [];
  if (!executed.length) return;
  const userGoal = [...aiMessages].reverse().find((m) => m.role === "user")?.content || "";
  const includeCommandOutput = aiContextMode !== "off";
  const blocks = [];
  executed.forEach((item, index) => {
    blocks.push(`命令 ${index + 1}：`);
    blocks.push("```bash");
    blocks.push(item.command);
    blocks.push("```");
    if (includeCommandOutput) {
      blocks.push("输出：");
      blocks.push("```terminal");
      blocks.push(redactSensitiveText(item.output || "(无输出)"));
      blocks.push("```");
    }
  });
  await streamAiMessages([
    {
      role: "system",
      content: [
        "你是 ZeroTerm 的 AI 助手。用户刚在同一条 AI 回复里批准执行了多条命令。",
        "你的任务是综合这些已执行命令的结果继续推进用户目标，但不要假装未执行的命令已经执行。",
        "如果证据已经足够，必须停止继续排查，直接给出：结论、依据、影响、建议下一步。",
        "如果当前结果已经能回答问题，不要再重复建议同类检查命令。",
        "只有在缺少一个关键事实时，才给下一条最有用的命令。",
        "每次最多建议一条命令，且每个 fenced code block 只能包含一条命令。",
        "引用终端输出、报错或日志时必须使用 ```terminal 代码块；只有真正需要用户批准执行的命令才使用 ```bash。",
        "不要假装执行未执行的命令。",
        includeCommandOutput
          ? "用户允许附带这些已执行命令的输出，你可以基于下面的输出继续分析。"
          : "用户当前选择了“不附带终端内容”，因此下面只提供已执行命令名称；不要基于终端输出做判断，也不要声称看到了命令输出。",
      ].join("\n"),
    },
    ...redactAiMessagesForRequest(aiMessages.slice(-6), { includeTerminalContent: includeCommandOutput }),
    { role: "user", content: userGoal },
    {
      role: "system",
      content: [
        `同一条 AI 回复中共有 ${totalCommands || executed.length} 条可执行命令，用户本次已执行 ${executed.length} 条。`,
        includeCommandOutput ? "仅基于下面这些已执行命令和输出继续分析：" : "仅基于下面这些已执行命令名称继续分析：",
        ...blocks,
      ].join("\n"),
    },
  ], "正在分析已执行命令...");
}

async function streamAiMessages(messages, pendingText = "正在思考...") {
  await ensureAiStreamListener();
  if (!window.__ztAiStreams) window.__ztAiStreams = new Map();
  const pendingNode = appendAiMessage("assistant", pendingText, { pending: true });
  const requestId = `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  aiActiveRequestId = requestId;
  updateAiSendButton();
  window.__ztAiStreams.set(requestId, { node: pendingNode, content: "" });
  const timeoutId = window.setTimeout(() => {
    const state = window.__ztAiStreams?.get?.(requestId);
    if (!state) return;
    state.node.classList.remove("pending");
    state.node.className = "ai-message ai-message-error";
    setAiMessageContent(state.node, "AI 响应超时，请重试。");
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
      if (content.trim()) {
        state.node.classList.remove("pending");
        state.node.className = "ai-message ai-message-assistant";
        setAiMessageContent(state.node, content);
        const assistantMessage = { role: "assistant", content, commandResults: [] };
        aiMessages.push(assistantMessage);
        aiMessageByNode.set(state.node, assistantMessage);
        storeAiConversationForActivePane();
      } else {
        state.node.classList.remove("pending");
        state.node.className = "ai-message ai-message-error";
        setAiMessageContent(state.node, "AI 流式响应失败，且非流式重试没有返回内容。");
      }
    } catch (fallbackError) {
      state.node.classList.remove("pending");
      state.node.className = "ai-message ai-message-error";
      setAiMessageContent(state.node, `AI 响应失败：${String(fallbackError || e)}`);
    } finally {
      if (aiActiveRequestId === requestId) aiActiveRequestId = "";
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

function ensureAiMultiCommandControls(messageNode, totalCommands) {
  if (!messageNode || totalCommands < 1) return null;
  let state = aiMultiCommandState.get(messageNode);
  if (!state) {
    state = {
      totalCommands,
      executedCount: 0,
      lastContinuedCount: 0,
      results: [],
      continuing: false,
      controls: null,
      hint: null,
      button: null,
    };
    const message = aiMessageByNode.get(messageNode);
    const storedResults = Array.isArray(message?.commandResults) ? message.commandResults : [];
    if (storedResults.length) {
      state.results = storedResults.map((item) => ({
        command: String(item?.command || ""),
        output: String(item?.output || ""),
      })).filter((item) => item.command.trim());
      state.executedCount = state.results.length;
      state.lastContinuedCount = 0;
    }
    aiMultiCommandState.set(messageNode, state);
  } else {
    state.totalCommands = Math.max(state.totalCommands || 0, totalCommands);
  }
  if (!state.controls || !state.controls.isConnected) {
    const body = messageNode.querySelector(".ai-message-body");
    if (!body) return state;
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
      if (!current.results.length) {
        showToast("请先执行至少一条命令，再继续分析。", "error", 3200);
        return;
      }
      current.continuing = true;
      updateAiMultiCommandControls(messageNode);
      try {
        await continueAiAfterCommands(current.results, { totalCommands: current.totalCommands });
        current.lastContinuedCount = current.executedCount;
      } finally {
        current.continuing = false;
        updateAiMultiCommandControls(messageNode);
      }
    });
    controls.append(hint, button);
    body.appendChild(controls);
    state.controls = controls;
    state.hint = hint;
    state.button = button;
  }
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
    ? `这条回复里有 ${total} 条可执行命令，已执行 ${executed} 条${pending ? `，剩余 ${pending} 条` : ""}。`
    : `这条回复里有 ${total} 条可执行命令；你可以执行后，再手动继续分析。`;
  if (state.continuing) {
    state.button.disabled = true;
    state.button.textContent = "分析中...";
    return;
  }
  if (!executed) {
    state.button.disabled = true;
    state.button.textContent = "继续分析";
    return;
  }
  const dirty = executed > (state.lastContinuedCount || 0);
  state.button.disabled = !dirty;
  state.button.textContent = dirty ? "继续分析" : "已分析";
}

function storeAiCommandResultForMessage(messageNode, result) {
  const message = aiMessageByNode.get(messageNode);
  if (!message || !result?.command) return;
  if (!Array.isArray(message.commandResults)) message.commandResults = [];
  message.commandResults = message.commandResults.filter((item) => item.command !== result.command);
  message.commandResults.push({
    command: result.command,
    output: redactSensitiveText(result.output || ""),
  });
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

function isNonPublicIpv4(ip) {
  const parts = ip.split(".").map((v) => Number(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

function isNonPublicIpv6(ip) {
  const normalized = String(ip || "").toLowerCase();
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd");
}

function looksLikeClockTime(value) {
  return /^\d{1,2}:\d{2}:\d{2}$/.test(String(value || ""));
}

function redactSensitiveText(text) {
  let out = String(text || "");
  out = out.replace(/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_\-]{16,}\b/g, "[REDACTED_API_KEY]");
  out = out.replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_GITHUB_TOKEN]");
  out = out.replace(/\b(?:xox[baprs]-)[A-Za-z0-9-]{16,}\b/g, "[REDACTED_SLACK_TOKEN]");
  out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]");
  out = out.replace(/\b(?:Bearer|Token|Authorization:)\s+[^\s]+/gi, "$1 [REDACTED_SECRET]");
  out = out.replace(/\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*([^\s"']+)/gi, "$1=[REDACTED_SECRET]");
  out = out.replace(/\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "[REDACTED_MAC]");
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED_UUID]");
  out = out.replace(/\b(?:[A-Z0-9][A-Z0-9_-]{7,})(?:\b)/g, (match) => {
    if (/^[0-9]+$/.test(match)) return match;
    if (/^\d{2,4}(?:[-_]\d{2,6})+$/.test(match)) return match;
    return match.length >= 12 ? "[REDACTED_ID]" : match;
  });
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (ip) => isNonPublicIpv4(ip) ? ip : "[REDACTED_PUBLIC_IP]");
  out = out.replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}(?:%[\w.-]+)?(?![\w:])/gi, (ip) => {
    if (looksLikeClockTime(ip)) return ip;
    const plain = ip.replace(/%.*$/, "");
    return isNonPublicIpv6(plain) ? ip : "[REDACTED_PUBLIC_IPV6]";
  });
  out = out.replace(/(?<![\w:])::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}(?:%[\w.-]+)?(?![\w:])/gi, (ip) => {
    const plain = ip.replace(/%.*$/, "");
    return isNonPublicIpv6(plain) ? ip : "[REDACTED_PUBLIC_IPV6]";
  });
  out = out.replace(/(^|\s)([\w.-]+@[A-Za-z0-9_.-]+)(?=[:#$]\s?)/g, "$1[REDACTED_HOST_PROMPT]");
  return out;
}

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
  if (aiContextMode === "always") return true;
  const q = String(text || "").toLowerCase();
  if (!q.trim()) return false;
  return /终端|命令|输出|结果|报错|错误|日志|执行|刚才|上面|当前|这台|机器|服务器|主机|系统|环境|配置|性能|cpu|内存|磁盘|硬盘|网络|公网|ip|端口|进程|服务|登录|连接|ssh|shell|目录|文件|项目|部署|安装|启动|运行|检查|看看|分析|诊断/.test(q);
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
          const output = await executeAiCommand(singleCommand, { autoContinue: false });
          if (commandState) {
            const result = { command: singleCommand, output: output || "" };
            commandState.results.push(result);
            commandState.executedCount += 1;
            storeAiCommandResultForMessage(messageNode, result);
            updateAiMultiCommandControls(messageNode);
          }
          run.textContent = "已执行";
        } catch {
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
  setAiMessageContent(node, content);
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
        state.node.classList.remove("pending");
        state.node.className = "ai-message ai-message-error";
        setAiMessageContent(state.node, payload.error);
      }
      if (aiActiveRequestId === payload.requestId) aiActiveRequestId = "";
      window.__ztAiStreams.delete(payload.requestId);
      return;
    }
    if (payload.delta) {
      state.content += payload.delta;
      state.node.classList.remove("pending");
      state.node.className = "ai-message ai-message-assistant";
      setAiMessageContent(state.node, state.content);
    }
    if (payload.done) {
      if (state.timeoutId) window.clearTimeout(state.timeoutId);
      state.node.classList.remove("pending");
      if (aiActiveRequestId === payload.requestId) aiActiveRequestId = "";
      if (!state.content.trim()) {
        state.node.className = "ai-message ai-message-error";
        setAiMessageContent(state.node, "AI 没有返回内容，请重试。");
        window.__ztAiStreams.delete(payload.requestId);
        return;
      }
      const assistantMessage = { role: "assistant", content: state.content, commandResults: [] };
      aiMessages.push(assistantMessage);
      aiMessageByNode.set(state.node, assistantMessage);
      storeAiConversationForActivePane();
      window.__ztAiStreams.delete(payload.requestId);
    }
  });
}

async function loadAiConfig() {
  try {
    const store = await invoke("get_ai_config");
    applyAiStore(store);
  } catch (e) {
    if (settingsAiStatus) settingsAiStatus.textContent = String(e);
  }
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
  if (aiSending) return;
  syncAiConversationToActivePane();
  aiSending = true;
  await ensureAiStreamListener();
  if (!window.__ztAiStreams) window.__ztAiStreams = new Map();
  updateAiSendButton();
  try {
    aiMessages.push({ role: "user", content: text, commandResults: [] });
    storeAiConversationForActivePane();
    appendAiMessage("user", text);
    const system = "你是 ZeroTerm 的 AI 助手。用户是普通用户，不一定懂命令。请先用人话解释和规划，不要假装已经执行命令。需要用户执行命令时，一次只建议下一条最有用的命令；每个 bash/shell fenced code block 只能包含一条命令。引用终端输出、报错或日志时必须使用 ```terminal 代码块，不要使用 bash。";
    const terminalContext = shouldAttachTerminalContext(text) ? buildAiTerminalContext() : "";
    const messages = [{ role: "system", content: system }];
    if (terminalContext) messages.push({ role: "system", content: terminalContext });
    messages.push(...redactAiMessagesForRequest(aiMessages.slice(-10), { includeTerminalContent: aiContextMode !== "off" }));
    await streamAiMessages(messages);
  } catch (e) {
    appendAiMessage("error", String(e));
  } finally {
    aiSending = false;
    aiActiveRequestId = "";
    updateAiSendButton();
  }
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
const settingsDataClearVault = document.getElementById("settings-data-clear-vault");
const settingsDataStatus = document.getElementById("settings-data-status");
const settingsGeneralSubtabBasic = document.getElementById("settings-general-subtab-basic");
const settingsGeneralSubtabSftp = document.getElementById("settings-general-subtab-sftp");
const settingsGeneralBasicSection = document.getElementById("settings-general-basic-section");
const settingsGeneralSftpSection = document.getElementById("settings-general-sftp-section");
const settingsGeneralTitle = document.getElementById("settings-general-title");
const settingsGeneralDesc = document.getElementById("settings-general-desc");
const settingsLanguageSelect = document.getElementById("settings-language-select");
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
const settingsTerminalTheme = document.getElementById("settings-terminal-theme");
const settingsTerminalSubtabTheme = document.getElementById("settings-terminal-subtab-theme");
const settingsTerminalSubtabFont = document.getElementById("settings-terminal-subtab-font");
const settingsTerminalThemeSection = document.getElementById("settings-terminal-theme-section");
const settingsTerminalFontSection = document.getElementById("settings-terminal-font-section");
const settingsTerminalFontFamily = document.getElementById("settings-terminal-font-family");
const settingsTerminalFontSize = document.getElementById("settings-terminal-font-size");
const settingsTerminalLineHeight = document.getElementById("settings-terminal-line-height");
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
const settingsSftpAutoDetect = document.getElementById("settings-sftp-auto-detect");
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
let sftpFollowPollTimer = null;
let sftpFollowPollingTick = false;
const SETTINGS_KEY_SFTP_AUTO_DETECT = "zeroterm.settings.sftp.auto_detect";
const SETTINGS_KEY_SFTP_LOCAL_DIR = "zeroterm.settings.sftp.local_dir";
const SETTINGS_KEY_SYNC_AUTO = "zeroterm.settings.sync.auto";
const SETTINGS_KEY_SYNC_ACTIVE_PROFILE = "zeroterm.settings.sync.active_profile";
const SETTINGS_KEY_APP_THEME_MODE = "zeroterm.settings.app_theme_mode";
const SETTINGS_KEY_TERMINAL_THEME = "zeroterm.settings.terminal.theme";
const SETTINGS_KEY_TERMINAL_CUSTOM_THEMES = "zeroterm.settings.terminal.custom_themes";
const SETTINGS_KEY_TERMINAL_HIDDEN_BUILTIN_THEMES = "zeroterm.settings.terminal.hidden_builtin_themes";
const SETTINGS_KEY_TERMINAL_FONT_FAMILY = "zeroterm.settings.terminal.font_family";
const SETTINGS_KEY_TERMINAL_FONT_SIZE = "zeroterm.settings.terminal.font_size";
const SETTINGS_KEY_TERMINAL_LINE_HEIGHT = "zeroterm.settings.terminal.line_height";
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
  // the image shows through (glass mode). Without one, use the theme's own
  // background colour so each theme paints its proper backdrop and text
  // contrast holds even when the theme's light/dark doesn't match the app.
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
      appWindow.close().catch((e) => {
        console.warn("close failed", e);
      });
    });
  }
  syncWindowMaximizeButtonState();
}

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

function openConfirmDialog({ title, message = "", okText = "OK", cancelText = "Cancel" } = {}) {
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
    if (settingsSftpAutoDetect) {
      settingsSftpAutoDetect.checked = localStorage.getItem(SETTINGS_KEY_SFTP_AUTO_DETECT) !== "0";
    }
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
    const card = document.createElement("article");
    card.className = "port-forward-card" + (row.active ? " active" : "");

    const head = document.createElement("div");
    head.className = "port-forward-card-head";
    const title = document.createElement("div");
    title.innerHTML = `<strong></strong><span></span>`;
    title.querySelector("strong").textContent = friendlyForwardTitle(row.forward);
    title.querySelector("span").textContent = `${row.hostName} · ${row.active ? t("port_forward.status.running") : t("port_forward.status.stopped")}`;

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
    ? "general"
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
  if (settingsTerminalPanel) settingsTerminalPanel.hidden = true;
  if (settingsAiPanel) settingsAiPanel.hidden = settingsSection !== "ai";
  if (settingsSyncPanel) settingsSyncPanel.hidden = settingsSection !== "sync";
  settingsPageBody?.classList.toggle("settings-sync-scrollbar", settingsSection === "sync");
  if (settingsDataPanel) settingsDataPanel.hidden = settingsSection !== "data";
  if (settingsAboutPanel) settingsAboutPanel.hidden = settingsSection !== "about";
  if (settingsSection === "ai") {
    maybeAutoRefreshAiModels().catch(() => {});
  }
  if (settingsGeneralTitle) {
    settingsGeneralTitle.textContent = settingsSection === "ai"
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
    settingsGeneralDesc.textContent = settingsSection === "ai"
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
      const li = document.createElement("li");
      li.className = "settings-sync-device-row";
      const main = document.createElement("div");
      main.className = "settings-sync-device-main";
      const name = document.createElement("strong");
      name.textContent = device.name || device.deviceId || device.device_id || t("settings.sync.devices.this_device");
      if (device.isCurrent || device.is_current) {
        const badge = document.createElement("em");
        badge.className = "settings-sync-device-current";
        badge.textContent = t("settings.sync.devices.current_badge");
        name.appendChild(document.createTextNode(" "));
        name.appendChild(badge);
      }
      const idText = document.createElement("span");
      idText.textContent = device.deviceId || device.device_id || "";
      main.append(name, idText);
      const lastSeen = document.createElement("span");
      lastSeen.className = "settings-sync-device-seen";
      const at = Number(device.lastSeenAt ?? device.last_seen_at ?? 0);
      lastSeen.textContent = at > 0
        ? t("settings.sync.devices.last_seen", { when: formatRelativeTime(at) })
        : "";
      li.append(main, lastSeen);
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
  if (!autoSyncEnabled() && reason === "heartbeat") return null;
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
    if (!preserveQuery) triggerInput.value = "";
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
  setAttr("lock-button", "title", "sidebar.lock");
  setAttr("window-minimize", "title", "window.minimize");
  setAttr("window-close", "title", "window.close");
  setWindowMaximizeButtonState(windowIsMaximized);

  setPlaceholder("host-search", "hosts.search.placeholder");
  setAttr("add-host-button", "title", "hosts.new_host");
  setText("hosts-empty-title", "hosts.empty.title");
  setText("hosts-empty-desc", "hosts.empty.default");
  setText("hosts-empty-add", "hosts.new_host");

  setPlaceholder("sftp-left-path-input", "sftp.path.placeholder");
  setPlaceholder("sftp-right-path-input", "sftp.path.placeholder");
  setText("sftp-left-filter-label", "sftp.button.filter");
  setText("sftp-right-filter-label", "sftp.button.filter");
  setPlaceholder("sftp-left-filter-input", "sftp.filter.placeholder");
  setPlaceholder("sftp-right-filter-input", "sftp.filter.placeholder");
  setText("sftp-right-empty-title", "sftp.empty.connect_title");
  setText("sftp-right-empty-desc", "sftp.empty.connect_desc");
  setText("files-menu-open", "files.menu.open");
  setText("files-menu-open-with", "files.menu.open_with");
  setText("files-menu-copy", "files.menu.copy_to_target");
  setText("files-menu-refresh", "files.button.refresh");
  setText("files-menu-mkdir", "files.button.new_folder");
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
  setAttr("ai-context-toggle", "title", "ai.context.toggle.title");
  setText("ai-session-dialog-title", "ai.session.title");
  setText("ai-session-close", "ai.session.close");
  setText("ai-session-current-filter", "ai.session.filter.current");
  setText("ai-session-all-filter", "ai.session.filter.all");
  setAttr("ai-session-filter", "aria-label", "ai.session.filter.aria");
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
  setText("settings-sftp-title", "settings.sftp.title");
  setText("settings-sftp-auto-label", "settings.sftp.auto.label");
  setText("settings-sftp-auto-hint", "settings.sftp.auto.hint");
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
  setText("settings-data-clear-vault", "settings.data.button.clear_vault");
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
      setText("file-editor-hint", "editor.hint.utf8_info", {
        lines: fileEditorGetValue().split(/\r?\n/).length,
      });
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
settingsDataClearVault?.addEventListener("click", async () => {
  const ok = confirm(t("settings.data.confirm.clear_vault"));
  if (!ok) return;
  await runSyncButtonAction(settingsDataClearVault, t("settings.data.button.clear_vault"), async () => {
    try {
      await invoke("clear_vault_data");
      if (settingsDataStatus) settingsDataStatus.textContent = t("settings.data.status.cleared");
      await refreshAllSyncedViewsFromVault();
      await loadSyncProfiles().catch(() => {});
      showToast(t("settings.data.status.cleared"), "success");
    } catch (e) {
      const msg = String(e);
      if (settingsDataStatus) settingsDataStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});
settingsUpdateInstall?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsUpdateInstall, t("settings.update.status.installing"), async () => {
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
settingsSftpAutoDetect?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_SFTP_AUTO_DETECT, settingsSftpAutoDetect.checked ? "1" : "0");
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
    dataUnlisten: null,
    latencyUnlisten: null,
    closedUnlisten: null,
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
  await waitForTerminalFonts();
  await stabilizePaneSize(pane, 2);

  const cols = pane.term ? pane.term.cols : 80;
  const rows = pane.term ? pane.term.rows : 24;
  const sessionId = await invoke("create_local_terminal_session", { cols, rows });
  pane.sessionId = sessionId;
  pane.statusEl.textContent = t("terminal.status.local");
  if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;
  await wirePaneSessionEvents(pane, sessionId);
  pane.reconnectFactory = async () => {
    const cols2 = pane.term ? pane.term.cols : 80;
    const rows2 = pane.term ? pane.term.rows : 24;
    const sid2 = await invoke("create_local_terminal_session", { cols: cols2, rows: rows2 });
    pane.sessionId = sid2;
    if (pane.statusEl) pane.statusEl.textContent = t("terminal.status.local");
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = true;
    await wirePaneSessionEvents(pane, sid2);
  };
}

function renderTerminalWorkspace() {
  sanitizeTerminalTabs();
  renderTabStrip();
  syncAiConversationToActivePane();
  applyTerminalSidePanelForActivePane();
  renderTerminalCommandSnippets();
  if (terminalActiveSidePanel === "metrics") renderMetricsPanel();
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
    };
    const onUp = () => {
      document.body.classList.remove("resizing-ai-panel");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
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

function renderTabStrip() {
  termTabStrip.innerHTML = "";

  for (const tab of termState.tabs) {
    const el = document.createElement("div");
    el.className = "tab-item" + (tab.id === termState.activeTabId ? " active" : "");
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
    // The WebGL renderer (macOS) draws dim / low-contrast text — e.g. the
    // zsh-autosuggestions ghost suggestion (default fg=8) — with reduced
    // alpha, which looks washed-out/"发虚". Forcing a minimum fg/bg contrast
    // ratio lifts only the too-faint text to a readable solid color; normal
    // high-contrast text already exceeds the ratio and is untouched. Left at
    // the default (1 = off) on Windows/Linux, whose DOM renderer shows faint
    // text fine.
    minimumContrastRatio: isMacPlatform ? 4.5 : 1,
    cursorBlink: true,
    allowProposedApi: true,
    customGlyphs: true,
    rescaleOverlappingGlyphs: false,
    scrollback: 10000,
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
        // Mac: Option+Click; Windows/Linux: Ctrl+Click
        if (isMacPlatform ? !event?.altKey : !event?.ctrlKey) return;
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
    // Use the WebGL renderer when available. It draws each glyph at an
    // absolute cell position, which fixes the cumulative left-to-right
    // character drift the DOM renderer exhibits on Retina/macOS with a custom
    // monospace font — the drift shows up as garbled lines when zsh redraws
    // the whole input line on history recall (up-arrow). Gated to macOS so the
    // confirmed-good Windows DOM rendering is left untouched. If the GPU
    // context is unavailable or later lost, dispose the addon so xterm falls
    // back to the DOM renderer automatically.
    try {
      const WebglAddonCtor = window.WebglAddon?.WebglAddon;
      if (isMacPlatform && WebglAddonCtor) {
        const webgl = new WebglAddonCtor();
        webgl.onContextLoss(() => {
          try { webgl.dispose(); } catch {}
          pane.webglAddon = null;
        });
        pane.term.loadAddon(webgl);
        pane.webglAddon = webgl;
      }
    } catch (e) {
      console.warn("webgl renderer unavailable, falling back to DOM renderer", e);
      pane.webglAddon = null;
    }
    pane.bodyEl.addEventListener("wheel", (ev) => {
      if (!pane.term) return;
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
    if (pane.sessionId === null) return;
    sendTextToPane(pane, d).catch((e) => {
      console.warn("send_input failed", e);
    });
  });

  pane.term.onScroll(() => {
    syncPaneViewportScroll(pane);
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
            if (isMacPlatform ? !event?.altKey : !event?.ctrlKey) return;
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
            if (isMacPlatform ? !event?.altKey : !event?.ctrlKey) return;
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

function writePaneTerminalData(pane, data, { stickToBottom = false } = {}) {
  if (!pane?.term) return;
  pane.term.write(data, () => {
    if (!pane.term) return;
    if (stickToBottom) pane.term.scrollToBottom();
    syncPaneViewportScroll(pane);
    refreshPaneTerminal(pane);
  });
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let terminalFontsReadyPromise = null;

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
    fitPane(pane);
  }
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
  await waitForTerminalFonts();
  await stabilizePaneSize(pane, 2);

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
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }

  pane.dataUnlisten = await listen("session:data", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    if (!pane.term) return;
    const stickToBottom = isPaneTerminalNearBottom(pane);
    writePaneTerminalData(pane, new Uint8Array(ev.payload.data), { stickToBottom });
  });

  pane.latencyUnlisten = await listen("session:latency", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    if (!pane.latencyEl) return;
    const rtt = Number(ev.payload.rttMs);
    if (!Number.isFinite(rtt) || rtt < 0) return;
    pane.latencyEl.textContent = `${Math.round(rtt)}ms`;
    pane.latencyEl.hidden = false;
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
    if (pane.latencyEl) pane.latencyEl.hidden = true;
    if (pane.reconnectBtn) pane.reconnectBtn.hidden = false;
    if (pane.term) writePaneTerminalData(pane, tail, { stickToBottom: true });
  });

}

async function disconnectPaneSession(pane, { dispose }) {
  const sid = pane.sessionId;
  pane.sessionId = null;
  pane.lastSentCols = 0;
  pane.lastSentRows = 0;

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
  if (pane.latencyUnlisten) {
    pane.latencyUnlisten();
    pane.latencyUnlisten = null;
  }
  if (pane.closedUnlisten) {
    pane.closedUnlisten();
    pane.closedUnlisten = null;
  }

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

    if (pane.term) pane.term.dispose();
    pane.term = null;
    pane.fitAddon = null;
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

let editingHostId = null;
let hfKeyPem = null;
let hfForwards = [];

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

hfPasswordToggle?.addEventListener("click", () => {
  const show = hfPassword.type === "password";
  hfPassword.type = show ? "text" : "password";
  syncPasswordToggleButton(hfPasswordToggle, show, { show: "显示密码", hide: "隐藏密码" });
});
hfKeyPassphraseToggle?.addEventListener("click", () => {
  const show = hfKeyPassphrase.type === "password";
  hfKeyPassphrase.type = show ? "text" : "password";
  syncPasswordToggleButton(hfKeyPassphraseToggle, show, { show: "显示口令", hide: "隐藏口令" });
});
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
const filesMenuUpload = document.getElementById("files-menu-upload");
const filesMenuHidden = document.getElementById("files-menu-hidden");
const filesMenuPermissions = document.getElementById("files-menu-permissions");
const filesMenuSelectAll = document.getElementById("files-menu-select-all");
const filesMenuEdit = document.getElementById("files-menu-edit");
const filesMenuDownload = document.getElementById("files-menu-download");
const filesMenuCloseSeparator = document.getElementById("files-menu-close-separator");
const filesMenuClose = document.getElementById("files-menu-close");
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
    lastUserNavAt: 0,
    followLockedByUser: false,
    autoConnectQueue: Promise.resolve(),
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
    lastUserNavAt: 0,
    followLockedByUser: false,
    autoConnectQueue: Promise.resolve(),
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
        await invoke("sftp_upload", {
          sftpId: pane.sftpId,
          local: nativePath,
          remote: remotePath,
        });
      } else {
        const buf = await item.file.arrayBuffer();
        const data = Array.from(new Uint8Array(buf));
        await invoke("sftp_upload_bytes", {
          sftpId: pane.sftpId,
          remote: remotePath,
          data,
          sourceLabel: `drag:${relPath}`,
        });
      }
      uploaded += 1;
      pane.statusEl.textContent = t("files.status.uploaded_one", {
        name: relPath,
        size: formatSize(item.file?.size || 0),
      });
    } catch (e) {
      pane.statusEl.textContent = t("files.error.drag_upload_failed_for", {
        name: relPath,
        error: e,
      });
      throw e;
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
  targetPane.statusEl.textContent = t("files.status.copying_many", {
    count: names.length,
    path: destinationDir,
  });

  let copied = 0;
  const errors = [];

  for (const name of names) {
    const sourcePath = joinPanePath(sourcePane, name);
    const destinationPath = joinPath(destinationDir, name);
    try {
      await invoke("sftp_copy_entry_between_panes", {
        sourceSftpId,
        sourcePath,
        destinationSftpId,
        destinationDir,
        overwrite: false,
      });
      copied += 1;
    } catch (e) {
      const err = String(e || "");
      if (err.includes("destination already exists")) {
        const ok = confirm(t("files.confirm.overwrite", { path: destinationPath }));
        if (ok) {
          try {
            await invoke("sftp_copy_entry_between_panes", {
              sourceSftpId,
              sourcePath,
              destinationSftpId,
              destinationDir,
              overwrite: true,
            });
            copied += 1;
            continue;
          } catch (e2) {
            errors.push({ name, error: String(e2) });
            continue;
          }
        }
      }
      errors.push({ name, error: err });
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
    total: names.length,
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
    try {
      const detect = await invoke("sftp_detect_dir_helper", { sftpId: pane.sftpId });
      const autoDetectEnabled = localStorage.getItem(SETTINGS_KEY_SFTP_AUTO_DETECT) !== "0";
      if (autoDetectEnabled && !detect?.configured) {
        const ok = confirm(t("sftp.helper.install.prompt"));
        if (ok) {
          await invoke("sftp_install_dir_helper", { sftpId: pane.sftpId });
          pane.statusEl.textContent = t("sftp.helper.install.success");
        }
      }
    } catch (e) {
      console.warn("sftp helper detect/install failed", e);
      pane.statusEl.textContent = t("sftp.helper.install.failed", { error: e });
    }
    await navigateSftpPane(pane, "/", { source: "system" });
    startSftpFollowPolling();
  } catch (e) {
    pane.statusEl.textContent = t("sftp.error.connect_failed", { error: e });
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
  startSftpFollowPolling();
}

function stopSftpFollowPolling() {
  if (sftpFollowPollTimer !== null) {
    clearInterval(sftpFollowPollTimer);
    sftpFollowPollTimer = null;
  }
}

function startSftpFollowPolling() {
  stopSftpFollowPolling();
  sftpFollowPollTimer = setInterval(() => {
    pollSftpFollowOnce().catch((e) => {
      console.warn("pollSftpFollowOnce failed", e);
    });
  }, 1200);
}

async function pollSftpFollowOnce() {
  if (workspaceMode !== "sftp") return;
  const activePane = getActivePane();
  const activeHostId = activePane?.host?.id || null;
  sftpFollowPollingTick = true;
  for (const pane of Object.values(sftpPanes)) {
    if (!pane || isLocalPane(pane) || pane.sftpId === null || !pane.host) continue;
    if (pane.followLockedByUser) continue;
    if (activeHostId && pane.host.id !== activeHostId) continue;
    if (Date.now() - (pane.lastUserNavAt || 0) < 2200) continue;
    try {
      const doc = await invoke("sftp_read_text", {
        sftpId: pane.sftpId,
        path: ".zeroterm_sftp_follow_cwd",
        maxBytes: 1024,
      });
      const remoteCwd = normalizeAbsolutePath((doc?.content || "").trim());
      if (!remoteCwd || remoteCwd === "/") continue;
      if (samePanePath(pane, pane.path, remoteCwd)) continue;
      await navigateSftpPane(pane, remoteCwd, { source: "follow" });
    } catch {
      // Ignore missing/helper-not-ready errors.
    }
  }
  sftpFollowPollingTick = false;
}

async function navigateSftpPane(pane, path, { source = "user", retryOnReconnect = true } = {}) {
  if (source === "user") {
    pane.followLockedByUser = true;
  }
  if (!sftpFollowPollingTick && source !== "follow") {
    pane.lastUserNavAt = Date.now();
  }
  const local = isLocalPane(pane);
  if (!local && pane.sftpId === null) return;
  pane.statusEl.textContent = t("files.status.listing", { path });
  try {
    setSftpPathEditMode(pane, false);
    const entries = local
      ? await invoke("local_list", { path })
      : await invoke("sftp_list", { sftpId: pane.sftpId, path });
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
    const msg = String(e || "").toLowerCase();
    const shouldReconnect =
      retryOnReconnect &&
      !local &&
      pane.host &&
      pane.hostId &&
      (msg.includes("session closed") || msg.includes("channel closed") || msg.includes("broken pipe"));

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
    pane.statusEl.textContent = t("files.error.list_failed", { error: e });
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
  setFilesContextNodeVisible(filesMenuCopy, true);
  setFilesContextNodeVisible(filesMenuRename, true);
  setFilesContextNodeVisible(filesMenuDelete, true);
  setFilesContextNodeVisible(filesMenuEntrySeparator, true);
  setFilesContextNodeVisible(filesMenuRefresh, true);
  setFilesContextNodeVisible(filesMenuMkdir, true);
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
  filesMenuCopy.disabled = !(connected && !local && hasSingleTarget && isFile);
  filesMenuRename.disabled = !(connected && hasSingleTarget);
  filesMenuDelete.disabled = !(connected && hasDeleteTarget);
  filesMenuRefresh.disabled = !connected;
  filesMenuMkdir.disabled = !connected;
  filesMenuUpload.disabled = !connected || local;
  filesMenuHidden.disabled = !connected;
  filesMenuPermissions.disabled = !(connected && hasSingleTarget);
  filesMenuSelectAll.disabled = !(connected && getVisibleEntriesForPane(pane).length > 0);
  filesMenuEdit.disabled = !(connected && canInlineEdit);
  filesMenuDownload.disabled = !(connected && !local && canDownload);
  filesMenuClose.disabled = !connected;
  filesMenuHidden.textContent = pane.showHidden ? t("files.menu.hide_hidden") : t("files.menu.show_hidden");

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
    try {
      await invoke("sftp_copy_entry_between_panes", {
        sourceSftpId: pane.sftpId,
        sourcePath: joinPanePath(pane, entry.name),
        destinationSftpId: null,
        destinationDir,
      });
      pane.statusEl.textContent = t("files.status.downloaded_dir_to", {
        name: entry.name,
        folder: destinationDir,
      });
    } catch (e) {
      pane.statusEl.textContent = t("files.error.download_failed", { error: e });
    }
    return;
  }

  const local = await invoke("plugin:dialog|save", {
    options: { defaultPath: entry.name },
  });
  if (!local) return;
  try {
    const n = await invoke("sftp_download", {
      sftpId: pane.sftpId,
      remote: joinPanePath(pane, entry.name),
      local,
    });
    pane.statusEl.textContent = t("files.status.downloaded_one", { name: entry.name, size: formatSize(n) });
  } catch (e) {
    pane.statusEl.textContent = t("files.error.download_failed", { error: e });
  }
}

async function openEntryWithLocalApp(pane, entry) {
  if (!pane || !entry || entry.kind !== "file") return;
  const defaultAppPath = isMacPlatform
    ? "/Applications"
    : isWindowsPlatform
      ? "C:\\Program Files"
      : "/usr/bin";
  const picked = await invoke("plugin:dialog|open", {
    options: {
      multiple: false,
      directory: false,
      title: t("files.menu.open_with"),
      defaultPath: defaultAppPath,
    },
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
    pane.statusEl.textContent = t("files.error.rename_failed", { error: e });
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
    pane.statusEl.textContent = t("files.error.delete_failed", { error: e });
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
    pane.statusEl.textContent = t("files.error.mkdir_failed", { error: e });
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
    try {
      const n = await invoke("sftp_upload", {
        sftpId: pane.sftpId,
        local: path,
        remote: joinPanePath(pane, name),
      });
      pane.statusEl.textContent = t("files.status.uploaded_one", { name, size: formatSize(n) });
    } catch (e) {
      pane.statusEl.textContent = t("files.error.upload_failed_for", { name, error: e });
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
    await invoke("sftp_upload_bytes", {
      sftpId: pane.sftpId,
      remote: targetPath,
      data,
      sourceLabel: `copy:${sourcePath}`,
    });
    pane.statusEl.textContent = t("files.status.copied_to", { name: entry.name, path: targetDir });
    if (targetDir === pane.path) {
      await navigateSftpPane(pane, pane.path);
    }
  } catch (e) {
    pane.statusEl.textContent = t("files.error.copy_failed", { error: e });
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
      pane.statusEl.textContent = t("files.error.delete_failed_for", { name: entry.name, error: e });
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

aiComposeInput?.addEventListener("keydown", (ev) => {
  if (ev.key !== "Enter" || ev.shiftKey) return;
  ev.preventDefault();
  aiComposeForm?.requestSubmit();
});

aiContextToggle?.addEventListener("click", cycleAiContextMode);

aiNewChatButton?.addEventListener("click", () => {
  if (aiMessages.length && !confirm(t("ai.session.confirm.new"))) return;
  startNewAiConversation();
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
      if (!deletedCurrentSession && aiMessages.length) storeAiConversationForActivePane({ persist: false });
    } else {
      await invoke("clear_ai_sessions");
      aiSessionItems = [];
      clearAiSessionIdentitiesForScope();
    }
    renderAiSessions();
    showToast(currentOnly ? t("ai.session.toast.cleared_current") : t("ai.session.toast.cleared_all"), "success", 1800);
  } catch (e) {
    showToast(t("ai.session.toast.clear_failed", { error: e }), "error", 3600);
  }
});

aiComposeForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (aiSending) {
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
});
window.addEventListener("resize", () => {
  if (!filesContextMenu.hidden) hideFilesContextMenu();
  resetSftpDragState();
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

applyI18n();
loadAiConfig().catch(() => {});
loadAiSessions({ render: true }).catch(() => {});
refreshVaultStatus();
function openSettingsPage() {
  setWorkspaceMode("settings");
}
