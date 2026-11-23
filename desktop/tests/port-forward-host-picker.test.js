// Run with node desktop/tests/port-forward-host-picker.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function openPortForwardEditor(");
const end = source.indexOf("\nconst settingsSyncBackends", start) > start
  ? source.indexOf("\nconst settingsSyncBackends", start)
  : source.indexOf("\nfunction ", source.indexOf("\nasync function savePortForwardEditor(", start) + 1);
assert(start >= 0 && end > start);
function select(value = "") {
  let selected = value;
  const node = { options: [], appendChild(option) {
    this.options.push(option);
    if (this.options.length === 1) selected = option.value;
  } };
  Object.defineProperties(node, {
    value: { get: () => selected, set: (value) => { selected = value; } },
    innerHTML: { set: () => { node.options = []; selected = ""; } },
  });
  return node;
}
const hosts = [
  { id: "local", name: "server", user: "root", host: "direct", port: 22, groupId: "local-group" },
  { id: "wg-a", name: "server", user: "alice:server", host: "gateway-a", port: 2222, warpgate: "gateway-a", groupId: "group-a" },
  { id: "wg-b", name: "server", user: "alice:server", host: "gateway-b", port: 2222, warpgate: "gateway-b", groupId: "group-b" },
];
const context = {
  document: { createElement: () => ({}) },
  hostsCache: [], hostsSource: "warpgate",
  hostGroups: [
    { id: "local-group", name: "Local" },
    { id: "root-a", name: "Gateway A" },
    { id: "group-a", name: "Prod", parentId: "root-a" },
    { id: "group-b", name: "Prod" },
  ],
  portForwardEditorGroup: select(),
  reloadHostGroupsFromVault: async () => {},
  portForwardEditor: {}, portForwardEditorHost: select(), portForwardEditorSource: select(),
  portForwardEditorSourceWrap: {}, portForwardEditorHostWrap: {},
  portForwardEditorTitle: {}, portForwardEditorAdd: {}, portForwardEditorError: {},
  portForwardEditorOverlay: {},
  portForwardEditorKind: { value: "local" },
  portForwardEditorKindTabs: null,
  portForwardEditorBind: { value: "127.0.0.1" },
  portForwardEditorBindPort: { value: "8080" },
  portForwardEditorTargetHostWrap: {},
  portForwardEditorTargetPortWrap: {},
  portForwardEditorArrow: {},
  portForwardEditorHint: {},
  portForwardEditorTargetHost: { value: "localhost" },
  portForwardEditorTargetPort: { value: "80" },
  portForwardEditorSave: { disabled: false },
  portForwardExpandedHosts: new Set(),
  savedInvokes: [],
  invoke: async (command, args) => { context.savedInvokes.push({ command, args }); },
  loadPortForwardPage: async () => {},
  t: (key) => key === "hosts.source.warpgate" ? "Warpgate" : key,
  setText() {},
  syncCustomSelect() {},
  forwardFromIO: (spec) => spec,
  refreshHostsCacheFromVault: async () => { context.hostsCache = hosts; },
};
const api = vm.runInNewContext(`${source.slice(start, end)}; ({
  openPortForwardCreateEditor, openPortForwardEditor, savePortForwardEditor, closePortForwardEditor,
  populatePortForwardHostOptions, populatePortForwardGroupOptions,
  selectedHost: () => portForwardEditorHostId,
  isHostLocked: () => portForwardEditorHostLocked,
})`, context);
const ids = () => context.portForwardEditorHost.options.map((opt) => opt.value);
(async () => {
  await api.openPortForwardCreateEditor();
  assert.deepEqual(ids(), ["wg-a", "wg-b"], "Warpgate source includes targets from both gateways");
  assert.equal(context.portForwardEditorHost.options[0].textContent, "server (alice:server@gateway-a:2222)");
  assert.equal(api.selectedHost(), "wg-a");
  assert.deepEqual(context.portForwardEditorGroup.options.map((opt) => opt.value), ["", "group-a", "group-b"]);
  assert.equal(context.portForwardEditorGroup.options[1].textContent, "Gateway A / Prod");
  context.portForwardEditorGroup.value = "group-b";
  api.populatePortForwardHostOptions();
  assert.deepEqual(ids(), ["wg-b"], "right selector shows only hosts in the chosen group");
  assert.equal(api.selectedHost(), "wg-b");
  context.portForwardEditorGroup.value = "";
  api.populatePortForwardHostOptions();
  context.portForwardEditorHost.value = "wg-b";
  context.portForwardEditorSource.value = "all";
  api.populatePortForwardGroupOptions();
  assert.deepEqual(ids(), ["local", "wg-a", "wg-b"]);
  assert.equal(api.selectedHost(), "wg-b", "preserve the selected target when still visible");
  context.portForwardEditorGroup.value = "group-b";
  context.portForwardEditorSource.value = "local";
  api.populatePortForwardGroupOptions();
  assert.equal(context.portForwardEditorGroup.value, "", "source changes reset an unavailable group");
  assert.deepEqual(ids(), ["local"]);
  assert.equal(api.selectedHost(), "local", "source changes update the host used on save");
  context.hostsCache = [hosts[0]];
  context.portForwardEditorSource.value = "warpgate";
  api.populatePortForwardHostOptions();
  assert.equal(api.selectedHost(), "", "an empty source must not retain a hidden host");
  context.hostsCache = [{ ...hosts[0], groupId: "deleted-group" }];
  context.portForwardEditorSource.value = "local";
  api.populatePortForwardGroupOptions();
  context.portForwardEditorGroup.value = "__ungrouped__";
  api.populatePortForwardHostOptions();
  assert.deepEqual(ids(), ["local"], "orphan hosts remain selectable under Ungrouped");
  api.openPortForwardEditor({ hostId: "wg-b", id: "rule", forward: {}, hostName: "server" });
  assert.equal(context.portForwardEditorSourceWrap.hidden, true);
  assert.equal(context.portForwardEditorHostWrap.hidden, true);
  assert.equal(api.selectedHost(), "wg-b", "editing preserves the rule's original target");
  assert.equal(api.isHostLocked(), false);

  await api.openPortForwardCreateEditor({ hostId: "wg-b", hostName: "server" });
  assert.equal(context.portForwardEditorSourceWrap.hidden, true, "group quick-add hides source filter");
  assert.equal(context.portForwardEditorHostWrap.hidden, true, "group quick-add hides host picker");
  assert.equal(api.selectedHost(), "wg-b", "group quick-add locks target host");
  assert.equal(api.isHostLocked(), true);
  assert.equal(context.portForwardEditorTitle.textContent, "port_forward.editor.title.create_for_host");
  assert.equal(context.portForwardEditorOverlay.hidden, false);

  context.portForwardEditorHost.value = "";
  context.portForwardEditorBindPort.value = "18080";
  context.portForwardEditorTargetPort.value = "8080";
  await api.savePortForwardEditor();
  assert.equal(context.savedInvokes.length, 1);
  assert.equal(context.savedInvokes[0].command, "create_port_forward_rule");
  assert.equal(context.savedInvokes[0].args.input.hostId, "wg-b", "saving a locked-host rule keeps the group host ID");
  assert.equal(context.portForwardExpandedHosts.has("wg-b"), true, "saving expands the host group");
  assert.equal(api.isHostLocked(), false, "closing resets locked-host state");

  context.refreshHostsCacheFromVault = async () => { throw new Error("vault unavailable"); };
  await api.openPortForwardCreateEditor({ hostId: "wg-b", hostName: "server" });
  assert.equal(api.selectedHost(), "wg-b", "group quick-add opens without needing a vault refresh");
  await assert.rejects(api.openPortForwardCreateEditor(), /vault unavailable/);
  console.log("port-forward-host-picker.test.js: passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
