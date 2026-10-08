//! Connect: the relay and the system proxy setting, driven from the window.
//!
//! One relay at a time. `connect_start` binds a local port with no password,
//! forwards to the chosen source with the login attached, and, when asked,
//! points the operating system's proxy setting at it after taking a snapshot
//! of what was there. `connect_stop` puts the setting back exactly as found
//! and ends the relay. `connect_status` says what is running.
//!
//! Three sources, chosen on the screen: the person's own proxy line, their own
//! list with a rotation rule (a different member every connection, every N,
//! at random, or only when one dies), or a free exit from the hproxy.com pool
//! by country. The relay's `Source` owns rotation and failover; this file
//! builds it from what the window sent.
//!
//! While connected, a probe goes THROUGH the relay to our own judge every
//! `PROBE_EVERY`: it measures the round trip, reads the exit address the judge
//! saw, and labels it with country, city and network. That is what lets the
//! screen say "you are leaving through 203.0.113.9 in Frankfurt, 140 ms" and,
//! when a fixed proxy dies, "not answering for three checks" instead of
//! nothing. The probe is one connection like any other, so under a
//! per-connection rotation rule it takes one turn. `connect_probe` runs one
//! on request, `connect_rotate` switches upstream on request.
//!
//! The snapshot is also written to the app's config directory. If the app
//! dies while connected (a crash, a forced reboot) the next start finds the
//! file, sees the system still pointing at a relay that no longer exists, and
//! restores the setting before anything else, because a machine left pointing
//! at a dead proxy has no internet and no explanation. `restore_on_exit` does
//! the same the moment the app ends, whichever way it ends.

use crate::check::AppState;
use hproxy_api::geo::Geo;
use hproxy_relay::pool::Pool;
use hproxy_relay::upstream::{self, Scheme, Upstream};
use hproxy_relay::{List, Rotation, Source, SourceKind, Stats, StatsSnapshot};
use hproxy_system::{ProxySetting, RestoreOutcome, Snapshot, Support};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// How often the relay is probed while connected.
const PROBE_EVERY: Duration = Duration::from_secs(20);
/// How long one probe may take. The relay's own dial budget is inside this.
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
/// The default probe target: our TLS judge, a CONNECT through the relay, TLS
/// end to end, and an answer that names the address it saw on the wire. The
/// person may point the probe anywhere else (Settings, "Connect check"); then
/// it measures reachability and the round trip, and only a Cloudflare
/// `/cdn-cgi/trace` page can still name the exit.
pub const DEFAULT_PROBE_URL: &str = hproxy_probe::judge::DEFAULT_ECHO_TLS;

/// What a probe target can tell us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeKind {
    /// Our judge: JSON with the trusted peer address.
    Echo,
    /// A Cloudflare `/cdn-cgi/trace` page: its `ip=` line names the exit.
    Trace,
    /// Anything else: a 2xx or 3xx answer means the tunnel works.
    Plain,
}

fn probe_kind(url: &str) -> ProbeKind {
    if url == DEFAULT_PROBE_URL {
        ProbeKind::Echo
    } else if url.trim_end_matches('/').ends_with("/cdn-cgi/trace") {
        ProbeKind::Trace
    } else {
        ProbeKind::Plain
    }
}

