//! The connection: the relay on this device, kept running while the place
//! behind it changes, and the probes that say whether it really works.
//!
//! One relay at a time. `start` binds a local port with no password and
//! forwards to the place's source with the login attached; called again while
//! connected it is a switch: the port stays, only the source behind it changes
//! (`SwitchableSource`), and the open connections end so every app comes back
//! through the new place. `stop` ends the relay and every connection in it.
//!
//! A connection is tested before it counts (verify.rs). A new one: the relay
//! comes up, traffic goes through it to our judge, and `start` answers only
//! then, so a door points nothing at a proxy that does not work. A switch: a
//! short-lived trial relay carries the test, and the relay in use is left alone
//! until the new place passed, so a dead proxy never costs a working connection.
//!
//! Probes go through the relay to our judge (health.rs). Each one travels
//! through the person's own proxy and its plan, so they run when there is a
//! reason: when connecting and on every switch, when connections start
//! failing, on request, and on a slow beat while it works (`ProbePolicy`).
//! While it does not work they come quicker, so a proxy that comes back is
//! seen within seconds.
//!
//! Every probe belongs to a route: a number that changes on every switch, so
//! the answer of a probe that started before a switch never lands on the new
//! place's screen.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use hproxy_api::geo::Geo;
use hproxy_places::Place;
use hproxy_relay::{Login, Rotation, Routing, SourceKind, Stats, StatsSnapshot, SwitchableSource};
use serde::Serialize;
use tokio::sync::{oneshot, watch as signal, Notify};
use tokio::task::JoinHandle;

use crate::health::{self, Health, HealthState, DEFAULT_PROBE_URL};
use crate::leak::{self, DnsLeakView};
use crate::source::Built;
use crate::speed::{self, Speed};
use crate::verify;

/// When probes run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbePolicy {
    /// While it works, a probe this often. `None`: only when something happens.
    pub every: Option<Duration>,
    /// While it does not work, a probe this often, to see it come back.
    pub retry: Duration,
    /// After connections through the relay fail, a probe at once, but never
    /// closer together than this.
    pub after_failures: Duration,
}

impl ProbePolicy {
    /// A phone: every probe is a request through the customer's own plan, and
    /// the phone may be on mobile data. A slow beat keeps "working" true.
    pub const PHONE: ProbePolicy = ProbePolicy {
        every: Some(Duration::from_secs(300)),
        retry: Duration::from_secs(15),
        after_failures: Duration::from_secs(5),
    };

    /// A computer: the window shows the address and the round trip while
    /// connected, so they stay fresh; a proxy that stops is seen within seconds.
    pub const COMPUTER: ProbePolicy = ProbePolicy {
        every: Some(Duration::from_secs(20)),
        retry: Duration::from_secs(5),
        after_failures: Duration::from_secs(5),
    };
}

/// What changed, for whoever shows the connection.
#[derive(Debug, Clone)]
pub enum Change {
    /// The relay is up (or switched to another place).
    Up,
    /// A probe came back.
    Health(Box<Health>),
    /// A connection asked for did not pass its test, so nothing changed: the
    /// place it was for and what the test found.
    DidNotWork { place: Place, health: Box<Health> },
    /// How a connection that was asked for went (a start, a switch to another place; never Next
    /// IP or a member picked): whether it worked, and when not, why in the fixed words of the
    /// apps' usage counts (hproxy-api, `usage::FAILURES`). Once per connection.
    Outcome { ok: bool, why: Option<&'static str> },
    /// The relay is down.
    Down,
}

/// The source behind the relay, as a screen shows it.
#[derive(Debug, Serialize, Clone)]
pub struct SourceInfo {
    pub kind: SourceKind,
    /// How many upstreams it chooses from; unknown for the pool.
    pub size: Option<usize>,
    /// The group's rotation rule, as a sentence.
    pub rotation: Option<String>,
    /// The upstream in use, never with its password.
    pub in_use: String,
    /// The pool's description of the exit (place, latency).
    pub detail: Option<String>,
    pub can_rotate: bool,
    /// For a group, the member in use: its place in the group (from 0).
    pub member: Option<usize>,
}

/// The connection as it is right now.
#[derive(Debug, Serialize, Clone)]
pub struct Status {
    pub running: bool,
    pub listen: Option<String>,
    pub place: Option<Place>,
    pub source: Option<SourceInfo>,
    /// Unix milliseconds, for the time connected.
    pub started_at_ms: Option<u64>,
    pub stats: Option<StatsSnapshot>,
    /// What the last probe of the place in use found.
    pub health: Option<Health>,
    /// A message worth showing (lines of a group that were left out).
    pub notice: Option<String>,
    /// Changes on every switch.
    pub route: Option<u64>,
    /// Where other devices on this network connect, while they may.
    pub network: Option<String>,
}

/// What other devices on this network connect with (`Connection::share`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Share {
    pub port: u16,
    pub login: Login,
}

