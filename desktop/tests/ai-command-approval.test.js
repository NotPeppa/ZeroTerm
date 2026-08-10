// Regression test: clicking an AI command's “批准执行” control is the
// authorization. executeAiCommand must not open a second confirmation dialog.
//
// Run with: node desktop/tests/ai-command-approval.test.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "../frontend/main.js"),
  "utf8",
);
const html = fs.readFileSync(
  path.join(__dirname, "../frontend/index.html"),
  "utf8",
);
const css = fs.readFileSync(
  path.join(__dirname, "../frontend/styles.css"),
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
  source.includes("run.textContent = restoredResult")
    && source.includes('? "已执行"')
    && source.includes('`批准 ${index + 1}` : "批准执行"'),
  "code blocks should expose an explicit approval control",
);
check(
  source.includes('code.title = "点击复制"')
    && source.includes('code.addEventListener("click", copy)')
    && source.includes("await navigator.clipboard.writeText(text)"),
  "clicking inline code should copy it to the clipboard",
);
check(
  !source.includes("requestAiCommandApproval"),
  "inline code must not retain a click-to-execute path",
);
check(
  source.includes('output: execution?.output || ""')
    && source.includes('output: typeof result.output === "string" ? result.output : ""'),
  "approved command output should be stored in the conversation",
);
check(
  source.includes('invoke("authorize_ai_terminal_command"')
    && source.includes("policy?.autoAllowed"),
  "automatic terminal control must pass through the backend command policy",
);
check(
  source.includes('runButton.dataset.manualApprovalRequired === "true"')
    && source.includes('run.textContent = restoredResult')
    && source.includes('run.disabled = Boolean(restoredResult)')
    && source.includes('function aiCodeBlockRequiresManualApproval(block)')
    && source.includes("requiresManualApproval || requiresRiskApproval"),
  "AI -user command fences should wait for a clickable manual approval",
);
check(
  source.includes("bash-user, powershell-user, or cmd-user")
    && source.includes("show an approval button"),
  "the AI command protocol should describe explicit manual approval",
);
check(
  source.includes('String(paneKey).startsWith("session:")'),
  "terminal control should remain scoped to the active terminal session",
);
check(
  source.includes('state.mode = "manual";')
    && source.includes('data: [3]'),
  "stopping terminal control should restore manual mode and interrupt an active command",
);
const composeStart = html.indexOf('<form class="ai-compose" id="ai-compose-form">');
const composeEnd = html.indexOf("</form>", composeStart);
const composeHtml = composeStart >= 0 && composeEnd > composeStart
  ? html.slice(composeStart, composeEnd)
  : "";
check(
  composeHtml.includes('select id="ai-context-toggle"')
    && composeHtml.includes('select id="ai-terminal-control-mode"'),
  "terminal context and terminal permission should both be selected inside the compose box",
);
check(
  !html.slice(0, composeStart).includes('class="ai-terminal-control"'),
  "terminal permission should not remain as a separate bar above the compose box",
);
check(
  source.includes('messageNode.classList.toggle("ai-risk-approval-required", requiresManualApproval || requiresRiskApproval || requiresUserInput)')
    && css.includes(".ai-message-assistant.ai-risk-approval-required .ai-message-body"),
  "manual approvals, risky commands, and unresolved placeholders should mark the whole AI reply with a risk border",
);
check(
  source.includes('messageNode?.classList.remove("ai-risk-approval-required")'),
  "executing the manually approved command should clear the risk border",
);
const agentStart = source.indexOf("async function maybeRunAiTerminalAgent");
const agentEnd = source.indexOf("\nfunction isExecutableCodeBlock", agentStart);
const agentSource = agentStart >= 0 && agentEnd > agentStart
  ? source.slice(agentStart, agentEnd)
  : "";