/// A probe URL from the window: absolute, http or https, nothing else. Empty
/// means the default.
fn probe_url_from(url: Option<String>) -> Result<String, String> {
    let url = url
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_PROBE_URL.to_string());
    let parsed = reqwest::Url::parse(&url).map_err(|_| {
        "the probe target needs to be a full address, like https://www.google.com/generate_204".to_string()
    })?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("the probe target needs to be an http or https address".into());
    }
    Ok(url)
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// The `ip=` line of a Cloudflare trace page.
fn trace_ip(body: &str) -> Option<String> {
    body.lines()
        .find_map(|l| l.strip_prefix("ip="))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[derive(Default)]
pub struct RelayState {
    inner: Mutex<Option<Running>>,
}

struct Running {
    listen: SocketAddr,
    source: Arc<Source>,
    stats: Arc<Stats>,
    /// The pool's own description of the exit in use (place and latency), or
    /// nothing for the other sources.
    exit_label: Option<String>,
    started_at_ms: u64,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<Result<(), String>>,
    probe: tauri::async_runtime::JoinHandle<()>,
    health: Arc<Mutex<HealthState>>,
    /// Where the probe goes; the loop reads it on every tick.
    probe_url: Arc<Mutex<String>>,
    system: Option<Snapshot>,
}

#[derive(Default)]
struct HealthState {
    last: Option<Health>,
    failures_in_a_row: u32,
}

/// What the last probe through the relay found.
#[derive(Serialize, Clone)]
pub struct Health {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub exit_ip: Option<String>,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub asn_org: Option<String>,
    /// The exit's IANA time zone, e.g. "Europe/Berlin": the leak check compares
    /// it with the computer's clock.
    pub timezone: Option<String>,
    /// Why the probe failed, as a sentence.
    pub error: Option<String>,
    pub checked_at_ms: u64,
    pub failures_in_a_row: u32,
    /// The host the probe went to.
    pub target: String,
    /// Whether that target can name the exit address: our judge and any
    /// Cloudflare trace page can, a plain page cannot.
    pub reflects_exit: bool,
}

/// The source behind the relay, as the window shows it.
#[derive(Serialize, Clone)]
pub struct SourceInfo {
    pub kind: SourceKind,
    /// How many upstreams it chooses from; unknown for the pool.
    pub size: Option<usize>,
    /// The list's rotation rule, as a sentence.
    pub rotation: Option<String>,
    /// The upstream in use, never with its password.
    pub in_use: String,
    /// The pool's description of the exit (place, latency).
    pub detail: Option<String>,
    pub can_rotate: bool,
}

#[derive(Serialize, Clone)]
pub struct ConnectStatus {
    pub running: bool,
    pub listen: Option<String>,
    /// The upstream in use, as shown to a person: never the password.
    pub upstream: Option<String>,
    /// Whether the system proxy setting currently points at the relay.
    pub system_proxy: bool,
    /// What this machine can do about its system proxy setting.
    pub support: Support,
    /// A message worth showing: the setting was restored after a crash, or
    /// left alone because it had been changed.
    pub notice: Option<String>,
    pub source: Option<SourceInfo>,
    /// Unix milliseconds, for the uptime counter.
    pub started_at_ms: Option<u64>,
    pub stats: Option<StatsSnapshot>,
    pub health: Option<Health>,
}

/// What the window asks to connect through.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConnectSource {
    Fixed {
        line: String,
    },
    List {
        lines: Vec<String>,
        rotation: RotationArg,
    },
    Free {
        #[serde(default)]
        country: Option<String>,
        #[serde(default)]
        socks5: bool,
        /// A free exit the person picked from the Free tab's list, `host:port`.
        /// Absent: the pool's search picks the first exit that works.
        #[serde(default)]
        exit: Option<String>,
    },
}

fn scheme_of(socks5: bool) -> Scheme {
    if socks5 {
        Scheme::Socks5
    } else {
        Scheme::Http
    }
}

/// A free exit's `host:port` as the relay's upstream. Pool exits are open
/// proxies, so there is never a login.
fn free_upstream(addr: &str, scheme: Scheme) -> Result<Upstream, String> {
    let (host, port) = addr
        .trim()
        .rsplit_once(':')
        .ok_or_else(|| format!("`{addr}` is not a host:port"))?;
    let port: u16 = port.parse().map_err(|_| format!("`{addr}` has no usable port"))?;
    // An IPv6 address comes in brackets, `[2001:db8::1]:8080`, the way
    // `Upstream::addr` prints it; the host is the address inside them.
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if host.is_empty() {
        return Err(format!("`{addr}` has no host"));
    }
    Ok(Upstream {
        scheme,
        host: host.to_string(),
        port,
        auth: None,
    })
}

#[derive(Deserialize)]
pub struct RotationArg {
    /// `every_connection`, `every_n`, `random` or `on_failure`.
    pub rule: String,
    #[serde(default)]
    pub n: Option<u32>,
}

fn rotation_from(arg: &RotationArg) -> Result<Rotation, String> {
    match arg.rule.as_str() {
        "every_connection" => Ok(Rotation::EveryConnection),
        "every_n" => Ok(Rotation::Every(arg.n.unwrap_or(10))),
        "random" => Ok(Rotation::Random),
        "on_failure" => Ok(Rotation::OnFailure),
        other => Err(format!("`{other}` is not a rotation rule")),
    }
}

/// Build the relay's source. Returns it with the pool's exit description and a
/// notice about lines that were skipped, when there are any.
async fn build_source(src: ConnectSource) -> Result<(Source, Option<String>, Option<String>), String> {
    match src {
        ConnectSource::Fixed { line } => Ok((Source::Fixed(upstream::parse(&line)?), None, None)),
        ConnectSource::List { lines, rotation } => {
            let rule = rotation_from(&rotation)?;
            let mut members = Vec::new();
            let mut skipped = Vec::new();
            for (i, l) in lines.iter().enumerate() {
                let l = l.trim();
                if l.is_empty() {
                    continue;
                }
                match upstream::parse(l) {
                    Ok(u) => members.push(u),
                    // The line number and nothing else. The engine's sentence
                    // quotes the line, and a line carries a password.
                    Err(_) => skipped.push(format!("line {}", i + 1)),
                }
            }
            if members.is_empty() {
                return Err(match skipped.first() {
                    Some(first) => format!("none of the lines could be read as a proxy (the first bad one is {first})"),
                    None => "the list is empty".to_string(),
                });
            }
            let list = List::new(members, rule)?;
            let notice = (!skipped.is_empty()).then(|| {
                format!(
                    "{} of the lines could not be read as a proxy and were left out (the first is {})",
                    skipped.len(),
                    skipped[0]
                )
            });
            Ok((Source::List(list), None, notice))
        }
        ConnectSource::Free { country, socks5, exit } => {
            let scheme = scheme_of(socks5);
            let pool = Pool::new(country, scheme)?;
            let (src, label) = match exit.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
                Some(addr) => Source::from_pool_starting_at(pool, free_upstream(addr, scheme)?).await?,
                None => Source::from_pool(pool).await?,
            };
            Ok((src, Some(label), None))
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn snapshot_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("system-proxy-snapshot.json"))
}

