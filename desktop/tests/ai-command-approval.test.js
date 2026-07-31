// Regression test: clicking an AI command's “批准执行” control is the
// authorization. executeAiCommand must not open a second confirmation dialog.
//
// Run with: node desktop/tests/ai-command-approval.test.js

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../frontend/main.js"),
  "utf8",
);

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

const start = source.indexOf("async function executeAiCommand(command)");
const end = source.indexOf("\nfunction wait(ms)", start);
const executeAiCommand = start >= 0 && end > start
  ? source.slice(start, end)
  : "";

check(Boolean(executeAiCommand), "executeAiCommand should exist");
check(
  !executeAiCommand.includes("openConfirmDialog"),
  "approved AI commands must not open a second confirmation dialog",
);
check(
  executeAiCommand.includes("sendTextToPane(pane, command, { submit: true })"),
  "approved AI commands should still be submitted to the active terminal",
);
check(
  source.includes('run.textContent = restoredResult ? "已执行" : (commands.length > 1 ? `批准 ${index + 1}` : "批准执行")'),
  "code blocks should expose an explicit approval control",
);

console.log(`\nai-command-approval.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
