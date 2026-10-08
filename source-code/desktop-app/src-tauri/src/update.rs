//! Updates: which version to take, where to look for it, and when to install it.
//!
//! Three moments, the same rules:
//!   - At start (`update_at_start`): a copy that updates itself (src/channel.rs) looks for a
//!     newer version before its screens open, and when there is one it downloads and installs
//!     that first, then the new version opens: what an app from Google Play does. The window
//!     shows the progress (src/components/StartGate.tsx). It never locks anyone out: no answer
//!     within a few seconds, no internet, a download that stalls or fails, and the app simply
//!     opens and tries again at the next start. It never loops either: when a version did not
//!     arrive after its install, the next start does not try it again at once (`ATTEMPT_NOTE`).
//!     Only a released build does this (it carries HPROXY_RELEASED_AT): a developer's build is
//!     never replaced by the published one.
//!   - While it runs (src/lib/updater.ts): a look every six hours, the download in the
//!     background, "Restart to update" in the title bar (`update_check`, `update_download`,
//!     `update_install`).
//!   - While nobody uses it (`update_install_quietly`): the app lives in the tray, so someone can
//!     keep it hidden for weeks and never see that offer. The downloaded version installs itself
//!     silently, and the new version comes back to the tray.
//!
//! Nobody is using it when all of these hold, checked right before the install and again after
//! the download:
//!   - the window is hidden (in the tray),
//!   - no connection is running (an install ends the relay),
//!   - no other copy of this program runs under its own name: the Windows installer ends every
//!     one before replacing the file, mid-task or not. The tool Use with AI hands an assistant
//!     is a copy under another name (`src/tool.rs`), so it does not count here and an update
//!     never ends it; an assistant pointed at this program itself (`HProxy.exe mcp`) does.
//!
//! The window adds a fourth: no check is running (it knows, `src/lib/runState.ts`). At start the
//! window just opened and nothing runs yet, so only the other copies and a connection can hold an
//! install back; then the version waits for the title bar's offer.
//!
//! How it installs: while the window is on screen the installer shows its own small progress
//! window (`installMode: passive` in tauri.conf.json); in the tray `/S` makes it silent, and a
//! note in the app's data folder tells the new version to start in the tray: nobody asked for a
//! window. The system proxy is put back in the plugin's before-exit hook, because on Windows the
//! plugin ends this process with `std::process::exit`, which skips the app's own exit path.
//!
//! Which version it takes is decided here, for every path: newer than this one, and signed after
//! this build was released (`newer_and_signed_after_release`). Where it looks: hproxy.com's
//! update list, or, on the maintainers' own computer, the test ring's list, which gets every
//! release before everyone else (`in_test_ring`).

#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[cfg(desktop)]
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::connect;

/// The update list every copy reads (tauri.conf.json names it too; a test keeps the two equal).
#[cfg(desktop)]
pub const STABLE_LIST: &str = "https://hproxy.com/downloads/desktop/latest.json";
/// The test ring's list. The release tool puts each release here first, and on the stable list
/// once the maintainer said it works (`release.mjs ship app`, then `--promote`).
#[cfg(desktop)]
pub const TEST_LIST: &str = "https://hproxy.com/downloads/desktop/latest-test.json";
/// The file that puts a copy in the test ring: in its app data folder, the one word "test".
/// The release tool writes it on the maintainers' computer (`release.mjs ring join`).
#[cfg(desktop)]
const RING_NOTE: &str = "update-ring";

/// The note that makes the next start wait in the tray. The quiet install and
/// its note are desktop only: phones update through their store.
#[cfg(desktop)]
const HIDDEN_NOTE: &str = "start-hidden-after-update";
/// A note older than this is left over from an install that never happened.
#[cfg(desktop)]
const NOTE_FRESH: Duration = Duration::from_secs(10 * 60);
/// The version installed last and when: a start that finds this version still missing within
/// `NOTE_FRESH` opens without trying again, so a failing installer can never loop.
#[cfg(desktop)]
const ATTEMPT_NOTE: &str = "update-attempt";