fn save_snapshot(app: &AppHandle, s: &Snapshot) {
    if let Some(p) = snapshot_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(p, json);
        }
    }
}

fn clear_snapshot(app: &AppHandle) {
    if let Some(p) = snapshot_path(app) {
        let _ = std::fs::remove_file(p);
    }
}

/// On start: if a snapshot was left behind, the previous run died while
/// connected. Put the system back before the window even opens.
pub fn repair_on_start(app: &AppHandle) -> Option<String> {
    let p = snapshot_path(app)?;
    let json = std::fs::read_to_string(&p).ok()?;
    let snap: Snapshot = serde_json::from_str(&json).ok()?;
    let outcome = hproxy_system::restore(&snap);
    let _ = std::fs::remove_file(&p);
    match outcome {
        Ok(RestoreOutcome::Restored) => {
            log::warn!("system proxy was still pointing at a relay from a previous run; restored");
            Some("The last session ended while connected. Your system proxy setting has been put back.".into())
        }
        Ok(RestoreOutcome::LeftAlone { .. }) => None,
        Err(e) => {
            log::error!("could not restore the system proxy after a crash: {e}");
            Some(format!(
                "The last session ended while connected and the system proxy could not be restored automatically: {e}"
            ))
        }
    }
}

/// Whether a connection is up, for the updater's "nobody is using the app"
/// (src/update.rs). A poisoned lock answers yes: when in doubt, no update.
pub fn is_running(app: &AppHandle) -> bool {
    app.state::<RelayState>()
        .inner
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(true)
}

/// The running relay's start (Unix ms), which names its session: the time
/// zone match takes a probe's zone only from the relay that is up now.
pub fn session(app: &AppHandle) -> Option<u64> {
    app.state::<RelayState>()
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.started_at_ms))
}

/// The exit's time zone from the last probe that answered, with the session,
/// while connected (timezone.rs: the setting switched on, "Match again").
pub fn exit_zone(app: &AppHandle) -> Option<(u64, String)> {
    let state = app.state::<RelayState>();
    let guard = state.inner.lock().ok()?;
    let r = guard.as_ref()?;
    let health = r.health.lock().ok()?;
    let zone = health.last.as_ref().filter(|h| h.ok)?.timezone.clone()?;
    Some((r.started_at_ms, zone))
}

/// A probe's answer: kept for the card, and the exit's zone handed to the
/// time zone match (timezone.rs) while it is on, off the async threads
/// because Windows' `tzutil` blocks.
async fn took_probe(app: &AppHandle, session: u64, health: &Arc<Mutex<HealthState>>, h: Health) {
    let zone = if h.ok { h.timezone.clone() } else { None };
    record_health(health, h);
    if let Some(zone) = zone.filter(|_| crate::timezone::is_matching(app)) {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || crate::timezone::follow_exit(&app, session, &zone)).await;
    }
}

/// On exit (the last window closed, or the process is ending): if Connect is
/// still on, put the system proxy back and tell the relay to stop.
/// Synchronous on purpose, because the event loop is ending and nothing
/// asynchronous would get to run; the relay task is not awaited for the same
/// reason. The window stops Connect itself before an update it was asked to
/// install, and a quiet update (src/update.rs) calls this from the installer's
/// before-exit hook; this is also the guarantee for every other way out: the
/// title bar's close button, a quit from the OS, a process asked to end.
pub fn restore_on_exit(app: &AppHandle) {
    let state = app.state::<RelayState>();
    let running = state.inner.lock().ok().and_then(|mut g| g.take());
    // The time zone, even when no relay runs any more, and only once the relay
    // is out of the state, so a probe still finishing cannot match it again.
    match crate::timezone::restore(app) {
        Ok(Some(words)) => log::info!("{words}"),
        Ok(None) => {}
        Err(e) => log::error!("could not put the time zone back on exit: {e}"),
    }
    let Some(mut r) = running else { return };
    if let Some(snap) = r.system.take() {
        match hproxy_system::restore(&snap) {
            Ok(outcome) => log::info!("system proxy put back on exit: {outcome:?}"),
            Err(e) => log::error!("could not restore the system proxy on exit: {e}"),
        }
        clear_snapshot(app);
    }
    r.probe.abort();
    if let Some(stop) = r.stop.take() {
        let _ = stop.send(());
    }
}

