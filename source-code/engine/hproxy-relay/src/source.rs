//! Where the upstream proxy comes from, and what happens when it dies.
//!
//! Three sources, and the difference is entirely about failure:
//!
//!   **Fixed**  the customer's own proxy line. If it stops answering that is
//!              news, and the honest response is an error they can see. Silently
//!              swapping a paid, country-targeted, sticky proxy for something
//!              else would be worse than failing.
//!
//!   **List**   the customer's own list, rotated by a rule they chose: a
//!              different member for every connection, every N connections, at
//!              random, or only when the one in use dies. A member that fails
//!              rests for a minute (`REST_FOR`) and the next one carries the
//!              connection. When every member is resting the rest is over for
//!              all of them: a list where everything blipped at once should
//!              get a second chance, not an error on every request.
//!
//!   **Pool**   a free exit from the shared pool. These die constantly and that
//!              is the deal, so the right response is to report the corpse,
//!              take a different exit and carry on. The Chrome extension has
//!              done exactly this since it shipped; this is the same behaviour
//!              for the rest of the machine.

use std::io;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::RwLock;

use crate::pool::Pool;
use crate::upstream::Upstream;

pub enum Source {
    Fixed(Upstream),
    List(List),
    Pool { pool: Pool, current: RwLock<Upstream> },
}

/// What a source is, for a status line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Fixed,
    List,
    Pool,
}

impl SourceKind {
    /// The one word for it, the same one serde writes, so a status line does
    /// not have to go through JSON and back to name itself.
    pub fn name(self) -> &'static str {
        match self {
            SourceKind::Fixed => "fixed",
            SourceKind::List => "list",
            SourceKind::Pool => "pool",
        }
    }
}

/// A successful dial: the socket, the upstream that carried it, and whether the
/// source had to switch upstream to get there.
#[derive(Debug)]
pub struct Dialed {
    pub stream: tokio::net::TcpStream,
    pub used: Upstream,
    pub rotated: bool,
}

/// How a `List` moves from one member to the next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    /// A different member for every connection, in order.
    EveryConnection,
    /// Stay on a member for this many connections, then move on.
    Every(u32),
    /// A member picked at random for every connection.
    Random,
    /// Stay on a member until it stops answering, then move on.
    OnFailure,
}

impl Rotation {
    pub fn describe(self) -> String {
        match self {
            Rotation::EveryConnection => "a different proxy for every connection".into(),
            Rotation::Every(n) => format!("a different proxy every {n} connections"),
            Rotation::Random => "a random proxy for every connection".into(),
            Rotation::OnFailure => "the same proxy until it stops answering".into(),
        }
    }
}

/// How long a member that failed sits out before it is tried again.
pub const REST_FOR: Duration = Duration::from_secs(60);

/// The customer's own list, rotated by a rule.
pub struct List {
    members: Vec<Upstream>,
    rule: Rotation,
    rest_for: Duration,
    state: Mutex<ListState>,
}

struct ListState {
    /// The member the next connection uses, except under `Random`.
    index: usize,
    /// Connections served by `index` so far, for `Every(n)`.
    served: u32,
    /// When each member last failed, while it is resting.
    resting: Vec<Option<Instant>>,
    /// The member that carried the most recent connection.
    last_used: Option<usize>,
    /// xorshift state for `Random`.
    seed: u64,
}

impl List {
    pub fn new(members: Vec<Upstream>, rule: Rotation) -> Result<Self, String> {
        Self::with_rest(members, rule, REST_FOR)
    }

