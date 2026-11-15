//! IPv4, IPv6 and UDP headers: reading what the tunnel delivers and writing the
//! UDP datagrams the daemon sends into it.
//!
//! Everything here reads untrusted bytes. Every length is checked before it is
//! used and nothing indexes past what was checked, so a malformed packet is an
//! error value, never a panic.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

pub const PROTO_TCP: u8 = 6;
pub const PROTO_UDP: u8 = 17;
pub(crate) const IPV4_HEADER: usize = 20;
pub(crate) const IPV6_HEADER: usize = 40;
const UDP_HEADER: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketError {
    Truncated,
    BadVersion,
    BadHeaderLength,
    BadLength,
    BadChecksum,
    /// A fragment: the daemon does not reassemble, so neither half is usable.
    Fragment,
    /// The payload does not fit one packet of the interface's MTU.
    TooLarge,
    /// Source and destination are not the same family.
    MixedFamily,
}

/// What a packet from the tunnel holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parsed<'a> {
    Udp {
        src: SocketAddr,
        dst: SocketAddr,
        payload: &'a [u8],
    },
    /// Handed whole to the TCP stack, which checks the rest itself.
    Tcp { src: IpAddr, dst: IpAddr },
    Other {
        src: IpAddr,
        dst: IpAddr,
        protocol: u8,
    },
}

pub(crate) fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

/// The ones'-complement sum of 16-bit words, folded, before inversion.
pub(crate) fn sum(mut acc: u32, bytes: &[u8]) -> u32 {
    let mut chunks = bytes.chunks_exact(2);
    for c in &mut chunks {
        acc += u32::from(u16::from_be_bytes([c[0], c[1]]));
    }
    if let [last] = chunks.remainder() {
        acc += u32::from(*last) << 8;
    }
    acc
}

pub(crate) fn fold(mut acc: u32) -> u16 {
    while acc > 0xffff {
        acc = (acc & 0xffff) + (acc >> 16);
    }
    acc as u16
}

fn pseudo(src: IpAddr, dst: IpAddr, protocol: u8, length: usize) -> u32 {
    match (src, dst) {
        (IpAddr::V4(s), IpAddr::V4(d)) => {
            let acc = sum(sum(0, &s.octets()), &d.octets());
            acc + u32::from(protocol) + length as u32
        }
        (IpAddr::V6(s), IpAddr::V6(d)) => {
            let acc = sum(sum(0, &s.octets()), &d.octets());
            acc + (length as u32 >> 16) + (length as u32 & 0xffff) + u32::from(protocol)
        }
        _ => 0,
    }
}

/// Read one packet the tunnel delivered.
pub fn parse(packet: &[u8]) -> Result<Parsed<'_>, PacketError> {
    let first = *packet.first().ok_or(PacketError::Truncated)?;
    match first >> 4 {
        4 => parse_v4(packet),
        6 => parse_v6(packet),
        _ => Err(PacketError::BadVersion),
    }
}

fn parse_v4(packet: &[u8]) -> Result<Parsed<'_>, PacketError> {
    if packet.len() < IPV4_HEADER {
        return Err(PacketError::Truncated);
    }
    let ihl = usize::from(packet[0] & 0x0f) * 4;
    if ihl < IPV4_HEADER || ihl > packet.len() {
        return Err(PacketError::BadHeaderLength);
    }
    let total = usize::from(be16(packet, 2).ok_or(PacketError::Truncated)?);
    if total < ihl || total > packet.len() {
        return Err(PacketError::BadLength);
    }
    if fold(sum(0, &packet[..ihl])) != 0xffff {
        return Err(PacketError::BadChecksum);
    }
    let flags = be16(packet, 6).ok_or(PacketError::Truncated)?;
    let fragment = flags & 0x2000 != 0 || flags & 0x1fff != 0;
    let protocol = packet[9];
    let src = IpAddr::V4(Ipv4Addr::new(
        packet[12], packet[13], packet[14], packet[15],
    ));
    let dst = IpAddr::V4(Ipv4Addr::new(
        packet[16], packet[17], packet[18], packet[19],
    ));
    let body = &packet[ihl..total];
    match protocol {
        PROTO_UDP if fragment => Err(PacketError::Fragment),
        PROTO_UDP => udp(src, dst, body, false),
        PROTO_TCP if fragment => Err(PacketError::Fragment),
        PROTO_TCP => Ok(Parsed::Tcp { src, dst }),
        _ => Ok(Parsed::Other { src, dst, protocol }),
    }
}

