//! One proxy, four transports, one row.
//!
//! `Checker::check` fans the four probes out at once and merges their answers:
//! which transports worked, how fast the best one was, how anonymous it is,
//! what software runs it, where traffic comes out, and when nothing answered,
//! the most informative reason why.

use crate::echo::EchoResponse;
use crate::fingerprint;
use crate::grade;
use crate::judge::{Judge, JudgeKind, Ladder};
use crate::line::ProxyLine;
use crate::result::{CheckResult, Failure, ProtocolTiming, Status, TransportFailure};
use crate::speed;
use crate::transport::{self, Budget, Context, Probe, Target};
use crate::udp;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::sync::{Mutex, OnceCell};

/// Which transports a check should probe. Four bools rather than a set:
/// stack-allocated, and the `match` in the hot loop beats a hash lookup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolSet {
    pub http: bool,
    pub https: bool,
    pub socks4: bool,
    pub socks5: bool,
}

impl ProtocolSet {
    /// Probe every transport: report what answered rather than trusting a
    /// `socks5://` hint in the pasted line.
    pub fn all() -> Self {
        Self {
            http: true,
            https: true,
            socks4: true,
            socks5: true,
        }
    }

    pub fn any(&self) -> bool {
        self.http || self.https || self.socks4 || self.socks5
    }

    /// From lowercase wire names. Unknown values are ignored rather than
    /// rejected, so one typo does not kill a whole run.
    pub fn from_strings<S: AsRef<str>>(s: &[S]) -> Self {
        let mut out = Self {
            http: false,
            https: false,
            socks4: false,
            socks5: false,
        };
        for p in s {
            match p.as_ref().trim().to_ascii_lowercase().as_str() {
                "http" => out.http = true,
                "https" => out.https = true,
                "socks4" => out.socks4 = true,
                "socks5" => out.socks5 = true,
                _ => {}
            }
        }
        out
    }

    pub fn names(&self) -> Vec<&'static str> {
        let mut v = Vec::with_capacity(4);
        if self.http {
            v.push("http");
        }
        if self.https {
            v.push("https");
        }
        if self.socks4 {
            v.push("socks4");
        }
        if self.socks5 {
            v.push("socks5");
        }
        v
    }
}

impl Default for ProtocolSet {
    fn default() -> Self {
        Self::all()
    }
}

/// Per-check knobs. Defaults are quick and gentle.
#[derive(Debug, Clone)]
pub struct CheckOptions {
    /// Per-transport deadline for the whole probe.
    pub timeout: Duration,
    /// Fail-fast cap on getting a socket. Deliberately separate from `timeout`:
    /// a listener connects in tens of milliseconds or never, while a proxy
    /// that connected may legitimately be slow to answer.
    pub connect_timeout: Duration,
    /// Extra attempts after a failed check. Retries the whole proxy, not each
    /// transport: if any transport answered the proxy is alive and we stop.
    pub retries: u8,
    pub protocols: ProtocolSet,
    /// Probe SOCKS5 UDP ASSOCIATE and relay a real datagram.
    pub measure_udp: bool,
    /// Pull a payload through the proxy and report Mbit/s.
    pub measure_speed: bool,
    /// Payload for the speed test. The public door caps it.
    pub speed_bytes: usize,
}

impl Default for CheckOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(8),
            connect_timeout: Duration::from_secs(5),
            retries: 0,
            protocols: ProtocolSet::all(),
            measure_udp: false,
            measure_speed: false,
            speed_bytes: speed::PUBLIC_CAP_BYTES,
        }
    }
}

pub struct Checker {
    ladder: Ladder,
    speed_door: Judge,
    /// This machine's public address, learned once per session by dialling the
    /// judge directly. Without it a transparent proxy cannot be told from an
    /// anonymous one.
    own_ip: OnceCell<Option<String>>,
    /// Judge hosts resolved to IPv4 socket addresses, once per session, for
    /// SOCKS4, which carries an address and not a name.
    v4_cache: Mutex<HashMap<String, Option<SocketAddr>>>,
}

