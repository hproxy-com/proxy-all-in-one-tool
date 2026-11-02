//! The doors Swift calls (ios-app): the same as jni_glue.rs, as plain C.
//!
//!   hproxy_init(dataDir, tunnel)    start the engine with the shared folder; the
//!                                   tunnel's process only reads the library
//!   hproxy_call(method, argsJson)   everything else (engine.rs), JSON in, JSON out
//!   hproxy_poll(timeoutMs)          the next event, or null
//!   hproxy_free(text)               give back a text one of these handed out
//!
//!   hproxy_tunnel_start(write, context, throughProxy)
//!   hproxy_tunnel_packet(packet, length)
//!   hproxy_tunnel_stop()
//!
//! On iOS the system hands an extension its packets through `packetFlow`, which
//! only Swift can read: there is no descriptor to give the tunnel, and the
//! private one some tunnels dig out is not allowed in the App Store. So packets
//! cross this door one by one: Swift passes each one it reads to
//! `hproxy_tunnel_packet`, and `write` is called with each one to send back. The
//! tunnel itself is the one the phone runs, on channels (hproxy-tunnel, stack.rs).
//!
//! Every door that answers, answers JSON (`{"ok":true,"value":...}` or
//! `{"ok":false,"error":"..."}`), never throws, and stops a panic here: one that
//! crossed into Swift would end the process.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::panic::catch_unwind;
use std::sync::Mutex;
use std::time::Duration;

use hproxy_tunnel::Exits;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::engine;
use crate::jni_glue::guarded;

/// Packets waiting in each direction between Swift and the tunnel.
const QUEUED: usize = 512;

/// Sends one packet out through `packetFlow`.
pub type Write = extern "C" fn(context: *mut c_void, packet: *const u8, length: usize);

/// What Swift handed over to be written to: it stays valid until
/// `hproxy_tunnel_stop` answered.
struct Writer {
    write: Write,
    context: *mut c_void,
}

// SAFETY: `context` belongs to Swift, which keeps it alive and whose `write` may
// be called from any thread (`packetFlow.writePackets` may).
unsafe impl Send for Writer {}

struct Running {
    into: mpsc::Sender<Vec<u8>>,
    stop: oneshot::Sender<()>,
}

static TUNNEL: Mutex<Option<Running>> = Mutex::new(None);

fn tunnel() -> std::sync::MutexGuard<'static, Option<Running>> {
    TUNNEL.lock().unwrap_or_else(|e| e.into_inner())
}

/// A text from Swift. Null and broken text are empty.
///
/// # Safety
///
/// `text` is null, or a C string that stays valid during this call.
unsafe fn text(text: *const c_char) -> String {
    if text.is_null() {
        return String::new();
    }
    CStr::from_ptr(text).to_string_lossy().into_owned()
}

/// A text for Swift, which gives it back through `hproxy_free`.
fn out(s: String) -> *mut c_char {
    // A NUL inside the JSON cannot happen: serde writes it as an escape.
    CString::new(s).map_or(std::ptr::null_mut(), CString::into_raw)
}

/// # Safety
///
/// `data` is null or a C string valid during this call.
#[no_mangle]
pub unsafe extern "C" fn hproxy_init(data: *const c_char, tunnel: bool) -> *mut c_char {
    let data = text(data);
    out(guarded(|| {
        let folder = std::path::Path::new(&data);
        if tunnel {
            engine::init_reading(folder)?;
        } else {
            engine::init(folder, 0)?;
        }
        log::info!("engine: started on iOS");
        Ok(Value::Null)
    }))
}

/// # Safety
///
/// Both are null or C strings valid during this call.
#[no_mangle]
pub unsafe extern "C" fn hproxy_call(method: *const c_char, args: *const c_char) -> *mut c_char {
    let (method, args) = (text(method), text(args));
    out(guarded(|| engine::engine()?.call(&method, &args)))
}

/// The next event, or null after `timeout_ms`.
#[no_mangle]
pub extern "C" fn hproxy_poll(timeout_ms: c_int) -> *mut c_char {
    let next = catch_unwind(|| {
        let e = engine::engine().ok()?;
        e.events.poll(Duration::from_millis(timeout_ms.clamp(0, 60_000) as u64))
    })
    .ok()
    .flatten();
    next.map_or(std::ptr::null_mut(), out)
}

/// # Safety
///
/// `text` is null, or came from one of these doors and was not given back yet.
#[no_mangle]
pub unsafe extern "C" fn hproxy_free(text: *mut c_char) {
    if !text.is_null() {
        drop(CString::from_raw(text));
    }
}

