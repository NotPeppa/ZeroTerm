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
const GROUPS_STORAGE_KEY = "zeroterm.vault.groups";
const GROUP_STATE_STORAGE_KEY = "zeroterm.vault.group.state";
const HOST_GROUP_MAP_STORAGE_KEY = "zeroterm.vault.host.group.map";

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
    "sidebar.lock": "Lock Vault",
    "sidebar.collapse": "Collapse",
    "sidebar.expand": "Expand",
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
    "hosts.empty.default": "No saved hosts yet. Click + New host or add from CLI.",
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
    "host_editor.label.proxy_jump": "ProxyJump (saved alias)",
    "host_editor.label.advanced": "ProxyJump and forwards",
    "host_editor.label.port_forwards": "Port forwards",
    "host_editor.button.add_forward": "+ Add forward",
    "host_editor.hint.forwards": "Supports local forward (-L) and dynamic SOCKS5 (-D).",
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
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.bind": "bind",
    "host_editor.forward.port": "port",
    "host_editor.forward.target_host": "target host",
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
    "files.menu.open": "Open",
    "files.menu.open_with": "Open with...",
    "files.menu.copy_to_target": "Copy to target directory",
    "files.menu.rename": "Rename",
    "files.menu.delete": "Delete",
    "files.menu.show_hidden": "Show Hidden Files",
    "files.menu.hide_hidden": "Hide Hidden Files",
    "files.menu.permissions": "Edit Permissions",
    "files.menu.select_all": "Select All",
    "files.menu.close": "Close",
    "files.selection.count": "{count} selected",
    "files.status.connecting": "Connecting...",
    "files.status.listing": "Listing {path}...",
    "files.error.mkdir_failed": "mkdir failed: {error}",
    "files.prompt.new_folder": "New folder name:",
    "files.prompt.copy_target_dir": "Target directory path:",
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
    "files.error.permissions_not_supported": "Editing permissions is not available yet.",
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
    "settings.nav.sync": "Sync",
    "settings.nav.about": "About",
    "settings.general.subtab.basic": "Basic",
    "settings.general.subtab.sftp": "SFTP",
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
    "settings.sync.status.aborted": "Aborted — vault id mismatch",
    "settings.sync.status.forgotten": "Engine forgotten (passphrase required to resume)",
    "settings.sync.status.cleared_all": "Cleared {count} sync profile(s)",
    "settings.sync.confirm.clear_all": "Delete all sync profiles and credentials? This cannot be undone.",
    "settings.sync.status.no_profile": "No sync profile configured",
    "settings.sync.status.bootstrapped": "Connected — head clock {clock}",
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
    "settings.sync.sftp.no_hosts": "Add an SSH host in the vault first",
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
    "settings.sync.confirm.vault_mismatch": "The repo was created against a different vault (vault id = {remote}). Continuing will reject every sync. Proceed anyway?",
    "settings.sync.devices.title": "Joined Devices",
    "settings.sync.devices.empty": "Device list appears after you join a repo and run sync.",
    "settings.sync.conflicts.title": "Conflict Inbox",
    "settings.sync.conflicts.empty": "No conflicts pending.",
    "settings.sync.conflicts.no_profile": "Configure a sync profile to see conflicts.",
    "settings.sync.conflicts.local": "Local",
    "settings.sync.conflicts.remote": "Remote",
    "settings.sync.conflicts.tombstone": "(deleted upstream)",
    "settings.sync.conflicts.redacted": "(secret content, {bytes} bytes)",
    "settings.sync.conflicts.keep_local": "Keep local",
    "settings.sync.conflicts.keep_remote": "Keep remote",
    "settings.sync.conflicts.resolved": "Conflict resolved",
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
    "settings.sync.method": "Sync Method",
    "settings.sync.button.save": "Save Config",
    "settings.sync.button.browse": "Browse",
    "settings.sync.button.now": "Sync Now",
    "settings.sync.button.create_repo": "Create Repo",
    "settings.sync.button.join_repo": "Join Repo",
    "settings.sync.button.forget_engine": "Disconnect",
    "settings.sync.button.clear_all": "Clear all",
    "settings.sync.button.busy.save": "Saving...",
    "settings.sync.button.busy.create_repo": "Creating...",
    "settings.sync.button.busy.join_repo": "Joining...",
    "settings.sync.button.busy.now": "Syncing...",
    "settings.sync.button.busy.refresh_stats": "Refreshing...",
    "settings.sync.button.busy.compact_now": "Compacting...",
    "settings.sync.button.busy.forget_engine": "Disconnecting...",
    "settings.sync.button.busy.clear_all": "Clearing...",
    "settings.sync.button.busy.resolve_conflict": "Resolving...",
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
    "theme.edit.title": "Edit theme",
    "theme.edit.reset": "Reset",
    "theme.edit.cancel": "Cancel",
    "theme.edit.save": "Save",
    "settings.nav.sftp": "SFTP",
    "settings.nav.hotkeys": "Hotkeys",
    "settings.terminal.desc": "Configure terminal themes and visual behavior.",
    "settings.language.label": "Language",
    "settings.language.hint": "Changes apply immediately and are saved locally.",
    "settings.version.label": "Version",
    "settings.about.title": "About",
    "settings.update.install": "Install & Restart",
    "settings.update.latest": "You are on the latest version ({version}).",
    "settings.update.available": "Update available: {current} -> {latest}",
    "settings.update.failed": "Update failed: {error}",
    "settings.terminal_theme.title": "Terminal Theme",
    "settings.terminal_theme.light_title": "Light Terminal Themes",
    "settings.terminal_theme.dark_title": "Dark Terminal Themes",
    "settings.terminal_theme.add": "+ New",
    "settings.terminal_theme.label": "Theme",
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
    "sidebar.lock": "锁定保险库",
    "sidebar.collapse": "收起",
    "sidebar.expand": "展开",
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
    "hosts.empty.default": "还没有保存的主机。点击 + 新建主机，或在 CLI 中添加。",
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
    "host_editor.label.proxy_jump": "ProxyJump（已保存别名）",
    "host_editor.label.advanced": "ProxyJump 与转发",
    "host_editor.label.port_forwards": "端口转发",
    "host_editor.button.add_forward": "+ 添加转发",
    "host_editor.hint.forwards": "支持本地转发（-L）和动态 SOCKS5（-D）。",
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
    "host_editor.forward.dynamic": "SOCKS5 (-D)",
    "host_editor.forward.bind": "监听地址",
    "host_editor.forward.port": "端口",
    "host_editor.forward.target_host": "目标主机",
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
    "files.menu.open": "打开",
    "files.menu.open_with": "打开方式...",
    "files.menu.copy_to_target": "复制到目标目录",
    "files.menu.rename": "重命名",
    "files.menu.delete": "删除",
    "files.menu.show_hidden": "显示隐藏文件",
    "files.menu.hide_hidden": "不显示隐藏文件",
    "files.menu.permissions": "编辑权限",
    "files.menu.select_all": "全选",
    "files.menu.close": "关闭",
    "files.selection.count": "已选 {count} 项",
    "files.status.connecting": "连接中...",
    "files.status.listing": "正在列出 {path}...",
    "files.error.mkdir_failed": "创建目录失败：{error}",
    "files.prompt.new_folder": "新文件夹名称：",
    "files.prompt.copy_target_dir": "目标目录路径：",
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
    "files.error.permissions_not_supported": "暂不支持编辑权限。",
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
    "settings.nav.sync": "同步",
    "settings.nav.about": "关于",
    "settings.general.subtab.basic": "基础",
    "settings.general.subtab.sftp": "SFTP",
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
    "settings.sync.status.aborted": "已中止 — vault id 不匹配",
    "settings.sync.status.forgotten": "已断开会话（需要密码重新连接）",
    "settings.sync.status.cleared_all": "已清空 {count} 个同步配置",
    "settings.sync.confirm.clear_all": "确定要删除所有同步配置和凭据吗？此操作不可撤销。",
    "settings.sync.status.no_profile": "尚未配置同步",
    "settings.sync.status.bootstrapped": "已连接 — 逻辑时钟 {clock}",
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
    "settings.sync.sftp.no_hosts": "请先在保险库添加 SSH 主机",
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
    "settings.sync.confirm.vault_mismatch": "该仓库是基于另一个 vault 创建的（vault id = {remote}）。继续将导致每次同步被拒。仍要继续吗？",
    "settings.sync.devices.title": "已加入设备",
    "settings.sync.devices.empty": "设备列表会在加入仓库并完成同步后显示。",
    "settings.sync.conflicts.title": "冲突收件箱",
    "settings.sync.conflicts.empty": "暂无待解决冲突。",
    "settings.sync.conflicts.no_profile": "请先配置同步以查看冲突。",
    "settings.sync.conflicts.local": "本地",
    "settings.sync.conflicts.remote": "远端",
    "settings.sync.conflicts.tombstone": "（远端已删除）",
    "settings.sync.conflicts.redacted": "（私密内容，{bytes} 字节）",
    "settings.sync.conflicts.keep_local": "保留本地",
    "settings.sync.conflicts.keep_remote": "保留远端",
    "settings.sync.conflicts.resolved": "冲突已解决",
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
    "settings.sync.method": "同步方式",
    "settings.sync.button.save": "保存配置",
    "settings.sync.button.browse": "浏览",
    "settings.sync.button.now": "立即同步",
    "settings.sync.button.create_repo": "创建仓库",
    "settings.sync.button.join_repo": "加入仓库",
    "settings.sync.button.forget_engine": "断开会话",
    "settings.sync.button.clear_all": "清空配置",
    "settings.sync.button.busy.save": "保存中...",
    "settings.sync.button.busy.create_repo": "创建中...",
    "settings.sync.button.busy.join_repo": "加入中...",
    "settings.sync.button.busy.now": "同步中...",
    "settings.sync.button.busy.refresh_stats": "刷新中...",
    "settings.sync.button.busy.compact_now": "压缩中...",
    "settings.sync.button.busy.forget_engine": "断开中...",
    "settings.sync.button.busy.clear_all": "清空中...",
    "settings.sync.button.busy.resolve_conflict": "处理中...",
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
    "theme.edit.title": "编辑主题",
    "theme.edit.reset": "重置",
    "theme.edit.cancel": "取消",
    "theme.edit.save": "保存",
    "settings.nav.sftp": "SFTP",
    "settings.nav.hotkeys": "快捷键",
    "settings.terminal.desc": "配置终端主题与视觉表现。",
    "settings.language.label": "语言",
    "settings.language.hint": "修改立即生效，并会保存在本地。",
    "settings.version.label": "版本",
    "settings.about.title": "关于",
    "settings.update.install": "安装并重启",
    "settings.update.latest": "当前已是最新版本（{version}）。",
    "settings.update.available": "发现新版本：{current} -> {latest}",
    "settings.update.failed": "更新失败：{error}",
    "settings.terminal_theme.title": "终端主题",
    "settings.terminal_theme.light_title": "亮色终端主题",
    "settings.terminal_theme.dark_title": "暗色终端主题",
    "settings.terminal_theme.add": "+ 新建",
    "settings.terminal_theme.label": "主题",
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
const vaultsContent = document.getElementById("vaults-content");
const vaultLayout = document.querySelector(".vault-layout");
const vaultSplitter = document.getElementById("vault-splitter");
const sftpLeftContent = document.getElementById("sftp-left-content");
const sftpRightContent = document.getElementById("sftp-right-content");
const newWindowButton = document.getElementById("new-window-button");
const settingsButton = document.getElementById("settings-button");
const quickConnectButton = document.getElementById("quick-connect-button");
const localTerminalButton = document.getElementById("local-terminal-button");
const vaultBottomSettingsButton = document.getElementById("vault-bottom-settings");
const vaultBottomSettingsRow = document.getElementById("vault-bottom-settings-row");
const settingsBackButton = document.getElementById("settings-back");
const settingsNavGeneral = document.getElementById("settings-nav-general");
const settingsNavTerminal = document.getElementById("settings-nav-terminal");
const settingsNavSync = document.getElementById("settings-nav-sync");
const settingsGeneralPanel = document.getElementById("settings-general-panel");
const settingsTerminalPanel = document.getElementById("settings-terminal-panel");
const settingsSyncPanel = document.getElementById("settings-sync-panel");
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
const settingsAboutPanel = document.getElementById("settings-about-panel");
const settingsGeneralSubtabBasic = document.getElementById("settings-general-subtab-basic");
const settingsGeneralSubtabSftp = document.getElementById("settings-general-subtab-sftp");
const settingsGeneralBasicSection = document.getElementById("settings-general-basic-section");
const settingsGeneralSftpSection = document.getElementById("settings-general-sftp-section");
const settingsGeneralTitle = document.getElementById("settings-general-title");
const settingsGeneralDesc = document.getElementById("settings-general-desc");
const settingsLanguageSelect = document.getElementById("settings-language-select");
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
const themeEditOverlay = document.getElementById("theme-edit-overlay");
const themeEditForm = document.getElementById("theme-edit-form");
const themeEditCancel = document.getElementById("theme-edit-cancel");
const themeEditReset = document.getElementById("theme-edit-reset");
const themeEditPreview = document.getElementById("theme-edit-preview");
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
let windowIsMaximized = false;
let workspaceSidebarCollapsed = false;
let selectedVaultHostId = null;
let vaultSidebarWidth = 320;
let hostGroups = [];
let groupExpandedState = {};
let hostGroupMap = {};
let draggingHostId = null;
let hostsContextHostId = null;
let groupsContextGroupId = null;
let sftpFollowPollTimer = null;
let sftpFollowPollingTick = false;
const SETTINGS_KEY_SFTP_AUTO_DETECT = "zeroterm.settings.sftp.auto_detect";
const SETTINGS_KEY_SFTP_LOCAL_DIR = "zeroterm.settings.sftp.local_dir";
const SETTINGS_KEY_SYNC_AUTO = "zeroterm.settings.sync.auto";
const SETTINGS_KEY_SYNC_ACTIVE_PROFILE = "zeroterm.settings.sync.active_profile";
const SETTINGS_KEY_TERMINAL_THEME = "zeroterm.settings.terminal.theme";
const SETTINGS_KEY_TERMINAL_CUSTOM_THEMES = "zeroterm.settings.terminal.custom_themes";
const SETTINGS_KEY_TERMINAL_FONT_FAMILY = "zeroterm.settings.terminal.font_family";
const SETTINGS_KEY_TERMINAL_FONT_SIZE = "zeroterm.settings.terminal.font_size";
const SETTINGS_KEY_TERMINAL_LINE_HEIGHT = "zeroterm.settings.terminal.line_height";
let settingsSection = "general";
let settingsTerminalSubtab = "theme";
let settingsGeneralSubtab = "basic";
let syncProfiles = [];
let syncEditingId = null;
let settingsSftpHomeCache = null;
let appVersionCache = null;
let syncAutoTimer = null;
let syncSingleProfileId = null;
let syncSecretsLoadToken = 0;
const syncDraftByBackend = {
  filesystem: null,
  webdav: null,
  s3: null,
};

