# ZeroTerm Core

Rust workspace housing ZeroTerm's shared core. See [RFC-001](../RFC-001-architecture.md) for the overall design.

## Crates

| Crate | Status | Purpose |
|---|---|---|
| `zeroterm-ssh` | done | SSH protocol (russh wrapper): connect, auth (password/key/agent), host-key trust, PTY shell, SFTP streaming, port forwarding, ProxyJump |
| `zeroterm-store` | done | SQLite schema + migrations; opaque ciphertext storage |
| `zeroterm-vault` | done | Encrypted credential store (Argon2id + XChaCha20-Poly1305) |
| `zeroterm-app` | done | Vault-aware host orchestration + OS keychain caching |
| `zeroterm-cli` | done | Interactive SSH client; first consumer of `zeroterm-app` |
| `zeroterm-ffi` | done | uniffi bindings (Swift + Kotlin) — vault, hosts, async session, callbacks |
| `zeroterm-sync` | later | E2E-encrypted sync client |

## Prerequisites

- Rust toolchain (stable, 1.76+ recommended). Install via [rustup](https://rustup.rs/).
- On Windows: a recent build of Visual Studio Build Tools (MSVC) — `rustup` will tell you if it's missing.
- SQLite is bundled via `rusqlite`'s `bundled` feature.

## Quick start

```powershell
# from the core/ directory
cargo build --release
cargo test
```

## CLI usage

The `zeroterm` binary supports two modes — direct (no vault) and
vault-driven — plus subcommands for managing the vault.

### Direct mode

Connects without ever touching the vault.

```powershell
zeroterm user@host
zeroterm user@host -i $HOME\.ssh\id_ed25519
zeroterm user@host -A                          # use the running SSH agent
zeroterm user@host -A -i $HOME\.ssh\id_rsa     # agent first, key file as fallback
zeroterm user@host -p 2222
zeroterm user@host --known-hosts .\test-known-hosts

# Local port forward (-L) — open localhost:8080 on your machine that
# pipes through to nginx on the remote box.
zeroterm user@host -L 8080:127.0.0.1:80

# Dynamic SOCKS5 proxy (-D) — point your browser at 127.0.0.1:1080
# and traffic is routed through the SSH server.
zeroterm user@host -D 1080

# ProxyJump (-J) — connect to the target through a jump host.
zeroterm user@target -J jumpuser@bastion

# All combinable; shell stays open and the forwards live with it.
zeroterm user@target -A -J me@bastion -L 5432:db.internal:5432 -D 1080
```

### Vault-driven mode

```powershell
# Save a host (creates the vault if missing, prompts to set master password)
zeroterm add prod-web root@10.0.0.10 -i $HOME\.ssh\id_ed25519
zeroterm add staging deploy@10.0.0.11 -p 2222

# List
zeroterm list

# Connect by alias
zeroterm prod-web

# Interactive picker (lists every host, arrow-key + Enter)
zeroterm

# Remove
zeroterm remove staging

# Save forwards on a host so they auto-start every time you connect via alias.
zeroterm forward add prod-web -L 8080:127.0.0.1:80
zeroterm forward add prod-web -D 1080
zeroterm forward list prod-web
zeroterm forward remove prod-web 0

# Set ProxyJump on a host to another saved alias (must already exist).
zeroterm forward jump prod-web bastion          # use `bastion` as jump
zeroterm forward jump prod-web --clear          # remove ProxyJump

# Cache the master password in the OS keychain after this run, so future
# unlocks don't prompt. (One-shot — applies to whichever command you run it on.)
zeroterm --remember list

# Drop the cached password for this vault.
zeroterm forget
```

### SFTP

`sftp` subcommands work against either a saved alias or a `user@host`
target — same auth resolution as `connect`.

```powershell
# list a remote dir
zeroterm sftp ls prod-web /var/log
zeroterm sftp ls deploy@10.0.0.10 /etc/nginx

# download a file (omit local-path → write to current dir under remote basename)
zeroterm sftp get prod-web /var/log/nginx/access.log
zeroterm sftp get prod-web /etc/hosts ./hosts.bak

# upload
zeroterm sftp put prod-web .\nginx.conf /etc/nginx/nginx.conf

# rename, delete (file only — no recursive rm yet), mkdir
zeroterm sftp mv prod-web /tmp/a.txt /tmp/b.txt
zeroterm sftp rm prod-web /tmp/old.log
zeroterm sftp mkdir prod-web /tmp/new-dir
```

The list output is a thin `ls -l` style: kind marker (`d`/`-`/`l`/`?`),
size, name. Directories get a trailing `/`.

> Single-shot transfers are loaded fully into memory. Don't use `get` /
> `put` for multi-GB files — reach for `rsync` or wait for streaming
> support (separate milestone).

The vault is unlocked once per command. Use `--remember` to cache the
master password in the OS keychain so future runs skip the prompt; use
`zeroterm forget` to drop it. See [Master-password caching](#master-password-caching).

### Default vault location

| OS | Path |
|---|---|
| Windows | `%APPDATA%\ZeroTerm\zeroterm.vault` |
| macOS   | `~/Library/Application Support/ZeroTerm/zeroterm.vault` |
| Linux   | `~/.local/share/ZeroTerm/zeroterm.vault` |

Override with `--vault <path>`.

> **Subcommand-name limitation**: `zeroterm list` always invokes the
> `list` subcommand even if you have a saved host literally named "list".
> Don't name aliases `list`, `add`, or `remove`.

## SSH layer

### Authentication

Direct mode tries identities in this order:

1. `-A` (SSH agent), if given — every identity offered, in agent order
2. Each `-i <path>` private key (with passphrase prompt if needed)
3. If neither was given, fall back to a password prompt

The first method the server accepts wins. Vault-driven mode pulls auth
material from the saved record — password or PEM key bytes (with
optional passphrase, also stored in the vault).

#### SSH agent

The `-A` flag uses the running SSH agent:

| Platform | Agent it talks to |
|---|---|
| Linux / macOS | the process at `$SSH_AUTH_SOCK` (system agent, `ssh-agent`, `gpg-agent` with SSH support, etc.) |
| Windows | the `OpenSSH Authentication Agent` service via `\\.\pipe\openssh-ssh-agent` |

On Windows you'll typically need to enable the service once:

```powershell
# elevated PowerShell
Get-Service ssh-agent | Set-Service -StartupType Automatic
Start-Service ssh-agent
ssh-add $HOME\.ssh\id_ed25519
```

PuTTY's **Pageant** is intentionally NOT supported — different wire
format, separate adapter someday.

### Port forwarding & ProxyJump

| Flag | What it does | OpenSSH-compatible syntax |
|---|---|---|
| `-L [bind:]port:host:hport` | Local TCP listener bridged to `host:hport` via the SSH server | yes (no IPv6 brackets yet) |
| `-D [bind:]port` | Local SOCKS5 proxy (CONNECT only, no auth) routed through the SSH server | yes |
| `-J user@host[:port]` | Connect to the target through a jump host (single hop) | yes (no comma chains yet) |

Forwards stay up for the lifetime of the shell session and are torn
down when you exit. The jump-host session is held open alongside the
target session for the same reason.

### Forwards saved on hosts

In addition to one-shot `-L`/`-D`/`-J` flags, you can persist forwards
and ProxyJump on each saved host so connecting by alias (or clicking
the host in the desktop UI) automatically applies them:

```powershell
zeroterm forward add prod-web -L 5432:db.internal:5432
zeroterm forward add prod-web -D 1080
zeroterm forward jump prod-web bastion
zeroterm forward list prod-web

zeroterm prod-web   # ←  shell + saved forwards + ProxyJump, all auto
```

CLI flags layer on top of saved forwards (you get both). Saved
forwards apply to SFTP commands too — `zeroterm sftp ls prod-web /tmp`
honours the host's saved ProxyJump (forwards aren't useful with a
short-lived SFTP command but are honoured anyway for symmetry).

The desktop app reads the same data: clicking Connect on a host that
has saved forwards auto-starts them; the terminal header shows
`via <jump> · L 8080:... · D 1080` when applicable.

Not yet supported:

- **Remote forwarding (`-R`)** — server-side `bind:port` listener; needs
  sshd's `AllowTcpForwarding` plus a different message flow
- **Multi-hop ProxyJump** (`-J jumpA,jumpB,...`)
- **IPv6 bracket syntax** in `-L` host slot
- **Desktop UI for editing forwards** — manage via CLI today, GUI editor
  is the next batch

### Host-key verification

Default behavior matches OpenSSH's interactive client:

- **Trusted** (matches `~/.ssh/known_hosts`): silent.
- **Unknown**: print fingerprint, prompt `yes/no`. On `yes`, append.
- **Mismatch**: loud warning, one-shot accept; the stored entry is **not**
  rewritten — fix it manually if the change is legitimate.

Override flags: `--known-hosts <path>`, `--insecure-skip-host-key-check`.

### known_hosts format support

Supported: `host keytype b64`, `[host]:port keytype b64`, comma-separated
host lists, comments, blank lines.

Not yet (tracked): hashed hostnames, wildcards, `@cert-authority`,
`@revoked`.

## Vault layer

Implements the crypto design in [RFC-001 §4](../RFC-001-architecture.md):

```
master_password ─Argon2id(m=64MiB, t=3, p=4, salt=device-salt)─→ master_key (32B)
record_key      = HKDF-SHA256(master_key, salt=record_id, info="zeroterm-record-v1")
ciphertext      = XChaCha20-Poly1305(record_key, nonce=24B random,
                                     plaintext, aad = record_id || version_le)
```

Highlights:

- **Master password isn't stored** — a known-constant verifier blob proves
  the password is right by AEAD-decrypting back to the constant.
- **Per-record keys** so compromising one ciphertext doesn't help with
  others.
- **AAD binds `record_id || version`**, blocking record-swap and version
  rollback attacks.
- **`master_key` is `Zeroizing`** — wiped on `Vault` drop.
- **Tombstones** keep deletes propagatable for sync.

### Argon2id parameter tuning

Defaults `m=64MiB, t=3, p=4` (desktop/laptop). Mobile may need lower
`m_cost`. Parameters are persisted in `vault_meta`, so older vaults keep
working when defaults change. `Vault::create_with_params` picks them per
call.

### Master-password caching

`--remember` saves the master password to the OS keychain after a
successful unlock or create:

| OS | Backend |
|---|---|
| macOS | Keychain (Security framework) |
| Windows | Credential Manager (Wincred) |
| Linux | Secret Service (D-Bus to gnome-keyring / kwallet / etc.) |

Each entry is keyed by `service = "ZeroTerm"`, `username = "vault:" +
absolute path`, so multiple vaults don't collide. Subsequent unlocks
silently use the cached password; if the vault's password has been
rotated externally, ZeroTerm falls back to prompting and warns you to
either run `zeroterm forget` or re-`--remember`.

If the keychain backend isn't available (Linux without D-Bus, headless
CI, etc.) the cache is treated as a miss — every command prompts.