    /// `rest_for` is a parameter so a test can make a rest end quickly.
    pub fn with_rest(members: Vec<Upstream>, rule: Rotation, rest_for: Duration) -> Result<Self, String> {
        if members.is_empty() {
            return Err("the list has no proxies in it".into());
        }
        if rule == Rotation::Every(0) {
            return Err("\"every N connections\" needs N to be at least 1".into());
        }
        let n = members.len();
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0x9E37_79B9_7F4A_7C15)
            | 1;
        Ok(Self {
            members,
            rule,
            rest_for,
            state: Mutex::new(ListState {
                index: 0,
                served: 0,
                resting: vec![None; n],
                last_used: None,
                seed,
            }),
        })
    }

    pub fn len(&self) -> usize {
        self.members.len()
    }

    pub fn is_empty(&self) -> bool {
        self.members.is_empty()
    }

    pub fn rule(&self) -> Rotation {
        self.rule
    }

    /// Members not resting right now.
    pub fn available(&self) -> usize {
        let st = self.lock();
        let now = Instant::now();
        (0..self.members.len()).filter(|i| self.is_up(&st, *i, now)).count()
    }

    /// The member that carried the most recent connection, or the one the next
    /// connection will use while none has been served yet.
    pub fn last_used(&self) -> Upstream {
        let st = self.lock();
        self.members[st.last_used.unwrap_or(st.index)].clone()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ListState> {
        // A poisoned lock means a panic elsewhere while it was held. The state
        // is a few integers and is still usable.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn is_up(&self, st: &ListState, i: usize, now: Instant) -> bool {
        match st.resting[i] {
            None => true,
            Some(since) => now.duration_since(since) >= self.rest_for,
        }
    }

    /// The first member at or after `from`, wrapping, that is not resting.
    /// When every member is resting, the rest is over for all of them.
    fn next_up(&self, st: &mut ListState, from: usize, now: Instant) -> usize {
        let n = self.members.len();
        for k in 0..n {
            let i = (from + k) % n;
            if self.is_up(st, i, now) {
                return i;
            }
        }
        st.resting.iter_mut().for_each(|r| *r = None);
        from % n
    }

    /// A random member that is not resting. Same second chance as `next_up`.
    fn random_up(&self, st: &mut ListState, now: Instant) -> usize {
        let n = self.members.len();
        let up: Vec<usize> = (0..n).filter(|i| self.is_up(st, *i, now)).collect();
        if up.is_empty() {
            st.resting.iter_mut().for_each(|r| *r = None);
        }
        // xorshift64: spreads connections well enough, and needs no crate.
        let mut x = st.seed;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        st.seed = x;
        if up.is_empty() {
            (x % n as u64) as usize
        } else {
            up[(x % up.len() as u64) as usize]
        }
    }

    /// The member for the next connection, applying the rule.
    fn take(&self) -> Upstream {
        let mut st = self.lock();
        let now = Instant::now();
        let i = match self.rule {
            Rotation::Random => self.random_up(&mut st, now),
            _ => {
                let from = st.index;
                let i = self.next_up(&mut st, from, now);
                st.index = i;
                i
            }
        };
        st.last_used = Some(i);
        match self.rule {
            Rotation::EveryConnection => {
                st.index = self.next_up(&mut st, i + 1, now);
            }
            Rotation::Every(n) => {
                st.served += 1;
                if st.served >= n {
                    st.served = 0;
                    st.index = self.next_up(&mut st, i + 1, now);
                }
            }
            Rotation::Random | Rotation::OnFailure => {}
        }
        self.members[i].clone()
    }

    /// `dead` failed: rest it and move on. Returns the member the retry uses,
    /// which under `OnFailure` is also the new sticky one.
    fn rest(&self, dead: &Upstream) -> Upstream {
        let mut st = self.lock();
        let now = Instant::now();
        let mut dead_at = None;
        for (i, m) in self.members.iter().enumerate() {
            if m == dead {
                st.resting[i] = Some(now);
                if dead_at.is_none() || st.last_used == Some(i) {
                    dead_at = Some(i);
                }
            }
        }
        st.served = 0;
        let i = match self.rule {
            Rotation::Random => self.random_up(&mut st, now),
            _ => {
                // The sticky rules still point at the dead member; start the
                // search just past it. EveryConnection has already moved on.
                let from = match dead_at {
                    Some(d) if d == st.index => d + 1,
                    _ => st.index,
                };
                let i = self.next_up(&mut st, from, now);
                st.index = i;
                i
            }
        };
        st.last_used = Some(i);
        if self.rule == Rotation::EveryConnection {
            st.index = self.next_up(&mut st, i + 1, now);
        }
        self.members[i].clone()
    }

    /// Move on because the person asked, whatever the rule.
    fn advance(&self) -> Upstream {
        let mut st = self.lock();
        let now = Instant::now();
        let from = st.last_used.map_or(st.index, |i| i + 1);
        let i = match self.rule {
            Rotation::Random => self.random_up(&mut st, now),
            _ => self.next_up(&mut st, from, now),
        };
        st.index = i;
        st.served = 0;
        st.last_used = Some(i);
        self.members[i].clone()
    }
}

impl Source {
    /// How many pool exits to try before giving up on finding one that works.
    ///
    /// Sized from a measurement, not a guess: on 2026-08-08, 11 of 12
    /// consecutive `/api/vpn/next` picks were web servers rather than proxies
    /// (see the note on `Pool::next_working`). At roughly a 1-in-12 hit rate,
    /// a handful of attempts would fail most of the time and read to the
    /// customer as "this tool is broken" rather than "the free pool is rough".
    const VERIFY_TRIES: usize = 15;

