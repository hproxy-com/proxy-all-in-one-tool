//! A copy installed from the Microsoft Store: an MSIX package (store/microsoft-store/msix/).
//!
//! Windows gives a packaged app a private copy of the per-user registry and of new files in
//! AppData, so three things work differently in that copy:
//!   - updates come from the Store, never from hproxy.com (src/channel.rs names the copy
//!     `microsoft-store`, and src/update.rs looks only for copies that update themselves). At
//!     start the copy asks the Store for a newer version and lets the Store install it
//!     (`store_update_at_start`);
//!   - the AI tool is the package's `hproxy` command, which Windows puts on the PATH itself,
//!     not a copy in AppData with its folder added to the PATH (src/tool.rs);
//!   - "Start with the computer" would write the Run key into the private copy, where Windows
//!     never looks for it, so Settings does not offer it.
//!
//! The system proxy is not among them: the package declares the Internet Settings key
//! unvirtualized, so Connect's writes reach Windows (proxy-engine/hproxy-system).

use serde::Serialize;

/// Whether this process runs from an app package.
#[cfg(windows)]
pub fn is_store_install() -> bool {
    use windows_sys::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut length = 0u32;
    // Asked with no buffer, a packaged process answers "the buffer is too small" and any
    // other process APPMODEL_ERROR_NO_PACKAGE.
    // SAFETY: a length of 0 with a null buffer is the documented way to ask for the length;
    // nothing is written through the null pointer.
    let answer = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    answer != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
pub fn is_store_install() -> bool {
    false
}

/// For the window: the Store copy does not look for updates and does not offer starting with
/// the computer.
#[tauri::command]
pub fn store_install() -> bool {
    is_store_install()
}

/// What the Store copy's start check did (src/components/StartGate.tsx). Every outcome opens the
/// app; an install instead ends it, and the new version opens. Only Windows builds the outcomes
/// past `NotHere`.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum StoreAtStart {
    /// Not a copy from the Microsoft Store.
    NotHere,
    /// Nothing newer in the Store.
    Current,
    /// The Store did not answer in time: the app opens, and the Store still updates it later.
    NoAnswer,
    /// The person said no in the Store's window, or the Store could not install it.
    NotInstalled,
}

/// At start, the Store copy asks the Store for a newer version of itself and, when there is one,
/// lets the Store download and install it in the Store's own window (Microsoft's in-app update,
/// Windows.Services.Store; Microsoft: "the OS displays a dialog that asks the user's permission
/// before downloading the updates" and installing "may cause the application to exit"). The app
/// is registered to start again when Windows ends it for the update, and if it is still running
/// when the Store is done, it starts the new version itself. Nothing newer, no answer within a few
/// seconds, or a "no" in the Store's window: the app opens as it is.
#[tauri::command]
pub async fn store_update_at_start(app: tauri::AppHandle) -> StoreAtStart {
    #[cfg(windows)]
    return in_the_store::at_start(app).await;
    #[cfg(not(windows))]
    {
        let _ = app;
        StoreAtStart::NotHere
    }
}

#[cfg(windows)]
mod in_the_store {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::{Emitter, Manager};
    use windows::core::Interface;
    use windows::Services::Store::{StoreContext, StorePackageUpdateState};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::IInitializeWithWindow;

    use super::StoreAtStart;

    /// How long the Store may take to say whether there is a newer version.
    const FIND: Duration = Duration::from_secs(6);
    /// The package's application, as the MSIX manifest names it (<Application Id="HProxy">).
    const APPLICATION_ID: &str = "HProxy";

    enum Found {
        Nothing,
        Updates,
    }

    enum Done {
        Installed,
        NotInstalled,
    }

