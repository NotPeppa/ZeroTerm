// Run with node desktop/tests/sftp-host-select.test.js.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("function fuzzyMatchSelectOption(");
const end = source.indexOf("\nfunction buildCustomSelect(", start);
assert(start >= 0 && end > start, "SFTP host select helpers not found");

const labels = {
  "sftp.host.local": "Local",
  "hosts.source.local": "ZeroTerm",
  "hosts.source.warpgate": "Warpgate",
  "files.button.back": "Back",
  "sftp.host.group.empty": "Empty group",
  "select.search.empty": "No matches",
};
const translate = (key) => labels[key] || key;

const { resolveSftpHostMenuState } = vm.runInNewContext(
  `${source.slice(start, end)}; ({ resolveSftpHostMenuState })`,
  { t: translate },
);
const rows = (items, fn) => Array.from(items, fn);

const localGroups = [
  { id: "g-prod", name: "Prod", parentId: "", warpgate: "", sortOrder: 1 },
  { id: "g-web", name: "Web", parentId: "g-prod", warpgate: "", sortOrder: 1 },
];
const localHosts = [
  { id: "h-ungrouped", name: "bastion", user: "root", host: "10.0.0.1", port: 22, groupId: "", warpgate: "" },
  { id: "h-web1", name: "web-1", user: "ubuntu", host: "10.0.1.1", port: 22, groupId: "g-web", warpgate: "" },
];
const wgGroups = [
  { id: "wg-gw", name: "Warpgate", parentId: "", warpgate: "gw-a", sortOrder: 1 },
  { id: "wg-sub", name: "DB", parentId: "wg-gw", warpgate: "gw-a", sortOrder: 1 },
];
const wgHosts = [
  { id: "wg-root-host", name: "jump", user: "alice:jump", host: "gw-a", port: 2222, groupId: "wg-gw", warpgate: "gw-a" },
  { id: "wg-db1", name: "pg-1", user: "alice:pg-1", host: "gw-a", port: 2222, groupId: "wg-sub", warpgate: "gw-a" },
];

// 1. Without Warpgate: flatten Local + ZeroTerm top-level groups & ungrouped hosts directly at root.
const noWgRoot = resolveSftpHostMenuState({
  hostGroupsList: localGroups,
  hostsList: localHosts,
  selectedValue: "__local__",
  translate,
});
assert.deepEqual(
  rows(noWgRoot.items, (item) => [item.kind, item.label]),
  [
    ["host", "Local"],
    ["group", "Prod"],
    ["host", "bastion"],
  ],
  "without Warpgate, ZeroTerm groups and ungrouped hosts appear directly at root",
);

const noWgNested = resolveSftpHostMenuState({
  browseGroupId: "g-web",
  hostGroupsList: localGroups,
  hostsList: localHosts,
  translate,
});
assert.deepEqual(
  rows(noWgNested.items, (item) => [item.kind, item.label, item.meta]),
  [
    ["back", "Back", "Web"],
    ["host", "web-1", "ubuntu@10.0.1.1:22"],
  ],
);
assert.equal(noWgNested.items[0].nextGroupId, "g-prod");

// 2. With Warpgate: root splits into Local, ZeroTerm, Warpgate.
const allGroups = [...localGroups, ...wgGroups];
const allHosts = [...localHosts, ...wgHosts];

const wgRoot = resolveSftpHostMenuState({
  hostGroupsList: allGroups,
  hostsList: allHosts,
  selectedValue: "__local__",
  translate,
});
assert.deepEqual(
  rows(wgRoot.items, (item) => [item.kind, item.label, item.nextSource || item.value]),
  [
    ["host", "Local", "__local__"],
    ["group", "ZeroTerm", "local"],
    ["group", "Warpgate", "warpgate"],
  ],
  "with Warpgate, root shows Local, ZeroTerm, and Warpgate",
);