fn parse_v6(packet: &[u8]) -> Result<Parsed<'_>, PacketError> {
    if packet.len() < IPV6_HEADER {
        return Err(PacketError::Truncated);
    }
    let payload = usize::from(be16(packet, 4).ok_or(PacketError::Truncated)?);
    if IPV6_HEADER + payload > packet.len() {
        return Err(PacketError::BadLength);
    }
    let next = packet[6];
    let mut s = [0u8; 16];
    let mut d = [0u8; 16];
    s.copy_from_slice(&packet[8..24]);
    d.copy_from_slice(&packet[24..40]);
    let src = IpAddr::V6(Ipv6Addr::from(s));
    let dst = IpAddr::V6(Ipv6Addr::from(d));
    let body = &packet[IPV6_HEADER..IPV6_HEADER + payload];
    match next {
        PROTO_UDP => udp(src, dst, body, true),
        PROTO_TCP => Ok(Parsed::Tcp { src, dst }),
        // Extension headers, fragments included, are not walked: not TCP or UDP here.
        protocol => Ok(Parsed::Other { src, dst, protocol }),
    }
}

fn udp(src: IpAddr, dst: IpAddr, body: &[u8], v6: bool) -> Result<Parsed<'_>, PacketError> {
    if body.len() < UDP_HEADER {
        return Err(PacketError::Truncated);
    }
    let length = usize::from(be16(body, 4).ok_or(PacketError::Truncated)?);
    if length < UDP_HEADER || length > body.len() {
        return Err(PacketError::BadLength);
    }
    let datagram = &body[..length];
    let checksum = be16(body, 6).ok_or(PacketError::Truncated)?;
    // IPv4 allows no checksum (zero); IPv6 requires one.
    if (checksum != 0 || v6) && fold(sum(pseudo(src, dst, PROTO_UDP, length), datagram)) != 0xffff {
        return Err(PacketError::BadChecksum);
    }
    let sport = be16(body, 0).ok_or(PacketError::Truncated)?;
    let dport = be16(body, 2).ok_or(PacketError::Truncated)?;
    Ok(Parsed::Udp {
        src: SocketAddr::new(src, sport),
        dst: SocketAddr::new(dst, dport),
        payload: &datagram[UDP_HEADER..],
    })
}

