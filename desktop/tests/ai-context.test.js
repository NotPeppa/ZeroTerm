// Regression tests for token-budgeted AI conversation assembly.

const { estimateTextTokens, buildAiContextMessages } = require("../frontend/ai-context.js");

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

const shortConversation = Array.from({ length: 14 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: `message-${index}`,
}));
const shortResult = buildAiContextMessages(shortConversation);
check(!shortResult.compacted, "short conversations should not be compacted");
check(shortResult.messages.length === 14, "more than the old ten-message limit should be retained");
check(shortResult.messages[0].content === "message-0", "the earliest short-session message should reach the model");

const longConversation = [
  { role: "user", content: "关键约束：生产数据库绝对不能重启。" },
  ...Array.from({ length: 30 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}-` + "较长的上下文内容。".repeat(100),
  })),
  { role: "user", content: "请根据刚才的约束给出最终方案。" },
];
const longResult = buildAiContextMessages(longConversation, { maxTokens: 2_400, summaryTokens: 700 });
check(longResult.compacted, "long conversations should be compacted");
check(longResult.omittedCount > 0, "compaction should report older messages");
check(longResult.messages[0].role === "user", "older history should remain below system-message authority");
check(longResult.messages[0].content.includes("生产数据库绝对不能重启"), "the original constraint should survive compaction");
check(longResult.messages.at(-1).content.includes("最终方案"), "the latest user request should remain verbatim");
check(longResult.estimatedTokens <= 2_400, "assembled history should respect its token budget");

const commandResult = buildAiContextMessages([{
  role: "assistant",
  content: "请执行检查。",
  commandResults: [{ command: "systemctl status api", output: "active (running)" }],
}]);
check(
  commandResult.messages[0].content.includes("systemctl status api")
    && commandResult.messages[0].content.includes("active (running)"),
  "executed commands and their output should reach later turns",
);
check(estimateTextTokens("中文上下文") >= 4, "CJK token estimates should not be unrealistically small");

const oversizedLatest = buildAiContextMessages([
  { role: "user", content: "超长输入".repeat(10_000) },
], { maxTokens: 1_000, summaryTokens: 400 });
check(oversizedLatest.compacted, "a single oversized latest message should report compaction");
check(oversizedLatest.estimatedTokens <= 1_000, "an oversized latest message should stay within budget");

console.log(`\nai-context.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
