// Regression tests for terminal wait-prompt detection.
//
// Run with: node desktop/tests/attention.test.js

const {
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
check("请输入验证码：", true, "Chinese verification code");
check("按回车键继续", true, "Chinese enter prompt");

// Normal output must not create noisy alerts.
check("$ ", false, "shell prompt");
check("1. execution completed\n2. artifacts uploaded", false, "numbered log output");
check("password updated successfully", false, "password status log");
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
check("Build completed\u0007", false, "completion bell text");
check("notify;Build;completed successfully", false, "generic OSC notification");
check("https://example.test/search?q=continue", false, "URL query");
check("", false, "empty screen");

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
