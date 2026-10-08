//! Phase-timed probes for the four transports, each climbing the judge ladder.
//!
//! Every probe used to be one library call wrapped in one clock. One number
//! cannot distinguish a proxy that is far away from one that is overloaded,
//! which are opposite problems calling for opposite decisions. So the probes
//! own the socket and drive the wire themselves:
//!
//! 1. dial the proxy, timing DNS and TCP separately (`dial.rs`)
//! 2. establish the transport, timing the proxy's admission step (the SOCKS
//!    greeting, or `CONNECT` and its reply) and any TLS handshake
//! 3. send one GET to a judge and read the reply, timing first byte
//!
//! Step 3 is identical for all four, so the four transports produce genuinely
//! comparable numbers. Every request carries the nonce, every reply must
//! reflect it, and every transport therefore learns the exit address.

use crate::browser;
use crate::dial::{classify_io, dial, ms, Dialed};
use crate::echo::{echo_with_nonce, trace_echo, EchoResponse, PROBE_NONCE_HEADER};
use crate::judge::{Judge, JudgeKind};
use crate::line::b64;
use crate::result::{Failure, FailureDetail, Phase, Timings};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Hard cap on how much of a reply is buffered. The judge answers with a few
/// hundred bytes; anything vastly larger is an interstitial or an error page,
/// and none of those become more informative at megabyte three.
const MAX_RESPONSE: usize = 64 * 1024;

/// The proxy under test.
#[derive(Clone, Copy)]
pub struct Target<'a> {
    pub host: &'a str,
    pub port: u16,
    pub auth: Option<&'a (String, String)>,
}

/// Two deadlines, not one. `connect` is a fail-fast cap on getting a socket: a
/// proxy that is listening but comatose is the most common failure on a
/// scraped list, and letting it hold a worker for the full deadline is how a
/// run of ten thousand takes an hour. `total` bounds everything.
#[derive(Clone, Copy)]
pub struct Budget {
    pub connect: Duration,
    pub total: Duration,
}

impl Budget {
    fn dial(&self) -> Duration {
        self.connect.min(self.total)
    }
}

/// What one transport learned after climbing its ladder.
#[derive(Default, Debug)]
pub struct Probe {
    pub alive: bool,
    pub timings: Option<Timings>,
    /// The judge's echo. Present on every alive probe by construction: reaching
    /// our judge with our nonce is what "alive" means.
    pub echo: Option<EchoResponse>,
    /// Reply headers as they arrived back through the proxy, names lowercased.
    /// Where `Via` and `X-Cache` live, so it is what identifies the software.
    pub headers: HashMap<String, String>,
    /// The address actually dialled, after any name resolution.
    pub peer: Option<SocketAddr>,
    /// Which rung answered.
    pub judge: Option<JudgeKind>,
    /// Why the transport failed, from the rung that said the most.
    pub failure: Option<FailureDetail>,
    /// Whether the certificate that came back through the tunnel was the
    /// judge's real one. `None` when no TLS was spoken or it could not be told.
    pub tls_genuine: Option<bool>,
}

impl Probe {
    fn failed(kind: Failure, phase: Phase, started: Instant, status: Option<u16>) -> Self {
        Probe {
            failure: Some(FailureDetail {
                kind,
                phase,
                elapsed_ms: ms(started.elapsed()),
                status,
            }),
            ..Default::default()
        }
    }
}

/// Everything a rung attempt needs besides the rung itself.
#[derive(Clone, Copy)]
pub struct Context<'a> {
    pub nonce: &'a str,
    pub budget: Budget,
}

/// The phases measured before the request went out.
#[derive(Default, Clone, Copy)]
struct Phases {
    dns_ms: Option<u32>,
    connect_ms: u32,
    handshake_ms: Option<u32>,
    tls_ms: Option<u32>,
    peer: Option<SocketAddr>,
}

// ── The climb ────────────────────────────────────────────────────────────────

