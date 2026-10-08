//! What is released, per product: `GET https://hproxy.com/downloads/versions.json`.
//!
//! The maintainers' release tool writes this file. Every copy of the app reads it, whatever
//! installed it (the download from hproxy.com, the Microsoft Store, Google Play, an APK), to learn
//! which version its own channel has and the oldest version that is still supported. A store
//! publishes a new version only after its review, so the file names each channel's live version
//! separately: a copy is told about a version only once the place it updates from has it. The
//! file holds version numbers and words, never an address to download from: each copy updates
//! through the channel that installed it, so a changed file can at most show a wrong notice,
//! never deliver a program.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

pub const DEFAULT_VERSIONS_URL: &str = "https://hproxy.com/downloads/versions.json";

/// Release notes longer than this are cut: the notice shows a few lines, not a document.
const MAX_NOTES: usize = 4000;

/// One product's newest release.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Release {
    /// Three numbers, like `0.2.4`: the newest version shipped anywhere.
    pub version: String,
    /// The version each channel has live, by channel name: `windows`, `macos`, `linux-appimage`,
    /// `linux-deb`, `linux-rpm`, `microsoft-store`, `google-play`, `apk` (the app names its own in
    /// desktop-app/src-tauri/src/channel.rs). A channel that is missing has nothing to offer yet.
    #[serde(default)]
    pub channels: BTreeMap<String, String>,
    /// The oldest version that still works as it should. A copy below it is told to update and
    /// cannot put the notice away.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// The file: one entry per product. Products this build does not know are ignored, so the file
/// can grow without breaking older copies.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Versions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<Release>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<Release>,
}

/// What the file means for a copy that runs `current` and updates from one channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub current: String,
    /// The version the copy's channel has, when it is newer than `current`.
    pub newer: Option<String>,
    /// `current` is below the file's minimum and the channel has a newer version: the copy must
    /// update.
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

/// `major.minor.patch`, digits only. A tag, a suffix or a fourth number is not a version here.
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    fn number(part: &str) -> Option<u64> {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    }
    let mut parts = v.trim().split('.');
    let version = (number(parts.next()?)?, number(parts.next()?)?, number(parts.next()?)?);
    parts.next().is_none().then_some(version)
}

/// The notice for a copy that runs `current` and updates from `channel`, or None when `current`
/// is not a version (a development build says "dev").
pub fn verdict(current: &str, release: &Release, channel: &str) -> Option<Verdict> {
    let running = parse_version(current)?;
    let live = release.channels.get(channel).filter(|v| parse_version(v).is_some());
    let newer = live.filter(|v| parse_version(v).is_some_and(|v| v > running)).cloned();
    // An update can only be required when the channel has one to take.
    let below_minimum = release
        .minimum
        .as_deref()
        .and_then(parse_version)
        .is_some_and(|m| running < m);
    // The notes describe the newest version: they are shown only when that is what the channel has.
    let describes = newer.as_deref() == Some(release.version.as_str());
    Some(Verdict {
        current: current.trim().to_string(),
        required: below_minimum && newer.is_some(),
        newer,
        notes: release.notes.clone().filter(|_| describes),
        date: release.date.clone().filter(|_| describes),
    })
}

/// What a version check sends as its User-Agent: the program, its version and its channel, and
/// nothing else (`hproxy-checker/0.2.4 (windows)`, `hproxy/0.2.4 (cli)`). It is how the site
/// can count how many copies run each version, without any other request.
pub fn user_agent(program: &str, version: &str, channel: &str) -> String {
    format!("{program}/{version} ({channel})")
}

/// Ask the list what `channel` has for a copy of `program` running `version`: Ok(None) when the
/// list says nothing for this copy (a development build, no app entry), Err when the list could
/// not be read (offline, missing).
pub async fn check(program: &str, version: &str, channel: &str) -> Result<Option<Verdict>, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(user_agent(program, version, channel))
        .build()
        .map_err(|e| format!("could not set up the version check: {e}"))?;
    let list = fetch(&http, DEFAULT_VERSIONS_URL).await?;
    Ok(list.app.and_then(|app| verdict(version, &app, channel)))
}

/// Read the file. Each product whose entry does not read is left out rather than failing the
/// whole file.
pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<Versions, String> {
    let resp = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("could not reach the version list: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("the version list answered {status}"));
    }
    let raw: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("the version list is not JSON: {e}"))?;
    Ok(parse(&raw))
}

