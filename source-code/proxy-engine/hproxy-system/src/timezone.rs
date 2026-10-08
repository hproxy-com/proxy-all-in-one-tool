//! The computer's time zone, matched to the exit's place while connected and
//! put back exactly as found. Sites read the clock's zone and compare it with
//! the address (the Connect panel's leak check); a Berlin clock behind a
//! Chicago address gives the proxy away.
//!
//! Windows only. The zone is one setting for the whole computer, and every
//! signed-in user may change it: Windows gives the "Change the time zone" right
//! to Users, so there is no prompt (`whoami /priv` lists it as present). The
//! change goes through Windows' own `tzutil`, which switches that right on for
//! itself. Everywhere else [`SystemClock`] says it cannot, and the leak check
//! only advises.
//!
//! The same rule as the proxy setting: a change starts with a [`ZoneSnapshot`]
//! of the zone before it, handed out BEFORE the change so a crash between the
//! two still leaves a record, and a restore leaves the zone alone when it is no
//! longer ours (the person, or Windows' automatic time zone, changed it since).
//! A record of a change that never happened is harmless for the same reason:
//! the zone is not the one it names as ours, so nothing is put back.

use serde::{Deserialize, Serialize};

use crate::windows_zones::WINDOWS_ZONES;

/// The zone before we changed it, and the one we set, as Windows names them
/// ("W. Europe Standard Time").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ZoneSnapshot {
    pub before: String,
    pub ours: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ZoneRestore {
    Restored,
    /// Changed by someone else since we set it: left as it is.
    LeftAlone { now: String },
}

/// Reading and setting the computer's zone: Windows' own in the app
/// ([`SystemClock`]), a pretend one in tests.
pub trait ZoneClock {
    /// The zone as Windows names it.
    fn current(&self) -> Result<String, String>;
    fn set(&self, zone: &str) -> Result<(), String>;
}

/// This computer's clock, through Windows' `tzutil`. Elsewhere every call
/// answers that the zone can only be matched on Windows.
pub struct SystemClock;

impl ZoneClock for SystemClock {
    fn current(&self) -> Result<String, String> {
        platform::current()
    }

    fn set(&self, zone: &str) -> Result<(), String> {
        platform::set(zone)
    }
}

/// The Windows zone that keeps the same time as an IANA zone
/// ("America/Chicago" is "Central Standard Time"), from CLDR's table.
pub fn windows_zone_for(iana: &str) -> Option<&'static str> {
    WINDOWS_ZONES
        .binary_search_by(|(name, _)| name.cmp(&iana))
        .ok()
        .map(|i| WINDOWS_ZONES[i].1)
}

/// Set the computer's zone to the one that keeps `iana`'s time.
///
/// `earlier` is a match still in place (the exit before this one): its
/// `before` stays the zone that comes back. `record` receives the snapshot
/// before the zone is touched, to keep it on disk. Already that zone: nothing
/// is changed, nothing is recorded, and there is nothing new to put back
/// (`None`). After an error the zone is as it was, and the caller records
/// `earlier` again.
pub fn match_zone(
    clock: &impl ZoneClock,
    iana: &str,
    earlier: Option<&ZoneSnapshot>,
    record: impl FnOnce(&ZoneSnapshot),
) -> Result<Option<ZoneSnapshot>, String> {
    let target = windows_zone_for(iana).ok_or_else(|| format!("Windows has no time zone for {iana}"))?;
    let now = clock.current()?;
    if same_zone(&now, target) {
        return Ok(None);
    }
    let snapshot = ZoneSnapshot {
        before: earlier.map_or(now, |e| e.before.clone()),
        ours: target.to_string(),
    };
    record(&snapshot);
    clock.set(target)?;
    let set = clock.current()?;
    if !same_zone(&set, target) {
        return Err(format!("Windows kept {set} instead of {target}"));
    }
    Ok(Some(snapshot))
}

/// Put the zone back, unless it is no longer the one we set.
pub fn restore_zone(clock: &impl ZoneClock, snapshot: &ZoneSnapshot) -> Result<ZoneRestore, String> {
    let now = clock.current()?;
    if !same_zone(&now, &snapshot.ours) {
        return Ok(ZoneRestore::LeftAlone { now });
    }
    clock.set(&snapshot.before)?;
    Ok(ZoneRestore::Restored)
}

/// Whether Windows sets the zone by itself from the computer's location
/// ("Set time zone automatically"). While it is on, Windows may put its own
/// zone back in the middle of a connection.
pub fn automatic_zone_on() -> bool {
    platform::automatic()
}

/// `tzutil /g` adds `_dstoff` when daylight saving is switched off for a zone;
/// it is the same zone.
pub fn same_zone(a: &str, b: &str) -> bool {
    a.trim_end_matches("_dstoff").eq_ignore_ascii_case(b.trim_end_matches("_dstoff"))
}

