//! Where this copy came from, which is where its updates come from.
//!
//! Read from the system while the app runs, never from how the program was built: the same
//! Android file goes to Google Play, GitHub and hproxy.com (all carry Google's signature, so any
//! copy can take any later one), and it must behave right wherever it was installed from.
//!
//!   windows          the installer from hproxy.com (GitHub offers the same file); updates itself
//!   macos            the .dmg; updates itself
//!   linux-appimage   the AppImage; updates itself
//!   linux-deb        the .deb; the notice and a download (a .deb installs only with the admin
//!                    password, which a quiet update cannot ask for)
//!   linux-rpm        the .rpm; the same as the .deb
//!   microsoft-store  the MSIX from the Microsoft Store (src/store.rs); the Store updates it
//!   google-play      installed by Google Play; Play updates it (its in-app update, at start)
//!   apk              installed by hand; the notice and a download
//!   app-store        an iPhone (none is published yet); the App Store updates it
//!
//! The version list (hproxy.com/downloads/versions.json) names each of these with the version it
//! has live, and the version check sends the name, so the site can count which copies run which
//! version without any other request (PRIVACY.md, "What leaves your machine").

use serde::Serialize;
use tauri::{AppHandle, Runtime};

// Each system builds only its own variants; the others exist for the window and the tests.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Channel {
    Windows,
    Macos,
    LinuxAppimage,
    LinuxDeb,
    LinuxRpm,
    MicrosoftStore,
    GooglePlay,
    Apk,
    AppStore,
}

impl Channel {
    /// The name the version list and the version check use.
    pub fn name(self) -> &'static str {
        match self {
            Channel::Windows => "windows",
            Channel::Macos => "macos",
            Channel::LinuxAppimage => "linux-appimage",
            Channel::LinuxDeb => "linux-deb",
            Channel::LinuxRpm => "linux-rpm",
            Channel::MicrosoftStore => "microsoft-store",
            Channel::GooglePlay => "google-play",
            Channel::Apk => "apk",
            Channel::AppStore => "app-store",
        }
    }

    /// The copy installs its own updates from hproxy.com: signed files, checked by the updater
    /// plugin against the key compiled into the program (src/update.rs). Only desktops ask.
    #[cfg_attr(mobile, allow(dead_code))]
    pub fn updates_itself(self) -> bool {
        matches!(self, Channel::Windows | Channel::Macos | Channel::LinuxAppimage)
    }
}

/// This copy's channel.
pub fn current<R: Runtime>(app: &AppHandle<R>) -> Channel {
    #[cfg(windows)]
    {
        let _ = app;
        if crate::store::is_store_install() {
            Channel::MicrosoftStore
        } else {
            Channel::Windows
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        Channel::Macos
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux(tauri::utils::platform::bundle_type())
    }
    #[cfg(target_os = "android")]
    {
        android::channel(app)
    }
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        Channel::AppStore
    }
}

/// A Linux copy by the package it came in. The bundler writes the package type into the program
/// it puts in each package; a program run straight from the build folder has none and counts
/// as the AppImage, the one Linux package that updates itself.
#[cfg(any(target_os = "linux", test))]
fn linux(bundle: Option<tauri::utils::config::BundleType>) -> Channel {
    use tauri::utils::config::BundleType;
    match bundle {
        Some(BundleType::Deb) => Channel::LinuxDeb,
        Some(BundleType::Rpm) => Channel::LinuxRpm,
        _ => Channel::LinuxAppimage,
    }
}

/// Google Play's own package name: the installer of every copy Play installed.
#[cfg(any(target_os = "android", test))]
const GOOGLE_PLAY_INSTALLER: &str = "com.android.vending";

/// An Android copy by the app that installed it. Nothing known counts as Google Play: its button
/// opens Play, where the same signed app can update any copy, while telling a Play copy to
/// download a file would break Play's rules.
#[cfg(any(target_os = "android", test))]
fn android_channel(installer: Option<&str>) -> Channel {
    match installer {
        Some(GOOGLE_PLAY_INSTALLER) | None => Channel::GooglePlay,
        Some(_) => Channel::Apk,
    }
}

/// For the window: where this copy came from.
#[tauri::command]
pub fn install_channel(app: AppHandle) -> Channel {
    current(&app)
}

/// The app that installed this copy, asked from Android (InstallSourcePlugin.kt in
/// gen/android/app/src/main/java/com/hproxy/checker).
#[cfg(target_os = "android")]
pub mod android {
    use super::{android_channel, Channel};
    use serde::Deserialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct InstallSource<R: Runtime>(PluginHandle<R>);

    #[derive(Deserialize)]
    struct Answer {
        installer: Option<String>,
    }

    /// Registered in lib.rs: loads the Kotlin side once, when the app starts.
    pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("install-source")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.hproxy.checker", "InstallSourcePlugin")?;
                app.manage(InstallSource(handle));
                Ok(())
            })
            .build()
    }

    pub fn channel<R: Runtime>(app: &AppHandle<R>) -> Channel {
        let installer = app
            .try_state::<InstallSource<R>>()
            .and_then(|s| s.0.run_mobile_plugin::<Answer>("installSource", ()).ok())
            .and_then(|a| a.installer);
        android_channel(installer.as_deref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::BundleType;

    #[test]
    fn a_linux_copy_is_named_by_its_package() {
        assert_eq!(linux(Some(BundleType::Deb)), Channel::LinuxDeb);
        assert_eq!(linux(Some(BundleType::Rpm)), Channel::LinuxRpm);
        assert_eq!(linux(Some(BundleType::AppImage)), Channel::LinuxAppimage);
        assert_eq!(linux(None), Channel::LinuxAppimage, "run from the build folder");
    }

    #[test]
    fn an_android_copy_is_named_by_what_installed_it() {
        assert_eq!(android_channel(Some("com.android.vending")), Channel::GooglePlay);
        assert_eq!(
            android_channel(Some("com.google.android.packageinstaller")),
            Channel::Apk
        );
        assert_eq!(android_channel(Some("org.mozilla.firefox")), Channel::Apk);
        assert_eq!(
            android_channel(None),
            Channel::GooglePlay,
            "unknown opens Play, never a download"
        );
    }

    #[test]
    fn only_the_downloads_update_themselves() {
        let itself = [Channel::Windows, Channel::Macos, Channel::LinuxAppimage];
        for c in [
            Channel::Windows,
            Channel::Macos,
            Channel::LinuxAppimage,
            Channel::LinuxDeb,
            Channel::LinuxRpm,
            Channel::MicrosoftStore,
            Channel::GooglePlay,
            Channel::Apk,
            Channel::AppStore,
        ] {
            assert_eq!(c.updates_itself(), itself.contains(&c), "{}", c.name());
        }
    }

    #[test]
    fn the_window_gets_the_same_names_as_the_version_list() {
        for c in [
            Channel::LinuxAppimage,
            Channel::MicrosoftStore,
            Channel::GooglePlay,
            Channel::AppStore,
        ] {
            assert_eq!(serde_json::to_value(c).unwrap(), serde_json::json!(c.name()));
        }
    }
}
