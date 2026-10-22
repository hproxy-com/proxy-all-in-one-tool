//! The connection: the relay on this device, kept running while the place
//! behind it changes, and the probes that say whether it really works.
//!
//! One relay at a time. `start` binds a local port with no password and
//! forwards to the place's source with the login attached; called again while
//! connected it is a switch: the port stays, only the source behind it changes
//! (`SwitchableSource`), and the open connections end so every app comes back
//! through the new place. `stop` ends the relay and every connection in it.
//!
//! Probes go through the relay to our judge (health.rs). Each one travels
//! through the person's own proxy and its plan, so they run when there is a
//! reason: at once on connecting and on every switch, when connections start
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
use hproxy_relay::{Rotation, SourceKind, Stats, StatsSnapshot, SwitchableSource};
use serde::Serialize;
use tokio::sync::{oneshot, Notify};
use tokio::task::JoinHandle;

use crate::health::{self, Health, HealthState, DEFAULT_PROBE_URL};
use crate::leak::{self, DnsLeakView};
use crate::source::Built;
use crate::speed::{self, Speed};

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
}

/// What changed, for whoever shows the connection.
#[derive(Debug, Clone)]
pub enum Change {
    /// The relay is up (or switched to another place).
    Up,
    /// A probe came back.
    Health(Box<Health>),
    /// The first probe of a connection that was asked for (a start, a switch to another place;
    /// never Next IP or a member picked): whether it worked, and when not, why in the fixed
    /// words of the apps' usage counts (hproxy-api, `usage::FAILURES`). Once per connection.
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
        }
    }
}

struct Running {
    place: Place,
    listen: SocketAddr,
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    exit_label: Option<String>,
    started_at_ms: u64,
    route: Arc<AtomicU64>,
    /// The route whose first probe is the outcome of a connection asked for (`Change::Outcome`).
    outcome: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    probe_url: Arc<Mutex<String>>,
    /// Rung for a probe at once: a switch, a request.
    poke: Arc<Notify>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<Result<(), String>>,
    watcher: JoinHandle<()>,
}

/// The handles a change needs, taken under the lock and used after it.
struct Live {
    listen: SocketAddr,
    source: Arc<SwitchableSource>,
    stats: Arc<Stats>,
    route: Arc<AtomicU64>,
    outcome: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    probe_url: Arc<Mutex<String>>,
    poke: Arc<Notify>,
}

