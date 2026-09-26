//! The Checker screen's commands: start a run, cancel it, read one line.
//!
//! `check_proxies` hands the list to `hproxy_probe::Batch`, which parses,
//! deduplicates, fans out under the adaptive governor and streams every row
//! the moment it settles. This file adds what the desktop app needs on top:
//! geolocation from our public IP API (`hproxy_api::geo`), the optional API
//! checking mode (`hproxy_api::check_api`), and the `checker:result` and
//! `checker:done` events the window listens to.

use hproxy_api::check_api::{Remote, RemoteError, CHUNK};
use hproxy_api::geo::{Geo, DEFAULT_GEO_API};
use hproxy_probe::batch::Claims;
use hproxy_probe::{Batch, BatchOptions, CheckOptions, CheckResult, Checker, Ladder, ProtocolSet, DEFAULT_CONCURRENCY};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Shared application state, managed by Tauri.
pub struct AppState {
    /// One engine for the whole session, so its own-address lookup and its
    /// resolved judges are reused across runs.
    pub checker: Arc<Checker>,
    /// Session-wide geolocation resolver. Its cache survives across runs, so
    /// re-checking a list costs no further lookups.
    pub geo: Arc<Geo>,
    /// The cancel handle of the run in flight, if any. Starting a run cancels
    /// the previous one; `cancel_checks` cancels the current one.
    pub current: Mutex<Option<Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            checker: Arc::new(Checker::public()),
            geo: Arc::new(Geo::new(DEFAULT_GEO_API)),
            current: Mutex::new(None),
        }
    }
}

/// Everything a run needs, sent from the UI. All knobs are optional and fall
/// back to gentle defaults.
#[derive(Deserialize)]
pub struct CheckArgs {
    pub proxies: Vec<String>,
    #[serde(default)]
    pub concurrency: Option<usize>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub retries: Option<u8>,
    #[serde(default)]
    pub protocols: Option<Vec<String>>,
    /// A custom plain-HTTP echo judge, for people who run their own.
    #[serde(default)]
    pub judge_http_url: Option<String>,
    /// A custom TLS echo judge.
    #[serde(default)]
    pub liveness_https_url: Option<String>,
    /// Endpoint used to label results with country / city / ASN / ISP. Send an
    /// EMPTY string to switch geolocation off, for users who do not want the
    /// addresses they are checking leaving the machine at all.
    #[serde(default)]
    pub geo_api_url: Option<String>,
    /// Who does the checking: `"local"` (default), `"api"`, or `"both"`. Local
    /// runs every probe from this machine. API hands the list to our checker,
    /// which means the list, credentials included, leaves the machine. Both
    /// shares one queue between them. Anything unrecognised means local: an
    /// unknown value must never silently upload a list.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub check_api_url: Option<String>,
    #[serde(default)]
    pub measure_udp: Option<bool>,
    #[serde(default)]
    pub measure_speed: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Source {
    Local,
    Api,
    Both,
}

impl Source {
    fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("api") => Source::Api,
            Some("both") => Source::Both,
            _ => Source::Local,
        }
    }
    fn uses_api(self) -> bool {
        matches!(self, Source::Api | Source::Both)
    }
}

/// Emitted once when a run finishes or is cancelled.
#[derive(Serialize, Clone)]
struct DonePayload {
    total: usize,
    alive: usize,
    duration_ms: u64,
    cancelled: bool,
    /// The highest concurrency the governor settled on: the difference between
    /// "your line took everything we could give it" and "we throttled to
    /// protect your router".
    peak_concurrency: usize,
    duplicates: usize,
    invalid: usize,
    /// Run-level things the user should know: the API rate-limited us and the
    /// list fell back to local, a chunk failed. A silent fallback is worse than
    /// a slow run.
    notices: Vec<String>,
}

