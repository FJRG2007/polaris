//! Finding TVs by what they announce on the network (multicast DNS, RFC 6762
//! and DNS-SD, RFC 6763).
//!
//! The Rust twin of `desktop/src/main/tv-mdns.ts`, reading the packets the same
//! way: a TV whose debugging only opens through Wireless debugging pairing
//! (Chromecast with Google TV, Google TV Streamer) never answers on the classic
//! port 5555, so the port sweep cannot see it; it does announce
//! `_adb-tls-pairing._tcp` and `_adb-tls-connect._tcp`, and its Cast record names
//! the model (`md`). What is found here feeds the path engine (`tv_path`) as a
//! `TvSighting`.
//!
//! Searching never listens for the network: the query goes out from a port the
//! system picks on each interface's own address and asks for unicast answers, so
//! nothing binds 5353 or joins the multicast group and Windows Defender Firewall
//! has no reason to ask the operator to let Polaris in.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::task::Poll;
use std::time::Duration;

use tokio::net::UdpSocket;

use crate::tv_address::read_tv_address;
use crate::tv_path::{TvService, TvSighting};

const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;
const TYPE_A: u16 = 1;
const TYPE_PTR: u16 = 12;
const TYPE_TXT: u16 = 16;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;
/// The question's top class bit: answer by unicast, so a socket off port 5353 hears it (RFC 6762 5.4).
const UNICAST_RESPONSE: u16 = 0x8000;
/// Compression pointers followed per name before it counts as a loop.
const MAX_JUMPS: usize = 32;
/// How often the query goes out while a search listens: under the firewall's 3-second window for unicast answers.
pub const RESEND: Duration = Duration::from_secs(1);

/// The DNS-SD service type each `TvService` is announced under.
pub const TV_SERVICE_TYPES: [(TvService, &str); 4] = [
    (TvService::Adb, "_adb._tcp.local"),
    (TvService::AdbTlsConnect, "_adb-tls-connect._tcp.local"),
    (TvService::AdbTlsPairing, "_adb-tls-pairing._tcp.local"),
    (TvService::Googlecast, "_googlecast._tcp.local"),
];

/// What a record carries: PTR the instance name, SRV the target host, A the address, TXT each `key=value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MdnsData {
    Name(String),
    Entries(Vec<String>),
}

/// One answer or additional record of a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsRecord {
    pub name: String,
    pub kind: u16,
    pub data: MdnsData,
    /// SRV: the service's port.
    pub port: Option<u16>,
}

/// A packet as it arrived, with the address it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdnsPacket {
    pub data: Vec<u8>,
    pub from: Ipv4Addr,
}

fn encode_name(name: &str, into: &mut Vec<u8>) {
    for label in name.split('.').filter(|label| !label.is_empty()) {
        into.push(label.len() as u8);
        into.extend_from_slice(label.as_bytes());
    }
    into.push(0);
}

/// One query asking for every TV service at once, each as a PTR question that wants a unicast answer.
pub fn tv_query() -> Vec<u8> {
    let mut query = vec![0u8; 12];
    query[4..6].copy_from_slice(&(TV_SERVICE_TYPES.len() as u16).to_be_bytes());
    for (_, kind) in TV_SERVICE_TYPES {
        encode_name(kind, &mut query);
        query.extend_from_slice(&TYPE_PTR.to_be_bytes());
        query.extend_from_slice(&(CLASS_IN | UNICAST_RESPONSE).to_be_bytes());
    }
    query
}

fn u16_at(packet: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*packet.get(at)?, *packet.get(at + 1)?]))
}

/// A name at `offset`, following compression pointers, and where the name itself stops.
fn read_name(packet: &[u8], offset: usize) -> Option<(String, usize)> {
    let mut labels = Vec::new();
    let mut at = offset;
    let mut end = None;
    let mut jumps = 0;
    loop {
        let length = *packet.get(at)? as usize;
        if length == 0 {
            return Some((labels.join("."), end.unwrap_or(at + 1)));
        }
        if length & 0xc0 == 0xc0 {
            jumps += 1;
            if jumps > MAX_JUMPS {
                return None;
            }
            end.get_or_insert(at + 2);
            at = usize::from(u16_at(packet, at)? & 0x3fff);
            continue;
        }
        let label = packet.get(at + 1..at + 1 + length)?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        at += 1 + length;
    }
}

