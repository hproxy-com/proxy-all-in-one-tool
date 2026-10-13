//! Can a connection carry everyday traffic through this proxy?
//!
//! A check answers "did anything relay our request?". Connecting needs more.
//! Nearly all traffic is HTTPS, which travels in a tunnel (HTTP CONNECT or
//! SOCKS5), and on a phone every app's connection is a tunnel, so a proxy that
//! only fetches plain http:// pages carries almost nothing. A proxy that
//! re-signs HTTPS can read passwords, and one that hands sites this machine's
//! own address hides nothing.
//!
//! This is the one reading of a check for every door that connects: the app's
//! Connect and its saved proxies, the phone, the command line and the AI tool.
//! The checker's table keeps reporting what answered; this says what that
//! means for a person about to connect.

use serde::{Deserialize, Serialize};

use crate::grade;
use crate::line::Scheme;
use crate::result::CheckResult;

/// Above this a working proxy is called slow. Pages still load, but every
/// request waits this long before its first byte.
pub const SLOW_MS: i32 = 1500;

/// How the answer should look on a screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tone {
    /// Connect and forget about it.
    Good,
    /// It carries traffic, with something worth knowing.
    Warn,
    /// It will not carry everyday traffic, or it should not be trusted with it.
    Bad,
}

/// How to speak to the proxy for a tunnel, as the check proved it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Way {
    /// HTTP CONNECT.
    Http,
    Socks5,
}

/// One finding, as a stable word for filters and code. `says` and `why` are
/// the words for people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Note {
    /// Nothing relayed the check.
    NotAnswering,
    /// Only plain http:// works: no tunnel, so no HTTPS and no phone apps.
    PlainHttpOnly,
    /// Only SOCKS4 answered, which the relay does not speak.
    Socks4Only,
    /// HTTPS came back with a certificate that is not the site's own.
    ReadsHttps,
    /// The far end saw this machine's own address: nothing is hidden.
    NotHidden,
    /// Plain http:// requests carry this machine's address in a header.
    TellsHttpSites,
    Slow {
        ms: i32,
    },
    /// The login asks for one country and traffic leaves from another.
    WrongCountry {
        asked: String,
        exits: String,
    },
}

/// What a check means for connecting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usable {
    /// A connection through it carries tunnels: https sites and apps.
    pub carries: bool,
    pub tone: Tone,
    /// How to speak to it. `None` when it carries nothing a tunnel needs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub way: Option<Way>,
    /// A few words for a row: "Working · 180 ms", "Can't open https sites".
    pub says: String,
    /// One plain sentence when it is not simply working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<Note>,
}

impl Usable {
    /// Add what the line's login asked for: HProxy-style logins name a
    /// country (`-country-us`), and an exit elsewhere is worth saying. Call
    /// once the exit's country is known (the engine has no location source,
    /// the door that located the exit does).
    pub fn with_asked_country(mut self, asked: Option<&str>, exits: Option<&str>) -> Self {
        let (Some(asked), Some(exits)) = (
            asked.map(str::trim).filter(|c| !c.is_empty()),
            exits.map(str::trim).filter(|c| !c.is_empty()),
        ) else {
            return self;
        };
        if !self.carries || asked.eq_ignore_ascii_case(exits) {
            return self;
        }
        let (asked, exits) = (asked.to_ascii_uppercase(), exits.to_ascii_uppercase());
        // Only a working row is reworded. A row already warning about
        // something heavier keeps its words, and the note rides along.
        if self.tone == Tone::Good {
            self.tone = Tone::Warn;
            self.says = format!("Exits in {exits}");
            self.why = Some(format!("The login asks for {asked}, but traffic leaves from {exits}."));
        }
        self.notes.push(Note::WrongCountry { asked, exits });
        self
    }
}

