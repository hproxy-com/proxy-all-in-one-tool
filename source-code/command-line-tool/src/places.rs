//! The places a person saved in the HProxy app, for every door that connects:
//! `hproxy places` and `hproxy connect --place`, the MCP server's
//! `proxy_places` and `proxy_connect {place}`, and the desktop app itself.
//!
//! The app keeps the library (`hproxy-places`, in its own data folder,
//! `store::app_dir`); this module only ever READS it. Two programs editing one
//! file would lose each other's changes, so a connection started here counts
//! no use and picks nothing: the app stays the one place that changes them.
//!
//! What leaves this module for a screen or a model is a view: names,
//! addresses, what a login targets, how a proxy did when last checked. A line
//! with its password goes only into the relay's source, where it is dialled,
//! and a background connection is started with the place's NAME, so no
//! password ever sits in a process list.

use hproxy_places::{store, Library, Place, ProxyView, Rule, Targeting};
use hproxy_relay::Source;
use serde_json::{json, Value};

/// The library the HProxy app keeps on this computer. Empty when the app
/// never saved anything here.
pub fn open_library() -> Result<Library, String> {
    let dir = store::app_dir().ok_or("this system names no folder for programs' data, so there are no saved places")?;
    Ok(store::load(&dir)?.unwrap_or_default())
}

/// A saved place, found by its name or id, and the words it goes by.
pub fn find(lib: &Library, wanted: &str) -> Result<(Place, String), String> {
    let place = lib.find(wanted)?;
    let name = name_of(lib, &place);
    Ok((place, name))
}

/// What a place is called on screen.
pub fn name_of(lib: &Library, place: &Place) -> String {
    match place {
        Place::Proxy { id } => lib
            .view()
            .proxies
            .into_iter()
            .find(|p| &p.id == id)
            .map_or_else(|| id.clone(), |p| p.title()),
        Place::Group { id } => lib.group(id).map_or_else(|| id.clone(), |g| g.name.clone()),
        Place::Free { country, .. } if country.is_empty() => "the fastest free proxy".into(),
        Place::Free { country, .. } => format!("a free proxy in {country}"),
    }
}

/// A group's rule as the relay's rotation, and the relay's source for a
/// saved proxy or group: the one place where a saved line becomes something to
/// dial, for every door (proxy-engine/hproxy-connection, source.rs).
pub use hproxy_connection::source::{rotation_of, source_of};

/// `source_of` for a place named by a person or a model, started on a group's
/// `member` (counted from 1) when one is given. Returns the source, the words
/// the place goes by, and a notice about lines left out.
pub fn source_named(wanted: &str, member: Option<usize>) -> Result<(Source, String, Option<String>), String> {
    let lib = open_library()?;
    let (place, name) = find(&lib, wanted)?;
    let (source, notice) = source_of(&lib, &place)?;
    if let Some(m) = member {
        if !matches!(place, Place::Group { .. }) {
            return Err(format!(
                "\"{name}\" is one proxy; only a group has members to pick from"
            ));
        }
        source.go_to_line(m.saturating_sub(1))?;
    }
    Ok((source, name, notice))
}

/// What a login targets, as words: "Los Angeles, California, US · session
/// 7f3a · 30 min". Empty when it targets nothing.
pub fn targeting_words(t: &Targeting) -> String {
    let place: Vec<String> = [&t.city, &t.region, &t.country]
        .into_iter()
        .flatten()
        .map(|p| spelled(p))
        .collect();
    let mut parts = Vec::new();
    if !place.is_empty() {
        parts.push(place.join(", "));
    }
    if let Some(s) = &t.session {
        parts.push(format!("session {s}"));
    }
    if let Some(m) = t.minutes {
        parts.push(format!("{m} min"));
    }
    parts.join(" · ")
}

