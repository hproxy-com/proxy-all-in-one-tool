//! The support chat, for the app's Help tab (2026-10-11).
//!
//! People talk to HProxy support from the app, and an idea goes to the same
//! chat. The app is a visitor of the HProxy brand's chat at chat.hproxy.com,
//! the same chat the website's launcher opens, speaking its socket protocol:
//! `session.hello`, answered by `session.ready` (the
//! visitor's token, the open thread, whether someone is there, the brand's
//! own words); `messages.history`; `message.send`; and what comes back by
//! itself: `message.new`, `message.ack`, `typing.agent.*`,
//! `agent.online_status`.
//!
//! The socket lives in the engine like every other network call; the app
//! asks through `call` and reads what happens from the event queue ("chat"
//! events). Nothing about the person goes out but what they type: no proxy,
//! no password, no list. The page the chat records it was opened on is the
//! app itself, so support sees where a message came from. The brand's host,
//! never the company's: the chat shows "HProxy support" and nothing else.
//!
//! TLS is the engine's own (rustls with ring, as everywhere else in it):
//! the WebSocket library only frames, it brings no TLS stack of its own.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::events::Events;

/// The brand's chat host (never the company's).
pub const CHAT_HOST: &str = "chat.hproxy.com";
/// The HProxy brand's workspace in the chat (public: the website carries it too).
pub const WORKSPACE: &str = "ws_01KS1JWD2PZPE12E7NZ9QFDG16";
/// The chat admits a visitor socket from the brand's own site: the app is the
/// brand's own too.
const ORIGIN: &str = "https://hproxy.com";
/// Where the chat records the conversation began.
const PAGE: &str = "android-app://com.hproxy.app";
const AGENT: &str = "HProxy Android";
/// The longest a socket may take to open before it counts as lost.
const OPEN_WITHIN: Duration = Duration::from_secs(12);
/// Waits between tries after a lost socket: 1, 2, 4 ... up to 30 seconds.
const BACKOFF_MAX: Duration = Duration::from_secs(30);

/// The chat, once per engine: at most one socket, opened by the app.
pub struct Chat {
    events: Arc<Events>,
    outbox: Mutex<Option<mpsc::UnboundedSender<Value>>>,
}

impl Chat {
    pub fn new(events: Arc<Events>) -> Self {
        Chat {
            events,
            outbox: Mutex::new(None),
        }
    }

