//! IP fragmentation, both ways: a UDP datagram larger than the interface's MTU
//! leaves as fragments, and the fragments the peer sends are joined again before
//! they are read.
//!
//! A kernel WireGuard interface gets this from the IP stack it sits under; this
//! daemon has none for UDP, so without it a datagram one byte past the MTU would
//! be lost where a kernel tunnel delivers it. A game whose packets run past the
//! nested side link's MTU is the case that needs it.
//!
//! Every fragment is untrusted. Lengths are checked before use, an overlap
//! discards the whole datagram (as RFC 5722 asks of IPv6, and the safe reading of
//! IPv4), and the table of half-joined datagrams is bounded in entries, bytes and
//! age, so a peer that never sends the last fragment cannot hold memory.

use std::collections::{BTreeMap, HashMap};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::{Duration, Instant};

use crate::packet::{self, be16, fold, sum, PacketError, IPV4_HEADER, IPV6_HEADER, PROTO_UDP};

/// IPv6's fragment header: next header, reserved, offset and flags, identification.
const FRAGMENT_HEADER: usize = 8;
/// IPv6's number for the fragment header.
pub const PROTO_FRAGMENT: u8 = 44;
/// The largest IP packet either family describes with its length field.
const MAX_PACKET: usize = 65535;

/// One UDP datagram as the IP packets that carry it: one when it fits `mtu`,
/// fragments of at most `mtu` bytes each when it does not.
pub fn udp_packets(
    src: SocketAddr,
    dst: SocketAddr,
    payload: &[u8],
    mtu: usize,
    id: u32,
    out: &mut Vec<Vec<u8>>,
) -> Result<(), PacketError> {
    out.clear();
    let mut whole = Vec::new();
    match packet::build_udp(src, dst, payload, mtu, &mut whole) {
        Ok(()) => {
            out.push(whole);
            return Ok(());
        }
        Err(PacketError::TooLarge) => {}
        Err(e) => return Err(e),
    }
    let v6 = src.is_ipv6();
    let header = if v6 { IPV6_HEADER } else { IPV4_HEADER };
    // The whole datagram first, then cut: the UDP checksum covers all of it.
    packet::build_udp(src, dst, payload, header + MAX_PACKET, &mut whole)?;
    if !v6 && whole.len() > MAX_PACKET {
        return Err(PacketError::TooLarge);
    }
    let room = mtu.saturating_sub(header + if v6 { FRAGMENT_HEADER } else { 0 });
    let chunk = room / 8 * 8;
    if chunk == 0 {
        return Err(PacketError::TooLarge);
    }
    let body = &whole[header..];
    let mut offset = 0;
    while offset < body.len() {
        let end = (offset + chunk).min(body.len());
        let more = end < body.len();
        let piece = &body[offset..end];
        let mut p = Vec::with_capacity(mtu);
        if v6 {
            p.extend_from_slice(&whole[..IPV6_HEADER]);
            p[4..6].copy_from_slice(&((FRAGMENT_HEADER + piece.len()) as u16).to_be_bytes());
            p[6] = PROTO_FRAGMENT;
            let field = ((offset / 8) as u16) << 3 | u16::from(more);
            p.extend_from_slice(&[PROTO_UDP, 0]);
            p.extend_from_slice(&field.to_be_bytes());
            p.extend_from_slice(&id.to_be_bytes());
        } else {
            p.extend_from_slice(&whole[..IPV4_HEADER]);
            p[2..4].copy_from_slice(&((IPV4_HEADER + piece.len()) as u16).to_be_bytes());
            p[4..6].copy_from_slice(&(id as u16).to_be_bytes());
            let field = (offset / 8) as u16 | if more { 0x2000 } else { 0 };
            p[6..8].copy_from_slice(&field.to_be_bytes());
            p[10] = 0;
            p[11] = 0;
            let check = !fold(sum(0, &p[..IPV4_HEADER]));
            p[10..12].copy_from_slice(&check.to_be_bytes());
        }
        p.extend_from_slice(piece);
        out.push(p);
        offset = end;
    }
    Ok(())
}

