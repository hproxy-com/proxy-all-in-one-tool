//! `hproxy connect`, `hproxy free`, `hproxy status`, `hproxy stop`.
//!
//! A connection can run in front of you or behind you.
//!
//! **In front** is the old behaviour: the command stays, prints what to type
//! into a program, and Ctrl+C ends it.
//!
//! **Behind** (`--background`) is for the case where a person, or an AI
//! assistant acting for them, wants a proxy available while they get on with
//! something else. The command starts a second copy of this program with no
//! console window, prints where it listens, and returns. Nothing stays on
//! screen, nothing holds a terminal, and closing the terminal does not take
//! the connection with it.
//!
//! HOW IT IS STOPPED, and why there is no process killing here. Every
//! connection writes one small file named after its own process (see
//! [`state_dir`]) and reads it back every half second: when its file is gone,
//! it shuts down by itself. `hproxy stop` just deletes those files and waits
//! for the ports to close. That works the same on Windows, macOS and Linux,
//! needs no privilege and no extra library, and a file deleted by hand or
//! wiped by a restart cleans up after itself instead of leaving something
//! running that nothing knows how to end.
//!
//! A FILE EACH, not one shared file. Several connections are normal: a person
//! has one for their browser while an assistant runs its own for scraping, and
//! the MCP server publishes its link here too, so `hproxy status` shows what
//! was opened on this machine even when nobody was watching, and `hproxy stop`
//! ends it. One file per process means two of them can never overwrite each
//! other's entry, and nothing has to lock anything.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hproxy_relay::cli::{listen_addr, source_from, Args};
use hproxy_relay::Stats;
use serde::{Deserialize, Serialize};

use crate::rows::Obj;
use crate::Outcome;

/// Set on the child, so it knows it is the background copy.
const CHILD_MARK: &str = "HPROXY_BACKGROUND";

/// How often the background copy reads its own state file back.
const WATCH_EVERY: Duration = Duration::from_millis(500);

/// What is running, written by the background copy and read by `status` and
/// `stop`. Passwords never appear: `upstream` is the masked label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Running {
    pub pid: u32,
    pub listening: String,
    pub http_proxy: String,
    pub socks5_proxy: String,
    pub upstream: String,
    pub source: String,
    pub started_at: u64,
}

/// `<data dir>/hproxy/connections`, created on demand. The OS's own place for
/// a program's state: `%LOCALAPPDATA%` on Windows, `~/Library/Application
/// Support` on macOS, `$XDG_STATE_HOME` or `~/.local/state` elsewhere.
/// `HPROXY_STATE_DIR` overrides all of it, which is what the tests use.
pub fn state_dir() -> PathBuf {
    let base = std::env::var_os("HPROXY_STATE_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            if cfg!(windows) {
                std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
            } else if cfg!(target_os = "macos") {
                std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
            } else {
                std::env::var_os("XDG_STATE_HOME")
                    .map(PathBuf::from)
                    .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/state")))
            }
            .map(|dir| dir.join("hproxy"))
        })
        .unwrap_or_else(std::env::temp_dir)
        .join("connections");
    let _ = std::fs::create_dir_all(&base);
    base
}

fn entry_path(pid: u32) -> PathBuf {
    state_dir().join(format!("{pid}.json"))
}

