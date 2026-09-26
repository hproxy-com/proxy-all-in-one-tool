//! Three-tier anonymity grading from a judge echo.
//!
//! The judge received the request the proxy forwarded and echoes back the
//! address it saw and the headers it got. The verdict falls out of what leaked:
//!
//!   1. The judge saw OUR real address, on the wire or inside a forwarding
//!      header: **transparent**. The proxy announces you.
//!   2. Else any proxy-revealing header is present: **anonymous**. The far end
//!      can tell a proxy was used, but not who is behind it.
//!   3. Else: **elite**. Indistinguishable from a direct connection.
//!
//! These words describe a documented mechanism (RFC 7239's forwarding headers
//! and their informal relatives), not a quality score.

use crate::echo::EchoResponse;

/// Headers a proxy adds that reveal "a proxy was here" and sometimes the real
/// client behind it.
///
/// Two rules keep the grade honest. Nothing the probe sends itself may appear
/// here (see `browser.rs`; a test fails the build otherwise), and `x-real-peer`
/// is deliberately absent: it is how our own edge names the true peer, and
/// counting it would grade every proxy checked through our judge "anonymous".
pub const LEAK_HEADERS: &[&str] = &[
    "x-forwarded-for",
    "x-real-ip",
    "via",
    "forwarded",
    "x-proxy-id",
    "client-ip",
    "x-client-ip",
    "x-forwarded",
    "forwarded-for",
    "proxy-connection",
];

pub const TRANSPARENT: &str = "transparent";
pub const ANONYMOUS: &str = "anonymous";
pub const ELITE: &str = "elite";

/// Grade one proxy from its judge echo. `our_ip` is this machine's public
/// address, `None` if detection failed (then transparent cannot be proven).
pub fn grade(echo: &EchoResponse, our_ip: Option<&str>) -> &'static str {
    let our_ip_present = match our_ip {
        Some(our) if !our.is_empty() => {
            echo.wire_ip() == our
                || echo
                    .headers
                    .iter()
                    .any(|(k, v)| LEAK_HEADERS.contains(&k.to_ascii_lowercase().as_str()) && v.contains(our))
        }
        _ => false,
    };
    if our_ip_present {
        return TRANSPARENT;
    }
    let any_leak_header = echo
        .headers
        .keys()
        .any(|k| LEAK_HEADERS.contains(&k.to_ascii_lowercase().as_str()));
    if any_leak_header {
        ANONYMOUS
    } else {
        ELITE
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn echo(ip: &str, headers: &[(&str, &str)]) -> EchoResponse {
        EchoResponse {
            ip: ip.to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<HashMap<_, _>>(),
            peer_ip: None,
        }
    }

    #[test]
    fn elite_when_nothing_leaks() {
        assert_eq!(
            grade(&echo("9.9.9.9", &[("host", "judge.example")]), Some("1.1.1.1")),
            ELITE
        );
    }

    #[test]
    fn anonymous_when_a_proxy_header_is_present() {
        assert_eq!(
            grade(&echo("9.9.9.9", &[("via", "1.1 squid")]), Some("1.1.1.1")),
            ANONYMOUS
        );
    }

    #[test]
    fn transparent_when_our_address_is_on_the_wire_or_forwarded() {
        assert_eq!(grade(&echo("1.1.1.1", &[]), Some("1.1.1.1")), TRANSPARENT);
        assert_eq!(
            grade(&echo("9.9.9.9", &[("x-forwarded-for", "1.1.1.1")]), Some("1.1.1.1")),
            TRANSPARENT
        );
        assert_eq!(
            grade(
                &echo("9.9.9.9", &[("X-Forwarded-For", "10.0.0.1, 1.1.1.1")]),
                Some("1.1.1.1")
            ),
            TRANSPARENT
        );
    }

    /// Our own judge sits behind nginx, so the echo reports its loopback peer
    /// and the true address arrives as `x-real-peer`. Grading must read
    /// through to the real peer.
    #[test]
    fn reads_through_loopback_to_the_real_peer() {
        let e = echo("127.0.0.1", &[("x-real-peer", "1.1.1.1"), ("host", "echo.hproxy.com")]);
        assert_eq!(grade(&e, Some("1.1.1.1")), TRANSPARENT);
    }

    /// The header that carries the real peer must never itself count as a
    /// leak, or every proxy checked through our own judge would grade
    /// anonymous and elite would be unreachable.
    #[test]
    fn real_peer_header_is_not_a_leak() {
        let e = echo("127.0.0.1", &[("x-real-peer", "9.9.9.9"), ("host", "echo.hproxy.com")]);
        assert_eq!(grade(&e, Some("1.1.1.1")), ELITE);
    }

    #[test]
    fn our_address_in_the_host_header_is_not_a_leak() {
        // The Host header is always our own judge's address.
        let e = echo("9.9.9.9", &[("host", "1.1.1.1:4505")]);
        assert_eq!(grade(&e, Some("1.1.1.1")), ELITE);
    }

    #[test]
    fn without_our_address_transparent_cannot_be_proven() {
        assert_eq!(grade(&echo("1.1.1.1", &[]), None), ELITE);
        assert_eq!(grade(&echo("1.1.1.1", &[("via", "x")]), None), ANONYMOUS);
    }
}