impl Status {
    fn off(notice: Option<String>) -> Status {
        Status {
            running: false,
            listen: None,
            place: None,
            source: None,
            started_at_ms: None,
            stats: None,
            health: None,
            notice,
            route: None,
            network: None,
        }
    }
}

/// A relay running on this device.
struct Relay {
    listen: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
}

impl Relay {
    /// Listen on `listen` and forward through `source`. Answers once the port
    /// is open, with the port it really got.
    async fn up(listen: SocketAddr, source: &Arc<SwitchableSource>, stats: &Arc<Stats>) -> Result<Relay, String> {
        Relay::listening(listen, None, source, stats).await
    }

    /// The same relay for the other devices on this network, with its login.
    async fn for_network(share: Share, source: &Arc<SwitchableSource>, stats: &Arc<Stats>) -> Result<Relay, String> {
        let everywhere: SocketAddr = ([0, 0, 0, 0], share.port).into();
        Relay::listening(everywhere, Some(share.login), source, stats).await
    }

    async fn listening(
        listen: SocketAddr,
        login: Option<Login>,
        source: &Arc<SwitchableSource>,
        stats: &Arc<Stats>,
    ) -> Result<Relay, String> {
        let (stop, stopped) = oneshot::channel::<()>();
        let (ready_tx, ready) = oneshot::channel::<Result<SocketAddr, String>>();
        let task = {
            let source = Arc::clone(source);
            let stats = Arc::clone(stats);
            tokio::spawn(async move {
                let mut ready = Some(ready_tx);
                let on_ready = |bound| {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(bound));
                    }
                };
                let until_stopped = async {
                    let _ = stopped.await;
                };
                let r = match login {
                    Some(login) => {
                        hproxy_relay::serve_network(listen, login, source, stats, on_ready, until_stopped).await
                    }
                    None => hproxy_relay::serve(listen, false, false, source, stats, on_ready, until_stopped).await,
                };
                if let (Err(e), Some(tx)) = (&r, ready.take()) {
                    let _ = tx.send(Err(e.clone()));
                }
                r
            })
        };
        match ready.await {
            Ok(Ok(listen)) => Ok(Relay {
                listen,
                stop: Some(stop),
                task,
            }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("the relay stopped before it could say where it listens".into()),
        }
    }

    /// Ask it to end, not waiting for it.
    fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }

    async fn down(mut self) {
        self.stop();
        let _ = self.task.await;
    }
}

struct Running {
    place: Place,
    relay: Relay,
    /// The same relay for other devices, while they may use it.
    network: Option<Relay>,
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    exit_label: Option<String>,
    started_at_ms: u64,
    route: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    /// Rung for a probe at once: a move within the place.
    poke: Arc<Notify>,
    watcher: JoinHandle<()>,
}

/// The handles a change needs, taken under the lock and used after it.
struct Live {
    listen: SocketAddr,
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    route: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    poke: Arc<Notify>,
}

impl Live {
    fn of(r: &Running) -> Live {
        Live {
            listen: r.relay.listen,
            source: Arc::clone(&r.source),
            stats: Arc::clone(&r.stats),
            route: Arc::clone(&r.route),
            health: Arc::clone(&r.health),
            poke: Arc::clone(&r.poke),
        }
    }
}

/// Routes are numbered across the whole process, so a probe of a relay
/// already stopped can never pass for one of the relay running now.
static NEXT_ROUTE: AtomicU64 = AtomicU64::new(1);

/// Start a new route: what the last probe found belongs to the old one.
fn start_route(route: &AtomicU64, health: &Mutex<HealthState>) -> u64 {
    let n = NEXT_ROUTE.fetch_add(1, Ordering::SeqCst);
    route.store(n, Ordering::SeqCst);
    *health.lock().unwrap_or_else(|e| e.into_inner()) = HealthState::default();
    n
}

type OnChange = Arc<dyn Fn(Change) + Send + Sync>;

/// What a start answers when `cancel`, `stop` or a newer start called it off.
pub const CALLED_OFF: &str = "called off";

/// Why a start ended without a connection.
struct NotStarted {
    /// For the person.
    words: String,
    /// In the fixed words of the usage counts; `None`: nobody failed, it was called off.
    why: Option<&'static str>,
    /// What the test found, when it got that far.
    health: Option<Health>,
}

impl NotStarted {
    /// Before any test: a port taken, a member that is not there.
    fn before_the_test(words: String) -> NotStarted {
        NotStarted {
            words,
            why: Some("other"),
            health: None,
        }
    }

    fn called_off() -> NotStarted {
        NotStarted {
            words: CALLED_OFF.to_string(),
            why: None,
            health: None,
        }
    }
}

