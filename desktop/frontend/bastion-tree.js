// The remote hierarchy comes from the authorized catalog, never from local host groups or tags.
export function buildBastionTree(catalog, query = '') {
  const groups = new Map();
  for (const group of catalog.groups || []) {
    if (!group.id || groups.has(group.id)) continue;
    groups.set(group.id, { ...group, parent_id: group.parent_id || null });
  }
  for (const group of groups.values()) {
    if (!groups.has(group.parent_id)) group.parent_id = null;
    const seen = new Set([group.id]);
    let parent = group.parent_id;
    while (parent) {
      if (seen.has(parent)) { group.parent_id = null; break; }
      seen.add(parent);
      parent = groups.get(parent)?.parent_id;
    }
  }
  const needle = query.trim().toLocaleLowerCase();
  const matches = value => String(value || '').toLocaleLowerCase().includes(needle);
  const childrenByGroup = new Map(), assetsByGroup = new Map();
  for (const group of groups.values()) {
    if (!childrenByGroup.has(group.parent_id)) childrenByGroup.set(group.parent_id, []);
    childrenByGroup.get(group.parent_id).push(group);
  }
  for (const asset of catalog.assets || []) {
    const groupId = groups.has(asset.group_id) ? asset.group_id : null;
    if (!assetsByGroup.has(groupId)) assetsByGroup.set(groupId, []);
    assetsByGroup.get(groupId).push(asset);
  }
  function assetNode(asset, inheritedMatch = false) {
    const fullMatch = inheritedMatch || !needle || matches(`${asset.name} ${(asset.tags || []).join(' ')}`);
    const accounts = fullMatch ? asset.accounts : asset.accounts.filter(a => matches(`${a.username} ${a.capabilities.join(' ')}`));
    if (!accounts.length) return null;
    return { kind: 'asset', key: `asset:${asset.id}`, asset, accounts };
  }
  const sort = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name, undefined, { numeric: true });
  function groupNode(group, inheritedMatch = false) {
    const fullMatch = inheritedMatch || Boolean(needle && matches(group.name));
    const children = (childrenByGroup.get(group.id) || []).sort(sort).map(g => groupNode(g, fullMatch)).filter(Boolean);
    const assets = (assetsByGroup.get(group.id) || []).map(a => assetNode(a, fullMatch)).filter(Boolean);
    const count = assets.length + children.reduce((n, child) => n + child.count, 0);
    return count ? { kind: 'group', key: `group:${group.id}`, name: group.name, count, children: [...children, ...assets] } : null;
  }
  const roots = (childrenByGroup.get(null) || []).sort(sort).map(g => groupNode(g)).filter(Boolean);
  const ungrouped = (assetsByGroup.get(null) || []).map(a => assetNode(a)).filter(Boolean);
  if (ungrouped.length) roots.push({ kind: 'group', key: 'ungrouped', name: null, count: ungrouped.length, children: ungrouped });
  return roots;
}