/// Climb the rungs in order and stop at the first that answers with the nonce.
///
/// Only a refused connection to the PROXY ends the climb early: nothing is
/// listening, so no rung can help. A line with credentials climbs past even
/// that, because residential gateways are known to refuse odd origin ports and
/// relay to port 80 fine, and a paid gateway is worth two more probes. A
/// timeout never ends the climb: for a proxy that accepts only some of the
/// connections it gets, the later rungs are the retries that find it.
///
/// The failure reported is the most informative one seen on any rung, not the
/// last: "answered 407" on rung one beats "timed out" on rung three.
async fn climb<'a, F, Fut>(rungs: &'a [Judge], credentialed: bool, mut attempt: F) -> Probe
where
    F: FnMut(&'a Judge) -> Fut,
    Fut: Future<Output = Probe>,
{
    let mut best: Option<Probe> = None;
    for rung in rungs {
        let p = attempt(rung).await;
        if p.alive {
            return p;
        }
        let stop = match &p.failure {
            Some(f) => {
                (f.kind == Failure::Refused && f.phase == Phase::Connect && !credentialed)
                    || (f.kind == Failure::Unresolved && f.phase == Phase::Dns)
            }
            None => false,
        };
        let better = match (&best, &p.failure) {
            (None, _) => true,
            (Some(b), Some(f)) => b.failure.as_ref().is_none_or(|bf| f.kind.rank() < bf.kind.rank()),
            (Some(_), None) => false,
        };
        if better {
            best = Some(p);
        }
        if stop {
            break;
        }
    }
    best.unwrap_or_default()
}

// ── Transports ───────────────────────────────────────────────────────────────

/// Plain HTTP through an HTTP proxy: an absolute-form GET straight at the proxy.
/// The only transport where the proxy can see and rewrite our headers, so the
/// one that grades all three anonymity tiers.
pub async fn http(t: Target<'_>, rungs: &[Judge], cx: Context<'_>) -> Probe {
    climb(rungs, t.auth.is_some(), |judge| async move {
        let started = Instant::now();
        let d = match dial(t.host, t.port, cx.budget.dial()).await {
            Ok(d) => d,
            Err(e) => {
                return Probe {
                    failure: Some(e.detail),
                    ..Default::default()
                }
            }
        };
        let mut stream = d.stream;
        let authority = judge.authority();
        let req = build_request(
            &format!("http://{authority}{}", judge.path),
            &authority,
            judge.kind,
            cx.nonce,
            // Sent to the proxy itself, so the login rides Proxy-Authorization.
            t.auth.map(|a| ("Proxy-Authorization", a)),
        );
        finish(
            &mut stream,
            &req,
            started,
            Phases {
                dns_ms: d.dns_ms,
                connect_ms: d.connect_ms,
                peer: d.peer,
                ..Default::default()
            },
            judge.kind,
            cx,
        )
        .await
    })
    .await
}

/// HTTPS through an HTTP proxy: `CONNECT`, then TLS we drive ourselves.
/// `handshake_ms` is the proxy deciding whether to let you out, `tls_ms` the
/// far end's handshake carried over the tunnel it opened.
pub async fn https(t: Target<'_>, rungs: &[Judge], cx: Context<'_>) -> Probe {
    climb(rungs, t.auth.is_some(), |judge| async move {
        let started = Instant::now();
        let d = match dial(t.host, t.port, cx.budget.dial()).await {
            Ok(d) => d,
            Err(e) => {
                return Probe {
                    failure: Some(e.detail),
                    ..Default::default()
                }
            }
        };
        let mut stream = d.stream;

        let t_hs = Instant::now();
        let authority = judge.authority();
        let target = judge.connect_target();
        let mut connect_req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
        if let Some((user, pass)) = t.auth {
            connect_req.push_str(&basic_auth_line("Proxy-Authorization", user, pass));
        }
        connect_req.push_str("\r\n");
        if let Err(e) = write_all_within(&mut stream, connect_req.as_bytes(), cx.budget.total, started).await {
            return Probe::failed(classify_io(&e), Phase::Handshake, started, None);
        }
        match read_head_within(&mut stream, cx.budget.total, started).await {
            Ok(head) => match status_of(&head) {
                Some(s) if (200..300).contains(&s) => {}
                Some(s) => return Probe::failed(failure_for_status(s), Phase::Handshake, started, Some(s)),
                None => return Probe::failed(Failure::Transport, Phase::Handshake, started, None),
            },
            Err(e) => return Probe::failed(classify_io(&e), Phase::Handshake, started, None),
        }
        let handshake_ms = ms(t_hs.elapsed());

        let (mut tls, tls_ms, genuine) = match tls_over(stream, &judge.host, cx.budget.total, started).await {
            Ok(v) => v,
            Err(p) => return p,
        };
        // Inside the tunnel we are talking to the origin: an origin-form
        // request with no proxy login attached.
        let req = build_request(&judge.path, &authority, judge.kind, cx.nonce, None);
        let mut probe = finish(
            &mut tls,
            &req,
            started,
            Phases {
                dns_ms: d.dns_ms,
                connect_ms: d.connect_ms,
                handshake_ms: Some(handshake_ms),
                tls_ms: Some(tls_ms),
                peer: d.peer,
            },
            judge.kind,
            cx,
        )
        .await;
        probe.tls_genuine = genuine;
        probe
    })
    .await
}

/// SOCKS5. Carries a hostname, so the judge is passed by name and the proxy
/// resolves it, which is what `socks5h` means and what you want from a proxy.
pub async fn socks5(t: Target<'_>, rungs: &[Judge], cx: Context<'_>) -> Probe {
    climb(rungs, t.auth.is_some(), |judge| async move {
        let started = Instant::now();
        let Dialed {
            stream: sock,
            dns_ms,
            connect_ms,
            peer,
        } = match dial(t.host, t.port, cx.budget.dial()).await {
            Ok(d) => d,
            Err(e) => {
                return Probe {
                    failure: Some(e.detail),
                    ..Default::default()
                }
            }
        };
        let t_hs = Instant::now();
        let left = cx.budget.total.saturating_sub(started.elapsed());
        let dest = (judge.host.as_str(), judge.port);
        let handshake = async move {
            match t.auth {
                Some((user, pass)) => {
                    tokio_socks::tcp::Socks5Stream::connect_with_password_and_socket(sock, dest, user, pass).await
                }
                None => tokio_socks::tcp::Socks5Stream::connect_with_socket(sock, dest).await,
            }
        };
        let stream = match tokio::time::timeout(left, handshake).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let (kind, status) = classify_socks(&e);
                return Probe::failed(kind, Phase::Handshake, started, status);
            }
            Err(_) => return Probe::failed(Failure::Timeout, Phase::Handshake, started, None),
        };
        let handshake_ms = ms(t_hs.elapsed());
        let phases = Phases {
            dns_ms,
            connect_ms,
            handshake_ms: Some(handshake_ms),
            peer,
            ..Default::default()
        };
        through_tunnel(stream, judge, phases, started, cx).await
    })
    .await
}