pub struct Connection {
    inner: Mutex<Option<Running>>,
    geo: Arc<Geo>,
    program: String,
    policy: ProbePolicy,
    on_change: OnChange,
    /// Where probes go. Kept between connections: a door sets it once.
    probe_url: Arc<Mutex<String>>,
    /// How connections travel. Kept between connections.
    routing: Mutex<Routing>,
    /// What other devices connect with, when the person shares.
    share: Mutex<Option<Share>>,
    /// One start at a time.
    starting: tokio::sync::Mutex<()>,
    /// Moves on to call off the start under way.
    give_up: signal::Sender<u64>,
}

impl Connection {
    /// `program` names this door in our servers' logs; `on_change` hears every
    /// change (from the relay's own tasks too).
    pub fn new(
        geo: Arc<Geo>,
        program: &str,
        policy: ProbePolicy,
        on_change: impl Fn(Change) + Send + Sync + 'static,
    ) -> Connection {
        Connection {
            inner: Mutex::new(None),
            geo,
            program: program.to_string(),
            policy,
            on_change: Arc::new(on_change),
            probe_url: Arc::new(Mutex::new(DEFAULT_PROBE_URL.to_string())),
            routing: Mutex::new(Routing::default()),
            share: Mutex::new(None),
            starting: tokio::sync::Mutex::new(()),
            give_up: signal::channel(0).0,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Running>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn live(&self) -> Option<Live> {
        self.lock().as_ref().map(Live::of)
    }

    /// Where the relay listens, while it runs.
    pub fn listen(&self) -> Option<SocketAddr> {
        self.lock().as_ref().map(|r| r.relay.listen)
    }

    /// The place connected through, while connected.
    pub fn place(&self) -> Option<Place> {
        self.lock().as_ref().map(|r| r.place.clone())
    }

    /// Where probes go from now on, this connection and the next.
    pub fn set_probe_url(&self, url: String) {
        *self.probe_url.lock().unwrap_or_else(|e| e.into_inner()) = url;
        // The test always goes through the proxy, wherever it goes now.
        self.set_routing(self.routing_now());
    }

    fn routing_now(&self) -> Routing {
        self.routing.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// How connections travel from now on (hproxy-relay, routes.rs): this
    /// connection, at once, and the next. The connection's own test always goes
    /// through the proxy, whatever the rules say: around it, a dead proxy would
    /// pass.
    pub fn set_routing(&self, mut routing: Routing) {
        routing.sites = routing.sites.tested_at(&health::host_of(&url_of(&self.probe_url)));
        let mut kept = self.routing.lock().unwrap_or_else(|e| e.into_inner());
        if *kept == routing {
            return;
        }
        *kept = routing.clone();
        drop(kept);
        if let Some(live) = self.live() {
            live.source.set_routing(routing);
        }
    }

    /// Let the other devices on this network use this connection, with a login,
    /// or stop letting them. It needs a connection to share: kept until there is
    /// one, and it ends with it.
    pub async fn share(&self, share: Option<Share>) -> Result<(), String> {
        *self.share.lock().unwrap_or_else(|e| e.into_inner()) = share;
        let old = self.lock().as_mut().and_then(|r| r.network.take());
        if let Some(old) = old {
            old.down().await;
        }
        self.open_network().await
    }

    async fn open_network(&self) -> Result<(), String> {
        let share = self.share.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let (Some(share), Some(live)) = (share, self.live()) else {
            return Ok(());
        };
        let relay = Relay::for_network(share, &live.source, &live.stats).await?;
        let gone = {
            let mut running = self.lock();
            match running.as_mut() {
                Some(r) => {
                    r.network = Some(relay);
                    None
                }
                None => Some(relay),
            }
        };
        if let Some(relay) = gone {
            relay.down().await;
        }
        Ok(())
    }

    /// Call off a start that is testing. It answers `CALLED_OFF`, and nothing changed.
    pub fn cancel(&self) {
        self.give_up.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// Connect to `place` through `built` (source.rs), the relay on `listen`
    /// (port 0 picks a free one); a group starts on `member` (its place in
    /// the group, from 0) when one is given, and stays on it. Already
    /// connected, this is a switch in place: same port, the open connections
    /// end and come back through the new place.
    ///
    /// Answers once traffic got through the place (verify.rs). An error means
    /// nothing changed: no relay is left behind, and on a switch the place in
    /// use goes on as it was. A newer start takes over from one still testing.
    pub async fn start(
        &self,
        place: Place,
        built: Built,
        listen: SocketAddr,
        member: Option<usize>,
    ) -> Result<Status, String> {
        self.cancel();
        let _one_at_a_time = self.starting.lock().await;
        let mut called_off = self.give_up.subscribe();
        match self
            .start_now(place.clone(), built, listen, member, &mut called_off)
            .await
        {
            Ok(status) => Ok(status),
            Err(no) => {
                if let Some(health) = no.health {
                    (self.on_change)(Change::DidNotWork {
                        place,
                        health: Box::new(health),
                    });
                }
                if no.why.is_some() {
                    (self.on_change)(Change::Outcome { ok: false, why: no.why });
                }
                Err(no.words)
            }
        }
    }

    async fn start_now(
        &self,
        place: Place,
        built: Built,
        listen: SocketAddr,
        member: Option<usize>,
        called_off: &mut signal::Receiver<u64>,
    ) -> Result<Status, NotStarted> {
        hproxy_relay::check_bind(&listen, false).map_err(NotStarted::before_the_test)?;
        if let Some(m) = member {
            built.source.go_to_line(m).map_err(NotStarted::before_the_test)?;
        }
        let Built {
            source,
            exit_label,
            notice,
        } = built;
        let source = Arc::new(SwitchableSource::new(source));
        source.set_routing(self.routing_now());
        let stats = Arc::new(Stats::default());
        // A member asked for by number is the one wanted: tested as it is, never swapped.
        let may_move = member.is_none();

        if let Some(live) = self.live() {
            let trial: SocketAddr = ([127, 0, 0, 1], 0).into();
            let relay = Relay::up(trial, &source, &stats)
                .await
                .map_err(NotStarted::before_the_test)?;
            let tested = self
                .first_test(relay.listen, &source, &stats, may_move, called_off)
                .await;
            relay.down().await;
            return Ok(self.switched(live, place, &source, exit_label, notice, tested?));
        }

        let relay = Relay::up(listen, &source, &stats)
            .await
            .map_err(NotStarted::before_the_test)?;
        let first = match self
            .first_test(relay.listen, &source, &stats, may_move, called_off)
            .await
        {
            Ok(first) => first,
            Err(no) => {
                relay.down().await;
                return Err(no);
            }
        };

        let bound = relay.listen;
        let health = Arc::new(Mutex::new(HealthState::default()));
        let route = Arc::new(AtomicU64::new(0));
        start_route(&route, &health);
        let first = health::record(&health, first);
        let poke = Arc::new(Notify::new());
        let watcher = tokio::spawn(watch(Watch {
            listen: bound,
            geo: Arc::clone(&self.geo),
            program: self.program.clone(),
            policy: self.policy,
            stats: Arc::clone(&stats),
            route: Arc::clone(&route),
            health: Arc::clone(&health),
            probe_url: Arc::clone(&self.probe_url),
            poke: Arc::clone(&poke),
            on_change: Arc::clone(&self.on_change),
        }));
        log::info!(
            "connected: {:?} source through {}, relay on {bound}",
            source.current().kind(),
            source.current().in_use_now()
        );
        let running = Running {
            place,
            relay,
            network: None,
            source,
            stats,
            exit_label,
            started_at_ms: crate::now_ms(),
            route,
            health,
            poke,
            watcher,
        };
        let mut status = status_of(Some(&running));
        status.notice = notice;
        *self.lock() = Some(running);
        self.tell_it_works(first);
        if let Err(e) = self.open_network().await {
            log::warn!("the network could not be let in: {e}");
        }
        status.network = self.status().network;
        Ok(status)
    }

    /// The test a connection has to pass: through `listen`, moving on within
    /// a group or the free pool, one more try where that can change the answer.
    async fn first_test(
        &self,
        listen: SocketAddr,
        source: &SwitchableSource,
        stats: &Stats,
        may_move: bool,
        called_off: &mut signal::Receiver<u64>,
    ) -> Result<Health, NotStarted> {
        let url = url_of(&self.probe_url);
        let test = async {
            let mut moves = 0;
            let mut tried_again = false;
            loop {
                let mut h = health::probe_once(listen, &self.geo, &url, &self.program).await;
                if h.ok {
                    return Ok(h);
                }
                let failed = stats.take_failure();
                let why = failed.map(|f| f.why);
                if may_move && moves < verify::MOVES && source.current().can_rotate() {
                    moves += 1;
                    if source.next_ip().await.is_ok() {
                        continue;
                    }
                } else if !tried_again && verify::worth_another_try(&h, why) {
                    tried_again = true;
                    continue;
                }
                let words = verify::failure_words(&h, failed.as_ref());
                let word = h
                    .error
                    .as_deref()
                    .and_then(health::failure_word)
                    .or_else(|| why.map(hproxy_relay::Why::as_str))
                    .unwrap_or("other");
                log::info!("the first test failed: {words}");
                h.error = Some(words.clone());
                return Err(NotStarted {
                    words,
                    why: Some(word),
                    health: Some(h),
                });
            }
        };
        tokio::select! {
            tested = test => tested,
            _ = called_off.changed() => Err(NotStarted::called_off()),
        }
    }

    /// The test passed: everyone hears it.
    fn tell_it_works(&self, first: Health) {
        (self.on_change)(Change::Up);
        (self.on_change)(Change::Health(Box::new(first)));
        (self.on_change)(Change::Outcome { ok: true, why: None });
    }

    /// The place that passed its test goes behind the running relay.
    fn switched(
        &self,
        live: Live,
        place: Place,
        source: &SwitchableSource,
        exit_label: Option<String>,
        notice: Option<String>,
        first: Health,
    ) -> Status {
        let described = source.current().in_use_now();
        live.source.adopt(source);
        live.stats.rotated();
        {
            let mut guard = self.lock();
            if let Some(r) = guard.as_mut() {
                r.exit_label = exit_label;
                r.place = place;
            }
        }
        // A connection of its own: an older failure is not its own.
        live.stats.take_failure();
        start_route(&live.route, &live.health);
        let first = health::record(&live.health, first);
        log::info!("switched in place to {described}, relay still on {}", live.listen);
        self.tell_it_works(first);
        let mut status = self.status();
        status.notice = notice;
        status
    }

    /// End the relay and every connection in it, and call off a start that is testing.
    pub async fn stop(&self) {
        self.cancel();
        let running = self.lock().take();
        let Some(mut r) = running else { return };
        r.watcher.abort();
        if let Some(network) = r.network.take() {
            network.down().await;
        }
        r.relay.stop();
        let _ = (&mut r.relay.task).await;
        log::info!("disconnected");
        (self.on_change)(Change::Down);
    }

    /// The same without waiting: the process is ending and nothing asynchronous
    /// gets to run any more.
    pub fn stop_now(&self) {
        self.cancel();
        if let Some(mut r) = self.lock().take() {
            r.watcher.abort();
            r.relay.stop();
            if let Some(network) = r.network.as_mut() {
                network.stop();
            }
        }
    }

    pub fn status(&self) -> Status {
        status_of(self.lock().as_ref())
    }

    /// A probe right now, its answer in the status that comes back.
    pub async fn test_now(&self) -> Result<Status, String> {
        let live = self.live().ok_or("not connected")?;
        let url = url_of(&self.probe_url);
        probe_route(&self.watch_of(live), &url).await;
        Ok(self.status())
    }

    /// The status once the first probe of the route in use landed (after a
    /// move within the place), or after as long as a probe may take.
    pub async fn probed(&self) -> Status {
        let until = Instant::now() + health::PROBE_TIMEOUT + Duration::from_secs(3);
        loop {
            let status = self.status();
            if status.health.is_some() || !status.running || Instant::now() >= until {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// What a probe needs, from the running relay's handles.
    fn watch_of(&self, live: Live) -> Watch {
        Watch {
            listen: live.listen,
            geo: Arc::clone(&self.geo),
            program: self.program.clone(),
            policy: self.policy,
            stats: live.stats,
            route: live.route,
            health: live.health,
            probe_url: Arc::clone(&self.probe_url),
            poke: live.poke,
            on_change: Arc::clone(&self.on_change),
        }
    }

    /// Another upstream within the place (the next member of a group, a fresh
    /// free exit); the open connections move with it. A single proxy refuses.
    pub async fn next_ip(&self) -> Result<Status, String> {
        let live = self.live().ok_or("not connected")?;
        let label = live.source.next_ip().await?;
        self.moved(live, label);
        Ok(self.status())
    }

    /// The member of the connected group before the one in use. Anything but
    /// a group refuses.
    pub fn back(&self) -> Result<Status, String> {
        let live = self.live().ok_or("not connected")?;
        let label = live.source.previous_ip()?;
        self.moved(live, label);
        Ok(self.status())
    }

    /// One member of the connected group, by its place in the group (from 0).
    pub fn go_to_member(&self, member: usize) -> Result<Status, String> {
        let live = self.live().ok_or("not connected")?;
        let label = live.source.go_to_line(member)?;
        self.moved(live, label);
        Ok(self.status())
    }

    fn moved(&self, live: Live, label: String) {
        live.stats.rotated();
        let is_pool = live.source.current().kind() == SourceKind::Pool;
        if let Some(r) = self.lock().as_mut() {
            r.exit_label = is_pool.then_some(label);
        }
        start_route(&live.route, &live.health);
        live.poke.notify_one();
        (self.on_change)(Change::Up);
    }

    /// Which resolver the proxy looks names up with.
    pub async fn dns_leak(&self) -> Result<DnsLeakView, String> {
        let listen = self.listen().ok_or("not connected")?;
        Ok(leak::dns_leak(listen, &self.geo, &self.program).await)
    }

    /// How fast a download through the relay is.
    pub async fn speed(&self) -> Result<Speed, String> {
        let listen = self.listen().ok_or("not connected")?;
        speed::measure(listen, &self.program).await
    }
}

fn status_of(running: Option<&Running>) -> Status {
    let Some(r) = running else { return Status::off(None) };
    let source = r.source.current();
    Status {
        running: true,
        listen: Some(r.relay.listen.to_string()),
        place: Some(r.place.clone()),
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
        notice: None,
        route: Some(r.route.load(Ordering::SeqCst)),
        network: r.network.as_ref().map(|n| n.listen.to_string()),
    }
}

fn url_of(probe_url: &Mutex<String>) -> String {
    probe_url
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string())
}

/// One probe, kept only if the route is still the one it started on.
async fn probe_route(w: &Watch, url: &str) {
    let at = w.route.load(Ordering::SeqCst);
    // A failure from before this probe says nothing about it.
    w.stats.take_failure();
    let mut h = health::probe_once(w.listen, &w.geo, url, &w.program).await;
    if !h.ok {
        h.error = Some(verify::failure_words(&h, w.stats.take_failure().as_ref()));
    }
    if w.route.load(Ordering::SeqCst) == at {
        let h = health::record(&w.health, h);
        (w.on_change)(Change::Health(Box::new(h)));
    }
}

/// What the watcher needs.
struct Watch {
    listen: SocketAddr,
    geo: Arc<Geo>,
    program: String,
    policy: ProbePolicy,
    stats: Arc<Stats>,
    route: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    probe_url: Arc<Mutex<String>>,
    poke: Arc<Notify>,
    on_change: OnChange,
}

/// How often the watcher looks at the relay's counters.
const LOOK_EVERY: Duration = Duration::from_secs(2);

/// Probes for as long as the relay runs, whenever there is a reason
/// (ProbePolicy). The test that let the connection up was the first one.
async fn watch(w: Watch) {
    let mut failures = w.stats.snapshot().failures;
    loop {
        let probed = Instant::now();
        loop {
            let ok = w
                .health
                .lock()
                .ok()
                .and_then(|h| h.last.as_ref().map(|l| l.ok))
                .unwrap_or(false);
            tokio::select! {
                _ = w.poke.notified() => break,
                _ = tokio::time::sleep(LOOK_EVERY) => {}
            }
            let now = w.stats.snapshot().failures;
            let failing = now > failures;
            failures = now;
            if failing && probed.elapsed() >= w.policy.after_failures {
                break;
            }
            let due = if ok { w.policy.every } else { Some(w.policy.retry) };
            if due.is_some_and(|d| probed.elapsed() >= d) {
                break;
            }
        }
        let url = url_of(&w.probe_url);
        probe_route(&w, &url).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_relay::{List, Rotation, Source};
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// A probe that never leaves this machine: the fake proxies below answer it themselves.
    const LOCAL_PROBE: &str = "http://judge.invalid/";

    const OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    const BAD: &[u8] = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    /// A proxy that answers the first `failures` requests with 502 and the rest
    /// with 200, and counts them.
    async fn proxy_failing_first(failures: usize) -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&requests);
        tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let count = Arc::clone(&count);
                tokio::spawn(async move {
                    read_head(&mut client).await;
                    let seen = count.fetch_add(1, Ordering::SeqCst);
                    let _ = client.write_all(if seen < failures { BAD } else { OK }).await;
                });
            }
        });
        (addr, requests)
    }

    async fn working_proxy() -> (SocketAddr, Arc<AtomicUsize>) {
        proxy_failing_first(0).await
    }

    /// A proxy that takes the connection and then says nothing, ever.
    async fn silent_proxy() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut kept = Vec::new();
            while let Ok((client, _)) = listener.accept().await {
                kept.push(client);
            }
        });
        addr
    }

    /// A port with nothing behind it: every connection through it is refused.
    fn dead_port() -> SocketAddr {
        std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
    }

    async fn read_head(s: &mut TcpStream) -> String {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            match s.read(&mut byte).await {
                Ok(1) => head.push(byte[0]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&head).into_owned()
    }

    const QUIET: ProbePolicy = ProbePolicy {
        every: None,
        retry: Duration::from_secs(3600),
        after_failures: Duration::from_secs(3600),
    };

    fn connection(changes: Arc<AtomicUsize>) -> Connection {
        let c = Connection::new(Arc::new(Geo::new("")), "hproxy-test", QUIET, move |_| {
            changes.fetch_add(1, Ordering::SeqCst);
        });
        c.set_probe_url(LOCAL_PROBE.into());
        c
    }

    fn built(line: &str) -> Built {
        Built {
            source: Source::Fixed(hproxy_relay::upstream::parse(line).unwrap()),
            exit_label: None,
            notice: None,
        }
    }

    fn group(lines: &[String]) -> Built {
        let members = lines
            .iter()
            .map(|l| hproxy_relay::upstream::parse(l).unwrap())
            .collect();
        Built {
            source: Source::List(List::new(members, Rotation::OnFailure).unwrap()),
            exit_label: None,
            notice: None,
        }
    }

    fn place(id: &str) -> Place {
        Place::Proxy { id: id.into() }
    }

    fn any_port() -> SocketAddr {
        "127.0.0.1:0".parse().unwrap()
    }

    #[tokio::test]
    async fn a_dead_proxy_is_refused_and_leaves_nothing_behind() {
        type Seen = Vec<(bool, Option<&'static str>)>;
        let outcomes: Arc<Mutex<Seen>> = Arc::new(Mutex::new(Vec::new()));
        let failed: Arc<Mutex<Vec<Place>>> = Arc::new(Mutex::new(Vec::new()));
        let (seen, gone) = (Arc::clone(&outcomes), Arc::clone(&failed));
        let c = Connection::new(
            Arc::new(Geo::new("")),
            "hproxy-test",
            QUIET,
            move |change| match change {
                Change::Outcome { ok, why } => seen.lock().unwrap().push((ok, why)),
                Change::DidNotWork { place, .. } => gone.lock().unwrap().push(place),
                _ => {}
            },
        );
        c.set_probe_url(LOCAL_PROBE.into());
        let err = c
            .start(place("a"), built(&dead_port().to_string()), any_port(), None)
            .await
            .unwrap_err();
        assert_eq!(err, "connection refused: nothing answers at that address");
        assert!(!c.status().running, "no connection after a failed test");
        assert!(c.listen().is_none(), "and no relay left listening");
        assert_eq!(
            *outcomes.lock().unwrap(),
            vec![(false, Some("refused"))],
            "said once, with why"
        );
        assert_eq!(
            *failed.lock().unwrap(),
            vec![place("a")],
            "the place hears what the test found"
        );
    }

    #[tokio::test]
    async fn a_connection_counts_only_after_traffic_got_through() {
        let (proxy, requests) = working_proxy().await;
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let status = c
            .start(place("a"), built(&proxy.to_string()), any_port(), None)
            .await
            .unwrap();
        assert!(status.running);
        assert!(requests.load(Ordering::SeqCst) >= 1, "the test went through the proxy");
        assert!(
            c.status().health.is_some_and(|h| h.ok),
            "what the test found is on the card"
        );
        c.stop().await;
    }

    #[tokio::test]
    async fn one_bad_answer_of_a_gateway_gets_a_second_try() {
        let (proxy, requests) = proxy_failing_first(1).await;
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let status = c.start(place("a"), built(&proxy.to_string()), any_port(), None).await;
        assert!(status.is_ok(), "{:?}", status.err());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        c.stop().await;
    }

    #[tokio::test]
    async fn a_group_moves_past_its_dead_members_before_it_answers() {
        let (proxy, _) = working_proxy().await;
        let lines = [dead_port().to_string(), dead_port().to_string(), proxy.to_string()];
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let status = c.start(place("g"), group(&lines), any_port(), None).await.unwrap();
        assert_eq!(
            status.source.unwrap().member,
            Some(2),
            "it stands on the one that worked"
        );
        c.stop().await;
    }

    #[tokio::test]
    async fn a_member_picked_by_number_stays_the_one_in_use() {
        let (first, _) = working_proxy().await;
        let (second, _) = working_proxy().await;
        let lines = [first.to_string(), second.to_string()];
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let status = c.start(place("g"), group(&lines), any_port(), Some(1)).await.unwrap();
        assert_eq!(status.source.unwrap().member, Some(1));
        c.stop().await;
    }

    #[tokio::test]
    async fn a_switch_to_a_dead_proxy_leaves_the_working_one_alone() {
        let (good, requests) = working_proxy().await;
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let first = c
            .start(place("good"), built(&good.to_string()), any_port(), None)
            .await
            .unwrap();
        let port = c.listen().unwrap().port();

        let err = c
            .start(place("dead"), built(&dead_port().to_string()), any_port(), None)
            .await;
        assert!(err.is_err(), "the dead one is refused");

        let now = c.status();
        assert!(now.running, "the connection carries on");
        assert_eq!(now.place, Some(place("good")));
        assert_eq!(now.route, first.route, "nothing moved");
        assert_eq!(c.listen().unwrap().port(), port);
        let before = requests.load(Ordering::SeqCst);
        c.test_now().await.unwrap();
        assert!(
            requests.load(Ordering::SeqCst) > before,
            "and traffic still goes through the good one"
        );
        c.stop().await;
    }

    #[tokio::test]
    async fn a_switch_that_passes_keeps_one_port_and_says_so() {
        let changes = Arc::new(AtomicUsize::new(0));
        let c = connection(Arc::clone(&changes));
        let (a, _) = working_proxy().await;
        let (b, b_requests) = working_proxy().await;

        let first = c
            .start(place("a"), built(&a.to_string()), any_port(), None)
            .await
            .unwrap();
        assert!(first.running);
        let port = c.listen().unwrap().port();
        assert_ne!(port, 0);
        let route = first.route.unwrap();
        assert!(
            TcpStream::connect(c.listen().unwrap()).await.is_ok(),
            "the relay listens"
        );

        let second = c
            .start(place("b"), built(&b.to_string()), any_port(), None)
            .await
            .unwrap();
        assert_eq!(c.listen().unwrap().port(), port, "a switch keeps the port");
        assert!(second.route.unwrap() > route, "a switch starts a new route");
        assert!(second.source.unwrap().in_use.contains(&b.to_string()));
        assert_eq!(second.place, Some(place("b")));
        assert!(second.health.is_some_and(|h| h.ok), "its first test is on the card");
        let tested = b_requests.load(Ordering::SeqCst);
        assert!(tested >= 1);
        c.test_now().await.unwrap();
        assert!(
            b_requests.load(Ordering::SeqCst) > tested,
            "traffic now goes through the new one"
        );

        c.stop().await;
        assert!(!c.status().running);
        assert!(c.listen().is_none());
        assert!(
            changes.load(Ordering::SeqCst) >= 3,
            "up, switched and down were all told"
        );
    }

    #[tokio::test]
    async fn a_test_can_be_called_off() {
        let silent = silent_proxy().await;
        let c = Arc::new(connection(Arc::new(AtomicUsize::new(0))));
        let starting = {
            let c = Arc::clone(&c);
            tokio::spawn(async move { c.start(place("a"), built(&silent.to_string()), any_port(), None).await })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        c.cancel();
        let answer = tokio::time::timeout(Duration::from_secs(3), starting)
            .await
            .expect("calling it off does not wait for the proxy")
            .unwrap();
        assert_eq!(answer.unwrap_err(), CALLED_OFF);
        assert!(c.listen().is_none());
    }

    #[tokio::test]
    async fn a_public_address_is_refused() {
        let c = connection(Arc::new(AtomicUsize::new(0)));
        let err = c
            .start(
                place("a"),
                built("198.51.100.1:8080"),
                "0.0.0.0:0".parse().unwrap(),
                None,
            )
            .await
            .unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        assert!(!c.status().running);
    }

    #[tokio::test]
    async fn a_proxy_that_stops_later_shows_in_the_next_probe() {
        let c = connection(Arc::new(AtomicUsize::new(0)));
        // It works once, for the first test and nothing more.
        let proxy = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                if let Ok((mut client, _)) = listener.accept().await {
                    read_head(&mut client).await;
                    let _ = client.write_all(OK).await;
                }
            });
            addr
        };
        c.start(place("a"), built(&proxy.to_string()), any_port(), None)
            .await
            .unwrap();
        let after = c.test_now().await.unwrap();
        let h = after.health.expect("the probe answered");
        assert!(!h.ok);
        assert!(h.error.is_some());
        assert_eq!(h.failures_in_a_row, 1);
        assert!(
            after.running,
            "a connection that is up stays up: the door decides what follows"
        );
        c.stop().await;
    }

    #[tokio::test]
    async fn moving_within_a_single_proxy_is_refused_and_nothing_is_running_to_test() {
        let (proxy, _) = working_proxy().await;
        let c = connection(Arc::new(AtomicUsize::new(0)));
        assert!(c.test_now().await.is_err());
        c.start(place("a"), built(&proxy.to_string()), any_port(), None)
            .await
            .unwrap();
        assert!(c.next_ip().await.is_err(), "a single proxy has no other IP");
        assert!(c.go_to_member(1).is_err());
        assert!(c.back().is_err());
        c.stop().await;
    }

    #[tokio::test]
    async fn a_probe_address_set_once_holds_for_every_connection() {
        let (proxy, _) = working_proxy().await;
        let c = connection(Arc::new(AtomicUsize::new(0)));
        c.set_probe_url("http://other.invalid/".into());
        c.start(place("a"), built(&proxy.to_string()), any_port(), None)
            .await
            .unwrap();
        assert_eq!(c.status().health.unwrap().target, "other.invalid");
        c.stop().await;
        c.start(place("a"), built(&proxy.to_string()), any_port(), None)
            .await
            .unwrap();
        assert_eq!(c.status().health.unwrap().target, "other.invalid");
        c.stop().await;
    }
}
