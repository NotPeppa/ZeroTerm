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
