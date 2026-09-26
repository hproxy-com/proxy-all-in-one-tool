//! Every mistake answered with the way out, for a person and for an AI agent.
//!
//! The goal: even the simplest AI agent knows at once how to go on. A wrong
//! command is answered with "not a command", the closest real one, and where
//! the full list is.
//!
//! So a wrong command names the closest real one, or the command the word
//! usually means (`disconnect` is `stop`, `vpn` is `free`, `test` is `check`),
//! then lists every command in one line each, and says where the options are.
//! A wrong option names the closest real option and lists them all. The MCP
//! server answers a wrong tool or a wrong argument the same way (mcp.rs).

/// Every command, what it does in one line, and the words people and agents
/// type when they mean it.
pub const COMMANDS: &[(&str, &str, &[&str])] = &[
    (
        "check",
        "test proxies: works or not, protocols, anonymity, latency, exit",
        &["test", "verify", "validate", "scan", "probe", "try"],
    ),
    (
        "connect",
        "a local proxy with no password that forwards through yours",
        &["start", "run", "use", "tunnel", "relay", "on", "up"],
    ),
    (
        "free",
        "the same through a free exit from the HProxy pool",
        &["vpn", "free-proxy", "freeproxy", "anonymous"],
    ),
    (
        "status",
        "what runs in the background here, and through which proxy",
        &["ps", "info", "state", "running", "show", "ls"],
    ),
    (
        "stop",
        "end background connections (all, or one by port)",
        &["disconnect", "kill", "quit", "exit", "end", "down", "off", "close"],
    ),
    (
        "list",
        "live free proxies from hproxy.com, one ip:port per line",
        &["proxies", "free-list", "get", "fetch", "pool"],
    ),
    (
        "ip",
        "where addresses are: country, city, network",
        &["lookup", "geo", "whois", "locate", "where", "location"],
    ),
    (
        "app",
        "open the HProxy desktop app, or wake it in the tray (--background)",
        &["open", "gui", "window", "wake", "desktop", "launch"],
    ),
    (
        "mcp",
        "serve all of it to an AI assistant over stdio",
        &["server", "ai", "agent", "assistant"],
    ),
    (
        "help",
        "this list; `hproxy help <command>` for one command",
        &["usage", "commands", "man", "?"],
    ),
    ("version", "the version", &[]),
];

/// Edit distance between two short words (insertions, deletions, changes,
/// and a swap of neighbours counted as one: `chcek` is one step from `check`).
pub fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=n {
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[n][m]
}

/// The candidate a word is a typo of: at most two edits away, and fewer
/// edits than half its length, so `ip` never passes for `ps`.
pub fn closest<'a>(word: &str, candidates: impl IntoIterator<Item = &'a str>) -> Option<&'a str> {
    let word = word.to_ascii_lowercase();
    candidates
        .into_iter()
        .map(|c| (distance(&word, &c.to_ascii_lowercase()), c))
        .filter(|(d, c)| *d > 0 && *d <= 2 && *d * 2 < c.len().max(word.len()))
        .min_by_key(|(d, _)| *d)
        .map(|(_, c)| c)
}

/// The command a word probably meant: one of its usual words, a typo of a
/// command, or a typo of one of the usual words.
pub fn suggest_command(word: &str) -> Option<&'static str> {
    let w = word.trim_start_matches('-').to_ascii_lowercase();
    for (name, _, words) in COMMANDS {
        if *name == w || words.contains(&w.as_str()) {
            return Some(name);
        }
    }
    if let Some(c) = closest(&w, COMMANDS.iter().map(|c| c.0)) {
        return Some(COMMANDS.iter().find(|x| x.0 == c).map(|x| x.0).unwrap_or(c));
    }
    let words = COMMANDS
        .iter()
        .flat_map(|(name, _, ws)| ws.iter().map(move |w| (*w, *name)));
    let (list, owner): (Vec<&str>, Vec<&str>) = words.unzip();
    closest(&w, list.iter().copied()).and_then(|hit| list.iter().position(|x| *x == hit).map(|i| owner[i]))
}

/// Every command in one line each.
pub fn command_list() -> String {
    let mut s = String::new();
    for (name, what, _) in COMMANDS {
        s.push_str(&format!("  {name:<8} {what}\n"));
    }
    s
}

/// The answer to an unknown command.
pub fn unknown_command(word: &str) -> String {
    let mut s = format!("`{word}` is not a command.");
    if let Some(c) = suggest_command(word) {
        s.push_str(&format!(" Did you mean `hproxy {c}`?"));
    }
    s.push_str("\n\nThe commands:\n");
    s.push_str(&command_list());
    s.push_str("\n`hproxy help <command>` shows a command's options with examples.");
    s
}