/// A new tunnel, replacing the one running. `through_proxy`: connections go to
/// the relay; off, they are refused, never sent around the proxy. `context`
/// stays valid until `hproxy_tunnel_stop` answered.
#[no_mangle]
pub extern "C" fn hproxy_tunnel_start(write: Write, context: *mut c_void, through_proxy: bool) -> *mut c_char {
    let writer = Writer { write, context };
    out(guarded(move || {
        let e = engine::engine()?;
        hproxy_tunnel_stop();
        let exits = match e.connection.listen().filter(|_| through_proxy) {
            Some(relay) => Exits::through(relay),
            None => Exits {
                relay: None,
                gate: std::sync::Arc::new(hproxy_tunnel::ProxyAll),
            },
        };
        let (into, from_phone) = mpsc::channel::<Vec<u8>>(QUEUED);
        let (to_phone, mut out_of_it) = mpsc::channel::<Vec<u8>>(QUEUED);
        let (stop, stopped) = oneshot::channel::<()>();
        e.rt.spawn(hproxy_tunnel::run_with(from_phone, to_phone, exits, async {
            let _ = stopped.await;
        }));
        e.rt.spawn(async move {
            // Taken whole: a closure would otherwise hold its fields one by one, and a raw pointer
            // alone may not cross threads.
            let writer = writer;
            while let Some(packet) = out_of_it.recv().await {
                (writer.write)(writer.context, packet.as_ptr(), packet.len());
            }
        });
        *tunnel() = Some(Running { into, stop });
        Ok(Value::Null)
    }))
}

/// One packet `packetFlow` read. Dropped when the tunnel is behind, as a network
/// drops it: the app's TCP sends it again.
///
/// # Safety
///
/// `packet` points at `length` bytes, valid during this call.
#[no_mangle]
pub unsafe extern "C" fn hproxy_tunnel_packet(packet: *const u8, length: usize) {
    if packet.is_null() || length == 0 {
        return;
    }
    let bytes = std::slice::from_raw_parts(packet, length).to_vec();
    if let Some(running) = tunnel().as_ref() {
        let _ = running.into.try_send(bytes);
    }
}

/// End the tunnel.
#[no_mangle]
pub extern "C" fn hproxy_tunnel_stop() {
    if let Some(running) = tunnel().take() {
        let _ = running.stop.send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_tunnel::packet::{self, Seen};
    use std::net::SocketAddr;
    use std::sync::mpsc::{channel, Sender};

    /// A text from these doors, read and given back.
    unsafe fn read(s: *mut c_char) -> serde_json::Value {
        assert!(!s.is_null());
        let answer = CStr::from_ptr(s).to_string_lossy().into_owned();
        hproxy_free(s);
        serde_json::from_str(&answer).unwrap()
    }

    extern "C" fn write(context: *mut c_void, packet: *const u8, length: usize) {
        // SAFETY: the test below keeps the sender alive, and `packet` is valid during this call.
        unsafe {
            let sent = &*(context as *const Mutex<Sender<Vec<u8>>>);
            let _ = sent
                .lock()
                .unwrap()
                .send(std::slice::from_raw_parts(packet, length).to_vec());
        }
    }

    /// A DNS question for example.com, as a phone asks it.
    fn question() -> Vec<u8> {
        let mut q = vec![0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        q.extend_from_slice(b"\x07example\x03com\x00");
        q.extend_from_slice(&[0, 1, 0, 1]);
        q
    }

    #[test]
    fn swift_reaches_the_engine_and_the_packets_cross_both_ways() {
        let dir = std::env::temp_dir().join(format!("hproxy-ffi-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = CString::new(dir.display().to_string()).unwrap();
        // SAFETY: each pointer comes from a CString that outlives its call, and every answer is
        // read and given back once.
        unsafe {
            assert_eq!(read(hproxy_init(path.as_ptr(), false))["ok"], true);

            let status = CString::new("status").unwrap();
            let none = CString::new("").unwrap();
            let answer = read(hproxy_call(status.as_ptr(), none.as_ptr()));
            assert_eq!(answer["ok"], true);
            assert_eq!(answer["value"]["running"], false);

            let wrong = CString::new("no such thing").unwrap();
            let answer = read(hproxy_call(wrong.as_ptr(), none.as_ptr()));
            assert_eq!(answer["ok"], false, "an error comes back as words");

            assert!(hproxy_poll(0).is_null(), "nothing has happened yet");

            let (sent, seen) = channel::<Vec<u8>>();
            let sent = Box::new(Mutex::new(sent));
            let context = &*sent as *const Mutex<Sender<Vec<u8>>> as *mut c_void;
            assert_eq!(read(hproxy_tunnel_start(write, context, false))["ok"], true);

            let phone: SocketAddr = "10.0.0.2:5353".parse().unwrap();
            let dns: SocketAddr = (hproxy_tunnel::DNS_V4, 53).into();
            let packet = packet::udp(phone, dns, &question()).unwrap();
            hproxy_tunnel_packet(packet.as_ptr(), packet.len());

            let answer = seen.recv_timeout(Duration::from_secs(5)).expect("the tunnel answered");
            match packet::read(&answer) {
                Seen::Udp { from, to, payload } => {
                    assert_eq!(from, dns);
                    assert_eq!(to, phone);
                    assert_eq!(&payload[..2], &[0x12, 0x34], "the answer to that question");
                }
                _ => panic!("expected a DNS answer"),
            }

            hproxy_tunnel_stop();
            hproxy_tunnel_packet(packet.as_ptr(), packet.len());
            assert!(
                seen.recv_timeout(Duration::from_millis(300)).is_err(),
                "a stopped tunnel takes nothing"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
