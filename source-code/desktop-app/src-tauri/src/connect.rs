//! Connect: the relay and the system proxy setting, driven from the window.
//!
//! One relay at a time. `connect_start` binds a local port with no password,
//! forwards to the chosen source with the login attached, and, when asked,
//! points the operating system's proxy setting at it after taking a snapshot
//! of what was there. `connect_stop` puts the setting back exactly as found
//! and ends the relay. `connect_status` says what is running.
//!
//! It connects to a place (`hproxy_places::Place`): one of the person's saved
//! proxies, one of their groups (moved through by its rule: the same member
//! until it dies, every N minutes, every connection, every N connections, at
//! random), or a free exit from the hproxy.com pool by country. A saved line
//! is read from the library here (places.rs), so the window names a place by
//! its id and never sends a password. The relay's `Source` owns rotation and
//! failover; this file builds it from the place. The window and the tray start
//! a connection the same way (`start_place`).
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
use crate::places::{place_words, PlacesState};
use hproxy_api::geo::Geo;
use hproxy_places::{Place, Verdict};
use hproxy_relay::pool::Pool;
use hproxy_relay::upstream::Upstream;
use hproxy_relay::{Rotation, Source, SourceKind, Stats, StatsSnapshot, SwitchableSource};
use hproxy_system::{ProxySetting, RestoreOutcome, Snapshot, Support};
use serde::Serialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// How often the relay is probed while connected.
const PROBE_EVERY: Duration = Duration::from_secs(20);
/// The default probe target, our TLS judge, and the helpers a probe uses:
/// one copy for every door (proxy-engine/hproxy-connection, health.rs).
pub use hproxy_connection::health::DEFAULT_PROBE_URL;
use hproxy_connection::health::{probe_url_from, Health, HealthState};

#[derive(Default)]
pub struct RelayState {
    inner: Mutex<Option<Running>>,
    /// The probe target the window asked for last (Settings, "Connect
    /// check"), so a connection the tray starts probes the same way.
    last_probe_url: Mutex<Option<String>>,
}

struct Running {
    /// The place connected through: what the window and the tray name.
    place: Place,
    listen: SocketAddr,
    /// What the relay forwards through. Switching places replaces what is in
    /// it while the port stays open (`switch_in_place`).
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    /// The pool's own description of the exit in use (place and latency), or
    /// nothing for the other sources.
    exit_label: Option<String>,
    started_at_ms: u64,
    /// The route in use: a new number whenever the place or the exit changes
    /// (a switch, "Next IP"). A probe that started on an earlier route is not
    /// recorded, and the time zone match takes its zone only from this one.
    route: Arc<AtomicU64>,
    /// Whether the system proxy was asked for when connecting. A switch that
    /// asks the same happens in place; one that asks otherwise reconnects.
    system_wanted: bool,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tauri::async_runtime::JoinHandle<Result<(), String>>,
    probe: tauri::async_runtime::JoinHandle<()>,
    health: Arc<Mutex<HealthState>>,
    /// Where the probe goes; the loop reads it on every tick.
    probe_url: Arc<Mutex<String>>,
    system: Option<Snapshot>,
    /// On a phone, the VPN that carries every app to the relay (vpn.rs): what
    /// the system proxy is on a computer.
    #[cfg(target_os = "android")]
    vpn: Option<crate::vpn::android::Running>,
}

impl Running {
    /// Whether every program (every app, on a phone) goes through the relay.
    fn whole_device(&self) -> bool {
        #[cfg(target_os = "android")]
        return self.vpn.is_some();
        #[cfg(not(target_os = "android"))]
        self.system.is_some()
    }
}

/// Whether this device can be sent through the relay from here: on a phone by
/// the VPN, on a computer by its system proxy setting.
fn whole_device_support() -> Support {
    #[cfg(target_os = "android")]
    return Support::Automatic {
        how: "a VPN on this phone: every app goes through the relay".into(),
    };
    #[cfg(not(target_os = "android"))]
    hproxy_system::support()
}

