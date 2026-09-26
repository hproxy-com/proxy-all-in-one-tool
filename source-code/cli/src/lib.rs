//! `hproxy`: the engine and the relay from a terminal, a script or an AI agent.
//!
//!   hproxy check 1.2.3.4:8080 user:pass@5.6.7.8:1080     check a few lines
//!   hproxy check --file proxies.txt --json > out.jsonl   one JSON row per line
//!   hproxy list --protocol socks5 | hproxy check --first 3 --alive
//!   hproxy connect host:port:user:pass                   a local proxy with no password
//!   hproxy mcp                                           the same, as tools for an AI assistant
//!
//! No arguments library on purpose: every crate in this binary is one we ask
//! a customer to trust, and a flag parser is forty lines.
//!
//! A library, with a two-line binary (main.rs), because the desktop app
//! includes it too: started with a command (`HProxy.exe mcp`), the app runs
//! as this tool and opens no window. That is how an AI assistant starts it
//! from Use with AI, with nothing else to download.

mod app;
mod check;
mod connect;
mod hint;
mod mcp;
mod probe;
mod rows;
mod web;

pub use app::{set_inside_app, COPIED_FROM};

/// How a command ended, and the exit code that says so. The codes follow
/// grep, so scripts and agents can branch without reading any text:
/// 0 = found what was asked for, 1 = ran fine and nothing works,
/// 2 = could not run (bad usage, unreadable input, a service out of reach).
pub enum Outcome {
    Ok,
    NoneWorking,
    Error(String),
}

// The usage, in one section per command, so `hproxy help <command>` and
// `hproxy <command> --help` print just that command, and `hproxy help` all
// of them.
const HEAD: &str = "\
hproxy: check proxies, connect through one, or give both to an AI assistant.

USAGE
  hproxy check [LINES...] [--file <path>|-] [options]
  hproxy connect <PROXY> | --file <list> [--rotate RULE] | --free [--country CC]
  hproxy status [--probe] [--json] | hproxy stop [ADDRESS]
  hproxy list [--country CC] [--protocol P] [--anonymity A] [--limit N] [--json]
  hproxy ip <address>...
  hproxy app [--background]
  hproxy mcp
  hproxy --version

