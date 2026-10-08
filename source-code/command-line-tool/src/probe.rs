//! One check THROUGH a running relay: the address the world sees, where it is,
//! how anonymous, how fast, and whether the proxy re-signs HTTPS.
//!
//! The same engine that checks anyone else's proxy, pointed at our own local
//! address. That is the whole end-to-end path in one answer: the browser's
//! side, the relay, the upstream proxy and the judge.

use std::time::Duration;

use hproxy_api::geo::Geo;
use hproxy_probe::{CheckOptions, CheckResult, Checker, ProtocolSet};

/// Probe with a caller's engine and lookup (the MCP server holds both for the
/// session). HTTPS and plain HTTP only: the relay's SOCKS5 side reaches the
/// same upstream, and every extra transport is another wait.
pub async fn exit_through(checker: &Checker, geo: &Geo, listening: &str) -> Result<CheckResult, String> {
    let line = hproxy_probe::parse(listening).map_err(|e| e.0)?;
    let opts = CheckOptions {
        timeout: Duration::from_secs(8),
        connect_timeout: Duration::from_secs(3),
        protocols: ProtocolSet {
            http: true,
            https: true,
            socks4: false,
            socks5: false,
        },
        ..Default::default()
    };
    let mut r = checker.check(&line, &opts).await;
    if !r.alive {
        return Err(r.error.unwrap_or_else(|| "the proxy did not answer".into()));
    }
    if let Some(exit) = r.exit_ip.clone() {
        let _ = geo.prefetch(std::slice::from_ref(&exit), |_| {}).await;
        // Located by the exit: the address dialled here is our own relay.
        geo.enrich(&exit, &mut r);
    }
    Ok(r)
}

/// The same for a one-shot caller (`hproxy status --probe`), which has no
/// engine of its own yet. `None` when the path does not carry traffic.
pub async fn through(listening: &str) -> Option<CheckResult> {
    let checker = Checker::public();
    let geo = crate::check::geo_client();
    exit_through(&checker, &geo, listening).await.ok()
}

/// Whether HTTPS went through: through a relay that is a CONNECT tunnel with
/// TLS inside, which is what every HTTPS site needs.
pub fn tunnels_https(r: &CheckResult) -> bool {
    r.protocols.iter().any(|p| p == "https")
}
