//! The copy of this program an AI assistant runs (Use with AI).
//!
//! An update's installer ends every running copy of the app's own program by
//! name and then replaces the file (target/release/nsis/x64, CheckIfAppIsRunning).
//! An assistant keeps its tool running for as long as it is open, so a tool that
//! IS the app's program either holds every update back or is ended in the middle
//! of the assistant's work. Windows cannot overwrite a running program but can
//! rename one (measured on Windows 11, 2026-09-24), so on Windows the tool is a
//! copy outside the install folder, under a name of its own (`hproxy.exe`): the
//! installer never touches it. After an update the app refreshes the copy,
//! moving a running one aside first; the assistant's session goes on with the
//! old copy and gets the new one the next time it starts the tool, so an update
//! never waits for the assistant.
//!
//! Beside the copy, `copied-from.txt` names the app's program (so the tool's
//! `hproxy app`, the assistant's wake-up, can start it) and the build copied.
//!
//! The copy's folder goes on the user's PATH, once, so every setup the Use with
//! AI tab hands out says `hproxy` and holds no file path: the tab holds only
//! things to copy and paste. The uninstaller takes the folder back off the PATH
//! (windows/installer-hooks.nsh).
//!
//! macOS and Linux swap an app's files under a running program without ending
//! it, so there the tool is the app's own program (on Linux the AppImage file,
//! not the mount it runs from). A debug build is its own tool as well: it
//! changes on every build and weighs ten times more.

#[cfg(windows)]
use std::path::Path;
use std::path::PathBuf;
#[cfg(windows)]
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

/// The copy's file name. The copy, and everything below that makes it, exists
/// on Windows only.
#[cfg(windows)]
const PROGRAM: &str = "hproxy.exe";
/// A copy moved aside while it ran; a later start removes it once nothing runs it.
#[cfg(windows)]
const ASIDE_PREFIX: &str = "hproxy-old-";
/// Written beside the copy once its folder has gone on the user's PATH. When the
/// folder is later missing from the PATH, the person took it off: it is not put
/// back, and setups name the copy's full path instead. The uninstaller removes
/// the PATH entry and this note together (windows/installer-hooks.nsh).
#[cfg(windows)]
const ON_PATH_NOTE: &str = "on-path.txt";

/// Where an assistant should start the tool: the copy on Windows (made or
/// brought up to date first), elsewhere the app's own program.
pub fn path(app: &AppHandle) -> Option<PathBuf> {
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        if let Some(copy) = ensure_copy(app) {
            return Some(copy);
        }
    }
    #[cfg(target_os = "linux")]
    if let Some(image) = std::env::var_os("APPIMAGE") {
        return Some(PathBuf::from(image));
    }
    let _ = app;
    std::env::current_exe().ok()
}

/// What an assistant's setup names to start the tool: `hproxy` where the copy's
/// folder is on the user's PATH (Windows, put there by `ensure_on_path`), the
/// same words on every computer; otherwise the program's full path.
pub fn command(app: &AppHandle) -> Option<String> {
    // The Microsoft Store copy: the package declares `hproxy` as its command
    // (store/microsoft-store/msix/AppxManifest.xml), and Windows keeps that on
    // the PATH itself. A copy in AppData would be private to the package, and so
    // would a PATH change (src/store.rs).
    if crate::store::is_store_install() {
        return Some("hproxy".into());
    }
    let program = path(app)?;
    #[cfg(windows)]
    if program
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(PROGRAM))
    {
        if let Some(dir) = program.parent() {
            if user_path_has(dir) {
                return Some("hproxy".into());
            }
        }
    }
    Some(program.to_string_lossy().into_owned())
}

