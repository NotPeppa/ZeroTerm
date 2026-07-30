//! Server-to-server copies that never touch this machine.
//!
//! The relay path in [`crate::sftp::tree::pipe_remote_file_to_remote`] streams
//! `A -> here -> B`, so a remote-to-remote copy is capped by *our* uplink even
//! when both servers sit on gigabit links. This module runs `rsync`/`scp` on
//! the source host instead, so the bytes go straight from A to B.
//!
//! The thing that makes it possible is SSH agent forwarding: A has no
//! credentials for B, so we lend it ours for the duration of the command
//! (see [`zeroterm_ssh::Session::exec_forwarding_agent`]). That is also why
//! this path is strictly opt-in per transfer and falls back to the relay
//! rather than trying to make itself work — see [`probe`].
//!
//! Host key checking is *never* relaxed. A gets a temporary `known_hosts`
//! containing the keys we already verified for B; if we have none to lend,
//! direct copying is reported unavailable and the caller relays.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio_util::sync::CancellationToken;
use tracing::warn;
use zeroterm_ssh::{decode_secret_key, AuthMethod, ExecStream, KnownHosts, PrivateKey, Session};

use crate::connect::build_connect_chain_for_host;
use crate::sftp::{ipc_error, string_error};
use crate::state::AppState;

/// How a finished copy actually moved its bytes, so the UI can explain a slow
/// transfer instead of leaving the user guessing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransferRoute {
    Direct,
    Relay,
}

impl TransferRoute {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Relay => "relay",
        }
    }
}

/// Probe results go stale (a host reboots, a key is revoked) but re-probing
/// costs a full SSH round trip plus an auth handshake, which would be paid
/// per-file on a directory tree. A minute is long enough to cover one tree.
const PROBE_TTL: Duration = Duration::from_secs(60);

/// How long the probe waits for A to reach B before declaring direct
/// unavailable. Deliberately short: the fallback is always available, so
/// spending 30s discovering a firewall is worse than just relaying.
const PROBE_CONNECT_TIMEOUT_SECS: u32 = 10;

/// Exit codes the remote preamble reserves for its own failures. Chosen high
/// to avoid colliding with anything `rsync` (0-35) or `scp` return.
const EXIT_TMPDIR_UNSAFE: u32 = 96;
const EXIT_MKTEMP_FAILED: u32 = 97;

/// Heredoc delimiter for the `known_hosts` payload. Quoted at the shell so
/// nothing inside is expanded; [`build_preamble`] refuses payloads that could
/// terminate it early.
const KH_DELIMITER: &str = "ZEROTERM_KNOWN_HOSTS_EOF";

/// Single-quote `s` for safe interpolation into a POSIX shell command.
///
/// Everything user- or vault-controlled that reaches the remote shell —
/// paths, hostnames, usernames — must go through this. Inside single quotes
/// the shell expands nothing at all, so the only character needing care is
/// the quote itself: close, emit an escaped quote, reopen.
pub(crate) fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Which copy tool the source host has available. `rsync` is preferred: it
/// reports machine-readable aggregate progress and handles trees natively.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopyTool {
    Rsync,
    Scp,
}

/// Everything needed to launch a direct copy, cached per host pair.
#[derive(Debug, Clone)]
pub(crate) struct DirectPlan {
    tool: CopyTool,
    /// Raw `user@host` for the destination. Shell-quoted at the point of use,
    /// never stored quoted, so it can't be double-quoted by accident.
    target_login: String,
    target_port: u16,
    /// Canonical `known_hosts` lines for the destination, taken from keys we
    /// already verified ourselves.
    known_hosts_lines: Vec<String>,
    /// Destination credentials lent to the source host's copy command via the
    /// in-process agent. Empty means "proxy the system agent" (the pre-vault
    /// behavior, still right when the destination is configured for agent
    /// auth).
    identities: LentIdentities,
}

/// Vault keys destined for the forwarded agent. A newtype purely so
/// `DirectPlan`'s derived `Debug` can never print key material.
#[derive(Clone, Default)]
pub(crate) struct LentIdentities(Vec<Arc<PrivateKey>>);

impl std::fmt::Debug for LentIdentities {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LentIdentities({} key(s))", self.0.len())
    }
}