export function installBastionTree({ invoke, refreshHosts, renderLocal, openLogin, openTerminal, openFiles, syncCustomSelect }) {
  const q = id => document.getElementById(id);
  const list = q('hosts-list'), search = q('host-search'), empty = q('hosts-empty');
  const localButton = q('asset-source-local'), remoteButton = q('asset-source-bastion');
  const picker = q('bastion-tree-profile'), toolbar = q('bastion-tree-toolbar');
  const refresh = q('bastion-tree-refresh'), status = q('bastion-tree-status'), login = q('bastion-tree-login');
  let source = 'local', profiles = [], catalog = null, state = 'idle', error = '', epoch = 0, opening = false;
  const expanded = new Set();
  const searchCollapsed = new Set();
  let previousQuery = '';
  let selected = '';
  const words = {
    zh: { local:'本地', bastion:'堡垒机', localPlaceholder:'搜索主机或分组…', source:'资产来源', choose:'选择堡垒机', manage:'配置堡垒机', refresh:'刷新资产', login:'登录堡垒机', loginHint:'登录后加载授权资产与分组', noProfiles:'尚未配置堡垒机', loading:'正在加载资产…', empty:'暂无授权资产', search:'没有匹配的资产或账号', retry:'重试', ungrouped:'未分组', terminal:'打开终端', files:'打开文件', profile:'堡垒机连接', placeholder:'搜索资产、分组或账号…', failed:'资产加载失败', opening:'正在连接…' },
    en: { local:'Local', bastion:'Bastion', localPlaceholder:'Search hosts or groups…', source:'Asset source', choose:'Select a bastion', manage:'Configure bastion', refresh:'Refresh assets', login:'Log in to bastion', loginHint:'Log in to load authorized assets and groups', noProfiles:'No bastion configured', loading:'Loading assets…', empty:'No authorized assets', search:'No matching assets or accounts', retry:'Retry', ungrouped:'Ungrouped', terminal:'Open terminal', files:'Open files', profile:'Bastion connection', placeholder:'Search assets, groups or accounts…', failed:'Failed to load assets', opening:'Connecting…' }
  };
  const w = key => words[document.documentElement.lang.startsWith('zh') ? 'zh' : 'en'][key];
  const icon = path => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true'); const p=document.createElementNS(svg.namespaceURI,'path'); p.setAttribute('d',path); svg.append(p); return svg; };
  const icons = { folder:'M3 7h6l2 2h10v10H3z', asset:'M3 3h18v7H3zM3 14h18v7H3zM7 6h.01M7 17h.01', account:'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 21v-2a8 8 0 0 1 16 0v2', terminal:'m4 6 5 6-5 6M12 18h8', files:'M3 7h6l2 2h10v10H3z' };
  function translate() {
    localButton.textContent = w('local'); remoteButton.textContent = w('bastion');
    q('asset-source-switch').setAttribute('aria-label', w('source'));
    picker.setAttribute('aria-label', w('profile'));
    refresh.title = w('refresh'); refresh.setAttribute('aria-label', w('refresh'));
    const selectedId = picker.value;
    picker.replaceChildren(...(profiles.length ? profiles.map(p => new Option(p.name, p.id)) : [new Option(w('choose'), '')]));
    picker.value = profiles.some(p => p.id === selectedId) ? selectedId : (profiles[0]?.id || '');
    syncCustomSelect(picker.id);
    const input = toolbar.querySelector('.zt-select-trigger-input');
    input?.setAttribute('aria-label', w('profile'));
    syncControls();
    if (source === 'bastion') render();
  }
  function syncControls() {
    const remote = source === 'bastion';
    list.classList.toggle('bastion-asset-tree', remote);
    localButton.setAttribute('aria-pressed', String(!remote)); remoteButton.setAttribute('aria-pressed', String(remote));
    toolbar.hidden = !remote; status.hidden = !remote || (state === 'ready' && !error && !opening);
    q('add-host-button').hidden = remote; q('add-group-button').hidden = remote;
    search.placeholder = w(remote ? 'placeholder' : 'localPlaceholder');
    refresh.disabled = state === 'loading' || !picker.value;
    picker.disabled = state === 'loading';
    const trigger = toolbar.querySelector('.zt-select-trigger');
    if (trigger) { trigger.tabIndex = state === 'loading' ? -1 : 0; trigger.setAttribute('aria-disabled', String(state === 'loading')); }
    const input = toolbar.querySelector('.zt-select-trigger-input');
    if (input) input.disabled = state === 'loading';
  }
  function render() {
    if (source !== 'bastion') return false;
    syncControls();
    const focusKey = document.activeElement?.dataset.bastionNode;
    list.replaceChildren(); empty.hidden = true;
    login.hidden = true;
    status.querySelector('p').textContent = state === 'loading' ? w('loading') : state === 'login' ? w('loginHint') : state === 'noProfiles' ? w('noProfiles') : state === 'error' ? `${w('failed')}: ${error}` : opening ? w('opening') : error;
    if (['login','noProfiles','error'].includes(state)) {
      login.hidden = false;
      login.textContent = state === 'error' ? w('retry') : state === 'noProfiles' ? w('manage') : w('login');
    }
    if (state !== 'ready' || !catalog) return true;
    const nodes = buildBastionTree(catalog, search.value);
    if (!nodes.length) {
      status.hidden = false;
      status.querySelector('p').textContent = search.value.trim() ? w('search') : w('empty');
      return true;
    }
    if (previousQuery !== search.value) { searchCollapsed.clear(); previousQuery = search.value; }
    function appendNode(node, container) {
      const li = document.createElement('li'); li.className = `bastion-tree-item bastion-tree-${node.kind}`;
      const row = document.createElement('button'); row.type = 'button'; row.className = 'bastion-tree-toggle'; row.dataset.bastionNode = node.key;
      const expansionKey = `${picker.value}:${node.key}`;
      const open = search.value.trim() ? !searchCollapsed.has(expansionKey) : expanded.has(expansionKey);
      row.setAttribute('aria-expanded', String(open));
      const caret = document.createElement('span'); caret.className = 'bastion-tree-caret'; caret.textContent = open ? '▾' : '▸';
      const label = document.createElement('span'); label.className = 'bastion-tree-name'; label.textContent = node.kind === 'group' ? node.name || w('ungrouped') : node.asset.name;
      row.title = label.textContent;
      const count = document.createElement('span'); count.className = 'bastion-tree-count'; count.textContent = String(node.kind === 'group' ? node.count : node.accounts.length);
      row.append(caret, icon(icons[node.kind === 'group' ? 'folder' : 'asset']), label, count); li.append(row);
      row.addEventListener('click', () => { const key = `${picker.value}:${node.key}`; if (search.value.trim()) { if (open) searchCollapsed.add(key); else searchCollapsed.delete(key); }
        else { if (open) expanded.delete(key); else expanded.add(key); } render(); focusNode(node.key); });
      const children = document.createElement('ul'); children.hidden = !open;
      const childNodes = node.kind === 'group' ? node.children : node.accounts;
      if (node.kind === 'group') childNodes.forEach(child => appendNode(child, children));
      else for (const account of childNodes) {
        const item = document.createElement('li'); item.className = 'bastion-tree-account';
        const key = `${picker.value}:${node.asset.id}:${account.id}`;
        if (selected === key) item.classList.add('selected');
        const identity = document.createElement('span'); identity.className = 'bastion-tree-name'; identity.textContent = account.username; identity.title = `${account.username} · ${account.capabilities.join(' / ')}`;
        item.append(icon(icons.account), identity);
        for (const [cap, labelKey, action] of [['shell','terminal',openTerminal], ['sftp','files',openFiles]]) {
          if (!account.capabilities.includes(cap)) continue;
          const control = document.createElement('button'); control.type = 'button'; control.className = 'workspace-icon-btn bastion-tree-connect';
          control.title = `${w(labelKey)} · ${account.username}`; control.setAttribute('aria-label', control.title); control.disabled = opening;
          control.append(icon(icons[labelKey]));
          control.addEventListener('click', () => connect(node.asset, account, action)); item.append(control);
        }
        if (account.capabilities.includes('shell')) item.addEventListener('dblclick', e => { if (!e.target.closest('button')) connect(node.asset, account, openTerminal); });
        children.append(item);
      }
      li.append(children); container.append(li);
    }
    nodes.forEach(node => appendNode(node, list));
    if (focusKey) focusNode(focusKey);
    return true;
  }
  function focusNode(key) { [...list.querySelectorAll('[data-bastion-node]')].find(el => el.dataset.bastionNode === key)?.focus({preventScroll:true}); }
  async function connect(asset, account, action) {
    if (opening) return;
    const profileId = picker.value, requestEpoch = epoch;
    opening = true; error = ''; selected = `${profileId}:${asset.id}:${account.id}`; render();
    try {
      const id = await invoke('bastion_save_asset', {profileId,assetId:asset.id,accountId:account.id});
      if (epoch !== requestEpoch) return;
      await refreshHosts();
      if (epoch !== requestEpoch) return;
      const hosts = await invoke('list_hosts');
      if (epoch !== requestEpoch) return;
      const host = hosts.find(h => h.id === id);
      if (!host) throw new Error('RESOURCE_NOT_FOUND');
      await action(host);
    } catch (e) {
      if (epoch === requestEpoch) { error = String(e); status.hidden = false; status.querySelector('p').textContent = error; }
    } finally { if (epoch === requestEpoch) { opening = false; if (source === 'bastion') render(); } }
  }
  async function load({ reloadProfiles = false, profileId = picker.value } = {}) {
    picker.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    const requestEpoch = ++epoch;
    catalog = null; opening = false; error = ''; state = 'loading'; render();
    try {
      if (reloadProfiles) {
        const next = await invoke('bastion_profiles');
        if (epoch !== requestEpoch) return;
        profiles = next; translate();
        if (profiles.some(p => p.id === profileId)) { picker.value = profileId; syncCustomSelect(picker.id); }
      }
      if (!picker.value) { state = 'noProfiles'; return; }
      const result = await invoke('bastion_catalog', {profileId:picker.value});
      if (epoch !== requestEpoch) return;
      catalog = result; state = 'ready'; error = '';
    } catch (e) {
      if (epoch !== requestEpoch) return;
      error = String(e);
      state = /UNAUTHENTICATED|SESSION_EXPIRED|SESSION_REVOKED|LOGIN_SESSION_REVOKED/.test(error) ? 'login' : 'error';
    } finally { if (epoch === requestEpoch) render(); }
  }
  function setSource(next) {
    if (next === source) return;
    picker.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    epoch++; opening = false; source = next; search.value = ''; syncControls();
    if (source === 'bastion') load({reloadProfiles:true});
    else { status.hidden = true; toolbar.hidden = true; renderLocal(); }
  }
  localButton.addEventListener('click', () => setSource('local'));
  remoteButton.addEventListener('click', () => setSource('bastion'));
  picker.addEventListener('change', () => { selected = ''; load(); });
  refresh.addEventListener('click', () => load({reloadProfiles:true}));
  login.addEventListener('click', () => state === 'error' ? load({reloadProfiles:true}) : openLogin(picker.value || undefined));
  list.addEventListener('keydown', e => {
    if (!e.target.matches('[data-bastion-node]')) return;
    const rows = [...list.querySelectorAll('[data-bastion-node]')].filter(el => el.offsetParent !== null);
    const i = rows.indexOf(e.target);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'ArrowRight' && e.target.getAttribute('aria-expanded') === 'false') {
      e.preventDefault(); e.target.click();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (e.target.getAttribute('aria-expanded') === 'true') e.target.click();
      else e.target.closest('ul')?.closest('.bastion-tree-item')?.querySelector('.bastion-tree-toggle')?.focus();
    }
  });
  document.getElementById('lock-button').addEventListener('click', () => {
    picker.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    epoch++; catalog = null; profiles = []; expanded.clear(); selected = ''; opening = false; error = ''; state = 'idle'; source = 'local'; search.value = ''; list.replaceChildren(); translate();
  });
  translate();
  return {
    render, translate,
    change({ type, profileId }) {
      if (['logout','loginStart'].includes(type) && profileId !== picker.value) return;
      // Drop snapshots immediately on logout/profile edits; in-flight requests cannot restore them.
      epoch++; catalog = null; opening = false;
      state = ['logout','loginStart'].includes(type) ? 'login' : 'idle'; error = '';
      if (source !== 'bastion') return;
      if (['logout','loginStart'].includes(type)) { render(); return; }
      load({reloadProfiles:true, profileId});
    }
  };
}
