//! End-to-end tests against the REAL binary.
//!
//! These spawn `hproxy-relay` as a process (via `CARGO_BIN_EXE_…`) and drive
//! it over TCP, with a fake upstream proxy on one side and a fake origin server
//! on the other. Nothing here reaches inside the crate.
//!
//! That choice is deliberate. This codebase has twice shipped a green unit-test
//! suite over live bugs, and both times running the actual thing found them. A
//! proxy relay in particular is almost all wiring: whether the auth header lands
//! on the wire, whether a tunnel really carries bytes both ways, whether a
//! rejected login surfaces as an error instead of a hang. None of that is
//! visible from a function's return value.
//!
//! Written with `std::net` and threads rather than tokio so the test harness
//! needs no dependencies of its own.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const USER: &str = "test";
const PASS: &str = "s3cret";
/// base64("test:s3cret")
const EXPECTED_AUTH: &str = "Basic dGVzdDpzM2NyZXQ=";

/// Read an HTTP head (up to the blank line) from a blocking stream.
fn read_head(r: &mut BufReader<TcpStream>) -> String {
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let done = line == "\r\n" || line == "\n";
        head.push_str(&line);
        if done {
            break;
        }
    }
    head
}

fn pipe(mut a: TcpStream, mut b: TcpStream) {
    let mut buf = [0u8; 8192];
    loop {
        match a.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if b.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = b.shutdown(Shutdown::Write);
}

/// An origin web server that answers everything with a known body.
fn spawn_origin() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    thread::spawn(move || {
        for s in l.incoming().flatten() {
            thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let head = read_head(&mut r);
                // Echo the path back so a test can prove the request line was
                // rewritten into origin form when it needed to be.
                let path = head.split_whitespace().nth(1).unwrap_or("?").to_string();
                let body = format!("ORIGIN-OK {path}");
                let mut s = s;
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.flush();
                let _ = s.shutdown(Shutdown::Both);
            });
        }
    });
    port
}

/// A fake upstream HTTP proxy that DEMANDS the right credentials.
///
/// Returns its port and a handle to every `Proxy-Authorization` value it saw, so
/// a test can assert the header actually reached the wire rather than merely
/// being constructed somewhere.
fn spawn_upstream(require_auth: bool) -> (u16, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&seen);

    thread::spawn(move || {
        for s in l.incoming().flatten() {
            let sink = Arc::clone(&sink);
            thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let head = read_head(&mut r);
                let mut client = s;

                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("proxy-authorization:"))
                    .map(|l| l.split_once(':').map_or("", |(_, v)| v).trim().to_string());
                sink.lock().unwrap().push(auth.clone().unwrap_or_default());

                if require_auth && auth.as_deref() != Some(EXPECTED_AUTH) {
                    let _ = client.write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\n\
                          Proxy-Authenticate: Basic realm=\"test\"\r\n\
                          Content-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }

                let mut parts = head.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("").to_string();

                if method.eq_ignore_ascii_case("CONNECT") {
                    let Ok(server) = TcpStream::connect(&target) else {
                        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
                        return;
                    };
                    let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
                    let (c2, s2) = (client.try_clone().unwrap(), server.try_clone().unwrap());
                    let up = thread::spawn(move || pipe(c2, s2));
                    pipe(server, client);
                    let _ = up.join();
                    return;
                }

                // Absolute-URI form: fetch it ourselves, like a real proxy.
                let rest = target.split_once("://").map(|(_, r)| r).unwrap_or(&target);
                let (authority, path) = match rest.find('/') {
                    Some(i) => (&rest[..i], &rest[i..]),
                    None => (rest, "/"),
                };
                let authority = if authority.contains(':') {
                    authority.to_string()
                } else {
                    format!("{authority}:80")
                };
                let Ok(mut server) = TcpStream::connect(&authority) else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
                    return;
                };
                let _ = write!(
                    server,
                    "{method} {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
                );
                let _ = server.flush();
                pipe(server, client);
            });
        }
    });
    (port, seen)
}

struct Connector {
    child: Child,
    port: u16,
}