/// A provider's spelling of a place, for reading: "new-york" reads "New York";
/// a two-letter country code stays as it is.
fn spelled(raw: &str) -> String {
    if raw.len() == 2 {
        return raw.to_ascii_uppercase();
    }
    raw.split(['-', '_', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| {
                    f.to_uppercase()
                        .chain(c.flat_map(char::to_lowercase))
                        .collect::<String>()
                })
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A group's rule in words, for a list a person or a model reads.
pub fn rule_words(rule: Rule, n: Option<u32>) -> String {
    let n = n.unwrap_or(10).max(1);
    match rule {
        Rule::OnFailure => "the same proxy until it stops answering".into(),
        Rule::EveryMinutes if n == 1 => "a new proxy every minute".into(),
        Rule::EveryMinutes => format!("a new proxy every {n} minutes"),
        Rule::EveryConnection => "a new proxy for every connection".into(),
        Rule::EveryN => format!("a new proxy every {n} connections"),
        Rule::Random => "a random proxy for every connection".into(),
    }
}

/// Does a saved proxy or group fit what was typed? Its name, title, address,
/// session or the places it targets, as the provider spells them and as they
/// read ("new_york" and "New York"); never its login or password.
fn matches(fields: &[String], typed: &str) -> bool {
    let q = typed.trim().to_lowercase();
    q.is_empty() || fields.iter().any(|f| f.to_lowercase().contains(&q))
}

fn targeting_fields(t: Option<&Targeting>) -> Vec<String> {
    let Some(t) = t else { return Vec::new() };
    let mut fields: Vec<String> = [&t.session, &t.city, &t.region, &t.country]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    fields.push(targeting_words(t));
    fields
}

/// The library as one JSON object a model reads: the saved proxies and the
/// groups that fit `search` (all of them without one), at most `limit` of
/// each, then how many more there were. Never a password, never a login.
pub fn listing(lib: &Library, search: &str, limit: usize) -> Value {
    let view = lib.view();
    let proxies: Vec<&ProxyView> = view
        .proxies
        .iter()
        .filter(|p| {
            let mut fields = vec![p.title(), p.address.clone()];
            fields.extend(targeting_fields(p.about.as_ref()));
            matches(&fields, search)
        })
        .collect();
    let groups: Vec<_> = view
        .groups
        .iter()
        .filter(|g| {
            let mut fields = vec![g.name.clone()];
            fields.extend(targeting_fields(Some(&g.summary.shared)));
            matches(&fields, search)
        })
        .collect();
    let proxy_rows: Vec<Value> = proxies.iter().take(limit).map(|p| proxy_row(p)).collect();
    let group_rows: Vec<Value> = groups
        .iter()
        .take(limit)
        .map(|g| {
            let mut row = json!({
                "id": g.id,
                "name": g.name,
                "proxies": g.size,
                "rule": rule_words(g.rule, g.n),
            });
            if g.summary.sessions > 0 {
                row["sessions"] = json!(g.summary.sessions);
            }
            let shared = targeting_words(&g.summary.shared);
            if !shared.is_empty() {
                row["all_target"] = json!(shared);
            }
            row
        })
        .collect();
    let mut out = json!({
        "proxies": proxy_rows,
        "groups": group_rows,
    });
    if proxies.len() > limit {
        out["more_proxies_not_listed"] = json!(proxies.len() - limit);
    }
    if groups.len() > limit {
        out["more_groups_not_listed"] = json!(groups.len() - limit);
    }
    if let Some(picked) = &view.picked {
        out["picked_in_the_app"] = json!(name_of(lib, picked));
    }
    out
}

/// How many of each kind `hproxy places` prints unless `--limit` says.
const LIST_AT_MOST: usize = 500;

/// `hproxy places [SEARCH] [--json] [--limit N]`: what is saved in the HProxy
/// app, for a person (a table) or a program (`--json`, one object per line).
pub fn command(argv: &[String]) -> crate::Outcome {
    let mut json = false;
    let mut limit = LIST_AT_MOST;
    let mut words: Vec<&str> = Vec::new();
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--json" => json = true,
            "--limit" => match it.next().and_then(|n| n.parse::<usize>().ok()).filter(|n| *n >= 1) {
                Some(n) => limit = n,
                None => return crate::Outcome::Error("--limit needs a number from 1".into()),
            },
            other if other.starts_with('-') => {
                return crate::Outcome::Error(crate::hint::unknown_option(
                    "places",
                    other,
                    crate::hint::PLACES_OPTIONS,
                ))
            }
            word => words.push(word),
        }
    }
    let lib = match open_library() {
        Ok(lib) => lib,
        Err(e) => return crate::Outcome::Error(e),
    };
    let found = listing(&lib, &words.join(" "), limit);
    let proxies = found["proxies"].as_array().cloned().unwrap_or_default();
    let groups = found["groups"].as_array().cloned().unwrap_or_default();
    if json {
        for (kind, rows) in [("proxy", &proxies), ("group", &groups)] {
            for row in rows {
                let mut row = row.clone();
                row["kind"] = json!(kind);
                println!("{row}");
            }
        }
    } else {
        print_table(&proxies, &groups);
        for (key, what) in [
            ("more_proxies_not_listed", "proxies"),
            ("more_groups_not_listed", "groups"),
        ] {
            if let Some(n) = found[key].as_u64() {
                eprintln!("and {n} more {what}: narrow it with a word, or raise --limit");
            }
        }
        if let Some(first) = proxies.first().or(groups.first()) {
            eprintln!(
                "Connect through one: hproxy connect --place \"{}\"",
                first["name"].as_str().unwrap_or_default()
            );
        }
    }
    if proxies.is_empty() && groups.is_empty() {
        if !json {
            eprintln!(
                "{}",
                if words.is_empty() {
                    "Nothing is saved in the HProxy app on this computer yet."
                } else {
                    "Nothing saved fits that."
                }
            );
        }
        return crate::Outcome::NoneWorking;
    }
    crate::Outcome::Ok
}

