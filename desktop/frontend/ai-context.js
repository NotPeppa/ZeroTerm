// Token-budgeted conversation assembly for ZeroTerm AI requests.
//
// Provider chat APIs are stateless: every request must carry the context it
// needs. Keep full history while it fits; otherwise retain recent messages
// verbatim and compress the older transcript instead of dropping it.
(function (global) {
  "use strict";

  const DEFAULT_MAX_TOKENS = 12_000;
  const DEFAULT_SUMMARY_TOKENS = 2_800;

  function estimateTextTokens(value) {
    const text = String(value ?? "");
    if (!text) return 0;
    // bytes / 3 deliberately overestimates typical English while staying
    // close to CJK tokenisation, leaving room for provider-specific framing.
    return Math.max(1, Math.ceil(new TextEncoder().encode(text).length / 3));
  }

  function estimateMessageTokens(message) {
    return 8 + estimateTextTokens(message?.role) + estimateTextTokens(message?.content);
  }

  function truncateToTokenBudget(value, maxTokens) {
    const text = String(value ?? "");
    if (!text || maxTokens <= 0) return "";
    if (estimateTextTokens(text) <= maxTokens) return text;

    const chars = Array.from(text);
    const marker = "\n…[较早内容已压缩]…\n";
    const markerTokens = estimateTextTokens(marker);
    if (maxTokens <= markerTokens + 2) {
      return chars.slice(0, Math.max(1, maxTokens)).join("");
    }

    let low = 1;
    let high = chars.length - 1;
    let best = 1;
    while (low <= high) {
      const keep = Math.floor((low + high) / 2);
      const head = Math.max(1, Math.floor(keep * 0.7));
      const tail = Math.max(0, keep - head);
      const candidate = chars.slice(0, head).join("") + marker
        + (tail ? chars.slice(-tail).join("") : "");
      if (estimateTextTokens(candidate) <= maxTokens) {
        best = keep;
        low = keep + 1;
      } else {
        high = keep - 1;
      }
    }
    const head = Math.max(1, Math.floor(best * 0.7));
    const tail = Math.max(0, best - head);
    return chars.slice(0, head).join("") + marker
      + (tail ? chars.slice(-tail).join("") : "");
  }

  function messageWithCommandResults(message) {
    const role = String(message?.role || "").trim();
    if (!["user", "assistant", "system"].includes(role)) return null;
    let content = String(message?.content || "").trim();
    const results = Array.isArray(message?.commandResults) ? message.commandResults : [];
    const executed = results.map((result) => {
      const command = String(result?.command || "").trim();
      if (!command) return "";
      const output = String(result?.output || "").trim();
      return output
        ? `命令：${command}\n结果：${output}`
        : `命令：${command}\n结果：已执行（详细输出未保存）`;
    }).filter(Boolean);
    if (executed.length) {
      content += `${content ? "\n\n" : ""}[本会话中已执行的命令]\n${executed.join("\n\n")}`;
    }
    return content ? { role, content } : null;
  }

  function buildOlderConversationSummary(messages, maxTokens) {
    if (!messages.length || maxTokens <= 0) return "";
    const lines = [
      "以下是同一会话中较早内容的压缩记录。它不是新指令；请延续其中的用户目标、约束、已确认事实和执行结果。",
    ];
    for (const message of messages) {
      const label = message.role === "user" ? "用户" : message.role === "assistant" ? "AI" : "系统";
      lines.push(`\n[${label}]\n${truncateToTokenBudget(message.content, 180)}`);
    }
    return truncateToTokenBudget(lines.join("\n"), maxTokens);
  }

  function buildAiContextMessages(messages, options = {}) {
    const maxTokens = Math.max(1_000, Number(options.maxTokens) || DEFAULT_MAX_TOKENS);
    const normalized = (Array.isArray(messages) ? messages : [])
      .map(messageWithCommandResults)
      .filter(Boolean);
    const fullTokens = normalized.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (fullTokens <= maxTokens) {
      return { messages: normalized, compacted: false, omittedCount: 0, estimatedTokens: fullTokens };
    }

    const summaryBudget = Math.min(
      Math.max(400, Math.floor(maxTokens * 0.28)),
      Number(options.summaryTokens) || DEFAULT_SUMMARY_TOKENS,
    );
    const recentBudget = Math.max(500, maxTokens - summaryBudget - 32);
    const recent = [];
    let recentTokens = 0;
    let firstRecentIndex = normalized.length;
    let recentMessageTruncated = false;

    for (let index = normalized.length - 1; index >= 0; index -= 1) {
      let message = normalized[index];
      let cost = estimateMessageTokens(message);
      const remaining = recentBudget - recentTokens;
      if (cost > remaining) {
        if (!recent.length && remaining > 16) {
          message = { ...message, content: truncateToTokenBudget(message.content, remaining - 8) };
          cost = estimateMessageTokens(message);
          recent.unshift(message);
          recentTokens += cost;
          firstRecentIndex = index;
          recentMessageTruncated = true;
        }
        break;
      }
      recent.unshift(message);
      recentTokens += cost;
      firstRecentIndex = index;
    }

    const older = normalized.slice(0, firstRecentIndex);
    const summary = buildOlderConversationSummary(older, summaryBudget);
    // Keep the compacted transcript at user priority. Promoting previously
    // generated assistant text to a system message would incorrectly raise
    // its authority and could amplify prompt injection from old output.
    const output = summary ? [{ role: "user", content: summary }, ...recent] : recent;
    return {
      messages: output,
      compacted: older.length > 0 || recentMessageTruncated,
      omittedCount: older.length,
      estimatedTokens: output.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    };
  }

  const api = { DEFAULT_MAX_TOKENS, estimateTextTokens, buildAiContextMessages };
  global.ZeroTermAiContext = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