/// Start a run. Returns immediately; results arrive as `checker:result` events
/// (one `CheckResult` each) followed by a single `checker:done`.
#[tauri::command]
pub fn check_proxies(app: AppHandle, state: State<'_, AppState>, args: CheckArgs) -> Result<(), String> {
    let geo = match args.geo_api_url.as_deref().map(str::trim) {
        Some(url) if url != DEFAULT_GEO_API => Arc::new(Geo::new(url)),
        _ => state.geo.clone(),
    };

    let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(8000).clamp(1000, 60_000));
    let protocols = match args.protocols.as_deref() {
        Some(list) if !list.is_empty() => ProtocolSet::from_strings(list),
        _ => ProtocolSet::all(),
    };
    let check = CheckOptions {
        timeout,
        connect_timeout: Duration::from_secs(5).min(timeout),
        retries: args.retries.unwrap_or(0).min(3),
        protocols,
        measure_udp: args.measure_udp.unwrap_or(false),
        measure_speed: args.measure_speed.unwrap_or(false),
        ..Default::default()
    };
    let opts = BatchOptions {
        concurrency: args.concurrency.unwrap_or(DEFAULT_CONCURRENCY),
        check: check.clone(),
        dedupe: true,
    };

    // Custom judges make a checker of their own; the defaults share the
    // session's, whose own-address lookup is already done.
    let custom_plain = args.judge_http_url.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let custom_tls = args
        .liveness_https_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let checker: Arc<Checker> = if custom_plain.is_some() || custom_tls.is_some() {
        let public = Ladder::public();
        let plain = custom_plain
            .map(str::to_string)
            .unwrap_or_else(|| public.plain[0].url());
        let tls = custom_tls.map(str::to_string).unwrap_or_else(|| public.tls[0].url());
        let ladder = Ladder::from_urls(
            &plain,
            &tls,
            hproxy_probe::judge::DEFAULT_TRACE_PLAIN,
            hproxy_probe::judge::DEFAULT_TRACE_TLS,
        )
        .ok_or("the judge URL could not be read: it needs to look like http://host:port/path")?;
        Arc::new(Checker::new(ladder))
    } else {
        state.checker.clone()
    };

    let source = Source::parse(args.source.as_deref());
    let check_api = args
        .check_api_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| hproxy_api::check_api::DEFAULT_CHECK_API.to_string());

    let mut batch = Batch::new(args.proxies, checker, opts);
    if source == Source::Api {
        batch.local_only_serves_requeue();
    }
    let cancel = batch.cancel_handle();
    // Starting a run cancels any run still in flight.
    if let Ok(mut cur) = state.current.lock() {
        if let Some(prev) = cur.replace(cancel.clone()) {
            prev.store(true, Ordering::SeqCst);
        }
    }

    tauri::async_runtime::spawn(async move {
        let started = Instant::now();
        let total = batch.len();
        let duplicates = batch.duplicates();
        let invalid = batch.invalid();

        let done_payload = |alive: usize, cancelled: bool, peak: usize, notices: Vec<String>| DonePayload {
            total,
            alive,
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
            peak_concurrency: peak,
            duplicates,
            invalid,
            notices,
        };

        if cancel.load(Ordering::SeqCst) {
            let _ = app.emit("checker:done", done_payload(0, true, 0, Vec::new()));
            return;
        }

        // Geolocation runs BESIDE the check, never in front of it: a lookup
        // that only decorates rows must not be able to delay them. A row that
        // settles after its wave arrived is labelled from the cache when it is
        // emitted below; a row that settled earlier is labelled by the window
        // from these `checker:geo` events.
        let geo_task = {
            let geo = geo.clone();
            let hosts = batch.hosts();
            let app = app.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                geo.prefetch(&hosts, |labels| {
                    if !cancel.load(Ordering::SeqCst) {
                        let _ = app.emit("checker:geo", labels);
                    }
                })
                .await;
            })
        };

        // Exits exist only once a proxy answers, so they cannot be looked up
        // with the list. A working row whose exit is not known yet is sent
        // here; the lookup batches them and its labels reach the window as
        // `checker:geo` like the others. The window puts a label on a working
        // row by its exit and on every other row by the address dialled.
        let (exit_tx, exit_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let exit_task = {
            let geo = geo.clone();
            let app = app.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                geo.locate_as_found(exit_rx, |labels| {
                    if !cancel.load(Ordering::SeqCst) {
                        let _ = app.emit("checker:geo", labels);
                    }
                })
                .await;
            })
        };

        let notices: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let api_alive = Arc::new(AtomicUsize::new(0));
        let api_task = if source.uses_api() {
            let claims = batch.claims();
            claims.external_active.store(true, Ordering::SeqCst);
            spawn_api_task(
                app.clone(),
                geo.clone(),
                check_api,
                source,
                claims,
                notices.clone(),
                api_alive.clone(),
                check.clone(),
                cancel.clone(),
            )
        } else {
            None
        };

        let emit_app = app.clone();
        let emit_geo = geo.clone();
        let done = batch
            .run(|mut r| {
                if let Some(host) = r.ip.clone() {
                    emit_geo.enrich(&host, &mut r);
                }
                if r.alive && r.country_code.is_none() {
                    if let Some(exit) = r.exit_ip.as_deref() {
                        let _ = exit_tx.send(exit.to_string());
                    }
                }
                let _ = emit_app.emit("checker:result", r);
            })
            .await;
        // The run is over: no more exits will be found, so the lookup can
        // finish what it holds and end.
        drop(exit_tx);

        if let Some(t) = api_task {
            if done.cancelled {
                t.abort();
            } else {
                let _ = t.await;
            }
        }

        // The labels have normally all arrived long before the last proxy
        // settles. After a tiny list they may not have, and the window stops
        // listening at `checker:done`, so give them a moment; a cancelled run
        // does not wait for anything.
        if done.cancelled {
            geo_task.abort();
            exit_task.abort();
        } else {
            let _ = tokio::time::timeout(Duration::from_secs(4), async {
                let _ = geo_task.await;
                let _ = exit_task.await;
            })
            .await;
        }

        let notices = notices.lock().map(|n| n.clone()).unwrap_or_default();
        let alive = done.alive + api_alive.load(Ordering::SeqCst);
        log::info!(
            "run finished: {alive}/{total} alive in {} ms, concurrency settled at {}",
            done.duration_ms,
            done.peak_concurrency
        );
        let _ = app.emit(
            "checker:done",
            done_payload(alive, done.cancelled, done.peak_concurrency, notices),
        );
    });

    Ok(())
}

