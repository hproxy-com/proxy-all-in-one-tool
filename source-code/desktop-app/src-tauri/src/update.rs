//! Updates while nobody is using the app: tell whether it is in use, and
//! download the new version quietly in the background without disturbing anyone.
//!
//! The window owns the policy (`src/lib/updater.ts`): look for a new version at
//! start and every six hours, download it in the background, and offer
//! "Restart to update". Since the app lives in the tray, someone can keep it
//! hidden for weeks and never see that offer, so a fix would never reach them.
//! This module is the other half: when nobody is using the app, it installs the
//! update itself, silently, and the new version comes back to the tray.
//!
//! Nobody is using it when all of these hold, checked here right before the
//! install and again after the download:
//!   - the window is hidden (in the tray),
//!   - no connection is running (an install ends the relay),
//!   - no other copy of this program runs under its own name: the Windows
//!     installer ends every one before replacing the file, mid-task or not.
//!     The tool Use with AI hands an assistant is a copy under another name
//!     (`src/tool.rs`), so it does not count here and an update never ends it;
//!     an assistant pointed at this program itself (`HProxy.exe mcp`) does.
//!
//! The window adds a fourth: no check is running (it knows, `src/lib/runState.ts`).
//!
//! How it installs: `/S` makes the installer silent (no window at all), and the
//! system proxy is put back in the plugin's before-exit hook, because on
//! Windows the plugin ends this process with `std::process::exit`, which skips
//! the app's own exit path. The installer starts the new version with the same
//! arguments, so a note in the app's data folder tells it to start in the tray:
//! nobody asked for a window.
//!
//! Which version it takes at all is decided here too, for both paths: newer
//! than this one, and signed after this build was released
//! (`newer_and_signed_after_release`).

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::connect;

/// The note that makes the next start wait in the tray. The quiet install and
/// its note are desktop only: phones update through their store.
#[cfg(desktop)]
const HIDDEN_NOTE: &str = "start-hidden-after-update";
/// A note older than this is left over from an install that never happened.
#[cfg(desktop)]
const NOTE_FRESH: Duration = Duration::from_secs(10 * 60);

/// What the app knows about whether anybody is using it.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct Idle {
    window_visible: bool,
    connected: bool,
    /// Other running copies of this program; `None` when they could not be counted.
    other_copies: Option<u32>,
}

impl Idle {
    /// All three say nobody is using the app. Uncounted copies count as someone.
    #[cfg(desktop)]
    fn nobody_using(&self) -> bool {
        !self.window_visible && !self.connected && self.other_copies == Some(0)
    }
}

fn idle_now(app: &AppHandle) -> Idle {
    let window_visible = app
        .get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(true))
        .unwrap_or(false);
    Idle {
        window_visible,
        connected: connect::is_running(app),
        other_copies: other_copies(),
    }
}

/// What the window asks before it tries a quiet install.
#[tauri::command]
pub fn update_idle(app: AppHandle) -> Idle {
    idle_now(&app)
}

/// Install the newest version now, silently, if nobody is using the app.
/// False when there was nothing to do (someone is using it, or no update).
/// On Windows a successful install never returns: the installer takes over.
/// Phones update through their store, so there it never has anything to do.
#[tauri::command]
pub async fn update_install_quietly(app: AppHandle) -> Result<bool, String> {
    #[cfg(desktop)]
    return install_quietly(app).await;
    #[cfg(not(desktop))]
    {
        let _ = app;
        Ok(false)
    }
}

#[cfg(desktop)]
async fn install_quietly(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_updater::UpdaterExt;

    if !idle_now(&app).nobody_using() {
        return Ok(false);
    }
    let restore = app.clone();
    let updater = app
        .updater_builder()
        .installer_arg("/S")
        .on_before_exit(move || {
            connect::restore_on_exit(&restore);
            restore.cleanup_before_exit();
        })
        .build()
        .map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    // Verified against the public key compiled into this build before it
    // returns (the plugin's `download`).
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    // The download takes a while: look again, someone may have come back.
    if !idle_now(&app).nobody_using() {
        return Ok(false);
    }
    write_hidden_note(&app);
    log::info!(
        "installing {} quietly: the window is hidden, nothing is connected, no other copy runs",
        update.version
    );
    if let Err(e) = update.install(bytes) {
        clear_hidden_note(&app);
        return Err(e.to_string());
    }
    // Windows never gets here. macOS and Linux swapped the files in place:
    // start the new version, which finds the note and waits in the tray.
    connect::restore_on_exit(&app);
    app.restart()
}

