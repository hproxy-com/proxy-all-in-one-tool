//! What a judge sends back, and the nonce that makes it worth believing.
//!
//! A request goes THROUGH the proxy to a judge. The judge answers with three
//! things, and the three must never share a field:
//!
//!   - `ip`: the address the judge saw, leak channel first. It prefers the
//!     proxy-supplied `x-forwarded-for`, because grading has to read the leak
//!     exactly as written. That makes it the one value a hostile proxy fully
//!     controls, and unusable as an exit address.
//!   - `headers`: the request headers as received: what the proxy passed,
//!     added or leaked.
//!   - `peer_ip`: where the connection genuinely came FROM. Filled by the
//!     judge from sources the proxy cannot forge (its own edge's peer header).
//!     This is the exit, and the only value safe to geolocate.
//!
//! Every request carries a nonce, and an echo counts only when it reflects it.
//! A canned 200, a captive page, a box that terminates TLS itself or a decoy
//! replaying somebody else's echo cannot know the value. Measured on the day
//! this rule went into the server (2026-09-06): 84 percent of the "live" HTTP
//! set were Amazon addresses that completed every handshake and relayed
//! nothing, graded alive because a 2xx was enough.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};

/// The header every echo probe carries and must see reflected.
pub const PROBE_NONCE_HEADER: &str = "x-hproxy-probe";

static PROBE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique per check: wall-clock nanoseconds plus a process counter. Not a
/// secret, only unguessable enough that a canned answer cannot contain it.
pub fn nonce() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}-{:x}", PROBE_COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct EchoResponse {
    #[serde(default)]
    pub ip: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub peer_ip: Option<String>,
}

impl EchoResponse {
    /// The address the judge saw on the wire, read through our own edge.
    ///
    /// A judge behind nginx reports its loopback peer as `ip` when nothing was
    /// leaked; nginx passes the true connecting address as `x-real-peer`, a
    /// header chosen because it is not one of the grader's leak headers. Prefer
    /// that when `ip` is loopback, unspecified or empty.
    pub fn wire_ip(&self) -> &str {
        let looks_local = self
            .ip
            .parse::<IpAddr>()
            .map(|a| a.is_loopback() || a.is_unspecified())
            .unwrap_or(self.ip.trim().is_empty());
        if looks_local {
            if let Some(peer) = self.headers.get("x-real-peer").map(String::as_str) {
                if !peer.trim().is_empty() {
                    return peer;
                }
            }
        }
        &self.ip
    }

    /// The exit address, if anything trustworthy named it.
    ///
    /// `peer_ip` first: the judge filled it from a source the proxy cannot
    /// write. Then `x-real-peer`, which our own edge sets unconditionally. Never
    /// `x-forwarded-for` or `ip`: the first is the leak channel and the second
    /// prefers it. A private or loopback value is proof the header did not come
    /// from where we think it did, and is dropped rather than printed.
    pub fn exit_ip(&self) -> Option<String> {
        let candidates = [
            self.peer_ip.as_deref(),
            self.headers.get("x-real-peer").map(String::as_str),
        ];
        candidates
            .into_iter()
            .flatten()
            .filter_map(|v| v.split(',').next())
            .filter_map(|v| v.trim().parse::<IpAddr>().ok())
            .find(|ip| is_public(*ip))
            .map(|ip| ip.to_string())
    }

    /// True when this echo reflects the nonce the probe sent.
    pub fn carries_nonce(&self, nonce: &str) -> bool {
        self.headers
            .iter()
            .any(|(k, v)| k.eq_ignore_ascii_case(PROBE_NONCE_HEADER) && v == nonce)
    }
}

/// Keep an echo only if it reflects the nonce. Header names come back lowercased
/// by most servers; compared case-insensitively anyway.
pub fn echo_with_nonce(echo: Option<EchoResponse>, nonce: &str) -> Option<EchoResponse> {
    echo.filter(|e| e.carries_nonce(nonce))
}

/// The trace judge's reply as an echo. Cloudflare's trace reflects the
/// User-Agent as `uag=` (the nonce rides there) and names the connecting
/// address as `ip=`, which is the proxy's exit by definition. It reflects no
/// other request header, so a synthetic `via` caps the grade at anonymous: the
/// proxy hid us, whether or not it also added headers we cannot see.
///
/// Alive only when `uag=` carries the nonce and `ip=` names an address. An
/// exit that turns out to be our own address is still a relay that answered;
/// the grader then calls it transparent, which is the honest word for it.
pub fn trace_echo(body: &str, nonce: &str) -> Option<EchoResponse> {
    let mut uag = None;
    let mut ip = None;
    for line in body.lines() {
        if let Some(v) = line.strip_prefix("uag=") {
            uag = Some(v.trim());
        } else if let Some(v) = line.strip_prefix("ip=") {
            ip = Some(v.trim());
        }
    }
    let uag = uag?;
    let ip = ip?;
    if !uag.contains(nonce) || ip.is_empty() {
        return None;
    }
    Some(EchoResponse {
        ip: ip.to_string(),
        headers: [("via".to_string(), "cloudflare-trace".to_string())]
            .into_iter()
            .collect(),
        peer_ip: Some(ip.to_string()),
    })
}