/// The listing for a person: one line each, names in a column.
fn print_table(proxies: &[Value], groups: &[Value]) {
    let width = proxies
        .iter()
        .chain(groups)
        .filter_map(|r| r["name"].as_str())
        .map(|n| n.chars().count())
        .max()
        .unwrap_or(0)
        .min(40);
    let cell = |s: &str| format!("{s:<width$}");
    let address_width = proxies
        .iter()
        .filter_map(|r| r["address"].as_str())
        .map(|a| a.chars().count())
        .max()
        .unwrap_or(0);
    if !proxies.is_empty() {
        println!("PROXIES");
        for p in proxies {
            let mut about: Vec<String> = Vec::new();
            if let Some(t) = p["targets"].as_str() {
                about.push(t.to_string());
            }
            match (
                p["last_check"]["working"].as_bool(),
                p["last_check"]["latency_ms"].as_u64(),
            ) {
                (Some(true), Some(ms)) => about.push(format!("working, {ms} ms")),
                (Some(true), None) => about.push("working".into()),
                (Some(false), _) => about.push("not answering last time".into()),
                (None, _) => {}
            }
            if let Some(place) = p["last_check"]["exit_place"].as_str() {
                about.push(place.to_string());
            }
            println!(
                "  {}  {:<address_width$}  {}",
                cell(p["name"].as_str().unwrap_or_default()),
                p["address"].as_str().unwrap_or_default(),
                about.join(" · ")
            );
        }
    }
    if !groups.is_empty() {
        if !proxies.is_empty() {
            println!();
        }
        println!("GROUPS");
        for g in groups {
            let size = g["proxies"].as_u64().unwrap_or(0);
            let what = if g["sessions"].as_u64() == Some(size) && size > 1 {
                "sessions"
            } else if size == 1 {
                "proxy"
            } else {
                "proxies"
            };
            let mut about = vec![format!("{size} {what}")];
            if let Some(t) = g["all_target"].as_str() {
                about.push(t.to_string());
            }
            about.push(g["rule"].as_str().unwrap_or_default().to_string());
            println!(
                "  {}  {}",
                cell(g["name"].as_str().unwrap_or_default()),
                about.join(" · ")
            );
        }
    }
}