impl Live {
    fn of(r: &Running) -> Live {
        Live {
            listen: r.listen,
            source: Arc::clone(&r.source),
            stats: Arc::clone(&r.stats),
            route: Arc::clone(&r.route),
            outcome: Arc::clone(&r.outcome),
            health: Arc::clone(&r.health),
            probe_url: Arc::clone(&r.probe_url),
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

pub struct Connection {
    inner: Mutex<Option<Running>>,
    geo: Arc<Geo>,
    program: String,
    policy: ProbePolicy,
    on_change: OnChange,
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
        self.lock().as_ref().map(|r| r.listen)
    }

    /// The place connected through, while connected.
    pub fn place(&self) -> Option<Place> {
        self.lock().as_ref().map(|r| r.place.clone())
    }

    /// Connect to `place` through `built` (source.rs), the relay on `listen`
    /// (port 0 picks a free one); a group starts on `member` (its place in
    /// the group, from 0) when one is given. Already connected, this is a
    /// switch in place: same port, the open connections end and come back
    /// through the new place.
    pub async fn start(
        &self,
        place: Place,
        built: Built,
        listen: SocketAddr,
        member: Option<usize>,
    ) -> Result<Status, String> {
        hproxy_relay::check_bind(&listen, false)?;
        if let Some(m) = member {
            built.source.go_to_line(m)?;
        }
        if let Some(live) = self.live() {
            return Ok(self.switch_in_place(live, place, built));
        }

        let source = Arc::new(SwitchableSource::new(built.source));
        let stats = Arc::new(Stats::default());
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<SocketAddr, String>>();
        let task = {
            let source = Arc::clone(&source);
            let stats = Arc::clone(&stats);
            tokio::spawn(async move {
                let mut ready = Some(ready_tx);
                let r = hproxy_relay::serve(
                    listen,
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
            Err(_) => return Err("the relay stopped before it could say where it listens".into()),
        };

        let health = Arc::new(Mutex::new(HealthState::default()));
        let route = Arc::new(AtomicU64::new(0));
        let outcome = Arc::new(AtomicU64::new(start_route(&route, &health)));
        let probe_url = Arc::new(Mutex::new(DEFAULT_PROBE_URL.to_string()));
        let poke = Arc::new(Notify::new());
        let watcher = tokio::spawn(watch(Watch {
            listen: bound,
            geo: Arc::clone(&self.geo),
            program: self.program.clone(),
            policy: self.policy,
            stats: Arc::clone(&stats),
            route: Arc::clone(&route),
            outcome: Arc::clone(&outcome),
            health: Arc::clone(&health),
            probe_url: Arc::clone(&probe_url),
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
            listen: bound,
            source,
            stats,
            exit_label: built.exit_label,
            started_at_ms: crate::now_ms(),
            route,
            outcome,
            health,
            probe_url,
            poke,
            stop: Some(stop_tx),
            task,
            watcher,
        };
        let mut status = status_of(Some(&running));
        status.notice = built.notice;
        *self.lock() = Some(running);
        (self.on_change)(Change::Up);
        Ok(status)
    }

    /// The new place behind the running relay; a probe of it follows at once.
    fn switch_in_place(&self, live: Live, place: Place, built: Built) -> Status {
        let described = built.source.in_use_now();
        live.source.replace(built.source);
        live.stats.rotated();
        {
            let mut guard = self.lock();
            if let Some(r) = guard.as_mut() {
                r.exit_label = built.exit_label;
                r.place = place;
            }
        }
        // A connection of its own: its first probe is its outcome, and an older failure is not its own.
        live.stats.take_why();
        live.outcome
            .store(start_route(&live.route, &live.health), Ordering::SeqCst);
        live.poke.notify_one();
        log::info!("switched in place to {described}, relay still on {}", live.listen);
        (self.on_change)(Change::Up);
        let mut status = self.status();
        status.notice = built.notice;
        status
    }

    /// End the relay and every connection in it.
    pub async fn stop(&self) {
        let running = self.lock().take();
        let Some(mut r) = running else { return };
        r.watcher.abort();
        if let Some(stop) = r.stop.take() {
            let _ = stop.send(());
        }
        let _ = r.task.await;
        log::info!("disconnected");
        (self.on_change)(Change::Down);
    }

    pub fn status(&self) -> Status {
        status_of(self.lock().as_ref())
    }

    /// A probe right now, its answer in the status that comes back.
    pub async fn test_now(&self) -> Result<Status, String> {
        let live = self.live().ok_or("not connected")?;
        let url = url_of(&live.probe_url);
        probe_route(&self.watch_of(live), &url).await;
        Ok(self.status())
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
            outcome: live.outcome,
            health: live.health,
            probe_url: live.probe_url,
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
        listen: Some(r.listen.to_string()),
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
    }
}

fn url_of(probe_url: &Mutex<String>) -> String {
    probe_url
        .lock()
        .map(|u| u.clone())
        .unwrap_or_else(|_| DEFAULT_PROBE_URL.to_string())
}

/// One probe, kept only if the route is still the one it started on. The first of a connection
/// asked for is also its outcome (`Change::Outcome`): why it failed in the probe's own words, else
/// in the relay's, which saw the proxy behind it fail (hproxy-relay, `Stats::take_why`).
async fn probe_route(w: &Watch, url: &str) {
    let at = w.route.load(Ordering::SeqCst);
    let h = health::probe_once(w.listen, &w.geo, url, &w.program).await;
    if w.route.load(Ordering::SeqCst) == at {
        let h = health::record(&w.health, h);
        let first = w
            .outcome
            .compare_exchange(at, 0, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        let outcome = first.then(|| Change::Outcome {
            ok: h.ok,
            why: (!h.ok).then(|| {
                h.error
                    .as_deref()
                    .and_then(health::failure_word)
                    .or_else(|| w.stats.take_why().map(hproxy_relay::Why::as_str))
                    .unwrap_or("other")
            }),
        });
        (w.on_change)(Change::Health(Box::new(h)));
        if let Some(outcome) = outcome {
            (w.on_change)(outcome);
        }
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
    outcome: Arc<AtomicU64>,
    health: Arc<Mutex<HealthState>>,
    probe_url: Arc<Mutex<String>>,
    poke: Arc<Notify>,
    on_change: OnChange,
}

/// How often the watcher looks at the relay's counters.
const LOOK_EVERY: Duration = Duration::from_secs(2);

/// Probes for as long as the relay runs: one at once, then whenever there is
/// a reason (ProbePolicy).
async fn watch(w: Watch) {
    let mut failures = w.stats.snapshot().failures;
    loop {
        let url = url_of(&w.probe_url);
        probe_route(&w, &url).await;
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_relay::Source;
    use std::sync::atomic::AtomicUsize;

    fn connection(changes: Arc<AtomicUsize>) -> Connection {
        let policy = ProbePolicy {
            every: None,
            retry: Duration::from_secs(3600),
            after_failures: Duration::from_secs(3600),
        };
        Connection::new(Arc::new(Geo::new("")), "hproxy-test", policy, move |_| {
            changes.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn built(line: &str) -> Built {
        Built {
            source: Source::Fixed(hproxy_relay::upstream::parse(line).unwrap()),
            exit_label: None,
            notice: None,
        }
    }

    fn place(id: &str) -> Place {
        Place::Proxy { id: id.into() }
    }

    #[tokio::test]
    async fn a_connection_asked_for_says_once_whether_it_worked_and_why_not() {
        // An upstream that refuses: a port that was free a moment ago. Nothing leaves this machine.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        type Seen = Vec<(bool, Option<&'static str>)>;
        let outcomes: Arc<Mutex<Seen>> = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&outcomes);
        let policy = ProbePolicy {
            every: None,
            retry: Duration::from_secs(3600),
            after_failures: Duration::from_secs(3600),
        };
        let c = Connection::new(Arc::new(Geo::new("")), "hproxy-test", policy, move |change| {
            if let Change::Outcome { ok, why } = change {
                seen.lock().unwrap().push((ok, why));
            }
        });
        let any: SocketAddr = "127.0.0.1:0".parse().unwrap();
        c.start(place("a"), built(&format!("127.0.0.1:{port}")), any, None)
            .await
            .unwrap();
        for _ in 0..150 {
            if !outcomes.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert_eq!(
            *outcomes.lock().unwrap(),
            vec![(false, Some("refused"))],
            "the relay saw the refusal"
        );
        c.test_now().await.unwrap();
        assert_eq!(
            outcomes.lock().unwrap().len(),
            1,
            "a probe asked for later is no second connection"
        );
        c.stop().await;
    }

    #[tokio::test]
    async fn start_switch_and_stop_keep_one_port_and_say_so() {
        let changes = Arc::new(AtomicUsize::new(0));
        let c = connection(Arc::clone(&changes));
        let any: SocketAddr = "127.0.0.1:0".parse().unwrap();

        let first = c
            .start(place("a"), built("198.51.100.1:8080"), any, None)
            .await
            .unwrap();
        assert!(first.running);
        let port = c.listen().unwrap().port();
        assert_ne!(port, 0);
        let route = first.route.unwrap();
        assert!(
            tokio::net::TcpStream::connect(c.listen().unwrap()).await.is_ok(),
            "the relay listens"
        );

        let second = c
            .start(place("b"), built("198.51.100.2:8080"), any, None)
            .await
            .unwrap();
        assert_eq!(c.listen().unwrap().port(), port, "a switch keeps the port");
        assert!(second.route.unwrap() > route, "a switch starts a new route");
        assert!(second.source.unwrap().in_use.contains("198.51.100.2"));
        assert_eq!(second.place, Some(place("b")));

        c.stop().await;
        assert!(!c.status().running);
        assert!(c.listen().is_none());
        assert!(
            changes.load(Ordering::SeqCst) >= 3,
            "up, switched and down were all told"
        );
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
    async fn the_first_probe_of_a_dead_proxy_says_it_does_not_work() {
        let changes = Arc::new(AtomicUsize::new(0));
        let c = connection(Arc::clone(&changes));
        // Nothing listens on the proxy's port: every connection through it fails.
        let dead = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        c.start(
            place("a"),
            built(&dead.to_string()),
            "127.0.0.1:0".parse().unwrap(),
            None,
        )
        .await
        .unwrap();
        let mut health = None;
        for _ in 0..200 {
            health = c.status().health;
            if health.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let h = health.expect("the first probe runs at once");
        assert!(!h.ok);
        assert!(h.error.is_some());
        c.stop().await;
    }

    #[tokio::test]
    async fn moving_within_a_single_proxy_is_refused_and_nothing_is_running_to_test() {
        let c = connection(Arc::new(AtomicUsize::new(0)));
        assert!(c.test_now().await.is_err());
        c.start(
            place("a"),
            built("198.51.100.1:8080"),
            "127.0.0.1:0".parse().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert!(c.next_ip().await.is_err(), "a single proxy has no other IP");
        assert!(c.go_to_member(1).is_err());
        c.stop().await;
    }
}