fn status_of(running: Option<&Running>, notice: Option<String>) -> ConnectStatus {
    match running {
        Some(r) => ConnectStatus {
            running: true,
            listen: Some(r.listen.to_string()),
            upstream: Some(r.source.in_use_now()),
            system_proxy: r.system.is_some(),
            support: hproxy_system::support(),
            notice,
            source: Some(SourceInfo {
                kind: r.source.kind(),
                size: r.source.size(),
                rotation: r.source.rotation().map(Rotation::describe),
                in_use: r.source.in_use_now(),
                detail: r.exit_label.clone(),
                can_rotate: r.source.can_rotate(),
            }),
            started_at_ms: Some(r.started_at_ms),
            stats: Some(r.stats.snapshot()),
            health: r.health.lock().ok().and_then(|h| h.last.clone()),
        },
        None => ConnectStatus {
            running: false,
            listen: None,
            upstream: None,
            system_proxy: false,
            support: hproxy_system::support(),
            notice,
            source: None,
            started_at_ms: None,
            stats: None,
            health: None,
        },
    }
}

/// One probe through the relay to `url`: the round trip, and when the target
/// can name it, the exit address and where it lives.
async fn probe_once(listen: SocketAddr, geo: &Geo, url: &str) -> Health {
    let kind = probe_kind(url);
    let target = host_of(url);
    let started = Instant::now();
    let outcome: Result<Option<String>, String> = async {
        let proxy = reqwest::Proxy::all(format!("http://{listen}")).map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(PROBE_TIMEOUT)
            .user_agent(concat!("hproxy-checker/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("could not build the probe client: {e}"))?;
        let resp = client.get(url).send().await.map_err(|e| {
            if e.is_timeout() {
                format!("no answer from {target} within {} seconds", PROBE_TIMEOUT.as_secs())
            } else {
                e.without_url().to_string()
            }
        })?;
        if !resp.status().is_success() {
            return Err(format!("{target} answered {}", resp.status()));
        }
        match kind {
            ProbeKind::Echo => {
                let echo: hproxy_probe::EchoResponse = resp
                    .json()
                    .await
                    .map_err(|_| "the answer did not come from our judge".to_string())?;
                let ip = echo
                    .exit_ip()
                    .ok_or_else(|| "the judge could not tell which address you left through".to_string())?;
                Ok(Some(ip))
            }
            ProbeKind::Trace => {
                let body = resp
                    .text()
                    .await
                    .map_err(|_| "the trace page could not be read".to_string())?;
                Ok(trace_ip(&body))
            }
            ProbeKind::Plain => Ok(None),
        }
    }
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let checked_at_ms = now_ms();
    let reflects_exit = kind != ProbeKind::Plain;
    match outcome {
        Ok(ip) => {
            let label = match &ip {
                Some(ip) => {
                    geo.prefetch(std::slice::from_ref(ip), |_| {}).await;
                    geo.label(ip)
                }
                None => None,
            };
            Health {
                ok: true,
                latency_ms: Some(latency_ms),
                exit_ip: ip,
                country_code: label.as_ref().and_then(|l| l.country_code.clone()),
                country: label.as_ref().and_then(|l| l.country.clone()),
                city: label.as_ref().and_then(|l| l.city.clone()),
                asn_org: label.as_ref().and_then(|l| l.asn_org.clone()),
                timezone: label.as_ref().and_then(|l| l.timezone.clone()),
                error: None,
                checked_at_ms,
                failures_in_a_row: 0,
                target,
                reflects_exit,
            }
        }
        Err(e) => Health {
            ok: false,
            latency_ms: None,
            exit_ip: None,
            country_code: None,
            country: None,
            city: None,
            asn_org: None,
            timezone: None,
            error: Some(e),
            checked_at_ms,
            failures_in_a_row: 0,
            target,
            reflects_exit,
        },
    }
}

fn record_health(health: &Arc<Mutex<HealthState>>, mut h: Health) {
    if let Ok(mut st) = health.lock() {
        st.failures_in_a_row = if h.ok { 0 } else { st.failures_in_a_row + 1 };
        h.failures_in_a_row = st.failures_in_a_row;
        st.last = Some(h);
    }
}

/// Start relaying `source` on `listen` (default `127.0.0.1:8080`; port 0
/// picks a free port), and set the system proxy when `system_proxy` is true.
#[tauri::command]
pub async fn connect_start(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
    source: ConnectSource,
    listen: Option<String>,
    system_proxy: bool,
    probe_url: Option<String>,
) -> Result<ConnectStatus, String> {
    let probe_url = Arc::new(Mutex::new(probe_url_from(probe_url)?));
    let asked = listen.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut addr: SocketAddr = asked
        .unwrap_or(hproxy_relay::DEFAULT_LISTEN)
        .parse()
        .map_err(|_| "the listen address needs to look like 127.0.0.1:8080".to_string())?;
    hproxy_relay::check_bind(&addr, false)?;

    // The source is built before the old relay is stopped: a pool that has no
    // exit right now must not cost the person the connection they had.
    let (source, exit_label, mut notice) = build_source(source).await?;
    let source = Arc::new(source);
    let stats = Arc::new(Stats::default());

    // One relay at a time keeps "which proxy am I on" a question with one
    // answer. Stopping the old one restores the system setting first.
    stop_running(&app, &state).await;

    // The default port is a popular one (development servers live on 8080).
    // When nobody asked for a specific port and the default is taken, take a
    // free one instead of failing: the address is shown and copied from the
    // screen anyway, so which port it is does not matter to the person.
    if asked.is_none() && std::net::TcpListener::bind(addr).is_err() {
        addr.set_port(0);
    }

    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<SocketAddr, String>>();
    let task = {
        let source = Arc::clone(&source);
        let stats = Arc::clone(&stats);
        tauri::async_runtime::spawn(async move {
            let mut ready = Some(ready_tx);
            let r = hproxy_relay::serve(
                addr,
                false,
                false,
                source,
                stats,
                |bound| {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(bound));
                    }
                },
                async {
                    let _ = stop_rx.await;
                },
            )
            .await;
            if let (Err(e), Some(tx)) = (&r, ready.take()) {
                let _ = tx.send(Err(e.clone()));
            }
            r
        })
    };

    let bound = match ready_rx.await {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("the relay stopped before it could report its address".into()),
    };

    // The relay is up. Now the system setting, with its snapshot saved to
    // disk before the change so a crash between the two lines still leaves a
    // record.
    let mut system = None;
    if system_proxy {
        match hproxy_system::support() {
            Support::Automatic { .. } => match hproxy_system::set(&bound.ip().to_string(), bound.port()) {
                Ok(snap) => {
                    save_snapshot(&app, &snap);
                    system = Some(snap);
                }
                Err(e) => {
                    // The relay still works; the person can paste the address.
                    notice = Some(format!(
                        "The relay is running, but the system proxy could not be set: {e}"
                    ));
                }
            },
            // Nothing to set here (a phone, a Linux desktop without GNOME). The
            // card shows the address to type in with these steps itself
            // (ConnectionCard.tsx, ProgramSettings), so a notice would say
            // them twice.
            Support::Manual { .. } => {}
        }
    }

    // The first probe runs at once, so the exit address is on the screen
    // within a second or two of connecting; then every PROBE_EVERY.
    let started_at_ms = now_ms();
    let health = Arc::new(Mutex::new(HealthState::default()));
    let probe = {
        let health = Arc::clone(&health);
        let geo = Arc::clone(&app_state.geo);
        let probe_url = Arc::clone(&probe_url);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let url = probe_url
                    .lock()
                    .map(|u| u.clone())
                    .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string());
                let h = probe_once(bound, &geo, &url).await;
                took_probe(&app, started_at_ms, &health, h).await;
                tokio::time::sleep(PROBE_EVERY).await;
            }
        })
    };

    log::info!(
        "connected: {:?} source through {}, listening on {bound}",
        source.kind(),
        source.in_use_now()
    );
    let running = Running {
        listen: bound,
        source,
        stats,
        exit_label,
        started_at_ms,
        stop: Some(stop_tx),
        task,
        probe,
        health,
        probe_url,
        system,
    };
    let status = status_of(Some(&running), notice);
    if let Ok(mut inner) = state.inner.lock() {
        *inner = Some(running);
    }
    crate::tray::relay_changed(&app, true, status.upstream.as_deref());
    Ok(status)
}

