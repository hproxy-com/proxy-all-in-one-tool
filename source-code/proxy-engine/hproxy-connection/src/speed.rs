//! How fast a download through the relay is.
//!
//! Our speed door (`hproxy_probe::speed::DEFAULT_SPEED_URL`) hands anyone a
//! fixed payload of up to 64 KB (more only for our own signed verifier). One
//! 64 KB answer on a fast line is over before TCP has sped up, so it measures
//! the round trip, not the speed. So the test asks for one payload after the
//! other on the SAME connection through the relay: the connection warms up,
//! and the bytes of every answer after the first are timed together. It stops
//! at `MAX_BYTES` or `MAX_TIME`, whichever comes first, because every byte
//! goes through the person's own proxy and their plan.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use serde::Serialize;

/// What one test may use of the person's plan.
pub const MAX_BYTES: u64 = 3 * 1024 * 1024;
/// How long one test may take.
pub const MAX_TIME: Duration = Duration::from_secs(8);
/// One answer of the speed door.
const PIECE: usize = hproxy_probe::speed::PUBLIC_CAP_BYTES;

#[derive(Debug, Serialize, Clone)]
pub struct Speed {
    /// Megabits per second, measured over the warm connection.
    pub mbps: f64,
    /// Bytes downloaded, the first answer included.
    pub bytes: u64,
    /// The round trip of the first request through the relay, in ms.
    pub first_ms: u64,
    /// How long the timed part took, in ms.
    pub timed_ms: u64,
}

/// Download through the relay on `listen`.
pub async fn measure(listen: SocketAddr, program: &str) -> Result<Speed, String> {
    let proxy = reqwest::Proxy::all(format!("http://{listen}")).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .pool_max_idle_per_host(1)
        .user_agent(format!("{program}/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("could not start the speed test: {e}"))?;
    let url = format!("{}?bytes={PIECE}", hproxy_probe::speed::DEFAULT_SPEED_URL);

    let started = Instant::now();
    let mut total: u64 = fetch(&client, &url).await?;
    let first_ms = started.elapsed().as_millis() as u64;

    let timed = Instant::now();
    let mut timed_bytes: u64 = 0;
    while total < MAX_BYTES && started.elapsed() < MAX_TIME {
        let n = fetch(&client, &url).await?;
        total += n;
        timed_bytes += n;
    }
    let timed_ms = timed.elapsed().as_millis() as u64;
    if timed_bytes == 0 || timed_ms == 0 {
        return Err("the speed test did not get far enough to measure".into());
    }
    let mbps = (timed_bytes as f64 * 8.0) / (timed_ms as f64 / 1000.0) / 1_000_000.0;
    Ok(Speed {
        mbps: (mbps * 10.0).round() / 10.0,
        bytes: total,
        first_ms,
        timed_ms,
    })
}

/// One answer of the door, read whole; its size in bytes.
async fn fetch(client: &reqwest::Client, url: &str) -> Result<u64, String> {
    let resp = client
        .get(url)
        .header("Accept-Encoding", "identity")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "the speed test timed out".to_string()
            } else {
                e.without_url().to_string()
            }
        })?;
    if !resp.status().is_success() {
        return Err(format!("the speed test answered {}", resp.status()));
    }
    let body = resp.bytes().await.map_err(|e| e.without_url().to_string())?;
    Ok(body.len() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_relay_that_is_not_there_fails_with_a_reason() {
        let closed = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let err = measure(closed, "hproxy-test").await.unwrap_err();
        assert!(!err.is_empty());
    }

    // A test never uses more than a few megabytes, in pieces the public door hands out.
    const _: () = assert!(MAX_BYTES <= 4 * 1024 * 1024);
    const _: () = assert!(PIECE <= 64 * 1024);
}
