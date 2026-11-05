//! macOS Companion interface discovery. This reads the system interface list;
//! it does not modify network configuration or broaden the existing RFC 1918
//! bind policy. The list is refreshed again at the management start boundary.
use super::{normalize_lan_interfaces, validate_management_bind_address, GatewayError, LanIpv4Interface};
use std::net::Ipv4Addr;

const ADDRESS_OFFSET: usize = 4; // Darwin sockaddr_in::sin_addr
const IPV4_END: usize = ADDRESS_OFFSET + 4;

// Darwin stores sa_len before sa_family. IPv4 octets are already in network
// order; reading bytes directly avoids accidentally swapping native integers.
fn ipv4_address(bytes: &[u8]) -> Option<Ipv4Addr> {
    if bytes.len() < IPV4_END || bytes[0] < IPV4_END as u8 || bytes[1] != libc::AF_INET as u8 {
        return None;
    }
    Some(Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]))
}

// Routing messages on Darwin can omit trailing zero bytes from a netmask;
// getifaddrs preserves sa_len and may use AF_UNSPEC for the mask family. A
// zero-length netmask represents /0. Never read past the supplied length.
fn ipv4_netmask_prefix(bytes: &[u8]) -> Option<u8> {
    let len = usize::from(*bytes.first()?);
    if len == 0 { return Some(0); }
    if len < ADDRESS_OFFSET || bytes.len() < len.min(IPV4_END) { return None; }
    if bytes[1] != libc::AF_UNSPEC as u8 && bytes[1] != libc::AF_INET as u8 { return None; }
    let mut octets = [0u8; 4];
    for index in ADDRESS_OFFSET..len.min(IPV4_END) {
        octets[index - ADDRESS_OFFSET] = bytes[index];
    }
    let mask = u32::from_be_bytes(octets);
    let inverse = !mask;
    if inverse & inverse.wrapping_add(1) != 0 { return None; }
    Some(mask.leading_ones() as u8)
}

fn candidate(name: &str, flags: u32, address: &[u8], netmask: &[u8]) -> Option<(String, Ipv4Addr, u8, bool)> {
    // Virtual and point-to-point interfaces may be administratively up without
    // IFF_RUNNING. The selected address is re-enumerated and bound at start.
    let required = libc::IFF_UP as u32;
    if flags & required != required || flags & libc::IFF_LOOPBACK as u32 != 0 { return None; }
    Some((name.to_owned(), ipv4_address(address)?, ipv4_netmask_prefix(netmask)?, true))
}

#[cfg(target_os = "macos")]
struct IfAddrs(*mut libc::ifaddrs);

#[cfg(target_os = "macos")]
impl Drop for IfAddrs {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: a successful getifaddrs returned this exact list once.
            unsafe { libc::freeifaddrs(self.0) };
        }
    }
}

/// Only the prefix declared by Darwin's sockaddr is read. The backing memory is
/// borrowed from a successful getifaddrs result and remains alive until Drop.
#[cfg(target_os = "macos")]
unsafe fn bounded_sockaddr<'a>(_list: &'a IfAddrs, address: *const libc::sockaddr) -> Option<&'a [u8]> {
    if address.is_null() { return None; }
    let raw = address.cast::<u8>();
    // SAFETY: getifaddrs returned a non-null pointer to a sockaddr with sa_len.
    let len = unsafe { *raw } as usize;
    let readable = len.min(IPV4_END).max(1);
    // SAFETY: getifaddrs owns at least the advertised sockaddr length; when
    // sa_len is zero only the length byte itself is read.
    Some(unsafe { std::slice::from_raw_parts(raw, readable) })
}

