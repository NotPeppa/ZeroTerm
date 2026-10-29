const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "../frontend/main.js"), "utf8");
const start = source.indexOf("async function saveHostForm(");
const end = source.indexOf("\n// --------------------------------------------------------------------------", start);
assert.ok(start >= 0 && end > start);

async function save({ type = "password", originalType = type, password = "", key = null,
  passphrase = "", masterPassword = "master", reject = false, creating = false } = {}) {
  const calls = [];
  const errors = [];
  let prompts = 0;
  let closed = false;
  const context = {
    editingHostId: creating ? null : "host-1", editingHostAuthType: originalType,
    hostError: {}, hostOverlay: { hidden: false },
    hfAuthType: { value: type }, hfPassword: { value: password },
    hfName: { value: "Host" }, hfHost: { value: "example.com" },
    hfPort: { value: "22" }, hfUser: { value: "root" },
    hfGroup: { value: "", dataset: {} }, hfJump: { value: "" },
    buildKeyAuth: async () => ({ type: "private_key", key_pem: key, passphrase }),
    requestHostSecretRevealPassword: async (forUpdate) => {
      assert.equal(forUpdate, true);
      prompts++;
      return masterPassword;
    },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (reject) throw new Error("verification failed");
    },
    showHostError: (error) => errors.push(error),
    closeHostEditor: () => { closed = true; },
    autoSyncAfterDataChange() {}, enterHosts: async () => {}, t: (key) => key,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.saveHostForm({ preventDefault() {} });
  return { calls, errors, prompts, closed };
}

test("credential changes require master-password confirmation", async () => {
  for (const options of [
    { password: "replacement" },
    { type: "key", key: "replacement-key" },
    { type: "key", passphrase: "replacement-passphrase" },
    { type: "agent", originalType: "password" },
  ]) {
    const result = await save(options);
    assert.equal(result.prompts, 1);
    assert.equal(result.calls[0].command, "update_host");
    assert.equal(result.calls[0].args.masterPassword, "master");
    assert.equal(result.closed, true);
  }
});

test("cancelled verification does not update or close the editor", async () => {
  const result = await save({ password: "replacement", masterPassword: null });
  assert.equal(result.calls.length, 0);
  assert.equal(result.closed, false);
});

test("failed verification leaves the editor open with an error", async () => {
  const result = await save({ password: "replacement", reject: true });
  assert.equal(result.closed, false);
  assert.match(result.errors[0], /verification failed/);
});

test("ordinary edits preserve credentials without prompting", async () => {
  for (const type of ["password", "key", "agent"]) {
    const result = await save({ type });
    assert.equal(result.prompts, 0);
    assert.equal(result.calls[0].args.masterPassword, null);
    assert.equal(result.closed, true);
  }
});

test("new hosts do not require credential-update verification", async () => {
  const result = await save({ creating: true, password: "initial" });
  assert.equal(result.prompts, 0);
  assert.equal(result.calls[0].command, "save_host");
});
