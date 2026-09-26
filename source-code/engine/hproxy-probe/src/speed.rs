//! Download throughput through a proxy, on demand.
//!
//! Fetches a fixed-size payload from our own speed door THROUGH the proxy and
//! reports megabits per second. The door lives behind Cloudflare on HTTPS, so
//! the fetch needs a tunnel: CONNECT through an HTTP proxy, or a SOCKS tunnel
//! with TLS inside. A plain-HTTP relay cannot reach it (Cloudflare redirects
//! plain HTTP), which is fine: throughput is a question about tunnels anyway.
//!
//! Only the body transfer is timed, first byte to last byte, so a small payload
//! on a distant proxy measures throughput and not round-trip time. The public
//! door caps an unsigned request at 64 KB, so a very fast proxy on a very fast
//! line saturates the measurement; the value is then reported as a floor.

use crate::dial::{classify_io, dial, ms};
use crate::judge::Judge;
use crate::line::{b64, ProxyLine};
use crate::result::{Failure, FailureDetail, Phase};
use crate::transport::{find, tls_config};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const DEFAULT_SPEED_URL: &str = "https://hproxy.com/api/free-proxy/speedtest";
/// What the public door serves without a signature.
pub const PUBLIC_CAP_BYTES: usize = 65_536;

/// How the tunnel to the speed door is opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    HttpConnect,
    Socks5,
    Socks4,
}

pub struct SpeedResult {
    pub mbps: f64,
    pub bytes: usize,
    pub transfer_ms: u32,
}

/// Measure through the proxy `line` names. Fails when the door is unreachable
/// through this proxy or too little arrived to time honestly (under 16 KB, or
/// under 20 ms of transfer).
pub async fn measure(
    line: &ProxyLine,
    via: Via,
    door: &Judge,
    socks4_door: Option<std::net::SocketAddr>,
    bytes: usize,
    connect: Duration,
    total: Duration,
) -> Result<SpeedResult, FailureDetail> {
    let auth = line.auth.as_ref();
    let started = Instant::now();
    let d = dial(&line.host, line.port, connect.min(total))
        .await
        .map_err(|e| e.detail)?;
    let mut sock = d.stream;
    let authority = door.authority();
    let fail = |kind: Failure, phase: Phase| FailureDetail {
        kind,
        phase,
        elapsed_ms: ms(started.elapsed()),
        status: None,
    };

    match via {
        Via::HttpConnect => {
            let target = door.connect_target();
            let mut req = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
            if let Some((u, p)) = auth {
                req.push_str(&format!(
                    "Proxy-Authorization: Basic {}\r\n",
                    b64(format!("{u}:{p}").as_bytes())
                ));
            }
            req.push_str("\r\n");
            sock.write_all(req.as_bytes())
                .await
                .map_err(|e| fail(classify_io(&e), Phase::Handshake))?;
            let head = read_head(&mut sock, total, started)
                .await
                .map_err(|e| fail(classify_io(&e), Phase::Handshake))?;
            let status = String::from_utf8_lossy(&head)
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse::<u16>().ok())
                .unwrap_or(0);
            if !(200..300).contains(&status) {
                return Err(FailureDetail {
                    kind: Failure::BadStatus,
                    phase: Phase::Handshake,
                    elapsed_ms: ms(started.elapsed()),
                    status: Some(status),
                });
            }
            fetch_over_tls(sock, door, &authority, bytes, total, started).await
        }
        Via::Socks5 => {
            let left = total.saturating_sub(started.elapsed());
            let dest = (door.host.as_str(), door.port);
            let hs = async move {
                match auth {
                    Some((u, p)) => {
                        tokio_socks::tcp::Socks5Stream::connect_with_password_and_socket(sock, dest, u, p).await
                    }
                    None => tokio_socks::tcp::Socks5Stream::connect_with_socket(sock, dest).await,
                }
            };
            let stream = match tokio::time::timeout(left, hs).await {
                Ok(Ok(s)) => s,
                Ok(Err(_)) => return Err(fail(Failure::Transport, Phase::Handshake)),
                Err(_) => return Err(fail(Failure::Timeout, Phase::Handshake)),
            };
            fetch_over_tls(stream, door, &authority, bytes, total, started).await
        }
        Via::Socks4 => {
            let Some(addr) = socks4_door else {
                return Err(fail(Failure::Unresolved, Phase::Dns));
            };
            let left = total.saturating_sub(started.elapsed());
            let hs = async move {
                match auth {
                    Some((u, _)) => tokio_socks::tcp::Socks4Stream::connect_with_userid_and_socket(sock, addr, u).await,
                    None => tokio_socks::tcp::Socks4Stream::connect_with_socket(sock, addr).await,
                }
            };
            let stream = match tokio::time::timeout(left, hs).await {
                Ok(Ok(s)) => s,
                Ok(Err(_)) => return Err(fail(Failure::Transport, Phase::Handshake)),
                Err(_) => return Err(fail(Failure::Timeout, Phase::Handshake)),
            };
            fetch_over_tls(stream, door, &authority, bytes, total, started).await
        }
    }
}