`zeroterm forget` removes the cached password without unlocking the
vault.

### End-to-end smoke test

```powershell
cargo run --release -p zeroterm-vault --example vault_demo
```

Creates a temp vault, exercises insert/list/update/delete, asserts wrong
password is rejected.

## What this checkpoint does NOT cover

- **Sync** — `zeroterm-sync` lands later
- **PuTTY Pageant** agent (different wire format from OpenSSH)
- **Remote port forwarding (`-R`)** — server-side listener
- **Multi-hop ProxyJump** chains
- **Auto-lock / TTL** for the keychain cache — once `--remember`'d, the password stays cached until `zeroterm forget` (or "Forget password" in the desktop UI)
- IME composition, function keys beyond F4

## russh version pinning

Pinned to `russh = "0.45"`. Bumping requires touching `session.rs`.

## Layout

```
core/
├── Cargo.toml                         # workspace root + shared deps
└── crates/
    ├── zeroterm-ssh/
    │   └── src/{lib,error,known_hosts,host_key,session}.rs
    ├── zeroterm-store/
    │   └── src/lib.rs                 # SQLite schema + opaque blob CRUD
    ├── zeroterm-vault/
    │   ├── src/{lib,error,crypto,vault}.rs
    │   └── examples/vault_demo.rs     # end-to-end smoke test
    ├── zeroterm-app/
    │   └── src/{lib,error,host,app}.rs    # vault-aware host orchestration
    └── zeroterm-cli/
        └── src/main.rs                # interactive SSH client
```