/// Routes are numbered across the whole run, so a probe of a relay already
/// stopped can never pass for one of the relay running now.
static NEXT_ROUTE: AtomicU64 = AtomicU64::new(1);

/// Start a new route: what the last probe found belongs to the old one, so it
/// goes, and the card shows nothing stale while the first probe of the new
/// place is under way.
fn start_route(route: &AtomicU64, health: &Mutex<HealthState>) -> u64 {
    let n = NEXT_ROUTE.fetch_add(1, Ordering::SeqCst);
    route.store(n, Ordering::SeqCst);
    if let Ok(mut h) = health.lock() {
        *h = HealthState::default();
    }
    n
}

/// One probe through the relay, recorded only if the route is still the one
/// it started on: a probe of the place switched away from must not land on
/// the card of the new one, nor set the time zone to the old exit's.
async fn probe_route(
    app: &AppHandle,
    geo: &Geo,
    listen: SocketAddr,
    url: &str,
    route: &AtomicU64,
    health: &Arc<Mutex<HealthState>>,
) {
    let at = route.load(Ordering::SeqCst);
    let h = probe_once(listen, geo, url).await;
    if route.load(Ordering::SeqCst) == at {
        took_probe(app, at, health, h).await;
    }
}

/// The handles a switch needs from the running relay, taken under the lock
/// and used after it is let go.
struct Live {
    listen: SocketAddr,
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    route: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    probe_url: Arc<Mutex<String>>,
}

impl Live {
    fn of(r: &Running) -> Self {
        Self {
            listen: r.listen,
            source: Arc::clone(&r.source),
            stats: Arc::clone(&r.stats),
            route: Arc::clone(&r.route),
            health: Arc::clone(&r.health),
            probe_url: Arc::clone(&r.probe_url),
        }
    }

    fn probe_url(&self) -> String {
        self.probe_url
            .lock()
            .map(|u| u.clone())
            .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string())
    }
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
    /// For a group, the member in use: its place in the group (from 0), the
    /// number `places_group_members` gives it.
    pub member: Option<usize>,
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
    /// The place connected through, whoever started it (the window or the tray).
    pub place: Option<Place>,
}

use hproxy_connection::source::scheme_of;

/// Build the relay's source for a place: a saved proxy or group through the
/// one step every door shares (`hproxy_cli::places::source_of`, over the
/// library this app keeps), the free pool here, where its search can wait.
/// Returns it with the pool's exit description and a notice about lines that
/// were skipped, when there are any.
async fn build_source(places: &PlacesState, place: &Place) -> Result<(Source, Option<String>, Option<String>), String> {
    let built =
        hproxy_connection::source::build(|p| places.read(|lib| hproxy_connection::source_of(lib, p)), place).await?;
    Ok((built.source, built.exit_label, built.notice))
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

/// The route in use, which names the relay's current place and exit: the time
/// zone match takes a probe's zone only from the route that is up now.
pub fn session(app: &AppHandle) -> Option<u64> {
    app.state::<RelayState>()
        .inner
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.route.load(Ordering::SeqCst)))
}

/// The exit's time zone from the last probe that answered, with the route,
/// while connected (timezone.rs: the setting switched on, "Match again").
pub fn exit_zone(app: &AppHandle) -> Option<(u64, String)> {
    let state = app.state::<RelayState>();
    let guard = state.inner.lock().ok()?;
    let r = guard.as_ref()?;
    let health = r.health.lock().ok()?;
    let zone = health.last.as_ref().filter(|h| h.ok)?.timezone.clone()?;
    Some((r.route.load(Ordering::SeqCst), zone))
}

/// The place the running relay goes through, if one runs.
fn connected_place(app: &AppHandle) -> Option<Place> {
    let state = app.try_state::<RelayState>()?;
    let guard = state.inner.lock().ok()?;
    guard.as_ref().map(|r| r.place.clone())
}