#[tauri::command]
pub async fn connect_stop(app: AppHandle, state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    let notice = stop_running(&app, &state).await;
    crate::tray::relay_changed(&app, false, None);
    Ok(status_of(None, notice))
}

/// The tray icon's Disconnect: the same stop as the window's, with the window
/// hidden or shown. The window hears it through `relay-changed`.
#[cfg(desktop)]
pub async fn stop_from_tray(app: &AppHandle) {
    let state = app.state::<RelayState>();
    if let Some(notice) = stop_running(app, &state).await {
        log::warn!("{notice}");
    }
    crate::tray::relay_changed(app, false, None);
}

#[tauri::command]
pub fn connect_status(state: State<'_, RelayState>) -> ConnectStatus {
    let guard = state.inner.lock().ok();
    status_of(guard.as_ref().and_then(|g| g.as_ref()), None)
}

/// How many free exits the Free tab lists for a country.
const FREE_LIST_SIZE: usize = 24;

/// One free exit on the Free tab's list, as the pool describes it.
#[derive(Serialize)]
pub struct FreeExit {
    pub host: String,
    pub port: u16,
    pub country: String,
    pub city: String,
    pub network: String,
    pub latency_ms: Option<i64>,
}

/// A country's free exits, best first, untested: the window tests each one
/// with `free_test` and shows the result on its row.
#[tauri::command]
pub async fn free_list(country: Option<String>, socks5: bool) -> Result<Vec<FreeExit>, String> {
    let pool = Pool::new(country, scheme_of(socks5))?;
    Ok(pool
        .list(FREE_LIST_SIZE)
        .await?
        .into_iter()
        .map(|e| FreeExit {
            host: e.upstream.host,
            port: e.upstream.port,
            country: e.country,
            city: e.city,
            network: e.network,
            latency_ms: e.latency_ms,
        })
        .collect())
}