const TERMINAL_THEMES = {
  "termark-dark": {
    background: "#00000000",
    foreground: "#e7ecff",
    cursor: "#9cc3ff",
    selectionBackground: "#2d4a7a",
  },
  "kanagawa-wave": {
    background: "#00000000",
    foreground: "#dcd7ba",
    cursor: "#7e9cd8",
    selectionBackground: "#2a2a37",
  },
  "catppuccin-mocha": {
    background: "#00000000",
    foreground: "#cdd6f4",
    cursor: "#89b4fa",
    selectionBackground: "#313244",
  },
  nord: {
    background: "#00000000",
    foreground: "#d8dee9",
    cursor: "#88c0d0",
    selectionBackground: "#3b4252",
  },
};

const TERMINAL_THEME_META = {
  "tokyo-day": { label: "Tokyo Day", group: "light" },
  "catppuccin-latte": { label: "Catppuccin Latte", group: "light" },
  "termark-dark": { label: "Termark Dark", group: "dark" },
  "kanagawa-wave": { label: "Kanagawa Wave", group: "dark" },
  "catppuccin-mocha": { label: "Catppuccin Mocha", group: "dark" },
  nord: { label: "Nord", group: "dark" },
};

let terminalCustomThemes = [];
let terminalEditingThemeId = null;
let themeMenuTargetId = null;
let themeEditOriginal = null;

