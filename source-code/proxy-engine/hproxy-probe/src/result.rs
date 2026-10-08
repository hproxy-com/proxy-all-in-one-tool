//! The one row every door reads, and the words a dead proxy is described with.
//!
//! `CheckResult` serialises with snake_case names that match the website's
//! checker row, so the desktop table, the CLI's JSON and the API's stream are
//! one shape. A field that a door cannot measure stays empty rather than
//! invented: an absent waterfall is honest, a made-up one is not.

use serde::{Deserialize, Serialize};

/// Network-friendly default: how many proxies are probed at once. A home
/// router's connection table chokes long before a modern CPU does, which is
/// what makes "1000-thread" checkers knock a home connection offline. The
/// governor climbs above this only while the link shows headroom.
pub const DEFAULT_CONCURRENCY: usize = 64;
/// Absolute ceiling any caller may ask for. Reaching it is a deliberate,
/// warned-about choice, never a default.
pub const MAX_CONCURRENCY: usize = 1000;

/// Sockets one in-flight slot can hold at once: up to four transports per
/// proxy, and a TLS handshake through a proxy can briefly hold more than one.
const SOCKETS_PER_SLOT: u64 = 5;
/// Descriptors left for everything that is not a probe: the window, file
/// dialogs, exports, the runtime itself.
const RESERVED_FDS: u64 = 128;

/// The highest concurrency this machine can actually sustain.
///
/// On Unix a socket is a file descriptor and macOS ships a soft limit of 256,
/// below the ceiling and not far above the default once four transports per
/// proxy are counted. Past the limit, `connect` fails with "too many open
/// files" and the tool reports perfectly good proxies as dead. So the soft
/// limit is raised toward the hard limit (no privileges needed) and the request
/// is clamped to what the descriptors allow. Windows does not cap sockets this
/// way, so there it is a straight pass-through.
pub fn sustainable_concurrency(requested: usize) -> usize {
    let requested = requested.clamp(1, MAX_CONCURRENCY);
    match os_fd_ceiling() {
        Some(limit) => {
            let usable = limit.saturating_sub(RESERVED_FDS) / SOCKETS_PER_SLOT;
            let usable = usize::try_from(usable).unwrap_or(usize::MAX).max(1);
            requested.min(usable)
        }
        None => requested,
    }
}

#[cfg(unix)]
fn os_fd_ceiling() -> Option<u64> {
    rlimit::increase_nofile_limit(u64::MAX).ok()
}

#[cfg(not(unix))]
fn os_fd_ceiling() -> Option<u64> {
    None
}

/// What happened to one input line. `alive` keeps its plain meaning; this says
/// which of the several kinds of "not alive" it was, because a line we could
/// not read is not a dead proxy and must not be painted as one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// At least one transport relayed our request to a judge.
    Alive,
    /// Every transport failed. `failure` says how.
    #[default]
    Dead,
    /// The line could not be read as a proxy at all.
    Invalid,
    /// A gateway name that DNS could not resolve.
    Unresolved,
    /// Skipped: the run was cancelled, or no protocol was selected.
    Unchecked,
}

/// The fixed failure vocabulary. Small and stable on purpose: these get stored,
/// grouped and filtered, so a free-form string would be useless within a week.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    /// Nothing answered within the budget.
    Timeout,
    /// The connection was refused or reset: nothing is listening, or the proxy
    /// hung up during the handshake.
    Refused,
    /// The proxy's hostname did not resolve.
    Unresolved,
    /// The proxy answered the handshake and demanded a login (HTTP 407, or a
    /// SOCKS5 method or auth refusal).
    AuthRequired,
    /// The proxy answered and refused the destination (HTTP 403, SOCKS reply
    /// "not allowed by ruleset").
    Forbidden,
    /// The proxy spoke the protocol but answered with some other status.
    BadStatus,
    /// The TLS handshake through the tunnel failed.
    #[serde(rename = "tls_error")]
    Tls,
    /// The socket broke mid-exchange, or the reply was not HTTP at all.
    #[serde(rename = "transport_error")]
    Transport,
    /// Answered 200, but the body was not our echo: a web server, a captive
    /// portal or an interstitial that says yes to everything. The single most
    /// common decoy on a scraped list.
    NoEcho,
}

