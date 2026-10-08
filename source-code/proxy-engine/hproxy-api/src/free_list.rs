//! The live free proxy list: `GET https://hproxy.com/api/proxy-list`.
//!
//! The same pool the website lists and the Chrome extension draws from,
//! re-checked around the clock. Rows are reduced to the fields a caller acts
//! on: the API also sends coordinates, reliability labels and counters, and a
//! model reading the answer pays for every field it did not ask for.

use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_LIST_API: &str = "https://hproxy.com/api/proxy-list";

/// Largest page a caller may ask for. The list holds thousands; a caller that
/// wants more than this wants the downloadable file, not an API page.
pub const MAX_LIMIT: usize = 1000;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ListQuery {
    /// ISO 3166 alpha-2, any case.
    pub country: Option<String>,
    /// `http`, `https`, `socks4` or `socks5`.
    pub protocol: Option<String>,
    /// `elite`, `anonymous` or `transparent`.
    pub anonymity: Option<String>,
    pub limit: usize,
}

impl ListQuery {
    /// Check the values before they reach the network, with a sentence for
    /// each mistake, and return the query string.
    pub fn to_query(&self) -> Result<String, String> {
        let mut q = vec![
            ("format", "json".to_string()),
            ("limit", self.limit.clamp(1, MAX_LIMIT).to_string()),
        ];
        if let Some(cc) = self.country.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            if cc.len() != 2 || !cc.bytes().all(|b| b.is_ascii_alphabetic()) {
                return Err(format!("`{cc}` is not a two-letter country code, e.g. DE or US"));
            }
            q.push(("country", cc.to_ascii_lowercase()));
        }
        if let Some(p) = self.protocol.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            let p = p.to_ascii_lowercase();
            if !matches!(p.as_str(), "http" | "https" | "socks4" | "socks5") {
                return Err(format!("`{p}` is not a protocol. Use http, https, socks4 or socks5"));
            }
            q.push(("protocol", p));
        }
        if let Some(a) = self.anonymity.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            let a = a.to_ascii_lowercase();
            if !matches!(a.as_str(), "elite" | "anonymous" | "transparent") {
                return Err(format!("`{a}` is not a grade. Use elite, anonymous or transparent"));
            }
            q.push(("anonymity", a));
        }
        Ok(q.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"))
    }
}

/// One free proxy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreeProxy {
    pub ip: String,
    pub port: u16,
    #[serde(default)]
    pub protocols: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anonymity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asn_org: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_24h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<String>,
}

impl FreeProxy {
    /// `ip:port`, IPv6 in brackets, ready to paste into a checker or a program.
    pub fn line(&self) -> String {
        if self.ip.contains(':') {
            format!("[{}]:{}", self.ip, self.port)
        } else {
            format!("{}:{}", self.ip, self.port)
        }
    }
}

/// Read one page of the list. The answer is an array; an object with `data`
/// is accepted too, so a future envelope does not break old binaries.
pub async fn fetch(client: &reqwest::Client, api: &str, q: &ListQuery) -> Result<Vec<FreeProxy>, String> {
    let url = format!("{}?{}", api.trim_end_matches('/'), q.to_query()?);
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("could not reach the free list: {e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("a few")
            .to_string();
        return Err(format!(
            "the free list is rate limited for your address; retry after {retry} seconds"
        ));
    }
    if !status.is_success() {
        return Err(format!("the free list answered {status}"));
    }
    let raw: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("the free list sent something that is not JSON: {e}"))?;
    parse_rows(raw)
}

fn parse_rows(raw: serde_json::Value) -> Result<Vec<FreeProxy>, String> {
    let rows = match raw {
        serde_json::Value::Array(_) => raw,
        serde_json::Value::Object(mut o) => o.remove("data").unwrap_or(serde_json::Value::Array(Vec::new())),
        _ => return Err("the free list answered in an unknown shape".into()),
    };
    let list: Vec<serde_json::Value> = serde_json::from_value(rows).map_err(|e| e.to_string())?;
    // One odd row must not sink the page: keep every row that reads.
    Ok(list
        .into_iter()
        .filter_map(|v| serde_json::from_value::<FreeProxy>(v).ok())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_checks_its_values_and_lowercases_them() {
        let q = ListQuery {
            country: Some("DE".into()),
            protocol: Some("SOCKS5".into()),
            anonymity: Some("Elite".into()),
            limit: 20,
        };
        assert_eq!(
            q.to_query().unwrap(),
            "format=json&limit=20&country=de&protocol=socks5&anonymity=elite"
        );
        let bad = ListQuery {
            country: Some("Germany".into()),
            ..Default::default()
        };
        assert!(bad.to_query().unwrap_err().contains("two-letter"));
        let bad = ListQuery {
            protocol: Some("vless".into()),
            ..Default::default()
        };
        assert!(bad.to_query().unwrap_err().contains("not a protocol"));
        let huge = ListQuery {
            limit: 1_000_000,
            ..Default::default()
        };
        assert!(huge.to_query().unwrap().contains("limit=1000"));
    }

    #[test]
    fn rows_keep_what_a_caller_acts_on_and_skip_what_does_not_read() {
        let raw = serde_json::json!([
            {"ip":"203.0.113.9","port":1080,"protocols":["socks5"],"anonymity":"elite",
             "country_code":"FR","latitude":48.9,"verification_count":60,"latency_ms":9},
            {"ip":"2001:db8::7","port":8080,"protocols":["http"]},
            {"port":"not a row"}
        ]);
        let rows = parse_rows(raw).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].line(), "203.0.113.9:1080");
        assert_eq!(rows[1].line(), "[2001:db8::7]:8080");
        let json = serde_json::to_string(&rows[0]).unwrap();
        assert!(
            !json.contains("latitude") && !json.contains("verification_count"),
            "{json}"
        );
        assert!(!json.contains("null"), "{json}");
        assert_eq!(parse_rows(serde_json::json!({"data": []})).unwrap().len(), 0);
    }
}
