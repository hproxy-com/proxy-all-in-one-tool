//! The phone's places: the library (hproxy-places) in the app's own folder,
//! a paste read before it is added, and a place's line when the person asks
//! to see or copy it.
//!
//! On the phone the folder is the app's private storage, which no other app
//! can read and which never leaves the phone (no backups, PRIVACY.md); the
//! file is kept the same way as on a computer (store.rs): written beside,
//! then swapped in, the copy before it kept as a backup.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use hproxy_places::{store, GroupInput, Library, Place, Rule, Targeting};
use serde::{Deserialize, Serialize};

/// The library from `dir`. A file that cannot be read is moved aside under a
/// name of its own (never deleted) and the backup is read instead; with
/// neither, the library starts empty. Returns it with a notice for the person
/// when something was wrong.
pub fn open(dir: &Path) -> (Library, Option<String>) {
    match store::load(dir) {
        Ok(Some(lib)) => (lib, None),
        Ok(None) => (Library::default(), None),
        Err(e) => {
            log::error!("places: {e}");
            let aside = store::set_aside(dir, hproxy_connection::now_ms());
            match store::load_backup(dir) {
                Ok(Some(lib)) => {
                    let _ = store::save(dir, &lib);
                    (
                        lib,
                        Some(
                            "Your proxies could not be read, so the copy from before the last change was used.".into(),
                        ),
                    )
                }
                _ => {
                    let where_ = aside.map(|p| p.display().to_string()).unwrap_or_default();
                    log::error!("places: no backup to fall back on; the unreadable file is kept at {where_}");
                    (
                        Library::default(),
                        Some("Your proxies could not be read. The file is kept, so nothing was deleted.".into()),
                    )
                }
            }
        }
    }
}

pub fn save(dir: &Path, lib: &Library) -> Result<(), String> {
    store::save(dir, lib)
}

/// The folder the phone keeps its places in.
pub fn dir_in(data: &Path) -> PathBuf {
    data.join("places")
}

/// A paste, read before anything is added: how many lines are proxies, and
/// what they share, so the screen can say "100 sessions · California · 30 min
/// each · one login".
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// Lines that read as a proxy, once each.
    pub proxies: usize,
    /// Lines that do not.
    pub unreadable: usize,
    /// Lines given more than once.
    pub repeated: usize,
    /// How many of the proxies hold a session of their own.
    pub sessions: usize,
    /// What every proxy targets alike (its kind, country, region, city, minutes).
    pub shared: Targeting,
    /// The schemes the lines name (`http`, `socks5`); empty when none does.
    pub schemes: Vec<String>,
    /// Different gateways (host and port) among them.
    pub gateways: usize,
    /// Different logins among them.
    pub logins: usize,
    /// The first proxy's address, for a single line.
    pub first: Option<String>,
    /// Already saved on this phone.
    pub saved: usize,
}

/// Read a paste for the review.
pub fn review(lib: &Library, text: &str) -> Review {
    let mut seen = HashSet::new();
    let mut lines = Vec::new();
    let (mut unreadable, mut repeated) = (0, 0);
    for raw in text
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}'))
        .filter(|l| !l.is_empty())
    {
        if !seen.insert(raw.to_string()) {
            repeated += 1;
            continue;
        }
        match hproxy_probe::line::parse(raw) {
            Ok(p) => lines.push((raw.to_string(), p)),
            Err(_) => unreadable += 1,
        }
    }
    let texts: Vec<String> = lines.iter().map(|(l, _)| l.clone()).collect();
    let summary = hproxy_places::library::summarise(&texts);
    let mut schemes: Vec<String> = lines
        .iter()
        .filter_map(|(_, p)| p.scheme)
        .map(|s| match s {
            hproxy_probe::Scheme::Http => "http".to_string(),
            hproxy_probe::Scheme::Socks4 => "socks4".to_string(),
            hproxy_probe::Scheme::Socks5 => "socks5".to_string(),
        })
        .collect();
    schemes.sort();
    schemes.dedup();
    let gateways = lines.iter().map(|(_, p)| p.addr()).collect::<HashSet<_>>().len();
    let logins = lines
        .iter()
        .filter_map(|(_, p)| p.auth.as_ref().map(|(u, _)| u.clone()))
        .collect::<HashSet<_>>()
        .len();
    let known: HashSet<&str> = lib.proxies.iter().map(|p| p.id.as_str()).collect();
    let saved = texts
        .iter()
        .filter(|l| known.contains(hproxy_places::proxy_id(l).as_str()))
        .count();
    Review {
        proxies: lines.len(),
        unreadable,
        repeated,
        sessions: summary.sessions,
        shared: summary.shared,
        schemes,
        gateways,
        logins,
        first: lines.first().map(|(_, p)| p.addr()),
        saved,
    }
}

