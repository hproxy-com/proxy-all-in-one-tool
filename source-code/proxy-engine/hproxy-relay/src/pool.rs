//! Free-pool mode: the same exits the Chrome extension uses.
//!
//! ⚠️ THIS FILE IS ONE HALF OF A SHARED CONTRACT. The other half is the HProxy
//! Chrome extension, and the backend half is the pool API. The extension and this binary are the
//! same product in two places: the extension proxies Chrome, this proxies the
//! whole machine, and both draw from one pool through one API. Change the shape
//! here and change it there.
//!
//! Three behaviours copied deliberately from the extension, because each one
//! was learned the hard way:
//!
//!   1. **The control plane never goes through the proxy.** Calls to
//!      hproxy.com are made by this process directly, never relayed. That is
//!      what lets failover fetch a replacement exit WHILE the current exit is
//!      dead. (The extension has to say this out loud in a `bypassList`; here
//!      it falls out of the design, and it is written down so nobody
//!      "optimises" it by routing our own requests through the relay.)
//!   2. **Recent exits go last**, so rotating actually gives a different
//!      network rather than the same best-scoring proxy again. `RECENT_MAX`
//!      matches the extension's 12.
//!   3. **A dead exit is reported back.** The pool is crowd-sourced health
//!      data; a client that quietly drops a corpse makes the pool worse for
//!      everyone, including the next request this same user makes.
//!
//! And one learned on 2026-09-28, when Microsoft's store testers picked a free
//! country, pressed Connect and watched it spin: **a free connect answers within
//! half a minute.** The old search asked `/api/vpn/next` for one exit at a time
//! and tested each before asking for the next, up to 15 in a row and up to 22
//! seconds each: minutes of "Connecting" whenever the pool was rough. Now one
//! call to `/api/vpn/pool` brings a batch, `SEARCH_PARALLEL` exits are tested at
//! the same time, the first that relays wins, and at `SEARCH_DEADLINE` the
//! search stops and says so in words.

use std::collections::VecDeque;
use std::future::Future;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Mutex;
use tokio::task::JoinSet;

use crate::upstream::{Scheme, Upstream};

/// Where the control plane lives. Matches `const API` in background.js.
const API: &str = "https://hproxy.com";

/// How many recent exits a search puts last. Matches `RECENT_MAX` in
/// background.js.
const RECENT_MAX: usize = 12;

/// How long a free connect may search before it says that nothing works. A
/// proxy tool that spins for minutes reads as broken.
pub const SEARCH_DEADLINE: Duration = Duration::from_secs(30);

/// How many exits are tested at the same time: enough to get through a rough
/// pool quickly, few enough not to look like a scan on the person's network.
pub const SEARCH_PARALLEL: usize = 6;

/// How many exits one search draws from the pool.
const SEARCH_BATCH: usize = 36;

/// How long one exit has to prove that it relays.
const TEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct PoolResponse {
    #[serde(default)]
    proxies: Vec<PoolProxy>,
}

#[derive(Deserialize)]
struct PoolProxy {
    ip: String,
    port: u16,
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    asn_org: Option<String>,
    #[serde(default)]
    latency_ms: Option<i64>,
}

/// One exit, plus the labels worth printing when we switch to it.
#[derive(Clone)]
pub struct Exit {
    pub upstream: Upstream,
    pub country: String,
    pub city: String,
    /// The network it belongs to, as the pool names it.
    pub network: String,
    pub latency_ms: Option<i64>,
}

impl Exit {
    pub fn describe(&self) -> String {
        let mut s = self.upstream.addr();
        let place = match (self.city.as_str(), self.country.as_str()) {
            ("", "") => String::new(),
            ("", c) => c.to_string(),
            (city, "") => city.to_string(),
            (city, c) => format!("{city}, {c}"),
        };
        if !place.is_empty() {
            s.push_str(&format!(" ({place})"));
        }
        if let Some(ms) = self.latency_ms {
            s.push_str(&format!(" {ms}ms"));
        }
        s
    }
}

