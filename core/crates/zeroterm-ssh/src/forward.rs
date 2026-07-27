//! TCP port forwarding helpers built on top of an authenticated
//! [`crate::Session`].
//!
//! Three flavours are exposed:
//!
//! * [`forward_local`] — `ssh -L bind:port:host:hport` semantics. Opens
//!   a local TCP listener; each accepted connection is bridged to
//!   `host:hport` via a `direct-tcpip` channel on the SSH server.
//!
//! * [`forward_dynamic`] — `ssh -D port` semantics. Local SOCKS5
//!   listener (no auth, CONNECT only); each request becomes a
//!   `direct-tcpip` channel.
//!
//! * [`forward_remote`] — `ssh -R bind:port:host:hport` semantics. Asks the
//!   SSH server to listen remotely and open `forwarded-tcpip` channels back to
//!   the client; each channel is bridged to a local TCP target.
//!
//! Both helpers spawn a long-lived task that runs until the returned
//! [`ForwardHandle`] is dropped. The handle's `local_addr()` is the
//! address actually bound (useful when the caller passed port 0 to let
//! the OS choose).
//!
use std::net::SocketAddr;
use std::sync::Arc;

use russh::client::Msg;
use russh::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;
use tracing::{debug, warn};

use crate::error::SshError;
use crate::session::{RemoteForwardSubscription, Session, SharedHandle};

/// Live forward. Drop to stop the listener and any in-flight bridges.
pub struct ForwardHandle {
    local: SocketAddr,
    cancel: CancellationToken,
}

impl ForwardHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Explicit shutdown. Equivalent to `drop`, but lets callers tag
    /// the cancellation in logs.
    pub fn stop(self) {
        self.cancel.cancel();
    }
}

impl Drop for ForwardHandle {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

/// `ssh -L bind:port:host:hport` — local listener forwarded through SSH.
pub async fn forward_local(
    session: &Session,
    bind_addr: &str,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<ForwardHandle, SshError> {
    let listener = TcpListener::bind((bind_addr, bind_port))
        .await
        .map_err(SshError::Io)?;
    let local = listener.local_addr().map_err(SshError::Io)?;
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let handle = session.handle_clone();

    debug!(
        %local,
        target = %format!("{target_host}:{target_port}"),
        "local forward listening"
    );
    tokio::spawn(local_loop(
        listener,
        handle,
        target_host,
        target_port,
        cancel_for_task,
    ));

    Ok(ForwardHandle { local, cancel })
}

async fn local_loop(
    listener: TcpListener,
    handle: SharedHandle,
    target_host: String,
    target_port: u16,
    cancel: CancellationToken,
) {
    let target_host = Arc::new(target_host);
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            res = listener.accept() => match res {
                Ok((tcp, peer)) => {
                    let handle = Arc::clone(&handle);
                    let target_host = Arc::clone(&target_host);
                    let cancel = cancel.clone();
                    tokio::spawn(async move {
                        if let Err(e) = bridge_to_target(
                            handle,
                            target_host.as_str().to_string(),
                            target_port,
                            tcp,
                            peer,
                            cancel,
                        )
                        .await
                        {
                            warn!(error = %e, "local forward bridge ended with error");
                        }
                    });
                }
                Err(e) => {
                    warn!(error = %e, "local forward accept failed; exiting loop");
                    break;
                }
            }
        }
    }
}

async fn bridge_to_target(
    handle: SharedHandle,
    target_host: String,
    target_port: u16,
    mut tcp: TcpStream,
    peer: SocketAddr,
    cancel: CancellationToken,
) -> Result<(), SshError> {
    let channel = {
        let handle = handle.lock().await;
        handle
            .channel_open_direct_tcpip(
                target_host,
                target_port as u32,
                peer.ip().to_string(),
                peer.port() as u32,
            )
            .await?
    };
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = cancel.cancelled() => {}
        res = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {
            if let Err(e) = res {
                debug!(error = %e, "bidirectional copy ended");
            }
        }
    }
    Ok(())
}

// --------------------------------------------------------------------------
// SOCKS5 dynamic forwarding
// --------------------------------------------------------------------------

/// `ssh -D port` — local SOCKS5 proxy. CONNECT-only, no-auth-only.
pub async fn forward_dynamic(
    session: &Session,
    bind_addr: &str,
    bind_port: u16,
) -> Result<ForwardHandle, SshError> {
    let listener = TcpListener::bind((bind_addr, bind_port))
        .await
        .map_err(SshError::Io)?;
    let local = listener.local_addr().map_err(SshError::Io)?;
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    let handle = session.handle_clone();

    debug!(%local, "dynamic SOCKS5 forward listening");
    tokio::spawn(socks_loop(listener, handle, cancel_for_task));

    Ok(ForwardHandle { local, cancel })
}

/// `ssh -R bind:port:host:hport` — remote listener forwarded back to a local target.
pub async fn forward_remote(
    session: &Session,
    bind_addr: &str,
    bind_port: u16,
    target_host: String,
    target_port: u16,
) -> Result<ForwardHandle, SshError> {
    let subscription = session
        .request_remote_forward(bind_addr, bind_port as u32)
        .await?;
    let remote_port = subscription.port();
    let local: SocketAddr = "0.0.0.0:0"
        .parse()
        .map_err(|e| SshError::Io(io_err(format!("remote addr parse failed: {e}"))))?;
    let cancel = CancellationToken::new();
    let cancel_for_task = cancel.clone();
    debug!(remote = %format!("{bind_addr}:{remote_port}"), target = %format!("{target_host}:{target_port}"), "remote forward requested");
    tokio::spawn(remote_loop(
        subscription,
        target_host,
        target_port,
        cancel_for_task,
    ));

    Ok(ForwardHandle { local, cancel })
}