    fn outbox(&self) -> std::sync::MutexGuard<'_, Option<mpsc::UnboundedSender<Value>>> {
        self.outbox.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Open the socket, unless it is open already. `token`: the visitor token
    /// the chat gave last time, so the person's own thread comes back.
    pub fn open(&self, rt: &tokio::runtime::Runtime, token: Option<String>) {
        let mut slot = self.outbox();
        if slot.as_ref().is_some_and(|tx| !tx.is_closed()) {
            return;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        *slot = Some(tx);
        let events = Arc::clone(&self.events);
        rt.spawn(run(token.filter(|t| !t.trim().is_empty()), rx, events));
    }

    /// A frame for the chat: `{op, data}`, and an `id` when the app wants the
    /// answers to it (a message's acknowledgements carry it).
    pub fn send(&self, frame: Value) -> Result<(), String> {
        let slot = self.outbox();
        let tx = slot.as_ref().ok_or("the chat is not open")?;
        tx.send(frame).map_err(|_| "the chat is not open".to_string())
    }

    /// Close the socket for good (the app left Help, or the app is going away).
    pub fn close(&self) {
        self.outbox().take();
    }
}

/// Why one socket ended.
enum Ended {
    /// The app closed the chat.
    Closed,
    /// The network or the server dropped it: try again.
    Lost(String),
}

async fn run(mut token: Option<String>, mut outbox: mpsc::UnboundedReceiver<Value>, events: Arc<Events>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match session(&mut token, &mut outbox, &events).await {
            Ended::Closed => return,
            Ended::Lost(why) => {
                log::info!("chat lost: {why}");
                events.emit("chat", json!({ "kind": "down", "why": why }));
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

/// While a socket is down, frames the app sends are dropped (the screen holds
/// a message until it is acknowledged); only the app closing matters.
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

/// Letters, digits and `-._~` as they are; everything else as `%XX`.
fn escaped(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn frame(op: &str, id: &str, data: Value) -> Message {
    Message::Text(json!({ "v": 1, "id": id, "op": op, "data": data }).to_string())
}

async fn session(
    token: &mut Option<String>,
    outbox: &mut mpsc::UnboundedReceiver<Value>,
    events: &Arc<Events>,
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
            escaped(PAGE)
        );
        if let Some(t) = token.as_deref() {
            url.push_str(&format!("&token={}", escaped(t)));
        }
        let mut request = url.into_client_request().map_err(|e| e.to_string())?;
        let headers = request.headers_mut();
        headers.insert("Origin", ORIGIN.parse().map_err(|_| "bad origin".to_string())?);
        headers.insert("User-Agent", AGENT.parse().map_err(|_| "bad agent".to_string())?);
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
                if let Some(next) = read(&envelope, token, events) {
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

/// One frame from the chat, told to the app; returns a frame to send back,
/// when one is due (the history of a thread the chat resumed).
fn read(envelope: &Value, token: &mut Option<String>, events: &Arc<Events>) -> Option<Message> {
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
            events.emit(
                "chat",
                json!({
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
                }),
            );
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
                events.emit("chat", json!({ "kind": "history", "messages": messages }));
            }
            None
        }
        "message.new" => {
            events.emit("chat", json!({ "kind": "message", "message": data.get("message") }));
            None
        }
        "message.ack" => {
            events.emit("chat", json!({ "kind": "ack", "ack": data }));
            None
        }
        "conversation.created" => {
            events.emit(
                "chat",
                json!({ "kind": "conversation", "conversation": data.get("conversation") }),
            );
            None
        }
        "typing.agent.start" | "typing.agent.stop" => {
            events.emit("chat", json!({ "kind": "typing", "on": op == "typing.agent.start" }));
            None
        }
        "agent.online_status" => {
            events.emit("chat", json!({ "kind": "online", "online": data.get("online") }));
            None
        }
        "message.deleted" => {
            events.emit("chat", json!({ "kind": "deleted", "id": data.get("message_id") }));
            None
        }
        "error" => {
            events.emit(
                "chat",
                json!({ "kind": "error", "id": envelope.get("id"), "error": data }),
            );
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_a_query_cannot_carry() {
        assert_eq!(
            escaped("android-app://com.hproxy.app"),
            "android-app%3A%2F%2Fcom.hproxy.app"
        );
        assert_eq!(escaped("abc_DEF-1.2~"), "abc_DEF-1.2~");
    }

    #[test]
    fn ready_keeps_the_token_and_asks_for_the_thread() {
        let events = Arc::new(Events::default());
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
            &events,
        );
        assert_eq!(token.as_deref(), Some("vt_123"));
        let Some(Message::Text(t)) = next else {
            panic!("a history request is due")
        };
        let sent: Value = serde_json::from_str(&t).unwrap();
        assert_eq!(sent["op"], "messages.history");
        assert_eq!(sent["data"]["conversation_id"], "conv_1");
    }

    /// The real chat admits the app's socket and answers `session.ready`. Says
    /// hello only: no message is sent, so nobody is notified. By hand:
    /// `cargo test -p hproxy-mobile live_chat -- --ignored --nocapture`.
    // Multi-threaded, like the engine's own runtime: the test waits on the
    // event queue with a blocking poll, which would starve a one-thread runtime.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "opens a socket to chat.hproxy.com"]
    async fn live_chat_admits_the_app() {
        let events = Arc::new(Events::default());
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let session_events = Arc::clone(&events);
        let task = tokio::spawn(async move {
            let mut token = None;
            let ended = session(&mut token, &mut rx, &session_events).await;
            if let Ended::Lost(why) = &ended {
                println!("lost: {why}");
            }
            (matches!(ended, Ended::Closed), token)
        });
        let mut ready = None;
        for _ in 0..30 {
            if let Some(e) = events.poll(Duration::from_millis(500)) {
                let v: Value = serde_json::from_str(&e).unwrap();
                println!("{v}");
                if v["what"]["kind"] == "ready" || v["data"]["kind"] == "ready" || e.contains("\"ready\"") {
                    ready = Some(v);
                    break;
                }
            }
        }
        drop(tx);
        let (closed, token) = task.await.unwrap();
        assert!(ready.is_some(), "no session.ready from the chat");
        assert!(closed, "closing from the app ends the session cleanly");
        assert!(
            token.is_some_and(|t| !t.is_empty()),
            "the chat hands out a visitor token"
        );
    }

    #[test]
    fn a_fresh_visitor_asks_for_no_history() {
        let events = Arc::new(Events::default());
        let mut token = None;
        let next = read(
            &json!({ "op": "session.ready", "data": { "visitor_token": "vt_9" } }),
            &mut token,
            &events,
        );
        assert!(next.is_none());
        assert_eq!(token.as_deref(), Some("vt_9"));
    }
}