pub struct Pool {
    client: reqwest::Client,
    country: Option<String>,
    protocol: &'static str,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    recent: VecDeque<String>,
}

impl Pool {
    pub fn new(country: Option<String>, scheme: Scheme) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            // The pool API is fast and this call sits in front of a user's very
            // first request. A long hang here reads as "the tool is broken".
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("hproxy-connector/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("could not start the HTTP client: {e}"))?;
        Ok(Self {
            client,
            country: country.map(|c| c.trim().to_uppercase()).filter(|c| !c.is_empty()),
            protocol: match scheme {
                Scheme::Socks5 => "socks5",
                Scheme::Http => "http",
            },
            state: Mutex::new(State::default()),
        })
    }

    fn scheme(&self) -> Scheme {
        if self.protocol == "socks5" {
            Scheme::Socks5
        } else {
            Scheme::Http
        }
    }

    /// "HTTP" or "SOCKS5", for sentences.
    fn protocol_name(&self) -> &'static str {
        if self.protocol == "socks5" {
            "SOCKS5"
        } else {
            "HTTP"
        }
    }

    /// Where, for sentences: "in DE", or "anywhere".
    fn place(&self) -> String {
        match &self.country {
            Some(cc) => format!("in {cc}"),
            None => "anywhere".into(),
        }
    }

    /// The pool's exits for this country and protocol, best first
    /// (`/api/vpn/pool`, the ranking `/api/vpn/next` walks). Not tested here:
    /// the pool's own checks accept exits a browser refuses, so a caller tests
    /// an exit before trusting it (`test`, `first_working`).
    pub async fn list(&self, limit: usize) -> Result<Vec<Exit>, String> {
        let mut url = format!("{API}/api/vpn/pool?protocol={}&limit={}", self.protocol, limit.clamp(1, 200));
        if let Some(cc) = &self.country {
            url.push_str(&format!("&country={cc}"));
        }
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("could not reach the HProxy pool: {e}"))?;
        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            // The free pool has a per-network budget. Say so plainly rather
            // than letting it look like an outage.
            return Err("the free pool's quota for your network is used up. It refills \
                 continuously, so try again shortly, or connect your own proxy instead."
                .into());
        }
        if !resp.status().is_success() {
            return Err(format!("the HProxy pool answered {}", resp.status()));
        }
        let body: PoolResponse = resp
            .json()
            .await
            .map_err(|e| format!("could not read the pool's answer: {e}"))?;
        let scheme = self.scheme();
        Ok(body
            .proxies
            .into_iter()
            // An entry that cannot speak the protocol asked for would fail on
            // every request with no explanation, so it is checked, not assumed.
            .filter(|p| p.protocols.is_empty() || p.protocols.iter().any(|x| x == self.protocol))
            .map(|p| Exit {
                upstream: Upstream {
                    scheme,
                    host: p.ip,
                    port: p.port,
                    // Pool exits are open proxies. There is no login to attach.
                    auth: None,
                },
                country: p.country_code.unwrap_or_default(),
                city: p.city.unwrap_or_default(),
                network: p.asn_org.unwrap_or_default(),
                latency_ms: p.latency_ms,
            })
            .collect())
    }

    /// The first exit of a fresh batch that really relays, tested
    /// `SEARCH_PARALLEL` at a time, within `SEARCH_DEADLINE`.
    ///
    /// WHY EVERY EXIT IS TESTED. A pool pick that answers is not a pick that
    /// relays: an ordinary web server on port 80 answers every request with its
    /// own page (August 2026), and 25 of the 30 top free exits re-signed HTTPS
    /// with a certificate of their own (2026-09-23). The test fetches our own
    /// control-plane JSON through the candidate over HTTPS with certificate
    /// checks on, which is exactly what a person's browser will ask of it.
    ///
    /// Exits used lately go last, so "New IP" moves to a different network
    /// while a small pool still has something to offer. Every exit that failed
    /// is reported to the pool in one batch.
    pub async fn first_working(&self) -> Result<Exit, String> {
        let recent: Vec<String> = self.state.lock().await.recent.iter().cloned().collect();
        let listed = self.list(SEARCH_BATCH).await?;
        if listed.is_empty() {
            return Err(format!(
                "no free {} proxy {} is up right now. Try another country, or connect your own proxy.",
                self.protocol_name(),
                self.place()
            ));
        }
        let (fresh, used): (Vec<Exit>, Vec<Exit>) = listed.into_iter().partition(|e| !recent.contains(&e.upstream.host));
        let candidates: Vec<Exit> = fresh.into_iter().chain(used).collect();
        let tried = candidates.len();

        let raced = race_first(candidates, SEARCH_PARALLEL, SEARCH_DEADLINE, |e: Exit| async move {
            match works(e.upstream.clone()).await {
                Ok(()) => Ok(e),
                Err(why) => Err((e, why)),
            }
        })
        .await;

        let dead: Vec<Upstream> = raced.failed.iter().map(|(e, _)| e.upstream.clone()).collect();
        self.report_dead_many(&dead);

        match raced.found {
            Some(exit) => {
                self.remember(&exit.upstream.host).await;
                Ok(exit)
            }
            None if raced.timed_out => Err(format!(
                "no free {} proxy {} worked within {} seconds ({} of {tried} tested). Free proxies are \
                 public and come and go: try another country, or connect your own proxy.",
                self.protocol_name(),
                self.place(),
                SEARCH_DEADLINE.as_secs(),
                raced.failed.len(),
            )),
            None => Err(format!(
                "none of the {tried} free {} proxies {} works right now. Free proxies are public and come \
                 and go: try another country, or connect your own proxy.",
                self.protocol_name(),
                self.place(),
            )),
        }
    }

    /// Mark an exit as just used, so the next search puts it last.
    pub async fn remember(&self, host: &str) {
        let mut st = self.state.lock().await;
        st.recent.retain(|ip| ip != host);
        st.recent.push_front(host.to_string());
        while st.recent.len() > RECENT_MAX {
            st.recent.pop_back();
        }
    }

    /// Tell the pool an exit stopped answering. Fire and forget, exactly like
    /// the extension's `reportDead`: a health report that blocks a user's
    /// reconnect is worse than a health report that gets lost.
    pub fn report_dead(&self, up: &Upstream) {
        self.report_dead_many(std::slice::from_ref(up));
    }

    /// Several dead exits in one report, the batch the API takes.
    fn report_dead_many(&self, dead: &[Upstream]) {
        if dead.is_empty() {
            return;
        }
        let client = self.client.clone();
        let reports: Vec<serde_json::Value> = dead
            .iter()
            .map(|up| {
                serde_json::json!({
                    "ip": up.host,
                    "port": up.port,
                    "protocol": match up.scheme { Scheme::Socks5 => "socks5", Scheme::Http => "http" },
                    "alive": false,
                })
            })
            .collect();
        let body = serde_json::json!({ "reports": reports });
        tokio::spawn(async move {
            let _ = client.post(format!("{API}/api/vpn/report")).json(&body).send().await;
        });
    }
}

