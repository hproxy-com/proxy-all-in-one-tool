//! "Works with": whether a working proxy also opens a given site, or that
//! site refuses its address (a captcha wall, a block, a region lock).
//!
//! The one place the engine asks a site that is not ours, and only when the
//! person picked one: the checker's "Works with Google". Only the answer's
//! status and where it sends you are read; the page itself is never
//! downloaded, because every byte goes through the person's own proxy and
//! plan. A proxy that is not working is never asked.

use std::time::Duration;

use hproxy_probe::{ProxyLine, Way};
use serde::{Deserialize, Serialize};

/// The sites a check can be made against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Any,
    Google,
    Instagram,
    Tiktok,
    Amazon,
}

impl Site {
    pub fn name(self) -> &'static str {
        match self {
            Site::Any => "Any site",
            Site::Google => "Google",
            Site::Instagram => "Instagram",
            Site::Tiktok => "TikTok",
            Site::Amazon => "Amazon",
        }
    }

    fn url(self) -> Option<&'static str> {
        Some(match self {
            Site::Any => return None,
            Site::Google => "https://www.google.com/search?q=weather&hl=en",
            Site::Instagram => "https://www.instagram.com/",
            Site::Tiktok => "https://www.tiktok.com/",
            Site::Amazon => "https://www.amazon.com/",
        })
    }
}

/// What the site said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "verdict", rename_all = "snake_case")]
pub enum SiteVerdict {
    Opens,
    /// The site refused this address, with the reason in words.
    Refuses {
        why: String,
    },
    /// The site could not be asked through this proxy (it timed out, or the
    /// tunnel broke), so nothing is known.
    Unknown {
        why: String,
    },
}

/// A phone browser's words, so the site answers as it answers a person.
const BROWSER: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

/// Ask `site` through the proxy `line`, speaking to it the `way` its check proved.
pub async fn check(line: &ProxyLine, way: Way, site: Site) -> SiteVerdict {
    let Some(url) = site.url() else {
        return SiteVerdict::Opens;
    };
    let proxy = match proxy_for(line, way) {
        Ok(p) => p,
        Err(e) => return SiteVerdict::Unknown { why: e },
    };
    let client = match reqwest::Client::builder()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .user_agent(BROWSER)
        .build()
    {
        Ok(c) => c,
        Err(e) => return SiteVerdict::Unknown { why: e.to_string() },
    };
    let resp = match client.get(url).header("Accept-Language", "en-US,en;q=0.9").send().await {
        Ok(r) => r,
        Err(e) if e.is_timeout() => {
            return SiteVerdict::Unknown {
                why: format!("{} did not answer in time", site.name()),
            }
        }
        Err(e) => {
            return SiteVerdict::Unknown {
                why: e.without_url().to_string(),
            }
        }
    };
    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    // The answer's head is all that is read: dropping it here ends the
    // connection before the page comes down.
    drop(resp);
    read(site, status, &location)
}

/// What a status and a redirect mean for each site.
fn read(site: Site, status: u16, location: &str) -> SiteVerdict {
    let refuses = |why: &str| SiteVerdict::Refuses { why: why.to_string() };
    match (site, status) {
        (_, 429) => refuses(&format!(
            "{} says too many requests come from this address",
            site.name()
        )),
        (Site::Google, 301..=399) if location.contains("/sorry/") => {
            refuses("Google asks this address to solve a captcha")
        }
        (Site::Instagram, 301..=399) if location.contains("/challenge") => {
            refuses("Instagram asks this address for a challenge")
        }
        (Site::Amazon, 503) => refuses("Amazon shows this address its robot check"),
        (Site::Tiktok, 451) => refuses("TikTok is not available where this address is"),
        (_, 403) => refuses(&format!("{} refuses this address", site.name())),
        (_, 200..=399) => SiteVerdict::Opens,
        (_, s) => SiteVerdict::Unknown {
            why: format!("{} answered {s}", site.name()),
        },
    }
}

/// The proxy as the HTTP client takes it, with its login.
fn proxy_for(line: &ProxyLine, way: Way) -> Result<reqwest::Proxy, String> {
    let host = if line.host.contains(':') {
        format!("[{}]", line.host)
    } else {
        line.host.clone()
    };
    let login = line
        .auth
        .as_ref()
        .map(|(u, p)| format!("{}:{}@", encode(u), encode(p)))
        .unwrap_or_default();
    let url = match way {
        // socks5h: the proxy looks the site's name up, as the relay has it do.
        Way::Socks5 => format!("socks5h://{login}{host}:{}", line.port),
        Way::Http => format!("http://{login}{host}:{}", line.port),
    };
    reqwest::Proxy::all(url).map_err(|e| e.to_string())
}

/// A login's part, as an address carries it: everything but letters, digits
/// and `-._~` written as `%XX`.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_site_reads_its_own_wall() {
        assert_eq!(read(Site::Google, 200, ""), SiteVerdict::Opens);
        assert_eq!(
            read(Site::Google, 302, "https://consent.google.com/ml"),
            SiteVerdict::Opens,
            "a consent page is no wall"
        );
        assert!(matches!(
            read(Site::Google, 302, "https://www.google.com/sorry/index?continue=x"),
            SiteVerdict::Refuses { .. }
        ));
        assert!(matches!(
            read(Site::Instagram, 302, "https://www.instagram.com/challenge/"),
            SiteVerdict::Refuses { .. }
        ));
        assert_eq!(
            read(Site::Instagram, 302, "https://www.instagram.com/accounts/login/"),
            SiteVerdict::Opens
        );
        assert!(matches!(read(Site::Amazon, 503, ""), SiteVerdict::Refuses { .. }));
        assert!(matches!(read(Site::Tiktok, 451, ""), SiteVerdict::Refuses { .. }));
        assert!(matches!(read(Site::Tiktok, 429, ""), SiteVerdict::Refuses { .. }));
        assert!(matches!(read(Site::Amazon, 500, ""), SiteVerdict::Unknown { .. }));
    }

    #[test]
    fn a_login_with_odd_characters_is_written_safely() {
        assert_eq!(encode("user-country-us"), "user-country-us");
        assert_eq!(encode("p@ss:w/rd"), "p%40ss%3Aw%2Frd");
        let line = hproxy_probe::parse("198.51.100.7:8080:acct-session-ab:p!ss#w%rd").unwrap();
        assert!(proxy_for(&line, Way::Http).is_ok());
        assert!(proxy_for(&line, Way::Socks5).is_ok());
    }

    #[tokio::test]
    async fn any_site_asks_nothing() {
        let line = hproxy_probe::parse("198.51.100.7:8080").unwrap();
        assert_eq!(check(&line, Way::Http, Site::Any).await, SiteVerdict::Opens);
    }
}
