//! How fast does a closed port say no on this platform?
//!
//! A checker spends most of its life on refused ports, so this number is the
//! floor under the whole run. Measured 2026-09-16 on Windows 11: a blocking
//! `std::net::TcpStream::connect_timeout` and tokio's `TcpStream::connect` both
//! report `ConnectionRefused` after about 2.05 seconds, because Winsock retries
//! the SYN after the RST before giving up; Node's overlapped `ConnectEx` on the
//! same machine reports it in 5 ms. On Linux and macOS the refusal arrives in
//! well under a millisecond.
//!
//! Consequences, encoded in the engine: the connect budget must stay above
//! 2.5 seconds or every refused port on Windows reads as a timeout, and the
//! governor is what keeps a mostly-dead list fast, because a refused probe
//! costs a slot for two seconds but almost no bandwidth.
//!
//! Ignored by default (it is a measurement, not a contract). Run it with
//! `cargo test -p hproxy-probe --test refused_timing -- --ignored --nocapture`.

use std::net::TcpListener;
use std::time::{Duration, Instant};

fn closed_port() -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let p = l.local_addr().unwrap().port();
    drop(l);
    p
}

#[test]
#[ignore = "platform measurement"]
fn std_blocking_connect_refusal_timing() {
    let port = closed_port();
    let t = Instant::now();
    let r = std::net::TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(5));
    println!(
        "std connect_timeout: {:?} in {:?}",
        r.as_ref().err().map(|e| e.kind()),
        t.elapsed()
    );
    assert!(r.is_err());
}

#[tokio::test]
#[ignore = "platform measurement"]
async fn tokio_connect_refusal_timing() {
    let port = closed_port();
    let t = Instant::now();
    let r = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect(("127.0.0.1", port)),
    )
    .await;
    match &r {
        Ok(Ok(_)) => println!("tokio: connected?!"),
        Ok(Err(e)) => println!("tokio: error {:?} in {:?}", e.kind(), t.elapsed()),
        Err(_) => println!("tokio: TIMED OUT after {:?}", t.elapsed()),
    }
    assert!(
        matches!(r, Ok(Err(_))),
        "tokio must report the refusal inside five seconds"
    );
}
