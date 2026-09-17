// Regression checks for the metrics chip in the terminal pane header.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function isPaneHeaderMetricsEnabled");
const end = source.indexOf("\nsetInterval(refreshPaneHeaderMetrics", start);
if (start < 0 || end < 0) throw new Error("pane header metrics helpers were not found");

const SAMPLE = {
  cpuUsage: 12.4,
  memoryUsed: 23,
  memoryTotal: 100,
  disks: [
    { mount: "/", usage: 41, used: 1024, total: 4096 },
    { mount: "/data", usage: 53.2, used: 2048, total: 4096 },
  ],
  networks: [
    { name: "eth0", rxBytesPerSec: 1024, txBytesPerSec: 2048 },
    { name: "eth1", rxBytesPerSec: 1024, txBytesPerSec: 0 },
  ],
};

function createFixture({ saved = null, metrics = SAMPLE, sessionId = "s1", hidden = false } = {}) {
  const values = new Map();
  if (saved !== null) values.set("header.metrics", saved);
  const calls = [];
  const pane = { sessionId, host: { id: "h1" }, metricsEl: { hidden: true, innerHTML: "" } };
  const context = {
    console,
    document: { hidden },
    SETTINGS_KEY_TERMINAL_HEADER_METRICS: "header.metrics",
    localStorage: { getItem: (k) => (values.has(k) ? values.get(k) : null) },
    termState: { tabs: [{ panes: [pane] }] },
    getActiveTab: () => context.termState.tabs[0],
    terminalSessionLayout: { hidden: false },
    t: (key) => key,
    metricTone: (v) => (v >= 95 ? "danger" : v >= 85 ? "warn" : "good"),
    formatMetricBytes: (b) => `${Number(b) || 0} B`,
    invoke: async (cmd, args) => {
      calls.push(args);
      if (metrics instanceof Error) throw metrics;
      return metrics;
    },
  };
  const helpers = vm.runInNewContext(
    `${source.slice(start, end)}; ({ isPaneHeaderMetricsEnabled, applyPaneHeaderMetricsVisibility, refreshPaneHeaderMetrics })`,
    context,
  );
  return { helpers, pane, calls, context };
}

async function run() {
  const on = createFixture();
  if (!on.helpers.isPaneHeaderMetricsEnabled()) throw new Error("missing setting must default to enabled");
  await on.helpers.refreshPaneHeaderMetrics();
  if (on.pane.metricsEl.hidden) throw new Error("chip stayed hidden after a successful sample");
  const chip = on.pane.metricsEl.innerHTML;
  for (const expected of [
    ">12.4%<",            // cpu, one decimal
    ">23.0%<",            // memory percentage
    "23 B / 100 B",       // memory absolute
    ">53%<",              // busiest disk wins
    "2048 B / 4096 B",    // that disk's absolute usage
    "↓ 2048 B/s",         // network totalled across interfaces
    "↑ 2048 B/s",
  ]) {
    if (!chip.includes(expected)) throw new Error(`chip is missing ${expected}: ${chip}`);
  }

  const off = createFixture({ saved: "false" });
  await off.helpers.refreshPaneHeaderMetrics();
  if (off.calls.length) throw new Error("disabled setting must not poll the collector");

  const backgrounded = createFixture({ hidden: true });
  await backgrounded.helpers.refreshPaneHeaderMetrics();
  if (backgrounded.calls.length) throw new Error("a hidden document must not poll the collector");

  const idle = createFixture({ sessionId: null });
  await idle.helpers.refreshPaneHeaderMetrics();
  if (idle.calls.length) throw new Error("a pane without a session must not poll the collector");

  const failing = createFixture({ metrics: new Error("boom") });
  failing.pane.metricsEl.innerHTML = "stale";
  failing.pane.metricsEl.hidden = false;
  await failing.helpers.refreshPaneHeaderMetrics();
  if (failing.pane.metricsEl.innerHTML !== "stale") throw new Error("a failed sample must keep the last reading");

  const hiding = createFixture({ saved: "false" });
  hiding.pane.metricsEl.innerHTML = "metrics.cpu 1%";
  hiding.pane.metricsEl.hidden = false;
  hiding.helpers.applyPaneHeaderMetricsVisibility();
  if (!hiding.pane.metricsEl.hidden) throw new Error("turning the setting off must hide the chip");

  // A slow collector must not stack up: a tick landing while one is in flight
  // is dropped rather than spawning a second sample.
  const slow = createFixture();
  let release;
  slow.context.invoke = (cmd, args) => {
    slow.calls.push(args);
    return new Promise((resolve) => { release = () => resolve(SAMPLE); });
  };
  const first = slow.helpers.refreshPaneHeaderMetrics();
  await slow.helpers.refreshPaneHeaderMetrics();
  if (slow.calls.length !== 1) throw new Error("an overlapping tick started a second sample");
  release();
  await first;
  const second = slow.helpers.refreshPaneHeaderMetrics();
  if (slow.calls.length !== 2) throw new Error("the guard was not released after the sample settled");
  release();
  await second;

  console.log("pane-header-metrics: ok");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
