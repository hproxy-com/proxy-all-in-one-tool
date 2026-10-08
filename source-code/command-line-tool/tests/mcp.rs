//! `hproxy mcp`, end to end: the real binary, the real protocol over stdio.
//!
//! Every answer is read back as JSON-RPC, so anything else on stdout (a stray
//! print from a library, a banner) fails the test that meets it. Nothing here
//! needs the internet: checks use lines that cannot be read as proxies, and
//! the connection goes to a fake upstream on this machine.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

const USER: &str = "agent";
const PASS: &str = "n0t-for-the-model";
/// base64("agent:n0t-for-the-model")
const EXPECTED_AUTH: &str = "Basic YWdlbnQ6bjB0LWZvci10aGUtbW9kZWw=";

struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    lines: mpsc::Receiver<String>,
}

impl Session {
    fn start(env: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_hproxy"));
        cmd.arg("mcp")
            .env_remove("HPROXY_PROXY")
            .env_remove("HPROXY_PROXY_FILE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().expect("could not start hproxy mcp");
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(l) = line else { break };
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
        Session {
            child,
            stdin,
            lines: rx,
        }
    }

    fn send(&mut self, text: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{text}").unwrap();
        stdin.flush().unwrap();
    }

    fn next(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(Duration::from_secs(20))
            .expect("the server did not answer");
        serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout carried something that is not JSON-RPC: {line}"))
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string());
        let v = self.next();
        assert_eq!(v["id"], id, "answers came back out of order: {v}");
        v
    }

    fn tool(&mut self, id: u64, name: &str, args: Value) -> (Value, bool) {
        let v = self.call(id, "tools/call", json!({"name": name, "arguments": args}));
        let result = &v["result"];
        let text = result["content"][0]["text"]
            .as_str()
            .unwrap_or_else(|| panic!("no text in {v}"));
        let is_error = result["isError"].as_bool().unwrap_or(false);
        let body = serde_json::from_str(text).unwrap_or(Value::String(text.to_string()));
        (body, is_error)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn a_session_initialises_lists_its_tools_and_answers_pings() {
    let mut s = Session::start(&[]);
    let v = s.call(
        1,
        "initialize",
        json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}),
    );
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(v["result"]["serverInfo"]["name"], "hproxy");
    assert!(v["result"]["capabilities"]["tools"].is_object());
    assert!(v["result"]["instructions"].as_str().unwrap().contains("proxy_connect"));

    // A notification gets no answer: the next line is the ping's.
    s.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#);
    let v = s.call(2, "ping", json!({}));
    assert_eq!(v["result"], json!({}));

    let v = s.call(3, "tools/list", json!({}));
    let names: Vec<&str> = v["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for want in [
        "proxy_check",
        "proxy_list",
        "ip_lookup",
        "proxy_connect",
        "proxy_status",
        "proxy_new_ip",
        "proxy_disconnect",
    ] {
        assert!(names.contains(&want), "{want} missing from {names:?}");
    }
}

#[test]
fn protocol_mistakes_get_protocol_errors_and_tool_mistakes_get_answers() {
    let mut s = Session::start(&[]);
    s.send("this is not json");
    assert_eq!(s.next()["error"]["code"], -32700);
    let v = s.call(1, "no/such/method", json!({}));
    assert_eq!(v["error"]["code"], -32601);
    let v = s.call(2, "tools/call", json!({"name": "no_such_tool", "arguments": {}}));
    assert_eq!(v["error"]["code"], -32602);

    // A tool that cannot do what was asked answers in words, flagged isError.
    let (body, is_error) = s.tool(3, "proxy_check", json!({}));
    assert!(is_error);
    assert!(body.as_str().unwrap().contains("proxies"), "{body}");
    let (_, is_error) = s.tool(
        4,
        "proxy_check",
        json!({"proxies": ["1.2.3.4:80"], "protocols": ["ftp"]}),
    );
    assert!(is_error);
}

#[test]
fn a_check_of_unreadable_lines_is_counted_without_the_network() {
    let mut s = Session::start(&[]);
    let (body, is_error) = s.tool(
        1,
        "proxy_check",
        json!({"proxies": ["line-one", "line-two\nline-three"], "geo": false}),
    );
    assert!(!is_error, "{body}");
    assert_eq!(body["checked"], 3);
    assert_eq!(body["working"], 0);
    assert_eq!(body["unreadable_lines"], 3);
    assert_eq!(body["working_proxies"], json!([]));
}

