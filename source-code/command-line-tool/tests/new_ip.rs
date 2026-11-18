//! `hproxy new-ip` against the real binary: a connection through a list runs
//! in the background, and the command and the connection's own page move it
//! along the list, the way a person at a terminal and a script would.
//!
//! No internet and no proxy is ever reached: nothing goes through the
//! connection, so its list can be documentation addresses. The state goes to
//! a temporary directory of its own (`HPROXY_STATE_DIR`), so the test never
//! touches a connection a person has running.

use std::process::{Command, Output};

use serde_json::Value;

fn hproxy(state: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hproxy"))
        .args(args)
        .env("HPROXY_STATE_DIR", state)
        .env("HPROXY_NO_UPDATE_CHECK", "1")
        .env("HPROXY_NO_USAGE", "1")
        .env_remove("HPROXY_PROXY")
        .env_remove("HPROXY_PROXY_FILE")
        .output()
        .expect("could not run hproxy")
}

fn json_of(out: &Output) -> Value {
    assert!(
        out.status.success(),
        "exit {:?}: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(text.trim()).unwrap_or_else(|e| panic!("not one JSON line ({e}): {text}"))
}

fn start(state: &std::path::Path, args: &[&str]) -> String {
    let mut all = vec!["connect"];
    all.extend_from_slice(args);
    all.extend_from_slice(&["--listen", "127.0.0.1:0", "--background"]);
    let ready = json_of(&hproxy(state, &all));
    ready["listening"].as_str().unwrap().to_string()
}

#[test]
fn new_ip_moves_a_running_list_and_status_follows() {
    let dir = std::env::temp_dir().join(format!("hproxy-new-ip-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let list = dir.join("proxies.txt");
    std::fs::write(
        &list,
        "198.51.100.1:8080:u:p\n198.51.100.2:8080:u:p\n198.51.100.3:8080:u:p\n",
    )
    .unwrap();

    let listening = start(&dir, &["--file", list.to_str().unwrap(), "--rotate", "on-failure"]);
    let port = listening.rsplit(':').next().unwrap().to_string();

    // No address: the one connection running here.
    let s = json_of(&hproxy(&dir, &["new-ip", "--json"]));
    assert_eq!(s["ok"], true);
    assert_eq!((s["member"].as_u64(), s["members"].as_u64()), (Some(2), Some(3)), "{s}");
    assert!(s["upstream"].as_str().unwrap().contains("198.51.100.2"), "{s}");
    assert!(!s.to_string().contains(":p@"), "never the password: {s}");

    // By port, straight to a member.
    let s = json_of(&hproxy(&dir, &["new-ip", &port, "--member", "3", "--json"]));
    assert_eq!(s["member"], 3, "{s}");

    // Status says where it is now, from the connection itself.
    let st = json_of(&hproxy(&dir, &["status", "--json"]));
    assert_eq!(st["member"], 3, "{st}");
    assert!(st["now_on"].as_str().unwrap().contains("198.51.100.3"), "{st}");

    // In words, for a person: from the last member round to the first.
    let out = hproxy(&dir, &["new-ip", &listening]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let said = String::from_utf8_lossy(&out.stdout);
    assert!(said.starts_with("Now on proxy 1 of 3: "), "{said}");

    // A member the list does not have: refused, exit 2, and it says why.
    let out = hproxy(&dir, &["new-ip", &port, "--member", "9"]);
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("no proxy 9") && err.contains("ends at proxy 3"), "{err}");

    // One proxy: nothing to switch to, said as much.
    let fixed = start(&dir, &["198.51.100.7:8080:u:p"]);
    let out = hproxy(&dir, &["new-ip", &fixed]);
    assert_eq!(out.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("one proxy"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );

    // Two run now, so naming none is refused, with both named.
    let out = hproxy(&dir, &["new-ip"]);
    assert_eq!(out.status.code(), Some(2));
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains(&listening) && err.contains(&fixed), "{err}");

    // A typo of an option gets the closest real one.
    let out = hproxy(&dir, &["new-ip", "--membr", "2"]);
    assert!(String::from_utf8_lossy(&out.stderr).contains("--member"));

    let out = hproxy(&dir, &["stop"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let _ = std::fs::remove_dir_all(&dir);
}
