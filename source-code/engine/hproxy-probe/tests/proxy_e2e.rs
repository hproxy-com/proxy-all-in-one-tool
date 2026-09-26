//! End-to-end tests against real proxies, run in-process.
//!
//! The unit tests prove the parsers parse. They cannot prove that a probe can
//! hold a conversation with an actual proxy, which is the only thing this
//! engine does. So this file stands up a judge, an HTTP proxy, a SOCKS4 proxy
//! and a SOCKS5 proxy on loopback, and drives the real engine through them.
//! Everything is bound to 127.0.0.1 on ephemeral ports: no network, no third
//! party, nothing to rate-limit, and it runs in CI.
//!
//! The fake proxies can be told to inject headers, which is how the three
//! anonymity tiers get tested for real rather than by feeding a hand-written
//! struct to the grader.

use hproxy_probe::judge::Ladder;
use hproxy_probe::transport::{self, Budget, Context, Target};
use hproxy_probe::{CheckOptions, Checker, Failure, Judge, ProtocolSet, Status};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

// ── Test infrastructure ──────────────────────────────────────────────────────

async fn read_head(s: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match s.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn header_map(head: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            m.insert(
                k.trim().to_ascii_lowercase(),
                serde_json::Value::String(v.trim().to_string()),
            );
        }
    }
    m
}

/// The address the fake proxy makes its outbound connections from. It matters
/// that this is NOT 127.0.0.1: a real proxy reaches the judge from its own
/// address, and that difference is the whole basis of anonymity grading.
const PROXY_EXIT: &str = "127.0.0.2";

/// What the judge reports as the trusted peer. Our real judge sits behind an
/// edge that names the true connecting address; the engine only believes a
/// public one, so the fake judge maps its loopback peers onto documentation
/// space the way an edge would name real addresses.
const OWN_PUBLIC: &str = "203.0.113.1";
const EXIT_PUBLIC: &str = "203.0.113.2";

fn as_public(peer: std::net::IpAddr) -> String {
    if peer.to_string() == PROXY_EXIT {
        EXIT_PUBLIC.into()
    } else {
        OWN_PUBLIC.into()
    }
}

/// A judge: answers every request with `{ip, headers, peer_ip}`, exactly like
/// the real echo endpoint. Every request header is reflected, the nonce
/// included.
async fn spawn_judge() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, peer)) = l.accept().await {
            tokio::spawn(async move {
                let head = read_head(&mut s).await;
                let public = as_public(peer.ip());
                let body =
                    serde_json::json!({ "ip": public, "headers": header_map(&head), "peer_ip": public }).to_string();
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            });
        }
    });
    addr
}

/// A judge that answers something other than our echo. The captive portal,
/// the ISP interception page, the "your subscription expired" splash screen
/// that litter scraped lists. It must NOT count as a working proxy.
async fn spawn_impostor(status: &'static str, body: &'static str) -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let _ = read_head(&mut s).await;
                let resp = format!("HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nLocation: https://example.com/\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            });
        }
    });
    addr
}

/// A judge sitting behind a CDN, which is what our own TLS endpoint is. The
/// edge stamps `x-forwarded-for`, `x-real-ip` and `cf-connecting-ip` onto every
/// request, and puts the caller's own address in the forwarded header, which is
/// the value that turns a mis-grade into the worst possible one.
async fn spawn_cdn_judge() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, peer)) = l.accept().await {
            tokio::spawn(async move {
                let head = read_head(&mut s).await;
                let mut headers = header_map(&head);
                for k in ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] {
                    headers.insert(k.into(), serde_json::Value::String(OWN_PUBLIC.to_string()));
                }
                let public = as_public(peer.ip());
                let body = serde_json::json!({ "ip": OWN_PUBLIC, "headers": headers, "peer_ip": public }).to_string();
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
                let _ = s.flush().await;
            });
        }
    });
    addr
}

