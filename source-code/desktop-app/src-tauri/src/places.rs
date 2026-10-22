//! Places: the person's proxies, groups and the place they picked, owned here
//! (the `hproxy-places` crate) and kept in the app's own data folder, not in
//! the window's storage. The window shows them from a view that never holds a
//! password and asks for every change by id; a connection, a check and the
//! tray read the lines here, on the side that dials them.
//!
//! The window kept them itself before (its localStorage). Its first start with
//! this version sends them over once (`places_move_from_window`); after that
//! the window's copy is never read again, and it is left where it was rather
//! than deleted, so nothing can be lost in the move.
//!
//! A library file that cannot be read is never written over: it is moved aside
//! under a new name, and the copy from before the last write
//! (`places.dat.bak`) is read instead. When that fails too, the app starts
//! empty and says so.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use hproxy_places::{
    proxy_id, store, Details, GroupInput, Library, LibraryView, MemberView, Place, ProxyView, Targeting, Verdict,
    WindowStorage,
};
use hproxy_probe::CheckResult;
use serde::Serialize;
#[cfg(mobile)]
use tauri::Manager;
use tauri::{AppHandle, State};

use crate::check::{check_one, AppState};

/// The library, the folder it is kept in, and what the start had to say.
pub struct PlacesState {
    lib: Arc<Mutex<Library>>,
    dir: Option<PathBuf>,
    notice: Arc<Mutex<Option<String>>>,
    /// A write of what checks found is on its way (`keep_soon`).
    write_pending: Arc<AtomicBool>,
    /// Lines checked before they were saved (the window's paste field, every
    /// line of a pasted list's review, every row of a Checker run), with what
    /// each check found: a line saved right after keeps that answer instead of
    /// reading "not checked yet". In memory only.
    checked: Mutex<RecentChecks>,
}

/// How many of those checks are kept, and for how long they count: more than the most proxies
/// one can keep (10 000), so a Checker run's working rows kept at once all carry what it found.
const CHECKED_KEPT: usize = 20_000;
const CHECKED_FOR_MS: u64 = 10 * 60 * 1000;

/// Checks of lines not saved yet, by line, the oldest let go first past CHECKED_KEPT.
#[derive(Default)]
struct RecentChecks {
    by_line: HashMap<String, Verdict>,
    order: VecDeque<String>,
}

impl RecentChecks {
    fn put(&mut self, line: &str, verdict: Verdict) {
        if self.by_line.insert(line.to_string(), verdict).is_none() {
            self.order.push_back(line.to_string());
        }
        while self.order.len() > CHECKED_KEPT {
            if let Some(old) = self.order.pop_front() {
                self.by_line.remove(&old);
            }
        }
    }

    /// What a check of `line` found, while it still counts.
    fn fresh(&self, line: &str, now: u64) -> Option<&Verdict> {
        self.by_line
            .get(line)
            .filter(|v| now.saturating_sub(v.at) < CHECKED_FOR_MS)
    }
}
/// How long what checks found waits before it is written, with whatever else
/// was found meanwhile.
const CHECKS_WRITTEN_AFTER: Duration = Duration::from_secs(2);

impl PlacesState {
    /// Open the library kept in the app's data folder (see the module doc for
    /// what happens when it cannot be read).
    pub fn open(app: &AppHandle) -> Self {
        // On a computer, the folder every door reads the library from (the
        // command line and the AI assistant's tool find it there too); on a
        // phone, the app's own private folder, where nothing else looks.
        #[cfg(desktop)]
        let dir = {
            let _ = app;
            store::app_dir()
        };
        #[cfg(mobile)]
        let dir = app.path().app_data_dir().ok();
        let opened = match dir {
            Some(dir) => open_in(&dir),
            None => Opened {
                lib: Library::default(),
                notice: Some(MEMORY_ONLY.into()),
                dir: None,
            },
        };
        if let Some(n) = &opened.notice {
            log::warn!("{n}");
        }
        Self::from_opened(opened)
    }

