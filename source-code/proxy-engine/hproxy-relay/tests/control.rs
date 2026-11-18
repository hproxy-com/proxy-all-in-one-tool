//! The relay's own pages over real sockets, the way a script uses them.
//!
//! A list of two fake upstream proxies (A and B) and an echo server. A tunnel
//! open through A must end when a script asks for a new IP, the next one must
//! go through B, the status page must agree, and no page request may count as
//! traffic. Also: the page reached through the relay as a proxy (HTTP_PROXY
//! pointing at it), a request with a body, a web page turned away, and the
//! relay for other devices asking for its login.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use hproxy_relay::{serve, serve_network, upstream, List, Login, Rotation, Source, Stats, SwitchableSource};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const PATIENCE: Duration = Duration::from_secs(5);

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

/// A plain HTTP proxy that answers CONNECT and counts every request it gets.
async fn fake_upstream() -> (SocketAddr, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&requests);
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let count = Arc::clone(&count);
            tokio::spawn(async move {
                let head = read_head(&mut client).await;
                count.fetch_add(1, Ordering::SeqCst);
                let target = head.split_whitespace().nth(1).unwrap_or_default().to_string();
                let Ok(mut server) = TcpStream::connect(&target).await else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n").await;
                    return;
                };
                let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
            });
        }
    });
    (addr, requests)
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

fn at(addr: SocketAddr) -> upstream::Upstream {
    upstream::parse(&addr.to_string()).unwrap()
}

/// A relay on this computer, through `source`, counting into `stats`.
async fn start(source: Source, stats: Arc<Stats>) -> (SocketAddr, oneshot::Sender<()>) {
    let (ready_tx, ready) = oneshot::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(serve(
        "127.0.0.1:0".parse().unwrap(),
        false,
        false,
        Arc::new(SwitchableSource::new(source)),
        stats,
        |bound| {
            let _ = ready_tx.send(bound);
        },
        async {
            let _ = stopped.await;
        },
    ));
    (ready.await.unwrap(), stop)
}

/// The relay other devices use, with `login`.
async fn start_network(source: Source, login: Login) -> (SocketAddr, oneshot::Sender<()>) {
    let (ready_tx, ready) = oneshot::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(serve_network(
        "127.0.0.1:0".parse().unwrap(),
        login,
        Arc::new(SwitchableSource::new(source)),
        Arc::new(Stats::default()),
        |bound| {
            let _ = ready_tx.send(bound);
        },
        async {
            let _ = stopped.await;
        },
    ));
    (ready.await.unwrap(), stop)
}

/// One request as it would go on the wire, and the whole answer: its status
/// code, its head and its body. The relay closes after a page's answer.
async fn send(relay: SocketAddr, request: &str) -> (u16, String, String) {
    let mut s = TcpStream::connect(relay).await.unwrap();
    s.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(PATIENCE, s.read_to_end(&mut out))
        .await
        .expect("the relay answers and closes")
        .unwrap();
    let text = String::from_utf8(out).unwrap();
    let (head, body) = text.split_once("\r\n\r\n").expect("an HTTP answer");
    let code = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (code, head.to_string(), body.to_string())
}

