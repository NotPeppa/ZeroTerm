// Auto-reconnect must stay bounded (3 tries, doubling delay), must not fire for
// local shells or when switched off, and a success must refill the budget.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("const AUTO_RECONNECT_MAX_ATTEMPTS");
const end = source.indexOf("\nasync function connectPaneSession", start);
if (start < 0 || end < 0) throw new Error("auto reconnect helpers were not found");

function createFixture({ saved = null, isLocal = false, factory = true } = {}) {
  const timers = [];
  const runs = [];
  const context = {
    console,
    SETTINGS_KEY_TERMINAL_AUTO_RECONNECT: "auto.reconnect",
    localStorage: { getItem: () => saved },
    t: (key, vars) => `${key}:${vars.seconds}s:${vars.attempt}/${vars.max}`,
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (id) timers[id - 1].cleared = true;
    },
    Promise,
  };
  const helpers = vm.runInNewContext(
    `${source.slice(start, end)}; ({ scheduleAutoReconnect, cancelAutoReconnect, resetAutoReconnect, AUTO_RECONNECT_MAX_ATTEMPTS })`,
    context,
  );
  const pane = {
    isLocal,
    sessionId: null,
    statusEl: { textContent: "" },
    autoReconnectAttempts: 0,
    autoReconnectTimer: null,
    reconnectFactory: factory ? async () => runs.push(Date.now()) : null,
  };
  return { helpers, pane, timers, runs };
}

function run() {
  const f = createFixture();
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    const armed = f.helpers.scheduleAutoReconnect(f.pane);
    if (i < 3) {
      if (!armed) throw new Error(`attempt ${i + 1} should have been armed`);
      delays.push(f.timers.at(-1).delay);
      if (!f.pane.statusEl.textContent.includes(`${i + 1}/3`)) {
        throw new Error(`status did not show the attempt count: ${f.pane.statusEl.textContent}`);
      }
    } else if (armed) {
      throw new Error("a fourth attempt must not be armed");
    }
  }
  if (delays.join(",") !== "1000,2000,4000") throw new Error(`backoff was ${delays.join(",")}`);

  const reset = createFixture();
  reset.helpers.scheduleAutoReconnect(reset.pane);
  reset.helpers.resetAutoReconnect(reset.pane);
  if (!reset.timers[0].cleared) throw new Error("reset must clear the pending timer");
  if (reset.pane.autoReconnectAttempts !== 0) throw new Error("reset must refill the attempt budget");
  if (!reset.helpers.scheduleAutoReconnect(reset.pane)) throw new Error("budget was not usable after a reset");
  if (reset.timers.at(-1).delay !== 1000) throw new Error("backoff did not restart from the base delay");

  if (createFixture({ saved: "false" }).helpers.scheduleAutoReconnect(createFixture().pane) !== false) {
    throw new Error("the disabled setting must not arm a retry");
  }
  const local = createFixture({ isLocal: true });
  if (local.helpers.scheduleAutoReconnect(local.pane)) throw new Error("local shells must not auto reconnect");
  const bare = createFixture({ factory: false });
  if (bare.helpers.scheduleAutoReconnect(bare.pane)) throw new Error("a pane with no reconnect factory must be skipped");

  // A retry that fires after the pane got reconnected by other means is a no-op.
  const live = createFixture();
  live.helpers.scheduleAutoReconnect(live.pane);
  live.pane.sessionId = "s1";
  live.timers[0].fn();
  if (live.runs.length) throw new Error("a reconnected pane must not be reconnected again");

  const fires = createFixture();
  fires.helpers.scheduleAutoReconnect(fires.pane);
  fires.timers[0].fn();
  if (fires.runs.length !== 1) throw new Error("the armed timer did not run the reconnect factory");

  console.log("terminal-auto-reconnect: ok");
}

run();