/// Why a host pair can't use the direct path. Carried so the caller can log
/// something actionable rather than a bare "falling back".
#[derive(Debug, Clone)]
pub(crate) struct DirectUnavailable(pub String);

type ProbeCache = HashMap<(String, String), (Instant, Result<DirectPlan, DirectUnavailable>)>;

/// Cached [`probe`] verdicts keyed by `(source_host_id, target_host_id)`.
#[derive(Default)]
pub(crate) struct DirectProbeCache(Mutex<ProbeCache>);

impl DirectProbeCache {
    fn get(&self, key: &(String, String)) -> Option<Result<DirectPlan, DirectUnavailable>> {
        let cache = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (at, verdict) = cache.get(key)?;
        (at.elapsed() < PROBE_TTL).then(|| verdict.clone())
    }

    fn put(&self, key: (String, String), verdict: Result<DirectPlan, DirectUnavailable>) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key, (Instant::now(), verdict));
    }

    pub(crate) fn clear(&self) {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }
}

/// The shell preamble that materialises B's `known_hosts` on A.
///
/// `mktemp` gives a race-free private file; the `trap` removes it however the
/// script exits, including when we drop the channel to cancel. The whitespace
/// check exists because the path is interpolated into `rsync -e`, which word-
/// splits its argument — bailing out (and relaying) beats mis-parsing an
/// `ssh` invocation that carries our host key checking.
fn build_preamble(known_hosts_lines: &[String]) -> Result<String, String> {
    if known_hosts_lines.iter().any(|l| l.trim() == KH_DELIMITER) {
        return Err(string_error(
            "known_hosts entry collides with the heredoc delimiter",
        ));
    }
    Ok(format!(
        "KH=$(mktemp) || exit {EXIT_MKTEMP_FAILED}\n\
         trap 'rm -f \"$KH\"' EXIT INT TERM HUP\n\
         case \"$KH\" in *[[:space:]]*) exit {EXIT_TMPDIR_UNSAFE} ;; esac\n\
         cat > \"$KH\" <<'{KH_DELIMITER}'\n\
         {}\n\
         {KH_DELIMITER}\n",
        known_hosts_lines.join("\n")
    ))
}

/// `-o` flags shared by the probe and the transfer. `BatchMode=yes` keeps a
/// misconfigured host from hanging on a password prompt with no tty, and
/// `StrictHostKeyChecking=yes` (never `no`, never `accept-new`) makes the
/// lent `known_hosts` authoritative.
fn ssh_options() -> String {
    format!(
        "-o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KH \
         -o ConnectTimeout={PROBE_CONNECT_TIMEOUT_SECS}"
    )
}

/// Ask the source host whether it can copy straight to the destination.
///
/// One round trip answers everything that matters: whether a copy tool
/// exists, whether A can reach B's SSH port, and whether agent forwarding
/// actually produced a working credential. Any "no" means relay.
async fn probe(
    session: &Session,
    target_login: &str,
    target_port: u16,
    known_hosts_lines: &[String],
    identities: LentIdentities,
) -> Result<DirectPlan, DirectUnavailable> {
    let preamble = match build_preamble(known_hosts_lines) {
        Ok(p) => p,
        Err(e) => return Err(DirectUnavailable(e)),
    };
    let opts = ssh_options();
    let script = format!(
        "{preamble}\
         command -v rsync >/dev/null 2>&1 && echo ZT_RSYNC\n\
         command -v scp >/dev/null 2>&1 && echo ZT_SCP\n\
         ssh {opts} -p {target_port} {login} true >/dev/null 2>&1 && echo ZT_AUTH_OK\n\
         exit 0\n",
        login = sh_quote(target_login),
    );

    let mut out = String::new();
    let status = session
        .exec_forwarding_agent_with_identities(&script, identities.0.clone(), |stream, chunk| {
            if stream == ExecStream::Stdout {
                out.push_str(&String::from_utf8_lossy(chunk));
            }
        })
        .await
        .map_err(|e| DirectUnavailable(format!("probe failed: {e}")))?;

    match status {
        EXIT_TMPDIR_UNSAFE => {
            return Err(DirectUnavailable(
                "source host's temp directory path contains whitespace".into(),
            ))
        }
        EXIT_MKTEMP_FAILED => {
            return Err(DirectUnavailable(
                "source host could not create a temp file".into(),
            ))
        }
        _ => {}
    }

    if !out.contains("ZT_AUTH_OK") {
        return Err(DirectUnavailable(
            "source host could not authenticate to the destination \
             (no forwarded agent key accepted, or the host is unreachable)"
                .into(),
        ));
    }
    let tool = if out.contains("ZT_RSYNC") {
        CopyTool::Rsync
    } else if out.contains("ZT_SCP") {
        CopyTool::Scp
    } else {
        return Err(DirectUnavailable(
            "source host has neither rsync nor scp".into(),
        ));
    };

    Ok(DirectPlan {
        tool,
        target_login: target_login.to_string(),
        target_port,
        known_hosts_lines: known_hosts_lines.to_vec(),
        identities,
    })
}