/// What a probe through a saved proxy says about it, the way its row shows it.
fn verdict_of_health(h: &Health) -> Verdict {
    Verdict {
        ok: h.ok,
        latency_ms: h.latency_ms,
        cc: h.country_code.as_deref().map(str::to_ascii_lowercase),
        place: place_words(h.city.as_deref(), h.country.as_deref()),
        exit_ip: h.exit_ip.clone(),
        anonymity: None,
        // A live probe went through the relay itself: `ok` already means it
        // carried traffic, and there is no check row to read words from.
        says: None,
        tone: None,
        way: None,
        datacenter: h.datacenter,
        at: h.checked_at_ms,
    }
}

/// A probe's answer: kept for the card, and the exit's zone handed to the
/// time zone match (timezone.rs) while it is on, off the async threads
/// because Windows' `tzutil` blocks.
async fn took_probe(app: &AppHandle, session: u64, health: &Arc<Mutex<HealthState>>, h: Health) {
    let zone = if h.ok { h.timezone.clone() } else { None };
    // A probe through a saved proxy is also the freshest word on it: its row
    // shows what the last probe found (places.rs keeps it).
    if let Some(Place::Proxy { id }) = connected_place(app) {
        if let Some(places) = app.try_state::<PlacesState>() {
            places.probed(&id, verdict_of_health(&h));
        }
    }
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
        Some(r) => {
            let source = r.source.current();
            ConnectStatus {
                running: true,
                listen: Some(r.listen.to_string()),
                upstream: Some(source.in_use_now()),
                system_proxy: r.whole_device(),
                support: whole_device_support(),
                notice,
                source: Some(SourceInfo {
                    kind: source.kind(),
                    size: source.size(),
                    rotation: source.rotation().map(Rotation::describe),
                    in_use: source.in_use_now(),
                    detail: r.exit_label.clone(),
                    can_rotate: source.can_rotate(),
                    member: source.line_in_use(),
                }),
                started_at_ms: Some(r.started_at_ms),
                stats: Some(r.stats.snapshot()),
                health: r.health.lock().ok().and_then(|h| h.last.clone()),
                place: Some(r.place.clone()),
            }
        }
        None => ConnectStatus {
            running: false,
            listen: None,
            upstream: None,
            system_proxy: false,
            support: whole_device_support(),
            notice,
            source: None,
            started_at_ms: None,
            stats: None,
            health: None,
            place: None,
        },
    }
}

/// One probe through the relay to `url` (hproxy-connection, health.rs).
async fn probe_once(listen: SocketAddr, geo: &Geo, url: &str) -> Health {
    hproxy_connection::health::probe_once(listen, geo, url, "hproxy-checker").await
}

fn record_health(health: &Arc<Mutex<HealthState>>, h: Health) {
    hproxy_connection::health::record(health, h);
}

/// The window's Connect: connect to `place` on `listen` (default
/// `127.0.0.1:8080`; port 0 picks a free port), with the system proxy set when
/// `system_proxy` is true; a group starts on `member` when one is given (its
/// place in the group, from 0). See `start_place`.
#[tauri::command]
pub async fn connect_start(
    app: AppHandle,
    place: Place,
    listen: Option<String>,
    system_proxy: bool,
    probe_url: Option<String>,
    member: Option<usize>,
) -> Result<ConnectStatus, String> {
    start_place(&app, place, listen, system_proxy, probe_url, member).await
}

/// Connect from outside the window (the tray, the phone's quick tile): the
/// place picked last, with the system proxy set (on a phone, the VPN) and the
/// probe the window asked for last. Nothing picked yet: an error that says so,
/// and the tray opens the window to pick one.
pub async fn connect_picked(app: &AppHandle) -> Result<ConnectStatus, String> {
    let place = app
        .state::<PlacesState>()
        .picked()
        .ok_or("pick a place in HProxy first")?;
    start_place(app, place, None, true, None, None).await
}