/// Whether one free exit relays, tested from this computer.
#[derive(Serialize)]
pub struct FreeTest {
    pub ok: bool,
    /// How long the test took, when it worked.
    pub ms: Option<u32>,
    /// Why not, in words, when it did not.
    pub why: Option<String>,
}

/// Test one free exit the way Connect would use it: our own HTTPS page through
/// it, certificates checked (`hproxy_relay::pool::test`).
#[tauri::command]
pub async fn free_test(host: String, port: u16, socks5: bool) -> FreeTest {
    let up = Upstream {
        scheme: scheme_of(socks5),
        host,
        port,
        auth: None,
    };
    match hproxy_relay::pool::test(&up).await {
        Ok(ms) => FreeTest {
            ok: true,
            ms: Some(ms),
            why: None,
        },
        Err(why) => FreeTest {
            ok: false,
            ms: None,
            why: Some(why),
        },
    }
}

/// Switch to a different upstream because the person asked: the next member
/// of a list, or a fresh exit from the pool. A fixed proxy refuses. A probe
/// follows at once so the screen shows the new exit.
#[tauri::command]
pub async fn connect_rotate(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<ConnectStatus, String> {
    let (source, listen, health, stats, url) = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        let r = guard.as_ref().ok_or("not connected")?;
        (
            Arc::clone(&r.source),
            r.listen,
            Arc::clone(&r.health),
            Arc::clone(&r.stats),
            current_probe_url(r),
        )
    };
    let label = source.advance().await?;
    stats.rotated();
    let is_pool = source.kind() == SourceKind::Pool;
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(r) = guard.as_mut() {
            r.exit_label = is_pool.then(|| label.clone());
        }
    }
    let h = probe_once(listen, &app_state.geo, &url).await;
    record_health(&health, h);
    let status = connect_status(state);
    crate::tray::relay_changed(&app, true, status.upstream.as_deref());
    Ok(status)
}

fn current_probe_url(r: &Running) -> String {
    r.probe_url
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string())
}

/// One probe through the relay right now, for the "Test now" button.
#[tauri::command]
pub async fn connect_probe(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<ConnectStatus, String> {
    let (listen, health, url, session) = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        let r = guard.as_ref().ok_or("not connected")?;
        (r.listen, Arc::clone(&r.health), current_probe_url(r), r.started_at_ms)
    };
    let h = probe_once(listen, &app_state.geo, &url).await;
    took_probe(&app, session, &health, h).await;
    Ok(connect_status(state))
}

/// One resolver the DNS leak test saw, with its place and network.
#[derive(Serialize)]
pub struct LeakResolver {
    pub ip: String,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub asn_org: Option<String>,
    /// The network the resolver said it asks for, when it sent one.
    pub client_subnet: Option<String>,
}

/// What the DNS leak test found through the relay (`hproxy_api::leak`).
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DnsLeakView {
    /// The resolvers the proxy looked the test's made-up name up with.
    Seen { resolvers: Vec<LeakResolver> },
    /// The proxy never looked the name up.
    NotSeen,
    /// The test could not run, with the reason in words.
    Unavailable { why: String },
}

/// The DNS leak test through the running relay: which resolver the proxy
/// looks names up with, and where it is. The leak check runs it once a
/// connection is up and again on "Test now".
#[tauri::command]
pub async fn leak_dns(
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<DnsLeakView, String> {
    let listen = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        guard.as_ref().ok_or("not connected")?.listen
    };
    let door = hproxy_api::http_client("hproxy-checker", Duration::from_secs(6));
    Ok(match hproxy_api::leak::dns_leak(&format!("http://{listen}"), &door).await {
        hproxy_api::leak::DnsLeak::Seen(found) => {
            let ips: Vec<String> = found.iter().map(|r| r.ip.clone()).collect();
            app_state.geo.prefetch(&ips, |_| {}).await;
            let resolvers = found
                .into_iter()
                .map(|r| {
                    let label = app_state.geo.label(&r.ip);
                    LeakResolver {
                        country_code: label.as_ref().and_then(|l| l.country_code.clone()),
                        country: label.as_ref().and_then(|l| l.country.clone()),
                        city: label.as_ref().and_then(|l| l.city.clone()),
                        asn_org: label.as_ref().and_then(|l| l.asn_org.clone()),
                        client_subnet: r.client_subnet,
                        ip: r.ip,
                    }
                })
                .collect();
            DnsLeakView::Seen { resolvers }
        }
        hproxy_api::leak::DnsLeak::NotSeen => DnsLeakView::NotSeen,
        hproxy_api::leak::DnsLeak::Unavailable(why) => DnsLeakView::Unavailable { why },
    })
}