/// Resolve (and cache) whether `source_host_id` can copy directly to
/// `target_host_id`.
///
/// A destination behind a ProxyJump is rejected outright: the jump is *our*
/// route to it, and the source host has no reason to share it.
pub(crate) async fn plan_direct_copy(
    state: &AppState,
    app_handle: &AppHandle,
    source_host_id: &str,
    target_host_id: &str,
) -> Result<DirectPlan, DirectUnavailable> {
    let key = (source_host_id.to_string(), target_host_id.to_string());
    if let Some(cached) = state.direct_probes.get(&key) {
        return cached;
    }

    let verdict = plan_uncached(state, app_handle, source_host_id, target_host_id).await;
    state.direct_probes.put(key, verdict.clone());
    verdict
}

async fn plan_uncached(
    state: &AppState,
    app_handle: &AppHandle,
    source_host_id: &str,
    target_host_id: &str,
) -> Result<DirectPlan, DirectUnavailable> {
    let (target_host, target_cfg, target_jump) =
        build_connect_chain_for_host(state, app_handle, target_host_id)
            .map_err(DirectUnavailable)?;
    if target_jump.is_some() || target_host.proxy_jump_host_id.is_some() {
        return Err(DirectUnavailable(
            "destination is reached through a ProxyJump this machine provides".into(),
        ));
    }

    // Work out which credentials the source host can be lent for the
    // destination. A vault-stored key is decoded here and served by the
    // in-process agent; agent auth keeps the old system-agent proxy; a
    // password can't cross an agent channel at all, so say so up front
    // instead of paying a probe that is guaranteed to fail.
    let mut lent_keys: Vec<Arc<PrivateKey>> = Vec::new();
    let mut has_agent_auth = false;
    for method in &target_cfg.auth_methods {
        match method {
            AuthMethod::PrivateKeyData { pem, passphrase } => {
                let key = decode_secret_key(pem, passphrase.as_deref()).map_err(|e| {
                    DirectUnavailable(format!(
                        "destination key from the vault could not be decoded: {e}"
                    ))
                })?;
                lent_keys.push(Arc::new(key));
            }
            AuthMethod::PrivateKey { path, passphrase } => {
                let pem = std::fs::read_to_string(path).map_err(|e| {
                    DirectUnavailable(format!(
                        "destination key file {} could not be read: {e}",
                        path.display()
                    ))
                })?;
                let key = decode_secret_key(&pem, passphrase.as_deref()).map_err(|e| {
                    DirectUnavailable(format!(
                        "destination key file {} could not be decoded: {e}",
                        path.display()
                    ))
                })?;
                lent_keys.push(Arc::new(key));
            }
            AuthMethod::Agent => has_agent_auth = true,
            AuthMethod::Password(_) => {}
        }
    }
    if lent_keys.is_empty() && !has_agent_auth {
        return Err(DirectUnavailable(
            "destination host is configured for password authentication; \
             a direct copy needs key-based auth (a vault key, key file, or \
             ssh-agent identity the destination accepts)"
                .into(),
        ));
    }
    let identities = LentIdentities(lent_keys);

    let known_hosts = KnownHosts::at_default()
        .ok_or_else(|| DirectUnavailable("could not locate known_hosts".into()))?;
    let lines = known_hosts
        .trusted_lines(&target_cfg.host, target_cfg.port)
        .map_err(|e| DirectUnavailable(format!("reading known_hosts: {e}")))?;
    if lines.is_empty() {
        // Refusing here is the point: the alternative would be telling the
        // source host to skip host key verification.
        return Err(DirectUnavailable(format!(
            "no verified host key on file for {}; refusing to have the source host \
             connect without one",
            target_cfg.host
        )));
    }

    let (_src_host, src_cfg, src_jump) =
        build_connect_chain_for_host(state, app_handle, source_host_id)
            .map_err(DirectUnavailable)?;
    let session = state
        .sftp_pool
        .acquire_session(source_host_id.to_string(), src_cfg, src_jump)
        .await
        .map_err(DirectUnavailable)?;

    let login = format!("{}@{}", target_cfg.username, target_cfg.host);
    probe(&session, &login, target_cfg.port, &lines, identities).await
}