/// SOCKS4. The destination must be an `ip:port`: SOCKS4 carries a raw
/// four-byte address and has no domain form, so the caller resolves each rung
/// once per run and passes the addresses alongside.
pub async fn socks4(t: Target<'_>, rungs: &[(Judge, SocketAddr)], cx: Context<'_>) -> Probe {
    let judges: Vec<Judge> = rungs.iter().map(|(j, _)| j.clone()).collect();
    let addr_of = |judge: &Judge| rungs.iter().find(|(j, _)| j == judge).map(|(_, a)| *a);
    climb(&judges, t.auth.is_some(), |judge| async move {
        let started = Instant::now();
        let Some(judge_addr) = addr_of(judge) else {
            return Probe::failed(Failure::Unresolved, Phase::Dns, started, None);
        };
        let Dialed {
            stream: sock,
            dns_ms,
            connect_ms,
            peer,
        } = match dial(t.host, t.port, cx.budget.dial()).await {
            Ok(d) => d,
            Err(e) => {
                return Probe {
                    failure: Some(e.detail),
                    ..Default::default()
                }
            }
        };
        let t_hs = Instant::now();
        let left = cx.budget.total.saturating_sub(started.elapsed());
        // SOCKS4 authenticates with a bare user id, not a password pair.
        let handshake = async move {
            match t.auth {
                Some((user, _)) => {
                    tokio_socks::tcp::Socks4Stream::connect_with_userid_and_socket(sock, judge_addr, user).await
                }
                None => tokio_socks::tcp::Socks4Stream::connect_with_socket(sock, judge_addr).await,
            }
        };
        let stream = match tokio::time::timeout(left, handshake).await {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                let (kind, status) = classify_socks(&e);
                return Probe::failed(kind, Phase::Handshake, started, status);
            }
            Err(_) => return Probe::failed(Failure::Timeout, Phase::Handshake, started, None),
        };
        let handshake_ms = ms(t_hs.elapsed());
        let phases = Phases {
            dns_ms,
            connect_ms,
            handshake_ms: Some(handshake_ms),
            peer,
            ..Default::default()
        };
        through_tunnel(stream, judge, phases, started, cx).await
    })
    .await
}

/// The tail shared by both SOCKS transports: TLS if the rung wants it, then
/// the origin-form request.
async fn through_tunnel<S>(stream: S, judge: &Judge, mut phases: Phases, started: Instant, cx: Context<'_>) -> Probe
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let authority = judge.authority();
    let req = build_request(&judge.path, &authority, judge.kind, cx.nonce, None);
    if judge.tls {
        let (mut tls, tls_ms, genuine) = match tls_over(stream, &judge.host, cx.budget.total, started).await {
            Ok(v) => v,
            Err(p) => return p,
        };
        phases.tls_ms = Some(tls_ms);
        let mut probe = finish(&mut tls, &req, started, phases, judge.kind, cx).await;
        probe.tls_genuine = genuine;
        probe
    } else {
        let mut stream = stream;
        finish(&mut stream, &req, started, phases, judge.kind, cx).await
    }
}

