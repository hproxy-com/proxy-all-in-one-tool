//! What a proxy line's username asks of its provider: the country, region and
//! city it targets, and whether it holds one exit (a session) and for how long.
//!
//! Residential providers take their targeting in the username, so a batch of a
//! hundred lines usually shares one host, one port range and one password, and
//! differs only there. Two shapes cover what providers print:
//!
//!   dashes       `account-country-us-state-california-session-7f3a9c21-lifetime-30`
//!                (also `-city-`, `-asn-`, `-time-<seconds>`, and keys this file
//!                does not show, such as `-type-` or `-os-`, which are skipped)
//!   underscores  `account_c_US_city_new-york_s_ab12cd_ttl_30m`
//!
//! Only what is recognised is read; everything else in the username is left
//! alone, and a username with nothing recognisable reads as nothing. A value
//! that does not look like what its key promises (a country that is not two
//! letters, a time that is not a number) is not read either: a wrong label on
//! a place is worse than none.

use serde::{Deserialize, Serialize};

/// What a username targets. Empty fields were not in it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Targeting {
    /// Two-letter country code, upper case.
    pub country: Option<String>,
    /// A state or region, as the provider spells it (`california`, `new york`).
    pub region: Option<String>,
    /// A city, as the provider spells it (`los angeles`, `new-york`).
    pub city: Option<String>,
    /// An autonomous system number, digits only.
    pub asn: Option<String>,
    /// The session the line holds: the same exit for every connection while
    /// it lasts. Absent, the provider picks a new exit as it likes.
    pub session: Option<String>,
    /// How long the session holds, in minutes, when the username says.
    pub minutes: Option<u32>,
    /// What kind of address the traffic leaves from, when the login names it
    /// (`-type-residential`): `residential`, `mobile`, `isp` or `datacenter`.
    /// The phone app says it in the place's line ("Residential · 100 sessions").
    pub kind: Option<String>,
}

impl Targeting {
    pub fn is_empty(&self) -> bool {
        *self == Targeting::default()
    }

    /// Whether the line holds one exit (a session) rather than rotating.
    pub fn sticky(&self) -> bool {
        self.session.is_some()
    }
}

/// Keys whose value this file reads, in the dash shape.
fn dash_key(key: &str) -> Option<Field> {
    Some(match key {
        "country" | "cc" => Field::Country,
        "state" | "region" => Field::Region,
        "city" => Field::City,
        "asn" => Field::Asn,
        "session" | "sessid" | "sess" | "sid" => Field::Session,
        "lifetime" => Field::Minutes,
        "time" => Field::Seconds,
        "ttl" => Field::Span,
        "type" => Field::Kind,
        _ => return None,
    })
}

/// Keys a provider puts in the dash shape whose value is not shown, consumed
/// with their value so the value is never mistaken for a key.
fn skipped_dash_key(key: &str) -> bool {
    matches!(
        key,
        "os" | "package" | "pkg" | "zip" | "isp" | "strict" | "requireudp" | "pool"
    ) || key.starts_with("not.")
}

#[derive(Clone, Copy)]
enum Field {
    Country,
    Region,
    City,
    Asn,
    Session,
    Minutes,
    Seconds,
    Span,
    Kind,
}

/// A login's `type` value as one of the four kinds, or nothing for a word
/// that names none of them.
fn kind_of(v: &str) -> Option<&'static str> {
    Some(match v.to_ascii_lowercase().as_str() {
        "residential" | "resi" | "res" => "residential",
        "mobile" | "mob" | "4g" | "5g" => "mobile",
        "isp" | "static" => "isp",
        "datacenter" | "datacentre" | "dc" => "datacenter",
        _ => return None,
    })
}

/// Read the targeting out of a proxy's username.
pub fn read(username: &str) -> Targeting {
    let mut t = Targeting::default();
    read_dashes(username, &mut t);
    read_underscores(username, &mut t);
    t
}

fn read_dashes(username: &str, t: &mut Targeting) {
    let tokens: Vec<&str> = username.split('-').collect();
    // The first token is the account itself, never a key.
    let mut i = 1;
    while i < tokens.len() {
        let key = tokens[i].to_ascii_lowercase();
        let value = tokens.get(i + 1).copied();
        match (dash_key(&key), value) {
            (Some(field), Some(v)) => {
                set(t, field, v);
                i += 2;
            }
            _ if skipped_dash_key(&key) && value.is_some() => i += 2,
            _ => i += 1,
        }
    }
}

