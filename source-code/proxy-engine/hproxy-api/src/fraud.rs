//! The fraud score of an address: how risky the sites a proxy reaches will
//! take it to be. FFraud's free public lookup by default, with no key; or the
//! person's own key at IPQualityScore, Scamalytics, proxycheck.io or AbuseIPDB.
//!
//! Every lookup goes from the person's computer straight to the service they
//! picked, with their own key; nothing passes through us on the way, and
//! nothing another service answers is kept or sent anywhere. Their answers
//! belong to them and to the person who holds the key.
//!
//! Each service is one request and one reader. The readers are pure, so the
//! tests below hold each one against the answer its documentation shows (and,
//! for FFraud and proxycheck.io, an answer read live on 2026-09-23).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// FFraud's public lookup: no key, 100 requests a second per address.
pub const FFRAUD_PUBLIC: &str = "https://api.ffraud.com/public/ip/";
const IPQS: &str = "https://ipqualityscore.com/api/json/ip/";
const PROXYCHECK: &str = "https://proxycheck.io/v3/";
const ABUSEIPDB: &str = "https://api.abuseipdb.com/api/v2/check";
/// Where Scamalytics answers when the person gives a username and key
/// instead of the full address from their account.
const SCAMALYTICS: &str = "https://api11.scamalytics.com/v3/";

/// Who looks the address up, and with what. The window sends it as
/// `{"service": "ipqs", "key": "..."}`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "service", rename_all = "lowercase")]
pub enum FraudService {
    /// FFraud's free public lookup. The default.
    Ffraud,
    Ipqs {
        key: String,
    },
    /// The API address Scamalytics shows in the person's account
    /// (`https://api11.scamalytics.com/v3/<username>/?key=<key>`), or
    /// `username:key`.
    Scamalytics {
        address: String,
    },
    /// Works without a key too, at 100 lookups a day.
    Proxycheck {
        #[serde(default)]
        key: Option<String>,
    },
    Abuseipdb {
        key: String,
    },
}

/// One address's score, the same shape whoever answered.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FraudScore {
    pub ip: String,
    /// 0 to 100; higher is riskier.
    pub score: u8,
    /// The service's own word for it, when it gives one ("low", "high").
    pub risk: Option<String>,
    /// What the service says the address is: "proxy", "VPN", "Tor", "hosting".
    pub flags: Vec<String>,
    /// The service's own sentence, or one made from what it said.
    pub reason: Option<String>,
    /// Who answered: "FFraud", "IPQualityScore" ...
    pub service: &'static str,
}

impl FraudService {
    /// The name the screen shows.
    pub fn name(&self) -> &'static str {
        match self {
            Self::Ffraud => "FFraud",
            Self::Ipqs { .. } => "IPQualityScore",
            Self::Scamalytics { .. } => "Scamalytics",
            Self::Proxycheck { .. } => "proxycheck.io",
            Self::Abuseipdb { .. } => "AbuseIPDB",
        }
    }

    /// The request for one address.
    fn request(&self, http: &reqwest::Client, ip: &str) -> Result<reqwest::RequestBuilder, String> {
        let missing = |what: &str| format!("{} needs {what} (Settings, Fraud score)", self.name());
        Ok(match self {
            Self::Ffraud => http.get(format!("{FFRAUD_PUBLIC}{ip}")),
            Self::Ipqs { key } => {
                let key = key.trim();
                if key.is_empty() {
                    return Err(missing("your API key"));
                }
                let mut url = reqwest::Url::parse(IPQS).map_err(|e| e.to_string())?;
                url.path_segments_mut()
                    .map_err(|_| "bad IPQualityScore address".to_string())?
                    .pop_if_empty()
                    .push(key)
                    .push(ip);
                url.query_pairs_mut()
                    .append_pair("strictness", "0")
                    .append_pair("allow_public_access_points", "true");
                http.get(url)
            }
            Self::Scamalytics { address } => http.get(
                scamalytics_url(address, ip)
                    .ok_or_else(|| missing("the API address from your Scamalytics account, or username:key"))?,
            ),
            Self::Proxycheck { key } => {
                let mut url = reqwest::Url::parse(&format!("{PROXYCHECK}{ip}")).map_err(|e| e.to_string())?;
                if let Some(key) = key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
                    url.query_pairs_mut().append_pair("key", key);
                }
                http.get(url)
            }
            Self::Abuseipdb { key } => {
                let key = key.trim();
                if key.is_empty() {
                    return Err(missing("your API key"));
                }
                http.get(ABUSEIPDB)
                    .query(&[("ipAddress", ip), ("maxAgeInDays", "90")])
                    .header("Key", key)
                    .header("Accept", "application/json")
            }
        })
    }

    /// Read one answer. `status` is the HTTP status it came with.
    pub fn read(&self, ip: &str, status: u16, body: &Value) -> Result<FraudScore, String> {
        match self {
            Self::Ffraud => read_ffraud(ip, status, body),
            Self::Ipqs { .. } => read_ipqs(ip, status, body),
            Self::Scamalytics { .. } => read_scamalytics(ip, status, body),
            Self::Proxycheck { .. } => read_proxycheck(ip, status, body),
            Self::Abuseipdb { .. } => read_abuseipdb(ip, status, body),
        }
    }
}

