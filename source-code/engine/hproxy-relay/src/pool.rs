//! Free-pool mode: the same rotating exits the Chrome extension uses.
//!
//! ⚠️ THIS FILE IS ONE HALF OF A SHARED CONTRACT. The other half is the HProxy
//! Chrome extension, and the backend half is the pool API. The extension and this binary are the
//! same product in two places: the extension proxies Chrome, this proxies the
//! whole machine, and both draw from one pool through one API. Change the shape
//! here and change it there.
//!
//! Three behaviours copied deliberately from the extension, because each one
//! was learned the hard way:
//!
//!   1. **The control plane never goes through the proxy.** Calls to
//!      hproxy.com are made by this process directly, never relayed. That is
//!      what lets failover fetch a replacement exit WHILE the current exit is
//!      dead. (The extension has to say this out loud in a `bypassList`; here
//!      it falls out of the design, and it is written down so nobody
//!      "optimises" it by routing our own requests through the relay.)
//!   2. **Recent exits are excluded**, so rotating actually gives a different
//!      network rather than the same best-scoring proxy again. `RECENT_MAX`
//!      matches the extension's 12.
//!   3. **A dead exit is reported back.** The pool is crowd-sourced health
//!      data; a client that quietly drops a corpse makes the pool worse for
//!      everyone, including the next request this same user makes.

use std::collections::VecDeque;
use std::time::Duration;

use serde::Deserialize;
use tokio::sync::Mutex;

use crate::upstream::{Scheme, Upstream};

/// Where the control plane lives. Matches `const API` in background.js.
const API: &str = "https://hproxy.com";

/// How many recent exits we ask the engine to skip. Matches `RECENT_MAX` in
/// background.js; the API caps the list at 24, so this stays comfortably under.
const RECENT_MAX: usize = 12;

#[derive(Deserialize)]
struct NextResponse {
    proxy: Option<PoolProxy>,
}

#[derive(Deserialize)]
struct PoolProxy {
    ip: String,
    port: u16,
    #[serde(default)]
    protocols: Vec<String>,
    #[serde(default)]
    country_code: Option<String>,
    #[serde(default)]
    city: Option<String>,
    #[serde(default)]
    latency_ms: Option<i64>,
}

/// One exit, plus the labels worth printing when we switch to it.
pub struct Exit {
    pub upstream: Upstream,
    pub country: String,
    pub city: String,
    pub latency_ms: Option<i64>,
}

impl Exit {
    pub fn describe(&self) -> String {
        let mut s = self.upstream.addr();
        let place = match (self.city.as_str(), self.country.as_str()) {
            ("", "") => String::new(),
            ("", c) => c.to_string(),
            (city, "") => city.to_string(),
            (city, c) => format!("{city}, {c}"),
        };
        if !place.is_empty() {
            s.push_str(&format!(" ({place})"));
        }
        if let Some(ms) = self.latency_ms {
            s.push_str(&format!(" {ms}ms"));
        }
        s
    }
}

pub struct Pool {
    client: reqwest::Client,
    country: Option<String>,
    protocol: &'static str,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    recent: VecDeque<String>,
}

impl Pool {
    pub fn new(country: Option<String>, scheme: Scheme) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            // The pool API is fast and this call sits in front of a user's very
            // first request. A long hang here reads as "the tool is broken".
            .timeout(Duration::from_secs(12))
            .user_agent(concat!("hproxy-connector/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| format!("could not start the HTTP client: {e}"))?;
        Ok(Self {
            client,
            country: country.map(|c| c.trim().to_uppercase()).filter(|c| !c.is_empty()),
            protocol: match scheme {
                Scheme::Socks5 => "socks5",
                Scheme::Http => "http",
            },
            state: Mutex::new(State::default()),
        })
    }

    /// Ask for an exit we have not just used.
    pub async fn next(&self) -> Result<Exit, String> {
        let recent: Vec<String> = {
            let st = self.state.lock().await;
            st.recent.iter().cloned().collect()
        };

        let mut url = format!("{API}/api/vpn/next?protocol={}", self.protocol);
        if let Some(cc) = &self.country {
            url.push_str(&format!("&country={cc}"));
        }
        if !recent.is_empty() {
            url.push_str(&format!("&exclude={}", recent.join(",")));
        }

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("could not reach the HProxy pool: {e}"))?;

        if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            // The free pool has a per-network daily budget. Say so plainly
            // rather than letting it look like an outage.
            return Err("the free pool's daily quota for your network is used up. It refills \
                 continuously, so try again shortly, or run the connector with your own \
                 proxy line instead."
                .into());
        }
        if !resp.status().is_success() {
            return Err(format!("the HProxy pool answered {}", resp.status()));
        }

        let body: NextResponse = resp
            .json()
            .await
            .map_err(|e| format!("could not read the pool's answer: {e}"))?;

        let p = body.proxy.ok_or_else(|| match &self.country {
            Some(cc) => format!(
                "no free {} exit is alive in {cc} right now. Try another country, or drop \
                     --country to take the fastest exit anywhere.",
                self.protocol
            ),
            None => format!("no free {} exit is alive right now.", self.protocol),
        })?;

        // The engine should honour ?protocol=, but a pool entry that cannot
        // speak what we asked for would fail on every request with no
        // explanation, so it is checked rather than assumed.
        if !p.protocols.is_empty() && !p.protocols.iter().any(|x| x == self.protocol) {
            return Err(format!(
                "the pool returned a {} proxy when {} was asked for",
                p.protocols.join("/"),
                self.protocol
            ));
        }

        {
            let mut st = self.state.lock().await;
            st.recent.retain(|ip| ip != &p.ip);
            st.recent.push_front(p.ip.clone());
            while st.recent.len() > RECENT_MAX {
                st.recent.pop_back();
            }
        }

