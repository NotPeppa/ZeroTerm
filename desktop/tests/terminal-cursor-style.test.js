// The cursor style setting feeds xterm's `cursorStyle`, which throws on an
// unknown value — so a stale or hand-edited localStorage entry must fall back.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function getTerminalCursorStyle");
const end = source.indexOf("\nfunction applyTerminalThemeToAllPanes", start);
if (start < 0 || end < 0) throw new Error("cursor style helper was not found");

function read(saved) {
  const context = {
    SETTINGS_KEY_TERMINAL_CURSOR_STYLE: "cursor.style",
    TERMINAL_CURSOR_STYLES: ["block", "bar", "underline"],
    localStorage: { getItem: () => saved },
  };
  return vm.runInNewContext(`${source.slice(start, end)}; getTerminalCursorStyle()`, context);
}

for (const [saved, expected] of [
  [null, "block"],
  ["block", "block"],
  ["bar", "bar"],
  ["underline", "underline"],
  ["underscore", "block"],
  ["", "block"],
  ["BLOCK", "block"],
]) {
  const got = read(saved);
  if (got !== expected) throw new Error(`saved ${JSON.stringify(saved)} gave ${got}, expected ${expected}`);
}

console.log("terminal-cursor-style: ok");