/// Look one address up. The error is a sentence for the screen.
pub async fn lookup(http: &reqwest::Client, service: &FraudService, ip: &str) -> Result<FraudScore, String> {
    let ip: std::net::IpAddr = ip
        .trim()
        .parse()
        .map_err(|_| format!("`{}` is not an IP address", ip.trim()))?;
    let ip = ip.to_string();
    let name = service.name();
    let answer = service
        .request(http, &ip)?
        .send()
        .await
        .map_err(|e| format!("{name} did not answer: {}", plain(&e)))?;
    let status = answer.status().as_u16();
    let body: Value = answer
        .json()
        .await
        .map_err(|_| format!("{name} answered with something that is not a result (HTTP {status})"))?;
    service.read(&ip, status, &body)
}

/// A request error in a few words, without the URL (it may carry a key).
fn plain(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "it took too long"
    } else if e.is_connect() {
        "no connection to it"
    } else {
        "the request failed"
    }
}

fn score_of(v: &Value) -> Option<u8> {
    let n = v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))?;
    Some(n.round().clamp(0.0, 100.0) as u8)
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The names of the flags that are true, in the order given.
fn flags(v: &Value, names: &[(&str, &str)]) -> Vec<String> {
    names
        .iter()
        .filter(|(key, _)| v[*key].as_bool() == Some(true))
        .map(|(_, name)| name.to_string())
        .collect()
}

fn refused(name: &str, status: u16, message: Option<String>) -> String {
    let why = message.unwrap_or_else(|| format!("HTTP {status}"));
    match status {
        401 | 403 => format!("{name} did not accept the key: {why}"),
        429 => format!("{name}: too many lookups for now. {why}"),
        _ => format!("{name} could not look it up: {why}"),
    }
}

fn read_ffraud(ip: &str, status: u16, v: &Value) -> Result<FraudScore, String> {
    if v["success"].as_bool() != Some(true) {
        return Err(refused(
            "FFraud",
            status,
            text(&v["message"]).or_else(|| text(&v["error"])),
        ));
    }
    let score = score_of(&v["fraud_score"]).ok_or("FFraud sent no score")?;
    let mut f = flags(
        v,
        &[
            ("proxy", "proxy"),
            ("vpn", "VPN"),
            ("tor", "Tor"),
            ("relay", "relay"),
            ("hosting", "hosting"),
        ],
    );
    if v["is_residential_proxy"].as_bool() == Some(true) {
        f.push("residential proxy".into());
    }
    Ok(FraudScore {
        ip: ip.to_string(),
        score,
        risk: text(&v["risk"]),
        flags: f,
        reason: text(&v["reason"]),
        service: "FFraud",
    })
}

fn read_ipqs(ip: &str, status: u16, v: &Value) -> Result<FraudScore, String> {
    if v["success"].as_bool() != Some(true) {
        return Err(refused("IPQualityScore", status, text(&v["message"])));
    }
    let score = score_of(&v["fraud_score"]).ok_or("IPQualityScore sent no score")?;
    Ok(FraudScore {
        ip: ip.to_string(),
        score,
        risk: None,
        flags: flags(
            v,
            &[
                ("proxy", "proxy"),
                ("vpn", "VPN"),
                ("tor", "Tor"),
                ("recent_abuse", "recent abuse"),
                ("bot_status", "bot"),
            ],
        ),
        reason: None,
        service: "IPQualityScore",
    })
}

