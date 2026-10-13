//! The engine, once per app process: the places, the connection, the
//! tunnel with its firewall, the checker, and the events the app reads.
//!
//! Everything the app asks goes through `call(method, args)`: a method name
//! and JSON in, JSON out (`{"ok":true,"value":...}` or `{"ok":false,
//! "error":"words for the person"}`). The calls that wait for the network
//! (connecting, a probe, the speed test) block the app's calling thread,
//! which is a background thread there (Kotlin's IO dispatcher), never its
//! screen.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use hproxy_api::geo::{Geo, DEFAULT_GEO_API};
use hproxy_connection::{Change, Connection, ProbePolicy};
use hproxy_places::{Library, Place, WindowStorage};
use hproxy_probe::Checker;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::checker::{self, Checks, StartInput, Tools};
use crate::events::Events;
use crate::firewall::{Firewall, TableInput};
use crate::places;

/// How the app names itself in our servers' logs.
pub const PROGRAM: &str = "hproxy-phone";

pub struct Engine {
    pub rt: tokio::runtime::Runtime,
    pub events: Arc<Events>,
    places_dir: PathBuf,
    lib: Mutex<Library>,
    notice: Mutex<Option<String>>,
    geo: Arc<Geo>,
    checker: Arc<Checker>,
    pub connection: Connection,
    pub firewall: Arc<Firewall>,
    checks: Arc<Checks>,
    #[cfg(unix)]
    pub tunnel: Mutex<Option<crate::tunnel::Running>>,
    own_ip: Mutex<Option<(std::time::Instant, Value)>>,
    /// The support chat of the Help tab (chat.rs).
    chat: crate::chat::Chat,
}

static ENGINE: OnceLock<Engine> = OnceLock::new();

/// The engine, once `init` ran.
pub fn engine() -> Result<&'static Engine, String> {
    ENGINE.get().ok_or_else(|| "the engine was not started".to_string())
}

/// Start the engine with the app's private folder; `sdk` is Android's API
/// level, which decides how apps are told apart (owner.rs). A second call
/// changes nothing.
pub fn init(data: &Path, sdk: i32) -> Result<&'static Engine, String> {
    if let Some(e) = ENGINE.get() {
        return Ok(e);
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(3)
        .thread_name("hproxy")
        .enable_all()
        .build()
        .map_err(|e| format!("the engine could not start: {e}"))?;
    let events = Arc::new(Events::default());
    let places_dir = places::dir_in(data);
    let (lib, notice) = places::open(&places_dir);
    let geo = Arc::new(Geo::new(DEFAULT_GEO_API));
    let connection = {
        let events = Arc::clone(&events);
        Connection::new(
            Arc::clone(&geo),
            PROGRAM,
            ProbePolicy::PHONE,
            move |change| match change {
                Change::Up => events.emit("connection", json!({ "up": true })),
                Change::Down => events.emit("connection", json!({ "up": false })),
                Change::Health(h) => events.emit("health", h),
            },
        )
    };
    let firewall = Arc::new(Firewall::new(Arc::clone(&events)));
    if sdk < 29 {
        firewall.set_owner(Arc::new(crate::owner::ProcNet));
    }
    let chat = crate::chat::Chat::new(Arc::clone(&events));
    let engine = Engine {
        rt,
        events,
        places_dir,
        lib: Mutex::new(lib),
        notice: Mutex::new(notice),
        geo,
        checker: Arc::new(Checker::public()),
        connection,
        firewall,
        checks: Arc::new(Checks::new(data)),
        #[cfg(unix)]
        tunnel: Mutex::new(None),
        own_ip: Mutex::new(None),
        chat,
    };
    let _ = ENGINE.set(engine);
    ENGINE.get().ok_or_else(|| "the engine could not start".to_string())
}

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn from<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("the app sent something the engine cannot read: {e}"))
}