#[cfg(windows)]
mod platform {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    /// No console window flashing up from the windowed app.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// Windows' own tool, by its full path: never whatever `tzutil` is first on the PATH.
    fn tzutil(args: &[&str]) -> Result<String, String> {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let out = Command::new(format!(r"{root}\System32\tzutil.exe"))
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("could not run tzutil: {e}"))?;
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr);
            let why = if why.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { why };
            return Err(format!("Windows refused the time zone change ({})", why.trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn current() -> Result<String, String> {
        let zone = tzutil(&["/g"])?;
        if zone.is_empty() {
            return Err("Windows did not say which time zone is set".into());
        }
        Ok(zone)
    }

    pub fn set(zone: &str) -> Result<(), String> {
        tzutil(&["/s", zone]).map(|_| ())
    }

    /// The automatic time zone service starts on demand (3) when the setting
    /// is on, and is disabled (4) when it is off.
    pub fn automatic() -> bool {
        winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey(r"SYSTEM\CurrentControlSet\Services\tzautoupdate")
            .and_then(|k| k.get_value::<u32, _>("Start"))
            .is_ok_and(|start| start == 3)
    }
}

#[cfg(not(windows))]
mod platform {
    const WHY: &str = "the time zone can only be matched from here on Windows";

    pub fn current() -> Result<String, String> {
        Err(WHY.into())
    }

    pub fn set(_zone: &str) -> Result<(), String> {
        Err(WHY.into())
    }

    pub fn automatic() -> bool {
        false
    }
}

/// A pretend clock for tests: a zone in memory, and every change it was asked for.
#[cfg(test)]
pub(crate) mod fake {
    use super::ZoneClock;
    use std::cell::RefCell;

    pub struct FakeClock {
        pub zone: RefCell<String>,
        pub sets: RefCell<Vec<String>>,
        /// Refuse every change, the way a managed computer's policy can.
        pub refuse: bool,
        /// Take a change but keep this zone instead.
        pub keeps: Option<String>,
    }

    impl FakeClock {
        pub fn at(zone: &str) -> Self {
            FakeClock { zone: RefCell::new(zone.into()), sets: RefCell::new(Vec::new()), refuse: false, keeps: None }
        }
    }

    impl ZoneClock for FakeClock {
        fn current(&self) -> Result<String, String> {
            Ok(self.zone.borrow().clone())
        }

        fn set(&self, zone: &str) -> Result<(), String> {
            if self.refuse {
                return Err("Windows refused the time zone change (access denied)".into());
            }
            self.sets.borrow_mut().push(zone.into());
            *self.zone.borrow_mut() = self.keeps.clone().unwrap_or_else(|| zone.into());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeClock;
    use super::*;

    const BERLIN: &str = "W. Europe Standard Time";
    const CHICAGO: &str = "Central Standard Time";
    const TOKYO: &str = "Tokyo Standard Time";

    #[test]
    fn every_zone_the_ip_api_names_has_its_windows_zone() {
        assert_eq!(windows_zone_for("America/Chicago"), Some(CHICAGO));
        assert_eq!(windows_zone_for("Europe/Berlin"), Some(BERLIN));
        assert_eq!(windows_zone_for("Asia/Tokyo"), Some(TOKYO));
        // Today's names of zones CLDR writes under their old ones.
        assert_eq!(windows_zone_for("Asia/Kolkata"), Some("India Standard Time"));
        assert_eq!(windows_zone_for("Europe/Kyiv"), Some("FLE Standard Time"));
        assert_eq!(windows_zone_for("Not/AZone"), None);
    }

    #[test]
    fn the_table_is_sorted_for_the_search() {
        assert!(WINDOWS_ZONES.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn a_zone_without_daylight_saving_is_the_same_zone() {
        assert!(same_zone("W. Europe Standard Time_dstoff", BERLIN));
        assert!(!same_zone(BERLIN, CHICAGO));
    }

    #[test]
    fn the_record_comes_before_the_change() {
        let clock = FakeClock::at(BERLIN);
        let mut seen = None;
        let snap = match_zone(&clock, "America/Chicago", None, |s| {
            // What the clock showed when the record was handed out.
            seen = Some((s.clone(), clock.zone.borrow().clone()));
        })
        .unwrap()
        .unwrap();
        let (recorded, zone_then) = seen.expect("a change is recorded");
        assert_eq!(zone_then, BERLIN, "recorded before the zone moved");
        assert_eq!(recorded, snap);
        assert_eq!(snap, ZoneSnapshot { before: BERLIN.into(), ours: CHICAGO.into() });
        assert_eq!(*clock.zone.borrow(), CHICAGO);
    }

    #[test]
    fn a_zone_already_right_is_not_touched_or_recorded() {
        let clock = FakeClock::at(CHICAGO);
        let snap = match_zone(&clock, "America/Chicago", None, |_| panic!("nothing to record")).unwrap();
        assert_eq!(snap, None);
        assert!(clock.sets.borrow().is_empty());
    }

    #[test]
    fn the_next_exit_keeps_the_zone_from_before_the_first_one() {
        let clock = FakeClock::at(BERLIN);
        let first = match_zone(&clock, "America/Chicago", None, |_| {}).unwrap().unwrap();
        let second = match_zone(&clock, "Asia/Tokyo", Some(&first), |_| {}).unwrap().unwrap();
        assert_eq!(second, ZoneSnapshot { before: BERLIN.into(), ours: TOKYO.into() });
        assert_eq!(restore_zone(&clock, &second).unwrap(), ZoneRestore::Restored);
        assert_eq!(*clock.zone.borrow(), BERLIN);
    }

    #[test]
    fn a_refused_change_is_an_error_and_the_zone_stays() {
        let clock = FakeClock { refuse: true, ..FakeClock::at(BERLIN) };
        let err = match_zone(&clock, "America/Chicago", None, |_| {}).unwrap_err();
        assert!(err.contains("refused"), "{err}");
        assert_eq!(*clock.zone.borrow(), BERLIN);
    }

    #[test]
    fn a_zone_windows_did_not_take_is_an_error() {
        let clock = FakeClock { keeps: Some(BERLIN.into()), ..FakeClock::at(BERLIN) };
        let err = match_zone(&clock, "America/Chicago", None, |_| {}).unwrap_err();
        assert_eq!(err, format!("Windows kept {BERLIN} instead of {CHICAGO}"));
    }

    #[test]
    fn an_unknown_zone_is_an_error_and_nothing_changes() {
        let clock = FakeClock::at(BERLIN);
        let err = match_zone(&clock, "Not/AZone", None, |_| panic!("nothing to record")).unwrap_err();
        assert_eq!(err, "Windows has no time zone for Not/AZone");
        assert!(clock.sets.borrow().is_empty());
    }

    #[test]
    fn a_zone_changed_since_is_left_alone() {
        let clock = FakeClock::at(BERLIN);
        let snap = match_zone(&clock, "America/Chicago", None, |_| {}).unwrap().unwrap();
        // Windows' automatic time zone, or the person, moved it on.
        *clock.zone.borrow_mut() = "Pacific Standard Time".into();
        let sets = clock.sets.borrow().len();
        assert_eq!(restore_zone(&clock, &snap).unwrap(), ZoneRestore::LeftAlone { now: "Pacific Standard Time".into() });
        assert_eq!(clock.sets.borrow().len(), sets, "nothing set");
    }

    #[test]
    fn a_record_of_a_change_that_never_happened_restores_nothing() {
        // The app died between the record and the change: the zone is still
        // the one from before, so the record's `ours` is not it.
        let clock = FakeClock::at(BERLIN);
        let record = ZoneSnapshot { before: BERLIN.into(), ours: CHICAGO.into() };
        assert_eq!(restore_zone(&clock, &record).unwrap(), ZoneRestore::LeftAlone { now: BERLIN.into() });
        assert!(clock.sets.borrow().is_empty());
    }

    /// The real thing, by hand only: this computer's clock goes to Tokyo time
    /// for a moment and back, through the code the app uses.
    /// `cargo test -p hproxy-system -- --ignored --nocapture live_`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_match_and_restore_round_trip() {
        /// Whatever happens below, the zone goes back.
        struct PutBack(String);
        impl Drop for PutBack {
            fn drop(&mut self) {
                let _ = platform::set(&self.0);
            }
        }
        let clock = SystemClock;
        let before = clock.current().unwrap();
        let _put_back = PutBack(before.clone());
        let snapshot = match_zone(&clock, "Asia/Tokyo", None, |s| {
            assert_eq!(clock.current().unwrap(), s.before, "recorded before the change");
        })
        .unwrap()
        .expect("this computer already shows Tokyo time");
        assert_eq!(snapshot.before, before);
        assert!(same_zone(&clock.current().unwrap(), TOKYO));
        // Matching again to the zone already set changes nothing.
        assert_eq!(match_zone(&clock, "Asia/Tokyo", Some(&snapshot), |_| {}).unwrap(), None);
        assert_eq!(restore_zone(&clock, &snapshot).unwrap(), ZoneRestore::Restored);
        assert_eq!(clock.current().unwrap(), before);
        println!("matched to {} and put back to {before}", snapshot.ours);
    }

    #[test]
    fn a_snapshot_round_trips_through_json() {
        let s = ZoneSnapshot { before: BERLIN.into(), ours: CHICAGO.into() };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(serde_json::from_str::<ZoneSnapshot>(&json).unwrap(), s);
    }
}