/// Can we write there at all? Asked before a background connection starts,
/// because one that cannot publish itself is one nobody can see or stop: on a
/// locked-down machine the starter would otherwise wait a minute and then
/// blame the connection for not coming up.
fn state_dir_is_writable() -> Result<(), String> {
    let dir = state_dir();
    let probe = dir.join(format!(".writable-{}", std::process::id()));
    std::fs::write(&probe, b"").map_err(|e| {
        format!(
            "cannot write in {}: {e}. Point HPROXY_STATE_DIR at a directory you can write to.",
            dir.display()
        )
    })?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// Say that this process is serving a connection. The file is the readiness
/// signal a starter waits for and the switch `hproxy stop` turns off, so it is
/// written once the port is open and never before.
pub fn publish(r: &Running) -> Result<(), String> {
    let path = entry_path(r.pid);
    std::fs::write(&path, serde_json::to_string_pretty(r).unwrap_or_default())
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// One process's entry, as it wrote it.
pub fn read_entry(pid: u32) -> Option<Running> {
    serde_json::from_str(&std::fs::read_to_string(entry_path(pid)).ok()?).ok()
}

/// Take our own entry away, when we are the one leaving.
pub fn unpublish(pid: u32) {
    let _ = std::fs::remove_file(entry_path(pid));
}

/// Has someone asked us to stop? Cheap on purpose: every connection asks this
/// twice a second, so it looks at one filename and touches no network.
pub fn asked_to_stop(pid: u32) -> bool {
    !entry_path(pid).exists()
}

/// Raised the moment this process's entry is on disk, and never lowered.
///
/// A missing entry means two opposite things, and only the publisher can tell
/// them apart: before the port is open it means "not yet", after it means
/// "somebody ran `hproxy stop`". Watching for the entry to appear first is NOT
/// enough, because a stop can land between the port opening and the watcher's
/// next look, and then the watcher waits for a file that will never come back
/// while the connection serves on. This flag is set once, by the code that
/// wrote the entry, so the watcher is never guessing.
pub type Published = std::sync::Arc<std::sync::atomic::AtomicBool>;

pub fn not_published_yet() -> Published {
    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
}

/// Write our entry and say so. The two belong together: whoever publishes owns
/// the flag the watcher reads.
pub fn publish_and_mark(r: &Running, published: &Published) -> Result<(), String> {
    publish(r)?;
    published.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Sit here until this process's entry is taken away. Hand it to
/// [`hproxy_relay::serve`] as the shutdown signal and `hproxy stop` ends the
/// connection wherever it was started from: a background copy, or the MCP
/// server serving an assistant. A connection that never managed to publish
/// itself keeps serving whoever asked for it, rather than shutting down half a
/// second after it started.
pub async fn wait_until_stopped(pid: u32, published: Published) {
    loop {
        tokio::time::sleep(WATCH_EVERY).await;
        if published.load(std::sync::atomic::Ordering::SeqCst) && asked_to_stop(pid) {
            return;
        }
    }
}

/// Every connection running on this machine, oldest first, with the entries of
/// ones that are no longer answering removed on the way. A process that was
/// killed outright cannot clean up after itself, so whoever looks next does
/// it: an entry is only true while something accepts on its address.
pub fn running_now() -> Vec<Running> {
    let mut found: Vec<Running> = Vec::new();
    let Ok(entries) = std::fs::read_dir(state_dir()) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Running>(&t).ok());
        match parsed {
            Some(r) if answers(&r.listening) => found.push(r),
            // Unreadable, or nothing answers there any more: it is over.
            _ => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    // Oldest first, and the process number settles a tie so two connections
    // started in the same second are never listed in a different order twice.
    found.sort_by_key(|r| (r.started_at, r.pid));
    found
}

/// Does something answer on that address? The honest liveness check for a
/// relay: a process that exists but cannot accept is no use to anyone.
pub fn answers(listening: &str) -> bool {
    listening
        .parse()
        .ok()
        .is_some_and(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(600)).is_ok())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Start this program again, detached: no console window on Windows, its own
/// session on Unix, so closing the terminal leaves it running. Returns what it
/// wrote into the state file once it was listening.
///
/// ⚠️ NOT A PIPE. Reading the child's readiness from its stdout looks obvious
/// and hangs on Windows: a detached child inherits the parent's own inheritable
/// handles, including the pipe whoever started US is reading, so that pipe
/// never reaches its end and the caller waits forever (seen in the test that
/// runs this binary). With every stream closed and the state file as the
/// signal, nothing is held open by anyone.
fn spawn_background(argv: &[String]) -> Result<Running, String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not find this program: {e}"))?;
    let mut cmd = std::process::Command::new(exe);
    // The subcommand again: what arrives here is everything after it, and
    // `hproxy free` has already been normalised to `connect --free`.
    cmd.arg("connect")
        .args(argv)
        .env(CHILD_MARK, "1")
        .stdin(Stdio::null())
        // Nothing it says has anywhere to go behind you.
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: no console window, and
        // Ctrl+C in this terminal does not reach it.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // Its own session: the terminal's hangup never reaches it.
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    keep_our_streams_out_of_the_child();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the background copy: {e}"))?;
    let pid = child.id();
    // The free pool can take a while to find an exit that actually works, so
    // the wait is generous; a child that gives up ends it early.
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(r) = read_entry(pid) {
            return Ok(r);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "the background copy stopped before it was listening ({status}). Run the same command without --background to see why."
            ));
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err("the background copy did not come up within a minute. Run the same command without --background to see why.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Windows only: keep this terminal's own streams out of the background copy.
///
/// Closing the child's three streams is not enough. Windows inheritance is a
/// property of each handle, not of the three stream slots, and a process is
/// started with inheritance on, so the child is handed a copy of every
/// inheritable handle we hold, whatever its own streams are set to. When
/// somebody reads our output through a pipe (`hproxy connect -b … | jq`, or a
/// test running this binary), the writing end of that pipe would live on
/// inside a process meant to run for days, and the reader would wait for an
/// end that never comes. Clearing the flag here is what makes "detached" true.
/// Our own printing is unaffected: only inheritance changes, and we print one
/// line and leave. `hproxy app` (app.rs) starts the desktop app the same way.
#[cfg(windows)]
pub(crate) fn keep_our_streams_out_of_the_child() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};

    for stream in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: two calls that read a handle we already own and clear one
        // flag on it. A process started without that stream gets back null or
        // the invalid handle, and then we leave it alone.
        unsafe {
            let handle = GetStdHandle(stream);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

/// `hproxy connect` and `hproxy free`.
pub async fn command(mut argv: Vec<String>) -> Outcome {
    let background = argv.iter().any(|a| a == "--background" || a == "-b");
    argv.retain(|a| a != "--background" && a != "-b");
    let child = std::env::var(CHILD_MARK).is_ok();

    let args = match hproxy_relay::cli::parse_args(argv.clone().into_iter()) {
        Ok(Some(a)) => a,
        Ok(None) => {
            print!("{}", hproxy_relay::cli::USAGE);
            print!("{EXTRA_USAGE}");
            return Outcome::Ok;
        }
        // The relay's parser says "unknown option `x`"; the answer here adds
        // the closest real one and all of them.
        Err(e) => {
            if let Some(opt) = e.strip_prefix("unknown option `").and_then(|r| r.strip_suffix('`')) {
                return Outcome::Error(crate::hint::unknown_option(
                    "connect",
                    opt,
                    crate::hint::CONNECT_OPTIONS,
                ));
            }
            return Outcome::Error(e);
        }
    };

    if background && !child {
        if let Err(e) = state_dir_is_writable() {
            return Outcome::Error(e);
        }
        // Several connections are fine; two on one address are not. Catching
        // it here says which one is in the way, where a bind error would only
        // say the address is taken.
        if let Ok(wanted) = listen_addr(&args) {
            if let Some(r) = running_now().into_iter().find(|r| r.listening == wanted.to_string()) {
                return Outcome::Error(format!(
                    "a connection is already running on {} ({}). Stop it with `hproxy stop {}`, or start this one on another port with --listen 127.0.0.1:0.",
                    r.listening, r.upstream, r.listening
                ));
            }
        }
        return match spawn_background(&argv) {
            Ok(running) => {
                println!("{}", serde_json::to_string(&running).unwrap_or_default());
                if !args.json {
                    eprintln!("Running in the background. `hproxy status` to see it, `hproxy stop` to end it.");
                }
                Outcome::Ok
            }
            Err(e) => Outcome::Error(e),
        };
    }

    if child {
        return serve_in_background(args).await;
    }
    match hproxy_relay::cli::run(args).await {
        Ok(()) => Outcome::Ok,
        Err(e) => Outcome::Error(e),
    }
}

/// The background copy: serve until the state file says otherwise.
async fn serve_in_background(args: Args) -> Outcome {
    // Never serve a connection we cannot publish: nobody could see or end it.
    if let Err(e) = state_dir_is_writable() {
        return Outcome::Error(e);
    }
    let addr = match listen_addr(&args) {
        Ok(a) => a,
        Err(e) => return Outcome::Error(e),
    };
    let (src, first_exit) = match source_from(&args).await {
        Ok(v) => v,
        Err(e) => return Outcome::Error(e),
    };
    let label = src.label(first_exit.as_deref());
    let kind = src.kind();
    let pid = std::process::id();
    let published = not_published_yet();
    let mark = published.clone();

    let outcome = hproxy_relay::serve(
        addr,
        args.allow_lan,
        false,
        Arc::new(src),
        Arc::new(Stats::default()),
        move |local| {
            let running = Running {
                pid,
                listening: local.to_string(),
                http_proxy: format!("http://{local}"),
                socks5_proxy: format!("socks5h://{local}"),
                upstream: label,
                source: kind.name().to_string(),
                started_at: now_secs(),
            };
            // Writing this file IS the readiness signal the starter waits for.
            let _ = publish_and_mark(&running, &mark);
        },
        // Someone ran `hproxy stop`, which takes our entry away.
        wait_until_stopped(pid, published),
    )
    .await;
    unpublish(pid);
    match outcome {
        Ok(()) => Outcome::Ok,
        Err(e) => Outcome::Error(e),
    }
}

/// `hproxy status`: what is running in the background, if anything.
pub async fn status(argv: &[String]) -> Outcome {
    let json = argv.iter().any(|a| a == "--json");
    let probe = argv.iter().any(|a| a == "--probe");
    if let Some(bad) = argv
        .iter()
        .find(|a| a.starts_with('-') && *a != "--json" && *a != "--probe")
    {
        return Outcome::Error(crate::hint::unknown_option("status", bad, crate::hint::STATUS_OPTIONS));
    }
    let running = running_now();
    if running.is_empty() {
        if json {
            println!("{}", Obj::new().put("connected", false).done());
        } else {
            println!("Nothing is running in the background.");
        }
        return Outcome::NoneWorking;
    }
    for (nth, r) in running.iter().enumerate() {
        // Probing asks the judge THROUGH the connection, so it costs a round
        // trip each and only happens when it was asked for.
        let exit = if probe {
            crate::probe::through(&r.listening).await
        } else {
            None
        };
        if json {
            let mut o = Obj::new()
                .put("connected", true)
                .put("listening", &r.listening)
                .put("http_proxy", &r.http_proxy)
                .put("socks5_proxy", &r.socks5_proxy)
                .put("upstream", &r.upstream)
                .put("source", &r.source)
                .put("uptime_seconds", now_secs().saturating_sub(r.started_at))
                .put("pid", r.pid);
            if let Some(e) = &exit {
                o = o
                    .put("exit_ip", &e.exit_ip)
                    .put("country_code", &e.country_code)
                    .put("latency_ms", e.latency_ms);
            }
            println!("{}", o.done());
        } else {
            if nth > 0 {
                println!();
            }
            println!("{} through {}", r.http_proxy, r.upstream);
            println!("  also SOCKS5: {}", r.socks5_proxy);
            println!("  source     : {}", r.source);
            println!(
                "  running    : {} s, process {}",
                now_secs().saturating_sub(r.started_at),
                r.pid
            );
            if let Some(e) = &exit {
                let place = e.country_code.as_deref().unwrap_or("");
                println!(
                    "  exit       : {} {place} {}",
                    e.exit_ip.as_deref().unwrap_or("unknown"),
                    e.latency_ms.map(|ms| format!("{ms} ms")).unwrap_or_default()
                );
            }
        }
    }
    Outcome::Ok
}

/// Does this connection's address match what the person typed? Either the
/// whole address or just the port, because the port is what they remember.
fn is_the_one(listening: &str, want: &str) -> bool {
    listening == want || listening.rsplit(':').next().is_some_and(|port| port == want)
}

/// `hproxy stop [ADDRESS]`: take the entries away and wait for the ports to
/// close. With nothing named it ends every background connection on this
/// machine, including one an assistant opened over MCP, which is what makes it
/// the switch a person can always reach for.
pub async fn stop(argv: &[String]) -> Outcome {
    let mut which: Option<&str> = None;
    for a in argv {
        if a.starts_with('-') {
            return Outcome::Error(crate::hint::unknown_option("stop", a, crate::hint::STOP_OPTIONS));
        }
        if which.is_some() {
            return Outcome::Error("stop takes one address at most, for example `hproxy stop 8080`".into());
        }
        which = Some(a);
    }
    let running = running_now();
    let targets: Vec<Running> = match which {
        None => running,
        Some(want) => running.into_iter().filter(|r| is_the_one(&r.listening, want)).collect(),
    };
    if targets.is_empty() {
        match which {
            Some(want) => println!("Nothing is running on {want}. `hproxy status` shows what is."),
            None => println!("Nothing was running in the background."),
        }
        return Outcome::Ok;
    }
    for r in &targets {
        unpublish(r.pid);
    }
    // Each one reads its own entry twice a second; give them a few turns.
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut left: Vec<&Running> = targets.iter().collect();
    loop {
        left.retain(|r| {
            if answers(&r.listening) {
                return true;
            }
            println!("Stopped {} ({}).", r.listening, r.upstream);
            false
        });
        if left.is_empty() || std::time::Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if left.is_empty() {
        return Outcome::Ok;
    }
    let stuck: Vec<String> = left
        .iter()
        .map(|r| format!("{} (process {})", r.listening, r.pid))
        .collect();
    Outcome::Error(format!(
        "asked them to stop, but these are still answering: {}",
        stuck.join(", ")
    ))
}

pub const EXTRA_USAGE: &str = "\
  -b, --background      Run behind you: no window, no terminal held. Prints
                        where it listens, then returns. `hproxy status` shows
                        it, `hproxy stop` ends it.
";

#[cfg(test)]
mod tests {
    use super::*;

    /// `HPROXY_STATE_DIR` is one variable for the whole process, and tests run
    /// in parallel threads of it: without this they overwrite each other's.
    static ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// A connection that really answers, so `running_now` keeps its entry.
    fn a_listening_entry(pid: u32) -> (std::net::TcpListener, Running) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let local = listener.local_addr().unwrap();
        let r = Running {
            pid,
            listening: local.to_string(),
            http_proxy: format!("http://{local}"),
            socks5_proxy: format!("socks5h://{local}"),
            upstream: "http://user:********@198.51.100.7:8080".into(),
            source: "fixed".into(),
            started_at: now_secs(),
        };
        (listener, r)
    }

    #[test]
    fn the_state_directory_goes_where_the_environment_says() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("hproxy-state-{}", std::process::id()));
        std::env::set_var("HPROXY_STATE_DIR", &dir);
        let path = entry_path(42);
        assert!(path.starts_with(&dir), "{path:?}");
        assert_eq!(path.file_name().unwrap(), "42.json", "one file per process");
        assert!(state_dir().exists(), "the directory is made on demand");
        std::env::remove_var("HPROXY_STATE_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_is_running_round_trips_without_a_password() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("hproxy-state-rt-{}", std::process::id()));
        std::env::set_var("HPROXY_STATE_DIR", &dir);
        let (_held, r) = a_listening_entry(42);
        publish(&r).unwrap();
        let back = read_entry(42).expect("written state reads back");
        assert_eq!(back.pid, 42);
        assert_eq!(back.listening, r.listening);
        assert!(!back.upstream.contains("hunter"), "{}", back.upstream);
        assert!(!asked_to_stop(42), "its entry is there, so it keeps serving");
        unpublish(42);
        assert!(read_entry(42).is_none(), "a removed entry means it is over");
        assert!(asked_to_stop(42), "and that is how it learns to shut down");
        std::env::remove_var("HPROXY_STATE_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_connections_live_side_by_side_and_a_dead_one_is_forgotten() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("hproxy-state-two-{}", std::process::id()));
        std::env::set_var("HPROXY_STATE_DIR", &dir);
        // One a person started, one an assistant started: both are real.
        let (_mine, mut mine) = a_listening_entry(101);
        let (_theirs, mut theirs) = a_listening_entry(102);
        mine.started_at -= 10;
        theirs.started_at -= 5;
        publish(&mine).unwrap();
        publish(&theirs).unwrap();
        // And one whose process died without tidying up.
        let (dead_socket, dead) = a_listening_entry(103);
        publish(&dead).unwrap();
        drop(dead_socket);

        let seen = running_now();
        assert_eq!(seen.len(), 2, "the closed one is dropped: {seen:?}");
        assert_eq!(seen[0].pid, 101, "oldest first");
        assert_eq!(seen[1].pid, 102);
        assert!(read_entry(103).is_none(), "and its entry is cleaned up for it");

        assert!(is_the_one(&mine.listening, &mine.listening));
        let port = mine.listening.rsplit(':').next().unwrap();
        assert!(is_the_one(&mine.listening, port), "the port alone is enough");
        assert!(!is_the_one(&mine.listening, &theirs.listening));

        std::env::remove_var("HPROXY_STATE_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The race that cost an afternoon: `hproxy stop` can land between the
    /// port opening and the watcher's next look. Watching for the entry to
    /// appear is not enough; the publisher has to say it published.
    /// Synchronous on purpose: the guard above is a plain mutex, and holding
    /// one across an await is how a test ties up its own suite. The runtime
    /// runs inside it instead.
    #[test]
    fn a_watcher_waits_for_the_publisher_not_for_the_file() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("hproxy-state-race-{}", std::process::id()));
        std::env::set_var("HPROXY_STATE_DIR", &dir);
        let pid = 4242;
        unpublish(pid);
        let published = not_published_yet();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();

        // Nothing published yet: a missing entry means "not yet", never "stop".
        // 🪤 The timeout is built INSIDE the block: a tokio timer made outside
        // a running runtime panics for want of a reactor.
        let watch = |flag: Published, ms: u64| {
            rt.block_on(
                async move { tokio::time::timeout(Duration::from_millis(ms), wait_until_stopped(pid, flag)).await },
            )
        };
        assert!(
            watch(published.clone(), 700).is_err(),
            "it shut down before anything was published"
        );

        // Published and taken away again in one go, the way a fast `stop` does
        // it: the watcher has to notice even though it never saw the file.
        let (_held, r) = a_listening_entry(pid);
        publish_and_mark(&r, &published).unwrap();
        unpublish(pid);
        assert!(
            watch(published, 1500).is_ok(),
            "a stop that lands in the gap must still end it"
        );

        std::env::remove_var("HPROXY_STATE_DIR");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_state_directory_that_cannot_be_written_is_said_so_at_once() {
        let _guard = ENV.lock().unwrap_or_else(|e| e.into_inner());
        // A file where the directory should be: `create_dir_all` fails, and so
        // does every write under it, whatever the operating system.
        let blocked = std::env::temp_dir().join(format!("hproxy-state-blocked-{}", std::process::id()));
        std::fs::write(&blocked, b"not a directory").unwrap();
        std::env::set_var("HPROXY_STATE_DIR", &blocked);
        let answer = state_dir_is_writable();
        std::env::remove_var("HPROXY_STATE_DIR");
        let _ = std::fs::remove_file(&blocked);
        let e = answer.expect_err("writing under a file cannot work");
        assert!(e.contains("HPROXY_STATE_DIR"), "it has to say what to do about it: {e}");
    }

    #[test]
    fn a_closed_port_never_counts_as_answering() {
        let port = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        assert!(!answers(&format!("127.0.0.1:{port}")));
        assert!(!answers("not an address"));
    }
}
