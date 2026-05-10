//! SSH agent authentication.
//!
//! Cross-platform agent access:
//!   - Unix: `$SSH_AUTH_SOCK` (Unix domain socket) — handled by russh-keys'
//!     built-in `connect_env`.
//!   - Windows: `\\.\pipe\openssh-ssh-agent` — the named pipe exposed by
//!     the "OpenSSH Authentication Agent" Windows service. Make sure
//!     that service is set to Automatic / running and that you've
//!     `ssh-add`'ed your keys.
//!
//! PuTTY's Pageant is intentionally NOT supported — different wire
//! format. May land as a separate adapter later.
//!
//! russh 0.45's agent API uses an "owning" pattern: each call consumes
//! the `AgentClient` and returns a fresh one alongside the result. The
//! loop here threads the agent through each per-key auth attempt.

use russh::client::Handle;
use russh_keys::agent::client::AgentClient;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::SshError;

/// Try to authenticate with every identity the local SSH agent offers.
/// Returns `Ok(true)` on the first success, `Ok(false)` if the agent
/// is reachable but no identity worked, and an `Err` only when the
/// agent itself can't be opened.
pub(crate) async fn try_agent_auth<H>(
    handle: &mut Handle<H>,
    username: &str,
) -> Result<bool, SshError>
where
    H: russh::client::Handler + 'static,
{
    #[cfg(unix)]
    {
        let agent = AgentClient::connect_env().await.map_err(|e| {
            SshError::AgentUnavailable(format!(
                "couldn't reach SSH agent via $SSH_AUTH_SOCK: {e}. Is ssh-agent running?"
            ))
        })?;
        run_loop(handle, username, agent).await
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        const PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
        let pipe = ClientOptions::new().open(PIPE).map_err(|e| {
            SshError::AgentUnavailable(format!(
                "couldn't open OpenSSH agent pipe `{PIPE}`: {e}. \
                 Run `Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent` \
                 from an elevated PowerShell, then `ssh-add` your key."
            ))
        })?;
        let agent = AgentClient::connect(pipe);
        run_loop(handle, username, agent).await
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (handle, username);
        Err(SshError::AgentUnavailable(
            "agent auth not implemented on this platform".into(),
        ))
    }
}

async fn run_loop<H, R>(
    handle: &mut Handle<H>,
    username: &str,
    mut agent: AgentClient<R>,
) -> Result<bool, SshError>
where
    H: russh::client::Handler + 'static,
    R: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(format!("request_identities: {e}")))?;

    if identities.is_empty() {
        tracing::warn!("ssh-agent has no identities — `ssh-add` your key first");
        return Ok(false);
    }
    tracing::debug!(count = identities.len(), "agent identities available");

    for key in identities {
        let (returned_signer, auth_result) = handle
            .authenticate_future(username.to_string(), key.clone(), agent)
            .await;
        agent = returned_signer;

        match auth_result {
            Ok(true) => return Ok(true),
            Ok(false) => {
                tracing::debug!("agent identity rejected by server");
                continue;
            }
            Err(e) => {
                tracing::warn!(error = %e, "agent auth attempt errored");
                continue;
            }
        }
    }
    Ok(false)
}
