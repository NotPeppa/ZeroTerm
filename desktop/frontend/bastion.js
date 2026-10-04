// Only public metadata crosses IPC. Login tokens and SSH tickets remain in Rust.
export function installBastion({ invoke, refreshHosts, openTerminal, openFiles, syncCustomSelect, onChange }) {
  const button = document.getElementById('bastion-button');
  const overlay = document.createElement('div');
  overlay.id = 'bastion-overlay';
  overlay.className = 'overlay';
  overlay.hidden = true;
  overlay.innerHTML = `<section class="dialog bastion-dialog" role="dialog" aria-modal="true" aria-labelledby="bastion-title">
    <header class="bastion-header">
      <div><h3 id="bastion-title"></h3><p data-label="subtitle"></p></div>
      <button type="button" class="bastion-close" data-action="close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    </header>
    <div class="bastion-body">
    <div class="bastion-profile-picker">
      <div class="bastion-profile-field"><label id="bastion-profiles-label" for="bastion-profiles" data-label="connection"></label><select id="bastion-profiles" aria-labelledby="bastion-profiles-label"></select></div>
      <div class="dialog-actions bastion-actions"><button type="button" data-action="new" data-label="new"></button><button type="button" class="bastion-delete" data-action="delete" data-label="delete"></button></div>
    </div>
    <details id="bastion-config" class="bastion-section" open>
      <summary><span data-label="config"></span><span id="bastion-endpoint"></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></summary>
      <form id="bastion-profile-form" class="bastion-form">
        <p class="bastion-wide bastion-help" data-label="configHint"></p>
        <label><span data-label="name"></span><input type="text" name="name" required autocomplete="off"></label>
        <label><span>HTTPS URL</span><input type="url" name="api_url" required placeholder="https://bastion.example.com" autocomplete="off"></label>
        <label><span>server_id</span><input type="text" name="server_id" required autocomplete="off"></label>
        <label><span>SSH Host</span><input type="text" name="ssh_host" required autocomplete="off"></label>
        <label><span>SSH Port</span><input type="number" name="ssh_port" min="1" max="65535" required value="2222"></label>
        <label><span data-label="fingerprint"></span><input type="text" name="ssh_host_key_sha256" required placeholder="SHA256:…" autocomplete="off"></label>
        <label class="bastion-wide"><span data-label="ca"></span><textarea name="ca_pem" rows="2" placeholder="-----BEGIN CERTIFICATE-----" autocomplete="off" spellcheck="false"></textarea></label>
        <div class="dialog-actions bastion-actions bastion-wide"><button type="submit" class="primary" data-label="save"></button></div>
      </form>
    </details>
    <section class="bastion-section bastion-login" aria-labelledby="bastion-login-title">
      <h4 id="bastion-login-title" data-label="account"></h4>
      <p id="bastion-login-hint" class="bastion-help" data-label="saveFirst"></p>
      <form id="bastion-login-form" class="bastion-form">
        <label><span data-label="username"></span><input type="text" name="username" autocomplete="username" required></label>
        <label><span data-label="password"></span><input type="password" name="password" autocomplete="off" required></label>
        <div class="dialog-actions bastion-actions"><button type="submit" class="primary" data-label="login"></button></div>
      </form>
    </section>
    <section class="bastion-section bastion-catalog" aria-labelledby="bastion-assets-title">
      <header class="bastion-assets-header"><h4 id="bastion-assets-title" data-label="assets"></h4><div class="dialog-actions bastion-actions"><button type="button" data-action="refresh" data-label="refresh"></button><button type="button" data-action="logout" data-label="logout"></button></div></header>
      <div id="bastion-assets" class="bastion-assets"></div>
    </section>
    <p id="bastion-message" role="status" aria-live="polite" hidden></p>
    <p class="bastion-security" data-label="hint"></p>
    </div>
  </section>`;
  document.body.append(overlay);
  const q = selector => overlay.querySelector(selector);
  const profileForm = q('#bastion-profile-form');
  const loginForm = q('#bastion-login-form');
  const select = q('#bastion-profiles');
  const message = q('#bastion-message');
  const assetsEl = q('#bastion-assets');
  let profiles = [], busy = false, previousFocus = null;
  let requestedProfileId;
  const words = {
    en: { title:'Bastion', subtitle:'Manage connections and authorized assets', close:'Close', connection:'Bastion connection', choose:'Select or create a connection', new:'New connection', delete:'Delete', config:'Connection configuration', configHint:'Verify the server ID, SSH address and fingerprint with your administrator.', name:'Name', fingerprint:'Verified SSH SHA256 fingerprint', ca:'Private TLS CA PEM (optional)', save:'Save configuration', account:'Account login', username:'Username', password:'Password', login:'Log in', logout:'Log out', refresh:'Refresh', assets:'Authorized assets', favorite:'Save to hosts', terminal:'Terminal', files:'Files', empty:'No authorized assets', waiting:'Log in to view available assets', saveFirst:'Save the connection configuration before logging in.', saved:'Saved', loading:'Loading…', saving:'Saving configuration…', loggingIn:'Logging in…', loggingOut:'Logging out…', deleting:'Deleting connection…', opening:'Opening connection…', hint:'Login stays in memory; log in again after locking the vault or restarting. The gateway can read and record target sessions.' },
    zh: { title:'堡垒机', subtitle:'管理连接配置与授权资产', close:'关闭', connection:'堡垒机连接', choose:'选择或新建连接', new:'新增连接', delete:'删除', config:'连接配置', configHint:'请向管理员核验 server_id、SSH 地址和指纹。', name:'名称', fingerprint:'已核验的 SSH SHA256 指纹', ca:'私有 TLS CA PEM（可选）', save:'保存配置', account:'账户登录', username:'用户名', password:'密码', login:'登录', logout:'注销', refresh:'刷新', assets:'授权资产', favorite:'加入主机列表', terminal:'终端', files:'文件', empty:'暂无授权资产', waiting:'登录后查看可用资产', saveFirst:'保存连接配置后，即可登录并获取授权资产。', saved:'已保存', loading:'正在加载…', saving:'正在保存配置…', loggingIn:'正在登录…', loggingOut:'正在注销…', deleting:'正在删除连接…', opening:'正在打开连接…', hint:'登录状态仅保存在内存，锁定 Vault 或重启后需重新登录。网关可读取并录制目标会话。' }
  };
  const w = key => words[document.documentElement.lang.startsWith('zh') ? 'zh' : 'en'][key] || key;
  function translate() {
    q('#bastion-title').textContent = w('title');
    overlay.querySelectorAll('[data-label]').forEach(el => el.textContent = w(el.dataset.label));
    q('[data-action="close"]').setAttribute('aria-label', w('close'));
    q('[data-action="close"]').title = w('close');
    button.title = w('title');
    button.setAttribute('aria-label', w('title'));
  }
  function setMessage(text = '', state = '') {
    message.textContent = text;
    message.hidden = !text;
    message.dataset.state = state;
  }
  function showEmpty(key = 'waiting') {
    const empty = document.createElement('div');
    empty.className = 'bastion-empty';
    empty.textContent = w(key);
    assetsEl.replaceChildren(empty);
  }
  function syncControls() {
    overlay.querySelectorAll('button, input, select, textarea').forEach(el => el.disabled = busy);
    const needsProfile = busy || !select.value;
    q('[data-action="delete"]').disabled = needsProfile;
    q('[data-action="logout"]').disabled = needsProfile;
    q('[data-action="refresh"]').disabled = needsProfile;
    loginForm.querySelectorAll('input, button').forEach(el => el.disabled = needsProfile);
    loginForm.hidden = !select.value;
    q('.bastion-catalog').hidden = !select.value;
    q('#bastion-login-hint').hidden = Boolean(select.value);
    q('.bastion-dialog').setAttribute('aria-busy', String(busy));
    const trigger = q('.zt-select-trigger');
    if (trigger) {
      trigger.tabIndex = busy ? -1 : 0;
      trigger.setAttribute('aria-disabled', String(busy));
      q('.zt-select-trigger-input').setAttribute('aria-labelledby', 'bastion-profiles-label');
    }
  }
  function syncPicker() {
    syncCustomSelect?.(select.id);
    syncControls();
  }
  function fillProfile() {
    const p = profiles.find(p => p.id === select.value);
    profileForm.reset();
    q('#bastion-config').open = !p;
    q('#bastion-endpoint').textContent = p ? `${p.ssh_host}:${p.ssh_port}` : '';
    for (const name of ['name','api_url','server_id','ssh_host','ssh_port','ssh_host_key_sha256','ca_pem']) {
      profileForm.elements[name].value = p?.[name] ?? (name === 'ssh_port' ? 2222 : '');
    }
    showEmpty();
    loginForm.reset();
    setMessage();
    syncPicker();
  }
  async function loadProfiles(id = select.value || undefined) {
    profiles = await invoke('bastion_profiles');
    select.replaceChildren(new Option(w('choose'), ''));
    profiles.forEach(p => select.add(new Option(p.name, p.id)));
    select.value = profiles.some(p => p.id === id) ? id : (profiles[0]?.id ?? '');
    // An explicit empty selection starts a new configuration.
    if (id === '') select.value = '';
    fillProfile();
  }
  async function run(action, progress = 'loading') {
    if (busy) return;
    busy = true;
    select.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    setMessage(w(progress), 'loading');
    syncControls();
    try {
      await action();
      if (message.dataset.state === 'loading') setMessage();
    } catch (e) {
      setMessage(String(e), 'error');
    } finally {
      busy = false;
      syncControls();
    }
  }
  const currentId = () => { if (!select.value) throw new Error(w('saveFirst')); return select.value; };
  async function saveAsset(asset, account) {
    const id = await invoke('bastion_save_asset', {profileId:currentId(),assetId:asset.id,accountId:account.id});
    await refreshHosts();
    const hosts = await invoke('list_hosts');
    return hosts.find(h => h.id === id);
  }
  async function loadAssets() {
    const assets = await invoke('bastion_assets', {profileId:currentId()});
    assetsEl.replaceChildren();
    for (const asset of assets) for (const account of asset.accounts) {
      const row = document.createElement('div');
      row.className = 'bastion-asset';
      const identity = document.createElement('div');
      identity.className = 'bastion-asset-identity';
      const name = document.createElement('strong');
      name.textContent = asset.name;
      const accountInfo = document.createElement('span');
      accountInfo.textContent = `${account.username} · ${account.capabilities.join(' / ')}`;
      identity.append(name, accountInfo);
      const actions = document.createElement('div');
      actions.className = 'dialog-actions bastion-actions';
      for (const [labelKey, allowed, action] of [
        ['favorite',true,async () => { setMessage(w('saved'), 'success'); }],
        ['terminal',account.capabilities.includes('shell'),async host => { close(); await openTerminal(host); }],
        ['files',account.capabilities.includes('sftp'),async host => { close(); await openFiles(host); }]
      ]) {
        if (!allowed) continue;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = w(labelKey);
        b.addEventListener('click', () => run(async () => action(await saveAsset(asset, account)), 'opening'));
        actions.append(b);
      }
      row.append(identity, actions);
      assetsEl.append(row);
    }
    if (!assetsEl.childElementCount) showEmpty('empty');
    setMessage();
  }
  function close() {
    select.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    overlay.hidden = true;
    loginForm.elements.password.value = '';
    assetsEl.replaceChildren();
    previousFocus?.focus();
  }
  button.addEventListener('click', async () => {
    previousFocus = document.activeElement;
    translate();
    overlay.hidden = false;
    q('.bastion-body').scrollTop = 0;
    const profileId = requestedProfileId;
    requestedProfileId = undefined;
    await run(() => loadProfiles(profileId));
    if (!overlay.hidden) q('[data-action="close"]').focus();
  });
  select.addEventListener('change', fillProfile);
  q('[data-action="close"]').addEventListener('click', close);
  q('[data-action="new"]').addEventListener('click', () => {
    select.value = '';
    fillProfile();
    profileForm.elements.name.focus();
  });
  q('[data-action="delete"]').addEventListener('click', () => run(async () => {
    const profileId = currentId();
    await invoke('bastion_delete_profile', {profileId});
    onChange?.({type:'delete', profileId});
    await loadProfiles('');
  }, 'deleting'));
  q('[data-action="logout"]').addEventListener('click', () => run(async () => {
    const profileId = currentId();
    await invoke('bastion_logout', {profileId});
    onChange?.({type:'logout', profileId});
    showEmpty();
    setMessage();
  }, 'loggingOut'));
  q('[data-action="refresh"]').addEventListener('click', () => run(async () => {
    await loadAssets();
    onChange?.({type:'catalog', profileId:currentId()});
  }));
  profileForm.addEventListener('submit', e => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(profileForm));
    values.id = select.value;
    values.ssh_port = Number(values.ssh_port);
    values.ca_pem ||= null;
    run(async () => {
      const id = await invoke('bastion_save_profile', {profile:values});
      onChange?.({type:'profile', profileId:id});
      await loadProfiles(id);
      setMessage(w('saved'), 'success');
    }, 'saving').then(() => { if (!overlay.hidden && select.value) loginForm.elements.username.focus(); });
  });
  loginForm.addEventListener('submit', e => {
    e.preventDefault();
    const username = loginForm.elements.username.value, password = loginForm.elements.password.value;
    loginForm.elements.password.value = '';
    run(async () => {
      const profileId = currentId();
      onChange?.({type:'loginStart', profileId});
      await invoke('bastion_login', {profileId,username,password});
      onChange?.({type:'login', profileId});
      await loadAssets();
    }, 'loggingIn');
  });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (q('.zt-select-trigger')?.getAttribute('aria-expanded') === 'true') {
        select.closest('.zt-select-wrap').dispatchEvent(new CustomEvent('zt-select-close'));
      } else if (!busy) close();
    }
    if (e.key === 'Tab') {
      const controls = [...overlay.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')]
        .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null);
      const first = controls[0], last = controls.at(-1);
      if (!controls.length) { e.preventDefault(); return; }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  // Vault lock removes login state in Rust. Clear any displayed asset snapshot too.
  document.getElementById('lock-button').addEventListener('click', close);
  return { open: profileId => { requestedProfileId = profileId; button.click(); } };
}