fn to(v: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    place: Place,
    #[serde(default)]
    member: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretArgs {
    place: Place,
    #[serde(default)]
    member: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MembersArgs {
    id: String,
    #[serde(default)]
    from: usize,
    #[serde(default = "fifty")]
    count: usize,
}

fn fifty() -> usize {
    50
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinesArgs {
    run: u64,
    which: Vec<usize>,
}

impl Engine {
    /// One call from the app.
    pub fn call(&'static self, method: &str, args: &str) -> Result<Value, String> {
        let args: Value = if args.trim().is_empty() {
            Value::Null
        } else {
            serde_json::from_str(args).map_err(|e| format!("the app sent something the engine cannot read: {e}"))?
        };
        match method {
            "library" => Ok(self.library()),
            "review" => {
                let text = args.get("text").and_then(Value::as_str).unwrap_or("");
                to(places::review(&locked(&self.lib), text))
            }
            "add" => {
                let added = self.change(|lib| places::add(lib, from(args)?, hproxy_connection::now_ms()))?;
                Ok(json!({ "added": to(added)?, "library": self.library() }))
            }
            "rename" => {
                let a: IdArgs = from(args)?;
                self.change(|lib| Ok(lib.rename_proxy(&a.id, a.name.as_deref().unwrap_or(""))))?;
                Ok(self.library())
            }
            "renameGroup" => {
                let a: IdArgs = from(args)?;
                self.change(|lib| Ok(lib.rename_group(&a.id, a.name.as_deref().unwrap_or(""))))?;
                Ok(self.library())
            }
            "forget" => {
                let a: IdArgs = from(args)?;
                self.change(|lib| Ok(lib.forget_proxy(&a.id)))?;
                Ok(self.library())
            }
            "forgetGroup" => {
                let a: IdArgs = from(args)?;
                self.change(|lib| Ok(lib.forget_group(&a.id)))?;
                Ok(self.library())
            }
            "pick" => {
                let place: Option<Place> = from(args.get("place").cloned().unwrap_or(Value::Null))?;
                self.change(|lib| lib.pick(place))?;
                Ok(self.library())
            }
            "secret" => {
                let a: SecretArgs = from(args)?;
                to(places::secret(&locked(&self.lib), &a.place, a.member)?)
            }
            "members" => {
                let a: MembersArgs = from(args)?;
                to(locked(&self.lib)
                    .members(&a.id, a.from, a.count.min(500))
                    .ok_or("that group is not here any more")?)
            }
            "moveFromWindow" => {
                let storage: WindowStorage = from(args.get("storage").cloned().unwrap_or(Value::Null))?;
                let moved = self.change(|lib| Ok(lib.move_from_window(storage, hproxy_connection::now_ms())))?;
                Ok(json!({ "moved": moved, "library": self.library() }))
            }
            "connect" => self.rt.block_on(self.connect(from(args)?)),
            "disconnect" => {
                self.rt.block_on(self.connection.stop());
                to(self.connection.status())
            }
            "status" => to(self.connection.status()),
            "testNow" => to(self.rt.block_on(self.connection.test_now())?),
            "dnsLeak" => to(self.rt.block_on(self.connection.dns_leak())?),
            "speed" => to(self.rt.block_on(self.connection.speed())?),
            "vpnArgs" => Ok(vpn_args()),
            "freeCountries" => {
                let countries = self.rt.block_on(hproxy_relay::pool::countries())?;
                Ok(Value::Array(
                    countries
                        .into_iter()
                        .map(|c| json!({ "code": c.code, "count": c.count }))
                        .collect(),
                ))
            }
            "ownIp" => Ok(self.rt.block_on(self.own_ip())),
            "checkStart" => {
                let input: StartInput = from(args)?;
                let lib = locked(&self.lib).clone();
                let tools = self.tools();
                let checks = Arc::clone(&self.checks);
                to(self
                    .rt
                    .block_on(async move { checker::start(&checks, &lib, input, tools) })?)
            }
            "checkCancel" => {
                self.checks.cancel();
                Ok(Value::Null)
            }
            "checkLines" => {
                let a: LinesArgs = from(args)?;
                to(self.checks.lines(a.run, &a.which)?)
            }
            "checkRecent" => to(self.checks.recent()),
            "freeList" => to(self.rt.block_on(free_list(from(args)?))?),
            "fraud" => Ok(Value::Array(self.rt.block_on(fraud_scores(from(args)?)))),
            "chatOpen" => {
                let a: ChatOpenArgs = from(args)?;
                self.chat.open(&self.rt, a.token);
                Ok(Value::Null)
            }
            "chatSend" => {
                let a: ChatSendArgs = from(args)?;
                let body = a.body.trim();
                if body.is_empty() {
                    return Err("write something first".into());
                }
                self.chat
                    .send(json!({ "op": "message.send", "id": a.id, "data": { "body": body } }))?;
                Ok(Value::Null)
            }
            "chatRead" => {
                let a: ChatReadArgs = from(args)?;
                self.chat
                    .send(json!({ "op": "message.read", "data": { "conversation_id": a.conversation_id } }))?;
                Ok(Value::Null)
            }
            "chatClose" => {
                self.chat.close();
                Ok(Value::Null)
            }
            "firewall" => {
                let table: TableInput = from(args)?;
                self.firewall.set_table(table);
                Ok(Value::Null)
            }
            other => Err(format!("the engine has no call named {other}")),
        }
    }

    /// The library as the screens see it: never a password.
    fn library(&self) -> Value {
        let lib = locked(&self.lib);
        let mut v = serde_json::to_value(lib.view()).unwrap_or(Value::Null);
        if let Some(o) = v.as_object_mut() {
            o.insert("movedFromWindow".into(), lib.moved_from_window.into());
            if let Some(n) = locked(&self.notice).take() {
                o.insert("notice".into(), n.into());
            }
        }
        v
    }

    /// Change the library and keep it.
    fn change<T>(&self, f: impl FnOnce(&mut Library) -> Result<T, String>) -> Result<T, String> {
        let mut lib = locked(&self.lib);
        let out = f(&mut lib)?;
        places::save(&self.places_dir, &lib)?;
        Ok(out)
    }

    async fn connect(&'static self, a: ConnectArgs) -> Result<Value, String> {
        let built =
            hproxy_connection::source::build(|p| hproxy_connection::source_of(&locked(&self.lib), p), &a.place).await?;
        let any: SocketAddr = ([127, 0, 0, 1], 0).into();
        let status = self.connection.start(a.place.clone(), built, any, a.member).await?;
        let now = hproxy_connection::now_ms();
        let _ = self.change(|lib| {
            match &a.place {
                Place::Proxy { id } => lib.proxy_used(id, now),
                Place::Group { id } => lib.group_used(id, now),
                Place::Free { .. } => {}
            }
            lib.pick(Some(a.place.clone()))
        });
        to(status)
    }

    fn tools(&'static self) -> Tools {
        Tools {
            checker: Arc::clone(&self.checker),
            geo: Arc::clone(&self.geo),
            events: Arc::clone(&self.events),
            on_saved: Box::new(move |verdicts| {
                let _ = self.change(|lib| {
                    for (id, v) in verdicts {
                        lib.set_verdict(&id, v);
                    }
                    Ok(())
                });
            }),
        }
    }

    /// The phone's own address (this app is outside its own VPN, so it is
    /// the phone's real one) and where it is, for "Your own IP" while off.
    /// Asked again after half a minute: the phone moves between networks.
    async fn own_ip(&self) -> Value {
        if let Some((at, v)) = locked(&self.own_ip).as_ref() {
            if at.elapsed() < Duration::from_secs(30) {
                return v.clone();
            }
        }
        let client = hproxy_api::http_client(PROGRAM, Duration::from_secs(6));
        let ip = match client.get(hproxy_probe::judge::DEFAULT_ECHO_TLS).send().await {
            Ok(r) => r
                .json::<hproxy_probe::EchoResponse>()
                .await
                .ok()
                .and_then(|e| e.exit_ip()),
            Err(_) => None,
        };
        let Some(ip) = ip else { return Value::Null };
        self.geo.prefetch(std::slice::from_ref(&ip), |_| {}).await;
        let label = self.geo.label(&ip);
        let v = json!({
            "ip": ip,
            "countryCode": label.as_ref().and_then(|l| l.country_code.clone()),
            "country": label.as_ref().and_then(|l| l.country.clone()),
            "city": label.as_ref().and_then(|l| l.city.clone()),
            "timezone": label.as_ref().and_then(|l| l.timezone.clone()),
        });
        *locked(&self.own_ip) = Some((std::time::Instant::now(), v.clone()));
        v
    }
}

/// What the VPN is opened with: one place decides the routes, the
/// addresses and the DNS server, and that is the tunnel crate.
pub fn vpn_args() -> Value {
    json!({
        "routes": hproxy_tunnel::vpn_routes().into_iter().map(|(ip, len)| format!("{ip}/{len}")).collect::<Vec<_>>(),
        "addresses": [format!("{}/32", hproxy_tunnel::TUN_V4), format!("{}/128", hproxy_tunnel::TUN_V6)],
        "dns": hproxy_tunnel::DNS_V4.to_string(),
        "mtu": hproxy_tunnel::MTU,
    })
}

// -------------------------------------------------------------------------
// The free list, one exit a row (the phone's Proxies screen, 2026-10-11)
// -------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FreeListArgs {
    /// Two letters, or none for every country.
    #[serde(default)]
    country: Option<String>,
    #[serde(default = "two_hundred")]
    limit: usize,
}

fn two_hundred() -> usize {
    200
}

/// One free exit as a row of the list shows it: the proxy itself, where it
/// is, its network, how fast and how often it answered the pool's checks.
/// Untested from this phone: connecting to it tests it (`Source::exact_free`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FreeRow {
    host: String,
    port: u16,
    /// How the relay speaks to it: "HTTP" or "SOCKS5".
    proto: &'static str,
    /// Two letters, lower case.
    cc: String,
    city: String,
    region: String,
    network: String,
    ms: Option<i64>,
    uptime: Option<f64>,
    datacenter: Option<bool>,
    lat: Option<f64>,
    lng: Option<f64>,
    verified_at: Option<String>,
}

/// The free list itself, so a person sees which one they connect to
/// (2026-10-11). The pool's best exits of both protocols
/// for a country (or every country), each once: an exit that speaks both is
/// listed as HTTP, which carries every app's traffic through CONNECT.
async fn free_list(a: FreeListArgs) -> Result<Vec<FreeRow>, String> {
    use hproxy_relay::pool::Pool;
    use hproxy_relay::Scheme;
    let country = a
        .country
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| !c.is_empty());
    let limit = a.limit.clamp(1, 200);
    let http = Pool::new(country.clone(), Scheme::Http)?;
    let socks = Pool::new(country, Scheme::Socks5)?;
    let (h, s) = tokio::join!(http.list(limit), socks.list(limit));
    // One protocol answering is enough to show a list.
    if let (Err(e), Err(_)) = (&h, &s) {
        return Err(e.clone());
    }
    let mut seen = std::collections::HashSet::new();
    let mut rows = Vec::new();
    for (exits, proto) in [(h.unwrap_or_default(), "HTTP"), (s.unwrap_or_default(), "SOCKS5")] {
        for e in exits {
            if !seen.insert(e.upstream.addr()) {
                continue;
            }
            rows.push(FreeRow {
                host: e.upstream.host,
                port: e.upstream.port,
                proto,
                cc: e.country.to_ascii_lowercase(),
                city: e.city,
                region: e.region,
                network: e.network,
                ms: e.latency_ms,
                uptime: e.uptime,
                datacenter: e.datacenter,
                lat: e.latitude,
                lng: e.longitude,
                verified_at: e.verified_at,
            });
        }
    }
    Ok(rows)
}