fn read_scamalytics(ip: &str, status: u16, v: &Value) -> Result<FraudScore, String> {
    let s = &v["scamalytics"];
    if s["status"].as_str() != Some("ok") {
        let message = text(&s["error"])
            .or_else(|| text(&s["message"]))
            .or_else(|| text(&v["error"]));
        return Err(refused("Scamalytics", status, message));
    }
    let score = score_of(&s["scamalytics_score"]).ok_or("Scamalytics sent no score")?;
    Ok(FraudScore {
        ip: ip.to_string(),
        score,
        risk: text(&s["scamalytics_risk"]),
        flags: flags(
            &s["scamalytics_proxy"],
            &[("is_vpn", "VPN"), ("is_datacenter", "hosting")],
        ),
        reason: None,
        service: "Scamalytics",
    })
}

fn read_proxycheck(ip: &str, status: u16, v: &Value) -> Result<FraudScore, String> {
    if !matches!(v["status"].as_str(), Some("ok") | Some("warning")) {
        return Err(refused("proxycheck.io", status, text(&v["message"])));
    }
    let d = &v[ip]["detections"];
    let score = score_of(&d["risk"]).ok_or("proxycheck.io sent no risk score")?;
    Ok(FraudScore {
        ip: ip.to_string(),
        score,
        risk: None,
        flags: flags(
            d,
            &[
                ("proxy", "proxy"),
                ("vpn", "VPN"),
                ("tor", "Tor"),
                ("hosting", "hosting"),
                ("compromised", "compromised"),
                ("scraper", "scraper"),
                ("anonymous", "anonymous"),
            ],
        ),
        reason: None,
        service: "proxycheck.io",
    })
}

fn read_abuseipdb(ip: &str, status: u16, v: &Value) -> Result<FraudScore, String> {
    if let Some(first) = v["errors"].as_array().and_then(|e| e.first()) {
        return Err(refused("AbuseIPDB", status, text(&first["detail"])));
    }
    let d = &v["data"];
    let score = score_of(&d["abuseConfidenceScore"]).ok_or("AbuseIPDB sent no score")?;
    let mut f = flags(d, &[("isTor", "Tor")]);
    if d["usageType"].as_str().is_some_and(|t| t.contains("Data Center")) {
        f.push("hosting".into());
    }
    let reports = d["totalReports"].as_u64().unwrap_or(0);
    Ok(FraudScore {
        ip: ip.to_string(),
        score,
        risk: None,
        flags: f,
        reason: Some(match reports {
            0 => "No abuse reports in the last 90 days".to_string(),
            1 => "Reported for abuse once in the last 90 days".to_string(),
            n => format!("Reported for abuse {n} times in the last 90 days"),
        }),
        service: "AbuseIPDB",
    })
}