/// The answer to an unknown option of `cmd`, whose real options are `known`.
pub fn unknown_option(cmd: &str, option: &str, known: &[&str]) -> String {
    let mut s = format!("`{option}` is not an option of `hproxy {cmd}`.");
    let bare = option.trim_start_matches('-');
    let long: Vec<&str> = known.iter().copied().filter(|k| k.starts_with("--")).collect();
    if let Some(hit) = closest(bare, long.iter().map(|k| k.trim_start_matches('-'))) {
        s.push_str(&format!(" Did you mean `--{hit}`?"));
    } else if bare != cmd && COMMANDS.iter().any(|x| x.0 == bare) {
        s.push_str(&format!(" `{bare}` is a command of its own: `hproxy {bare}`."));
    }
    if long.is_empty() {
        s.push_str(&format!(" `hproxy {cmd}` takes no options."));
    } else {
        s.push_str(&format!(" Its options: {}.", long.join(", ")));
    }
    s.push_str(&format!(" `hproxy help {cmd}` explains each."));
    s
}

/// The real options of each command, for the answers above.
pub const CHECK_OPTIONS: &[&str] = &[
    "--file",
    "--json",
    "--fields",
    "--alive",
    "--first",
    "--geo",
    "--timeout",
    "--protocols",
    "--concurrency",
    "--udp",
    "--speed",
    "--retries",
    "--help",
];
pub const CONNECT_OPTIONS: &[&str] = &[
    "--file",
    "--rotate",
    "--free",
    "--country",
    "--socks5",
    "--listen",
    "--background",
    "--json",
    "--allow-lan",
    "--verbose",
    "--help",
];
pub const STATUS_OPTIONS: &[&str] = &["--probe", "--json", "--help"];
pub const STOP_OPTIONS: &[&str] = &["--help"];
pub const LIST_OPTIONS: &[&str] = &["--country", "--protocol", "--anonymity", "--limit", "--json", "--help"];
pub const IP_OPTIONS: &[&str] = &["--help"];
pub const APP_OPTIONS: &[&str] = &["--background", "--help"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typo_finds_its_command() {
        assert_eq!(suggest_command("chek"), Some("check"));
        assert_eq!(suggest_command("chcek"), Some("check"));
        assert_eq!(suggest_command("conect"), Some("connect"));
        assert_eq!(suggest_command("stauts"), Some("status"));
        assert_eq!(suggest_command("CHECK"), Some("check"));
    }

    #[test]
    fn the_usual_words_find_their_command() {
        assert_eq!(suggest_command("disconnect"), Some("stop"));
        assert_eq!(suggest_command("disconect"), Some("stop"));
        assert_eq!(suggest_command("vpn"), Some("free"));
        assert_eq!(suggest_command("test"), Some("check"));
        assert_eq!(suggest_command("lookup"), Some("ip"));
        assert_eq!(suggest_command("--usage"), Some("help"));
        // Waking the desktop app: the assistant's wake-up command.
        assert_eq!(suggest_command("open"), Some("app"));
        assert_eq!(suggest_command("wake"), Some("app"));
    }

    /// Every command the program takes is in the table the hints come from,
    /// so no command can be missing from "did you mean" or from the list.
    #[test]
    fn every_command_has_its_line() {
        for (name, _, _) in COMMANDS {
            assert!(
                crate::is_command(name),
                "{name} is in the table but the program does not take it"
            );
        }
        for word in [
            "check", "connect", "free", "status", "stop", "list", "ip", "app", "mcp", "help", "version",
        ] {
            assert!(
                COMMANDS.iter().any(|(n, _, _)| *n == word),
                "{word} has no line in the table"
            );
        }
    }

    #[test]
    fn nonsense_is_not_forced_onto_a_command() {
        assert_eq!(suggest_command("banana"), None);
        assert_eq!(suggest_command("x"), None);
    }

    #[test]
    fn an_unknown_command_lists_every_command_and_says_where_help_is() {
        let t = unknown_command("chek");
        assert!(t.contains("Did you mean `hproxy check`?"), "{t}");
        for (name, _, _) in COMMANDS {
            assert!(t.contains(name), "{name} missing from:\n{t}");
        }
        assert!(t.contains("hproxy help <command>"));
    }

    #[test]
    fn an_unknown_option_names_the_closest_and_all_of_them() {
        let t = unknown_option("check", "--jsn", CHECK_OPTIONS);
        assert!(t.contains("Did you mean `--json`?"), "{t}");
        assert!(t.contains("--timeout"), "{t}");
        assert!(t.contains("hproxy help check"), "{t}");
        let t = unknown_option("list", "--contry", LIST_OPTIONS);
        assert!(t.contains("Did you mean `--country`?"), "{t}");
        let t = unknown_option("stop", "--all", STOP_OPTIONS);
        assert!(t.contains("Its options: --help"), "{t}");
    }

    #[test]
    fn distance_counts_a_swap_as_one() {
        assert_eq!(distance("check", "chcek"), 1);
        assert_eq!(distance("status", "stop"), 4);
        assert_eq!(distance("", "ip"), 2);
    }
}
