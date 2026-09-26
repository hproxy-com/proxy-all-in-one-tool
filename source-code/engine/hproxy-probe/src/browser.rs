//! The request fingerprint every probe wears.
//!
//! A checker that sends a bare, robotic request does not measure what the user
//! cares about. Filtering proxies, corporate gateways and anti-bot-fronted
//! endpoints treat a request with no `User-Agent` and no client hints
//! differently from a browser's, and a proxy that works for real browsing then
//! gets reported dead. So every probe goes out looking like Chrome on Windows.
//!
//! Two rules for anything added here:
//!
//! 1. No header in this set may appear in `grade::LEAK_HEADERS`. The judge
//!    echoes back every header it received and the grader treats the presence
//!    of a leak header as proof of a proxy. Sending one ourselves would grade
//!    every proxy on earth "anonymous". A test fails the build if that happens.
//! 2. The version is hardcoded, deliberately. Fetching the current Chrome
//!    version from a third party is a dependency in the hot path of a privacy
//!    tool. Being a few versions behind changes nothing about whether a proxy
//!    relays; the constant is bumped with releases.

/// Bumped with releases. See rule 2 above.
pub const CHROME_VERSION: &str = "141.0.7390.108";
pub const CHROME_MAJOR: &str = "141";

/// Chrome's headers, in Chrome's order, with Chrome's casing.
///
/// Casing is part of the fingerprint. HTTP header names are case-insensitive to
/// a parser, and every HTTP library normalises them, so a request where every
/// name is uniformly lowercase announces "an HTTP library generated me". Chrome
/// sends client hints lowercase (`sec-ch-ua`) and fetch metadata in title case
/// (`Sec-Fetch-Site`). Writing the request bytes ourselves is what makes this
/// reproducible.
pub fn chrome_request_headers() -> Vec<(&'static str, String)> {
    vec![
        (
            "sec-ch-ua",
            format!("\"Chromium\";v=\"{CHROME_MAJOR}\", \"Google Chrome\";v=\"{CHROME_MAJOR}\", \"Not?A_Brand\";v=\"24\""),
        ),
        ("sec-ch-ua-mobile", "?0".into()),
        ("sec-ch-ua-platform", "\"Windows\"".into()),
        ("Upgrade-Insecure-Requests", "1".into()),
        (
            "User-Agent",
            format!(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROME_VERSION} Safari/537.36"
            ),
        ),
        (
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8".into(),
        ),
        ("Sec-Fetch-Site", "none".into()),
        ("Sec-Fetch-Mode", "navigate".into()),
        ("Sec-Fetch-User", "?1".into()),
        ("Sec-Fetch-Dest", "document".into()),
        ("Accept-Language", "en-US,en;q=0.9".into()),
        // Deliberately no `Connection: keep-alive` (we read to EOF and never
        // reuse a socket; the probes append `Connection: close` themselves) and
        // no `Accept-Encoding` (we decode nothing, so asking for a codec we
        // cannot read would turn a working proxy into an unparseable reply).
    ]
}

/// The fingerprint as CRLF-terminated request lines, casing intact.
pub fn chrome_header_lines() -> String {
    let mut out = String::new();
    for (name, value) in chrome_request_headers() {
        out.push_str(name);
        out.push_str(": ");
        out.push_str(&value);
        out.push_str("\r\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::grade::LEAK_HEADERS;

    #[test]
    fn preserves_chromes_own_header_casing() {
        let lines = chrome_header_lines();
        for expected in [
            "sec-ch-ua: ",
            "sec-ch-ua-mobile: ",
            "sec-ch-ua-platform: ",
            "User-Agent: ",
            "Accept: ",
            "Sec-Fetch-Site: ",
            "Sec-Fetch-Dest: ",
            "Upgrade-Insecure-Requests: ",
            "Accept-Language: ",
        ] {
            assert!(lines.contains(expected), "wrong casing, expected `{expected}`");
        }
        assert!(!lines.contains("user-agent: "));
        assert!(!lines.contains("Sec-Ch-Ua: "));
        assert_eq!(lines.matches("\r\n").count(), chrome_request_headers().len());
    }

    /// THE guard: anything we send is echoed back by the judge and the grader
    /// counts leak headers by presence alone.
    #[test]
    fn emulated_headers_are_not_leak_headers() {
        for (name, _) in chrome_request_headers() {
            let name = name.to_ascii_lowercase();
            assert!(
                !LEAK_HEADERS.contains(&name.as_str()),
                "`{name}` is a leak header; sending it ourselves would break grading"
            );
        }
        assert!(
            !chrome_header_lines().to_ascii_lowercase().contains("x-hproxy-probe"),
            "the nonce is added by the probe, not here"
        );
    }

    #[test]
    fn looks_like_chrome_and_the_brand_list_agrees_with_the_ua() {
        let lines = chrome_header_lines();
        assert!(lines.contains("Chrome/"));
        assert!(lines.contains("Windows NT"));
        assert!(lines.contains(&format!("v=\"{CHROME_MAJOR}\"")));
        assert!(lines.contains(&format!("Chrome/{CHROME_MAJOR}.")));
    }

    #[test]
    fn omits_headers_that_would_contradict_the_probe() {
        let lower = chrome_header_lines().to_ascii_lowercase();
        assert!(!lower.contains("connection:"));
        assert!(!lower.contains("accept-encoding:"));
    }
}
