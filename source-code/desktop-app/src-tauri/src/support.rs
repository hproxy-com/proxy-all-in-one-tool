//! Help: talking to HProxy support from the app (2026-10-18, as the phone app has since
//! 2026-10-11). The socket is proxy-engine/hproxy-chat, the phone's own: the window asks here and
//! hears what happens as "chat" events. Support sees where a chat was written from: this app on
//! Windows, macOS or Linux, where this copy came from (channel.rs) and its version, as
//! "hproxy-app://windows?store=microsoft-store&v=0.3.9". Nothing else about the person goes out.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime, State};

/// The chat, one socket for the app.
pub struct SupportChat(hproxy_chat::Chat);

impl SupportChat {
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Self {
        let app = app.clone();
        SupportChat(hproxy_chat::Chat::new(move |what: Value| {
            let _ = app.emit("chat", what);
        }))
    }

    pub fn close(&self) {
        self.0.close();
    }
}

/// Which app this is, as the chat's inbox reads it ("Windows app"), and the name its socket gives.
fn app_of() -> (&'static str, &'static str) {
    if cfg!(target_os = "windows") {
        ("hproxy-app://windows", "HProxy Windows")
    } else if cfg!(target_os = "macos") {
        ("hproxy-app://mac", "HProxy Mac")
    } else {
        ("hproxy-app://linux", "HProxy Linux")
    }
}

/// Where this copy came from, in the words the chat's inbox knows: the installer from the
/// website, the Microsoft Store, or on Linux which package.
fn store_of(channel: crate::channel::Channel) -> &'static str {
    use crate::channel::Channel;
    match channel {
        Channel::MicrosoftStore => "microsoft-store",
        Channel::LinuxAppimage => "appimage",
        Channel::LinuxDeb => "deb",
        Channel::LinuxRpm => "rpm",
        _ => "website",
    }
}

/// Open the chat (Help showing). `token`: the visitor token the chat gave last time, so the
/// person's own thread comes back.
#[tauri::command]
pub fn chat_open(app: AppHandle, chat: State<'_, SupportChat>, token: Option<String>) {
    let (base, agent) = app_of();
    let store = store_of(crate::channel::current(&app));
    let visitor = hproxy_chat::Visitor {
        page: hproxy_chat::page(base, Some(store), Some(env!("CARGO_PKG_VERSION"))),
        agent: agent.to_string(),
    };
    if let Some(socket) = chat.0.open(token, visitor) {
        tauri::async_runtime::spawn(socket);
    }
}

/// A message from the person; `id` is the window's own, which the acknowledgements carry.
#[tauri::command]
pub fn chat_send(chat: State<'_, SupportChat>, id: String, body: String) -> Result<(), String> {
    chat.0.send_message(&id, &body)
}

/// The person read the thread: support sees it.
#[tauri::command]
pub fn chat_read(chat: State<'_, SupportChat>, conversation_id: String) -> Result<(), String> {
    chat.0.mark_read(&conversation_id)
}

/// Help is left: the socket closes.
#[tauri::command]
pub fn chat_close(chat: State<'_, SupportChat>) {
    chat.close();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::Channel;

    #[test]
    fn support_reads_where_the_copy_came_from() {
        assert_eq!(store_of(Channel::MicrosoftStore), "microsoft-store");
        assert_eq!(store_of(Channel::Windows), "website");
        assert_eq!(store_of(Channel::Macos), "website");
        assert_eq!(store_of(Channel::LinuxDeb), "deb");
        let (base, _) = app_of();
        assert!(base.starts_with("hproxy-app://"));
        assert_eq!(
            hproxy_chat::page(
                "hproxy-app://windows",
                Some(store_of(Channel::MicrosoftStore)),
                Some("0.3.9")
            ),
            "hproxy-app://windows?store=microsoft-store&v=0.3.9"
        );
    }
}
