//! Geolocation + ASN enrichment.
//!
//! Backed by HProxy's free public IP API (`https://hproxy.com/api/ip`), which is
//! keyless, CORS-enabled and documented at <https://hproxy.com/docs/free/ip-lookup>.
//! It answers country, region, city, coordinates, timezone, ASN, ASN organisation
//! and ISP, and it is the same lookup behind the HProxy free proxy list, so the
//! desktop app and the CLI label their results with exactly the data the
//! website does.
//!
//! ## Why an API instead of a bundled database
//!
//! The obvious alternative is to ship an .mmdb inside the installer, which is
//! what unfx-proxy-checker does (a 69 MB GeoLite2-City file committed to its
//! repo). Two reasons not to:
//!
//!   1. **Size.** This app's whole selling point against the Electron tools is a
//!      ~4 MB installer. A city+ASN database is 25-70 MB, so bundling one makes
//!      the installer an order of magnitude bigger than the thing it competes on.
//!   2. **Licensing.** MaxMind's GeoLite2 terms restrict redistribution, so
//!      committing it to a public repo is legally shaky. (unfx does it anyway.)
//!
//! The cost is that geo needs the network. That is an honest trade for a tool
//! whose entire job is making network requests, and it degrades cleanly: if the
//! API is unreachable, checking still works and the location columns show "—".
//!
//! ## ⚠️ What leaves the machine
//!
//! Enabling geo sends the **IP addresses being checked** to hproxy.com. Nothing
//! else: not the proxy credentials, not the results, not the ports. The check
//! itself still runs entirely locally. Users who do not want even that can turn
//! geo off (`geo_api_url: ""` from the UI), and then nothing at all is uploaded.
//! Keep the README's privacy wording in sync with this paragraph.

use hproxy_probe::CheckResult;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::RwLock;
use std::time::Duration;

/// The public endpoint. Overridable per run so a user can point at their own
/// deployment, and settable to empty to disable enrichment entirely.
pub const DEFAULT_GEO_API: &str = "https://hproxy.com/api/ip";

/// Addresses per batch request. Matches the API's documented `batch_too_large`
/// ceiling — going higher just earns a 400.
const BATCH: usize = 100;

/// One address's answer. Every field is optional because the API omits what it
/// does not know, and a total miss comes back as `{"ip": "…", "found": false}`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct GeoData {
    /// ISO-3166 alpha-2, e.g. "US".
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub country_name: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub asn: Option<i32>,
    #[serde(default)]
    pub asn_org: Option<String>,
    #[serde(default)]
    pub is_datacenter: Option<bool>,
    /// The IANA zone of the place, e.g. "America/Chicago": what a computer
    /// there would have its clock set to (the Connect panel's time zone check).
    #[serde(default)]
    pub timezone: Option<String>,
}

impl GeoData {
    /// A miss (`found: false`) deserializes to all-None. Distinguishing it from a
    /// hit matters so we never stamp `is_datacenter: false` onto a row we know
    /// nothing about.
    fn is_empty(&self) -> bool {
        self.country.is_none() && self.asn.is_none() && self.city.is_none()
    }
}

/// One address's label as the window receives it (`checker:geo`), for rows that
/// settled before their wave of lookups came back. The names match the fields
/// of a result row, so the window folds either into a row the same way.
#[derive(Debug, Clone, Serialize)]
pub struct GeoLabel {
    pub ip: String,
    pub country_code: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub asn: Option<i32>,
    pub asn_org: Option<String>,
    pub is_datacenter: Option<bool>,
    pub timezone: Option<String>,
}

impl GeoLabel {
    fn new(ip: &str, g: &GeoData) -> Self {
        Self {
            ip: ip.to_string(),
            country_code: g.country.clone(),
            country: g.country_name.clone(),
            city: g.city.clone(),
            asn: g.asn,
            asn_org: g.asn_org.clone(),
            is_datacenter: g.is_datacenter,
            timezone: g.timezone.clone(),
        }
    }
}

#[derive(Deserialize)]
struct BatchResponse {
    #[serde(default)]
    results: Vec<GeoData>,
}