/// A TLS handshake over an already-open stream, timed, and whether the
/// certificate that came back is the judge's real one.
async fn tls_over<S>(
    stream: S,
    host: &str,
    budget: Duration,
    started: Instant,
) -> Result<(tokio_rustls::client::TlsStream<S>, u32, Option<bool>), Probe>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let t_tls = Instant::now();
    let server_name = match rustls::pki_types::ServerName::try_from(host.to_string()) {
        Ok(n) => n,
        Err(_) => return Err(Probe::failed(Failure::Tls, Phase::Tls, started, None)),
    };
    let connector = tokio_rustls::TlsConnector::from(tls_config());
    let left = budget.saturating_sub(started.elapsed());
    match tokio::time::timeout(left, connector.connect(server_name, stream)).await {
        Ok(Ok(s)) => {
            let tls_ms = ms(t_tls.elapsed());
            let chain = s.get_ref().1.peer_certificates().unwrap_or(&[]);
            let genuine = genuine_chain(chain, host, rustls::pki_types::UnixTime::now());
            Ok((s, tls_ms, genuine))
        }
        Ok(Err(_)) => Err(Probe::failed(Failure::Tls, Phase::Tls, started, None)),
        Err(_) => Err(Probe::failed(Failure::Timeout, Phase::Tls, started, None)),
    }
}

/// Whether a certificate chain is the real one for `host`: it leads to a
/// public root and names the host. `None` when that cannot be told (no chain,
/// a name TLS cannot carry, no root store).
///
/// The handshake itself accepts any chain on purpose (see `AcceptAnyServerCert`):
/// whether a proxy relays is one question, and a proxy that re-signs HTTPS with
/// its own authority does relay. Whether it can READ what it relays is another
/// question, and this is the answer. A person must never log in through a
/// proxy that fails this; the checker says so instead of calling it just alive.
pub fn genuine_chain(
    chain: &[rustls::pki_types::CertificateDer<'_>],
    host: &str,
    now: rustls::pki_types::UnixTime,
) -> Option<bool> {
    use rustls::client::danger::ServerCertVerifier;
    static VERIFIER: OnceLock<Option<Arc<rustls::client::WebPkiServerVerifier>>> = OnceLock::new();
    let verifier = VERIFIER
        .get_or_init(|| {
            let roots: rustls::RootCertStore = webpki_roots::TLS_SERVER_ROOTS.iter().cloned().collect();
            rustls::client::WebPkiServerVerifier::builder_with_provider(
                Arc::new(roots),
                Arc::new(rustls::crypto::ring::default_provider()),
            )
            .build()
            .ok()
        })
        .as_ref()?;
    let (end_entity, intermediates) = chain.split_first()?;
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).ok()?;
    Some(
        verifier
            .verify_server_cert(end_entity, intermediates, &name, &[], now)
            .is_ok(),
    )
}

// ── The shared tail ──────────────────────────────────────────────────────────

/// Send the request, read the reply, assemble the result.
async fn finish<S>(
    stream: &mut S,
    req: &str,
    started: Instant,
    phases: Phases,
    kind: JudgeKind,
    cx: Context<'_>,
) -> Probe
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if let Err(e) = write_all_within(stream, req.as_bytes(), cx.budget.total, started).await {
        return Probe::failed(classify_io(&e), Phase::Request, started, None);
    }
    let (raw, ttfb) = match read_body_within(stream, cx.budget.total, started).await {
        Ok(v) => v,
        Err(e) => return Probe::failed(classify_io(&e), Phase::Response, started, None),
    };
    let Some(parsed) = parse_response(&raw) else {
        return Probe::failed(Failure::Transport, Phase::Response, started, None);
    };

    // 2xx only, and a redirect is a failure rather than something to follow.
    // A plain-HTTP judge that redirects to HTTPS stops being able to grade
    // anonymity at all: the proxy tunnels instead of rewriting, no forwarding
    // header can appear, and every proxy silently grades elite. Refusing the
    // redirect turns that class of bug into a visible dead judge.
    if !(200..300).contains(&parsed.status) {
        return Probe::failed(
            failure_for_status(parsed.status),
            Phase::Response,
            started,
            Some(parsed.status),
        );
    }

    // "Something returned 200" and "we reached our judge" are different claims,
    // and only the second is evidence the proxy relayed anything. The echo must
    // parse AND carry this probe's nonce.
    let echo = match kind {
        JudgeKind::Echo => echo_with_nonce(serde_json::from_str::<EchoResponse>(&parsed.body).ok(), cx.nonce),
        JudgeKind::Trace => trace_echo(&parsed.body, cx.nonce),
    };
    let Some(echo) = echo else {
        return Probe::failed(Failure::NoEcho, Phase::Response, started, Some(parsed.status));
    };

    Probe {
        alive: true,
        timings: Some(Timings {
            dns_ms: phases.dns_ms,
            connect_ms: phases.connect_ms,
            handshake_ms: phases.handshake_ms,
            tls_ms: phases.tls_ms,
            ttfb_ms: ms(ttfb),
            // Wall clock for the whole probe. The phases sum to slightly less;
            // the remainder is body transfer.
            total_ms: ms(started.elapsed()),
        }),
        echo: Some(echo),
        headers: parsed.headers,
        peer: phases.peer,
        judge: Some(kind),
        failure: None,
        // Filled by the caller that spoke TLS; a plain rung has nothing to say.
        tls_genuine: None,
    }
}

