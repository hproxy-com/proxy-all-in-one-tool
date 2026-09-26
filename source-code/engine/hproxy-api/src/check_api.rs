//! API-mode checking: hand the list to our own service instead of running it
//! down the user's own line.
//!
//! ## Why this exists
//!
//! Local checking is the honest default and always will be, but it has one real
//! cost: every probe is a socket opened from the user's own connection. A big
//! list is thousands of concurrent connections through a home router, and even
//! with the governor keeping that survivable, it is still their bandwidth, their
//! NAT table and their household's video call. Sending the list to our checker
//! instead moves all of that onto our hardware. The user's machine makes exactly
//! one HTTP request and reads a stream.
//!
//! ## What it costs them
//!
//! Two honest trade-offs, both surfaced in the UI rather than buried:
//!
//! 1. **The list leaves the machine.** In local mode nothing about the proxies
//!    is transmitted except the addresses sent for geolocation. In API mode the
//!    whole list, credentials included, goes to our server. That is a real
//!    change in the privacy posture of the tool and it must be the user's
//!    deliberate choice, never a default.
//! 2. **Less detail comes back.** The server-side checker
//!    answers liveness, protocols, anonymity, latency and geo. None of the
//!    per-phase timings, exit address, leaked headers or software detection this
//!    engine produces. Rows are tagged `source: "api"` so the difference is
//!    visible rather than mysterious.
//!
//! ## The chunk size is set by the server's rate limiter, not by us
//!
//! `allow_proxy_check` gives an IP **10 requests of burst and then one every
//! five seconds**, while a single request may carry up to 100,000 proxies and
//! the daily volume budget is 300,000. That inverts the usual instinct: small
//! chunks are not gentler here, they are catastrophic. A 100k list in 500-proxy
//! chunks is 200 calls, 190 of them throttled five seconds apart, and API mode
//! would look broken while behaving perfectly correctly. Few and large is the
//! only shape that works.

use futures::StreamExt;
use hproxy_probe::{CheckOptions, CheckResult, Failure, Status};
use serde::Deserialize;
use std::time::Duration;

pub const DEFAULT_CHECK_API: &str = "https://hproxy.com/api/free-proxy/check";

/// Proxies per request. See the rate-limit note above for why this is large.
/// Five calls covers the biggest batch the endpoint accepts.
pub const CHUNK: usize = 20_000;

/// Longest we will hold one streaming response open. The server's own ceiling
/// is 900s; matching it means we give up at the same moment it does rather than
/// abandoning a stream that was still going to deliver.
const STREAM_TIMEOUT: Duration = Duration::from_secs(900);

/// One NDJSON line, as the server sends it. Every field is optional on the way
/// in: a server that adds a field must not break an older client, and a server
/// that drops one must not either.
#[derive(Debug, Deserialize)]
struct RemoteRow {
    input: String,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    ip: Option<String>,
    #[serde(default)]
    exit_ip: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    alive: bool,
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    supports_udp: Option<bool>,
    #[serde(default)]
    speed_mbps: Option<f64>,
    #[serde(default)]
    anonymity: Option<String>,
    #[serde(default)]
    latency_ms: Option<i32>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    region: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    asn: Option<i32>,
    #[serde(default)]
    asn_org: Option<String>,
    #[serde(default)]
    is_datacenter: Option<bool>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    failure: Option<String>,
}

impl From<RemoteRow> for CheckResult {
    fn from(r: RemoteRow) -> Self {
        // The server's words are the engine's words; an unknown one is simply
        // not a failure we can name.
        let failure: Option<Failure> = r
            .failure
            .as_deref()
            .and_then(|f| serde_json::from_value(serde_json::Value::String(f.to_string())).ok());
        let status = match r.status.as_deref() {
            Some("alive") => Status::Alive,
            Some("invalid") => Status::Invalid,
            Some("unresolved") => Status::Unresolved,
            Some("unchecked") => Status::Unchecked,
            Some(_) => Status::Dead,
            None if r.alive => Status::Alive,
            None => Status::Dead,
        };
        let rotating = match (&r.exit_ip, &r.ip) {
            (Some(exit), Some(ip)) => Some(exit != ip),
            _ => None,
        };
        CheckResult {
            input: r.input,
            status,
            ip: r.ip,
            port: r.port,
            alive: r.alive,
            protocols: r.protocols,
            supports_udp: r.supports_udp,
            speed_mbps: r.speed_mbps,
            anonymity: r.anonymity,
            latency_ms: r.latency_ms,
            country_code: r.country_code,
            country: None,
            region: r.region,
            city: r.city,
            asn: r.asn,
            asn_org: r.asn_org,
            is_datacenter: r.is_datacenter,
            error: r.error,
            failure,
            exit_ip: r.exit_ip,
            rotating,
            source: Some("api".into()),
            // Everything below is what the server does not measure. Left empty
            // rather than faked: an invented waterfall would be worse than an
            // absent one.
            ..Default::default()
        }
    }
}

