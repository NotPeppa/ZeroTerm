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
    unlockPath.textContent = `vault: ${status.path}`;

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

      unlockStatus.textContent = "Enter your master password to continue.";
      unlockLabel.textContent = "Master password";
      unlockButton.textContent = "Unlock";
      unlockConfirm.hidden = true;
    } else {
      unlockStatus.textContent =
        "No vault yet. Choose a master password — it cannot be recovered.";
      unlockLabel.textContent = "New master password";
      unlockButton.textContent = "Create vault";
      unlockConfirm.hidden = false;
    }

    unlockRemember.checked = false;
    unlockForm.hidden = false;
    unlockPassword.focus();
  } catch (e) {
    unlockStatus.textContent = `error: ${e}`;
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
        throw new Error("passwords do not match");
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

let hostsCache = [];
const selectedHostIds = new Set();

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
  if (!confirm(`Delete ${picked.length} selected host(s)?`)) return;

  for (const host of picked) {
    try {
      await invoke("delete_host", { id: host.id });
    } catch (e) {
      alert(`delete failed for ${host.name}: ${e}`);
      break;
    }
  }
  await enterHosts();
});

openTerminalsButton.addEventListener("click", () => {
  if (termState.tabs.length === 0) {
    alert("No terminal tabs yet. Open a host first.");
    return;
  }
  show("terminal");
  renderTerminalWorkspace();
});

