// `tmux ls` output parsing (Rust side is mirrored here in spirit) plus the
// panel's own rendering rules: version-less hosts disable the actions, and an
// attached session is marked.

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function renderTmuxSessions");
const end = source.indexOf("\nasync function renderTmuxPanel", start);
if (start < 0 || end < 0) throw new Error("tmux panel helpers were not found");

function load() {
  const rows = [];
  const body = {
    innerHTML: "",
    appendChild: (el) => rows.push(el),
  };
  const context = {
    console,
    terminalTmuxBody: body,
    terminalTmuxSubtitle: { textContent: "" },
    terminalTmuxNew: { disabled: false },
    terminalTmuxDetach: { disabled: false },
    t: (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
    sendTmuxCommand: (cmd) => context.sent.push(cmd),
    sent: [],
    confirm: () => true,
    openTextInputDialog: async () => null,
    document: {
      createElement: () => {
        const el = {
          classList: { add: () => {} },
          children: [],
          append: (...kids) => el.children.push(...kids),
          setAttribute: () => {},
          addEventListener: (type, fn) => {
            if (type === "click") el.click = fn;
          },
        };
        return el;
      },
    },
  };
  const api = vm.runInNewContext(`${source.slice(start, end)}; ({ renderTmuxSessions })`, context);
  return { api, context, rows, body };
}

// No tmux on the host: the panel says so and the action buttons go dead
// rather than typing commands that would just print "command not found".
const missing = load();
missing.api.renderTmuxSessions({ version: "", sessions: [] });
if (!missing.context.terminalTmuxNew.disabled || !missing.context.terminalTmuxDetach.disabled) {
  throw new Error("actions stayed enabled without tmux");
}
if (!missing.body.innerHTML.includes("tmux.empty.missing.title")) throw new Error("missing-tmux empty state not shown");
if (missing.context.terminalTmuxSubtitle.textContent !== "tmux.subtitle.missing") throw new Error("subtitle did not report the missing tmux");

// tmux present but no sessions yet: actions live, empty state shown.
const empty = load();
empty.api.renderTmuxSessions({ version: "3.0a", sessions: [] });
if (empty.context.terminalTmuxNew.disabled) throw new Error("new-session must be available once tmux exists");
// Detach without an attached session would type C-b d into the shell.
if (!empty.context.terminalTmuxDetach.disabled) throw new Error("detach must stay disabled with no sessions");
if (empty.context.terminalTmuxSubtitle.textContent !== "tmux 3.0a") throw new Error("version was not shown");
if (!empty.body.innerHTML.includes("tmux.empty.title")) throw new Error("empty session list state not shown");

// Sessions render one row each, attached ones flagged, click attaches by name.
const listed = load();
listed.api.renderTmuxSessions({
  version: "3.0a",
  sessions: [
    { name: "work", windows: 3, attached: true, created: "" },
    { name: "my session", windows: 1, attached: false, created: "" },
  ],
});
if (listed.rows.length !== 2) throw new Error(`expected 2 rows, got ${listed.rows.length}`);
if (listed.context.terminalTmuxDetach.disabled) throw new Error("detach must be available while a session is attached");
// The card itself is inert: attaching happens only through its button.
if (listed.rows[1].click) throw new Error("the card must not carry a click handler of its own");
listed.rows[1].children.at(-1).children[0].click();
const cmd = listed.context.sent.at(-1);
// The name is quoted, so spaces and shell metacharacters cannot split it.
if (!cmd.includes('attach -t "my session"')) throw new Error(`attach command did not quote the name: ${cmd}`);
if (!cmd.includes("switch-client")) throw new Error("attach must fall back to switch-client when already inside tmux");

const detachedOnly = load();
detachedOnly.api.renderTmuxSessions({
  version: "3.0a",
  sessions: [{ name: "work", windows: 2, attached: false, created: "" }],
});
if (!detachedOnly.context.terminalTmuxDetach.disabled) {
  throw new Error("detach must stay disabled when every session is detached");
}

// Each row carries attach / rename / kill, and kill asks first.
const actions = listed.rows[0].children.at(-1);
if (actions.children.length !== 3) throw new Error(`expected 3 row actions, got ${actions.children.length}`);
actions.children[2].click();
const killCmd = listed.context.sent.at(-1);
if (!killCmd.startsWith("tmux kill-session -t ")) throw new Error(`kill action sent ${killCmd}`);
if (!killCmd.includes('"work"')) throw new Error("kill did not quote the session name");

console.log("tmux-panel: ok");
