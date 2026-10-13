//! The doors Kotlin calls (phone-android, `com.hproxy.app.engine.Native`):
//!
//!   init(dataDir, sdk)       start the engine with the app's private folder
//!   call(method, argsJson)   everything else (engine.rs), JSON in, JSON out
//!   poll(timeoutMs)          the next event, or null
//!   tunnelStart(fd, proxy)   a new VPN descriptor, for a new tunnel (through
//!                            the proxy, or the firewall alone)
//!   tunnelSwap(fd)           a new descriptor for the running tunnel
//!   tunnelStop()             the tunnel ends, its descriptor closes
//!   setOwnerLookup(lookup)   Android 10+: who asks Android whose connection
//!                            a connection is (OwnerLookup.kt)
//!
//! Every door answers with JSON (`{"ok":true,"value":...}` or `{"ok":false,
//! "error":"..."}`), never throws, and catches a panic before it can cross
//! into the Java world, where it would end the app.

use std::net::{IpAddr, SocketAddr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;

use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
use jni::sys::{jboolean, jint, jstring};
use jni::{JNIEnv, JavaVM};
use serde_json::{json, Value};

use crate::engine::{self, Engine};
use crate::owner::OwnerOf;

/// The JSON every door answers with.
fn answer(r: Result<Value, String>) -> String {
    match r {
        Ok(v) => json!({ "ok": true, "value": v }).to_string(),
        Err(e) => json!({ "ok": false, "error": e }).to_string(),
    }
}

/// Runs `f`, a panic turned into an error.
fn guarded(f: impl FnOnce() -> Result<Value, String>) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => answer(r),
        Err(p) => {
            let why = p
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| p.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "unknown".into());
            log::error!("engine: a call panicked: {why}");
            answer(Err(format!("something went wrong inside the engine ({why})")))
        }
    }
}

fn text(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(String::from).unwrap_or_default()
}

fn out(env: &mut JNIEnv, s: String) -> jstring {
    env.new_string(s).map(|j| j.into_raw()).unwrap_or(std::ptr::null_mut())
}

fn started() -> Result<&'static Engine, String> {
    engine::engine()
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_init<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    data: JString<'l>,
    sdk: jint,
) -> jstring {
    let data = text(&mut env, &data);
    let r = guarded(|| {
        crate::logcat::start();
        engine::init(std::path::Path::new(&data), sdk)?;
        log::info!("engine: started, Android API {sdk}");
        Ok(Value::Null)
    });
    out(&mut env, r)
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_call<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    method: JString<'l>,
    args: JString<'l>,
) -> jstring {
    let method = text(&mut env, &method);
    let args = text(&mut env, &args);
    let r = guarded(|| started()?.call(&method, &args));
    out(&mut env, r)
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_poll<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    timeout_ms: jint,
) -> jstring {
    let next = catch_unwind(|| {
        let e = engine::engine().ok()?;
        e.events.poll(Duration::from_millis(timeout_ms.clamp(0, 60_000) as u64))
    })
    .ok()
    .flatten();
    match next {
        Some(event) => out(&mut env, event),
        None => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_tunnelStart<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    fd: jint,
    through_proxy: jboolean,
) -> jstring {
    let r = guarded(|| {
        #[cfg(unix)]
        {
            let e = started()?;
            // SAFETY: HProxyVpnService detached this descriptor for the engine
            // and keeps no copy of it.
            let fd = unsafe { crate::tunnel::owned(fd)? };
            crate::tunnel::start(e, fd, through_proxy != 0);
            Ok(Value::Null)
        }
        #[cfg(not(unix))]
        {
            let _ = (fd, through_proxy);
            Err("the VPN runs on a phone only".into())
        }
    });
    out(&mut env, r)
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_tunnelSwap<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    fd: jint,
) -> jstring {
    let r = guarded(|| {
        #[cfg(unix)]
        {
            let e = started()?;
            // SAFETY: as for tunnelStart.
            let fd = unsafe { crate::tunnel::owned(fd)? };
            crate::tunnel::swap(e, fd)?;
            Ok(Value::Null)
        }
        #[cfg(not(unix))]
        {
            let _ = fd;
            Err("the VPN runs on a phone only".into())
        }
    });
    out(&mut env, r)
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_tunnelStop<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
) -> jstring {
    let r = guarded(|| {
        #[cfg(unix)]
        crate::tunnel::stop(started()?);
        Ok(Value::Null)
    });
    out(&mut env, r)
}

#[no_mangle]
pub extern "system" fn Java_com_hproxy_app_engine_Native_setOwnerLookup<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    lookup: JObject<'l>,
) -> jstring {
    let r = (|| -> Result<Value, String> {
        let e = started()?;
        let vm = env.get_java_vm().map_err(|e| e.to_string())?;
        let lookup = env.new_global_ref(lookup).map_err(|e| e.to_string())?;
        e.firewall.set_owner(std::sync::Arc::new(JavaOwner { vm, lookup }));
        Ok(Value::Null)
    })();
    let r = answer(r);
    out(&mut env, r)
}

/// Android 10+: Kotlin asks `ConnectivityManager.getConnectionOwnerUid`
/// (OwnerLookup.kt, `uid(udp, srcIp, srcPort, dstIp, dstPort)`).
struct JavaOwner {
    vm: JavaVM,
    lookup: GlobalRef,
}

fn bytes(ip: IpAddr) -> Vec<u8> {
    match ip {
        IpAddr::V4(v4) => v4.octets().to_vec(),
        IpAddr::V6(v6) => v6.octets().to_vec(),
    }
}

impl OwnerOf for JavaOwner {
    fn owner(&self, udp: bool, from: SocketAddr, to: SocketAddr) -> Option<u32> {
        // The tunnel's threads are the engine's own: attached once, for good.
        let mut env = self.vm.attach_current_thread_permanently().ok()?;
        let r = env.with_local_frame(8, |env| -> jni::errors::Result<i32> {
            let src = env.byte_array_from_slice(&bytes(from.ip()))?;
            let dst = env.byte_array_from_slice(&bytes(to.ip()))?;
            env.call_method(
                &self.lookup,
                "uid",
                "(Z[BI[BI)I",
                &[
                    JValue::Bool(udp as u8),
                    JValue::Object(&src),
                    JValue::Int(i32::from(from.port())),
                    JValue::Object(&dst),
                    JValue::Int(i32::from(to.port())),
                ],
            )?
            .i()
        });
        match r {
            Ok(uid) if uid >= 0 => Some(uid as u32),
            Ok(_) => None,
            Err(_) => {
                let _ = env.exception_clear();
                None
            }
        }
    }
}