/// How long the start waits for the update list before it opens without it.
#[cfg(desktop)]
const START_CHECK: Duration = Duration::from_secs(4);
/// Any later look: long enough for a slow line, short enough never to hang.
#[cfg(desktop)]
const CHECK: Duration = Duration::from_secs(30);
/// A download that receives nothing for this long is given up (tried again later).
#[cfg(desktop)]
const STALL: Duration = Duration::from_secs(20);

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

fn window_visible(app: &AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(true))
        .unwrap_or(false)
}

fn idle_now(app: &AppHandle) -> Idle {
    Idle {
        window_visible: window_visible(app),
        connected: connect::is_running(app),
        other_copies: other_copies(),
    }
}

/// What the window asks before it tries a quiet install.
#[tauri::command]
pub fn update_idle(app: AppHandle) -> Idle {
    idle_now(&app)
}

/// A version the window may offer: what the start screen and the title bar's sheet show.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[cfg(desktop)]
impl UpdateInfo {
    fn of(update: &tauri_plugin_updater::Update) -> Self {
        UpdateInfo {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update
                .body
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|d| d.as_str())
                .map(String::from),
        }
    }
}

/// The version the last look found, and its bytes once they are downloaded and verified.
#[derive(Default)]
pub struct Pending {
    #[cfg(desktop)]
    found: Mutex<Option<Found>>,
}

#[cfg(desktop)]
struct Found {
    update: tauri_plugin_updater::Update,
    bytes: Option<Vec<u8>>,
}

#[cfg(desktop)]
impl Pending {
    fn keep(&self, update: tauri_plugin_updater::Update, bytes: Option<Vec<u8>>) {
        if let Ok(mut found) = self.found.lock() {
            *found = Some(Found { update, bytes });
        }
    }

    /// The found version and, once downloaded, its bytes.
    fn get(&self) -> Option<(tauri_plugin_updater::Update, Option<Vec<u8>>)> {
        let found = self.found.lock().ok()?;
        found.as_ref().map(|f| (f.update.clone(), f.bytes.clone()))
    }

    /// The downloaded bytes of `version`, if those are what is kept.
    fn bytes_of(&self, version: &str) -> Option<Vec<u8>> {
        let found = self.found.lock().ok()?;
        found
            .as_ref()
            .filter(|f| f.update.version == version)
            .and_then(|f| f.bytes.clone())
    }
}

/// How far a download is, for the start screen's bar.
#[cfg(desktop)]
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

/// What the start check did, for the window (src/components/StartGate.tsx). Every outcome opens
/// the app; an install instead ends this program, and the new version opens. Phones build only
/// `NotHere`: their store updates them.
#[cfg_attr(not(desktop), allow(dead_code))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum AtStart {
    /// This copy does not update itself (a store, a package), or it is not a released build.
    NotHere,
    /// Nothing newer.
    Current,
    /// No answer from the update list in time: the app opens and looks again later.
    NoAnswer,
    /// A newer version, but another copy of the program runs or a connection is up (an install
    /// would end them): the title bar offers it.
    Waits { version: String },
    /// Found, but the download or the install failed: the title bar offers it again later.
    Failed { version: String },
    /// This version was installed a moment ago and did not arrive: not again at once.
    TriedRecently { version: String },
}

/// At start, before the window opens its screens: take a newer version first (see the top of
/// this file). On Windows a successful install never returns: the installer takes over and
/// starts the new version. Elsewhere the files are swapped and the app restarts.
#[tauri::command]
pub async fn update_at_start(app: AppHandle, pending: State<'_, Pending>) -> Result<AtStart, String> {
    #[cfg(desktop)]
    return Ok(at_start(&app, &pending).await);
    #[cfg(not(desktop))]
    {
        let _ = (app, pending);
        Ok(AtStart::NotHere)
    }
}

