//! What the proxy told us about itself, on top of whether it works: which
//! software runs it, and exactly which headers it added on your behalf. The
//! anonymity grade is a one-word verdict; this is the evidence under it.

use crate::grade::LEAK_HEADERS;
use crate::result::LeakedHeader;
use std::collections::HashMap;

/// Substrings that name proxy software, mapped to how we display them. Order
/// matters: the more specific entry comes first, or "Apache Traffic Server" is
/// reported as plain "Apache".
const SOFTWARE: &[(&str, &str)] = &[
    ("apache traffic server", "Apache Traffic Server"),
    ("trafficserver", "Apache Traffic Server"),
    ("mikrotik", "MikroTik"),
    ("tinyproxy", "Tinyproxy"),
    ("litespeed", "LiteSpeed"),
    ("haproxy", "HAProxy"),
    ("squid", "Squid"),
    ("varnish", "Varnish"),
    ("privoxy", "Privoxy"),
    ("polipo", "Polipo"),
    ("3proxy", "3proxy"),
    ("ccproxy", "CCProxy"),
    ("wingate", "WinGate"),
    ("kerio", "Kerio"),
    ("bluecoat", "Blue Coat"),
    ("proxysg", "Blue Coat ProxySG"),
    ("zscaler", "Zscaler"),
    ("fortigate", "FortiGate"),
    ("fortinet", "FortiGate"),
    ("websense", "Forcepoint"),
    ("forcepoint", "Forcepoint"),
    ("sophos", "Sophos"),
    ("artica", "Artica"),
    ("ziproxy", "Ziproxy"),
    ("delegate", "DeleGate"),
    ("mitmproxy", "mitmproxy"),
    ("goproxy", "goproxy"),
    ("envoy", "Envoy"),
    ("traefik", "Traefik"),
    ("cloudflare", "Cloudflare"),
    ("nginx", "nginx"),
    ("apache", "Apache"),
];

/// Request headers that carry the proxy's identity as the judge received them.
/// `Via` is the standards-blessed one; the rest are what real deployments emit.
const IDENTITY_HEADERS: &[&str] = &[
    "via",
    "x-cache",
    "x-cache-lookup",
    "proxy-agent",
    "x-proxy-id",
    "x-squid-error",
    "x-bluecoat-via",
    "x-forwarded-server",
];

/// Name the proxy software, from what the judge saw and what came back.
///
/// The response's `Server` header is deliberately not consulted: a reply that
/// returned our echo came from our judge, so `Server` names our own origin, and
/// reading it would report every proxy on earth as running whatever we run.
pub fn detect_software(
    echo_headers: &HashMap<String, String>,
    response_headers: &HashMap<String, String>,
) -> Option<String> {
    let mut haystack = String::new();
    for source in [echo_headers, response_headers] {
        for name in IDENTITY_HEADERS {
            if let Some(v) = source.get(*name) {
                haystack.push_str(&v.to_ascii_lowercase());
                haystack.push(' ');
            }
        }
    }
    if haystack.trim().is_empty() {
        return None;
    }
    SOFTWARE
        .iter()
        .find(|(needle, _)| haystack.contains(needle))
        .map(|(_, display)| (*display).to_string())
}

/// Exactly which headers the proxy added, with values, sorted so two runs can
/// be compared by eye.
pub fn leaked(echo_headers: &HashMap<String, String>) -> Vec<LeakedHeader> {
    let mut out: Vec<LeakedHeader> = echo_headers
        .iter()
        .filter(|(k, _)| LEAK_HEADERS.contains(&k.to_ascii_lowercase().as_str()))
        .map(|(k, v)| LeakedHeader {
            name: k.to_ascii_lowercase(),
            value: v.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Whether the proxy advertised a persistent connection. `Some(true)` or
/// `None`, never `Some(false)`: every request we send asks the proxy to close,
/// so a close tells us only that it did as asked.
pub fn keep_alive(response_headers: &HashMap<String, String>) -> Option<bool> {
    let says_alive = |k: &str| {
        response_headers
            .get(k)
            .is_some_and(|v| v.to_ascii_lowercase().contains("keep-alive"))
    };
    if response_headers.contains_key("keep-alive") || says_alive("proxy-connection") || says_alive("connection") {
        Some(true)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn names_software_from_the_via_header() {
        assert_eq!(
            detect_software(&map(&[("via", "1.1 proxy-01 (squid/5.7)")]), &HashMap::new()),
            Some("Squid".into())
        );
    }

    #[test]
    fn names_software_from_the_response_side_too() {
        assert_eq!(
            detect_software(&HashMap::new(), &map(&[("x-cache", "MISS from mikrotik-gw")])),
            Some("MikroTik".into())
        );
    }

    #[test]
    fn prefers_the_more_specific_name() {
        assert_eq!(
            detect_software(&map(&[("via", "1.1 ats (apache traffic server/9.1)")]), &HashMap::new()),
            Some("Apache Traffic Server".into())
        );
    }

    #[test]
    fn never_reads_the_origins_own_server_header() {
        assert_eq!(
            detect_software(&HashMap::new(), &map(&[("server", "nginx/1.24.0")])),
            None
        );
    }

    #[test]
    fn no_identity_headers_means_no_claim() {
        assert_eq!(
            detect_software(&map(&[("host", "echo.hproxy.com"), ("accept", "*/*")]), &HashMap::new()),
            None
        );
    }

    #[test]
    fn leaked_headers_carry_values_and_are_sorted() {
        let l = leaked(&map(&[
            ("x-forwarded-for", "1.2.3.4"),
            ("via", "1.1 squid"),
            ("accept", "*/*"),
        ]));
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].name, "via");
        assert_eq!(l[1].name, "x-forwarded-for");
        assert_eq!(l[1].value, "1.2.3.4");
    }

    #[test]
    fn our_own_peer_header_is_not_reported_as_a_leak() {
        assert!(leaked(&map(&[("x-real-peer", "9.9.9.9"), ("x-hproxy-probe", "n")])).is_empty());
    }

    #[test]
    fn keep_alive_is_provable_but_never_disprovable() {
        assert_eq!(keep_alive(&map(&[("connection", "keep-alive")])), Some(true));
        assert_eq!(keep_alive(&map(&[("proxy-connection", "Keep-Alive")])), Some(true));
        assert_eq!(keep_alive(&map(&[("keep-alive", "timeout=5")])), Some(true));
        assert_eq!(keep_alive(&map(&[("connection", "close")])), None);
        assert_eq!(keep_alive(&HashMap::new()), None);
    }
}
