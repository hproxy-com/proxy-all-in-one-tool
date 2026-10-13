//! HProxy Mobile: the engine of the native phone app.
//!
//! The phone app (phone-android, Kotlin and Jetpack Compose) draws every
//! screen itself; everything that touches a proxy happens here, in the same
//! Rust the computer app and the command line run:
//!
//!   places     the person's proxies and groups (hproxy-places), in the app's
//!              private folder; a paste read before it is added
//!   engine     the connection (hproxy-connection): the relay, switching in
//!              place, the probes, the DNS leak test, the speed test
//!   tunnel     the phone's VPN (hproxy-tunnel): every app's packets through
//!              the relay, or out directly, or nowhere, by the firewall
//!   firewall   per app, by who owns each connection (owner.rs)
//!   checker    a list checked from the phone, each answer sent as it lands
//!   free       the free list, one exit a row, and fraud scores (engine.rs)
//!   chat       the support chat of the Help tab (chat.hproxy.com)
//!   events     what happens on its own, read by the app with `poll`
//!
//! The app reaches it through JNI (jni_glue.rs): `libhproxy_mobile.so`, the
//! class `com.hproxy.app.engine.Native`.

pub mod chat;
pub mod checker;
pub mod engine;
pub mod events;
pub mod firewall;
pub mod jni_glue;
pub mod logcat;
pub mod owner;
pub mod places;

#[cfg(unix)]
pub mod tunnel;