#[cfg(desktop)]
async fn at_start(app: &AppHandle, pending: &Pending) -> AtStart {
    use tauri::Emitter;

    // Once per run of the program: a window that reloads does not install twice.
    static LOOKED: AtomicBool = AtomicBool::new(false);
    if LOOKED.swap(true, Ordering::SeqCst) {
        return AtStart::Current;
    }
    if released_at().is_none() || !crate::channel::current(app).updates_itself() {
        return AtStart::NotHere;
    }
    let current = app.package_info().version.clone();
    if let Some(version) = tried_recently(app, &current) {
        log::warn!("{version} was installed a moment ago and this is still {current}: opening without it");
        return AtStart::TriedRecently { version };
    }
    let hidden = !window_visible(app);
    let update = match updater(app, START_CHECK, hidden) {
        Ok(updater) => match updater.check().await {
            Ok(Some(update)) => update,
            Ok(None) => return AtStart::Current,
            Err(e) => {
                log::info!("no answer from the update list at start ({e}); looking again later");
                return AtStart::NoAnswer;
            }
        },
        Err(e) => {
            log::warn!("the updater could not be set up: {e}");
            return AtStart::NoAnswer;
        }
    };
    let version = update.version.clone();
    if other_copies() != Some(0) || connect::is_running(app) {
        pending.keep(update, None);
        return AtStart::Waits { version };
    }

    let _ = app.emit("update:found", UpdateInfo::of(&update));
    let bytes = match download_watched(app, &update).await {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("{version} could not be downloaded at start: {e}");
            pending.keep(update, None);
            return AtStart::Failed { version };
        }
    };
    pending.keep(update.clone(), Some(bytes.clone()));
    write_attempt_note(app, &version);
    if hidden {
        write_hidden_note(app);
    }
    log::info!("installing {version} at start, before anything else runs");
    let _ = app.emit("update:installing", &version);
    if let Err(e) = update.install(bytes) {
        clear_attempt_note(app);
        clear_hidden_note(app);
        log::warn!("{version} could not be installed at start: {e}");
        return AtStart::Failed { version };
    }
    // Windows never gets here. macOS and Linux swapped the files in place.
    connect::restore_on_exit(app);
    app.restart()
}

/// Look for a newer version now (the title bar's timer, or "Check for updates"). Only a copy
/// that updates itself looks here; the others read the version list (src/versions.rs).
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    #[cfg(desktop)]
    {
        if !crate::channel::current(&app).updates_itself() {
            return Ok(None);
        }
        let updater = updater(&app, CHECK, false)?;
        let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
            return Ok(None);
        };
        let info = UpdateInfo::of(&update);
        // The same version, already downloaded, keeps its bytes.
        if pending.bytes_of(&update.version).is_none() {
            pending.keep(update, None);
        }
        Ok(Some(info))
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, pending);
        Ok(None)
    }
}

/// Download the version the last look found. The plugin verifies it against the public key in
/// this build before it hands the bytes over (its `download`).
#[tauri::command]
pub async fn update_download(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some((update, bytes)) = pending.get() else {
            return Err("there is no version to download".into());
        };
        if bytes.is_some() {
            return Ok(());
        }
        let bytes = download_watched(&app, &update).await?;
        pending.keep(update, Some(bytes));
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, pending);
        Err("phones update through their store".into())
    }
}

/// "Restart to update": install the downloaded version. The window stopped Connect first. On
/// Windows this never returns: the installer shows its progress and starts the new version.
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let Some((update, Some(bytes))) = pending.get() else {
            return Err("the new version is not downloaded yet".into());
        };
        write_attempt_note(&app, &update.version);
        if let Err(e) = update.install(bytes) {
            clear_attempt_note(&app);
            return Err(e.to_string());
        }
        connect::restore_on_exit(&app);
        app.restart()
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, pending);
        Err("phones update through their store".into())
    }
}

/// Forget the version the last look found, so the next look fetches it afresh (after a failed
/// install, "Try again").
#[tauri::command]
pub fn update_forget(pending: State<'_, Pending>) {
    #[cfg(desktop)]
    if let Ok(mut found) = pending.found.lock() {
        *found = None;
    }
    #[cfg(not(desktop))]
    let _ = pending;
}

