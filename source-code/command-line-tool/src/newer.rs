//! One line on stderr when a newer `hproxy` is out.
//!
//! The standalone tool (the file from GitHub's releases page) updates nothing by itself, so once
//! a day, after a command a person ran at a terminal, it asks hproxy.com's version list about the
//! `cli` channel and, when there is something newer, says so in one line:
//!
//!   hproxy 0.2.5 is out (this is 0.2.4): https://github.com/hproxy-com/proxy-all-in-one-tool/releases/latest
//!
//! It never gets in a script's way: nothing when stderr is not a terminal, nothing with `--json`
//! or `--fields`, nothing for the MCP server, nothing when `HPROXY_NO_UPDATE_CHECK` is set, and a
//! command never waits for the answer (a look that is not back when the command is done is
//! simply tried again next time). The copies inside the desktop app are left out: the app
//! updates itself and refreshes the AI assistant's copy at every start (src-tauri/src/tool.rs).
//!
//! What the request tells hproxy.com: `hproxy/0.2.4 (cli)`, nothing else (PRIVACY.md).

use std::io::IsTerminal;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hproxy_api::versions::{check, Verdict};
use tokio::runtime::Runtime;
use tokio::task::JoinHandle;

/// Set to anything but "0" to turn the look off.
pub const OFF: &str = "HPROXY_NO_UPDATE_CHECK";
/// Once a day at most.
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// How long the end of a command waits for a look that is not back yet.
const LAST_WAIT: Duration = Duration::from_millis(300);
const RELEASES: &str = "https://github.com/hproxy-com/proxy-all-in-one-tool/releases/latest";
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Start the look beside a command, when this run may look at all.
pub fn start(rt: &Runtime, cmd: &str, rest: &[String]) -> Option<JoinHandle<Result<Option<Verdict>, String>>> {
    let off = std::env::var(OFF).is_ok_and(|v| !v.trim().is_empty() && v.trim() != "0");
    if off || !for_a_person(cmd, rest) || crate::app::inside_app() || copy_of_the_app() {
        return None;
    }
    if !std::io::stderr().is_terminal() {
        return None;
    }
    let last = stamp().and_then(|path| std::fs::read_to_string(path).ok());
    if !due(last.as_deref(), now_secs()) {
        return None;
    }
    Some(rt.spawn(check("hproxy", VERSION, "cli")))
}

/// At the end of the command: the line, if the answer is back and says so.
pub fn finish(rt: &Runtime, look: JoinHandle<Result<Option<Verdict>, String>>) {
    let answer = rt.block_on(async { tokio::time::timeout(LAST_WAIT, look).await });
    let Ok(Ok(Ok(verdict))) = answer else {
        // Not back in time, or the list could not be read: next time.
        return;
    };
    if let Some(path) = stamp() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, now_secs().to_string());
    }
    if let Some(line) = verdict.as_ref().and_then(line) {
        eprintln!("{line}");
    }
}

/// A command a person reads, not one a program parses.
fn for_a_person(cmd: &str, rest: &[String]) -> bool {
    let machine = rest
        .iter()
        .any(|a| a == "--json" || a == "--fields" || a.starts_with("--fields="));
    !machine && cmd != "mcp" && cmd != "app"
}

/// The copy of this program the desktop app hands an AI assistant carries a note beside it
/// (app.rs, COPIED_FROM); the app keeps that copy current itself.
fn copy_of_the_app() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|me| me.parent().map(|dir| dir.join(crate::app::COPIED_FROM)))
        .is_some_and(|note| note.is_file())
}

/// Whether a day has passed since the last look (`last`: the stamp file's text, seconds).
fn due(last: Option<&str>, now: u64) -> bool {
    match last.and_then(|text| text.trim().parse::<u64>().ok()) {
        Some(then) => now.saturating_sub(then) >= EVERY.as_secs() || then > now,
        None => true,
    }
}

/// The line for a verdict, or None when there is nothing to say.
fn line(verdict: &Verdict) -> Option<String> {
    let newer = verdict.newer.as_deref()?;
    Some(if verdict.required {
        format!(
            "hproxy {} no longer works as it should; get {newer}: {RELEASES}",
            verdict.current
        )
    } else {
        format!("hproxy {newer} is out (this is {}): {RELEASES}", verdict.current)
    })
}

/// Where the last look's time is kept: the user's cache folder.
fn stamp() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")));
    base.map(|dir| dir.join("hproxy").join("update-check"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn only_commands_a_person_reads_look() {
        assert!(for_a_person("check", &words("--file proxies.txt")));
        assert!(for_a_person("list", &words("--country DE")));
        assert!(!for_a_person("check", &words("--file proxies.txt --json")));
        assert!(!for_a_person("check", &words("--fields exit,latency")));
        assert!(!for_a_person("check", &words("--fields=exit")));
        assert!(
            !for_a_person("mcp", &[]),
            "the MCP server's streams belong to the assistant"
        );
        assert!(!for_a_person("app", &[]));
    }

    #[test]
    fn once_a_day() {
        let now = 1_790_000_000;
        assert!(due(None, now), "never looked");
        assert!(due(Some("garbage"), now));
        assert!(!due(Some(&(now - 3_600).to_string()), now));
        assert!(due(Some(&(now - 25 * 3_600).to_string()), now));
        assert!(
            due(Some(&(now + 3_600).to_string()), now),
            "a clock set back does not stop it for good"
        );
    }

    #[test]
    fn the_line_names_both_versions_and_where_to_get_the_new_one() {
        let newer = Verdict {
            current: "0.2.4".into(),
            newer: Some("0.2.5".into()),
            required: false,
            notes: None,
            date: None,
        };
        assert_eq!(
            line(&newer).as_deref(),
            Some("hproxy 0.2.5 is out (this is 0.2.4): https://github.com/hproxy-com/proxy-all-in-one-tool/releases/latest")
        );
        let required = Verdict {
            required: true,
            ..newer.clone()
        };
        assert!(line(&required)
            .unwrap()
            .starts_with("hproxy 0.2.4 no longer works as it should; get 0.2.5"));
        let current = Verdict { newer: None, ..newer };
        assert_eq!(line(&current), None);
    }
}
