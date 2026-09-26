//! Timed dialling: the first two phases every probe shares.
//!
//! You cannot measure what you do not own. An HTTP library hands back one
//! number for a whole request because it owns the socket. To answer "was this
//! proxy slow because it is far away, or because it is overloaded" the
//! connection is opened here and the clock keeps running across the parts, so
//! DNS and TCP are measured exactly once per probe, in one place, the same way
//! for every transport.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

use crate::result::{Failure, FailureDetail, Phase};

/// Round a duration to whole milliseconds. Rounds rather than truncates: a
/// 0.6 ms connect reported as `0` reads as a broken measurement.
pub fn ms(d: Duration) -> u32 {
    let v = (d.as_secs_f64() * 1000.0).round();
    if v < 0.0 {
        0
    } else if v > u32::MAX as f64 {
        u32::MAX
    } else {
        v as u32
    }
}

/// A connected socket, plus what getting there cost.
pub struct Dialed {
    pub stream: TcpStream,
    /// `None` when the host was already a literal address. `None` means "no
    /// lookup happened", which is a different statement from `Some(0)`.
    pub dns_ms: Option<u32>,
    pub connect_ms: u32,
    /// The address actually reached. A proxy pasted as a hostname is compared
    /// against this, not its name, when deciding whether traffic left by a
    /// different door than it entered.
    pub peer: Option<SocketAddr>,
}

/// Why a dial failed, in the vocabulary the row is described with.
#[derive(Debug)]
pub struct DialError {
    pub detail: FailureDetail,
}

impl DialError {
    fn new(kind: Failure, phase: Phase, started: Instant) -> Self {
        Self {
            detail: FailureDetail {
                kind,
                phase,
                elapsed_ms: ms(started.elapsed()),
                status: None,
            },
        }
    }
}

/// The least a connect budget should be. Windows reports a refused connection
/// only after retrying the SYN, about two seconds after the RST (measured
/// 2026-09-16, see tests/refused_timing.rs); a budget under that turns every
/// closed port into a "timeout", which is the wrong word and hides the one
/// fact a reader can act on.
pub const MIN_CONNECT_BUDGET: Duration = Duration::from_millis(2500);

/// Resolve if needed, then connect, timing each phase separately.
///
/// `budget` bounds the whole operation, not each step, so a slow resolver cannot
/// hand a connect attempt a fresh full timeout.
pub async fn dial(host: &str, port: u16, budget: Duration) -> Result<Dialed, DialError> {
    let started = Instant::now();

    let (addrs, dns_ms) = match host.parse::<IpAddr>() {
        Ok(ip) => (vec![SocketAddr::new(ip, port)], None),
        Err(_) => {
            let t = Instant::now();
            let lookup = tokio::time::timeout(budget, tokio::net::lookup_host((host, port))).await;
            let resolved: Vec<SocketAddr> = match lookup {
                Err(_) => return Err(DialError::new(Failure::Timeout, Phase::Dns, started)),
                Ok(Err(_)) => return Err(DialError::new(Failure::Unresolved, Phase::Dns, started)),
                Ok(Ok(iter)) => iter.collect(),
            };
            (resolved, Some(ms(t.elapsed())))
        }
    };

    if addrs.is_empty() {
        return Err(DialError::new(Failure::Unresolved, Phase::Dns, started));
    }

    // Try every address, sharing what is left of the budget between the ones
    // still untried. A timeout must not end the loop: a dual-stack hostname
    // usually resolves IPv6-first, and on a network where IPv6 is blackholed
    // that address hangs rather than refusing. Giving up there reports a proxy
    // dead whose IPv4 address works. Each address gets a share, not the whole
    // budget, so a badly configured name cannot stall a worker N times over.
    // Timed as one span, because a first address that hung is time the user
    // genuinely waited.
    let t = Instant::now();
    let total = addrs.len();
    let mut stream = None;
    let mut last: Option<(Failure, io::ErrorKind)> = None;
    for (i, addr) in addrs.into_iter().enumerate() {
        let left = budget.saturating_sub(started.elapsed());
        if left.is_zero() {
            last = Some((Failure::Timeout, io::ErrorKind::TimedOut));
            break;
        }
        let share = left / (total - i) as u32;
        match tokio::time::timeout(share, TcpStream::connect(addr)).await {
            Ok(Ok(s)) => {
                stream = Some(s);
                break;
            }
            Ok(Err(e)) => last = Some((classify_io(&e), e.kind())),
            Err(_) => last = Some((Failure::Timeout, io::ErrorKind::TimedOut)),
        }
    }
    let Some(stream) = stream else {
        let kind = last.map(|(k, _)| k).unwrap_or(Failure::Refused);
        return Err(DialError::new(kind, Phase::Connect, started));
    };
    let connect_ms = ms(t.elapsed());

    // Nagle holds a small write back waiting for an ACK on the previous one.
    // Every probe is exactly that shape, one tiny request then a read, so
    // leaving it on adds tens of milliseconds of pure measurement error.
    let _ = stream.set_nodelay(true);
    let peer = stream.peer_addr().ok();

    Ok(Dialed {
        stream,
        dns_ms,
        connect_ms,
        peer,
    })
}