impl Checker {
    pub fn new(ladder: Ladder) -> Self {
        let speed_door = Judge::echo(speed::DEFAULT_SPEED_URL).expect("the default speed URL parses");
        Self {
            ladder,
            speed_door,
            own_ip: OnceCell::new(),
            v4_cache: Mutex::new(HashMap::new()),
        }
    }

    /// The public HProxy judges.
    pub fn public() -> Self {
        Self::new(Ladder::public())
    }

    pub fn with_speed_door(mut self, door: Judge) -> Self {
        self.speed_door = door;
        self
    }

    pub fn ladder(&self) -> &Ladder {
        &self.ladder
    }

    /// The canary target for the governor: the primary judge, resolved.
    pub async fn canary(&self) -> Option<SocketAddr> {
        let j = &self.ladder.own_address;
        tokio::net::lookup_host((j.host.as_str(), j.port)).await.ok()?.next()
    }

    /// Learn this machine's public address by dialling the judge directly, once
    /// per session. Bounded to a few seconds: an unreachable judge costs the
    /// first check that wait and nothing after it.
    pub async fn own_ip(&self) -> Option<String> {
        self.own_ip
            .get_or_init(|| async {
                let j = &self.ladder.own_address;
                let nonce = crate::echo::nonce();
                let cx = Context {
                    nonce: &nonce,
                    budget: Budget {
                        connect: Duration::from_secs(3),
                        total: Duration::from_secs(6),
                    },
                };
                // A direct dial is exactly an "HTTP proxy" probe aimed at the
                // judge itself: absolute-URI GET, no proxy in between.
                let rungs = [j.clone()];
                let p = transport::http(
                    Target {
                        host: &j.host,
                        port: j.port,
                        auth: None,
                    },
                    &rungs,
                    cx,
                )
                .await;
                let echo = p.echo?;
                // Prefer the trusted peer field, then what the judge saw on
                // the wire. Never loopback: our judge sits behind nginx and
                // reports its loopback peer when nothing else names us.
                echo.exit_ip().or_else(|| {
                    let ip = echo.wire_ip().trim().to_string();
                    let parsed: Option<IpAddr> = ip.parse().ok();
                    parsed
                        .filter(|a| !a.is_loopback() && !a.is_unspecified())
                        .map(|a| a.to_string())
                })
            })
            .await
            .clone()
    }

    async fn v4_of(&self, judge: &Judge) -> Option<SocketAddr> {
        let key = format!("{}:{}", judge.host, judge.port);
        {
            let cache = self.v4_cache.lock().await;
            if let Some(v) = cache.get(&key) {
                return *v;
            }
        }
        let resolved = if let Ok(ip) = judge.host.parse::<IpAddr>() {
            let sa = SocketAddr::new(ip, judge.port);
            sa.is_ipv4().then_some(sa)
        } else {
            tokio::net::lookup_host((judge.host.as_str(), judge.port))
                .await
                .ok()
                .and_then(|mut a| a.find(SocketAddr::is_ipv4))
        };
        self.v4_cache.lock().await.insert(key, resolved);
        resolved
    }

