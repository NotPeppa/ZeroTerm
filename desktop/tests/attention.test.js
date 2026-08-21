// Regression tests for terminal wait-prompt detection.
//
// Run with: node desktop/tests/attention.test.js

const {
  cancelTerminalAttentionScan,
  scheduleTerminalAttentionScan,
  terminalAttentionFingerprint,
  terminalLiveVisibleText,
  terminalTextNeedsAttention,
} = require("../frontend/attention.js");

let passed = 0;
let failed = 0;

function check(input, expected, label) {
  const actual = terminalTextNeedsAttention(input);
  checkValue(actual, expected, label);
}

function checkValue(actual, expected, label) {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${label}: expected ${expected}, got ${actual}`);
  }
}

// Agent CLI permission and selection prompts.
check("Would you like to run the following command?\n❯ 1. Yes, proceed\n  2. No", true, "Codex approval");
check(
  "Would you like to run the following command?\nEnvironment: local\nReason: Need to inspect the running container.\n$ nsenter -t 31529 -m -p -- ps -ef\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again (p)\n  3. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel",
  true,
  "Codex multi-line approval with esc-to-cancel footer"
);
check("Permission required\n❯ Allow once\n  Deny", true, "unnumbered approval cursor");
check("Choose an action\n1. Allow once\n2. Always allow\n3. No", true, "numbered permission menu");
check("Delete these files?", true, "action question");

// Common terminal input prompts.
check("[sudo] password for alice: ", true, "sudo password");
check("Enter passphrase for key '/home/alice/.ssh/id_ed25519': ", true, "SSH passphrase");
check("? Select a profile (Use arrow keys)", true, "arrow-key selection");
check("Build paused — press any key to continue", true, "press any key");
check("Waiting for user approval", true, "explicit wait state");
check("Approval required", true, "approval-required notification");
check("Approval required >", true, "approval-required text is not mistaken for a shell prompt");

// Localized prompts.
check("是否继续执行？\n1. 是\n2. 否", true, "Chinese confirmation");
check("需要授权\n❯ 允许一次\n  拒绝", true, "Chinese approval cursor");
check("请选择一个操作\n❯ 允许一次\n  拒绝", true, "Chinese selection prompt");
check("请输入验证码：", true, "Chinese verification code");
check("按回车键继续", true, "Chinese enter prompt");

// Normal output must not create noisy alerts.
check("$ ", false, "shell prompt");
check("1. execution completed\n2. artifacts uploaded", false, "numbered log output");
check("password updated successfully", false, "password status log");
check(
  '"pleaseSelectDataStatus": "请选择数据状态",\n+5 lines (ctrl+t to view transcript)\nWorking (29s • esc to interrupt)\nExplain this codebase',
  false,
  "Codex working screen containing prompt-like transcript text"
);
check(
  '"pleaseSelectDataStatus": "请选择数据状态",',
  false,
  "Chinese translation value is not a selection prompt"
);
check(
  '请选择多场景 => (none exact)\n请选择 => common.tips.pleaseSelect = "请选择"',
  false,
  "search-result mappings are not selection prompts"
);
check(
  "Would you like to run the following command?\n❯ Yes, proceed\ncommand completed\nalice@host:~$",
  false,
  "resolved approval above a ready shell prompt"
);
check(
  "是否继续执行？\n1. 是\n2. 否\n操作已完成\nPS C:\\Users\\alice>",
  false,
  "resolved Chinese approval above a PowerShell prompt"
);
check(
  "Are you sure?\nYes / No\nfinished\nthek@Mac ZeroTerm %",
  false,
  "resolved approval above a spaced zsh prompt"
);
check(
  "目标 C:\\Users\\lfl\\.dsh\\skills\\browser 已存在，覆盖重建联接？(y/N):\nPS D:\\code> npm install -g @deepseek-ai/dsh@latest\n",
  false,
  "resolved y/n prompt above a running PowerShell command"
);
check(
  "PS D:\\code> dsh web\n目标 C:\\Users\\lfl\\.dsh\\skills\\browser 已存在，覆盖重建联接？(y/N):",
  true,
  "new y/n prompt below a PowerShell command"
);
check(
  "Continue deployment? (y/N):\nthek@Mac ZeroTerm % npm install\ninstalling dependencies",
  false,
  "resolved y/n prompt above a running zsh command"
);
check("Build completed\u0007", false, "completion bell text");
check("notify;Build;completed successfully", false, "generic OSC notification");
check("https://example.test/search?q=continue", false, "URL query");
check("", false, "empty screen");

const acknowledgedPrompt = terminalAttentionFingerprint(
  "Continue deployment? (y/N):\nDownloading 10%"
);
const changedScreenPrompt = terminalAttentionFingerprint(
  "Continue deployment? (y/N):\nDownloading 80%"
);
checkValue(
  changedScreenPrompt === acknowledgedPrompt,
  true,
  "prompt fingerprint survives unrelated progress output changes"
);
checkValue(
  terminalAttentionFingerprint("Delete files? (y/N):") !==
    terminalAttentionFingerprint("Overwrite configuration? (y/N):"),
  true,
  "different questions with the same y/n choice have distinct fingerprints"
);

// A quiet-period debounce alone can be postponed forever by steady output.
// Once attention is active, the max-delay timer must survive those resets and
// force a scan that can clear the stale badge.
function fakeTimers() {
  let nextId = 1;
  let now = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = end;
    },
  };
}

const clock = fakeTimers();
const scanState = { attnQuietTimer: null, attnMaxTimer: null };
let scanCount = 0;
const scheduleSteadyOutputScan = () => scheduleTerminalAttentionScan(
  scanState,
  () => { scanCount += 1; },
  {
    quietDelay: 450,
    maxDelay: 1000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  }
);
scheduleSteadyOutputScan();
for (let elapsed = 0; elapsed < 900; elapsed += 100) {
  clock.advance(100);
  scheduleSteadyOutputScan();
}
clock.advance(100);
checkValue(scanCount, 1, "continuous output cannot postpone stale-attention scan");
cancelTerminalAttentionScan(scanState, { clearTimer: clock.clearTimer });

const quietClock = fakeTimers();
const quietState = { attnQuietTimer: null, attnMaxTimer: null };
let quietScanCount = 0;
scheduleTerminalAttentionScan(
  quietState,
  () => { quietScanCount += 1; },
  {
    quietDelay: 450,
    maxDelay: null,
    setTimer: quietClock.setTimer,
    clearTimer: quietClock.clearTimer,
  }
);
quietClock.advance(449);
checkValue(quietScanCount, 0, "new attention scan still waits for quiet period");
quietClock.advance(1);
checkValue(quietScanCount, 1, "new attention scan runs after quiet period");

function fakeBuffer(lines, { baseY, viewportY }) {
  return {
    baseY,
    viewportY,
    length: lines.length,
    getLine(index) {
      return {
        translateToString() {
          return lines[index] || "";
        },
      };
    },
  };
}

const historyBuffer = fakeBuffer(
  ["Would you like to run this?", "❯ Yes", "old output", "$ "],
  { baseY: 2, viewportY: 0 }
);
checkValue(
  terminalLiveVisibleText(historyBuffer, 2) === null,
  true,
  "scrollback history is never scanned"
);

const liveBuffer = fakeBuffer(
  ["old history question?", "old output", "Approval required", "❯ Allow once"],
  { baseY: 2, viewportY: 2 }
);
checkValue(
  terminalLiveVisibleText(liveBuffer, 2) === "Approval required\n❯ Allow once",
  true,
  "only the live visible viewport is returned"
);

console.log(`\nattention.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
