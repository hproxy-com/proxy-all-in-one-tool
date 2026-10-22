//! Usage counts for the command line (hproxy-api, `usage`): the apps' book and report, kept in
//! the user's folder, asked once and nothing counted or sent before a yes.
//!
//! The question comes once, at the end of a command a person ran at a terminal, and no answer is
//! a no. Never in a pipe or a script, never with `--json` or `--fields`, never for the MCP server
//! and never inside the desktop app (which has its own book and question). After a yes only the
//! runs at a terminal and the MCP server count; a script counts nothing. `hproxy usage` shows the
//! answer and the last report as it went, `hproxy usage on|off` changes it, and HPROXY_NO_USAGE
//! (anything but "0") keeps a run out entirely. What a report holds: PRIVACY.md, "Usage counts".

use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use hproxy_api::usage::{self, About, Answer, Book, Event};
use tokio::runtime::Runtime;

use crate::Outcome;

/// Set to anything but "0" to keep a run out of the counts, question included.
pub const OFF: &str = "HPROXY_NO_USAGE";
/// The longest the end of a command waits for a report to go.
const LAST_WAIT: Duration = Duration::from_secs(2);
const PRIVACY: &str = "https://hproxy.com/privacy";

/// This run's part: its book, and whether a person at a terminal may be asked.
struct Run {
    book: Mutex<Book>,
    path: PathBuf,
    ask: bool,
}

static RUN: OnceLock<Option<Run>> = OnceLock::new();

/// Where the book is kept: the user's own folder for settings.
fn book_path() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    base.map(|dir| dir.join("hproxy").join("usage.json"))
}

