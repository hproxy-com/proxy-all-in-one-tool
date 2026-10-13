//! A place becomes the relay's source: the one step every door shares.
//!
//! A saved proxy is its own line, fixed. A group is its members in the order
//! they were saved, moved through by the group's rule. The free pool is found
//! on the network, so it is built apart (`free_source`), and a door asks it in
//! its own way. A line with its password goes only into the source, where it
//! is dialled; what comes back for a screen never carries one.

use hproxy_places::{Library, Place, Rule};
use hproxy_relay::pool::Pool;
use hproxy_relay::upstream::{self, Scheme, Upstream};
use hproxy_relay::{List, Rotation, Source};

/// A source and what to say about it: the pool's description of its exit,
/// and a notice when lines of a group were left out.
pub struct Built {
    pub source: Source,
    pub exit_label: Option<String>,
    pub notice: Option<String>,
}

/// A group's rule as the relay's rotation. `n` is minutes for `EveryMinutes`
/// and connections for `EveryN`; the library never keeps less than 1.
pub fn rotation_of(rule: Rule, n: Option<u32>) -> Rotation {
    let n = n.unwrap_or(10).max(1);
    match rule {
        Rule::OnFailure => Rotation::OnFailure,
        Rule::EveryMinutes => Rotation::Timed(std::time::Duration::from_secs(u64::from(n) * 60)),
        Rule::EveryConnection => Rotation::EveryConnection,
        Rule::EveryN => Rotation::Every(n),
        Rule::Random => Rotation::Random,
    }
}

/// The relay's source for a saved proxy or group: the one place where a saved
/// line becomes something to dial, for every door. Returns it with a notice
/// when lines of a group were left out. The free pool is not built here: it
/// needs the network (`free_source`).
///
/// A group's members keep their place in the group (`List::with_lines`): a
/// line the relay cannot use (a SOCKS4 one, a damaged one) leaves no member,
/// and a number counted among the members alone would point at the wrong
/// proxy after it.
pub fn source_of(lib: &Library, place: &Place) -> Result<(Source, Option<String>), String> {
    match place {
        Place::Proxy { id } => {
            let proxy = lib.proxy(id).ok_or("that proxy is not saved here any more")?;
            let up = upstream::parse(&proxy.line)?;
            // What the app's last check proved it speaks goes first, so a bare
            // SOCKS5 line is not tried as HTTP before it connects.
            if let Some(way) = proxy.last.as_ref().and_then(|v| v.way) {
                upstream::remember(&up, way.into());
            }
            Ok((Source::Fixed(up), None))
        }
        Place::Group { id } => {
            let g = lib.group(id).ok_or("that group is not here any more")?;
            let mut members = Vec::new();
            let mut member_lines = Vec::new();
            let mut skipped = Vec::new();
            for (i, l) in g.lines.iter().enumerate() {
                let l = l.trim();
                if l.is_empty() {
                    continue;
                }
                match upstream::parse(l) {
                    Ok(u) => {
                        members.push(u);
                        member_lines.push(i);
                    }
                    // The line number and nothing else: the parser's sentence
                    // quotes the line, and a line carries a password.
                    Err(_) => skipped.push(format!("line {}", i + 1)),
                }
            }
            if members.is_empty() {
                return Err(match skipped.first() {
                    Some(first) => format!("none of the lines could be read as a proxy (the first bad one is {first})"),
                    None => "the group is empty".to_string(),
                });
            }
            let list = List::new(members, rotation_of(g.rule, g.n))?.with_lines(member_lines)?;
            let notice = (!skipped.is_empty()).then(|| {
                format!(
                    "{} of the lines could not be read as a proxy and were left out (the first is {})",
                    skipped.len(),
                    skipped[0]
                )
            });
            Ok((Source::List(list), notice))
        }
        Place::Free { .. } => Err("a free place is found in the pool, not in the library".into()),
    }
}

pub fn scheme_of(socks5: bool) -> Scheme {
    if socks5 {
        Scheme::Socks5
    } else {
        Scheme::Http
    }
}

/// A free exit's `host:port` as the relay's upstream. Pool exits are open
/// proxies, so there is never a login.
pub fn free_upstream(addr: &str, scheme: Scheme) -> Result<Upstream, String> {
    let (host, port) = addr
        .trim()
        .rsplit_once(':')
        .ok_or_else(|| format!("`{addr}` is not a host:port"))?;
    let port: u16 = port.parse().map_err(|_| format!("`{addr}` has no usable port"))?;
    // An IPv6 address comes in brackets, `[2001:db8::1]:8080`, the way
    // `Upstream::addr` prints it; the host is the address inside them.
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if host.is_empty() {
        return Err(format!("`{addr}` has no host"));
    }
    Ok(Upstream {
        scheme,
        host: host.to_string(),
        port,
        auth: None,
    })
}

/// The free pool as a source: the fastest working exit of a country ("" for
/// any), which the pool may replace when it dies; or the one exit picked from
/// its list, tested once more first and held as it is, never replaced
/// (`Source::exact_free`). Returns it with the pool's description of the exit.
pub async fn free_source(country: &str, socks5: bool, exit: Option<&str>) -> Result<(Source, String), String> {
    let scheme = scheme_of(socks5);
    let country = Some(country.trim().to_string()).filter(|c| !c.is_empty());
    let pool = Pool::new(country, scheme)?;
    match exit.map(str::trim).filter(|e| !e.is_empty()) {
        Some(addr) => Source::exact_free(&pool, free_upstream(addr, scheme)?).await,
        None => Source::from_pool(pool).await,
    }
}

