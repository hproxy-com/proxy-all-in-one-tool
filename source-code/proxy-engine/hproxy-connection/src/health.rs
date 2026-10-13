//! One probe through the relay: does traffic really get through, how long it
//! takes, and which address it comes out with.
//!
//! The probe goes THROUGH the relay to our own judge: a CONNECT, TLS end to
//! end, and an answer that names the address it saw on the wire. That is what
//! lets a screen say "you appear as 203.0.113.9 in Frankfurt, 140 ms" and,
//! when a proxy dies, "not answering" instead of nothing. A person may point
//! the probe anywhere else; then it measures reachability and the round trip,
//! and only a Cloudflare `/cdn-cgi/trace` page can still name the exit.

use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use hproxy_api::geo::Geo;
use serde::Serialize;

/// How long one probe may take. The relay's own dial budget is inside this.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// The default probe target: our TLS judge.
pub const DEFAULT_PROBE_URL: &str = hproxy_probe::judge::DEFAULT_ECHO_TLS;

/// What a probe target can tell us.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeKind {
    /// Our judge: JSON with the trusted peer address.
    Echo,
    /// A Cloudflare `/cdn-cgi/trace` page: its `ip=` line names the exit.
    Trace,
    /// Anything else: a 2xx or 3xx answer means the tunnel works.
    Plain,
}

pub fn probe_kind(url: &str) -> ProbeKind {
    if url == DEFAULT_PROBE_URL {
        ProbeKind::Echo
    } else if url.trim_end_matches('/').ends_with("/cdn-cgi/trace") {
        ProbeKind::Trace
    } else {
        ProbeKind::Plain
    }
}