/// Make the copy, or bring it up to date with this build, and clear away copies
/// moved aside earlier. At start (on a thread of its own) and from Use with AI.
#[cfg(windows)]
pub fn ensure_copy(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().ok()?;
    let dir = app.path().app_local_data_dir().ok()?.join("tool");
    let source = std::env::current_exe().ok()?;
    let note = note_for(&source)?;
    let copy = dir.join(PROGRAM);
    let recorded = std::fs::read_to_string(dir.join(hproxy_cli::COPIED_FROM)).ok();
    if !(copy.is_file() && recorded.as_deref() == Some(note.as_str())) {
        if let Err(e) = refresh(&dir, &source, &copy, &note) {
            log::warn!("the AI tool's copy could not be made in {}: {e}", dir.display());
            return None;
        }
        log::info!("the AI tool's copy is this build now: {}", copy.display());
    }
    remove_moved_aside(&dir);
    ensure_on_path(&dir);
    Some(copy)
}

/// Put the copy's folder on the user's PATH, once (see ON_PATH_NOTE).
#[cfg(windows)]
fn ensure_on_path(dir: &Path) {
    let note = dir.join(ON_PATH_NOTE);
    if note.exists() {
        return;
    }
    match add_to_user_path(dir) {
        Ok(added) => {
            if added {
                log::info!("the AI tool's folder is on the user's PATH now: {}", dir.display());
            }
            let _ = std::fs::write(&note, format!("{}\n", dir.display()));
        }
        Err(e) => log::warn!("the AI tool's folder could not go on the user's PATH: {e}"),
    }
}

/// Add `dir` to the user's PATH (HKCU\Environment\Path) and tell running
/// programs the environment changed, as Windows' own settings page does. The
/// value keeps its type: REG_EXPAND_SZ holds `%VARIABLES%` that must stay
/// unexpanded. False when `dir` was on it already.
#[cfg(windows)]
fn add_to_user_path(dir: &Path) -> std::io::Result<bool> {
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};
    let env = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;
    let (current, vtype) = match env.get_raw_value("Path") {
        Ok(v) if matches!(v.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ) => (reg_text(&v.bytes), v.vtype),
        Ok(_) => return Err(std::io::Error::other("the user's PATH is not text; left alone")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (String::new(), RegType::REG_EXPAND_SZ),
        Err(e) => return Err(e),
    };
    let Some(next) = path_with(&current, &dir.to_string_lossy()) else {
        return Ok(false);
    };
    let bytes = next.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
    env.set_raw_value("Path", &RegValue { bytes, vtype })?;
    broadcast_environment_change();
    Ok(true)
}

/// The uninstaller's last word (windows/installer-hooks.nsh): take `dir` off the
/// user's PATH and drop the note that says it went on. Done by this program
/// rather than the installer, whose strings end at 1024 characters: a longer
/// PATH (one measured had 1087) would come back cut short.
#[cfg(windows)]
pub fn forget_path(dir: &Path) -> std::io::Result<bool> {
    let _ = std::fs::remove_file(dir.join(ON_PATH_NOTE));
    remove_from_user_path(dir)
}

/// Take `dir` off the user's PATH, keeping every other entry and the value's
/// type, and tell running programs. False when it was not on it.
#[cfg(windows)]
fn remove_from_user_path(dir: &Path) -> std::io::Result<bool> {
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};
    let env = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)?;
    let value = match env.get_raw_value("Path") {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    if !matches!(value.vtype, RegType::REG_SZ | RegType::REG_EXPAND_SZ) {
        return Ok(false);
    }
    let Some(next) = path_without(&reg_text(&value.bytes), &dir.to_string_lossy()) else {
        return Ok(false);
    };
    let bytes = next.encode_utf16().chain([0]).flat_map(u16::to_le_bytes).collect();
    env.set_raw_value(
        "Path",
        &RegValue {
            bytes,
            vtype: value.vtype,
        },
    )?;
    broadcast_environment_change();
    Ok(true)
}

/// `path` without the entries that name `dir`, everything else as it was, or
/// None when no entry names it.
#[cfg(windows)]
fn path_without(path: &str, dir: &str) -> Option<String> {
    let entries: Vec<&str> = path.split(';').collect();
    if !entries.iter().any(|entry| same_dir(entry, dir)) {
        return None;
    }
    Some(
        entries
            .into_iter()
            .filter(|entry| !same_dir(entry, dir))
            .collect::<Vec<_>>()
            .join(";"),
    )
}

