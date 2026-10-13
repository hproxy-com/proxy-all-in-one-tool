//! Switching places while the relay runs, over real sockets.
//!
//! Two fake upstream proxies (A and B) and an echo server. A client opens a
//! tunnel through the relay, the source is switched, and the test checks the
//! three things a person notices: the relay's port never changed, the tunnel
//! that was open ended (so a browser reconnects instead of staying on the old
//! address), and the next connection goes through the new upstream.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use hproxy_relay::{serve, upstream, Source, Stats, SwitchableSource};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const PATIENCE: Duration = Duration::from_secs(3);

/// A server that sends back every byte it receives.
async fn echo_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    addr
}

/// A plain HTTP proxy that answers CONNECT and counts the tunnels it opened.
async fn fake_upstream() -> (SocketAddr, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let tunnels = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&tunnels);
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let count = Arc::clone(&count);
            tokio::spawn(async move {
                let head = read_head(&mut client).await;
                let target = head.split_whitespace().nth(1).unwrap_or_default().to_string();
                let Ok(mut server) = TcpStream::connect(&target).await else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                    return;
                };
                count.fetch_add(1, Ordering::SeqCst);
                let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
            });
        }
    });
    (addr, tunnels)
}

async fn read_head(s: &mut TcpStream) -> String {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match s.read(&mut byte).await {
            Ok(1) => head.push(byte[0]),
            _ => break,
        }
    }
    String::from_utf8_lossy(&head).into_owned()
}

fn fixed(addr: SocketAddr) -> Source {
    Source::Fixed(upstream::parse(&addr.to_string()).unwrap())
}

/// Open a tunnel through the relay to the echo server and prove it carries bytes.
async fn open_tunnel(relay: SocketAddr, origin: SocketAddr) -> TcpStream {
    let mut c = TcpStream::connect(relay).await.unwrap();
    c.write_all(format!("CONNECT {origin} HTTP/1.1\r\nHost: {origin}\r\n\r\n").as_bytes())
        .await
        .unwrap();
    let head = tokio::time::timeout(PATIENCE, read_head(&mut c)).await.unwrap();
    assert!(head.starts_with("HTTP/1.1 200"), "the relay refused the tunnel: {head}");
    c.write_all(b"ping").await.unwrap();
    let mut back = [0u8; 4];
    tokio::time::timeout(PATIENCE, c.read_exact(&mut back))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&back, b"ping");
    c
}

/// True when the relay closed this tunnel (end of stream or a reset).
async fn closed_by_relay(c: &mut TcpStream) -> bool {
    let mut buf = [0u8; 16];
    matches!(
        tokio::time::timeout(PATIENCE, c.read(&mut buf)).await,
        Ok(Ok(0)) | Ok(Err(_))
    )
}

#[tokio::test]
async fn a_switch_keeps_the_port_ends_open_tunnels_and_uses_the_new_upstream() {
    let origin = echo_server().await;
    let (a, through_a) = fake_upstream().await;
    let (b, through_b) = fake_upstream().await;

    let switchable = Arc::new(SwitchableSource::new(fixed(a)));
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<SocketAddr>();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let relay_task = tokio::spawn(serve(
        "127.0.0.1:0".parse().unwrap(),
        false,
        false,
        Arc::clone(&switchable),
        Arc::new(Stats::default()),
        |bound| {
            let _ = ready_tx.send(bound);
        },
        async {
            let _ = stop_rx.await;
        },
    ));
    let relay = ready_rx.await.unwrap();

    // Through A.
    let mut open = open_tunnel(relay, origin).await;
    assert_eq!(through_a.load(Ordering::SeqCst), 1);

    // Switch to B in place: the open tunnel ends, the relay's address stays.
    switchable.replace(fixed(b));
    assert!(
        closed_by_relay(&mut open).await,
        "the tunnel opened before the switch must end"
    );

    let mut after = open_tunnel(relay, origin).await;
    assert_eq!(through_b.load(Ordering::SeqCst), 1, "the new connection went through B");
    assert_eq!(through_a.load(Ordering::SeqCst), 1, "nothing new went through A");

    // "Next IP" on the same source ends what is open and carries on through B.
    switchable.end_open_connections();
    assert!(closed_by_relay(&mut after).await);
    let mut last = open_tunnel(relay, origin).await;
    assert_eq!(through_b.load(Ordering::SeqCst), 2);

    // Stopping ends the open tunnels too: nothing keeps going through the proxy.
    let _ = stop_tx.send(());
    assert!(
        closed_by_relay(&mut last).await,
        "a stopped relay must not leave tunnels running"
    );
    assert!(relay_task.await.unwrap().is_ok());
}
