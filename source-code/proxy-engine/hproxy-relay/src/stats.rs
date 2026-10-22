//! Live counters for one relay, so a window can say what the tunnel is doing
//! instead of "connected" and nothing else.
//!
//! Bytes are counted on the PROXY side of each connection: everything written
//! towards the proxy is "up", everything read from it is "down". The request
//! head the relay adds is counted too, which is honest: it went up the wire.
//! Counting happens inside `poll_read` and `poll_write`, so a download that
//! runs for an hour moves the number the whole hour, not once at the end.

use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Why a connection could not reach the proxy, in the fixed words the apps'
/// usage counts take (hproxy-api, `usage::FAILURES`): one word, never the
/// proxy's own text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Why {
    Timeout,
    Login,
    Refused,
    Dns,
    Blocked,
    Other,
}

impl Why {
    pub fn as_str(self) -> &'static str {
        match self {
            Why::Timeout => "timeout",
            Why::Login => "login",
            Why::Refused => "refused",
            Why::Dns => "dns",
            Why::Blocked => "blocked",
            Why::Other => "other",
        }
    }

    const ALL: [Why; 6] = [
        Why::Timeout,
        Why::Login,
        Why::Refused,
        Why::Dns,
        Why::Blocked,
        Why::Other,
    ];

    fn code(self) -> u8 {
        Why::ALL.iter().position(|w| *w == self).map_or(0, |i| i as u8 + 1)
    }

    fn of_code(code: u8) -> Option<Why> {
        Why::ALL.get(usize::from(code).checked_sub(1)?).copied()
    }
}

#[derive(Debug, Default)]
pub struct Stats {
    /// Client connections accepted since the relay started.
    connections: AtomicU64,
    /// Client connections open right now.
    active: AtomicU64,
    /// Connections that could not reach the proxy, even after a failover.
    failures: AtomicU64,
    /// Why the newest of those failed (`Why`, 0 = none since the last `take_why`).
    why: AtomicU8,
    /// Upstream switches: a failover, or one the person asked for.
    rotations: AtomicU64,
    /// Bytes sent towards the proxy.
    bytes_up: AtomicU64,
    /// Bytes received from the proxy.
    bytes_down: AtomicU64,
}

/// The counters at one moment, in the shape a window receives them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct StatsSnapshot {
    pub connections: u64,
    pub active: u64,
    pub failures: u64,
    pub rotations: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
}

impl Stats {
    pub fn snapshot(&self) -> StatsSnapshot {
        StatsSnapshot {
            connections: self.connections.load(Ordering::Relaxed),
            active: self.active.load(Ordering::Relaxed),
            failures: self.failures.load(Ordering::Relaxed),
            rotations: self.rotations.load(Ordering::Relaxed),
            bytes_up: self.bytes_up.load(Ordering::Relaxed),
            bytes_down: self.bytes_down.load(Ordering::Relaxed),
        }
    }

    /// A client connection was accepted. The guard counts it as open until it
    /// is dropped, whichever way the connection ends.
    pub fn opened(&self) -> Open<'_> {
        self.connections.fetch_add(1, Ordering::Relaxed);
        self.active.fetch_add(1, Ordering::Relaxed);
        Open(self)
    }

    /// A connection could not reach the proxy.
    pub fn failed(&self) {
        self.failures.fetch_add(1, Ordering::Relaxed);
    }

    /// A connection could not reach the proxy, for `why`.
    pub fn failed_for(&self, why: Why) {
        self.failed();
        self.why.store(why.code(), Ordering::Relaxed);
    }

    /// Why the newest failure since the last call happened, and forget it: a
    /// connection that starts reads it once, so an older failure never
    /// passes for its own.
    pub fn take_why(&self) -> Option<Why> {
        Why::of_code(self.why.swap(0, Ordering::Relaxed))
    }

    /// The source switched upstream.
    pub fn rotated(&self) {
        self.rotations.fetch_add(1, Ordering::Relaxed);
    }
}

/// One open client connection. Dropping it closes the count.
pub struct Open<'a>(&'a Stats);

impl Drop for Open<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// The proxy side of a connection, with every byte counted.
pub struct Counted<S> {
    inner: S,
    stats: Arc<Stats>,
}

impl<S> Counted<S> {
    pub fn new(inner: S, stats: Arc<Stats>) -> Self {
        Self { inner, stats }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &polled {
            let n = buf.filled().len() - before;
            self.stats.bytes_down.fetch_add(n as u64, Ordering::Relaxed);
        }
        polled
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.inner).poll_write(cx, data);
        if let Poll::Ready(Ok(n)) = &polled {
            self.stats.bytes_up.fetch_add(*n as u64, Ordering::Relaxed);
        }
        polled
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn bytes_are_counted_per_direction_as_they_flow() {
        let stats = Arc::new(Stats::default());
        let (near, mut far) = tokio::io::duplex(64);
        let mut counted = Counted::new(near, Arc::clone(&stats));

        counted.write_all(b"hello").await.unwrap();
        far.write_all(b"seven!!").await.unwrap();
        let mut buf = [0u8; 16];
        let n = counted.read(&mut buf).await.unwrap();

        let s = stats.snapshot();
        assert_eq!(n, 7);
        assert_eq!(s.bytes_up, 5, "{s:?}");
        assert_eq!(s.bytes_down, 7, "{s:?}");
    }

    #[test]
    fn a_connection_is_open_until_its_guard_drops() {
        let stats = Stats::default();
        let first = stats.opened();
        let second = stats.opened();
        assert_eq!(stats.snapshot().active, 2);
        assert_eq!(stats.snapshot().connections, 2);
        drop(first);
        assert_eq!(stats.snapshot().active, 1);
        drop(second);
        let s = stats.snapshot();
        assert_eq!(s.active, 0);
        assert_eq!(s.connections, 2, "the total never goes down");
    }

    #[test]
    fn failures_and_rotations_count_up() {
        let stats = Stats::default();
        stats.failed();
        stats.rotated();
        stats.rotated();
        let s = stats.snapshot();
        assert_eq!((s.failures, s.rotations), (1, 2));
    }

    #[test]
    fn the_newest_failure_says_why_once() {
        let stats = Stats::default();
        assert_eq!(stats.take_why(), None);
        stats.failed_for(Why::Timeout);
        stats.failed_for(Why::Login);
        assert_eq!(stats.snapshot().failures, 2);
        assert_eq!(stats.take_why(), Some(Why::Login), "the newest one");
        assert_eq!(stats.take_why(), None, "read once");
        for why in Why::ALL {
            stats.failed_for(why);
            assert_eq!(stats.take_why(), Some(why));
        }
    }
}