pub(crate) enum Line {
    Result(Box<CheckResult>),
    End,
    /// A blank line, or an event we do not recognise. Ignoring unknown `_event`
    /// values rather than erroring is what lets the server add one without
    /// breaking every installed copy of this app.
    Ignored,
}

pub(crate) fn parse_line(s: &str) -> Line {
    let s = s.trim();
    if s.is_empty() {
        return Line::Ignored;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
        return Line::Ignored;
    };
    if let Some(ev) = v.get("_event").and_then(|e| e.as_str()) {
        return if ev == "end" { Line::End } else { Line::Ignored };
    }
    match serde_json::from_value::<RemoteRow>(v) {
        Ok(row) => Line::Result(Box::new(row.into())),
        Err(_) => Line::Ignored,
    }
}

pub struct Remote {
    url: String,
    client: reqwest::Client,
}

/// Why a chunk did not complete. The caller needs the distinction: everything
/// here means "check these locally instead", but only some of it is worth
/// telling the user about.
#[derive(Debug)]
pub enum RemoteError {
    /// Rate limited. Carries the server's `Retry-After` in seconds when it gave
    /// one, because "try again in 4 minutes" is actionable and "rate limited" is
    /// not.
    RateLimited(Option<u64>),
    /// Anything else: offline, DNS, TLS, a 500, a truncated stream.
    Failed(String),
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::RateLimited(Some(s)) => {
                write!(f, "our API is rate limiting this connection, {s}s to go")
            }
            RemoteError::RateLimited(None) => write!(f, "our API is rate limiting this connection"),
            RemoteError::Failed(m) => write!(f, "{m}"),
        }
    }
}

impl Remote {
    pub fn new(url: String) -> Option<Self> {
        let client = reqwest::Client::builder()
            // No overall timeout: this is a long-lived stream and reqwest's
            // `timeout` applies to the WHOLE response, so setting it would kill
            // a large batch mid-flight for the crime of being large. The read
            // deadline below bounds it instead.
            .connect_timeout(Duration::from_secs(15))
            .build()
            .ok()?;
        Some(Self { url, client })
    }