/// Install the newest version now, silently, if nobody is using the app.
/// False when there was nothing to do (someone is using it, or no update).
/// On Windows a successful install never returns: the installer takes over.
/// Phones update through their store, so there it never has anything to do.
#[tauri::command]
pub async fn update_install_quietly(app: AppHandle, pending: State<'_, Pending>) -> Result<bool, String> {
    #[cfg(desktop)]
    return install_quietly(app, &pending).await;
    #[cfg(not(desktop))]
    {
        let _ = (app, pending);
        Ok(false)
    }
}

#[cfg(desktop)]
async fn install_quietly(app: AppHandle, pending: &Pending) -> Result<bool, String> {
    if !idle_now(&app).nobody_using() || !crate::channel::current(&app).updates_itself() {
        return Ok(false);
    }
    let updater = updater(&app, CHECK, true)?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    // The bytes the title bar's download already verified, when they are this version's.
    let bytes = match pending.bytes_of(&update.version) {
        Some(bytes) => bytes,
        None => download_watched(&app, &update).await?,
    };
    // The download takes a while: look again, someone may have come back.
    if !idle_now(&app).nobody_using() {
        return Ok(false);
    }
    write_hidden_note(&app);
    write_attempt_note(&app, &update.version);
    log::info!(
        "installing {} quietly: the window is hidden, nothing is connected, no other copy runs",
        update.version
    );
    if let Err(e) = update.install(bytes) {
        clear_hidden_note(&app);
        clear_attempt_note(&app);
        return Err(e.to_string());
    }
    // Windows never gets here. macOS and Linux swapped the files in place:
    // start the new version, which finds the note and waits in the tray.
    connect::restore_on_exit(&app);
    app.restart()
}

/// The updater for one look: the stable list or the test ring's, how long the look may take,
/// and a silent installer for a copy nobody is watching.
#[cfg(desktop)]
fn updater(app: &AppHandle, timeout: Duration, silent: bool) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;

    let restore = app.clone();
    let list = if in_test_ring(app) { TEST_LIST } else { STABLE_LIST };
    let list: tauri::Url = list.parse().map_err(|e| format!("{list}: {e}"))?;
    let mut builder = app
        .updater_builder()
        .endpoints(vec![list])
        .map_err(|e| e.to_string())?
        .timeout(timeout)
        .on_before_exit(move || {
            connect::restore_on_exit(&restore);
            restore.cleanup_before_exit();
        });
    if silent {
        builder = builder.installer_arg("/S");
    }
    builder.build().map_err(|e| e.to_string())
}

/// Download a version with its progress for the start screen, and give up when nothing arrives
/// for `STALL`: a line that stopped moving must not hold the app closed.
#[cfg(desktop)]
async fn download_watched(app: &AppHandle, update: &tauri_plugin_updater::Update) -> Result<Vec<u8>, String> {
    use tauri::Emitter;

    let started = Instant::now();
    // Milliseconds after `started` when the last bytes arrived.
    let last = Arc::new(AtomicU64::new(0));
    let arrived = last.clone();
    let events = app.clone();
    let mut downloaded = 0u64;
    let mut shown = 0u64;
    let download = update.download(
        move |chunk, total| {
            downloaded += chunk as u64;
            arrived.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
            // One event per 64 KB is plenty for a bar; the last one always goes.
            if downloaded - shown >= 64 * 1024 || Some(downloaded) == total {
                shown = downloaded;
                let _ = events.emit("update:progress", Progress { downloaded, total });
            }
        },
        || {},
    );
    tokio::pin!(download);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            result = &mut download => return result.map_err(|e| e.to_string()),
            _ = tick.tick() => {
                let quiet = (started.elapsed().as_millis() as u64).saturating_sub(last.load(Ordering::Relaxed));
                if quiet > STALL.as_millis() as u64 {
                    return Err(format!("nothing arrived for {} seconds", STALL.as_secs()));
                }
            }
        }
    }
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
    data_file(app, HIDDEN_NOTE)
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

/// A file in the app's data folder, by name.
#[cfg(desktop)]
fn data_file(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join(name))
}