/// Any place as a source: a saved one from `lib`, a free one from the pool.
/// The library is only read, and only before the pool is asked, so a lock
/// held around it is never held across the network.
pub async fn build(
    lib: impl FnOnce(&Place) -> Result<(Source, Option<String>), String>,
    place: &Place,
) -> Result<Built, String> {
    match place {
        Place::Proxy { .. } | Place::Group { .. } => {
            let (source, notice) = lib(place)?;
            Ok(Built {
                source,
                exit_label: None,
                notice,
            })
        }
        Place::Free {
            country, socks5, exit, ..
        } => {
            let (source, label) = free_source(country, *socks5, exit.as_deref()).await?;
            Ok(Built {
                source,
                exit_label: Some(label),
                notice: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_places::GroupInput;
    use hproxy_relay::SourceKind;

    #[test]
    fn a_group_rule_becomes_the_relays_rotation() {
        use std::time::Duration;
        assert_eq!(rotation_of(Rule::OnFailure, None), Rotation::OnFailure);
        assert_eq!(rotation_of(Rule::EveryConnection, None), Rotation::EveryConnection);
        assert_eq!(rotation_of(Rule::EveryN, Some(5)), Rotation::Every(5));
        assert_eq!(rotation_of(Rule::EveryN, None), Rotation::Every(10));
        assert_eq!(rotation_of(Rule::Random, None), Rotation::Random);
        assert_eq!(
            rotation_of(Rule::EveryMinutes, Some(5)),
            Rotation::Timed(Duration::from_secs(300))
        );
        assert_eq!(
            rotation_of(Rule::EveryMinutes, Some(0)),
            Rotation::Timed(Duration::from_secs(60)),
            "never zero minutes"
        );
    }

    fn kept() -> (Library, String, String) {
        let mut lib = Library::default();
        let proxy = lib
            .add_proxies(&["user:pass@198.51.100.1:3128".to_string()], 1)
            .remove(0);
        let group = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "Mixed".into(),
                    lines: vec![
                        "198.51.100.1:8080".into(),
                        "socks4://198.51.100.2:1080".into(),
                        "198.51.100.3:8080".into(),
                    ],
                    rule: Rule::OnFailure,
                    n: None,
                },
                2,
            )
            .unwrap();
        (lib, proxy, group)
    }

    #[test]
    fn a_saved_proxy_is_fixed_and_never_shows_its_password() {
        let (lib, proxy, _) = kept();
        let (source, notice) = source_of(&lib, &Place::Proxy { id: proxy }).unwrap();
        assert_eq!(source.kind(), SourceKind::Fixed);
        assert!(notice.is_none());
        assert!(!source.in_use_now().contains("pass"), "{}", source.in_use_now());
    }

    #[test]
    fn a_group_keeps_the_numbers_of_its_lines() {
        let (lib, _, group) = kept();
        let (source, _) = source_of(&lib, &Place::Group { id: group }).unwrap();
        assert_eq!(source.size(), Some(2), "the SOCKS4 line leaves no member");
        assert!(
            source.go_to_line(2).unwrap().contains("198.51.100.3"),
            "the third line keeps its number"
        );
    }

    #[test]
    fn a_place_that_is_gone_or_free_is_not_built_from_the_library() {
        let (lib, _, _) = kept();
        assert!(source_of(&lib, &Place::Proxy { id: "gone".into() }).is_err());
        assert!(source_of(&lib, &Place::Group { id: "gone".into() }).is_err());
        let free = Place::Free {
            country: "DE".into(),
            socks5: false,
            exit: None,
            exit_country: None,
        };
        assert!(source_of(&lib, &free).is_err());
    }

    #[test]
    fn a_picked_free_exit_becomes_an_open_upstream() {
        let up = free_upstream(" 203.0.113.9:1080 ", Scheme::Socks5).unwrap();
        assert_eq!(
            (up.host.as_str(), up.port, up.scheme),
            ("203.0.113.9", 1080, Scheme::Socks5)
        );
        assert!(up.auth.is_none());
        assert!(free_upstream("203.0.113.9", Scheme::Http).is_err());
        assert!(free_upstream("203.0.113.9:port", Scheme::Http).is_err());
        assert!(free_upstream(":8080", Scheme::Http).is_err());
        assert!(free_upstream("[]:8080", Scheme::Http).is_err());
        let v6 = free_upstream("[2001:db8::7]:3128", Scheme::Http).unwrap();
        assert_eq!((v6.host.as_str(), v6.port), ("2001:db8::7", 3128));
        assert_eq!(v6.addr(), "[2001:db8::7]:3128");
    }

    #[tokio::test]
    async fn build_reads_a_saved_place_from_the_library_it_is_given() {
        let (lib, proxy, _) = kept();
        let built = build(|p| source_of(&lib, p), &Place::Proxy { id: proxy })
            .await
            .unwrap();
        assert_eq!(built.source.kind(), SourceKind::Fixed);
        assert!(built.exit_label.is_none());
    }
}
