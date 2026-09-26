//! API-mode checking against a fake NDJSON server.
//!
//! The parsing here is the kind that looks obviously correct and is not: lines
//! arrive split across TCP reads, the server may answer for fewer proxies than
//! it was given, and the terminator may arrive while the connection stays open.
//! Each of those, got wrong, loses results silently — a proxy with no answer is
//! marked dead at the end of a run, so the failure mode is "your working proxy
//! is reported dead", with nothing on screen suggesting anything went wrong.

use hproxy_api::check_api::{Remote, RemoteError};
use hproxy_probe::{CheckOptions, CheckResult, ProtocolSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn read_request(s: &mut TcpStream) -> String {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                // Stop once the declared body has arrived.
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().to_string()))
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    if buf.len() >= i + 4 + len {
                        break;
                    }
                }
            }
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// A server that writes `pieces` verbatim, in order, with a pause between them.
/// `status_line` lets a test answer 429 instead of 200.
async fn spawn_server(
    status_line: &'static str,
    extra_headers: &'static str,
    pieces: Vec<String>,
    keep_open: bool,
) -> (SocketAddr, Arc<Mutex<Option<String>>>) {
    let seen = Arc::new(Mutex::new(None));
    let seen_c = seen.clone();
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            let pieces = pieces.clone();
            let seen = seen_c.clone();
            tokio::spawn(async move {
                let req = read_request(&mut s).await;
                if let Some(i) = req.find("\r\n\r\n") {
                    *seen.lock().unwrap() = Some(req[i + 4..].to_string());
                }
                // Chunked so the body can be streamed in pieces without
                // declaring a length up front, exactly like the real endpoint.
                let head = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/x-ndjson\r\n{extra_headers}Transfer-Encoding: chunked\r\n\r\n"
                );
                if s.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                for p in pieces {
                    let framed = format!("{:x}\r\n{p}\r\n", p.len());
                    if s.write_all(framed.as_bytes()).await.is_err() {
                        return;
                    }
                    let _ = s.flush().await;
                    tokio::time::sleep(Duration::from_millis(15)).await;
                }
                if !keep_open {
                    let _ = s.write_all(b"0\r\n\r\n").await;
                    let _ = s.flush().await;
                } else {
                    // Terminator sent, connection deliberately left hanging.
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
            });
        }
    });
    (addr, seen)
}

fn opts() -> CheckOptions {
    CheckOptions {
        timeout: Duration::from_secs(5),
        retries: 1,
        protocols: ProtocolSet {
            http: true,
            https: true,
            socks4: false,
            socks5: false,
        },
        ..Default::default()
    }
}

fn line(input: &str, alive: bool) -> String {
    format!(
        r#"{{"input":"{input}","ip":"1.2.3.4","port":8080,"alive":{alive},"protocols":["http"],"latency_ms":150,"country_code":"DE"}}"#
    )
}

const END: &str = r#"{"_event":"end"}"#;

