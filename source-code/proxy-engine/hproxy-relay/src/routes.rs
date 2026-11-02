//! How a connection travels, beyond which proxy it uses.
//!
//! Sites: by default everything goes through the proxy. A person can name the
//! sites that skip it (a bank that refuses proxies, a work tool), or name the
//! only sites that use it and leave the rest of the computer as it is. The
//! relay decides per connection, so it works the same for a browser, a program
//! pointed at the local port and a whole phone. A site that skips the proxy
//! leaves on the person's own address: that is what they asked for, and the
//! kill switch does not hold it back.
//!
//! The first hop: a proxy in front of the proxy. The first one carries the
//! connection to the second, so the second only ever sees the first one's
//! address. A proxy that only accepts one allowed address works from anywhere
//! this way, through a server of your own that has that address.
//!
//! The login: a relay that other devices on the network use (`serve_network`)
//! asks for one. Here only this computer can reach the local port, so it needs
//! none; there, anyone on the network could.

use std::net::IpAddr;

use crate::upstream::Upstream;

/// Which sites use the proxy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// Every site.
    #[default]
    All,
    /// Every site except the ones named.
    Except,
    /// Only the ones named.
    Only,
}

impl Mode {
    /// The word a door stores it as; anything else is every site.
    pub fn of(word: &str) -> Mode {
        match word {
            "except" => Mode::Except,
            "only" => Mode::Only,
            _ => Mode::All,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Site {
    /// A name and everything under it.
    Name(String),
    /// An address, or a range of them.
    Net(IpAddr, u8),
}

/// The sites a person named, and what happens to them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Routes {
    mode: Mode,
    sites: Vec<Site>,
    /// Always through the proxy, whatever the rules say: where the connection's
    /// own test goes. If that went around the proxy, a dead proxy would pass.
    tested_at: Option<String>,
}

impl Routes {
    /// Read what a person wrote: one site a line, or separated by commas or
    /// spaces, as a name, an address, a range, or a pasted link. Words that are
    /// none of these come back in the error, so nothing is dropped silently.
    pub fn new(mode: Mode, words: &str) -> Result<Routes, String> {
        let mut sites = Vec::new();
        let mut wrong = Vec::new();
        for word in words.split(|c: char| c.is_whitespace() || c == ',' || c == ';') {
            let word = word.trim();
            if word.is_empty() {
                continue;
            }
            match site_of(word) {
                Some(site) => sites.push(site),
                None => wrong.push(word.to_string()),
            }
        }
        if !wrong.is_empty() {
            return Err(format!("not a site: {}", wrong.join(", ")));
        }
        Ok(Routes {
            mode,
            sites,
            tested_at: None,
        })
    }

    /// The same rules, with `host` always going through the proxy.
    pub fn tested_at(mut self, host: &str) -> Routes {
        self.tested_at = Some(host.to_ascii_lowercase());
        self
    }

    /// Whether a connection to `host` goes straight out, past the proxy.
    pub fn direct(&self, host: &str) -> bool {
        if self.mode == Mode::All {
            return false;
        }
        let host = host.trim_matches(|c| c == '[' || c == ']').trim_end_matches('.');
        let host = host.to_ascii_lowercase();
        if self.tested_at.as_deref() == Some(host.as_str()) {
            return false;
        }
        let named = self.sites.iter().any(|site| matches(site, &host));
        match self.mode {
            Mode::All => false,
            Mode::Except => named,
            Mode::Only => !named,
        }
    }
}

fn matches(site: &Site, host: &str) -> bool {
    match site {
        Site::Name(name) => host == name || host.strip_suffix(name.as_str()).is_some_and(|rest| rest.ends_with('.')),
        Site::Net(net, bits) => host.parse().is_ok_and(|ip| within(ip, *net, *bits)),
    }
}

fn within(ip: IpAddr, net: IpAddr, bits: u8) -> bool {
    match (ip.to_canonical(), net) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(bits)).unwrap_or(0);
            u32::from(ip) & mask == u32::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(bits)).unwrap_or(0);
            u128::from(ip) & mask == u128::from(net) & mask
        }
        _ => false,
    }
}

