//! In the background: the icon by the clock. The app keeps running with no
//! window and no taskbar button, which is different from minimized.
//!
//! Closing the window hides it instead of quitting (while "Keep running in the
//! background" is on, the default), so a connection keeps going with no
//! taskbar button. The icon's menu opens the window, connects to the last
//! place or disconnects, and quits; its tooltip says what the relay is doing.
//! The relay itself tells the icon when it starts and stops
//! (`relay_changed`), so the icon is right whichever way the change was made.
//!
//! "Connect" needs the place the person picked last, which lives in the
//! window's storage, so the icon asks the window (`tray-connect`); the window
//! keeps running while hidden. "Disconnect" is done here directly.
//!
//! Phones have no tray: everything here is a no-op there.

use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// What the icon needs to remember between calls.
pub struct TrayState {
    /// Hide on close instead of quitting. On unless the person turned it off.
    pub keep_running: AtomicBool,
    /// Whether the relay runs, for the menu's Connect / Disconnect item.
    pub connected: AtomicBool,
    #[cfg(desktop)]
    toggle: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

impl Default for TrayState {
    fn default() -> Self {
        Self {
            keep_running: AtomicBool::new(true),
            connected: AtomicBool::new(false),
            #[cfg(desktop)]
            toggle: Mutex::new(None),
        }
    }
}

/// Bring the window back from the tray, in front. Desktop only, like the menu
/// that calls it: a phone's window cannot be minimised or hidden.
#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Build the icon and its menu. Desktop only; called once from `setup`.
#[cfg(desktop)]
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open HProxy", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "Connect", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit HProxy", true, None::<&str>)?;
    let line = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &toggle, &line, &quit])?;

    let mut icon = TrayIconBuilder::with_id("main")
        .tooltip("HProxy: not connected")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "toggle" => toggle_connection(app),
            // The exit handler in lib.rs puts the system proxy back first.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(image) = app.default_window_icon() {
        icon = icon.icon(image.clone());
    }
    icon.build(app)?;

    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut t) = state.toggle.lock() {
            *t = Some(toggle);
        }
    }
    Ok(())
}

/// The menu's middle item: disconnect here, or ask the window to connect to
/// the place the person picked last.
#[cfg(desktop)]
fn toggle_connection(app: &AppHandle) {
    use tauri::Emitter;
    let connected = app
        .try_state::<TrayState>()
        .map(|s| s.connected.load(Ordering::SeqCst))
        .unwrap_or(false);
    if connected {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            crate::connect::stop_from_tray(&app).await;
        });
    } else {
        let _ = app.emit("tray-connect", ());
    }
}

/// The relay started or stopped: the menu item and the tooltip follow, and
/// the window hears about it (a change made from the icon while Connect is
/// open must show there too).
pub fn relay_changed(app: &AppHandle, connected: bool, through: Option<&str>) {
    use tauri::Emitter;
    // Phones have no tooltip to name the proxy in.
    #[cfg(not(desktop))]
    let _ = through;
    if let Some(state) = app.try_state::<TrayState>() {
        state.connected.store(connected, Ordering::SeqCst);
        #[cfg(desktop)]
        if let Ok(t) = state.toggle.lock() {
            if let Some(item) = t.as_ref() {
                let _ = item.set_text(if connected { "Disconnect" } else { "Connect" });
            }
        }
    }
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id("main") {
        let tip = match (connected, through) {
            (true, Some(t)) => format!("HProxy: connected through {t}"),
            (true, None) => "HProxy: connected".to_string(),
            (false, _) => "HProxy: not connected".to_string(),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
    let _ = app.emit("relay-changed", connected);
}

/// Close hides the window instead of quitting, while the person wants that.
#[cfg(desktop)]
pub fn keeps_running(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .map(|s| s.keep_running.load(Ordering::SeqCst))
        .unwrap_or(false)
}

/// The window says whether closing it should keep the app in the background
/// (Settings, "In the background"). Phones ignore it.
#[tauri::command]
pub fn set_keep_running(app: AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        state.keep_running.store(enabled, Ordering::SeqCst);
    }
}