";
const CHECK: &str = "\
CHECK reads proxy lines from the arguments, from --file (- for stdin), or
from piped stdin, in any shape a provider prints (host:port,
host:port:user:pass, user:pass@host:port, socks5://..., CSV, spaces). Every
line is probed on HTTP, HTTPS, SOCKS4 and SOCKS5 at once, from this machine,
and a row is printed the moment it settles.

  --json                 one JSON object per line; empty fields are left out
  --fields <a,b,...>     only these fields (implies --json), e.g.
                         input,alive,protocols,latency_ms,exit_ip,country_code
  --alive                only working proxies: bare lines, or rows with --json
  --first <N>            stop as soon as N working proxies are found
  --geo                  add each exit's country and network (sends the exit
                         addresses, nothing else, to hproxy.com's IP lookup)
  --timeout <SECONDS>    time for each attempt (default 8). A silent proxy is
                         tried once per judge, so it can take twice this:
                         cutting that short reports flaky working proxies dead
  --protocols <LIST>     only some of: http,https,socks4,socks5
  --concurrency <N>      ceiling on proxies in flight (default 64; the
                         governor decides the level below it)
  --udp                  also test whether SOCKS5 proxies relay UDP
  --speed                also measure download throughput
  --retries <N>          extra attempts per proxy (default 0)

EXAMPLES
  hproxy check 198.51.100.7:8080 user:pass@203.0.113.9:1080
  hproxy check --file proxies.txt --json > rows.jsonl
  hproxy list --protocol socks5 | hproxy check --first 5 --alive

";
const CONNECT: &str = "\
CONNECT runs a proxy on this machine that needs no password and forwards to
the real one with the login attached. HTTP and SOCKS5 on the same port.
  -b, --background       run it behind you: no window, no terminal held, and
                         closing the terminal leaves it running. Prints where
                         it listens and returns
  --listen <ADDR>        default 127.0.0.1:8080; port 0 takes any free port
  --json                 print one JSON line with the address when ready
  --file, --rotate       a list, rotated: every, every:N, random, on-failure
  --free, --country      a free exit from the HProxy pool instead
  (hproxy connect --help has the rest)

";
const STATUS: &str = "\
STATUS lists every background connection on this machine, including one an AI
assistant opened over MCP: where it listens, which proxy it uses (never the
password), how long it has run, and with --probe the address the world sees
you as. STOP ends them all, or `hproxy stop 8080` ends the one on that port.

EXAMPLES
  hproxy status --probe
  hproxy stop 8080

";
const LIST: &str = "\
LIST prints live free proxies from hproxy.com, one ip:port per line, ready to
pipe into check. IP prints what hproxy.com knows about addresses, as JSON.

EXAMPLES
  hproxy list --country DE --protocol socks5 --limit 20
  hproxy ip 8.8.8.8 1.1.1.1

";
const MCP: &str = "\
MCP serves all of it to an AI assistant over stdio (Model Context Protocol):
proxy_check, proxy_list, ip_lookup, proxy_connect, proxy_status,
proxy_new_ip, proxy_disconnect, app_open. Claude Code:
  claude mcp add hproxy -- hproxy mcp
Set HPROXY_PROXY=<line> in the server's environment and proxy_connect uses
that proxy without its password ever entering the conversation.

";
const EXIT: &str = "\
EXIT CODES
  0  found what was asked for (check: at least one proxy works)
  1  ran fine, nothing works
  2  could not run: bad usage, unreadable input, a service out of reach
";

fn usage() -> String {
    [HEAD, CHECK, CONNECT, STATUS, LIST, app::USAGE, MCP, EXIT].concat()
}

/// One command's help: its section, its examples, the exit codes.
fn help_for(cmd: &str) -> Option<String> {
    Some(match cmd {
        "check" => [CHECK, EXIT].concat(),
        "connect" | "free" => [hproxy_relay::cli::USAGE, connect::EXTRA_USAGE].concat(),
        "status" | "stop" => [STATUS, EXIT].concat(),
        "list" | "ip" => [LIST, EXIT].concat(),
        "app" => [app::USAGE, EXIT].concat(),
        "mcp" => MCP.to_string(),
        "help" | "version" => usage(),
        _ => return None,
    })
}
/// Does this start of the desktop app's program run as the tool instead of
/// opening a window? `program` is the program's own path, `args` what follows.
///
/// A program named `hproxy` (the copy an assistant runs, src-tauri/src/tool.rs,
/// or the standalone tool) is always the tool: every word goes to the command
/// line, and no word ever opens a window. The app's own program opens its window
/// only when started with nothing or with `--background` (the tray, at log-in or
/// after a quiet update); anything else is the tool, so `HProxy.exe chek` answers
/// "did you mean `hproxy check`?" rather than opening a window. macOS may add a
/// `-psn_...` word when Finder starts an app; that is the window too.
///
/// Found 2026-09-24: deciding by the first word alone let the copy take itself
/// for the app, and a test of `hproxy app` brought a running app's window to the
/// front.
pub fn runs_as_tool(program: &std::path::Path, args: &[String]) -> bool {
    let named_hproxy = program
        .file_stem()
        .and_then(|s| s.to_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("hproxy"));
    named_hproxy || !args.iter().all(|a| a == "--background" || a.starts_with("-psn_"))
}

/// Is this word one of the tool's commands?
pub fn is_command(word: &str) -> bool {
    matches!(
        word,
        "check"
            | "connect"
            | "free"
            | "status"
            | "stop"
            | "list"
            | "ip"
            | "app"
            | "mcp"
            | "help"
            | "-h"
            | "--help"
            | "-?"
            | "version"
            | "-V"
            | "--version"
    )
}

/// Run one command line (without the program's name) and return the exit
/// code: 0 found what was asked for, 1 ran fine and nothing works, 2 could
/// not run.
pub fn run(args: Vec<String>) -> u8 {
    let Some(cmd) = args.first().map(String::as_str) else {
        eprint!("{}", usage());
        return 2;
    };
    let rest = &args[1..];

    match cmd {
        "-V" | "--version" | "version" => {
            println!("hproxy {}", env!("CARGO_PKG_VERSION"));
            return 0;
        }
        "-h" | "--help" | "help" | "-?" => {
            // `hproxy help check`: that command alone.
            if let Some(topic) = rest.first() {
                let topic = topic.trim_start_matches('-');
                return match help_for(topic).or_else(|| hint::suggest_command(topic).and_then(help_for)) {
                    Some(h) => {
                        print!("{h}");
                        0
                    }
                    None => {
                        eprintln!("hproxy: {}", hint::unknown_command(topic));
                        2
                    }
                };
            }
            print!("{}", usage());
            return 0;
        }
        _ => {}
    }
    // `hproxy <command> --help`, anywhere on the line: that command's help,
    // before anything runs. Connect prints its own (it has the most options).
    if cmd != "connect" && cmd != "free" && rest.iter().any(|a| a == "--help" || a == "-h") {
        if let Some(h) = help_for(cmd) {
            print!("{h}");
            return 0;
        }
    }

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("hproxy: could not start the runtime: {e}");
            return 2;
        }
    };
    let outcome = match cmd {
        "check" => rt.block_on(check::command(rest)),
        "list" => rt.block_on(web::list(rest)),
        "ip" => rt.block_on(web::ip(rest)),
        "app" => rt.block_on(app::command(rest)),
        "mcp" => rt.block_on(mcp::serve()),
        "status" => rt.block_on(connect::status(rest)),
        "stop" => rt.block_on(connect::stop(rest)),
        "connect" | "free" => {
            let mut argv: Vec<String> = rest.to_vec();
            if cmd == "free" {
                argv.insert(0, "--free".into());
            }
            rt.block_on(connect::command(argv))
        }
        other => Outcome::Error(hint::unknown_command(other)),
    };
    // Leftover probes of a stopped run must not hold the process open.
    rt.shutdown_timeout(std::time::Duration::from_millis(200));
    match outcome {
        Outcome::Ok => 0,
        Outcome::NoneWorking => 1,
        Outcome::Error(e) => {
            eprintln!("hproxy: {e}");
            2
        }
    }
}

