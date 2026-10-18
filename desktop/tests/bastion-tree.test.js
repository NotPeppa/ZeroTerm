const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../frontend/bastion-tree.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const account = (id, username, capabilities = ['shell', 'sftp']) => ({ id, username, capabilities });
const asset = (id, group_id, accounts = [account('deploy-id', 'deploy')]) => ({ id, name:id, group_id, tags:['production'], accounts });
function allAssets(nodes) { return nodes.flatMap(n => n.kind === 'asset' ? [n.asset.id] : allAssets(n.children)); }

test('legacy assets remain ungrouped; tags never invent server groups', async () => {
  const { buildBastionTree } = await modulePromise;
  const tree = buildBastionTree({assets:[asset('server', null)],groups:[]});
  assert.equal(tree[0].key, 'ungrouped');
  assert.deepEqual(allAssets(tree), ['server']);
  assert.equal(tree[0].children[0].accounts[0].username, 'deploy');
});

test('remote hierarchy retains parent groups, server order and all target accounts', async () => {
  const { buildBastionTree } = await modulePromise;
  const tree = buildBastionTree({groups:[
    {id:'production',name:'Production'},
    {id:'apps',name:'Applications',parent_id:'production',sort_order:2},
    {id:'db',name:'Databases',parent_id:'production',sort_order:1},
    {id:'empty',name:'Empty'}
  ], assets:[asset('app-01','apps',[account('a','deploy'),account('b','files',['sftp'])]),asset('db-01','db')]});
  assert.equal(tree.length, 1);
  assert.equal(tree[0].count, 2);
  assert.deepEqual(tree[0].children.map(g=>g.key), ['group:db','group:apps']);
  assert.deepEqual(tree[0].children[1].children[0].accounts.map(a=>a.username), ['deploy','files']);
});

test('search keeps ancestor groups and filters target accounts without changing the catalog', async () => {
  const { buildBastionTree } = await modulePromise;
  const catalog = { groups:[{id:'root',name:'Production'},{id:'apps',name:'Applications',parent_id:'root'}], assets:[asset('app-01','apps',[account('a','deploy'),account('b','files',['sftp'])])] };
  const tree = buildBastionTree(catalog,'files');
  assert.equal(tree[0].key, 'group:root');
  assert.deepEqual(tree[0].children[0].children[0].accounts.map(a=>a.username), ['files']);
  assert.equal(catalog.assets[0].accounts.length,2);
  assert.equal(buildBastionTree(catalog,'Production')[0].children[0].children[0].accounts.length,2);
  assert.deepEqual(buildBastionTree(catalog,'missing'),[]);
});

test('cycles, missing parents and unknown group references never drop or duplicate assets', async () => {
  const { buildBastionTree } = await modulePromise;
  const tree = buildBastionTree({groups:[{id:'a',name:'A',parent_id:'b'},{id:'b',name:'B',parent_id:'a'},{id:'orphan',name:'Orphan',parent_id:'missing'}], assets:[asset('one','a'),asset('two','b'),asset('three','orphan'),asset('four','missing')]});
  assert.deepEqual(allAssets(tree).sort(), ['four','one','three','two']);
  assert.equal(tree.find(n=>n.key==='ungrouped').count,1);
});

test('RFC-006 account labels are displayed and searchable; username remains the fallback', async () => {
  const { buildBastionTree, accountLabel } = await modulePromise;
  const labelled = { id:'l', label:'Deploy (prod)', username:'deploy', domain:null, credential_kind:'password', capabilities:['shell'] };
  assert.equal(accountLabel(labelled), 'Deploy (prod)');
  assert.equal(accountLabel({ ...labelled, label:' ' }), 'deploy');
  assert.equal(accountLabel(account('x', 'root')), 'root');
  const catalog = { groups:[], assets:[asset('app-01', null, [labelled, account('o', 'ops')])] };
  assert.deepEqual(buildBastionTree(catalog, '(prod)')[0].children[0].accounts.map(a => a.id), ['l']);
  assert.deepEqual(buildBastionTree(catalog, 'deploy')[0].children[0].accounts.map(a => a.id), ['l']);
});

test('servers without a native SSH entry get an explicit message that keeps the code', async () => {
  const { explainBastionError } = await modulePromise;
  const zh = explainBastionError('NATIVE_ENTRY_UNAVAILABLE (request_id: )', 'zh-CN');
  assert.match(zh, /该堡垒机未开启 ZeroTerm 原生 SSH 入口/);
  assert.match(zh, /NATIVE_ENTRY_UNAVAILABLE/);
  assert.match(explainBastionError('NATIVE_ENTRY_UNAVAILABLE', 'en'), /native SSH entry/);
  assert.equal(explainBastionError('PERMISSION_DENIED (request_id: x)', 'zh'), 'PERMISSION_DENIED (request_id: x)');
});

test('refused native capabilities get an explicit message that keeps the code', async () => {
  const { explainBastionError } = await modulePromise;
  assert.equal(explainBastionError('CHANNEL_PERMISSION_DENIED: sftp', 'zh-CN'), '该堡垒机暂未开放文件传输 (CHANNEL_PERMISSION_DENIED: sftp)');
  assert.match(explainBastionError('{"code":"CHANNEL_PERMISSION_DENIED","message":"CHANNEL_PERMISSION_DENIED: exec"}', 'en'), /not opened server tools \(exec\)/);
  assert.match(explainBastionError('CHANNEL_PERMISSION_DENIED: shell', 'en'), /terminal access/);
  assert.match(explainBastionError('CHANNEL_PERMISSION_DENIED (request_id: r1)', 'zh'), /暂未开放此账号的原生 SSH 能力.*request_id: r1/);
  assert.match(explainBastionError('CHANNEL_PERMISSION_DENIED: sftp', undefined), /file transfer/);
});

// RFC-006 grants are all-or-nothing, so bastion favorites need no capability snapshot to be
// offered by the SFTP pane pickers; the ticket decides at open time.
test('SFTP host pickers list bastion favorites alongside local hosts', () => {
  const main = fs.readFileSync(path.join(__dirname, '../frontend/main.js'), 'utf8');
  const start = main.indexOf('function syncSftpHostOptions');
  const end = main.indexOf('\nfunction ensureDefaultSftpPaneState', start);
  assert.ok(start > 0 && end > start, 'syncSftpHostOptions not found');
  const element = () => ({ children: [], dataset: {}, appendChild(child) { this.children.push(child); }, set innerHTML(_) { this.children = []; } });
  const pane = { key: 'right', hostId: '', hostSelect: element() };
  const vm = require('node:vm');
  const context = {
    sftpPanes: { right: pane },
    hostsCache: [
      { id: 'plain', name: 'web-01', user: 'root', host: 'web', port: 22, authType: 'password' },
      { id: 'fav', name: 'Target A · Deploy', user: 'deploy', host: 'gateway', port: 2222, authType: 'bastion' },
    ],
    LOCAL_HOST_ID: 'local',
    isTerminalSideSftpPane: () => false,
    t: key => key,
    syncCustomSelect: () => {},
    document: { createElement: element },
  };
  vm.runInNewContext(`${main.slice(start, end)}\nsyncSftpHostOptions();`, context);
  assert.deepEqual(pane.hostSelect.children.map(o => o.value), ['', 'local', 'plain', 'fav']);
  assert.ok(!/authType\s*!==\s*"bastion"/.test(main.slice(main.indexOf('function buildCustomSelect'), main.indexOf('function buildCustomSelect') + 6000)), 'the custom host menu must not filter bastion favorites');
});