/// Whether this copy is in the test ring: the maintainers' own computer, which takes every
/// release before everyone else.
#[cfg(desktop)]
fn in_test_ring(app: &AppHandle) -> bool {
    data_file(app, RING_NOTE)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .is_some_and(|text| says_test_ring(&text))
}

#[cfg(desktop)]
fn says_test_ring(text: &str) -> bool {
    text.trim().eq_ignore_ascii_case("test")
}

/// Before an install: which version, and when. The next start reads it (`tried_recently`).
#[cfg(desktop)]
fn write_attempt_note(app: &AppHandle, version: &str) {
    if let Some(path) = data_file(app, ATTEMPT_NOTE) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&path, format!("{version}\n{}", now_ms()));
    }
}

#[cfg(desktop)]
fn clear_attempt_note(app: &AppHandle) {
    if let Some(path) = data_file(app, ATTEMPT_NOTE) {
        let _ = std::fs::remove_file(path);
    }
}

/// The version an install brought a moment ago that is still not the one running: the start
/// check leaves it alone this time. A note that is old, or whose version arrived, is removed.
#[cfg(desktop)]
fn tried_recently(app: &AppHandle, running: &semver::Version) -> Option<String> {
    let path = data_file(app, ATTEMPT_NOTE)?;
    let text = std::fs::read_to_string(&path).ok()?;
    let still_missing = missing_after_install(&text, running, now_ms());
    if still_missing.is_none() {
        let _ = std::fs::remove_file(&path);
    }
    still_missing
}

/// The note's version, when it is newer than the running one and was written within
/// `NOTE_FRESH`; None for anything else, a note that cannot be read included.
#[cfg(desktop)]
fn missing_after_install(note: &str, running: &semver::Version, now_ms: u64) -> Option<String> {
    let mut lines = note.lines();
    let version = lines.next()?.trim();
    let written_ms: u64 = lines.next()?.trim().parse().ok()?;
    let newer = semver::Version::parse(version).ok()? > *running;
    (newer && fresh(written_ms, now_ms)).then(|| version.to_string())
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

    /// The release tool publishes to the list tauri.conf.json names; the code reads the same
    /// one, and the test ring's list sits beside it.
    #[cfg(desktop)]
    #[test]
    fn the_lists_are_the_ones_the_release_tool_writes() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints = conf["plugins"]["updater"]["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 1);
        assert_eq!(endpoints[0].as_str(), Some(STABLE_LIST));
        assert_eq!(TEST_LIST, STABLE_LIST.replace("/latest.json", "/latest-test.json"));
    }

    #[cfg(desktop)]
    #[test]
    fn only_the_word_test_puts_a_copy_in_the_test_ring() {
        assert!(says_test_ring("test"));
        assert!(says_test_ring(" TEST\r\n"));
        assert!(!says_test_ring(""));
        assert!(!says_test_ring("stable"));
        assert!(!says_test_ring("testing"));
    }

    #[cfg(desktop)]
    #[test]
    fn a_version_that_did_not_arrive_is_left_alone_for_ten_minutes() {
        let now = 1_790_000_000_000;
        let running = v("0.2.4");
        let note = |version: &str, at: u64| format!("{version}\n{at}");
        // Installed a minute ago, still 0.2.4 running: do not try 0.2.5 again yet.
        assert_eq!(
            missing_after_install(&note("0.2.5", now - 60_000), &running, now).as_deref(),
            Some("0.2.5")
        );
        // Eleven minutes ago: try again.
        assert_eq!(
            missing_after_install(&note("0.2.5", now - 11 * 60_000), &running, now),
            None
        );
        // The version arrived (or an older note): nothing is missing.
        assert_eq!(missing_after_install(&note("0.2.4", now - 1_000), &running, now), None);
        assert_eq!(missing_after_install(&note("0.2.3", now - 1_000), &running, now), None);
        // Unreadable notes hold nothing back.
        assert_eq!(missing_after_install("", &running, now), None);
        assert_eq!(missing_after_install("0.2.5", &running, now), None);
        assert_eq!(missing_after_install("zero\n123", &running, now), None);
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
