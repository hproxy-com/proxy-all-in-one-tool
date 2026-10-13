//! Whose connection is this? The firewall decides by app, and the VPN hands
//! over packets, not apps. Android says which app owns a connection:
//!
//!   Android 10 and later   `ConnectivityManager.getConnectionOwnerUid`, which
//!                          only the app running the VPN may call: asked in
//!                          Kotlin (OwnerLookup.kt) through JNI (jni_glue.rs)
//!   Android 7 to 9         the kernel's own tables, /proc/net/tcp and udp
//!                          (and their IPv6 twins), readable by apps there
//!
//! Either way the answer is the app's user id (every app has its own), which
//! the firewall's table names (firewall.rs). No answer: nobody is blocked by
//! mistake, the connection takes the table's default.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub trait OwnerOf: Send + Sync {
    /// The user id of the app that owns the connection from `from` to `to`.
    fn owner(&self, udp: bool, from: SocketAddr, to: SocketAddr) -> Option<u32>;
}

/// Android 7 to 9: the kernel's tables.
pub struct ProcNet;

impl OwnerOf for ProcNet {
    fn owner(&self, udp: bool, from: SocketAddr, to: SocketAddr) -> Option<u32> {
        let files: &[&str] = if udp {
            &["/proc/net/udp", "/proc/net/udp6"]
        } else {
            &["/proc/net/tcp", "/proc/net/tcp6"]
        };
        files.iter().find_map(|f| {
            let text = std::fs::read_to_string(f).ok()?;
            find(&text, udp, from, to)
        })
    }
}

/// The owner of `from` → `to` in one of the kernel's tables. TCP must match
/// both ends; UDP the app's end, and the far end too when the socket names
/// one (a socket that sends anywhere names none).
pub fn find(table: &str, udp: bool, from: SocketAddr, to: SocketAddr) -> Option<u32> {
    let mut loose = None;
    for line in table.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 8 {
            continue;
        }
        let (Some(local), Some(remote)) = (address(f[1]), address(f[2])) else {
            continue;
        };
        let Ok(uid) = f[7].parse::<u32>() else { continue };
        if local.port() != from.port() || !same_or_any(local.ip(), from.ip()) {
            continue;
        }
        if remote.port() == to.port() && same(remote.ip(), to.ip()) {
            return Some(uid);
        }
        if udp && remote.port() == 0 && remote.ip().is_unspecified() {
            loose.get_or_insert(uid);
        }
    }
    loose
}

/// `0100007F:0035` (IPv4) or 32 hex digits and a port (IPv6), as the kernel
/// prints them: each 32-bit word in the machine's own byte order, which is
/// little-endian on every Android phone.
fn address(field: &str) -> Option<SocketAddr> {
    let (ip, port) = field.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let ip = match ip.len() {
        8 => IpAddr::V4(Ipv4Addr::from(u32::from_str_radix(ip, 16).ok()?.to_le_bytes())),
        32 => {
            let mut bytes = [0u8; 16];
            for (i, chunk) in bytes.chunks_mut(4).enumerate() {
                let word = u32::from_str_radix(&ip[i * 8..i * 8 + 8], 16).ok()?;
                chunk.copy_from_slice(&word.to_le_bytes());
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// The same address, an IPv4 one written the IPv6 way included.
fn same(a: IpAddr, b: IpAddr) -> bool {
    plain(a) == plain(b)
}

fn same_or_any(table: IpAddr, packet: IpAddr) -> bool {
    table.is_unspecified() || same(table, packet)
}

fn plain(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:13AD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22301 1 0000000000000000 100 0 0 10 0
   1: 010012C6:CC5C 030012C6:01BB 02 00000000:00000000 01:00000400 00000000 10123        0 0 2 0000000000000000 100 0 0 10 0
   2: 010012C6:CC5D 5DB8D85D:0050 01 00000000:00000000 00:00000000 00000000 10200        0 1 1 0000000000000000 100 0 0 10 0
";

    const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF0000010012C6:CC60 0000000000000000FFFF0000030012C6:01BB 02 00000000:00000000 00:00000000 00000000 10333        0 3 1 0000000000000000 100 0 0 10 0
   1: 0000FDFE0000706800000000_BROKEN:0001 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 1        0 4
";

    #[test]
    fn a_connection_is_found_by_both_of_its_ends() {
        // 198.18.0.1:52316 → 198.18.0.3:443, the second line.
        let from: SocketAddr = "198.18.0.1:52316".parse().unwrap();
        let to: SocketAddr = "198.18.0.3:443".parse().unwrap();
        assert_eq!(find(TCP, false, from, to), Some(10123));
        let elsewhere: SocketAddr = "198.18.0.4:443".parse().unwrap();
        assert_eq!(find(TCP, false, from, elsewhere), None, "the far end must match too");
        let site: SocketAddr = "93.216.184.93:80".parse().unwrap();
        assert_eq!(find(TCP, false, "198.18.0.1:52317".parse().unwrap(), site), Some(10200));
    }

    #[test]
    fn an_ipv4_connection_on_an_ipv6_socket_is_found_too() {
        let from: SocketAddr = "198.18.0.1:52320".parse().unwrap();
        let to: SocketAddr = "198.18.0.3:443".parse().unwrap();
        assert_eq!(find(TCP6, false, from, to), Some(10333));
    }

    #[test]
    fn a_udp_socket_that_names_no_far_end_is_found_by_its_own() {
        let table = "  sl  local_address rem_address   st
   7: 010012C6:A410 00000000:0000 07 00000000:00000000 00:00000000 00000000 10456        0 9 2 0
";
        let from: SocketAddr = "198.18.0.1:42000".parse().unwrap();
        assert_eq!(find(table, true, from, "8.8.8.8:443".parse().unwrap()), Some(10456));
        assert_eq!(
            find(table, false, from, "8.8.8.8:443".parse().unwrap()),
            None,
            "TCP is matched by both ends"
        );
    }

    #[test]
    fn the_kernel_s_way_of_writing_addresses_reads_back() {
        assert_eq!(address("0100007F:0035"), Some("127.0.0.1:53".parse().unwrap()));
        assert_eq!(address("010012C6:01BB"), Some("198.18.0.1:443".parse().unwrap()));
        assert_eq!(
            address("0000000000000000FFFF0000010012C6:0050"),
            Some("[::ffff:198.18.0.1]:80".parse().unwrap())
        );
        assert_eq!(address("nonsense"), None);
    }
}
