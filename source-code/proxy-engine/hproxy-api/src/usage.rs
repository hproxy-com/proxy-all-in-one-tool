//! Usage counts: what one copy of an HProxy app counted in a day, kept on the
//! machine and sent once a day to `https://hproxy.com/v1/app/usage`, ONLY
//! after the person said yes in that app. Shared by the computer app, the
//! phone engine and the command line, so all of them keep and send the same
//! report (the extension mirrors it in JavaScript).
//!
//! The book (`usage.json`, beside the app's own data):
//!   answer   unasked, yes or no: asked once, changed in Settings at any time
//!   copy     a random number made on yes and tied to nothing; deleted on no
//!   days     the counts of the last few days, by day
//!   sent     the days already sent
//!   last     the last report exactly as it was sent ("what is sent")
//!
//! Nothing is counted while the answer is not yes: no tally waits for a yes.
//! A report holds counts and words from fixed lists only, the lists hproxy.com's
//! server checks every report against; a word off them would only be dropped
//! there. A count stops at
//! the server's bound, so a busy day never loses its whole report.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_USAGE_URL: &str = "https://hproxy.com/v1/app/usage";

/// Why a connection failed, in the server's words; anything else is "other".
pub const FAILURES: [&str; 7] = ["timeout", "login", "refused", "dns", "tls", "blocked", "other"];
/// What a copy used, by the server's names; a name off the list is not counted.
pub const FEATURES: [&str; 17] = [
    "groups",
    "rotation",
    "new_ip",
    "free",
    "checker",
    "fraud_score",
    "leak_checks",
    "speed_test",
    "timezone",
    "system_proxy",
    "app_rules",
    "firewall",
    "expiry",
    "notes",
    "search",
    "import_file",
    "mcp",
];
/// Where a crash happened, in the server's words; anything else is "other".
pub const CRASHES: [&str; 5] = ["engine", "window", "network", "storage", "other"];

/// The most a count of one day can be: the server's bound.
const MOST: u64 = 100_000;
/// How many finished days back a report may still be sent (the server takes 7).
const DAYS_BACK: i64 = 6;

/// Asked once; changed in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    #[default]
    Unasked,
    Yes,
    No,
}

/// One day's counts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Day {
    pub opened: u64,
    pub connects_ok: u64,
    pub failed: BTreeMap<String, u64>,
    pub check_runs: u64,
    /// The longest list checked that day.
    pub check_most: u64,
    /// How many proxies and groups were kept, last seen that day.
    pub saved: u64,
    pub groups: u64,
    pub free: u64,
    pub features: BTreeSet<String>,
    pub crashes: BTreeMap<String, u64>,
}

/// Something that happened, to count. The window sends these as JSON:
/// `{"kind": "connectFailed", "reason": "timeout"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    Opened,
    ConnectOk,
    ConnectFailed { reason: String },
    CheckRun { proxies: u64 },
    Kept { proxies: u64, groups: u64 },
    FreeUsed,
    Feature { name: String },
    Crash { part: String },
}

/// Which app, on which system, which version: the report's first words.
#[derive(Debug, Clone, Copy)]
pub struct About<'a> {
    /// `desktop`, `extension`, `phone` or `cli`.
    pub app: &'a str,
    /// `os_word()`, or the extension's own.
    pub os: &'a str,
    pub version: &'a str,
}

/// The system this program was built for, in the server's words.
pub fn os_word() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    }
}

/// A size as the server takes it: never the exact length.
pub fn bucket(n: u64) -> &'static str {
    match n {
        0 => "0",
        1 => "1",
        2..=10 => "2-10",
        11..=100 => "11-100",
        101..=1000 => "101-1000",
        _ => "1001+",
    }
}

/// The book, kept beside the app's data.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Book {
    pub answer: Answer,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy: Option<String>,
    pub days: BTreeMap<String, Day>,
    pub sent: BTreeSet<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Value>,
}