fn read_txt(rdata: &[u8]) -> Vec<String> {
    let mut entries = Vec::new();
    let mut at = 0;
    while at < rdata.len() {
        let length = rdata[at] as usize;
        if length > 0 {
            let stop = rdata.len().min(at + 1 + length);
            entries.push(String::from_utf8_lossy(&rdata[at + 1..stop]).into_owned());
        }
        at += 1 + length;
    }
    entries
}

fn read_records(packet: &[u8]) -> Option<Vec<MdnsRecord>> {
    if packet.len() < 12 || u16_at(packet, 2)? & 0x8000 == 0 {
        return Some(Vec::new());
    }
    let questions = u16_at(packet, 4)?;
    let count =
        u16_at(packet, 6)? as usize + u16_at(packet, 8)? as usize + u16_at(packet, 10)? as usize;
    let mut at = 12;
    for _ in 0..questions {
        at = read_name(packet, at)?.1 + 4;
    }
    let mut records = Vec::new();
    for _ in 0..count {
        let (name, end) = read_name(packet, at)?;
        let kind = u16_at(packet, end)?;
        let length = u16_at(packet, end + 8)? as usize;
        let start = end + 10;
        if start + length > packet.len() {
            break;
        }
        let rdata = &packet[start..start + length];
        let record = |data, port| MdnsRecord {
            name: name.clone(),
            kind,
            data,
            port,
        };
        match kind {
            TYPE_PTR => records.push(record(MdnsData::Name(read_name(packet, start)?.0), None)),
            TYPE_SRV if length >= 6 => records.push(record(
                MdnsData::Name(read_name(packet, start + 6)?.0),
                u16_at(rdata, 4),
            )),
            TYPE_A if length == 4 => records.push(record(
                MdnsData::Name(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]).to_string()),
                None,
            )),
            TYPE_TXT => records.push(record(MdnsData::Entries(read_txt(rdata)), None)),
            _ => {}
        }
        at = start + length;
    }
    Some(records)
}

/// The answer and additional records of a response; a query or a malformed packet reads as none.
pub fn parse_mdns(packet: &[u8]) -> Vec<MdnsRecord> {
    read_records(packet).unwrap_or_default()
}

