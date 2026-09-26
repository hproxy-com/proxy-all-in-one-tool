//! `hproxy app`: open the HProxy desktop app, or wake it in the tray with
//! `--background`, the wake-up command an AI assistant needs. An
//! assistant runs this tool on its own; this is how it brings the app up for
//! the person (to show a saved list, a connection), or starts it behind them.
//!
//! Where the app is. The tool an assistant runs on Windows is a copy the app
//! keeps outside its install folder, so updates never have to end it
//! (`desktop-app/src-tauri/src/tool.rs`); the copy's folder holds
//! `copied-from.txt`, whose first line is the app's program. Started as the
//! app's own program (`HProxy.exe app`, and the tool on macOS and Linux), it
//! starts itself. A standalone `hproxy` from a release has no app beside it
//! and says so.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::Outcome;

pub(crate) const USAGE: &str = "\
APP opens the HProxy desktop app, or brings its window up when it runs.
  --background           start it in the tray by the clock, no window (does
                         nothing more when it already runs)

EXAMPLES
  hproxy app
  hproxy app --background

";

/// The note beside the tool's copy that names the app's program.
pub const COPIED_FROM: &str = "copied-from.txt";

static INSIDE_APP: AtomicBool = AtomicBool::new(false);

/// The desktop app calls this before it runs a command as the tool: then the
/// app's program is this very program.
pub fn set_inside_app() {
    INSIDE_APP.store(true, Ordering::SeqCst);
}

/// The app's program as the note beside a tool copy names it, if it still exists.
fn named_in(dir: &Path) -> Option<PathBuf> {
    let note = std::fs::read_to_string(dir.join(COPIED_FROM)).ok()?;
    let path = PathBuf::from(note.lines().next()?.trim());
    path.is_file().then_some(path)
}

/// Where the desktop app's program is, or the sentence that says it is not here.
pub(crate) fn app_program() -> Result<PathBuf, String> {
    let me = std::env::current_exe().map_err(|e| format!("could not find this program: {e}"))?;
    if INSIDE_APP.load(Ordering::SeqCst) {
        // An AppImage runs from a mount that goes away with it: start the file.
        #[cfg(target_os = "linux")]
        if let Some(image) = std::env::var_os("APPIMAGE") {
            return Ok(PathBuf::from(image));
        }
        return Ok(me);
    }
    me.parent().and_then(named_in).ok_or_else(|| {
        "this hproxy is the standalone tool; the HProxy desktop app is not installed with it. \
         Install the app and set it up again from its Use with AI tab."
            .to_string()
    })
}

/// Start the app, detached from whoever started us: no window of ours, none of
/// our streams handed over (an assistant reads our output through a pipe, and a
/// pipe held open by the app would never end). Returns what to tell the person.
pub(crate) fn open(background: bool) -> Result<String, String> {
    let program = app_program()?;
    let mut cmd = std::process::Command::new(&program);
    if background {
        cmd.arg("--background");
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, as the background connections.
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
        crate::connect::keep_our_streams_out_of_the_child();
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    cmd.spawn()
        .map_err(|e| format!("could not start the HProxy app: {e}"))?;
    Ok(if background {
        "HProxy is running in the tray by the clock (it was started there if it was not running).".into()
    } else {
        "HProxy's window is opening.".into()
    })
}

/// `hproxy app`.
pub async fn command(rest: &[String]) -> Outcome {
    let mut background = false;
    for a in rest {
        match a.as_str() {
            "--background" | "-b" => background = true,
            other => return Outcome::Error(crate::hint::unknown_option("app", other, crate::hint::APP_OPTIONS)),
        }
    }
    match open(background) {
        Ok(said) => {
            println!("{said}");
            Outcome::Ok
        }
        Err(e) => Outcome::Error(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_note_beside_the_copy_names_the_app() {
        let dir = std::env::temp_dir().join(format!("hproxy-app-note-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("HProxy.exe");
        std::fs::write(&program, b"not really a program").unwrap();
        std::fs::write(
            dir.join(COPIED_FROM),
            format!("{}\n0.2.0 11889152 1727136000\n", program.display()),
        )
        .unwrap();
        assert_eq!(named_in(&dir), Some(program.clone()));

        // A note naming a program that is gone names nothing.
        std::fs::remove_file(&program).unwrap();
        assert_eq!(named_in(&dir), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