/// `_c_US`, `_city_new-york`, `_s_ab12`, `_ttl_30m`: a marker, then a value up
/// to the next underscore.
fn read_underscores(username: &str, t: &mut Targeting) {
    for (marker, field) in [
        ("_c_", Field::Country),
        ("_city_", Field::City),
        ("_s_", Field::Session),
        ("_ttl_", Field::Span),
    ] {
        let Some(at) = username.find(marker) else { continue };
        let rest = &username[at + marker.len()..];
        let value = rest.split('_').next().unwrap_or("");
        set(t, field, value);
    }
}

/// Set a field from a value, once (the first reading wins) and only when the
/// value looks like what the field holds.
fn set(t: &mut Targeting, field: Field, raw: &str) {
    let v = raw.trim();
    if v.is_empty() || v.len() > 64 {
        return;
    }
    match field {
        Field::Country => {
            if t.country.is_none() && v.len() == 2 && v.bytes().all(|b| b.is_ascii_alphabetic()) {
                t.country = Some(v.to_ascii_uppercase());
            }
        }
        Field::Region => {
            if t.region.is_none() && is_place_name(v) {
                t.region = Some(v.to_string());
            }
        }
        Field::City => {
            if t.city.is_none() && is_place_name(v) {
                t.city = Some(v.to_string());
            }
        }
        Field::Asn => {
            let n = v.strip_prefix("AS").or_else(|| v.strip_prefix("as")).unwrap_or(v);
            if t.asn.is_none() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) {
                t.asn = Some(n.to_string());
            }
        }
        Field::Session => {
            if t.session.is_none() && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') {
                t.session = Some(v.to_string());
            }
        }
        Field::Minutes => {
            if t.minutes.is_none() {
                t.minutes = v.parse::<u32>().ok().filter(|m| *m > 0);
            }
        }
        Field::Seconds => {
            if t.minutes.is_none() {
                t.minutes = v.parse::<u32>().ok().filter(|s| *s > 0).map(|s| s.div_ceil(60));
            }
        }
        Field::Span => {
            if t.minutes.is_none() {
                t.minutes = span_minutes(v);
            }
        }
        Field::Kind => {
            if t.kind.is_none() {
                t.kind = kind_of(v).map(str::to_string);
            }
        }
    }
}

/// `30m`, `2h`, `1d`, or a bare number of minutes.
fn span_minutes(v: &str) -> Option<u32> {
    let lower = v.to_ascii_lowercase();
    let (digits, per) = match lower.chars().last()? {
        'm' => (&lower[..lower.len() - 1], 1),
        'h' => (&lower[..lower.len() - 1], 60),
        'd' => (&lower[..lower.len() - 1], 1440),
        c if c.is_ascii_digit() => (lower.as_str(), 1),
        _ => return None,
    };
    digits
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .and_then(|n| n.checked_mul(per))
}

