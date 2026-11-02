//! Connect on a computer: the connection (`hproxy_connection`, the same for
//! every door) and what only a computer has around it.
//!
//! The engine runs the relay, tests a place before it counts (proxy-engine,
//! verify.rs) and keeps probing through it. This file adds the rest:
//!
//! The system proxy setting. Once a place passed its test the setting is
//! pointed at the relay, after a snapshot of what was there, and `connect_stop`
//! puts it back exactly as found. A place that fails its test never touches the
//! setting, so a dead proxy cannot take a computer offline. The person decides
//! whether a connection takes the whole computer (Settings, the Connect page's
//! Menu), and can change it while connected.
//!
//! The kill switch (Settings). Two probes in a row failed and the proxy counts
//! as stopped. On, the setting stays: everything that follows it waits, and
//! nothing leaves on the person's own address. Off, the setting goes back for
//! now and returns the moment the proxy answers. It covers what follows the
//! system proxy setting; a program that ignores the setting never went through
//! the proxy at all.
//!
//! Telling the person. A proxy that stops changes the tray icon and, when the
//! window is not in front, says so in a notification (tray.rs).
//!
//! It connects to a place (`hproxy_places::Place`): one of the person's saved
//! proxies, one of their groups, or a free exit from the hproxy.com pool by
//! country. A saved line is read from the library here (places.rs), so the
//! window names a place by its id and never sends a password. The window and
//! the tray start a connection the same way (`start_place`).
//!
//! The snapshot is also written to the app's config directory. If the app
//! dies while connected (a crash, a forced reboot) the next start finds the
//! file, sees the system still pointing at a relay that no longer exists, and
//! restores the setting before anything else, because a machine left pointing
//! at a dead proxy has no internet and no explanation. `restore_on_exit` does
//! the same the moment the app ends, whichever way it ends.

use crate::notify::Look;
use crate::places::PlacesState;
use hproxy_api::geo::Geo;
use hproxy_api::usage::Event;
use hproxy_connection::health::{probe_url_from, Health};
use hproxy_connection::{routing_of, Built, Change, Connection, ProbePolicy, Share};
use hproxy_places::Place;
use hproxy_relay::pool::Pool;
use hproxy_relay::upstream::Upstream;
use hproxy_relay::{Login, StatsSnapshot};
use hproxy_system::{ProxySetting, RestoreOutcome, Snapshot, Support};
use serde::Serialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub use hproxy_connection::SourceInfo;

/// How many probes in a row have to fail before the proxy counts as stopped.
/// One failure is often one bad exit of a gateway, and the next probe is seconds away.
const STOPPED_AFTER: u32 = 2;

pub struct RelayState {
    connection: Connection,
    computer: Mutex<Computer>,
    /// The kill switch (Settings, While connected). On until asked otherwise.
    kill_switch: AtomicBool,
    /// "Use for the whole computer", for a connection the tray starts.
    whole_computer: AtomicBool,
    /// The proxy stopped answering (`STOPPED_AFTER`) and has not come back.
    stopped: AtomicBool,
}

/// What the connection changed on this computer.
#[derive(Default)]
struct Computer {
    /// What the setting said before: kept for as long as it points at the relay.
    system: Option<Snapshot>,
    /// The kill switch is off, the proxy stopped, and the setting went back
    /// for now: it returns when the proxy answers.
    on_own_address: bool,
    /// On a phone, the VPN that carries every app to the relay (vpn.rs): what
    /// the system proxy is on a computer.
    #[cfg(target_os = "android")]
    vpn: Option<crate::vpn::android::Running>,
}

impl Computer {
    /// Whether every program (every app, on a phone) goes through the relay.
    fn whole_device(&self) -> bool {
        #[cfg(target_os = "android")]
        return self.vpn.is_some();
        #[cfg(not(target_os = "android"))]
        self.system.is_some()
    }
}