/// Build the copy invocation that runs inside [`build_preamble`]'s shell.
///
/// Split out from [`run_direct_copy`] so the quoting can be tested without a
/// live pair of hosts — it's the part where a mistake is both easy to make
/// and expensive (a mis-quoted `-e` silently disables host key checking's
/// key source; a mis-quoted path is a command injection).
fn build_copy_command(plan: &DirectPlan, source_path: &str, dest_path: &str, is_dir: bool) -> String {
    let opts = ssh_options();
    let port = plan.target_port;
    let remote_spec = sh_quote(&format!("{}:{}", plan.target_login, dest_path));

    match plan.tool {
        CopyTool::Rsync => {
            // A trailing slash on a directory source copies its *contents*
            // into dest, which is what makes dest the copy rather than its
            // parent. Files take no slash.
            let src = if is_dir {
                sh_quote(&format!("{}/", source_path.trim_end_matches('/')))
            } else {
                sh_quote(source_path)
            };
            // Double quotes, not single: `$KH` has to expand to the temp
            // known_hosts the preamble created. Safe because everything in
            // this string is ours — `opts` is a fixed set of flags and `port`
            // is a u16. User-controlled values (paths, login) are
            // single-quoted separately.
            format!("rsync -a --info=progress2 -e \"ssh {opts} -p {port}\" -- {src} {remote_spec}")
        }
        CopyTool::Scp => {
            let recurse = if is_dir { "-r " } else { "" };
            format!(
                "scp {recurse}-p {opts} -P {port} -- {src} {remote_spec}",
                src = sh_quote(source_path),
            )
        }
    }
}

