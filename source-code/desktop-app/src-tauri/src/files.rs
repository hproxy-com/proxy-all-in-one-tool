//! Importing a list and exporting results, with the dialog on THIS side.
//!
//! The window never names a path. It asks "let the person pick a list" or
//! "let the person save this text", the native dialog opens from Rust, and
//! only the file the person chose is read or written. These used to be two
//! commands that took a path from JavaScript and read or wrote whatever it
//! said: fine while every caller is our own code, and an open door the day a
//! string from a proxy (a `Via` header, an ISP name) finds a way to run as
//! script in the window. A checker renders text written by strangers all day,
//! so the window gets no file access of its own and needs no dialog permission.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// Open the native file picker and return the chosen list's text.
/// `None` when the person closes the dialog without choosing.
#[tauri::command]
pub async fn import_proxy_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Proxy list", &["txt", "csv", "json", "list"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let Some(path) = rx
        .await
        .map_err(|_| "the file dialog closed unexpectedly".to_string())?
    else {
        return Ok(None);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Open the native save dialog and write `content` where the person says.
/// `false` when they close the dialog without choosing.
#[tauri::command]
pub async fn export_text_file(app: AppHandle, default_name: String, content: String) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(default_name).save_file(move |path| {
        let _ = tx.send(path);
    });
    let Some(path) = rx
        .await
        .map_err(|_| "the save dialog closed unexpectedly".to_string())?
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(true)
}