/// Connect the way the fake proxy does: from `PROXY_EXIT`.
async fn connect_as_proxy(authority: &str) -> std::io::Result<TcpStream> {
    let target: SocketAddr = tokio::net::lookup_host(authority)
        .await?
        .next()
        .ok_or_else(|| std::io::Error::other("no address"))?;
    if !target.ip().is_loopback() {
        return TcpStream::connect(target).await;
    }
    let sock = tokio::net::TcpSocket::new_v4()?;
    sock.bind(format!("{PROXY_EXIT}:0").parse().unwrap())?;
    sock.connect(target).await
}

/// An HTTP proxy. `inject` is added to every forwarded request, which is how a
/// transparent proxy (leaks your address) or an anonymous one (announces
/// itself) is simulated. `refuse_connect_with` makes it answer CONNECT with
/// that status instead of tunnelling.
async fn spawn_http_proxy(
    inject: Vec<(&'static str, String)>,
    refuse_connect_with: Option<&'static str>,
) -> (SocketAddr, Arc<AtomicBool>) {
    let saw_connect = Arc::new(AtomicBool::new(false));
    let flag = saw_connect.clone();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = l.accept().await {
            let inject = inject.clone();
            let flag = flag.clone();
            tokio::spawn(async move {
                let head = read_head(&mut client).await;
                let Some(request_line) = head.lines().next() else {
                    return;
                };
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or("");
                let uri = parts.next().unwrap_or("");

                if method == "CONNECT" {
                    flag.store(true, Ordering::SeqCst);
                    if let Some(status) = refuse_connect_with {
                        let _ = client
                            .write_all(
                                format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                                    .as_bytes(),
                            )
                            .await;
                        return;
                    }
                    let Ok(mut upstream) = connect_as_proxy(uri).await else {
                        return;
                    };
                    let _ = client.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                    return;
                }

                let rest = uri.strip_prefix("http://").unwrap_or(uri);
                let (authority, path) = match rest.find('/') {
                    Some(i) => (&rest[..i], &rest[i..]),
                    None => (rest, "/"),
                };
                let Ok(mut upstream) = connect_as_proxy(authority).await else {
                    return;
                };
                let mut out = format!("GET {path} HTTP/1.1\r\n");
                for line in head.lines().skip(1).filter(|l| !l.is_empty()) {
                    out.push_str(line);
                    out.push_str("\r\n");
                }
                for (k, v) in &inject {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\n");
                let _ = upstream.write_all(out.as_bytes()).await;
                let _ = upstream.flush().await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    (addr, saw_connect)
}

/// A minimal SOCKS5 proxy: no-auth greeting, CONNECT, then relay.
async fn spawn_socks5() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut hdr = [0u8; 2];
                if c.read_exact(&mut hdr).await.is_err() || hdr[0] != 5 {
                    return;
                }
                let mut methods = vec![0u8; hdr[1] as usize];
                if c.read_exact(&mut methods).await.is_err() || c.write_all(&[5, 0]).await.is_err() {
                    return;
                }
                let mut req = [0u8; 4];
                if c.read_exact(&mut req).await.is_err() {
                    return;
                }
                let host = match req[3] {
                    1 => {
                        let mut a = [0u8; 4];
                        if c.read_exact(&mut a).await.is_err() {
                            return;
                        }
                        std::net::Ipv4Addr::from(a).to_string()
                    }
                    3 => {
                        let mut len = [0u8; 1];
                        if c.read_exact(&mut len).await.is_err() {
                            return;
                        }
                        let mut name = vec![0u8; len[0] as usize];
                        if c.read_exact(&mut name).await.is_err() {
                            return;
                        }
                        String::from_utf8_lossy(&name).into_owned()
                    }
                    _ => return,
                };
                let mut p = [0u8; 2];
                if c.read_exact(&mut p).await.is_err() {
                    return;
                }
                let port = u16::from_be_bytes(p);
                let Ok(mut upstream) = connect_as_proxy(&format!("{host}:{port}")).await else {
                    let _ = c.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await;
                    return;
                };
                if c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut c, &mut upstream).await;
            });
        }
    });
    addr
}

