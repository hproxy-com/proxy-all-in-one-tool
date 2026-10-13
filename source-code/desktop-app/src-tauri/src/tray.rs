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
//! "Connect" goes to the place the person picked last and "Disconnect" ends the
//! connection, both here: the places live in the library (places.rs), not in
//! the window, so the icon needs no window to connect.
//!
//! Under them, Quick connect: the places used last, then the ones added last,
//! and the fastest free proxy, read from the library whenever it changes
//! (`places_changed`). Picking one connects there, or switches there in place
//! while connected.
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
    /// Quick connect's places with their names, in the menu's order.
    #[cfg(desktop)]
    places: Mutex<Vec<(hproxy_places::Place, String)>>,
}

/// How many places the tray menu lists.
#[cfg(desktop)]
const MAX_TRAY_PLACES: usize = 6;

impl Default for TrayState {
    fn default() -> Self {
        Self {
            keep_running: AtomicBool::new(true),
            connected: AtomicBool::new(false),
            #[cfg(desktop)]
            toggle: Mutex::new(None),
            #[cfg(desktop)]
            places: Mutex::new(Vec::new()),
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

/// The icon's menu: open, connect or disconnect, Quick connect's places, quit.
/// Returns the Connect / Disconnect item too, which `relay_changed` renames.
#[cfg(desktop)]
fn menu(
    app: &AppHandle,
    connected: bool,
    places: &[(hproxy_places::Place, String)],
) -> tauri::Result<(tauri::menu::Menu<tauri::Wry>, tauri::menu::MenuItem<tauri::Wry>)> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "open", "Open HProxy", true, None::<&str>)?)?;
    let toggle = MenuItem::with_id(
        app,
        "toggle",
        if connected { "Disconnect" } else { "Connect" },
        true,
        None::<&str>,
    )?;
    menu.append(&toggle)?;
    if !places.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        for (i, (_, name)) in places.iter().take(MAX_TRAY_PLACES).enumerate() {
            menu.append(&MenuItem::with_id(app, format!("place:{i}"), name, true, None::<&str>)?)?;
        }
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit HProxy", true, None::<&str>)?)?;
    Ok((menu, toggle))
}

/// Build the icon and its menu. Desktop only; called once from `setup`.
#[cfg(desktop)]
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let (menu, toggle) = menu(app, false, &[])?;

    let mut icon = TrayIconBuilder::with_id("main")
        .tooltip("HProxy: not connected")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "toggle" => toggle_connection(app),
            // The exit handler in lib.rs puts the system proxy back first.
            "quit" => app.exit(0),
            id => {
                if let Some(i) = id.strip_prefix("place:").and_then(|i| i.parse::<usize>().ok()) {
                    connect_to_listed(app, i);
                }
            }
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

/// The menu's middle item: disconnect, or connect to the place the person
/// picked last. Nothing picked yet, or the connect failed: the window opens,
/// where the place can be picked and the reason is on its card.
#[cfg(desktop)]
fn toggle_connection(app: &AppHandle) {
    let connected = app
        .try_state::<TrayState>()
        .map(|s| s.connected.load(Ordering::SeqCst))
        .unwrap_or(false);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if connected {
            crate::connect::stop_from_outside(&app).await;
        } else if let Err(e) = crate::connect::connect_picked(&app).await {
            log::warn!("the tray could not connect: {e}");
            show_main(&app);
        }
    });
}

/// One of Quick connect's places, by its place in the menu.
#[cfg(desktop)]
fn connect_to_listed(app: &AppHandle, i: usize) {
    let place = app.try_state::<TrayState>().and_then(|s| {
        s.places
            .lock()
            .ok()
            .and_then(|p| p.get(i).map(|(place, _)| place.clone()))
    });
    let Some(place) = place else { return };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::connect::start_place(&app, place, None, true, None, None).await {
            log::warn!("the tray could not connect: {e}");
            show_main(&app);
        }
    });
}

/// The relay started or stopped: the menu item and the tooltip follow, and
/// the window hears about it (a change made from the icon while Connect is
/// open must show there too).
pub fn relay_changed(app: &AppHandle, connected: bool, through: Option<&str>) {
    use tauri::Emitter;
    // A phone names the proxy in the VPN's notification instead of a tooltip.
    #[cfg(target_os = "android")]
    if let (true, Some(t)) = (connected, through) {
        crate::vpn::android::through_changed(app, t);
    }
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

/// The places changed (one saved, removed, renamed, used): Quick connect in
/// the menu follows. Its fastest free proxy speaks the protocol the free place
/// picked last spoke. Phones have no menu.
pub fn places_changed(app: &AppHandle) {
    #[cfg(desktop)]
    {
        use hproxy_places::Place;
        let (Some(state), Some(places)) = (
            app.try_state::<TrayState>(),
            app.try_state::<crate::places::PlacesState>(),
        ) else {
            return;
        };
        let socks5 = matches!(places.picked(), Some(Place::Free { socks5: true, .. }));
        let mut list = places.quick(MAX_TRAY_PLACES - 1);
        list.push((
            Place::Free {
                country: String::new(),
                socks5,
                exit: None,
                exit_country: None,
            },
            "Fastest free proxy".to_string(),
        ));
        if let Ok(mut known) = state.places.lock() {
            *known = list.clone();
        }
        let connected = state.connected.load(Ordering::SeqCst);
        let Some(tray) = app.tray_by_id("main") else { return };
        if let Ok((menu, toggle)) = menu(app, connected, &list) {
            if tray.set_menu(Some(menu)).is_ok() {
                if let Ok(mut t) = state.toggle.lock() {
                    *t = Some(toggle);
                }
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = app;
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
