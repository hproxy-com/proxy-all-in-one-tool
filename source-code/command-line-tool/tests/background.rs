//! A connection that runs behind you, end to end, against the real binary:
//! start it detached, use it, read its status, stop it.
//!
//! No internet: the upstream is a fake proxy on this machine, and the state
//! file goes to a temporary directory of its own (`HPROXY_STATE_DIR`), so the
//! test never touches a real connection a person has running.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::Value;

const USER: &str = "agent";
const PASS: &str = "n0t-for-the-model";
/// base64("agent:n0t-for-the-model")
const EXPECTED_AUTH: &str = "Basic YWdlbnQ6bjB0LWZvci10aGUtbW9kZWw=";

fn hproxy(state: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hproxy"))
        .args(args)
        .env("HPROXY_STATE_DIR", state)
        .env_remove("HPROXY_PROXY")
        .output()
        .expect("could not run hproxy")
}

#[test]
fn a_background_connection_starts_serves_and_stops() {
    let dir = std::env::temp_dir().join(format!("hproxy-bg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let origin = spawn_origin();
    let upstream = spawn_upstream();
    let line = format!("127.0.0.1:{upstream}:{USER}:{PASS}");

    // Starting returns at once, with where it listens.
    let started = Instant::now();
    let out = hproxy(&dir, &["connect", &line, "--listen", "127.0.0.1:0", "--background"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let ready: Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).trim()).expect("one JSON line");
    let local = ready["listening"].as_str().unwrap().to_string();
    assert!(local.starts_with("127.0.0.1:"), "{local}");
    assert!(!ready.to_string().contains(PASS), "the password must not be printed");
    assert!(
        started.elapsed() < Duration::from_secs(30),
        "took {:?}",
        started.elapsed()
    );

    // It is a different process, and this one is free again.
    let status: Value =
        serde_json::from_str(String::from_utf8_lossy(&hproxy(&dir, &["status", "--json"]).stdout).trim()).unwrap();
    assert_eq!(status["connected"], true);
    assert_eq!(status["listening"], local.as_str());
    assert_ne!(status["pid"].as_u64().unwrap(), std::process::id() as u64);
    assert!(!status.to_string().contains(PASS));

    // A client with no credentials reaches the origin through it.
    let mut c = TcpStream::connect(&local).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        c,
        "GET http://127.0.0.1:{origin}/behind-you HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut resp = String::new();
    let _ = c.read_to_string(&mut resp);
    assert!(resp.contains("ORIGIN-OK /behind-you"), "{resp}");

    // Taking the same address twice is refused, and says which one is there.
    let clash = hproxy(&dir, &["connect", &line, "--listen", &local, "--background"]);
    assert!(!clash.status.success());
    assert!(
        String::from_utf8_lossy(&clash.stderr).contains("already running"),
        "{}",
        String::from_utf8_lossy(&clash.stderr)
    );

    // A second one on its own port is fine: a person and an assistant can each
    // have theirs. Both show up, oldest first.
    let second = hproxy(&dir, &["connect", &line, "--listen", "127.0.0.1:0", "--background"]);
    assert!(second.status.success(), "{}", String::from_utf8_lossy(&second.stderr));
    let other: Value = serde_json::from_str(String::from_utf8_lossy(&second.stdout).trim()).expect("one JSON line");
    let other_local = other["listening"].as_str().unwrap().to_string();
    assert_ne!(other_local, local, "each gets its own port");

    let both = hproxy(&dir, &["status", "--json"]);
    let text = String::from_utf8_lossy(&both.stdout).to_string();
    let rows: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l.trim()).expect("one JSON object per line"))
        .collect();
    assert_eq!(rows.len(), 2, "both are listed: {text}");
    let mut listed: Vec<String> = rows
        .iter()
        .map(|r| r["listening"].as_str().unwrap_or("").to_string())
        .collect();
    listed.sort();
    let mut expected = vec![local.clone(), other_local];
    expected.sort();
    assert_eq!(listed, expected);

    // Stopping without naming one ends them all and frees the ports.
    let stop = hproxy(&dir, &["stop"]);
    assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
    assert_eq!(
        String::from_utf8_lossy(&stop.stdout)
            .lines()
            .filter(|l| l.starts_with("Stopped "))
            .count(),
        2,
        "{}",
        String::from_utf8_lossy(&stop.stdout)
    );
    assert!(TcpStream::connect(&local).is_err(), "the port is still open");
    let after = hproxy(&dir, &["status", "--json"]);
    assert_eq!(after.status.code(), Some(1), "nothing running means exit 1");
    assert_eq!(
        serde_json::from_str::<Value>(String::from_utf8_lossy(&after.stdout).trim()).unwrap()["connected"],
        false
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn stopping_nothing_is_not_an_error() {
    let dir = std::env::temp_dir().join(format!("hproxy-bg-none-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let out = hproxy(&dir, &["stop"]);
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("Nothing was running"));
    let _ = std::fs::remove_dir_all(&dir);
}

// ── A fake origin and a fake upstream proxy that demands a login ──────────────

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

fn spawn_origin() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            std::thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let head = read_head(&mut r);
                let path = head.split_whitespace().nth(1).unwrap_or("?").to_string();
                let body = format!("ORIGIN-OK {path}");
                let mut s = s;
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.shutdown(Shutdown::Both);
            });
        }
    });
    port
}

fn spawn_upstream() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            std::thread::spawn(move || {
                let mut r = BufReader::new(s.try_clone().unwrap());
                let head = read_head(&mut r);
                let mut client = s;
                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("proxy-authorization:"))
                    .map(|l| l.split_once(':').map_or("", |(_, v)| v).trim().to_string())
                    .unwrap_or_default();
                if auth != EXPECTED_AUTH {
                    let _ = client.write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
                let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let rest = target.split_once("://").map(|(_, r)| r).unwrap_or(&target);
                let (authority, path) = match rest.find('/') {
                    Some(i) => (&rest[..i], &rest[i..]),
                    None => (rest, "/"),
                };
                let Ok(mut server) = TcpStream::connect(authority) else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
                    return;
                };
                let _ = write!(
                    server,
                    "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
                );
                let mut buf = Vec::new();
                let _ = server.read_to_end(&mut buf);
                let _ = client.write_all(&buf);
                let _ = client.shutdown(Shutdown::Both);
            });
        }
    });
    port
}