// 3. Drill into ZeroTerm: shows Back (ZeroTerm) + ZeroTerm subgroups & ungrouped hosts only.
const inZeroTerm = resolveSftpHostMenuState({
  browseSource: "local",
  hostGroupsList: allGroups,
  hostsList: allHosts,
  translate,
});
assert.deepEqual(
  rows(inZeroTerm.items, (item) => [item.kind, item.label]),
  [
    ["back", "Back"],
    ["group", "Prod"],
    ["host", "bastion"],
  ],
);
assert.equal(inZeroTerm.items[0].meta, "ZeroTerm");
assert.equal(inZeroTerm.items[0].nextSource, "");

// 4. Drill into ZeroTerm subgroup -> nested subgroup -> Back returns step by step.
const inProd = resolveSftpHostMenuState({
  browseSource: "local",
  browseGroupId: "g-prod",
  hostGroupsList: allGroups,
  hostsList: allHosts,
  translate,
});
assert.deepEqual(
  rows(inProd.items, (item) => [item.kind, item.label]),
  [
    ["back", "Back"],
    ["group", "Web"],
  ],
);
assert.equal(inProd.items[0].nextSource, "local");
assert.equal(inProd.items[0].nextGroupId, "");

// 5. Single Warpgate gateway unwraps its redundant root group directly inside Warpgate.
const inWarpgate = resolveSftpHostMenuState({
  browseSource: "warpgate",
  hostGroupsList: allGroups,
  hostsList: allHosts,
  translate,
});
assert.deepEqual(
  rows(inWarpgate.items, (item) => [item.kind, item.label]),
  [
    ["back", "Back"],
    ["group", "DB"],
    ["host", "jump"],
  ],
  "single Warpgate gateway unwraps its root group instead of showing a duplicate Warpgate layer",
);
assert.equal(inWarpgate.items[0].meta, "Warpgate");
assert.equal(inWarpgate.items[0].nextSource, "");

const inWgSub = resolveSftpHostMenuState({
  browseSource: "warpgate",
  browseGroupId: "wg-sub",
  hostGroupsList: allGroups,
  hostsList: allHosts,
  translate,
});
assert.deepEqual(
  rows(inWgSub.items, (item) => [item.kind, item.label]),
  [
    ["back", "Back"],
    ["host", "pg-1"],
  ],
);
assert.equal(inWgSub.items[0].nextSource, "warpgate");
assert.equal(inWgSub.items[0].nextGroupId, "", "Back from subgroup returns straight to Warpgate source");

// 6. Multiple Warpgate gateways keep each gateway visible under Warpgate.
const multiWgGroups = [
  ...allGroups,
  { id: "wg-gw-b", name: "Gateway B", parentId: "", warpgate: "gw-b", sortOrder: 2 },
];
const multiWgHosts = [
  ...allHosts,
  { id: "wg-b1", name: "app-b", user: "bob:app-b", host: "gw-b", port: 2222, groupId: "wg-gw-b", warpgate: "gw-b" },
];
const inMultiWarpgate = resolveSftpHostMenuState({
  browseSource: "warpgate",
  hostGroupsList: multiWgGroups,
  hostsList: multiWgHosts,
  translate,
});
assert.deepEqual(
  rows(inMultiWarpgate.items, (item) => [item.kind, item.label]),
  [
    ["back", "Back"],
    ["group", "Warpgate"],
    ["group", "Gateway B"],
  ],
  "multiple Warpgate gateways list each gateway root under Warpgate",
);

// 7. Search stays flat across Local, ZeroTerm, and Warpgate regardless of browse state.
const searchAll = resolveSftpHostMenuState({
  query: "1",
  browseSource: "local",
  browseGroupId: "g-prod",
  hostGroupsList: allGroups,
  hostsList: allHosts,
  translate,
});
assert.deepEqual(
  rows(searchAll.items, (item) => item.label),
  ["bastion", "pg-1", "web-1"],
  "search finds matching hosts across both ZeroTerm and Warpgate",
);

console.log("sftp-host-select.test.js: passed");