    /// Build a pool source by taking a first WORKING exit, so a bad pool is
    /// reported at startup rather than on the customer's first page load.
    ///
    /// Prints nothing: stdout belongs to the caller, and a caller that speaks a
    /// protocol on it (the MCP server, `--json`) would be corrupted by a stray
    /// line. Progress words are the caller's job.
    pub async fn from_pool(pool: Pool) -> Result<(Self, String), String> {
        let exit = pool.next_working(Self::VERIFY_TRIES).await?;
        let label = exit.describe();
        Ok((
            Source::Pool {
                pool,
                current: RwLock::new(exit.upstream),
            },
            label,
        ))
    }

    pub fn kind(&self) -> SourceKind {
        match self {
            Source::Fixed(_) => SourceKind::Fixed,
            Source::List(_) => SourceKind::List,
            Source::Pool { .. } => SourceKind::Pool,
        }
    }

    /// How many upstreams this source chooses from. `None` for the pool, which
    /// is remote and does not say.
    pub fn size(&self) -> Option<usize> {
        match self {
            Source::Fixed(_) => Some(1),
            Source::List(l) => Some(l.len()),
            Source::Pool { .. } => None,
        }
    }

    /// The list's rotation rule, when this is a list.
    pub fn rotation(&self) -> Option<Rotation> {
        match self {
            Source::List(l) => Some(l.rule()),
            _ => None,
        }
    }

    /// The upstream in use, as a person may see it. For a list, the member
    /// that carried the most recent connection. Never the password.
    ///
    /// Synchronous so a status call can read it while holding an ordinary
    /// lock. The pool's exit is behind an async lock; while a rotation holds
    /// it for writing, the honest answer is that the exit is being switched.
    pub fn in_use_now(&self) -> String {
        match self {
            Source::Fixed(u) => u.to_string(),
            Source::List(l) => l.last_used().to_string(),
            Source::Pool { current, .. } => match current.try_read() {
                Ok(u) => u.to_string(),
                Err(_) => "switching to a fresh exit".to_string(),
            },
        }
    }

    /// The upstream for the next connection. For a list this applies the
    /// rotation rule, so it is asked exactly once per connection.
    pub async fn take(&self) -> Upstream {
        match self {
            Source::Fixed(u) => u.clone(),
            Source::List(l) => l.take(),
            Source::Pool { current, .. } => current.read().await.clone(),
        }
    }

    /// Whether `advance` can do anything.
    pub fn can_rotate(&self) -> bool {
        !matches!(self, Source::Fixed(_))
    }

    /// Move to a different upstream because the person asked. Returns how the
    /// new one is described. Refused for a fixed proxy: there is no other one.
    pub async fn advance(&self) -> Result<String, String> {
        match self {
            Source::Fixed(_) => Err("this is your own proxy, there is nothing to switch to".into()),
            Source::List(l) => Ok(l.advance().to_string()),
            Source::Pool { pool, current } => {
                let exit = pool.next_working(Self::VERIFY_TRIES).await?;
                let label = exit.describe();
                *current.write().await = exit.upstream;
                Ok(label)
            }
        }
    }

    /// Retire a dead upstream and take a fresh one. `None` when this source
    /// cannot rotate, which is the correct answer for a customer's own proxy.
    async fn rotate(&self, dead: &Upstream) -> Option<Upstream> {
        match self {
            Source::Fixed(_) => None,
            Source::List(l) => {
                let next = l.rest(dead);
                eprintln!(
                    "  {} stopped answering, resting it for a minute, now on {}",
                    dead.addr(),
                    next.addr()
                );
                Some(next)
            }
            Source::Pool { pool, current } => {
                {
                    // Another connection may have rotated already while this
                    // one was failing. Rotating again would burn a good exit
                    // and, on a page with fifty parallel requests, would burn
                    // fifty.
                    let now = current.read().await;
                    if *now != *dead {
                        return Some(now.clone());
                    }
                }
                pool.report_dead(dead);
                let exit = pool.next_working(Self::VERIFY_TRIES).await.ok()?;
                let mut w = current.write().await;
                // Re-check under the write lock: between dropping the read
                // guard and taking this one, someone else may have won the race.
                if *w != *dead {
                    return Some(w.clone());
                }
                eprintln!(
                    "  exit {} stopped answering, switched to {}",
                    dead.addr(),
                    exit.describe()
                );
                *w = exit.upstream.clone();
                Some(exit.upstream)
            }
        }
    }

