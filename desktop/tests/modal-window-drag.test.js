// Regression checks for keeping the native window movable while a full-screen
// modal overlay is open.

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../frontend/styles.css"), "utf8");

if (!source.includes('document.querySelectorAll(".overlay")')) {
  throw new Error("modal overlays should receive their own window drag region");
}
if (!source.includes('dragRegion.className = "overlay-window-drag-region"')) {
  throw new Error("modal drag regions should use the shared drag-region class");
}
if (!source.includes("bindDragOnBar(dragRegion)")) {
  throw new Error("modal drag regions should start native window dragging");
}
if (source.includes('dragRegion.setAttribute("data-tauri-drag-region"')) {
  throw new Error("modal drag regions must not trigger native and manual dragging at the same time");
}
if (!styles.includes(".overlay-window-drag-region")) {
  throw new Error("modal drag regions should reserve a visible hit area at the top");
}
if (!/\.overlay\s*\{[\s\S]*?padding:\s*44px 12px 12px;/.test(styles)) {
  throw new Error("modal content should leave the top drag strip unobstructed");
}
if (!/#file-editor-content\s*\{[\s\S]*?flex:\s*1 1 auto;/.test(styles)) {
  throw new Error("the file editor should shrink before its action buttons leave the viewport");
}

console.log("modal-window-drag.test.js: passed");
