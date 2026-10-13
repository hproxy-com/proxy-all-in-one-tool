//! Where the library lives: one file in the app's own data folder.
//!
//! It is written whole to a file beside it and then swapped in, so a crash in
//! the middle of a write leaves the last good copy where it was; the copy
//! before that is kept as `places.dat.bak`, so a bad write is one rename away
//! from undone.
//!
//! On Windows the file is sealed with the person's own Windows login (DPAPI,
//! the same protection browsers give saved passwords): another account on the
//! computer, or the file copied to another computer, reads nothing. Elsewhere
//! it is readable by the person's account only (mode 0600), inside a folder
//! that belongs to the app; on a phone that folder is private to the app.
//!
//! The file starts with `HPXP` and a byte that says how the rest is kept, so
//! a later version can change the sealing and still read what is there.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::library::Library;

/// The desktop app's identifier, which names its data folder on every system
/// (desktop-app/src-tauri/tauri.conf.json, `identifier`; a test there keeps
/// the two the same).
pub const APP_ID: &str = "com.hproxy.checker";

/// The folder the desktop app keeps the library in, and the one every other
/// door (the command line, the AI assistant's tool) reads it from: the
/// system's folder for programs' data, then [`APP_ID`]. That is `%APPDATA%` on
/// Windows, `~/Library/Application Support` on macOS, `$XDG_DATA_HOME` or
/// `~/.local/share` elsewhere: the same place the app's framework gives it.
/// `HPROXY_PLACES_DIR` names another folder, which is what tests use. `None`
/// when the system names no such folder.
pub fn app_dir() -> Option<PathBuf> {
    app_dir_from(|key| std::env::var_os(key))
}

fn app_dir_from(var: impl Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    let set = |key: &str| var(key).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = set("HPROXY_PLACES_DIR") {
        return Some(dir);
    }
    let base = if cfg!(windows) {
        set("APPDATA")
    } else if cfg!(target_os = "macos") {
        set("HOME").map(|h| h.join("Library/Application Support"))
    } else {
        // A relative XDG_DATA_HOME is ignored, as the specification says.
        set("XDG_DATA_HOME")
            .filter(|d| d.is_absolute())
            .or_else(|| set("HOME").map(|h| h.join(".local/share")))
    };
    base.map(|b| b.join(APP_ID))
}

/// The library's file, in the folder the app gives it.
pub const FILE: &str = "places.dat";
/// The copy kept from before the last write.
pub const BACKUP: &str = "places.dat.bak";
const MAGIC: &[u8; 4] = b"HPXP";
/// The rest is JSON as it is.
const PLAIN: u8 = 0;
/// The rest is JSON sealed with the Windows login (DPAPI).
const SEALED_WINDOWS: u8 = 1;

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// The library kept in `dir`, or `None` when there is none yet.
pub fn load(dir: &Path) -> Result<Option<Library>, String> {
    read(&path_in(dir))
}

/// The copy from before the last write, for when the library cannot be read.
pub fn load_backup(dir: &Path) -> Result<Option<Library>, String> {
    read(&dir.join(BACKUP))
}

/// Move a library that cannot be read out of the way, under a name of its
/// own (`places.dat.unreadable-<stamp>`). Left in place, the next save would
/// copy it over the backup, the one good copy left. Returns where it went.
pub fn set_aside(dir: &Path, stamp: u64) -> Result<PathBuf, String> {
    let aside = dir.join(format!("{FILE}.unreadable-{stamp}"));
    std::fs::rename(path_in(dir), &aside)
        .map(|_| aside)
        .map_err(|e| format!("could not move {} aside: {e}", path_in(dir).display()))
}

fn read(path: &Path) -> Result<Option<Library>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let json = open(&bytes)?;
    serde_json::from_slice(&json)
        .map(Some)
        .map_err(|e| format!("{} could not be read: {e}", path.display()))
}

/// Keep `library` in `dir`: write it beside the file, keep the copy that was
/// there as the backup, then swap the new one in.
pub fn save(dir: &Path, library: &Library) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let json = serde_json::to_vec(library).map_err(|e| format!("could not write the library: {e}"))?;
    let body = seal(&json)?;
    let path = path_in(dir);
    let fresh = dir.join(format!("{FILE}.new"));
    write_private(&fresh, &body)?;
    if path.exists() {
        let _ = std::fs::copy(&path, dir.join(BACKUP));
    }
    std::fs::rename(&fresh, &path).map_err(|e| format!("could not put {} in place: {e}", path.display()))
}

/// The file's bytes: the header, then the sealed JSON.
fn seal(json: &[u8]) -> Result<Vec<u8>, String> {
    let (how, rest) = seal_for_this_system(json)?;
    let mut out = Vec::with_capacity(5 + rest.len());
    out.extend_from_slice(MAGIC);
    out.push(how);
    out.extend_from_slice(&rest);
    Ok(out)
}

