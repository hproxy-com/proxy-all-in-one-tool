//! Run a whole list: parse, deduplicate, fan out under the governor, stream
//! every row the moment it settles.
//!
//! A FIXED WORKER POOL pulls from a shared cursor rather than one future per
//! proxy: memory is bounded by the concurrency setting instead of the list
//! size, and a cancelled run stops within one in-flight probe because each
//! worker re-checks the cancel flag before claiming its next proxy.
//!
//! The pool is spawned at the user's ceiling, but how many may be on the
//! network at once is decided moment to moment by the governor. A parked task
//! costs a few hundred bytes, so spawning the ceiling and gating on permits
//! keeps memory bounded by the setting rather than by the list.
//!
//! A door that also checks elsewhere (the desktop app's API mode) claims
//! chunks from the same cursor through `Batch::claims()`, and hands back
//! anything the other side failed to answer through `requeue`, so no proxy is
//! ever silently reported dead because nobody looked at it.

use crate::check::{CheckOptions, Checker};
use crate::governor::Governor;
use crate::line::{self, ProxyLine};
use crate::result::{sustainable_concurrency, CheckResult, Status, DEFAULT_CONCURRENCY};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::task::JoinSet;

#[derive(Debug, Clone)]
pub struct BatchOptions {
    /// The ceiling. The governor decides the moment-to-moment level.
    pub concurrency: usize,
    pub check: CheckOptions,
    /// Skip lines that parse to a proxy already in the list. Scraped lists are
    /// full of repeats in several spellings, and a duplicate costs a real
    /// socket and a real timeout for an answer we already have.
    pub dedupe: bool,
}

impl Default for BatchOptions {
    fn default() -> Self {
        Self {
            concurrency: DEFAULT_CONCURRENCY,
            check: CheckOptions::default(),
            dedupe: true,
        }
    }
}

/// One input line, parsed once before the fan-out.
pub struct Item {
    pub raw: String,
    pub line: Result<ProxyLine, String>,
}

/// Where a run stands, for a progress bar.
#[derive(Debug, Clone, Copy, Default)]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub alive: usize,
}

/// Emitted once when a run finishes or is cancelled.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Done {
    pub total: usize,
    pub alive: usize,
    pub duration_ms: u64,
    pub cancelled: bool,
    /// The highest concurrency the governor settled on.
    pub peak_concurrency: usize,
    pub duplicates: usize,
    pub invalid: usize,
}

/// The shared hand-out state, so an external claimant can join the run.
#[derive(Clone)]
pub struct Claims {
    pub items: Arc<Vec<Item>>,
    pub cursor: Arc<AtomicUsize>,
    pub requeue: Arc<Mutex<Vec<usize>>>,
    /// Set while an external claimant may still hand indices back. Workers
    /// must not exit on an empty queue while this is true.
    pub external_active: Arc<AtomicBool>,
}

impl Claims {
    /// Claim up to `n` consecutive indices. Returns the range, possibly short.
    pub fn claim(&self, n: usize) -> std::ops::Range<usize> {
        let total = self.items.len();
        let start = self.cursor.fetch_add(n, Ordering::Relaxed).min(total);
        let end = (start + n).min(total);
        start..end
    }

    pub fn remaining(&self) -> usize {
        self.items.len().saturating_sub(self.cursor.load(Ordering::Relaxed))
    }

    pub fn hand_back(&self, indices: impl IntoIterator<Item = usize>) {
        if let Ok(mut q) = self.requeue.lock() {
            q.extend(indices);
        }
    }
}

/// What makes two pasted lines the same proxy: host, port and login. Two
/// spellings of one endpoint with one login are checked once.
type DedupeKey = (String, u16, Option<(String, String)>);

pub struct Batch {
    claims: Claims,
    checker: Arc<Checker>,
    opts: BatchOptions,
    cancel: Arc<AtomicBool>,
    /// Whether local workers claim fresh work. False when an external door
    /// checks everything and local workers only pick up what it hands back.
    local_claims: bool,
    duplicates: usize,
    invalid: usize,
}