newWindowButton.addEventListener("click", () => {
  invoke("open_new_window").catch((e) => alert(`new window failed: ${e}`));
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
    hostsEmpty.textContent = `error: ${e}`;
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
      ? "No host matched your search."
      : "No saved hosts yet. Click + New host or add from CLI.";
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
    meta.textContent = host.authType;

    info.append(name, target, meta);
    top.append(pick, badge, info);

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const connectBtn = document.createElement("button");
    connectBtn.type = "button";
    connectBtn.textContent = "Connect";
    connectBtn.className = "primary";
    connectBtn.addEventListener("click", () => openHostInTerminal(host));

    const filesBtn = document.createElement("button");
    filesBtn.type = "button";
    filesBtn.textContent = "Files";
    filesBtn.addEventListener("click", () => openFiles(host));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openHostEditor(host.id));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`Delete saved host "${host.name}"?`)) return;
      try {
        await invoke("delete_host", { id: host.id });
        await enterHosts();
      } catch (e) {
        alert(`delete failed: ${e}`);
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
  hostsSelectionHint.textContent = `${count} selected`;
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
  alert("Select a host to open a new terminal tab.");
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
  invoke("open_new_window").catch((e) => alert(`new window failed: ${e}`));
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
    empty.textContent = "No open terminal tabs. Open one from Hosts.";
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
    : "Empty pane";

  const status = document.createElement("span");
  status.className = "pane-status";
  status.textContent = "connecting...";

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
    pane.statusEl.textContent = "connected";

    await wirePaneSessionEvents(pane, sessionId);

    try {
      const info = await invoke("session_info", { sessionId });
      const bits = [];
      if (info.jump) bits.push(`via ${info.jump}`);
      if (info.forwards.length > 0) bits.push(info.forwards.join(", "));
      if (bits.length > 0) {
        pane.statusEl.textContent = bits.join(" · ");
      }
    } catch (e) {
      console.warn("session_info failed", e);
    }
  } catch (e) {
    pane.statusEl.textContent = `connect failed: ${e}`;
    if (pane.term) {
      pane.term.write(`\x1b[31mfailed to connect: ${e}\x1b[0m\r\n`);
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
        ? `\r\n\x1b[2m[remote exited with status ${ev.payload.exitCode}]\x1b[0m\r\n`
        : "\r\n\x1b[2m[disconnected]\x1b[0m\r\n";

    pane.sessionId = null;
    if (pane.statusEl) pane.statusEl.textContent = "disconnected";
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
    alert("Current split mode supports up to 2 panes.");
    return;
  }

  const source = getActivePane();
  if (!source || !source.host) {
    alert("Active pane has no host to duplicate.");
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
    hkTitle.textContent = "Unknown host";
    hkBody.textContent =
      `The authenticity of '${currentHostKey.host}:${currentHostKey.port}' cannot be established. ` +
      "Trusting this key adds it to known_hosts.";
    hkDetail.textContent = `${currentHostKey.keyType}\n${currentHostKey.fingerprint}`;
  } else {
    hkTitle.textContent = "Warning: host key changed";
    hkBody.textContent =
      "This might indicate a man-in-the-middle attack. Trust only if you know why the key changed.";
    hkDetail.textContent =
      `Server now offers:\n  ${currentHostKey.keyType} ${currentHostKey.fingerprint}\n` +
      `known_hosts has:\n  ${currentHostKey.stored ?? "(unknown)"}`;
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
  hfKeyStatus.textContent = "No key loaded";
  hfPassword.value = "";
  hfKeyPassphrase.value = "";
  hfForwards = [];

  await populateJumpOptions(id);

  if (id) {
    hostTitle.textContent = "Edit host";
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
        hfKeyStatus.textContent = "Existing key kept (choose a file to replace)";
        hfKeyPassphrase.value = h.keyPassphrase ?? "";
      }

      hfJump.value = h.proxyJump ?? "";
      hfForwards = h.forwards.map(forwardFromIO);
    } catch (e) {
      hostError.textContent = `load failed: ${e}`;
      hostError.hidden = false;
    }
  } else {
    hostTitle.textContent = "Add host";
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
  none.textContent = "(none)";
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
    empty.textContent = "(no forwards)";
    hfForwardsList.appendChild(empty);
    return;
  }

  hfForwards.forEach((fwd, idx) => {
    const li = document.createElement("li");

    const kind = document.createElement("select");
    [["local", "Local (-L)"], ["dynamic", "SOCKS5 (-D)"]].forEach(([v, label]) => {
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
    bind.placeholder = "bind";
    bind.value = fwd.bindAddr;
    bind.addEventListener("input", () => (fwd.bindAddr = bind.value));
    fields.appendChild(bind);

    const bp = document.createElement("input");
    bp.className = "short";
    bp.type = "number";
    bp.placeholder = "port";
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
      th.placeholder = "target host";
      th.value = fwd.targetHost ?? "";
      th.addEventListener("input", () => (fwd.targetHost = th.value));
      fields.appendChild(th);

      const tp = document.createElement("input");
      tp.className = "short";
      tp.type = "number";
      tp.placeholder = "port";
      tp.min = 1;
      tp.max = 65535;
      tp.value = fwd.targetPort ?? "";
      tp.addEventListener("input", () => (fwd.targetPort = tp.value));
      fields.appendChild(tp);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
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
      title: "Choose a private key",
    },
  });

  if (!chosen) return;
  const path = String(chosen);

  try {
    const text = await invoke("read_local_text_file", { path });
    hfKeyPem = text;
    hfKeyStatus.textContent = `loaded ${basename(path)} (${text.length} bytes)`;
  } catch (e) {
    hfKeyStatus.textContent = `read failed: ${e}`;
  }
}