/// Run the copy on the source host.
///
/// `on_bytes` receives a running total when the tool reports one; `scp` does
/// not, so callers that need progress there poll the destination themselves.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_direct_copy<F>(
    state: &AppState,
    app_handle: &AppHandle,
    source_host_id: &str,
    plan: &DirectPlan,
    source_path: &str,
    dest_path: &str,
    is_dir: bool,
    cancel: CancellationToken,
    mut on_bytes: F,
) -> Result<(), String>
where
    F: FnMut(u64) + Send,
{
    let (_src_host, src_cfg, src_jump) =
        build_connect_chain_for_host(state, app_handle, source_host_id)?;
    let session = state
        .sftp_pool
        .acquire_session(source_host_id.to_string(), src_cfg, src_jump)
        .await?;

    let preamble = build_preamble(&plan.known_hosts_lines)?;
    let command = build_copy_command(plan, source_path, dest_path, is_dir);

    // `-e`/`-o` reference $KH, so the tool has to run inside the preamble's
    // shell rather than as a separate exec.
    let script = format!("{preamble}{command}\n");

    // Shared rather than borrowed: the output closure lives inside the exec
    // future, and we need to read the tails after that future is consumed.
    let stdout_tail = std::sync::Arc::new(Mutex::new(String::new()));
    let stderr_tail = std::sync::Arc::new(Mutex::new(String::new()));
    let stdout_for_cb = std::sync::Arc::clone(&stdout_tail);
    let stderr_for_cb = std::sync::Arc::clone(&stderr_tail);

    let exec = session.exec_forwarding_agent_with_identities(
        &script,
        plan.identities.0.clone(),
        move |stream, chunk| {
            let text = String::from_utf8_lossy(chunk);
            match stream {
                ExecStream::Stdout => {
                    if let Some(bytes) = parse_rsync_progress(&text) {
                        on_bytes(bytes);
                    }
                    push_tail(
                        &mut stdout_for_cb.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
                        &text,
                    );
                }
                ExecStream::Stderr => push_tail(
                    &mut stderr_for_cb.lock().unwrap_or_else(std::sync::PoisonError::into_inner),
                    &text,
                ),
            }
        },
    );

    let status = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            // Dropping the exec future closes the channel, which HUPs the
            // remote shell; its trap removes the lent known_hosts.
            return Err(ipc_error("CANCELLED", "transfer cancelled"));
        }
        status = exec => status.map_err(|e| format!("direct copy: {e}"))?,
    };

    match status {
        0 => Ok(()),
        EXIT_TMPDIR_UNSAFE => Err(string_error(
            "source host's temp directory path contains whitespace",
        )),
        EXIT_MKTEMP_FAILED => Err(string_error("source host could not create a temp file")),
        code => {
            let stderr = stderr_tail.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let stdout = stdout_tail.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let detail = if stderr.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                stderr.trim().to_string()
            };
            Err(string_error(format!(
                "direct copy exited with status {code}{}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            )))
        }
    }
}

/// Keep only the last few hundred bytes of a stream for error reporting —
/// `rsync` on a large tree would otherwise accumulate megabytes we never use.
fn push_tail(buf: &mut String, chunk: &str) {
    const KEEP: usize = 512;
    buf.push_str(chunk);
    if buf.len() > KEEP * 2 {
        let cut = buf.len() - KEEP;
        // Don't split a multi-byte character.
        let cut = (cut..buf.len())
            .find(|i| buf.is_char_boundary(*i))
            .unwrap_or(buf.len());
        *buf = buf[cut..].to_string();
    }
}

/// Pull the running byte total out of `rsync --info=progress2` output.
///
/// The format is `<bytes> <pct>% <rate> <elapsed>`, redrawn with carriage
/// returns rather than newlines, and the byte count is thousands-separated.
/// Returns the last complete figure in `chunk`, or `None` when the chunk
/// holds no progress line (rsync also prints file names and a summary).
fn parse_rsync_progress(chunk: &str) -> Option<u64> {
    let mut latest = None;
    for field in chunk.split(['\r', '\n']) {
        let field = field.trim_start();
        let mut parts = field.split_whitespace();
        let (Some(bytes), Some(pct)) = (parts.next(), parts.next()) else {
            continue;
        };
        // The percentage column is what distinguishes a progress redraw from
        // rsync's other output, which also starts with digits sometimes.
        if !pct.ends_with('%') {
            continue;
        }
        let digits: String = bytes.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || bytes.chars().any(|c| !c.is_ascii_digit() && c != ',') {
            continue;
        }
        if let Ok(n) = digits.parse::<u64>() {
            latest = Some(n);
        }
    }
    latest
}

impl DirectPlan {
    /// Whether the chosen tool reports its own byte progress. `rsync` does
    /// (`--info=progress2`); `scp` doesn't, so callers poll the destination.
    pub(crate) fn reports_progress(&self) -> bool {
        matches!(self.tool, CopyTool::Rsync)
    }
}

/// Outcome of trying to move one file server-to-server.
pub(crate) enum DirectAttempt {
    /// Bytes landed at the final destination.
    Done(u64),
    /// Direct is not usable here; the caller should relay. Carries the reason
    /// for the log — nothing has been written to the destination.
    Fallback(String),
    /// The user cancelled. Must not be retried via the relay.
    Cancelled,
}

/// Below this size, relaying wins.
///
/// A direct copy pays a fresh `A -> B` SSH handshake per file (~100-300ms on
/// a WAN link), while the relay reuses SFTP channels we already hold open.
/// That trade only pays off once the transfer itself would take longer than
/// the handshake: at a typical 1 MB/s relay ceiling, 4 MiB costs ~4s to
/// relay versus well under 1s to copy directly. Small files in a directory
/// tree would otherwise turn one connection into thousands.
const MIN_DIRECT_COPY_BYTES: u64 = 4 * 1024 * 1024;

/// Whether a file of this size is worth copying directly.
///
/// `None` means the source couldn't be stat'd — relay, and let the relay
/// path surface the real error rather than guessing at it here.
fn worth_copying_directly(size: Option<u64>) -> bool {
    matches!(size, Some(size) if size >= MIN_DIRECT_COPY_BYTES)
}

/// Copy one file straight from the source host to the destination host.
///
/// Mirrors the relay path's safety discipline: the tool writes to a
/// `.zeroterm-part-*` sibling and only then is renamed into place, so a
/// failure here leaves the destination untouched and falling back to the
/// relay can't produce a half-written file. The temp name is the same shape
/// the existing stale-temp reaper already recognises
/// (`cleanup_stale_remote_temp_entries`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn try_direct_file_copy(
    state: &AppState,
    app_handle: &AppHandle,
    source_host_id: &str,
    target_host_id: &str,
    source: &str,
    target: &str,
    size_hint: Option<u64>,
    overwrite: bool,
    cancel: CancellationToken,
    source_sftp: &zeroterm_ssh::Sftp,
    target_sftp: &zeroterm_ssh::Sftp,
    progress: &mut (dyn FnMut(zeroterm_ssh::ProgressTick) + Send),
) -> DirectAttempt {
    // The tree walker doesn't carry sizes, so resolve one here. The relay
    // path stats the source too (inside the parallel downloader), so this
    // isn't an extra round trip overall — just an earlier one.
    let size = match size_hint {
        Some(size) => Some(size),
        None => source_sftp.stat(source).await.ok().map(|m| m.size),
    };
    if !worth_copying_directly(size) {
        return DirectAttempt::Fallback(match size {
            Some(size) => format!(
                "file is {size} bytes, below the {MIN_DIRECT_COPY_BYTES}-byte direct-copy threshold"
            ),
            None => "could not size the source file".into(),
        });
    }
    let plan = match plan_direct_copy(state, app_handle, source_host_id, target_host_id).await {
        Ok(plan) => plan,
        Err(DirectUnavailable(reason)) => return DirectAttempt::Fallback(reason),
    };

    let temp_target = crate::sftp::file::unique_remote_temp_path(target, "part");
    let result = run_file_copy_with_progress(
        state,
        app_handle,
        source_host_id,
        &plan,
        source,
        &temp_target,
        size,
        cancel.clone(),
        target_sftp,
        progress,
    )
    .await;

    if let Err(err) = result {
        cleanup_direct_temp_file(target_sftp, &temp_target).await;
        if cancel.is_cancelled() {
            return DirectAttempt::Cancelled;
        }
        return DirectAttempt::Fallback(err);
    }

    // Size the result from the destination rather than trusting the tool's
    // own accounting, so the transfer event matches what actually landed.
    let bytes = target_sftp
        .stat(&temp_target)
        .await
        .map(|m| m.size)
        .unwrap_or_else(|_| size.unwrap_or(0));

    if let Err(err) =
        crate::sftp::file::finalize_remote_upload_target(target_sftp, &temp_target, target, overwrite)
            .await
    {
        cleanup_direct_temp_file(target_sftp, &temp_target).await;
        return DirectAttempt::Fallback(format!("renaming into place: {err}"));
    }

    progress(zeroterm_ssh::ProgressTick {
        bytes_done: bytes,
        total: size.or(Some(bytes)),
    });
    DirectAttempt::Done(bytes)
}