impl Drop for Connector {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Start the real binary and wait until its port answers.
fn start_connector(proxy_line: &str) -> Connector {
    // Claim a free port, then release it so the binary can bind it.
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let mut child = Command::new(env!("CARGO_BIN_EXE_hproxy-relay"))
        .arg(proxy_line)
        .arg("--listen")
        .arg(format!("127.0.0.1:{port}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to start hproxy-relay");

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Connector { child, port };
        }
        thread::sleep(Duration::from_millis(40));
    }
    // A relay that never answered must not outlive the test that started it.
    let _ = child.kill();
    let _ = child.wait();
    panic!("relay never came up on port {port}");
}

/// Send a plain-HTTP proxied request through the connector.
fn get_via(port: u16, url: &str) -> String {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(s, "GET {url} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    s.flush().unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

#[test]
fn a_plain_request_reaches_the_origin_with_credentials_attached() {
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:{PASS}"));

    let resp = get_via(c.port, &format!("http://127.0.0.1:{origin}/hello"));

    assert!(resp.contains("200 OK"), "no 200 from the origin:\n{resp}");
    assert!(resp.contains("ORIGIN-OK /hello"), "wrong body:\n{resp}");

    // The point of the whole binary: the client sent no credentials, and the
    // upstream received the right ones.
    let headers = seen.lock().unwrap().clone();
    assert!(
        headers.iter().any(|h| h == EXPECTED_AUTH),
        "upstream never saw the injected credentials, it saw: {headers:?}"
    );
}

#[test]
fn a_connect_tunnel_carries_bytes_both_ways() {
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:{PASS}"));

    let mut s = TcpStream::connect(("127.0.0.1", c.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "CONNECT 127.0.0.1:{origin} HTTP/1.1\r\nHost: 127.0.0.1:{origin}\r\n\r\n"
    )
    .unwrap();
    s.flush().unwrap();

    // The 200 that opens the tunnel.
    let mut r = BufReader::new(s.try_clone().unwrap());
    let head = read_head(&mut r);
    assert!(head.contains("200"), "tunnel was not established:\n{head}");

    // Now speak to the origin directly through it, as a browser would speak TLS.
    write!(s, "GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    s.flush().unwrap();
    let mut body = String::new();
    let _ = r.read_to_string(&mut body);

    assert!(
        body.contains("ORIGIN-OK /tunnelled"),
        "nothing came back through the tunnel:\n{body}"
    );
    let headers = seen.lock().unwrap().clone();
    assert!(
        headers.iter().any(|h| h == EXPECTED_AUTH),
        "CONNECT went upstream without credentials: {headers:?}"
    );
}

#[test]
fn a_rejected_login_surfaces_as_an_error_rather_than_a_hang() {
    // A wrong password must produce something the customer can see. A silent
    // hang is the single worst failure mode for this tool, because it looks
    // exactly like a dead proxy and sends people debugging the wrong thing.
    let (upstream, _seen) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:WRONG"));

    let (tx, rx) = mpsc::channel();
    let port = c.port;
    thread::spawn(move || {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        s.flush().unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        let _ = tx.send(out);
    });

    let resp = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("connector hung instead of reporting the rejected login");
    assert!(resp.contains("502"), "expected a 502 explaining the refusal:\n{resp}");
    assert!(
        resp.to_lowercase().contains("connector"),
        "the error should name itself so it is debuggable:\n{resp}"
    );
}

#[test]
fn an_open_upstream_works_with_no_credentials() {
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(false);
    let c = start_connector(&format!("127.0.0.1:{upstream}"));

    let resp = get_via(c.port, &format!("http://127.0.0.1:{origin}/open"));
    assert!(resp.contains("ORIGIN-OK /open"), "{resp}");

    // No auth invented out of nowhere.
    let headers = seen.lock().unwrap().clone();
    assert!(
        headers.iter().all(|h| h.is_empty()),
        "sent credentials to an upstream that has none: {headers:?}"
    );
}

#[test]
fn the_at_shape_is_accepted_too() {
    // Same proxy, written the other way round. A customer should not have to
    // rearrange their line to use this tool.
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(true);
    let c = start_connector(&format!("{USER}:{PASS}@127.0.0.1:{upstream}"));

    let resp = get_via(c.port, &format!("http://127.0.0.1:{origin}/at"));
    assert!(resp.contains("ORIGIN-OK /at"), "{resp}");
    assert!(seen.lock().unwrap().iter().any(|h| h == EXPECTED_AUTH));
}

#[test]
fn a_clients_own_proxy_authorization_is_replaced_not_duplicated() {
    // Some software sends a guessed or stale Proxy-Authorization of its own. If
    // both survive, the upstream sees two and picks one, which fails
    // intermittently and is horrible to diagnose.
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:{PASS}"));

    let mut s = TcpStream::connect(("127.0.0.1", c.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "GET http://127.0.0.1:{origin}/dup HTTP/1.1\r\nHost: x\r\n\
         Proxy-Authorization: Basic STALEVALUE\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    s.flush().unwrap();
    let mut resp = String::new();
    let _ = s.read_to_string(&mut resp);

    assert!(resp.contains("ORIGIN-OK /dup"), "{resp}");
    let headers = seen.lock().unwrap().clone();
    assert!(headers.iter().any(|h| h == EXPECTED_AUTH), "{headers:?}");
    assert!(
        !headers.iter().any(|h| h.contains("STALEVALUE")),
        "the client's stale header reached the upstream: {headers:?}"
    );
}

#[test]
fn a_socks5_client_is_carried_through_an_http_upstream_with_the_login() {
    // The same local port answers SOCKS5. A program that only knows SOCKS
    // reaches an HTTP proxy that demands a password, and never sees it.
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:{PASS}"));

    let mut s = TcpStream::connect(("127.0.0.1", c.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    // Greeting: one method, no login.
    s.write_all(&[0x05, 0x01, 0x00]).unwrap();
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice).unwrap();
    assert_eq!(choice, [0x05, 0x00]);
    // CONNECT 127.0.0.1:<origin>.
    let mut req = vec![0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1];
    req.extend_from_slice(&origin.to_be_bytes());
    s.write_all(&req).unwrap();
    let mut reply = [0u8; 10];
    s.read_exact(&mut reply).unwrap();
    assert_eq!(reply[1], 0x00, "SOCKS5 reply was not success: {reply:?}");

    write!(s, "GET /over-socks HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
    s.flush().unwrap();
    let mut body = String::new();
    let _ = s.read_to_string(&mut body);
    assert!(body.contains("ORIGIN-OK /over-socks"), "{body}");
    assert!(
        seen.lock().unwrap().iter().any(|h| h == EXPECTED_AUTH),
        "the upstream never saw the login"
    );
}

#[test]
fn a_socks5_client_is_told_when_the_upstream_refuses() {
    // Wrong password upstream: the SOCKS5 client gets a failure reply, not a hang.
    let (upstream, _) = spawn_upstream(true);
    let c = start_connector(&format!("127.0.0.1:{upstream}:{USER}:WRONG"));

    let mut s = TcpStream::connect(("127.0.0.1", c.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    s.write_all(&[0x05, 0x01, 0x00]).unwrap();
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice).unwrap();
    s.write_all(&[0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50])
        .unwrap();
    let mut reply = [0u8; 10];
    s.read_exact(&mut reply).expect("the relay hung instead of answering");
    assert_ne!(reply[1], 0x00, "a refused upstream must not read as success");
}

#[test]
fn opening_the_port_in_a_browser_explains_itself() {
    // People will inevitably type http://127.0.0.1:8080 into a browser. A blank
    // page or a hang teaches them nothing.
    let (upstream, _) = spawn_upstream(false);
    let c = start_connector(&format!("127.0.0.1:{upstream}"));

    let mut s = TcpStream::connect(("127.0.0.1", c.port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(s, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").unwrap();
    s.flush().unwrap();
    let mut resp = String::new();
    let _ = s.read_to_string(&mut resp);

    assert!(resp.contains("400"), "{resp}");
    assert!(resp.to_lowercase().contains("proxy"), "{resp}");
}