/// Write one UDP datagram as a whole IP packet, no larger than `mtu`, into `out`.
pub fn build_udp(
    src: SocketAddr,
    dst: SocketAddr,
    payload: &[u8],
    mtu: usize,
    out: &mut Vec<u8>,
) -> Result<(), PacketError> {
    out.clear();
    let length = UDP_HEADER + payload.len();
    match (src.ip(), dst.ip()) {
        (IpAddr::V4(s), IpAddr::V4(d)) => {
            if IPV4_HEADER + length > mtu.min(usize::from(u16::MAX)) {
                return Err(PacketError::TooLarge);
            }
            let total = (IPV4_HEADER + length) as u16;
            out.extend_from_slice(&[0x45, 0, 0, 0, 0, 0, 0x40, 0, 64, PROTO_UDP, 0, 0]);
            out[2..4].copy_from_slice(&total.to_be_bytes());
            out.extend_from_slice(&s.octets());
            out.extend_from_slice(&d.octets());
            let check = !fold(sum(0, &out[..IPV4_HEADER]));
            out[10..12].copy_from_slice(&check.to_be_bytes());
        }
        (IpAddr::V6(s), IpAddr::V6(d)) => {
            if IPV6_HEADER + length > mtu || length > usize::from(u16::MAX) {
                return Err(PacketError::TooLarge);
            }
            out.extend_from_slice(&[0x60, 0, 0, 0]);
            out.extend_from_slice(&(length as u16).to_be_bytes());
            out.extend_from_slice(&[PROTO_UDP, 64]);
            out.extend_from_slice(&s.octets());
            out.extend_from_slice(&d.octets());
        }
        _ => return Err(PacketError::MixedFamily),
    }
    let start = out.len();
    out.extend_from_slice(&src.port().to_be_bytes());
    out.extend_from_slice(&dst.port().to_be_bytes());
    out.extend_from_slice(&(length as u16).to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(payload);
    let mut check = !fold(sum(
        pseudo(src.ip(), dst.ip(), PROTO_UDP, length),
        &out[start..],
    ));
    if check == 0 {
        check = 0xffff;
    }
    out[start + 6..start + 8].copy_from_slice(&check.to_be_bytes());
    Ok(())
}

/// The source and destination of an IP packet, for the routing checks the TCP
/// stack's output goes through. None when it is not a readable IP header.
pub fn addresses(packet: &[u8]) -> Option<(IpAddr, IpAddr)> {
    match packet.first()? >> 4 {
        4 if packet.len() >= IPV4_HEADER => Some((
            IpAddr::V4(Ipv4Addr::new(
                packet[12], packet[13], packet[14], packet[15],
            )),
            IpAddr::V4(Ipv4Addr::new(
                packet[16], packet[17], packet[18], packet[19],
            )),
        )),
        6 if packet.len() >= IPV6_HEADER => {
            let mut s = [0u8; 16];
            let mut d = [0u8; 16];
            s.copy_from_slice(&packet[8..24]);
            d.copy_from_slice(&packet[24..40]);
            Some((IpAddr::V6(s.into()), IpAddr::V6(d.into())))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn a(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    #[test]
    fn udp_v4_round_trip() {
        let mut out = Vec::new();
        build_udp(
            a("10.0.0.1:5000"),
            a("10.0.0.2:7882"),
            b"hello",
            1420,
            &mut out,
        )
        .unwrap();
        assert_eq!(out.len(), 20 + 8 + 5);
        assert_eq!(
            parse(&out).unwrap(),
            Parsed::Udp {
                src: a("10.0.0.1:5000"),
                dst: a("10.0.0.2:7882"),
                payload: b"hello"
            }
        );
        assert_eq!(
            addresses(&out),
            Some((a("10.0.0.1:1").ip(), a("10.0.0.2:1").ip()))
        );
    }

    #[test]
    fn udp_v6_round_trip() {
        let mut out = Vec::new();
        build_udp(
            a("[fd00::1]:1"),
            a("[fd00::2]:2"),
            &[7; 100],
            1420,
            &mut out,
        )
        .unwrap();
        match parse(&out).unwrap() {
            Parsed::Udp { src, dst, payload } => {
                assert_eq!(
                    (src, dst, payload.len()),
                    (a("[fd00::1]:1"), a("[fd00::2]:2"), 100)
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(addresses(&out).is_some());
    }

    #[test]
    fn known_checksum() {
        // A datagram whose checksum was computed by hand: 10.0.0.1:1 -> 10.0.0.2:2, "ab".
        let mut out = Vec::new();
        build_udp(a("10.0.0.1:1"), a("10.0.0.2:2"), b"ab", 1500, &mut out).unwrap();
        assert_eq!(&out[10..12], &[0x26, 0xcd]);
        let udp_check = u16::from_be_bytes([out[26], out[27]]);
        // 0x0a00+0x0001+0x0a00+0x0002+0x0011+0x000a + 0x0001+0x0002+0x000a + 0x6162
        let expected = !fold(
            0x0a00 + 0x0001 + 0x0a00 + 0x0002 + 0x0011 + 0x000a + 0x0001 + 0x0002 + 0x000a + 0x6162,
        );
        assert_eq!(udp_check, expected);
    }

    #[test]
    fn refusals() {
        let mut ok = Vec::new();
        build_udp(a("10.0.0.1:1"), a("10.0.0.2:2"), b"abcd", 1500, &mut ok).unwrap();
        assert_eq!(parse(&[]), Err(PacketError::Truncated));
        assert_eq!(parse(&[0x15]), Err(PacketError::BadVersion));
        assert_eq!(parse(&ok[..10]), Err(PacketError::Truncated));
        let mut p = ok.clone();
        p[0] = 0x44;
        assert_eq!(parse(&p), Err(PacketError::BadHeaderLength));
        p = ok.clone();
        p[0] = 0x4f;
        assert_eq!(parse(&p), Err(PacketError::BadHeaderLength));
        p = ok.clone();
        p[3] = 200;
        assert_eq!(parse(&p), Err(PacketError::BadLength));
        p = ok.clone();
        p[8] ^= 1;
        assert_eq!(parse(&p), Err(PacketError::BadChecksum));
        p = ok.clone();
        p[30] ^= 1;
        assert_eq!(parse(&p), Err(PacketError::BadChecksum));
        p = ok.clone();
        p[24..26].copy_from_slice(&4u16.to_be_bytes());
        assert_eq!(parse(&p), Err(PacketError::BadLength));
        // No checksum at all is valid on IPv4.
        p = ok.clone();
        p[26] = 0;
        p[27] = 0;
        assert!(matches!(parse(&p), Ok(Parsed::Udp { .. })));
        // A fragment, after fixing the header checksum.
        p = ok.clone();
        p[6] = 0x20;
        refresh_v4(&mut p);
        assert_eq!(parse(&p), Err(PacketError::Fragment));
        p[9] = PROTO_TCP;
        refresh_v4(&mut p);
        assert_eq!(parse(&p), Err(PacketError::Fragment));
        p = ok.clone();
        p[2..4].copy_from_slice(&24u16.to_be_bytes());
        refresh_v4(&mut p);
        assert_eq!(parse(&p), Err(PacketError::Truncated));
        p = ok.clone();
        p[9] = PROTO_TCP;
        refresh_v4(&mut p);
        assert!(matches!(parse(&p), Ok(Parsed::Tcp { .. })));
        p[9] = 1;
        refresh_v4(&mut p);
        assert!(matches!(parse(&p), Ok(Parsed::Other { protocol: 1, .. })));
        assert_eq!(
            build_udp(a("10.0.0.1:1"), a("[::1]:2"), b"", 1500, &mut p),
            Err(PacketError::MixedFamily)
        );
        assert_eq!(
            build_udp(a("10.0.0.1:1"), a("10.0.0.2:2"), &[0; 1473], 1500, &mut p),
            Err(PacketError::TooLarge)
        );
        assert_eq!(
            build_udp(a("[::1]:1"), a("[::2]:2"), &[0; 1453], 1500, &mut p),
            Err(PacketError::TooLarge)
        );
        assert_eq!(addresses(&[0x45]), None);
        assert_eq!(addresses(&[]), None);
    }

    #[test]
    fn v6_refusals() {
        let mut ok = Vec::new();
        build_udp(a("[fd00::1]:1"), a("[fd00::2]:2"), b"abcd", 1500, &mut ok).unwrap();
        assert_eq!(parse(&ok[..39]), Err(PacketError::Truncated));
        let mut p = ok.clone();
        p[5] = 200;
        assert_eq!(parse(&p), Err(PacketError::BadLength));
        p = ok.clone();
        p[46] = 0;
        p[47] = 0;
        assert_eq!(parse(&p), Err(PacketError::BadChecksum));
        p = ok.clone();
        p[6] = PROTO_TCP;
        assert!(matches!(parse(&p), Ok(Parsed::Tcp { .. })));
        p[6] = 44;
        assert!(matches!(parse(&p), Ok(Parsed::Other { protocol: 44, .. })));
    }

    fn refresh_v4(p: &mut [u8]) {
        p[10] = 0;
        p[11] = 0;
        let c = !fold(sum(0, &p[..20]));
        p[10..12].copy_from_slice(&c.to_be_bytes());
    }

    proptest! {
        #[test]
        fn parse_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..1600)) {
            let _ = parse(&bytes);
            let _ = addresses(&bytes);
        }

        #[test]
        fn parse_never_panics_on_ip_shaped(version in prop_oneof![Just(0x45u8), Just(0x60u8), any::<u8>()], rest in proptest::collection::vec(any::<u8>(), 0..200)) {
            let mut bytes = vec![version];
            bytes.extend(rest);
            let _ = parse(&bytes);
        }

        #[test]
        fn mutated_datagrams_never_panic(payload in proptest::collection::vec(any::<u8>(), 0..64), at in 0usize..100, bit in 0u8..8, cut in 0usize..100) {
            let mut out = Vec::new();
            build_udp(a("10.0.0.1:9"), a("10.0.0.2:7"), &payload, 1500, &mut out).unwrap();
            let i = at % out.len();
            out[i] ^= 1 << bit;
            let _ = parse(&out);
            out.truncate(cut % (out.len() + 1));
            let _ = parse(&out);
        }

        #[test]
        fn build_then_parse_is_identity(v6 in any::<bool>(), sp in 1u16.., dp in 1u16.., payload in proptest::collection::vec(any::<u8>(), 0..1300)) {
            let (s, d) = if v6 { (a("[fd00::1]:0"), a("[fd00::2]:0")) } else { (a("10.0.0.1:0"), a("10.0.0.2:0")) };
            let src = SocketAddr::new(s.ip(), sp);
            let dst = SocketAddr::new(d.ip(), dp);
            let mut out = Vec::new();
            build_udp(src, dst, &payload, 1420, &mut out).unwrap();
            prop_assert_eq!(parse(&out).unwrap(), Parsed::Udp { src, dst, payload: &payload });
        }
    }
}
