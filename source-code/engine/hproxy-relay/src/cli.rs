//! The relay's command-line shape, shared by its own binary and by
//! `hproxy connect` / `hproxy free`, so the two never drift.

use std::net::SocketAddr;

use crate::pool;
use crate::source::{List, Rotation, Source};
use crate::upstream::{self, Scheme, Upstream};
use crate::DEFAULT_LISTEN;

pub const USAGE: &str = "\
HProxy Relay: use a proxy from software that cannot log in to one.

USAGE
  hproxy-relay <PROXY> [options]                  your own proxy
  hproxy-relay --file <list.txt> [--rotate RULE]  your own list, rotating
  hproxy-relay --free [--country US]              a free exit from the HProxy pool

PROXY accepts any shape your provider prints:
  host:port:username:password
  username:password@host:port
  http://username:password@host:port
  socks5://username:password@host:port
  host:port                            (open proxy, or IP authorisation)

OPTIONS
      --file <PATH>     A list of proxies, one per line, used in turn.
      --rotate <RULE>   With --file: every (a new proxy per connection, the
                        default), every:N (a new one every N connections),
                        random, or on-failure (stay until it stops answering).
  -f, --free            Use the free HProxy proxy pool instead of your own proxy.
      --country <CC>    With --free: a two-letter country, e.g. US, DE, FR.
      --socks5          With --free: ask the pool for a SOCKS5 exit.
  -l, --listen <ADDR>   Where to listen. Default 127.0.0.1:8080. Port 0 takes
                        any free port and prints which one.
      --allow-lan       Permit binding a non-loopback address. Read the warning.
      --json            Print one JSON line when ready (for scripts and AI
                        agents); everything meant for people goes to stderr.
  -v, --verbose         Print one line per request (to stderr).
  -h, --help            This text.

THEN point your software's proxy setting at the listen address, with no
username or password. The same port speaks HTTP and SOCKS5.
";

#[derive(Debug)]
pub struct Args {
    pub proxy: Option<String>,
    pub file: Option<String>,
    pub rotate: Rotation,
    pub free: bool,
    pub country: Option<String>,
    pub socks5: bool,
    pub listen: String,
    pub allow_lan: bool,
    pub json: bool,
    pub verbose: bool,
}

/// `every`, `every:N`, `random`, `on-failure`.
pub fn parse_rotation(s: &str) -> Result<Rotation, String> {
    let s = s.trim().to_ascii_lowercase();
    match s.as_str() {
        "every" | "every-connection" | "each" => Ok(Rotation::EveryConnection),
        "random" => Ok(Rotation::Random),
        "on-failure" | "onfailure" | "sticky" => Ok(Rotation::OnFailure),
        other => match other.strip_prefix("every:").map(str::parse::<u32>) {
            Some(Ok(n)) if n >= 1 => Ok(Rotation::Every(n)),
            _ => Err(format!(
                "`{s}` is not a rotation rule. Use every, every:N (N at least 1), random or on-failure."
            )),
        },
    }
}

/// Read a list file into upstreams. Blank lines and `#` comments are skipped
/// quietly; any other line that is not a proxy is counted and the first one
/// quoted, so a typo is visible without one bad line sinking the list.
pub fn read_list(path: &str) -> Result<(Vec<Upstream>, Option<String>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?;
    let mut members = Vec::new();
    let mut skipped = 0usize;
    let mut first_bad: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        match upstream::parse(line) {
            Ok(u) => members.push(u),
            Err(e) => {
                skipped += 1;
                first_bad.get_or_insert_with(|| format!("`{line}`: {e}"));
            }
        }
    }
    if members.is_empty() {
        return Err(match first_bad {
            Some(bad) => format!("{path} has no usable proxy. The first line that failed was {bad}"),
            None => format!("{path} is empty."),
        });
    }
    let note = first_bad.map(|bad| format!("skipped {skipped} line(s) that are not proxies, the first was {bad}"));
    Ok((members, note))
}