    /// Run `dial` against the upstream for this connection, and on failure
    /// rotate once and try again. One retry, not a loop: a pool-wide outage
    /// should surface as an error the customer can read, not as a connection
    /// that hangs forever while the tool works through a thousand dead exits.
    pub async fn dial_with_failover<F, Fut>(&self, dial: F) -> io::Result<Dialed>
    where
        F: Fn(Upstream) -> Fut,
        Fut: std::future::Future<Output = io::Result<tokio::net::TcpStream>>,
    {
        let up = self.take().await;
        match dial(up.clone()).await {
            Ok(stream) => Ok(Dialed {
                stream,
                used: up,
                rotated: false,
            }),
            Err(first) => {
                let Some(next) = self.rotate(&up).await else {
                    return Err(first);
                };
                match dial(next.clone()).await {
                    Ok(stream) => Ok(Dialed {
                        stream,
                        used: next,
                        rotated: true,
                    }),
                    // Report the first error, not the second: it describes the
                    // upstream the customer was actually on.
                    Err(_) => Err(first),
                }
            }
        }
    }

    /// One line for the startup banner.
    pub fn label(&self, first_exit: Option<&str>) -> String {
        match self {
            Source::Fixed(u) => format!("{u}"),
            Source::List(l) => format!("your list, {} proxies, {}", l.len(), l.rule().describe()),
            Source::Pool { pool: _, .. } => match first_exit {
                Some(e) => format!("free pool, currently {e}"),
                None => "free pool".to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream;

    #[test]
    fn a_source_names_itself_the_same_way_twice() {
        // `name()` and serde must never drift: a status line prints one and a
        // JSON row carries the other, and a reader treats them as one word.
        for kind in [SourceKind::Fixed, SourceKind::List, SourceKind::Pool] {
            assert_eq!(serde_json::to_string(&kind).unwrap(), format!("\"{}\"", kind.name()));
        }
    }

    fn members(n: usize) -> Vec<Upstream> {
        (0..n)
            .map(|i| upstream::parse(&format!("198.51.100.{}:8080:u:p", i + 1)).unwrap())
            .collect()
    }

    fn hosts(list: &List, takes: usize) -> Vec<String> {
        (0..takes).map(|_| list.take().host).collect()
    }

    #[tokio::test]
    async fn a_fixed_source_never_rotates() {
        // A paid, country-targeted, sticky proxy must not be silently swapped
        // for something else. Failing loudly is the correct behaviour.
        let up = upstream::parse("198.51.100.7:8080:u:p").unwrap();
        let src = Source::Fixed(up.clone());
        assert!(src.rotate(&up).await.is_none());
        assert_eq!(src.take().await, up);
        assert!(!src.can_rotate());
        assert!(src.advance().await.is_err());
    }

    #[tokio::test]
    async fn a_fixed_source_surfaces_the_dial_error() {
        let up = upstream::parse("198.51.100.7:8080:u:p").unwrap();
        let src = Source::Fixed(up);
        let out = src
            .dial_with_failover(|_| async { Err(io::Error::other("nope")) })
            .await;
        assert!(out.is_err());
        assert_eq!(out.unwrap_err().to_string(), "nope");
    }

    #[tokio::test]
    async fn a_successful_dial_reports_which_upstream_carried_it() {
        // The plain path builds its auth header from the upstream that actually
        // carried the connection, so a rotation mid-request must not leave it
        // signing with the retired one. That is why dial_with_failover returns
        // the upstream alongside the socket instead of the caller re-reading it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let up = upstream::parse("198.51.100.7:8080:u:p").unwrap();
        let src = Source::Fixed(up.clone());
        let dialed = src
            .dial_with_failover(move |_| async move { tokio::net::TcpStream::connect(addr).await })
            .await
            .expect("dial should have succeeded");

        assert_eq!(dialed.used, up);
        assert!(!dialed.rotated);
    }

    #[test]
    fn a_fixed_label_never_prints_the_password() {
        let src = Source::Fixed(upstream::parse("h:1:user:hunter2").unwrap());
        let l = src.label(None);
        assert!(!l.contains("hunter2"), "{l}");
        assert!(l.contains("user"), "{l}");
    }

    #[test]
    fn a_list_rotates_every_connection_in_order() {
        let list = List::new(members(3), Rotation::EveryConnection).unwrap();
        assert_eq!(
            hosts(&list, 4),
            ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.1"]
        );
    }

    #[test]
    fn a_list_stays_for_n_connections() {
        let list = List::new(members(3), Rotation::Every(2)).unwrap();
        let h = hosts(&list, 7);
        assert_eq!(
            h,
            [
                "198.51.100.1",
                "198.51.100.1",
                "198.51.100.2",
                "198.51.100.2",
                "198.51.100.3",
                "198.51.100.3",
                "198.51.100.1"
            ]
        );
    }

    #[test]
    fn on_failure_stays_until_the_member_dies() {
        let list = List::new(members(3), Rotation::OnFailure).unwrap();
        assert_eq!(hosts(&list, 3), ["198.51.100.1"; 3]);
        let dead = list.last_used();
        let next = list.rest(&dead);
        assert_eq!(next.host, "198.51.100.2");
        assert_eq!(hosts(&list, 2), ["198.51.100.2"; 2]);
        assert_eq!(list.available(), 2);
    }

    #[test]
    fn a_resting_member_is_skipped_then_tried_again() {
        let list = List::with_rest(members(3), Rotation::EveryConnection, Duration::from_millis(40)).unwrap();
        let _first = list.take();
        let second = list.take();
        assert_eq!(second.host, "198.51.100.2");
        list.rest(&second);
        // The two that are up alternate; the resting one never appears.
        let h = hosts(&list, 4);
        assert!(!h.iter().any(|x| x == "198.51.100.2"), "{h:?}");
        std::thread::sleep(Duration::from_millis(50));
        let h = hosts(&list, 3);
        assert!(h.iter().any(|x| x == "198.51.100.2"), "rest over: {h:?}");
    }

    #[test]
    fn when_every_member_rests_the_rest_is_over_for_all() {
        let list = List::new(members(2), Rotation::OnFailure).unwrap();
        let a = list.take();
        let b = list.rest(&a);
        assert_eq!(b.host, "198.51.100.2");
        let again = list.rest(&b);
        assert_eq!(again.host, "198.51.100.1", "everything rested, so everything is back");
        assert_eq!(list.available(), 2);
    }

    #[test]
    fn random_never_picks_a_resting_member() {
        let list = List::new(members(3), Rotation::Random).unwrap();
        let b = members(3)[1].clone();
        list.rest(&b);
        let h = hosts(&list, 60);
        assert!(!h.iter().any(|x| x == "198.51.100.2"), "{h:?}");
        assert!(
            h.iter().any(|x| x == "198.51.100.1") && h.iter().any(|x| x == "198.51.100.3"),
            "{h:?}"
        );
    }

    #[test]
    fn an_empty_or_zero_step_list_is_refused() {
        assert!(List::new(Vec::new(), Rotation::EveryConnection).is_err());
        assert!(List::new(members(2), Rotation::Every(0)).is_err());
    }

    #[tokio::test]
    async fn advance_moves_on_whatever_the_rule() {
        let src = Source::List(List::new(members(3), Rotation::OnFailure).unwrap());
        assert_eq!(src.take().await.host, "198.51.100.1");
        let label = src.advance().await.unwrap();
        assert!(label.contains("198.51.100.2"), "{label}");
        assert_eq!(src.take().await.host, "198.51.100.2");
        assert!(src.can_rotate());
        assert_eq!(src.size(), Some(3));
        assert_eq!(src.kind(), SourceKind::List);
    }

    #[tokio::test]
    async fn a_failed_dial_on_a_list_moves_to_the_next_member() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });
        let src = Source::List(List::new(members(2), Rotation::OnFailure).unwrap());
        let dialed = src
            .dial_with_failover(move |up| async move {
                if up.host == "198.51.100.1" {
                    Err(io::Error::other("dead"))
                } else {
                    tokio::net::TcpStream::connect(addr).await
                }
            })
            .await
            .expect("the second member should have carried it");
        assert_eq!(dialed.used.host, "198.51.100.2");
        assert!(dialed.rotated);
        assert!(src.in_use_now().contains("198.51.100.2"));
    }

    #[test]
    fn a_list_label_says_how_it_rotates_and_hides_passwords() {
        let src = Source::List(List::new(members(4), Rotation::Every(10)).unwrap());
        let l = src.label(None);
        assert_eq!(l, "your list, 4 proxies, a different proxy every 10 connections");
        assert!(!src.label(None).contains(":p"), "{l}");
    }
}