async function buildKeyAuth() {
  if (editingHostId && !hfKeyPem) {
    showHostError("Pick a new key file to replace existing key.");
    return null;
  }
  if (!editingHostId && !hfKeyPem) {
    showHostError("Pick a private key file first.");
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
      showHostError(`forward ${i + 1}: invalid bind port`);
      return;
    }

    if (fwd.kind === "local") {
      if (!fwd.targetHost?.trim()) {
        showHostError(`forward ${i + 1}: target host required`);
        return;
      }
      const targetPort = parseInt(fwd.targetPort, 10);
      if (!targetPort || targetPort < 1 || targetPort > 65535) {
        showHostError(`forward ${i + 1}: invalid target port`);
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
    showHostError("name, host and user are required");
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
    setFileEditorError("Ace editor failed to load.");
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
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    await invoke("sftp_mkdir", {
      sftpId: filesSftpId,
      path: joinPath(filesCurrentPath, name),
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`mkdir failed: ${e}`);
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
  fileEditorTitle.textContent = dirty ? "Edit Remote File *" : "Edit Remote File";
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
    setFileEditorError("Enter text in Search first.");
    return false;
  }

  const range = fileEditorAce.find(needle, editorSearchOptions({ backwards }));
  if (!range) {
    setFileEditorError("No matches found.");
    return false;
  }
  setFileEditorError("");
  return true;
}

function replaceInEditor({ all = false } = {}) {
  if (!fileEditorState.open || !ensureFileEditorAce()) return;
  const needle = fileEditorFindInput.value;
  if (!needle) {
    setFileEditorError("Enter text in Search first.");
    return;
  }

  const replacement = fileEditorReplaceInput.value ?? "";
  const opts = editorSearchOptions();

  if (all) {
    const replaced = fileEditorAce.replaceAll(replacement, { ...opts, needle });
    if (!replaced) {
      setFileEditorError("No matches found to replace.");
      return;
    }
    setFileEditorError("");
    fileEditorHint.textContent = `Replaced ${replaced} occurrence(s).`;
    return;
  }

  if (!searchInEditor({ backwards: false })) return;
  const replaced = fileEditorAce.replace(replacement);
  if (replaced == null) {
    setFileEditorError("No match selected to replace.");
    return;
  }

  setFileEditorError("");
  fileEditorHint.textContent = "Replaced 1 occurrence.";
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
  fileEditorHint.textContent = "Supports common UTF-8 text files. Press Ctrl/Cmd + S to save.";
  fileEditorTitle.textContent = "Edit Remote File";
  setFileEditorError("");
}

async function openRemoteEditor(entry) {
  if (!canInlineEditEntry(entry)) {
    alert("This file type is not in the inline-edit list, or the file is too large.");
    return;
  }
  if (filesSftpId === null) return;
  if (!ensureFileEditorAce()) {
    alert("Editor component failed to load.");
    return;
  }

  if (fileEditorState.open && fileEditorState.dirty) {
    const ok = confirm("Discard unsaved editor changes?");
    if (!ok) return;
  }

  resetFileEditorState();
  const path = joinPath(filesCurrentPath, entry.name);
  fileEditorOverlay.hidden = false;
  fileEditorTitle.textContent = "Opening...";
  fileEditorPath.textContent = path;
  fileEditorHint.textContent = "Loading file content...";
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
    fileEditorHint.textContent =
      `UTF-8 text · ${doc.content.split(/\r?\n/).length} lines · Ctrl/Cmd + S to save`;
    fileEditorSetReadOnly(false);
    fileEditorSaveButton.disabled = false;
    setFileEditorDirty(false);
    refreshFileEditorLayout();
    fileEditorFocus();
  } catch (e) {
    fileEditorState.open = false;
    setFileEditorError(`open failed: ${e}`);
    fileEditorTitle.textContent = "Edit Remote File";
    fileEditorHint.textContent = "Unable to open this file in the inline editor.";
  }
}

function closeRemoteEditor({ force = false } = {}) {
  if (fileEditorOverlay.hidden) return true;
  if (!force && fileEditorState.saving) return false;
  if (!force && fileEditorState.open && fileEditorState.dirty && !fileEditorState.saving) {
    const ok = confirm("You have unsaved changes. Close editor anyway?");
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
    fileEditorHint.textContent = `Saved ${formatSize(bytes)} just now`;
    filesStatus.textContent = `Saved ${fileEditorState.path}.`;
    await navigateTo(filesCurrentPath);
  } catch (e) {
    setFileEditorError(`save failed: ${e}`);
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
  filesStatus.textContent = "Connecting...";

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
    showFilesError(`open failed: ${e}`);
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
  filesStatus.textContent = `Listing ${path}...`;

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
    showFilesError(`list failed: ${e}`);
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
    empty.textContent = "(empty)";
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
  filesSelectionHint.textContent = `${count} selected`;
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

  beginTransfer(`Downloading ${entry.name}`);
  try {
    const n = await invoke("sftp_download", {
      sftpId: filesSftpId,
      remote,
      local,
    });
    filesStatus.textContent = `Downloaded ${entry.name} (${formatSize(n)}).`;
  } catch (e) {
    showFilesError(`download failed: ${e}`);
  } finally {
    hideProgress();
    activeTransferId = null;
  }
}

async function renameEntry(entry) {
  const next = prompt(`Rename "${entry.name}" to:`, entry.name);
  if (!next || next === entry.name) return;
  try {
    await invoke("sftp_rename", {
      sftpId: filesSftpId,
      from: joinPath(filesCurrentPath, entry.name),
      to: joinPath(filesCurrentPath, next),
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`rename failed: ${e}`);
  }
}

async function deleteEntry(entry) {
  const target = joinPath(filesCurrentPath, entry.name);
  if (!confirm(`Delete ${target}?`)) return;

  const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
  try {
    await invoke(command, {
      sftpId: filesSftpId,
      path: target,
    });
    await navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`delete failed: ${e}`);
  }
}

async function deleteSelectedFiles() {
  const picked = filesEntries.filter((e) => filesSelected.has(e.name));
  if (picked.length === 0) return;
  if (!confirm(`Delete ${picked.length} selected item(s)?`)) return;

  for (const entry of picked) {
    const path = joinPath(filesCurrentPath, entry.name);
    const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
    try {
      await invoke(command, { sftpId: filesSftpId, path });
    } catch (e) {
      showFilesError(`delete failed for ${entry.name}: ${e}`);
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

  beginTransfer(`Uploading ${name}`);
  try {
    const n = await invoke("sftp_upload", {
      sftpId: filesSftpId,
      local: localPath,
      remote,
    });
    filesStatus.textContent = `Uploaded ${name} (${formatSize(n)}).`;
  } catch (e) {
    showFilesError(`upload failed for ${name}: ${e}`);
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
      beginTransfer(`Uploading ${file.name}`);
      const n = await invoke("sftp_upload_bytes", {
        sftpId: filesSftpId,
        remote,
        data: Array.from(bytes),
        sourceLabel: file.name,
      });
      filesStatus.textContent = `Uploaded ${file.name} (${formatSize(n)}).`;
    } catch (e) {
      showFilesError(`drag upload failed for ${file.name}: ${e}`);
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
    alert("Select at least one file (directories are skipped for bulk download).");
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

    beginTransfer(`Downloading ${entry.name}`);
    try {
      await invoke("sftp_download", {
        sftpId: filesSftpId,
        remote,
        local,
      });
    } catch (e) {
      showFilesError(`download failed for ${entry.name}: ${e}`);
      break;
    } finally {
      hideProgress();
      activeTransferId = null;
    }
  }

  filesStatus.textContent = `Downloaded ${picked.length} file(s) to ${folder}.`;
}

function beginTransfer(label) {
  activeTransferId = "pending";
  pendingCancel = false;
  progressLabel.textContent = label;
  progressBar.removeAttribute("value");
  filesProgress.hidden = false;
}

function showProgress(p) {
  const verb = p.kind === "upload" ? "Uploading" : "Downloading";
  let suffix = "";
  if (p.bytesPerSec != null && p.bytesPerSec > 0) {
    suffix += ` · ${formatSize(p.bytesPerSec)}/s`;
  }
  if (p.etaSeconds != null) {
    suffix += ` · ETA ${formatEta(p.etaSeconds)}`;
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

refreshVaultStatus();
