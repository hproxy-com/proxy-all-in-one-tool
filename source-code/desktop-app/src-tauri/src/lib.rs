//! The desktop app: the engine (`hproxy_probe`) and the relay (`hproxy_relay`)
//! with a window around them. One module per screen or door:
//!
//!   check       the Checker screen: start a run, cancel it, read one line
//!   connect     the Connect screen: the relay and the system proxy setting
//!   files       import a list, export results: the dialogs open from Rust
//!   fraud       fraud scores of addresses, with the service picked in Settings
//!
//! The HProxy web APIs (locations, API-mode checking) are the `hproxy-api`
//! crate, shared with the CLI.
//!
//! The updater's policy lives in the window (`src/lib/updater.ts`): check on a
//! timer, download in the background, install on the person's click after
//! stopping Connect, or by itself while nobody is using the app (`update`).
//! The Rust side registers the plugin and puts the system proxy back on every
//! exit, whichever way the app ends.

mod check;
mod connect;
mod files;
mod fraud;
mod store;
mod tool;
mod tray;
mod update;
mod versions;

use tauri::Manager;

use check::AppState;

/// What the setups on Use with AI name to start this app as the tool with `mcp`
/// (src/main.rs): `hproxy` where the tool's folder is on the user's PATH or the
/// copy came from the Microsoft Store, else the program's full path (src/tool.rs).
#[tauri::command]
fn tool_command(app: tauri::AppHandle) -> Option<String> {
    tool::command(&app)
}

/// The argument the uninstaller starts this program with, followed by the AI
/// tool's folder (windows/installer-hooks.nsh; src/main.rs acts on it first).
#[cfg(windows)]
pub const FORGET_TOOL_PATH: &str = "--forget-tool-path";

/// Take the AI tool's folder off the user's PATH (src/tool.rs). Only a `tool`
/// folder inside the user's own local app data is accepted: the argument comes
/// from our uninstaller, and nothing else may leave the PATH this way. The exit
/// code: 0 done or nothing to do, 1 the PATH could not be written, 2 refused.
#[cfg(windows)]
pub fn forget_tool_path(dir: &str) -> i32 {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();
    let dir = std::path::Path::new(dir);
    let inside = !local.is_empty() && dir.to_string_lossy().to_lowercase().starts_with(&format!("{local}\\"));
    let is_tool = dir.file_name().is_some_and(|name| name.eq_ignore_ascii_case("tool"));
    if !(inside && is_tool) {
        return 2;
    }
    match tool::forget_path(dir) {
        Ok(_) => 0,
        Err(_) => 1,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // One copy at a time, and it goes first so a second launch ends before it
    // builds anything. Two copies would each run a relay and each take a
    // snapshot of the system proxy, and only one snapshot can be the truth.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        // `hproxy app --background` wakes the app in the tray; when it already
        // runs, that is done, and the window stays where it is.
        if args.iter().any(|a| a == "--background") {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    // Signed updates and the relaunch after one: desktop only. Phones update
    // through their store, and the two plugins do not build for them. Which
    // version is taken: newer, and signed after this build was released
    // (update.rs), so an old build of ours cannot come back as a new one.
    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_updater::Builder::new()
                .default_version_comparator(update::newer_and_signed_after_release)
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        // Start with the computer, only when the person ticks it in Settings
        // (off by default). Started that way, the app waits in the tray.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ));

    let app = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Logging. A windowed app has no terminal, so `eprintln!` goes nowhere
        // a user can reach, and a bug report arrives with nothing to go on.
        // This writes to a rotating file in the OS log directory (and to
        // stdout in dev), at Info by default so an ordinary run stays quiet.
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .max_file_size(2_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("hproxy-checker".into()),
                    }),
                ])
                .build(),
        )
        .setup(|app| {
            app.manage(AppState::new());
            app.manage(connect::RelayState::default());
            app.manage(tray::TrayState::default());
            // A previous run that died while connected left the system proxy
            // pointing at a relay that no longer exists. Put it back first.
            if let Some(notice) = connect::repair_on_start(app.handle()) {
                log::warn!("{notice}");
            }
            // The icon by the clock. Without it, closing must quit again, or
            // a closed window would leave the app running with no way back.
            #[cfg(desktop)]
            {
                if let Err(e) = tray::build(app.handle()) {
                    log::warn!("the tray icon could not be made: {e}");
                    tray::set_keep_running(app.handle().clone(), false);
                }
                // The AI assistant's tool: its own copy, which updates never
                // end (src/tool.rs), brought up to date with this build. The
                // Microsoft Store copy has the package's `hproxy` command
                // instead (src/store.rs).
                #[cfg(all(windows, not(debug_assertions)))]
                if !store::is_store_install() {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        tool::ensure_copy(&handle);
                    });
                }
                // Started with the computer, or again after a quiet update
                // (src/update.rs): wait in the tray, no window.
                let after_update = update::starts_hidden_after_update(app.handle());
                if after_update || std::env::args().any(|a| a == "--background") {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        // Closing hides the window to the tray while "Keep running in the
        // background" is on: the connection goes on, with no taskbar button.
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && tray::keeps_running(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            check::check_proxies,
            check::cancel_checks,
            check::check_line,
            check::parse_line,
            files::import_proxy_file,
            files::export_text_file,
            connect::connect_start,
            connect::connect_stop,
            connect::connect_status,
            connect::connect_rotate,
            connect::connect_probe,
            connect::connect_set_probe,
            connect::system_proxy_current,
            fraud::fraud_lookup,
            tray::set_keep_running,
            update::update_idle,
            update::update_install_quietly,
            store::store_install,
            versions::versions_check,
            tool_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app, event| {
        // Whichever way the app ends, a machine must never be left pointing at
        // a relay that no longer exists. Both events can fire; the restore
        // takes the running relay out of the state, so the second call finds
        // nothing to do.
        if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
            connect::restore_on_exit(app);
        }
    });
}
