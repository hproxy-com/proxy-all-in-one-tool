//! Reminders on the computer's own notifications: proxies and groups close to
//! the day they expire, three days before and on the day itself. What is due
//! and its words come from the library (hproxy-places, `reminders`), the same
//! for every app; this file reads the days now and then and shows them.

use std::path::Path;
use std::time::Duration;

use hproxy_places::reminders::{due, Said};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::places::PlacesState;

/// How often the days are read.
const EVERY: Duration = Duration::from_secs(30 * 60);

/// Read the days now and then, for as long as the app runs (in the tray too).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // After the start's own work.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            run(&app);
            tokio::time::sleep(EVERY).await;
        }
    });
}

fn run(app: &AppHandle) {
    let places = app.state::<PlacesState>();
    // A library kept in memory only has nowhere to remember what was said.
    let Some(dir) = places.dir().map(Path::to_path_buf) else {
        return;
    };
    let today = chrono::Local::now().date_naive().format("%Y-%m-%d").to_string();
    let mut said = Said::read(&dir);
    let notices = due(&places.view(), &today, &said);
    if notices.is_empty() {
        return;
    }
    for n in &notices {
        match app.notification().builder().title(&n.title).body(&n.body).show() {
            Ok(()) => {
                log::info!("reminder: {}", n.body);
                said.note(&n.key, &today);
            }
            Err(e) => log::warn!("a reminder could not be shown: {e}"),
        }
    }
    said.write(&dir, &today);
}