/// The Scamalytics address for one lookup: the one from the person's account
/// with this `ip`, or one made from `username:key`. None when it is neither.
fn scamalytics_url(address: &str, ip: &str) -> Option<reqwest::Url> {
    let address = address.trim();
    let mut url = if address.contains("://") {
        let url = reqwest::Url::parse(address).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        if url.scheme() != "https" || !(host == "scamalytics.com" || host.ends_with(".scamalytics.com")) {
            return None;
        }
        url
    } else {
        let (user, key) = address.split_once(':')?;
        let (user, key) = (user.trim(), key.trim());
        if user.is_empty() || key.is_empty() || user.contains('/') {
            return None;
        }
        let mut url = reqwest::Url::parse(&format!("{SCAMALYTICS}{user}/")).ok()?;
        url.query_pairs_mut().append_pair("key", key);
        url
    };
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| k != "ip")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if !kept.iter().any(|(k, _)| k == "key") {
        return None;
    }
    url.query_pairs_mut().clear().extend_pairs(kept).append_pair("ip", ip);
    Some(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const IP: &str = "203.0.113.9";

    #[test]
    fn reads_ffraud_as_it_answered_live() {
        // api.ffraud.com/public/ip/8.8.8.8, read 2026-09-23 (trimmed).
        let body = json!({"success":true,"ip":"8.8.8.8","fraud_score":5,"risk":"none",
            "reason":"Datacenter/hosting IP operated by Google Cloud. Not inherently malicious, but datacenter traffic in consumer-facing flows can indicate automation",
            "proxy":false,"vpn":false,"tor":false,"relay":false,"hosting":true,"mobile":false,"is_residential_proxy":false});
        let s = FraudService::Ffraud.read("8.8.8.8", 200, &body).unwrap();
        assert_eq!(s.score, 5);
        assert_eq!(s.risk.as_deref(), Some("none"));
        assert_eq!(s.flags, vec!["hosting"]);
        assert!(s.reason.unwrap().contains("Google Cloud"));
        assert_eq!(s.service, "FFraud");
    }

    #[test]
    fn says_why_ffraud_refused() {
        let body = json!({"success":false,"error_code":3002,"error":"RATE_LIMIT_IP",
            "message":"Rate limit exceeded for your IP address. 100 requests/second allowed for public endpoints. Retry after 1 second(s)."});
        let e = FraudService::Ffraud.read(IP, 429, &body).unwrap_err();
        assert!(e.starts_with("FFraud: too many lookups for now."), "{e}");
        assert!(e.contains("Retry after 1 second"), "{e}");
    }

    #[test]
    fn reads_ipqualityscore() {
        let body = json!({"success":true,"message":"Success.","fraud_score":88,"proxy":true,"vpn":true,"tor":false,"recent_abuse":true,"bot_status":false,"request_id":"x"});
        let s = FraudService::Ipqs { key: "k".into() }.read(IP, 200, &body).unwrap();
        assert_eq!((s.score, s.risk.clone()), (88, None));
        assert_eq!(s.flags, vec!["proxy", "VPN", "recent abuse"]);
        let bad = json!({"success":false,"message":"Invalid or unauthorized key. Please check the API key and try again.","request_id":"y"});
        let e = FraudService::Ipqs { key: "k".into() }.read(IP, 200, &bad).unwrap_err();
        assert!(e.contains("Invalid or unauthorized key"), "{e}");
    }

    #[test]
    fn reads_scamalytics_v3() {
        let body = json!({"scamalytics":{"status":"ok","mode":"live","ip":IP,"scamalytics_score":64,"scamalytics_risk":"medium",
            "scamalytics_proxy":{"is_datacenter":true,"is_vpn":false,"is_apple_icloud_private_relay":false}},"external_datasources":{}});
        let service = FraudService::Scamalytics {
            address: "demo:abc".into(),
        };
        let s = service.read(IP, 200, &body).unwrap();
        assert_eq!((s.score, s.risk.as_deref()), (64, Some("medium")));
        assert_eq!(s.flags, vec!["hosting"]);
        let bad = json!({"scamalytics":{"status":"error","error":"invalid key"}});
        assert!(service.read(IP, 200, &bad).unwrap_err().contains("invalid key"));
    }

    #[test]
    fn reads_proxycheck_v3_as_it_answered_live() {
        // proxycheck.io/v3/8.8.8.8, read 2026-09-23 (trimmed).
        let body = json!({"status":"ok","8.8.8.8":{"network":{"asn":"AS15169","provider":"Google LLC","type":"Business"},
            "detections":{"proxy":false,"vpn":false,"compromised":false,"scraper":false,"tor":false,"hosting":false,"anonymous":true,"risk":100,"confidence":100},
            "operator":null},"query_time":4});
        let s = FraudService::Proxycheck { key: None }
            .read("8.8.8.8", 200, &body)
            .unwrap();
        assert_eq!(s.score, 100);
        assert_eq!(s.flags, vec!["anonymous"]);
        let denied =
            json!({"status":"denied","message":"Your access to the API has been blocked due to using a proxy server."});
        assert!(FraudService::Proxycheck { key: None }
            .read(IP, 200, &denied)
            .unwrap_err()
            .contains("blocked"));
    }

    #[test]
    fn reads_abuseipdb() {
        // The example answer in AbuseIPDB's documentation (trimmed).
        let body = json!({"data":{"ipAddress":"192.0.2.39","isPublic":true,"abuseConfidenceScore":100,"countryCode":"CN",
            "usageType":"Data Center/Web Hosting/Transit","isp":"Tencent Cloud Computing (Beijing) Co. Ltd","isTor":false,"totalReports":1}});
        let s = FraudService::Abuseipdb { key: "k".into() }
            .read("192.0.2.39", 200, &body)
            .unwrap();
        assert_eq!(s.score, 100);
        assert_eq!(s.flags, vec!["hosting"]);
        assert_eq!(s.reason.as_deref(), Some("Reported for abuse once in the last 90 days"));
        let limit =
            json!({"errors":[{"detail":"Daily rate limit of 1000 requests exceeded for this endpoint.","status":429}]});
        let e = FraudService::Abuseipdb { key: "k".into() }
            .read(IP, 429, &limit)
            .unwrap_err();
        assert!(e.starts_with("AbuseIPDB: too many lookups for now."), "{e}");
    }

    #[test]
    fn builds_the_scamalytics_address() {
        let u = scamalytics_url("https://api12.scamalytics.com/v3/demo/?key=abc&ip=1.1.1.1", IP).unwrap();
        assert_eq!(
            u.as_str(),
            "https://api12.scamalytics.com/v3/demo/?key=abc&ip=203.0.113.9"
        );
        let u = scamalytics_url("demo:abc", IP).unwrap();
        assert_eq!(
            u.as_str(),
            "https://api11.scamalytics.com/v3/demo/?key=abc&ip=203.0.113.9"
        );
        assert!(scamalytics_url("https://evil.example/v3/demo/?key=abc", IP).is_none());
        assert!(scamalytics_url("http://api11.scamalytics.com/v3/demo/?key=abc", IP).is_none());
        assert!(scamalytics_url("https://api11.scamalytics.com/v3/demo/", IP).is_none());
        assert!(scamalytics_url("nokey", IP).is_none());
    }

    #[test]
    fn a_missing_key_is_said_before_anything_is_sent() {
        let http = reqwest::Client::new();
        let e = FraudService::Ipqs { key: " ".into() }.request(&http, IP).err().unwrap();
        assert_eq!(e, "IPQualityScore needs your API key (Settings, Fraud score)");
        assert!(FraudService::Proxycheck { key: None }.request(&http, IP).is_ok());
    }

    #[test]
    fn scores_are_read_as_whole_numbers_from_0_to_100() {
        assert_eq!(score_of(&json!(12.6)), Some(13));
        assert_eq!(score_of(&json!("40")), Some(40));
        assert_eq!(score_of(&json!(140)), Some(100));
        assert_eq!(score_of(&json!(-3)), Some(0));
        assert_eq!(score_of(&json!(null)), None);
    }

    /// Our own service, live. The others are never asked from a test: their
    /// answers above come from their documentation.
    #[tokio::test]
    #[ignore = "live: asks api.ffraud.com"]
    async fn looks_up_ffraud_live() {
        let http = crate::http_client("hproxy-api-test", std::time::Duration::from_secs(20));
        let s = lookup(&http, &FraudService::Ffraud, "8.8.8.8").await.unwrap();
        assert_eq!((s.ip.as_str(), s.service), ("8.8.8.8", "FFraud"));
        assert!(s.risk.is_some() && s.reason.is_some(), "{s:?}");
        let e = lookup(&http, &FraudService::Ffraud, "not an address")
            .await
            .unwrap_err();
        assert_eq!(e, "`not an address` is not an IP address");
    }

    #[test]
    fn the_window_names_the_service_it_wants() {
        let s: FraudService = serde_json::from_value(json!({"service":"ipqs","key":"abc"})).unwrap();
        assert_eq!(s, FraudService::Ipqs { key: "abc".into() });
        let s: FraudService = serde_json::from_value(json!({"service":"ffraud"})).unwrap();
        assert_eq!(s, FraudService::Ffraud);
        let s: FraudService = serde_json::from_value(json!({"service":"proxycheck"})).unwrap();
        assert_eq!(s, FraudService::Proxycheck { key: None });
    }
}
