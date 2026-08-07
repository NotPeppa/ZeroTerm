// Regression test: TUI programs move cursorY while repainting. Scroll-follow
// state must depend on xterm's viewport/base positions instead.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../frontend/styles.css"), "utf8");
const xtermVersions = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../frontend/assets/xterm-versions.json"), "utf8"),
);
const { Terminal } = require(path.join(__dirname, "../frontend/assets/xterm.min.js"));
let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${label}`);
  }
}

const start = source.indexOf("function isTerminalBufferAtBottom(buffer)");
const end = source.indexOf("\nfunction isPaneTerminalNearBottom", start);
const helper = start >= 0 && end > start ? source.slice(start, end) : "";

check(Boolean(helper), "terminal bottom helper should exist");
check(
  helper.includes("buffer.viewportY") && helper.includes("buffer.baseY"),
  "bottom detection should compare viewportY with baseY",
);
check(
  !helper.includes("buffer.cursorY"),
  "TUI cursor movement must not affect scroll-follow state",
);
check(
  source.includes("return isTerminalBufferAtBottom(buffer)"),
  "sticky output should use the corrected bottom rule",
);
const isAtBottom = vm.runInNewContext(`${helper}; isTerminalBufferAtBottom`);
check(
  isAtBottom({ baseY: 120, viewportY: 120, cursorY: 0 }),
  "a TUI cursor repaint at the top row should remain attached to the bottom",
);
check(
  !isAtBottom({ baseY: 120, viewportY: 90, cursorY: 20 }),
  "a genuinely scrolled-up viewport should remain detached from the bottom",
);
check(
  !source.includes("function syncPaneViewportScroll")
    && !source.includes("pane.term.scrollLines(ev.deltaY"),
  "xterm should be the sole owner of viewport and wheel scrolling",
);
const writeStart = source.indexOf("function writePaneTerminalData");
const writeEnd = source.indexOf("\nfunction parseOsc7Path", writeStart);
const writeSource = writeStart >= 0 && writeEnd > writeStart
  ? source.slice(writeStart, writeEnd)
  : "";
check(
  !writeSource.includes("refreshPaneTerminal"),
  "streaming output should not force a full terminal repaint after every chunk",
);
check(
  source.includes("followOutput: true")
    && source.includes("stickToBottom: () => pane.followOutput !== false"),
  "output following should survive terminal buffer switches as pane state",
);
check(
  writeSource.includes('typeof stickToBottom === "function"')
    && writeSource.includes("stickToBottom()"),
  "queued writes should recheck follow state after asynchronous parsing",
);
check(
  source.includes("scrollOnUserInput: true"),
  "keyboard input should explicitly restore the live terminal viewport",
);
check(
  Number.parseInt(xtermVersions["@xterm/xterm"], 10) >= 6,
  "xterm core should include the alternate-buffer scrollbar teleport fixes",
);
check(
  styles.includes("overflow-y: scroll !important"),
  "terminal viewport should retain xterm's stable scroll geometry",
);
check(
  source.includes('pane.term.buffer.onBufferChange(() => {')
    && source.includes("if (!pane.term || !pane.followOutput) return")
    && source.includes("pane.term.scrollToBottom()"),
  "returning from a TUI alternate buffer should restore a following pane to the bottom",
);
check(
  source.includes("if (ev.deltaY < 0)")
    && source.includes("pane.followOutput = false")
    && source.includes("if (isPaneTerminalNearBottom(pane)) pane.followOutput = true"),
  "explicit user scrolling should control whether output follows",
);

async function runXtermBufferSwitchRegression() {
  const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  try {
    await write(Array.from({ length: 500 }, (_, i) => `normal-${i}\r\n`).join(""));
    term.scrollToBottom();
    let stayedAtBottom = true;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      await write("\x1b[?1049h");
      await write(Array.from({ length: 40 }, (_, i) => `alternate-${cycle}-${i}\r\n`).join(""));
      term.scrollLines(-18);
      term.scrollLines(9);
      term.scrollLines(-6);
      await write("\x1b[?1049l");
      const buffer = term.buffer.active;
      stayedAtBottom = stayedAtBottom
        && buffer.type === "normal"
        && buffer.viewportY === buffer.baseY;
    }
    check(stayedAtBottom, "real xterm buffer switches should preserve the live viewport");
  } finally {
    term.dispose();
  }
}

runXtermBufferSwitchRegression()
  .catch((error) => {
    failed += 1;
    console.error("  FAIL: real xterm buffer regression threw", error);
  })
  .finally(() => {
    console.log(`\nterminal-scroll.test.js: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
