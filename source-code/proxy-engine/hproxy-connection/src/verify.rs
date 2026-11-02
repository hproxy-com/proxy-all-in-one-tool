//! Before any door says "connected": traffic has to get through.
//!
//! A relay that listens proves nothing about the proxy behind it, and a screen
//! that says "connected" on that alone sends a whole device into a dead end. So
//! a connection is tested first, through the relay, by the same probe that
//! watches it afterwards (health.rs): HTTPS to our judge with the certificate
//! checked. A proxy that only fetches plain pages cannot pass it, and neither
//! can one that re-signs HTTPS.
//!
//! This file holds what every door shares about that test: how many other
//! proxies of a group or the free pool get a chance, when one more try is worth
//! it, and the words for a failure.

use std::future::Future;

use hproxy_relay::{Failure, Said, SwitchableSource, Why};

use crate::health::Health;

/// How many other proxies of a group or the free pool are tried when one fails.
pub const MOVES: usize = 3;

/// Try, and when that fails and the source can move on (a group, the free
/// pool), move on and try again, a few times. A single proxy gets its one try.
pub async fn until_it_works<T, A, F>(source: &SwitchableSource, mut attempt: A, works: impl Fn(&T) -> bool) -> T
where
    A: FnMut() -> F,
    F: Future<Output = T>,
{
    let mut answer = attempt().await;
    let mut moves = 0;
    while !works(&answer) && source.current().can_rotate() && moves < MOVES {
        moves += 1;
        if source.next_ip().await.is_err() {
            break;
        }
        answer = attempt().await;
    }
    answer
}

/// Whether one more try of the same proxy can change the answer. A gateway that
/// hands out exits fails now and then on one bad exit and gives another on the
/// next request. A wrong login, nothing listening, an unknown name, a false
/// certificate and a proxy that stayed silent for the whole wait stay as they
/// are, and a second wait would only keep the person waiting.
pub fn worth_another_try(h: &Health, why: Option<Why>) -> bool {
    let said = h.error.as_deref().unwrap_or_default();
    match why {
        Some(Why::Other | Why::Blocked) => true,
        Some(_) => false,
        None => !(said.starts_with("bad certificate") || said.starts_with("timed out")),
    }
}

/// Why a test failed, for the person: the error by its name, a colon, what it
/// means. The windows show the name large and the rest under it, so "Timed out"
/// reads as "Timed out" everywhere (`errorParts` in the desktop window,
/// `Failure` on the phone). The relay knows the most when it could not reach the
/// proxy, down to what the proxy answered; the probe's own sentence says
/// everything else.
pub fn failure_words(h: &Health, failed: Option<&Failure>) -> String {
    let target = &h.target;
    let Some(failed) = failed else {
        return probe_words(h);
    };
    match (failed.why, failed.said) {
        (Why::Timeout, _) => "timed out: the proxy did not answer".into(),
        (Why::Login, _) => "login refused: check the username and password".into(),
        (Why::Refused, _) => "connection refused: nothing answers at that address".into(),
        (Why::Dns, _) => "address not found: that name does not exist".into(),
        (Why::Blocked, Said::Status(status)) => format!("blocked ({status}): the proxy would not open {target}"),
        (Why::Blocked, _) => format!("blocked: the proxy would not open {target}"),
        (_, Said::Status(status)) => format!("proxy error {status}: it did not open {target}"),
        (_, Said::Socks(words)) => format!("proxy error: {words}"),
        (_, Said::WrongProtocol) => "wrong protocol: it did not answer as a proxy of this kind".into(),
        (_, Said::Nothing) => probe_words(h),
    }
}