/// `Ok(None)` means help was asked for.
pub fn parse_args(argv: impl Iterator<Item = String>) -> Result<Option<Args>, String> {
    let mut proxy: Option<String> = None;
    let mut file: Option<String> = None;
    let mut rotate: Option<Rotation> = None;
    let mut country: Option<String> = None;
    let mut listen = DEFAULT_LISTEN.to_string();
    let (mut free, mut socks5, mut allow_lan, mut json, mut verbose) = (false, false, false, false, false);

    let mut it = argv;
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => return Ok(None),
            "-v" | "--verbose" => verbose = true,
            "--allow-lan" => allow_lan = true,
            "--json" => json = true,
            "-f" | "--free" => free = true,
            "--socks5" => socks5 = true,
            "--file" => file = Some(it.next().ok_or("--file needs a path to a list of proxies")?),
            "--rotate" => {
                rotate = Some(parse_rotation(
                    &it.next()
                        .ok_or("--rotate needs a rule: every, every:N, random or on-failure")?,
                )?)
            }
            "--country" => country = Some(it.next().ok_or("--country needs a two-letter code, e.g. US")?),
            "-l" | "--listen" => listen = it.next().ok_or("--listen needs an address, e.g. 127.0.0.1:8080")?,
            "-p" | "--proxy" => proxy = Some(it.next().ok_or("--proxy needs a proxy line")?),
            other if other.starts_with('-') => return Err(format!("unknown option `{other}`")),
            // Bare argument: the proxy line, so the common case needs no flags.
            other => proxy = Some(other.to_string()),
        }
    }

    let sources = [proxy.is_some(), file.is_some(), free].iter().filter(|x| **x).count();
    if sources > 1 {
        return Err("a proxy line, --file and --free each say where traffic goes. Pick one.".into());
    }
    if sources == 0 {
        return Err(
            "no proxy given. Pass your own line (host:port:user:pass), a list (--file proxies.txt), \
             or use the free pool (--free)."
                .into(),
        );
    }
    if country.is_some() && !free {
        return Err("--country only applies to --free. Your own proxy already has a location.".into());
    }
    if rotate.is_some() && file.is_none() {
        return Err("--rotate only applies to --file. One proxy has nothing to rotate to.".into());
    }
    Ok(Some(Args {
        proxy,
        file,
        rotate: rotate.unwrap_or(Rotation::EveryConnection),
        free,
        country,
        socks5,
        listen,
        allow_lan,
        json,
        verbose,
    }))
}

/// The listen address, checked before anything touches the network: asking the
/// pool for an exit and then discovering the port is taken wastes a pick.
pub fn listen_addr(args: &Args) -> Result<SocketAddr, String> {
    let addr: SocketAddr = args
        .listen
        .parse()
        .map_err(|_| format!("`{}` is not an address. Try 127.0.0.1:8080.", args.listen))?;
    crate::check_bind(&addr, args.allow_lan)?;
    Ok(addr)
}

/// Where this run's traffic goes, and how the first exit is described when the
/// pool picked one. Shared by `run` below and by `hproxy connect`, which serves
/// it with its own readiness and shutdown (background mode).
pub async fn source_from(args: &Args) -> Result<(Source, Option<String>), String> {
    if args.free {
        let scheme = if args.socks5 { Scheme::Socks5 } else { Scheme::Http };
        let p = pool::Pool::new(args.country.clone(), scheme)?;
        eprintln!("  finding a free exit that actually works...");
        let (s, label) = Source::from_pool(p).await?;
        return Ok((s, Some(label)));
    }
    if let Some(path) = &args.file {
        let (members, note) = read_list(path)?;
        if let Some(note) = note {
            eprintln!("  {note}");
        }
        return Ok((Source::List(List::new(members, args.rotate)?), None));
    }
    Ok((
        Source::Fixed(upstream::parse(args.proxy.as_deref().unwrap_or(""))?),
        None,
    ))
}

