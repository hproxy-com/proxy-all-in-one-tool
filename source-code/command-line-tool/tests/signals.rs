//! Stopping a connection the way services and containers do: SIGTERM, which
//! `docker stop`, Kubernetes, Amazon ECS and systemd send. The relay has to end
//! as it does on Ctrl+C, cleanly and with exit code 0, rather than be killed by
//! the signal (in a container, where it is process 1, the kernel would drop an
//! unhandled SIGTERM and the container would be killed after its grace period).
//!
//! No internet: the upstream is never reached, nothing goes through before the
//! stop, and the state goes to a temporary directory of its own.

#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::os::unix::process::ExitStatusExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn sigterm_stops_the_relay_cleanly() {
    let dir = std::env::temp_dir().join(format!("hproxy-sigterm-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_hproxy"))
        .args(["connect", "127.0.0.1:9", "--listen", "127.0.0.1:0", "--json"])
        .env("HPROXY_STATE_DIR", &dir)
        .env("HPROXY_NO_UPDATE_CHECK", "1")
        .env("HPROXY_NO_USAGE", "1")
        .env_remove("HPROXY_PROXY")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("could not run hproxy");

    // Ready: the one JSON line, written once it listens.
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    assert!(ready.contains("\"listening\""), "not ready: {ready}");

    // SAFETY: kill(2) on the child this test started and still owns.
    let sent = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(sent, 0, "could not send SIGTERM");

    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if started.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            panic!("still running 10 s after SIGTERM");
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(
        status.signal(),
        None,
        "killed by the signal instead of stopping: {status:?}"
    );
    assert_eq!(status.code(), Some(0), "{status:?}");
}