fn about() -> About<'static> {
    About {
        app: "cli",
        os: usage::os_word(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

fn today() -> String {
    chrono::Local::now().date_naive().format("%Y-%m-%d").to_string()
}

/// Whether this run takes part, and how: `cmd` and its words (lib.rs, `run`).
fn takes_part(cmd: &str, rest: &[String]) -> Option<bool> {
    let off = std::env::var(OFF).is_ok_and(|v| !v.trim().is_empty() && v.trim() != "0");
    if off || crate::app::inside_app() || crate::newer::copy_of_the_app() || cmd == "usage" || cmd == "app" {
        return None;
    }
    if cmd == "mcp" {
        // Counted after a yes given at a terminal; never asked here, an assistant holds the pipes.
        return Some(false);
    }
    let machine = rest
        .iter()
        .any(|a| a == "--json" || a == "--fields" || a.starts_with("--fields="));
    if machine || !std::io::stderr().is_terminal() {
        return None;
    }
    Some(std::io::stdin().is_terminal())
}

/// At the start of a command: this run's book, and an opening counted (after a yes).
pub fn begin(cmd: &str, rest: &[String]) {
    let run = takes_part(cmd, rest).and_then(|ask| {
        let path = book_path()?;
        Some(Run {
            book: Mutex::new(Book::load(&path)),
            path,
            ask,
        })
    });
    let _ = RUN.set(run);
    count(Event::Opened);
    if cmd == "mcp" {
        feature("mcp");
    }
}

fn run() -> Option<&'static Run> {
    RUN.get().and_then(Option::as_ref)
}

/// Count `event` today; nothing at all, not even a write, before a yes.
pub fn count(event: Event) {
    let Some(r) = run() else { return };
    let mut book = r.book.lock().unwrap_or_else(|e| e.into_inner());
    if book.answer != Answer::Yes {
        return;
    }
    book.count(&today(), &event);
    let _ = book.save(&r.path);
}

/// A feature used, by its fixed name (hproxy-api, `usage::FEATURES`).
pub fn feature(name: &str) {
    count(Event::Feature { name: name.into() });
}

/// At the end of a command: the question once (a person at a terminal), then the finished days
/// that wait, sent within a short wait. The MCP server sends at its start instead (`send_soon`).
pub fn end(rt: &Runtime) {
    let Some(r) = run() else { return };
    let unasked = r.book.lock().map(|b| b.answer == Answer::Unasked).unwrap_or(false);
    if unasked && r.ask {
        let yes = ask();
        {
            let mut book = r.book.lock().unwrap_or_else(|e| e.into_inner());
            book.set_answer(yes);
            let _ = book.save(&r.path);
        }
        if yes {
            count(Event::Opened);
        }
    }
    let _ = rt.block_on(async { tokio::time::timeout(LAST_WAIT, send_due()).await });
}

/// For the MCP server, which runs for hours: the days that wait go now, beside it.
pub fn send_soon(rt: &Runtime) {
    if run().is_some() {
        rt.spawn(send_due());
    }
}

async fn send_due() {
    let Some(r) = run() else { return };
    let today = today();
    let due = r.book.lock().map(|b| b.due(&today, about())).unwrap_or_default();
    if due.is_empty() {
        return;
    }
    let client = hproxy_api::http_client("hproxy-cli", Duration::from_secs(10));
    for (day, report) in due {
        if usage::send(&client, usage::DEFAULT_USAGE_URL, &report).await.is_err() {
            return;
        }
        let mut book = r.book.lock().unwrap_or_else(|e| e.into_inner());
        // A "no" while it went (another terminal): the book stays as that one left it.
        if book.answer == Answer::Yes && book.copy.as_deref() == report.get("copy").and_then(|c| c.as_str()) {
            book.mark_sent(&day, report, &today);
            let _ = book.save(&r.path);
        }
    }
}

/// The question, on stderr, one line of answer from stdin. Anything but yes is no.
fn ask() -> bool {
    let mut err = std::io::stderr();
    let _ = write!(
        err,
        "\nHelp make hproxy better? Once a day it can send us a few counts about the day before:\n\
         commands run, checks and how long the lists were, which features were used. Never a\n\
         proxy, a login, an address you check or anything you type. More: {PRIVACY}\n\
         Change it any time with `hproxy usage off` or `hproxy usage on`.\n\
         Send counts once a day? [y/N] "
    );
    let _ = err.flush();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return false;
    }
    matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// `hproxy usage [on|off]`: the answer and the last report, or a new answer.
pub fn command(rest: &[String]) -> Outcome {
    let Some(path) = book_path() else {
        return Outcome::Error("there is no folder to keep the answer in (no LOCALAPPDATA or HOME)".into());
    };
    let mut book = Book::load(&path);
    match rest.first().map(String::as_str) {
        None => {}
        Some("on") | Some("off") => {
            book.set_answer(rest[0] == "on");
            if let Err(e) = book.save(&path) {
                return Outcome::Error(format!("the answer could not be kept: {e}"));
            }
        }
        Some(other) => {
            return Outcome::Error(format!(
                "usage takes on or off, not {other}: `hproxy usage on`, `hproxy usage off`"
            ));
        }
    }
    let state = match book.answer {
        Answer::Yes => "on: once a day, a few counts about the day before",
        Answer::No => "off: nothing is counted or sent",
        Answer::Unasked => "not asked yet: nothing is counted or sent",
    };
    println!("Usage counts {state}.");
    println!("Never a proxy, a login, an address you check or anything you type. More: {PRIVACY}");
    match &book.last {
        Some(last) => println!(
            "The last report, as it was sent:\n{}",
            serde_json::to_string_pretty(last).unwrap_or_default()
        ),
        None if book.answer == Answer::Yes => {
            println!("Nothing sent yet. The first report goes the day after you said yes.")
        }
        None => {}
    }
    Outcome::Ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn scripts_the_app_and_the_usage_command_never_take_part() {
        // A test's stderr is no terminal: every command a person types reads as a script here.
        assert_eq!(takes_part("check", &words("--file x.txt")), None);
        assert_eq!(takes_part("check", &words("--json")), None);
        assert_eq!(takes_part("usage", &[]), None);
        assert_eq!(takes_part("app", &[]), None);
        // The MCP server counts after a yes and is never asked.
        assert_eq!(takes_part("mcp", &[]), Some(false));
    }
}