/// A status the proxy answered with, in the vocabulary.
fn failure_for_status(status: u16) -> Failure {
    match status {
        407 => Failure::AuthRequired,
        403 => Failure::Forbidden,
        _ => Failure::BadStatus,
    }
}

/// A SOCKS error in the vocabulary. The reply code rides in `status` so a
/// reader can see "reply 5" next to "connection refused by the proxy".
fn classify_socks(e: &tokio_socks::Error) -> (Failure, Option<u16>) {
    use tokio_socks::Error as E;
    match e {
        E::Io(io) => (classify_io(io), None),
        E::NoAcceptableAuthMethods
        | E::PasswordAuthFailure(_)
        | E::AuthorizationRequired
        | E::IdentdAuthFailure
        | E::InvalidUserIdAuthFailure => (Failure::AuthRequired, None),
        E::ConnectionNotAllowedByRuleset => (Failure::Forbidden, Some(2)),
        E::GeneralSocksServerFailure => (Failure::BadStatus, Some(1)),
        E::NetworkUnreachable => (Failure::BadStatus, Some(3)),
        E::HostUnreachable => (Failure::BadStatus, Some(4)),
        E::ConnectionRefused => (Failure::BadStatus, Some(5)),
        E::TtlExpired => (Failure::BadStatus, Some(6)),
        E::CommandNotSupported => (Failure::BadStatus, Some(7)),
        E::AddressTypeNotSupported => (Failure::BadStatus, Some(8)),
        // Not speaking SOCKS at all: a wrong version byte, garbage, an HTTP
        // server on the port.
        _ => (Failure::Transport, None),
    }
}

/// Build one GET. `target` is an absolute URI for a plain HTTP proxy and an
/// origin-form path everywhere else. The nonce rides in its own header for an
/// echo judge and in the User-Agent for the trace judge, which reflects
/// nothing else.
fn build_request(
    target: &str,
    authority: &str,
    kind: JudgeKind,
    nonce: &str,
    auth: Option<(&str, &(String, String))>,
) -> String {
    let mut r = format!("GET {target} HTTP/1.1\r\nHost: {authority}\r\n");
    match kind {
        JudgeKind::Echo => {
            r.push_str(&browser::chrome_header_lines());
            r.push_str(&format!("{PROBE_NONCE_HEADER}: {nonce}\r\n"));
        }
        JudgeKind::Trace => {
            for line in browser::chrome_header_lines().lines() {
                if line.to_ascii_lowercase().starts_with("user-agent:") {
                    r.push_str(&format!("User-Agent: hproxy-probe/{nonce}\r\n"));
                } else {
                    r.push_str(line);
                    r.push_str("\r\n");
                }
            }
        }
    }
    if let Some((header, (user, pass))) = auth {
        r.push_str(&basic_auth_line(header, user, pass));
    }
    // Ours, not Chrome's: we read to EOF and never reuse the socket.
    r.push_str("Connection: close\r\n\r\n");
    r
}

fn basic_auth_line(header: &str, user: &str, pass: &str) -> String {
    format!("{header}: Basic {}\r\n", b64(format!("{user}:{pass}").as_bytes()))
}

async fn write_all_within<S>(stream: &mut S, bytes: &[u8], budget: Duration, started: Instant) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let left = budget.saturating_sub(started.elapsed());
    if left.is_zero() {
        return Err(io::Error::new(io::ErrorKind::TimedOut, "write budget spent"));
    }
    tokio::time::timeout(left, async {
        stream.write_all(bytes).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "write timed out"))?
}

/// Read just a header block (the `CONNECT` reply, which has no body).
async fn read_head_within<S>(stream: &mut S, budget: Duration, started: Instant) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        let left = budget.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "head timed out"));
        }
        let n = tokio::time::timeout(left, stream.read(&mut chunk))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "head timed out"))??;
        if n == 0 {
            if buf.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "closed without replying",
                ));
            }
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if find(&buf, b"\r\n\r\n").is_some() || buf.len() > 8192 {
            break;
        }
    }
    Ok(buf)
}