#[cfg(target_os = "macos")]
pub(super) fn enumerate() -> Result<Vec<LanIpv4Interface>, GatewayError> {
    let mut first = std::ptr::null_mut();
    // SAFETY: the out pointer is valid, and the result is released by IfAddrs.
    if unsafe { libc::getifaddrs(&mut first) } != 0 {
        return Err(GatewayError::new("gateway-interface-enumeration-failed", "macOS could not enumerate private LAN interfaces"));
    }
    let list = IfAddrs(first);
    let mut current = list.0;
    let mut count = 0usize;
    let mut candidates = Vec::new();
    while !current.is_null() {
        count += 1;
        if count > 65_536 {
            return Err(GatewayError::new("gateway-interface-enumeration-failed", "macOS interface enumeration exceeded its limit"));
        }
        // SAFETY: each node and its pointers belong to the live getifaddrs list.
        let item = unsafe { &*current };
        current = item.ifa_next;
        if item.ifa_name.is_null() { continue; }
        // SAFETY: getifaddrs documents ifa_name as a NUL-terminated name.
        let name = unsafe { std::ffi::CStr::from_ptr(item.ifa_name) }.to_string_lossy();
        // SAFETY: pointers either are null or point into the live system list.
        let (Some(address), Some(netmask)) = (unsafe { bounded_sockaddr(&list, item.ifa_addr) }, unsafe { bounded_sockaddr(&list, item.ifa_netmask) }) else { continue };
        if let Some(record) = candidate(&name, item.ifa_flags, address, netmask) { candidates.push(record); }
    }
    Ok(normalize_lan_interfaces(candidates))
}

fn management_address_with(
    requested: &str,
    enumerate: impl FnOnce() -> Result<Vec<LanIpv4Interface>, GatewayError>,
) -> Result<String, GatewayError> {
    validate_management_bind_address(requested, &enumerate()?)
}

