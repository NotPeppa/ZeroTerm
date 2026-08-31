// Regression checks for terminal right-sidebar feature visibility settings.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function getTerminalSidebarFeatures");
const end = source.indexOf("\nfunction setTerminalSidePanel", start);

if (start < 0 || end < 0) {
  throw new Error("terminal sidebar feature helpers were not found");
}

const featureIds = ["snippets", "ai", "metrics", "services", "ports", "docker", "sftp", "theme"];

function createFixture(savedValue = null, activePanel = null) {
  const values = new Map();
  if (savedValue !== null) values.set("sidebar.features", savedValue);

  const inputs = featureIds.map((featureId) => ({
    dataset: { terminalSidebarFeature: featureId },
    checked: false,
  }));
  const toggles = Object.fromEntries(featureIds.map((featureId) => [featureId, { hidden: false }]));
  const closedPanels = [];
  const refits = [];
  const context = {
    SETTINGS_KEY_TERMINAL_SIDEBAR_FEATURES: "sidebar.features",
    TERMINAL_SIDEBAR_FEATURE_IDS: featureIds,
    TERMINAL_SIDEBAR_FEATURE_TOGGLES: toggles,
    settingsTerminalSidebarFeatures: {
      querySelectorAll: () => inputs,
    },
    terminalSidePanelByPane: new Map([
      ["pane-1", activePanel],
      ["pane-2", "ai"],
    ]),
    terminalSidebarRail: { hidden: true },
    terminalActiveSidePanel: activePanel,
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    getActiveTab: () => ({ id: "tab-1" }),
    setTerminalSidePanel: (panel) => {
      closedPanels.push(panel);
      context.terminalActiveSidePanel = panel;
    },
    refitActiveTerminalPanes: (options) => refits.push(options),
  };

  const helpers = vm.runInNewContext(
    `${source.slice(start, end)}; ({ getTerminalSidebarFeatures, setTerminalSidebarFeatureEnabled, applyTerminalSidebarFeatureSettings })`,
    context,
  );
  return { helpers, values, inputs, toggles, closedPanels, refits, context };
}

function assertAllEnabled(features, message) {
  for (const featureId of featureIds) {
    if (features[featureId] !== true) throw new Error(`${message}: ${featureId} was not enabled`);
  }
}

function run() {
  const defaults = createFixture();
  assertAllEnabled(defaults.helpers.getTerminalSidebarFeatures(), "missing configuration must default to all enabled");
  defaults.helpers.applyTerminalSidebarFeatureSettings();
  if (defaults.context.terminalSidebarRail.hidden || defaults.inputs.some((input) => !input.checked)) {
    throw new Error("default settings were not reflected in the rail and settings controls");
  }

  const corrupt = createFixture("{not-json");
  assertAllEnabled(corrupt.helpers.getTerminalSidebarFeatures(), "corrupt configuration must default to all enabled");

  const partial = createFixture(JSON.stringify({ metrics: false }), "metrics");
  partial.helpers.applyTerminalSidebarFeatureSettings();
  if (!partial.toggles.metrics.hidden || partial.toggles.ai.hidden) {
    throw new Error("a disabled feature should hide only its own sidebar button");
  }
  if (partial.context.terminalSidePanelByPane.get("pane-1") !== null || partial.closedPanels.at(-1) !== null) {
    throw new Error("disabling the active feature should clear saved pane state and close the panel");
  }
  const metricsInput = partial.inputs.find((input) => input.dataset.terminalSidebarFeature === "metrics");
  if (metricsInput.checked) throw new Error("the settings control did not reflect the disabled feature");

  const saved = createFixture();
  saved.helpers.setTerminalSidebarFeatureEnabled("docker", false);
  const persisted = JSON.parse(saved.values.get("sidebar.features"));
  if (persisted.docker !== false || featureIds.some((id) => id !== "docker" && persisted[id] !== true)) {
    throw new Error("changing one feature did not persist a complete boolean map");
  }

  saved.values.set("sidebar.features", JSON.stringify(Object.fromEntries(featureIds.map((id) => [id, false]))));
  saved.helpers.applyTerminalSidebarFeatureSettings();
  if (!saved.context.terminalSidebarRail.hidden || featureIds.some((id) => !saved.toggles[id].hidden)) {
    throw new Error("disabling every feature should hide the entire rail and every button");
  }

  const beforeUnknown = saved.values.get("sidebar.features");
  saved.helpers.setTerminalSidebarFeatureEnabled("unknown", true);
  if (saved.values.get("sidebar.features") !== beforeUnknown) {
    throw new Error("unknown feature IDs must not alter persisted settings");
  }

  console.log("terminal-sidebar-features.test.js: passed");
}

run();
