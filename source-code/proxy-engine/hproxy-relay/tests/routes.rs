//! How connections travel, over real sockets: a site that skips the proxy, only
//! the sites named, two proxies in a row, and the relay other devices use.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use hproxy_relay::{upstream, Login, Mode, Routes, Routing, Source, Stats, SwitchableSource};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// A site that says who it is.
async fn site(says: &'static str) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut got = [0u8; 2048];
                let _ = s.read(&mut got).await;
                let body = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{says}",
                    says.len()
                );
                let _ = s.write_all(body.as_bytes()).await;
            });
        }
    });
    port
}

/// A plain HTTP proxy that counts its tunnels and keeps where they went.
struct FakeProxy {
    port: u16,
    tunnels: Arc<AtomicUsize>,
    targets: Arc<Mutex<Vec<String>>>,
}

async fn fake_proxy() -> FakeProxy {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let tunnels = Arc::new(AtomicUsize::new(0));
    let targets = Arc::new(Mutex::new(Vec::new()));
    let (count, seen) = (Arc::clone(&tunnels), Arc::clone(&targets));
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let (count, seen) = (Arc::clone(&count), Arc::clone(&seen));
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read_exact(&mut byte).await.is_err() {
                        return;
                    }
                    head.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&head).to_string();
                let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                count.fetch_add(1, Ordering::SeqCst);
                seen.lock().unwrap().push(target.clone());
                let Ok(mut server) = TcpStream::connect(target.as_str()).await else {
                    return;
                };
                let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
            });
        }
    });
    FakeProxy { port, tunnels, targets }
}

fn upstream_at(port: u16) -> upstream::Upstream {
    upstream::parse(&format!("127.0.0.1:{port}")).unwrap()
}

/// A relay on this computer with `routing`, through `port`'s proxy.
async fn relay(port: u16, routing: Routing) -> (u16, oneshot::Sender<()>) {
    let source = Arc::new(SwitchableSource::new(Source::Fixed(upstream_at(port))));
    source.set_routing(routing);
    let (ready_tx, ready) = oneshot::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        hproxy_relay::serve(
            "127.0.0.1:0".parse().unwrap(),
            false,
            false,
            source,
            Arc::new(Stats::default()),
            |bound: SocketAddr| {
                let _ = ready_tx.take().unwrap().send(bound.port());
            },
            async {
                let _ = stopped.await;
            },
        )
        .await
        .unwrap();
    });
    (ready.await.unwrap(), stop)
}

/// The relay other devices use, through `port`'s proxy.
async fn network_relay(port: u16, login: Login) -> (u16, oneshot::Sender<()>) {
    let source = Arc::new(SwitchableSource::new(Source::Fixed(upstream_at(port))));
    let (ready_tx, ready) = oneshot::channel();
    let (stop, stopped) = oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        hproxy_relay::serve_network(
            "127.0.0.1:0".parse().unwrap(),
            login,
            source,
            Arc::new(Stats::default()),
            |bound: SocketAddr| {
                let _ = ready_tx.take().unwrap().send(bound.port());
            },
            async {
                let _ = stopped.await;
            },
        )
        .await
        .unwrap();
    });
    (ready.await.unwrap(), stop)
}

/// A CONNECT through the relay, then one request, with an optional login.
async fn through(relay: u16, target: u16, login: Option<&str>) -> Result<String, String> {
    let mut s = TcpStream::connect(("127.0.0.1", relay)).await.unwrap();
    let header = login.map_or(String::new(), |l| format!("Proxy-Authorization: {l}\r\n"));
    s.write_all(format!("CONNECT 127.0.0.1:{target} HTTP/1.1\r\nHost: x\r\n{header}\r\n").as_bytes())
        .await
        .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if s.read_exact(&mut byte).await.is_err() {
            return Err("closed".into());
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).to_string();
    let status = head.split_whitespace().nth(1).unwrap_or("").to_string();
    if status != "200" {
        return Err(status);
    }
    s.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").await.unwrap();
    let mut all = String::new();
    s.read_to_string(&mut all).await.unwrap();
    Ok(all.rsplit("\r\n\r\n").next().unwrap_or("").to_string())
}

fn rules(mode: Mode, sites: &str) -> Routing {
    Routing {
        sites: Routes::new(mode, sites).unwrap(),
        first_hop: None,
    }
}