fn parse(raw: &serde_json::Value) -> Versions {
    let product = |key: &str| {
        let mut release: Release = serde_json::from_value(raw.get(key)?.clone()).ok()?;
        parse_version(&release.version)?;
        if release.minimum.as_deref().is_some_and(|m| parse_version(m).is_none()) {
            release.minimum = None;
        }
        release.channels.retain(|_, v| parse_version(v).is_some());
        if let Some(notes) = release.notes.as_mut() {
            if notes.chars().count() > MAX_NOTES {
                *notes = notes.chars().take(MAX_NOTES).collect();
            }
        }
        Some(release)
    };
    Versions {
        app: product("app"),
        extension: product("extension"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A release whose every channel has `version`.
    fn release(version: &str, minimum: Option<&str>) -> Release {
        let channels = ["windows", "microsoft-store", "google-play", "apk"]
            .into_iter()
            .map(|c| (c.to_string(), version.to_string()))
            .collect();
        Release {
            version: version.into(),
            channels,
            minimum: minimum.map(Into::into),
            date: None,
            notes: Some("What changed.".into()),
        }
    }

    #[test]
    fn a_version_is_three_numbers_and_nothing_else() {
        assert_eq!(parse_version("0.2.4"), Some((0, 2, 4)));
        assert_eq!(parse_version(" 10.0.12 "), Some((10, 0, 12)));
        for not_a_version in [
            "",
            "dev",
            "0.2",
            "0.2.4.0",
            "0.2.x",
            "v0.2.4",
            "0.2.4-beta",
            "+1.2.3",
            "1..3",
        ] {
            assert_eq!(parse_version(not_a_version), None, "{not_a_version}");
        }
    }

    #[test]
    fn the_check_names_the_program_its_version_and_its_channel_and_nothing_else() {
        assert_eq!(
            user_agent("hproxy-checker", "0.2.4", "linux-deb"),
            "hproxy-checker/0.2.4 (linux-deb)"
        );
        assert_eq!(user_agent("hproxy", "0.2.4", "cli"), "hproxy/0.2.4 (cli)");
    }

    #[test]
    fn numbers_compare_as_numbers_not_as_text() {
        let v = verdict("0.2.9", &release("0.2.10", None), "apk").unwrap();
        assert_eq!(v.newer.as_deref(), Some("0.2.10"));
        assert!(!v.required);
    }

    #[test]
    fn the_newest_copy_hears_nothing() {
        let v = verdict("0.2.4", &release("0.2.4", Some("0.2.0")), "apk").unwrap();
        assert_eq!(v.newer, None);
        assert!(!v.required);
        // A build newer than the file (a tester's) is not told to go back.
        assert_eq!(verdict("0.3.0", &release("0.2.4", None), "apk").unwrap().newer, None);
    }

    #[test]
    fn a_copy_hears_only_what_its_own_channel_has() {
        // Shipped everywhere, but the Microsoft Store is still certifying it.
        let mut r = release("0.2.4", None);
        r.channels.insert("microsoft-store".into(), "0.2.3".into());
        r.channels.remove("google-play");
        assert_eq!(verdict("0.2.3", &r, "windows").unwrap().newer.as_deref(), Some("0.2.4"));
        assert_eq!(verdict("0.2.3", &r, "microsoft-store").unwrap().newer, None);
        assert_eq!(
            verdict("0.2.3", &r, "google-play").unwrap().newer,
            None,
            "no entry: nothing to offer yet"
        );
        assert_eq!(verdict("0.2.3", &r, "a-channel-nobody-knows").unwrap().newer, None);
    }

    #[test]
    fn the_notes_describe_only_the_newest_version() {
        let mut r = release("0.2.5", None);
        r.channels.insert("microsoft-store".into(), "0.2.4".into());
        let store = verdict("0.2.3", &r, "microsoft-store").unwrap();
        assert_eq!(store.newer.as_deref(), Some("0.2.4"));
        assert_eq!(store.notes, None, "the notes are 0.2.5's, not 0.2.4's");
        assert_eq!(
            verdict("0.2.3", &r, "apk").unwrap().notes.as_deref(),
            Some("What changed.")
        );
    }

    #[test]
    fn below_the_minimum_the_update_is_required() {
        let v = verdict("0.1.9", &release("0.2.4", Some("0.2.0")), "google-play").unwrap();
        assert_eq!(v.newer.as_deref(), Some("0.2.4"));
        assert!(v.required);
        assert!(
            !verdict("0.2.0", &release("0.2.4", Some("0.2.0")), "google-play")
                .unwrap()
                .required
        );
    }

    #[test]
    fn nothing_is_required_that_the_channel_cannot_give() {
        let v = verdict("0.2.4", &release("0.2.4", Some("0.3.0")), "apk").unwrap();
        assert!(!v.required);
        let mut r = release("0.2.4", Some("0.2.4"));
        r.channels.insert("microsoft-store".into(), "0.2.3".into());
        assert!(
            !verdict("0.2.3", &r, "microsoft-store").unwrap().required,
            "the store does not have it yet"
        );
    }

    #[test]
    fn a_development_build_gets_no_verdict() {
        assert_eq!(verdict("dev", &release("0.2.4", None), "apk"), None);
    }

    #[test]
    fn the_file_keeps_what_reads_and_drops_the_rest() {
        let raw = json!({
            "app": {
                "version": "0.2.4", "minimum": "zero", "date": "2026-09-30T10:00:00Z", "notes": "One box.",
                "channels": { "windows": "0.2.4", "microsoft-store": "soon" }
            },
            "extension": { "version": "one" },
            "phone-app-of-the-future": { "version": "9.9.9" }
        });
        let v = parse(&raw);
        let app = v.app.unwrap();
        assert_eq!(app.version, "0.2.4");
        assert_eq!(app.minimum, None, "a minimum that is not a version is ignored");
        assert_eq!(app.notes.as_deref(), Some("One box."));
        assert_eq!(
            app.channels.len(),
            1,
            "a channel whose version is not a version is left out"
        );
        assert_eq!(v.extension, None, "a release without a real version is left out");
    }

    #[test]
    fn very_long_notes_are_cut() {
        let raw = json!({ "app": { "version": "0.2.4", "notes": "a".repeat(MAX_NOTES + 50) } });
        assert_eq!(parse(&raw).app.unwrap().notes.unwrap().chars().count(), MAX_NOTES);
    }

    #[test]
    fn a_file_of_the_wrong_shape_is_empty_not_an_error() {
        assert_eq!(parse(&json!([1, 2, 3])), Versions::default());
        assert_eq!(parse(&json!("text")), Versions::default());
    }
}