/// Run until Ctrl+C, printing the banner a person needs to configure their
/// software, or with `--json` one line a program can read.
pub async fn run(args: Args) -> Result<(), String> {
    let addr = listen_addr(&args)?;
    let (src, first_exit) = source_from(&args).await?;
    let label = src.label(first_exit.as_deref());
    let kind = src.kind();
    let allow_lan = args.allow_lan;
    let json = args.json;

    crate::serve(
        addr,
        args.allow_lan,
        args.verbose,
        std::sync::Arc::new(src),
        std::sync::Arc::new(crate::Stats::default()),
        move |local| {
            if json {
                // One line, then silence on stdout: a program waiting for the
                // relay reads this and knows where to point its traffic.
                let ready = serde_json::json!({
                    "listening": local.to_string(),
                    "http_proxy": format!("http://{local}"),
                    "socks5_proxy": format!("socks5h://{local}"),
                    "source": kind,
                    "upstream": label,
                });
                println!("{ready}");
                return;
            }
            eprintln!("HProxy Relay");
            eprintln!("  upstream : {label}");
            eprintln!("  listening: {local} (HTTP and SOCKS5)");
            eprintln!();
            eprintln!("In your software, set the proxy to:");
            eprintln!("  Type     : HTTP, or SOCKS5 if that is all it offers");
            eprintln!("  Address  : {}", local.ip());
            eprintln!("  Port     : {}", local.port());
            eprintln!("  Username : (leave empty)");
            eprintln!("  Password : (leave empty)");
            if !allow_lan {
                eprintln!();
                eprintln!("Only this computer can use it. Ctrl+C to stop.");
            }
        },
        async move {
            let _ = tokio::signal::ctrl_c().await;
            if !json {
                eprintln!("\nStopped. Remember to turn the proxy setting back off in your software.");
            }
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> impl Iterator<Item = String> {
        s.split_whitespace().map(String::from).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn a_bare_line_is_the_proxy_and_flags_are_read() {
        let a = parse_args(argv("1.2.3.4:8080:u:p --listen 127.0.0.1:9000 -v"))
            .unwrap()
            .unwrap();
        assert_eq!(a.proxy.as_deref(), Some("1.2.3.4:8080:u:p"));
        assert_eq!(a.listen, "127.0.0.1:9000");
        assert!(a.verbose && !a.free && !a.allow_lan);
    }

    #[test]
    fn free_mode_and_its_country() {
        let a = parse_args(argv("--free --country de --socks5")).unwrap().unwrap();
        assert!(a.free && a.socks5);
        assert_eq!(a.country.as_deref(), Some("de"));
    }

    #[test]
    fn contradictions_and_omissions_explain_themselves() {
        assert!(parse_args(argv("--free 1.2.3.4:80")).unwrap_err().contains("Pick one"));
        assert!(parse_args(argv("")).unwrap_err().contains("no proxy given"));
        assert!(parse_args(argv("1.2.3.4:80 --country US"))
            .unwrap_err()
            .contains("--country only"));
        assert!(parse_args(argv("--bogus")).unwrap_err().contains("unknown option"));
        assert!(parse_args(argv("--help")).unwrap().is_none());
        assert!(parse_args(argv("--file a.txt 1.2.3.4:80"))
            .unwrap_err()
            .contains("Pick one"));
        assert!(parse_args(argv("1.2.3.4:80 --rotate random"))
            .unwrap_err()
            .contains("--rotate only"));
    }

    #[test]
    fn a_list_with_a_rotation_rule_and_json() {
        let a = parse_args(argv("--file list.txt --rotate every:25 --json --listen 127.0.0.1:0"))
            .unwrap()
            .unwrap();
        assert_eq!(a.file.as_deref(), Some("list.txt"));
        assert_eq!(a.rotate, Rotation::Every(25));
        assert!(a.json);
        let a = parse_args(argv("--file list.txt")).unwrap().unwrap();
        assert_eq!(
            a.rotate,
            Rotation::EveryConnection,
            "a list rotates per connection unless told"
        );
    }

    #[test]
    fn rotation_rules_read_the_way_people_write_them() {
        assert_eq!(parse_rotation("every").unwrap(), Rotation::EveryConnection);
        assert_eq!(parse_rotation("EVERY:3").unwrap(), Rotation::Every(3));
        assert_eq!(parse_rotation("random").unwrap(), Rotation::Random);
        assert_eq!(parse_rotation("on-failure").unwrap(), Rotation::OnFailure);
        assert!(parse_rotation("every:0").is_err());
        assert!(parse_rotation("sometimes").unwrap_err().contains("every:N"));
    }

    #[test]
    fn a_list_file_skips_comments_and_names_the_first_bad_line() {
        let dir = std::env::temp_dir().join(format!("hproxy-relay-list-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("list.txt");
        std::fs::write(
            &path,
            "\u{feff}# my proxies\n198.51.100.7:8080:u:p\n\nnot a proxy\nsocks5://198.51.100.8:1080\n",
        )
        .unwrap();
        let (members, note) = read_list(path.to_str().unwrap()).unwrap();
        assert_eq!(members.len(), 2);
        assert_eq!(members[1].scheme, Scheme::Socks5);
        let note = note.expect("the bad line is reported");
        assert!(note.contains("skipped 1") && note.contains("not a proxy"), "{note}");

        std::fs::write(&path, "# nothing\n\n").unwrap();
        assert!(read_list(path.to_str().unwrap()).unwrap_err().contains("empty"));
        std::fs::write(&path, "garbage\n").unwrap();
        assert!(read_list(path.to_str().unwrap())
            .unwrap_err()
            .contains("no usable proxy"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