function loadCustomThemes() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY_TERMINAL_CUSTOM_THEMES) || "[]";
    const parsed = JSON.parse(raw);
    terminalCustomThemes = Array.isArray(parsed) ? parsed : [];
  } catch {
    terminalCustomThemes = [];
  }
}

function saveCustomThemes() {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_CUSTOM_THEMES, JSON.stringify(terminalCustomThemes));
}

function allTerminalThemes() {
  const customMap = {};
  for (const t of terminalCustomThemes) {
    customMap[t.id] = t.theme;
  }
  return { ...TERMINAL_THEMES, ...customMap };
}

function getTerminalThemeName() {
  const saved = localStorage.getItem(SETTINGS_KEY_TERMINAL_THEME) || "termark-dark";
  return allTerminalThemes()[saved] ? saved : "termark-dark";
}

function getTerminalThemeConfig() {
  return allTerminalThemes()[getTerminalThemeName()] || TERMINAL_THEMES["termark-dark"];
}

function getTerminalFontFamily() {
  return localStorage.getItem(SETTINGS_KEY_TERMINAL_FONT_FAMILY) || TERMINAL_FONT_STACK;
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
  const theme = getTerminalThemeConfig();
  for (const tab of termState.tabs) {
    for (const pane of tab.panes) {
      if (!pane.term) continue;
      pane.term.setOption("theme", theme);
      pane.term.setOption("fontFamily", getTerminalFontFamily());
      pane.term.setOption("fontSize", getTerminalFontSize());
      pane.term.setOption("lineHeight", getTerminalLineHeight());
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

function makeThemePreviewBlock(themeName, themeConfig) {
  const p = document.createElement("pre");
  p.className = "terminal-theme-preview " + (TERMINAL_THEME_META[themeName]?.group === "light" ? "light" : "dark");
  p.textContent = "root@termark$ ls\ndrwxr-xr-x 1 root  boot\ndrwxr-xr-x 1 root  data";
  if (themeConfig) {
    p.style.background = toOpaqueHex(themeConfig.background);
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
    card.addEventListener("click", () => {
      localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, id);
      terminalEditingThemeId = id;
      if (settingsTerminalTheme) {
        settingsTerminalTheme.value = id;
        syncCustomSelect("settings-terminal-theme");
      }
      applyTerminalThemeToAllPanes();
      syncTerminalThemeCardsActive();
      syncTerminalThemeEditor();
    });
    card.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      themeMenuTargetId = id;
      if (!themeCardMenu) return;
      themeCardMenu.hidden = false;
      themeCardMenu.style.left = `${ev.clientX}px`;
      themeCardMenu.style.top = `${ev.clientY}px`;
    });
    (group === "light" ? terminalThemeListLight : terminalThemeListDark).appendChild(card);
  };

  Object.entries(TERMINAL_THEME_META).forEach(([id, meta]) => addCard(id, meta.label, meta.group));
  terminalCustomThemes.forEach((t) => addCard(t.id, t.label, t.group));
  syncTerminalThemeCardsActive();
}

function toOpaqueHex(color) {
  if (!color) return "#000000";
  if (color.length === 9) return color.slice(0, 7);
  if (color.length === 7) return color;
  return "#000000";
}

function syncTerminalThemeEditor() {
  const currentId = terminalEditingThemeId || getTerminalThemeName();
  const isCustom = terminalCustomThemes.some((t) => t.id === currentId);
  const theme = allTerminalThemes()[currentId] || getTerminalThemeConfig();
  if (themeColorBg) themeColorBg.value = toOpaqueHex(theme.background);
  if (themeColorFg) themeColorFg.value = toOpaqueHex(theme.foreground);
  if (themeColorCursor) themeColorCursor.value = toOpaqueHex(theme.cursor);
  if (themeColorSelection) themeColorSelection.value = toOpaqueHex(theme.selectionBackground);
  if (themeHexBg) themeHexBg.value = toOpaqueHex(theme.background);
  if (themeHexFg) themeHexFg.value = toOpaqueHex(theme.foreground);
  if (themeHexCursor) themeHexCursor.value = toOpaqueHex(theme.cursor);
  if (themeHexSelection) themeHexSelection.value = toOpaqueHex(theme.selectionBackground);
  if (themeMenuDelete) themeMenuDelete.disabled = !isCustom;
  updateThemeEditPreview(theme);
}

function updateThemeEditPreview(theme) {
  if (!themeEditPreview) return;
  const pre = themeEditPreview.querySelector("pre");
  if (!pre) return;
  pre.style.background = toOpaqueHex(theme.background);
  pre.style.color = toOpaqueHex(theme.foreground);
}

