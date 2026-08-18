// Regression test: an AI reply's command must execute exactly once even though
// stream-done both re-renders the conversation (detaching the streamed node)
// and separately schedules the terminal agent. Duplicate execution happened
// because both triggers held different DOM copies of the same button and the
// authorize IPC await let both pass the entry checks.
//
// Run with: node desktop/tests/ai-duplicate-execution.test.js

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

const start = source.indexOf("async function maybeRunAiTerminalAgent(messageNode, paneKey)");
const end = source.indexOf("\nasync function", start + 1);
const agent = start >= 0 && end > start ? source.slice(start, end) : "";

check(Boolean(agent), "maybeRunAiTerminalAgent should exist");
check(
  agent.includes("!messageNode.isConnected"),
  "agent must refuse detached (stale, re-rendered) message nodes",
);
check(
  agent.includes("if (state.running || runButton.disabled || !runButton.isConnected) return;"),
  "agent must re-check running/disabled state after the authorize await",
);
check(
  agent.indexOf("authorize_ai_terminal_command")
    < agent.indexOf("if (state.running || runButton.disabled || !runButton.isConnected) return;"),
  "the re-check must sit after the authorize IPC round-trip",
);
check(
  !source.includes("maybeRunAiTerminalAgent(state.node"),
  "stream/fallback handlers must not target the captured (stale) stream node",
);
check(
  source.match(/maybeRunAiTerminalAgent\(latestAiAssistantMessageNode\(\), state\.paneKey\)/g)?.length === 3,
  "all three stream/fallback completion paths should target the live latest node",
);

console.log(`ai-duplicate-execution.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
