// Regression checks for CRLF / LF line-ending handling in the built-in file editor.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "frontend/main.js"), "utf8");
const markup = fs.readFileSync(path.join(root, "frontend/index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "frontend/styles.css"), "utf8");
const gitattributes = fs.readFileSync(path.join(root, "../.gitattributes"), "utf8");

// 1. Repository .gitattributes guards scripts and defaults text files to LF.
assert.match(gitattributes, /^\*\s+text=auto\s+eol=lf$/m);
assert.match(gitattributes, /^\*\.sh\s+text\s+eol=lf$/m);

// 2. Editor UI wires the EOL badge/toggle button and warning styles.
assert.match(markup, /<div class="file-editor-meta">[\s\S]*?id="file-editor-eol"/);
assert.match(styles, /\.file-editor-eol-btn\.is-warning\s*\{/);
assert.match(source, /fileEditorEolButton\?\.addEventListener\("click",\s*\(\)\s*=>\s*toggleFileEditorEol\(\)\)/);
assert.match(source, /fileEditorAce\.session\.setNewLineMode\(/);

// 3. Extract and exercise the pure EOL helpers in an isolated VM context.
const basenameStart = source.indexOf("function basename(path)");
const basenameEnd = source.indexOf("\nfunction uniqueId", basenameStart);
const eolStart = source.indexOf("const POSIX_LINE_ENDING_BASENAMES");
const eolEnd = source.indexOf("\nfunction ensureFileEditorAce()", eolStart);

assert.ok(basenameStart >= 0 && basenameEnd > basenameStart, "basename helper not found");
assert.ok(eolStart >= 0 && eolEnd > eolStart, "EOL helpers not found");

const helpers = vm.runInNewContext(
  `${source.slice(basenameStart, basenameEnd)}\n${source.slice(eolStart, eolEnd)}; ({
    isPosixLineEndingPreferred,
    detectEditorEolMode,
    shouldWarnEditorCrlf,
    fileEditorEolLabel,
    normalizeEditorContentForEol,
  })`,
  { isWindowsPlatform: true },
);

// Empty or single-line remote files edited from Windows must lock to LF ("unix")
// so pasting CRLF text from the Windows clipboard never flips the file to CRLF.
assert.equal(
  helpers.detectEditorEolMode("", { isRemote: true, isWindowsHost: true, path: "/root/deploy.sh" }),
  "unix",
);
assert.equal(
  helpers.detectEditorEolMode("echo hello", { isRemote: true, isWindowsHost: true, path: "/etc/app.txt" }),
  "unix",
);

// Local POSIX scripts / configs on Windows also default to LF ("unix").
assert.equal(
  helpers.detectEditorEolMode("", { isRemote: false, isWindowsHost: true, path: "C:\\repo\\scripts\\run.sh" }),
  "unix",
);
assert.equal(
  helpers.detectEditorEolMode("#!/usr/bin/env bash", { isRemote: false, isWindowsHost: true, path: "C:\\repo\\hook" }),
  "unix",
);
assert.equal(
  helpers.detectEditorEolMode("", { isRemote: false, isWindowsHost: true, path: "C:\\repo\\Dockerfile" }),
  "unix",
);

// Plain local Windows files with no newlines default to CRLF ("windows").
assert.equal(
  helpers.detectEditorEolMode("", { isRemote: false, isWindowsHost: true, path: "C:\\Users\\demo\\notes.txt" }),
  "windows",
);

// Existing file line endings are detected accurately.
assert.equal(
  helpers.detectEditorEolMode("#!/bin/sh\necho ok\n", { isRemote: true, isWindowsHost: true, path: "/opt/a.sh" }),
  "unix",
);
assert.equal(
  helpers.detectEditorEolMode("#!/bin/sh\r\necho bad\r\n", { isRemote: true, isWindowsHost: true, path: "/opt/a.sh" }),
  "windows",
);
// Mixed line endings prefer LF unless CRLF strictly dominates.
assert.equal(
  helpers.detectEditorEolMode("a\r\nb\nc\n", { isRemote: true, isWindowsHost: true, path: "/opt/a.sh" }),
  "unix",
);

// CRLF warning triggers on remote files and local POSIX scripts, not local Windows text/batch files.
assert.equal(
  helpers.shouldWarnEditorCrlf("windows", { isRemote: true, path: "/opt/run.sh", content: "echo 1\r\n" }),
  true,
);
assert.equal(
  helpers.shouldWarnEditorCrlf("windows", { isRemote: false, path: "C:\\repo\\run.sh", content: "echo 1\r\n" }),
  true,
);
assert.equal(
  helpers.shouldWarnEditorCrlf("windows", { isRemote: false, path: "C:\\repo\\build.bat", content: "@echo off\r\n" }),
  false,
);
assert.equal(
  helpers.shouldWarnEditorCrlf("unix", { isRemote: true, path: "/opt/run.sh", content: "echo 1\n" }),
  false,
);

// Saving normalizes pasted CRLF/CR into the active EOL mode without stray \r bytes.
assert.equal(
  helpers.normalizeEditorContentForEol("#!/bin/bash\r\nset -e\r\necho ok\r", "unix"),
  "#!/bin/bash\nset -e\necho ok\n",
);
assert.equal(
  helpers.normalizeEditorContentForEol("line1\nline2\r\nline3", "windows"),
  "line1\r\nline2\r\nline3",
);
assert.equal(helpers.fileEditorEolLabel("unix"), "LF");
assert.equal(helpers.fileEditorEolLabel("windows"), "CRLF");

console.log("editor-eol.test.js: passed");
