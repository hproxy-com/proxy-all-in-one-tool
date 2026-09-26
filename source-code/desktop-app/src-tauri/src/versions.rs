//! Whether this copy is current, read from hproxy.com's version list (`hproxy_api::versions`).
//! Every copy asks, whatever installed it, and names the channel it updates from (the window
//! knows it: src/lib/versions.ts), so it is told about a version only once that channel has it.
//! The window then offers the update the channel's way. This side only fetches and compares.

use std::time::Duration;

use hproxy_api::versions::{fetch, verdict, Verdict, DEFAULT_VERSIONS_URL};

/// The notice for this copy, or None when there is nothing to say. A list that cannot be read
/// (offline, the file missing) is None as well: an update notice is never worth an error.
#[tauri::command]
pub async fn versions_check(app: tauri::AppHandle, channel: String) -> Option<Verdict> {
    let http = hproxy_api::http_client("hproxy-checker", Duration::from_secs(15));
    let list = match fetch(&http, DEFAULT_VERSIONS_URL).await {
        Ok(list) => list,
        Err(e) => {
            log::info!("{e}; trying again at the next check");
            return None;
        }
    };
    verdict(&app.package_info().version.to_string(), &list.app?, &channel)
}
