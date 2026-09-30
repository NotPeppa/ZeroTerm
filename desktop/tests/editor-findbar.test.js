// Regression checks for the file editor's floating find/replace bar and for
// keeping global hotkeys from firing behind a modal dialog.

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const markup = fs.readFileSync(path.join(__dirname, "../frontend/index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../frontend/styles.css"), "utf8");

if (!/function modalOverlayOpen\(\)[\s\S]*?\.overlay:not\(\[hidden\]\)/.test(source)) {
  throw new Error("an open modal should be detectable from the global hotkey dispatcher");
}
if (!/function handleKeybindingShortcut\(ev\)[\s\S]*?if \(modalOverlayOpen\(\)\) return;/.test(source)) {
  throw new Error("configurable hotkeys must not fire while a modal dialog is open");
}
if (!/function handleGlobalTerminalFindNav\(ev\)[\s\S]*?modalOverlayOpen\(\)/.test(source)) {
  throw new Error("terminal find navigation must not fire while a modal dialog is open");
}
if (!/name: "openEditorFind"[\s\S]*?bindKey: \{ win: "Ctrl-F"/.test(source)) {
  throw new Error("Ace binds Ctrl-F to its unbundled searchbox unless we override it");
}

for (const id of ["file-editor-find", "file-editor-replace", "file-editor-replace-all"]) {
  const hits = markup.split(`id="${id}"`).length - 1;
  if (hits !== 1) throw new Error(`#${id} should exist exactly once, found ${hits}`);
}
if (markup.includes("file-editor-find-inline")) {
  throw new Error("the duplicate inline find inputs should be gone");
}
if (!/<div class="file-editor-body">[\s\S]*?class="file-editor-findbar"/.test(markup)) {
  throw new Error("the findbar should be anchored inside the editor body");
}
if (!/\.file-editor-findbar\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:/.test(styles)) {
  throw new Error("the findbar should float at the top-right of the editor");
}

// The replace row starts collapsed behind the chevron, VS Code style.
if (!/id="file-editor-findbar-replace-row"[^>]*\shidden/.test(markup)) {
  throw new Error("the replace row should start collapsed");
}
if (!/function setEditorReplaceVisible[\s\S]*?aria-expanded/.test(source)) {
  throw new Error("the chevron should report its expanded state");
}
// The three inline toggles must actually reach Ace's search options.
if (!/wholeWord: fileEditorWholeWordInput\.checked/.test(source)
  || !/regExp: fileEditorRegexInput\.checked/.test(source)) {
  throw new Error("the whole-word and regex toggles should drive the search");
}
if (!/\.file-editor-findbar-toggle input:checked \+ span/.test(styles)) {
  throw new Error("an enabled toggle needs a visible active state");
}
// A half-typed regex throws inside Ace; both search paths must survive it.
for (const fn of ["updateEditorFindCount", "function searchInEditor"]) {
  const body = source.slice(source.indexOf(fn));
  if (!/catch/.test(body.slice(0, 700))) {
    throw new Error(`${fn} should tolerate an invalid regex`);
  }
}

console.log("editor-findbar.test.js: passed");
