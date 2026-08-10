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
  styles.includes("overflow-y: auto !important")
    && !styles.includes("overflow-y: scroll !important"),
  "terminal viewport should not force a permanent outside scrollbar gutter",
);
check(
  !source.includes("overviewRuler: { width: 8 }")
    && styles.includes(".xterm-scrollable-element > .scrollbar.vertical")
    && styles.includes(".scrollbar.vertical > .slider"),
  "xterm 6 scrollbar should use custom CSS without enabling its overview ruler",
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

const repairStart = source.indexOf("function repairXtermResizeBuffers");
const repairEnd = source.indexOf("\nfunction clampPaneBodyHeight", repairStart);
const repairSource = repairStart >= 0 && repairEnd > repairStart
  ? source.slice(repairStart, repairEnd)
  : "";
check(Boolean(repairSource), "xterm resize buffer repair helper should exist");
const repairXtermResizeBuffers = vm.runInNewContext(
  `${repairSource}; repairXtermResizeBuffers`,
);

check(
  source.includes("pendingTerminalWrites: 0")
    && source.includes("fitAfterTerminalWrites: false")
    && source.includes("if ((pane.pendingTerminalWrites || 0) > 0)")
    && source.includes("pane.pendingTerminalWrites === 0 && pane.fitAfterTerminalWrites"),
  "fit should be deferred until all asynchronous xterm writes are parsed",
);

const terminalIoStart = source.indexOf("function requestPaneFit");
const terminalIoEnd = source.indexOf("\nfunction parseOsc7Path", terminalIoStart);
const terminalIoSource = terminalIoStart >= 0 && terminalIoEnd > terminalIoStart
  ? source.slice(terminalIoStart, terminalIoEnd)
  : "";
const terminalIo = vm.runInNewContext(
  `${terminalIoSource}; ({ fitPane, writePaneTerminalData })`,
  {
    TERMINAL_RESIZE_DEBOUNCE_MS: 0,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback) => callback(),
    cancelAnimationFrame: () => {},
    invoke: () => Promise.resolve(),
    console,
  },
);

function runWriteFitSerializationRegression() {
  let writeCallback = null;
  let fitCount = 0;
  const term = {
    rows: 24,
    write(_data, callback) {
      writeCallback = callback;
    },
    scrollToBottom() {},
    refresh() {},
  };
  const pane = {
    term,
    fitAddon: { fit: () => { fitCount += 1; } },
    bodyEl: null,
    rootEl: null,
    sessionId: null,
    pendingResizeTimer: null,
    pendingFitRaf: null,
    pendingTerminalWrites: 0,
    fitAfterTerminalWrites: false,
  };

  terminalIo.writePaneTerminalData(pane, "pending-output");
  terminalIo.fitPane(pane);
  check(fitCount === 0, "fit should not run while an xterm write is pending");
  check(pane.fitAfterTerminalWrites, "a blocked fit should be remembered");
  writeCallback();
  check(pane.pendingTerminalWrites === 0, "parsed write callback should drain the write count");
  check(fitCount === 1, "the deferred fit should run once after parsing finishes");
}

runWriteFitSerializationRegression();

async function runXtermResizeRepairRegression() {
  const term = new Terminal({ cols: 39, rows: 18, scrollback: 100, convertEol: false });
  const write = (data) => new Promise((resolve) => term.write(data, resolve));
  try {
    await write(Array.from({ length: 22 }, (_, i) => `line-${i}\r\n`).join("") + "\x1b[4A");
    const core = term._core;
    // Reproduce the xterm 6.0.0 resize invariant reported upstream: growing
    // rows consumes ybase without allocating the newly visible BufferLines.
    core.buffer.lines.length = 18;
    term.resize(37, 23);
    check(
      core.buffer.lines.length < core.buffer.ybase + term.rows,
      "regression fixture should begin with missing visible buffer rows",
    );
    check(repairXtermResizeBuffers(term), "resize guard should repair missing buffer rows");
    check(
      core.buffer.lines.length >= core.buffer.ybase + term.rows,
      "resize guard should restore the visible BufferLine invariant",
    );
    check(
      core._bufferService.buffers.alt.lines.length === 0,
      "resize guard should leave an inactive empty alternate buffer untouched",
    );
    for (let row = 18; row <= 22; row += 1) {
      await write(`\x1b[${row + 1};1H\x1b[2Kbottom-${row}`);
      check(Boolean(term.buffer.active.getLine(row)), `repaired row ${row} should remain writable`);
    }
  } finally {
    term.dispose();
  }
}

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

Promise.all([
  runXtermBufferSwitchRegression(),
  runXtermResizeRepairRegression(),
])
  .catch((error) => {
    failed += 1;
    console.error("  FAIL: real xterm buffer regression threw", error);
  })
  .finally(() => {
    console.log(`\nterminal-scroll.test.js: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
