//! Does a SOCKS5 proxy actually RELAY UDP?
//!
//! Open the SOCKS5 control connection, request UDP ASSOCIATE, then send a real
//! DNS query through the relay the proxy hands back and require a DNS ANSWER in
//! return. A granted association with no working relay counts as no: some
//! suppliers "fake yes" on ASSOCIATE (measured 2026-08-25), and the honest
//! answer to "can you carry my UDP" is whether a datagram came back, not
//! whether the proxy said yes.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// The whole exchange is bounded by `total`, so a silent relay cannot pin a
/// worker. `connect` bounds the control connection alone.
pub async fn relays_udp(
    host: &str,
    port: u16,
    auth: Option<&(String, String)>,
    connect: Duration,
    total: Duration,
) -> bool {
    matches!(
        tokio::time::timeout(total, inner(host, port, auth, connect, total)).await,
        Ok(Ok(true))
    )
}

async fn inner(
    host: &str,
    port: u16,
    auth: Option<&(String, String)>,
    connect: Duration,
    total: Duration,
) -> std::io::Result<bool> {
    let ctrl_addr = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut ctrl = match tokio::time::timeout(connect, tokio::net::TcpStream::connect(ctrl_addr.as_str())).await {
        Ok(Ok(s)) => s,
        _ => return Ok(false),
    };
    let proxy_ip: Option<IpAddr> = host.parse().ok().or_else(|| ctrl.peer_addr().ok().map(|p| p.ip()));

    // Greeting: offer no-auth, plus user/pass when the line carries a login.
    if auth.is_some() {
        ctrl.write_all(&[0x05, 0x02, 0x00, 0x02]).await?;
    } else {
        ctrl.write_all(&[0x05, 0x01, 0x00]).await?;
    }
    let mut method = [0u8; 2];
    ctrl.read_exact(&mut method).await?;
    if method[0] != 0x05 {
        return Ok(false);
    }
    match method[1] {
        0x00 => {}
        0x02 => {
            let Some((user, pass)) = auth else { return Ok(false) };
            let (ub, pb) = (user.as_bytes(), pass.as_bytes());
            if ub.len() > 255 || pb.len() > 255 {
                return Ok(false);
            }
            let mut req = Vec::with_capacity(3 + ub.len() + pb.len());
            req.push(0x01);
            req.push(ub.len() as u8);
            req.extend_from_slice(ub);
            req.push(pb.len() as u8);
            req.extend_from_slice(pb);
            ctrl.write_all(&req).await?;
            let mut ar = [0u8; 2];
            ctrl.read_exact(&mut ar).await?;
            if ar[1] != 0x00 {
                return Ok(false);
            }
        }
        _ => return Ok(false),
    }

    // UDP ASSOCIATE with DST 0.0.0.0:0 (no pre-committed client address).
    ctrl.write_all(&[0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    let mut head = [0u8; 4];
    ctrl.read_exact(&mut head).await?;
    if head[0] != 0x05 || head[1] != 0x00 {
        return Ok(false);
    }
    let relay_ip: IpAddr = match head[3] {
        0x01 => {
            let mut a = [0u8; 4];
            ctrl.read_exact(&mut a).await?;
            IpAddr::from(a)
        }
        0x04 => {
            let mut a = [0u8; 16];
            ctrl.read_exact(&mut a).await?;
            IpAddr::from(a)
        }
        0x03 => {
            let mut len = [0u8; 1];
            ctrl.read_exact(&mut len).await?;
            let mut d = vec![0u8; len[0] as usize];
            ctrl.read_exact(&mut d).await?;
            // A domain BND is unusual for ASSOCIATE; fall back to the proxy.
            match proxy_ip {
                Some(a) => a,
                None => return Ok(false),
            }
        }
        _ => return Ok(false),
    };
    let mut portb = [0u8; 2];
    ctrl.read_exact(&mut portb).await?;
    let relay_port = u16::from_be_bytes(portb);
    if relay_port == 0 {
        return Ok(false);
    }

    // A relay of 0.0.0.0 / :: means "same host as this control connection".
    let relay_ip = if relay_ip.is_unspecified() {
        match proxy_ip {
            Some(a) => a,
            None => return Ok(false),
        }
    } else {
        relay_ip
    };
    if !relay_is_plausible(relay_ip, proxy_ip) {
        return Ok(false);
    }
    let relay = SocketAddr::new(relay_ip, relay_port);

    // A real DNS query for dns.google THROUGH the relay, wrapped in the SOCKS5
    // UDP header (RSV RSV FRAG ATYP DST.ADDR DST.PORT DATA).
    let bind_any = if relay_ip.is_ipv6() { "[::]:0" } else { "0.0.0.0:0" };
    let udp = tokio::net::UdpSocket::bind(bind_any).await?;
    udp.connect(relay).await?;
    let mut dgram: Vec<u8> = vec![0x00, 0x00, 0x00, 0x01, 8, 8, 8, 8, 0x00, 0x35];
    dgram.extend_from_slice(&dns_query_a_record());
    udp.send(&dgram).await?;

    // Require a DNS answer back. The control connection stays open until here:
    // closing it tears the association down.
    let mut buf = [0u8; 1500];
    let got = match tokio::time::timeout(total, udp.recv(&mut buf)).await {
        Ok(Ok(n)) => dns_reply_has_answer(&buf[..n]),
        _ => false,
    };
    drop(ctrl);
    Ok(got)
}

/// The relay the proxy named must be somewhere a datagram can honestly go: the
/// proxy itself, a public address, or a private address only when the proxy
/// itself is on that private network (a LAN proxy is a real thing on a desktop).
/// Loopback, multicast and the unspecified address are never a relay.
fn relay_is_plausible(relay: IpAddr, proxy: Option<IpAddr>) -> bool {
    if relay.is_loopback() || relay.is_multicast() || relay.is_unspecified() {
        return false;
    }
    if crate::echo::is_public(relay) {
        return true;
    }
    match (relay, proxy) {
        (IpAddr::V4(r), Some(IpAddr::V4(p))) => r == p || (r.is_private() && p.is_private()),
        (IpAddr::V6(r), Some(IpAddr::V6(p))) => r == p || (!crate::echo::is_public(IpAddr::V6(p))),
        _ => false,
    }
}

/// A minimal DNS A-record query for `dns.google`, txid 0x1234, recursion desired.
fn dns_query_a_record() -> Vec<u8> {
    let mut q = vec![0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    for label in ["dns", "google"] {
        q.push(label.len() as u8);
        q.extend_from_slice(label.as_bytes());
    }
    q.push(0x00);
    q.extend_from_slice(&[0x00, 0x01, 0x00, 0x01]);
    q
}

/// True if `payload` (a datagram from a SOCKS5 UDP relay) carries a DNS RESPONSE
/// to our query: our txid, the QR bit set, at least one answer.
fn dns_reply_has_answer(payload: &[u8]) -> bool {
    if payload.len() < 4 {
        return false;
    }
    let addr_len = match payload[3] {
        0x01 => 4,
        0x04 => 16,
        0x03 => match payload.get(4) {
            Some(&n) => n as usize + 1,
            None => return false,
        },
        _ => return false,
    };
    let dns = match payload.get(4 + addr_len + 2..) {
        Some(d) if d.len() >= 12 => d,
        _ => return false,
    };
    let id_ok = dns[0] == 0x12 && dns[1] == 0x34;
    let is_response = dns[2] & 0x80 != 0;
    let ancount = u16::from_be_bytes([dns[6], dns[7]]);
    id_ok && is_response && ancount >= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_query_is_a_well_formed_a_record_for_dns_google() {
        let q = dns_query_a_record();
        assert_eq!(&q[0..2], &[0x12, 0x34]);
        assert_eq!(&q[4..6], &[0x00, 0x01]);
        assert_eq!(q[12], 3);
        assert_eq!(&q[13..16], b"dns");
        assert_eq!(q[16], 6);
        assert_eq!(&q[17..23], b"google");
        assert_eq!(q[23], 0);
        assert_eq!(&q[24..28], &[0x00, 0x01, 0x00, 0x01]);
    }

    fn encap_reply(txid: [u8; 2], qr: bool, ancount: u16) -> Vec<u8> {
        let mut p = vec![0x00, 0x00, 0x00, 0x01, 8, 8, 8, 8, 0x00, 0x35];
        p.extend_from_slice(&txid);
        p.push(if qr { 0x81 } else { 0x01 });
        p.push(0x80);
        p.extend_from_slice(&[0x00, 0x01]);
        p.extend_from_slice(&ancount.to_be_bytes());
        p.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]);
        p
    }

    /// The line between "really carries UDP" and a supplier that grants the
    /// association but never relays the packet.
    #[test]
    fn dns_reply_accepts_a_real_answer_and_rejects_everything_else() {
        assert!(dns_reply_has_answer(&encap_reply([0x12, 0x34], true, 1)));
        assert!(dns_reply_has_answer(&encap_reply([0x12, 0x34], true, 3)));
        assert!(!dns_reply_has_answer(&encap_reply([0x12, 0x34], true, 0)));
        assert!(!dns_reply_has_answer(&encap_reply([0x12, 0x34], false, 1)));
        assert!(!dns_reply_has_answer(&encap_reply([0xAB, 0xCD], true, 1)));
        assert!(!dns_reply_has_answer(&[0x00, 0x00, 0x00]));
        assert!(!dns_reply_has_answer(&[]));
    }

    #[test]
    fn relay_plausibility() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(relay_is_plausible(ip("203.0.113.9"), Some(ip("203.0.113.9"))));
        assert!(relay_is_plausible(ip("8.8.8.8"), Some(ip("203.0.113.9"))));
        assert!(
            relay_is_plausible(ip("192.168.1.5"), Some(ip("192.168.1.5"))),
            "a LAN proxy relaying on itself"
        );
        assert!(
            relay_is_plausible(ip("192.168.1.9"), Some(ip("192.168.1.5"))),
            "a LAN proxy relaying on its LAN"
        );
        assert!(
            !relay_is_plausible(ip("192.168.1.9"), Some(ip("203.0.113.9"))),
            "a public proxy naming a private relay is lying"
        );
        assert!(!relay_is_plausible(ip("127.0.0.1"), Some(ip("127.0.0.1"))));
        assert!(!relay_is_plausible(ip("224.0.0.1"), Some(ip("203.0.113.9"))));
    }

    #[tokio::test]
    async fn a_dead_port_is_not_a_udp_relay_and_returns_within_budget() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let started = std::time::Instant::now();
        assert!(!relays_udp("127.0.0.1", port, None, Duration::from_secs(1), Duration::from_secs(2)).await);
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