impl Batch {
    /// Parse every line up front. Parsing is pure CPU next to the network, and
    /// doing it here gives the caller the full host list (for a geo prefetch,
    /// say) before a single socket opens.
    pub fn new(lines: Vec<String>, checker: Arc<Checker>, opts: BatchOptions) -> Self {
        let mut seen: HashSet<DedupeKey> = HashSet::new();
        let mut items = Vec::with_capacity(lines.len());
        let mut duplicates = 0;
        let mut invalid = 0;
        for raw in lines {
            match line::parse(&raw) {
                Ok(l) => {
                    if opts.dedupe && !seen.insert(l.key()) {
                        duplicates += 1;
                        continue;
                    }
                    items.push(Item { raw, line: Ok(l) });
                }
                Err(e) => {
                    invalid += 1;
                    items.push(Item { raw, line: Err(e.0) });
                }
            }
        }
        Self {
            claims: Claims {
                items: Arc::new(items),
                cursor: Arc::new(AtomicUsize::new(0)),
                requeue: Arc::new(Mutex::new(Vec::new())),
                external_active: Arc::new(AtomicBool::new(false)),
            },
            checker,
            opts,
            cancel: Arc::new(AtomicBool::new(false)),
            local_claims: true,
            duplicates,
            invalid,
        }
    }

    pub fn claims(&self) -> Claims {
        self.claims.clone()
    }

    pub fn items(&self) -> Arc<Vec<Item>> {
        self.claims.items.clone()
    }

    /// Every host in the list, for a caller that wants to look them up before
    /// the run starts.
    pub fn hosts(&self) -> Vec<String> {
        self.claims
            .items
            .iter()
            .filter_map(|i| i.line.as_ref().ok().map(|l| l.host.clone()))
            .collect()
    }

    /// A handle that stops the run. Setting it makes every worker exit before
    /// claiming its next proxy.
    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }

    /// Local workers stop claiming fresh work and only serve the requeue.
    pub fn local_only_serves_requeue(&mut self) {
        self.local_claims = false;
    }

    pub fn duplicates(&self) -> usize {
        self.duplicates
    }

    pub fn invalid(&self) -> usize {
        self.invalid
    }

    pub fn len(&self) -> usize {
        self.claims.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.claims.items.is_empty()
    }

    /// Run the list. `on_result` is called on the calling task for every row
    /// the moment it settles, so it needs no synchronisation of its own.
    pub async fn run<F>(self, mut on_result: F) -> Done
    where
        F: FnMut(CheckResult),
    {
        let started = Instant::now();
        let total = self.claims.items.len();
        let concurrency = sustainable_concurrency(self.opts.concurrency);
        let governor = Governor::new(concurrency);
        let stop = Arc::new(AtomicBool::new(false));

        // Nothing waits in front of the first probe. Our own address is learned
        // once per session, and `check` already asks for it alongside its four
        // probes, so the first wave overlaps that lookup instead of queueing
        // behind it: a single-proxy check saves one full round trip to the
        // judge. The governor starts itself as soon as its canary resolves and
        // holds its conservative starting level until then. If the judge is
        // unreachable the run still goes ahead: grading loses only the
        // transparent tier, and the governor never leaves its start, which is
        // the safe direction to fail.
        let gov_task = {
            let checker = self.checker.clone();
            let governor = governor.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                if let Some(addr) = checker.canary().await {
                    governor.govern(addr, stop).await;
                }
            })
        };

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CheckResult>();
        let workers = concurrency.min(total.max(1));
        let mut pool = JoinSet::new();
        for _ in 0..workers {
            let claims = self.claims.clone();
            let checker = self.checker.clone();
            let opts = self.opts.check.clone();
            let cancel = self.cancel.clone();
            let tx = tx.clone();
            let governor = governor.clone();
            let local_claims = self.local_claims;
            pool.spawn(async move {
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        break;
                    }
                    // Requeued work first: it already waited through a failed
                    // round trip elsewhere and should not queue again.
                    let claimed = claims
                        .requeue
                        .lock()
                        .ok()
                        .and_then(|mut q| q.pop())
                        .or_else(|| local_claims.then(|| claims.cursor.fetch_add(1, Ordering::Relaxed)));
                    let Some(item) = claimed.and_then(|i| claims.items.get(i)) else {
                        if claims.external_active.load(Ordering::SeqCst) {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                            continue;
                        }
                        break;
                    };
                    let mut result = match &item.line {
                        Ok(line) => {
                            // A slot only for the part that touches the network,
                            // and only after the index is claimed.
                            let Some(_slot) = governor.acquire().await else { break };
                            if cancel.load(Ordering::SeqCst) {
                                break;
                            }
                            checker.check(line, &opts).await
                        }
                        // An unparseable line costs no sockets and must not wait
                        // for a slot behind proxies that do.
                        Err(why) => CheckResult::invalid(item.raw.clone(), why.clone()),
                    };
                    result.input = item.raw.clone();
                    if result.source.is_none() {
                        result.source = Some("local".into());
                    }
                    if tx.send(result).is_err() {
                        break;
                    }
                }
            });
        }
        drop(tx);

        let mut alive = 0usize;
        let mut cancelled = false;
        while let Some(result) = rx.recv().await {
            if self.cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            if result.alive {
                alive += 1;
            }
            on_result(result);
        }
        // A cancel that landed before any row settled (during the own-address
        // wait, say) still makes this a cancelled run.
        cancelled = cancelled || self.cancel.load(Ordering::SeqCst);
        stop.store(true, Ordering::SeqCst);
        if cancelled {
            pool.abort_all();
        }
        while let Some(joined) = pool.join_next().await {
            if let Err(e) = joined {
                if e.is_panic() {
                    log::error!("a checker worker panicked: {e}");
                }
            }
        }
        gov_task.abort();
        Done {
            total,
            alive,
            duration_ms: started.elapsed().as_millis() as u64,
            cancelled,
            peak_concurrency: governor.peak(),
            duplicates: self.duplicates,
            invalid: self.invalid,
        }
    }
}