/// How a paste is added.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddInput {
    pub text: String,
    /// As one group (the person moves through it) or as proxies of their own.
    #[serde(default)]
    pub as_group: bool,
    #[serde(default)]
    pub name: Option<String>,
    /// A group's rule; "stay until it stops answering" when not said.
    #[serde(default)]
    pub rule: Option<Rule>,
    #[serde(default)]
    pub n: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    /// What to connect to now: the group, or the first proxy added.
    pub place: Option<Place>,
    pub count: usize,
    /// The proxies added one by one, in the order of the paste: the app names each and has
    /// them checked at once (the Proxies screen, 2026-10-11). Empty for a group.
    pub ids: Vec<String>,
}

/// Add a paste to the library.
pub fn add(lib: &mut Library, input: AddInput, now: u64) -> Result<Added, String> {
    let lines: Vec<String> = input.text.lines().map(str::to_string).collect();
    if input.as_group {
        let review = review(lib, &input.text);
        let name = input
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| group_name(&review));
        let id = lib.save_group(
            GroupInput {
                id: None,
                name,
                lines,
                rule: input.rule.unwrap_or(Rule::OnFailure),
                n: input.n,
            },
            now,
        )?;
        let count = lib.group(&id).map_or(0, |g| g.lines.len());
        Ok(Added {
            place: Some(Place::Group { id }),
            count,
            ids: Vec::new(),
        })
    } else {
        let ids = lib.add_proxies(&lines, now);
        if ids.is_empty() {
            return Err("none of the lines can be read as a proxy".into());
        }
        Ok(Added {
            place: Some(Place::Proxy { id: ids[0].clone() }),
            count: ids.len(),
            ids,
        })
    }
}

/// A group's name from what its members share: "US residential", "Germany
/// mobile", "My group".
fn group_name(r: &Review) -> String {
    let kind = r.shared.kind.as_deref().map(|k| match k {
        "isp" => "ISP".to_string(),
        k => k.to_string(),
    });
    match (r.shared.country.as_deref(), kind) {
        (Some(c), Some(k)) => format!("{c} {k}"),
        (Some(c), None) => format!("{c} proxies"),
        (None, Some(k)) => format!("{}{}", k[..1].to_uppercase(), &k[1..]),
        (None, None) => "My group".into(),
    }
}

/// A place's line, taken apart, for the Details page: shown only when the
/// person opens it there, and copied only when they ask.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Secret {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub pass: Option<String>,
    /// The scheme the line names, when it names one.
    pub scheme: Option<String>,
    pub line: String,
}