/// In `both` mode, stop handing chunks to the API once the tail is this short.
/// The server's rate limiter allows a burst and then one request every few
/// seconds, so the last few hundred proxies cost more in throttled round trips
/// than checking them locally costs outright.
const BOTH_TAIL: usize = 1000;

/// The API side of a run: claim big chunks from the shared cursor, stream them
/// through our checker, emit each row, and hand back anything that did not
/// come home so a local worker checks it.
#[allow(clippy::too_many_arguments)]
fn spawn_api_task(
    app: AppHandle,
    geo: Arc<Geo>,
    url: String,
    source: Source,
    claims: Claims,
    notices: Arc<Mutex<Vec<String>>>,
    api_alive: Arc<AtomicUsize>,
    opts: CheckOptions,
    cancel: Arc<AtomicBool>,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let remote = match Remote::new(url) {
        Some(r) => r,
        None => {
            push_notice(&notices, "could not start the API client, checking locally instead");
            claims.external_active.store(false, Ordering::SeqCst);
            return None;
        }
    };
    Some(tauri::async_runtime::spawn(async move {
        loop {
            if cancel.load(Ordering::SeqCst) {
                break;
            }
            let remaining = claims.remaining();
            let want = match source {
                Source::Local => break,
                Source::Api => CHUNK.min(remaining),
                Source::Both => {
                    if remaining < BOTH_TAIL {
                        break;
                    }
                    (remaining / 2).clamp(1, CHUNK)
                }
            };
            if want == 0 {
                break;
            }
            let range = claims.claim(want);
            if range.is_empty() {
                break;
            }
            let claimed: Vec<usize> = range.collect();
            let lines: Vec<String> = claimed.iter().map(|i| claims.items[*i].raw.clone()).collect();

            let outcome = remote
                .check(&lines, &opts, |mut r| {
                    if let Some(host) = r.ip.clone() {
                        geo.enrich(&host, &mut r);
                    }
                    if r.alive {
                        api_alive.fetch_add(1, Ordering::Relaxed);
                    }
                    let _ = app.emit("checker:result", r);
                })
                .await;

            match outcome {
                Ok(answered) => {
                    // The server may answer for fewer lines than it was given,
                    // and every one of those has to be checked somewhere or it
                    // silently becomes a dead row.
                    let missed: Vec<usize> = claimed
                        .iter()
                        .copied()
                        .filter(|i| !answered.contains(&claims.items[*i].raw))
                        .collect();
                    if !missed.is_empty() {
                        log::info!(
                            "API answered {} of {} lines; the rest go local",
                            answered.len(),
                            claimed.len()
                        );
                        claims.hand_back(missed);
                    }
                }
                Err(e) => {
                    push_notice(
                        &notices,
                        &format!("{e}. {} proxies fell back to local checking", claimed.len()),
                    );
                    claims.hand_back(claimed);
                    // A rate limit will not clear inside this run; asking again
                    // only collects more refusals while the user waits.
                    if matches!(e, RemoteError::RateLimited(_)) {
                        break;
                    }
                }
            }
        }
        // Last: local workers wait on this flag before giving up, so clearing
        // it early would let them exit while a chunk could still be handed back.
        claims.external_active.store(false, Ordering::SeqCst);
    }))
}