    fn from_opened(opened: Opened) -> Self {
        Self {
            lib: Arc::new(Mutex::new(opened.lib)),
            dir: opened.dir,
            notice: Arc::new(Mutex::new(opened.notice)),
            write_pending: Arc::new(AtomicBool::new(false)),
            checked: Mutex::new(RecentChecks::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Library> {
        self.lib.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Change the library and keep it on disk; returns the view after.
    fn change<T>(&self, f: impl FnOnce(&mut Library) -> T) -> (T, LibraryView) {
        let mut lib = self.lock();
        let out = f(&mut lib);
        self.keep(&lib);
        (out, lib.view())
    }

    fn keep(&self, lib: &Library) {
        if let Some(dir) = &self.dir {
            write(dir, lib, &self.notice);
        }
    }

    /// Keep the library on disk in a moment rather than now: for what checks
    /// and probes found, which come many at a time (Test all checks every
    /// proxy), and would otherwise rewrite the whole file once each.
    fn keep_soon(&self) {
        let Some(dir) = self.dir.clone() else { return };
        if self.write_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (lib, notice, pending) = (
            Arc::clone(&self.lib),
            Arc::clone(&self.notice),
            Arc::clone(&self.write_pending),
        );
        std::thread::spawn(move || {
            std::thread::sleep(CHECKS_WRITTEN_AFTER);
            let lib = lib.lock().unwrap_or_else(|e| e.into_inner());
            // Cleared under the lock: a check that lands after this waits for
            // the lock and asks for a write of its own.
            if pending.swap(false, Ordering::SeqCst) {
                write(&dir, &lib, &notice);
            }
        });
    }

    /// Write now what is waiting to be written: the app is closing.
    pub fn flush(&self) {
        let lib = self.lock();
        if self.write_pending.swap(false, Ordering::SeqCst) {
            self.keep(&lib);
        }
    }

    /// Read the library, for the side that dials it.
    pub fn read<T>(&self, f: impl FnOnce(&Library) -> T) -> T {
        f(&self.lock())
    }

    /// The line of a saved proxy, for the side that dials it.
    pub fn proxy_line(&self, id: &str) -> Option<String> {
        self.lock().proxy(id).map(|p| p.line.clone())
    }

    /// A group's lines and rule, for the side that dials them.
    pub fn group_lines(&self, id: &str) -> Option<(Vec<String>, hproxy_places::Rule, Option<u32>)> {
        self.lock().group(id).map(|g| (g.lines.clone(), g.rule, g.n))
    }

    /// The place picked last, for the tray's Connect.
    pub fn picked(&self) -> Option<Place> {
        self.lock().picked.clone()
    }

    /// What the switch connects to: yours used last, never a free proxy (`Library::switch_place`).
    pub fn switch_place(&self) -> Option<Place> {
        self.lock().switch_place()
    }

    /// The library as a screen sees it (the reminders read the days from it).
    pub fn view(&self) -> LibraryView {
        self.lock().view()
    }

    /// The folder the library is kept in; none when it lives in memory only.
    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// A connection went through `place`: count it, bring it to the top and
    /// remember it as the pick.
    pub fn used(&self, place: &Place) {
        let now = now_ms();
        self.change(|lib| {
            match place {
                Place::Proxy { id } => lib.proxy_used(id, now),
                Place::Group { id } => lib.group_used(id, now),
                Place::Free { .. } => {}
            }
            let _ = lib.pick(Some(place.clone()));
        });
    }

    /// Keep what a check found about a saved proxy.
    pub fn verdict(&self, id: &str, verdict: Verdict) {
        if self.lock().set_verdict(id, verdict) {
            self.keep_soon();
        }
    }

    /// A line was checked before it was saved: remember the answer a while.
    pub fn checked(&self, line: &str, verdict: Verdict) {
        self.checked
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .put(line.trim(), verdict);
    }

    /// Save lines as proxies. One checked a moment ago that has no check of
    /// its own yet keeps what that check found. Returns the ids saved and the
    /// view after.
    fn add(&self, lines: &[String], now: u64) -> (Vec<String>, LibraryView) {
        let recent: Vec<(String, Verdict)> = {
            let kept = self.checked.lock().unwrap_or_else(|e| e.into_inner());
            lines
                .iter()
                .map(|l| l.trim())
                .filter_map(|l| kept.fresh(l, now).map(|v| (l.to_string(), v.clone())))
                .collect()
        };
        self.change(|lib| {
            let ids = lib.add_proxies(lines, now);
            let saved: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
            for (line, verdict) in recent {
                let id = proxy_id(&line);
                let unchecked = lib.proxy(&id).is_some_and(|p| p.last.is_none());
                if unchecked && saved.contains(id.as_str()) {
                    lib.set_verdict(&id, verdict);
                }
            }
            ids
        })
    }

    /// Keep what a probe through the connected proxy found. Probes come every
    /// twenty seconds, so the file is written only when the answer changed in
    /// a way its row shows (working or not, the exit, its country) or the one
    /// on disk is ten minutes old; in between the row is kept fresh in memory.
    pub fn probed(&self, id: &str, verdict: Verdict) {
        const STALE_MS: u64 = 10 * 60 * 1000;
        let mut lib = self.lock();
        let worth_writing = match lib.proxy(id).and_then(|p| p.last.as_ref()) {
            None => true,
            Some(old) => {
                old.ok != verdict.ok
                    || old.exit_ip != verdict.exit_ip
                    || old.cc != verdict.cc
                    || verdict.at.saturating_sub(old.at) >= STALE_MS
            }
        };
        if !worth_writing {
            // Fresh in memory, the written copy left as it is.
            if let Some(p) = lib.proxies.iter_mut().find(|p| p.id == id) {
                if let Some(last) = p.last.as_mut() {
                    last.latency_ms = verdict.latency_ms;
                }
            }
            return;
        }
        if lib.set_verdict(id, verdict) {
            self.keep_soon();
        }
    }

    /// A library held in memory only: for tests.
    #[cfg(test)]
    pub fn with(lib: Library) -> Self {
        Self::from_opened(Opened {
            lib,
            notice: None,
            dir: None,
        })
    }

    /// The saved proxies and groups for the tray's Quick connect: the ones used
    /// last first, then the ones added last, at most `max`.
    pub fn quick(&self, max: usize) -> Vec<(Place, String)> {
        let view = self.lock().view();
        let mut used: Vec<(u64, Place, String)> = Vec::new();
        for p in view.proxies.iter().filter(|p| p.uses > 0) {
            used.push((p.last_used_at, Place::Proxy { id: p.id.clone() }, p.title()));
        }
        for g in view.groups.iter().filter(|g| g.uses > 0) {
            used.push((g.last_used_at, Place::Group { id: g.id.clone() }, g.name.clone()));
        }
        used.sort_by(|a, b| b.0.cmp(&a.0));
        let mut fresh: Vec<&ProxyView> = view.proxies.iter().filter(|p| p.uses == 0).collect();
        fresh.sort_by(|a, b| b.added_at.cmp(&a.added_at));
        used.into_iter()
            .map(|(_, place, name)| (place, name))
            .chain(
                fresh
                    .into_iter()
                    .map(|p| (Place::Proxy { id: p.id.clone() }, p.title())),
            )
            .take(max)
            .collect()
    }
}

const MEMORY_ONLY: &str = "The app's data folder is unavailable: places are kept until HProxy closes.";

/// Write the library to `dir`; a failure is logged and becomes the notice
/// the window shows.
fn write(dir: &Path, lib: &Library, notice: &Mutex<Option<String>>) {
    if let Err(e) = store::save(dir, lib) {
        log::error!("the places could not be kept on disk: {e}");
        *notice.lock().unwrap_or_else(|e| e.into_inner()) = Some(format!("Your places could not be saved: {e}"));
    }
}

/// What opening the library found.
struct Opened {
    lib: Library,
    notice: Option<String>,
    /// Where changes are written; none while that could cost something.
    dir: Option<PathBuf>,
}

fn open_in(dir: &Path) -> Opened {
    let main = match store::load(dir) {
        Ok(lib) => {
            return Opened {
                lib: lib.unwrap_or_default(),
                notice: None,
                dir: Some(dir.to_path_buf()),
            }
        }
        Err(e) => e,
    };
    // The unreadable file goes aside before anything else: left where it is,
    // the next save would copy it over the backup. When it cannot be moved,
    // nothing is written this run, so it is never written over either.
    let (kept, write_to) = match store::set_aside(dir, now_ms()) {
        Ok(path) => (
            format!("The file was kept as {}.", path.display()),
            Some(dir.to_path_buf()),
        ),
        Err(e) => (format!("{e}, so changes are kept until HProxy closes."), None),
    };
    match store::load_backup(dir) {
        Ok(Some(lib)) => Opened {
            lib,
            notice: Some(format!(
                "Your places were read from the copy before the last save ({main}). {kept}"
            )),
            dir: write_to,
        },
        _ => Opened {
            lib: Library::default(),
            notice: Some(format!("Your places could not be read ({main}). {kept}")),
            dir: write_to,
        },
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// What the window gets at start.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacesStart {
    pub view: LibraryView,
    /// Whether the window's old storage was moved in already.
    pub moved_from_window: bool,
    /// Something to say about the library (read from the copy, set aside).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[tauri::command]
pub fn places_get(places: State<'_, PlacesState>) -> PlacesStart {
    let lib = places.lock();
    PlacesStart {
        view: lib.view(),
        moved_from_window: lib.moved_from_window,
        notice: places.notice.lock().ok().and_then(|n| n.clone()),
    }
}

/// The window's old storage, once. Later calls change nothing.
#[tauri::command]
pub fn places_move_from_window(app: AppHandle, places: State<'_, PlacesState>, old: WindowStorage) -> LibraryView {
    let now = now_ms();
    let (moved, view) = places.change(|lib| lib.move_from_window(old, now));
    if moved {
        log::info!(
            "the window's places moved into the library: {} proxies, {} groups",
            view.proxies.len(),
            view.groups.len()
        );
        crate::tray::places_changed(&app);
    }
    view
}

/// Lines saved, and the id of each readable one, in the order given.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    pub view: LibraryView,
    pub ids: Vec<String>,
}

#[tauri::command]
pub fn places_add(app: AppHandle, places: State<'_, PlacesState>, lines: Vec<String>) -> Added {
    let (ids, view) = places.add(&lines, now_ms());
    crate::tray::places_changed(&app);
    Added { view, ids }
}

#[tauri::command]
pub fn places_rename(app: AppHandle, places: State<'_, PlacesState>, id: String, name: String) -> LibraryView {
    let view = places.change(|lib| lib.rename_proxy(&id, &name)).1;
    crate::tray::places_changed(&app);
    view
}

/// Several saved proxies named at once, each its own name (`names[i]` for `ids[i]`): a paste
/// named "Shop 1", "Shop 2" … in one write.
#[tauri::command]
pub fn places_name_each(
    app: AppHandle,
    places: State<'_, PlacesState>,
    ids: Vec<String>,
    names: Vec<String>,
) -> LibraryView {
    let named: Vec<(String, String)> = ids.into_iter().zip(names).collect();
    let view = places.change(|lib| lib.name_proxies(&named)).1;
    crate::tray::places_changed(&app);
    view
}

/// What saved proxies are, one or a whole paste at once: a name, the last day
/// they work, a note. A field left out stays; an empty one is taken away; a
/// date that is not a day changes nothing and says why.
#[tauri::command]
pub fn places_describe(
    app: AppHandle,
    places: State<'_, PlacesState>,
    ids: Vec<String>,
    details: Details,
) -> Result<LibraryView, String> {
    let (described, view) = places.change(|lib| lib.describe_proxies(&ids, &details));
    described?;
    count_details(&app, &details);
    crate::tray::places_changed(&app);
    Ok(view)
}

/// The same for a group, which keeps its name when an empty one comes.
#[tauri::command]
pub fn places_group_describe(
    app: AppHandle,
    places: State<'_, PlacesState>,
    id: String,
    details: Details,
) -> Result<LibraryView, String> {
    let (described, view) = places.change(|lib| lib.describe_group(&id, &details));
    described?;
    count_details(&app, &details);
    crate::tray::places_changed(&app);
    Ok(view)
}

/// Usage counts (usage.rs): a last day or a note written counts as that feature used.
fn count_details(app: &AppHandle, details: &Details) {
    let written = |field: &Option<String>| field.as_deref().is_some_and(|v| !v.trim().is_empty());
    if written(&details.expires) {
        crate::usage::feature(app, "expiry");
    }
    if written(&details.note) {
        crate::usage::feature(app, "notes");
    }
}

#[tauri::command]
pub fn places_forget(app: AppHandle, places: State<'_, PlacesState>, id: String) -> LibraryView {
    let view = places.change(|lib| lib.forget_proxy(&id)).1;
    crate::tray::places_changed(&app);
    view
}

#[tauri::command]
pub fn places_pick(
    app: AppHandle,
    places: State<'_, PlacesState>,
    place: Option<Place>,
) -> Result<LibraryView, String> {
    let (picked, view) = places.change(|lib| lib.pick(place));
    crate::tray::places_changed(&app);
    picked.map(|_| view)
}

#[tauri::command]
pub fn places_group_save(app: AppHandle, places: State<'_, PlacesState>, group: GroupInput) -> Result<Added, String> {
    let now = now_ms();
    let (saved, view) = places.change(|lib| lib.save_group(group, now));
    crate::tray::places_changed(&app);
    if saved.is_ok() {
        crate::usage::feature(&app, "groups");
    }
    saved.map(|id| Added { view, ids: vec![id] })
}

#[tauri::command]
pub fn places_group_forget(app: AppHandle, places: State<'_, PlacesState>, id: String) -> LibraryView {
    let view = places.change(|lib| lib.forget_group(&id)).1;
    crate::tray::places_changed(&app);
    view
}

/// A group's lines, passwords included: for its editor and for the Checker,
/// both asked for by the person, never for showing.
#[tauri::command]
pub fn places_group_lines(places: State<'_, PlacesState>, id: String) -> Result<Vec<String>, String> {
    places
        .group_lines(&id)
        .map(|(lines, _, _)| lines)
        .ok_or_else(|| "that group is not here any more".into())
}

/// Some of a group's members, without passwords: `from` and up to `count`.
#[tauri::command]
pub fn places_group_members(
    places: State<'_, PlacesState>,
    id: String,
    from: usize,
    count: usize,
) -> Result<Vec<MemberView>, String> {
    places
        .lock()
        .members(&id, from, count.min(1000))
        .ok_or_else(|| "that group is not here any more".into())
}

/// A saved proxy's line, password included, when the person asks to copy it.
#[tauri::command]
pub fn places_proxy_line(places: State<'_, PlacesState>, id: String) -> Result<String, String> {
    places
        .proxy_line(&id)
        .ok_or_else(|| "that proxy is not saved here any more".into())
}

/// Check a saved proxy again, by id: the line stays on this side, and what the
/// check found is kept with it. Returns the proxy as the window shows it.
#[tauri::command]
pub async fn places_check(
    places: State<'_, PlacesState>,
    app_state: State<'_, AppState>,
    id: String,
) -> Result<ProxyView, String> {
    let line = places
        .proxy_line(&id)
        .ok_or_else(|| "that proxy is not saved here any more".to_string())?;
    let result = check_one(&app_state, &line).await?;
    places.verdict(&id, verdict_of_check(&result, now_ms()));
    places
        .lock()
        .view()
        .proxies
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "that proxy is not saved here any more".into())
}

/// What a check says about a saved proxy, the way its row shows it: the
/// engine's verdict on whether it carries a connection, not merely whether
/// something answered.
pub fn verdict_of_check(r: &CheckResult, at: u64) -> Verdict {
    Verdict::of_check(r, at)
}

/// "Berlin, Germany", or whichever of the two is known (hproxy-places, which
/// the phone app reads too).
pub use hproxy_places::place_words;

/// How many lines one `describe_lines` call reads. The window asks in turns past this.
const MAX_LINES: usize = 5_000;

/// What each line targets, in the order given: nothing for a line that cannot
/// be read, has no login, or whose login targets nothing. For lines not saved
/// yet (a paste being reviewed); saved ones carry it in the view.
#[tauri::command]
pub fn describe_lines(lines: Vec<String>) -> Vec<Option<Targeting>> {
    lines.iter().take(MAX_LINES).map(|l| about(l)).collect()
}

fn about(line: &str) -> Option<Targeting> {
    let parsed = hproxy_probe::line::parse(line).ok()?;
    let (user, _password) = parsed.auth?;
    Some(hproxy_places::read_targeting(&user)).filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_session_line_is_read_and_a_plain_one_is_nothing() {
        let out = describe_lines(vec![
            "gate.example.com:10000:acct-country-us-state-california-session-7f3a9c21-lifetime-30:secret".into(),
            "198.51.100.7:8080:user:pass".into(),
            "203.0.113.9:3128".into(),
            "not a proxy".into(),
        ]);
        let first = out[0].as_ref().expect("the session line targets something");
        assert_eq!(first.session.as_deref(), Some("7f3a9c21"));
        assert_eq!(first.region.as_deref(), Some("california"));
        assert!(out[1].is_none(), "a plain login targets nothing");
        assert!(out[2].is_none(), "no login, nothing to read");
        assert!(out[3].is_none(), "an unreadable line is nothing, not an error");
    }

    #[test]
    fn the_password_never_comes_back() {
        let out = describe_lines(vec!["gate.example.com:1:acct-session-ab12:hunter2-country-de".into()]);
        let json = serde_json::to_string(&out).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
        assert_eq!(
            out[0].as_ref().and_then(|t| t.country.as_deref()),
            None,
            "the password is not read for targeting"
        );
    }

    #[test]
    fn a_check_becomes_a_verdict_the_row_can_show() {
        let r = CheckResult {
            input: "198.51.100.7:8080".into(),
            alive: true,
            protocols: vec!["http".into(), "https".into()],
            latency_ms: Some(140),
            country_code: Some("DE".into()),
            country: Some("Germany".into()),
            city: Some("Berlin".into()),
            exit_ip: Some("203.0.113.9".into()),
            anonymity: Some("elite".into()),
            ..Default::default()
        };
        let v = verdict_of_check(&r, 7);
        assert!(v.ok);
        assert_eq!(v.latency_ms, Some(140));
        assert_eq!(v.cc.as_deref(), Some("de"));
        assert_eq!(v.place.as_deref(), Some("Berlin, Germany"));
        assert_eq!(v.exit_ip.as_deref(), Some("203.0.113.9"));
        assert_eq!(v.says.as_deref(), Some("Working · 140 ms"));
        assert_eq!(v.way, Some(hproxy_probe::Way::Http));
        assert_eq!(v.at, 7);
    }

    /// A proxy that answered only plain HTTP used to be saved as working, and
    /// Connect through it opened no https site.
    #[test]
    fn a_proxy_that_cannot_open_a_tunnel_is_not_saved_as_working() {
        let r = CheckResult {
            input: "198.51.100.7:8080".into(),
            alive: true,
            protocols: vec!["http".into()],
            latency_ms: Some(90),
            ..Default::default()
        };
        let v = verdict_of_check(&r, 7);
        assert!(!v.ok);
        assert_eq!(v.says.as_deref(), Some("Can't open https sites"));
        assert_eq!(v.tone, Some(hproxy_probe::Tone::Bad));
        assert_eq!(v.way, None);
    }

    #[test]
    fn what_checks_find_is_written_a_moment_later_and_always_before_exit() {
        let dir = std::env::temp_dir().join(format!("hproxy-places-soon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let line = "198.51.100.7:8080".to_string();
        let mut lib = Library::default();
        lib.add_proxies(std::slice::from_ref(&line), 1);
        store::save(&dir, &lib).unwrap();
        let places = PlacesState::from_opened(Opened {
            lib,
            notice: None,
            dir: Some(dir.clone()),
        });
        let checked = |at| Verdict {
            ok: true,
            at,
            ..Default::default()
        };
        places.verdict(&proxy_id(&line), checked(5));
        places.verdict(&proxy_id(&line), checked(6));
        let on_disk = || {
            store::load(&dir).unwrap().unwrap().proxies[0]
                .last
                .as_ref()
                .map(|v| v.at)
        };
        assert_eq!(on_disk(), None, "not written at once");
        places.flush();
        assert_eq!(on_disk(), Some(6), "written on the way out, the newest answer");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_line_checked_before_it_is_saved_keeps_that_answer_a_while() {
        let at = now_ms();
        let seven = "198.51.100.7:8080".to_string();
        let places = PlacesState::with(Library::default());
        places.checked(
            " 198.51.100.7:8080 ",
            Verdict {
                ok: true,
                latency_ms: Some(90),
                at,
                ..Default::default()
            },
        );
        let (ids, view) = places.add(&[seven.clone(), "198.51.100.8:8080".to_string()], at + 1);
        assert_eq!(ids.len(), 2);
        assert_eq!(view.proxies[0].last.as_ref().and_then(|v| v.latency_ms), Some(90));
        assert!(
            view.proxies[1].last.is_none(),
            "a line nobody checked reads not checked"
        );

        let places = PlacesState::with(Library::default());
        places.checked(
            &seven,
            Verdict {
                ok: true,
                at,
                ..Default::default()
            },
        );
        let (_, view) = places.add(&[seven], at + CHECKED_FOR_MS);
        assert!(view.proxies[0].last.is_none(), "an old check counts no more");
    }

    #[test]
    fn every_line_a_review_checked_reaches_its_saved_proxy() {
        let at = now_ms();
        let places = PlacesState::with(Library::default());
        let lines: Vec<String> = (0..200)
            .map(|i| format!("198.51.{}.{}:8080", i / 250, i % 250 + 1))
            .collect();
        for (i, line) in lines.iter().enumerate() {
            places.checked(
                line,
                Verdict {
                    ok: i % 3 != 0,
                    at,
                    ..Default::default()
                },
            );
        }
        let (ids, view) = places.add(&lines, at + 1);
        assert_eq!(ids.len(), 200);
        assert!(view.proxies.iter().all(|p| p.last.is_some()), "none reads not checked");
    }

    #[test]
    fn past_the_most_kept_the_oldest_check_is_let_go() {
        let mut recent = RecentChecks::default();
        let at = 1;
        for i in 0..=CHECKED_KEPT {
            recent.put(
                &format!("line {i}"),
                Verdict {
                    ok: true,
                    at,
                    ..Default::default()
                },
            );
        }
        assert!(recent.fresh("line 0", at).is_none(), "the first one went");
        assert!(recent.fresh(&format!("line {CHECKED_KEPT}"), at).is_some());
        recent.put(
            "line 5",
            Verdict {
                ok: false,
                at,
                ..Default::default()
            },
        );
        assert_eq!(
            recent.fresh("line 5", at).map(|v| v.ok),
            Some(false),
            "a line checked again keeps the newer answer"
        );
        assert_eq!(recent.by_line.len(), CHECKED_KEPT);
    }

    fn set_aside_files(dir: &Path) -> Vec<Vec<u8>> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("unreadable"))
            .map(|e| std::fs::read(e.path()).unwrap())
            .collect()
    }

    #[test]
    fn an_unreadable_library_is_set_aside_never_written_over() {
        let dir = std::env::temp_dir().join(format!("hproxy-places-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(store::path_in(&dir), b"not a library").unwrap();
        let opened = open_in(&dir);
        assert_eq!(opened.lib, Library::default());
        assert!(opened.notice.unwrap().contains("could not be read"));
        assert!(opened.dir.is_some(), "with the file out of the way, saving is safe");
        assert_eq!(set_aside_files(&dir), vec![b"not a library".to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_library_is_read_from_the_copy_before_and_that_copy_survives() {
        let dir = std::env::temp_dir().join(format!("hproxy-places-bak-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut lib = Library::default();
        lib.add_proxies(&["198.51.100.7:8080".to_string()], 1);
        store::save(&dir, &lib).unwrap();
        store::save(&dir, &lib).unwrap(); // the first write is now the backup
        std::fs::write(store::path_in(&dir), b"damaged").unwrap();
        let opened = open_in(&dir);
        assert_eq!(opened.lib.proxies.len(), 1);
        assert!(opened.notice.unwrap().contains("copy before"));
        assert_eq!(set_aside_files(&dir), vec![b"damaged".to_vec()]);

        // The next save must not copy the damaged file over the good backup.
        store::save(opened.dir.as_deref().unwrap(), &opened.lib).unwrap();
        assert_eq!(store::load_backup(&dir).unwrap().unwrap().proxies.len(), 1);
        assert_eq!(store::load(&dir).unwrap().unwrap().proxies.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
