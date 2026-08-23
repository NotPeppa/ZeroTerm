// Regression checks for restoring a saved background after an app update
// resets WebView localStorage but leaves the image file intact.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function getAppBgOpacity");
const end = source.indexOf("/// Reflect the current background state", start);

if (start < 0 || end < 0) {
  throw new Error("background image helpers were not found");
}

function createFixture(savedEnabled, image, diskSettings = null) {
  const values = new Map();
  const calls = [];
  if (savedEnabled !== undefined) {
    values.set("background.enabled", savedEnabled);
  }

  const layer = { style: {} };
  const classes = new Set();
  const context = {
    SETTINGS_KEY_APP_BG_OPACITY: "background.opacity",
    SETTINGS_KEY_APP_BG_BLUR: "background.blur",
    SETTINGS_KEY_APP_BG_ENABLED: "background.enabled",
    appBackgroundDataUrl: null,
    localStorage: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    document: {
      getElementById: () => layer,
      body: {
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
        },
      },
    },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "get_background_image") return image;
      if (command === "get_background_settings") return diskSettings;
      if (command === "save_background_settings") return args.input;
      throw new Error(`unexpected command: ${command}`);
    },
    console,
  };

  const helpers = vm.runInNewContext(
    `${source.slice(start, end)}; ({ initAppBackground })`,
    context,
  );
  return { helpers, values, layer, classes, calls };
}

async function run() {
  const migrated = createFixture(undefined, "data:image/png;base64,abc");
  await migrated.helpers.initAppBackground();
  if (migrated.values.get("background.enabled") !== "true") {
    throw new Error("a saved image should restore a missing enabled state");
  }
  if (!migrated.classes.has("has-app-bg") || migrated.layer.style.opacity !== "0.4") {
    throw new Error("a restored background should be applied immediately");
  }
  const migrationSave = migrated.calls.find((call) => call.command === "save_background_settings");
  if (migrationSave?.args?.input?.opacity !== 40 || migrationSave?.args?.input?.blur !== 0) {
    throw new Error("existing local settings should migrate to the durable settings file");
  }

  const restored = createFixture("true", "data:image/png;base64,abc", { opacity: 75, blur: 8 });
  await restored.helpers.initAppBackground();
  if (restored.layer.style.opacity !== "0.75" || restored.layer.style.filter !== "blur(8px)") {
    throw new Error("durable opacity and blur settings should be restored before applying");
  }

  const disabled = createFixture("false", "data:image/png;base64,abc", { opacity: 60, blur: 4 });
  await disabled.helpers.initAppBackground();
  if (disabled.values.get("background.enabled") !== "false" || disabled.classes.has("has-app-bg")) {
    throw new Error("an explicit disabled state must be preserved");
  }

  const empty = createFixture(undefined, null);
  await empty.helpers.initAppBackground();
  if (empty.values.has("background.enabled") || empty.classes.has("has-app-bg")) {
    throw new Error("an absent image must not create an enabled state");
  }

  console.log("background-image.test.js: passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