/// Whether the user's PATH as saved holds `dir`. Not this process's own PATH:
/// that one is as old as the app.
#[cfg(windows)]
fn user_path_has(dir: &Path) -> bool {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(env) = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment") else {
        return false;
    };
    let Ok(value) = env.get_raw_value("Path") else {
        return false;
    };
    path_with(&reg_text(&value.bytes), &dir.to_string_lossy()).is_none()
}

/// A registry string: UTF-16, up to its first NUL.
#[cfg(windows)]
fn reg_text(bytes: &[u8]) -> String {
    let words: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .take_while(|&word| word != 0)
        .collect();
    String::from_utf16_lossy(&words)
}

/// `path` with `dir` added at its end, or None when an entry names `dir` already.
#[cfg(windows)]
fn path_with(path: &str, dir: &str) -> Option<String> {
    if path.split(';').any(|entry| same_dir(entry, dir)) {
        return None;
    }
    let kept = path.trim_end_matches(';');
    Some(if kept.trim().is_empty() {
        dir.to_string()
    } else {
        format!("{kept};{dir}")
    })
}

/// Whether a PATH entry names `dir`, read as Windows reads it: `%VARIABLES%`
/// expanded, letter case, spaces around and a trailing backslash aside.
#[cfg(windows)]
fn same_dir(entry: &str, dir: &str) -> bool {
    let clean = |s: &str| expand_vars(s.trim()).trim_end_matches('\\').to_lowercase();
    !entry.trim().is_empty() && clean(entry) == clean(dir)
}

