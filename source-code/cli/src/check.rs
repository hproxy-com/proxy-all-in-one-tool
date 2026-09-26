//! `hproxy check`, and the run loop the MCP server shares with it.

use std::io::{BufRead, IsTerminal, Write};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use hproxy_api::geo::{located_ip, Geo};
use hproxy_probe::{
    Batch, BatchOptions, CheckOptions, CheckResult, Checker, Done, ProtocolSet, Status, DEFAULT_CONCURRENCY,
};

use crate::rows;
use crate::Outcome;

/// How long a working row waits for its exit's location before it is printed
/// anyway, and how many may wait at once. Working proxies arrive in bursts;
/// one lookup per burst instead of one per row.
const GEO_HOLD: Duration = Duration::from_millis(400);
const GEO_BATCH: usize = 50;

/// What the caller wants after each row.
pub enum Flow {
    Continue,
    Stop,
}

/// Run a batch and hand every row to `emit` as it settles.
///
/// With `first`, the run stops once that many working proxies were handed
/// over. With `geo`, a working row is located by its exit before it is handed
/// over; rows wait at most `GEO_HOLD` for that, in batches, and a dead lookup
/// service is asked once, not once per row. `emit` returning `Flow::Stop`
/// (the reader went away) ends the run as well. Returns the engine's summary
/// and how many working rows were handed over.
pub async fn run<F>(batch: Batch, first: Option<usize>, geo: Option<Arc<Geo>>, mut emit: F) -> (Done, usize)
where
    F: FnMut(CheckResult) -> Flow,
{
    let cancel = batch.cancel_handle();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CheckResult>();
    let task = tokio::spawn(batch.run(move |r| {
        let _ = tx.send(r);
    }));

    let mut working = 0usize;
    let mut stopped = false;
    let mut held: Vec<CheckResult> = Vec::new();
    let mut held_since: Option<Instant> = None;
    let mut geo_down = false;

    // Hands one row to the caller, counting and stopping as asked.
    let mut hand_over = |r: CheckResult, stopped: &mut bool| {
        if *stopped {
            return;
        }
        let alive = r.alive;
        match emit(r) {
            Flow::Stop => *stopped = true,
            Flow::Continue => {
                if alive {
                    working += 1;
                    if first.is_some_and(|n| working >= n) {
                        *stopped = true;
                    }
                }
            }
        }
        if *stopped {
            cancel.store(true, Ordering::SeqCst);
        }
    };

    loop {
        let next = match held_since {
            Some(t) => match tokio::time::timeout(GEO_HOLD.saturating_sub(t.elapsed()), rx.recv()).await {
                Ok(r) => r.map(Some),
                Err(_) => Some(None),
            },
            None => rx.recv().await.map(Some),
        };
        let flush_now = match next {
            // The run is over: flush what waits, then finish.
            None => {
                flush(&geo, &mut held, &mut geo_down, &mut stopped, &mut hand_over).await;
                break;
            }
            // Waited long enough.
            Some(None) => true,
            Some(Some(mut r)) => {
                if stopped {
                    continue;
                }
                let wants_lookup = !geo_down
                    && r.alive
                    && r.exit_ip.is_some()
                    && geo
                        .as_ref()
                        .is_some_and(|g| located_ip(&r).is_some_and(|ip| !g.knows(ip)));
                if wants_lookup {
                    held.push(r);
                    held_since.get_or_insert_with(Instant::now);
                    held.len() >= GEO_BATCH
                } else {
                    if let (Some(g), Some(host)) = (geo.as_ref(), r.ip.clone()) {
                        g.enrich(&host, &mut r);
                    }
                    hand_over(r, &mut stopped);
                    false
                }
            }
        };
        if flush_now {
            flush(&geo, &mut held, &mut geo_down, &mut stopped, &mut hand_over).await;
            held_since = None;
        }
    }

    let done = task.await.unwrap_or(Done {
        total: 0,
        alive: 0,
        duration_ms: 0,
        cancelled: true,
        peak_concurrency: 0,
        duplicates: 0,
        invalid: 0,
    });
    (done, working)
}