/// A minimal SOCKS4 proxy: CONNECT request, granted reply, then relay.
async fn spawn_socks4() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut req = [0u8; 8];
                if c.read_exact(&mut req).await.is_err() || req[0] != 4 || req[1] != 1 {
                    return;
                }
                let port = u16::from_be_bytes([req[2], req[3]]);
                let ip = std::net::Ipv4Addr::new(req[4], req[5], req[6], req[7]);
                let mut b = [0u8; 1];
                loop {
                    match c.read_exact(&mut b).await {
                        Ok(_) if b[0] == 0 => break,
                        Ok(_) => {}
                        Err(_) => return,
                    }
                }
                let Ok(mut upstream) = connect_as_proxy(&format!("{ip}:{port}")).await else {
                    let _ = c.write_all(&[0, 91, 0, 0, 0, 0, 0, 0]).await;
                    return;
                };
                if c.write_all(&[0, 0x5a, 0, 0, 0, 0, 0, 0]).await.is_err() {
                    return;
                }
                let _ = tokio::io::copy_bidirectional(&mut c, &mut upstream).await;
            });
        }
    });
    addr
}

fn budget() -> Budget {
    Budget {
        connect: Duration::from_secs(3),
        total: Duration::from_secs(5),
    }
}

fn judge_at(addr: &SocketAddr) -> Judge {
    Judge::echo(&format!("http://{addr}/echo")).unwrap()
}

fn checker_with(judge: &SocketAddr) -> Checker {
    // No trace rungs: the fake judge is the only rung, so a failure there is
    // a failure of the proxy and not of the ladder.
    Checker::new(Ladder::from_urls(&format!("http://{judge}/echo"), "https://192.0.2.2:9/unused", "", "").unwrap())
}

fn http_only() -> CheckOptions {
    CheckOptions {
        timeout: Duration::from_secs(5),
        protocols: ProtocolSet {
            http: true,
            https: false,
            socks4: false,
            socks5: false,
        },
        ..Default::default()
    }
}

fn socks5_only() -> CheckOptions {
    CheckOptions {
        timeout: Duration::from_secs(5),
        protocols: ProtocolSet {
            http: false,
            https: false,
            socks4: false,
            socks5: true,
        },
        ..Default::default()
    }
}

fn line(port: u16) -> hproxy_probe::ProxyLine {
    hproxy_probe::parse(&format!("127.0.0.1:{port}")).unwrap()
}

// ── The probes, against real proxies ─────────────────────────────────────────