/// Whether an IP packet is one fragment of a larger one.
pub fn is_fragment(packet: &[u8]) -> bool {
    match packet.first().map(|b| b >> 4) {
        Some(4) => be16(packet, 6).is_some_and(|f| f & 0x3fff != 0),
        Some(6) => packet.get(6) == Some(&PROTO_FRAGMENT),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct Key {
    src: IpAddr,
    dst: IpAddr,
    id: u32,
    protocol: u8,
}

struct Partial {
    v6: bool,
    pieces: BTreeMap<usize, Vec<u8>>,
    /// Known once the last fragment has arrived.
    total: Option<usize>,
    received: usize,
    started: Instant,
}

/// One fragment, read.
struct Fragment<'a> {
    key: Key,
    v6: bool,
    offset: usize,
    more: bool,
    data: &'a [u8],
}

/// What happened to a fragment handed to [`Reassembly::push`].
#[derive(Debug, PartialEq, Eq)]
pub enum Joined {
    /// The datagram is whole: an unfragmented IP packet, to be read as usual.
    Whole(Vec<u8>),
    /// Kept until the rest arrives.
    Waiting,
    /// Not a fragment this daemon can read, or one that contradicts the others.
    Malformed,
    /// The table is full; the fragment was dropped.
    Full,
}

/// The half-joined datagrams, bounded.
pub struct Reassembly {
    parts: HashMap<Key, Partial>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
    timeout: Duration,
}

impl Reassembly {
    pub fn new(max_entries: usize, max_bytes: usize, timeout: Duration) -> Self {
        Reassembly {
            parts: HashMap::new(),
            bytes: 0,
            max_entries,
            max_bytes,
            timeout,
        }
    }

    /// Datagrams still waiting for a fragment.
    pub fn pending(&self) -> usize {
        self.parts.len()
    }

    /// Bytes held for them.
    pub fn held(&self) -> usize {
        self.bytes
    }

    /// Forget every datagram older than the timeout.
    pub fn sweep(&mut self, now: Instant) {
        let timeout = self.timeout;
        let mut freed = 0;
        self.parts.retain(|_, p| {
            let keep = now.saturating_duration_since(p.started) < timeout;
            if !keep {
                freed += p.received;
            }
            keep
        });
        self.bytes -= freed;
    }

    fn discard(&mut self, key: &Key) {
        if let Some(p) = self.parts.remove(key) {
            self.bytes -= p.received;
        }
    }

    /// One fragment from the tunnel.
    pub fn push(&mut self, packet: &[u8], now: Instant) -> Joined {
        let Some(f) = read(packet) else {
            return Joined::Malformed;
        };
        let end = f.offset + f.data.len();
        let header = if f.v6 { IPV6_HEADER } else { IPV4_HEADER };
        if (f.more && f.data.len() % 8 != 0)
            || header + end > MAX_PACKET + usize::from(f.v6) * IPV6_HEADER
        {
            self.discard(&f.key);
            return Joined::Malformed;
        }
        if f.data.is_empty() && f.more {
            return Joined::Malformed;
        }
        if !self.parts.contains_key(&f.key) {
            self.sweep(now);
            if self.parts.len() >= self.max_entries {
                return Joined::Full;
            }
            self.parts.insert(
                f.key,
                Partial {
                    v6: f.v6,
                    pieces: BTreeMap::new(),
                    total: None,
                    received: 0,
                    started: now,
                },
            );
        }
        if self.bytes + f.data.len() > self.max_bytes {
            self.discard(&f.key);
            return Joined::Full;
        }
        let Some(part) = self.parts.get_mut(&f.key) else {
            return Joined::Malformed;
        };
        let overlaps = part
            .pieces
            .range(..end)
            .next_back()
            .is_some_and(|(&at, d)| at + d.len() > f.offset);
        let past_end = part.total.is_some_and(|t| end > t);
        let ends_twice = !f.more && part.total.is_some_and(|t| t != end);
        let before_known_end = !f.more && part.pieces.range(end..).next().is_some();
        if overlaps || past_end || ends_twice || before_known_end || part.v6 != f.v6 {
            self.discard(&f.key);
            return Joined::Malformed;
        }
        if !f.more {
            part.total = Some(end);
        }
        part.pieces.insert(f.offset, f.data.to_vec());
        part.received += f.data.len();
        self.bytes += f.data.len();
        if part.total != Some(part.received) {
            return Joined::Waiting;
        }
        let Some(part) = self.parts.remove(&f.key) else {
            return Joined::Malformed;
        };
        self.bytes -= part.received;
        Joined::Whole(rebuild(&f.key, &part))
    }
}

/// The fragment's identity, place and data, or None when it is not a fragment
/// with a readable header.
fn read(packet: &[u8]) -> Option<Fragment<'_>> {
    match packet.first()? >> 4 {
        4 => {
            if packet.len() < IPV4_HEADER {
                return None;
            }
            let ihl = usize::from(packet[0] & 0x0f) * 4;
            let total = usize::from(be16(packet, 2)?);
            if ihl < IPV4_HEADER || total < ihl || total > packet.len() {
                return None;
            }
            if fold(sum(0, &packet[..ihl])) != 0xffff {
                return None;
            }
            let field = be16(packet, 6)?;
            let more = field & 0x2000 != 0;
            let offset = usize::from(field & 0x1fff) * 8;
            if !more && offset == 0 {
                return None;
            }
            Some(Fragment {
                key: Key {
                    src: IpAddr::V4(Ipv4Addr::new(
                        packet[12], packet[13], packet[14], packet[15],
                    )),
                    dst: IpAddr::V4(Ipv4Addr::new(
                        packet[16], packet[17], packet[18], packet[19],
                    )),
                    id: u32::from(be16(packet, 4)?),
                    protocol: packet[9],
                },
                v6: false,
                offset,
                more,
                data: &packet[ihl..total],
            })
        }
        6 => {
            if packet.len() < IPV6_HEADER + FRAGMENT_HEADER || packet[6] != PROTO_FRAGMENT {
                return None;
            }
            let length = usize::from(be16(packet, 4)?);
            if length < FRAGMENT_HEADER || IPV6_HEADER + length > packet.len() {
                return None;
            }
            let at = IPV6_HEADER;
            let field = be16(packet, at + 2)?;
            let more = field & 1 != 0;
            let offset = usize::from(field >> 3) * 8;
            if !more && offset == 0 {
                return None;
            }
            let mut s = [0u8; 16];
            let mut d = [0u8; 16];
            s.copy_from_slice(&packet[8..24]);
            d.copy_from_slice(&packet[24..40]);
            let id = u32::from_be_bytes([
                packet[at + 4],
                packet[at + 5],
                packet[at + 6],
                packet[at + 7],
            ]);
            Some(Fragment {
                key: Key {
                    src: IpAddr::V6(Ipv6Addr::from(s)),
                    dst: IpAddr::V6(Ipv6Addr::from(d)),
                    id,
                    protocol: packet[at],
                },
                v6: true,
                offset,
                more,
                data: &packet[at + FRAGMENT_HEADER..IPV6_HEADER + length],
            })
        }
        _ => None,
    }
}