#[cfg(target_os = "macos")]
pub(super) fn management_address(requested: &str) -> Result<String, GatewayError> {
    management_address_with(requested, enumerate)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UP: u32 = (libc::IFF_UP | libc::IFF_RUNNING) as u32;
    fn addr(a: [u8; 4]) -> [u8; 8] { [8, libc::AF_INET as u8, 0, 0, a[0], a[1], a[2], a[3]] }
    fn mask(a: [u8; 4]) -> [u8; 8] { [8, libc::AF_UNSPEC as u8, 0, 0, a[0], a[1], a[2], a[3]] }

    #[test]
    fn macos_lan_ipv4_byte_order_and_short_netmasks() {
        assert_eq!(ipv4_address(&addr([192, 168, 23, 41])), Some(Ipv4Addr::new(192, 168, 23, 41)));
        assert_eq!(ipv4_netmask_prefix(&[0]), Some(0));
        assert_eq!(ipv4_netmask_prefix(&[4, 0, 0, 0]), Some(0));
        assert_eq!(ipv4_netmask_prefix(&[5, 0, 0, 0, 255]), Some(8));
        assert_eq!(ipv4_netmask_prefix(&[6, 0, 0, 0, 255, 255]), Some(16));
        assert_eq!(ipv4_netmask_prefix(&[7, 0, 0, 0, 255, 255, 255]), Some(24));
        assert_eq!(ipv4_netmask_prefix(&mask([255, 255, 255, 255])), Some(32));
        assert_eq!(ipv4_netmask_prefix(&mask([255, 254, 255, 0])), None);
        assert_eq!(ipv4_netmask_prefix(&[7, 0, 0, 0, 255]), None);
        assert_eq!(ipv4_netmask_prefix(&[3, 0, 0]), None);
        assert_eq!(ipv4_netmask_prefix(&[8, 30, 0, 0, 255, 255, 255, 0]), None);
        assert_eq!(ipv4_address(&[7, 2, 0, 0, 192, 168, 1]), None);
        assert_eq!(ipv4_address(&[8, 30, 0, 0, 192, 168, 1, 2]), None);
    }

    #[test]
    fn macos_lan_filters_down_loopback_public_and_duplicate_interfaces() {
        let rows = [
            candidate("en0", UP, &addr([192, 168, 1, 20]), &mask([255, 255, 255, 0])),
            candidate("duplicate", UP, &addr([192, 168, 1, 20]), &mask([255, 255, 255, 0])),
            candidate("en1", UP, &addr([10, 4, 5, 6]), &mask([255, 255, 0, 0])),
            candidate("down", libc::IFF_RUNNING as u32, &addr([192, 168, 1, 21]), &mask([255, 255, 255, 0])),
            candidate("virtual", libc::IFF_UP as u32, &addr([192, 168, 1, 22]), &mask([255, 255, 255, 0])),
            candidate("lo", UP | libc::IFF_LOOPBACK as u32, &addr([10, 0, 0, 5]), &mask([255, 0, 0, 0])),
            candidate("public", UP, &addr([8, 8, 8, 8]), &mask([255, 255, 255, 0])),
            candidate("invalid-mask", UP, &addr([10, 2, 3, 4]), &mask([255, 0, 255, 0])),
        ];
        let interfaces = normalize_lan_interfaces(rows.into_iter().flatten());
        assert_eq!(interfaces.iter().map(|row| row.name.as_str()).collect::<Vec<_>>(), ["en0", "en1", "virtual"]);
        assert_eq!(interfaces[0].address, "192.168.1.20");
        assert_eq!(interfaces[0].prefix_length, 24);
        assert_eq!(interfaces[1].address, "10.4.5.6");
        assert_eq!(interfaces[2].address, "192.168.1.22");
    }

    #[test]
    fn macos_lan_management_rechecks_selection_and_propagates_failure() {
        let rows = || normalize_lan_interfaces([candidate("en0", UP, &addr([192, 168, 1, 20]), &mask([255, 255, 255, 0])).unwrap()]);
        assert_eq!(management_address_with("192.168.1.20", || Ok(rows())).unwrap(), "192.168.1.20");
        // Interface disappeared after display and is no longer present at start.
        assert_eq!(management_address_with("192.168.1.20", || Ok(vec![])).unwrap_err().code, "gateway-bind-address-unavailable");
        for other in ["127.0.0.1", "0.0.0.0", "8.8.8.8", "192.168.1.21"] {
            assert!(management_address_with(other, || Ok(rows())).is_err());
        }
        assert_eq!(management_address_with("192.168.1.20", || Err(GatewayError::new("gateway-interface-enumeration-failed", "test"))).unwrap_err().code, "gateway-interface-enumeration-failed");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_lan_system_enumeration_uses_real_getifaddrs() {
        let interfaces = enumerate().unwrap();
        let unique: std::collections::BTreeSet<_> = interfaces.iter().map(|row| &row.address).collect();
        assert_eq!(unique.len(), interfaces.len());
        for row in &interfaces {
            let ip: Ipv4Addr = row.address.parse().unwrap();
            assert!(super::super::is_private_lan(ip));
            assert!(row.prefix_length <= 32);
            assert_eq!(row.interface_id, row.address);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_lan_live_management_bind_when_private_interface_exists() {
        let interfaces = enumerate().unwrap();
        let Some(interface) = interfaces.first() else { panic!("macos-lan-fixture-no-private-interface") };
        // Exercise the same re-enumeration/validation as the Tauri management
        // commands. Port 0 binds only locally and does not contact a peer.
        let address = management_address(&interface.address).unwrap_or_else(|_| panic!("macos-lan-interface-changed"));
        let ip: Ipv4Addr = address.parse().unwrap();
        let listener = std::net::TcpListener::bind(std::net::SocketAddrV4::new(ip, 0))
            .unwrap_or_else(|_| panic!("macos-lan-bind-failed"));
        let actual = listener.local_addr().unwrap();
        assert_eq!(actual.ip(), std::net::IpAddr::V4(ip));
        assert_ne!(actual.port(), 0);
        drop(listener);
    }
}