/// The line of a saved proxy, or of a group's member (`member`, from 0, the
/// first when not given).
pub fn secret(lib: &Library, place: &Place, member: Option<usize>) -> Result<Secret, String> {
    let line = match place {
        Place::Proxy { id } => lib
            .proxy(id)
            .ok_or("that proxy is not saved here any more")?
            .line
            .clone(),
        Place::Group { id } => {
            let g = lib.group(id).ok_or("that group is not here any more")?;
            g.lines
                .get(member.unwrap_or(0))
                .ok_or("that group has no such proxy")?
                .clone()
        }
        Place::Free { .. } => return Err("a free proxy has no login to show".into()),
    };
    let p = hproxy_probe::line::parse(&line).map_err(|e| e.0)?;
    Ok(Secret {
        host: p.host.clone(),
        port: p.port,
        user: p.auth.as_ref().map(|(u, _)| u.clone()),
        pass: p.auth.as_ref().map(|(_, pw)| pw.clone()),
        scheme: p.scheme.map(|s| format!("{s:?}").to_ascii_lowercase()),
        line,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSIONS: &str =
        "premium.hproxy.com:10000:hp-type-residential-country-us-state-california-session-7f3a9c21-lifetime-30:pw
premium.hproxy.com:10000:hp-type-residential-country-us-state-california-session-b21c08e4-lifetime-30:pw
premium.hproxy.com:10000:hp-type-residential-country-us-state-california-session-4d90f1aa-lifetime-30:pw
not a proxy
premium.hproxy.com:10000:hp-type-residential-country-us-state-california-session-7f3a9c21-lifetime-30:pw
";

    #[test]
    fn a_paste_of_sessions_reads_as_one_place_with_what_they_share() {
        let r = review(&Library::default(), SESSIONS);
        assert_eq!((r.proxies, r.unreadable, r.repeated), (3, 1, 1));
        assert_eq!(r.sessions, 3);
        assert_eq!(r.shared.country.as_deref(), Some("US"));
        assert_eq!(r.shared.region.as_deref(), Some("california"));
        assert_eq!(r.shared.kind.as_deref(), Some("residential"));
        assert_eq!(r.shared.minutes, Some(30));
        assert_eq!(r.gateways, 1, "one gateway");
        assert_eq!(r.logins, 3, "each session is its own login");
        assert_eq!(r.saved, 0);
    }

    #[test]
    fn added_as_a_group_it_is_named_by_what_it_shares() {
        let mut lib = Library::default();
        let added = add(
            &mut lib,
            AddInput {
                text: SESSIONS.into(),
                as_group: true,
                name: None,
                rule: None,
                n: None,
            },
            1,
        )
        .unwrap();
        assert_eq!(added.count, 3);
        let Some(Place::Group { id }) = added.place else {
            panic!("a group")
        };
        let g = lib.group(&id).unwrap();
        assert_eq!(g.name, "US residential");
        assert_eq!(g.rule, Rule::OnFailure, "it stays on one until it stops answering");
        assert_eq!(review(&lib, SESSIONS).saved, 0, "a group's lines are not saved proxies");
    }

    #[test]
    fn added_as_proxies_each_is_its_own_and_the_first_is_the_place() {
        let mut lib = Library::default();
        let added = add(
            &mut lib,
            AddInput {
                text: "198.51.100.1:8080\n198.51.100.2:8080:u:p\n".into(),
                as_group: false,
                name: None,
                rule: None,
                n: None,
            },
            1,
        )
        .unwrap();
        assert_eq!(added.count, 2);
        assert_eq!(lib.proxies.len(), 2);
        assert!(matches!(added.place, Some(Place::Proxy { .. })));
        assert_eq!(review(&lib, "198.51.100.1:8080").saved, 1);
        assert!(add(
            &mut lib,
            AddInput {
                text: "nope".into(),
                as_group: false,
                name: None,
                rule: None,
                n: None
            },
            2
        )
        .is_err());
    }

    #[test]
    fn a_secret_is_the_line_taken_apart_and_only_for_a_saved_place() {
        let mut lib = Library::default();
        let id = lib
            .add_proxies(&["socks5://alice:hunter2@198.51.100.7:1080".to_string()], 1)
            .remove(0);
        let s = secret(&lib, &Place::Proxy { id }, None).unwrap();
        assert_eq!((s.host.as_str(), s.port), ("198.51.100.7", 1080));
        assert_eq!((s.user.as_deref(), s.pass.as_deref()), (Some("alice"), Some("hunter2")));
        assert_eq!(s.scheme.as_deref(), Some("socks5"));
        let free = Place::Free {
            country: String::new(),
            socks5: false,
            exit: None,
            exit_country: None,
        };
        assert!(secret(&lib, &free, None).is_err());
    }

    #[test]
    fn an_unreadable_library_is_kept_and_the_backup_used() {
        let dir = std::env::temp_dir().join(format!("hproxy-mobile-places-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut lib = Library::default();
        lib.add_proxies(&["198.51.100.1:8080".to_string()], 1);
        save(&dir, &lib).unwrap();
        lib.add_proxies(&["198.51.100.2:8080".to_string()], 2);
        save(&dir, &lib).unwrap();
        std::fs::write(store::path_in(&dir), b"HPXP\x09broken").unwrap();
        let (opened, notice) = open(&dir);
        assert!(notice.is_some());
        assert_eq!(opened.proxies.len(), 1, "the copy from before the last change");
        let kept = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("unreadable"));
        assert!(kept, "the unreadable file is moved aside, never deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
