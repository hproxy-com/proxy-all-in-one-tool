//! What happens in the engine on its own (a probe came back, a proxy was
//! checked, a blocked app tried), waiting for the app to read it.
//!
//! The app reads with `poll` on one thread of its own, which waits up to a
//! timeout for the next event: no call from Rust into Kotlin is needed for
//! anything but the firewall's question "whose connection is this?".

use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// Events waiting; past this the newest are dropped (the app reads the state
/// again whenever it comes back, so nothing is lost for good).
const WAITING: usize = 8192;

pub struct Events {
    tx: SyncSender<String>,
    rx: Mutex<Receiver<String>>,
}

impl Default for Events {
    fn default() -> Self {
        let (tx, rx) = sync_channel(WAITING);
        Events { tx, rx: Mutex::new(rx) }
    }
}

impl Events {
    /// One event: `{"type": kind, ...fields of what}`.
    pub fn emit(&self, kind: &str, what: impl Serialize) {
        let mut v = serde_json::to_value(what).unwrap_or(serde_json::Value::Null);
        let obj = match v.as_object_mut() {
            Some(o) => o,
            None => {
                v = serde_json::json!({ "value": v });
                v.as_object_mut().expect("just made an object")
            }
        };
        obj.insert("type".into(), kind.into());
        match self.tx.try_send(v.to_string()) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => log::warn!("events: the app is not reading, {kind} dropped"),
            Err(TrySendError::Disconnected(_)) => {}
        }
    }

    /// The next event, waiting up to `timeout`.
    pub fn poll(&self, timeout: Duration) -> Option<String> {
        let rx = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        match rx.recv_timeout(timeout) {
            Ok(e) => Some(e),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_event_carries_its_type_and_its_fields() {
        let e = Events::default();
        e.emit("health", serde_json::json!({ "ok": true }));
        e.emit("plain", 7);
        let first: serde_json::Value = serde_json::from_str(&e.poll(Duration::from_millis(10)).unwrap()).unwrap();
        assert_eq!(first["type"], "health");
        assert_eq!(first["ok"], true);
        let second: serde_json::Value = serde_json::from_str(&e.poll(Duration::from_millis(10)).unwrap()).unwrap();
        assert_eq!(
            (second["type"].as_str(), second["value"].as_i64()),
            (Some("plain"), Some(7))
        );
        assert!(e.poll(Duration::from_millis(10)).is_none(), "nothing more");
    }
}