/// Convenience for a row that was never checked because the run stopped.
pub fn unchecked(raw: &str) -> CheckResult {
    CheckResult {
        input: raw.to_string(),
        status: Status::Unchecked,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::judge::Ladder;

    fn unreachable_checker() -> Arc<Checker> {
        Arc::new(Checker::new(
            Ladder::from_urls("http://192.0.2.2:9/echo", "https://192.0.2.2:9/echo", "", "").unwrap(),
        ))
    }

    #[test]
    fn deduplicates_spellings_and_keeps_invalid_lines() {
        let b = Batch::new(
            vec![
                "1.2.3.4:80".into(),
                "http://1.2.3.4:80/".into(),
                "garbage".into(),
                "1.2.3.4:81".into(),
            ],
            unreachable_checker(),
            BatchOptions::default(),
        );
        assert_eq!(b.len(), 3);
        assert_eq!(b.duplicates(), 1);
        assert_eq!(b.invalid(), 1);
        assert_eq!(b.hosts(), vec!["1.2.3.4", "1.2.3.4"]);
    }

    #[tokio::test]
    async fn invalid_lines_come_back_as_invalid_rows_without_touching_the_network() {
        let opts = BatchOptions {
            check: CheckOptions {
                timeout: Duration::from_secs(1),
                connect_timeout: Duration::from_millis(300),
                ..Default::default()
            },
            ..Default::default()
        };
        let b = Batch::new(
            vec!["not a proxy".into(), "# comment".into()],
            unreachable_checker(),
            opts,
        );
        let mut rows = Vec::new();
        let done = b.run(|r| rows.push(r)).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.status == Status::Invalid));
        assert!(rows.iter().all(|r| r.error.is_some()));
        assert_eq!(done.total, 2);
        assert_eq!(done.alive, 0);
        assert!(!done.cancelled);
    }

    #[tokio::test]
    async fn claims_hand_out_ranges_and_hand_back_indices() {
        let b = Batch::new(
            (0..10).map(|i| format!("10.0.0.{i}:80")).collect(),
            unreachable_checker(),
            BatchOptions::default(),
        );
        let c = b.claims();
        assert_eq!(c.claim(4), 0..4);
        assert_eq!(c.claim(4), 4..8);
        assert_eq!(c.claim(4), 8..10);
        assert_eq!(c.claim(4), 10..10);
        assert_eq!(c.remaining(), 0);
        c.hand_back([3, 7]);
        assert_eq!(c.requeue.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn cancelling_stops_the_run_promptly() {
        let opts = BatchOptions {
            concurrency: 4,
            check: CheckOptions {
                timeout: Duration::from_secs(3),
                connect_timeout: Duration::from_secs(3),
                protocols: crate::check::ProtocolSet {
                    http: true,
                    https: false,
                    socks4: false,
                    socks5: false,
                },
                ..Default::default()
            },
            ..Default::default()
        };
        // TEST-NET-1 addresses black-hole, so every probe would take the full
        // budget; cancelling must not wait for the whole list. The own-address
        // lookup against the unreachable judge costs its bounded wait once, at
        // the start, and the four probes in flight cost one budget more.
        let lines: Vec<String> = (1..=40).map(|i| format!("192.0.2.{i}:8080")).collect();
        let b = Batch::new(lines, unreachable_checker(), opts);
        let cancel = b.cancel_handle();
        let started = Instant::now();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel.store(true, Ordering::SeqCst);
        });
        let done = b.run(|_| {}).await;
        assert!(done.cancelled);
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "took {:?}",
            started.elapsed()
        );
    }
}
