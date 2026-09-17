// The hotkey table is the only source of truth for the dispatcher and the
// settings list, so combo normalisation and override semantics must hold.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("const SETTINGS_KEY_KEYBINDINGS");
const end = source.indexOf("\nfunction renderKeybindingSettings", start);
if (start < 0 || end < 0) throw new Error("keybinding helpers were not found");

function load({ isMac = false, saved = null } = {}) {
  const store = { value: saved };
  const context = {
    console,
    isMacPlatform: isMac,
    workspaceMode: "terminal",
    termState: { tabs: [], activeTabId: null },
    getActivePane: () => null,
    openPaneFindPrompt: async () => {},
    openLocalTerminalInTab: async () => {},
    closeTab: async () => {},
    openQuickConnectOverlay: () => {},
    openSettingsPage: () => {},
    setWorkspaceMode: () => {},
    renderTerminalWorkspace: () => {},
    invoke: async () => {},
    alert: () => {},
    t: (key) => key,
    showToast: () => {},
    localStorage: {
      getItem: () => store.value,
      setItem: (_k, v) => { store.value = v; },
    },
  };
  const api = vm.runInNewContext(
    `${source.slice(start, end)}; ({ KEYBINDING_ACTIONS, comboFromEvent, formatKeybindingCombo, isUsableKeybindingCombo, getKeybindingCombo, setKeybindingOverride, activateTabByOffset })`,
    context,
  );
  return { api, context, store };
}

function ev(key, mods = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

// "Mod" is Ctrl off mac and Cmd on mac, so one default string covers both.
const win = load();
if (win.api.comboFromEvent(ev("f", { ctrlKey: true })) !== "Mod+F") throw new Error("ctrl+f did not normalise to Mod+F");
if (win.api.comboFromEvent(ev("f", { metaKey: true })) !== "Meta+F") throw new Error("win key must not be Mod off mac");
const mac = load({ isMac: true });
if (mac.api.comboFromEvent(ev("f", { metaKey: true })) !== "Mod+F") throw new Error("cmd+f did not normalise to Mod+F");
if (mac.api.comboFromEvent(ev("f", { ctrlKey: true })) !== "Ctrl+F") throw new Error("ctrl must stay ctrl on mac");

// Modifier order is canonical regardless of which flags are set.
if (win.api.comboFromEvent(ev("T", { ctrlKey: true, shiftKey: true, altKey: true })) !== "Mod+Alt+Shift+T") {
  throw new Error("modifier order is not canonical");
}
if (win.api.comboFromEvent(ev("Control", { ctrlKey: true })) !== "") throw new Error("a bare modifier must not record");
if (win.api.comboFromEvent(ev(" ", { ctrlKey: true })) !== "Mod+Space") throw new Error("space was not named");

// A combo with no real modifier would swallow ordinary typing.
for (const [combo, ok] of [["Mod+F", true], ["Ctrl+Tab", true], ["Alt+K", true], ["Shift+A", false], ["A", false]]) {
  if (win.api.isUsableKeybindingCombo(combo) !== ok) throw new Error(`${combo} usability check is wrong`);
}

// Overrides: absent means default, "" means deliberately cleared.
const find = win.api.KEYBINDING_ACTIONS.find((a) => a.id === "terminal.find");
if (win.api.getKeybindingCombo(find) !== "Mod+F") throw new Error("default combo was not returned");
win.api.setKeybindingOverride("terminal.find", "Mod+Alt+F");
if (win.api.getKeybindingCombo(find) !== "Mod+Alt+F") throw new Error("override was not applied");
win.api.setKeybindingOverride("terminal.find", "");
if (win.api.getKeybindingCombo(find) !== "") throw new Error("a cleared binding must not fall back to the default");

const corrupt = load({ saved: "{not json" });
if (corrupt.api.getKeybindingCombo(find) !== "Mod+F") throw new Error("corrupt storage must fall back to defaults");

// Defaults must not collide with each other.
const seen = new Map();
for (const action of win.api.KEYBINDING_ACTIONS) {
  if (seen.has(action.combo)) throw new Error(`${action.combo} is bound twice by default`);
  seen.set(action.combo, action.id);
}

// Tab cycling wraps in both directions.
const cyc = load();
cyc.context.termState.tabs = [{ id: "a" }, { id: "b" }, { id: "c" }];
cyc.context.termState.activeTabId = "a";
cyc.api.activateTabByOffset(-1);
if (cyc.context.termState.activeTabId !== "c") throw new Error("prev-tab did not wrap backwards");
cyc.api.activateTabByOffset(1);
if (cyc.context.termState.activeTabId !== "a") throw new Error("next-tab did not wrap forwards");

console.log("keybindings: ok");