/// A probe URL a person asked for: absolute, http or https, nothing else.
/// Empty means the default.
pub fn probe_url_from(url: Option<String>) -> Result<String, String> {
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

pub fn host_of(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// The `ip=` line of a Cloudflare trace page.
pub fn trace_ip(body: &str) -> Option<String> {
    body.lines()
        .find_map(|l| l.strip_prefix("ip="))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// What the last probe through the relay found.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Health {
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub exit_ip: Option<String>,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub asn_org: Option<String>,
    /// Whether the exit's network is a data center.
    pub datacenter: Option<bool>,
    /// The exit's IANA time zone, e.g. "Europe/Berlin": the leak check compares
    /// it with the device's clock.
    pub timezone: Option<String>,
    /// Where the exit is: its city when known, else the middle of its country
    /// (the map flies there and puts the pin on it).
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
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

impl Health {
    /// A probe that failed, with its reason.
    pub fn failed(error: String, target: String, reflects_exit: bool, checked_at_ms: u64) -> Health {
        Health {
            ok: false,
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
            error: Some(error),
            checked_at_ms,
            failures_in_a_row: 0,
            target,
            reflects_exit,
        }
    }
}

/// The last probe's answer and how many failed in a row.
#[derive(Default)]
pub struct HealthState {
    pub last: Option<Health>,
    pub failures_in_a_row: u32,
}

/// Keep a probe's answer, counting failures in a row (a success resets them).
pub fn record(state: &Mutex<HealthState>, mut h: Health) -> Health {
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    st.failures_in_a_row = if h.ok { 0 } else { st.failures_in_a_row + 1 };
    h.failures_in_a_row = st.failures_in_a_row;
    st.last = Some(h.clone());
    h
}

/// One probe through the relay on `listen` to `url`: the round trip, and when
/// the target can name it, the exit address and where it lives. `program`
/// names the door in the server's logs ("hproxy-phone", "hproxy-checker").
pub async fn probe_once(listen: SocketAddr, geo: &Geo, url: &str, program: &str) -> Health {
    let kind = probe_kind(url);
    let target = host_of(url);
    let started = Instant::now();
    let outcome: Result<Option<String>, String> = async {
        let proxy = reqwest::Proxy::all(format!("http://{listen}")).map_err(|e| e.to_string())?;
        let client = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(PROBE_TIMEOUT)
            .user_agent(format!("{program}/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("could not build the probe client: {e}"))?;
        let resp = client.get(url).send().await.map_err(|e| in_words(&e, &target))?;
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
    let checked_at_ms = crate::now_ms();
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
                datacenter: label.as_ref().and_then(|l| l.is_datacenter),
                timezone: label.as_ref().and_then(|l| l.timezone.clone()),
                latitude: label.as_ref().and_then(|l| l.latitude),
                longitude: label.as_ref().and_then(|l| l.longitude),
                error: None,
                checked_at_ms,
                failures_in_a_row: 0,
                target,
                reflects_exit,
            }
        }
        Err(e) => Health::failed(e, target, reflects_exit, checked_at_ms),
    }
}

/// Why the probe's request failed, in words a person reads. reqwest's own top line ("error
/// sending request") names no reason; the reason is further down its chain of causes. The probe
/// asks our relay, which answers 502 when the proxy behind it fails, and reqwest reports that as
/// an unsuccessful tunnel.
fn in_words(e: &reqwest::Error, target: &str) -> String {
    if e.is_timeout() {
        return format!("no answer from {target} within {} seconds", PROBE_TIMEOUT.as_secs());
    }
    let mut chain = String::new();
    let mut kind = None;
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        if kind.is_none() {
            kind = s.downcast_ref::<std::io::Error>().map(std::io::Error::kind);
        }
        chain.push_str(&s.to_string());
        chain.push_str(" | ");
        src = s.source();
    }
    words_for(kind, &chain, target)
}

/// The words for a failed probe. The system's part is read by its kind, never its text: that text
/// is in the device's language ("Es konnte keine Verbindung hergestellt werden" on a German
/// computer). reqwest's and hyper's own words are always English, so they may be read.
fn words_for(kind: Option<std::io::ErrorKind>, chain: &str, target: &str) -> String {
    use std::io::ErrorKind as K;
    match kind {
        Some(K::ConnectionRefused) => return "the connection was refused".into(),
        Some(K::ConnectionReset | K::ConnectionAborted | K::UnexpectedEof | K::BrokenPipe) => {
            return "the proxy closed the connection".into();
        }
        Some(K::TimedOut) => return format!("no answer from {target} within {} seconds", PROBE_TIMEOUT.as_secs()),
        _ => {}
    }
    let lower = chain.to_lowercase();
    if lower.contains("tunnel error: unsuccessful") {
        // The relay answered 502: the proxy behind it failed or would not go there.
        format!("the proxy did not open {target}")
    } else if lower.contains("underlying connection") {
        "the proxy could not be reached".into()
    } else if lower.contains("certificate") || lower.contains("unknownissuer") || lower.contains("notvalidforname") {
        format!("the proxy showed a false certificate for {target}")
    } else if lower.contains("connection closed") || lower.contains("incomplete") {
        "the proxy closed the connection".into()
    } else {
        format!("the proxy did not carry the request to {target}")
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
    fn failures_count_up_and_reset_on_success() {
        let state = Mutex::new(HealthState::default());
        let dead = |at| Health::failed("no answer".into(), "hproxy.com".into(), true, at);
        record(&state, dead(1));
        let second = record(&state, dead(2));
        assert_eq!(second.failures_in_a_row, 2);
        let mut alive = dead(3);
        alive.ok = true;
        alive.error = None;
        assert_eq!(record(&state, alive).failures_in_a_row, 0);
        assert_eq!(state.lock().unwrap().failures_in_a_row, 0);
    }

    #[tokio::test]
    async fn a_relay_that_is_not_there_is_a_failed_probe_with_a_reason() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let geo = Geo::new("");
        let h = probe_once(closed, &geo, DEFAULT_PROBE_URL, "hproxy-test").await;
        assert!(!h.ok);
        assert_eq!(h.error.as_deref(), Some("the connection was refused"));
        assert!(h.exit_ip.is_none());
    }

    #[tokio::test]
    async fn a_proxy_failing_behind_the_relay_is_said_in_words() {
        // What our relay answers when the proxy behind it fails: 502 to the CONNECT.
        let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = relay.local_addr().unwrap();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut s, _)) = relay.accept().await {
                let mut head = [0u8; 2048];
                let _ = s.read(&mut head).await;
                let _ = s
                    .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                    .await;
            }
        });
        let geo = Geo::new("");
        let h = probe_once(addr, &geo, DEFAULT_PROBE_URL, "hproxy-test").await;
        assert!(!h.ok);
        assert_eq!(
            h.error,
            Some(format!("the proxy did not open {}", host_of(DEFAULT_PROBE_URL)))
        );
    }

    #[test]
    fn failures_are_said_in_words() {
        use std::io::ErrorKind as K;
        let words = |kind, chain| words_for(kind, chain, "hproxy.com");
        // The chains as reqwest 0.12 really writes them (read off a failing probe).
        assert_eq!(
            words(None, "client error (Connect) | tunnel error: unsuccessful | "),
            "the proxy did not open hproxy.com"
        );
        // A German computer: the system's sentence is not read, its kind is.
        let german = "client error (Connect) | tunnel error: failed to create underlying connection | tcp connect error | \
                      Es konnte keine Verbindung hergestellt werden, da der Zielcomputer die Verbindung verweigerte. (os error 10061) | ";
        assert_eq!(words(Some(K::ConnectionRefused), german), "the connection was refused");
        assert_eq!(
            words(Some(K::ConnectionReset), "x | "),
            "the proxy closed the connection"
        );
        assert_eq!(
            words(
                None,
                "client error (Connect) | invalid peer certificate: UnknownIssuer | "
            ),
            "the proxy showed a false certificate for hproxy.com"
        );
        assert_eq!(
            words(None, "connection closed before message completed | "),
            "the proxy closed the connection"
        );
        assert_eq!(
            words(None, "something nobody foresaw | "),
            "the proxy did not carry the request to hproxy.com"
        );
    }
}