impl RelayState {
    pub fn new(app: &AppHandle, geo: Arc<Geo>) -> Self {
        let handle = app.clone();
        Self {
            connection: Connection::new(geo, "hproxy-checker", ProbePolicy::COMPUTER, move |change| {
                heard(&handle, change);
            }),
            computer: Mutex::new(Computer::default()),
            kill_switch: AtomicBool::new(true),
            whole_computer: AtomicBool::new(true),
            stopped: AtomicBool::new(false),
        }
    }

    fn computer(&self) -> std::sync::MutexGuard<'_, Computer> {
        self.computer.lock().unwrap_or_else(|e| e.into_inner())
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

/// What the engine says on its own, from the relay's tasks.
fn heard(app: &AppHandle, change: Change) {
    match change {
        // A new place or a new exit starts with a clean slate.
        Change::Up => proxy_is_back(app, false),
        Change::Down => {}
        Change::Health(h) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { took_probe(&app, *h).await });
        }
        // The row of a saved proxy that failed its test says so.
        Change::DidNotWork { place, health } => {
            if let (Place::Proxy { id }, Some(places)) = (place, app.try_state::<PlacesState>()) {
                places.probed(&id, health.verdict());
            }
        }
        Change::Outcome { ok, why } => {
            let event = if ok {
                Event::ConnectOk
            } else {
                Event::ConnectFailed {
                    reason: why.unwrap_or("other").into(),
                }
            };
            crate::usage::count(app, event);
        }
    }
}

/// A probe's answer: the row of a saved proxy, the kill switch, and the exit's
/// zone handed to the time zone match (timezone.rs) while it is on, off the
/// async threads because Windows' `tzutil` blocks.
async fn took_probe(app: &AppHandle, h: Health) {
    let Some(state) = app.try_state::<RelayState>() else {
        return;
    };
    // A probe through a saved proxy is also the freshest word on it: its row
    // shows what the last probe found (places.rs keeps it).
    if let Some(Place::Proxy { id }) = state.connection.place() {
        if let Some(places) = app.try_state::<PlacesState>() {
            places.probed(&id, h.verdict());
        }
    }
    if h.ok {
        proxy_is_back(app, true);
    } else if h.failures_in_a_row >= STOPPED_AFTER {
        proxy_stopped(app);
    }
    let session = state.connection.status().route;
    if let (Some(session), Some(zone)) = (
        session,
        h.timezone.filter(|_| h.ok && crate::timezone::is_matching(app)),
    ) {
        let app = app.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || crate::timezone::follow_exit(&app, session, &zone)).await;
    }
}

/// The proxy stopped answering. With the kill switch off the setting goes back
/// for now; the tray and a notification say what happened either way.
fn proxy_stopped(app: &AppHandle) {
    let state = app.state::<RelayState>();
    if state.stopped.swap(true, Ordering::SeqCst) {
        return;
    }
    let held = state.kill_switch.load(Ordering::SeqCst);
    if !held {
        step_aside(app, &state);
    }
    let meaning = if held {
        "Kill switch on: nothing goes out on your own address."
    } else {
        "You are on your own address until it answers."
    };
    // The error by its name: the last probe's words.
    let error = state.connection.status().health.and_then(|h| h.error).map(sentence);
    log::warn!(
        "the proxy stopped answering; kill switch {}",
        if held { "on" } else { "off" }
    );
    crate::tray::trouble(app, true);
    let lines: Vec<&str> = error.as_deref().into_iter().chain([meaning]).collect();
    crate::tray::tell(app, "Your proxy stopped answering", &lines, Look::Stopped);
}

/// The engine's words as a sentence.
fn sentence(words: String) -> String {
    let mut letters = words.chars();
    match letters.next() {
        Some(first) => first.to_uppercase().chain(letters).collect(),
        None => words,
    }
}