/// The service instances the packets announce, resolved through their SRV, A and TXT records.
/// Names are matched without regard to case, as DNS does.
pub fn heard_in(packets: &[MdnsPacket]) -> Vec<Heard> {
    let mut instances: Vec<(String, TvService, Ipv4Addr)> = Vec::new();
    let mut targets = HashMap::new();
    let mut ports = HashMap::new();
    let mut addresses: HashMap<String, String> = HashMap::new();
    let mut texts: HashMap<String, Vec<String>> = HashMap::new();
    for packet in packets {
        for record in parse_mdns(&packet.data) {
            let name = record.name.to_lowercase();
            match (record.kind, record.data) {
                (TYPE_PTR, MdnsData::Name(instance)) => {
                    let Some((service, _)) =
                        TV_SERVICE_TYPES.iter().find(|(_, kind)| *kind == name)
                    else {
                        continue;
                    };
                    let instance = instance.to_lowercase();
                    instances.retain(|(known, _, _)| *known != instance);
                    instances.push((instance, *service, packet.from));
                }
                (TYPE_SRV, MdnsData::Name(target)) => {
                    if let Some(port) = record.port.filter(|port| *port != 0) {
                        ports.insert(name.clone(), port);
                    }
                    targets.insert(name, target.to_lowercase());
                }
                (TYPE_A, MdnsData::Name(address)) => {
                    addresses.insert(name, address);
                }
                (TYPE_TXT, MdnsData::Entries(entries)) => {
                    texts.insert(name, entries);
                }
                _ => {}
            }
        }
    }
    instances
        .into_iter()
        .map(|(instance, service, from)| {
            // The host's own address record when it sent one, else the address the answer came from.
            let address = targets
                .get(&instance)
                .and_then(|target| addresses.get(target))
                .and_then(|address| address.parse().ok())
                .unwrap_or(from);
            let txt = texts
                .get(&instance)
                .map(|entries| {
                    entries
                        .iter()
                        .map(|entry| match entry.split_once('=') {
                            Some((key, value)) => (key.to_string(), value.to_string()),
                            None => (entry.clone(), String::new()),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Heard {
                service,
                port: ports.get(&instance).copied().unwrap_or(0),
                txt,
                instance,
                addresses: vec![address],
            }
        })
        .collect()
}

/// Every TV the packets announce, by its private address.
pub fn collect_packets(packets: &[MdnsPacket]) -> BTreeMap<String, TvAnnouncement> {
    collect_tvs(&heard_in(packets))
}
/// One resolved service instance, as discovery heard it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heard {
    pub service: TvService,
    /// The instance name, e.g. `TV-1._googlecast._tcp.local.`.
    pub instance: String,
    pub addresses: Vec<Ipv4Addr>,
    pub port: u16,
    /// Each TXT `key=value`, as announced.
    pub txt: Vec<(String, String)>,
}

/// A TV found by its announcements, with the name it gave itself when it gave one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TvAnnouncement {
    /// In the TypeScript module's order: adb, adb-tls-connect, adb-tls-pairing, googlecast.
    pub services: Vec<TvService>,
    pub cast_model: Option<String>,
    pub name: Option<String>,
    /// The port each service announced: Wireless debugging's TLS and pairing ports move on every switch-on.
    pub ports: BTreeMap<String, u16>,
}

fn service_name(service: TvService) -> &'static str {
    match service {
        TvService::Adb => "adb",
        TvService::AdbTlsConnect => "adb-tls-connect",
        TvService::AdbTlsPairing => "adb-tls-pairing",
        TvService::Googlecast => "googlecast",
    }
}

/// A TXT value by key, without regard to the key's case; an empty value is none.
fn txt_value(entries: &[(String, String)], key: &str) -> Option<String> {
    entries
        .iter()
        .find(|(name, _)| !name.is_empty() && name.to_lowercase() == key)
        .and_then(|(_, value)| Some(value.trim().to_string()).filter(|value| !value.is_empty()))
}

/// Every TV the resolved services announce, by its private address. Instances are matched without regard to case, as DNS does.
pub fn collect_tvs(heard: &[Heard]) -> BTreeMap<String, TvAnnouncement> {
    let mut found: HashMap<String, (BTreeSet<&'static str>, TvAnnouncement)> = HashMap::new();
    for one in heard {
        let Some(address) = one
            .addresses
            .iter()
            .find_map(|address| read_tv_address(&address.to_string()))
        else {
            continue;
        };
        let (services, entry) = found.entry(address).or_default();
        services.insert(service_name(one.service));
        if one.port != 0 {
            entry
                .ports
                .insert(service_name(one.service).to_string(), one.port);
        }
        if one.service == TvService::Googlecast {
            entry.cast_model = txt_value(&one.txt, "md").or(entry.cast_model.take());
            entry.name = txt_value(&one.txt, "fn").or(entry.name.take());
        }
    }
    found
        .into_iter()
        .map(|(address, (services, mut entry))| {
            entry.services = TV_SERVICE_TYPES
                .iter()
                .map(|(service, _)| *service)
                .filter(|service| services.contains(service_name(*service)))
                .collect();
            entry.name = entry.name.or_else(|| entry.cast_model.clone());
            (address, entry)
        })
        .collect()
}

fn numeric(host: &str) -> u64 {
    host.split('.').fold(0u64, |sum, part| {
        sum * 256 + part.parse::<u64>().unwrap_or(0)
    })
}

/// Every TV found, by address: the port sweep's and the announced, one entry per address, in numeric order.
pub fn merge_found(open: &[String], heard: &BTreeMap<String, TvAnnouncement>) -> Vec<String> {
    let all: BTreeSet<&String> = open.iter().chain(heard.keys()).collect();
    let mut hosts: Vec<String> = all.into_iter().cloned().collect();
    hosts.sort_by_key(|host| numeric(host));
    hosts
}

/// The names TVs gave themselves, for the addresses that gave one.
pub fn names_of(heard: &BTreeMap<String, TvAnnouncement>) -> BTreeMap<String, String> {
    heard
        .iter()
        .filter_map(|(host, tv)| tv.name.clone().map(|name| (host.clone(), name)))
        .collect()
}

/// What is known about a TV before connecting: what it announced, and whether the classic port answered.
pub fn sighting_of(heard: Option<&TvAnnouncement>, adb_open: bool) -> TvSighting {
    TvSighting {
        services: heard.map(|tv| tv.services.clone()).unwrap_or_default(),
        cast_model: heard.and_then(|tv| tv.cast_model.clone()),
        adb_open,
    }
}

/// When the query goes out, from the start: every `RESEND` for as long as the
/// search listens. Windows Defender Firewall lets unicast answers to a multicast
/// through for 3 seconds after it was sent, so a gap under that keeps every moment
/// of the listen covered without any inbound rule.
pub fn ask_times(listen: Duration) -> Vec<Duration> {
    let mut times = vec![Duration::ZERO];
    while let Some(next) = times
        .last()
        .map(|last| *last + RESEND)
        .filter(|next| *next < listen)
    {
        times.push(next);
    }
    times
}

/// This computer's private IPv4 addresses, one per interface the query goes out on.
fn local_addresses() -> Vec<Ipv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match &interface.addr {
            if_addrs::IfAddr::V4(address) if !interface.is_loopback() => Some(address.ip),
            _ => None,
        })
        .filter(|ip| read_tv_address(&ip.to_string()).is_some())
        .collect()
}

