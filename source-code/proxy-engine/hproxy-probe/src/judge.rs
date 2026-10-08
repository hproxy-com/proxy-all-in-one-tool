//! The judges, and the ladder a probe climbs when the first one is out of reach.
//!
//! A judge is an endpoint the proxy is asked to fetch that reflects what it
//! saw. Two kinds exist:
//!
//!   - `Echo`: our own reflector. Answers JSON with the address it saw, every
//!     request header, and the trusted exit. Full anonymity grade.
//!   - `Trace`: Cloudflare's `/cdn-cgi/trace` on our own zone, served at the
//!     edge on port 80 and 443. Reflects the User-Agent (the nonce rides there)
//!     and names the exit as `ip=`. Reflects no other header, so the grade is
//!     capped at anonymous. It is the most reachable address a free proxy can
//!     be asked for: measured 2026-09-06, 21 of 25 relaying proxies reached it
//!     against 8 to 10 for origin ports.
//!
//! A transport climbs its ladder in order and stops at the first rung that
//! answers with the nonce. Only a refused connection ends the climb early
//! (nothing is listening, no rung can help), and even that is overridden for a
//! line with credentials: residential gateways are known to refuse odd origin
//! ports while relaying to port 80 fine, and a paid gateway is worth two more
//! probes. A timeout never ends the climb: rungs two and three are, for a proxy
//! that only accepts some of the connections it gets, the retries that find
//! it. Measured 2026-09-13 on a 2,000-line list: stopping after a timeout made
//! the run eight times faster and reported 110 working proxies dead.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JudgeKind {
    Echo,
    Trace,
}

impl JudgeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JudgeKind::Echo => "echo",
            JudgeKind::Trace => "trace",
        }
    }
}

/// One rung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Judge {
    pub kind: JudgeKind,
    pub host: String,
    pub port: u16,
    pub path: String,
    /// The request to this judge is carried inside TLS. For an HTTP proxy that
    /// means a CONNECT tunnel; for SOCKS it means TLS through the tunnel.
    pub tls: bool,
}

impl Judge {
    /// From a URL like `http://echo.example.com:4505/api/echo`. IPv6 authorities
    /// in brackets are handled, because silently mis-splitting on the colons
    /// would send every probe to a nonsense address.
    pub fn from_url(kind: JudgeKind, url: &str) -> Option<Self> {
        let (rest, tls) = match url.strip_prefix("https://") {
            Some(r) => (r, true),
            None => (url.strip_prefix("http://")?, false),
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].to_string()),
            None => (rest, "/".to_string()),
        };
        let default_port = if tls { 443 } else { 80 };
        let (host, port) = if let Some(close) = authority.strip_prefix('[').and_then(|a| a.find(']')) {
            let host = authority[1..=close].to_string();
            let port = authority[close + 2..]
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .unwrap_or(default_port);
            (host, port)
        } else {
            match authority.rsplit_once(':') {
                Some((h, p)) => match p.parse() {
                    Ok(port) => (h.to_string(), port),
                    Err(_) => (authority.to_string(), default_port),
                },
                None => (authority.to_string(), default_port),
            }
        };
        if host.is_empty() {
            return None;
        }
        Some(Judge {
            kind,
            host,
            port,
            path,
            tls,
        })
    }

    pub fn echo(url: &str) -> Option<Self> {
        Self::from_url(JudgeKind::Echo, url)
    }

    pub fn trace(url: &str) -> Option<Self> {
        Self::from_url(JudgeKind::Trace, url)
    }

    /// `host:port`, omitting the port when it is the scheme default, because
    /// some picky origins compare `Host` against their configured server name.
    pub fn authority(&self) -> String {
        let default = if self.tls { 443 } else { 80 };
        let host = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == default {
            host
        } else {
            format!("{host}:{}", self.port)
        }
    }

    /// `host:port` with the port always written: the form a CONNECT line and
    /// its Host header need (RFC 9110, authority-form). `authority()` leaves a
    /// default port out, which is right for the request inside the tunnel and
    /// wrong here: Squid and many others answer `CONNECT hproxy.com` with a
    /// 400, and the proxy then reads as having no HTTPS at all.
    pub fn connect_target(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    pub fn url(&self) -> String {
        format!(
            "{}://{}{}",
            if self.tls { "https" } else { "http" },
            self.authority(),
            self.path
        )
    }
}

/// The rungs, per transport shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ladder {
    /// For plain HTTP forwarding and for SOCKS tunnels: reached over plain
    /// HTTP inside whatever the proxy carries. The first rung grades anonymity.
    pub plain: Vec<Judge>,
    /// For the HTTPS transport: reached through a CONNECT tunnel with TLS
    /// inside. A plain-HTTP relay must never earn the https flag, so no plain
    /// rung is ever used here.
    pub tls: Vec<Judge>,
    /// The URL the engine fetches directly, no proxy, to learn this machine's
    /// own public address. Without it a transparent proxy cannot be told from
    /// an anonymous one.
    pub own_address: Judge,
}