    /// Check one proxy, retrying the WHOLE proxy on failure: if any transport
    /// answered it is alive and we stop. Bounds the worst case to
    /// `(retries + 1) * timeout` instead of four times that.
    pub async fn check(&self, line: &ProxyLine, opts: &CheckOptions) -> CheckResult {
        let attempts = opts.retries as u32 + 1;
        let mut last = CheckResult::default();
        for attempt in 0..attempts {
            let r = self.check_once(line, opts).await;
            if r.alive {
                return r;
            }
            last = r;
            if attempt + 1 < attempts {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        last
    }

    async fn check_once(&self, line: &ProxyLine, opts: &CheckOptions) -> CheckResult {
        let mut result = CheckResult {
            ip: Some(line.host.clone()),
            port: Some(line.port),
            ..Default::default()
        };
        if !opts.protocols.any() {
            result.status = Status::Unchecked;
            result.error = Some("no protocols selected".into());
            return result;
        }

        let nonce = crate::echo::nonce();
        // The connect budget never goes below what Windows needs to report a
        // refusal, or every closed port would read as a timeout.
        let connect = opts
            .connect_timeout
            .max(crate::dial::MIN_CONNECT_BUDGET)
            .min(opts.timeout);
        let cx = Context {
            nonce: &nonce,
            budget: Budget {
                connect,
                total: opts.timeout,
            },
        };
        let target = Target {
            host: &line.host,
            port: line.port,
            auth: line.auth.as_ref(),
        };

        // SOCKS4 needs every plain rung as an address, resolved before the
        // fan-out so four probes cannot race into four lookups.
        let socks4_rungs: Vec<(Judge, SocketAddr)> = if opts.protocols.socks4 {
            let mut v = Vec::new();
            for j in &self.ladder.plain {
                if let Some(sa) = self.v4_of(j).await {
                    v.push((j.clone(), sa));
                }
            }
            v
        } else {
            Vec::new()
        };

        // Grading compares what the judge saw against our own address. It is
        // learned once per session and runs alongside the probes rather than
        // before them, so it is only ever needed at the merge.
        let (http_p, https_p, s4_p, s5_p, own) = tokio::join!(
            async {
                if opts.protocols.http {
                    transport::http(target, &self.ladder.plain, cx).await
                } else {
                    Probe::default()
                }
            },
            async {
                if opts.protocols.https {
                    transport::https(target, &self.ladder.tls, cx).await
                } else {
                    Probe::default()
                }
            },
            async {
                if opts.protocols.socks4 && !socks4_rungs.is_empty() {
                    transport::socks4(target, &socks4_rungs, cx).await
                } else {
                    Probe::default()
                }
            },
            async {
                if opts.protocols.socks5 {
                    transport::socks5(target, &self.ladder.plain, cx).await
                } else {
                    Probe::default()
                }
            },
            self.own_ip(),
        );

        let probes = [
            ("http", &http_p),
            ("https", &https_p),
            ("socks4", &s4_p),
            ("socks5", &s5_p),
        ];

        for (name, p) in probes {
            if p.alive {
                result.protocols.push((*name).to_string());
                if let Some(t) = p.timings {
                    result.timings.push(ProtocolTiming {
                        protocol: (*name).to_string(),
                        timings: t,
                    });
                }
            } else if let Some(f) = &p.failure {
                result.failures.push(TransportFailure {
                    protocol: (*name).to_string(),
                    detail: f.clone(),
                });
            }
        }

        result.alive = !result.protocols.is_empty();
        result.status = if result.alive { Status::Alive } else { Status::Dead };
        // The row's headline latency is the best transport's total, so it can
        // never disagree with the breakdown underneath it.
        result.latency_ms = result
            .timings
            .iter()
            .map(|t| t.timings.total_ms)
            .min()
            .map(|v| v as i32);

        // Every header-derived fact comes from the plain-HTTP probe ONLY. A
        // tunnelled transport physically cannot rewrite a header: it relays
        // opaque bytes, so any proxy-shaped header the judge reports on a
        // tunnelled probe was added by something at the far end (our TLS judge
        // sits behind Cloudflare, which stamps forwarding headers on every
        // request). Grading a tunnel on them would report that every
        // HTTPS-capable proxy on earth leaks. What a tunnel CAN tell us
        // honestly is the exit address, observed on the wire.
        if let Some(echo) = http_p.echo.as_ref().filter(|_| http_p.alive) {
            result.anonymity = Some(grade::grade(echo, own.as_deref()).to_string());
            result.keep_alive = fingerprint::keep_alive(&http_p.headers);
            // The evidence comes only from our own echo, which reflects the
            // request as the proxy forwarded it. The trace rung reflects
            // nothing but the User-Agent and carries a synthetic `via` that
            // caps the grade; reading software or leaks out of that would
            // report every proxy that only reached the trace as "Cloudflare"
            // leaking a header it never sent.
            if http_p.judge == Some(JudgeKind::Echo) {
                result.leaked_headers = fingerprint::leaked(&echo.headers);
                result.server = fingerprint::detect_software(&echo.headers, &http_p.headers);
            }
        }

        // The exit, from the first alive probe in preference order: HTTP
        // first because its echo is read in full, then the tunnels. Only alive
        // probes are consulted: a failed probe's echo is either absent or
        // unverified, and reading an address out of an unverified echo is
        // exactly the favour a decoy would like.
        for (_, p) in [
            ("http", &http_p),
            ("https", &https_p),
            ("socks5", &s5_p),
            ("socks4", &s4_p),
        ] {
            if !p.alive {
                continue;
            }
            if let Some(echo) = p.echo.as_ref() {
                if result.exit_ip.is_none() {
                    result.exit_ip = echo.exit_ip();
                    result.rotating = rotating(echo, &line.host, p.peer);
                }
                if result.judge.is_none() {
                    result.judge = p.judge.map(|k| k.as_str().to_string());
                }
            }
        }

        // A tunnel that carried our TLS with somebody else's certificate belongs
        // to a proxy that re-signs HTTPS and can read it. Still alive: it
        // relays. But nobody should log in through it, and the row says so.
        result.tls_intercepted = [&https_p, &s5_p, &s4_p]
            .iter()
            .filter(|p| p.alive)
            .find_map(|p| p.tls_genuine)
            .map(|genuine| !genuine);

        // Only tunnels answered. A tunnel cannot add a header, so nothing can
        // have leaked and elite is the correct grade, with one exception: if
        // the address the far end saw is our own, the traffic never actually
        // went anywhere, and that is transparent however it was carried.
        if result.alive && result.anonymity.is_none() {
            let transparent =
                matches!((result.exit_ip.as_deref(), own.as_deref()), (Some(exit), Some(ours)) if exit == ours);
            result.anonymity = Some(if transparent { grade::TRANSPARENT } else { grade::ELITE }.to_string());
        }

        if !result.alive {
            // ONE reason out of four probes, by information content, not by
            // order. None when alive: there is nothing to explain.
            let best = result.failures.iter().min_by_key(|f| f.detail.kind.rank());
            if let Some(f) = best {
                result.failure = Some(f.detail.kind);
                result.error = Some(f.detail.sentence());
                if result.failures.iter().all(|f| f.detail.kind == Failure::Unresolved) {
                    result.status = Status::Unresolved;
                }
            } else {
                result.error = Some("proxy did not respond".into());
            }
        }

        // UDP: only a SOCKS5 proxy can relay it, so a proxy that answered on
        // anything else is simply "no".
        if opts.measure_udp && result.alive {
            result.supports_udp = Some(if s5_p.alive {
                udp::relays_udp(
                    &line.host,
                    line.port,
                    line.auth.as_ref(),
                    opts.connect_timeout,
                    opts.timeout,
                )
                .await
            } else {
                false
            });
        }

        // Speed, through whichever tunnel answered.
        if opts.measure_speed && result.alive {
            let via = if https_p.alive {
                Some(speed::Via::HttpConnect)
            } else if s5_p.alive {
                Some(speed::Via::Socks5)
            } else if s4_p.alive {
                Some(speed::Via::Socks4)
            } else {
                None
            };
            if let Some(via) = via {
                let socks4_door = if via == speed::Via::Socks4 {
                    self.v4_of(&self.speed_door).await
                } else {
                    None
                };
                let budget = opts.timeout.max(Duration::from_secs(15));
                if let Ok(s) = speed::measure(
                    line,
                    via,
                    &self.speed_door,
                    socks4_door,
                    opts.speed_bytes,
                    opts.connect_timeout,
                    budget,
                )
                .await
                {
                    result.speed_mbps = Some(s.mbps);
                }
            }
        }

        result
    }
}

/// Did traffic leave by a different door than it went in? Compared against the
/// address actually dialled rather than the text pasted, because a proxy given
/// as a hostname would otherwise never match its own exit and every one would
/// be flagged rotating. `None` means unknown rather than no.
fn rotating(echo: &EchoResponse, pasted_host: &str, peer: Option<SocketAddr>) -> Option<bool> {
    let exit: IpAddr = echo.exit_ip()?.parse().ok()?;
    if let Ok(pasted) = pasted_host.parse::<IpAddr>() {
        return Some(exit != pasted);
    }
    peer.map(|p| p.ip() != exit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap as Map;

    fn echo_with(ip: &str) -> EchoResponse {
        EchoResponse {
            ip: ip.to_string(),
            headers: Map::new(),
            peer_ip: Some(ip.to_string()),
        }
    }

    #[test]
    fn rotating_compares_against_a_pasted_literal_address() {
        assert_eq!(rotating(&echo_with("203.0.113.9"), "203.0.113.9", None), Some(false));
        assert_eq!(rotating(&echo_with("198.51.100.7"), "203.0.113.9", None), Some(true));
    }

    #[test]
    fn rotating_uses_the_resolved_peer_for_a_hostname() {
        let peer: SocketAddr = "203.0.113.9:8080".parse().unwrap();
        assert_eq!(
            rotating(&echo_with("203.0.113.9"), "proxy.example.com", Some(peer)),
            Some(false)
        );
        assert_eq!(
            rotating(&echo_with("198.51.100.7"), "proxy.example.com", Some(peer)),
            Some(true)
        );
    }

    #[test]
    fn rotating_is_unknown_when_we_cannot_tell() {
        assert_eq!(rotating(&echo_with("203.0.113.9"), "proxy.example.com", None), None);
        let mut e = echo_with("");
        e.peer_ip = None;
        assert_eq!(rotating(&e, "203.0.113.9", None), None);
    }

    #[test]
    fn protocol_set_parses_wire_names_and_ignores_typos() {
        let p = ProtocolSet::from_strings(&["HTTP", "socks5", "shadowsocks"]);
        assert!(p.http && p.socks5 && !p.https && !p.socks4);
        assert_eq!(p.names(), vec!["http", "socks5"]);
        assert!(!ProtocolSet::from_strings::<&str>(&[]).any());
    }

    #[tokio::test]
    async fn dead_target_reports_not_alive_with_a_reason() {
        // 192.0.2.1 is TEST-NET-1 (RFC 5737): guaranteed unroutable. Proves the
        // pipeline settles to dead within the timeout instead of hanging.
        let ladder = Ladder::from_urls("http://192.0.2.2:9/echo", "https://192.0.2.2:9/echo", "", "").unwrap();
        let checker = Checker::new(ladder);
        let opts = CheckOptions {
            timeout: Duration::from_secs(2),
            connect_timeout: Duration::from_millis(800),
            protocols: ProtocolSet {
                http: false,
                https: false,
                socks4: false,
                socks5: true,
            },
            ..Default::default()
        };
        let line = crate::line::parse("192.0.2.1:8080").unwrap();
        let r = checker.check(&line, &opts).await;
        assert!(!r.alive);
        assert_eq!(r.status, Status::Dead);
        assert!(r.protocols.is_empty());
        assert!(r.timings.is_empty());
        assert_eq!(r.port, Some(8080));
        assert!(r.failure.is_some(), "a dead row must say why");
        assert!(r.error.as_deref().is_some_and(|e| !e.is_empty()));
        assert_eq!(r.failures.len(), 1);
        assert_eq!(r.failures[0].protocol, "socks5");
    }

    /// LIVE against the real public judge. Ignored by default; run with
    /// `cargo test -p hproxy-probe live_judge -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "hits the live judge"]
    async fn live_judge_detects_a_real_public_ip() {
        let checker = Checker::public();
        let own = checker
            .own_ip()
            .await
            .expect("the live judge must answer with an address");
        let parsed: IpAddr = own.parse().unwrap_or_else(|_| panic!("not an IP: {own}"));
        assert!(!parsed.is_loopback() && !parsed.is_unspecified());
        println!("live judge resolved our public IP as {own}");
        assert!(checker.canary().await.is_some());
    }
}