/// A socket on one interface's own address and a port the system picks, sending
/// to the group out of that interface. Never port 5353 and never the wildcard
/// address, and no multicast group joined: that is what a program listening for
/// the network looks like, and what makes Windows ask to let it through.
pub fn open_query_socket(local: Ipv4Addr) -> std::io::Result<UdpSocket> {
    let socket = socket2::Socket::new(
        socket2::Domain::IPV4,
        socket2::Type::DGRAM,
        Some(socket2::Protocol::UDP),
    )?;
    socket.bind(&SocketAddrV4::new(local, 0).into())?;
    // The address is bound, so the system's default route for the group still works without it.
    let _ = socket.set_multicast_if_v4(&local);
    socket.set_nonblocking(true)?;
    UdpSocket::from_std(socket.into())
}

/// The next datagram any of the sockets received, with its sender.
fn receive_any<'a>(
    sockets: &'a [UdpSocket],
    buffer: &'a mut [u8],
) -> impl Future<Output = (usize, SocketAddr)> + 'a {
    std::future::poll_fn(move |context| {
        for socket in sockets {
            // A failed read (Windows reports an earlier send's ICMP error on the next one) is skipped, a few at most.
            for _ in 0..8 {
                let mut read = tokio::io::ReadBuf::new(buffer);
                match socket.poll_recv_from(context, &mut read) {
                    Poll::Ready(Ok(from)) => return Poll::Ready((read.filled().len(), from)),
                    Poll::Ready(Err(_)) => continue,
                    Poll::Pending => break,
                }
            }
        }
        Poll::Pending
    })
}

/// Asks the network for TVs for `listen` and returns what answered, or until
/// `cancel` finishes. The query goes out on each interface from that interface's
/// own address and a port other than 5353, with the unicast-response bit set: a
/// responder answers such a query by unicast straight back to that port (RFC 6762
/// 5.1, 5.4 and 6.7), which the firewall lets in as the answer to what was sent.
/// Never fails: a network that cannot be asked finds nothing.
pub async fn browse_tvs(
    listen: Duration,
    cancel: impl Future<Output = ()>,
) -> BTreeMap<String, TvAnnouncement> {
    browse_on(&local_addresses(), listen, cancel).await
}

/// `browse_tvs` on the given interface addresses.
pub async fn browse_on(
    locals: &[Ipv4Addr],
    listen: Duration,
    cancel: impl Future<Output = ()>,
) -> BTreeMap<String, TvAnnouncement> {
    let sockets: Vec<UdpSocket> = locals
        .iter()
        .filter_map(|local| open_query_socket(*local).ok())
        .collect();
    if sockets.is_empty() {
        return BTreeMap::new();
    }
    let query = tv_query();
    let group = SocketAddr::from((MDNS_GROUP, MDNS_PORT));
    let start = tokio::time::Instant::now();
    let deadline = start + listen;
    let mut asks = ask_times(listen)
        .into_iter()
        .map(|at| start + at)
        .peekable();
    let mut packets = Vec::new();
    let collect = async {
        let mut buffer = vec![0u8; 9_000];
        loop {
            let next_ask = asks.peek().copied();
            tokio::select! {
                biased;
                () = tokio::time::sleep_until(deadline) => break,
                () = tokio::time::sleep_until(next_ask.unwrap_or(deadline)), if next_ask.is_some() => {
                    asks.next();
                    for socket in &sockets {
                        // An interface that went away meanwhile.
                        let _ = socket.send_to(&query, group).await;
                    }
                }
                (length, from) = receive_any(&sockets, &mut buffer) => {
                    if let SocketAddr::V4(from) = from {
                        packets.push(MdnsPacket { data: buffer[..length].to_vec(), from: *from.ip() });
                    }
                }
            }
        }
    };
    tokio::select! {
        () = collect => {}
        () = cancel => {}
    }
    collect_packets(&packets)
}