async fn remote_loop(
    mut subscription: RemoteForwardSubscription,
    target_host: String,
    target_port: u16,
    cancel: CancellationToken,
) {
    let mut cancelled = false;
    loop {
        let next = tokio::select! {
            _ = cancel.cancelled() => {
                cancelled = true;
                break;
            },
            item = subscription.recv() => item,
        };
        match next {
            Some(item) => {
                let target_host = target_host.clone();
                let cancel = cancel.clone();
                tokio::spawn(async move {
                    if let Err(e) = bridge_remote_channel(
                        item.channel,
                        target_host,
                        target_port,
                        item.originator_address,
                        item.originator_port,
                        cancel,
                    )
                    .await
                    {
                        warn!(error = %e, "remote forward bridge ended with error");
                    }
                });
            }
            None => break,
        }
    }
    subscription.close(cancelled).await;
}

async fn bridge_remote_channel(
    channel: Channel<Msg>,
    target_host: String,
    target_port: u16,
    originator_address: String,
    originator_port: u32,
    cancel: CancellationToken,
) -> Result<(), SshError> {
    let mut tcp = TcpStream::connect((target_host.as_str(), target_port)).await?;
    let mut stream = channel.into_stream();
    debug!(originator = %format!("{originator_address}:{originator_port}"), target = %format!("{target_host}:{target_port}"), "remote forward connection accepted");
    tokio::select! {
        _ = cancel.cancelled() => {}
        res = tokio::io::copy_bidirectional(&mut stream, &mut tcp) => {
            if let Err(e) = res {
                debug!(error = %e, "remote bidirectional copy ended");
            }
        }
    }
    Ok(())
}

async fn socks_loop(listener: TcpListener, handle: SharedHandle, cancel: CancellationToken) {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            res = listener.accept() => match res {
                Ok((tcp, peer)) => {
                    let handle = Arc::clone(&handle);
                    let cancel = cancel.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_socks(tcp, peer, handle, cancel).await {
                            debug!(error = %e, "socks connection ended");
                        }
                    });
                }
                Err(e) => {
                    warn!(error = %e, "socks accept failed");
                    break;
                }
            }
        }
    }
}

async fn handle_socks(
    mut tcp: TcpStream,
    peer: SocketAddr,
    handle: SharedHandle,
    cancel: CancellationToken,
) -> Result<(), SshError> {
    // -- auth negotiation -------------------------------------------------
    let mut hdr = [0u8; 2];
    tcp.read_exact(&mut hdr).await?;
    if hdr[0] != 5 {
        return Err(SshError::Io(io_err("not socks5")));
    }
    let nmethods = hdr[1] as usize;
    let mut methods = vec![0u8; nmethods];
    tcp.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        let _ = tcp.write_all(&[5, 0xff]).await;
        return Err(SshError::Io(io_err("no acceptable auth method")));
    }
    tcp.write_all(&[5, 0]).await?;

    // -- request ----------------------------------------------------------
    let mut req = [0u8; 4];
    tcp.read_exact(&mut req).await?;
    if req[0] != 5 {
        return Err(SshError::Io(io_err("bad ver in request")));
    }
    if req[1] != 1 {
        // Only CONNECT supported.
        let _ = tcp.write_all(&[5, 0x07, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        return Err(SshError::Io(io_err("only CONNECT supported")));
    }
    let target_host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            tcp.read_exact(&mut name).await?;
            String::from_utf8(name).map_err(|_| SshError::Io(io_err("bad domain")))?
        }
        4 => {
            let mut a = [0u8; 16];
            tcp.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        other => {
            return Err(SshError::Io(io_err(format!("bad atyp {other}"))));
        }
    };
    let mut port_buf = [0u8; 2];
    tcp.read_exact(&mut port_buf).await?;
    let target_port = u16::from_be_bytes(port_buf);

    // -- open SSH channel -------------------------------------------------
    let channel_result = {
        let handle = handle.lock().await;
        handle
            .channel_open_direct_tcpip(
                target_host.clone(),
                target_port as u32,
                peer.ip().to_string(),
                peer.port() as u32,
            )
            .await
    };
    let channel = match channel_result {
        Ok(c) => c,
        Err(e) => {
            // Generic failure (rep=0x01) — server unreachable.
            let _ = tcp.write_all(&[5, 0x01, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            return Err(e.into());
        }
    };

    // success reply, with all-zero bnd_addr/bnd_port (clients ignore for CONNECT)
    tcp.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;

    let mut stream = channel.into_stream();
    // SSH-11: bind the relay to the forward's cancel token like
    // `bridge_to_target` does, so tearing down the dynamic forward
    // actually drops in-flight SOCKS connections instead of leaving them
    // copying until the peer closes.
    tokio::select! {
        _ = cancel.cancelled() => {}
        res = tokio::io::copy_bidirectional(&mut tcp, &mut stream) => {
            if let Err(e) = res {
                debug!(error = %e, "socks relay ended with error");
            }
        }
    }
    Ok(())
}

fn io_err<E: Into<String>>(msg: E) -> std::io::Error {
    std::io::Error::other(msg.into())
}

// Keep types we need in this module accessible.
#[allow(dead_code)]
type _ChanType = Channel<Msg>;
