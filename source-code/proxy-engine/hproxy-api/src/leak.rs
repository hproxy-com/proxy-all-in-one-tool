//! `https://hproxy.com/api/leak/<name>`: which resolver a proxy looks names up with.
//!
//! The test: through the proxy, ask for a made-up name under `leak.hproxy.com`.
//! The proxy's resolver asks our nameserver for it, and the nameserver writes
//! down the resolver's address (the monorepo's `hproxy-dns-leak`; the design is
//! `docs/plan-2026-09-28-dns-leak-test/PLAN.md` there). Then this asks the door
//! who looked the name up. The connection attempt through the proxy fails on
//! purpose: the nameserver answers "no such name", right after the lookup.
//!
//! A proxy that is handed the NAME (an HTTP proxy, SOCKS5 with the name) looks it
//! up itself, so this finds the resolver the proxy uses, never the user's own.
//! When the door is not there (the test not switched on yet) the answer says
//! so, `Unavailable`: never a guess.

use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const LEAK_API: &str = "https://hproxy.com/api/leak";
pub const LEAK_ZONE: &str = "leak.hproxy.com";

/// How long the lookup through the proxy may take (the nameserver answers at
/// once; a slow proxy is the only wait), and how often, and how far apart, the
/// door is asked afterwards: a resolver can take a moment to ask.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
const DOOR_TRIES: u32 = 4;
const DOOR_PAUSE: Duration = Duration::from_millis(700);

/// One resolver that asked for the made-up name, as the door reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolver {
    pub ip: String,
    /// The network the resolver said it asks for (EDNS client subnet), when it sent one.
    #[serde(default)]
    pub client_subnet: Option<String>,
    #[serde(default)]
    pub queries: u32,
}

#[derive(Deserialize)]
struct DoorAnswer {
    seen: bool,
    #[serde(default)]
    resolvers: Vec<Resolver>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DnsLeak {
    /// The resolvers the proxy used, as our nameserver saw them.
    Seen(Vec<Resolver>),
    /// The door answered, but no resolver asked: the proxy never looked the
    /// name up (some refuse a connection before resolving anything).
    NotSeen,
    /// The door is not there or did not answer, with the reason in words.
    Unavailable(String),
}

/// 20 random lowercase letters and digits: nobody can guess another person's
/// name and read which resolver they use (the door wants 16 to 40).
pub fn made_up_name() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut bytes = [0u8; 20];
    if getrandom::getrandom(&mut bytes).is_err() {
        // No system randomness at all: the clock still makes a name nobody
        // else is using at this moment.
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (nanos >> ((i % 16) * 8)) as u8 ^ (i as u8).wrapping_mul(37);
        }
    }
    // 256 is not a multiple of 36, so the first letters are a hair likelier;
    // that is nothing next to 36^20 names.
    bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

/// Run the test through `proxy_url` (e.g. `http://127.0.0.1:8080`, the relay).
/// `door` asks hproxy.com; it may go direct or through the same proxy.
pub async fn dns_leak(proxy_url: &str, door: &reqwest::Client) -> DnsLeak {
    let name = made_up_name();
    let through = match reqwest::Proxy::all(proxy_url)
        .map_err(|e| e.to_string())
        .and_then(|p| reqwest::Client::builder().proxy(p).timeout(LOOKUP_TIMEOUT).build().map_err(|e| e.to_string()))
    {
        Ok(c) => c,
        Err(e) => return DnsLeak::Unavailable(format!("could not reach the proxy: {e}")),
    };
    // The lookup. Its failure is the point: the name does not exist.
    let _ = through.get(format!("https://{name}.{LEAK_ZONE}/")).send().await;

    for attempt in 0..DOOR_TRIES {
        if attempt > 0 {
            tokio::time::sleep(DOOR_PAUSE).await;
        }
        let resp = match door.get(format!("{LEAK_API}/{name}")).send().await {
            Ok(r) => r,
            Err(e) => return DnsLeak::Unavailable(format!("the leak test did not answer: {}", e.without_url())),
        };
        if !resp.status().is_success() {
            return DnsLeak::Unavailable(format!("the leak test answered {}", resp.status()));
        }
        match resp.json::<DoorAnswer>().await {
            Ok(a) if a.seen => return DnsLeak::Seen(a.resolvers),
            Ok(_) => {}
            // A page instead of the door's JSON: the door is not there yet.
            Err(_) => return DnsLeak::Unavailable("the leak test is not switched on".into()),
        }
    }
    DnsLeak::NotSeen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_made_up_name_is_what_the_door_accepts() {
        let a = made_up_name();
        let b = made_up_name();
        assert_eq!(a.len(), 20);
        assert!(a.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()), "{a}");
        assert_ne!(a, b, "two tests never share a name");
    }

    #[test]
    fn the_door_answer_reads() {
        let a: DoorAnswer = serde_json::from_str(
            r#"{"name":"k3v9x2m7q1w8e4r6t0y5","seen":true,"resolvers":[{"ip":"192.0.2.53","client_subnet":null,"queries":2,"first_seen_ms":1,"last_seen_ms":2}]}"#,
        )
        .unwrap();
        assert!(a.seen);
        assert_eq!(
            a.resolvers,
            vec![Resolver {
                ip: "192.0.2.53".into(),
                client_subnet: None,
                queries: 2
            }]
        );
    }
}