// -------------------------------------------------------------------------
// Fraud scores, from the checker the person picked (Settings)
// -------------------------------------------------------------------------

#[derive(Deserialize)]
struct FraudArgs {
    ips: Vec<String>,
    /// `{"service":"ffraud"}`, `{"service":"ipqs","key":"..."}` (hproxy_api::fraud).
    service: hproxy_api::fraud::FraudService,
}

/// The most addresses one call looks up: a screen's worth.
const FRAUD_AT_MOST: usize = 60;

/// One score per address, a few at a time, in no particular order: each
/// answer names its address, a failure says why ("IPQualityScore needs your
/// API key"). Any of the fraud score checkers can answer (the computer app's
/// five).
async fn fraud_scores(a: FraudArgs) -> Vec<Value> {
    let http = hproxy_api::http_client(PROGRAM, Duration::from_secs(10));
    let service = Arc::new(a.service);
    let gate = Arc::new(tokio::sync::Semaphore::new(4));
    let mut set = tokio::task::JoinSet::new();
    let mut seen = std::collections::HashSet::new();
    for ip in a
        .ips
        .into_iter()
        .filter(|ip| seen.insert(ip.clone()))
        .take(FRAUD_AT_MOST)
    {
        let (http, service, gate) = (http.clone(), Arc::clone(&service), Arc::clone(&gate));
        set.spawn(async move {
            let _turn = gate.acquire_owned().await;
            match hproxy_api::fraud::lookup(&http, &service, &ip).await {
                Ok(s) => json!({
                    "ip": ip,
                    "score": s.score,
                    "risk": s.risk,
                    "flags": s.flags,
                    "reason": s.reason,
                    "service": s.service,
                }),
                Err(e) => json!({ "ip": ip, "error": e, "service": service.name() }),
            }
        });
    }
    let mut out = Vec::new();
    while let Some(answer) = set.join_next().await {
        if let Ok(v) = answer {
            out.push(v);
        }
    }
    out
}

// -------------------------------------------------------------------------
// The support chat (chat.rs)
// -------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChatOpenArgs {
    #[serde(default)]
    token: Option<String>,
}

#[derive(Deserialize)]
struct ChatSendArgs {
    /// The app's own id for the message: its acknowledgements carry it.
    id: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatReadArgs {
    conversation_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vpn_is_opened_with_the_tunnel_s_own_addresses() {
        let v = vpn_args();
        assert_eq!(v["addresses"][0], "198.18.0.1/32");
        assert_eq!(v["dns"], "198.18.0.2");
        assert!(v["routes"].as_array().unwrap().iter().any(|r| r == "2000::/3"));
    }
}