fn site_of(word: &str) -> Option<Site> {
    if let Ok(ip) = word.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
        let bits = if ip.is_ipv4() { 32 } else { 128 };
        return Some(Site::Net(ip, bits));
    }
    if let Some((address, bits)) = word.split_once('/') {
        if let (Ok(ip), Ok(bits)) = (address.parse::<IpAddr>(), bits.parse::<u8>()) {
            let most = if ip.is_ipv4() { 32 } else { 128 };
            return (bits <= most).then_some(Site::Net(ip, bits));
        }
    }
    // A pasted link: the name in it.
    let lower = word.to_ascii_lowercase();
    let name = lower.split_once("://").map_or(lower.as_str(), |(_, rest)| rest);
    let name = name.split(['/', '?', '#']).next().unwrap_or(name);
    let name = name.rsplit_once('@').map_or(name, |(_, host)| host);
    let name = name.split(':').next().unwrap_or(name);
    let name = name.strip_prefix("*.").unwrap_or(name).trim_matches('.');
    let fits = name.contains('.')
        && name
            .split('.')
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    fits.then(|| Site::Name(name.to_string()))
}

/// The username and password of a relay other devices use.
#[derive(Clone, PartialEq, Eq)]
pub struct Login {
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for Login {
    /// Never prints the password.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Login({})", self.username)
    }
}

/// How the connections of a relay travel.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Routing {
    pub sites: Routes,
    /// A proxy in front of the proxy.
    pub first_hop: Option<Upstream>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes(mode: Mode, words: &str) -> Routes {
        Routes::new(mode, words).unwrap()
    }

    #[test]
    fn by_default_everything_goes_through_the_proxy() {
        assert!(!Routes::default().direct("example.com"));
        assert!(!routes(Mode::All, "example.com").direct("example.com"));
    }

    #[test]
    fn a_site_named_skips_the_proxy_with_everything_under_it() {
        let r = routes(Mode::Except, "example.com");
        assert!(r.direct("example.com"));
        assert!(r.direct("www.example.com"));
        assert!(r.direct("EXAMPLE.COM."));
        assert!(!r.direct("notexample.com"), "a name is matched at a dot");
        assert!(!r.direct("example.org"));
    }

    #[test]
    fn only_the_sites_named_use_the_proxy() {
        let r = routes(Mode::Only, "example.com, shop.example.org");
        assert!(!r.direct("example.com"));
        assert!(!r.direct("a.shop.example.org"));
        assert!(r.direct("example.org"), "the rest goes straight out");
    }

    #[test]
    fn people_paste_links_and_write_wildcards() {
        let r = routes(
            Mode::Except,
            "https://www.example.com/a/b?c=1\n*.example.org:8443\nuser@example.net",
        );
        assert!(r.direct("www.example.com"));
        assert!(!r.direct("example.com"), "the link named www");
        assert!(r.direct("a.example.org"));
        assert!(r.direct("example.net"));
    }

    #[test]
    fn addresses_and_ranges_are_sites_too() {
        let r = routes(Mode::Except, "192.0.2.7 198.51.100.0/24 2001:db8::/32 [2001:db8:1::1]");
        assert!(r.direct("192.0.2.7"));
        assert!(!r.direct("192.0.2.8"));
        assert!(r.direct("198.51.100.200"));
        assert!(!r.direct("198.51.101.1"));
        assert!(r.direct("2001:db8::1"));
        assert!(r.direct("[2001:db8:1::1]"));
        assert!(r.direct("::ffff:192.0.2.7"), "the same address in its IPv6 form");
    }

    #[test]
    fn the_connections_own_test_always_goes_through_the_proxy() {
        let r = routes(Mode::Except, "hproxy.com").tested_at("hproxy.com");
        assert!(!r.direct("hproxy.com"), "or a dead proxy would pass its test");
        assert!(r.direct("www.hproxy.com"));
        let r = routes(Mode::Only, "example.com").tested_at("HProxy.com");
        assert!(!r.direct("hproxy.com"));
    }

    #[test]
    fn what_is_not_a_site_is_said() {
        assert_eq!(
            Routes::new(Mode::Except, "example.com banana 1.2.3.4/99").unwrap_err(),
            "not a site: banana, 1.2.3.4/99"
        );
        assert_eq!(Routes::new(Mode::Except, " \n ").unwrap().sites.len(), 0);
    }

    #[test]
    fn a_login_never_prints_its_password() {
        let login = Login {
            username: "hproxy".into(),
            password: "secret".into(),
        };
        assert_eq!(format!("{login:?}"), "Login(hproxy)");
    }
}