fn probe_words(h: &Health) -> String {
    h.error
        .clone()
        .unwrap_or_else(|| "timed out: the proxy did not answer".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use hproxy_relay::{upstream, List, Rotation, Source};
    use std::cell::Cell;

    fn failed(error: &str) -> Health {
        Health::failed(error.into(), "hproxy.com".into(), true, 1)
    }

    fn because(why: Why, said: Said) -> Option<Failure> {
        Some(Failure { why, said })
    }

    fn source(lines: &[&str]) -> SwitchableSource {
        let members = lines.iter().map(|l| upstream::parse(l).unwrap()).collect();
        SwitchableSource::new(Source::List(List::new(members, Rotation::OnFailure).unwrap()))
    }

    #[tokio::test]
    async fn a_group_moves_on_until_one_works() {
        let tries = Cell::new(0);
        let s = source(&["198.51.100.1:8080", "198.51.100.2:8080", "198.51.100.3:8080"]);
        let answer = until_it_works(
            &s,
            || {
                tries.set(tries.get() + 1);
                let n = tries.get();
                async move { n }
            },
            |n| *n == 3,
        )
        .await;
        assert_eq!(answer, 3);
        assert_eq!(tries.get(), 3, "the third proxy worked, so no fourth try");
    }

    #[tokio::test]
    async fn a_group_gives_up_after_a_few_and_says_the_last_answer() {
        let tries = Cell::new(0);
        let s = source(&[
            "198.51.100.1:8080",
            "198.51.100.2:8080",
            "198.51.100.3:8080",
            "198.51.100.4:8080",
            "198.51.100.5:8080",
            "198.51.100.6:8080",
        ]);
        let answer = until_it_works(
            &s,
            || {
                tries.set(tries.get() + 1);
                let n = tries.get();
                async move { n }
            },
            |_| false,
        )
        .await;
        assert_eq!(answer, MOVES + 1);
    }

    #[tokio::test]
    async fn a_single_proxy_gets_its_one_try() {
        let tries = Cell::new(0);
        let s = SwitchableSource::new(Source::Fixed(upstream::parse("198.51.100.1:8080").unwrap()));
        until_it_works(
            &s,
            || {
                tries.set(tries.get() + 1);
                async {}
            },
            |_| false,
        )
        .await;
        assert_eq!(tries.get(), 1, "nothing to move on to");
    }

    #[test]
    fn one_more_try_only_where_it_can_change_the_answer() {
        let refused = failed("proxy error: it did not open hproxy.com");
        assert!(
            worth_another_try(&refused, Some(Why::Other)),
            "one bad exit of a gateway"
        );
        assert!(
            worth_another_try(&refused, Some(Why::Blocked)),
            "the exit would not go there"
        );
        assert!(worth_another_try(&failed("connection closed: the proxy hung up"), None));
        assert!(!worth_another_try(&refused, Some(Why::Login)), "the login stays wrong");
        assert!(
            !worth_another_try(&refused, Some(Why::Refused)),
            "nothing listens there"
        );
        assert!(!worth_another_try(&refused, Some(Why::Dns)), "the name stays unknown");
        assert!(
            !worth_another_try(&refused, Some(Why::Timeout)),
            "it waited long enough"
        );
        assert!(!worth_another_try(
            &failed("bad certificate: the proxy showed a false one for hproxy.com"),
            None
        ));
        assert!(!worth_another_try(
            &failed("timed out: no answer from hproxy.com within 12 seconds"),
            None
        ));
    }

    #[test]
    fn a_failure_is_named_by_whoever_knows_most() {
        let h = failed("proxy error: it did not open hproxy.com");
        let says = |failure: Option<Failure>| failure_words(&h, failure.as_ref());
        assert_eq!(
            says(because(Why::Timeout, Said::Nothing)),
            "timed out: the proxy did not answer"
        );
        assert_eq!(
            says(because(Why::Login, Said::Status(407))),
            "login refused: check the username and password"
        );
        assert_eq!(
            says(because(Why::Refused, Said::Nothing)),
            "connection refused: nothing answers at that address"
        );
        assert_eq!(
            says(because(Why::Dns, Said::Nothing)),
            "address not found: that name does not exist"
        );
        assert_eq!(
            says(because(Why::Blocked, Said::Status(403))),
            "blocked (403): the proxy would not open hproxy.com"
        );
        assert_eq!(
            says(because(Why::Other, Said::Status(502))),
            "proxy error 502: it did not open hproxy.com"
        );
        assert_eq!(
            says(because(Why::Other, Said::Socks("host unreachable"))),
            "proxy error: host unreachable"
        );
        assert_eq!(
            says(because(Why::Other, Said::WrongProtocol)),
            "wrong protocol: it did not answer as a proxy of this kind"
        );
        assert_eq!(
            says(because(Why::Other, Said::Nothing)),
            "proxy error: it did not open hproxy.com"
        );
        assert_eq!(says(None), "proxy error: it did not open hproxy.com");
    }

    #[test]
    fn every_failure_starts_with_its_name() {
        let h = failed("timed out: no answer from hproxy.com within 12 seconds");
        for why in [
            Why::Timeout,
            Why::Login,
            Why::Refused,
            Why::Dns,
            Why::Blocked,
            Why::Other,
        ] {
            let words = failure_words(&h, because(why, Said::Status(500)).as_ref());
            assert!(words.split_once(": ").is_some(), "{words}");
        }
    }
}