/// Whether one exit really relays, and how long the test took in
/// milliseconds; or why not, in words a person reads on the exit's row.
pub async fn test(up: &Upstream) -> Result<u32, String> {
    let started = Instant::now();
    works(up.clone()).await?;
    Ok(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
}

/// Does this exit genuinely relay, or does it just answer?
///
/// Fetches our own control-plane JSON THROUGH the candidate over HTTPS, with
/// the usual certificate checks. A web server pretending to be a proxy fails at
/// the CONNECT, a proxy that re-signs HTTPS fails at the certificate, and one
/// that somehow answers cannot produce our JSON, so every failure shape is
/// caught by requiring the parsed body to carry a `countries` array.
async fn works(up: Upstream) -> Result<(), String> {
    let proxy = reqwest::Proxy::all(proxy_url(&up)).map_err(|e| format!("unusable proxy address: {e}"))?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(TEST_TIMEOUT)
        .build()
        .map_err(|e| format!("client: {e}"))?;

    let resp = client.get(format!("{API}/api/vpn/countries")).send().await.map_err(|e| in_words(&e))?;
    if !resp.status().is_success() {
        return Err(format!("answered with HTTP {} instead of relaying", resp.status().as_u16()));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "answered with a page of its own instead of relaying".to_string())?;
    if v.get("countries").and_then(|c| c.as_array()).is_some() {
        Ok(())
    } else {
        Err("answered with a page of its own instead of relaying".into())
    }
}

/// The exit as the test's HTTP client takes it. SOCKS5 is `socks5h`: the
/// proxy looks up the site's name, as it does for every connection the relay
/// makes through it (relay.rs, `socks5_connect`). With plain `socks5` this
/// computer looks the name up itself, and where it has IPv6 it hands the proxy
/// an IPv6 address, which most free proxies cannot reach: they answer "network
/// unreachable". On 2026-09-28 all 24 free SOCKS5 proxies failed the test that
/// way, in two seconds, on a computer with IPv6.
fn proxy_url(up: &Upstream) -> String {
    let scheme = match up.scheme {
        Scheme::Socks5 => "socks5h",
        Scheme::Http => "http",
    };
    format!("{scheme}://{}", up.addr())
}

/// Why a request through an exit failed, as a person reads it.
fn in_words(e: &reqwest::Error) -> String {
    let mut chain = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        chain.push_str(" | ");
        chain.push_str(&s.to_string());
        src = s.source();
    }
    reason_from(e.is_timeout(), &chain)
}