/// The unfragmented packet: a fresh header, then the pieces in order.
fn rebuild(key: &Key, part: &Partial) -> Vec<u8> {
    let total = part.received;
    let mut p = Vec::with_capacity(IPV6_HEADER + total);
    match (key.src, key.dst) {
        (IpAddr::V4(s), IpAddr::V4(d)) => {
            p.extend_from_slice(&[0x45, 0]);
            p.extend_from_slice(&((IPV4_HEADER + total) as u16).to_be_bytes());
            p.extend_from_slice(&[0, 0, 0, 0, 64, key.protocol, 0, 0]);
            p.extend_from_slice(&s.octets());
            p.extend_from_slice(&d.octets());
            let check = !fold(sum(0, &p[..IPV4_HEADER]));
            p[10..12].copy_from_slice(&check.to_be_bytes());
        }
        (IpAddr::V6(s), IpAddr::V6(d)) => {
            p.extend_from_slice(&[0x60, 0, 0, 0]);
            p.extend_from_slice(&(total as u16).to_be_bytes());
            p.extend_from_slice(&[key.protocol, 64]);
            p.extend_from_slice(&s.octets());
            p.extend_from_slice(&d.octets());
        }
        // A key is built from one packet, so both addresses share its family.
        _ => {}
    }
    for piece in part.pieces.values() {
        p.extend_from_slice(piece);
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packet::{parse, Parsed};
    use proptest::prelude::*;

    fn a(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn table() -> Reassembly {
        Reassembly::new(8, 256 * 1024, Duration::from_secs(30))
    }

    fn join(t: &mut Reassembly, packets: &[Vec<u8>]) -> Option<Vec<u8>> {
        let now = Instant::now();
        let mut whole = None;
        for p in packets {
            match t.push(p, now) {
                Joined::Whole(w) => whole = Some(w),
                Joined::Waiting => {}
                other => panic!("unexpected {other:?}"),
            }
        }
        whole
    }

    fn payload_of(packet: &[u8]) -> Vec<u8> {
        match parse(packet) {
            Ok(Parsed::Udp { payload, .. }) => payload.to_vec(),
            other => panic!("not UDP: {other:?}"),
        }
    }

    #[test]
    fn a_datagram_that_fits_is_one_packet() {
        let mut out = Vec::new();
        udp_packets(
            a("10.0.0.1:1"),
            a("10.0.0.2:2"),
            &[7; 1332],
            1360,
            1,
            &mut out,
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].len(), 1360);
        assert_eq!(payload_of(&out[0]), vec![7; 1332]);
    }

    #[test]
    fn v4_fragments_fit_the_mtu_and_join_in_any_order() {
        let payload: Vec<u8> = (0..4000u32).map(|i| i as u8).collect();
        let mut out = Vec::new();
        udp_packets(
            a("10.0.0.1:1"),
            a("10.0.0.2:2"),
            &payload,
            1360,
            77,
            &mut out,
        )
        .unwrap();
        assert_eq!(out.len(), 3);
        assert!(out.iter().all(|p| p.len() <= 1360));
        assert!(out.iter().all(|p| parse(p) == Err(PacketError::Fragment)));
        assert!(out.iter().all(|p| is_fragment(p)));
        let mut t = table();
        let mut reversed = out.clone();
        reversed.reverse();
        let whole = join(&mut t, &reversed).unwrap();
        assert_eq!(payload_of(&whole), payload);
        assert_eq!((t.pending(), t.held()), (0, 0));
    }

    #[test]
    fn v6_fragments_fit_the_mtu_and_join() {
        let payload = vec![3u8; 3000];
        let mut out = Vec::new();
        udp_packets(
            a("[fd00::1]:1"),
            a("[fd00::2]:2"),
            &payload,
            1280,
            9,
            &mut out,
        )
        .unwrap();
        assert!(out.len() >= 3);
        assert!(out.iter().all(|p| p.len() <= 1280));
        assert!(out
            .iter()
            .all(|p| matches!(parse(p), Ok(Parsed::Other { protocol: 44, .. }))));
        let whole = join(&mut table(), &out).unwrap();
        assert_eq!(payload_of(&whole), payload);
    }

    #[test]
    fn the_largest_datagram_still_goes_and_one_more_byte_does_not() {
        let mut out = Vec::new();
        let max = MAX_PACKET - IPV4_HEADER - 8;
        udp_packets(
            a("10.0.0.1:1"),
            a("10.0.0.2:2"),
            &vec![1; max],
            1360,
            2,
            &mut out,
        )
        .unwrap();
        let mut t = Reassembly::new(8, 1 << 20, Duration::from_secs(30));
        assert_eq!(payload_of(&join(&mut t, &out).unwrap()).len(), max);
        let big = vec![1; max + 1];
        assert_eq!(
            udp_packets(a("10.0.0.1:1"), a("10.0.0.2:2"), &big, 1360, 3, &mut out),
            Err(PacketError::TooLarge)
        );
        assert_eq!(
            udp_packets(a("10.0.0.1:1"), a("10.0.0.2:2"), &[0; 100], 20, 3, &mut out),
            Err(PacketError::TooLarge)
        );
        assert_eq!(
            udp_packets(a("10.0.0.1:1"), a("[::2]:2"), &[0; 100], 1360, 3, &mut out),
            Err(PacketError::MixedFamily)
        );
    }

    #[test]
    fn contradictions_discard_the_datagram() {
        let payload = vec![5u8; 3000];
        let mut out = Vec::new();
        udp_packets(
            a("10.0.0.1:1"),
            a("10.0.0.2:2"),
            &payload,
            1360,
            4,
            &mut out,
        )
        .unwrap();
        let now = Instant::now();
        // The same fragment twice overlaps itself.
        let mut t = table();
        assert_eq!(t.push(&out[0], now), Joined::Waiting);
        assert_eq!(t.push(&out[0], now), Joined::Malformed);
        assert_eq!((t.pending(), t.held()), (0, 0));
        // A last fragment that ends before a piece already held.
        let mut t = table();
        assert_eq!(t.push(&out[2], now), Joined::Waiting);
        let mut early = out[1].clone();
        early[6] &= !0x20;
        early[10] = 0;
        early[11] = 0;
        let c = !fold(sum(0, &early[..20]));
        early[10..12].copy_from_slice(&c.to_be_bytes());
        assert_eq!(t.push(&early, now), Joined::Malformed);
        assert_eq!(t.pending(), 0);
        // A middle fragment whose length is not a multiple of eight.
        let mut t = table();
        let mut odd = out[0].clone();
        odd.pop();
        let length = odd.len() as u16;
        odd[2..4].copy_from_slice(&length.to_be_bytes());
        odd[10] = 0;
        odd[11] = 0;
        let c = !fold(sum(0, &odd[..20]));
        odd[10..12].copy_from_slice(&c.to_be_bytes());
        assert_eq!(t.push(&odd, now), Joined::Malformed);
        // Not a fragment at all, and garbage.
        let mut whole = Vec::new();
        packet::build_udp(a("10.0.0.1:1"), a("10.0.0.2:2"), b"x", 1360, &mut whole).unwrap();
        assert_eq!(t.push(&whole, now), Joined::Malformed);
        assert!(!is_fragment(&whole) && !is_fragment(&[]) && !is_fragment(&[0x10]));
        assert_eq!(t.push(&[], now), Joined::Malformed);
        assert_eq!(t.push(&[0x45, 0, 0], now), Joined::Malformed);
        let mut bad = out[0].clone();
        bad[10] ^= 1;
        assert_eq!(t.push(&bad, now), Joined::Malformed);
    }

    #[test]
    fn the_table_is_bounded_in_entries_bytes_and_age() {
        let mut t = Reassembly::new(2, 5000, Duration::from_secs(30));
        let now = Instant::now();
        let first = |id: u32| {
            let mut out = Vec::new();
            udp_packets(
                a("10.0.0.1:1"),
                a("10.0.0.2:2"),
                &[1; 3000],
                1360,
                id,
                &mut out,
            )
            .unwrap();
            out.remove(0)
        };
        assert_eq!(t.push(&first(1), now), Joined::Waiting);
        assert_eq!(t.push(&first(2), now), Joined::Waiting);
        assert_eq!(t.push(&first(3), now), Joined::Full);
        assert_eq!(t.pending(), 2);
        // Past the timeout the old ones are swept and a new one fits.
        let later = now + Duration::from_secs(31);
        assert_eq!(t.push(&first(4), later), Joined::Waiting);
        assert_eq!(t.pending(), 1);
        // Bytes: a second fragment past the budget drops the whole datagram.
        let mut out = Vec::new();
        udp_packets(
            a("10.0.0.1:1"),
            a("10.0.0.2:2"),
            &[1; 9000],
            1360,
            4,
            &mut out,
        )
        .unwrap();
        for p in &out[1..3] {
            assert_eq!(t.push(p, later), Joined::Waiting);
        }
        assert_eq!(t.push(&out[3], later), Joined::Full);
        assert_eq!((t.pending(), t.held()), (0, 0));
        t.sweep(later + Duration::from_secs(60));
        assert_eq!((t.pending(), t.held()), (0, 0));
    }

    proptest! {
        #[test]
        fn fragment_then_join_is_identity(v6 in any::<bool>(), len in 0usize..9000, mtu in 1280usize..1500, id in any::<u32>()) {
            let (s, d) = if v6 { (a("[fd00::1]:5"), a("[fd00::2]:6")) } else { (a("10.0.0.1:5"), a("10.0.0.2:6")) };
            let payload: Vec<u8> = (0..len).map(|i| (i * 7) as u8).collect();
            let mut out = Vec::new();
            udp_packets(s, d, &payload, mtu, id, &mut out).unwrap();
            prop_assert!(out.iter().all(|p| p.len() <= mtu));
            let whole = if out.len() == 1 { out[0].clone() } else { join(&mut Reassembly::new(4, 1 << 20, Duration::from_secs(30)), &out).unwrap() };
            prop_assert_eq!(payload_of(&whole), payload);
        }

        #[test]
        fn push_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..1600)) {
            let mut t = table();
            let _ = t.push(&bytes, Instant::now());
            let mut shaped = bytes.clone();
            if shaped.len() >= 20 {
                shaped[0] = 0x45;
                shaped[10] = 0;
                shaped[11] = 0;
                let c = !fold(sum(0, &shaped[..20]));
                shaped[10..12].copy_from_slice(&c.to_be_bytes());
            }
            let _ = t.push(&shaped, Instant::now());
        }
    }
}