/// When this build was released, in seconds since 1970. The maintainers'
/// release tool sets HPROXY_RELEASED_AT while it builds;
/// dev and preview builds have none.
#[cfg(desktop)]
const RELEASED_AT: Option<&str> = option_env!("HPROXY_RELEASED_AT");

/// The rule for taking a version from the update server, for the click and
/// the quiet install alike (the plugin's default comparator, set in lib.rs):
/// it is newer than this one, and every signature in the manifest was made
/// after this build was released.
///
/// The second half is what a signature alone does not give. A signature proves
/// a file is ours, not that it is new. Someone in control of the download
/// folder, or of where hproxy.com points, cannot make a file we did not sign,
/// but could announce an OLD one of ours, with its real signature, as version
/// 99, and every copy would "update" back to a build we had already replaced,
/// fixed bugs and all. Each signature records when it was made (its trusted
/// comment, `timestamp:<seconds>`), and the plugin checks that comment against
/// the public key in this build before it installs anything, so the time
/// cannot be changed without our private key.
#[cfg(desktop)]
pub fn newer_and_signed_after_release(current: semver::Version, remote: tauri_plugin_updater::RemoteRelease) -> bool {
    let take = take_version(&current, &remote, released_at());
    if !take && remote.version > current {
        log::warn!(
            "version {} on the update server is refused: it was signed before this build ({current}) was released",
            remote.version
        );
    }
    take
}

#[cfg(desktop)]
fn released_at() -> Option<u64> {
    // black_box keeps the text itself in the program (the optimizer may fold
    // the parse into a number), so the release script can find it there and
    // prove the build it publishes carries its release time.
    std::hint::black_box(RELEASED_AT).and_then(|s| s.trim().parse().ok())
}

#[cfg(desktop)]
fn take_version(
    current: &semver::Version,
    remote: &tauri_plugin_updater::RemoteRelease,
    released_at: Option<u64>,
) -> bool {
    use tauri_plugin_updater::RemoteReleaseInner;

    if remote.version <= *current {
        return false;
    }
    let Some(released_at) = released_at else {
        return true;
    };
    let signatures: Vec<&str> = match &remote.data {
        RemoteReleaseInner::Dynamic(platform) => vec![platform.signature.as_str()],
        RemoteReleaseInner::Static { platforms } => platforms.values().map(|p| p.signature.as_str()).collect(),
    };
    !signatures.is_empty() && signatures.iter().all(|s| signed_at(s).is_some_and(|t| t > released_at))
}

/// When a signature was made, read from its trusted comment. `signature` is
/// what a manifest carries: minisign's text, base64 again.
#[cfg(desktop)]
fn signed_at(signature: &str) -> Option<u64> {
    use base64::Engine;

    let text = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .ok()?;
    let signature = minisign_verify::Signature::decode(std::str::from_utf8(&text).ok()?).ok()?;
    signature
        .trusted_comment()
        .split('\t')
        .find_map(|part| part.strip_prefix("timestamp:"))?
        .parse()
        .ok()
}

/// Whether this start follows a quiet install, so the window stays in the
/// tray. Reading the note removes it: it is good for one start only.
#[cfg(desktop)]
pub fn starts_hidden_after_update(app: &AppHandle) -> bool {
    let Some(path) = note_path(app) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let _ = std::fs::remove_file(&path);
    fresh(text.trim().parse().unwrap_or(0), now_ms())
}

#[cfg(desktop)]
fn fresh(written_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(written_ms) < NOTE_FRESH.as_millis() as u64
}

#[cfg(desktop)]
fn note_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(HIDDEN_NOTE))
}

#[cfg(desktop)]
fn write_hidden_note(app: &AppHandle) {
    if let Some(path) = note_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, now_ms().to_string());
    }
}

