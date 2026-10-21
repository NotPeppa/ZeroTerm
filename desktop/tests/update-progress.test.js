const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../frontend/main.js'), 'utf8');

function fixture() {
  const context = {
    Math, Number, updateInstallInProgress: false, updateCheckInProgress: false,
    latestUpdateInfo: { available: true },
    t: (key, values) => key + (values ? JSON.stringify(values) : ''),
    formatSize: n => `${n} B`, showToast() {}, loadAppVersion: async () => '1.0',
    runSyncButtonAction: async (_button, _label, action) => action(),
    window: { __TAURI__: { core: { Channel: class {} } } },
  };
  for (const name of ['updateDialogProgress', 'updateDialogProgressStatus', 'updateDialogProgressBar',
    'updateDialogCancel', 'updateDialogConfirm', 'updateDialogOverlay', 'settingsUpdateStatus',
    'settingsUpdateCheck', 'settingsUpdateInstall']) {
    context[name] = {
      hidden: false, disabled: false, value: 0,
      removeAttribute(name) { delete this[name]; },
      addEventListener(_event, handler) { this.handler = handler; },
    };
  }
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function renderUpdateProgress('),
    source.indexOf('\nsettingsUpdateCheck?.addEventListener')), context);
  vm.runInContext(source.slice(source.indexOf('updateDialogConfirm?.addEventListener("click", async'),
    source.indexOf('\nsettingsGeneralSubtabBasic?.addEventListener')), context);
  return context;
}

test('update progress handles known size, unknown size and installation', () => {
  const c = fixture();
  c.renderUpdateProgress({ phase: 'downloading', downloaded: 25, total: 100 });
  assert.equal(c.updateDialogProgressBar.value, 25);
  assert.match(c.updateDialogProgressStatus.textContent, /25%|"percent":25/);
  c.renderUpdateProgress({ phase: 'downloading', downloaded: 30 });
  assert.equal('value' in c.updateDialogProgressBar, false);
  assert.match(c.updateDialogProgressStatus.textContent, /downloading_unknown/);
  c.renderUpdateProgress({ phase: 'installing' });
  assert.equal(c.updateDialogProgressBar.value, 100);
  assert.match(c.updateDialogProgressStatus.textContent, /installing/);
});

test('installation registers progress before invoking and blocks duplicate requests', async () => {
  const c = fixture();
  let finish, calls = 0;
  c.invoke = async (command, { onProgress }) => {
    assert.equal(command, 'install_update');
    calls++;
    onProgress.onmessage({ phase: 'downloading', downloaded: 50, total: 100 });
    await new Promise(resolve => { finish = resolve; });
    throw new Error('network interrupted');
  };
  const pending = c.updateDialogConfirm.handler();
  assert.equal(c.updateDialogProgressBar.value, 50);
  assert.equal(c.updateDialogCancel.disabled, true);
  await c.updateDialogConfirm.handler();
  assert.equal(calls, 1);
  finish();
  await pending;
  assert.equal(c.updateInstallInProgress, false);
  assert.equal(c.updateDialogCancel.disabled, false);
  assert.equal(c.settingsUpdateCheck.disabled, false);
  assert.match(c.updateDialogProgressStatus.textContent, /network interrupted/);
  assert.equal(c.updateDialogProgressBar.hidden, true);
  c.renderUpdateProgress({ phase: 'preparing' });
  assert.equal(c.updateDialogProgressBar.hidden, false);
  assert.equal('value' in c.updateDialogProgressBar, false);
});

test('already latest response clears obsolete update and closes dialog', async () => {
  const c = fixture();
  c.invoke = async () => 'already_latest';
  await c.updateDialogConfirm.handler();
  assert.equal(c.latestUpdateInfo, null);
  assert.equal(c.settingsUpdateInstall.disabled, true);
  assert.equal(c.updateDialogOverlay.hidden, true);
  assert.match(c.settingsUpdateStatus.textContent, /latest/);
});