/// When the desktop app is started from a terminal as the tool, Windows gives
/// it no console to print to (it is built as a window app). Borrow the
/// terminal's, but only when nothing was handed over: an assistant's pipes must
/// keep the output, or the MCP answers would land on a screen.
#[cfg(windows)]
pub fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
    // SAFETY: two plain Win32 calls with constant arguments.
    unsafe {
        let out = GetStdHandle(STD_OUTPUT_HANDLE);
        if out.is_null() || out == windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::runs_as_tool;
    use std::path::Path;

    fn words(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    /// The copy an assistant runs never opens a window, whatever it is given:
    /// on 2026-09-24 a test of `hproxy app` brought a running app's window to
    /// the front because the copy took itself for the app.
    #[test]
    fn a_program_named_hproxy_is_always_the_tool() {
        for line in ["", "app", "mcp", "wake", "--background", "chek"] {
            assert!(
                runs_as_tool(Path::new(r"C:\data\tool\hproxy.exe"), &words(line)),
                "{line:?}"
            );
            assert!(
                runs_as_tool(Path::new("/usr/local/bin/hproxy"), &words(line)),
                "{line:?}"
            );
        }
    }

    #[test]
    fn the_app_opens_its_window_only_for_nothing_or_the_tray() {
        // Since 2026-09-24 the product is "HProxy" and its program keeps the file name
        // hproxy-checker (tauri.conf.json mainBinaryName).
        let app = Path::new(r"C:\Users\x\AppData\Local\HProxy\hproxy-checker.exe");
        assert!(!runs_as_tool(app, &words("")));
        assert!(!runs_as_tool(app, &words("--background")));
        assert!(!runs_as_tool(
            Path::new("/Applications/HProxy.app/Contents/MacOS/hproxy-checker"),
            &words("-psn_0_12345")
        ));
        // Any other word is the tool, so a typo gets "did you mean", not a window.
        for line in ["mcp", "check 1.2.3.4:80", "wake", "chek", "--background mcp"] {
            assert!(runs_as_tool(app, &words(line)), "{line:?}");
        }
    }
}
