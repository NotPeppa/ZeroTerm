// Saved passwords never return over IPC. Login tokens and SSH tickets remain in Rust.
export function installBastion({ invoke, syncCustomSelect, onChange }) {
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
        <label><span>HTTPS URL</span><input type="url" name="api_url" required placeholder="https://bastion.example.com" autocomplete="off"></label>
        <label><span data-label="name"></span><input type="text" name="name" autocomplete="off" data-placeholder="namePlaceholder"></label>
        <label><span data-label="username"></span><input type="text" name="username" autocomplete="username" required></label>
        <label><span data-label="password"></span><input type="password" name="password" autocomplete="off" required></label>
        <label class="bastion-wide bastion-remember"><input type="checkbox" name="remember_password" checked><span data-label="rememberPassword"></span></label>
        <details class="bastion-wide bastion-advanced"><summary data-label="advanced"></summary>
          <label><span data-label="ca"></span><textarea name="ca_pem" rows="3" placeholder="-----BEGIN CERTIFICATE-----" autocomplete="off" spellcheck="false"></textarea></label>
        </details>
        <div id="bastion-trust" class="bastion-wide bastion-trust" aria-live="polite" hidden>
          <p class="bastion-trust-title" data-role="trust-title"></p>
          <dl><dt>server_id</dt><dd data-field="server_id"></dd><dt data-label="sshEntry"></dt><dd data-field="ssh_entry"></dd><dt data-label="fingerprint"></dt><dd data-field="ssh_host_key_sha256"></dd></dl>
          <p class="bastion-help" data-role="trust-note"></p>
        </div>
        <div class="dialog-actions bastion-actions bastion-wide"><button type="button" data-action="cancel-probe" data-label="cancel" hidden></button><button type="button" data-action="logout" data-label="logout" hidden></button><button type="submit" name="save_only" formnovalidate data-action="save" data-label="save" hidden></button><button type="submit" class="primary" data-role="submit"></button></div>
      </form>
    </details>
    <p id="bastion-message" role="status" aria-live="polite" hidden></p>
    <p class="bastion-security" data-label="hint"></p>
    </div>
  </section>`;
  document.body.append(overlay);
  const q = selector => overlay.querySelector(selector);
  const profileForm = q('#bastion-profile-form');
  const select = q('#bastion-profiles');
  const message = q('#bastion-message');
  let profiles = [], busy = false, previousFocus = null;
  let requestedProfileId;
  // Unsaved profile read from /info, shown for confirmation before it is pinned.
  let pending = null;
  const words = {
    en: { title:'Bastion', subtitle:'Manage connections and accounts', close:'Close', connection:'Bastion connection', choose:'Select or create a connection', new:'New connection', delete:'Delete', config:'Connection configuration', configHint:'Enter the address and account together. Verify the bastion identity, then confirm to save and log in.', name:'Name (optional)', namePlaceholder:'Defaults to the host name', advanced:'Advanced: private certificate authority', fingerprint:'SSH host-key fingerprint', sshEntry:'SSH entry', ca:'Private TLS CA PEM (only for a self-signed or internal CA)', save:'Save', probe:'Read and verify', confirmLogin:'Confirm and log in', saveLogin:'Save and log in', rememberPassword:'Save password in encrypted Vault', savedPassword:'Saved password; leave empty to keep it', cancel:'Cancel', probing:'Reading bastion identity…', trustPending:'Confirm the bastion identity', trustSaved:'Pinned bastion identity', trustNote:'Read from the bastion over verified HTTPS. Compare with your administrator if unsure; once saved, any later change is refused.', trustSavedNote:'Connections are refused if the bastion reports a different server ID, SSH entry or host key.', identityChanged:'The bastion identity has changed. Connection refused; saved trust was preserved. Verify the change with your administrator.', trustChanged:'Differs from the saved values. Confirm the reason with your administrator before saving.', username:'Username', password:'Password', logout:'Log out', saveFirst:'Select a bastion connection.', saved:'Saved', loading:'Loading…', saving:'Saving configuration…', loggingIn:'Logging in…', loggingOut:'Logging out…', deleting:'Deleting connection…', hint:'Saved accounts are available after unlocking Vault. The gateway can read and record target sessions.' },
    zh: { title:'堡垒机', subtitle:'管理连接配置与账户', close:'关闭', connection:'堡垒机连接', choose:'选择或新建连接', new:'新增连接', delete:'删除', config:'连接配置', configHint:'填写地址与账户，核验堡垒机身份后，确认即可保存并登录。', name:'名称（可选）', namePlaceholder:'默认使用主机名', advanced:'高级：私有证书颁发机构', fingerprint:'SSH 主机密钥指纹', sshEntry:'SSH 入口', ca:'私有 TLS CA PEM（仅自签或内网证书需要）', save:'保存', probe:'读取并核验', confirmLogin:'确认并登录', saveLogin:'保存并登录', rememberPassword:'将密码保存到加密 Vault', savedPassword:'密码已保存，留空继续使用', cancel:'取消', probing:'正在读取堡垒机身份…', trustPending:'请确认堡垒机身份', trustSaved:'已固定的堡垒机身份', trustNote:'以上信息通过已校验证书的 HTTPS 读取；如有疑问请与管理员核对。保存后若发生变化将拒绝连接。', trustSavedNote:'如果堡垒机返回的 server_id、SSH 入口或主机密钥与此不同，连接会被拒绝。', identityChanged:'堡垒机身份已变化，已拒绝连接并保留原有信任配置。请与管理员核实变更。', trustChanged:'与已保存的值不同，请先向管理员确认原因再保存。', username:'用户名', password:'密码', logout:'注销', saveFirst:'请选择堡垒机连接。', saved:'已保存', loading:'正在加载…', saving:'正在保存配置…', loggingIn:'正在登录…', loggingOut:'正在注销…', deleting:'正在删除连接…', hint:'解锁 Vault 后可使用已保存的账户登录。网关可读取并录制目标会话。' }
  };
  const w = key => words[document.documentElement.lang.startsWith('zh') ? 'zh' : 'en'][key] || key;
  function translate() {
    q('#bastion-title').textContent = w('title');
    overlay.querySelectorAll('[data-label]').forEach(el => el.textContent = w(el.dataset.label));
    overlay.querySelectorAll('[data-placeholder]').forEach(el => el.placeholder = w(el.dataset.placeholder));
    renderTrust();
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
  function syncControls() {
    overlay.querySelectorAll('button, input, select, textarea').forEach(el => el.disabled = busy);
    const needsProfile = busy || !select.value;
    q('[data-action="delete"]').disabled = needsProfile;
    q('[data-action="logout"]').disabled = needsProfile;
    q('[data-action="logout"]').hidden = !select.value;
    const useSaved = canUsePassword();
    profileForm.elements.password.required = !useSaved;
    profileForm.elements.password.placeholder = useSaved ? w('savedPassword') : '';
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
  const currentProfile = () => profiles.find(p => p.id === select.value);
  const sshEntry = p => `${p.ssh_host.includes(':') ? `[${p.ssh_host}]` : p.ssh_host}:${p.ssh_port}`;
  const trimUrl = url => url.trim().replace(/\/+$/, '');
  const caValue = () => profileForm.elements.ca_pem.value.trim() ? profileForm.elements.ca_pem.value : null;
  // Same URL and CA as the saved profile: its pinned identity still applies.
  const sameTrust = p => Boolean(p) && trimUrl(profileForm.elements.api_url.value) === trimUrl(p.api_url) && (caValue()?.trim() ?? null) === (p.ca_pem?.trim() || null);
  const canUsePassword = () => {
    const p = currentProfile();
    return sameTrust(p) && p.has_password && p.username === profileForm.elements.username.value.trim() && profileForm.elements.remember_password.checked;
  };
  function renderTrust() {
    const saved = currentProfile(), shown = pending ?? (sameTrust(saved) ? saved : null);
    const card = q('#bastion-trust');
    card.hidden = !shown;
    q('[data-action="cancel-probe"]').hidden = !pending;
    const submit = q('[data-role="submit"]');
    submit.textContent = w(pending ? 'confirmLogin' : sameTrust(saved) ? 'saveLogin' : 'probe');
    // Saving without logging in is useful for editing an existing connection.
    q('[data-action="save"]').hidden = Boolean(pending) || !sameTrust(saved);
    if (!shown) return;
    const values = { server_id: shown.server_id, ssh_entry: sshEntry(shown), ssh_host_key_sha256: shown.ssh_host_key_sha256 };
    const before = saved && { server_id: saved.server_id, ssh_entry: sshEntry(saved), ssh_host_key_sha256: saved.ssh_host_key_sha256 };
    let changed = false;
    for (const [field, value] of Object.entries(values)) {
      const dd = card.querySelector(`[data-field="${field}"]`);
      dd.textContent = value;
      dd.title = value;
      const differs = Boolean(pending && before && before[field] !== value);
      dd.classList.toggle('changed', differs);
      changed ||= differs;
    }
    card.dataset.state = changed ? 'changed' : pending ? 'pending' : 'saved';
    q('[data-role="trust-title"]').textContent = w(pending ? 'trustPending' : 'trustSaved');
    q('[data-role="trust-note"]').textContent = w(changed ? 'trustChanged' : pending ? 'trustNote' : 'trustSavedNote');
  }
  function fillProfile() {
    const p = currentProfile();
    pending = null;
    profileForm.reset();
    q('#bastion-config').open = true;
    q('#bastion-endpoint').textContent = p ? sshEntry(p) : '';
    for (const name of ['name','api_url','ca_pem','username']) profileForm.elements[name].value = p?.[name] ?? '';
    profileForm.elements.remember_password.checked = p ? Boolean(p.has_password || !p.username) : true;
    q('.bastion-advanced').open = Boolean(p?.ca_pem);
    renderTrust();
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
      const detail = String(e);
      setMessage(/SERVER_ID_CHANGED|GATEWAY_ADDRESS_CHANGED|GATEWAY_HOST_KEY_CHANGED/.test(detail) ? `${w('identityChanged')} ${detail}` : detail, 'error');
    } finally {
      busy = false;
      syncControls();
    }
  }
  const currentId = () => { if (!select.value) throw new Error(w('saveFirst')); return select.value; };
  function close() {
    select.closest('.zt-select-wrap')?.dispatchEvent(new CustomEvent('zt-select-close'));
    overlay.hidden = true;
    profileForm.elements.password.value = '';
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
    profileForm.elements.api_url.focus();
  });
  q('[data-action="cancel-probe"]').addEventListener('click', () => {
    pending = null;
    renderTrust();
    syncControls();
    setMessage();
    q('[data-role="submit"]').focus();
  });
  // A changed URL or CA invalidates an identity read with the previous values.
  profileForm.addEventListener('input', e => {
    if (pending && ['api_url', 'ca_pem'].includes(e.target.name)) pending = null;
    renderTrust();
    syncControls();
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
    setMessage();
  }, 'loggingOut'));
  function saveProfile(profile, login) {
    const username = profileForm.elements.username.value.trim();
    const password = profileForm.elements.password.value;
    const storedPassword = profileForm.elements.remember_password.checked ? password || null : '';
    run(async () => {
      const id = await invoke('bastion_save_profile', {profile:{...profile, username}, password:storedPassword});
      profileForm.elements.password.value = '';
      pending = null;
      onChange?.({type:'profile', profileId:id});
      await loadProfiles(id);
      if (login) {
        onChange?.({type:'loginStart', profileId:id});
        await invoke('bastion_login', {profileId:id, username, password});
        await onChange?.({type:'login', profileId:id});
        close();
      }
      setMessage(w('saved'), 'success');
    }, login ? 'loggingIn' : 'saving');
  }
  profileForm.addEventListener('submit', e => {
    e.preventDefault();
    const login = e.submitter?.name !== 'save_only';
    const name = profileForm.elements.name.value.trim(), saved = currentProfile();
    if (pending) return saveProfile({...pending, id: select.value, name: name || new URL(pending.api_url).hostname}, login);
    if (sameTrust(saved)) return saveProfile({...saved, name: name || new URL(saved.api_url).hostname}, login);
    run(async () => {
      pending = await invoke('bastion_probe', {name, apiUrl: profileForm.elements.api_url.value, caPem: caValue()});
      renderTrust();
    }, 'probing').then(() => { if (pending) q('[data-role="submit"]').focus(); });
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
  // Vault lock removes login state in Rust and clears the password input.
  document.getElementById('lock-button').addEventListener('click', close);
  return { open: profileId => { requestedProfileId = profileId; button.click(); } };
}
