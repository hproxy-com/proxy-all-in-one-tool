//! HProxy Tunnel: every app on a phone through the relay.
//!
//! THE PROBLEM. On a computer, the relay (hproxy-relay) sets itself as the
//! system proxy and every program follows. A phone has no such switch that
//! apps obey: a Wi-Fi proxy is ignored by many apps, and they go out with the
//! phone's real address. What every app does obey is a VPN.
//!
//! THE FIX. The app opens a VPN on the phone (Android's VpnService). Android
//! then hands it every packet every app sends, as raw IP. This crate turns those
//! packets back into ordinary connections with a TCP/IP stack (smoltcp), and
//! gives each one to the relay on 127.0.0.1 by SOCKS5, so the proxy, the login,
//! Next IP and switching places work exactly as on a computer.
//!
//!   phone apps ─► VPN ─► [this crate] ─► relay 127.0.0.1 ─► proxy ─► site
//!
//! What it decides:
//!   - DNS never leaves the phone: names get stand-in addresses (dns.rs) and
//!     the proxy looks them up, in its own country.
//!   - UDP other than DNS is dropped: an HTTP proxy cannot carry it, and
//!     sending it around the proxy would show the real address. Browsers fall
//!     back to TCP; voice calls and some games do not work while connected.
//!   - When the relay cannot connect, the app gets a reset at once. Nothing is
//!     ever sent around the proxy (no leak when the proxy is down).
//!   - IPv6 is taken as well as IPv4 (routes.rs): an address family the VPN
//!     left out would go out with the real address.
//!
//! The app itself is left out of its own VPN (VpnService.Builder's
//! addDisallowedApplication), so the relay reaches the real proxy directly.
//!
//! The firewall (the phone app's "Which apps"): a gate (gate.rs) decides each
//! new connection by the app that opened it: through the proxy, straight out
//! of this app's own sockets (direct.rs, and udp.rs for UDP), or blocked with
//! a reset. Without a gate every connection goes through the proxy, as before.

pub mod direct;
pub mod dns;
pub mod gate;
pub mod packet;
pub mod relay;
pub mod routes;
pub mod stack;
pub mod udp;

#[cfg(unix)]
pub mod fd;

use std::net::{Ipv4Addr, Ipv6Addr};

pub use gate::{Decision, Exits, Flow, Gate, ProxyAll};
pub use routes::{vpn_routes, Route};
pub use stack::{run, run_with};

/// The VPN's own addresses on the phone.
pub const TUN_V4: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 1);
pub const TUN_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x6870, 0, 0, 0, 0, 0, 1);
/// The DNS server the VPN gives the phone. Every DNS question is answered by
/// the tunnel, whichever server an app asks.
pub const DNS_V4: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 2);
/// The largest packet, as every network a phone is on carries it.
pub const MTU: u16 = 1500;

/// Whether an address is one of the stand-ins the tunnel's DNS gives out.
pub fn is_stand_in(ip: Ipv4Addr) -> bool {
    let net = u32::from(dns::FAKE_NET);
    let mask = !0u32 << (32 - dns::FAKE_PREFIX as u32);
    u32::from(ip) & mask == net && ip != TUN_V4 && ip != DNS_V4
}