/// Point the running probe somewhere else (Settings, "Connect check"), and
/// run one at once so the card shows the new target's answer. Empty means
/// back to our judge.
#[tauri::command]
pub async fn connect_set_probe(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
    url: Option<String>,
) -> Result<ConnectStatus, String> {
    let url = probe_url_from(url)?;
    let (listen, health, session) = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        let r = guard.as_ref().ok_or("not connected")?;
        if let Ok(mut u) = r.probe_url.lock() {
            *u = url.clone();
        }
        (r.listen, Arc::clone(&r.health), r.started_at_ms)
    };
    let h = probe_once(listen, &app_state.geo, &url).await;
    took_probe(&app, session, &health, h).await;
    Ok(connect_status(state))
}

/// What the OS proxy setting says right now, for the panel.
#[tauri::command]
pub fn system_proxy_current() -> Result<ProxySetting, String> {
    hproxy_system::current()
}

async fn stop_running(app: &AppHandle, state: &State<'_, RelayState>) -> Option<String> {
    let running = state.inner.lock().ok().and_then(|mut g| g.take());
    let mut notice = None;
    if let Some(mut r) = running {
        // The system setting goes back BEFORE the relay stops, so no program
        // is ever pointed at a port with nothing behind it.
        if let Some(snap) = r.system.take() {
            match hproxy_system::restore(&snap) {
                Ok(RestoreOutcome::Restored) => {}
                Ok(RestoreOutcome::LeftAlone { now }) => {
                    notice = Some(format!(
                        "The system proxy setting was changed while connected ({}), so it was left as it is.",
                        now.server.as_deref().unwrap_or("off")
                    ));
                }
                Err(e) => notice = Some(format!("The system proxy could not be restored: {e}")),
            }
            clear_snapshot(app);
        }
        r.probe.abort();
        if let Some(stop) = r.stop.take() {
            let _ = stop.send(());
        }
        let _ = r.task.await;
    }
    // The time zone, when it was matched to the exit (timezone.rs): back on
    // every disconnect, even when the relay had already stopped by itself.
    let zone = match crate::timezone::restore(app) {
        Ok(words) => words,
        Err(e) => Some(format!("The time zone could not be put back: {e}.")),
    };
    match (notice, zone) {
        (Some(n), Some(z)) => Some(format!("{n} {z}")),
        (n, z) => n.or(z),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_probe_kind_is_read_from_the_url() {
        assert_eq!(probe_kind(DEFAULT_PROBE_URL), ProbeKind::Echo);
        assert_eq!(probe_kind("https://www.cloudflare.com/cdn-cgi/trace"), ProbeKind::Trace);
        assert_eq!(probe_kind("https://1.1.1.1/cdn-cgi/trace/"), ProbeKind::Trace);
        assert_eq!(probe_kind("https://www.google.com/generate_204"), ProbeKind::Plain);
    }

    #[test]
    fn a_probe_url_is_checked_and_empty_means_the_judge() {
        assert_eq!(probe_url_from(None).unwrap(), DEFAULT_PROBE_URL);
        assert_eq!(probe_url_from(Some("   ".into())).unwrap(), DEFAULT_PROBE_URL);
        assert_eq!(
            probe_url_from(Some(" https://www.google.com/generate_204 ".into())).unwrap(),
            "https://www.google.com/generate_204"
        );
        assert!(probe_url_from(Some("google.com".into())).is_err());
        assert!(probe_url_from(Some("ftp://x.example/".into())).is_err());
        assert_eq!(host_of("https://www.google.com/generate_204"), "www.google.com");
    }

    #[test]
    fn a_trace_page_names_the_exit() {
        let body = "fl=123\nh=www.cloudflare.com\nip=203.0.113.9\nts=1\n";
        assert_eq!(trace_ip(body).as_deref(), Some("203.0.113.9"));
        assert_eq!(trace_ip("h=x\n"), None);
    }

    #[test]
    fn rotation_rules_are_read_by_name() {
        let arg = |rule: &str, n: Option<u32>| RotationArg {
            rule: rule.to_string(),
            n,
        };
        assert_eq!(
            rotation_from(&arg("every_connection", None)).unwrap(),
            Rotation::EveryConnection
        );
        assert_eq!(rotation_from(&arg("every_n", Some(5))).unwrap(), Rotation::Every(5));
        assert_eq!(rotation_from(&arg("every_n", None)).unwrap(), Rotation::Every(10));
        assert_eq!(rotation_from(&arg("random", None)).unwrap(), Rotation::Random);
        assert_eq!(rotation_from(&arg("on_failure", None)).unwrap(), Rotation::OnFailure);
        assert!(rotation_from(&arg("sometimes", None)).is_err());
    }

    #[tokio::test]
    async fn a_list_with_unreadable_lines_keeps_the_good_ones_and_says_so() {
        let src = ConnectSource::List {
            lines: vec![
                "198.51.100.1:8080:u:p".into(),
                "".into(),
                "not a proxy".into(),
                "198.51.100.2:8080".into(),
            ],
            rotation: RotationArg {
                rule: "every_connection".into(),
                n: None,
            },
        };
        let (source, exit, notice) = build_source(src).await.unwrap();
        assert_eq!(source.size(), Some(2));
        assert!(exit.is_none());
        let notice = notice.expect("a skipped line is worth a notice");
        assert!(notice.starts_with("1 of the lines"), "{notice}");
        assert!(notice.contains("line 3"), "{notice}");
        assert!(!notice.contains("not a proxy"), "never the line itself: {notice}");
    }

    #[tokio::test]
    async fn a_list_with_nothing_readable_is_refused() {
        let src = ConnectSource::List {
            lines: vec!["nope".into()],
            rotation: RotationArg {
                rule: "random".into(),
                n: None,
            },
        };
        let err = match build_source(src).await {
            Ok(_) => panic!("a list with nothing readable must be refused"),
            Err(e) => e,
        };
        assert!(err.contains("none of the lines"), "{err}");
    }

    #[tokio::test]
    async fn a_fixed_line_builds_a_fixed_source() {
        let src = ConnectSource::Fixed {
            line: "user:pass@198.51.100.1:3128".into(),
        };
        let (source, _, notice) = build_source(src).await.unwrap();
        assert_eq!(source.kind(), SourceKind::Fixed);
        assert!(notice.is_none());
        assert!(!source.in_use_now().contains("pass"), "{}", source.in_use_now());
    }

    #[test]
    fn the_window_sends_sources_tagged_by_kind() {
        let fixed: ConnectSource = serde_json::from_str(r#"{"kind":"fixed","line":"1.2.3.4:8080"}"#).unwrap();
        assert!(matches!(fixed, ConnectSource::Fixed { .. }));
        let list: ConnectSource =
            serde_json::from_str(r#"{"kind":"list","lines":["1.2.3.4:8080"],"rotation":{"rule":"every_n","n":3}}"#)
                .unwrap();
        assert!(matches!(list, ConnectSource::List { .. }));
        let free: ConnectSource = serde_json::from_str(r#"{"kind":"free","country":"DE"}"#).unwrap();
        assert!(matches!(free, ConnectSource::Free { socks5: false, exit: None, .. }));
        let picked: ConnectSource =
            serde_json::from_str(r#"{"kind":"free","country":"DE","socks5":true,"exit":"203.0.113.9:1080"}"#).unwrap();
        match picked {
            ConnectSource::Free { exit, socks5, .. } => {
                assert_eq!(exit.as_deref(), Some("203.0.113.9:1080"));
                assert!(socks5);
            }
            _ => panic!("a picked free exit read as another kind of source"),
        }
    }

    #[test]
    fn a_picked_free_exit_becomes_an_open_upstream() {
        let up = free_upstream(" 203.0.113.9:1080 ", Scheme::Socks5).unwrap();
        assert_eq!((up.host.as_str(), up.port, up.scheme), ("203.0.113.9", 1080, Scheme::Socks5));
        assert!(up.auth.is_none());
        assert!(free_upstream("203.0.113.9", Scheme::Http).is_err());
        assert!(free_upstream("203.0.113.9:port", Scheme::Http).is_err());
        assert!(free_upstream(":8080", Scheme::Http).is_err());
        assert!(free_upstream("[]:8080", Scheme::Http).is_err());
        // IPv6 in brackets, as the Free tab and `Upstream::addr` write it.
        let v6 = free_upstream("[2001:db8::7]:3128", Scheme::Http).unwrap();
        assert_eq!((v6.host.as_str(), v6.port), ("2001:db8::7", 3128));
        assert_eq!(v6.addr(), "[2001:db8::7]:3128");
    }

    #[test]
    fn health_failures_count_up_and_reset_on_success() {
        let health = Arc::new(Mutex::new(HealthState::default()));
        let dead = |at: u64| Health {
            ok: false,
            latency_ms: None,
            exit_ip: None,
            country_code: None,
            country: None,
            city: None,
            asn_org: None,
            timezone: None,
            error: Some("no answer".into()),
            checked_at_ms: at,
            failures_in_a_row: 0,
            target: "hproxy.com".into(),
            reflects_exit: true,
        };
        record_health(&health, dead(1));
        record_health(&health, dead(2));
        assert_eq!(health.lock().unwrap().last.as_ref().unwrap().failures_in_a_row, 2);
        let mut alive = dead(3);
        alive.ok = true;
        alive.error = None;
        record_health(&health, alive);
        assert_eq!(health.lock().unwrap().last.as_ref().unwrap().failures_in_a_row, 0);
    }
}