/// A connect-layer error in the vocabulary. Refused and unreachable both mean
/// "nothing we can reach is listening"; a timeout is its own word because it
/// means something is silently dropping packets, which is a different thing
/// for the reader to do something about.
pub fn classify_io(e: &io::Error) -> Failure {
    match e.kind() {
        io::ErrorKind::TimedOut => Failure::Timeout,
        io::ErrorKind::ConnectionRefused
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::NotConnected
        | io::ErrorKind::AddrNotAvailable => Failure::Refused,
        io::ErrorKind::NotFound => Failure::Unresolved,
        _ => {
            // "Network unreachable" and "host unreachable" have no stable
            // ErrorKind on every platform; read the OS text.
            let text = e.to_string().to_ascii_lowercase();
            if text.contains("unreachable") || text.contains("no route") {
                Failure::Refused
            } else if text.contains("timed out") {
                Failure::Timeout
            } else {
                Failure::Transport
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn ms_rounds_rather_than_truncating() {
        assert_eq!(ms(Duration::from_micros(600)), 1);
        assert_eq!(ms(Duration::from_micros(400)), 0);
        assert_eq!(ms(Duration::from_millis(250)), 250);
        assert_eq!(ms(Duration::from_secs(u64::MAX / 2)), u32::MAX);
    }

    #[tokio::test]
    async fn literal_address_reports_no_dns_phase() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let d = dial("127.0.0.1", addr.port(), Duration::from_secs(2))
            .await
            .expect("loopback must connect");
        assert!(d.dns_ms.is_none(), "a literal address must not report a DNS phase");
    }

    /// `localhost` resolves to `[::1]` before `127.0.0.1` and this listener is
    /// IPv4 only, so the first address must fail before the second succeeds.
    /// A dial that gave up on the first timeout would report a dual-stack proxy
    /// dead while its IPv4 works.
    #[tokio::test]
    async fn hostname_resolves_and_falls_through_to_a_working_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let d = dial("localhost", addr.port(), Duration::from_secs(6))
            .await
            .expect("must fall through");
        assert!(d.dns_ms.is_some(), "a hostname must report that a lookup happened");
        assert!(d.peer.is_some_and(|p| p.ip().is_loopback()));
    }

    /// 192.0.2.1 is TEST-NET-1 (RFC 5737), guaranteed unroutable: the dead-proxy
    /// path must give the worker back on schedule and say timeout, not hang.
    #[tokio::test]
    async fn unroutable_address_gives_up_within_the_budget() {
        let started = Instant::now();
        let r = dial("192.0.2.1", 8080, Duration::from_millis(600)).await;
        let e = r.err().expect("TEST-NET-1 must not connect");
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "overran: {:?}",
            started.elapsed()
        );
        assert_eq!(e.detail.phase, Phase::Connect);
        assert!(matches!(e.detail.kind, Failure::Timeout | Failure::Refused));
    }

    /// Bind, learn the port, drop the listener: the port is now closed. On
    /// Linux and macOS the refusal arrives in under a millisecond. On Windows
    /// Winsock retries the SYN after the RST and reports the refusal after
    /// about two seconds (measured, see tests/refused_timing.rs), which is why
    /// the engine's connect budget never goes below that.
    #[tokio::test]
    async fn a_closed_port_is_refused_and_says_so() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let e = dial("127.0.0.1", port, Duration::from_secs(4))
            .await
            .err()
            .expect("must fail");
        assert_eq!(e.detail.kind, Failure::Refused);
        assert_eq!(e.detail.phase, Phase::Connect);
        assert!(e.detail.elapsed_ms < 3500, "took {} ms", e.detail.elapsed_ms);
    }

    #[tokio::test]
    async fn an_unknown_name_is_unresolved_not_dead() {
        let e = dial("does-not-exist.invalid", 80, Duration::from_secs(5))
            .await
            .err()
            .expect("must fail");
        assert_eq!(e.detail.kind, Failure::Unresolved);
        assert_eq!(e.detail.phase, Phase::Dns);
    }
}