/// Look up the exits of the waiting rows in one go, label them, hand them over.
async fn flush<H>(
    geo: &Option<Arc<Geo>>,
    held: &mut Vec<CheckResult>,
    geo_down: &mut bool,
    stopped: &mut bool,
    hand_over: &mut H,
) where
    H: FnMut(CheckResult, &mut bool),
{
    if held.is_empty() {
        return;
    }
    if let Some(g) = geo {
        if !*geo_down && !*stopped {
            let ips: Vec<String> = held.iter().filter_map(|r| located_ip(r).map(str::to_string)).collect();
            if !g.prefetch(&ips, |_| {}).await {
                *geo_down = true;
            }
        }
    }
    for mut r in held.drain(..) {
        if let (Some(g), Some(host)) = (geo.as_ref(), r.ip.clone()) {
            g.enrich(&host, &mut r);
        }
        hand_over(r, stopped);
    }
}

#[derive(Debug)]
pub struct CheckArgs {
    pub lines: Vec<String>,
    pub file: Option<String>,
    pub json: bool,
    pub fields: Option<Vec<String>>,
    pub alive_only: bool,
    pub first: Option<usize>,
    pub geo: bool,
    pub concurrency: usize,
    pub timeout: Duration,
    pub protocols: ProtocolSet,
    pub udp: bool,
    pub speed: bool,
    pub retries: u8,
}

pub fn parse_args(argv: &[String]) -> Result<CheckArgs, String> {
    let mut a = CheckArgs {
        lines: Vec::new(),
        file: None,
        json: false,
        fields: None,
        alive_only: false,
        first: None,
        geo: false,
        concurrency: DEFAULT_CONCURRENCY,
        timeout: Duration::from_secs(8),
        protocols: ProtocolSet::all(),
        udp: false,
        speed: false,
        retries: 0,
    };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--file" | "-f" => a.file = Some(it.next().ok_or("--file needs a path, or - for stdin")?.clone()),
            "--json" => a.json = true,
            "--fields" => a.fields = Some(rows::parse_fields(it.next().ok_or("--fields needs a list")?)?),
            "--alive" => a.alive_only = true,
            "--geo" => a.geo = true,
            "--udp" => a.udp = true,
            "--speed" => a.speed = true,
            "--first" => {
                let n: usize = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|n| *n >= 1)
                    .ok_or("--first needs a number of at least 1")?;
                a.first = Some(n);
            }
            "--concurrency" | "-c" => {
                a.concurrency = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("--concurrency needs a number")?;
            }
            "--timeout" | "-t" => {
                let secs: f64 = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .filter(|s: &f64| s.is_finite())
                    .ok_or("--timeout needs seconds")?;
                a.timeout = Duration::from_secs_f64(secs.clamp(1.0, 120.0));
            }
            "--retries" => {
                a.retries = it
                    .next()
                    .and_then(|v| v.parse::<u8>().ok())
                    .ok_or("--retries needs a number from 0 to 5")?
                    .min(5)
            }
            "--protocols" | "-p" => {
                let list = it.next().ok_or("--protocols needs a list, e.g. http,socks5")?;
                let names: Vec<&str> = list.split(',').collect();
                a.protocols = ProtocolSet::from_strings(&names);
                if !a.protocols.any() {
                    return Err(format!(
                        "no known protocol in `{list}`. Use http, https, socks4 or socks5."
                    ));
                }
            }
            other if other.starts_with('-') && other.len() > 1 => {
                return Err(crate::hint::unknown_option("check", other, crate::hint::CHECK_OPTIONS))
            }
            line => a.lines.push(line.to_string()),
        }
    }
    if a.fields.is_some() && !a.json {
        a.json = true;
    }
    Ok(a)
}

/// Read every input line: arguments, then `--file` (or `-` for stdin), then
/// stdin when nothing else was given and a program is feeding it.
pub fn gather_lines(a: &mut CheckArgs) -> Result<Vec<String>, String> {
    let mut lines = std::mem::take(&mut a.lines);
    let mut read_stdin = false;
    match a.file.as_deref() {
        Some("-") => read_stdin = true,
        Some(path) => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?;
            lines.extend(text.lines().map(str::to_string));
        }
        None => {}
    }
    if lines.is_empty() && a.file.is_none() {
        // Waiting on a terminal would hang a script or an AI agent forever:
        // stdin is read only when something is piped in.
        if std::io::stdin().is_terminal() {
            return Err("nothing to check. Pass proxy lines, --file <path>, or pipe them in.".into());
        }
        read_stdin = true;
    }
    if read_stdin {
        for line in std::io::stdin().lock().lines() {
            lines.push(line.map_err(|e| format!("could not read stdin: {e}"))?);
        }
    }
    let lines: Vec<String> = lines
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return Err("nothing to check: the input had no lines.".into());
    }
    Ok(lines)
}