/// Wrapper used only to read back the echoed `ip`, so a batch response can be
/// keyed even though the API guarantees order anyway (belt and braces: if the
/// contract ever changed, we would mislabel rows rather than fail loudly).
#[derive(Deserialize)]
struct IpEcho {
    #[serde(default)]
    ip: Option<String>,
}

pub struct Geo {
    /// Empty string = enrichment disabled.
    api: String,
    http: reqwest::Client,
    /// Resolved answers, keyed by IP string. Populated by [`Geo::prefetch`] and
    /// read synchronously by [`Geo::enrich`].
    cache: RwLock<HashMap<String, GeoData>>,
}

impl Geo {
    pub fn new(api: impl Into<String>) -> Self {
        let api = api.into().trim().trim_end_matches('/').to_string();
        Self {
            api,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .user_agent(concat!("hproxy-checker/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default(),
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// The same, on a client the caller built: its own name in the server logs
    /// and its own time limit.
    pub fn with_client(api: impl Into<String>, http: reqwest::Client) -> Self {
        Self {
            api: api.into().trim().trim_end_matches('/').to_string(),
            http,
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Whether enrichment will do anything at all.
    pub fn available(&self) -> bool {
        !self.api.is_empty()
    }

    /// The label for one address, from the cache. `None` until a `prefetch`
    /// that included it has landed, and for an address the API did not know.
    pub fn label(&self, ip: &str) -> Option<GeoLabel> {
        let cache = self.cache.read().ok()?;
        let g = cache.get(ip)?;
        if g.is_empty() {
            return None;
        }
        Some(GeoLabel::new(ip, g))
    }

    /// Resolve every address in the list, in waves, handing each wave's answers
    /// to `on_wave` the moment it lands.
    ///
    /// This runs BESIDE the check, never in front of it. It used to be awaited
    /// before the first proxy was probed, which was fine for a thousand
    /// addresses (about a second) and wrong everywhere else: a 100 000-line
    /// list spent half a minute showing nothing, and with the IP API out of
    /// reach every wave waited out its 15 second timeout, so a 10 000-line
    /// list stalled for minutes before checking even began. A lookup that only
    /// decorates rows must never be able to delay them.
    ///
    /// Rows that settle after their wave arrived are labelled from the cache by
    /// [`Geo::enrich`]; rows that settled earlier are labelled by the window,
    /// from the labels `on_wave` emits.
    ///
    /// The first wave that fails outright ends the lookup for this run: if the
    /// API is down it will still be down 300 ms later, and the check does not
    /// need it.
    ///
    /// Returns false when the API was needed and did not answer, so a caller
    /// that keeps asking (see [`Geo::locate_as_found`]) can stop.
    pub async fn prefetch<F>(&self, hosts: &[String], mut on_wave: F) -> bool
    where
        F: FnMut(Vec<GeoLabel>),
    {
        if !self.available() {
            return false;
        }

        // Only real IPs; the API rejects hostnames, and a proxy list is
        // overwhelmingly ip:port. Deduplicated, and skipping anything already
        // cached from a previous run in this session.
        let mut want: Vec<String> = Vec::new();
        {
            let seen_cache = self.cache.read().ok();
            let mut seen: HashSet<&str> = HashSet::new();
            for h in hosts {
                let h = h.trim();
                if h.parse::<IpAddr>().is_err() || !seen.insert(h) {
                    continue;
                }
                if seen_cache.as_ref().is_some_and(|c| c.contains_key(h)) {
                    continue;
                }
                want.push(h.to_string());
            }
        }
        if want.is_empty() {
            return true;
        }

        let batches: Vec<Vec<String>> = want.chunks(BATCH).map(<[String]>::to_vec).collect();

        // Run batches in WAVES rather than all at once. A 10 000-proxy list is
        // 100 batches; firing those simultaneously would open 100 sockets in one
        // breath — the exact "flood the router" behaviour this app exists to
        // avoid — and would trip the API's own per-client rate limit, costing us
        // geo on most of the list. Waves of 8 keep it fast (a 10k list still
        // resolves in a couple of seconds) while staying polite at both ends.
        const WAVE: usize = 8;
        for wave in batches.chunks(WAVE) {
            let fetched = futures::future::join_all(wave.iter().map(|b| self.fetch_batch(b))).await;
            if fetched.iter().all(Option::is_none) {
                log::warn!("the IP API did not answer; this run carries no locations");
                return false;
            }
            let mut labels: Vec<GeoLabel> = Vec::new();
            {
                let Ok(mut cache) = self.cache.write() else {
                    return false;
                };
                for (batch, answers) in wave.iter().zip(fetched) {
                    let Some(answers) = answers else { continue };
                    // The API documents "one result per address, in the same
                    // order you sent them", so zip is the contract.
                    // `fetch_batch` refuses any reply whose echoed order
                    // disagrees, so a mismatch drops the batch rather than
                    // mislabelling proxies.
                    for (ip, data) in batch.iter().zip(answers) {
                        if !data.is_empty() {
                            labels.push(GeoLabel::new(ip, &data));
                        }
                        cache.insert(ip.clone(), data);
                    }
                }
            }
            if !labels.is_empty() {
                on_wave(labels);
            }
        }
        true
    }

    /// Look up addresses as they are discovered, until every sender is gone.
    ///
    /// Exits exist only once a proxy has answered, so they cannot be looked up
    /// with the list before the run. Each batch closes after `BATCH` addresses
    /// or a quarter of a second, whichever comes first: a steady trickle of
    /// working proxies costs a handful of requests, not one per proxy. An
    /// address is asked about once per session; once the API has failed to
    /// answer, the rest of the stream is drained without asking again.
    pub async fn locate_as_found<F>(&self, mut found: tokio::sync::mpsc::UnboundedReceiver<String>, mut on_wave: F)
    where
        F: FnMut(Vec<GeoLabel>),
    {
        let mut asked: HashSet<String> = HashSet::new();
        let mut api_down = !self.available();
        while let Some(first) = found.recv().await {
            let mut batch = vec![first];
            let deadline = tokio::time::Instant::now() + Duration::from_millis(250);
            while batch.len() < BATCH {
                match tokio::time::timeout_at(deadline, found.recv()).await {
                    Ok(Some(ip)) => batch.push(ip),
                    Ok(None) | Err(_) => break,
                }
            }
            if api_down {
                continue;
            }
            batch.retain(|ip| !self.knows(ip) && asked.insert(ip.clone()));
            if batch.is_empty() {
                continue;
            }
            if !self.prefetch(&batch, &mut on_wave).await {
                api_down = true;
            }
        }
    }

    async fn fetch_batch(&self, ips: &[String]) -> Option<Vec<GeoData>> {
        let response = self
            .http
            .post(&self.api)
            .json(&serde_json::json!({ "ips": ips }))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let raw: serde_json::Value = response.json().await.ok()?;

        // Verify the echoed order matches what we sent. If it ever does not, drop
        // the batch instead of labelling proxies with the wrong country — a wrong
        // flag is worse than a missing one.
        if let Some(items) = raw.get("results").and_then(|v| v.as_array()) {
            for (sent, got) in ips.iter().zip(items) {
                let echoed = serde_json::from_value::<IpEcho>(got.clone()).ok().and_then(|e| e.ip);
                if echoed.as_deref().is_some_and(|e| e != sent) {
                    return None;
                }
            }
        }

        serde_json::from_value::<BatchResponse>(raw).ok().map(|b| b.results)
    }

    /// Whether this address's answer is already in the cache (a hit or a miss).
    pub fn knows(&self, ip: &str) -> bool {
        self.cache.read().is_ok_and(|c| c.contains_key(ip))
    }

    /// Copy the cached answer for the address a row's location describes (see
    /// [`located_ip`]) onto a result. Synchronous: everything was resolved in
    /// [`Geo::prefetch`], so this is a map lookup on the hot path.
    ///
    /// A working proxy is labelled by its EXIT and nothing else: a rotating
    /// gateway in one country hands out exits in others, and labelling the
    /// gateway put a French flag on Mozambican residential lines (the website
    /// fixed exactly this on 2026-09-08). When the exit is not cached yet the
    /// row stays unlabelled until its own lookup lands, rather than borrowing
    /// the gateway's country. A dead proxy is labelled by the address dialled:
    /// you still want to know where an IP lived.
    pub fn enrich(&self, host: &str, result: &mut CheckResult) {
        // A row that already carries a location got it from a source nearer the
        // truth: API-mode rows are located by our server from their exit. The
        // cache here holds the dialled addresses, so overwriting would put the
        // gateway's country back on them.
        if result.country_code.is_some() {
            return;
        }
        let Ok(cache) = self.cache.read() else { return };
        let g = match located_ip(result) {
            Some(ip) if result.alive && result.exit_ip.is_some() => cache.get(ip),
            Some(ip) => cache.get(ip).or_else(|| cache.get(host)),
            None => cache.get(host),
        };
        let Some(g) = g else {
            return;
        };
        if g.is_empty() {
            return;
        }
        result.country_code = g.country.clone();
        result.country = g.country_name.clone();
        result.city = g.city.clone();
        result.asn = g.asn;
        result.asn_org = g.asn_org.clone();
        result.is_datacenter = g.is_datacenter;
    }
}

/// The address a row's location describes: the exit for a working proxy that
/// named one, else the address that was dialled.
pub fn located_ip(result: &CheckResult) -> Option<&str> {
    if result.alive {
        if let Some(exit) = result.exit_ip.as_deref() {
            return Some(exit);
        }
    }
    result.ip.as_deref()
}

impl Geo {
    /// The API's own answer for a few addresses, as it sent it: one address is
    /// `GET /api/ip/<ip>`, several are one batch. For `hproxy ip` and the MCP
    /// `ip_lookup` tool, which pass the whole record through.
    pub async fn lookup(&self, ips: &[String]) -> Result<serde_json::Value, String> {
        if !self.available() {
            return Err("the IP lookup is switched off".into());
        }
        let ips: Vec<String> = ips
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if ips.is_empty() {
            return Err("give at least one IP address".into());
        }
        if let Some(bad) = ips.iter().find(|s| s.parse::<IpAddr>().is_err()) {
            return Err(format!("`{bad}` is not an IP address"));
        }
        if ips.len() > BATCH {
            return Err(format!("at most {BATCH} addresses per lookup"));
        }
        let request = if ips.len() == 1 {
            self.http.get(format!("{}/{}", self.api, ips[0]))
        } else {
            self.http.post(&self.api).json(&serde_json::json!({ "ips": ips }))
        };
        let response = request
            .send()
            .await
            .map_err(|e| format!("could not reach the IP lookup: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("the IP lookup is rate limited for your address; retry in a minute".into());
        }
        if !status.is_success() {
            return Err(format!("the IP lookup answered {status}"));
        }
        response
            .json()
            .await
            .map_err(|e| format!("the IP lookup sent something that is not JSON: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_with(geo: &Geo, ip: &str, cc: &str) {
        geo.cache.write().unwrap().insert(
            ip.into(),
            GeoData {
                country: Some(cc.into()),
                ..Default::default()
            },
        );
    }

    /// A rotating residential gateway lives in one country and hands out exits
    /// in another. A working row is labelled by its exit, never the gateway.
    #[test]
    fn a_working_row_is_located_by_its_exit_not_the_gateway() {
        let geo = Geo::new(DEFAULT_GEO_API);
        cache_with(&geo, "198.51.100.7", "FR");
        cache_with(&geo, "203.0.113.9", "MZ");
        let mut r = CheckResult {
            ip: Some("198.51.100.7".into()),
            alive: true,
            exit_ip: Some("203.0.113.9".into()),
            ..Default::default()
        };
        geo.enrich("198.51.100.7", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("MZ"));
        assert_eq!(located_ip(&r), Some("203.0.113.9"));
    }

    /// Until the exit's own answer is in, the row stays unlabelled rather than
    /// borrowing the gateway's country, which would be a confident wrong flag.
    #[test]
    fn an_unknown_exit_never_borrows_the_gateways_country() {
        let geo = Geo::new(DEFAULT_GEO_API);
        cache_with(&geo, "198.51.100.7", "FR");
        let mut r = CheckResult {
            ip: Some("198.51.100.7".into()),
            alive: true,
            exit_ip: Some("203.0.113.9".into()),
            ..Default::default()
        };
        geo.enrich("198.51.100.7", &mut r);
        assert_eq!(r.country_code, None);
        assert!(!geo.knows("203.0.113.9"));
    }

    /// A dead row has no exit, so it keeps the address that was dialled.
    #[test]
    fn a_dead_row_is_located_by_the_address_dialled() {
        let geo = Geo::new(DEFAULT_GEO_API);
        cache_with(&geo, "198.51.100.7", "FR");
        let mut r = CheckResult {
            ip: Some("198.51.100.7".into()),
            ..Default::default()
        };
        geo.enrich("198.51.100.7", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("FR"));
    }

    /// API-mode rows arrive located by our server from their exit; the cache of
    /// dialled addresses must not put the gateway's country back on them.
    #[test]
    fn a_row_that_already_has_a_location_keeps_it() {
        let geo = Geo::new(DEFAULT_GEO_API);
        cache_with(&geo, "198.51.100.7", "FR");
        let mut r = CheckResult {
            ip: Some("198.51.100.7".into()),
            country_code: Some("MZ".into()),
            ..Default::default()
        };
        geo.enrich("198.51.100.7", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("MZ"));
    }

    /// Exits found during a run are asked about in batches, once each, and the
    /// stream ends when the run drops its sender.
    #[tokio::test]
    async fn exits_are_looked_up_in_batches_as_they_are_found() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let counter = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"results":[{"ip":"203.0.113.9","country":"MZ"},{"ip":"203.0.113.10","country":"KE"}]}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });

        let geo = Geo::new(format!("http://{addr}/api/ip"));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        for ip in ["203.0.113.9", "203.0.113.10", "203.0.113.9"] {
            tx.send(ip.to_string()).unwrap();
        }
        drop(tx);
        let mut labels = Vec::new();
        geo.locate_as_found(rx, |l| labels.extend(l)).await;
        assert_eq!(requests.load(Ordering::SeqCst), 1, "one batch for three sightings");
        assert_eq!(labels.len(), 2);
        assert!(geo.knows("203.0.113.10"));
    }

    #[tokio::test]
    async fn a_lookup_refuses_what_is_not_an_address_before_the_network() {
        let geo = Geo::new("http://127.0.0.1:9/api/ip");
        assert!(geo.lookup(&[]).await.unwrap_err().contains("at least one"));
        assert!(geo
            .lookup(&["example.com".into()])
            .await
            .unwrap_err()
            .contains("not an IP"));
        assert!(Geo::new("").lookup(&["8.8.8.8".into()]).await.is_err());
    }

    #[test]
    fn disabled_when_url_is_empty() {
        assert!(!Geo::new("").available());
        assert!(!Geo::new("   ").available());
        assert!(Geo::new(DEFAULT_GEO_API).available());
    }

    #[test]
    fn trailing_slash_is_normalised() {
        assert!(Geo::new("https://hproxy.com/api/ip/").available());
    }

    /// A `found: false` answer must leave the row untouched rather than stamping
    /// it with empty values (which would render as a blank flag, not a dash).
    #[test]
    fn miss_does_not_overwrite() {
        let geo = Geo::new(DEFAULT_GEO_API);
        geo.cache.write().unwrap().insert("1.2.3.4".into(), GeoData::default());
        let mut r = CheckResult {
            country_code: Some("DE".into()),
            ..Default::default()
        };
        geo.enrich("1.2.3.4", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("DE"), "a miss must not clear known geo");
        assert_eq!(r.is_datacenter, None);
    }

    #[test]
    fn hit_fills_every_column() {
        let geo = Geo::new(DEFAULT_GEO_API);
        geo.cache.write().unwrap().insert(
            "198.51.100.44".into(),
            GeoData {
                country: Some("US".into()),
                country_name: Some("United States".into()),
                city: Some("Dallas".into()),
                asn: Some(63949),
                asn_org: Some("Akamai Technologies, Inc.".into()),
                is_datacenter: Some(true),
                timezone: Some("America/Chicago".into()),
            },
        );
        assert_eq!(geo.label("198.51.100.44").and_then(|l| l.timezone).as_deref(), Some("America/Chicago"));
        let mut r = CheckResult::default();
        geo.enrich("198.51.100.44", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("US"));
        assert_eq!(r.country.as_deref(), Some("United States"));
        assert_eq!(r.city.as_deref(), Some("Dallas"));
        assert_eq!(r.asn, Some(63949));
        assert_eq!(r.asn_org.as_deref(), Some("Akamai Technologies, Inc."));
        assert_eq!(r.is_datacenter, Some(true));
    }

    /// The API's own answer (hproxy.com/api/ip/8.8.8.8, 2026-09-28) reads with
    /// its time zone, which the Connect panel compares with the computer's clock.
    #[test]
    fn the_api_answer_carries_the_time_zone() {
        let g: GeoData = serde_json::from_str(
            r#"{"asn":15169,"asn_org":"Google LLC","country":"US","country_name":"United States","ip":"8.8.8.8","is_datacenter":true,"isp":"Google LLC","latitude":37.751,"longitude":-97.822,"timezone":"America/Chicago"}"#,
        )
        .unwrap();
        assert_eq!(g.timezone.as_deref(), Some("America/Chicago"));
        assert_eq!(GeoLabel::new("8.8.8.8", &g).timezone.as_deref(), Some("America/Chicago"));
    }

    /// The engine's resolved address wins over the pasted host, so a proxy given
    /// as a hostname still gets labelled by the IP actually reached.
    #[test]
    fn prefers_the_resolved_ip() {
        let geo = Geo::new(DEFAULT_GEO_API);
        geo.cache.write().unwrap().insert(
            "8.8.8.8".into(),
            GeoData {
                country: Some("US".into()),
                ..Default::default()
            },
        );
        let mut r = CheckResult {
            ip: Some("8.8.8.8".into()),
            ..Default::default()
        };
        geo.enrich("proxy.example.com", &mut r);
        assert_eq!(r.country_code.as_deref(), Some("US"));
    }

    /// Hostnames and duplicates must never reach the API.
    #[tokio::test]
    async fn prefetch_ignores_non_ips_and_is_a_noop_when_disabled() {
        let geo = Geo::new("");
        let mut waves = 0;
        geo.prefetch(&["1.2.3.4".into(), "example.com".into()], |_| waves += 1)
            .await;
        assert!(geo.cache.read().unwrap().is_empty());
        assert_eq!(waves, 0);
    }

    /// An API that is down must cost the run ONE wave of attempts, not one per
    /// wave of the list. 900 addresses are nine batches, so two waves of eight;
    /// the server below hangs up on everyone, and only the first wave may ever
    /// reach it.
    #[tokio::test]
    async fn a_dead_api_costs_one_wave_not_the_whole_list() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                drop(sock);
            }
        });

        let geo = Geo::new(format!("http://{addr}/api/ip"));
        let ips: Vec<String> = (0..900).map(|i| format!("10.{}.{}.1", i / 250, i % 250)).collect();
        let mut waves = 0;
        geo.prefetch(&ips, |_| waves += 1).await;

        assert_eq!(waves, 0, "a failed wave hands over no labels");
        assert_eq!(
            hits.load(Ordering::SeqCst),
            8,
            "only the first wave may reach a dead API"
        );
        assert!(geo.cache.read().unwrap().is_empty());
    }

    /// A wave that answers is handed over as labels, and misses are not labels.
    #[tokio::test]
    async fn a_wave_is_handed_over_as_labels_without_the_misses() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"results":[{"ip":"8.8.8.8","country":"US","country_name":"United States","city":"Mountain View","asn":15169,"asn_org":"Google LLC"},{"ip":"10.0.0.1","found":false}]}"#;
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(reply.as_bytes()).await;
            }
        });

        let geo = Geo::new(format!("http://{addr}/api/ip"));
        let mut got: Vec<GeoLabel> = Vec::new();
        geo.prefetch(&["8.8.8.8".into(), "10.0.0.1".into()], |labels| got.extend(labels))
            .await;

        assert_eq!(got.len(), 1, "a miss is not a label");
        assert_eq!(got[0].ip, "8.8.8.8");
        assert_eq!(got[0].country_code.as_deref(), Some("US"));
        assert_eq!(got[0].asn_org.as_deref(), Some("Google LLC"));
        // The miss is still cached, so a second run does not ask again.
        assert_eq!(geo.cache.read().unwrap().len(), 2);
    }
}
