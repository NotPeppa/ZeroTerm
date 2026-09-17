// Regression checks for native clipboard fallback in restricted WebViews.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("async function writeClipboardText");
const end = source.indexOf("\nfunction formatSize", start);
if (start < 0 || end < 0) throw new Error("clipboard helper was not found");

function createHelper({ nativeFails = false, webFails = false } = {}) {
  const calls = [];
  const context = {
    invoke: async (command, args) => {
      calls.push({ route: "native", command, args });
      if (nativeFails) throw new Error("native denied");
    },
    navigator: {
      clipboard: {
        writeText: async (text) => {
          calls.push({ route: "web", text });
          if (webFails) throw new Error("web denied");
        },
      },
    },
  };
  const helper = vm.runInNewContext(
    `${source.slice(start, end)}; writeClipboardText`,
    context,
  );
  return { helper, calls };
}

async function run() {
  const native = createHelper();
  await native.helper("hello");
  if (native.calls.length !== 1 || native.calls[0].command !== "write_clipboard_text") {
    throw new Error("copy did not prefer the native clipboard command");
  }

  const fallback = createHelper({ nativeFails: true });
  await fallback.helper("fallback");
  if (fallback.calls.map((call) => call.route).join(",") !== "native,web") {
    throw new Error("browser clipboard fallback was not used after native failure");
  }

  const directWebWrites = source.match(/navigator\.clipboard\.writeText/g) || [];
  if (directWebWrites.length !== 1) {
    throw new Error("some copy actions still bypass the shared clipboard helper");
  }

  console.log("clipboard.test.js: passed");
}

run();