/// The location lookup the CLI and the MCP server use. Short time limit: a
/// label is decoration, and output must never stall long behind it.
pub fn geo_client() -> Geo {
    Geo::with_client(
        hproxy_api::geo::DEFAULT_GEO_API,
        hproxy_api::http_client("hproxy-cli", Duration::from_secs(6)),
    )
}

pub fn batch_options(
    concurrency: usize,
    timeout: Duration,
    protocols: ProtocolSet,
    udp: bool,
    speed: bool,
    retries: u8,
) -> BatchOptions {
    BatchOptions {
        concurrency,
        check: CheckOptions {
            timeout,
            connect_timeout: Duration::from_secs(5).min(timeout),
            retries,
            protocols,
            measure_udp: udp,
            measure_speed: speed,
            ..Default::default()
        },
        dedupe: true,
    }
}

/// `hproxy check`.
pub async fn command(argv: &[String]) -> Outcome {
    let mut a = match parse_args(argv) {
        Ok(a) => a,
        Err(e) => return Outcome::Error(e),
    };
    let lines = match gather_lines(&mut a) {
        Ok(l) => l,
        Err(e) => return Outcome::Error(e),
    };

    let opts = batch_options(a.concurrency, a.timeout, a.protocols, a.udp, a.speed, a.retries);
    let batch = Batch::new(lines, Arc::new(Checker::public()), opts);
    let total = batch.len();
    let geo = a.geo.then(|| Arc::new(geo_client()));

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let table = !a.json && !a.alive_only;
    if table {
        let _ = writeln!(
            out,
            "{:<7} {:<32} {:<22} {:<11} {:>8}  {:<16} {:<3} DETAIL",
            "STATUS", "PROXY", "PROTOCOLS", "ANONYMITY", "LATENCY", "EXIT", "CC"
        );
    }
    let mut pipe_closed = false;
    let (done, working) = run(batch, a.first, geo, |r| {
        if a.alive_only && !r.alive {
            return Flow::Continue;
        }
        let written = if a.json {
            writeln!(out, "{}", rows::compact(&r, a.fields.as_deref()))
        } else if a.alive_only {
            writeln!(out, "{}", r.input)
        } else {
            writeln!(out, "{}", table_row(&r))
        };
        match written {
            Ok(()) => Flow::Continue,
            Err(_) => {
                // The reader is gone (`| head -1`): stop checking for nobody.
                pipe_closed = true;
                Flow::Stop
            }
        }
    })
    .await;

    if !pipe_closed {
        let summary = format!(
            "{working} of {total} working in {:.1} s{}{}{}",
            done.duration_ms as f64 / 1000.0,
            if a.first.is_some_and(|n| working >= n) {
                ", stopped at --first"
            } else {
                ""
            },
            if done.duplicates > 0 {
                format!(", {} duplicates skipped", done.duplicates)
            } else {
                String::new()
            },
            if done.invalid > 0 {
                format!(", {} unreadable lines", done.invalid)
            } else {
                String::new()
            },
        );
        if table {
            let _ = writeln!(out, "\n{summary}");
        } else {
            eprintln!("{summary}");
        }
    }
    let _ = out.flush();
    if working > 0 || pipe_closed {
        Outcome::Ok
    } else {
        Outcome::NoneWorking
    }
}

