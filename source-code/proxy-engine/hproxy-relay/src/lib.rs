//! HProxy Relay: makes an authenticated proxy usable from software that
//! cannot log in to one.
//!
//! THE PROBLEM. A large amount of software cannot send a proxy username and
//! password, or can only do it badly:
//!
//!   - Windows has no field for proxy credentials in its own settings, so it
//!     waits and pops a login box at whatever moment traffic first flows.
//!   - Chrome's `--proxy-server` flag accepts a host and port and nothing else.
//!   - Most games, most torrent clients and plenty of command line tools ignore
//!     the system proxy entirely, and the ones with their own proxy box often
//!     have no credential fields next to it.
//!   - The Windows proxy setting cannot speak SOCKS5 at all.
//!
//! THE FIX, which is old and boring and works: run a proxy on this machine that
//! needs no password, and have it forward everything to the real one with the
//! password attached. Every program on the computer then points at
//! `127.0.0.1:<port>`, which every program can do.
//!
//! `serve` is the whole thing. The command line, the desktop app and anything
//! else call it with a [`Source`] (a fixed line, the customer's own list with
//! a rotation rule, or the free pool with failover), a [`Stats`] to count into,
//! and a way to stop it.

pub mod cli;
pub mod pool;
pub mod relay;
pub mod source;
pub mod stats;
pub mod upstream;

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::net::TcpListener;

pub use source::{Dialed, List, Rotation, Source, SourceKind, REST_FOR};
pub use stats::{Stats, StatsSnapshot};
pub use upstream::{Scheme, Upstream};

/// The default listen address. Loopback, so only this machine can use it.
pub const DEFAULT_LISTEN: &str = "127.0.0.1:8080";

/// Refuse to become an open proxy by accident.
///
/// This relay's whole purpose is to listen WITHOUT a password. On loopback that
/// is exactly right, because only this machine can reach it. On any other
/// interface it is an open relay, and open relays are found and abused within
/// minutes by people who will spend the customer's bandwidth on things the
/// customer would not choose. So a non-loopback bind takes an explicit flag.
pub fn check_bind(addr: &SocketAddr, allow_lan: bool) -> Result<(), String> {
    let loopback = match addr.ip() {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => v6.is_loopback(),
    };
    if loopback || allow_lan {
        return Ok(());
    }
    Err(format!(
        "refusing to listen on {addr}.\n\n\
         This relay accepts connections with NO password, which is safe on\n\
         127.0.0.1 because only this machine can reach it. On {} anyone who can\n\
         reach this port can use your proxy and spend your traffic.\n\n\
         If you genuinely want that on a trusted private network, pass --allow-lan\n\
         and put a firewall rule in front of it.",
        addr.ip()
    ))
}

/// Listen on `addr` and relay every connection through `source` until
/// `shutdown` resolves. `on_ready` is called once with the bound address, which
/// matters when the caller asked for port 0.
///
/// The caller keeps its own handles on `source` and `stats`: that is how a
/// window switches upstream on request and reads the counters while the relay
/// runs.
pub async fn serve<R, S>(
    addr: SocketAddr,
    allow_lan: bool,
    verbose: bool,
    source: Arc<Source>,
    stats: Arc<Stats>,
    on_ready: R,
    shutdown: S,
) -> Result<(), String>
where
    R: FnOnce(SocketAddr),
    S: Future<Output = ()>,
{
    check_bind(&addr, allow_lan)?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("could not listen on {addr}: {e}"))?;
    let local = listener.local_addr().unwrap_or(addr);
    on_ready(local);

    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((sock, _peer)) => {
                        // Nagle batches small writes, which on an interactive
                        // tunnel shows up as a stall before the first byte.
                        let _ = sock.set_nodelay(true);
                        let src = Arc::clone(&source);
                        let stats = Arc::clone(&stats);
                        tokio::spawn(async move { relay::handle(sock, &src, verbose, &stats).await });
                    }
                    Err(e) => {
                        // One failed accept (a descriptor limit, a client that
                        // vanished mid-handshake) must not end the process:
                        // this runs unattended in a tray for hours.
                        if verbose {
                            eprintln!("  accept failed: {e}");
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    }
                }
            }
            _ = &mut shutdown => {
                return Ok(());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sock(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn loopback_binds_are_allowed() {
        assert!(check_bind(&sock("127.0.0.1:8080"), false).is_ok());
        assert!(check_bind(&sock("[::1]:8080"), false).is_ok());
    }

    #[test]
    fn a_public_bind_is_refused_without_the_flag() {
        let err = check_bind(&sock("0.0.0.0:8080"), false).unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        assert!(err.contains("--allow-lan"), "{err}");
        assert!(check_bind(&sock("192.168.1.5:8080"), false).is_err());
    }

    #[test]
    fn the_flag_permits_it_deliberately() {
        assert!(check_bind(&sock("0.0.0.0:8080"), true).is_ok());
    }

    #[tokio::test]
    async fn serve_binds_reports_the_port_and_stops_on_shutdown() {
        let up = upstream::parse("198.51.100.7:8080:u:p").unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<SocketAddr>();
        let task = tokio::spawn(async move {
            serve(
                sock("127.0.0.1:0"),
                false,
                false,
                Arc::new(Source::Fixed(up)),
                Arc::new(Stats::default()),
                |a| {
                    let _ = ready_tx.send(a);
                },
                async {
                    let _ = rx.await;
                },
            )
            .await
        });
        let bound = ready_rx.await.expect("serve must report its address");
        assert_ne!(bound.port(), 0);
        assert!(tokio::net::TcpStream::connect(bound).await.is_ok());
        let _ = tx.send(());
        assert!(task.await.unwrap().is_ok());
    }
}