    /// Check one chunk, calling `on` for each result as it arrives.
    ///
    /// Returns the set of inputs the server actually answered for. The caller
    /// compares that against what it sent: **anything unanswered must be
    /// re-checked locally**, or a proxy silently disappears from the run and is
    /// later reported dead purely because nobody looked at it.
    pub async fn check<F>(
        &self,
        proxies: &[String],
        opts: &CheckOptions,
        mut on: F,
    ) -> Result<std::collections::HashSet<String>, RemoteError>
    where
        F: FnMut(CheckResult),
    {
        let body = serde_json::json!({
            "proxies": proxies,
            "timeout_ms": opts.timeout.as_millis() as u64,
            "retries": opts.retries,
            "protocols": opts.protocols.names(),
            "measure_udp": opts.measure_udp,
            "measure_speed": opts.measure_speed,
        });

        let resp = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|e| RemoteError::Failed(e.to_string()))?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            let secs = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok());
            return Err(RemoteError::RateLimited(secs));
        }
        if !resp.status().is_success() {
            return Err(RemoteError::Failed(format!("API returned {}", resp.status())));
        }

        let mut answered = std::collections::HashSet::new();
        let mut stream = resp.bytes_stream();
        let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
        let deadline = tokio::time::Instant::now() + STREAM_TIMEOUT;

        loop {
            let next = tokio::time::timeout_at(deadline, stream.next()).await;
            let chunk = match next {
                Err(_) => return Err(RemoteError::Failed("API stream timed out".into())),
                Ok(None) => break, // stream closed
                Ok(Some(Err(e))) => return Err(RemoteError::Failed(e.to_string())),
                Ok(Some(Ok(c))) => c,
            };
            buf.extend_from_slice(&chunk);

            // Lines arrive split across TCP reads, so a partial line at the end
            // of a chunk has to stay in the buffer until its newline turns up.
            // Parsing what happens to have arrived would drop a result per read.
            while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let text = String::from_utf8_lossy(&line[..line.len() - 1]);
                match parse_line(&text) {
                    Line::Result(r) => {
                        answered.insert(r.input.clone());
                        on(*r);
                    }
                    Line::End => return Ok(answered),
                    Line::Ignored => {}
                }
            }
        }

        // The stream ended without the terminator. Everything already parsed is
        // still good and is kept; the caller's reconciliation picks up whatever
        // never arrived, so a truncated stream costs accuracy on the tail rather
        // than the whole chunk.
        if !buf.is_empty() {
            if let Line::Result(r) = parse_line(&String::from_utf8_lossy(&buf)) {
                answered.insert(r.input.clone());
                on(*r);
            }
        }
        Ok(answered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_probe::ProtocolSet;

    fn opts() -> CheckOptions {
        CheckOptions {
            timeout: Duration::from_secs(8),
            retries: 0,
            protocols: ProtocolSet {
                http: true,
                https: false,
                socks4: false,
                socks5: true,
            },
            ..Default::default()
        }
    }

    #[test]
    fn parses_a_result_line_and_tags_its_source() {
        let line = r#"{"input":"1.2.3.4:8080","ip":"1.2.3.4","port":8080,"alive":true,"protocols":["http"],"anonymity":"elite","latency_ms":220,"country_code":"DE","city":"Berlin","asn":24940,"asn_org":"Hetzner","is_datacenter":true,"error":null}"#;
        let Line::Result(r) = parse_line(line) else {
            panic!("must parse as a result");
        };
        assert!(r.alive);
        assert_eq!(r.latency_ms, Some(220));
        assert_eq!(r.asn_org.as_deref(), Some("Hetzner"));
        assert_eq!(
            r.source.as_deref(),
            Some("api"),
            "a row must say where it was checked, or the missing waterfall is a mystery"
        );
        // The server does not measure these, and they must stay empty rather
        // than be invented.
        assert!(r.timings.is_empty());
        assert!(r.exit_ip.is_none());
        assert!(r.leaked_headers.is_empty());
    }

    #[test]
    fn recognises_the_terminator() {
        assert!(matches!(parse_line(r#"{"_event":"end"}"#), Line::End));
    }

    /// An unknown event must be skipped, not treated as the end and not treated
    /// as an error. That is what lets the server add an event without breaking
    /// every copy of this app already installed.
    #[test]
    fn skips_events_it_does_not_know() {
        assert!(matches!(parse_line(r#"{"_event":"progress","n":5}"#), Line::Ignored));
        assert!(matches!(parse_line(""), Line::Ignored));
        assert!(matches!(parse_line("   "), Line::Ignored));
        assert!(matches!(parse_line("not json at all"), Line::Ignored));
    }

    /// SSRF-screened lines come back shaped like a result with `error`. They are
    /// real answers about real input and must reach the UI.
    #[test]
    fn an_ssrf_blocked_line_is_still_a_result() {
        let line =
            r#"{"input":"127.0.0.1:8080","ip":null,"port":null,"alive":false,"protocols":[],"error":"unreachable"}"#;
        let Line::Result(r) = parse_line(line) else {
            panic!("a blocked line is an answer, not noise");
        };
        assert!(!r.alive);
        assert_eq!(r.error.as_deref(), Some("unreachable"));
        assert_eq!(r.input, "127.0.0.1:8080");
    }

    #[test]
    fn only_selected_protocols_are_requested() {
        assert_eq!(opts().protocols.names(), vec!["http", "socks5"]);
    }

    #[test]
    fn the_servers_status_and_failure_words_are_understood() {
        let line = r#"{"input":"1.2.3.4:8080","status":"dead","ip":"1.2.3.4","port":8080,"alive":false,"protocols":[],"failure":"no_echo","error":"answered 200, not a proxy"}"#;
        let Line::Result(r) = parse_line(line) else {
            panic!("must parse")
        };
        assert_eq!(r.status, Status::Dead);
        assert_eq!(r.failure, Some(Failure::NoEcho));
        let line = r#"{"input":"gw.example.com:9","status":"alive","ip":"198.51.100.83","exit_ip":"198.51.100.26","port":9,"alive":true,"protocols":["http"]}"#;
        let Line::Result(r) = parse_line(line) else {
            panic!("must parse")
        };
        assert_eq!(r.status, Status::Alive);
        assert_eq!(r.rotating, Some(true), "a gateway whose exit differs from its door");
    }
}