impl Book {
    /// The book at `path`; a missing or unreadable one starts unasked.
    pub fn load(path: &Path) -> Book {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Keep it: written beside, then moved into place, so a crash never leaves half a file.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let next = path.with_extension("json.next");
        std::fs::write(&next, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        std::fs::rename(&next, path)
    }

    /// The person's answer. Yes makes this copy's random number (once); no
    /// forgets everything: the number, the counts, what was sent.
    pub fn set_answer(&mut self, yes: bool) {
        if yes {
            self.answer = Answer::Yes;
            if self.copy.is_none() {
                self.copy = random_copy();
            }
        } else {
            *self = Book {
                answer: Answer::No,
                ..Book::default()
            };
        }
    }

    /// Count `event` on `today` (`YYYY-MM-DD`, the device's own day). Nothing
    /// while the answer is not yes.
    pub fn count(&mut self, today: &str, event: &Event) {
        if self.answer != Answer::Yes || day_number(today).is_none() {
            return;
        }
        let day = self.days.entry(today.to_string()).or_default();
        let add = |n: &mut u64| *n = (*n + 1).min(MOST);
        match event {
            Event::Opened => add(&mut day.opened),
            Event::ConnectOk => add(&mut day.connects_ok),
            Event::ConnectFailed { reason } => add(day.failed.entry(word(reason, &FAILURES)).or_default()),
            Event::CheckRun { proxies } => {
                add(&mut day.check_runs);
                day.check_most = day.check_most.max(*proxies);
            }
            Event::Kept { proxies, groups } => {
                day.saved = *proxies;
                day.groups = (*groups).min(MOST);
            }
            Event::FreeUsed => add(&mut day.free),
            Event::Feature { name } => {
                if FEATURES.contains(&name.as_str()) {
                    day.features.insert(name.clone());
                }
            }
            Event::Crash { part } => add(day.crashes.entry(word(part, &CRASHES)).or_default()),
        }
    }

    /// The finished days not sent yet (before `today`, at most `DAYS_BACK`
    /// back), each as the report the server takes. Nothing without a yes.
    pub fn due(&self, today: &str, about: About) -> Vec<(String, Value)> {
        let (Answer::Yes, Some(copy), Some(t)) = (self.answer, self.copy.as_deref(), day_number(today)) else {
            return Vec::new();
        };
        self.days
            .iter()
            .filter(|(d, _)| !self.sent.contains(*d))
            .filter(|(d, _)| day_number(d).is_some_and(|n| n < t && n >= t - DAYS_BACK))
            .map(|(d, counts)| (d.clone(), report(copy, d, counts, about)))
            .collect()
    }

    /// `day` went out as `report`: never again, and it is what Settings shows.
    /// Days too old to send are forgotten.
    pub fn mark_sent(&mut self, day: &str, report: Value, today: &str) {
        self.sent.insert(day.to_string());
        self.last = Some(report);
        if let Some(t) = day_number(today) {
            let keep = |d: &String| day_number(d).is_some_and(|n| n >= t - DAYS_BACK - 1);
            self.days.retain(|d, _| keep(d));
            self.sent.retain(keep);
        }
    }
}

/// A report in the server's shape (hproxy-backend routes/app_usage.rs read_report).
fn report(copy: &str, day: &str, c: &Day, about: About) -> Value {
    json!({
        "copy": copy,
        "app": about.app,
        "os": about.os,
        "version": about.version,
        "day": day,
        "opened": c.opened,
        "connects": {"ok": c.connects_ok, "failed": c.failed},
        "checks": {"runs": c.check_runs, "proxies": if c.check_runs > 0 { bucket(c.check_most) } else { "0" }},
        "saved": bucket(c.saved),
        "groups": c.groups,
        "free": c.free,
        "features": c.features,
        "crashes": c.crashes,
    })
}

/// Send one report. The server answers 204 to anything; only the network can fail.
pub async fn send(client: &reqwest::Client, url: &str, report: &Value) -> Result<(), String> {
    let r = client
        .post(url)
        .timeout(Duration::from_secs(20))
        .json(report)
        .send()
        .await
        .map_err(|e| format!("the usage report did not go: {e}"))?;
    if r.status().is_success() {
        Ok(())
    } else {
        Err(format!("the usage report was answered {}", r.status()))
    }
}

/// A word from `list`, else the list's last ("other").
fn word(w: &str, list: &[&str]) -> String {
    let w = w.trim().to_ascii_lowercase();
    list.iter()
        .find(|l| **l == w)
        .unwrap_or(list.last().unwrap_or(&"other"))
        .to_string()
}

/// 16 random bytes as 32 hex digits: tied to nothing but this copy.
fn random_copy() -> Option<String> {
    let mut bytes = [0u8; 16];
    if let Err(e) = getrandom::getrandom(&mut bytes) {
        log::warn!("usage counts: no randomness for the copy's number ({e}); nothing will be sent");
        return None;
    }
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Days since 1970-01-01 of a `YYYY-MM-DD` day (H. Hinnant's days_from_civil).
fn day_number(day: &str) -> Option<i64> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = day.get(0..4)?.parse().ok()?;
    let m: i64 = day.get(5..7)?.parse().ok()?;
    let d: i64 = day.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ABOUT: About = About {
        app: "desktop",
        os: "windows",
        version: "0.3.9",
    };

    fn yes() -> Book {
        let mut b = Book::default();
        b.set_answer(true);
        b
    }

    #[test]
    fn nothing_is_counted_or_sent_without_a_yes() {
        for answer in [None, Some(false)] {
            let mut b = Book::default();
            if let Some(a) = answer {
                b.set_answer(a);
            }
            b.count("2026-10-14", &Event::Opened);
            assert!(b.days.is_empty(), "{answer:?}");
            assert!(b.due("2026-10-15", ABOUT).is_empty());
            assert!(b.copy.is_none());
        }
    }

    #[test]
    fn a_yes_makes_one_number_and_a_no_forgets_everything() {
        let mut b = yes();
        let copy = b.copy.clone().unwrap();
        assert_eq!(copy.len(), 32);
        assert!(copy.bytes().all(|c| c.is_ascii_hexdigit()));
        b.set_answer(true);
        assert_eq!(b.copy.as_deref(), Some(copy.as_str()), "a second yes keeps the number");
        b.count("2026-10-14", &Event::Opened);
        b.set_answer(false);
        assert_eq!(
            b,
            Book {
                answer: Answer::No,
                ..Book::default()
            }
        );
        b.set_answer(true);
        assert_ne!(b.copy.as_deref(), Some(copy.as_str()), "a later yes makes a new one");
    }

    #[test]
    fn a_day_becomes_the_report_the_server_takes() {
        let mut b = yes();
        let day = "2026-10-14";
        for e in [
            Event::Opened,
            Event::Opened,
            Event::ConnectOk,
            Event::ConnectFailed {
                reason: "timeout".into(),
            },
            Event::ConnectFailed {
                reason: "Something New".into(),
            },
            Event::CheckRun { proxies: 300 },
            Event::CheckRun { proxies: 12 },
            Event::Kept {
                proxies: 301,
                groups: 2,
            },
            Event::FreeUsed,
            Event::Feature { name: "expiry".into() },
            Event::Feature { name: "expiry".into() },
            Event::Feature { name: "made-up".into() },
            Event::Crash { part: "engine".into() },
        ] {
            b.count(day, &e);
        }
        let due = b.due("2026-10-15", ABOUT);
        assert_eq!(due.len(), 1);
        let (d, r) = &due[0];
        assert_eq!(d, day);
        assert_eq!(
            r,
            &json!({
                "copy": b.copy.clone().unwrap(),
                "app": "desktop", "os": "windows", "version": "0.3.9", "day": day,
                "opened": 2,
                "connects": {"ok": 1, "failed": {"other": 1, "timeout": 1}},
                "checks": {"runs": 2, "proxies": "101-1000"},
                "saved": "101-1000", "groups": 2, "free": 1,
                "features": ["expiry"],
                "crashes": {"engine": 1},
            })
        );
    }

    #[test]
    fn only_finished_days_not_yet_sent_go_and_a_week_at_most() {
        let mut b = yes();
        for day in ["2026-10-01", "2026-10-09", "2026-10-13", "2026-10-14", "2026-10-15"] {
            b.count(day, &Event::Opened);
        }
        let days: Vec<String> = b.due("2026-10-15", ABOUT).into_iter().map(|(d, _)| d).collect();
        assert_eq!(
            days,
            ["2026-10-09", "2026-10-13", "2026-10-14"],
            "not today, not two weeks back"
        );
        let (d, r) = b.due("2026-10-15", ABOUT).remove(0);
        b.mark_sent(&d, r.clone(), "2026-10-15");
        assert_eq!(b.last.as_ref(), Some(&r), "what Settings shows");
        assert!(!b.days.contains_key("2026-10-01"), "too old to send: forgotten");
        let days: Vec<String> = b.due("2026-10-15", ABOUT).into_iter().map(|(d, _)| d).collect();
        assert_eq!(days, ["2026-10-13", "2026-10-14"]);
    }

    #[test]
    fn a_busy_day_stops_at_the_servers_bound_and_sizes_go_in_buckets() {
        let mut b = yes();
        b.days.insert(
            "2026-10-14".into(),
            Day {
                opened: MOST,
                ..Day::default()
            },
        );
        b.count("2026-10-14", &Event::Opened);
        assert_eq!(b.days["2026-10-14"].opened, MOST);
        assert_eq!(
            [0, 1, 2, 10, 11, 100, 101, 1000, 1001].map(bucket),
            ["0", "1", "2-10", "2-10", "11-100", "11-100", "101-1000", "101-1000", "1001+"]
        );
    }

    #[test]
    fn the_book_is_kept_and_an_unreadable_one_starts_unasked() {
        let dir = std::env::temp_dir().join(format!("hproxy-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("usage.json");
        let mut b = yes();
        b.count("2026-10-14", &Event::Opened);
        b.save(&path).unwrap();
        assert_eq!(Book::load(&path), b);
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(Book::load(&path).answer, Answer::Unasked);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn days_count_on_the_calendar() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-10-15").unwrap() - day_number("2026-10-08").unwrap(), 7);
        assert_eq!(day_number("2028-03-01").unwrap() - day_number("2028-02-28").unwrap(), 2);
        assert_eq!(day_number("15.10.2026"), None);
    }
}