#[tokio::test]
async fn http_probe_talks_to_a_real_proxy_and_times_every_phase() {
    let judge = spawn_judge().await;
    let (proxy, _) = spawn_http_proxy(vec![], None).await;
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::http(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &[judge_at(&judge)],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;

    assert!(
        p.alive,
        "the probe must reach the judge through the proxy: {:?}",
        p.failure
    );
    let t = p.timings.expect("an alive probe must carry timings");
    assert!(t.dns_ms.is_none(), "a literal address means no lookup happened");
    assert!(t.handshake_ms.is_none(), "plain HTTP has no admission step");
    assert!(t.tls_ms.is_none());
    assert!(t.total_ms >= t.connect_ms);
    let echo = p.echo.expect("the judge's echo must survive to the caller");
    assert_eq!(
        echo.exit_ip().as_deref(),
        Some(EXIT_PUBLIC),
        "the judge saw the proxy's exit, and we kept it"
    );
    assert!(echo.carries_nonce(&nonce));
}

#[tokio::test]
async fn socks5_probe_learns_the_exit_address_too() {
    let judge = spawn_judge().await;
    let socks = spawn_socks5().await;
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::socks5(
        Target {
            host: "127.0.0.1",
            port: socks.port(),
            auth: None,
        },
        &[judge_at(&judge)],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    assert!(p.alive, "SOCKS5 must reach the judge: {:?}", p.failure);
    assert!(
        p.timings.unwrap().handshake_ms.is_some(),
        "the SOCKS greeting is a real phase"
    );
    assert_eq!(p.echo.unwrap().exit_ip().as_deref(), Some(EXIT_PUBLIC));
}

#[tokio::test]
async fn socks4_probe_works_end_to_end() {
    let judge = spawn_judge().await;
    let socks = spawn_socks4().await;
    let nonce = hproxy_probe::echo::nonce();
    let rungs = [(judge_at(&judge), judge)];
    let p = transport::socks4(
        Target {
            host: "127.0.0.1",
            port: socks.port(),
            auth: None,
        },
        &rungs,
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    assert!(p.alive, "SOCKS4 must reach the judge: {:?}", p.failure);
    assert!(p.timings.and_then(|t| t.handshake_ms).is_some());
}

#[tokio::test]
async fn https_probe_sends_a_well_formed_connect() {
    let judge = spawn_judge().await;
    let (proxy, saw_connect) = spawn_http_proxy(vec![], None).await;
    // The TLS handshake will fail: the judge speaks plaintext. Under test is
    // that a correct CONNECT reaches the proxy and that a plaintext endpoint
    // cannot pass as a working TLS tunnel.
    let tls_judge = Judge::echo(&format!("https://{judge}/echo")).unwrap();
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::https(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &[tls_judge],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    assert!(
        saw_connect.load(Ordering::SeqCst),
        "the proxy must have received a CONNECT"
    );
    assert!(!p.alive);
    // A plaintext judge either answers the ClientHello with garbage (a TLS
    // error) or sits waiting for a request line that never comes (a timeout).
    // Either way the failure is in the TLS phase, which is the fact that matters.
    let f = p.failure.unwrap();
    assert_eq!(f.phase, hproxy_probe::Phase::Tls, "{f:?}");
    assert!(matches!(f.kind, Failure::Tls | Failure::Timeout), "{f:?}");
}

/// A judge that speaks TLS with a certificate no public authority issued: what
/// a proxy that intercepts HTTPS puts in front of every site. It reflects
/// exactly like `spawn_judge`, so to the engine it is a working rung.
async fn spawn_interceptor_judge() -> SocketAddr {
    let dir = format!("{}/tests/fixtures", env!("CARGO_MANIFEST_DIR"));
    let cert = rustls::pki_types::CertificateDer::from(std::fs::read(format!("{dir}/interceptor.crt.der")).unwrap());
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(rustls::pki_types::PrivatePkcs8KeyDer::from(
        std::fs::read(format!("{dir}/interceptor.key.der")).unwrap(),
    ));
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((s, peer)) = l.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(s).await else {
                    return;
                };
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                loop {
                    match tls.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                    }
                }
                let head = String::from_utf8_lossy(&buf).into_owned();
                let public = as_public(peer.ip());
                let body =
                    serde_json::json!({ "ip": public, "headers": header_map(&head), "peer_ip": public }).to_string();
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = tls.write_all(resp.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    addr
}

/// A proxy that re-signs HTTPS relays, so it is alive; it can also read what
/// it relays, so the probe must say the certificate was not the real one. Seen
/// live on 2026-09-19 on a proxy from a public list.
#[tokio::test]
async fn a_proxy_that_re_signs_https_stays_alive_and_is_named_an_interceptor() {
    let judge = spawn_interceptor_judge().await;
    let (proxy, saw_connect) = spawn_http_proxy(vec![], None).await;
    let tls_judge = Judge::echo(&format!("https://{judge}/echo")).unwrap();
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::https(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &[tls_judge],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    assert!(saw_connect.load(Ordering::SeqCst));
    assert!(p.alive, "it relays, so it is alive: {:?}", p.failure);
    assert_eq!(p.tls_genuine, Some(false), "a self-made certificate is not the judge's");
}

/// Squid and many others refuse a CONNECT whose target has no port. The judge
/// here is on 443, the default, where a Host header rightly drops the port and
/// a CONNECT line must not. Before 2026-09-19 the engine sent `CONNECT host`,
/// and every such proxy read as having no HTTPS.
#[tokio::test]
async fn a_connect_line_always_names_the_port_even_the_default_one() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = l.local_addr().unwrap();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = l.accept().await {
            let head = read_head(&mut c).await;
            let line = head.lines().next().unwrap_or("").to_string();
            let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
            let _ = tx.send(line);
            // Squid's answer to an authority without a port.
            let status = if target.rsplit_once(':').is_some_and(|(_, p)| p.parse::<u16>().is_ok()) {
                "502 Bad Gateway"
            } else {
                "400 Bad Request"
            };
            let _ = c
                .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes())
                .await;
        }
    });
    let judge = Judge::echo("https://judge.invalid/echo").unwrap();
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::https(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &[judge],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    let line = rx.recv().await.unwrap();
    assert!(line.starts_with("CONNECT judge.invalid:443 "), "{line}");
    assert_ne!(
        p.failure.unwrap().status,
        Some(400),
        "the proxy must not have refused the form"
    );
}

#[tokio::test]
async fn a_proxy_that_refuses_connect_with_407_says_so() {
    let judge = spawn_judge().await;
    let (proxy, _) = spawn_http_proxy(vec![], Some("407 Proxy Authentication Required")).await;
    let tls_judge = Judge::echo(&format!("https://{judge}/echo")).unwrap();
    let nonce = hproxy_probe::echo::nonce();
    let p = transport::https(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &[tls_judge],
        Context {
            nonce: &nonce,
            budget: budget(),
        },
    )
    .await;
    let f = p.failure.unwrap();
    assert_eq!(f.kind, Failure::AuthRequired);
    assert_eq!(f.status, Some(407));
}

// ── Anonymity, graded through real proxies ───────────────────────────────────

#[tokio::test]
async fn a_clean_proxy_grades_elite_with_exit_and_rotation() {
    let judge = spawn_judge().await;
    let (proxy, _) = spawn_http_proxy(vec![], None).await;
    let checker = checker_with(&judge);
    let r = checker.check(&line(proxy.port()), &http_only()).await;

    assert!(r.alive, "{:?}", r.error);
    assert_eq!(r.status, Status::Alive);
    assert_eq!(r.protocols, vec!["http"]);
    assert_eq!(r.anonymity.as_deref(), Some("elite"));
    assert!(
        r.leaked_headers.is_empty(),
        "a clean proxy must leak nothing, got {:?}",
        r.leaked_headers
    );
    assert_eq!(r.exit_ip.as_deref(), Some(EXIT_PUBLIC));
    assert_eq!(
        r.rotating,
        Some(true),
        "dialled 127.0.0.1, came out elsewhere: a gateway or pool sits behind the address"
    );
    assert_eq!(r.timings.len(), 1);
    assert_eq!(r.latency_ms, Some(r.timings[0].timings.total_ms as i32));
    assert_eq!(r.judge.as_deref(), Some("echo"));
    assert!(r.failure.is_none() && r.error.is_none());
}

#[tokio::test]
async fn a_proxy_that_announces_itself_grades_anonymous_and_is_identified() {
    let judge = spawn_judge().await;
    let (proxy, _) = spawn_http_proxy(vec![("Via", "1.1 gw (squid/5.7)".into())], None).await;
    let r = checker_with(&judge).check(&line(proxy.port()), &http_only()).await;
    assert_eq!(r.anonymity.as_deref(), Some("anonymous"));
    assert_eq!(r.server.as_deref(), Some("Squid"), "Via names the software");
    assert_eq!(r.leaked_headers.len(), 1);
    assert_eq!(r.leaked_headers[0].name, "via");
    assert!(r.leaked_headers[0].value.contains("squid"));
}

#[tokio::test]
async fn a_proxy_that_forwards_your_address_grades_transparent() {
    let judge = spawn_judge().await;
    // The judge names us OWN_PUBLIC when dialled directly, so that is this
    // machine's own address for grading. A proxy forwarding it is transparent.
    let (proxy, _) = spawn_http_proxy(vec![("X-Forwarded-For", OWN_PUBLIC.into())], None).await;
    let r = checker_with(&judge).check(&line(proxy.port()), &http_only()).await;
    assert_eq!(
        r.anonymity.as_deref(),
        Some("transparent"),
        "a proxy handing the origin your own address is the grade that matters most"
    );
    assert_eq!(r.leaked_headers[0].name, "x-forwarded-for");
    assert_eq!(
        r.leaked_headers[0].value, OWN_PUBLIC,
        "the value is the whole diagnosis"
    );
}

// ── The guards ───────────────────────────────────────────────────────────────

/// A 200 that is not our judge must not count as a working proxy.
#[tokio::test]
async fn a_200_that_is_not_our_judge_is_not_alive() {
    let impostor = spawn_impostor("200 OK", "<html>Sign in to continue</html>").await;
    let (proxy, _) = spawn_http_proxy(vec![], None).await;
    let r = checker_with(&impostor).check(&line(proxy.port()), &http_only()).await;
    assert!(!r.alive, "reaching something is not the same as reaching our judge");
    assert_eq!(r.failure, Some(Failure::NoEcho));
    assert!(r.error.as_deref().unwrap().contains("not a proxy"));
}

/// A judge that redirects must fail loudly rather than be followed: following
/// a plain-HTTP judge to HTTPS destroys anonymity grading silently.
#[tokio::test]
async fn a_redirecting_judge_is_a_dead_judge_not_a_followed_one() {
    let redirector = spawn_impostor("301 Moved Permanently", "moved").await;
    let (proxy, _) = spawn_http_proxy(vec![], None).await;
    let r = checker_with(&redirector).check(&line(proxy.port()), &http_only()).await;
    assert!(!r.alive);
    assert_eq!(r.failure, Some(Failure::BadStatus));
    assert_eq!(r.failures[0].detail.status, Some(301));
}

#[tokio::test]
async fn a_dead_proxy_settles_dead_within_its_budget_and_says_why() {
    let judge = spawn_judge().await;
    let started = std::time::Instant::now();
    let r = checker_with(&judge)
        .check(&hproxy_probe::parse("192.0.2.1:8080").unwrap(), &http_only())
        .await;
    assert!(!r.alive);
    assert!(r.timings.is_empty());
    assert!(r.failure.is_some());
    assert!(r.error.as_deref().is_some_and(|e| e.contains("after")), "{:?}", r.error);
    assert!(
        started.elapsed() < Duration::from_secs(12),
        "overran: {:?}",
        started.elapsed()
    );
}

/// THE regression guard. Making every transport parse the judge's echo (so
/// SOCKS and HTTPS learn the exit) must never make every transport GRADE on
/// that echo. Our real TLS judge is behind a CDN that stamps
/// `x-forwarded-for: <your address>` on every request; grading a tunnel on it
/// would call every tunnelling proxy on earth transparent. A tunnel cannot
/// rewrite a header. Only the plain-HTTP probe is graded on headers.
#[tokio::test]
async fn a_cdn_judges_own_headers_are_never_blamed_on_a_tunnelling_proxy() {
    let cdn = spawn_cdn_judge().await;
    let socks = spawn_socks5().await;
    let r = checker_with(&cdn).check(&line(socks.port()), &socks5_only()).await;
    assert!(r.alive, "the SOCKS proxy works: {:?}", r.error);
    assert_eq!(
        r.anonymity.as_deref(),
        Some("elite"),
        "a byte tunnel cannot add a header"
    );
    assert!(
        r.leaked_headers.is_empty(),
        "these are the CDN's headers: {:?}",
        r.leaked_headers
    );
    assert_eq!(r.server, None);
    assert_eq!(
        r.exit_ip.as_deref(),
        Some(EXIT_PUBLIC),
        "the exit is still observed on the wire"
    );
}

/// LIVE: the hand-written request against the real judge. Ignored by default;
/// run with `cargo test -p hproxy-probe --test proxy_e2e real_judge -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "hits the live judge"]
async fn hand_written_request_survives_the_real_judge() {
    let (proxy, _) = spawn_http_proxy(vec![], None).await;
    let nonce = hproxy_probe::echo::nonce();
    let rungs = Ladder::public().plain;
    let p = transport::http(
        Target {
            host: "127.0.0.1",
            port: proxy.port(),
            auth: None,
        },
        &rungs,
        Context {
            nonce: &nonce,
            budget: Budget {
                connect: Duration::from_secs(6),
                total: Duration::from_secs(15),
            },
        },
    )
    .await;
    assert!(
        p.alive,
        "real nginx must accept the hand-written request: {:?}",
        p.failure
    );
    let echo = p.echo.expect("echo");
    let exit = echo.exit_ip().expect("the real judge names the exit");
    let t = p.timings.expect("timings");
    println!(
        "live: exit={exit} connect={} ms ttfb={} ms total={} ms judge={:?}",
        t.connect_ms, t.ttfb_ms, t.total_ms, p.judge
    );
}
