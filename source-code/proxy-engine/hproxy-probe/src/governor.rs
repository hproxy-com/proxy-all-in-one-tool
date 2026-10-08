//! Adaptive concurrency: find the level this connection can actually sustain,
//! instead of making the user guess.
//!
//! Every checker asks for a thread count, and the number is a guess about a
//! machine and a line the author has never seen. Too high fills a home router's
//! connection table, new connections fail, and the checker faithfully reports
//! thousands of dead proxies: the tool blames the list for what the tool did.
//! Too low is safe everywhere and slow anywhere good.
//!
//! Watching the proxies themselves does not work: on a scraped list most are
//! dead on their own merits, so the failure rate says almost nothing about the
//! connection. So the governor does not measure the proxies. Every so often it
//! opens a plain TCP connection directly to our own judge, bypassing every
//! proxy, and times it. When the local link starts queueing, that number climbs
//! before anything else visibly breaks, whether the list is good or garbage.
//!
//! The control law is additive increase, multiplicative decrease, the shape TCP
//! uses for the same reason: climb gently while there is headroom, retreat
//! quickly when there is not. The user's setting is the CEILING, never a
//! target, so nobody's configured limit is ever exceeded.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Where a run begins, before it has learned anything about this connection.
const START: usize = 16;
/// Never throttle below this: a run has to make progress.
const FLOOR: usize = 4;
/// How often the canary runs: frequent enough to react inside a few seconds,
/// rare enough that the probe is not part of the load it measures.
const PROBE_EVERY: Duration = Duration::from_millis(1500);
/// A canary slower than this counts as failed rather than merely slow.
const CANARY_TIMEOUT: Duration = Duration::from_secs(4);
/// Additive increase, in slots per healthy reading.
const STEP_UP: usize = 8;
/// At or under this multiple of the best reading there is headroom: climb.
const HEALTHY: f64 = 1.35;
/// At or over this multiple the link is queueing: retreat.
const CONGESTED: f64 = 1.9;
/// Floor for the baseline, so jitter on a very fast link cannot produce huge
/// ratios and a thrashing governor.
const BASELINE_FLOOR: Duration = Duration::from_millis(5);

/// The control law, pure so it can be tested without a network. `ratio` is
/// the latest canary reading over the best one seen so far; `None` means no
/// usable reading, which is not the same as a bad one.
fn next_level(level: usize, ceiling: usize, ratio: Option<f64>) -> usize {
    let Some(ratio) = ratio else { return level };
    if ratio <= HEALTHY {
        (level + STEP_UP).min(ceiling)
    } else if ratio >= CONGESTED {
        (level * 2 / 3).max(FLOOR.min(ceiling))
    } else {
        // The band between the thresholds is deliberate: without it the level
        // oscillates around the boundary forever.
        level
    }
}

pub struct Governor {
    sem: Arc<Semaphore>,
    ceiling: usize,
    level: AtomicUsize,
    peak: AtomicUsize,
}

impl Governor {
    pub fn new(ceiling: usize) -> Arc<Self> {
        let ceiling = ceiling.max(1);
        let start = START.min(ceiling);
        Arc::new(Self {
            sem: Arc::new(Semaphore::new(start)),
            ceiling,
            level: AtomicUsize::new(start),
            peak: AtomicUsize::new(start),
        })
    }

    /// Claim a slot, held for one proxy's probe. `None` means the run is being
    /// torn down; the caller should stop rather than probe anyway.
    pub async fn acquire(&self) -> Option<OwnedSemaphorePermit> {
        self.sem.clone().acquire_owned().await.ok()
    }

    pub fn level(&self) -> usize {
        self.level.load(Ordering::Relaxed)
    }