fn push_notice(notices: &Arc<Mutex<Vec<String>>>, msg: &str) {
    if let Ok(mut n) = notices.lock() {
        if n.len() < 3 && !n.iter().any(|e| e == msg) {
            n.push(msg.to_string());
        }
    }
}

/// Cancel the current run. In-flight probes finish on their own budget; no new
/// ones start, and the window gets its `checker:done`.
#[tauri::command]
pub fn cancel_checks(state: State<'_, AppState>) {
    if let Ok(cur) = state.current.lock() {
        if let Some(c) = cur.as_ref() {
            c.store(true, Ordering::SeqCst);
        }
    }
}

/// Check one proxy the way a run would, with its location: the Connect
/// screen's look-before-you-leap. Rejects with the engine's sentence when the
/// line cannot be read; a dead proxy is a successful answer with `alive: false`
/// and the reason in `error`.
#[tauri::command]
pub async fn check_line(state: State<'_, AppState>, line: String) -> Result<CheckResult, String> {
    let parsed = hproxy_probe::parse(&line).map_err(|e| e.0)?;
    let checker = state.checker.clone();
    let geo = state.geo.clone();
    let opts = CheckOptions {
        timeout: Duration::from_secs(8),
        connect_timeout: Duration::from_secs(5),
        ..Default::default()
    };
    let mut result = checker.check(&parsed, &opts).await;
    // Locate what the row describes: the exit when it works, else the
    // address dialled. A gateway's own country is never the answer.
    if let Some(ip) = hproxy_api::geo::located_ip(&result).map(str::to_string) {
        let _ = geo.prefetch(std::slice::from_ref(&ip), |_| {}).await;
    }
    if let Some(host) = result.ip.clone() {
        geo.enrich(&host, &mut result);
    }
    Ok(result)
}

/// Parse one line the way the engine will, so the UI can show the count and
/// the shape it understood before a run starts.
#[tauri::command]
pub fn parse_line(line: String) -> Result<ParsedLine, String> {
    let l = hproxy_probe::parse(&line).map_err(|e| e.0)?;
    Ok(ParsedLine {
        host: l.host,
        port: l.port,
        auth: l.auth.is_some(),
        scheme: l.scheme.map(|s| format!("{s:?}").to_ascii_lowercase()),
    })
}

#[derive(Serialize)]
pub struct ParsedLine {
    pub host: String,
    pub port: u16,
    pub auth: bool,
    pub scheme: Option<String>,
}

#[allow(dead_code)]
fn _assert_result_is_send(r: CheckResult) -> impl Send {
    r
}