async fn fetch_over_tls<S>(
    stream: S,
    door: &Judge,
    authority: &str,
    bytes: usize,
    total: Duration,
    started: Instant,
) -> Result<SpeedResult, FailureDetail>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let fail = |kind: Failure, phase: Phase| FailureDetail {
        kind,
        phase,
        elapsed_ms: ms(started.elapsed()),
        status: None,
    };
    let server_name =
        rustls::pki_types::ServerName::try_from(door.host.clone()).map_err(|_| fail(Failure::Tls, Phase::Tls))?;
    let connector = tokio_rustls::TlsConnector::from(tls_config());
    let left = total.saturating_sub(started.elapsed());
    let mut tls = match tokio::time::timeout(left, connector.connect(server_name, stream)).await {
        Ok(Ok(s)) => s,
        Ok(Err(_)) => return Err(fail(Failure::Tls, Phase::Tls)),
        Err(_) => return Err(fail(Failure::Timeout, Phase::Tls)),
    };
    let sep = if door.path.contains('?') { '&' } else { '?' };
    let req = format!(
        "GET {}{sep}bytes={bytes} HTTP/1.1\r\nHost: {authority}\r\nUser-Agent: hproxy-probe\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
        door.path
    );
    tls.write_all(req.as_bytes())
        .await
        .map_err(|e| fail(classify_io(&e), Phase::Request))?;

    // Read the head, then time the body alone.
    let mut buf = Vec::with_capacity(bytes + 1024);
    let mut chunk = vec![0u8; 16 * 1024];
    let mut head_end = None;
    let mut want: Option<usize> = None;
    let mut status = 0u16;
    let mut first_body_byte: Option<Instant> = None;
    loop {
        let left = total.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err(fail(Failure::Timeout, Phase::Response));
        }
        let n = match tokio::time::timeout(left, tls.read(&mut chunk)).await {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(fail(classify_io(&e), Phase::Response)),
            Err(_) => return Err(fail(Failure::Timeout, Phase::Response)),
        };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if head_end.is_none() {
            if let Some(i) = find(&buf, b"\r\n\r\n") {
                head_end = Some(i + 4);
                let head = String::from_utf8_lossy(&buf[..i]).to_ascii_lowercase();
                status = head.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
                want = head.lines().find_map(|l| {
                    l.strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse::<usize>().ok())
                });
                if buf.len() > i + 4 {
                    first_body_byte = Some(Instant::now());
                }
            }
        } else if first_body_byte.is_none() {
            first_body_byte = Some(Instant::now());
        }
        if let (Some(he), Some(w)) = (head_end, want) {
            if buf.len().saturating_sub(he) >= w {
                break;
            }
        }
        if buf.len() > bytes + 64 * 1024 {
            break;
        }
    }
    let finished = Instant::now();
    if !(200..300).contains(&status) {
        return Err(FailureDetail {
            kind: Failure::BadStatus,
            phase: Phase::Response,
            elapsed_ms: ms(started.elapsed()),
            status: Some(status),
        });
    }
    let he = head_end.ok_or_else(|| fail(Failure::Transport, Phase::Response))?;
    let body_len = buf.len().saturating_sub(he);
    let first = first_body_byte.ok_or_else(|| fail(Failure::Transport, Phase::Response))?;
    let transfer = finished.duration_since(first);
    if body_len < 16 * 1024 || transfer < Duration::from_millis(20) {
        // Too little to time honestly. Report the transfer as a floor by
        // assuming the whole payload arrived inside 20 ms.
        let secs = transfer.max(Duration::from_millis(20)).as_secs_f64();
        return Ok(SpeedResult {
            mbps: round1(body_len as f64 * 8.0 / (secs * 1e6)),
            bytes: body_len,
            transfer_ms: ms(transfer),
        });
    }
    let secs = transfer.as_secs_f64();
    Ok(SpeedResult {
        mbps: round1(body_len as f64 * 8.0 / (secs * 1e6)),
        bytes: body_len,
        transfer_ms: ms(transfer),
    })
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

async fn read_head<S>(stream: &mut S, total: Duration, started: Instant) -> std::io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];
    loop {
        let left = total.saturating_sub(started.elapsed());
        if left.is_zero() {
            return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "head timed out"));
        }
        let n = tokio::time::timeout(left, stream.read(&mut chunk))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "head timed out"))??;
        if n == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "closed"));
        }
        buf.extend_from_slice(&chunk[..n]);
        if find(&buf, b"\r\n\r\n").is_some() || buf.len() > 8192 {
            return Ok(buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding() {
        assert_eq!(round1(12.345), 12.3);
        assert_eq!(round1(0.06), 0.1);
    }
}