/// The public HProxy judges. `echo.hproxy.com` is a DNS-only record straight to
/// the origin on a plain port, because anonymity grading needs plain HTTP with
/// no redirect and no CDN in front: Cloudflare redirects plain HTTP to HTTPS
/// and stamps its own forwarding headers on every request, which would grade
/// every proxy anonymous.
pub const DEFAULT_ECHO_PLAIN: &str = "http://echo.hproxy.com:4505/api/free-proxy/echo";
pub const DEFAULT_ECHO_TLS: &str = "https://hproxy.com/api/free-proxy/echo";
pub const DEFAULT_TRACE_PLAIN: &str = "http://hproxy.com/cdn-cgi/trace";
pub const DEFAULT_TRACE_TLS: &str = "https://hproxy.com/cdn-cgi/trace";

impl Ladder {
    /// The public ladder every open-source door uses.
    pub fn public() -> Self {
        Self::from_urls(
            DEFAULT_ECHO_PLAIN,
            DEFAULT_ECHO_TLS,
            DEFAULT_TRACE_PLAIN,
            DEFAULT_TRACE_TLS,
        )
        .expect("the default judge URLs parse")
    }

    /// A ladder from four URLs: the plain echo, the TLS echo, and the trace
    /// over plain and TLS. Empty trace URLs drop those rungs.
    pub fn from_urls(echo_plain: &str, echo_tls: &str, trace_plain: &str, trace_tls: &str) -> Option<Self> {
        let plain_echo = Judge::echo(echo_plain)?;
        let tls_echo = Judge::echo(echo_tls)?;
        let mut plain = vec![plain_echo.clone()];
        if let Some(t) = Judge::trace(trace_plain).filter(|_| !trace_plain.trim().is_empty()) {
            plain.push(t);
        }
        let mut tls = vec![tls_echo];
        if let Some(t) = Judge::trace(trace_tls).filter(|j| !trace_tls.trim().is_empty() && j.tls) {
            tls.push(t);
        }
        Some(Ladder {
            plain,
            tls,
            own_address: plain_echo,
        })
    }

    /// The first plain echo rung: the one that grades anonymity.
    pub fn primary(&self) -> &Judge {
        &self.plain[0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_urls_including_ports_and_ipv6() {
        let j = Judge::echo("http://echo.hproxy.com:4505/api/free-proxy/echo").unwrap();
        assert_eq!(
            (j.host.as_str(), j.port, j.path.as_str(), j.tls),
            ("echo.hproxy.com", 4505, "/api/free-proxy/echo", false)
        );
        let j = Judge::echo("https://hproxy.com/api/free-proxy/echo").unwrap();
        assert_eq!((j.host.as_str(), j.port, j.tls), ("hproxy.com", 443, true));
        let j = Judge::trace("http://example.com").unwrap();
        assert_eq!((j.port, j.path.as_str()), (80, "/"));
        let j = Judge::echo("http://[2001:db8::1]:4505/echo").unwrap();
        assert_eq!((j.host.as_str(), j.port), ("2001:db8::1", 4505));
        assert_eq!(j.authority(), "[2001:db8::1]:4505");
        assert!(Judge::echo("ftp://x/").is_none());
        assert!(Judge::echo("http:///x").is_none());
    }

    #[test]
    fn authority_omits_the_default_port() {
        assert_eq!(Judge::echo("https://hproxy.com/x").unwrap().authority(), "hproxy.com");
        assert_eq!(
            Judge::echo("http://echo.hproxy.com:4505/x").unwrap().authority(),
            "echo.hproxy.com:4505"
        );
        assert_eq!(
            Judge::echo("http://hproxy.com:80/x").unwrap().url(),
            "http://hproxy.com/x"
        );
    }

    #[test]
    fn a_connect_target_always_carries_the_port() {
        let j = Judge::echo("https://hproxy.com/api/free-proxy/echo").unwrap();
        assert_eq!(j.authority(), "hproxy.com", "the Host inside the tunnel omits it");
        assert_eq!(j.connect_target(), "hproxy.com:443", "the CONNECT line must not");
        assert_eq!(
            Judge::echo("https://[2001:db8::1]/x").unwrap().connect_target(),
            "[2001:db8::1]:443"
        );
        assert_eq!(
            Judge::echo("http://echo.example:4505/x").unwrap().connect_target(),
            "echo.example:4505"
        );
    }

    #[test]
    fn the_public_ladder_has_the_expected_shape() {
        let l = Ladder::public();
        assert_eq!(l.plain.len(), 2);
        assert_eq!(l.plain[0].kind, JudgeKind::Echo);
        assert_eq!(l.plain[1].kind, JudgeKind::Trace);
        assert!(!l.plain[0].tls && !l.plain[1].tls, "plain rungs stay plain");
        assert_eq!(l.tls.len(), 2);
        assert!(
            l.tls.iter().all(|j| j.tls),
            "a plain relay must never earn the https flag"
        );
        assert_eq!(l.own_address.host, "echo.hproxy.com");
    }

    #[test]
    fn empty_trace_urls_drop_the_rung() {
        let l = Ladder::from_urls("http://e.example:4505/echo", "https://e.example/echo", "", "").unwrap();
        assert_eq!(l.plain.len(), 1);
        assert_eq!(l.tls.len(), 1);
    }
}