        Ok(Exit {
            upstream: Upstream {
                scheme: if self.protocol == "socks5" {
                    Scheme::Socks5
                } else {
                    Scheme::Http
                },
                host: p.ip,
                port: p.port,
                // Pool exits are open proxies. There is no login to attach.
                auth: None,
            },
            country: p.country_code.unwrap_or_default(),
            city: p.city.unwrap_or_default(),
            latency_ms: p.latency_ms,
        })
    }

    /// Take exits until one actually proxies, or give up after `tries`.
    ///
    /// WHY THIS EXISTS (measured in August 2026). `/api/vpn/next` returns "the
    /// single best alive exit", and a pick that answers is not the same as a
    /// pick that relays: an ordinary web server on port 80 answers every
    /// request with its own page, looks alive to a plain liveness check, and
    /// can climb a ranking on a perfect uptime score without ever having
    /// proxied anything.
    ///
    /// So a client cannot trust a pick, and the honest fix on this side is to
    /// prove an exit works before handing it to the customer. That check is not
    /// a formality either: it dials our own control plane over HTTPS, which
    /// forces a real CONNECT tunnel, which is precisely the capability the
    /// relay needs and precisely what these web servers cannot do.
    pub async fn next_working(&self, tries: usize) -> Result<Exit, String> {
        let mut last = String::new();
        for _ in 0..tries.max(1) {
            let exit = match self.next().await {
                Ok(e) => e,
                // A hard error (quota, no exits in this country) will not get
                // better by asking again.
                Err(e) => return Err(e),
            };
            match self.works(&exit.upstream).await {
                Ok(()) => return Ok(exit),
                Err(why) => {
                    last = format!("{} ({why})", exit.upstream.addr());
                    self.report_dead(&exit.upstream);
                }
            }
        }
        Err(format!(
            "tried {tries} free exits and none of them actually proxied. Last was {last}. \
             The free pool is having a bad day; pass your own proxy line instead."
        ))
    }

    /// Does this exit genuinely relay, or does it just answer?
    ///
    /// Fetches our own control-plane JSON THROUGH the candidate over HTTPS. A
    /// web server pretending to be a proxy fails at the CONNECT, and one that
    /// somehow answers cannot produce our JSON, so both failure shapes are
    /// caught by requiring the parsed body to carry a `countries` array.
    async fn works(&self, up: &Upstream) -> Result<(), String> {
        let scheme = match up.scheme {
            Scheme::Socks5 => "socks5",
            Scheme::Http => "http",
        };
        let proxy =
            reqwest::Proxy::all(format!("{scheme}://{}", up.addr())).map_err(|e| format!("unusable proxy url: {e}"))?;
        let client = reqwest::Client::builder()
            .proxy(proxy)
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| format!("client: {e}"))?;

        let resp = client
            .get(format!("{API}/api/vpn/countries"))
            .send()
            .await
            .map_err(|_| "no tunnel".to_string())?;
        if !resp.status().is_success() {
            return Err(format!("answered {}", resp.status()));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|_| "answered with something that was not ours".to_string())?;
        if v.get("countries").and_then(|c| c.as_array()).is_some() {
            Ok(())
        } else {
            Err("answered with someone else's page".into())
        }
    }

    /// Tell the pool an exit stopped answering. Fire and forget, exactly like
    /// the extension's `reportDead`: a health report that blocks a user's
    /// reconnect is worse than a health report that gets lost.
    pub fn report_dead(&self, up: &Upstream) {
        let client = self.client.clone();
        let body = serde_json::json!({
            "reports": [{
                "ip": up.host,
                "port": up.port,
                "protocol": match up.scheme { Scheme::Socks5 => "socks5", Scheme::Http => "http" },
                "alive": false,
            }]
        });
        tokio::spawn(async move {
            let _ = client.post(format!("{API}/api/vpn/report")).json(&body).send().await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_max_matches_the_extension() {
        // background.js: `const RECENT_MAX = 12`. If the extension changes and
        // this does not, the two halves rotate through different-sized windows
        // and "New IP" means something different in each.
        assert_eq!(RECENT_MAX, 12);
    }

    #[test]
    fn the_control_plane_is_the_public_host() {
        // Must be the apex. vpn.rs documents that the extension's bypass list
        // is exactly `hproxy.com` and NOT `*.hproxy.com`, so a control plane on
        // a subdomain would be routed through a possibly-dead proxy.
        assert_eq!(API, "https://hproxy.com");
    }

    #[tokio::test]
    async fn an_exit_describes_itself_for_the_banner() {
        let e = Exit {
            upstream: Upstream {
                scheme: Scheme::Http,
                host: "203.0.113.209".into(),
                port: 80,
                auth: None,
            },
            country: "FR".into(),
            city: "Lauterbourg".into(),
            latency_ms: Some(6),
        };
        assert_eq!(e.describe(), "203.0.113.209:80 (Lauterbourg, FR) 6ms");
    }

    #[tokio::test]
    async fn a_bare_exit_still_describes_itself() {
        let e = Exit {
            upstream: Upstream {
                scheme: Scheme::Http,
                host: "203.0.113.7".into(),
                port: 8080,
                auth: None,
            },
            country: String::new(),
            city: String::new(),
            latency_ms: None,
        };
        assert_eq!(e.describe(), "203.0.113.7:8080");
    }

    #[test]
    fn pool_rejects_nothing_on_construction() {
        assert!(Pool::new(Some(" fr ".into()), Scheme::Http).is_ok());
        assert!(Pool::new(None, Scheme::Socks5).is_ok());
    }
}