/// Connect to `place`, from the window or the tray.
///
/// Already connected, this is a switch: the relay keeps running on its port,
/// the system proxy setting is not touched, and only the place behind the
/// relay changes (`switch_in_place`). It reconnects from scratch only when the
/// switch asks for another address or another answer about the system proxy.
/// Either way the place is counted as used and remembered as the pick.
pub async fn start_place(
    app: &AppHandle,
    place: Place,
    listen: Option<String>,
    system_proxy: bool,
    probe_url: Option<String>,
    member: Option<usize>,
) -> Result<ConnectStatus, String> {
    let state = app.state::<RelayState>();
    let app_state = app.state::<AppState>();
    let places = app.state::<PlacesState>();
    // The probe the window asks for is remembered for a connection the tray
    // starts; the tray asks for none and gets the one asked for last.
    let probe_url = match probe_url {
        Some(url) => {
            if let Ok(mut last) = state.last_probe_url.lock() {
                *last = Some(url.clone());
            }
            Some(url)
        }
        None => state.last_probe_url.lock().ok().and_then(|l| l.clone()),
    };
    let probe_url = probe_url_from(probe_url)?;
    let asked = listen.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut addr: SocketAddr = asked
        .unwrap_or(hproxy_relay::DEFAULT_LISTEN)
        .parse()
        .map_err(|_| "the listen address needs to look like 127.0.0.1:8080".to_string())?;
    hproxy_relay::check_bind(&addr, false)?;

    // The source is built before anything changes: a pool that has no exit
    // right now must not cost the person the connection they had.
    let (source, exit_label, mut notice) = build_source(&places, &place).await?;
    // A group started on the member the person picked carries the very first
    // connection through it.
    if let Some(member) = member {
        source.go_to_line(member)?;
    }

    let live = state.inner.lock().ok().and_then(|guard| {
        guard
            .as_ref()
            .filter(|r| (asked.is_none() || r.listen == addr) && r.system_wanted == system_proxy)
            .map(Live::of)
    });
    if let Some(live) = live {
        places.used(&place);
        crate::tray::places_changed(app);
        return Ok(switch_in_place(
            app,
            &state,
            &app_state.geo,
            live,
            place,
            source,
            exit_label,
            notice,
            probe_url,
        )
        .await);
    }

    let probe_url = Arc::new(Mutex::new(probe_url));
    let source = Arc::new(SwitchableSource::new(source));
    let stats = Arc::new(Stats::default());

    // One relay at a time keeps "which proxy am I on" a question with one
    // answer. Stopping the old one restores the system setting first.
    stop_running(app, &state).await;

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
                    save_snapshot(app, &snap);
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

    // On a phone, "the whole phone" is a VPN that carries every app to the
    // relay. Not allowed or refused: no connection at all, never a relay that
    // only this app uses while the card says "connected".
    #[cfg(target_os = "android")]
    let vpn = if system_proxy {
        match crate::vpn::android::start(app, bound, &source.current().in_use_now()).await {
            Ok(vpn) => Some(vpn),
            Err(e) => {
                let _ = stop_tx.send(());
                let _ = task.await;
                return Err(e);
            }
        }
    } else {
        None
    };

    // The first probe runs at once, so the exit address is on the screen
    // within a second or two of connecting; then every PROBE_EVERY.
    let started_at_ms = now_ms();
    let health = Arc::new(Mutex::new(HealthState::default()));
    let route = Arc::new(AtomicU64::new(0));
    start_route(&route, &health);
    let probe = {
        let health = Arc::clone(&health);
        let route = Arc::clone(&route);
        let geo = Arc::clone(&app_state.geo);
        let probe_url = Arc::clone(&probe_url);
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let url = probe_url
                    .lock()
                    .map(|u| u.clone())
                    .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string());
                probe_route(&app, &geo, bound, &url, &route, &health).await;
                tokio::time::sleep(PROBE_EVERY).await;
            }
        })
    };

    let now = source.current();
    log::info!(
        "connected: {:?} source through {}, listening on {bound}",
        now.kind(),
        now.in_use_now()
    );
    places.used(&place);
    let running = Running {
        place,
        listen: bound,
        source,
        stats,
        exit_label,
        started_at_ms,
        route,
        system_wanted: system_proxy,
        stop: Some(stop_tx),
        task,
        probe,
        health,
        probe_url,
        system,
        #[cfg(target_os = "android")]
        vpn,
    };
    let status = status_of(Some(&running), notice);
    if let Ok(mut inner) = state.inner.lock() {
        *inner = Some(running);
    }
    crate::tray::relay_changed(app, true, status.upstream.as_deref());
    crate::tray::places_changed(app);
    Ok(status)
}