/// Drive [`run_direct_copy`] while keeping the progress UI fed.
///
/// `rsync` reports totals on stdout, so its progress rides the output stream.
/// `scp` reports nothing machine-readable, so the destination file is stat'd
/// on a timer instead — cheap, and it uses the SFTP channel we already hold.
#[allow(clippy::too_many_arguments)]
async fn run_file_copy_with_progress(
    state: &AppState,
    app_handle: &AppHandle,
    source_host_id: &str,
    plan: &DirectPlan,
    source: &str,
    temp_target: &str,
    size_hint: Option<u64>,
    cancel: CancellationToken,
    target_sftp: &zeroterm_ssh::Sftp,
    progress: &mut (dyn FnMut(zeroterm_ssh::ProgressTick) + Send),
) -> Result<(), String> {
    progress(zeroterm_ssh::ProgressTick {
        bytes_done: 0,
        total: size_hint,
    });

    if plan.reports_progress() {
        return run_direct_copy(
            state,
            app_handle,
            source_host_id,
            plan,
            source,
            temp_target,
            false,
            cancel,
            |bytes_done| {
                progress(zeroterm_ssh::ProgressTick {
                    bytes_done,
                    total: size_hint,
                })
            },
        )
        .await;
    }

    let copy = run_direct_copy(
        state,
        app_handle,
        source_host_id,
        plan,
        source,
        temp_target,
        false,
        cancel,
        |_| {},
    );
    tokio::pin!(copy);

    let mut ticker = tokio::time::interval(Duration::from_millis(500));
    ticker.tick().await; // the first tick resolves immediately
    loop {
        tokio::select! {
            biased;
            result = &mut copy => return result,
            _ = ticker.tick() => {
                if let Ok(meta) = target_sftp.stat(temp_target).await {
                    progress(zeroterm_ssh::ProgressTick {
                        bytes_done: meta.size,
                        total: size_hint,
                    });
                }
            }
        }
    }
}