    /// Highest level actually reached: the difference between "your line took
    /// everything we could give it" and "we throttled to protect your router".
    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }

    pub fn ceiling(&self) -> usize {
        self.ceiling
    }

    fn set_level(&self, want: usize) {
        let want = want.clamp(FLOOR.min(self.ceiling), self.ceiling);
        let cur = self.level.load(Ordering::SeqCst);
        if want > cur {
            self.sem.add_permits(want - cur);
            self.level.store(want, Ordering::SeqCst);
            self.peak.fetch_max(want, Ordering::Relaxed);
        } else if want < cur {
            // `forget_permits` only takes what is not currently held, so it may
            // reduce by less than asked. Record what happened; the next tick
            // finishes the job if the link is still struggling.
            let got = self.sem.forget_permits(cur - want);
            self.level.store(cur - got, Ordering::SeqCst);
        }
    }

    /// Watch the link and steer, until `stop` is set.
    pub async fn govern(self: Arc<Self>, canary: SocketAddr, stop: Arc<AtomicBool>) {
        let mut baseline: Option<Duration> = None;
        loop {
            tokio::time::sleep(PROBE_EVERY).await;
            if stop.load(Ordering::SeqCst) {
                return;
            }
            let t = Instant::now();
            let reached = matches!(
                tokio::time::timeout(CANARY_TIMEOUT, TcpStream::connect(canary)).await,
                Ok(Ok(_))
            );
            // A canary that fails outright is ambiguous: our link, or the judge
            // having a bad minute. Congestion shows up as a slow success long
            // before it shows up as no success at all, so a failure holds the
            // level rather than retreating.
            if !reached {
                continue;
            }
            let sample = t.elapsed();
            let base = match baseline {
                Some(b) if b <= sample => b,
                _ => {
                    baseline = Some(sample);
                    sample
                }
            }
            .max(BASELINE_FLOOR);
            let ratio = sample.as_secs_f64() / base.as_secs_f64();
            let want = next_level(self.level(), self.ceiling, Some(ratio));
            if want != self.level() {
                log::debug!(
                    "concurrency {} -> {want} (canary {:.0} ms, baseline {:.0} ms)",
                    self.level(),
                    sample.as_secs_f64() * 1000.0,
                    base.as_secs_f64() * 1000.0
                );
            }
            self.set_level(want);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn climbs_while_the_link_has_headroom() {
        assert_eq!(next_level(16, 64, Some(1.0)), 24);
        assert_eq!(next_level(24, 64, Some(1.2)), 32);
    }

    #[test]
    fn never_exceeds_the_ceiling() {
        assert_eq!(next_level(60, 64, Some(1.0)), 64);
        assert_eq!(next_level(64, 64, Some(1.0)), 64);
        assert_eq!(next_level(1, 1, Some(1.0)), 1);
    }

    #[test]
    fn retreats_hard_when_the_link_is_queueing() {
        assert_eq!(next_level(96, 128, Some(3.0)), 64);
        assert_eq!(next_level(64, 128, Some(2.0)), 42);
    }

    #[test]
    fn never_throttles_below_the_floor() {
        assert_eq!(next_level(5, 64, Some(9.0)), FLOOR);
        assert_eq!(next_level(FLOOR, 64, Some(9.0)), FLOOR);
        assert_eq!(next_level(2, 2, Some(9.0)), 2);
    }

    #[test]
    fn holds_inside_the_dead_band_and_without_a_reading() {
        assert_eq!(next_level(40, 128, Some(1.5)), 40);
        assert_eq!(next_level(40, 128, Some(1.8)), 40);
        assert_eq!(next_level(40, 128, None), 40);
    }

    #[tokio::test]
    async fn starts_low_and_permits_track_the_level() {
        let g = Governor::new(64);
        assert_eq!(g.level(), START);
        g.set_level(32);
        assert_eq!(g.level(), 32);
        assert_eq!(g.sem.available_permits(), 32);
        g.set_level(8);
        assert_eq!(g.level(), 8);
        assert_eq!(g.sem.available_permits(), 8);
    }

    #[tokio::test]
    async fn a_small_ceiling_is_respected_from_the_first_moment() {
        let g = Governor::new(3);
        assert_eq!(g.level(), 3);
        g.set_level(100);
        assert_eq!(g.level(), 3);
        assert_eq!(g.sem.available_permits(), 3);
    }

    #[tokio::test]
    async fn reducing_while_slots_are_held_stays_honest() {
        let g = Governor::new(16);
        let held: Vec<_> = futures::future::join_all((0..14).map(|_| g.acquire())).await;
        assert_eq!(held.iter().filter(|p| p.is_some()).count(), 14);
        g.set_level(4);
        assert_eq!(g.level(), 14, "must report the level it actually reached");
        drop(held);
        g.set_level(4);
        assert_eq!(g.level(), 4);
    }
}