#[tokio::test]
async fn streams_results_and_reports_what_was_answered() {
    let body = format!("{}\n{}\n{}\n", line("a:1", true), line("b:2", false), END);
    let (addr, seen) = spawn_server("200 OK", "", vec![body], false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let got: Arc<Mutex<Vec<CheckResult>>> = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    let answered = remote
        .check(&["a:1".into(), "b:2".into()], &opts(), move |r| {
            g.lock().unwrap().push(r)
        })
        .await
        .expect("must succeed");

    assert_eq!(got.lock().unwrap().len(), 2);
    assert_eq!(answered.len(), 2);
    assert!(answered.contains("a:1") && answered.contains("b:2"));
    assert_eq!(
        got.lock().unwrap()[0].source.as_deref(),
        Some("api"),
        "rows must be labelled so a missing waterfall is explained"
    );

    // The probe options must actually reach the server, or the run silently
    // uses the server's defaults instead of the user's settings.
    let sent = seen.lock().unwrap().clone().unwrap();
    assert!(sent.contains("\"timeout_ms\":5000"), "sent: {sent}");
    assert!(sent.contains("\"retries\":1"), "sent: {sent}");
    assert!(sent.contains("\"http\""), "sent: {sent}");
    assert!(!sent.contains("socks4"), "unselected protocols must not be requested");
}

/// THE parsing trap. A JSON line does not arrive in one read; it arrives in
/// whatever pieces the network chose. Parsing per read instead of per newline
/// drops a result every time a line straddles a boundary.
#[tokio::test]
async fn a_line_split_across_reads_is_not_lost() {
    let full = format!("{}\n{}\n{}\n", line("a:1", true), line("b:2", true), END);
    // Cut mid-way through the first JSON object, then mid-way through the second.
    let cut1 = 40;
    let cut2 = full.len() / 2 + 7;
    let pieces = vec![
        full[..cut1].to_string(),
        full[cut1..cut2].to_string(),
        full[cut2..].to_string(),
    ];
    let (addr, _) = spawn_server("200 OK", "", pieces, false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let count = Arc::new(Mutex::new(0usize));
    let c = count.clone();
    let answered = remote
        .check(&["a:1".into(), "b:2".into()], &opts(), move |_| *c.lock().unwrap() += 1)
        .await
        .unwrap();

    assert_eq!(*count.lock().unwrap(), 2, "both results must survive the split");
    assert_eq!(answered.len(), 2);
}

/// The reconciliation contract: the caller finds out exactly which inputs came
/// back, so it can send the rest to local workers. Getting this wrong turns
/// unanswered proxies into dead rows.
#[tokio::test]
async fn unanswered_inputs_are_reported_as_unanswered() {
    let body = format!("{}\n{}\n", line("a:1", true), END);
    let (addr, _) = spawn_server("200 OK", "", vec![body], false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let sent: Vec<String> = vec!["a:1".into(), "b:2".into(), "c:3".into()];
    let answered = remote.check(&sent, &opts(), |_| {}).await.unwrap();

    assert_eq!(answered.len(), 1);
    let missed: Vec<&String> = sent.iter().filter(|s| !answered.contains(*s)).collect();
    assert_eq!(missed, vec!["b:2", "c:3"]);
}

/// The terminator must end the read. A server that keeps the socket open after
/// `_event: end` would otherwise hold the run hostage until the stream deadline.
#[tokio::test]
async fn the_terminator_ends_the_read_even_if_the_socket_stays_open() {
    let body = format!("{}\n{}\n", line("a:1", true), END);
    let (addr, _) = spawn_server("200 OK", "", vec![body], true).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let started = std::time::Instant::now();
    let answered = tokio::time::timeout(Duration::from_secs(5), remote.check(&["a:1".into()], &opts(), |_| {}))
        .await
        .expect("must return without waiting for the socket to close")
        .unwrap();

    assert_eq!(answered.len(), 1);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn a_rate_limit_is_distinguishable_and_carries_its_retry_after() {
    let (addr, _) = spawn_server("429 Too Many Requests", "Retry-After: 42\r\n", vec![], false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let err = remote
        .check(&["a:1".into()], &opts(), |_| {})
        .await
        .expect_err("429 must be an error, not an empty success");

    match err {
        RemoteError::RateLimited(secs) => assert_eq!(secs, Some(42)),
        other => panic!("expected a rate limit, got {other:?}"),
    }
}

/// An empty success would look like "the server answered for nothing", which
/// the caller would treat as every line unanswered and quietly requeue. That is
/// the right outcome, but it must come from an explicit error so the user is
/// told the API failed rather than silently getting a local run.
#[tokio::test]
async fn a_server_error_is_an_error() {
    let (addr, _) = spawn_server("500 Internal Server Error", "", vec![], false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();
    let err = remote.check(&["a:1".into()], &opts(), |_| {}).await;
    assert!(matches!(err, Err(RemoteError::Failed(_))));
}

/// SSRF-screened lines come back as ordinary result rows carrying an error, and
/// they count as answered: the server did look at them and did give a verdict.
#[tokio::test]
async fn blocked_lines_count_as_answered() {
    let blocked =
        r#"{"input":"127.0.0.1:80","ip":null,"port":null,"alive":false,"protocols":[],"error":"unreachable"}"#;
    let body = format!("{blocked}\n{END}\n");
    let (addr, _) = spawn_server("200 OK", "", vec![body], false).await;
    let remote = Remote::new(format!("http://{addr}/check")).unwrap();

    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    let answered = remote
        .check(&["127.0.0.1:80".into()], &opts(), move |r| g.lock().unwrap().push(r))
        .await
        .unwrap();

    assert_eq!(answered.len(), 1, "a refusal is still an answer");
    assert_eq!(got.lock().unwrap()[0].error.as_deref(), Some("unreachable"));
}