/// `%NAME%` replaced by the variable's value; a name that is not set stays as written.
#[cfg(windows)]
fn expand_vars(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(value) if !name.is_empty() => out.push_str(&value),
            _ => {
                out.push('%');
                out.push_str(name);
                out.push('%');
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Tell running programs that the environment changed, Explorer above all, which
/// starts the next ones: a program started afterwards finds `hproxy`.
#[cfg(windows)]
fn broadcast_environment_change() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let what: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result = 0usize;
    // SAFETY: `what` is a NUL-terminated UTF-16 string that outlives the call, and
    // the timeout bounds the wait on a program that does not answer.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            what.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}

/// What `copied-from.txt` says for this build: the app's program on the first
/// line (`hproxy app` reads it), then the version, size and time of the file.
#[cfg(windows)]
fn note_for(source: &Path) -> Option<String> {
    let meta = std::fs::metadata(source).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some(format!(
        "{}\n{} {} {}\n",
        source.display(),
        env!("CARGO_PKG_VERSION"),
        meta.len(),
        modified
    ))
}

/// Put a fresh copy in place. A running copy cannot be overwritten, but it can
/// be renamed: it goes aside and keeps serving its assistant, and the fresh one
/// takes its name.
#[cfg(windows)]
fn refresh(dir: &Path, source: &Path, copy: &Path, note: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let fresh = dir.join("hproxy.new.exe");
    std::fs::copy(source, &fresh)?;
    if copy.exists() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        std::fs::rename(copy, dir.join(format!("{ASIDE_PREFIX}{stamp}.exe")))?;
    }
    std::fs::rename(&fresh, copy)?;
    std::fs::write(dir.join(hproxy_cli::COPIED_FROM), note)
}

/// Remove copies moved aside earlier; one an assistant still runs stays until a
/// later start.
#[cfg(windows)]
fn remove_moved_aside(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(ASIDE_PREFIX) && name.ends_with(".exe") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hproxy-tool-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_new_build_replaces_the_copy_and_the_old_one_goes() {
        let root = scratch("refresh");
        let (source, dir) = (root.join("HProxy.exe"), root.join("tool"));
        let copy = dir.join(PROGRAM);
        std::fs::write(&source, b"build one").unwrap();
        refresh(&dir, &source, &copy, &note_for(&source).unwrap()).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"build one");

        // The next build: the copy in place goes aside first, then is cleared away.
        std::fs::write(&source, b"build two").unwrap();
        refresh(&dir, &source, &copy, &note_for(&source).unwrap()).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"build two");
        let aside = || {
            std::fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(ASIDE_PREFIX))
                .count()
        };
        assert_eq!(aside(), 1);
        remove_moved_aside(&dir);
        assert_eq!(aside(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_tool_folder_goes_on_the_path_once() {
        let dir = r"C:\Users\x\AppData\Local\com.hproxy.checker\tool";
        assert_eq!(path_with("", dir).as_deref(), Some(dir));
        assert_eq!(path_with(r"C:\a;C:\b", dir), Some(format!(r"C:\a;C:\b;{dir}")));
        assert_eq!(path_with(r"C:\a;;", dir), Some(format!(r"C:\a;{dir}")));
        // Already on it, however the entry is written.
        assert_eq!(path_with(&format!(r"C:\a;{dir}"), dir), None);
        assert_eq!(path_with(&format!(r"C:\a; {}\ ;C:\b", dir.to_uppercase()), dir), None);
    }

    #[test]
    fn the_uninstaller_takes_only_the_tool_folder_off_the_path() {
        let dir = r"C:\Users\x\AppData\Local\com.hproxy.checker\tool";
        assert_eq!(
            path_without(&format!(r"C:\a;{dir};C:\b"), dir).as_deref(),
            Some(r"C:\a;C:\b")
        );
        assert_eq!(path_without(&format!(r"{dir}\"), dir).as_deref(), Some(""));
        // Everything else stays as written, a trailing semicolon and %VARIABLES% included.
        assert_eq!(
            path_without(&format!(r"%USERPROFILE%\bin;{};", dir.to_uppercase()), dir).as_deref(),
            Some(r"%USERPROFILE%\bin;")
        );
        assert_eq!(path_without(r"C:\a;C:\b", dir), None);
        // Longer than an installer's strings: nothing is cut short.
        let long = format!("{};{dir}", vec![r"C:\a-rather-long-folder-name"; 60].join(";"));
        let kept = path_without(&long, dir).unwrap();
        assert_eq!(kept.len(), long.len() - dir.len() - 1);
        assert!(kept.len() > 1024);
    }

    #[test]
    fn path_entries_are_read_as_windows_reads_them() {
        let local = std::env::var("LOCALAPPDATA").expect("Windows sets LOCALAPPDATA");
        let dir = format!(r"{local}\com.hproxy.checker\tool");
        assert!(same_dir(r"%LOCALAPPDATA%\com.hproxy.checker\tool", &dir));
        assert!(!same_dir(r"%LOCALAPPDATA%\com.hproxy.checker", &dir));
        assert!(!same_dir("  ", &dir));
        assert_eq!(
            expand_vars(r"%HPROXY_NOT_SET_ANYWHERE%\x"),
            r"%HPROXY_NOT_SET_ANYWHERE%\x"
        );
        assert_eq!(expand_vars("50% off"), "50% off");
    }

    #[test]
    fn registry_text_stops_at_its_nul() {
        let bytes: Vec<u8> = "C:\\a;C:\\b\0left over"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(reg_text(&bytes), r"C:\a;C:\b");
    }

    #[test]
    fn the_note_names_the_app_first() {
        let root = scratch("note");
        let source = root.join("HProxy.exe");
        std::fs::write(&source, b"12345").unwrap();
        let note = note_for(&source).unwrap();
        let mut lines = note.lines();
        assert_eq!(lines.next(), Some(source.display().to_string().as_str()));
        assert!(lines
            .next()
            .unwrap()
            .starts_with(&format!("{} 5 ", env!("CARGO_PKG_VERSION"))));
        let _ = std::fs::remove_dir_all(&root);
    }
}
