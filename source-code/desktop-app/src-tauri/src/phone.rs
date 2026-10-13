//! The phone's own controls, for the window: the colour of the status bar's icons, a short buzz
//! under the finger, the room the system bars take over the page, and going to the background on
//! Back. Android does them (PhonePlugin.kt in gen/android/app/src/main/java/com/hproxy/checker);
//! everywhere else each command does nothing, so the window never has to ask where it runs.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Which buzz: a tab or a choice, the big button, a connection that came up, one that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Buzz {
    Tick,
    Press,
    Confirm,
    Reject,
}

/// What the system bars cover, in CSS pixels.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Insets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

/// The status bar's icons light on a dark page, dark on a white one; `canvas` is the page's
/// colour (`#rrggbb`), shown behind the page before it draws at the next start.
#[tauri::command]
pub fn phone_colors(app: AppHandle, dark: bool, canvas: String) {
    #[cfg(target_os = "android")]
    android::colors(&app, dark, &canvas);
    #[cfg(not(target_os = "android"))]
    let _ = (app, dark, canvas);
}

#[tauri::command]
pub fn phone_buzz(app: AppHandle, kind: Buzz) {
    #[cfg(target_os = "android")]
    android::buzz(&app, kind);
    #[cfg(not(target_os = "android"))]
    let _ = (app, kind);
}

/// The app to the background, still running, the way Home does it.
#[tauri::command]
pub fn phone_to_background(app: AppHandle) {
    #[cfg(target_os = "android")]
    android::to_background(&app);
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

/// Null when the phone could not say.
#[cfg(target_os = "android")]
#[tauri::command]
pub fn phone_insets(app: AppHandle) -> Option<Insets> {
    android::insets(&app)
}

/// Null: no system bars over the page off a phone.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn phone_insets(_app: AppHandle) -> Option<Insets> {
    None
}

#[cfg(target_os = "android")]
pub mod android {
    use super::{Buzz, Insets};
    use serde::Serialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct Phone<R: Runtime>(PluginHandle<R>);

    #[derive(Serialize)]
    struct Colors<'a> {
        dark: bool,
        canvas: &'a str,
    }

    #[derive(Serialize)]
    struct BuzzArgs {
        kind: Buzz,
    }

    /// Registered in lib.rs: loads the Kotlin side once, when the app starts.
    pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("phone")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.hproxy.checker", "PhonePlugin")?;
                app.manage(Phone(handle));
                Ok(())
            })
            .build()
    }

    fn run<R: Runtime, T: serde::de::DeserializeOwned>(
        app: &AppHandle<R>,
        command: &str,
        args: impl Serialize,
    ) -> Option<T> {
        let phone = app.try_state::<Phone<R>>()?;
        match phone.0.run_mobile_plugin::<T>(command, args) {
            Ok(answer) => Some(answer),
            Err(e) => {
                log::warn!("phone: {command} failed: {e}");
                None
            }
        }
    }

    pub fn colors<R: Runtime>(app: &AppHandle<R>, dark: bool, canvas: &str) {
        run::<R, ()>(app, "colors", Colors { dark, canvas });
    }

    pub fn buzz<R: Runtime>(app: &AppHandle<R>, kind: Buzz) {
        run::<R, ()>(app, "buzz", BuzzArgs { kind });
    }

    pub fn to_background<R: Runtime>(app: &AppHandle<R>) {
        run::<R, ()>(app, "toBackground", ());
    }

    pub fn insets<R: Runtime>(app: &AppHandle<R>) -> Option<Insets> {
        run::<R, Option<Insets>>(app, "insets", ()).flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_buzz_is_named_the_way_the_window_and_android_name_it() {
        for (kind, word) in [
            (Buzz::Tick, "tick"),
            (Buzz::Press, "press"),
            (Buzz::Confirm, "confirm"),
            (Buzz::Reject, "reject"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), word);
            assert_eq!(serde_json::from_value::<Buzz>(word.into()).unwrap(), kind);
        }
    }

    #[test]
    fn the_insets_read_what_android_answers() {
        let read: Insets = serde_json::from_str(r#"{"top":24.0,"right":0,"bottom":24,"left":0}"#).unwrap();
        assert_eq!(
            read,
            Insets {
                top: 24.0,
                right: 0.0,
                bottom: 24.0,
                left: 0.0
            }
        );
    }
}