#[cfg(desktop)]
fn clear_hidden_note(app: &AppHandle) {
    if let Some(path) = note_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(desktop)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Other running copies of this program, by file name, this process left out.
/// Windows only: elsewhere an update swaps the files under a running copy
/// without ending it, so the count does not matter there.
#[cfg(windows)]
fn other_copies() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let me = std::env::current_exe()
        .ok()?
        .file_name()?
        .to_string_lossy()
        .to_lowercase();
    let my_pid = std::process::id();
    let mut count = 0;
    // SAFETY: a process snapshot walked with the documented first/next pair,
    // on a zeroed entry whose size field is set, and closed after.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let len = entry
                .szExeFile
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
            if name == me && entry.th32ProcessID != my_pid {
                count += 1;
            }
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    Some(count)
}

#[cfg(not(windows))]
fn other_copies() -> Option<u32> {
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(desktop)]
    fn idle(window_visible: bool, connected: bool, other_copies: Option<u32>) -> Idle {
        Idle {
            window_visible,
            connected,
            other_copies,
        }
    }

    #[cfg(desktop)]
    #[test]
    fn installs_only_when_nobody_uses_the_app() {
        assert!(idle(false, false, Some(0)).nobody_using());
        assert!(!idle(true, false, Some(0)).nobody_using(), "the window is open");
        assert!(!idle(false, true, Some(0)).nobody_using(), "a connection is up");
        assert!(
            !idle(false, false, Some(1)).nobody_using(),
            "an AI assistant's tool runs"
        );
        assert!(!idle(false, false, None).nobody_using(), "copies could not be counted");
    }

    #[cfg(desktop)]
    #[test]
    fn a_note_is_good_for_ten_minutes() {
        let now = 1_000_000_000;
        assert!(fresh(now - 5_000, now));
        assert!(fresh(now, now));
        assert!(!fresh(now - 11 * 60 * 1000, now));
        assert!(!fresh(0, now), "an unreadable note");
    }

    #[cfg(windows)]
    #[test]
    fn counts_no_other_copy_of_the_test_program() {
        // The test binary runs once; nothing else carries its name.
        assert_eq!(other_copies(), Some(0));
    }

    /// A signature as a manifest carries it, made at `seconds`. Its key and
    /// signature bytes are zeros: only the trusted comment is read here, and
    /// the plugin checks the rest against the public key before installing.
    #[cfg(desktop)]
    fn signature_made_at(seconds: u64) -> String {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine;

        let first = STANDARD.encode([b"ED".as_slice(), &[0u8; 72]].concat());
        let global = STANDARD.encode([0u8; 64]);
        let text = format!(
            "untrusted comment: signature from tauri secret key\n{first}\n\
             trusted comment: timestamp:{seconds}\tfile:hproxy-checker_0.2.2_x64-setup.exe\n{global}\n"
        );
        STANDARD.encode(text)
    }

    /// A manifest for `version` with one platform per signing time.
    #[cfg(desktop)]
    fn release(version: &str, signed: &[u64]) -> tauri_plugin_updater::RemoteRelease {
        use tauri_plugin_updater::{ReleaseManifestPlatform, RemoteRelease, RemoteReleaseInner};

        let platforms = signed
            .iter()
            .enumerate()
            .map(|(i, &at)| {
                let platform = ReleaseManifestPlatform {
                    url: "https://hproxy.com/downloads/desktop/setup.exe".parse().unwrap(),
                    signature: signature_made_at(at),
                };
                (format!("platform-{i}"), platform)
            })
            .collect();
        RemoteRelease {
            version: semver::Version::parse(version).unwrap(),
            notes: None,
            pub_date: None,
            data: RemoteReleaseInner::Static { platforms },
        }
    }

    #[cfg(desktop)]
    fn v(version: &str) -> semver::Version {
        semver::Version::parse(version).unwrap()
    }

    #[cfg(desktop)]
    #[test]
    fn reads_when_a_signature_was_made() {
        use base64::Engine;

        assert_eq!(signed_at(&signature_made_at(1_790_223_541)), Some(1_790_223_541));
        assert_eq!(signed_at("not base64 at all"), None);
        let not_a_signature = base64::engine::general_purpose::STANDARD.encode("hello");
        assert_eq!(signed_at(&not_a_signature), None);
    }

    /// The signature of the first version published on hproxy.com (0.2.1,
    /// 2026-09-24), as its latest.json carries it: a real one, made by Tauri
    /// with the update key.
    #[cfg(desktop)]
    const PUBLISHED_0_2_1: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTTUxxZVdxRC9ndlJGQTFKamg0VXhMVkNKb2FFTnZCTHJ1MTRZOFBudVg3dlRwMTkyazM0VHJDODRZVVlYK212di9FUjhEbGVQNE1sSDE1RTJPbjVrWEY3Zm1UR3ZOT1FrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwMjI0ODAwCWZpbGU6aHByb3h5LWNoZWNrZXJfMC4yLjFfeDY0LXNldHVwLmV4ZQpaY0tqUXFBWERETVV1MnZZK3VYZU01ZGc1dEJiRGlab2pBcTFmK0N0VWZrcjNRSm42UUVKWjJvUlV0WTZiZ2xjYmRoZ0plNTU2VjI4NkhWajJtb2VBQT09Cg==";

    #[cfg(desktop)]
    #[test]
    fn reads_the_time_of_a_signature_tauri_made() {
        assert_eq!(signed_at(PUBLISHED_0_2_1), Some(1_790_224_800));
    }

    #[cfg(desktop)]
    #[test]
    fn a_later_build_refuses_the_first_published_one_announced_as_new() {
        use tauri_plugin_updater::{ReleaseManifestPlatform, RemoteRelease, RemoteReleaseInner};

        let replayed = RemoteRelease {
            version: v("99.0.0"),
            notes: None,
            pub_date: None,
            data: RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
                url: "https://hproxy.com/downloads/desktop/0.2.1/hproxy-checker_0.2.1_x64-setup.exe"
                    .parse()
                    .unwrap(),
                signature: PUBLISHED_0_2_1.into(),
            }),
        };
        // 0.2.2, released an hour after 0.2.1 was signed.
        assert!(!take_version(&v("0.2.2"), &replayed, Some(1_790_224_800 + 3_600)));
        // 0.2.1 itself was released before its own signature was made (210 s):
        // served as "99" it could only reinstall the very same build.
        assert!(take_version(&v("0.2.1"), &replayed, Some(1_790_224_590)));
    }

    #[cfg(desktop)]
    #[test]
    fn takes_a_newer_version_signed_after_this_release() {
        assert!(take_version(&v("0.2.1"), &release("0.2.2", &[2_000]), Some(1_000)));
        assert!(take_version(
            &v("0.2.1"),
            &release("0.3.0", &[2_000, 2_100]),
            Some(1_000)
        ));
    }

    #[cfg(desktop)]
    #[test]
    fn refuses_an_old_build_announced_as_new() {
        // A real signature of ours from before this release, under version 99.
        assert!(!take_version(&v("0.2.1"), &release("99.0.0", &[900]), Some(1_000)));
        // One old file among new ones is enough to refuse the whole manifest.
        assert!(!take_version(
            &v("0.2.1"),
            &release("0.2.2", &[2_000, 900]),
            Some(1_000)
        ));
    }

    #[cfg(desktop)]
    #[test]
    fn refuses_what_is_not_newer() {
        assert!(!take_version(&v("0.2.1"), &release("0.2.1", &[2_000]), Some(1_000)));
        assert!(!take_version(&v("0.2.1"), &release("0.2.0", &[2_000]), Some(1_000)));
    }

    #[cfg(desktop)]
    #[test]
    fn refuses_a_manifest_it_cannot_read_the_time_of() {
        use tauri_plugin_updater::{ReleaseManifestPlatform, RemoteReleaseInner};

        assert!(
            !take_version(&v("0.2.1"), &release("0.2.2", &[]), Some(1_000)),
            "no platform"
        );
        let mut broken = release("0.2.2", &[2_000]);
        broken.data = RemoteReleaseInner::Dynamic(ReleaseManifestPlatform {
            url: "https://hproxy.com/downloads/desktop/setup.exe".parse().unwrap(),
            signature: "not a signature".into(),
        });
        assert!(!take_version(&v("0.2.1"), &broken, Some(1_000)));
    }

    #[cfg(desktop)]
    #[test]
    fn a_build_without_a_release_time_only_compares_versions() {
        // Dev and preview builds: nothing to compare the signing time with.
        assert!(take_version(&v("0.2.1"), &release("0.2.2", &[1]), None));
        assert!(!take_version(&v("0.2.1"), &release("0.2.0", &[2_000]), None));
    }
}
