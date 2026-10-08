//! Matching the computer's time zone to the exit while connected (Settings,
//! "Match my time zone to the exit"; the leak check's time zone line).
//!
//! All of it happens on this side. The window only says whether the setting
//! is on (`timezone_set_matching`, when it opens and on every change): the
//! Connect screen is not always open (each visit starts it fresh, and the tray
//! connects with the window hidden), and a match that waited for it would be
//! missed. After every probe through the relay that names the exit's zone,
//! connect.rs calls `follow_exit`. The zone comes back on every disconnect
//! (connect.rs `stop_running`), whichever way the app ends (`restore_on_exit`),
//! and at the next start after a crash (`repair_on_start`, from the record kept
//! on disk): the promise the system proxy makes, with its rule that a zone
//! changed by someone else since is left alone (`hproxy_system::timezone`).
//!
//! Once per exit zone, not once per probe: when Windows' automatic time zone,
//! or the person, sets another zone while connected, it is not fought over
//! every twenty seconds. The leak check says so, and "Match again" asks.
//!
//! Proven on Windows 11 (2026-09-28): a normal account switches the zone with
//! no prompt, and a running Chrome reads the new zone within seconds, no reload.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use hproxy_system::timezone::{self, SystemClock, ZoneClock, ZoneRestore, ZoneSnapshot};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct ZoneState {
    /// Settings, "Match my time zone to the exit", as the window last said.
    matching: AtomicBool,
    matched: Mutex<Matched>,
}

/// The match for the connection that is up. Plain data with its rules, so the
/// tests run them against a pretend clock.
#[derive(Default)]
struct Matched {
    /// The zone before our first change and the one we set last, while matched.
    snapshot: Option<ZoneSnapshot>,
    /// The exit zone (IANA) last matched or tried.
    followed: Option<String>,
    /// When the zone was last set (Unix ms): browsers take a moment to notice.
    at_ms: Option<u64>,
    /// Why the last match did not happen, in words.
    problem: Option<String>,
}

impl Matched {
    /// Match the computer to the exit's `zone`, once per exit zone. `record`
    /// keeps the snapshot on disk, or removes it for `None`.
    fn follow(&mut self, clock: &impl ZoneClock, zone: &str, now_ms: u64, mut record: impl FnMut(Option<&ZoneSnapshot>)) {
        if self.followed.as_deref() == Some(zone) {
            return;
        }
        self.followed = Some(zone.to_string());
        match timezone::match_zone(clock, zone, self.snapshot.as_ref(), |s| record(Some(s))) {
            // Already that zone.
            Ok(None) => self.problem = None,
            Ok(Some(snapshot)) => {
                self.snapshot = Some(snapshot);
                self.at_ms = Some(now_ms);
                self.problem = None;
            }
            Err(e) => {
                // The record may name the change that failed: the match in
                // place (or none) is the one to keep.
                record(self.snapshot.as_ref());
                self.problem = Some(e);
            }
        }
    }

    /// Put the zone back and forget this connection's match. `Some(words)`
    /// when it was left as it is, because someone else changed it since. When
    /// Windows refuses, the snapshot stays, in memory and on disk, for the
    /// next try: at quit, or at the next start.
    fn restore(&mut self, clock: &impl ZoneClock, mut record: impl FnMut(Option<&ZoneSnapshot>)) -> Result<Option<String>, String> {
        let snapshot = std::mem::take(self).snapshot;
        let Some(snapshot) = snapshot else { return Ok(None) };
        match timezone::restore_zone(clock, &snapshot) {
            Ok(outcome) => {
                record(None);
                Ok(match outcome {
                    ZoneRestore::Restored => None,
                    ZoneRestore::LeftAlone { now } => {
                        Some(format!("The time zone was changed to {now} while connected, so it was left as it is."))
                    }
                })
            }
            Err(e) => {
                self.snapshot = Some(snapshot);
                Err(e)
            }
        }
    }
}

/// What the window shows about the time zone match.
#[derive(Serialize, Clone)]
pub struct ZoneStatus {
    /// This computer can match its zone from here (Windows).
    pub supported: bool,
    /// The setting is on.
    pub matching: bool,
    /// The Windows zone we set, while matched.
    pub matched: Option<String>,
    /// When it was set (Unix ms).
    pub matched_at_ms: Option<u64>,
    /// "Set time zone automatically" is on: Windows may put its own zone back.
    pub automatic: bool,
    /// Why the last match did not happen, in words.
    pub problem: Option<String>,
    /// What happened, in words, when it is worth saying.
    pub note: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn record_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("timezone-snapshot.json"))
}