/// The proxy answers again, or the connection moved to another one (`say`
/// false: nothing came back, this is something new).
fn proxy_is_back(app: &AppHandle, say: bool) {
    let Some(state) = app.try_state::<RelayState>() else {
        return;
    };
    if !state.stopped.swap(false, Ordering::SeqCst) {
        return;
    }
    step_back(app, &state);
    crate::tray::trouble(app, false);
    if say {
        crate::tray::tell(
            app,
            "Your proxy answers again",
            &["You are connected through it."],
            Look::Back,
        );
    }
}

/// The kill switch is off: the setting goes back while the proxy is away.
fn step_aside(app: &AppHandle, state: &RelayState) {
    let mut computer = state.computer();
    if computer.system.is_some() {
        computer.on_own_address = true;
        put_setting_back(app, &mut computer);
    }
}

/// The proxy answers: the setting points at the relay again.
fn step_back(app: &AppHandle, state: &RelayState) {
    let Some(listen) = state.connection.listen() else {
        return;
    };
    let mut computer = state.computer();
    if std::mem::take(&mut computer.on_own_address) {
        if let Some(e) = point_setting_at(app, &mut computer, listen) {
            log::warn!("{e}");
        }
    }
}

/// Point the operating system's proxy setting at the relay. The snapshot is on
/// disk before the change, so a crash between the two still leaves a record.
/// Words for the window when it could not be done.
fn point_setting_at(app: &AppHandle, computer: &mut Computer, listen: SocketAddr) -> Option<String> {
    match hproxy_system::support() {
        Support::Automatic { .. } => match hproxy_system::set(&listen.ip().to_string(), listen.port()) {
            Ok(snap) => {
                save_snapshot(app, &snap);
                computer.system = Some(snap);
                None
            }
            // The relay still works; the person can paste the address.
            Err(e) => Some(format!(
                "The relay is running, but the system proxy could not be set: {e}"
            )),
        },
        // Nothing to set here (a phone, a Linux desktop without GNOME). The
        // card shows the address to type in with these steps itself
        // (ConnectionCard.tsx, ProgramSettings), so a notice would say
        // them twice.
        Support::Manual { .. } => None,
    }
}

/// Put the setting back exactly as found. Words for the window when it did not go as planned.
fn put_setting_back(app: &AppHandle, computer: &mut Computer) -> Option<String> {
    let snap = computer.system.take()?;
    let words = match hproxy_system::restore(&snap) {
        Ok(RestoreOutcome::Restored) => None,
        Ok(RestoreOutcome::LeftAlone { now }) => Some(format!(
            "The system proxy setting was changed while connected ({}), so it was left as it is.",
            now.server.as_deref().unwrap_or("off")
        )),
        Err(e) => Some(format!("The system proxy could not be restored: {e}")),
    };
    clear_snapshot(app);
    words
}