check(
  agentSource.includes('policy?.classification === "user_input_required"')
    && agentSource.includes('runButton.textContent = "请先替换占位内容"')
    && agentSource.includes("runButton.disabled = true"),
  "unresolved placeholders should be disabled until the user supplies real values",
);
check(
  agentSource.indexOf('invoke("authorize_ai_terminal_command"')
    < agentSource.indexOf("if (!automaticControlEnabled) return"),
  "manual mode should still classify commands before skipping automatic execution",
);
check(
  source.includes('if (mode !== "manual") processLatestAiMessageForTerminalControl(paneKey)')
    && source.includes("function processLatestAiMessageForTerminalControl"),
  "enabling automatic control should immediately reprocess the visible AI reply",
);
check(
  !source.includes("AI_READ_ONLY_MAX_STEPS")
    && !agentSource.includes("state.steps")
    && !source.includes('const progressMax = "∞"'),
  "automatic modes should neither impose nor display a step count",
);

const heredocStart = source.indexOf("function looksLikeHeredocStart(line)");
const heredocEnd = source.indexOf("\nfunction shouldApproveAiCommandBlockAsScript", heredocStart);
const heredocHelper = heredocStart >= 0 && heredocEnd > heredocStart
  ? source.slice(heredocStart, heredocEnd)
  : "";
const looksLikeHeredocStart = vm.runInNewContext(`${heredocHelper}; looksLikeHeredocStart`);
check(
  looksLikeHeredocStart("cat <<'EOF' > /etc/network/interfaces")
    && looksLikeHeredocStart("cat <<-EOF | tee /tmp/output")
    && !looksLikeHeredocStart("value=<<<text"),
  "heredocs followed by redirection or a pipe should remain one command",
);
const splitStart = source.indexOf("function normalizeAiCommandBlock(command)");
const splitEnd = source.indexOf("\nfunction getAiContinuedCommandCount", splitStart);
const approvalEnd = source.indexOf("\nfunction getActiveTerminalSnapshot", heredocStart);
const splitHelpers = splitStart >= 0 && splitEnd > splitStart && approvalEnd > heredocStart
  ? `${source.slice(splitStart, splitEnd)}\n${source.slice(heredocStart, approvalEnd)}`
  : "";
const splitAiCommandBlockForApproval = vm.runInNewContext(
  `${splitHelpers}\nfunction looksLikeRunnableCommandLine() { return true; }; splitAiCommandBlockForApproval`,
);
const redirectedHeredoc = [
  "cat <<'EOF' > /etc/network/interfaces",
  "auto he-ipv6",
  "iface he-ipv6 inet6 v4tunnel",
  "  address YOUR_IPV6",
  "EOF",
].join("\n");
check(
  splitAiCommandBlockForApproval(redirectedHeredoc).length === 1,
  "a redirected heredoc should render exactly one approval control",
);
const executableStart = source.indexOf("function isExecutableCodeBlock");
const executableEnd = source.indexOf("\nfunction aiCodeBlockRequiresManualApproval", executableStart);
const outputStart = source.indexOf("function looksLikeTerminalOutput");
const outputEnd = source.indexOf("\nfunction looksLikeRunnableCommandLine", outputStart);
const executableHelpers = executableStart >= 0 && executableEnd > executableStart
  && outputStart >= 0 && outputEnd > outputStart
  ? `${source.slice(executableStart, executableEnd)}\n${source.slice(outputStart, outputEnd)}`
  : "";
const isExecutableCodeBlock = vm.runInNewContext(
  `${executableHelpers}; isExecutableCodeBlock`,
);
const dantedHeredoc = [
  "cat > /etc/danted.conf <<'EOF'",
  "internal: eth0 port = 1080",
  "external: eth0",
  "EOF",
  "systemctl restart danted",
].join("\n");
check(
  isExecutableCodeBlock({ dataset: { lang: "bash-user" } }, dantedHeredoc),
  "an explicit bash-user heredoc should keep its approval control when config lines contain colons",
);
check(
  css.includes(".ai-code-tools {")
    && css.includes("flex-wrap: wrap")
    && css.includes("border-top: 1px solid")
    && !css.slice(css.indexOf(".ai-code-tools {"), css.indexOf(".ai-code-tools button")).includes("position: absolute"),
  "command controls should use a wrapping footer instead of overlaying code",
);

console.log(`\nai-command-approval.test.js: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