/// The snapshot on disk for a crash to find, or no file for `None`.
fn record(app: &AppHandle, snapshot: Option<&ZoneSnapshot>) {
    let Some(path) = record_path(app) else { return };
    match snapshot {
        Some(s) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(json) = serde_json::to_string(s) {
                if let Err(e) = std::fs::write(&path, json) {
                    log::warn!("could not keep the time zone snapshot: {e}");
                }
            }
        }
        None => {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn status(app: &AppHandle, note: Option<String>) -> ZoneStatus {
    let state = app.state::<ZoneState>();
    let m = state.matched.lock().ok();
    ZoneStatus {
        supported: cfg!(windows),
        matching: state.matching.load(Ordering::SeqCst),
        matched: m.as_ref().and_then(|m| m.snapshot.as_ref().map(|s| s.ours.clone())),
        matched_at_ms: m.as_ref().and_then(|m| m.at_ms),
        automatic: timezone::automatic_zone_on(),
        problem: m.as_ref().and_then(|m| m.problem.clone()),
        note,
    }
}

/// Whether a probe's zone is worth handing over: the setting is on, here.
pub fn is_matching(app: &AppHandle) -> bool {
    cfg!(windows) && app.state::<ZoneState>().matching.load(Ordering::SeqCst)
}

/// After a probe through the relay started at `session` named the exit's zone
/// (connect.rs): match the computer to it. Blocking (Windows' `tzutil`), so
/// never on the async threads.
pub fn follow_exit(app: &AppHandle, session: u64, zone: &str) {
    if !cfg!(windows) {
        return;
    }
    let state = app.state::<ZoneState>();
    let Ok(mut m) = state.matched.lock() else { return };
    // Checked under the lock: a disconnect or a switch-off that came first
    // wins, and one that comes after waits for this match and puts it back.
    // The session keeps a probe of a relay already replaced from matching.
    if !state.matching.load(Ordering::SeqCst) || crate::connect::session(app) != Some(session) {
        return;
    }
    let before = m.snapshot.clone();
    m.follow(&SystemClock, zone, now_ms(), |s| record(app, s));
    match (&m.problem, &m.snapshot) {
        (Some(p), _) => log::warn!("the time zone could not be matched to {zone}: {p}"),
        (None, Some(s)) if before.as_ref() != Some(s) => log::info!("time zone matched to the exit: {} ({zone})", s.ours),
        _ => {}
    }
}

/// The matching on and off (Settings). On: matched at once when connected and
/// the exit's zone is known. Off: put back at once.
#[tauri::command]
pub async fn timezone_set_matching(app: AppHandle, on: bool) -> Result<ZoneStatus, String> {
    app.state::<ZoneState>().matching.store(on, Ordering::SeqCst);
    let handle = app.clone();
    let note = tauri::async_runtime::spawn_blocking(move || {
        if on {
            if let Some((session, zone)) = crate::connect::exit_zone(&handle) {
                follow_exit(&handle, session, &zone);
            }
            None
        } else {
            restore(&handle).unwrap_or_else(|e| Some(format!("The time zone could not be put back: {e}.")))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(status(&app, note))
}

/// "Match again" (the leak check), after Windows or the person set another
/// zone while connected, or after a match failed.
#[tauri::command]
pub async fn timezone_match_again(app: AppHandle) -> Result<ZoneStatus, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(mut m) = handle.state::<ZoneState>().matched.lock() {
            m.followed = None;
            m.problem = None;
        }
        if let Some((session, zone)) = crate::connect::exit_zone(&handle) {
            follow_exit(&handle, session, &zone);
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(status(&app, None))
}

/// The match as it stands, for the window.
#[tauri::command]
pub async fn timezone_status(app: AppHandle) -> ZoneStatus {
    status(&app, None)
}

/// The restore behind disconnect, quit and switching the setting off:
/// `Some(words)` when the zone was left as it is because someone else changed
/// it since. Blocking (Windows' `tzutil`).
pub fn restore(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<ZoneState>();
    let mut m = state.matched.lock().map_err(|_| "the time zone state is unavailable".to_string())?;
    m.restore(&SystemClock, |s| record(app, s))
}

/// At start: a snapshot on disk means the app ended while matched (a crash, a
/// shutdown): put the zone back before anything else. When Windows refuses,
/// the snapshot stays for the next try, and a new match keeps its `before`.
pub fn repair_on_start(app: &AppHandle) -> Option<String> {
    let path = record_path(app)?;
    let snapshot: ZoneSnapshot = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    match timezone::restore_zone(&SystemClock, &snapshot) {
        Ok(outcome) => {
            let _ = std::fs::remove_file(&path);
            Some(match outcome {
                ZoneRestore::Restored => format!("put the time zone back to {} after the last run", snapshot.before),
                ZoneRestore::LeftAlone { now } => format!("left the time zone at {now}: it was changed after the last run"),
            })
        }
        Err(e) => {
            let words = format!("could not put the time zone back to {}: {e}", snapshot.before);
            if let Ok(mut m) = app.state::<ZoneState>().matched.lock() {
                m.snapshot = Some(snapshot);
            }
            Some(words)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    const BERLIN: &str = "W. Europe Standard Time";
    const CHICAGO: &str = "Central Standard Time";
    const TOKYO: &str = "Tokyo Standard Time";

    /// A pretend computer clock.
    struct Clock {
        zone: RefCell<String>,
        refuse: Cell<bool>,
    }

    impl Clock {
        fn at(zone: &str) -> Self {
            Clock { zone: RefCell::new(zone.into()), refuse: Cell::new(false) }
        }
        fn now(&self) -> String {
            self.zone.borrow().clone()
        }
    }

    impl ZoneClock for Clock {
        fn current(&self) -> Result<String, String> {
            Ok(self.now())
        }
        fn set(&self, zone: &str) -> Result<(), String> {
            if self.refuse.get() {
                return Err("Windows refused the time zone change (access denied)".into());
            }
            *self.zone.borrow_mut() = zone.into();
            Ok(())
        }
    }

    /// What is on disk, as `record` leaves it.
    #[derive(Default)]
    struct Disk(Option<ZoneSnapshot>);

    impl Disk {
        fn keep(&mut self) -> impl FnMut(Option<&ZoneSnapshot>) + '_ {
            |s| self.0 = s.cloned()
        }
    }

    #[test]
    fn an_exit_is_matched_once_and_not_fought_over() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        assert_eq!(clock.now(), CHICAGO);
        assert_eq!(m.at_ms, Some(1));
        assert_eq!(disk.0, Some(ZoneSnapshot { before: BERLIN.into(), ours: CHICAGO.into() }));
        // Windows' automatic time zone puts its own back: the next probe of the
        // same exit leaves it alone.
        *clock.zone.borrow_mut() = BERLIN.into();
        m.follow(&clock, "America/Chicago", 2, disk.keep());
        assert_eq!(clock.now(), BERLIN);
        // "Match again" forgets the exit followed, and the next follow sets it.
        m.followed = None;
        m.follow(&clock, "America/Chicago", 3, disk.keep());
        assert_eq!(clock.now(), CHICAGO);
        assert_eq!(disk.0.as_ref().map(|s| s.before.as_str()), Some(BERLIN));
    }

    #[test]
    fn a_new_exit_moves_the_zone_and_the_first_zone_comes_back() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        m.follow(&clock, "Asia/Tokyo", 2, disk.keep());
        assert_eq!(clock.now(), TOKYO);
        assert_eq!(disk.0, Some(ZoneSnapshot { before: BERLIN.into(), ours: TOKYO.into() }));
        assert_eq!(m.restore(&clock, disk.keep()), Ok(None));
        assert_eq!(clock.now(), BERLIN);
        assert_eq!(disk.0, None);
        // Forgotten: the next connection to the same exit matches again.
        assert_eq!(m.followed, None);
    }

    #[test]
    fn a_refused_match_says_why_and_keeps_the_match_in_place() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        clock.refuse.set(true);
        m.follow(&clock, "Asia/Tokyo", 2, disk.keep());
        assert!(m.problem.as_deref().is_some_and(|p| p.contains("refused")));
        assert_eq!(clock.now(), CHICAGO);
        // The record names the match in place, not the one that failed.
        assert_eq!(disk.0, Some(ZoneSnapshot { before: BERLIN.into(), ours: CHICAGO.into() }));
    }

    #[test]
    fn a_refused_first_match_leaves_nothing_to_put_back() {
        let clock = Clock::at(BERLIN);
        clock.refuse.set(true);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        assert!(m.problem.is_some());
        assert_eq!(disk.0, None);
        assert_eq!(m.restore(&clock, disk.keep()), Ok(None));
        assert_eq!(m.problem, None, "a new connection starts clean");
    }

    #[test]
    fn a_zone_changed_while_connected_is_left_as_it_is() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        *clock.zone.borrow_mut() = "Pacific Standard Time".into();
        let words = m.restore(&clock, disk.keep()).unwrap().unwrap();
        assert!(words.contains("Pacific Standard Time"), "{words}");
        assert_eq!(clock.now(), "Pacific Standard Time");
        assert_eq!(disk.0, None);
    }

    #[test]
    fn a_refused_restore_is_kept_for_the_next_try() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "America/Chicago", 1, disk.keep());
        clock.refuse.set(true);
        assert!(m.restore(&clock, disk.keep()).is_err());
        assert!(disk.0.is_some(), "the record stays for the next start");
        clock.refuse.set(false);
        assert_eq!(m.restore(&clock, disk.keep()), Ok(None));
        assert_eq!(clock.now(), BERLIN);
        assert_eq!(disk.0, None);
    }

    #[test]
    fn an_exit_in_the_zone_already_shown_changes_nothing() {
        let clock = Clock::at(BERLIN);
        let (mut m, mut disk) = (Matched::default(), Disk::default());
        m.follow(&clock, "Europe/Berlin", 1, disk.keep());
        assert_eq!(m.snapshot, None);
        assert_eq!(disk.0, None);
        assert_eq!(m.restore(&clock, disk.keep()), Ok(None));
    }
}