impl Failure {
    /// The wire word, for filters and SQL.
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Timeout => "timeout",
            Failure::Refused => "refused",
            Failure::Unresolved => "unresolved",
            Failure::AuthRequired => "auth_required",
            Failure::Forbidden => "forbidden",
            Failure::BadStatus => "bad_status",
            Failure::Tls => "tls_error",
            Failure::Transport => "transport_error",
            Failure::NoEcho => "no_echo",
        }
    }

    /// Ranking by information content, most specific first. When four
    /// transports fail four different ways the row reports the one that says
    /// the most: "answered 407" beats "refused", because refused is the default
    /// state of the whole internet.
    pub fn rank(self) -> u8 {
        match self {
            Failure::AuthRequired => 0,
            Failure::Forbidden => 1,
            Failure::NoEcho => 2,
            Failure::BadStatus => 3,
            Failure::Tls => 4,
            Failure::Transport => 5,
            Failure::Unresolved => 6,
            Failure::Timeout => 7,
            Failure::Refused => 8,
        }
    }
}

/// Where inside a probe the failure happened. With the elapsed time this is
/// the whole diagnosis: "refused in 38 ms" means the port is closed, "timed
/// out after 8 s at connect" means something is silently dropping packets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Dns,
    Connect,
    Handshake,
    Tls,
    Request,
    Response,
}

/// One transport's failure, with the evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FailureDetail {
    pub kind: Failure,
    pub phase: Phase,
    /// How long the probe ran before giving up.
    pub elapsed_ms: u32,
    /// The HTTP or SOCKS status the proxy answered with, when it answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl FailureDetail {
    /// One plain sentence for a person. The wire word is for machines.
    pub fn sentence(&self) -> String {
        let secs = |ms: u32| format!("{:.1} s", ms as f64 / 1000.0);
        match self.kind {
            Failure::Timeout => match self.phase {
                Phase::Dns => format!("the hostname did not resolve within {}", secs(self.elapsed_ms)),
                Phase::Connect => format!("no answer to the connection after {}", secs(self.elapsed_ms)),
                Phase::Handshake => format!(
                    "connected, but the proxy never finished the handshake ({})",
                    secs(self.elapsed_ms)
                ),
                Phase::Tls => format!("the tunnel opened, but TLS never completed ({})", secs(self.elapsed_ms)),
                Phase::Request | Phase::Response => format!("connected, but no reply after {}", secs(self.elapsed_ms)),
            },
            Failure::Refused => match self.phase {
                Phase::Connect => format!(
                    "connection refused in {} ms: nothing is listening on that port",
                    self.elapsed_ms
                ),
                _ => format!("the proxy closed the connection after {} ms", self.elapsed_ms),
            },
            Failure::Unresolved => "the hostname does not resolve".to_string(),
            Failure::AuthRequired => match self.status {
                Some(407) => "the proxy wants a username and password (407)".to_string(),
                _ => "the proxy rejected the login".to_string(),
            },
            Failure::Forbidden => match self.status {
                Some(s) => format!("the proxy refused to relay to the judge ({s})"),
                None => "the proxy refused to relay to the judge".to_string(),
            },
            Failure::BadStatus => match self.status {
                // SOCKS reply codes are single digits; HTTP statuses start at 100.
                Some(s) if s < 100 => format!(
                    "the proxy accepted the handshake but could not reach the judge (SOCKS reply {s}: {})",
                    socks_reply(s)
                ),
                Some(s) => format!("the proxy answered {s} instead of relaying"),
                None => "the proxy answered with an unexpected status".to_string(),
            },
            Failure::Tls => "the TLS handshake through the tunnel failed".to_string(),
            Failure::Transport => "the connection broke before a reply arrived".to_string(),
            Failure::NoEcho => {
                "answered 200, but it is not a proxy: the reply was its own page, not our judge".to_string()
            }
        }
    }
}

/// The SOCKS5 reply codes (RFC 1928), in words.
fn socks_reply(code: u16) -> &'static str {
    match code {
        1 => "general failure",
        2 => "not allowed by ruleset",
        3 => "network unreachable",
        4 => "host unreachable",
        5 => "connection refused",
        6 => "TTL expired",
        7 => "command not supported",
        8 => "address type not supported",
        _ => "unknown",
    }
}

