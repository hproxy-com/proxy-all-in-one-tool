//! Reminders: proxies and groups close to the day they expire, said three
//! days before and on the day itself, so a plan never ends unnoticed (a row's
//! chip says it too, but only to someone looking at the list). Every app asks
//! here what is due and shows it its own way: the computer app as the
//! computer's notifications (desktop-app/src-tauri/src/reminders.rs), the
//! phone as Android's (hproxy-mobile, the engine's `remindersDue`), so all of
//! them say it in the same words.
//!
//! One notice per batch: proxies that share a day and a note were bought
//! together (a pasted list with one date for all), and a group is a batch of
//! its own. Each is said once per stage: what was said is kept beside the
//! library ([`FILE`], [`Said`]), so a restart never says it again. A day
//! already past says nothing here; its row is red.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::library::{day_words, days_left, LibraryView};

/// How many days before its last day a batch is first announced.
pub const SOON: i64 = 3;
/// What was said, beside the library.
pub const FILE: &str = "hproxy-reminders.json";
/// How long a notice said is remembered, in days.
const KEPT_DAYS: i64 = 90;

/// One notification to show, and the key it is remembered by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub key: String,
    pub title: String,
    pub body: String,
}

/// Every notice said, by key, with the day it was said.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Said {
    #[serde(default)]
    pub said: BTreeMap<String, String>,
}

