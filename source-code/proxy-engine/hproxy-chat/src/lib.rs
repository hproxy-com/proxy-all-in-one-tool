//! The support chat, for the apps' Help pages (2026-10-11 on the phone, 2026-10-18 on the
//! computer too): one client for both, so they speak the chat the same way.
//!
//! People talk to HProxy support from the app, and an idea goes to the same chat. The app is a
//! visitor of the HProxy brand's chat at chat.hproxy.com, the same chat the website's launcher
//! opens, speaking its socket protocol: `session.hello`, answered by `session.ready` (the
//! visitor's token, the open thread, whether someone is there, the brand's own words);
//! `messages.history`; `message.send`; `message.read`; and what comes back by itself:
//! `message.new`, `message.ack`, `typing.agent.*`, `agent.online_status`.
//!
//! The app hands `Chat::new` where to tell what happens (the phone's event queue, the desktop
//! window's "chat" event), and runs the socket on its own runtime (`open` returns it). Nothing
//! about the person goes out but what they type: no proxy, no password, no list. The page the
//! chat records it was opened on is the app itself (`page`), so support sees where a message came
//! from: which app, the store it came from, its version. The brand's host, never the company's:
//! the chat shows "HProxy support" and nothing else.
//!
//! TLS is the engine's own (rustls with ring, as everywhere else in it): the WebSocket library
//! only frames, it brings no TLS stack of its own.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// The brand's chat host (never the company's).
pub const CHAT_HOST: &str = "chat.hproxy.com";
/// The HProxy brand's workspace in the chat (public: the website carries it too).
pub const WORKSPACE: &str = "ws_01KS1JWD2PZPE12E7NZ9QFDG16";
/// The chat admits a visitor socket from the brand's own site: the app is the brand's own too.
const ORIGIN: &str = "https://hproxy.com";
/// The longest a socket may take to open before it counts as lost.
const OPEN_WITHIN: Duration = Duration::from_secs(12);
/// Waits between tries after a lost socket: 1, 2, 4 ... up to 30 seconds.
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// Who the chat sees: where the conversation began (`page`, the chat keeps it as the
/// conversation's first address) and the app's name for the socket ("HProxy Android").
#[derive(Debug, Clone)]
pub struct Visitor {
    pub page: String,
    pub agent: String,
}

/// Where the app is told what happens: `{ "kind": "ready" | "history" | "message" | ... }`.
type Sink = Arc<dyn Fn(Value) + Send + Sync>;

/// The chat, once per app: at most one socket, opened by the app.
pub struct Chat {
    tell: Sink,
    outbox: Mutex<Option<mpsc::UnboundedSender<Value>>>,
}

impl Chat {
    pub fn new(tell: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Chat {
            tell: Arc::new(tell),
            outbox: Mutex::new(None),
        }
    }

    fn outbox(&self) -> std::sync::MutexGuard<'_, Option<mpsc::UnboundedSender<Value>>> {
        self.outbox.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Open the socket, unless it is open already: the socket's life, for the app's runtime to
    /// run (None when one runs). `token`: the visitor token the chat gave last time, so the
    /// person's own thread comes back.
    pub fn open(&self, token: Option<String>, visitor: Visitor) -> Option<impl Future<Output = ()> + Send + 'static> {
        let mut slot = self.outbox();
        if slot.as_ref().is_some_and(|tx| !tx.is_closed()) {
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        *slot = Some(tx);
        let tell = Arc::clone(&self.tell);
        Some(run(token.filter(|t| !t.trim().is_empty()), visitor, rx, tell))
    }

    /// A frame for the chat: `{op, data}`, and an `id` when the app wants the answers to it (a
    /// message's acknowledgements carry it).
    pub fn send(&self, frame: Value) -> Result<(), String> {
        let slot = self.outbox();
        let tx = slot.as_ref().ok_or("the chat is not open")?;
        tx.send(frame).map_err(|_| "the chat is not open".to_string())
    }

    /// A message from the person. `id`: the app's own, which its acknowledgements carry.
    pub fn send_message(&self, id: &str, body: &str) -> Result<(), String> {
        let body = body.trim();
        if body.is_empty() {
            return Err("write something first".into());
        }
        self.send(json!({ "op": "message.send", "id": id, "data": { "body": body } }))
    }