    pub async fn at_start(app: tauri::AppHandle) -> StoreAtStart {
        if !super::is_store_install() {
            return StoreAtStart::NotHere;
        }
        let Some(hwnd) = app
            .get_webview_window("main")
            .and_then(|w| w.hwnd().ok())
            .map(|h| h.0 as isize)
        else {
            return StoreAtStart::NoAnswer;
        };

        // The Store's objects stay on the thread that made them. It reports what it found, then
        // waits for the word to go on: when the window stopped waiting (FIND passed), that word
        // never comes, and no Store window can appear later over an app already in use.
        let (found_tx, found_rx) = tokio::sync::oneshot::channel::<Result<Found, String>>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Done>();
        std::thread::spawn(move || {
            let (context, updates) = match find(hwnd) {
                Ok(found) => found,
                Err(e) => {
                    let _ = found_tx.send(Err(e.to_string()));
                    return;
                }
            };
            let any = updates.Size().unwrap_or(0) > 0;
            let _ = found_tx.send(Ok(if any { Found::Updates } else { Found::Nothing }));
            if !any || go_rx.recv_timeout(Duration::from_secs(5)).is_err() {
                return;
            }
            let _ = done_tx.send(install(&context, &updates));
        });

        match tokio::time::timeout(FIND, found_rx).await {
            Ok(Ok(Ok(Found::Updates))) => {}
            Ok(Ok(Ok(Found::Nothing))) => return StoreAtStart::Current,
            Ok(Ok(Err(e))) => {
                log::info!("the Microsoft Store did not say whether there is an update: {e}");
                return StoreAtStart::NoAnswer;
            }
            Ok(Err(_)) | Err(_) => return StoreAtStart::NoAnswer,
        }
        let _ = app.emit("update:store", ());
        if go_tx.send(()).is_err() {
            return StoreAtStart::NotInstalled;
        }
        match done_rx.await {
            Ok(Done::Installed) => {
                // Still running after the Store's install: start the new version and end this one.
                log::info!("the Microsoft Store installed a new version; starting it");
                relaunch_package();
                app.exit(0);
                StoreAtStart::NotInstalled
            }
            Ok(Done::NotInstalled) | Err(_) => StoreAtStart::NotInstalled,
        }
    }

    type Updates = windows_collections::IVectorView<windows::Services::Store::StorePackageUpdate>;

    fn find(hwnd: isize) -> windows::core::Result<(StoreContext, Updates)> {
        let ctx = StoreContext::GetDefault()?;
        // A desktop program must tell the Store which window its dialogs belong to.
        let init: IInitializeWithWindow = ctx.cast()?;
        // SAFETY: hwnd is this app's main window, alive for the whole start check.
        unsafe { init.Initialize(HWND(hwnd as *mut core::ffi::c_void))? };
        let updates = ctx.GetAppAndOptionalStorePackageUpdatesAsync()?.get()?;
        Ok((ctx, updates))
    }

    fn install(ctx: &StoreContext, updates: &Updates) -> Done {
        register_restart();
        let state = ctx
            .RequestDownloadAndInstallStorePackageUpdatesAsync(updates)
            .and_then(|op| op.get())
            .and_then(|result| result.OverallState());
        match state {
            Ok(StorePackageUpdateState::Completed) => Done::Installed,
            Ok(_) => Done::NotInstalled,
            Err(e) => {
                log::warn!("the Microsoft Store could not install the update: {e}");
                Done::NotInstalled
            }
        }
    }

    /// Ask Windows to start the app again when an update ends it, and only then: not after a
    /// crash, a hang or a restart of the computer.
    fn register_restart() {
        use windows_sys::Win32::System::Recovery::{
            RegisterApplicationRestart, RESTART_NO_CRASH, RESTART_NO_HANG, RESTART_NO_REBOOT,
        };
        // SAFETY: a null command line is documented as "no arguments".
        unsafe {
            RegisterApplicationRestart(std::ptr::null(), RESTART_NO_CRASH | RESTART_NO_HANG | RESTART_NO_REBOOT);
        }
    }

    /// Start this package's app through the Start menu's own address for it, which always opens
    /// the installed (new) version: `shell:AppsFolder\<family name>!HProxy`.
    fn relaunch_package() {
        let Some(family) = package_family_name() else {
            return;
        };
        let _ = std::process::Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{family}!{APPLICATION_ID}"))
            .spawn();
    }

    fn package_family_name() -> Option<String> {
        use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;
        let mut length = 0u32;
        // SAFETY: first the documented length query with no buffer, then a buffer of that length.
        unsafe {
            GetCurrentPackageFamilyName(&mut length, std::ptr::null_mut());
            if length == 0 {
                return None;
            }
            let mut buffer = vec![0u16; length as usize];
            if GetCurrentPackageFamilyName(&mut length, buffer.as_mut_ptr()) != 0 {
                return None;
            }
            let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..end]))
        }
    }
}

#[cfg(test)]
mod tests {
    /// A test runs as a plain program, never from a package.
    #[test]
    fn a_plain_program_is_not_a_store_install() {
        assert!(!super::is_store_install());
    }
}