/// Where the time went inside one probe.
///
/// Every number is a PHASE DURATION in milliseconds, never a running total.
/// A 900 ms proxy that spent 850 ms connecting is far away and will be quick
/// for somebody nearer it. One that connected in 40 ms and then waited 830 ms
/// for the first byte is overloaded and will be slow for everyone. One
/// aggregate number cannot tell those apart.
///
/// `dns_ms` is `None` when the proxy was pasted as a literal address (no
/// lookup happened), `handshake_ms` is `None` for plain HTTP (no admission
/// step), `tls_ms` is `None` unless a tunnel carried TLS. `total_ms` is the
/// wall clock of the whole probe; the gap to the sum of the phases is body
/// transfer, exactly as a browser's network waterfall shows it.
#[derive(Debug, Default, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Timings {
    pub dns_ms: Option<u32>,
    pub connect_ms: u32,
    pub handshake_ms: Option<u32>,
    pub tls_ms: Option<u32>,
    pub ttfb_ms: u32,
    pub total_ms: u32,
}

/// Timings tagged with the transport that produced them. A proxy that answers
/// on both HTTP and SOCKS5 has two genuinely different profiles.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProtocolTiming {
    pub protocol: String,
    pub timings: Timings,
}

/// One header the proxy added that told the far end something about you. The
/// value is the diagnosis: `x-forwarded-for: <your address>` is the difference
/// between "this proxy announces itself" and "this proxy announces you".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeakedHeader {
    pub name: String,
    pub value: String,
}

/// One row of output.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CheckResult {
    /// The exact line the user pasted. Consumers key results back to input
    /// rows on this, so it round-trips verbatim.
    pub input: String,
    pub status: Status,
    /// The address we dialled (the door).
    pub ip: Option<String>,
    pub port: Option<u16>,
    pub alive: bool,
    pub protocols: Vec<String>,
    /// `transparent`, `anonymous` or `elite`. See [`crate::grade`].
    pub anonymity: Option<String>,
    /// The best transport's `total_ms`, so it can never disagree with the
    /// breakdown in `timings`.
    pub latency_ms: Option<i32>,
    /// Whether the proxy relays UDP. `None` unless the check asked.
    pub supports_udp: Option<bool>,
    /// Download throughput in Mbit/s. `None` unless the check asked.
    pub speed_mbps: Option<f64>,
    // Geo. Filled by the door that has a lookup source; the engine leaves them
    // empty because it has none.
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub region: Option<String>,
    pub city: Option<String>,
    pub asn: Option<i32>,
    pub asn_org: Option<String>,
    pub is_datacenter: Option<bool>,
    /// One plain sentence when the row is not alive. For people.
    pub error: Option<String>,
    /// The wire word for the same thing. For filters and machines.
    pub failure: Option<Failure>,
    /// The failure of each transport that was tried, with phase and timing.
    pub failures: Vec<TransportFailure>,

    // ── Analyst detail ───────────────────────────────────────────────────────
    /// The address the far end actually saw: where traffic comes OUT, as
    /// opposed to `ip`, where it went in. Taken only from a judge's trusted
    /// peer field, never from a header the proxy could have written.
    pub exit_ip: Option<String>,
    /// `exit_ip` differs from the address dialled: a rotating gateway, a pool
    /// or an onward chain. `None` means unknown, not no.
    pub rotating: Option<bool>,
    /// One entry per transport that answered.
    pub timings: Vec<ProtocolTiming>,
    /// Proxy software, from `Via` / `X-Cache` / `Proxy-Agent`.
    pub server: Option<String>,
    /// Exactly which headers leaked, with values. The evidence behind the grade.
    pub leaked_headers: Vec<LeakedHeader>,
    /// The proxy relayed HTTPS with a certificate that is not the far end's
    /// real one: it re-signs TLS with its own authority, so it can read what
    /// passes through, passwords included. `None` when no HTTPS was relayed.
    pub tls_intercepted: Option<bool>,
    /// The proxy advertised a persistent connection. Provable true, never
    /// provably false: every request we send asks it to close.
    pub keep_alive: Option<bool>,
    /// Which judge rung answered: `echo` (full headers, exact grade) or `trace`
    /// (Cloudflare's reflector, exit known, grade capped at anonymous).
    pub judge: Option<String>,
    /// Which machine did the checking: `local` or `api`.
    pub source: Option<String>,
}

/// One transport's failure, so a reader can see that HTTP was refused in 38 ms
/// while SOCKS5 timed out, which are two different facts about one port.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransportFailure {
    pub protocol: String,
    #[serde(flatten)]
    pub detail: FailureDetail,
}

