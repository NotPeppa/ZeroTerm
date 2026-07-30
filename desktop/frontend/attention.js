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

    // Credential and MFA prompts. Anchor these to the end of a line so log
    // messages such as "password updated successfully" do not alert.
    /\b(?:password|passphrase|username|pin|otp|one[- ]time (?:password|code)|verification code|authentication code)[^\n:：]{0,120}[:：]\s*$/im,
    /\benter\s+(?:your\s+)?(?:password|passphrase|username|pin|otp|one[- ]time (?:password|code)|verification code|authentication code)[^\n]{0,160}[:：]?\s*$/im,

    // Chinese confirmation, selection, pause, credential and authorization
    // prompts commonly emitted by localized CLIs.
    /是否(?:继续|允许|授权|执行|运行|应用|覆盖|删除|重试)|请选择|请确认|等待(?:确认|授权|输入)/,
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
    return PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  return { terminalTextNeedsAttention };
});
