//! The DNS leak test through the relay: which resolver the proxy looks names
//! up with, and where it is (`hproxy_api::leak`, labelled with our IP data).

use std::net::SocketAddr;
use std::time::Duration;

use hproxy_api::geo::Geo;
use serde::Serialize;

/// One resolver the test saw, with its place and network.
#[derive(Debug, Serialize)]
pub struct LeakResolver {
    pub ip: String,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub asn_org: Option<String>,
    /// The network the resolver said it asks for, when it sent one.
    pub client_subnet: Option<String>,
}

/// What the test found.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DnsLeakView {
    /// The resolvers the proxy looked the test's made-up name up with.
    Seen { resolvers: Vec<LeakResolver> },
    /// The proxy never looked the name up.
    NotSeen,
    /// The test could not run, with the reason in words.
    Unavailable { why: String },
}

/// Run the test through the relay on `listen`. `program` names the door.
pub async fn dns_leak(listen: SocketAddr, geo: &Geo, program: &str) -> DnsLeakView {
    let door = hproxy_api::http_client(program, Duration::from_secs(6));
    match hproxy_api::leak::dns_leak(&format!("http://{listen}"), &door).await {
        hproxy_api::leak::DnsLeak::Seen(found) => {
            let ips: Vec<String> = found.iter().map(|r| r.ip.clone()).collect();
            geo.prefetch(&ips, |_| {}).await;
            let resolvers = found
                .into_iter()
                .map(|r| {
                    let label = geo.label(&r.ip);
                    LeakResolver {
                        country_code: label.as_ref().and_then(|l| l.country_code.clone()),
                        country: label.as_ref().and_then(|l| l.country.clone()),
                        city: label.as_ref().and_then(|l| l.city.clone()),
                        asn_org: label.as_ref().and_then(|l| l.asn_org.clone()),
                        client_subnet: r.client_subnet,
                        ip: r.ip,
                    }
                })
                .collect();
            DnsLeakView::Seen { resolvers }
        }
        hproxy_api::leak::DnsLeak::NotSeen => DnsLeakView::NotSeen,
        hproxy_api::leak::DnsLeak::Unavailable(why) => DnsLeakView::Unavailable { why },
    }
}
