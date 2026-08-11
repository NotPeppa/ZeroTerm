// Regression test: closing a terminal tab must update visible state before
// backend teardown completes, and renderer disposal errors must not leave a
// blank macOS "ghost tab" behind.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");

const disconnectStart = source.indexOf("async function disconnectPaneSession");
const closeStart = source.indexOf("async function closeTab", disconnectStart);
const closeEnd = source.indexOf("\nasync function splitActiveTab", closeStart);

if (disconnectStart < 0 || closeStart < 0 || closeEnd < 0) {
  throw new Error("terminal close helpers were not found");
}

let resolveDisconnect;
const disconnectGate = new Promise((resolve) => {
  resolveDisconnect = resolve;
});
const forgotten = [];
const warnings = [];
let renderTabStripCount = 0;
let renderWorkspaceCount = 0;
let workspaceMode = "terminal";
let rootRemoved = false;

const pane = {
  id: "pane-1",
  sessionId: 41,
  lastSentCols: 80,
  lastSentRows: 24,
  dataUnlisten: null,
  latencyUnlisten: null,
  latencyStoppedUnlisten: null,
  closedUnlisten: null,
  pendingResizeTimer: null,
  pendingFitRaf: null,
  pendingTerminalWrites: 1,
  fitAfterTerminalWrites: true,
  resizeObserver: null,
  osc7HandlerDispose: null,
  bufferChangeDispose: null,
  dprMediaQuery: null,
  ipLinkProviderDispose: null,
  rendererAddon: {
    dispose() {
      throw new Error("simulated macOS canvas disposal failure");
    },
  },
  term: {
    dispose() {
      throw new Error("simulated xterm disposal failure");
    },
  },
  fitAddon: {},
  searchAddon: {},
  rootEl: {
    parentNode: {
      removeChild() {
        rootRemoved = true;
      },
    },
  },
  bodyEl: {},
  titleEl: {},
  latencyEl: {},
  statusEl: {},
  reconnectBtn: {},
};

const termState = {
  tabs: [{ id: "tab-1", panes: [pane], activePaneId: pane.id }],
  activeTabId: "tab-1",
};

const helpers = vm.runInNewContext(
  `${source.slice(disconnectStart, closeEnd)}; ({ disconnectPaneSession, closeTab })`,
  {
    termState,
    invoke: () => disconnectGate,
    clearPaneAttention: () => {},
    forgetAiPaneState: (key) => forgotten.push(key),
    getActivePane: () => null,
    syncAiTerminalControlUi: () => {},
    stopPaneAliveWatchdog: () => {},
    disposePaneAttentionHandlers: () => {},
    clearTimeout: () => {},
    cancelAnimationFrame: () => {},
    renderTabStrip: () => { renderTabStripCount += 1; },
    renderTerminalWorkspace: () => { renderWorkspaceCount += 1; },
    setWorkspaceMode: (mode) => { workspaceMode = mode; },
    console: { warn: (...args) => warnings.push(args) },
  },
);

async function run() {
  let settled = false;
  const closePromise = helpers.closeTab("tab-1").then(() => {
    settled = true;
  });

  if (termState.tabs.length !== 0 || termState.activeTabId !== null) {
    throw new Error("tab state was not removed immediately");
  }
  if (workspaceMode !== "vaults" || renderTabStripCount !== 1 || renderWorkspaceCount !== 0) {
    throw new Error("visible workspace did not switch immediately after the last tab closed");
  }

  await Promise.resolve();
  if (settled) {
    throw new Error("regression fixture expected backend disconnect to remain pending");
  }

  resolveDisconnect();
  await closePromise;

  if (!rootRemoved || pane.rootEl !== null || pane.term !== null || pane.rendererAddon !== null) {
    throw new Error("pane cleanup stopped after a renderer disposal exception");
  }
  if (warnings.length !== 2) {
    throw new Error(`expected two isolated disposal warnings, got ${warnings.length}`);
  }
  if (!forgotten.includes("session:41") || !forgotten.includes("pane:pane-1")) {
    throw new Error("terminal AI state was not evicted during close");
  }

  console.log("terminal-close.test.js: passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
