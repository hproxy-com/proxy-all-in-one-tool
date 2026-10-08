//! The HProxy proxy-checking engine.
//!
//! One engine for every door: the desktop app, the command line, the website's
//! checker and the free-proxy pool all read this crate, so a proxy gets the same
//! verdict wherever it is checked. Before this crate there were three engines,
//! and every checker incident of 2026 was one of them disagreeing with another.
//!
//! What a check does, per proxy:
//!
//! 1. [`line::parse`] turns the pasted text into a host, a port and a login.
//! 2. Four transports probe it at once (HTTP, HTTPS via CONNECT, SOCKS4,
//!    SOCKS5). Each one dials the proxy, establishes the transport, and sends
//!    one request to a judge that echoes back what it saw. Each phase is timed
//!    separately ([`result::Timings`]).
//! 3. Every request carries a nonce, and only an echo that reflects the nonce
//!    counts as alive. A canned page, a captive portal, a web server on port 80
//!    or a decoy that replays somebody else's echo cannot know it.
//! 4. When a judge is out of reach the transport climbs the ladder
//!    ([`judge::Ladder`]): the origin echo, then the Cloudflare trace on port
//!    80, which is the most reachable address a proxy can be asked for.
//! 5. The exit address comes from the judge's trusted `peer_ip`, never from a
//!    header the proxy could have written. Anonymity is graded from the
//!    plain-HTTP echo only, because a tunnel cannot add a header.
//! 6. [`check::Checker`] merges the four answers into one [`result::CheckResult`],
//!    and [`batch::Batch`] runs a whole list under the adaptive [`governor`].
//!
//! No database, no web framework, no UI, no third-party service: the only
//! network endpoints are the judges, which are ours.

pub mod batch;
pub mod browser;
pub mod check;
pub mod dial;
pub mod echo;
pub mod fingerprint;
pub mod governor;
pub mod grade;
pub mod judge;
pub mod line;
pub mod result;
pub mod speed;
pub mod transport;
pub mod udp;

pub use batch::{Batch, BatchOptions, Done, Progress};
pub use check::{CheckOptions, Checker, ProtocolSet};
pub use echo::EchoResponse;
pub use judge::{Judge, JudgeKind, Ladder};
pub use line::{parse, LineError, ProxyLine, Scheme};
pub use result::{
    sustainable_concurrency, CheckResult, Failure, FailureDetail, LeakedHeader, Phase, ProtocolTiming, Status, Timings,
    DEFAULT_CONCURRENCY, MAX_CONCURRENCY,
};