/// Letters, digits, spaces, dots, apostrophes, dashes and underscores, with at
/// least one letter: what a region or city name looks like in a username. In
/// the dash shape a name of two words is joined with an underscore
/// (`city-los_angeles`), the dash being taken; in the underscore shape with a
/// dash (`_city_new-york`).
fn is_place_name(v: &str) -> bool {
    v.chars().any(|c| c.is_alphabetic())
        && v.chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '\'' | '-' | '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sticky_residential_line_in_the_dash_shape() {
        let t = read("hpabc123-type-residential-country-us-state-california-asn-7018-session-7f3a9c21-lifetime-30");
        assert_eq!(t.country.as_deref(), Some("US"));
        assert_eq!(t.region.as_deref(), Some("california"));
        assert_eq!(t.asn.as_deref(), Some("7018"));
        assert_eq!(t.session.as_deref(), Some("7f3a9c21"));
        assert_eq!(t.minutes, Some(30));
        assert!(t.sticky());
    }

    #[test]
    fn the_kind_of_address_is_read_from_the_type_key() {
        assert_eq!(
            read("hp-type-residential-country-us").kind.as_deref(),
            Some("residential")
        );
        assert_eq!(read("hp-type-mobile-country-gb").kind.as_deref(), Some("mobile"));
        assert_eq!(read("hp-type-ISP-country-de").kind.as_deref(), Some("isp"));
        assert_eq!(read("hp-type-dc").kind.as_deref(), Some("datacenter"));
        let t = read("hp-type-gold-country-fr");
        assert_eq!(t.kind, None, "a word that names no kind is not read");
        assert_eq!(t.country.as_deref(), Some("FR"), "and its value is still stepped over");
    }

    #[test]
    fn a_place_of_two_words_in_the_dash_shape_is_joined_with_an_underscore() {
        let t = read("acct-country-us-state-new_york-city-los_angeles-session-ab12");
        assert_eq!(t.region.as_deref(), Some("new_york"));
        assert_eq!(t.city.as_deref(), Some("los_angeles"));
        assert_eq!(t.session.as_deref(), Some("ab12"), "and what follows is still read");
    }

    #[test]
    fn a_rotating_line_has_no_session() {
        let t = read("hpabc123-type-residential-country-de");
        assert_eq!(t.country.as_deref(), Some("DE"));
        assert!(!t.sticky());
        assert_eq!(t.minutes, None);
    }

    #[test]
    fn keys_whose_value_is_not_shown_are_stepped_over_with_their_value() {
        // "residential", "windows", "off" and the excluded list must never be
        // read as keys or as values of the keys after them.
        let t = read("u-type-residential-os-windows-not.country-fr,de-strict-off-requireUdp-true-country-gb-session-ab12-lifetime-10");
        assert_eq!(t.country.as_deref(), Some("GB"));
        assert_eq!(t.session.as_deref(), Some("ab12"));
        assert_eq!(t.minutes, Some(10));
        assert_eq!(t.region, None);
    }

    #[test]
    fn a_city_with_a_space_and_a_package_name_before_it() {
        let t = read("user-package-pool2-country-us-state-california-city-los angeles");
        assert_eq!(t.city.as_deref(), Some("los angeles"));
        assert_eq!(t.region.as_deref(), Some("california"));
        assert_eq!(t.country.as_deref(), Some("US"));
    }

    #[test]
    fn a_session_time_in_seconds_reads_as_minutes() {
        let t = read("acct-country-fr-session-x9y8-time-1800");
        assert_eq!(t.minutes, Some(30));
        assert_eq!(
            read("acct-session-x9-time-90").minutes,
            Some(2),
            "rounded up, never to zero"
        );
    }

    #[test]
    fn the_underscore_shape() {
        let t = read("acct_c_US_city_new-york_sd_123_isp_456_s_sess42_ttl_1h");
        assert_eq!(t.country.as_deref(), Some("US"));
        assert_eq!(t.city.as_deref(), Some("new-york"));
        assert_eq!(t.session.as_deref(), Some("sess42"));
        assert_eq!(t.minutes, Some(60));
        assert_eq!(read("acct_c_GB_ttl_30m").minutes, Some(30));
    }

    #[test]
    fn a_plain_username_reads_as_nothing() {
        for name in ["user", "hp_74219", "john.smith", "mary-jo", "a-b-c-d", "", "x_y_z"] {
            assert!(read(name).is_empty(), "{name:?} read as {:?}", read(name));
        }
    }

    #[test]
    fn values_that_do_not_fit_their_key_are_not_read() {
        let t = read("u-country-usa-asn-telekom-lifetime-forever-session-a/b");
        assert!(t.is_empty(), "{t:?}");
        assert_eq!(read("u-country-").country, None, "a key with nothing after it");
        assert_eq!(
            read("u-lifetime-0").minutes,
            None,
            "zero minutes is not a session length"
        );
    }

    #[test]
    fn the_first_reading_wins() {
        let t = read("u-country-us-country-de");
        assert_eq!(t.country.as_deref(), Some("US"));
    }

    #[test]
    fn it_serialises_for_the_window_with_empty_fields_as_null() {
        let v = serde_json::to_value(read("u-country-us-session-ab")).unwrap();
        assert_eq!(v["country"], "US");
        assert_eq!(v["session"], "ab");
        assert!(v["city"].is_null());
    }
}
