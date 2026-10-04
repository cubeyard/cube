//! Upstream address check. Enforced after resolution and independent of the
//! policy decision, so a guest can never reach cubed, the runner's or
//! gateway's networks, the gateway host itself, or a metadata service
//! through the gateway.
use std::{
    collections::HashSet,
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

/// True when `ip` may be dialled upstream: globally routable unicast and not
/// assigned to one of the gateway host's own interfaces. A connection to the
/// host's own public address would travel over loopback and bypass perimeter
/// firewalls that protect services on the host.
pub fn is_upstream(ip: IpAddr, local: &HashSet<IpAddr>) -> bool {
    is_public(ip) && !local.contains(&canonical(ip))
}

/// Every address currently assigned to one of this host's interfaces.
/// Read fresh on every call, so address changes need no refresh logic.
pub fn local_addresses() -> io::Result<HashSet<IpAddr>> {
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list` on success; it is freed below.
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let mut out = HashSet::new();
    let mut cursor = list;
    while !cursor.is_null() {
        // SAFETY: `cursor` walks the list getifaddrs returned and is valid
        // until freeifaddrs; ifa_addr is either null or a sockaddr whose
        // sa_family tells its concrete type.
        unsafe {
            let entry = &*cursor;
            let address = entry.ifa_addr;
            if !address.is_null() {
                match i32::from((*address).sa_family) {
                    libc::AF_INET => {
                        let v4 = &*(address as *const libc::sockaddr_in);
                        out.insert(IpAddr::V4(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr))));
                    }
                    libc::AF_INET6 => {
                        let v6 = &*(address as *const libc::sockaddr_in6);
                        out.insert(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            cursor = entry.ifa_next;
        }
    }
    // SAFETY: `list` came from a successful getifaddrs.
    unsafe { libc::freeifaddrs(list) };
    Ok(out)
}

/// IPv4-mapped IPv6 addresses compare as their IPv4 address.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        IpAddr::V4(_) => ip,
    }
}

/// True only for globally routable unicast addresses.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => public_v4(v4),
        IpAddr::V6(v6) => public_v6(v6),
    }
}

fn in_v4(ip: Ipv4Addr, net: [u8; 4], prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(net)) & mask
}

fn public_v4(ip: Ipv4Addr) -> bool {
    const BLOCKED: [([u8; 4], u32); 16] = [
        ([0, 0, 0, 0], 8),       // "this network"
        ([10, 0, 0, 0], 8),      // RFC 1918
        ([100, 64, 0, 0], 10),   // CGNAT
        ([127, 0, 0, 0], 8),     // loopback
        ([169, 254, 0, 0], 16),  // link-local, cloud metadata
        ([172, 16, 0, 0], 12),   // RFC 1918
        ([192, 0, 0, 0], 24),    // IETF protocol assignments
        ([192, 0, 2, 0], 24),    // TEST-NET-1
        ([192, 88, 99, 0], 24),  // 6to4 relay anycast
        ([192, 168, 0, 0], 16),  // RFC 1918
        ([198, 18, 0, 0], 15),   // benchmarking
        ([198, 51, 100, 0], 24), // TEST-NET-2
        ([203, 0, 113, 0], 24),  // TEST-NET-3
        ([224, 0, 0, 0], 4),     // multicast
        ([240, 0, 0, 0], 4),     // reserved, broadcast
        ([255, 255, 255, 255], 32),
    ];
    !BLOCKED.iter().any(|(net, prefix)| in_v4(ip, *net, *prefix))
}

fn public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // Only global unicast 2000::/3 is considered at all.
    if s[0] & 0xe000 != 0x2000 {
        return false;
    }
    let blocked = [
        // 2001::/32 Teredo (embeds IPv4) and 2001:db8::/32 documentation.
        s[0] == 0x2001 && (s[1] == 0 || s[1] == 0x0db8),
        // 2001:10::/28 ORCHID, 2001:20::/28 ORCHIDv2.
        s[0] == 0x2001 && (s[1] & 0xfff0 == 0x0010 || s[1] & 0xfff0 == 0x0020),
        // 2002::/16 6to4 (embeds IPv4).
        s[0] == 0x2002,
        // 3fff::/20 documentation.
        s[0] == 0x3fff && s[1] & 0xf000 == 0,
    ];
    // ::ffff:0:0/96 (IPv4-mapped), ::/96, 64:ff9b::/96 (NAT64), fc00::/7,
    // fe80::/10, ff00::/8 and loopback all fall outside 2000::/3 above.
    !blocked.iter().any(|b| *b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_addresses_include_loopback() {
        let local = local_addresses().unwrap();
        assert!(local.contains(&ip("127.0.0.1")), "{local:?}");
    }

    #[test]
    fn the_hosts_own_addresses_are_never_upstream() {
        // A public address that is assigned to this host is refused, the
        // same address elsewhere is allowed.
        let own = ip("95.216.32.156");
        let local: HashSet<IpAddr> = [ip("127.0.0.1"), own, ip("2a01:4f9:2a:20de::2")].into();
        assert!(is_public(own));
        assert!(!is_upstream(own, &local));
        assert!(!is_upstream(ip("2a01:4f9:2a:20de::2"), &local));
        assert!(is_upstream(own, &HashSet::new()));
        assert!(is_upstream(ip("1.1.1.1"), &local));
        // Every address this machine really has is refused.
        for address in local_addresses().unwrap() {
            assert!(
                !is_upstream(address, &local_addresses().unwrap()),
                "{address}"
            );
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn private_and_special_v4_are_refused() {
        for s in [
            "0.0.0.0",
            "0.1.2.3",
            "10.0.0.1",
            "10.77.0.1",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "127.1.2.3",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.8",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.7",
            "203.0.113.1",
            "224.0.0.1",
            "239.255.255.250",
            "240.0.0.1",
            "255.255.255.255",
        ] {
            assert!(!is_public(ip(s)), "{s} must not be public");
        }
    }

    #[test]
    fn public_v4_is_allowed() {
        for s in [
            "1.1.1.1",
            "8.8.8.8",
            "140.82.112.3",
            "172.32.0.1",
            "100.128.0.1",
            "93.184.215.14",
        ] {
            assert!(is_public(ip(s)), "{s} must be public");
        }
    }

    #[test]
    fn v6_forms_are_checked() {
        for s in [
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:8.8.8.8",
            "::127.0.0.1",
            "64:ff9b::a00:1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001::1",
            "2002:a00:1::1",
            "3fff::1",
        ] {
            assert!(!is_public(ip(s)), "{s} must not be public");
        }
        for s in ["2606:4700:4700::1111", "2a00:1450:4001:80b::200e"] {
            assert!(is_public(ip(s)), "{s} must be public");
        }
    }
}
