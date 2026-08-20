// Regression test: an AI reply's command must be authorized and execute exactly
// once, and a dangerous command must show its approval notice only once, even though
// stream-done both re-renders the conversation (detaching the streamed node)
// and separately schedules the terminal agent. Duplicate execution happened
// because both triggers held different DOM copies of the same button and the
// authorize IPC await let both pass the entry checks.
//
// Run with: node desktop/tests/ai-duplicate-execution.test.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
const end = source.indexOf("\nfunction isExecutableCodeBlock", start + 1);
const agent = start >= 0 && end > start ? source.slice(start, end) : "";

check(Boolean(agent), "maybeRunAiTerminalAgent should exist");
check(
  agent.includes("!messageNode.isConnected"),
  "agent must refuse detached (stale, re-rendered) message nodes",
);
check(
  source.includes("const aiTerminalAuthorizationInFlight = new WeakSet();")
    && agent.includes("if (aiTerminalAuthorizationInFlight.has(runButton)) return;")
    && agent.includes("aiTerminalAuthorizationInFlight.add(runButton);")
    && agent.includes("aiTerminalAuthorizationInFlight.delete(runButton);"),
  "one live command button must have at most one policy check in flight",
);
check(
  agent.indexOf("aiTerminalAuthorizationInFlight.add(runButton)")
    < agent.indexOf('invoke("authorize_ai_terminal_command"')
    && agent.indexOf('invoke("authorize_ai_terminal_command"')
      < agent.indexOf("aiTerminalAuthorizationInFlight.delete(runButton)"),
  "the authorization lock must cover the asynchronous policy check",
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

async function checkConcurrentApprovalNotice() {
  const paneKey = "session:7";
  const state = {
    mode: "supervised",
    running: false,
    stopRequested: false,
    waitingApproval: false,
    waitingUserInput: false,
  };
  const runButton = {
    disabled: false,
    isConnected: true,
    dataset: { manualApprovalRequired: "false" },
    __ztCommand: "rm -rf ./build",
    __ztExecute: async () => null,
    textContent: "批准执行",
    title: "",
  };
  const messageNode = {
    isConnected: true,
    dataset: {},
    classList: { toggle() {}, remove() {} },
    querySelectorAll: () => [runButton],
    removeAttribute() {},
  };
  let releasePolicy;
  const policyGate = new Promise((resolve) => { releasePolicy = resolve; });
  let policyChecks = 0;
  let approvalToasts = 0;
  const context = {
    aiTerminalAuthorizationInFlight: new WeakSet(),
    getAiPaneKey: () => paneKey,
    getActivePane: () => ({ sessionId: 7 }),
    getAiTerminalControlState: () => state,
    invoke: async () => {
      policyChecks += 1;
      return policyGate;
    },
    syncAiTerminalControlUi() {},
    showToast: () => { approvalToasts += 1; },
    console,
  };
  const maybeRunAiTerminalAgent = vm.runInNewContext(
    `${agent}; maybeRunAiTerminalAgent`,
    context,
  );

  const first = maybeRunAiTerminalAgent(messageNode, paneKey);
  const duplicate = maybeRunAiTerminalAgent(messageNode, paneKey);
  releasePolicy({ classification: "approval_required", autoAllowed: false });
  await Promise.all([first, duplicate]);

  check(
    policyChecks === 1 && approvalToasts === 1 && state.waitingApproval,
    "concurrent triggers must produce one policy check and one dangerous-command notice",
  );
}

checkConcurrentApprovalNotice()
  .catch((error) => {
    failed += 1;
    console.error("  FAIL: concurrent approval behavior test crashed", error);
  })
  .finally(() => {
    console.log(`ai-duplicate-execution.test.js: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  });
