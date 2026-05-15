//! ZeroTerm interactive SSH CLI.
//!
//! Three usage modes:
//!
//! Direct — connect with an explicit `user@host`, no vault touched:
//!     zeroterm user@host
//!     zeroterm user@host -i ~/.ssh/id_ed25519 -p 2222
//!
//! Vault picker — open an interactive list of saved hosts:
//!     zeroterm
//!     zeroterm <alias>            # connect by saved name
//!
//! Vault management:
//!     zeroterm list
//!     zeroterm add <name> user@host [-i path] [-p port]
//!     zeroterm remove <name>
//!
//! `--vault <path>` overrides the default vault location, which is
//! `dirs::data_dir()/ZeroTerm/zeroterm.vault` (e.g.
//! `%APPDATA%\ZeroTerm\zeroterm.vault` on Windows).

use std::io::{stdout, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use clap::{Parser, Subcommand};
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use crossterm::terminal::{disable_raw_mode, enable_raw_mode, size as term_size};
use dialoguer::Select;
use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use zeroterm_app::{default_vault_path, App, Host, HostAuth};
use zeroterm_ssh::{
    AuthMethod, ChannelEvent, ConnectConfig, FileKind, HostKeyInfo, HostKeyPolicy, HostKeyPrompt,
    KnownHosts, MismatchAction, PtySize, Session,
};

#[derive(Debug, Parser)]
#[command(name = "zeroterm", version, about = "ZeroTerm SSH client")]
struct Args {
    #[command(subcommand)]
    command: Option<Command>,

    /// `user@host[:port]` for direct mode, or saved alias name.
    /// Absent → interactive picker over saved hosts.
    target: Option<String>,

    /// Identity file (private key) for direct mode. Repeatable.
    #[arg(short = 'i', long = "identity")]
    identities: Vec<PathBuf>,

    /// Use the running SSH agent (OpenSSH on Unix and Windows).
    /// Combine with `-i` if you want to fall back to a key file.
    #[arg(short = 'A', long)]
    agent: bool,

    /// Local port forward, OpenSSH `-L` syntax: `[bind:]port:host:hport`.
    /// Repeatable. The forward stays up for the lifetime of the shell.
    #[arg(short = 'L', long = "local-forward")]
    local_forward: Vec<String>,

    /// Dynamic SOCKS5 proxy, OpenSSH `-D` syntax: `[bind:]port`.
    /// Repeatable.
    #[arg(short = 'D', long = "dynamic-forward")]
    dynamic_forward: Vec<String>,

    /// ProxyJump host, OpenSSH `-J` syntax: `user@host[:port]`.
    /// Single hop only for now (no comma-separated chains).
    #[arg(short = 'J', long = "jump")]
    jump: Option<String>,

    /// Override port (otherwise from target, defaulting to 22).
    #[arg(short, long)]
    port: Option<u16>,

    /// Custom known_hosts path (defaults to ~/.ssh/known_hosts).
    #[arg(long = "known-hosts")]
    known_hosts: Option<PathBuf>,

    /// Skip host-key verification entirely. **Insecure — lab use only.**
    #[arg(long)]
    insecure_skip_host_key_check: bool,

    /// Vault file path. Defaults to OS-specific data dir.
    #[arg(long, global = true)]
    vault: Option<PathBuf>,

    /// After a successful unlock or create, save the master password
    /// to the OS keychain. Subsequent runs will pull it from there.
    #[arg(long, global = true)]
    remember: bool,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// List hosts saved in the vault.
    List,
    /// Save a host to the vault. Creates the vault if missing.
    Add {
        name: String,
        /// `user@host[:port]`.
        target: String,
        /// Identity file. If absent, prompt for a password.
        #[arg(short = 'i', long)]
        identity: Option<PathBuf>,
        /// Override port.
        #[arg(short, long)]
        port: Option<u16>,
    },
    /// Delete a saved host by name.
    Remove { name: String },
    /// Forget any keychain-cached master password for this vault.
    Forget,
    /// SFTP file operations against a saved alias or `user@host`.
    Sftp {
        #[command(subcommand)]
        action: SftpAction,
    },
    /// Manage saved port forwards and ProxyJump on a host.
    Forward {
        #[command(subcommand)]
        action: ForwardAction,
    },
}

#[derive(Debug, Subcommand)]
enum ForwardAction {
    /// List the forwards saved on a host.
    List { host: String },
    /// Append a forward to the host. Use `-L` for local, `-D` for SOCKS5.
    Add {
        host: String,
        /// Local forward, OpenSSH `-L` syntax: `[bind:]port:host:hport`.
        #[arg(short = 'L', long)]
        local: Option<String>,
        /// Dynamic SOCKS5, OpenSSH `-D` syntax: `[bind:]port`.
        #[arg(short = 'D', long)]
        dynamic: Option<String>,
    },
    /// Remove the Nth forward (0-indexed; see `list`).
    Remove { host: String, index: usize },
    /// Set or clear the ProxyJump alias on a host. Pass `--clear` to remove.
    Jump {
        host: String,
        /// Saved alias of another host to use as the jump host.
        #[arg(conflicts_with = "clear")]
        jump: Option<String>,
        #[arg(long, conflicts_with = "jump")]
        clear: bool,
    },
}

#[derive(Debug, Subcommand)]
enum SftpAction {
    /// List a remote directory.
    Ls {
        target: String,
        #[arg(default_value = ".")]
        path: String,
    },
    /// Download a remote file. If `local` is omitted, the remote
    /// basename is used in the current directory.
    Get {
        target: String,
        remote: String,
        local: Option<PathBuf>,
    },
    /// Upload a local file. Replaces any existing remote file.
    Put {
        target: String,
        local: PathBuf,
        remote: String,
    },
    /// Delete a remote file (does not recurse into directories).
    Rm { target: String, path: String },
    /// Create a remote directory.
    Mkdir { target: String, path: String },
    /// Rename / move on the remote.
    Mv {
        target: String,
        from: String,
        to: String,
    },
}

#[derive(Debug, Clone)]
struct Target {
    user: String,
    host: String,
    port: u16,
}

fn parse_target(s: &str, port_override: Option<u16>) -> Result<Target> {
    let (user, hostport) = s
        .split_once('@')
        .ok_or_else(|| anyhow!("target must look like user@host[:port]"))?;
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().context("invalid port")?),
        None => (hostport.to_string(), 22),
    };
    Ok(Target {
        user: user.to_string(),
        host,
        port: port_override.unwrap_or(port),
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,zeroterm=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let args = Args::parse();
    let vault_path = resolve_vault_path(args.vault.clone())?;

    match &args.command {
        Some(Command::List) => cmd_list(&args, &vault_path),
        Some(Command::Add { name, target, identity, port }) => {
            cmd_add(&args, &vault_path, name, target, identity.clone(), *port)
        }
        Some(Command::Remove { name }) => cmd_remove(&args, &vault_path, name),
        Some(Command::Forget) => cmd_forget(&vault_path),
        Some(Command::Sftp { action }) => cmd_sftp(&args, &vault_path, action).await,
        Some(Command::Forward { action }) => cmd_forward(&args, &vault_path, action),
        None => match &args.target {
            Some(t) if t.contains('@') => connect_direct(&args, t).await,
            Some(alias) => connect_by_alias(&vault_path, alias, &args).await,
            None => connect_via_picker(&vault_path, &args).await,
        },
    }
}

// --------------------------------------------------------------------------
// connect paths
// --------------------------------------------------------------------------

async fn connect_direct(args: &Args, target_str: &str) -> Result<()> {
    let target = parse_target(target_str, args.port)?;
    let host_key_policy = build_host_key_policy(args)?;
    let auth_methods = build_direct_auth_methods(args, &target)?;

    let cfg = ConnectConfig {
        host: target.host.clone(),
        port: target.port,
        username: target.user.clone(),
        auth_methods,
        connect_timeout: Some(Duration::from_secs(15)),
        host_key_policy,
    };

    run_session(cfg, args, &[], None).await
}

async fn connect_by_alias(vault_path: &Path, alias: &str, args: &Args) -> Result<()> {
    let app = open_app(args, vault_path, /*create_if_missing*/ false)?;
    let host = app
        .find_host_by_name(alias)?
        .ok_or_else(|| anyhow!("no host named '{}' in {}", alias, vault_path.display()))?;
    info!(name = %host.name, host = %host.host, port = host.port, "resolved alias");

    let cfg = app.connect_config(
        &host,
        build_host_key_policy(args)?,
        Some(Duration::from_secs(15)),
    );
    let saved_jump = resolve_saved_jump(&app, &host, args)?;
    run_session(cfg, args, &host.forwards, saved_jump).await
}

async fn connect_via_picker(vault_path: &Path, args: &Args) -> Result<()> {
    if !App::vault_exists(vault_path) {
        eprintln!(
            "No vault at {}. Add one with: zeroterm add <name> user@host",
            vault_path.display()
        );
        return Ok(());
    }

    let app = open_app(args, vault_path, false)?;
    let hosts = app.list_hosts()?;
    if hosts.is_empty() {
        eprintln!(
            "Vault is empty. Add a host with: zeroterm add <name> user@host"
        );
        return Ok(());
    }

    let items: Vec<String> = hosts
        .iter()
        .map(|h| format!("{}  ({}@{}:{})", h.name, h.user, h.host, h.port))
        .collect();
    let selection = Select::new()
        .with_prompt("Select a host")
        .items(&items)
        .default(0)
        .interact()?;
    let host = &hosts[selection];

    let cfg = app.connect_config(
        host,
        build_host_key_policy(args)?,
        Some(Duration::from_secs(15)),
    );
    let saved_jump = resolve_saved_jump(&app, host, args)?;
    run_session(cfg, args, &host.forwards, saved_jump).await
}

/// If the host has `proxy_jump` set, look up the jump alias in the
/// vault and return a fully-formed `ConnectConfig` for it. Returns
/// `None` when the host has no jump configured. The CLI `--jump` flag
/// takes precedence over this; we only resolve a saved jump when no
/// explicit one was given on the command line.
fn resolve_saved_jump(
    app: &App,
    host: &Host,
    args: &Args,
) -> Result<Option<ConnectConfig>> {
    if args.jump.is_some() {
        return Ok(None);
    }
    let Some(jump_alias) = host.proxy_jump.as_deref() else {
        return Ok(None);
    };
    let jump_host = app
        .find_host_by_name(jump_alias)?
        .ok_or_else(|| anyhow!("ProxyJump alias '{}' not found in vault", jump_alias))?;
    let cfg = app.connect_config(
        &jump_host,
        build_host_key_policy(args)?,
        Some(Duration::from_secs(15)),
    );
    Ok(Some(cfg))
}

async fn run_session(
    cfg: ConnectConfig,
    args: &Args,
    saved_forwards: &[zeroterm_app::ForwardSpec],
    saved_jump_cfg: Option<ConnectConfig>,
) -> Result<()> {
    info!(host = %cfg.host, port = cfg.port, "connecting");

    // Effective ProxyJump: CLI flag wins over the host's saved alias.
    let jump_cfg = if let Some(jump_spec) = args.jump.as_deref() {
        let jump_target = parse_target(jump_spec, None)?;
        Some(ConnectConfig {
            host: jump_target.host.clone(),
            port: jump_target.port,
            username: jump_target.user.clone(),
            auth_methods: cfg.auth_methods.clone(),
            connect_timeout: cfg.connect_timeout,
            host_key_policy: cfg.host_key_policy.clone(),
        })
    } else {
        saved_jump_cfg
    };

    let (jump_session, session) = match jump_cfg {
        Some(jcfg) => {
            info!(host = %jcfg.host, port = jcfg.port, "connecting (jump)");
            let j = Session::connect(jcfg)
                .await
                .context("failed to connect to jump host")?;
            info!("authenticated to jump host");
            let t = Session::connect_via(cfg, &j)
                .await
                .context("failed to connect to target via jump")?;
            (Some(j), t)
        }
        None => (None, Session::connect(cfg).await.context("failed to connect")?),
    };
    let mut session = session;
    info!("authenticated");

    let mut forwards: Vec<zeroterm_ssh::ForwardHandle> = Vec::new();

    // Saved forwards on the host record first, then any CLI flags layered
    // on top so command-line additions don't lose their explicitness.
    for spec in saved_forwards {
        let h = match spec {
            zeroterm_app::ForwardSpec::Local {
                bind_addr,
                bind_port,
                target_host,
                target_port,
            } => zeroterm_ssh::forward_local(
                &session,
                bind_addr,
                *bind_port,
                target_host.clone(),
                *target_port,
            )
            .await
            .with_context(|| format!("setting up saved forward {}", spec.summary()))?,
            zeroterm_app::ForwardSpec::Dynamic {
                bind_addr,
                bind_port,
            } => zeroterm_ssh::forward_dynamic(&session, bind_addr, *bind_port)
                .await
                .with_context(|| format!("setting up saved forward {}", spec.summary()))?,
        };
        info!(local = %h.local_addr(), spec = spec.summary(), "saved forward up");
        forwards.push(h);
    }
    for spec in &args.local_forward {
        let lf = parse_local_forward(spec)?;
        let handle = zeroterm_ssh::forward_local(
            &session,
            &lf.bind_addr,
            lf.bind_port,
            lf.target_host,
            lf.target_port,
        )
        .await
        .with_context(|| format!("setting up local forward {spec}"))?;
        info!(local = %handle.local_addr(), spec, "local forward up");
        forwards.push(handle);
    }
    for spec in &args.dynamic_forward {
        let df = parse_dynamic_forward(spec)?;
        let handle = zeroterm_ssh::forward_dynamic(&session, &df.bind_addr, df.bind_port)
            .await
            .with_context(|| format!("setting up SOCKS5 forward {spec}"))?;
        info!(local = %handle.local_addr(), spec, "dynamic SOCKS5 forward up");
        forwards.push(handle);
    }

    let (cols, rows) = term_size().unwrap_or((80, 24));
    let channel = session
        .open_shell(PtySize::new(cols, rows))
        .await
        .context("open shell")?;

    let exit_code = match run_interactive(channel).await {
        Ok(code) => code,
        Err(e) => {
            let _ = disable_raw_mode();
            error!(error = %e, "session ended with error");
            return Err(e);
        }
    };

    drop(forwards);
    let _ = session.disconnect().await;
    if let Some(j) = jump_session {
        let _ = j.disconnect().await;
    }

    if exit_code != 0 {
        std::process::exit(exit_code as i32);
    }
    Ok(())
}

#[derive(Debug)]
struct LocalForwardSpec {
    bind_addr: String,
    bind_port: u16,
    target_host: String,
    target_port: u16,
}

#[derive(Debug)]
struct DynamicForwardSpec {
    bind_addr: String,
    bind_port: u16,
}

/// Parse OpenSSH-style `-L` argument: `[bind:]port:host:hport`. The
/// host part may itself contain a colon (IPv6) — only the LAST colon
/// before `hport` separates host from hport.
fn parse_local_forward(spec: &str) -> Result<LocalForwardSpec> {
    // Strategy: split off the last two colon-separated tokens as
    // host:hport, the remainder as [bind:]port. This handles bracketed
    // IPv6 addresses in the host slot poorly — for now we don't support
    // them.
    let parts: Vec<&str> = spec.splitn(4, ':').collect();
    let (bind_addr, bind_port_str, target_host, target_port_str) = match parts.as_slice() {
        [bp, h, hp] => ("127.0.0.1".to_string(), *bp, h.to_string(), *hp),
        [b, bp, h, hp] => (b.to_string(), *bp, h.to_string(), *hp),
        _ => bail!("local forward must be `[bind:]port:host:hport`, got `{spec}`"),
    };
    Ok(LocalForwardSpec {
        bind_addr,
        bind_port: bind_port_str
            .parse()
            .with_context(|| format!("invalid bind port `{bind_port_str}`"))?,
        target_host,
        target_port: target_port_str
            .parse()
            .with_context(|| format!("invalid target port `{target_port_str}`"))?,
    })
}

/// Parse OpenSSH-style `-D` argument: `[bind:]port`.
fn parse_dynamic_forward(spec: &str) -> Result<DynamicForwardSpec> {
    let (bind_addr, bind_port_str) = match spec.rsplit_once(':') {
        Some((b, p)) => (b.to_string(), p),
        None => ("127.0.0.1".to_string(), spec),
    };
    Ok(DynamicForwardSpec {
        bind_addr,
        bind_port: bind_port_str
            .parse()
            .with_context(|| format!("invalid bind port `{bind_port_str}`"))?,
    })
}

async fn cmd_sftp(args: &Args, vault_path: &Path, action: &SftpAction) -> Result<()> {
    let target = sftp_target(action);
    let (cfg, saved_jump) = resolve_connect_config(args, vault_path, target).await?;

    // Effective ProxyJump: CLI flag wins over saved alias.
    let jump_cfg = if let Some(jump_spec) = args.jump.as_deref() {
        let jt = parse_target(jump_spec, None)?;
        Some(ConnectConfig {
            host: jt.host,
            port: jt.port,
            username: jt.user,
            auth_methods: cfg.auth_methods.clone(),
            connect_timeout: cfg.connect_timeout,
            host_key_policy: cfg.host_key_policy.clone(),
        })
    } else {
        saved_jump
    };

    info!(host = %cfg.host, port = cfg.port, "connecting (sftp)");
    let (jump_session, mut session) = match jump_cfg {
        Some(jcfg) => {
            let j = Session::connect(jcfg).await.context("jump connect")?;
            let t = Session::connect_via(cfg, &j)
                .await
                .context("target via jump")?;
            (Some(j), t)
        }
        None => (None, Session::connect(cfg).await.context("failed to connect")?),
    };
    let sftp = session.sftp().await.context("open sftp subsystem")?;

    let result = match action {
        SftpAction::Ls { path, .. } => sftp_ls(&sftp, path).await,
        SftpAction::Get { remote, local, .. } => sftp_get(&sftp, remote, local.as_deref()).await,
        SftpAction::Put { local, remote, .. } => sftp_put(&sftp, local, remote).await,
        SftpAction::Rm { path, .. } => sftp_rm(&sftp, path).await,
        SftpAction::Mkdir { path, .. } => sftp_mkdir(&sftp, path).await,
        SftpAction::Mv { from, to, .. } => sftp_mv(&sftp, from, to).await,
    };

    // Drop sftp before disconnect so the channel closes cleanly.
    drop(sftp);
    let _ = session.disconnect().await;
    if let Some(j) = jump_session {
        let _ = j.disconnect().await;
    }
    result
}

fn cmd_forget(vault_path: &Path) -> Result<()> {
    match zeroterm_app::keychain::forget_master_password(vault_path) {
        Ok(()) => {
            println!("forgot keychain entry for {}", vault_path.display());
            Ok(())
        }
        Err(e) => {
            warn!(error = %e, "could not delete keychain entry");
            Err(anyhow!(e))
        }
    }
}

fn sftp_target(action: &SftpAction) -> &str {
    match action {
        SftpAction::Ls { target, .. }
        | SftpAction::Get { target, .. }
        | SftpAction::Put { target, .. }
        | SftpAction::Rm { target, .. }
        | SftpAction::Mkdir { target, .. }
        | SftpAction::Mv { target, .. } => target,
    }
}

async fn sftp_ls(sftp: &zeroterm_ssh::Sftp, path: &str) -> Result<()> {
    let mut entries = sftp.list(path).await?;
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    for e in entries {
        let kind_marker = match e.kind {
            FileKind::Dir => 'd',
            FileKind::File => '-',
            FileKind::Symlink => 'l',
            FileKind::Other => '?',
        };
        let size_str = if e.kind == FileKind::Dir {
            String::from("-")
        } else {
            e.size.to_string()
        };
        let suffix = if e.kind == FileKind::Dir { "/" } else { "" };
        println!("{}  {:>10}  {}{}", kind_marker, size_str, e.name, suffix);
    }
    Ok(())
}

async fn sftp_get(
    sftp: &zeroterm_ssh::Sftp,
    remote: &str,
    local: Option<&Path>,
) -> Result<()> {
    let local_owned: PathBuf = match local {
        Some(p) => p.to_path_buf(),
        None => {
            let basename = remote.rsplit('/').next().unwrap_or(remote);
            PathBuf::from(basename)
        }
    };
    let mut file = tokio::fs::File::create(&local_owned)
        .await
        .with_context(|| format!("opening {} for write", local_owned.display()))?;

    let cancel = tokio_util::sync::CancellationToken::new();
    let mut last_print = std::time::Instant::now();
    let n = sftp
        .download_to_writer(
            remote,
            &mut file,
            zeroterm_ssh::DEFAULT_CHUNK,
            cancel,
            |tick| {
                let now = std::time::Instant::now();
                if now.duration_since(last_print) > std::time::Duration::from_millis(100)
                    || tick.bytes_done == tick.total.unwrap_or(u64::MAX)
                {
                    print_progress("get", remote, &tick);
                    last_print = now;
                }
            },
        )
        .await?;
    eprintln!();
    println!("downloaded {} → {} ({} bytes)", remote, local_owned.display(), n);
    Ok(())
}

async fn sftp_put(sftp: &zeroterm_ssh::Sftp, local: &Path, remote: &str) -> Result<()> {
    let metadata = std::fs::metadata(local)
        .with_context(|| format!("stating {}", local.display()))?;
    let size_hint = Some(metadata.len());

    let mut file = tokio::fs::File::open(local)
        .await
        .with_context(|| format!("reading {}", local.display()))?;

    let cancel = tokio_util::sync::CancellationToken::new();
    let mut last_print = std::time::Instant::now();
    let label = local.display().to_string();
    let n = sftp
        .upload_from_reader(
            remote,
            &mut file,
            zeroterm_ssh::DEFAULT_CHUNK,
            size_hint,
            cancel,
            |tick| {
                let now = std::time::Instant::now();
                if now.duration_since(last_print) > std::time::Duration::from_millis(100)
                    || tick.bytes_done == tick.total.unwrap_or(u64::MAX)
                {
                    print_progress("put", &label, &tick);
                    last_print = now;
                }
            },
        )
        .await?;
    eprintln!();
    println!("uploaded {} → {} ({} bytes)", local.display(), remote, n);
    Ok(())
}

fn print_progress(verb: &str, label: &str, tick: &zeroterm_ssh::ProgressTick) {
    use std::io::Write;
    let stderr = std::io::stderr();
    let mut handle = stderr.lock();
    match tick.total {
        Some(total) if total > 0 => {
            let pct = (tick.bytes_done as f64 / total as f64) * 100.0;
            let _ = write!(
                handle,
                "\r{verb} {label}  {} / {} ({:.1}%)",
                human(tick.bytes_done),
                human(total),
                pct
            );
        }
        _ => {
            let _ = write!(handle, "\r{verb} {label}  {}", human(tick.bytes_done));
        }
    }
    let _ = handle.flush();
}

fn human(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;
    if n >= GB {
        format!("{:.2} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{:.1} MB", n as f64 / MB as f64)
    } else if n >= KB {
        format!("{:.1} KB", n as f64 / KB as f64)
    } else {
        format!("{n} B")
    }
}

async fn sftp_rm(sftp: &zeroterm_ssh::Sftp, path: &str) -> Result<()> {
    let meta = sftp.stat(path).await?;
    match meta.kind {
        FileKind::Dir => Err(anyhow!(
            "{} is a directory; use `mkdir`'s reverse manually (recursive rm not implemented)",
            path
        )),
        _ => {
            sftp.remove_file(path).await?;
            println!("removed {}", path);
            Ok(())
        }
    }
}

async fn sftp_mkdir(sftp: &zeroterm_ssh::Sftp, path: &str) -> Result<()> {
    sftp.create_dir(path).await?;
    println!("created {}", path);
    Ok(())
}

async fn sftp_mv(sftp: &zeroterm_ssh::Sftp, from: &str, to: &str) -> Result<()> {
    sftp.rename(from, to).await?;
    println!("renamed {} → {}", from, to);
    Ok(())
}

/// Build a [`ConnectConfig`] from either an alias (looked up in the
/// vault) or a `user@host[:port]` direct target. Returns the config
/// plus an optional saved-ProxyJump config (alias mode only — direct
/// mode users specify `-J` via the CLI).
async fn resolve_connect_config(
    args: &Args,
    vault_path: &Path,
    target: &str,
) -> Result<(ConnectConfig, Option<ConnectConfig>)> {
    if target.contains('@') {
        let parsed = parse_target(target, args.port)?;
        let auth_methods = build_direct_auth_methods(args, &parsed)?;
        Ok((
            ConnectConfig {
                host: parsed.host,
                port: parsed.port,
                username: parsed.user,
                auth_methods,
                connect_timeout: Some(Duration::from_secs(15)),
                host_key_policy: build_host_key_policy(args)?,
            },
            None,
        ))
    } else {
        let app = open_app(args, vault_path, false)?;
        let host = app
            .find_host_by_name(target)?
            .ok_or_else(|| anyhow!("no host named '{}' in {}", target, vault_path.display()))?;
        let cfg = app.connect_config(
            &host,
            build_host_key_policy(args)?,
            Some(Duration::from_secs(15)),
        );
        let jump = resolve_saved_jump(&app, &host, args)?;
        Ok((cfg, jump))
    }
}

// --------------------------------------------------------------------------
// vault subcommands
// --------------------------------------------------------------------------

fn cmd_list(args: &Args, vault_path: &Path) -> Result<()> {
    if !App::vault_exists(vault_path) {
        eprintln!("No vault at {}.", vault_path.display());
        return Ok(());
    }
    let app = open_app(args, vault_path, false)?;
    let hosts = app.list_hosts()?;
    if hosts.is_empty() {
        println!("(no saved hosts)");
        return Ok(());
    }

    let name_w = hosts.iter().map(|h| h.name.len()).max().unwrap_or(4).max(4);
    println!("{:<width$}  TARGET", "NAME", width = name_w);
    for h in hosts {
        let auth_tag = match h.auth {
            HostAuth::Password { .. } => "(password)",
            HostAuth::PrivateKey { .. } => "(key)",
            HostAuth::Agent => "(agent)",
        };
        println!(
            "{:<width$}  {}@{}:{} {}",
            h.name,
            h.user,
            h.host,
            h.port,
            auth_tag,
            width = name_w
        );
    }
    Ok(())
}

fn cmd_add(
    args: &Args,
    vault_path: &Path,
    name: &str,
    target: &str,
    identity: Option<PathBuf>,
    port_override: Option<u16>,
) -> Result<()> {
    let target = parse_target(target, port_override)?;
    let app = open_app(args, vault_path, /*create_if_missing*/ true)?;

    let auth = build_host_auth(&target, identity, args.agent)?;
    let host = Host {
        id: String::new(),
        name: name.to_string(),
        host: target.host,
        port: target.port,
        user: target.user,
        auth,
        os_type: None,
        forwards: Vec::new(),
        proxy_jump: None,
    };

    let id = app.save_host(&host)?;
    println!("saved '{}' (id: {})", name, id);
    Ok(())
}

fn cmd_remove(args: &Args, vault_path: &Path, name: &str) -> Result<()> {
    if !App::vault_exists(vault_path) {
        bail!("no vault at {}", vault_path.display());
    }
    let app = open_app(args, vault_path, false)?;
    let host = app
        .find_host_by_name(name)?
        .ok_or_else(|| anyhow!("no host named '{}'", name))?;
    app.delete_host(&host.id)?;
    println!("removed '{}'", name);
    Ok(())
}

fn cmd_forward(args: &Args, vault_path: &Path, action: &ForwardAction) -> Result<()> {
    let app = open_app(args, vault_path, false)?;
    match action {
        ForwardAction::List { host } => {
            let h = app
                .find_host_by_name(host)?
                .ok_or_else(|| anyhow!("no host named '{host}'"))?;
            if let Some(jump) = &h.proxy_jump {
                println!("ProxyJump: {jump}");
            }
            if h.forwards.is_empty() {
                println!("(no forwards)");
            } else {
                for (i, f) in h.forwards.iter().enumerate() {
                    println!("{i}: {}", f.summary());
                }
            }
        }
        ForwardAction::Add {
            host,
            local,
            dynamic,
        } => {
            let mut h = app
                .find_host_by_name(host)?
                .ok_or_else(|| anyhow!("no host named '{host}'"))?;
            if local.is_some() == dynamic.is_some() {
                bail!("pass exactly one of --local or --dynamic");
            }
            let new_spec = if let Some(spec) = local {
                let lf = parse_local_forward(spec)?;
                zeroterm_app::ForwardSpec::Local {
                    bind_addr: lf.bind_addr,
                    bind_port: lf.bind_port,
                    target_host: lf.target_host,
                    target_port: lf.target_port,
                }
            } else {
                let df = parse_dynamic_forward(dynamic.as_ref().unwrap())?;
                zeroterm_app::ForwardSpec::Dynamic {
                    bind_addr: df.bind_addr,
                    bind_port: df.bind_port,
                }
            };
            h.forwards.push(new_spec.clone());
            app.update_host(&h)?;
            println!("added {} to '{host}'", new_spec.summary());
        }
        ForwardAction::Remove { host, index } => {
            let mut h = app
                .find_host_by_name(host)?
                .ok_or_else(|| anyhow!("no host named '{host}'"))?;
            if *index >= h.forwards.len() {
                bail!("index {index} out of range (have {} forwards)", h.forwards.len());
            }
            let removed = h.forwards.remove(*index);
            app.update_host(&h)?;
            println!("removed {} from '{host}'", removed.summary());
        }
        ForwardAction::Jump { host, jump, clear } => {
            let mut h = app
                .find_host_by_name(host)?
                .ok_or_else(|| anyhow!("no host named '{host}'"))?;
            if *clear {
                h.proxy_jump = None;
                println!("cleared ProxyJump on '{host}'");
            } else if let Some(j) = jump {
                if app.find_host_by_name(j)?.is_none() {
                    bail!("no host named '{j}' to use as jump");
                }
                h.proxy_jump = Some(j.clone());
                println!("set '{host}' ProxyJump to '{j}'");
            } else {
                bail!("pass either an alias or --clear");
            }
            app.update_host(&h)?;
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------
// helpers — vault, auth, host-key
// --------------------------------------------------------------------------

fn resolve_vault_path(override_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = override_path {
        return Ok(p);
    }
    default_vault_path()
        .ok_or_else(|| anyhow!("could not locate user data dir for default vault path"))
}

fn open_app(args: &Args, path: &Path, create_if_missing: bool) -> Result<App> {
    open_app_with_remember(path, create_if_missing, args.remember)
}

fn open_app_with_remember(
    path: &Path,
    create_if_missing: bool,
    remember: bool,
) -> Result<App> {
    if App::vault_exists(path) {
        // Try keychain-cached password first.
        if let Some(cached) = keychain_load(path) {
            match App::open(path, &cached) {
                Ok(app) => {
                    debug!("vault unlocked from keychain cache");
                    return Ok(app);
                }
                Err(zeroterm_app::AppError::Vault(
                    zeroterm_app::VaultError::AuthenticationFailed,
                )) => {
                    warn!(
                        "cached master password no longer matches — falling back to prompt. \
                         Run `zeroterm forget` if you'd rather not be re-prompted."
                    );
                }
                Err(e) => return Err(anyhow!(e)),
            }
        }

        let pw = rpassword::prompt_password("Master password: ")?;
        let app = App::open(path, &pw).map_err(|e| anyhow!(e))?;
        if remember {
            keychain_save(path, &pw);
        }
        Ok(app)
    } else if create_if_missing {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating vault dir {}", parent.display()))?;
        }
        eprintln!("Creating new vault at {}.", path.display());
        eprintln!("Choose a master password. THIS CANNOT BE RECOVERED — if you forget");
        eprintln!("it, every saved credential is permanently lost.");
        let pw1 = rpassword::prompt_password("Master password: ")?;
        if pw1.is_empty() {
            bail!("password cannot be empty");
        }
        let pw2 = rpassword::prompt_password("Confirm: ")?;
        if pw1 != pw2 {
            bail!("passwords don't match");
        }
        let app = App::create(path, &pw1).map_err(|e| anyhow!(e))?;
        if remember {
            keychain_save(path, &pw1);
        }
        Ok(app)
    } else {
        bail!("no vault at {}", path.display())
    }
}

/// Fetch a cached password if the keychain is reachable. Backend errors
/// are logged and treated as cache miss — never propagated.
fn keychain_load(path: &Path) -> Option<String> {
    match zeroterm_app::keychain::get_master_password(path) {
        Ok(opt) => opt,
        Err(e) => {
            debug!(error = %e, "keychain unavailable, will prompt");
            None
        }
    }
}

fn keychain_save(path: &Path, password: &str) {
    match zeroterm_app::keychain::save_master_password(path, password) {
        Ok(()) => info!("master password cached in OS keychain"),
        Err(e) => warn!(error = %e, "could not cache master password in keychain"),
    }
}

fn build_host_key_policy(args: &Args) -> Result<HostKeyPolicy> {
    if args.insecure_skip_host_key_check {
        warn!("host-key verification disabled (--insecure-skip-host-key-check)");
        return Ok(HostKeyPolicy::AcceptAll);
    }
    let store = match &args.known_hosts {
        Some(p) => KnownHosts::new(p.clone()),
        None => KnownHosts::at_default()
            .ok_or_else(|| anyhow!("could not locate $HOME for default known_hosts"))?,
    };
    Ok(HostKeyPolicy::Interactive {
        store,
        prompt: Arc::new(StdioHostKeyPrompt),
    })
}

fn build_direct_auth_methods(args: &Args, target: &Target) -> Result<Vec<AuthMethod>> {
    let mut methods: Vec<AuthMethod> = Vec::new();

    if args.agent {
        methods.push(AuthMethod::Agent);
    }

    for path in &args.identities {
        let needs_passphrase = key_needs_passphrase(path).unwrap_or(false);
        let passphrase = if needs_passphrase {
            Some(rpassword::prompt_password(format!(
                "Passphrase for {}: ",
                path.display()
            ))?)
        } else {
            None
        };
        methods.push(AuthMethod::PrivateKey {
            path: path.clone(),
            passphrase,
        });
    }
    if methods.is_empty() {
        let password = rpassword::prompt_password(format!(
            "{}@{}'s password: ",
            target.user, target.host
        ))?;
        methods.push(AuthMethod::Password(password));
    }
    Ok(methods)
}

fn build_host_auth(target: &Target, identity: Option<PathBuf>, use_agent: bool) -> Result<HostAuth> {
    if use_agent {
        if identity.is_some() {
            bail!("`add` accepts either --agent or --identity, not both");
        }
        return Ok(HostAuth::Agent);
    }

    if let Some(path) = identity {
        let pem = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let needs_passphrase = pem.contains("ENCRYPTED");
        let passphrase = if needs_passphrase {
            Some(rpassword::prompt_password(format!(
                "Passphrase for {}: ",
                path.display()
            ))?)
        } else {
            None
        };
        Ok(HostAuth::PrivateKey {
            key_pem: pem,
            passphrase,
        })
    } else {
        let value = rpassword::prompt_password(format!(
            "Password for {}@{}: ",
            target.user, target.host
        ))?;
        Ok(HostAuth::Password { value })
    }
}

fn key_needs_passphrase(path: &Path) -> std::io::Result<bool> {
    let bytes = std::fs::read(path)?;
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]);
    Ok(head.contains("ENCRYPTED"))
}

struct StdioHostKeyPrompt;

#[async_trait]
impl HostKeyPrompt for StdioHostKeyPrompt {
    async fn on_unknown(&self, info: HostKeyInfo) -> bool {
        eprintln!();
        eprintln!(
            "The authenticity of host '{}:{}' can't be established.",
            info.host, info.port
        );
        eprintln!("{} key fingerprint is {}.", info.key_type, info.fingerprint);
        prompt_yes_no("Are you sure you want to continue connecting (yes/no)? ").await
    }

    async fn on_mismatch(&self, info: HostKeyInfo, stored: String) -> MismatchAction {
        eprintln!();
        eprintln!("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        eprintln!("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @");
        eprintln!("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
        eprintln!(
            "Server '{}:{}' offered: {} {}",
            info.host, info.port, info.key_type, info.fingerprint
        );
        eprintln!("known_hosts has:    {}", stored);
        eprintln!("This could be a man-in-the-middle attack — refuse unless you");
        eprintln!("know exactly why the key changed (e.g. server reinstall).");
        if prompt_yes_no("Continue anyway just for this connection (yes/no)? ").await {
            MismatchAction::AcceptOnce
        } else {
            MismatchAction::Reject
        }
    }
}

async fn prompt_yes_no(prompt: &str) -> bool {
    eprint!("{}", prompt);
    let _ = std::io::stderr().flush();
    let mut reader = BufReader::new(tokio::io::stdin());
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

// --------------------------------------------------------------------------
// interactive shell
// --------------------------------------------------------------------------

async fn run_interactive(mut channel: zeroterm_ssh::ShellChannel) -> Result<u32> {
    enable_raw_mode().context("enable raw mode")?;
    let _guard = RawModeGuard;

    let (tx, mut rx) = mpsc::channel::<InputEvent>(64);

    let input_task = tokio::spawn(async move {
        let mut events = EventStream::new();
        while let Some(ev) = events.next().await {
            match ev {
                Ok(Event::Key(k)) => {
                    if let Some(bytes) = key_to_bytes(&k) {
                        if tx.send(InputEvent::Bytes(bytes)).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(Event::Resize(cols, rows)) => {
                    if tx.send(InputEvent::Resize(cols, rows)).await.is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    warn!(error = %e, "terminal event error");
                    break;
                }
            }
        }
    });

    let mut stdout = stdout();
    let mut exit_code: u32 = 0;

    loop {
        tokio::select! {
            ev = channel.recv() => match ev {
                ChannelEvent::Data(bytes) | ChannelEvent::Stderr(bytes) => {
                    stdout.write_all(&bytes)?;
                    stdout.flush()?;
                }
                ChannelEvent::Exit(code) => {
                    exit_code = code;
                    debug!(code, "remote exited");
                }
                ChannelEvent::Closed => {
                    debug!("channel closed");
                    break;
                }
            },
            maybe = rx.recv() => match maybe {
                Some(InputEvent::Bytes(b)) => channel.send(&b).await?,
                Some(InputEvent::Resize(cols, rows)) => {
                    channel.resize(PtySize::new(cols, rows)).await?;
                }
                None => {
                    debug!("input stream ended");
                }
            }
        }
    }

    input_task.abort();
    Ok(exit_code)
}

#[derive(Debug)]
enum InputEvent {
    Bytes(Vec<u8>),
    Resize(u16, u16),
}

struct RawModeGuard;
impl Drop for RawModeGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

fn key_to_bytes(k: &KeyEvent) -> Option<Vec<u8>> {
    if k.kind == KeyEventKind::Release {
        return None;
    }

    let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
    let alt = k.modifiers.contains(KeyModifiers::ALT);

    let bytes = match k.code {
        KeyCode::Char(c) => {
            if ctrl {
                let lc = c.to_ascii_lowercase();
                let b = match lc {
                    '@' => 0x00,
                    'a'..='z' => (lc as u8) - b'a' + 1,
                    '[' => 0x1b,
                    '\\' => 0x1c,
                    ']' => 0x1d,
                    '^' => 0x1e,
                    '_' => 0x1f,
                    '?' => 0x7f,
                    _ => return Some(c.to_string().into_bytes()),
                };
                let mut out = Vec::with_capacity(2);
                if alt {
                    out.push(0x1b);
                }
                out.push(b);
                out
            } else {
                let mut buf = [0u8; 4];
                let s = c.encode_utf8(&mut buf);
                let mut out = Vec::with_capacity(s.len() + 1);
                if alt {
                    out.push(0x1b);
                }
                out.extend_from_slice(s.as_bytes());
                out
            }
        }
        KeyCode::Enter => b"\r".to_vec(),
        KeyCode::Tab => b"\t".to_vec(),
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Backspace => b"\x7f".to_vec(),
        KeyCode::Esc => b"\x1b".to_vec(),
        KeyCode::Up => b"\x1b[A".to_vec(),
        KeyCode::Down => b"\x1b[B".to_vec(),
        KeyCode::Right => b"\x1b[C".to_vec(),
        KeyCode::Left => b"\x1b[D".to_vec(),
        KeyCode::Home => b"\x1b[H".to_vec(),
        KeyCode::End => b"\x1b[F".to_vec(),
        KeyCode::PageUp => b"\x1b[5~".to_vec(),
        KeyCode::PageDown => b"\x1b[6~".to_vec(),
        KeyCode::Delete => b"\x1b[3~".to_vec(),
        KeyCode::Insert => b"\x1b[2~".to_vec(),
        _ => return None,
    };
    Some(bytes)
}
