//! The upstream proxy: what the relay speaks to, with the login attached.
//!
//! Parsing is the engine's one parser (`hproxy_probe::line`), so a line that
//! the checker reads is a line the relay reads, in every shape a provider
//! prints. What this module adds is the one decision a relay has to make that
//! a checker does not: HOW to speak to the upstream, HTTP or SOCKS5.

use std::fmt;

pub use hproxy_probe::line::b64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scheme {
    Http,
    Socks5,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Upstream {
    pub scheme: Scheme,
    pub host: String,
    pub port: u16,
    /// Absent for open proxies and for providers using IP authorisation.
    pub auth: Option<(String, String)>,
}

impl Upstream {
    /// `host:port`, with IPv6 kept in brackets so it can be dialled and printed.
    pub fn addr(&self) -> String {
        if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }

    /// The `Proxy-Authorization` header value, when there is a login.
    pub fn basic_header(&self) -> Option<String> {
        self.auth
            .as_ref()
            .map(|(u, p)| format!("Basic {}", b64(format!("{u}:{p}").as_bytes())))
    }
}

impl fmt::Display for Upstream {
    /// Never prints the password. This goes in the startup banner, and a banner
    /// is the thing people paste into a support chat or a screen recording.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let scheme = match self.scheme {
            Scheme::Http => "http",
            Scheme::Socks5 => "socks5",
        };
        match &self.auth {
            Some((u, _)) => write!(f, "{scheme}://{u}:********@{}", self.addr()),
            None => write!(f, "{scheme}://{} (no login)", self.addr()),
        }
    }
}

/// Accept a proxy line in any of the shapes a provider might hand out. The
/// scheme prefix decides HTTP versus SOCKS5; without one the upstream is
/// spoken to as HTTP, which is what every seller's `host:port:user:pass`
/// line means.
pub fn parse(raw: &str) -> Result<Upstream, String> {
    let line = hproxy_probe::line::parse(raw).map_err(|e| e.0)?;
    let scheme = match line.scheme {
        Some(hproxy_probe::line::Scheme::Socks5) => Scheme::Socks5,
        Some(hproxy_probe::line::Scheme::Socks4) => {
            return Err("SOCKS4 upstreams are not supported by the relay. Use an HTTP or SOCKS5 proxy.".into())
        }
        _ => Scheme::Http,
    };
    Ok(Upstream {
        scheme,
        host: line.host,
        port: line.port,
        auth: line.auth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(s: &str) -> Upstream {
        parse(s).unwrap_or_else(|e| panic!("{s} failed: {e}"))
    }

    #[test]
    fn accepts_the_colon_shape() {
        let u = up("198.51.100.7:8080:hp_ir4k2:9fa2c1");
        assert_eq!(u.host, "198.51.100.7");
        assert_eq!(u.port, 8080);
        assert_eq!(u.auth, Some(("hp_ir4k2".into(), "9fa2c1".into())));
        assert_eq!(u.scheme, Scheme::Http);
    }

    #[test]
    fn accepts_the_at_shape_and_full_urls() {
        let u = up("hp_ir4k2:9fa2c1@198.51.100.7:8080");
        assert_eq!(u.auth, Some(("hp_ir4k2".into(), "9fa2c1".into())));
        assert_eq!(up("http://hp_ir4k2:9fa2c1@198.51.100.7:8080").scheme, Scheme::Http);
        // Writing https:// for a proxy URL is a common mix-up and means HTTP.
        assert_eq!(up("https://u:p@gate.example.com:1").scheme, Scheme::Http);
    }

    #[test]
    fn socks5_schemes_select_socks_and_socks4_is_refused() {
        assert_eq!(up("socks5://u:p@gate.example.com:1080").scheme, Scheme::Socks5);
        assert_eq!(up("socks5h://u:p@gate.example.com:1080").scheme, Scheme::Socks5);
        assert!(parse("socks4://1.2.3.4:1080").unwrap_err().contains("SOCKS4"));
    }

    #[test]
    fn an_open_proxy_has_no_auth() {
        let u = up("203.0.113.42:3128");
        assert_eq!(u.auth, None);
        assert_eq!(u.basic_header(), None);
    }

    #[test]
    fn passwords_with_colons_and_at_signs_survive() {
        assert_eq!(
            up("gate.example.com:8080:user:9f:a2:c1").auth,
            Some(("user".into(), "9f:a2:c1".into()))
        );
        let u = up("user:p@ss@198.51.100.7:8080");
        assert_eq!(u.auth, Some(("user".into(), "p@ss".into())));
        assert_eq!(u.host, "198.51.100.7");
    }

    #[test]
    fn ipv6_keeps_its_brackets_when_dialled() {
        let u = up("[2001:db8::1]:8080");
        assert_eq!(u.host, "2001:db8::1");
        assert_eq!(u.addr(), "[2001:db8::1]:8080");
        assert_eq!(
            up("[2001:db8::1]:8080:user:pass").auth,
            Some(("user".into(), "pass".into()))
        );
        assert_eq!(up("user:pass@[2001:db8::1]:1080").port, 1080);
    }

    #[test]
    fn the_auth_header_is_correct_basic() {
        assert_eq!(
            up("gate.example.com:1:Aladdin:open sesame").basic_header().unwrap(),
            "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=="
        );
    }

    #[test]
    fn the_password_is_never_printed() {
        let shown = format!("{}", up("gate.example.com:1:user:hunter2"));
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("user"), "{shown}");
    }

    #[test]
    fn bad_input_explains_itself() {
        assert!(parse("").is_err());
        assert!(parse("nonsense").unwrap_err().contains("no port"));
        assert!(parse("gate.example.com:notaport").unwrap_err().contains("port number"));
    }
}
