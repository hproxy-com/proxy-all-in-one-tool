//! The support chat, for the phone app's Help tab (2026-10-11). The chat itself is
//! proxy-engine/hproxy-chat, shared with the desktop app since 2026-10-18; this names the phone
//! to it and tells the app what happens through its event queue ("chat" events). The socket
//! lives in the engine like every other network call; the app asks through `call`.

use std::sync::Arc;

use serde_json::Value;

use crate::events::Events;

/// Where the chat records the conversation began: this app. `page` adds the store and the version.
const PAGE: &str = "android-app://com.hproxy.app";
const AGENT: &str = "HProxy Android";

/// The chat, once per engine: at most one socket, opened by the app.
pub struct Chat(hproxy_chat::Chat);

impl Chat {
    pub fn new(events: Arc<Events>) -> Self {
        Chat(hproxy_chat::Chat::new(move |what| events.emit("chat", what)))
    }

    /// Open the socket, unless it is open already. `token`: the visitor token the chat gave last
    /// time, so the person's own thread comes back. `page`: where support sees the chat came
    /// from (`page()`).
    pub fn open(&self, rt: &tokio::runtime::Runtime, token: Option<String>, page: String) {
        let visitor = hproxy_chat::Visitor {
            page,
            agent: AGENT.to_string(),
        };
        if let Some(socket) = self.0.open(token, visitor) {
            rt.spawn(socket);
        }
    }

    /// A frame for the chat: `{op, data}`, and an `id` when the app wants the answers to it.
    pub fn send(&self, frame: Value) -> Result<(), String> {
        self.0.send(frame)
    }

    /// A message from the person, with the app's own id.
    pub fn send_message(&self, id: &str, body: &str) -> Result<(), String> {
        self.0.send_message(id, body)
    }

    /// The person read the thread.
    pub fn mark_read(&self, conversation_id: &str) -> Result<(), String> {
        self.0.mark_read(conversation_id)
    }

    /// Close the socket for good (the app left Help, or the app is going away).
    pub fn close(&self) {
        self.0.close();
    }
}

/// Where the chat records the conversation began: the app, the store this copy came from and its
/// version, so support reads "Android app · Google Play · 0.3.8" (2026-10-18).
pub fn page(store: Option<&str>, version: Option<&str>) -> String {
    hproxy_chat::page(PAGE, store, version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_names_the_phone_app_the_store_and_the_version() {
        assert_eq!(
            page(Some("google-play"), Some("0.3.8")),
            "android-app://com.hproxy.app?store=google-play&v=0.3.8"
        );
        assert_eq!(page(None, None), PAGE, "copies that know nothing send the app alone");
    }
}