/// Best-effort removal of a failed file copy's temp target on the
/// destination.
///
/// Only files: a directory copy writes straight to its final path (same as
/// the relay path, which also copies entries in as it goes), so there is no
/// temp tree to reap and a partial directory is left for the user to inspect
/// rather than silently deleted.
pub(crate) async fn cleanup_direct_temp_file(sftp: &zeroterm_ssh::Sftp, path: &str) {
    if let Err(err) = sftp.remove_file(path).await {
        warn!(path, error = %err, "could not clean up after a failed direct copy");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_wraps_plain_values() {
        assert_eq!(sh_quote("/var/log/app.log"), "'/var/log/app.log'");
        assert_eq!(sh_quote("user@host"), "'user@host'");
    }

    #[test]
    fn sh_quote_neutralises_shell_metacharacters() {
        for raw in [
            "/tmp/$(id)",
            "/tmp/`id`",
            "/tmp/a b",
            "/tmp/a;rm -rf /",
            "/tmp/a|tee x",
            "/tmp/a\nb",
            "/tmp/文件 名",
            "/tmp/a&b",
            "/tmp/a>out",
        ] {
            let quoted = sh_quote(raw);
            assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
            // Every metacharacter survives verbatim inside the quotes, which
            // is exactly what makes it inert.
            let inner = &quoted[1..quoted.len() - 1];
            assert!(!inner.contains('\''), "unescaped quote in {quoted}");
            assert_eq!(inner.replace("'\\''", "'"), raw);
        }
    }

    #[test]
    fn sh_quote_escapes_embedded_single_quotes() {
        assert_eq!(sh_quote("it's"), r#"'it'\''s'"#);
        assert_eq!(sh_quote("'"), r#"''\'''"#);
        // A path crafted to break out of the quoting must not produce a
        // balanced-but-hostile string.
        let hostile = "'; rm -rf /; echo '";
        let quoted = sh_quote(hostile);
        assert_eq!(quoted.matches("'\\''").count(), 2);
    }

    #[test]
    fn preamble_rejects_delimiter_collision() {
        let lines = vec![KH_DELIMITER.to_string()];
        assert!(build_preamble(&lines).is_err());
        assert!(build_preamble(&["example.com ssh-ed25519 AAAA".to_string()]).is_ok());
    }

    #[test]
    fn preamble_cleans_up_and_guards_the_temp_path() {
        let script = build_preamble(&["h ssh-ed25519 AAAA".to_string()]).unwrap();
        assert!(script.contains("trap 'rm -f \"$KH\"' EXIT"));
        assert!(script.contains("[[:space:]]"));
        assert!(script.contains(&format!("exit {EXIT_TMPDIR_UNSAFE}")));
    }

    #[test]
    fn ssh_options_never_relax_host_key_checking() {
        let opts = ssh_options();
        assert!(opts.contains("StrictHostKeyChecking=yes"));
        assert!(!opts.contains("StrictHostKeyChecking=no"));
        assert!(!opts.contains("accept-new"));
        assert!(opts.contains("BatchMode=yes"));
    }

    #[test]
    fn rsync_progress_reads_the_running_total() {
        assert_eq!(
            parse_rsync_progress("  1,234,567  45%   10.50MB/s    0:00:12"),
            Some(1_234_567)
        );
        assert_eq!(parse_rsync_progress("32,768   0%    0.00kB/s    0:00:00"), Some(32_768));
        // Later redraws in one chunk win.
        assert_eq!(
            parse_rsync_progress("100  1%  1kB/s 0:00:01\r200  2%  1kB/s 0:00:02"),
            Some(200)
        );
    }

    #[test]
    fn rsync_progress_ignores_non_progress_output() {
        assert_eq!(parse_rsync_progress("sending incremental file list"), None);
        assert_eq!(parse_rsync_progress("some/file.txt"), None);
        assert_eq!(parse_rsync_progress(""), None);
        assert_eq!(parse_rsync_progress("total size is 1,024  speedup is 1.00"), None);
    }

    #[test]
    fn tail_buffer_stays_bounded_and_utf8_safe() {
        let mut buf = String::new();
        for _ in 0..500 {
            push_tail(&mut buf, "文字化けしないこと ");
        }
        assert!(buf.len() <= 1024 + 64);
        // Still valid UTF-8 (String guarantees it, but the slice index is the
        // part that could have panicked).
        assert!(!buf.is_empty());
    }

    #[test]
    fn route_labels_are_stable_for_the_ui() {
        assert_eq!(TransferRoute::Direct.as_str(), "direct");
        assert_eq!(TransferRoute::Relay.as_str(), "relay");
    }

    fn plan(tool: CopyTool) -> DirectPlan {
        DirectPlan {
            tool,
            target_login: "deploy@files.example.com".into(),
            target_port: 2222,
            known_hosts_lines: vec!["files.example.com ssh-ed25519 AAAA".into()],
            identities: LentIdentities::default(),
        }
    }

    /// Regression: the `-e` argument was single-quoted, which stopped `$KH`
    /// expanding. `ssh` then read a non-existent known_hosts file and every
    /// direct copy failed host key verification.
    #[test]
    fn rsync_rsh_argument_lets_the_known_hosts_variable_expand() {
        let cmd = build_copy_command(&plan(CopyTool::Rsync), "/srv/a.bin", "/srv/b.bin", false);
        assert!(
            cmd.contains("-e \"ssh "),
            "rsync -e must be double-quoted so $KH expands: {cmd}"
        );
        assert!(!cmd.contains("-e 'ssh "), "single quotes would inline $KH literally");
        assert!(cmd.contains("UserKnownHostsFile=$KH"));
    }

    #[test]
    fn copy_commands_quote_every_user_controlled_value() {
        for tool in [CopyTool::Rsync, CopyTool::Scp] {
            let cmd = build_copy_command(&plan(tool), "/srv/a b'; id #", "/dst/x y", false);
            // The hostile source path appears only inside single quotes.
            assert!(cmd.contains(r#"'/srv/a b'\''; id #'"#), "{cmd}");
            assert!(cmd.contains(r#"'deploy@files.example.com:/dst/x y'"#), "{cmd}");
            assert!(cmd.contains("-- "), "a -- guard keeps paths out of flag parsing");
        }
    }

    #[test]
    fn copy_commands_carry_the_destination_port() {
        let rsync = build_copy_command(&plan(CopyTool::Rsync), "/a", "/b", false);
        assert!(rsync.contains("-p 2222"), "{rsync}");
        let scp = build_copy_command(&plan(CopyTool::Scp), "/a", "/b", false);
        assert!(scp.contains("-P 2222"), "{scp}");
    }

    #[test]
    fn directory_copies_use_the_right_recursion_idiom() {
        let rsync = build_copy_command(&plan(CopyTool::Rsync), "/srv/dir", "/dst/dir", true);
        // Trailing slash makes dest *be* the copy rather than its parent.
        assert!(rsync.contains("'/srv/dir/'"), "{rsync}");
        let scp = build_copy_command(&plan(CopyTool::Scp), "/srv/dir", "/dst/dir", true);
        assert!(scp.contains("scp -r "), "{scp}");
        // A file must not pick up either.
        let file = build_copy_command(&plan(CopyTool::Rsync), "/srv/dir", "/dst/dir", false);
        assert!(file.contains("'/srv/dir'") && !file.contains("'/srv/dir/'"), "{file}");
    }

    #[test]
    fn small_files_stay_on_the_relay() {
        // The threshold is what keeps a many-small-files tree from paying an
        // SSH handshake per file.
        assert!(!worth_copying_directly(Some(0)));
        assert!(!worth_copying_directly(Some(64 * 1024)));
        assert!(!worth_copying_directly(Some(MIN_DIRECT_COPY_BYTES - 1)));
        assert!(worth_copying_directly(Some(MIN_DIRECT_COPY_BYTES)));
        assert!(worth_copying_directly(Some(8 * 1024 * 1024 * 1024)));
    }

    #[test]
    fn an_unsizeable_source_relays_rather_than_guessing() {
        assert!(!worth_copying_directly(None));
    }
}