#[tokio::test]
async fn a_site_named_goes_straight_out_and_the_proxy_never_hears_of_it() {
    let (site_port, proxy) = (site("hello").await, fake_proxy().await);
    let (port, _stop) = relay(proxy.port, rules(Mode::Except, "127.0.0.1")).await;
    assert_eq!(through(port, site_port, None).await.unwrap(), "hello");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn only_the_sites_named_use_the_proxy() {
    let (site_port, proxy) = (site("hello").await, fake_proxy().await);
    let (named, _a) = relay(proxy.port, rules(Mode::Only, "127.0.0.1")).await;
    assert_eq!(through(named, site_port, None).await.unwrap(), "hello");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1);

    let (other, _b) = relay(proxy.port, rules(Mode::Only, "example.com")).await;
    assert_eq!(through(other, site_port, None).await.unwrap(), "hello");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1, "this one went past it");
}

#[tokio::test]
async fn the_connections_own_test_goes_through_the_proxy_whatever_the_rules_say() {
    let (site_port, proxy) = (site("hello").await, fake_proxy().await);
    let mut routing = rules(Mode::Except, "127.0.0.1");
    routing.sites = routing.sites.tested_at("127.0.0.1");
    let (port, _stop) = relay(proxy.port, routing).await;
    assert_eq!(through(port, site_port, None).await.unwrap(), "hello");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn two_proxies_in_a_row_the_second_only_sees_the_first() {
    let site_port = site("hello").await;
    let (first, second) = (fake_proxy().await, fake_proxy().await);
    let routing = Routing {
        sites: Routes::default(),
        first_hop: Some(upstream_at(first.port)),
    };
    let (port, _stop) = relay(second.port, routing).await;
    assert_eq!(through(port, site_port, None).await.unwrap(), "hello");
    assert_eq!(
        *first.targets.lock().unwrap(),
        vec![format!("127.0.0.1:{}", second.port)],
        "the first proxy is asked for the second"
    );
    assert_eq!(
        *second.targets.lock().unwrap(),
        vec![format!("127.0.0.1:{site_port}")],
        "the second one is asked for the site"
    );
}

fn login() -> Login {
    Login {
        username: "hproxy".into(),
        password: "right".into(),
    }
}

#[tokio::test]
async fn the_network_relay_wants_its_login() {
    let (site_port, proxy) = (site("hello").await, fake_proxy().await);
    let (port, _stop) = network_relay(proxy.port, login()).await;
    assert_eq!(through(port, site_port, None).await.unwrap_err(), "407");
    let wrong = upstream::basic("hproxy", "wrong");
    assert_eq!(through(port, site_port, Some(&wrong)).await.unwrap_err(), "407");
    assert_eq!(proxy.tunnels.load(Ordering::SeqCst), 0, "nothing got through");
    let right = upstream::basic("hproxy", "right");
    assert_eq!(through(port, site_port, Some(&right)).await.unwrap(), "hello");
}

/// A SOCKS5 handshake with the relay: what it answers to a login.
async fn socks5_login(relay: u16, user: &str, pass: &str) -> [u8; 2] {
    let mut s = TcpStream::connect(("127.0.0.1", relay)).await.unwrap();
    s.write_all(&[0x05, 0x01, 0x02]).await.unwrap();
    let mut method = [0u8; 2];
    s.read_exact(&mut method).await.unwrap();
    assert_eq!(method, [0x05, 0x02], "the login is the way in");
    let mut hello = vec![0x01, user.len() as u8];
    hello.extend_from_slice(user.as_bytes());
    hello.push(pass.len() as u8);
    hello.extend_from_slice(pass.as_bytes());
    s.write_all(&hello).await.unwrap();
    let mut answer = [0u8; 2];
    s.read_exact(&mut answer).await.unwrap();
    answer
}

#[tokio::test]
async fn the_network_relay_wants_its_login_over_socks5_too() {
    let proxy = fake_proxy().await;
    let (port, _stop) = network_relay(proxy.port, login()).await;
    assert_eq!(socks5_login(port, "hproxy", "wrong").await, [0x01, 0x01]);
    assert_eq!(socks5_login(port, "hproxy", "right").await, [0x01, 0x00]);

    // No login offered: no way in.
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    s.write_all(&[0x05, 0x01, 0x00]).await.unwrap();
    let mut method = [0u8; 2];
    s.read_exact(&mut method).await.unwrap();
    assert_eq!(method, [0x05, 0xff]);
}