function updateCustomThemeColor(key, value) {
  const currentId = terminalEditingThemeId || getTerminalThemeName();
  const idx = terminalCustomThemes.findIndex((t) => t.id === currentId);
  if (idx < 0) return;
  terminalCustomThemes[idx].theme[key] = value;
  updateThemeEditPreview(terminalCustomThemes[idx].theme);
  saveCustomThemes();
  applyTerminalThemeToAllPanes();
  renderTerminalThemeCards();
  syncTerminalThemeCardsActive();
}

function openThemeEditDialog(themeId) {
  const idx = terminalCustomThemes.findIndex((t) => t.id === themeId);
  if (idx < 0) return;
  terminalEditingThemeId = themeId;
  themeEditOriginal = JSON.parse(JSON.stringify(terminalCustomThemes[idx].theme));
  syncTerminalThemeEditor();
  if (themeEditOverlay) themeEditOverlay.hidden = false;
}

function rebuildTerminalThemeSelectOptions() {
  if (!settingsTerminalTheme) return;
  const selected = getTerminalThemeName();
  settingsTerminalTheme.innerHTML = "";
  Object.entries(TERMINAL_THEME_META).forEach(([id, meta]) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = meta.label;
    settingsTerminalTheme.appendChild(o);
  });
  terminalCustomThemes.forEach((t) => {
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

function loadVaultGroupsState() {
  try {
    hostGroups = JSON.parse(localStorage.getItem(GROUPS_STORAGE_KEY) || "[]");
    groupExpandedState = JSON.parse(localStorage.getItem(GROUP_STATE_STORAGE_KEY) || "{}");
    hostGroupMap = JSON.parse(localStorage.getItem(HOST_GROUP_MAP_STORAGE_KEY) || "{}");
    if (!Array.isArray(hostGroups)) hostGroups = [];
    if (!groupExpandedState || typeof groupExpandedState !== "object") groupExpandedState = {};
    if (!hostGroupMap || typeof hostGroupMap !== "object") hostGroupMap = {};
  } catch {
    hostGroups = [];
    groupExpandedState = {};
    hostGroupMap = {};
  }
}

function saveVaultGroupsState() {
  localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify(hostGroups));
  localStorage.setItem(GROUP_STATE_STORAGE_KEY, JSON.stringify(groupExpandedState));
  localStorage.setItem(HOST_GROUP_MAP_STORAGE_KEY, JSON.stringify(hostGroupMap));
  autoSyncAfterDataChange();
}

function migrateAutoSeededGroupsIfNeeded() {
  if (!Array.isArray(hostGroups) || hostGroups.length !== 2) return;
  const names = hostGroups.map((g) => g?.name).sort();
  const looksSeeded = names[0] === "分组一" && names[1] === "分组二";
  if (!looksSeeded) return;
  const hasHostMapping = Object.keys(hostGroupMap || {}).length > 0;
  if (hasHostMapping) return;
  hostGroups = [];
  groupExpandedState = {};
  saveVaultGroupsState();
}

function populateHostGroupOptions(selectedGroupId = "") {
  if (!hfGroup) return;
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
  windowMaximizeButton.textContent = windowIsMaximized ? "❐" : "□";
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

if (isWindowsPlatform && appWindow) {
  if (workspaceTitlebar) {
    bindDblclickMaximizeOnBar(workspaceTitlebar);
  }
  bindDblclickMaximizeOnBar(vaultLeftTopbar);
  bindDblclickMaximizeOnBar(vaultRightTopbar);
  window.addEventListener("resize", () => {
    syncWindowMaximizeButtonState();
  });
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

function setWorkspaceMode(mode) {
  workspaceMode = mode;
  if (mode !== "sftp") {
    hideFilesContextMenu();
  }
  const showingSftp = mode === "sftp";
  const showingTerminal = mode === "terminal";
  const showingSettings = mode === "settings";
  panelVaults.hidden = false;
  panelTerminal.hidden = true;
  panelSftp.hidden = mode !== "sftp";
  if (settingsPage) settingsPage.hidden = !showingSettings;
  if (vaultWelcome) vaultWelcome.hidden = showingTerminal || showingSftp || showingSettings;
  if (terminalWorkspace) terminalWorkspace.hidden = !showingTerminal;
  workspaceTabVaults.classList.toggle("active", mode === "vaults");
  workspaceTabSftp.classList.toggle("active", mode === "sftp");
  workspaceNavVaults?.classList.toggle("active", mode === "vaults");
  workspaceNavSftp?.classList.toggle("active", mode === "sftp");
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
      settingsTerminalFontFamily.value = getTerminalFontFamily();
      syncCustomSelect("settings-terminal-font-family");
    }
    if (settingsTerminalFontSize) settingsTerminalFontSize.value = String(getTerminalFontSize());
    if (settingsTerminalLineHeight) settingsTerminalLineHeight.value = String(getTerminalLineHeight());
    syncTerminalFontPreview();
    syncTerminalThemeCardsActive();
  }
}

function setSettingsSection(section) {
  settingsSection = section === "terminal"
    ? "terminal"
    : section === "sync"
      ? "sync"
      : section === "about"
        ? "about"
        : "general";
  settingsNavGeneral?.classList.toggle("active", settingsSection === "general");
  settingsNavTerminal?.classList.toggle("active", settingsSection === "terminal");
  settingsNavSync?.classList.toggle("active", settingsSection === "sync");
  settingsNavAbout?.classList.toggle("active", settingsSection === "about");
  if (settingsGeneralPanel) settingsGeneralPanel.hidden = settingsSection !== "general";
  if (settingsTerminalPanel) settingsTerminalPanel.hidden = settingsSection !== "terminal";
  if (settingsSyncPanel) settingsSyncPanel.hidden = settingsSection !== "sync";
  if (settingsAboutPanel) settingsAboutPanel.hidden = settingsSection !== "about";
  if (settingsGeneralTitle) {
    settingsGeneralTitle.textContent = settingsSection === "terminal"
      ? t("settings.nav.terminal")
      : settingsSection === "sync"
        ? t("settings.nav.sync")
        : settingsSection === "about"
          ? t("settings.nav.about")
      : t("settings.general.title");
  }
  if (settingsGeneralDesc) {
    settingsGeneralDesc.textContent = settingsSection === "terminal"
      ? t("settings.terminal.desc")
      : settingsSection === "sync"
        ? t("settings.sync.desc")
        : settingsSection === "about"
          ? ""
      : t("settings.general.desc");
  }
  if (settingsSection === "terminal") {
    setSettingsTerminalSubtab(settingsTerminalSubtab);
  } else if (settingsSection === "sync") {
    loadSyncProfiles().catch((e) => {
      if (settingsSyncStatus) settingsSyncStatus.textContent = userFriendlySyncError(e);
    });
  } else if (settingsSection === "about") {
    loadAppVersion().then((v) => {
      if (settingsAboutVersionValue) settingsAboutVersionValue.textContent = v;
    });
    refreshUpdateStatus().catch(() => {});
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
  // sync layer — groups / hostGroupMap stay client-local for now and will
  // get their own sync record kinds in a later milestone.
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
  refreshRememberPassphraseFlag().catch(() => {});
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
  title.textContent = `${conflict.kind} · ${conflict.recordId}`;
  header.appendChild(title);

  const when = document.createElement("span");
  when.className = "muted tiny";
  try {
    when.textContent = new Date(conflict.detectedAt).toLocaleString();
  } catch {
    when.textContent = String(conflict.detectedAt);
  }
  header.appendChild(when);
  li.appendChild(header);

  const grid = document.createElement("div");
  grid.className = "settings-sync-conflict-grid";

  const localBox = document.createElement("div");
  localBox.className = "settings-sync-conflict-side";
  const localLabel = document.createElement("div");
  localLabel.className = "settings-sync-conflict-side-label";
  localLabel.textContent = t("settings.sync.conflicts.local");
  const localPre = document.createElement("pre");
  localPre.className = "settings-sync-conflict-preview";
  localPre.textContent = previewToText(conflict.localPreview);
  localBox.appendChild(localLabel);
  localBox.appendChild(localPre);
  grid.appendChild(localBox);

  const remoteBox = document.createElement("div");
  remoteBox.className = "settings-sync-conflict-side";
  const remoteLabel = document.createElement("div");
  remoteLabel.className = "settings-sync-conflict-side-label";
  remoteLabel.textContent = t("settings.sync.conflicts.remote");
  const remotePre = document.createElement("pre");
  remotePre.className = "settings-sync-conflict-preview";
  remotePre.textContent = previewToText(conflict.remotePreview);
  remoteBox.appendChild(remoteLabel);
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

function previewToText(preview) {
  if (preview && typeof preview === "object" && preview.tombstone) {
    return t("settings.sync.conflicts.tombstone");
  }
  if (preview && typeof preview === "object" && preview.redacted) {
    return t("settings.sync.conflicts.redacted", { bytes: preview.bytes ?? 0 });
  }
  try {
    return JSON.stringify(preview, null, 2);
  } catch {
    return String(preview);
  }
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

function isAutoSyncEnabled() {
  // Auto-sync is gone for M3 — every push is a full snapshot so timer-driven
  // pushes are wasteful. M5 reintroduces it once events are record-level.
  return false;
}

function scheduleAutoSync() {
  if (syncAutoTimer !== null) {
    clearTimeout(syncAutoTimer);
    syncAutoTimer = null;
  }
}

function autoSyncAfterDataChange() {
  // No-op in M3 — see isAutoSyncEnabled().
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
  const outcome = await invoke("sync_now", { profileId: id });
  return outcome;
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
}

function setSettingsTerminalSubtab(subtab) {
  settingsTerminalSubtab = subtab === "font" ? "font" : "theme";
  settingsTerminalSubtabTheme?.classList.toggle("active", settingsTerminalSubtab === "theme");
  settingsTerminalSubtabFont?.classList.toggle("active", settingsTerminalSubtab === "font");
  if (settingsTerminalThemeSection) settingsTerminalThemeSection.hidden = settingsTerminalSubtab !== "theme";
  if (settingsTerminalFontSection) settingsTerminalFontSection.hidden = settingsTerminalSubtab !== "font";
}

function bindDragOnBar(el) {
  if (!el || !appWindow?.startDragging) return;
  el.addEventListener("mousedown", (ev) => {
    if (ev.button !== 0) return;
    if (isTitlebarInteractiveTarget(ev.target)) return;
    appWindow.startDragging().catch((e) => {
      console.warn("startDragging failed", e);
    });
  });
}

function bindDblclickMaximizeOnBar(el) {
  if (!el || !isWindowsPlatform || !appWindow) return;
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
  const arrowPath = collapsed ? "m10 7 4 5-4 5" : "m14 7-4 5 4 5";
  return `
    <svg class="zt-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5"></rect>
      <path d="M9.5 4.5v15"></path>
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

function buildCustomSelect(selectEl) {
  if (!selectEl || selectEl.dataset.customSelectBound === "1") return;
  const wrap = document.createElement("div");
  wrap.className = "zt-select-wrap";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "zt-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "zt-select-menu";
  menu.hidden = true;

  const parent = selectEl.parentElement;
  if (!parent) return;
  selectEl.dataset.customSelectBound = "1";
  selectEl.classList.add("zt-select-native");
  parent.insertBefore(wrap, selectEl);
  wrap.append(trigger, menu);
  wrap.appendChild(selectEl);

  const close = () => {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (customSelectState.openId === selectEl.id) {
      customSelectState.openId = null;
    }
  };

  const open = () => {
    if (customSelectState.openId && customSelectState.openId !== selectEl.id) {
      const current = document.querySelector(`select#${customSelectState.openId}`);
      current?.dispatchEvent(new CustomEvent("zt-select-close"));
    }
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    customSelectState.openId = selectEl.id;
  };

  const sync = () => {
    const opts = Array.from(selectEl.options);
    const current = opts.find((o) => o.value === selectEl.value) || opts[0];
    trigger.textContent = current ? current.textContent : "";
    menu.innerHTML = "";
    for (const opt of opts) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "zt-select-option" + (opt.value === selectEl.value ? " active" : "");
      item.textContent = opt.textContent;
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
      });
      menu.appendChild(item);
    }
  };

  trigger.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (menu.hidden) open(); else close();
  });
  wrap.addEventListener("zt-select-close", close);
  document.addEventListener("click", (ev) => {
    if (!wrap.contains(ev.target)) close();
  });
  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") close();
  });

  selectEl.addEventListener("change", sync);
  selectEl._ztSync = sync;
  sync();
}

