//! Which addresses the VPN takes: the whole internet, minus the networks that
//! are not the internet (the home network, the phone itself, multicast).
//!
//! Android 13 can leave a range out of a VPN, but older phones only know "add
//! this route". So the ranges are written the old way that every Android
//! understands: the whole address space cut around the ranges left out.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// An address and how many of its leading bits are the network.
pub type Route = (IpAddr, u8);

/// IPv4 ranges that stay outside the VPN. They are never routed on the
/// internet, so a proxy could not reach them anyway, and the printer, the TV
/// and the router keep working while connected.
const V4_LEFT_OUT: &[(Ipv4Addr, u8)] = &[
    (Ipv4Addr::new(0, 0, 0, 0), 8),      // "this network"
    (Ipv4Addr::new(10, 0, 0, 0), 8),     // home and office networks
    (Ipv4Addr::new(100, 64, 0, 0), 10),  // the mobile carrier's own network
    (Ipv4Addr::new(127, 0, 0, 0), 8),    // this phone
    (Ipv4Addr::new(169, 254, 0, 0), 16), // a network with no router
    (Ipv4Addr::new(172, 16, 0, 0), 12),  // home and office networks
    (Ipv4Addr::new(192, 168, 0, 0), 16), // home networks
    (Ipv4Addr::new(224, 0, 0, 0), 4),    // multicast
    (Ipv4Addr::new(240, 0, 0, 0), 4),    // reserved, and the broadcast address
];

/// The IPv6 internet is one block, every public address there is: the phone
/// itself, private networks and multicast all lie outside it. Plus the block a
/// mobile carrier uses to reach IPv4 sites from an IPv6-only network.
const V6_TAKEN: &[(Ipv6Addr, u8)] = &[
    (Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0), 3),
    (Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96),
];

/// Every route the VPN adds: IPv4 and IPv6. IPv6 is taken too, because an
/// address family the VPN does not take goes out the normal way, with the
/// phone's real address.
pub fn vpn_routes() -> Vec<Route> {
    let v4_out: Vec<(u128, u8)> = V4_LEFT_OUT
        .iter()
        .map(|(a, len)| (u32::from(*a) as u128, *len))
        .collect();
    let v4 = cut(0, 0, 32, &v4_out)
        .into_iter()
        .map(|(a, len)| (IpAddr::V4(Ipv4Addr::from(a as u32)), len));
    let v6 = V6_TAKEN.iter().map(|(a, len)| (IpAddr::V6(*a), *len));
    v4.chain(v6).collect()
}

/// The block `addr/len` of a `bits`-wide space, minus the blocks in `out`, as
/// the fewest whole blocks: a block that misses every left-out range is kept,
/// one inside a left-out range is dropped, and one that overlaps is halved.
fn cut(addr: u128, len: u8, bits: u8, out: &[(u128, u8)]) -> Vec<(u128, u8)> {
    let inside = |a: u128, l: u8, net: u128, nl: u8| nl <= l && prefix(a, nl, bits) == prefix(net, nl, bits);
    if out.iter().any(|&(net, nl)| inside(addr, len, net, nl)) {
        return Vec::new();
    }
    if !out.iter().any(|&(net, nl)| inside(net, nl, addr, len)) {
        return vec![(addr, len)];
    }
    let half = 1u128 << (bits - len - 1);
    let mut both = cut(addr, len + 1, bits, out);
    both.extend(cut(addr | half, len + 1, bits, out));
    both
}

/// The first `len` bits of `addr` in a `bits`-wide space, the rest zero.
fn prefix(addr: u128, len: u8, bits: u8) -> u128 {
    if len == 0 {
        return 0;
    }
    let keep = if len >= 128 { u128::MAX } else { !(u128::MAX >> len) };
    (addr << (128 - bits as u32)) & keep
}

#[cfg(test)]
mod tests {
    use super::*;

    fn covered(routes: &[Route], ip: IpAddr) -> bool {
        routes.iter().any(|&(net, len)| match (net, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                prefix(u32::from(n) as u128, len, 32) == prefix(u32::from(a) as u128, len, 32)
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => prefix(u128::from(n), len, 128) == prefix(u128::from(a), len, 128),
            _ => false,
        })
    }

    #[test]
    fn the_internet_goes_through_the_vpn() {
        let routes = vpn_routes();
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "142.250.185.78",
            "198.18.0.2",
            "198.19.255.254",
            "223.255.255.1",
            "2001:4860:4860::8888",
            "2606:4700::1111",
            "64:ff9b::808:808",
        ] {
            assert!(covered(&routes, ip.parse().unwrap()), "{ip} must go through the VPN");
        }
    }

    #[test]
    fn the_home_network_and_the_phone_stay_outside() {
        let routes = vpn_routes();
        for ip in [
            "192.168.1.1",
            "10.0.0.5",
            "172.16.4.4",
            "172.31.255.255",
            "127.0.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.251",
            "255.255.255.255",
            "fe80::1",
            "fd12::1",
            "ff02::fb",
            "::1",
        ] {
            assert!(!covered(&routes, ip.parse().unwrap()), "{ip} must stay outside the VPN");
        }
    }

    #[test]
    fn the_edges_of_a_left_out_range_are_exact() {
        let routes = vpn_routes();
        assert!(covered(&routes, "172.15.255.255".parse().unwrap()));
        assert!(!covered(&routes, "172.16.0.0".parse().unwrap()));
        assert!(covered(&routes, "172.32.0.0".parse().unwrap()));
        assert!(covered(&routes, "11.0.0.0".parse().unwrap()));
        assert!(covered(&routes, "9.255.255.255".parse().unwrap()));
    }

    #[test]
    fn the_list_stays_short_enough_for_any_phone() {
        // Every route is one call into Android; a few dozen is what VPN apps add.
        let routes = vpn_routes();
        assert!(routes.len() < 64, "{} routes", routes.len());
        // No two routes overlap: each address is taken once.
        for (i, a) in routes.iter().enumerate() {
            for b in &routes[i + 1..] {
                assert!(!(covered(&[*a], b.0) || covered(&[*b], a.0)), "{a:?} and {b:?} overlap");
            }
        }
    }
}