fn table_row(r: &CheckResult) -> String {
    let status = match r.status {
        Status::Alive => "alive",
        Status::Dead => "dead",
        Status::Invalid => "invalid",
        Status::Unresolved => "no dns",
        Status::Unchecked => "skipped",
    };
    let protocols = if r.protocols.is_empty() {
        "-".to_string()
    } else {
        r.protocols.join(",")
    };
    let latency = r.latency_ms.map(|v| format!("{v} ms")).unwrap_or_else(|| "-".into());
    let mut detail = String::new();
    if r.alive {
        // First, because it is the one thing on the row that can hurt someone.
        if r.tls_intercepted == Some(true) {
            detail.push_str("INTERCEPTS HTTPS, never log in through it ");
        }
        if let Some(s) = &r.server {
            detail.push_str(s);
        }
        if let Some(true) = r.rotating {
            detail.push_str(" rotating");
        }
        if let Some(u) = r.supports_udp {
            detail.push_str(if u { " udp:yes" } else { " udp:no" });
        }
        if let Some(m) = r.speed_mbps {
            detail.push_str(&format!(" {m} Mbit/s"));
        }
        if let Some(org) = &r.asn_org {
            detail.push_str(&format!(" {org}"));
        }
    } else if let Some(e) = &r.error {
        detail.push_str(e);
    }
    format!(
        "{:<7} {:<32} {:<22} {:<11} {:>8}  {:<16} {:<3} {}",
        status,
        truncate(&r.input, 32),
        protocols,
        r.anonymity.as_deref().unwrap_or("-"),
        latency,
        r.exit_ip.as_deref().unwrap_or("-"),
        r.country_code.as_deref().unwrap_or("-"),
        detail.trim()
    )
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let cut: String = s.chars().take(n - 1).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn flags_are_read_and_fields_imply_json() {
        let a = parse_args(&argv("1.2.3.4:80 --first 3 --geo --fields input,alive -t 4 -p socks5")).unwrap();
        assert_eq!(a.lines, ["1.2.3.4:80"]);
        assert_eq!(a.first, Some(3));
        assert!(a.geo && a.json, "--fields means JSON");
        assert_eq!(a.fields.as_deref().unwrap(), ["input", "alive"]);
        assert_eq!(a.timeout, Duration::from_secs(4));
        assert!(a.protocols.socks5 && !a.protocols.http);
    }

    #[test]
    fn bad_values_explain_themselves() {
        assert!(parse_args(&argv("--first 0")).is_err());
        assert!(parse_args(&argv("--first many")).is_err());
        assert!(parse_args(&argv("--timeout NaN")).is_err());
        assert!(parse_args(&argv("--protocols ftp"))
            .unwrap_err()
            .contains("no known protocol"));
        assert!(parse_args(&argv("--fields nope")).unwrap_err().contains("not a field"));
        assert!(parse_args(&argv("--nope"))
            .unwrap_err()
            .contains("is not an option of `hproxy check`"));
    }

    #[test]
    fn a_lone_dash_means_stdin_for_file() {
        let a = parse_args(&argv("--file -")).unwrap();
        assert_eq!(a.file.as_deref(), Some("-"));
    }

    #[test]
    fn a_huge_timeout_is_clamped_not_obeyed() {
        let a = parse_args(&argv("--timeout 99999")).unwrap();
        assert_eq!(a.timeout, Duration::from_secs(120));
    }

    /// `--first` ends the run as soon as enough rows are handed over, and a
    /// reader that goes away ends it too. Unreadable lines cost no network, so
    /// these runs are fast and deterministic.
    #[tokio::test]
    async fn the_run_hands_over_every_row_and_stops_when_the_reader_does() {
        let opts = batch_options(4, Duration::from_secs(1), ProtocolSet::all(), false, false, 0);
        // No port and no separator: unreadable for sure. (`not a proxy 5` is NOT
        // unreadable: it reads as host `proxy`, port 5, login `not:a`.)
        let lines: Vec<String> = (0..20).map(|i| format!("line-{i}")).collect();
        let checker = Arc::new(Checker::public());

        let batch = Batch::new(lines.clone(), checker.clone(), opts.clone());
        let mut seen = 0;
        let (done, working) = run(batch, None, None, |_| {
            seen += 1;
            Flow::Continue
        })
        .await;
        assert_eq!((seen, working, done.total), (20, 0, 20));

        let batch = Batch::new(lines, checker, opts);
        let mut seen = 0;
        let (_, _) = run(batch, None, None, |_| {
            seen += 1;
            if seen == 3 {
                Flow::Stop
            } else {
                Flow::Continue
            }
        })
        .await;
        assert_eq!(seen, 3, "nothing is handed over after the reader stopped");
    }
}
