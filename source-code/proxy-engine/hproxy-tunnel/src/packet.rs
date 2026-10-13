//! The few things the tunnel reads in a packet before the TCP/IP stack sees
//! it, and the one kind of packet it writes itself: a UDP answer (DNS).

use std::net::{IpAddr, SocketAddr};

use smoltcp::phy::ChecksumCapabilities;
use smoltcp::wire::{IpAddress, IpProtocol, Ipv4Packet, Ipv4Repr, Ipv6Packet, Ipv6Repr, TcpPacket, UdpPacket, UdpRepr};

/// What a packet from the phone is.
#[derive(Debug, PartialEq, Eq)]
pub enum Seen<'a> {
    /// TCP; `opens` when it is the first packet of a new connection (SYN, no ACK).
    Tcp {
        from: SocketAddr,
        to: SocketAddr,
        opens: bool,
    },
    /// UDP, with what it carries.
    Udp {
        from: SocketAddr,
        to: SocketAddr,
        payload: &'a [u8],
    },
    /// Anything else (ping, fragments, other protocols): not carried.
    Other,
}

pub fn read(packet: &[u8]) -> Seen<'_> {
    let (from, to, protocol, body) = match packet.first().map(|b| b >> 4) {
        Some(4) => {
            let Ok(p) = Ipv4Packet::new_checked(packet) else {
                return Seen::Other;
            };
            // A piece of a bigger packet: phones send TCP whole, and a DNS question fits one.
            if p.more_frags() || p.frag_offset() != 0 {
                return Seen::Other;
            }
            let body = &packet[p.header_len() as usize..p.total_len() as usize];
            (
                IpAddr::V4(p.src_addr()),
                IpAddr::V4(p.dst_addr()),
                p.next_header(),
                body,
            )
        }
        Some(6) => {
            let Ok(p) = Ipv6Packet::new_checked(packet) else {
                return Seen::Other;
            };
            let start = 40;
            let body = &packet[start..start + p.payload_len() as usize];
            (
                IpAddr::V6(p.src_addr()),
                IpAddr::V6(p.dst_addr()),
                p.next_header(),
                body,
            )
        }
        _ => return Seen::Other,
    };
    match protocol {
        IpProtocol::Tcp => {
            let Ok(t) = TcpPacket::new_checked(body) else {
                return Seen::Other;
            };
            Seen::Tcp {
                from: SocketAddr::new(from, t.src_port()),
                to: SocketAddr::new(to, t.dst_port()),
                opens: t.syn() && !t.ack(),
            }
        }
        IpProtocol::Udp => {
            let Ok(u) = UdpPacket::new_checked(body) else {
                return Seen::Other;
            };
            Seen::Udp {
                from: SocketAddr::new(from, u.src_port()),
                to: SocketAddr::new(to, u.dst_port()),
                payload: u.payload(),
            }
        }
        _ => Seen::Other,
    }
}

/// A UDP packet from `from` to `to` carrying `payload`, checksums filled in.
/// `None` when the two addresses are not the same family.
pub fn udp(from: SocketAddr, to: SocketAddr, payload: &[u8]) -> Option<Vec<u8>> {
    let caps = ChecksumCapabilities::default();
    let udp = UdpRepr {
        src_port: from.port(),
        dst_port: to.port(),
    };
    let udp_len = 8 + payload.len();
    let (mut buf, header) = match (from.ip(), to.ip()) {
        (IpAddr::V4(src), IpAddr::V4(dst)) => {
            let ip = Ipv4Repr {
                src_addr: src,
                dst_addr: dst,
                next_header: IpProtocol::Udp,
                payload_len: udp_len,
                hop_limit: 64,
            };
            let mut buf = vec![0u8; ip.buffer_len() + udp_len];
            ip.emit(&mut Ipv4Packet::new_unchecked(&mut buf), &caps);
            (buf, ip.buffer_len())
        }
        (IpAddr::V6(src), IpAddr::V6(dst)) => {
            let ip = Ipv6Repr {
                src_addr: src,
                dst_addr: dst,
                next_header: IpProtocol::Udp,
                payload_len: udp_len,
                hop_limit: 64,
            };
            let mut buf = vec![0u8; ip.buffer_len() + udp_len];
            ip.emit(&mut Ipv6Packet::new_unchecked(&mut buf));
            (buf, ip.buffer_len())
        }
        _ => return None,
    };
    udp.emit(
        &mut UdpPacket::new_unchecked(&mut buf[header..]),
        &IpAddress::from(from.ip()),
        &IpAddress::from(to.ip()),
        payload.len(),
        |b| b.copy_from_slice(payload),
        &caps,
    );
    Some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_udp_packet_written_here_reads_back_the_same() {
        for (from, to) in [
            ("198.18.0.2:53", "10.0.0.2:40000"),
            ("[2001:db8::53]:53", "[fd00::2]:40000"),
        ] {
            let (from, to): (SocketAddr, SocketAddr) = (from.parse().unwrap(), to.parse().unwrap());
            let p = udp(from, to, b"hello").unwrap();
            assert_eq!(
                read(&p),
                Seen::Udp {
                    from,
                    to,
                    payload: b"hello"
                }
            );
        }
    }

    #[test]
    fn the_checksums_are_right() {
        let from: SocketAddr = "198.18.0.2:53".parse().unwrap();
        let to: SocketAddr = "10.0.0.2:40000".parse().unwrap();
        let p = udp(from, to, b"an answer").unwrap();
        let ip = Ipv4Packet::new_checked(&p[..]).unwrap();
        assert!(ip.verify_checksum());
        let u = UdpPacket::new_checked(ip.payload()).unwrap();
        assert!(u.verify_checksum(&IpAddress::from(from.ip()), &IpAddress::from(to.ip())));
    }

    #[test]
    fn mixed_families_are_refused() {
        assert!(udp("1.2.3.4:53".parse().unwrap(), "[::1]:5".parse().unwrap(), b"").is_none());
    }

    #[test]
    fn garbage_is_other() {
        assert_eq!(read(&[]), Seen::Other);
        assert_eq!(read(&[0x45, 0, 0]), Seen::Other);
        assert_eq!(read(&[0x00; 40]), Seen::Other);
    }
}
