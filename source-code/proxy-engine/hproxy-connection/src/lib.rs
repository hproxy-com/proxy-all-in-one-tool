//! HProxy Connection: one connection, for every door.
//!
//! A person connects through a place (one of their proxies, one of their
//! groups, or the free pool). Every door that connects (the phone app, the
//! computer app, the command line, the AI tool) needs the same steps, and
//! before this crate each door had its own copy of them:
//!
//!   source      a place becomes the relay's source: a saved line read from the
//!               library, a group's members in their order with its rule, or a
//!               free exit from the pool
//!   connection  the relay on this device, kept running while the place behind
//!               it changes, and the probes through it
//!   health      one probe through the relay: does traffic really get through,
//!               how long it takes, and which address it comes out with
//!   leak        which resolver the proxy looks names up with (DNS leak test)
//!   speed       how fast a download through the relay is
//!   sites       whether a working proxy also opens a given site (Google,
//!               Instagram, ...) or that site refuses its address
//!
//! "Working" means it carries your traffic: a probe that only reached a page
//! over plain HTTP, or never came back, is not working, whatever answered.
//!
//! The phone app reads all of it through `hproxy-mobile`. The computer app
//! reads `source`, `health` and `leak` today; its own connection code moves
//! onto `Connection` when the computer app's connection is rebuilt on it.

pub mod connection;
pub mod health;
pub mod leak;
pub mod sites;
pub mod source;
pub mod speed;

pub use connection::{Change, Connection, ProbePolicy, SourceInfo, Status};
pub use health::{Health, DEFAULT_PROBE_URL};
pub use source::{free_source, rotation_of, source_of, Built};

/// Unix milliseconds now.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
