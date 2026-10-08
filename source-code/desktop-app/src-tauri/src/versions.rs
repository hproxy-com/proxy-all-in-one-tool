//! Whether this copy is current, read from hproxy.com's version list (`hproxy_api::versions`).
//! Every copy asks, whatever installed it, naming the channel it updates from (src/channel.rs),
//! so it is told about a version only once that channel has it. The window then offers the
//! update the channel's way. This side only fetches and compares.
//!
//! The request says which version asks and from which channel, in its User-Agent line
//! (`hproxy-checker/0.2.4 (windows)`): the one thing the site learns from it, and what lets the
//! maintainers count how many copies run each version without any other request
//! (PRIVACY.md, "What leaves your machine").

use hproxy_api::versions::{check, Verdict};

use crate::channel;

/// The notice for this copy, or None when there is nothing to say. A list that cannot be read
/// (offline, the file missing) is None as well: an update notice is never worth an error.
#[tauri::command]
pub async fn versions_check(app: tauri::AppHandle) -> Option<Verdict> {
    let version = app.package_info().version.to_string();
    match check("hproxy-checker", &version, channel::current(&app).name()).await {
        Ok(verdict) => verdict,
        Err(e) => {
            log::info!("{e}; trying again at the next check");
            None
        }
    }
}
