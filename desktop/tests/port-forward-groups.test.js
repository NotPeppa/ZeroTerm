// Run with node desktop/tests/port-forward-groups.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function summarizeForwardSpec(");
const end = source.indexOf("\nfunction openPortForwardEditor(", start);
assert(start >= 0 && end > start);

function element(tagName) {
  const node = {
    tagName, children: [], listeners: {}, open: false, isConnected: true,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.append(child); },
    setAttribute() {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
    querySelector(tag) { return this.children.find((child) => child.tagName === tag); },
  };
  Object.defineProperty(node, "innerHTML", {
    set(html) {
      this.children = html === "<strong></strong><span></span>"
        ? [element("strong"), element("span")] : [];
    },
  });
  return node;
}

const rows = [
  { id: "sg-1", hostId: "sg", hostName: "SG", forward: { bindPort: 8333 } },
  { id: "hk-1", hostId: "hk", hostName: "HK", forward: { bindPort: 7928 } },
  { id: "sg-2", hostId: "sg", hostName: "SG", forward: { bindPort: 3090 }, active: { id: 7 } },
  { id: "other-sg", hostId: "other", hostName: "SG", forward: { bindPort: 8080 } },
];
const calls = [];
const context = {
  document: { createElement: element },
  portForwardList: element("div"),
  portForwardEmpty: element("div"),
  portForwardSearch: { value: "" },
  t: (key, vars) => `${key} ${Object.values(vars || {}).join(" ")}`,
  svgIcon: (svg) => svg,
  fuzzyMatchSelectOption: () => false,
  openConfirmDialog: async () => true,
  invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === "list_port_forward_status") return rows;
    if (command === "stop_port_forward") rows[2].active = null;
    if (command === "start_port_forward") rows[2].active = { id: 7 };
  },
};
const api = vm.runInNewContext(
  `${source.slice(start, end)}; ({ loadPortForwardPage, renderPortForwardRows })`, context,
);
const groups = () => context.portForwardList.children;
const body = (group) => group.children[1];
const actions = (card) => card.children[0].children[1].children;

(async () => {
  await api.loadPortForwardPage();
  assert.equal(groups().length, 3, "group by host ID, including same-name hosts");
  assert(groups().every((group) => group.tagName === "details" && !group.open));
  assert.deepEqual(groups().map((group) => body(group).children.length), [2, 1, 1]);
  assert.equal(groups()[0].children[0].children[1].textContent, "SG");
  assert.equal(groups()[0].children[0].children[2].textContent, "port_forward.group.summary 2 1");
  assert.equal(context.portForwardEmpty.hidden, true);

  groups()[0].open = true;
  groups()[0].listeners.toggle();
  await api.loadPortForwardPage();
  assert.equal(groups()[0].open, true, "refresh preserves expanded hosts");
  assert.equal(groups()[1].open, false);

  await actions(body(groups()[0]).children[1])[1].listeners.click();
  assert.equal(calls.at(-3).command, "stop_port_forward");
  assert.equal(calls.at(-3).args.id, 7);
  assert.equal(groups()[0].open, true, "stopping a rule preserves its expanded group");
  await actions(body(groups()[0]).children[1])[1].listeners.click();
  assert.equal(calls.at(-3).command, "start_port_forward");
  assert.equal(calls.at(-3).args.ruleId, "sg-2");

  context.portForwardSearch.value = "7928";
  api.renderPortForwardRows();
  assert.equal(groups().length, 1);
  assert.equal(groups()[0].open, true, "search results are visible without another click");
  groups()[0].listeners.toggle();
  context.portForwardSearch.value = "";
  api.renderPortForwardRows();
  assert.equal(groups()[0].open, true);
  assert.equal(groups()[1].open, false, "search does not persist automatic expansion");

  groups()[0].open = false;
  groups()[0].listeners.toggle();
  api.renderPortForwardRows();
  assert.equal(groups()[0].open, false, "manual collapse is preserved");
  context.portForwardSearch.value = "no-such-host";
  api.renderPortForwardRows();
  assert.equal(groups().length, 0);
  assert.equal(context.portForwardEmpty.hidden, false);
  console.log("port-forward-groups.test.js: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