/// A switch while connected: the new place goes behind the running relay.
/// The port stays, the system proxy setting stays as it is (so no program
/// ever goes out on the person's own address in between), and the open
/// connections end so every program comes back through the new place. A
/// probe follows at once, so the card names the new exit within a second or two.
#[allow(clippy::too_many_arguments)]
async fn switch_in_place(
    app: &AppHandle,
    state: &RelayState,
    geo: &Geo,
    live: Live,
    place: Place,
    source: Source,
    exit_label: Option<String>,
    notice: Option<String>,
    probe_url: String,
) -> ConnectStatus {
    let described = source.in_use_now();
    live.source.replace(source);
    live.stats.rotated();
    if let Ok(mut url) = live.probe_url.lock() {
        *url = probe_url.clone();
    }
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(r) = guard.as_mut() {
            r.exit_label = exit_label;
            r.place = place;
        }
    }
    start_route(&live.route, &live.health);
    log::info!("switched in place to {described}, still listening on {}", live.listen);
    probe_route(app, geo, live.listen, &probe_url, &live.route, &live.health).await;
    let status = status_now(state, notice);
    crate::tray::relay_changed(app, true, status.upstream.as_deref());
    status
}

/// The status as it is right now, with a notice for the window.
fn status_now(state: &RelayState, notice: Option<String>) -> ConnectStatus {
    let guard = state.inner.lock().ok();
    status_of(guard.as_ref().and_then(|g| g.as_ref()), notice)
}

#[tauri::command]
pub async fn connect_stop(app: AppHandle, state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    let notice = stop_running(&app, &state).await;
    crate::tray::relay_changed(&app, false, None);
    Ok(status_of(None, notice))
}

