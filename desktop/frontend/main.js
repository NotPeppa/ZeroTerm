// ZeroTerm desktop frontend — vanilla JS, intentionally no build step.
// xterm.js is loaded via CDN (see index.html) and exposed on window.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const Terminal = window.Terminal;
const FitAddon = window.FitAddon.FitAddon;

// --------------------------------------------------------------------------
// view switcher
// --------------------------------------------------------------------------
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

// --------------------------------------------------------------------------
// boot — figure out vault state, route to unlock or hosts
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
      enterHosts();
      return;
    }

    if (status.exists) {
      // Boot path tries the keychain first so users who ticked
      // "Remember password" skip the dialog. After an explicit Lock we
      // intentionally skip this — Lock means "force re-auth".
      if (tryKeychain) {
        try {
          const ok = await invoke("try_keychain_unlock");
          if (ok) {
            enterHosts();
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
        "No vault yet. Choose a master password — you can't recover it later.";
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
  const pw = unlockPassword.value;
  const remember = unlockRemember.checked;

  try {
    if (vaultExists) {
      await invoke("unlock_vault", { password: pw, remember });
    } else {
      if (pw !== unlockConfirm.value) {
        throw "passwords don't match";
      }
      await invoke("create_vault", { password: pw, remember });
    }
    unlockPassword.value = "";
    unlockConfirm.value = "";
    unlockRemember.checked = false;
    enterHosts();
  } catch (e) {
    unlockError.textContent = String(e);
    unlockError.hidden = false;
  }
});

// --------------------------------------------------------------------------
// hosts view
// --------------------------------------------------------------------------
const hostsList = document.getElementById("hosts-list");
const hostsEmpty = document.getElementById("hosts-empty");
document.getElementById("lock-button").addEventListener("click", async () => {
  // Lock = full re-auth required. Drop the in-memory app AND the
  // keychain cache, so the next launch (and any reload right now) goes
  // back to the password prompt. Users who want to stay auto-unlocked
  // simply close the app without clicking Lock.
  try {
    await invoke("forget_keychain");
  } catch (e) {
    console.warn("forget_keychain failed", e);
  }
  await invoke("lock_vault");
  show("unlock");
  refreshVaultStatus({ tryKeychain: false });
});

async function enterHosts() {
  show("hosts");
  hostsList.innerHTML = "";
  let hosts = [];
  try {
    hosts = await invoke("list_hosts");
  } catch (e) {
    hostsEmpty.hidden = false;
    hostsEmpty.textContent = `error: ${e}`;
    return;
  }

  if (hosts.length === 0) {
    hostsEmpty.hidden = false;
    return;
  }
  hostsEmpty.hidden = true;

  for (const host of hosts) {
    const li = document.createElement("li");
    const info = document.createElement("div");
    info.style.flex = "1";
    info.style.cursor = "pointer";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = host.name;
    const target = document.createElement("div");
    target.className = "target";
    target.textContent = `${host.user}@${host.host}:${host.port}`;
    const auth = document.createElement("div");
    auth.className = "auth";
    auth.textContent = host.authType;
    info.append(name, target, auth);
    info.addEventListener("click", () => connect(host));

    const buttons = document.createElement("div");
    buttons.className = "row-buttons";

    const filesBtn = document.createElement("button");
    filesBtn.type = "button";
    filesBtn.textContent = "Files";
    filesBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openFiles(host);
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openHostEditor(host.id);
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete saved host "${host.name}"?`)) return;
      try {
        await invoke("delete_host", { id: host.id });
        await enterHosts();
      } catch (e) {
        alert(`delete failed: ${e}`);
      }
    });

    buttons.append(filesBtn, editBtn, delBtn);

    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.gap = "12px";
    li.append(info, buttons);
    hostsList.appendChild(li);
  }
}

// --------------------------------------------------------------------------
// terminal view
// --------------------------------------------------------------------------
const termTitle = document.getElementById("term-title");
const termSubtitle = document.getElementById("term-subtitle");
const termHost = document.getElementById("terminal");
const backButton = document.getElementById("back-button");
const disconnectButton = document.getElementById("disconnect-button");

let term = null;
let fitAddon = null;
let activeSessionId = null;
let dataUnlisten = null;
let closedUnlisten = null;
let resizeObserver = null;
let pendingTextDecoder = new TextDecoder();

backButton.addEventListener("click", () => {
  if (activeSessionId !== null) {
    invoke("disconnect_session", { sessionId: activeSessionId }).catch(() => {});
  } else {
    teardownTerminal();
    enterHosts();
  }
});

disconnectButton.addEventListener("click", () => {
  if (activeSessionId !== null) {
    invoke("disconnect_session", { sessionId: activeSessionId }).catch(() => {});
  }
});

async function connect(host) {
  show("terminal");
  termTitle.textContent = `${host.name}  (${host.user}@${host.host}:${host.port})`;
  termSubtitle.hidden = true;
  termSubtitle.textContent = "";

  // Build terminal first so we know geometry before we ask for a PTY.
  setupTerminal();
  const cols = term.cols;
  const rows = term.rows;

  try {
    activeSessionId = await invoke("connect_host", {
      hostId: host.id,
      cols,
      rows,
    });
  } catch (e) {
    term.write(`\x1b[31mfailed to connect: ${e}\x1b[0m\r\n`);
    return;
  }

  // Pull the session info so we can show forwards / jump in the header.
  try {
    const info = await invoke("session_info", { sessionId: activeSessionId });
    const bits = [];
    if (info.jump) bits.push(`via ${info.jump}`);
    if (info.forwards.length > 0) bits.push(info.forwards.join(", "));
    if (bits.length > 0) {
      termSubtitle.textContent = bits.join(" · ");
      termSubtitle.hidden = false;
    }
  } catch (e) {
    console.warn("session_info failed", e);
  }

  await wireSessionEvents(activeSessionId);
}

function setupTerminal() {
  teardownTerminal();
  term = new Terminal({
    fontFamily:
      'Menlo, Consolas, "Liberation Mono", "DejaVu Sans Mono", monospace',
    fontSize: 13,
    theme: {
      background: "#000000",
      foreground: "#e6e9ef",
      cursor: "#e6e9ef",
    },
    cursorBlink: true,
    scrollback: 5000,
    convertEol: false,
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(termHost);
  fitAddon.fit();
  term.focus();

  term.onData((d) => {
    if (activeSessionId === null) return;
    const bytes = Array.from(new TextEncoder().encode(d));
    invoke("send_input", { sessionId: activeSessionId, data: bytes }).catch(
      (e) => console.error("send_input failed", e),
    );
  });

  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !term) return;
    fitAddon.fit();
    if (activeSessionId !== null) {
      invoke("resize_session", {
        sessionId: activeSessionId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    }
  });
  resizeObserver.observe(termHost);
}

async function wireSessionEvents(sessionId) {
  dataUnlisten = await listen("session:data", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    // payload.data is a number[] (Vec<u8>) over IPC.
    const bytes = new Uint8Array(ev.payload.data);
    term.write(bytes);
  });

  closedUnlisten = await listen("session:closed", (ev) => {
    if (ev.payload.sessionId !== sessionId) return;
    const tail =
      ev.payload.message
        ? `\r\n\x1b[31m${ev.payload.message}\x1b[0m\r\n`
        : ev.payload.exitCode != null
          ? `\r\n\x1b[2m[remote exited with status ${ev.payload.exitCode}]\x1b[0m\r\n`
          : `\r\n\x1b[2m[disconnected]\x1b[0m\r\n`;
    term.write(tail);
    activeSessionId = null;
  });
}

function teardownTerminal() {
  if (dataUnlisten) {
    dataUnlisten();
    dataUnlisten = null;
  }
  if (closedUnlisten) {
    closedUnlisten();
    closedUnlisten = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (term) {
    term.dispose();
    term = null;
  }
  fitAddon = null;
  activeSessionId = null;
  termHost.innerHTML = "";
}

// --------------------------------------------------------------------------
// host-key prompt
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
      `The authenticity of '${currentHostKey.host}:${currentHostKey.port}' can't be established. ` +
      `Trusting this key adds it to known_hosts permanently — you won't be asked again next time.`;
    hkDetail.textContent = `${currentHostKey.keyType}\n${currentHostKey.fingerprint}`;
  } else {
    hkTitle.textContent = "WARNING — host key changed";
    hkBody.textContent =
      "This could be a man-in-the-middle attack. Trusting here only allows this single connection — " +
      "the stored key in known_hosts is NOT updated. Refuse unless you know exactly why the key changed.";
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
    console.error("respond_host_key failed", e);
  }
}

// --------------------------------------------------------------------------
// host editor (add / edit / delete)
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
const hostError = document.getElementById("host-edit-error");
const hostReadonly = document.getElementById("host-edit-readonly");

let editingHostId = null;
// We never expose the saved key bytes back to the form. The user can
// either keep the existing key (leave the picker empty when editing)
// or replace it (pick a new file). This flag tells `save` whether to
// re-send key bytes.
let hfKeyPem = null;

document.getElementById("add-host-button").addEventListener("click", () => openHostEditor());
document.getElementById("host-edit-cancel").addEventListener("click", closeHostEditor);
hfAuthType.addEventListener("change", () => syncAuthSections());
hfKeyPick.addEventListener("click", pickKeyFile);
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
      } else {
        hfKeyStatus.textContent = "Existing key kept (pick a file to replace)";
        hfKeyPassphrase.value = h.keyPassphrase ?? "";
      }
      const ro = [];
      if (h.proxyJump) ro.push(`ProxyJump: ${h.proxyJump}`);
      if (h.forwards.length > 0) ro.push(`Forwards: ${h.forwards.join(", ")}`);
      if (ro.length > 0) {
        hostReadonly.textContent =
          ro.join(" · ") + " — edit via CLI for now (`zeroterm forward …`)";
        hostReadonly.hidden = false;
      }
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
  }

  syncAuthSections();
  hostOverlay.hidden = false;
  hfName.focus();
}

function closeHostEditor() {
  hostOverlay.hidden = true;
  editingHostId = null;
  hfKeyPem = null;
  hostForm.reset();
}

function syncAuthSections() {
  if (hfAuthType.value === "password") {
    hfPasswordBlock.hidden = false;
    hfKeyBlock.hidden = true;
  } else {
    hfPasswordBlock.hidden = true;
    hfKeyBlock.hidden = false;
  }
}

async function pickKeyFile() {
  const chosen = await invoke("plugin:dialog|open", {
    options: {
      multiple: false,
      directory: false,
      title: "Choose a private key file",
    },
  });
  if (!chosen) return;
  const path = String(chosen);
  try {
    const text = await invoke("read_local_text_file", { path });
    hfKeyPem = text;
    const basename = path.split(/[\\/]/).pop();
    hfKeyStatus.textContent = `loaded ${basename} (${text.length} bytes)`;
  } catch (e) {
    hfKeyStatus.textContent = `read failed: ${e}`;
  }
}

async function saveHostForm(ev) {
  ev.preventDefault();
  hostError.hidden = true;

  const auth = hfAuthType.value === "password"
    ? { type: "password", value: hfPassword.value }
    : await buildKeyAuth();
  if (auth === null) return;

  const input = {
    name: hfName.value.trim(),
    host: hfHost.value.trim(),
    port: parseInt(hfPort.value, 10),
    user: hfUser.value.trim(),
    auth,
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

async function buildKeyAuth() {
  if (editingHostId && !hfKeyPem) {
    // Editing existing host without picking a new key — refuse to wipe
    // the existing PEM. Tell user how to keep it: just don't pick.
    showHostError(
      "Keep the existing key by closing this dialog without saving, " +
      "or pick a new file to replace it.",
    );
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

// --------------------------------------------------------------------------
// files (SFTP)
// --------------------------------------------------------------------------
const filesTitle = document.getElementById("files-title");
const filesPath = document.getElementById("files-path");
const filesList = document.getElementById("files-list");
const filesStatus = document.getElementById("files-status");
const filesProgress = document.getElementById("files-progress");
const progressLabel = document.getElementById("progress-label");
const progressBar = document.getElementById("progress-bar");
const progressCancel = document.getElementById("progress-cancel");

let filesSftpId = null;
let filesCurrentPath = "/";
let filesHost = null;
let activeTransferId = null;
let pendingCancel = false;
let progressUnlisten = null;

document.getElementById("files-back").addEventListener("click", () => closeFiles());
document.getElementById("files-up").addEventListener("click", () => {
  if (filesCurrentPath === "/" || filesCurrentPath === "") return;
  navigateTo(parentPath(filesCurrentPath));
});
document.getElementById("files-refresh").addEventListener("click", () => {
  navigateTo(filesCurrentPath);
});
document.getElementById("files-mkdir").addEventListener("click", async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  try {
    const target = joinPath(filesCurrentPath, name);
    await invoke("sftp_mkdir", { sftpId: filesSftpId, path: target });
    navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`mkdir failed: ${e}`);
  }
});
document.getElementById("files-upload").addEventListener("click", uploadHere);

async function openFiles(host) {
  filesHost = host;
  show("files");
  filesTitle.textContent = `${host.name}  (${host.user}@${host.host}:${host.port})`;
  filesPath.textContent = "/";
  filesList.innerHTML = "";
  filesStatus.textContent = "Connecting…";

  // Start listening to progress events for this files session.
  if (progressUnlisten) {
    progressUnlisten();
    progressUnlisten = null;
  }
  progressUnlisten = await listen("sftp:progress", (ev) => {
    const p = ev.payload;

    // Latch: backend assigns transferId asynchronously, so adopt the
    // first event's id as the canonical one for the in-flight transfer.
    if (activeTransferId === "pending") {
      activeTransferId = p.transferId;
      // If the user clicked Cancel before this first event arrived,
      // honour it now that we finally know the real id.
      if (pendingCancel) {
        pendingCancel = false;
        invoke("sftp_cancel_transfer", { transferId: activeTransferId }).catch(
          (e) => console.warn("cancel failed", e),
        );
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
  cancelActiveTransfer();
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
    filesSftpId = null;
  }
  filesHost = null;
  filesList.innerHTML = "";
  hideProgress();
  enterHosts();
}

async function navigateTo(path) {
  if (filesSftpId === null) return;
  filesStatus.textContent = `Listing ${path}…`;
  try {
    const entries = await invoke("sftp_list", { sftpId: filesSftpId, path });
    filesCurrentPath = path;
    filesPath.textContent = path;
    renderFilesList(entries);
    filesStatus.textContent = "";
  } catch (e) {
    showFilesError(`list failed: ${e}`);
  }
}

function renderFilesList(entries) {
  filesList.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("li");
    empty.style.color = "var(--muted)";
    empty.style.justifyContent = "center";
    empty.textContent = "(empty)";
    filesList.appendChild(empty);
    return;
  }

  for (const e of entries) {
    const li = document.createElement("li");
    if (e.kind === "dir") li.classList.add("dir");

    const marker = document.createElement("span");
    marker.className = "marker";
    marker.textContent = kindMarker(e.kind);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = e.kind === "dir" ? `${e.name}/` : e.name;
    if (e.kind === "dir") {
      name.addEventListener("click", () => {
        navigateTo(joinPath(filesCurrentPath, e.name));
      });
    }

    const size = document.createElement("span");
    size.className = "size";
    size.textContent = e.kind === "dir" ? "—" : formatSize(e.size);

    const actions = document.createElement("span");
    actions.className = "row-actions";
    if (e.kind === "file") {
      const dl = document.createElement("button");
      dl.type = "button";
      dl.textContent = "Download";
      dl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        downloadEntry(e);
      });
      actions.appendChild(dl);
    }
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.textContent = "Rename";
    renameBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      renameEntry(e);
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteEntry(e);
    });
    actions.append(renameBtn, delBtn);

    li.append(marker, name, size, actions);
    filesList.appendChild(li);
  }
}

async function downloadEntry(entry) {
  const remote = joinPath(filesCurrentPath, entry.name);
  const local = await invoke("plugin:dialog|save", {
    options: { defaultPath: entry.name },
  });
  if (!local) return;
  // Reserve a transfer id locally so the progress event handler can
  // route updates to us. Backend assigns its own; we adopt whatever it
  // emits in its events for THIS files session.
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

async function uploadHere() {
  const local = await invoke("plugin:dialog|open", {
    options: { multiple: false, directory: false },
  });
  if (!local) return;
  const basename = String(local).split(/[\\/]/).pop();
  const remote = joinPath(filesCurrentPath, basename);
  beginTransfer(`Uploading ${basename}`);
  try {
    const n = await invoke("sftp_upload", {
      sftpId: filesSftpId,
      local,
      remote,
    });
    filesStatus.textContent = `Uploaded ${basename} (${formatSize(n)}).`;
    navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`upload failed: ${e}`);
  } finally {
    hideProgress();
    activeTransferId = null;
  }
}

function beginTransfer(label) {
  // Backend assigns transferId; we'll latch onto the first event we
  // see for the transfer that's currently running. Race window is
  // tiny (Tauri commands serialize per-call), but to be safe we treat
  // the FIRST progress event as binding for this session.
  activeTransferId = "pending";
  pendingCancel = false;
  progressLabel.textContent = label;
  progressBar.removeAttribute("value");
  filesProgress.hidden = false;
}

function showProgress(p) {
  const verbing = p.kind === "upload" ? "Uploading" : "Downloading";
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
    progressLabel.textContent =
      `${verbing} ${formatSize(p.bytesDone)} / ${formatSize(p.total)}${suffix}`;
  } else {
    progressBar.removeAttribute("value");
    progressLabel.textContent = `${verbing} ${formatSize(p.bytesDone)}${suffix}`;
  }
}

function formatEta(sec) {
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h${m.toString().padStart(2, "0")}m`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function hideProgress() {
  filesProgress.hidden = true;
  progressBar.value = 0;
}

function cancelActiveTransfer() {
  if (typeof activeTransferId === "number") {
    invoke("sftp_cancel_transfer", { transferId: activeTransferId }).catch((e) =>
      console.warn("cancel failed", e),
    );
  } else if (activeTransferId === "pending") {
    // Backend hasn't assigned an id yet; queue the cancel for when the
    // first progress event arrives and latches the real id.
    pendingCancel = true;
  }
}

progressCancel.addEventListener("click", cancelActiveTransfer);

async function renameEntry(entry) {
  const newName = prompt(`Rename "${entry.name}" to:`, entry.name);
  if (!newName || newName === entry.name) return;
  try {
    await invoke("sftp_rename", {
      sftpId: filesSftpId,
      from: joinPath(filesCurrentPath, entry.name),
      to: joinPath(filesCurrentPath, newName),
    });
    navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`rename failed: ${e}`);
  }
}

async function deleteEntry(entry) {
  const target = joinPath(filesCurrentPath, entry.name);
  if (!confirm(`Delete ${target}?`)) return;
  const command = entry.kind === "dir" ? "sftp_remove_dir" : "sftp_remove";
  try {
    await invoke(command, { sftpId: filesSftpId, path: target });
    navigateTo(filesCurrentPath);
  } catch (e) {
    showFilesError(`delete failed: ${e}`);
  }
}

function showFilesError(msg) {
  filesStatus.textContent = msg;
  console.error(msg);
}

function kindMarker(k) {
  switch (k) {
    case "dir": return "📁";
    case "file": return "📄";
    case "symlink": return "↪";
    default: return "?";
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
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
refreshVaultStatus();