/// The point of the connector for an agent: the proxy's login lives in the
/// server's environment, the agent uses a local address with no password, and
/// the upstream receives the right credentials. The password must never
/// appear in anything the model is sent.
#[test]
fn connect_carries_the_login_the_model_never_sees() {
    let origin = spawn_origin();
    let (upstream, seen) = spawn_upstream();
    let line = format!("127.0.0.1:{upstream}:{USER}:{PASS}");
    let mut s = Session::start(&[("HPROXY_PROXY", &line)]);

    let (body, is_error) = s.tool(1, "proxy_connect", json!({"verify": false}));
    assert!(!is_error, "{body}");
    assert!(
        !body.to_string().contains(PASS),
        "the password reached the model: {body}"
    );
    assert_eq!(body["connected"], true);
    let http_proxy = body["http_proxy"].as_str().unwrap().to_string();
    let local = http_proxy.trim_start_matches("http://").to_string();
    assert!(local.starts_with("127.0.0.1:"), "{local}");

    // A client with no credentials at all, through the local address.
    let mut c = TcpStream::connect(&local).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        c,
        "GET http://127.0.0.1:{origin}/via-mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut resp = String::new();
    let _ = c.read_to_string(&mut resp);
    assert!(resp.contains("ORIGIN-OK /via-mcp"), "{resp}");
    assert!(
        seen.lock().unwrap().iter().any(|h| h == EXPECTED_AUTH),
        "the upstream never got the login"
    );

    let (body, _) = s.tool(2, "proxy_status", json!({}));
    assert_eq!(body["connected"], true);
    assert!(body["stats"]["connections"].as_u64().unwrap() >= 1, "{body}");
    assert!(!body.to_string().contains(PASS));

    let (body, is_error) = s.tool(3, "proxy_new_ip", json!({}));
    assert!(is_error, "one proxy line cannot rotate: {body}");

    let (body, _) = s.tool(4, "proxy_disconnect", json!({}));
    assert_eq!(body["connected"], false);
    thread::sleep(Duration::from_millis(200));
    assert!(
        TcpStream::connect(&local).is_err(),
        "the local port is still open after disconnect"
    );

    // Closing stdin ends the session cleanly.
    drop(s.stdin.take());
    let status = s.child.wait().unwrap();
    assert!(status.success(), "{status}");
}

/// The other half of running behind you: what an assistant opens is not
/// hidden from the person whose machine it is. `hproxy status` in any terminal
/// shows it, `hproxy stop` ends it, and the server then says so instead of
/// pointing the model at a dead port.
#[test]
fn what_the_assistant_opened_is_visible_and_stoppable_from_a_terminal() {
    let dir = std::env::temp_dir().join(format!("hproxy-mcp-seen-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.to_string_lossy().to_string();
    let (upstream, _seen) = spawn_upstream();
    let line = format!("127.0.0.1:{upstream}:{USER}:{PASS}");
    let mut s = Session::start(&[("HPROXY_PROXY", &line), ("HPROXY_STATE_DIR", &state)]);

    let (body, is_error) = s.tool(1, "proxy_connect", json!({"verify": false}));
    assert!(!is_error, "{body}");
    let local = body["http_proxy"]
        .as_str()
        .unwrap()
        .trim_start_matches("http://")
        .to_string();

    // A terminal, with no idea a conversation is happening, sees it.
    let seen_from_outside = hproxy(&dir, &["status", "--json"]);
    let row: Value =
        serde_json::from_str(String::from_utf8_lossy(&seen_from_outside.stdout).trim()).expect("one JSON line");
    assert_eq!(row["connected"], true, "{row}");
    assert_eq!(row["listening"], local.as_str());
    assert!(
        !row.to_string().contains(PASS),
        "the password reached the state file: {row}"
    );

    // And ends it.
    let stop = hproxy(&dir, &["stop"]);
    assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
    assert!(TcpStream::connect(&local).is_err(), "the port is still open");

    // The server tells the model the truth about its own link now.
    let (body, _) = s.tool(2, "proxy_status", json!({}));
    assert_eq!(body["connected"], false, "{body}");

    let _ = std::fs::remove_dir_all(&dir);
}

fn hproxy(state: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_hproxy"))
        .args(args)
        .env("HPROXY_STATE_DIR", state)
        .env_remove("HPROXY_PROXY")
        .output()
        .expect("could not run hproxy")
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
    thread::spawn(move || {
        for s in l.incoming().flatten() {
            thread::spawn(move || {
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

fn spawn_upstream() -> (u16, Arc<Mutex<Vec<String>>>) {
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
                let auth = head
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("proxy-authorization:"))
                    .map(|l| l.split_once(':').map_or("", |(_, v)| v).trim().to_string())
                    .unwrap_or_default();
                sink.lock().unwrap().push(auth.clone());
                let mut client = s;
                if auth != EXPECTED_AUTH {
                    let _ = client.write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
                // Absolute-URI form only: fetch it like a real proxy.
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
    (port, seen)
}
