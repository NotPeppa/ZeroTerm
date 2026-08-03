// Regression checks for transient AI failure recovery.

const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

check(
  source.includes("const AI_AUTO_RETRY_LIMIT = 2")
    && source.includes("const AI_AUTO_RETRY_DELAYS_MS = [900, 1800]"),
  "transient failures should retry twice with increasing delays",
);
check(
  source.includes('scheduleAiAutoRetry(state, requestId, "AI 响应超时")')
    && source.includes('scheduleAiAutoRetry(s, payload.requestId, "AI 响应超时")'),
  "both initial and in-progress stream timeouts should auto-retry",
);
check(
  source.includes("scheduleAiAutoRetry(state, payload.requestId, payload.error)"),
  "retryable stream errors should auto-retry",
);
check(
  source.includes('invoke("cancel_ai_chat_stream", { requestId }).catch(() => {})'),
  "a timed-out stream should be canceled before its replacement starts",
);
check(
  source.includes('if (!text || text === "canceled") return false;'),
  "a user-canceled request must never auto-retry",
);
check(
  source.includes("AI 响应超时，自动重试仍未成功。")
    && source.includes("attachAiRetryButton(node, messages, pendingText)"),
  "manual retry should remain after automatic retries are exhausted",
);

console.log(`\nai-auto-retry.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