/// Read a full reply, returning it with the moment the first byte landed.
/// Stops on a satisfied `Content-Length` rather than always waiting for EOF,
/// so a proxy that ignores `Connection: close` costs nothing.
async fn read_body_within<S>(stream: &mut S, budget: Duration, started: Instant) -> io::Result<(Vec<u8>, Duration)>
where
    S: AsyncRead + Unpin,
{
    let t0 = Instant::now();
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let mut ttfb = None;
    let mut head_end: Option<usize> = None;
    let mut want: Option<usize> = None;
    let mut chunked = false;

    loop {
        let left = budget.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, "read timed out"));
        }
        let n = tokio::time::timeout(left, stream.read(&mut chunk))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "read timed out"))??;
        if n == 0 {
            break;
        }
        if ttfb.is_none() {
            ttfb = Some(t0.elapsed());
        }
        buf.extend_from_slice(&chunk[..n]);

        if head_end.is_none() {
            if let Some(i) = find(&buf, b"\r\n\r\n") {
                head_end = Some(i + 4);
                let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                want = head.lines().find_map(|l| {
                    l.strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                });
                chunked = head
                    .lines()
                    .any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"));
            }
        }
        if let (Some(he), Some(w)) = (head_end, want) {
            if buf.len().saturating_sub(he) >= w {
                break;
            }
        }
        if chunked {
            if let Some(he) = head_end {
                if find(&buf[he..], b"\r\n0\r\n").is_some() || buf[he..].starts_with(b"0\r\n") {
                    break;
                }
            }
        }
        if buf.len() >= MAX_RESPONSE {
            break;
        }
    }

    match ttfb {
        Some(t) => Ok((buf, t)),
        // Connected, wrote, and the far end closed without a byte: a dead
        // relay, not a fast one.
        None => Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "closed without replying",
        )),
    }
}

pub(crate) struct Parsed {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

pub(crate) fn parse_response(raw: &[u8]) -> Option<Parsed> {
    let split = find(raw, b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.lines();
    let status = status_line(lines.next()?)?;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let raw_body = &raw[split + 4..];
    let body = if headers
        .get("transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"))
    {
        dechunk(raw_body)
    } else {
        String::from_utf8_lossy(raw_body).into_owned()
    };
    Some(Parsed { status, headers, body })
}

fn status_of(head: &[u8]) -> Option<u16> {
    status_line(String::from_utf8_lossy(head).lines().next()?)
}

fn status_line(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    parts.next()?.parse().ok()
}

fn dechunk(raw: &[u8]) -> String {
    let mut out = Vec::new();
    let mut rest = raw;
    while let Some(eol) = find(rest, b"\r\n") {
        let size_line = String::from_utf8_lossy(&rest[..eol]);
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_hex, 16) else {
            break;
        };
        if size == 0 {
            break;
        }
        let start = eol + 2;
        let end = start + size;
        if end > rest.len() {
            out.extend_from_slice(&rest[start.min(rest.len())..]);
            break;
        }
        out.extend_from_slice(&rest[start..end]);
        rest = &rest[(end + 2).min(rest.len())..];
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── TLS ──────────────────────────────────────────────────────────────────────

/// One shared client config. Building it compiles a cipher list and is far too
/// expensive to repeat per proxy.
pub(crate) fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .expect("the ring provider supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
            .with_no_client_auth();
        Arc::new(cfg)
    })
    .clone()
}