/// Read one check for a connector. `prefix` is the scheme the line was written
/// with, if any, which picks the way when the proxy speaks both. `own_ip` is
/// this machine's public address when it is known.
pub fn usable(r: &CheckResult, prefix: Option<Scheme>, own_ip: Option<&str>) -> Usable {
    if !r.alive {
        return Usable {
            carries: false,
            tone: Tone::Bad,
            way: None,
            says: "Not answering".into(),
            why: r.error.clone(),
            notes: vec![Note::NotAnswering],
        };
    }

    let answered = |p: &str| r.protocols.iter().any(|x| x == p);
    let (connect, socks5) = (answered("https"), answered("socks5"));
    let way = match (connect, socks5) {
        (true, true) if prefix == Some(Scheme::Socks5) => Some(Way::Socks5),
        (true, _) => Some(Way::Http),
        (false, true) => Some(Way::Socks5),
        (false, false) => None,
    };

    let Some(way) = way else {
        let (says, why, note) = if answered("socks4") && !answered("http") {
            (
                "SOCKS4 only",
                "It only speaks SOCKS4, which Connect does not use. HTTP and SOCKS5 proxies work.",
                Note::Socks4Only,
            )
        } else {
            (
                "Can't open https sites",
                "It only fetches plain http:// pages. Https sites and phone apps need a tunnel, and it won't open one.",
                Note::PlainHttpOnly,
            )
        };
        return Usable {
            carries: false,
            tone: Tone::Bad,
            way: None,
            says: says.into(),
            why: Some(why.into()),
            notes: vec![note],
        };
    };

    let mut notes = Vec::new();
    let own = own_ip.map(str::trim).filter(|o| !o.is_empty());
    let exit_is_ours = matches!((r.exit_ip.as_deref(), own), (Some(exit), Some(own)) if exit == own);
    if r.tls_intercepted == Some(true) {
        notes.push(Note::ReadsHttps);
    }
    if exit_is_ours {
        notes.push(Note::NotHidden);
    } else if r.anonymity.as_deref() == Some(grade::TRANSPARENT) {
        notes.push(Note::TellsHttpSites);
    }
    if let Some(ms) = r.latency_ms.filter(|ms| *ms > SLOW_MS) {
        notes.push(Note::Slow { ms });
    }

    // The heaviest finding gives the row its words. The rest stay in `notes`.
    let (tone, says, why) = if notes.contains(&Note::ReadsHttps) {
        (
            Tone::Bad,
            "Reads your HTTPS".to_string(),
            Some("It swaps in its own certificates, so it can see passwords and everything else you send. Don't log in to anything through it.".to_string()),
        )
    } else if notes.contains(&Note::NotHidden) {
        (
            Tone::Bad,
            "Doesn't hide you".to_string(),
            Some("Sites still see your own address through it.".to_string()),
        )
    } else if notes.contains(&Note::TellsHttpSites) {
        (
            Tone::Warn,
            "Shows your IP to http sites".to_string(),
            Some("It adds your real address to plain http:// requests. Https sites can't see it.".to_string()),
        )
    } else if let Some(ms) = r.latency_ms.filter(|ms| *ms > SLOW_MS) {
        (
            Tone::Warn,
            format!("Slow · {ms} ms"),
            Some("It works, but every request waits this long before it starts.".to_string()),
        )
    } else {
        let says = match r.latency_ms {
            Some(ms) => format!("Working · {ms} ms"),
            None => "Working".to_string(),
        };
        (Tone::Good, says, None)
    };

    Usable {
        carries: true,
        tone,
        way: Some(way),
        says,
        why,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alive(protocols: &[&str], ms: i32) -> CheckResult {
        CheckResult {
            alive: true,
            protocols: protocols.iter().map(|p| p.to_string()).collect(),
            latency_ms: Some(ms),
            exit_ip: Some("198.51.100.20".into()),
            anonymity: Some(grade::ELITE.into()),
            ..Default::default()
        }
    }

    #[test]
    fn a_tunnel_that_answered_is_working_and_says_how_to_speak_to_it() {
        let u = usable(&alive(&["http", "https"], 180), None, Some("203.0.113.1"));
        assert!(u.carries);
        assert_eq!(u.tone, Tone::Good);
        assert_eq!(u.way, Some(Way::Http));
        assert_eq!(u.says, "Working · 180 ms");
        assert!(u.why.is_none() && u.notes.is_empty());
    }

    /// The case that read "Working" and carried nothing: a SOCKS5 proxy pasted
    /// without a prefix. The answer now says to speak SOCKS5 to it.
    #[test]
    fn a_bare_socks5_proxy_is_spoken_to_in_socks5() {
        let u = usable(&alive(&["socks5"], 240), None, None);
        assert!(u.carries);
        assert_eq!(u.way, Some(Way::Socks5));
    }

    #[test]
    fn a_proxy_that_speaks_both_follows_the_lines_prefix() {
        let both = alive(&["https", "socks5"], 90);
        assert_eq!(usable(&both, None, None).way, Some(Way::Http));
        assert_eq!(usable(&both, Some(Scheme::Http), None).way, Some(Way::Http));
        assert_eq!(usable(&both, Some(Scheme::Socks5), None).way, Some(Way::Socks5));
    }

    /// The other case that read "Working": plain HTTP answered, nothing that
    /// can carry a tunnel did.
    #[test]
    fn plain_http_alone_cannot_open_https_sites() {
        let u = usable(&alive(&["http"], 120), None, None);
        assert!(!u.carries);
        assert_eq!(u.tone, Tone::Bad);
        assert_eq!(u.way, None);
        assert_eq!(u.says, "Can't open https sites");
        assert_eq!(u.notes, vec![Note::PlainHttpOnly]);
    }

    #[test]
    fn socks4_alone_is_named_as_such() {
        let u = usable(&alive(&["socks4"], 120), None, None);
        assert!(!u.carries);
        assert_eq!(u.notes, vec![Note::Socks4Only]);
    }

    #[test]
    fn a_proxy_that_re_signs_https_is_red_whatever_else_it_does() {
        let mut r = alive(&["https", "socks5"], 80);
        r.tls_intercepted = Some(true);
        let u = usable(&r, None, None);
        assert!(u.carries, "it does carry traffic: the danger is what it can read");
        assert_eq!(u.tone, Tone::Bad);
        assert_eq!(u.says, "Reads your HTTPS");
        assert!(u.notes.contains(&Note::ReadsHttps));
    }

    #[test]
    fn our_own_address_at_the_far_end_means_nothing_is_hidden() {
        let mut r = alive(&["https"], 80);
        r.exit_ip = Some("203.0.113.1".into());
        r.anonymity = Some(grade::TRANSPARENT.into());
        let u = usable(&r, None, Some("203.0.113.1"));
        assert_eq!(u.tone, Tone::Bad);
        assert_eq!(u.says, "Doesn't hide you");
        assert_eq!(u.notes, vec![Note::NotHidden]);
    }

    #[test]
    fn a_header_leak_only_touches_plain_http_sites() {
        let mut r = alive(&["http", "https"], 80);
        r.anonymity = Some(grade::TRANSPARENT.into());
        let u = usable(&r, None, Some("203.0.113.1"));
        assert!(u.carries);
        assert_eq!(u.tone, Tone::Warn);
        assert_eq!(u.notes, vec![Note::TellsHttpSites]);
    }

    #[test]
    fn slow_is_a_warning_with_the_number() {
        let u = usable(&alive(&["https"], 2300), None, None);
        assert_eq!(u.tone, Tone::Warn);
        assert_eq!(u.says, "Slow · 2300 ms");
        assert_eq!(u.notes, vec![Note::Slow { ms: 2300 }]);
        assert_eq!(usable(&alive(&["https"], SLOW_MS), None, None).tone, Tone::Good);
    }

    #[test]
    fn a_dead_proxy_keeps_the_engines_reason() {
        let r = CheckResult {
            alive: false,
            error: Some("connection refused in 38 ms: nothing is listening on that port".into()),
            ..Default::default()
        };
        let u = usable(&r, None, None);
        assert!(!u.carries);
        assert_eq!(u.says, "Not answering");
        assert_eq!(u.why.as_deref(), r.error.as_deref());
    }

    #[test]
    fn an_exit_outside_the_asked_country_is_said() {
        let u = usable(&alive(&["https"], 150), None, None).with_asked_country(Some("us"), Some("DE"));
        assert_eq!(u.tone, Tone::Warn);
        assert_eq!(u.says, "Exits in DE");
        assert_eq!(
            u.notes,
            vec![Note::WrongCountry {
                asked: "US".into(),
                exits: "DE".into()
            }]
        );
        let same = usable(&alive(&["https"], 150), None, None).with_asked_country(Some("de"), Some("DE"));
        assert_eq!(same.tone, Tone::Good);
        let unknown = usable(&alive(&["https"], 150), None, None).with_asked_country(Some("us"), None);
        assert_eq!(unknown.tone, Tone::Good);
    }

    #[test]
    fn a_heavier_warning_keeps_its_words_when_the_country_is_off_too() {
        let mut r = alive(&["https"], 150);
        r.tls_intercepted = Some(true);
        let u = usable(&r, None, None).with_asked_country(Some("us"), Some("de"));
        assert_eq!(u.says, "Reads your HTTPS");
        assert!(u.notes.contains(&Note::WrongCountry {
            asked: "US".into(),
            exits: "DE".into()
        }));
    }

    #[test]
    fn the_answer_serialises_with_stable_words() {
        let u = usable(&alive(&["http"], 120), None, None);
        let json = serde_json::to_string(&u).unwrap();
        assert!(json.contains(r#""tone":"bad""#), "{json}");
        assert!(json.contains(r#""kind":"plain_http_only""#), "{json}");
        assert!(!json.contains("\"way\""), "{json}");
    }
}