fn json(body: &str) -> Value {
    serde_json::from_str(body.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {body}"))
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
async fn a_script_switches_the_list_and_open_tunnels_follow() {
    let origin = echo_server().await;
    let (a, through_a) = fake_upstream().await;
    let (b, through_b) = fake_upstream().await;
    let list = List::new(vec![at(a), at(b)], Rotation::OnFailure).unwrap();
    let stats = Arc::new(Stats::default());
    let (relay, _stop) = start(Source::List(list), Arc::clone(&stats)).await;

    let (code, head, body) = send(relay, "GET /hproxy/status HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(code, 200, "{head}");
    assert!(head.contains("Content-Type: application/json"), "{head}");
    let s = json(&body);
    assert_eq!((s["ok"].as_bool(), s["source"].as_str()), (Some(true), Some("list")));
    assert_eq!((s["member"].as_u64(), s["members"].as_u64()), (Some(1), Some(2)));
    assert!(s["upstream"].as_str().unwrap().contains(&a.port().to_string()), "{s}");
    assert_eq!(s["stats"]["connections"], 0, "a page is no traffic: {s}");

    let mut open = open_tunnel(relay, origin).await;
    assert_eq!(through_a.load(Ordering::SeqCst), 1);

    // The switch, with a body the way many clients send a POST.
    let (code, _, body) = send(
        relay,
        "POST /hproxy/new-ip HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
    )
    .await;
    assert_eq!(code, 200, "{body}");
    let s = json(&body);
    assert_eq!(s["member"], 2, "{s}");
    assert!(s["upstream"].as_str().unwrap().contains(&b.port().to_string()), "{s}");

    assert!(
        closed_by_relay(&mut open).await,
        "the tunnel open before the switch must end"
    );
    let _after = open_tunnel(relay, origin).await;
    assert_eq!(
        through_b.load(Ordering::SeqCst),
        1,
        "the next connection went through B"
    );
    assert_eq!(through_a.load(Ordering::SeqCst), 1, "nothing new went through A");

    // The status agrees, and counts the two tunnels and none of the pages.
    let (_, _, body) = send(relay, "GET /hproxy/status HTTP/1.1\r\nHost: x\r\n\r\n").await;
    let s = json(&body);
    assert_eq!(s["member"], 2);
    assert_eq!(s["stats"]["connections"], 2, "{s}");
    assert_eq!(stats.snapshot().connections, 2);

    // Proxy 1 again, by its number.
    let (code, _, body) = send(relay, "POST /hproxy/new-ip?member=1 HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!((code, json(&body)["member"].as_u64()), (200, Some(1)));
}

#[tokio::test]
async fn sent_through_the_relay_to_itself_the_relay_answers() {
    // HTTP_PROXY points at the relay and the script calls the relay's page:
    // the request arrives in a proxy's absolute form and must stay here,
    // never reach the upstream.
    let (up, requests) = fake_upstream().await;
    let (relay, _stop) = start(Source::Fixed(at(up)), Arc::new(Stats::default())).await;
    let port = relay.port();

    let (code, _, body) = send(
        relay,
        &format!("GET http://127.0.0.1:{port}/hproxy/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n"),
    )
    .await;
    assert_eq!(code, 200, "{body}");
    assert_eq!(json(&body)["source"], "fixed");

    let (code, _, body) = send(
        relay,
        &format!("POST http://localhost:{port}/hproxy/new-ip HTTP/1.1\r\nHost: localhost:{port}\r\nContent-Length: 0\r\n\r\n"),
    )
    .await;
    assert_eq!(code, 409, "one proxy has nothing to switch to: {body}");
    assert_eq!(json(&body)["ok"], false);

    assert_eq!(requests.load(Ordering::SeqCst), 0, "no page request went upstream");
}

#[tokio::test]
async fn a_web_page_is_turned_away_and_a_wrong_address_says_where_the_pages_are() {
    let (a, _) = fake_upstream().await;
    let (b, _) = fake_upstream().await;
    let list = List::new(vec![at(a), at(b)], Rotation::OnFailure).unwrap();
    let (relay, _stop) = start(Source::List(list), Arc::new(Stats::default())).await;

    let (code, _, body) = send(
        relay,
        "POST /hproxy/new-ip HTTP/1.1\r\nHost: x\r\nOrigin: https://example.com\r\nSec-Fetch-Site: cross-site\r\nContent-Length: 0\r\n\r\n",
    )
    .await;
    assert_eq!(code, 403, "{body}");
    let (_, _, body) = send(relay, "GET /hproxy/status HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(json(&body)["member"], 1, "the page switched nothing");

    let (code, _, body) = send(relay, "GET /hproxy/next HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(code, 404);
    assert!(json(&body)["pages"]["/hproxy/new-ip"].is_string(), "{body}");

    // The port opened as a web page still says what it is, and now where the pages are.
    let (code, _, body) = send(relay, "GET / HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(code, 400);
    assert!(body.contains("/hproxy/status"), "{body}");
}

#[tokio::test]
async fn the_relay_for_other_devices_asks_its_login_on_the_pages_too() {
    let (up, _) = fake_upstream().await;
    let login = Login {
        username: "name".into(),
        password: "secret".into(),
    };
    let (relay, _stop) = start_network(Source::Fixed(at(up)), login).await;
    let basic = upstream::basic("name", "secret");

    let (code, head, _) = send(relay, "GET /hproxy/status HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(code, 401, "{head}");
    assert!(head.contains("WWW-Authenticate: Basic"), "{head}");

    for header in ["Authorization", "Proxy-Authorization"] {
        let (code, _, body) = send(
            relay,
            &format!("GET /hproxy/status HTTP/1.1\r\nHost: x\r\n{header}: {basic}\r\n\r\n"),
        )
        .await;
        assert_eq!(code, 200, "{header}: {body}");
    }

    // The proxy itself still answers a missing login the proxy's way.
    let (code, _, _) = send(relay, "CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: x\r\n\r\n").await;
    assert_eq!(code, 407);
}
