// Terminal wait-prompt detection shared by the desktop UI and its regression
// tests. Keep this file dependency-free: it is loaded as a classic script
// before main.js and can also be required directly by Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ZeroTermAttention = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ACTION_WORDS =
    "(?:yes|no|allow|deny|approve|reject|authorize|continue|cancel|run|execute|proceed|apply|overwrite|delete|retry)";
  const ACTION_WORDS_ZH =
    "(?:是|否|允许(?:一次|本次|始终)?|拒绝|批准|继续|取消|运行|执行|应用|覆盖|删除|重试)";

  // Once a normal shell prompt is back at the bottom, an earlier confirmation
  // in the scrollback has already been resolved. Keep these deliberately
  // conservative: selection cursors such as "❯ Allow once" must not look like
  // a ready shell.
  const READY_PROMPT_PATTERNS = [
    /^[>$#%]\s*$/,
    /^(?:PS\s+)?[A-Za-z]:\\[^>\n]*>\s*$/i,
    /^(?:\([^)]+\)\s*)?[\w.-]+@[\w.-]+(?:[: ][^\n]*)?[#$%>]\s*$/,
    /^(?:\([^)]+\)\s*)?[\w.-]+(?::[^\n]*)?[#$%>]\s*$/,
    /^\[[^\]\n]+\][#$%>]\s*$/,
  ];

  // Agent TUIs keep prior conversation and command output on screen while
  // showing a live status near the bottom. A busy status takes precedence over
  // prompt-looking words in that transcript.
  const BUSY_STATE_PATTERNS = [
    // "esc to cancel" is also commonly shown at the bottom of approval
    // menus (for example alongside "Press enter to confirm"), so it is not
    // sufficient evidence that the CLI is still busy.
    /\besc(?:ape)?\s+to\s+(?:interrupt|stop)\b/i,
    /\bctrl\s*\+?\s*c\s+to\s+(?:interrupt|cancel|stop)\b/i,
    /^\s*[•●◉✳*]?\s*(?:working|thinking|processing|analy[sz]ing|executing)\s*(?:\(|…|\.{3}|$)/i,
    /(?:正在|仍在)(?:工作|思考|处理|分析|执行|运行|生成|搜索)/,
  ];

  const PROMPT_PATTERNS = [
    // Selection cursors used by agent CLIs and common prompt libraries. Some
    // render a numbered item, while others put the cursor directly before the
    // action ("❯ Allow once").
    new RegExp(
      `[❯›▶➤]\\s*(?:\\d{1,2}[.)]\\s*)?(?:${ACTION_WORDS}|${ACTION_WORDS_ZH})(?=\\s|[,，.。:：;；!?！？]|$)`,
      "i"
    ),
    new RegExp(
      `^\\s*(?:[❯›▶➤●○◉]\\s*)?\\d{1,2}[.)]\\s+(?:${ACTION_WORDS}|${ACTION_WORDS_ZH})(?=\\s|[,，.。:：;；!?！？]|$)`,
      "im"
    ),

    // Explicit question headers.
    /\b(?:do you want|would you like|are you sure|shall we|may i|can i)\b/i,
    /\b(?:allow|approve|authorize|confirm|continue|proceed|execute|run|apply|overwrite|delete|retry)\b[^\n?]{0,160}\?\s*$/im,

    // Inline yes/no and approval choices.
    /[\[(]\s*(?:y(?:es)?\s*[/|]\s*n(?:o)?|n(?:o)?\s*[/|]\s*y(?:es)?)[)\]]/i,
    /\([yY]\)es\s*\/\s*\([nN]\)o/i,
    /[\[(]\s*(?:是\s*[/|]\s*否|允许\s*[/|]\s*拒绝)[)\]]/,

    // Keyboard-driven menus and pause prompts.
    /\b(?:press|hit)\s+(?:the\s+)?(?:enter|return|any key|space(?:bar)?|tab)\b/i,
    /\buse\s+(?:the\s+)?(?:arrow keys|up and down arrows)\b/i,
    /\b(?:space|tab)\s+to\s+(?:select|toggle)\b/i,
    /\bwaiting for\s+(?:user\s+)?(?:input|approval|confirmation|authorization)\b/i,
    /\b(?:input|approval|confirmation|authorization)\s+(?:is\s+)?required\b/i,

    // Credential and MFA prompts. Anchor these to the end of a line so log
    // messages such as "password updated successfully" do not alert.
    /\b(?:password|passphrase|username|pin|otp|one[- ]time (?:password|code)|verification code|authentication code)[^\n:：]{0,120}[:：]\s*$/im,
    /\benter\s+(?:your\s+)?(?:password|passphrase|username|pin|otp|one[- ]time (?:password|code)|verification code|authentication code)[^\n]{0,160}[:：]?\s*$/im,

    // Chinese confirmation, selection, pause, credential and authorization
    // prompts commonly emitted by localized CLIs.
    /(?:^|\n)\s*(?:[?？❯›▶➤]\s*)?(?:是否(?:继续|允许|授权|执行|运行|应用|覆盖|删除|重试)|请选择(?![^\n]*=>)|请确认|等待(?:确认|授权|输入))[^\n]{0,160}\s*$/m,
    /(?:继续|确认|允许|授权|执行|运行|应用|覆盖|删除|重试)[^\n。！？]{0,80}[吗么][?？]?\s*$/m,
    /(?:请输入)?(?:密码|口令|用户名|验证码|动态码)\s*[:：]\s*$/m,
    /按(?:下)?(?:任意键|回车键?|空格键)(?:继续|确认)?/,
  ];

  function terminalTextNeedsAttention(text) {
    if (text == null) return false;
    const normalized = String(text)
      .replace(/\r/g, "")
      .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/\u00a0/g, " ");
    if (!normalized.trim()) return false;
    const meaningfulLines = normalized
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim());
    const recentLines = meaningfulLines.slice(-6);
    if (recentLines.some((line) =>
      BUSY_STATE_PATTERNS.some((pattern) => pattern.test(line))
    )) {
      return false;
    }
    const lastLine = meaningfulLines[meaningfulLines.length - 1];
    if (lastLine && READY_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))) {
      return false;
    }
    return PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  function terminalLiveVisibleText(buffer, rowCount) {
    if (!buffer) return null;
    const viewportY = Number(buffer.viewportY);
    const baseY = Number(buffer.baseY);
    if (Number.isFinite(viewportY) && Number.isFinite(baseY) && viewportY < baseY) {
      return null;
    }
    const rows = Math.max(1, Number(rowCount) || 1);
    const start = Number.isFinite(viewportY)
      ? viewportY
      : Math.max(0, Number(buffer.length) - rows);
    const end = Math.min(Number(buffer.length), start + rows);
    const lines = [];
    for (let i = start; i < end; i += 1) {
      const line = buffer.getLine?.(i);
      if (line) lines.push(line.translateToString?.(true) || "");
    }
    return lines.join("\n");
  }

  // Debounce prompt detection until output settles, but optionally cap how
  // long a pending scan may be postponed. The cap is used while an attention
  // badge is already active: otherwise a steady stream of output can keep
  // resetting the quiet timer forever and leave a stale badge behind.
  function scheduleTerminalAttentionScan(
    state,
    callback,
    {
      quietDelay,
      maxDelay = null,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
    }
  ) {
    if (!state || typeof callback !== "function") return;

    const cancelTimer = (key) => {
      if (state[key] === null || state[key] === undefined) return;
      clearTimer(state[key]);
      state[key] = null;
    };
    const run = () => {
      cancelTimer("attnQuietTimer");
      cancelTimer("attnMaxTimer");
      callback();
    };

    cancelTimer("attnQuietTimer");
    state.attnQuietTimer = setTimer(run, Math.max(0, Number(quietDelay) || 0));

    const hasMaxDelay = maxDelay !== null && maxDelay !== undefined;
    const boundedMaxDelay = Number(maxDelay);
    if (
      hasMaxDelay &&
      Number.isFinite(boundedMaxDelay) &&
      boundedMaxDelay >= 0 &&
      (state.attnMaxTimer === null || state.attnMaxTimer === undefined)
    ) {
      state.attnMaxTimer = setTimer(run, boundedMaxDelay);
    }
  }

  function cancelTerminalAttentionScan(
    state,
    { clearTimer = clearTimeout } = {}
  ) {
    if (!state) return;
    for (const key of ["attnQuietTimer", "attnMaxTimer"]) {
      if (state[key] !== null && state[key] !== undefined) {
        clearTimer(state[key]);
        state[key] = null;
      }
    }
  }

  return {
    terminalTextNeedsAttention,
    terminalLiveVisibleText,
    scheduleTerminalAttentionScan,
    cancelTerminalAttentionScan,
  };
});