/// The source behind the relay for a place: a saved proxy or group through the
/// one step every door shares (`hproxy_cli::places::source_of`, over the
/// library this app keeps), the free pool here, where its search can wait.
async fn build_source(places: &PlacesState, place: &Place) -> Result<Built, String> {
    hproxy_connection::source::build(|p| places.read(|lib| hproxy_connection::source_of(lib, p)), place).await
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
/// (src/update.rs).
pub fn is_running(app: &AppHandle) -> bool {
    app.state::<RelayState>().connection.listen().is_some()
}

/// The route in use, which names the relay's current place and exit: the time
/// zone match takes a probe's zone only from the route that is up now.
pub fn session(app: &AppHandle) -> Option<u64> {
    app.state::<RelayState>().connection.status().route
}

/// The exit's time zone from the last probe that answered, with the route,
/// while connected (timezone.rs: the setting switched on, "Match again").
pub fn exit_zone(app: &AppHandle) -> Option<(u64, String)> {
    let status = app.state::<RelayState>().connection.status();
    let zone = status.health.filter(|h| h.ok)?.timezone?;
    Some((status.route?, zone))
}

/// What a Connect uses, for the usage counts: a free proxy, a group and its rotation, the
/// system proxy setting.
fn count_place(app: &AppHandle, place: &Place, system_proxy: bool) {
    match place {
        Place::Free { .. } => {
            crate::usage::count(app, Event::FreeUsed);
            crate::usage::feature(app, "free");
        }
        Place::Group { id } => {
            crate::usage::feature(app, "groups");
            let rotates = app.try_state::<PlacesState>().is_some_and(|places| {
                places.read(|lib| {
                    lib.groups
                        .iter()
                        .any(|g| &g.id == id && g.rule != hproxy_places::Rule::OnFailure)
                })
            });
            if rotates {
                crate::usage::feature(app, "rotation");
            }
        }
        Place::Proxy { .. } => {}
    }
    if system_proxy {
        crate::usage::feature(app, "system_proxy");
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
    state.connection.stop_now();
    // The time zone, even when no relay runs any more, and only once the relay
    // is down, so a probe still finishing cannot match it again.
    match crate::timezone::restore(app) {
        Ok(Some(words)) => log::info!("{words}"),
        Ok(None) => {}
        Err(e) => log::error!("could not put the time zone back on exit: {e}"),
    }
    let mut computer = state.computer();
    computer.on_own_address = false;
    if let Some(words) = put_setting_back(app, &mut computer) {
        log::warn!("on exit: {words}");
    }
}

#[derive(Serialize, Clone)]
pub struct ConnectStatus {
    pub running: bool,
    pub listen: Option<String>,
    /// The upstream in use, as shown to a person: never the password.
    pub upstream: Option<String>,
    /// Whether the system proxy setting currently points at the relay.
    pub system_proxy: bool,
    /// The proxy stopped and the kill switch is off: programs are on the
    /// person's own address until it answers.
    pub on_own_address: bool,
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
    /// Where other devices on this network connect, while they may.
    pub network: Option<String>,
}

/// This computer's address on its network: the way out a packet would take to
/// an address outside it. A datagram socket only picks the route: nothing is sent.
fn network_address() -> Option<std::net::IpAddr> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    socket.local_addr().ok().map(|a| a.ip())
}

/// The status as it is right now, with a notice for the window.
fn status_now(state: &RelayState, notice: Option<String>) -> ConnectStatus {
    let s = state.connection.status();
    let computer = state.computer();
    ConnectStatus {
        running: s.running,
        listen: s.listen,
        upstream: s.source.as_ref().map(|source| source.in_use.clone()),
        system_proxy: computer.whole_device(),
        on_own_address: computer.on_own_address,
        support: whole_device_support(),
        notice: notice.or(s.notice),
        source: s.source,
        started_at_ms: s.started_at_ms,
        stats: s.stats,
        health: s.health,
        place: s.place,
        network: s.network.and_then(|bound| {
            let bound: SocketAddr = bound.parse().ok()?;
            Some(SocketAddr::new(network_address()?, bound.port()).to_string())
        }),
    }
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
    counted_start(&app, place, listen, system_proxy, probe_url, member).await
}

/// Call off a connect that is still testing (the switch pressed again).
#[tauri::command]
pub fn connect_cancel(state: State<'_, RelayState>) {
    state.connection.cancel();
}

/// `start_place`, counted: what the place uses. How it went is the connection's to say
/// (`Change::Outcome`); a place that could not even be built never got that far.
pub async fn counted_start(
    app: &AppHandle,
    place: Place,
    listen: Option<String>,
    system_proxy: bool,
    probe_url: Option<String>,
    member: Option<usize>,
) -> Result<ConnectStatus, String> {
    count_place(app, &place, system_proxy);
    start_place(app, place, listen, system_proxy, probe_url, member).await
}

/// Connect from outside the window (the tray, the phone's quick tile): the
/// place the window's switch would connect, your own used last and never a
/// free proxy (hproxy-places, `switch_place`), with the system proxy set (on a
/// phone, the VPN) and the probe the window asked for last. None of yours: an
/// error that says so, and the tray opens the window to add them.
pub async fn connect_picked(app: &AppHandle) -> Result<ConnectStatus, String> {
    let place = app
        .state::<PlacesState>()
        .switch_place()
        .ok_or("add your proxies in HProxy first")?;
    start_from_outside(app, place).await
}

/// A place connected from outside the window: with the choice the window keeps.
pub async fn start_from_outside(app: &AppHandle, place: Place) -> Result<ConnectStatus, String> {
    let whole = app.state::<RelayState>().whole_computer.load(Ordering::SeqCst);
    counted_start(app, place, None, whole, None, None).await
}

/// Connect to `place`, from the window or the tray.
///
/// Answers once traffic got through it, and until then nothing on this
/// computer changes: a place that fails leaves the setting, and a connection
/// already up, exactly as they were. Already connected, this is a switch: the
/// relay keeps running on its port, the system proxy setting is not touched,
/// and only the place behind the relay changes. It reconnects from scratch only
/// when the switch asks for another address. Either way the place is counted as
/// used and remembered as the pick.
pub async fn start_place(
    app: &AppHandle,
    place: Place,
    listen: Option<String>,
    system_proxy: bool,
    probe_url: Option<String>,
    member: Option<usize>,
) -> Result<ConnectStatus, String> {
    let state = app.state::<RelayState>();
    let places = app.state::<PlacesState>();
    // The probe the window asks for is kept for a connection the tray starts:
    // the tray asks for none and gets the one asked for last.
    if let Some(url) = probe_url {
        state.connection.set_probe_url(probe_url_from(Some(url))?);
    }
    let asked = listen.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let mut addr: SocketAddr = asked
        .unwrap_or(hproxy_relay::DEFAULT_LISTEN)
        .parse()
        .map_err(|_| "the listen address needs to look like 127.0.0.1:8080".to_string())?;
    hproxy_relay::check_bind(&addr, false)?;

    // The source is built before anything changes: a pool that has no exit
    // right now must not cost the person the connection they had.
    let built = build_source(&places, &place).await.inspect_err(|_| {
        crate::usage::count(app, Event::ConnectFailed { reason: "other".into() });
    })?;

    // Another address asked for: the relay moves. Stopping it puts the system
    // setting back first.
    let mut notice = None;
    if state
        .connection
        .listen()
        .is_some_and(|now| asked.is_some() && now != addr)
    {
        notice = stop_running(app, &state).await;
    }
    // The default port is a popular one (development servers live on 8080).
    // When nobody asked for a specific port and the default is taken, take a
    // free one instead of failing: the address is shown and copied from the
    // screen anyway, so which port it is does not matter to the person.
    if state.connection.listen().is_none() && asked.is_none() && std::net::TcpListener::bind(addr).is_err() {
        addr.set_port(0);
    }

    let started = state.connection.start(place.clone(), built, addr, member).await?;
    let listen_on: SocketAddr = started
        .listen
        .as_deref()
        .and_then(|l| l.parse().ok())
        .ok_or("the relay did not say where it listens")?;

    // The test passed. Now the computer.
    if let Some(words) = whole_device(app, &state, listen_on, system_proxy, started.source.as_ref()).await {
        notice = Some(words);
    }
    places.used(&place);
    crate::tray::places_changed(app);
    let status = status_now(&state, notice.or(started.notice));
    log::info!(
        "connected through {}",
        status.upstream.as_deref().unwrap_or("the relay")
    );
    crate::tray::relay_changed(app, true, status.upstream.as_deref());
    Ok(status)
}

/// Make the whole computer go through the relay, or not, whichever it does
/// now. Words for the window when it could not be done.
#[cfg(not(target_os = "android"))]
async fn whole_device(
    app: &AppHandle,
    state: &RelayState,
    listen: SocketAddr,
    wanted: bool,
    _source: Option<&SourceInfo>,
) -> Option<String> {
    let mut computer = state.computer();
    if !wanted {
        computer.on_own_address = false;
        return put_setting_back(app, &mut computer);
    }
    if computer.system.is_some() || computer.on_own_address {
        return None;
    }
    point_setting_at(app, &mut computer, listen)
}

/// On a phone, "the whole phone" is a VPN that carries every app to the relay.
/// Not allowed or refused: said, and the relay ends with the next stop.
#[cfg(target_os = "android")]
async fn whole_device(
    app: &AppHandle,
    state: &RelayState,
    listen: SocketAddr,
    wanted: bool,
    source: Option<&SourceInfo>,
) -> Option<String> {
    if !wanted || state.computer().vpn.is_some() {
        return None;
    }
    let in_use = source.map(|s| s.in_use.clone()).unwrap_or_default();
    match crate::vpn::android::start(app, listen, &in_use).await {
        Ok(vpn) => {
            state.computer().vpn = Some(vpn);
            None
        }
        Err(e) => Some(e),
    }
}

/// "Use for the whole computer" changed: while connected it happens now, and
/// the window keeps the choice for the next connection.
#[tauri::command]
pub async fn connect_set_whole_computer(
    app: AppHandle,
    state: State<'_, RelayState>,
    on: bool,
) -> Result<ConnectStatus, String> {
    state.whole_computer.store(on, Ordering::SeqCst);
    let Some(listen) = state.connection.listen() else {
        return Ok(status_now(&state, None));
    };
    let source = state.connection.status().source;
    let notice = whole_device(&app, &state, listen, on, source.as_ref()).await;
    Ok(status_now(&state, notice))
}

/// Which sites use the proxy, and the saved proxy in front of it (Settings). The
/// window sends what the person wrote: words that are no site come back as an error.
#[tauri::command]
pub fn connect_set_routing(
    state: State<'_, RelayState>,
    places: State<'_, PlacesState>,
    mode: String,
    sites: String,
    first_hop: Option<String>,
) -> Result<(), String> {
    let routing = places.read(|lib| routing_of(lib, &mode, &sites, first_hop.as_deref()))?;
    state.connection.set_routing(routing);
    Ok(())
}

/// Other devices on this network use this connection, with a login (Settings).
#[tauri::command]
pub async fn connect_set_share(
    state: State<'_, RelayState>,
    on: bool,
    port: u16,
    password: String,
) -> Result<ConnectStatus, String> {
    let share = on.then_some(Share {
        port,
        login: Login {
            username: "hproxy".into(),
            password,
        },
    });
    state.connection.share(share).await?;
    Ok(status_now(&state, None))
}

/// The kill switch (Settings). Changed while the proxy is stopped, it counts at once.
#[tauri::command]
pub fn connect_set_kill_switch(app: AppHandle, state: State<'_, RelayState>, on: bool) {
    state.kill_switch.store(on, Ordering::SeqCst);
    if state.stopped.load(Ordering::SeqCst) {
        if on {
            step_back(&app, &state);
        } else {
            step_aside(&app, &state);
        }
    }
}

#[tauri::command]
pub async fn connect_stop(app: AppHandle, state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    let notice = stop_running(&app, &state).await;
    crate::tray::relay_changed(&app, false, None);
    Ok(status_now(&state, notice))
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
    status_now(&state, None)
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
    let pool = Pool::new(country, hproxy_connection::source::scheme_of(socks5))?;
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
        scheme: hproxy_connection::source::scheme_of(socks5),
        host,
        port,
        auth: None,
        via: None,
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

/// What follows every move within the place connected through (Next IP, Back,
/// a member picked): the probe that shows where the move went, and the tray told.
async fn moved(app: &AppHandle, state: &RelayState) -> ConnectStatus {
    state.connection.probed().await;
    let status = status_now(state, None);
    crate::tray::relay_changed(app, true, status.upstream.as_deref());
    status
}

/// "Next IP": a different upstream because the person asked, the next member
/// of a list or a fresh exit from the pool. The open connections end with it,
/// so the tabs already open move to the new IP too. A fixed proxy refuses. A
/// probe follows at once so the screen shows the new exit.
#[tauri::command]
pub async fn connect_rotate(app: AppHandle, state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    state.connection.next_ip().await?;
    crate::usage::feature(&app, "new_ip");
    Ok(moved(&app, &state).await)
}

/// Next IP from outside the window (the phone's notification). The window
/// hears about it through `relay-changed`.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub async fn next_ip_from_outside(app: &AppHandle) {
    let state = app.state::<RelayState>();
    match state.connection.next_ip().await {
        Ok(_) => {
            crate::usage::feature(app, "new_ip");
            moved(app, &state).await;
        }
        Err(e) => log::warn!("next IP from outside the window: {e}"),
    }
}

/// Back: the member of the connected group before the one in use, the open
/// connections moved with it as with Next IP. Anything but a group refuses.
#[tauri::command]
pub async fn connect_back(app: AppHandle, state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    state.connection.back()?;
    Ok(moved(&app, &state).await)
}

/// One member of the connected group, by its place in the group (from 0):
/// the one in use from now, the open connections moved with it.
#[tauri::command]
pub async fn connect_member(
    app: AppHandle,
    state: State<'_, RelayState>,
    member: usize,
) -> Result<ConnectStatus, String> {
    state.connection.go_to_member(member)?;
    Ok(moved(&app, &state).await)
}

/// One probe through the relay right now, for the "Test now" button.
#[tauri::command]
pub async fn connect_probe(state: State<'_, RelayState>) -> Result<ConnectStatus, String> {
    state.connection.test_now().await?;
    Ok(status_now(&state, None))
}

pub use hproxy_connection::leak::DnsLeakView;

/// The DNS leak test through the running relay: which resolver the proxy
/// looks names up with, and where it is. The leak check runs it once a
/// connection is up and again on "Test now".
#[tauri::command]
pub async fn leak_dns(app: AppHandle, state: State<'_, RelayState>) -> Result<DnsLeakView, String> {
    crate::usage::feature(&app, "leak_checks");
    state.connection.dns_leak().await
}

/// Point the running probe somewhere else (Settings, "Connect check"), and
/// run one at once so the card shows the new target's answer. Empty means
/// back to our judge.
#[tauri::command]
pub async fn connect_set_probe(state: State<'_, RelayState>, url: Option<String>) -> Result<ConnectStatus, String> {
    state.connection.set_probe_url(probe_url_from(url)?);
    state.connection.test_now().await?;
    Ok(status_now(&state, None))
}

/// What the OS proxy setting says right now, for the panel.
#[tauri::command]
pub fn system_proxy_current() -> Result<ProxySetting, String> {
    hproxy_system::current()
}

async fn stop_running(app: &AppHandle, state: &RelayState) -> Option<String> {
    // The system setting goes back BEFORE the relay stops, so no program
    // is ever pointed at a port with nothing behind it.
    let notice = {
        let mut computer = state.computer();
        computer.on_own_address = false;
        put_setting_back(app, &mut computer)
    };
    // On a phone the VPN goes first, for the same reason: once it is
    // down, apps go out the normal way instead of into a stopped relay.
    #[cfg(target_os = "android")]
    {
        let vpn = state.computer().vpn.take();
        if let Some(vpn) = vpn {
            crate::vpn::android::stop(app, vpn).await;
        }
    }
    state.connection.stop().await;
    if state.stopped.swap(false, Ordering::SeqCst) {
        crate::tray::trouble(app, false);
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
    use hproxy_relay::SourceKind;

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
        let built = build_source(&places, &Place::Group { id: group }).await.unwrap();
        assert_eq!(built.source.size(), Some(2));
        assert!(built.exit_label.is_none());
        let notice = built.notice.expect("a skipped line is worth a notice");
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
        let source = build_source(&places, &Place::Group { id: group }).await.unwrap().source;
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
        let built = build_source(&places, &Place::Proxy { id: proxy }).await.unwrap();
        assert_eq!(built.source.kind(), SourceKind::Fixed);
        assert!(built.notice.is_none());
        assert!(
            !built.source.in_use_now().contains("pass"),
            "{}",
            built.source.in_use_now()
        );
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
}
