// Regression test: initial SSH connection and reconnect share one accessible
// loading state, and leaving that state restores the pane controls.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const helperStart = source.indexOf("function setPaneConnecting");
const helperEnd = source.indexOf("\nfunction ensurePaneElements", helperStart);
if (helperStart < 0 || helperEnd < 0) throw new Error("setPaneConnecting helper was not found");

const quickOpenStart = source.indexOf("async function connectQuickHostAndOpenTerminal");
const quickOpenEnd = source.indexOf("\nasync function connectQuickIntoPane", quickOpenStart);
const quickOpenSource = source.slice(quickOpenStart, quickOpenEnd);
if (quickOpenSource.indexOf("pane.reconnectFactory =") > quickOpenSource.indexOf("await connectQuickIntoPane")) {
  throw new Error("quick-connect retry is not available after the initial attempt fails");
}

const translations = {
  "terminal.status.connecting": "connecting...",
  "terminal.status.reconnecting": "reconnecting...",
  "terminal.loading.connecting": "Connecting to {host}",
  "terminal.loading.reconnecting": "Reconnecting to {host}",
};
const t = (key, vars = {}) => (translations[key] || key).replace("{host}", vars.host || "");
const attributes = {};
const classes = new Set();
const pane = {
  host: { name: "prod-shell" },
  rootEl: {
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => { attributes[name] = value; },
  },
  statusEl: { textContent: "" },
  reconnectBtn: { hidden: false, disabled: false },
  connectionLoadingEl: {
    hidden: true,
    setAttribute: (name, value) => { attributes[name] = value; },
  },
  connectionLoadingLabelEl: { textContent: "" },
};

const setPaneConnecting = vm.runInNewContext(
  `${source.slice(helperStart, helperEnd)}; setPaneConnecting`,
  { t },
);

setPaneConnecting(pane, true);
if (!pane.connecting || pane.connectionLoadingEl.hidden || !classes.has("connecting")) {
  throw new Error("initial connection did not show the loading state");
}
if (attributes["aria-busy"] !== "true" || pane.reconnectBtn.disabled !== true) {
  throw new Error("loading state is missing busy/disabled semantics");
}
if (pane.connectionLoadingLabelEl.textContent !== "Connecting to prod-shell") {
  throw new Error("initial connection label is incorrect");
}

setPaneConnecting(pane, true, { reconnecting: true });
if (pane.statusEl.textContent !== "reconnecting..." ||
    pane.connectionLoadingLabelEl.textContent !== "Reconnecting to prod-shell") {
  throw new Error("reconnect did not use its distinct loading label");
}

setPaneConnecting(pane, false);
if (pane.connecting || !pane.connectionLoadingEl.hidden || classes.has("connecting")) {
  throw new Error("loading state was not cleared");
}
if (attributes["aria-busy"] !== "false" || pane.reconnectBtn.disabled !== false) {
  throw new Error("pane controls were not restored after loading");
}

const styles = fs.readFileSync(path.join(__dirname, "../frontend/styles.css"), "utf8");
if (!styles.includes(".pane-connection-spinner") ||
    !styles.includes("@media (prefers-reduced-motion: reduce)")) {
  throw new Error("spinner or reduced-motion fallback is missing");
}

console.log("terminal-connection-loading.test.js: passed");
