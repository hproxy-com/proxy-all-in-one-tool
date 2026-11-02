//! The computer's own notifications, signed HProxy.
//!
//! On Windows a notification belongs to an app id, which decides the name and
//! the icon on it. The notification plugin picks that id badly twice: run from a
//! build folder it signs with PowerShell's, and in the Microsoft Store copy with
//! one the package does not own. So here the id is the real one: a Store copy
//! asks Windows for its own, any other copy registers its identifier under
//! `HKCU\Software\Classes\AppUserModelId` with our name and icon, which is what
//! Windows reads for a program without a package, and which works whether or not
//! a Start menu shortcut carries the id. The uninstaller takes that key away
//! again (windows/installer-hooks.nsh).
//!
//! Elsewhere the plugin does the job.

use tauri::AppHandle;

/// What a notification is about: the picture beside its words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// A proxy that stopped: the red H, a sound, and Disconnect on it.
    Stopped,
    /// It answers again: the blue H, quietly.
    Back,
    /// A reminder: the blue H.
    Reminder,
}

/// Show a notification. Pressing it brings the window back.
pub fn show(app: &AppHandle, title: &str, lines: &[&str], look: Look) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows::show(app, title, lines, look)
    }
    #[cfg(all(desktop, not(windows)))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = look;
        app.notification()
            .builder()
            .title(title)
            .body(lines.join("\n"))
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, title, lines, look);
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use super::Look;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Manager};
    use tauri_winrt_notification::{IconCrop, Sound, Toast};

    const NAME: &str = "HProxy";
    // An .ico for the name's line: in the dark theme Windows inverts a PNG there, and
    // our blue came out orange (measured on Windows 11, 2026-11-02).
    const ICON: &[u8] = include_bytes!("../icons/icon.ico");
    const ICON_ON: &[u8] = include_bytes!("../icons/notify-on.png");
    const ICON_STOPPED: &[u8] = include_bytes!("../icons/notify-stopped.png");

    pub fn show(app: &AppHandle, title: &str, lines: &[&str], look: Look) -> Result<(), String> {
        static ID: OnceLock<String> = OnceLock::new();
        let id = ID.get_or_init(|| app_id(app));

        let mut toast = Toast::new(id).title(title);
        if let Some(line) = lines.first() {
            toast = toast.text1(line);
        }
        if let Some(line) = lines.get(1) {
            toast = toast.text2(line);
        }
        let logo = match look {
            Look::Stopped => saved(app, "stopped.png", ICON_STOPPED),
            Look::Back | Look::Reminder => saved(app, "on.png", ICON_ON),
        };
        if let Some(logo) = &logo {
            toast = toast.icon(logo, IconCrop::Square, NAME);
        }
        toast = match look {
            Look::Stopped => toast.sound(Some(Sound::Default)).add_button("Disconnect", "disconnect"),
            Look::Back => toast.sound(None),
            Look::Reminder => toast.sound(Some(Sound::Default)),
        };
        let handle = app.clone();
        toast
            .on_activated(move |action| {
                match action.as_deref() {
                    Some("disconnect") => crate::tray::disconnect(&handle),
                    _ => crate::tray::show_main(&handle),
                }
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }

    /// The id to sign with: the package's own, else our identifier, registered.
    fn app_id(app: &AppHandle) -> String {
        if let Some(id) = packaged_id() {
            return id;
        }
        let id = app.config().identifier.clone();
        let icon = saved(app, "icon.ico", ICON);
        if let Err(e) = register(&id, icon.as_deref()) {
            // It can still be shown: a Start menu shortcut carries the same id.
            log::warn!("the notifications' name could not be registered: {e}");
        }
        id
    }

    /// Windows' id for this package, `<family>!HProxy`. None for a plain program.
    fn packaged_id() -> Option<String> {
        use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentApplicationUserModelId;
        let mut length = 0u32;
        // SAFETY: first the documented length query with no buffer, then a buffer of that length.
        unsafe {
            GetCurrentApplicationUserModelId(&mut length, std::ptr::null_mut());
            if length == 0 {
                return None;
            }
            let mut buffer = vec![0u16; length as usize];
            if GetCurrentApplicationUserModelId(&mut length, buffer.as_mut_ptr()) != 0 {
                return None;
            }
            let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(String::from_utf16_lossy(&buffer[..end]))
        }
    }

    fn register(id: &str, icon: Option<&Path>) -> std::io::Result<()> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let (key, _) =
            RegKey::predef(HKEY_CURRENT_USER).create_subkey(format!("Software\\Classes\\AppUserModelId\\{id}"))?;
        key.set_value("DisplayName", &NAME)?;
        if let Some(icon) = icon {
            key.set_value("IconUri", &icon.display().to_string())?;
        }
        Ok(())
    }

    /// A picture as a file, which is what Windows asks for, in the app's own folder.
    fn saved(app: &AppHandle, name: &str, bytes: &[u8]) -> Option<PathBuf> {
        let folder = app.path().app_local_data_dir().ok()?.join("notifications");
        let file = folder.join(name);
        if std::fs::read(&file).is_ok_and(|on_disk| on_disk == bytes) {
            return Some(file);
        }
        std::fs::create_dir_all(&folder).ok()?;
        std::fs::write(&file, bytes).ok()?;
        Some(file)
    }
}
