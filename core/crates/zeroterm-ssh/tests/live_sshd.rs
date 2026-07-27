//! Opt-in end-to-end smoke test against a real OpenSSH server.
//!
//! Example:
//! `ZEROTERM_TEST_SSH_PORT=2222 ZEROTERM_TEST_SSH_USER=user \
//!  ZEROTERM_TEST_SSH_KEY=/path/to/id_ed25519 \
//!  ZEROTERM_TEST_SSH_KNOWN_HOSTS=/path/to/known_hosts \
//!  cargo test -p zeroterm-ssh --test live_sshd -- --ignored --nocapture`

use std::path::PathBuf;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use zeroterm_ssh::{
    forward_dynamic, forward_local, forward_remote, AuthMethod, ConnectConfig, HostKeyPolicy,
    KnownHosts, Session,
};

fn live_config() -> ConnectConfig {
    ConnectConfig {
        host: std::env::var("ZEROTERM_TEST_SSH_HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: std::env::var("ZEROTERM_TEST_SSH_PORT")
            .expect("ZEROTERM_TEST_SSH_PORT is required")
            .parse()
            .expect("ZEROTERM_TEST_SSH_PORT must be a u16"),
        username: std::env::var("ZEROTERM_TEST_SSH_USER")
            .expect("ZEROTERM_TEST_SSH_USER is required"),
        auth_methods: vec![AuthMethod::PrivateKey {
            path: PathBuf::from(
                std::env::var("ZEROTERM_TEST_SSH_KEY")
                    .expect("ZEROTERM_TEST_SSH_KEY is required"),
            ),
            passphrase: None,
        }],
        connect_timeout: Some(Duration::from_secs(10)),
        host_key_policy: std::env::var("ZEROTERM_TEST_SSH_KNOWN_HOSTS")
            .map(|path| HostKeyPolicy::Strict(KnownHosts::new(PathBuf::from(path))))
            .unwrap_or(HostKeyPolicy::AcceptAll),
    }
}

async fn unused_local_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    listener.local_addr().unwrap().port()
}

async fn spawn_echo_server() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0_u8; 128];
                if let Ok(n) = stream.read(&mut buf).await {
                    let _ = stream.write_all(&buf[..n]).await;
                }
            });
        }
    });
    (port, task)
}

async fn spawn_fixed_server(response: &'static [u8]) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        if let Ok((mut stream, _)) = listener.accept().await {
            let mut request = [0_u8; 32];
            let _ = stream.read(&mut request).await;
            let _ = stream.write_all(response).await;
        }
    });
    (port, task)
}

async fn roundtrip(addr: std::net::SocketAddr, payload: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(payload).await.unwrap();
    let mut out = vec![0_u8; payload.len()];
    stream.read_exact(&mut out).await.unwrap();
    out
}

async fn fixed_response(addr: std::net::SocketAddr, payload: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(payload).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an explicitly configured OpenSSH test server"]
async fn real_sshd_exec_sftp_jump_and_forwards() {
    let cfg = live_config();
    let session = Session::connect(cfg.clone()).await.unwrap();

    let (status, stdout, stderr) = session.exec("printf zeroterm-russh-e2e").await.unwrap();
    assert_eq!(status, 0);
    assert_eq!(stdout, b"zeroterm-russh-e2e");
    assert!(stderr.is_empty());

    let sftp = session.sftp().await.unwrap();
    assert!(!sftp.list(".").await.unwrap().is_empty());

    let (echo_port, echo_task) = spawn_echo_server().await;

    let local = forward_local(
        &session,
        "127.0.0.1",
        0,
        "127.0.0.1".to_string(),
        echo_port,
    )
    .await
    .unwrap();
    assert_eq!(roundtrip(local.local_addr(), b"local").await, b"local");

    let dynamic = forward_dynamic(&session, "127.0.0.1", 0).await.unwrap();
    let mut socks = TcpStream::connect(dynamic.local_addr()).await.unwrap();
    socks.write_all(&[5, 1, 0]).await.unwrap();
    let mut method = [0_u8; 2];
    socks.read_exact(&mut method).await.unwrap();
    assert_eq!(method, [5, 0]);
    let [port_hi, port_lo] = echo_port.to_be_bytes();
    socks
        .write_all(&[5, 1, 0, 1, 127, 0, 0, 1, port_hi, port_lo])
        .await
        .unwrap();
    let mut reply = [0_u8; 10];
    socks.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply[..2], &[5, 0]);
    socks.write_all(b"dynamic").await.unwrap();
    let mut dynamic_out = [0_u8; 7];
    socks.read_exact(&mut dynamic_out).await.unwrap();
    assert_eq!(&dynamic_out, b"dynamic");

    let (target_a, target_a_task) = spawn_fixed_server(b"route-a").await;
    let (target_b, target_b_task) = spawn_fixed_server(b"route-b").await;
    let remote_port_a = unused_local_port().await;
    let remote_port_b = unused_local_port().await;
    assert_ne!(remote_port_a, remote_port_b);
    let remote_a = forward_remote(
        &session,
        "127.0.0.1",
        remote_port_a,
        "127.0.0.1".to_string(),
        target_a,
    )
    .await
    .unwrap();
    let remote_b = forward_remote(
        &session,
        "127.0.0.1",
        remote_port_b,
        "127.0.0.1".to_string(),
        target_b,
    )
    .await
    .unwrap();
    assert_eq!(
        fixed_response(([127, 0, 0, 1], remote_port_a).into(), b"a").await,
        b"route-a"
    );
    assert_eq!(
        fixed_response(([127, 0, 0, 1], remote_port_b).into(), b"b").await,
        b"route-b"
    );

    let jump = Session::connect(cfg.clone()).await.unwrap();
    let target = Session::connect_via(cfg, &jump).await.unwrap();
    let (status, stdout, _) = target.exec("printf proxy-jump-ok").await.unwrap();
    assert_eq!(status, 0);
    assert_eq!(stdout, b"proxy-jump-ok");

    remote_a.stop();
    remote_b.stop();
    dynamic.stop();
    local.stop();
    echo_task.abort();
    target_a_task.abort();
    target_b_task.abort();
    let _ = target.disconnect().await;
    let _ = jump.disconnect().await;
    let _ = session.disconnect().await;
}