/// One saved proxy as a model reads it.
fn proxy_row(p: &ProxyView) -> Value {
    let mut row = json!({"id": p.id, "name": p.title(), "address": p.address});
    if let Some(t) = p.about.as_ref().map(targeting_words).filter(|w| !w.is_empty()) {
        row["targets"] = json!(t);
    }
    if let Some(last) = &p.last {
        let mut checked = json!({"working": last.ok});
        if let Some(ms) = last.latency_ms {
            checked["latency_ms"] = json!(ms);
        }
        if let Some(place) = &last.place {
            checked["exit_place"] = json!(place);
        }
        row["last_check"] = checked;
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_places::GroupInput;
    use hproxy_relay::Rotation;

    const SHOP: &str = "198.51.100.7:8080:alice:hunter2";

    fn kept() -> Library {
        let mut lib = Library::default();
        lib.add_proxies(&[SHOP.to_string()], 1);
        let id = lib.proxies[0].id.clone();
        lib.rename_proxy(&id, "Shop");
        lib.add_proxies(
            &["gate.example.com:10000:acct-country-us-state-new_york-session-7f3a-lifetime-30:pw2".to_string()],
            2,
        );
        lib.save_group(
            GroupInput {
                id: None,
                name: "Mixed".into(),
                lines: vec![
                    "198.51.100.1:8080".into(),
                    "socks4://198.51.100.2:1080".into(),
                    "198.51.100.3:8080".into(),
                ],
                rule: Rule::EveryMinutes,
                n: Some(5),
            },
            3,
        )
        .unwrap();
        lib
    }

    #[test]
    fn a_saved_proxy_becomes_its_own_source_and_a_group_keeps_its_rule_and_numbers() {
        let lib = kept();
        let (place, name) = find(&lib, "shop").unwrap();
        assert_eq!(name, "Shop");
        let (src, notice) = source_of(&lib, &place).unwrap();
        assert!(notice.is_none());
        assert!(!src.in_use_now().contains("hunter2"), "{}", src.in_use_now());

        let (place, _) = find(&lib, "Mixed").unwrap();
        let (src, _) = source_of(&lib, &place).unwrap();
        assert_eq!(src.size(), Some(2), "the SOCKS4 line leaves no member");
        assert_eq!(
            src.rotation(),
            Some(Rotation::Timed(std::time::Duration::from_secs(300)))
        );
        assert!(
            src.go_to_line(2).unwrap().contains("198.51.100.3"),
            "the third line keeps its number"
        );
    }

    #[test]
    fn a_listing_never_carries_a_password_or_a_login() {
        let lib = kept();
        let all = listing(&lib, "", 100).to_string();
        for secret in ["hunter2", "pw2", "alice", "acct-"] {
            assert!(!all.contains(secret), "{secret} in {all}");
        }
        assert!(all.contains("\"Shop\"") && all.contains("Session 7f3a"), "{all}");
        assert!(all.contains("New York, US · session 7f3a · 30 min"), "{all}");
        assert!(all.contains("a new proxy every 5 minutes"), "{all}");
    }

    #[test]
    fn a_search_narrows_the_listing_and_a_limit_counts_the_rest() {
        let lib = kept();
        for typed in ["new york", "new_york", "7F3A"] {
            let found = listing(&lib, typed, 100);
            assert_eq!(found["proxies"].as_array().unwrap().len(), 1, "{typed}: {found}");
            assert_eq!(found["groups"].as_array().unwrap().len(), 0, "{typed}");
        }
        let found = listing(&lib, "", 1);
        assert_eq!(found["proxies"].as_array().unwrap().len(), 1);
        assert_eq!(found["more_proxies_not_listed"], 1);
        assert!(
            listing(&lib, "alice", 100)["proxies"].as_array().unwrap().is_empty(),
            "never by login"
        );
    }

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

    #[test]
    fn a_place_says_its_name_and_its_rule_in_words() {
        assert_eq!(spelled("new_york"), "New York");
        assert_eq!(spelled("de"), "DE");
        assert_eq!(rule_words(Rule::EveryMinutes, Some(1)), "a new proxy every minute");
        assert_eq!(rule_words(Rule::EveryN, None), "a new proxy every 10 connections");
    }
}