/// Accepts any certificate chain, deliberately. The question a proxy checker
/// asks is "does this proxy relay bytes", not "does the far end present a
/// certificate my machine trusts". Plenty of working proxies terminate TLS and
/// re-sign with their own certificate; rejecting them would report a working
/// proxy dead. Nothing sensitive crosses this connection: the request is a bare
/// GET and the reply is a public echo. Signature verification still runs, so a
/// handshake only succeeds if the peer holds the key it claims; what is skipped
/// is chain and name validation.
#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn fixture(name: &str) -> rustls::pki_types::CertificateDer<'static> {
        let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        rustls::pki_types::CertificateDer::from(std::fs::read(path).unwrap())
    }

    /// hproxy.com's own chain, captured 2026-09-19, is genuine for its name and
    /// for no other; a self-made certificate is genuine for nothing. The clock
    /// is pinned inside the leaf's validity, so this keeps passing after that
    /// certificate expires.
    #[test]
    fn a_real_chain_is_genuine_and_a_re_signed_one_is_not() {
        let when = rustls::pki_types::UnixTime::since_unix_epoch(Duration::from_secs(1_789_837_310));
        let real = vec![
            fixture("genuine-0-leaf.der"),
            fixture("genuine-1.der"),
            fixture("genuine-2.der"),
            fixture("genuine-3.der"),
        ];
        assert_eq!(genuine_chain(&real, "hproxy.com", when), Some(true));
        assert_eq!(
            genuine_chain(&real, "example.com", when),
            Some(false),
            "a real certificate for another name"
        );
        let forged = vec![fixture("interceptor.crt.der")];
        assert_eq!(genuine_chain(&forged, "hproxy.com", when), Some(false));
        assert_eq!(genuine_chain(&[], "hproxy.com", when), None, "no chain, no verdict");
    }

    #[test]
    fn parses_a_normal_reply() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nVia: 1.1 squid\r\n\r\n{\"ip\":\"9.9.9.9\"}";
        let p = parse_response(raw).expect("must parse");
        assert_eq!(p.status, 200);
        assert_eq!(p.headers.get("via").map(String::as_str), Some("1.1 squid"));
        assert_eq!(p.body, "{\"ip\":\"9.9.9.9\"}");
    }

    #[test]
    fn parses_a_chunked_reply() {
        let raw =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\na\r\n{\"ip\":\"9.9\r\n6\r\n.9.9\"}\r\n0\r\n\r\n";
        let p = parse_response(raw).expect("must parse");
        assert_eq!(p.body, "{\"ip\":\"9.9.9.9\"}");
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;foo=bar\r\nhello\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw).unwrap().body, "hello");
    }

    #[test]
    fn rejects_a_reply_that_is_not_http() {
        assert!(parse_response(b"\x05\x00\x00\x01\r\n\r\n").is_none());
        assert!(status_line("garbage").is_none());
    }

    #[test]
    fn reads_the_status_from_a_connect_reply() {
        assert_eq!(status_of(b"HTTP/1.1 200 Connection established\r\n\r\n"), Some(200));
        assert_eq!(
            status_of(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"),
            Some(407)
        );
        assert_eq!(failure_for_status(407), Failure::AuthRequired);
        assert_eq!(failure_for_status(403), Failure::Forbidden);
        assert_eq!(failure_for_status(302), Failure::BadStatus);
    }

    #[test]
    fn basic_auth_is_encoded_not_echoed() {
        let line = basic_auth_line("Proxy-Authorization", "user", "pass");
        assert_eq!(line, "Proxy-Authorization: Basic dXNlcjpwYXNz\r\n");
        assert!(!line.contains("pass"));
    }

    #[test]
    fn requests_carry_the_fingerprint_the_nonce_and_close() {
        let r = build_request("http://judge/x", "judge", JudgeKind::Echo, "n-1", None);
        assert!(r.starts_with("GET http://judge/x HTTP/1.1\r\nHost: judge\r\n"));
        assert!(r.contains("User-Agent: Mozilla/5.0"));
        assert!(r.contains("x-hproxy-probe: n-1\r\n"));
        assert!(r.ends_with("Connection: close\r\n\r\n"));
        // The trace judge reflects only the User-Agent, so the nonce rides there.
        let t = build_request("/cdn-cgi/trace", "hproxy.com", JudgeKind::Trace, "n-2", None);
        assert!(t.contains("User-Agent: hproxy-probe/n-2\r\n"));
        assert!(!t.contains("Mozilla"));
        assert!(!t.contains("x-hproxy-probe"));
        assert!(t.contains("sec-ch-ua:"), "the rest of the fingerprint stays");
    }

    #[test]
    fn tls_config_builds_once() {
        let cfg = tls_config();
        assert!(!cfg.alpn_protocols.iter().any(|p| p == b"h2"));
        assert!(Arc::ptr_eq(&cfg, &tls_config()));
    }

    /// A fake HTTP proxy that answers with a canned echo carrying the nonce,
    /// plus one that answers 200 with its own page. The first is alive, the
    /// second is a decoy.
    async fn fake_proxy(reply: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { break };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let mut got = Vec::new();
                    loop {
                        let n = s.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        got.extend_from_slice(&buf[..n]);
                        if find(&got, b"\r\n\r\n").is_some() {
                            break;
                        }
                    }
                    let req = String::from_utf8_lossy(&got).to_string();
                    let nonce = req
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("x-hproxy-probe:")
                                .map(|v| v.trim().to_string())
                        })
                        .unwrap_or_default();
                    let body = reply.replace("{NONCE}", &nonce);
                    let _ = s
                        .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nVia: 1.1 fake-squid\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
                        .await;
                });
            }
        });
        port
    }

    /// Budgets wide enough for Windows, where a refused connection takes about
    /// two seconds to be reported (see tests/refused_timing.rs).
    fn cx(nonce: &str) -> Context<'_> {
        Context {
            nonce,
            budget: Budget {
                connect: Duration::from_secs(4),
                total: Duration::from_secs(6),
            },
        }
    }

    #[tokio::test]
    async fn an_echo_with_the_nonce_is_alive_with_a_waterfall() {
        let port = fake_proxy(r#"{"ip":"203.0.113.9","headers":{"x-hproxy-probe":"{NONCE}","via":"1.1 fake-squid"},"peer_ip":"203.0.113.9"}"#).await;
        let rungs = [Judge::echo("http://judge.example:4505/echo").unwrap()];
        let t = Target {
            host: "127.0.0.1",
            port,
            auth: None,
        };
        let n = crate::echo::nonce();
        let p = http(t, &rungs, cx(&n)).await;
        assert!(p.alive, "{:?}", p.failure);
        let tm = p.timings.unwrap();
        assert!(tm.dns_ms.is_none());
        assert!(tm.total_ms >= tm.connect_ms);
        assert_eq!(p.judge, Some(JudgeKind::Echo));
        assert_eq!(p.echo.unwrap().exit_ip().as_deref(), Some("203.0.113.9"));
        assert_eq!(p.headers.get("via").map(String::as_str), Some("1.1 fake-squid"));
    }

    #[tokio::test]
    async fn a_decoy_that_answers_200_with_its_own_page_is_not_alive() {
        let port = fake_proxy("<html>welcome to my router</html>").await;
        let rungs = [Judge::echo("http://judge.example:4505/echo").unwrap()];
        let t = Target {
            host: "127.0.0.1",
            port,
            auth: None,
        };
        let p = http(t, &rungs, cx("n")).await;
        assert!(!p.alive);
        let f = p.failure.unwrap();
        assert_eq!(f.kind, Failure::NoEcho);
        assert_eq!(f.status, Some(200));
    }

    #[tokio::test]
    async fn a_replayed_echo_without_our_nonce_is_not_alive() {
        let port =
            fake_proxy(r#"{"ip":"203.0.113.9","headers":{"x-hproxy-probe":"stale-nonce"},"peer_ip":"203.0.113.9"}"#)
                .await;
        let rungs = [Judge::echo("http://judge.example:4505/echo").unwrap()];
        let p = http(
            Target {
                host: "127.0.0.1",
                port,
                auth: None,
            },
            &rungs,
            cx("fresh"),
        )
        .await;
        assert!(!p.alive);
        assert_eq!(p.failure.unwrap().kind, Failure::NoEcho);
    }

    #[tokio::test]
    async fn a_closed_port_is_refused_and_the_climb_stops_at_once() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let rungs = [
            Judge::echo("http://judge.example:4505/echo").unwrap(),
            Judge::trace("http://judge.example/cdn-cgi/trace").unwrap(),
        ];
        let started = Instant::now();
        let p = http(
            Target {
                host: "127.0.0.1",
                port,
                auth: None,
            },
            &rungs,
            cx("n"),
        )
        .await;
        assert!(!p.alive);
        let f = p.failure.unwrap();
        assert_eq!(f.kind, Failure::Refused);
        assert_eq!(f.phase, Phase::Connect);
        // One refusal (about two seconds on Windows, instant elsewhere), not
        // one per rung.
        assert!(
            started.elapsed() < Duration::from_millis(3500),
            "one refused connect must not be retried per rung: {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn a_407_is_reported_as_auth_required() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    let _ = s.read(&mut buf).await;
                    let _ = s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                });
            }
        });
        let rungs = [Judge::echo("http://judge.example:4505/echo").unwrap()];
        let p = http(
            Target {
                host: "127.0.0.1",
                port,
                auth: None,
            },
            &rungs,
            cx("n"),
        )
        .await;
        let f = p.failure.unwrap();
        assert_eq!(f.kind, Failure::AuthRequired);
        assert_eq!(f.status, Some(407));
        assert!(f.sentence().contains("407"));
        // The same proxy answers CONNECT with 407 too: the https transport
        // reports it at the handshake phase.
        let tls_rungs = [Judge::echo("https://judge.example/echo").unwrap()];
        let p = https(
            Target {
                host: "127.0.0.1",
                port,
                auth: None,
            },
            &tls_rungs,
            cx("n"),
        )
        .await;
        let f = p.failure.unwrap();
        assert_eq!((f.kind, f.phase), (Failure::AuthRequired, Phase::Handshake));
    }

    #[tokio::test]
    async fn a_socks5_greeting_to_an_http_server_is_a_transport_failure() {
        let port = fake_proxy("nope").await;
        let rungs = [Judge::echo("http://judge.example:4505/echo").unwrap()];
        let p = socks5(
            Target {
                host: "127.0.0.1",
                port,
                auth: None,
            },
            &rungs,
            cx("n"),
        )
        .await;
        assert!(!p.alive);
        let f = p.failure.unwrap();
        assert_eq!(f.phase, Phase::Handshake);
        // An HTTP server given a SOCKS greeting either hangs up (transport) or
        // waits for a request line that never comes (timeout). Both are the
        // handshake failing, which is the fact that matters.
        assert!(
            matches!(f.kind, Failure::Transport | Failure::Refused | Failure::Timeout),
            "{f:?}"
        );
    }

    #[tokio::test]
    async fn dead_target_reports_not_alive_within_the_budget() {
        // 192.0.2.1 is TEST-NET-1: guaranteed unroutable.
        let rungs = [Judge::echo("http://192.0.2.2:9/echo").unwrap()];
        let ctx = Context {
            nonce: "n",
            budget: Budget {
                connect: Duration::from_millis(700),
                total: Duration::from_secs(2),
            },
        };
        let started = Instant::now();
        let p = socks5(
            Target {
                host: "192.0.2.1",
                port: 8080,
                auth: None,
            },
            &rungs,
            ctx,
        )
        .await;
        assert!(!p.alive);
        assert!(started.elapsed() < Duration::from_secs(4));
    }
}