impl CheckResult {
    /// A row for a line that could not be read as a proxy.
    pub fn invalid(input: impl Into<String>, why: impl Into<String>) -> Self {
        Self {
            input: input.into(),
            status: Status::Invalid,
            error: Some(why.into()),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_exceeds_the_request_or_the_ceiling() {
        assert!(sustainable_concurrency(DEFAULT_CONCURRENCY) <= DEFAULT_CONCURRENCY);
        assert!(sustainable_concurrency(MAX_CONCURRENCY) <= MAX_CONCURRENCY);
        assert!(sustainable_concurrency(usize::MAX) <= MAX_CONCURRENCY);
    }

    #[test]
    fn always_at_least_one() {
        assert!(sustainable_concurrency(0) >= 1);
        assert!(sustainable_concurrency(1) >= 1);
    }

    #[test]
    fn is_a_clamp_not_a_transform() {
        for want in [1, 8, 64, 250, 999] {
            let got = sustainable_concurrency(want);
            assert!(got <= want, "{got} must never exceed the requested {want}");
            assert!(got >= 1);
        }
    }

    #[test]
    fn failure_words_are_stable() {
        assert_eq!(Failure::NoEcho.as_str(), "no_echo");
        assert_eq!(Failure::AuthRequired.as_str(), "auth_required");
        // The wire word and the serialised word are the same word.
        for f in [
            Failure::Timeout,
            Failure::Refused,
            Failure::Unresolved,
            Failure::AuthRequired,
            Failure::Forbidden,
            Failure::BadStatus,
            Failure::Tls,
            Failure::Transport,
            Failure::NoEcho,
        ] {
            assert_eq!(serde_json::to_string(&f).unwrap(), format!("\"{}\"", f.as_str()));
        }
        assert_eq!(serde_json::to_string(&Status::Alive).unwrap(), "\"alive\"");
    }

    #[test]
    fn the_most_informative_failure_ranks_first() {
        assert!(Failure::AuthRequired.rank() < Failure::NoEcho.rank());
        assert!(Failure::NoEcho.rank() < Failure::BadStatus.rank());
        assert!(Failure::Timeout.rank() < Failure::Refused.rank());
    }

    /// A SOCKS reply code is a single digit. Printed as "answered 5" it reads
    /// like an HTTP status that does not exist; seen live on 2026-09-17.
    #[test]
    fn a_socks_reply_code_is_named_not_printed_as_a_status() {
        let socks = FailureDetail {
            kind: Failure::BadStatus,
            phase: Phase::Handshake,
            elapsed_ms: 300,
            status: Some(5),
        };
        assert!(
            socks.sentence().contains("SOCKS reply 5: connection refused"),
            "{}",
            socks.sentence()
        );
        let http = FailureDetail {
            kind: Failure::BadStatus,
            phase: Phase::Response,
            elapsed_ms: 300,
            status: Some(404),
        };
        assert!(http.sentence().contains("answered 404"));
    }

    #[test]
    fn sentences_carry_the_evidence() {
        let refused = FailureDetail {
            kind: Failure::Refused,
            phase: Phase::Connect,
            elapsed_ms: 38,
            status: None,
        };
        assert!(refused.sentence().contains("38 ms"));
        assert!(refused.sentence().contains("nothing is listening"));

        let timeout = FailureDetail {
            kind: Failure::Timeout,
            phase: Phase::Connect,
            elapsed_ms: 8000,
            status: None,
        };
        assert!(timeout.sentence().contains("8.0 s"));

        let auth = FailureDetail {
            kind: Failure::AuthRequired,
            phase: Phase::Handshake,
            elapsed_ms: 90,
            status: Some(407),
        };
        assert!(auth.sentence().contains("407"));

        let decoy = FailureDetail {
            kind: Failure::NoEcho,
            phase: Phase::Response,
            elapsed_ms: 400,
            status: Some(200),
        };
        assert!(decoy.sentence().contains("not a proxy"));
    }

    #[test]
    fn the_row_serialises_with_snake_case_names() {
        let r = CheckResult {
            input: "1.2.3.4:8080".into(),
            status: Status::Alive,
            alive: true,
            protocols: vec!["http".into()],
            latency_ms: Some(120),
            ..Default::default()
        };
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"latency_ms\":120"));
        assert!(json.contains("\"status\":\"alive\""));
        assert!(json.contains("\"exit_ip\":null"));
    }
}