    /// The person read the thread: support sees it.
    pub fn mark_read(&self, conversation_id: &str) -> Result<(), String> {
        self.send(json!({ "op": "message.read", "data": { "conversation_id": conversation_id } }))
    }

    /// Close the socket for good (the app left Help, or the app is going away).
    pub fn close(&self) {
        self.outbox().take();
    }
}

/// Where the chat records the conversation began: the app (`base`, "android-app://com.hproxy.app",
/// "hproxy-app://windows"), the store this copy came from and its version, so support reads
/// "Android app · Google Play · 0.3.8" (2026-10-18: support sees where each chat was written
/// from). Nothing about the person: the store and the version only.
pub fn page(base: &str, store: Option<&str>, version: Option<&str>) -> String {
    let part = |key: &str, value: Option<&str>| {
        value
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| format!("{key}={}", escaped(v)))
    };
    let query: Vec<String> = [part("store", store), part("v", version)]
        .into_iter()
        .flatten()
        .collect();
    if query.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", query.join("&"))
    }
}

/// Letters, digits and `-._~` as they are; everything else as `%XX`.
pub fn escaped(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Why one socket ended.
enum Ended {
    /// The app closed the chat.
    Closed,
    /// The network or the server dropped it: try again.
    Lost(String),
}

async fn run(mut token: Option<String>, visitor: Visitor, mut outbox: mpsc::UnboundedReceiver<Value>, tell: Sink) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match session(&mut token, &visitor, &mut outbox, &tell).await {
            Ended::Closed => return,
            Ended::Lost(why) => {
                log::info!("chat lost: {why}");
                tell(json!({ "kind": "down", "why": why }));
                // Waiting, still listening for the app closing the chat.
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    closed = wait_closed(&mut outbox) => if closed { return },
                }
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
}

/// While a socket is down, frames the app sends are dropped (the screen holds a message until it
/// is acknowledged); only the app closing matters.
async fn wait_closed(outbox: &mut mpsc::UnboundedReceiver<Value>) -> bool {
    loop {
        if outbox.recv().await.is_none() {
            return true;
        }
    }
}

fn tls() -> Arc<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("ring offers the default TLS versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
}

fn frame(op: &str, id: &str, data: Value) -> Message {
    Message::Text(json!({ "v": 1, "id": id, "op": op, "data": data }).to_string())
}

async fn session(
    token: &mut Option<String>,
    visitor: &Visitor,
    outbox: &mut mpsc::UnboundedReceiver<Value>,
    tell: &Sink,
) -> Ended {
    let opened = tokio::time::timeout(OPEN_WITHIN, async {
        let tcp = TcpStream::connect((CHAT_HOST, 443)).await.map_err(|e| e.to_string())?;
        let name = rustls::pki_types::ServerName::try_from(CHAT_HOST)
            .map_err(|e| e.to_string())?
            .to_owned();
        let tls = tokio_rustls::TlsConnector::from(tls())
            .connect(name, tcp)
            .await
            .map_err(|e| e.to_string())?;
        let mut url = format!(
            "wss://{CHAT_HOST}/ws?role=visitor&workspace={WORKSPACE}&url={}",
            escaped(&visitor.page)
        );
        if let Some(t) = token.as_deref() {
            url.push_str(&format!("&token={}", escaped(t)));
        }
        let mut request = url.into_client_request().map_err(|e| e.to_string())?;
        let headers = request.headers_mut();
        headers.insert("Origin", ORIGIN.parse().map_err(|_| "bad origin".to_string())?);
        headers.insert(
            "User-Agent",
            visitor.agent.parse().map_err(|_| "bad agent".to_string())?,
        );
        tokio_tungstenite::client_async(request, tls)
            .await
            .map(|(ws, _)| ws)
            .map_err(|e| e.to_string())
    })
    .await;
    let mut ws = match opened {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => return Ended::Lost(e),
        Err(_) => return Ended::Lost("the chat did not answer in time".into()),
    };

    if let Err(e) = ws
        .send(frame("session.hello", "hello", json!({ "workspace_id": WORKSPACE })))
        .await
    {
        return Ended::Lost(e.to_string());
    }

    loop {
        tokio::select! {
            incoming = ws.next() => {
                let text = match incoming {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Ping(p))) => {
                        if let Err(e) = ws.send(Message::Pong(p)).await {
                            return Ended::Lost(e.to_string());
                        }
                        continue;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ended::Lost("the chat closed the socket".into()),
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => return Ended::Lost(e.to_string()),
                };
                let Ok(envelope) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(next) = read(&envelope, token, tell) {
                    if let Err(e) = ws.send(next).await {
                        return Ended::Lost(e.to_string());
                    }
                }
            }
            asked = outbox.recv() => {
                let Some(f) = asked else {
                    let _ = ws.close(None).await;
                    return Ended::Closed;
                };
                let op = f.get("op").and_then(Value::as_str).unwrap_or_default().to_string();
                if op.is_empty() {
                    continue;
                }
                let id = f.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| op.clone());
                let data = f.get("data").cloned().unwrap_or_else(|| json!({}));
                if let Err(e) = ws.send(frame(&op, &id, data)).await {
                    return Ended::Lost(e.to_string());
                }
            }
        }
    }
}