/// The JSON out of the file's bytes.
fn open(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 5 || &bytes[..4] != MAGIC {
        return Err("the library file is not one this app wrote".into());
    }
    match bytes[4] {
        PLAIN => Ok(bytes[5..].to_vec()),
        SEALED_WINDOWS => open_sealed_windows(&bytes[5..]),
        other => Err(format!(
            "the library file was written a newer way ({other}); update the app to read it"
        )),
    }
}

#[cfg(windows)]
fn seal_for_this_system(json: &[u8]) -> Result<(u8, Vec<u8>), String> {
    dpapi::protect(json).map(|b| (SEALED_WINDOWS, b))
}

#[cfg(not(windows))]
fn seal_for_this_system(json: &[u8]) -> Result<(u8, Vec<u8>), String> {
    Ok((PLAIN, json.to_vec()))
}

#[cfg(windows)]
fn open_sealed_windows(sealed: &[u8]) -> Result<Vec<u8>, String> {
    dpapi::unprotect(sealed)
}

#[cfg(not(windows))]
fn open_sealed_windows(_sealed: &[u8]) -> Result<Vec<u8>, String> {
    Err("the library file was sealed by Windows and can only be opened there".into())
}

#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    f.write_all(body)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let mut f = std::fs::File::create(path).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    f.write_all(body)
        .and_then(|_| f.sync_all())
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// The Windows login's own sealing (CryptProtectData, user scope, no prompt).
#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Copy what Windows handed back and give its memory back to it.
    ///
    /// SAFETY: `out` is a blob Windows filled in a successful call: `pbData`
    /// points at `cbData` bytes it allocated with LocalAlloc.
    unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(plain);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: `input` points at `plain`, alive for the call; the other
        // pointers are the documented optional nulls; Windows fills `out`.
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "Windows could not seal the library ({})",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: the call succeeded, so `out` is Windows' allocation.
        Ok(unsafe { take(out) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(sealed);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err(format!(
                "the library is sealed to another Windows login or was damaged ({})",
                std::io::Error::last_os_error()
            ));
        }
        // SAFETY: the call succeeded, so `out` is Windows' allocation.
        Ok(unsafe { take(out) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hproxy-places-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn nothing_there_reads_as_none() {
        let dir = scratch("empty");
        assert_eq!(load(&dir).unwrap(), None);
    }

    #[test]
    fn every_door_finds_the_library_in_the_apps_own_data_folder() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| pairs.iter().find(|(k, _)| *k == key).map(|(_, v)| OsString::from(v))
        };
        assert_eq!(
            app_dir_from(env(&[
                ("HPROXY_PLACES_DIR", "/tmp/places"),
                ("APPDATA", "/a"),
                ("HOME", "/h")
            ])),
            Some(PathBuf::from("/tmp/places")),
            "the override wins"
        );
        assert_eq!(app_dir_from(env(&[])), None, "no folder named, no guess");
        #[cfg(windows)]
        assert_eq!(
            app_dir_from(env(&[("APPDATA", r"C:\Users\a\AppData\Roaming")])),
            Some(PathBuf::from(r"C:\Users\a\AppData\Roaming\com.hproxy.checker"))
        );
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            assert_eq!(
                app_dir_from(env(&[("HOME", "/home/a")])),
                Some(PathBuf::from("/home/a/.local/share/com.hproxy.checker"))
            );
            assert_eq!(
                app_dir_from(env(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "relative")])),
                Some(PathBuf::from("/home/a/.local/share/com.hproxy.checker")),
                "a relative XDG_DATA_HOME is not a place"
            );
        }
    }

    #[test]
    fn a_library_round_trips_and_the_previous_copy_is_kept() {
        let dir = scratch("round-trip");
        let mut lib = Library::default();
        lib.add_proxies(&["198.51.100.1:8080:alice:hunter2".to_string()], 1);
        save(&dir, &lib).unwrap();
        assert_eq!(load(&dir).unwrap(), Some(lib.clone()));

        lib.add_proxies(&["198.51.100.2:8080".to_string()], 2);
        save(&dir, &lib).unwrap();
        assert_eq!(load(&dir).unwrap().unwrap().proxies.len(), 2);
        assert!(dir.join("places.dat.bak").exists(), "the copy before is kept");
        assert!(!dir.join("places.dat.new").exists(), "nothing half-written is left");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_password_is_not_in_the_file() {
        let dir = scratch("sealed");
        let mut lib = Library::default();
        lib.add_proxies(&["198.51.100.1:8080:alice:hunter2".to_string()], 1);
        save(&dir, &lib).unwrap();
        let bytes = std::fs::read(path_in(&dir)).unwrap();
        assert_eq!(bytes[4], SEALED_WINDOWS);
        assert!(
            !bytes.windows(7).any(|w| w == b"hunter2"),
            "the file must be sealed, not plain text"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_this_app_did_not_write_is_refused_not_read() {
        let dir = scratch("foreign");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(path_in(&dir), b"{\"proxies\":[]}").unwrap();
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
