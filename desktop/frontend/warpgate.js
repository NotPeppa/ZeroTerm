// Warpgate target directory. Each gateway profile mirrors its SSH targets
// into ordinary saved hosts (see core/crates/zeroterm-app/src/warpgate.rs),
// so this module only manages profiles and triggers a refresh. The API token
// and the Warpgate password / key stay in Rust; they are write-only from here.
export function installWarpgate({ invoke, confirm, syncCustomSelect, onSynced }) {
  const words = {
    en: {
      title: "Warpgate", subtitle: "Load SSH targets from a Warpgate gateway. Target addresses and credentials stay on the gateway.",
      none: "No gateway yet.", add: "Add gateway", edit: "Edit", refresh: "Refresh", delete: "Delete", close: "Close",
      name: "Name", url: "Warpgate URL", token: "API token", kept: "Saved; leave empty to keep",
      sshHost: "SSH address", sshHostPlaceholder: "Same as the Warpgate URL", sshPort: "SSH port",
      username: "Warpgate username", usernameHint: "Your Warpgate account, not a target account.",
      auth: "Authentication", password: "Password", key: "Private key", agent: "SSH agent",
      pickKey: "Choose file…", noKey: "No key loaded", savedKey: "Saved key; choose a file to replace", keyLoaded: "{name} loaded",
      passphrase: "Passphrase (optional)",
      pin: "TLS certificate SHA-256 (self-signed only)", pinHint: "openssl s_client -connect HOST:8888 </dev/null | openssl x509 -noout -fingerprint -sha256",
      save: "Save and refresh", cancel: "Cancel", synced: "{name}: {count} targets", failed: "{name}: {error}",
      deleteTitle: "Delete gateway?", deleteMessage: "Removes \"{name}\" and every host loaded from it.",
    },
    zh: {
      title: "Warpgate", subtitle: "从 Warpgate 网关读取 SSH 目标。目标地址和凭据只保存在网关上。",
      none: "还没有网关。", add: "添加网关", edit: "编辑", refresh: "刷新", delete: "删除", close: "关闭",
      name: "名称", url: "Warpgate 地址", token: "API Token", kept: "已保存，留空继续使用",
      sshHost: "SSH 地址", sshHostPlaceholder: "默认同 Warpgate 地址", sshPort: "SSH 端口",
      username: "Warpgate 用户名", usernameHint: "你的 Warpgate 账号，不是目标机账号。",
      auth: "认证方式", password: "密码", key: "私钥", agent: "SSH Agent",
      pickKey: "选择文件…", noKey: "未加载私钥", savedKey: "已保存私钥，选择文件可替换", keyLoaded: "已加载 {name}",
      passphrase: "口令（可选）",
      pin: "TLS 证书 SHA-256 指纹（仅自签证书需要）", pinHint: "openssl s_client -connect 主机:8888 </dev/null | openssl x509 -noout -fingerprint -sha256",
      save: "保存并刷新", cancel: "取消", synced: "{name}：{count} 个目标", failed: "{name}：{error}",
      deleteTitle: "删除网关？", deleteMessage: "将移除“{name}”以及从它读取的全部主机。",
    },
  };
  const w = (key, vars = {}) => {
    const text = words[document.documentElement.lang.startsWith("zh") ? "zh" : "en"][key] || key;
    return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  };

  const button = document.getElementById("warpgate-button");
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.hidden = true;
  overlay.innerHTML = `<div class="dialog wide warpgate-dialog" role="dialog" aria-modal="true" aria-labelledby="warpgate-title">
    <h3 id="warpgate-title"></h3>
    <p class="muted" data-w="subtitle"></p>
    <ul class="warpgate-list"></ul>
    <p class="muted warpgate-empty" data-w="none" hidden></p>
    <form class="warpgate-form" hidden>
      <div class="grid-2">
        <label><span data-w="name"></span><input name="name" type="text" required autocomplete="off" /></label>
        <label><span data-w="url"></span><input name="apiUrl" type="text" inputmode="url" required placeholder="https://gateway.example.com:8888" autocomplete="off" /></label>
        <label class="grid-span-2"><span data-w="token"></span><input name="token" type="password" autocomplete="off" /></label>
        <label><span data-w="sshHost"></span><input name="sshHost" type="text" autocomplete="off" data-wp="sshHostPlaceholder" /></label>
        <label><span data-w="sshPort"></span><input name="sshPort" type="number" min="1" max="65535" value="2222" required /></label>
        <label><span data-w="username"></span><input name="username" type="text" required autocomplete="off" />
          <span class="muted tiny" data-w="usernameHint"></span></label>
        <label><span data-w="auth"></span><select id="warpgate-auth-type" name="authType">
          <option value="password" data-w="password"></option>
          <option value="key" data-w="key"></option>
          <option value="agent" data-w="agent"></option>
        </select></label>
        <label class="grid-span-2" data-auth="password"><span data-w="password"></span><input name="password" type="password" autocomplete="off" /></label>
        <div class="grid-span-2" data-auth="key">
          <div class="key-row"><button type="button" data-action="pick-key" data-w="pickKey"></button><span class="muted tiny warpgate-key-status"></span></div>
          <label><span data-w="passphrase"></span><input name="passphrase" type="password" autocomplete="off" /></label>
        </div>
        <label class="grid-span-2"><span data-w="pin"></span><input name="tlsCertSha256" type="text" autocomplete="off" spellcheck="false" placeholder="AB:CD:…" />
          <code class="muted tiny" data-w="pinHint"></code></label>
      </div>
      <div class="dialog-actions">
        <button type="button" data-action="cancel" data-w="cancel"></button>
        <button type="submit" class="primary" data-w="save"></button>
      </div>
    </form>
    <p class="warpgate-status" role="status" aria-live="polite" hidden></p>
    <div class="dialog-actions warpgate-list-actions">
      <button type="button" data-action="add" data-w="add"></button>
      <button type="button" data-action="close" data-w="close"></button>
    </div>
  </div>`;
  document.body.append(overlay);
  const q = (s) => overlay.querySelector(s);
  const list = q(".warpgate-list");
  const form = q(".warpgate-form");
  const f = form.elements;
  const status = q(".warpgate-status");
  const keyStatus = q(".warpgate-key-status");
  let profiles = [];
  let editing = null;
  let keyPem = null;

  function translate() {
    q("#warpgate-title").textContent = w("title");
    overlay.querySelectorAll("[data-w]").forEach((el) => (el.textContent = w(el.dataset.w)));
    overlay.querySelectorAll("[data-wp]").forEach((el) => (el.placeholder = w(el.dataset.wp)));
    syncCustomSelect?.("warpgate-auth-type");
    if (button) {
      button.title = w("title");
      button.setAttribute("aria-label", w("title"));
    }
  }

  function setStatus(text = "", isError = false) {
    status.textContent = text;
    status.hidden = !text;
    status.classList.toggle("error", isError);
  }

  // Only the auth block for the chosen type is shown. An edit keeps the saved
  // secret when the type is unchanged and the field is left empty.
  function syncAuthBlocks() {
    const type = f.authType.value;
    overlay.querySelectorAll("[data-auth]").forEach((el) => (el.hidden = el.dataset.auth !== type));
    const keepsSaved = editing?.authType === type;
    f.password.placeholder = keepsSaved && type === "password" ? w("kept") : "";
    f.passphrase.placeholder = keepsSaved && type === "key" ? w("kept") : "";
    if (!keyPem) keyStatus.textContent = w(keepsSaved && type === "key" ? "savedKey" : "noKey");
  }

  async function load() {
    profiles = await invoke("list_warpgate_profiles");
    list.replaceChildren(
      ...profiles.map((p) => {
        const li = document.createElement("li");
        const label = document.createElement("div");
        const name = document.createElement("strong");
        const url = document.createElement("span");
        name.textContent = p.name;
        url.className = "muted tiny";
        url.textContent = `${p.apiUrl} · ${p.username}@${p.sshHost}:${p.sshPort}`;
        label.append(name, url);
        const actions = document.createElement("div");
        for (const action of ["refresh", "edit", "delete"]) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "small";
          b.textContent = w(action);
          b.addEventListener("click", () => handlers[action](p));
          actions.append(b);
        }
        li.append(label, actions);
        return li;
      }),
    );
    q(".warpgate-empty").hidden = profiles.length > 0;
  }

  async function sync(p, { silent = false } = {}) {
    try {
      const count = await invoke("sync_warpgate", { id: p.id });
      if (!silent) setStatus(w("synced", { name: p.name, count }));
    } catch (e) {
      if (silent) console.warn("warpgate sync failed", p.name, e);
      else setStatus(w("failed", { name: p.name, error: String(e) }), true);
    }
  }

  function openForm(p = null) {
    editing = p;
    keyPem = null;
    f.name.value = p?.name ?? "Warpgate";
    f.apiUrl.value = p?.apiUrl ?? "";
    f.token.value = "";
    f.token.required = !p;
    f.token.placeholder = p ? w("kept") : "";
    f.sshHost.value = p?.sshHost ?? "";
    f.sshPort.value = p?.sshPort ?? 2222;
    f.username.value = p?.username ?? "";
    f.authType.value = p?.authType ?? "password";
    f.password.value = "";
    f.passphrase.value = "";
    f.tlsCertSha256.value = p?.tlsCertSha256 ?? "";
    syncCustomSelect?.("warpgate-auth-type");
    syncAuthBlocks();
    form.hidden = false;
    q(".warpgate-list-actions").hidden = true;
    setStatus("");
    f.name.focus();
  }

  function closeForm() {
    form.hidden = true;
    q(".warpgate-list-actions").hidden = false;
    editing = null;
    keyPem = null;
  }

  function authInput() {
    switch (f.authType.value) {
      case "key":
        return { type: "private_key", key_pem: keyPem, passphrase: f.passphrase.value || null };
      case "agent":
        return { type: "agent" };
      default:
        return { type: "password", value: f.password.value };
    }
  }

  // An empty SSH address means "the host in the Warpgate URL".
  function sshHostFromUrl() {
    try {
      return new URL(f.apiUrl.value.trim()).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return "";
    }
  }

  const handlers = {
    refresh: async (p) => {
      await sync(p);
      await onSynced();
    },
    edit: (p) => openForm(p),
    delete: async (p) => {
      if (!(await confirm({ title: w("deleteTitle"), message: w("deleteMessage", { name: p.name }), okText: w("delete"), cancelText: w("cancel") }))) return;
      try {
        await invoke("delete_warpgate_profile", { id: p.id });
        setStatus("");
      } catch (e) {
        setStatus(String(e), true);
      }
      await load();
      await onSynced();
    },
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const id = await invoke("save_warpgate_profile", {
        id: editing?.id ?? null,
        input: {
          name: f.name.value,
          apiUrl: f.apiUrl.value,
          token: f.token.value || null,
          sshHost: f.sshHost.value.trim() || sshHostFromUrl(),
          sshPort: Number(f.sshPort.value),
          username: f.username.value,
          auth: authInput(),
          tlsCertSha256: f.tlsCertSha256.value || null,
        },
      });
      const name = f.name.value;
      closeForm();
      await load();
      await handlers.refresh(profiles.find((p) => p.id === id) ?? { id, name });
    } catch (e) {
      setStatus(String(e), true);
    } finally {
      submit.disabled = false;
    }
  });
  f.authType.addEventListener("change", syncAuthBlocks);
  q('[data-action="pick-key"]').addEventListener("click", async () => {
    // The backend picker authorizes the chosen path for read_local_text_file.
    const path = await invoke("pick_local_file", { title: w("key"), showHidden: true });
    if (!path) return;
    try {
      keyPem = await invoke("read_local_text_file", { path: String(path) });
      keyStatus.textContent = w("keyLoaded", { name: String(path).split(/[\\/]/).pop() });
    } catch (e) {
      keyPem = null;
      keyStatus.textContent = String(e);
    }
  });
  q('[data-action="cancel"]').addEventListener("click", closeForm);
  q('[data-action="add"]').addEventListener("click", () => openForm());
  q('[data-action="close"]').addEventListener("click", () => (overlay.hidden = true));
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.hidden = true;
  });
  button?.addEventListener("click", async () => {
    translate();
    closeForm();
    setStatus("");
    overlay.hidden = false;
    try {
      await load();
    } catch (e) {
      setStatus(String(e), true);
    }
    q('[data-action="add"]').focus();
  });
  translate();

  return {
    translate,
    /// Refresh every gateway quietly, e.g. right after the vault unlocks.
    async syncAll() {
      const all = await invoke("list_warpgate_profiles").catch(() => []);
      if (!all.length) return;
      for (const p of all) await sync(p, { silent: true });
      await onSynced();
    },
  };
}
