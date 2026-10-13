//! Which way each new connection goes: through the proxy, straight out, or
//! nowhere. The phone app's "Which apps" page (per app: through the proxy or
//! not, allowed on Wi-Fi, allowed on mobile data) is decided here, one
//! connection at a time, by the app that opened it.
//!
//! The tunnel asks the gate once per new TCP connection (at its first packet)
//! and once per new UDP flow. Who the app is, and what its rules say on the
//! network the phone is on now, is the gate's business (the phone app knows
//! both); the tunnel only carries the answer out:
//!
//!   Proxy   to the relay, as every connection went before the gate existed
//!   Direct  out of this app's own sockets, which Android keeps outside the
//!           VPN, so it leaves the way it would without HProxy
//!   Block   refused at once (a reset), so the app is told and nothing waits

use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Proxy,
    Direct,
    Block,
}

/// A new connection or UDP flow, as the phone sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flow {
    pub udp: bool,
    /// The app's end: the VPN address and the app's port.
    pub from: SocketAddr,
    /// Where it goes.
    pub to: SocketAddr,
    /// The name the app looked up for `to`, when `to` is a stand-in (dns.rs).
    pub name: Option<String>,
}

pub trait Gate: Send + Sync {
    fn decide(&self, flow: &Flow) -> Decision;
}

/// Every connection through the proxy: the tunnel without a firewall.
pub struct ProxyAll;

impl Gate for ProxyAll {
    fn decide(&self, _: &Flow) -> Decision {
        Decision::Proxy
    }
}

/// Where the tunnel sends what it carries.
#[derive(Clone)]
pub struct Exits {
    /// The relay, for connections the gate sends through the proxy. `None`
    /// while no proxy is connected and only the firewall runs: a connection
    /// meant for the proxy is then refused, never sent around it.
    pub relay: Option<SocketAddr>,
    pub gate: Arc<dyn Gate>,
}

impl Exits {
    /// Everything through the relay on `relay`.
    pub fn through(relay: SocketAddr) -> Exits {
        Exits {
            relay: Some(relay),
            gate: Arc::new(ProxyAll),
        }
    }
}