/// A public address: not loopback, private, shared, link-local, multicast,
/// broadcast, reserved or unspecified. An exit address is by definition one the
/// public internet saw. The RFC 5737 documentation ranges are left in: they
/// cannot answer, so they never appear as a real exit, and every test in this
/// crate uses them as its fake public addresses.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || o[0] >= 240)
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (seg[0] & 0xffc0) == 0xfe80) // link local fe80::/10
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(ip: &str, headers: &[(&str, &str)]) -> EchoResponse {
        EchoResponse {
            ip: ip.to_string(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            peer_ip: None,
        }
    }

    #[test]
    fn nonces_differ_between_checks() {
        let a = nonce();
        let b = nonce();
        assert_ne!(a, b);
        assert!(a.contains('-'));
    }

    #[test]
    fn echo_counts_only_with_our_nonce() {
        assert!(echo_with_nonce(Some(echo("1.2.3.4", &[(PROBE_NONCE_HEADER, "abc-1")])), "abc-1").is_some());
        assert!(echo_with_nonce(Some(echo("1.2.3.4", &[("X-HProxy-Probe", "abc-1")])), "abc-1").is_some());
        assert!(echo_with_nonce(Some(echo("1.2.3.4", &[(PROBE_NONCE_HEADER, "abc-2")])), "abc-1").is_none());
        assert!(echo_with_nonce(Some(echo("1.2.3.4", &[("via", "abc-1")])), "abc-1").is_none());
        assert!(echo_with_nonce(None, "abc-1").is_none());
    }

    #[test]
    fn wire_ip_reads_through_loopback_to_the_real_peer() {
        let e = echo("127.0.0.1", &[("x-real-peer", "203.0.113.9")]);
        assert_eq!(e.wire_ip(), "203.0.113.9");
        let e = echo("9.9.9.9", &[("x-real-peer", "203.0.113.9")]);
        assert_eq!(e.wire_ip(), "9.9.9.9", "a real address is trusted as-is");
        let e = echo("", &[("x-real-peer", "203.0.113.9")]);
        assert_eq!(e.wire_ip(), "203.0.113.9");
    }

    #[test]
    fn the_exit_comes_from_the_trusted_peer_field_first() {
        let mut e = echo("8.8.8.8", &[("x-real-peer", "198.51.100.7")]);
        e.peer_ip = Some("198.51.100.26".into());
        assert_eq!(e.exit_ip().as_deref(), Some("198.51.100.26"));
        let e = echo("8.8.8.8", &[("x-real-peer", "198.51.100.7")]);
        assert_eq!(e.exit_ip().as_deref(), Some("198.51.100.7"));
    }

    /// A transparent proxy leaks OUR address in `x-forwarded-for`; that is the
    /// signal grading reads, and it must never be mistaken for the exit.
    #[test]
    fn a_leaked_forwarded_for_never_becomes_the_exit() {
        let e = echo(
            "203.0.113.5",
            &[("x-forwarded-for", "203.0.113.5"), ("x-real-peer", "198.51.100.26")],
        );
        assert_eq!(e.exit_ip().as_deref(), Some("198.51.100.26"));
        let e = echo("8.8.8.8", &[("x-forwarded-for", "8.8.8.8")]);
        assert_eq!(e.exit_ip(), None, "with no trusted source the honest answer is none");
    }

    #[test]
    fn loopback_and_private_are_never_an_exit() {
        let mut e = echo("127.0.0.1", &[]);
        e.peer_ip = Some("127.0.0.1".into());
        assert_eq!(e.exit_ip(), None);
        e.peer_ip = Some("10.0.0.4".into());
        assert_eq!(e.exit_ip(), None);
        // A bad higher-trust value must not shadow a good one below it.
        e.headers.insert("x-real-peer".into(), "1.1.1.1".into());
        assert_eq!(e.exit_ip().as_deref(), Some("1.1.1.1"));
    }

    #[test]
    fn trace_reply_needs_the_nonce_and_an_address() {
        let body = "fl=1\nh=hproxy.com\nip=203.0.113.9\nuag=hproxy-probe/abc-1\ncolo=FRA\n";
        let e = trace_echo(body, "abc-1").expect("alive");
        assert_eq!(e.ip, "203.0.113.9");
        assert_eq!(e.peer_ip.as_deref(), Some("203.0.113.9"));
        assert!(
            e.headers.contains_key("via"),
            "the trace cannot prove elite, so the grade is capped"
        );
        assert!(trace_echo(body, "abc-2").is_none(), "wrong nonce");
        assert!(trace_echo("ip=1.2.3.4\n", "abc-1").is_none(), "no uag");
        assert!(
            trace_echo("uag=hproxy-probe/abc-1\nip=\n", "abc-1").is_none(),
            "no address"
        );
    }

    #[test]
    fn public_address_rule() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(is_public(ip("8.8.8.8")));
        assert!(is_public(ip("2606:4700::1111")));
        assert!(
            is_public(ip("203.0.113.9")),
            "documentation space stands in for public addresses in tests"
        );
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "172.16.5.5",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "240.0.0.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "ff02::1",
        ] {
            assert!(!is_public(ip(bad)), "{bad} must not be public");
        }
    }
}