impl Said {
    /// What was said, from beside the library in `dir`: nothing when there is
    /// no such file yet, or it cannot be read.
    pub fn read(dir: &Path) -> Said {
        std::fs::read_to_string(dir.join(FILE))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// `key` was said on `today`.
    pub fn note(&mut self, key: &str, today: &str) {
        self.said.insert(key.to_string(), today.to_string());
    }

    /// Keep it beside the library, forgetting what was said three months
    /// before `today`.
    pub fn write(&mut self, dir: &Path, today: &str) {
        self.said
            .retain(|_, day| days_left(day, today).is_some_and(|d| d > -KEPT_DAYS));
        let Ok(text) = serde_json::to_string_pretty(self) else {
            return;
        };
        // Written beside, then moved into place: a crash never leaves half a file.
        let next = dir.join(format!("{FILE}.next"));
        if std::fs::write(&next, text).is_ok() {
            let _ = std::fs::rename(&next, dir.join(FILE));
        }
    }
}

/// What is due on `today` (`YYYY-MM-DD`): one notice per batch, "soon" from
/// three days before its last day and "today" on it, leaving out what was
/// said already.
pub fn due(view: &LibraryView, today: &str, said: &Said) -> Vec<Notice> {
    struct Batch {
        day: String,
        note: Option<String>,
        count: usize,
        title: String,
    }
    let mut batches: BTreeMap<String, Batch> = BTreeMap::new();
    for p in &view.proxies {
        let Some(day) = p.expires.as_deref() else {
            continue;
        };
        let note = p.note.as_deref().map(first_line).filter(|n| !n.is_empty());
        let batch = batches
            .entry(format!("p|{day}|{}", note.as_deref().unwrap_or("")))
            .or_insert_with(|| Batch {
                day: day.to_string(),
                note,
                count: 0,
                title: p.title(),
            });
        batch.count += 1;
    }
    let mut out = Vec::new();
    for (key, b) in batches {
        let Some((left, stage)) = stage_of(&b.day, today) else {
            continue;
        };
        let key = format!("{key}|{stage}");
        if said.said.contains_key(&key) {
            continue;
        }
        let body = if b.count == 1 {
            format!("{} expires {}", b.title, when(left, &b.day, today))
        } else {
            let note = b.note.map(|n| format!(" ({n})")).unwrap_or_default();
            format!("{} proxies{note} expire {}", b.count, when(left, &b.day, today))
        };
        out.push(Notice {
            key,
            title: title_of(stage),
            body,
        });
    }
    for g in &view.groups {
        let Some(day) = g.expires.as_deref() else {
            continue;
        };
        let Some((left, stage)) = stage_of(day, today) else {
            continue;
        };
        let key = format!("g|{}|{day}|{stage}", g.id);
        if said.said.contains_key(&key) {
            continue;
        }
        let size = if g.size == 1 {
            "1 proxy".to_string()
        } else {
            format!("{} proxies", g.size)
        };
        let body = format!("The group {} ({size}) expires {}", g.name, when(left, day, today));
        out.push(Notice {
            key,
            title: title_of(stage),
            body,
        });
    }
    out
}

/// How many days are left and the stage that says it: "soon" in the last
/// three days before, "today" on the day; nothing before or after.
fn stage_of(day: &str, today: &str) -> Option<(i64, &'static str)> {
    let left = days_left(day, today)?;
    match left {
        0 => Some((0, "today")),
        1..=SOON => Some((left, "soon")),
        _ => None,
    }
}

fn title_of(stage: &str) -> String {
    if stage == "today" {
        "Proxies expire today"
    } else {
        "Proxies expire soon"
    }
    .to_string()
}

/// "today", "tomorrow", or "on 14 Nov" (the year too when it is another one).
fn when(left: i64, day: &str, today: &str) -> String {
    match left {
        0 => "today".into(),
        1 => "tomorrow".into(),
        _ => format!("on {}", day_words(day, today)),
    }
}

/// A note's first line, short enough for a notification.
fn first_line(note: &str) -> String {
    let line = note.lines().next().unwrap_or("").trim();
    if line.chars().count() > 40 {
        format!("{}…", line.chars().take(39).collect::<String>().trim_end())
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Details, GroupInput, Library, Rule};

    fn library() -> Library {
        let mut lib = Library::default();
        let shop = ["198.51.100.1:8080", "198.51.100.2:8080", "198.51.100.3:8080"].map(String::from);
        let ids = lib.add_proxies(&shop, 1);
        let batch = Details {
            expires: Some("2026-11-14".into()),
            note: Some("Shop batch\nfrom October".into()),
            ..Details::default()
        };
        lib.describe_proxies(&ids, &batch).unwrap();
        let one = lib.add_proxies(&["203.0.113.9:3128".to_string()], 2);
        let single = Details {
            name: Some("Shop 3".into()),
            expires: Some("2026-11-12".into()),
            ..Details::default()
        };
        lib.describe_proxies(&one, &single).unwrap();
        lib.add_proxies(&["192.0.2.7:1080".to_string()], 3);
        let g = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "Mobile".into(),
                    lines: vec!["192.0.2.8:1080".into(), "192.0.2.9:1080".into()],
                    rule: Rule::OnFailure,
                    n: None,
                },
                4,
            )
            .unwrap();
        lib.describe_group(
            &g,
            &Details {
                expires: Some("2026-11-14".into()),
                ..Details::default()
            },
        )
        .unwrap();
        lib
    }

    fn said_on(notices: &[Notice], day: &str) -> Said {
        let mut said = Said::default();
        for n in notices {
            said.note(&n.key, day);
        }
        said
    }

    #[test]
    fn three_days_before_a_batch_says_so_once_for_all_of_it() {
        let lib = library();
        let notices = due(&lib.view(), "2026-11-11", &Said::default());
        let bodies: Vec<&str> = notices.iter().map(|n| n.body.as_str()).collect();
        assert_eq!(
            bodies,
            vec![
                "Shop 3 expires tomorrow",
                "3 proxies (Shop batch) expire on 14 Nov",
                "The group Mobile (2 proxies) expires on 14 Nov",
            ]
        );
        assert!(notices.iter().all(|n| n.title == "Proxies expire soon"));
    }

    #[test]
    fn what_was_said_is_not_said_again_and_the_day_itself_says_it_once_more() {
        let lib = library();
        let first = due(&lib.view(), "2026-11-11", &Said::default());
        let said = said_on(&first, "2026-11-11");
        assert!(
            due(&lib.view(), "2026-11-12", &said)
                .iter()
                .all(|n| n.body.contains("today")),
            "only the day itself is new"
        );
        let on_the_day = due(&lib.view(), "2026-11-14", &said);
        assert_eq!(on_the_day.len(), 2, "the batch and the group, on their last day");
        assert!(on_the_day
            .iter()
            .all(|n| n.title == "Proxies expire today" && n.body.ends_with("today")));
    }

    #[test]
    fn nothing_is_said_a_week_before_or_once_the_day_has_passed() {
        let lib = library();
        assert!(due(&lib.view(), "2026-11-04", &Said::default()).is_empty());
        assert!(due(&lib.view(), "2026-11-20", &Said::default()).is_empty());
    }

    #[test]
    fn a_long_note_is_cut_for_a_notification() {
        assert_eq!(
            first_line("A very long note about where this batch of proxies came from"),
            "A very long note about where this batch…"
        );
    }

    #[test]
    fn what_was_said_is_kept_beside_the_library_and_forgotten_after_three_months() {
        let dir = std::env::temp_dir().join(format!("hproxy-places-reminders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut said = Said::default();
        said.note("p|2026-11-14||soon", "2026-11-11");
        said.note("p|2026-01-02||today", "2026-01-02");
        said.write(&dir, "2026-11-11");
        let back = Said::read(&dir);
        assert!(back.said.contains_key("p|2026-11-14||soon"));
        assert!(
            !back.said.contains_key("p|2026-01-02||today"),
            "said more than 90 days ago"
        );
        assert!(Said::read(&dir.join("nowhere")).said.is_empty(), "no file yet");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