/// The words for a failure, from whether it timed out and the error's whole
/// chain of causes.
fn reason_from(timed_out: bool, chain: &str) -> String {
    let lower = chain.to_lowercase();
    if timed_out || lower.contains("timed out") || lower.contains("deadline") {
        format!("did not answer within {} seconds", TEST_TIMEOUT.as_secs())
    } else if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("notvalidforname") {
        "hands out its own HTTPS certificates, so it could read what you send".into()
    } else if lower.contains("refused") {
        "refused the connection".into()
    } else {
        "does not relay HTTPS".into()
    }
}

/// What a race of tests came to.
pub(crate) struct Raced<T> {
    /// The first candidate that passed, if one did.
    pub found: Option<T>,
    /// Every candidate that failed, with why, in the order they failed.
    pub failed: Vec<(T, String)>,
    /// The deadline ended the race while candidates were still untested.
    pub timed_out: bool,
}

/// Test candidates `parallel` at a time and stop at the first that passes.
/// At `deadline` whatever is still being tested is abandoned: dropping the
/// `JoinSet` aborts its tasks.
pub(crate) async fn race_first<T, F, Fut>(candidates: Vec<T>, parallel: usize, deadline: Duration, test: F) -> Raced<T>
where
    T: Send + 'static,
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<T, (T, String)>> + Send + 'static,
{
    let end = tokio::time::Instant::now() + deadline;
    let mut waiting = candidates.into_iter();
    let mut running = JoinSet::new();
    let mut failed = Vec::new();
    for c in waiting.by_ref().take(parallel.max(1)) {
        running.spawn(test(c));
    }
    loop {
        match tokio::time::timeout_at(end, running.join_next()).await {
            Err(_) => return Raced { found: None, failed, timed_out: true },
            Ok(None) => return Raced { found: None, failed, timed_out: false },
            Ok(Some(Ok(Ok(winner)))) => return Raced { found: Some(winner), failed, timed_out: false },
            Ok(Some(Ok(Err((loser, why))))) => failed.push((loser, why)),
            // A test that panicked names no candidate; the next one takes its place.
            Ok(Some(Err(_))) => {}
        }
        if let Some(c) = waiting.next() {
            running.spawn(test(c));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn recent_max_matches_the_extension() {
        // background.js: `const RECENT_MAX = 12`. If the extension changes and
        // this does not, the two halves rotate through different-sized windows
        // and "New IP" means something different in each.
        assert_eq!(RECENT_MAX, 12);
    }

    #[test]
    fn a_socks5_exit_is_tested_with_the_name_resolved_at_the_proxy() {
        let exit = |scheme| Upstream {
            scheme,
            host: "203.0.113.9".into(),
            port: 4145,
            auth: None,
        };
        assert_eq!(proxy_url(&exit(Scheme::Socks5)), "socks5h://203.0.113.9:4145");
        assert_eq!(proxy_url(&exit(Scheme::Http)), "http://203.0.113.9:4145");
    }

    #[test]
    fn the_control_plane_is_the_public_host() {
        // Must be the apex. vpn.rs documents that the extension's bypass list
        // is exactly `hproxy.com` and NOT `*.hproxy.com`, so a control plane on
        // a subdomain would be routed through a possibly-dead proxy.
        assert_eq!(API, "https://hproxy.com");
    }

    #[test]
    fn a_search_ends_in_half_a_minute_at_most() {
        // Microsoft's certification (2026-09-28) failed the app on a free
        // connect that "loads indefinitely". The deadline is the promise.
        assert!(SEARCH_DEADLINE <= Duration::from_secs(30));
        assert!(TEST_TIMEOUT < SEARCH_DEADLINE);
    }

    fn exit(host: &str, port: u16, country: &str, city: &str, ms: Option<i64>) -> Exit {
        Exit {
            upstream: Upstream {
                scheme: Scheme::Http,
                host: host.into(),
                port,
                auth: None,
            },
            country: country.into(),
            city: city.into(),
            network: String::new(),
            latency_ms: ms,
        }
    }

    #[tokio::test]
    async fn an_exit_describes_itself_for_the_banner() {
        assert_eq!(exit("203.0.113.209", 80, "FR", "Lauterbourg", Some(6)).describe(), "203.0.113.209:80 (Lauterbourg, FR) 6ms");
    }

    #[tokio::test]
    async fn a_bare_exit_still_describes_itself() {
        assert_eq!(exit("203.0.113.7", 8080, "", "", None).describe(), "203.0.113.7:8080");
    }

    #[test]
    fn pool_rejects_nothing_on_construction() {
        assert!(Pool::new(Some(" fr ".into()), Scheme::Http).is_ok());
        assert!(Pool::new(None, Scheme::Socks5).is_ok());
    }

    #[test]
    fn failures_read_as_what_happened() {
        assert_eq!(reason_from(true, "error sending request"), "did not answer within 10 seconds");
        assert_eq!(
            reason_from(false, "error sending request | client error (Connect) | invalid peer certificate: UnknownIssuer"),
            "hands out its own HTTPS certificates, so it could read what you send"
        );
        assert_eq!(reason_from(false, "tcp connect error: Connection refused (os error 10061)"), "refused the connection");
        assert_eq!(reason_from(false, "socks connect error: unexpected eof"), "does not relay HTTPS");
    }

    /// What one pretend test gives back, in time.
    type PretendTest = std::pin::Pin<Box<dyn Future<Output = Result<u32, (u32, String)>> + Send>>;

    /// A pretend test: `Ok` after `ms` for even numbers, `Err` after `ms` for odd ones.
    fn pretend(ms: u64) -> impl Fn(u32) -> PretendTest {
        move |n: u32| {
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                if n.is_multiple_of(2) {
                    Ok(n)
                } else {
                    Err((n, "no".to_string()))
                }
            })
        }
    }

    #[tokio::test]
    async fn the_first_exit_that_works_wins() {
        // Two at a time: 1 and 3 fail, then 4 works while 7 fails beside it.
        let raced = race_first(vec![1, 3, 4, 7, 8], 2, Duration::from_secs(5), pretend(10)).await;
        assert_eq!(raced.found, Some(4));
        let failed: Vec<u32> = raced.failed.iter().map(|(n, _)| *n).collect();
        assert!(failed.contains(&1) && failed.contains(&3));
        assert!(!failed.contains(&4) && !failed.contains(&8));
        assert!(!raced.timed_out);
    }

    #[tokio::test]
    async fn when_nothing_works_every_failure_is_named() {
        let raced = race_first(vec![1, 3, 5], 6, Duration::from_secs(5), pretend(5)).await;
        assert_eq!(raced.found, None);
        assert_eq!(raced.failed.len(), 3);
        assert!(!raced.timed_out);
    }

    #[tokio::test]
    async fn the_deadline_stops_a_slow_search() {
        let started = Instant::now();
        let raced = race_first(vec![2, 4, 6], 3, Duration::from_millis(60), pretend(5_000)).await;
        assert_eq!(raced.found, None);
        assert!(raced.timed_out);
        assert!(started.elapsed() < Duration::from_secs(2), "the search outlived its deadline");
    }

    #[tokio::test]
    async fn no_more_than_parallel_tests_run_at_once() {
        let now = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let (n2, m2) = (now.clone(), most.clone());
        let raced = race_first((0u32..12).map(|i| i * 2 + 1).collect(), 3, Duration::from_secs(5), move |n: u32| {
            let (now, most) = (n2.clone(), m2.clone());
            async move {
                let running = now.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(running, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(15)).await;
                now.fetch_sub(1, Ordering::SeqCst);
                Err::<u32, (u32, String)>((n, "no".into()))
            }
        })
        .await;
        assert_eq!(raced.failed.len(), 12);
        assert_eq!(most.load(Ordering::SeqCst), 3);
    }

    /// Against the real pool: `cargo test -p hproxy-relay -- --ignored --nocapture live_`.
    /// It reports the exits that fail, as a person's connect would.
    #[tokio::test]
    #[ignore]
    async fn live_free_search_answers_within_the_deadline() {
        for (cc, scheme) in [(Some("US"), Scheme::Http), (Some("DE"), Scheme::Socks5), (Some("AU"), Scheme::Http), (None, Scheme::Socks5)] {
            let pool = Pool::new(cc.map(String::from), scheme).unwrap();
            let started = Instant::now();
            let found = pool.first_working().await;
            let took = started.elapsed();
            println!("{:?} {:?}: {:.1} s -> {}", cc, scheme, took.as_secs_f32(), match &found {
                Ok(e) => format!("works: {}", e.describe()),
                Err(why) => why.clone(),
            });
            assert!(took < SEARCH_DEADLINE + Duration::from_secs(15), "the search overran its deadline");
        }
    }

    /// The Free tab's list, live: how many of a country's listed free proxies
    /// pass the test from this computer, which is the number the tab shows,
    /// and why the others failed. Tested SEARCH_PARALLEL at a time, as the
    /// app does. Nothing is reported to the pool.
    #[tokio::test]
    #[ignore]
    async fn live_free_list_how_many_pass_from_here() {
        for (cc, scheme) in [(None, Scheme::Http), (None, Scheme::Socks5), (Some("US"), Scheme::Http), (Some("DE"), Scheme::Http), (Some("GB"), Scheme::Http)] {
            let pool = Pool::new(cc.map(String::from), scheme).unwrap();
            let started = Instant::now();
            let listed = match pool.list(24).await {
                Ok(l) => l,
                Err(why) => {
                    println!("{cc:?} {scheme:?}: no list: {why}");
                    continue;
                }
            };
            let mut passed = 0;
            let mut failed: std::collections::BTreeMap<String, usize> = Default::default();
            for batch in listed.chunks(SEARCH_PARALLEL) {
                let mut tests = tokio::task::JoinSet::new();
                for e in batch {
                    let up = e.upstream.clone();
                    tests.spawn(async move { test(&up).await });
                }
                while let Some(done) = tests.join_next().await {
                    match done.expect("a test ended without an answer") {
                        Ok(_) => passed += 1,
                        Err(why) => *failed.entry(why).or_default() += 1,
                    }
                }
            }
            println!(
                "{cc:?} {scheme:?}: {passed} of {} pass from here, {:.0} s; failed: {failed:?}",
                listed.len(),
                started.elapsed().as_secs_f32()
            );
        }
    }

    #[tokio::test]
    async fn an_empty_list_finds_nothing_at_once() {
        let raced = race_first(Vec::<u32>::new(), 6, Duration::from_secs(5), pretend(1)).await;
        assert_eq!(raced.found, None);
        assert!(raced.failed.is_empty());
        assert!(!raced.timed_out);
    }
}