/// Disconnect from outside the window: the tray icon, the phone's
/// notification or quick tile, Android taking the VPN back. The same stop as
/// the window's; the window hears it through `relay-changed`.
pub async fn stop_from_outside(app: &AppHandle) {
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

/// One country of the free pool on the Free tab's country menu.
#[derive(Serialize)]
pub struct FreeCountry {
    pub code: String,
    /// Exits of every protocol, untested.
    pub count: u64,
}

/// Every country the free pool has exits in, the most first: the Free tab's
/// country menu (`hproxy_relay::pool::countries`).
#[tauri::command]
pub async fn free_countries() -> Result<Vec<FreeCountry>, String> {
    Ok(hproxy_relay::pool::countries()
        .await?
        .into_iter()
        .map(|c| FreeCountry {
            code: c.code,
            count: c.count,
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

/// "Next IP": a different upstream because the person asked, the next member
/// of a list or a fresh exit from the pool. The open connections end with it,
/// so the tabs already open move to the new IP too. A fixed proxy refuses. A
/// probe follows at once so the screen shows the new exit.
#[tauri::command]
pub async fn connect_rotate(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<ConnectStatus, String> {
    let live = live_now(&state)?;
    let label = live.source.next_ip().await?;
    Ok(moved(&app, &state, &app_state.geo, live, label).await)
}

/// Next IP from outside the window (the phone's notification). The window
/// hears about it through `relay-changed`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub async fn next_ip_from_outside(app: &AppHandle) {
    let state = app.state::<RelayState>();
    let app_state = app.state::<AppState>();
    let live = match live_now(&state) {
        Ok(live) => live,
        Err(_) => return,
    };
    match live.source.next_ip().await {
        Ok(label) => {
            moved(app, &state, &app_state.geo, live, label).await;
        }
        Err(e) => log::warn!("next IP from outside the window: {e}"),
    }
}

/// Back: the member of the connected group before the one in use, the open
/// connections moved with it as with Next IP. Anything but a group refuses.
#[tauri::command]
pub async fn connect_back(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<ConnectStatus, String> {
    let live = live_now(&state)?;
    let label = live.source.previous_ip()?;
    Ok(moved(&app, &state, &app_state.geo, live, label).await)
}

/// One member of the connected group, by its place in the group (from 0):
/// the one in use from now, the open connections moved with it.
#[tauri::command]
pub async fn connect_member(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
    member: usize,
) -> Result<ConnectStatus, String> {
    let live = live_now(&state)?;
    let label = live.source.go_to_line(member)?;
    Ok(moved(&app, &state, &app_state.geo, live, label).await)
}

/// The running relay, for a command that changes what is behind it.
fn live_now(state: &RelayState) -> Result<Live, String> {
    let guard = state
        .inner
        .lock()
        .map_err(|_| "the relay state is unavailable".to_string())?;
    Ok(Live::of(guard.as_ref().ok_or("not connected")?))
}

/// What follows every move within the place connected through (Next IP,
/// Back, a member picked): the pool's description of its new exit kept, a
/// probe at once so the screen shows where the move went, and the tray told.
async fn moved(app: &AppHandle, state: &RelayState, geo: &Geo, live: Live, label: String) -> ConnectStatus {
    live.stats.rotated();
    let is_pool = live.source.current().kind() == SourceKind::Pool;
    if let Ok(mut guard) = state.inner.lock() {
        if let Some(r) = guard.as_mut() {
            r.exit_label = is_pool.then_some(label);
        }
    }
    start_route(&live.route, &live.health);
    probe_route(app, geo, live.listen, &live.probe_url(), &live.route, &live.health).await;
    let status = status_now(state, None);
    crate::tray::relay_changed(app, true, status.upstream.as_deref());
    status
}

/// One probe through the relay right now, for the "Test now" button.
#[tauri::command]
pub async fn connect_probe(
    app: AppHandle,
    state: State<'_, RelayState>,
    app_state: State<'_, AppState>,
) -> Result<ConnectStatus, String> {
    let live = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        Live::of(guard.as_ref().ok_or("not connected")?)
    };
    probe_route(
        &app,
        &app_state.geo,
        live.listen,
        &live.probe_url(),
        &live.route,
        &live.health,
    )
    .await;
    Ok(connect_status(state))
}

pub use hproxy_connection::leak::DnsLeakView;

/// The DNS leak test through the running relay: which resolver the proxy
/// looks names up with, and where it is. The leak check runs it once a
/// connection is up and again on "Test now".
#[tauri::command]
pub async fn leak_dns(state: State<'_, RelayState>, app_state: State<'_, AppState>) -> Result<DnsLeakView, String> {
    let listen = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        guard.as_ref().ok_or("not connected")?.listen
    };
    Ok(hproxy_connection::leak::dns_leak(listen, &app_state.geo, "hproxy-checker").await)
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
    let live = {
        let guard = state
            .inner
            .lock()
            .map_err(|_| "the relay state is unavailable".to_string())?;
        let r = guard.as_ref().ok_or("not connected")?;
        if let Ok(mut u) = r.probe_url.lock() {
            *u = url.clone();
        }
        Live::of(r)
    };
    probe_route(&app, &app_state.geo, live.listen, &url, &live.route, &live.health).await;
    Ok(connect_status(state))
}

/// What the OS proxy setting says right now, for the panel.
#[tauri::command]
pub fn system_proxy_current() -> Result<ProxySetting, String> {
    hproxy_system::current()
}

async fn stop_running(app: &AppHandle, state: &RelayState) -> Option<String> {
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
        // On a phone the VPN goes first, for the same reason: once it is
        // down, apps go out the normal way instead of into a stopped relay.
        #[cfg(target_os = "android")]
        if let Some(vpn) = r.vpn.take() {
            crate::vpn::android::stop(app, vpn).await;
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
    use hproxy_places::Rule;

    #[test]
    fn a_new_route_is_a_new_number_and_forgets_what_the_old_one_found() {
        let route = AtomicU64::new(0);
        let health = Arc::new(Mutex::new(HealthState::default()));
        let first = start_route(&route, &health);
        record_health(&health, health_of(true));
        assert!(health.lock().unwrap().last.is_some());

        let second = start_route(&route, &health);
        assert!(second > first, "routes only ever count up");
        assert_eq!(route.load(Ordering::SeqCst), second);
        assert!(
            health.lock().unwrap().last.is_none(),
            "the card must not show the old place's exit after a switch"
        );
    }

    fn health_of(ok: bool) -> Health {
        Health {
            ok,
            latency_ms: None,
            exit_ip: None,
            country_code: None,
            country: None,
            city: None,
            asn_org: None,
            datacenter: None,
            timezone: None,
            latitude: None,
            longitude: None,
            error: None,
            checked_at_ms: 1,
            failures_in_a_row: 0,
            target: "hproxy.com".into(),
            reflects_exit: true,
        }
    }

    /// A library with one saved proxy and one group, the group's lines as
    /// given (a group moved in from the window's storage may hold anything).
    fn places_with(proxy: &str, group: &[&str], rule: Rule) -> (PlacesState, String, String) {
        let mut lib = hproxy_places::Library::default();
        let proxy_id = lib.add_proxies(&[proxy.to_string()], 1).remove(0);
        lib.groups.push(hproxy_places::Group {
            id: "g1".into(),
            name: "G".into(),
            lines: group.iter().map(|s| s.to_string()).collect(),
            rule,
            n: None,
            added_at: 1,
            last_used_at: 0,
            uses: 0,
            summary: Default::default(),
            expires: None,
            note: None,
        });
        (PlacesState::with(lib), proxy_id, "g1".into())
    }

    #[tokio::test]
    async fn a_group_with_unreadable_lines_keeps_the_good_ones_and_says_so() {
        let (places, _, group) = places_with(
            "198.51.100.9:8080",
            &["198.51.100.1:8080:u:p", "", "not a proxy", "198.51.100.2:8080"],
            Rule::EveryConnection,
        );
        let (source, exit, notice) = build_source(&places, &Place::Group { id: group }).await.unwrap();
        assert_eq!(source.size(), Some(2));
        assert!(exit.is_none());
        let notice = notice.expect("a skipped line is worth a notice");
        assert!(notice.starts_with("1 of the lines"), "{notice}");
        assert!(notice.contains("line 3"), "{notice}");
        assert!(!notice.contains("not a proxy"), "never the line itself: {notice}");
    }

    #[tokio::test]
    async fn a_member_keeps_its_number_in_the_group_when_lines_before_it_were_left_out() {
        // A SOCKS4 line reads as a proxy but the relay cannot use it: lines 0
        // and 3 are members, and the window numbers them 0 and 3, as
        // places_group_members does.
        let (places, _, group) = places_with(
            "198.51.100.9:8080",
            &[
                "198.51.100.1:8080",
                "socks4://198.51.100.2:1080",
                "not a proxy",
                "198.51.100.4:8080",
            ],
            Rule::OnFailure,
        );
        let (source, _, _) = build_source(&places, &Place::Group { id: group }).await.unwrap();
        assert_eq!(source.size(), Some(2));
        assert_eq!(source.line_in_use(), Some(0));
        assert!(source.go_to_line(3).unwrap().contains("198.51.100.4"));
        assert_eq!(source.line_in_use(), Some(3));
        let refused = source.go_to_line(1).unwrap_err();
        assert!(refused.contains("proxy 2 of the group"), "{refused}");
    }

    #[tokio::test]
    async fn a_group_with_nothing_readable_is_refused() {
        let (places, _, group) = places_with("198.51.100.9:8080", &["nope"], Rule::Random);
        let err = match build_source(&places, &Place::Group { id: group }).await {
            Ok(_) => panic!("a group with nothing readable must be refused"),
            Err(e) => e,
        };
        assert!(err.contains("none of the lines"), "{err}");
    }

    #[tokio::test]
    async fn a_saved_proxy_builds_a_fixed_source_from_the_library() {
        let (places, proxy, _) = places_with("user:pass@198.51.100.1:3128", &["198.51.100.2:8080"], Rule::OnFailure);
        let (source, _, notice) = build_source(&places, &Place::Proxy { id: proxy }).await.unwrap();
        assert_eq!(source.kind(), SourceKind::Fixed);
        assert!(notice.is_none());
        assert!(!source.in_use_now().contains("pass"), "{}", source.in_use_now());
    }

    #[tokio::test]
    async fn a_place_that_is_gone_says_so() {
        let (places, _, _) = places_with("198.51.100.1:3128", &["198.51.100.2:8080"], Rule::OnFailure);
        assert!(build_source(&places, &Place::Proxy { id: "gone".into() })
            .await
            .is_err());
        assert!(build_source(&places, &Place::Group { id: "gone".into() })
            .await
            .is_err());
    }

    #[test]
    fn the_window_names_a_place_by_kind_and_id() {
        let proxy: Place = serde_json::from_str(r#"{"kind":"proxy","id":"abc"}"#).unwrap();
        assert_eq!(proxy, Place::Proxy { id: "abc".into() });
        let group: Place = serde_json::from_str(r#"{"kind":"group","id":"g1"}"#).unwrap();
        assert_eq!(group, Place::Group { id: "g1".into() });
        let free: Place = serde_json::from_str(r#"{"kind":"free","country":"DE"}"#).unwrap();
        assert!(matches!(
            free,
            Place::Free {
                socks5: false,
                exit: None,
                ..
            }
        ));
        let picked: Place = serde_json::from_str(
            r#"{"kind":"free","country":"DE","socks5":true,"exit":"203.0.113.9:1080","exitCountry":"DE"}"#,
        )
        .unwrap();
        match picked {
            Place::Free {
                exit,
                socks5,
                exit_country,
                ..
            } => {
                assert_eq!(exit.as_deref(), Some("203.0.113.9:1080"));
                assert!(socks5);
                assert_eq!(exit_country.as_deref(), Some("DE"));
            }
            _ => panic!("a picked free exit read as another kind of place"),
        }
    }

    #[test]
    fn a_probe_becomes_the_verdict_on_a_saved_proxys_row() {
        let mut h = health_of(true);
        h.latency_ms = Some(140);
        h.exit_ip = Some("203.0.113.9".into());
        h.country_code = Some("DE".into());
        h.country = Some("Germany".into());
        h.city = Some("Berlin".into());
        let v = verdict_of_health(&h);
        assert!(v.ok);
        assert_eq!(v.cc.as_deref(), Some("de"));
        assert_eq!(v.place.as_deref(), Some("Berlin, Germany"));
        assert_eq!(v.at, h.checked_at_ms);
    }
}