/// One frame from the chat, told to the app; returns a frame to send back, when one is due (the
/// history of a thread the chat resumed).
fn read(envelope: &Value, token: &mut Option<String>, tell: &Sink) -> Option<Message> {
    let op = envelope.get("op").and_then(Value::as_str).unwrap_or_default();
    let data = envelope.get("data").cloned().unwrap_or(Value::Null);
    match op {
        "session.ready" => {
            if let Some(t) = data.get("visitor_token").and_then(Value::as_str) {
                *token = Some(t.to_string());
            }
            let conversation = data
                .get("active_conversation")
                .and_then(|c| c.get("id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let config = data.get("widget_config").cloned().unwrap_or(Value::Null);
            tell(json!({
                "kind": "ready",
                "token": token,
                "conversation": conversation,
                "online": data.get("agent_online").and_then(Value::as_bool).unwrap_or(false),
                "name": config.get("agent_display_name").cloned().unwrap_or(Value::Null),
                "greeting": config.get("greeting").cloned().unwrap_or(Value::Null),
                "welcome": config.get("welcome_message").cloned().unwrap_or(Value::Null),
                "replyTime": config.get("usual_reply_time").cloned()
                    .filter(|v| !v.is_null())
                    .or_else(|| config.get("reply_time_text").cloned())
                    .unwrap_or(Value::Null),
            }));
            conversation.map(|c| {
                frame(
                    "messages.history",
                    "history",
                    json!({ "conversation_id": c, "limit": 60 }),
                )
            })
        }
        "ack" => {
            if let Some(messages) = data.get("messages") {
                tell(json!({ "kind": "history", "messages": messages }));
            }
            None
        }
        "message.new" => {
            tell(json!({ "kind": "message", "message": data.get("message") }));
            None
        }
        "message.ack" => {
            tell(json!({ "kind": "ack", "ack": data }));
            None
        }
        "conversation.created" => {
            tell(json!({ "kind": "conversation", "conversation": data.get("conversation") }));
            None
        }
        "typing.agent.start" | "typing.agent.stop" => {
            tell(json!({ "kind": "typing", "on": op == "typing.agent.start" }));
            None
        }
        "agent.online_status" => {
            tell(json!({ "kind": "online", "online": data.get("online") }));
            None
        }
        "message.deleted" => {
            tell(json!({ "kind": "deleted", "id": data.get("message_id") }));
            None
        }
        "error" => {
            tell(json!({ "kind": "error", "id": envelope.get("id"), "error": data }));
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sink that keeps what it is told.
    fn kept() -> (Sink, Arc<Mutex<Vec<Value>>>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&told);
        (Arc::new(move |v| into.lock().unwrap().push(v)), told)
    }

    #[test]
    fn escapes_what_a_query_cannot_carry() {
        assert_eq!(
            escaped("android-app://com.hproxy.app"),
            "android-app%3A%2F%2Fcom.hproxy.app"
        );
        assert_eq!(escaped("abc_DEF-1.2~"), "abc_DEF-1.2~");
    }

    #[test]
    fn the_page_names_the_app_the_store_and_the_version() {
        const PHONE: &str = "android-app://com.hproxy.app";
        assert_eq!(
            page(PHONE, Some("google-play"), Some("0.3.8")),
            "android-app://com.hproxy.app?store=google-play&v=0.3.8"
        );
        assert_eq!(
            page("hproxy-app://windows", Some("microsoft-store"), Some("0.3.9")),
            "hproxy-app://windows?store=microsoft-store&v=0.3.9"
        );
        assert_eq!(page(PHONE, Some("apk"), None), "android-app://com.hproxy.app?store=apk");
        // Nothing known: the app alone, as phone copies before 2026-10-18 sent it.
        assert_eq!(page(PHONE, None, Some("  ")), PHONE);
        // A store name the chat could misread is carried escaped.
        assert_eq!(
            page(PHONE, Some("a&b"), None),
            "android-app://com.hproxy.app?store=a%26b"
        );
        // The whole address travels escaped inside the socket's own query.
        assert_eq!(
            escaped(&page(PHONE, Some("google-play"), Some("0.3.8"))),
            "android-app%3A%2F%2Fcom.hproxy.app%3Fstore%3Dgoogle-play%26v%3D0.3.8"
        );
    }

    #[test]
    fn ready_keeps_the_token_and_asks_for_the_thread() {
        let (sink, told) = kept();
        let mut token = None;
        let next = read(
            &json!({
                "v": 1, "id": "x", "op": "session.ready",
                "data": {
                    "visitor_token": "vt_123",
                    "active_conversation": { "id": "conv_1" },
                    "agent_online": true,
                    "widget_config": { "agent_display_name": "HProxy support", "usual_reply_time": "1-3 minutes" }
                }
            }),
            &mut token,
            &sink,
        );
        assert_eq!(token.as_deref(), Some("vt_123"));
        let Some(Message::Text(t)) = next else {
            panic!("a history request is due")
        };
        let sent: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(sent["op"], "messages.history");
        assert_eq!(sent["data"]["conversation_id"], "conv_1");
        let ready = &told.lock().unwrap()[0];
        assert_eq!(ready["kind"], "ready");
        assert_eq!(ready["online"], true);
        assert_eq!(ready["replyTime"], "1-3 minutes");
    }

    #[test]
    fn a_fresh_visitor_asks_for_no_history() {
        let (sink, _) = kept();
        let mut token = None;
        let next = read(
            &json!({ "op": "session.ready", "data": { "visitor_token": "vt_9" } }),
            &mut token,
            &sink,
        );
        assert!(next.is_none());
        assert_eq!(token.as_deref(), Some("vt_9"));
    }

    #[test]
    fn a_message_needs_words_and_a_closed_chat_says_so() {
        let chat = Chat::new(|_| {});
        assert_eq!(chat.send_message("app-1", "   "), Err("write something first".into()));
        assert_eq!(chat.send_message("app-1", "hi"), Err("the chat is not open".into()));
        let opened = chat.open(
            None,
            Visitor {
                page: "hproxy-app://windows".into(),
                agent: "HProxy Windows".into(),
            },
        );
        assert!(opened.is_some(), "the first open hands out the socket's life");
        assert!(
            chat.open(
                None,
                Visitor {
                    page: String::new(),
                    agent: String::new()
                }
            )
            .is_none(),
            "one socket at a time"
        );
        assert!(chat.send_message("app-1", "hi").is_ok(), "queued for the socket");
        chat.close();
        assert!(chat.mark_read("conv_1").is_err());
    }

    /// The real chat admits the app's socket and answers `session.ready`. Says hello only: no
    /// message is sent, so nobody is notified. By hand:
    /// `cargo test -p hproxy-chat live_chat -- --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "opens a socket to chat.hproxy.com"]
    async fn live_chat_admits_the_app() {
        let (sink, told) = kept();
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let task = tokio::spawn(async move {
            let mut token = None;
            let visitor = Visitor {
                page: page("hproxy-app://windows", Some("website"), None),
                agent: "HProxy Windows".into(),
            };
            let ended = session(&mut token, &visitor, &mut rx, &sink).await;
            if let Ended::Lost(why) = &ended {
                println!("lost: {why}");
            }
            (matches!(ended, Ended::Closed), token)
        });
        let mut ready = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if told.lock().unwrap().iter().any(|v| v["kind"] == "ready") {
                ready = true;
                break;
            }
        }
        drop(tx);
        let (closed, token) = task.await.unwrap();
        assert!(ready, "no session.ready from the chat");
        assert!(closed, "closing from the app ends the session cleanly");
        assert!(
            token.is_some_and(|t| !t.is_empty()),
            "the chat hands out a visitor token"
        );
    }
}