function syncCustomSelect(selectId) {
  const el = document.getElementById(selectId);
  if (!el) return;
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
  setText("vault-local-title", "sftp.host.local");
  setText("vault-settings-text", "sidebar.settings");
  setAttr("workspace-nav-vaults", "title", "workspace.tab.vaults");
  setAttr("workspace-nav-sftp", "title", "workspace.tab.sftp");
  setAttr("new-window-button", "title", "sidebar.new_window");
  setAttr("settings-button", "title", "sidebar.settings");
  setAttr("quick-connect-button", "title", "sidebar.quick_connect");
  setAttr("local-terminal-button", "title", "sidebar.local_terminal");
  setAttr("lock-button", "title", "sidebar.lock");
  setAttr("window-minimize", "title", "window.minimize");
  setAttr("window-close", "title", "window.close");
  setWindowMaximizeButtonState(windowIsMaximized);

  setPlaceholder("host-search", "hosts.search.placeholder");
  setAttr("add-host-button", "title", "hosts.new_host");

  setPlaceholder("sftp-left-path-input", "sftp.path.placeholder");
  setPlaceholder("sftp-right-path-input", "sftp.path.placeholder");
  setText("sftp-left-filter-label", "sftp.button.filter");
  setText("sftp-right-filter-label", "sftp.button.filter");
  setPlaceholder("sftp-left-filter-input", "sftp.filter.placeholder");
  setPlaceholder("sftp-right-filter-input", "sftp.filter.placeholder");
  setText("sftp-left-actions", "sftp.button.actions");
  setText("sftp-right-actions", "sftp.button.actions");
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
  setText("hf-forwards-label", "host_editor.label.port_forwards");
  setText("hf-forward-add", "host_editor.button.add_forward");
  setText("hf-forwards-hint", "host_editor.hint.forwards");
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
  setText("theme-edit-title", "theme.edit.title");
  setText("theme-edit-reset", "theme.edit.reset");
  setText("theme-edit-cancel", "theme.edit.cancel");
  setText("theme-edit-save", "theme.edit.save");

  setText("settings-title", "settings.title");
  setText("settings-general-title", "settings.general.title");
  setText("settings-general-desc", "settings.general.desc");
  setText("settings-nav-pref", "settings.nav.pref");
  setText("settings-nav-general", "settings.nav.general");
  setText("settings-nav-terminal", "settings.nav.terminal");
  setText("settings-nav-sync", "settings.nav.sync");
  setText("settings-nav-about", "settings.nav.about");
  setText("settings-general-subtab-basic", "settings.general.subtab.basic");
  setText("settings-general-subtab-sftp", "settings.general.subtab.sftp");
  setText("settings-terminal-subtab-theme", "settings.terminal.subtab.theme");
  setText("settings-terminal-subtab-font", "settings.terminal.subtab.font");
  setText("settings-nav-sftp", "settings.nav.sftp");
  setText("settings-nav-hotkeys", "settings.nav.hotkeys");
  setText("settings-language-label", "settings.language.label");
  setText("settings-language-hint", "settings.language.hint");
  setText("settings-about-title", "settings.about.title");
  setText("settings-about-version-label", "settings.version.label");
  setText("settings-update-install", "settings.update.install");
  setText("settings-terminal-theme-title", "settings.terminal_theme.title");
  setText("terminal-theme-light-title", "settings.terminal_theme.light_title");
  setText("terminal-theme-dark-title", "settings.terminal_theme.dark_title");
  setText("terminal-theme-add-light", "settings.terminal_theme.add");
  setText("terminal-theme-add-dark", "settings.terminal_theme.add");
  setText("settings-terminal-theme-label", "settings.terminal_theme.label");
  setText("settings-terminal-font-title", "settings.terminal_font.title");
  setText("settings-terminal-font-hint", "settings.terminal_font.hint");
  setText("settings-terminal-font-family-label", "settings.terminal_font.family");
  setText("settings-terminal-font-size-label", "settings.terminal_font.size");
  setText("settings-terminal-line-height-label", "settings.terminal_font.line_height");
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
buildCustomSelect(document.getElementById("settings-terminal-theme"));
buildCustomSelect(document.getElementById("settings-terminal-font-family"));
buildCustomSelect(document.getElementById("settings-sync-profile"));
buildCustomSelect(document.getElementById("settings-sync-backend"));
syncCustomSelect("settings-sync-backend");
buildCustomSelect(document.getElementById("sftp-left-host"));
buildCustomSelect(document.getElementById("sftp-right-host"));
workspaceTabVaults.addEventListener("click", () => setWorkspaceMode("vaults"));
workspaceTabSftp.addEventListener("click", () => setWorkspaceMode("sftp"));
workspaceNavVaults?.addEventListener("click", () => setWorkspaceMode("vaults"));
workspaceNavSftp?.addEventListener("click", () => setWorkspaceMode("sftp"));
workspaceSidebarToggle?.addEventListener("click", () => {
  setWorkspaceSidebarCollapsed(!workspaceSidebarCollapsed);
});
workspaceSidebarToggleRight?.addEventListener("click", () => {
  setWorkspaceSidebarCollapsed(!workspaceSidebarCollapsed);
});
terminalThemeAddLight?.addEventListener("click", async () => {
  const label = await openTextInputDialog({
    title: "新建主题",
    message: "请输入主题名称",
    placeholder: "例如：My Light",
  });
  if (!label) return;
  const baseId = getTerminalThemeName();
  const baseTheme = { ...getTerminalThemeConfig() };
  const id = `custom-${Date.now()}`;
  terminalCustomThemes.push({ id, label, group: "light", theme: baseTheme });
  saveCustomThemes();
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
});
terminalThemeAddDark?.addEventListener("click", async () => {
  const label = await openTextInputDialog({
    title: "新建主题",
    message: "请输入主题名称",
    placeholder: "例如：My Dark",
  });
  if (!label) return;
  const baseTheme = { ...getTerminalThemeConfig() };
  const id = `custom-${Date.now()}`;
  terminalCustomThemes.push({ id, label, group: "dark", theme: baseTheme });
  saveCustomThemes();
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
});
document.getElementById("add-group-button")?.addEventListener("click", async () => {
  const name = await openTextInputDialog({
    title: t("groups.prompt.add.title"),
    message: t("groups.prompt.add.message"),
    placeholder: t("groups.prompt.add.placeholder"),
  });
  if (!name) return;
  const g = { id: uniqueId("group"), name, parentId: "" };
  hostGroups.push(g);
  groupExpandedState[g.id] = true;
  saveVaultGroupsState();
  renderHosts();
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

applyVaultSidebarWidth(vaultSidebarWidth);
setWorkspaceSidebarCollapsed(false);

document.getElementById("lock-button").addEventListener("click", async () => {
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
  hideGroupsContextMenu();
  openHostEditor();
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
  const g = { id: uniqueId("group"), name, parentId };
  hostGroups.push(g);
  groupExpandedState[parentId] = true;
  groupExpandedState[g.id] = true;
  saveVaultGroupsState();
  renderHosts();
});

groupsMenuExpand?.addEventListener("click", () => {
  if (!groupsContextGroupId) return;
  groupExpandedState[groupsContextGroupId] = true;
  saveVaultGroupsState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuExpandAll?.addEventListener("click", () => {
  for (const g of hostGroups) groupExpandedState[g.id] = true;
  saveVaultGroupsState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuCollapse?.addEventListener("click", () => {
  if (!groupsContextGroupId) return;
  groupExpandedState[groupsContextGroupId] = false;
  saveVaultGroupsState();
  hideGroupsContextMenu();
  renderHosts();
});

groupsMenuCollapseAll?.addEventListener("click", () => {
  for (const g of hostGroups) groupExpandedState[g.id] = false;
  saveVaultGroupsState();
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
  group.name = name;
  saveVaultGroupsState();
  renderHosts();
});

groupsMenuDelete?.addEventListener("click", () => {
  const groupId = groupsContextGroupId;
  const group = hostGroups.find((g) => g.id === groupId);
  hideGroupsContextMenu();
  if (!group) return;
  if (!confirm(t("groups.confirm.delete", { name: group.name }))) return;
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
  hostGroups = hostGroups.filter((g) => !toDelete.has(g.id));
  for (const gid of toDelete) {
    delete groupExpandedState[gid];
  }
  for (const key of Object.keys(hostGroupMap)) {
    if (toDelete.has(hostGroupMap[key])) delete hostGroupMap[key];
  }
  saveVaultGroupsState();
  renderHosts();
});

window.addEventListener("click", () => hideHostsContextMenu());
window.addEventListener("click", () => hideGroupsContextMenu());
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
settingsBackButton?.addEventListener("click", () => setWorkspaceMode("vaults"));
settingsNavGeneral?.addEventListener("click", () => setSettingsSection("general"));
settingsNavTerminal?.addEventListener("click", () => setSettingsSection("terminal"));
settingsNavSync?.addEventListener("click", () => setSettingsSection("sync"));
settingsNavAbout?.addEventListener("click", () => setSettingsSection("about"));
settingsUpdateInstall?.addEventListener("click", async () => {
  await runSyncButtonAction(settingsUpdateInstall, t("settings.update.status.installing"), async () => {
    try {
      if (settingsUpdateStatus) settingsUpdateStatus.textContent = t("settings.update.status.installing");
      await invoke("install_update");
    } catch (e) {
      const msg = t("settings.update.failed", { error: String(e) });
      if (settingsUpdateStatus) settingsUpdateStatus.textContent = msg;
      showToast(msg, "error", 4200);
    }
  });
});
settingsGeneralSubtabBasic?.addEventListener("click", () => setSettingsGeneralSubtab("basic"));
settingsGeneralSubtabSftp?.addEventListener("click", () => setSettingsGeneralSubtab("sftp"));
settingsTerminalSubtabTheme?.addEventListener("click", () => setSettingsTerminalSubtab("theme"));
settingsTerminalSubtabFont?.addEventListener("click", () => setSettingsTerminalSubtab("font"));
vaultBottomSettingsRow?.addEventListener("click", (ev) => {
  if (ev.target?.closest?.("#vault-bottom-settings")) return;
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
      if (settingsSyncStatus) settingsSyncStatus.textContent = t("settings.sync.status.joined");
      await refreshSyncStatusLine();
      await refreshHostsCacheFromVault({ silent: true });
      await refreshSyncConflicts();
      await refreshSyncRepoStats();
      showToast(t("settings.sync.status.joined"), "success");
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
      await refreshHostsCacheFromVault({ silent: true });
      await refreshSyncStatusLine();
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
quickConnectOverlay?.addEventListener("click", (ev) => {
  if (ev.target === quickConnectOverlay) closeQuickConnectOverlay();
});
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
  const value = settingsTerminalTheme.value;
  terminalEditingThemeId = value;
  localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, allTerminalThemes()[value] ? value : "termark-dark");
  applyTerminalThemeToAllPanes();
  syncTerminalThemeCardsActive();
  syncTerminalThemeEditor();
});
settingsTerminalFontFamily?.addEventListener("change", () => {
  localStorage.setItem(SETTINGS_KEY_TERMINAL_FONT_FAMILY, settingsTerminalFontFamily.value);
  applyTerminalThemeToAllPanes();
  syncTerminalFontPreview();
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
loadCustomThemes();
rebuildTerminalThemeSelectOptions();
renderTerminalThemeCards();
syncTerminalThemeEditor();

themeColorBg?.addEventListener("input", () => updateCustomThemeColor("background", `${themeColorBg.value}00`));
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
  updateCustomThemeColor("background", `${v}00`);
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

  // Built-in themes are read-only. For "Edit", create a custom copy first
  // so this action always opens an editable theme dialog.
  let editableId = id;
  const existingCustom = terminalCustomThemes.find((t) => t.id === id);
  if (!existingCustom) {
    const baseTheme = allTerminalThemes()[id];
    if (!baseTheme) return;
    const baseLabel = TERMINAL_THEME_META[id]?.label || id;
    let newId = `custom-${Date.now()}`;
    while (terminalCustomThemes.some((t) => t.id === newId)) {
      newId = `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
    terminalCustomThemes.push({
      id: newId,
      label: `${baseLabel} Custom`,
      group: TERMINAL_THEME_META[id]?.group === "light" ? "light" : "dark",
      theme: { ...baseTheme },
    });
    saveCustomThemes();
    editableId = newId;
    localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, editableId);
    terminalEditingThemeId = editableId;
    rebuildTerminalThemeSelectOptions();
    renderTerminalThemeCards();
    syncTerminalThemeEditor();
    applyTerminalThemeToAllPanes();
  }

  openThemeEditDialog(editableId);
});

themeMenuDuplicate?.addEventListener("click", async () => {
  const id = themeMenuTargetId;
  themeCardMenu.hidden = true;
  if (!id) return;
  const baseTheme = allTerminalThemes()[id];
  if (!baseTheme) return;
  const label = await openTextInputDialog({
    title: "复制为自定义",
    message: "请输入新主题名称",
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

themeMenuDelete?.addEventListener("click", () => {
  const id = themeMenuTargetId;
  themeCardMenu.hidden = true;
  const target = terminalCustomThemes.find((t) => t.id === id);
  if (!target) return;
  if (!confirm(`删除自定义主题 \"${target.label}\"?`)) return;
  terminalCustomThemes = terminalCustomThemes.filter((t) => t.id !== id);
  saveCustomThemes();
  const fallback = "termark-dark";
  terminalEditingThemeId = fallback;
  localStorage.setItem(SETTINGS_KEY_TERMINAL_THEME, fallback);
  rebuildTerminalThemeSelectOptions();
  renderTerminalThemeCards();
  syncTerminalThemeEditor();
  applyTerminalThemeToAllPanes();
});

themeEditCancel?.addEventListener("click", () => {
  const id = terminalEditingThemeId;
  const idx = terminalCustomThemes.findIndex((t) => t.id === id);
  if (idx >= 0 && themeEditOriginal) {
    terminalCustomThemes[idx].theme = JSON.parse(JSON.stringify(themeEditOriginal));
    saveCustomThemes();
    applyTerminalThemeToAllPanes();
    syncTerminalThemeEditor();
  }
  if (themeEditOverlay) themeEditOverlay.hidden = true;
});

themeEditReset?.addEventListener("click", () => {
  if (!themeEditOriginal) return;
  const id = terminalEditingThemeId;
  const idx = terminalCustomThemes.findIndex((t) => t.id === id);
  if (idx < 0) return;
  terminalCustomThemes[idx].theme = JSON.parse(JSON.stringify(themeEditOriginal));
  saveCustomThemes();
  applyTerminalThemeToAllPanes();
  syncTerminalThemeEditor();
});

themeEditForm?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (themeEditOverlay) themeEditOverlay.hidden = true;
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

newWindowButton.addEventListener("click", () => {
  invoke("open_new_window").catch((e) => alert(t("terminal.error.new_window_failed", { error: e })));
});

async function enterHosts() {
  show("hosts");
  setWorkspaceMode("vaults");
  hostSearch.value = "";
  loadVaultGroupsState();
  migrateAutoSeededGroupsIfNeeded();

  try {
    await refreshHostsCacheFromVault();
  } catch (e) {
    hostsCache = [];
    hostsEmpty.hidden = false;
    hostsEmpty.textContent = t("hosts.error.load_failed", { error: e });
    return;
  }
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
    hostsEmpty.textContent = q
      ? t("hosts.empty.search")
      : t("hosts.empty.default");
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
    const gid = hostGroupMap[host.id];
    if (gid && groupedRows.has(gid)) {
      groupedRows.get(gid).push(host);
    } else {
      ungroupedRows.push(host);
    }
  }

  function renderGroupNode(group, depth) {
    const items = groupedRows.get(group.id) || [];
    const expanded = groupExpandedState[group.id] !== false;

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
      saveVaultGroupsState();
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
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      row.classList.remove("drop-target");
      const hostId = (ev.dataTransfer && ev.dataTransfer.getData("text/plain")) || draggingHostId;
      if (!hostId) return;
      hostGroupMap[hostId] = group.id;
      saveVaultGroupsState();
      renderHosts();
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
        event?.preventDefault?.();
        if (!uri) return;
        const url = /^https?:\/\//i.test(uri) ? uri : `http://${uri}`;
        invoke("plugin:opener|open", { path: url }).catch(() => {
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
    requestPaneFit(pane, { immediate: true });
    pane.term.focus();
  } catch (e) {
    console.warn("terminal open/fit failed", e);
  }

  pane.term.onData((d) => {
    if (pane.sessionId === null) return;
    const bytes = Array.from(new TextEncoder().encode(d));
    invoke("send_input", { sessionId: pane.sessionId, data: bytes }).catch((e) => {
      console.warn("send_input failed", e);
    });
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
          activate: () => {
            const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            invoke("plugin:opener|open", { path: url }).catch(() => {
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
          activate: () => {
            const url = /^https?:\/\//i.test(value) ? value : `http://${value}`;
            invoke("plugin:opener|open", { path: url }).catch(() => {
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
  try {
    pane.fitAddon.fit();
  } catch {
    return;
  }
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
      pane.term.write(`\x1b[31m${t("terminal.error.connect_failed_term", { error: e })}\x1b[0m\r\n`);
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
    pane.term.write(new Uint8Array(ev.payload.data));
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
    if (pane.term) pane.term.write(tail);
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
const hfForwardsList = document.getElementById("hf-forwards");
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
  if (hfPassword) hfPassword.type = "password";
  if (hfKeyPassphrase) hfKeyPassphrase.type = "password";
  syncPasswordToggleButton(hfPasswordToggle, false, { show: "显示密码", hide: "隐藏密码" });
  syncPasswordToggleButton(hfKeyPassphraseToggle, false, { show: "显示口令", hide: "隐藏口令" });
  hfForwards = [];
  loadVaultGroupsState();

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

      populateHostGroupOptions(hostGroupMap[id] || "");

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
    populateHostGroupOptions("");
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

  syncCustomSelect("hf-jump");
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
    let savedHostId = editingHostId;
    if (editingHostId) {
      await invoke("update_host", { id: editingHostId, input });
    } else {
      savedHostId = await invoke("save_host", { input });
    }

    if (savedHostId) {
      const groupId = hfGroup?.value || "";
      if (groupId) {
        hostGroupMap[savedHostId] = groupId;
      } else {
        delete hostGroupMap[savedHostId];
      }
      saveVaultGroupsState();
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

function isLocalPane(pane) {
  return pane.hostId === LOCAL_HOST_ID;
}

function isPaneConnected(pane) {
  return pane.localConnected || pane.sftpId !== null;
}

function isRightPaneHostEmpty(pane) {
  return pane.key === "right" && !pane.hostId;
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
    actionsButton: document.getElementById(`sftp-${key}-actions`),
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

const sftpPanes = {
  left: buildSftpPane("left"),
  right: buildSftpPane("right"),
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
    const selected = pane.hostId || pane.host?.id || "";
    pane.hostSelect.innerHTML = "";

    if (pane.key === "right") {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t("sftp.host.placeholder");
      pane.hostSelect.appendChild(empty);
    }

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
    if (pane.key === "right" && !pane.hostSelect.value) pane.hostSelect.value = "";
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
    await navigateSftpPane(pane, pane.path);
    pane.localConnected = true;
    renderSftpPane(pane);
  } catch (e) {
    pane.localConnected = false;
    pane.statusEl.textContent = t("sftp.error.connect_failed", { error: e });
  }
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
      ? t("sftp.status.local", { path: pane.path })
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
  }
  if (showRightEmpty) {
    pane.selectedEntries = new Set();
    pane.statusEl.textContent = t("sftp.status.not_connected");
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
    marker.textContent = kindMarker(entry.kind);

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
    entry.size <= FILE_EDITOR_MAX_BYTES &&
    isLikelyEditableTextName(entry.name)
  );
}

function kindMarker(kind) {
  if (kind === "dir") return "📁";
  if (kind === "file") return "📄";
  if (kind === "symlink") return "↪";
  return "?";
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
  filesMenuOpenWith.disabled = !(connected && !local && canInlineEdit);
  filesMenuCopy.disabled = !(connected && !local && hasSingleTarget && isFile);
  filesMenuRename.disabled = !(connected && hasSingleTarget);
  filesMenuDelete.disabled = !(connected && hasDeleteTarget);
  filesMenuRefresh.disabled = !connected;
  filesMenuMkdir.disabled = !connected;
  filesMenuUpload.disabled = !connected || local;
  filesMenuHidden.disabled = !connected;
  filesMenuPermissions.disabled = true;
  filesMenuSelectAll.disabled = !(connected && getVisibleEntriesForPane(pane).length > 0);
  filesMenuEdit.disabled = !(connected && canInlineEdit);
  filesMenuDownload.disabled = !(connected && !local && canDownload);
  filesMenuClose.disabled = false;
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
        maxBytes: FILE_EDITOR_MAX_BYTES,
      }
      : {
        sftpId: pane.sftpId,
        path,
        maxBytes: FILE_EDITOR_MAX_BYTES,
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

  pane.actionsButton.addEventListener("click", (ev) => {
    hideFilesContextMenu();
    const rect = ev.currentTarget.getBoundingClientRect();
    showFilesContextMenu(pane, null, rect.left, rect.bottom + 6);
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
  await openSftpEntry(pane, entry, { forceEditor: true });
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

filesMenuPermissions.addEventListener("click", () => {
  const pane = getFilesContextPane();
  hideFilesContextMenu();
  if (!pane || !isPaneConnected(pane)) return;
  pane.statusEl.textContent = t("files.error.permissions_not_supported");
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

filesMenuClose.addEventListener("click", () => {
  hideFilesContextMenu();
});

fileEditorCancelButton.addEventListener("click", () => closeRemoteEditor());
fileEditorSaveButton.addEventListener("click", () => saveRemoteEditor());
fileEditorOverlay.addEventListener("click", (ev) => {
  if (ev.target === fileEditorOverlay) closeRemoteEditor();
});
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
refreshVaultStatus();
function openSettingsPage() {
  setWorkspaceMode("settings");
}
