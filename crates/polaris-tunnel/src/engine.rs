//! The tunnel itself: one WireGuard peer over a UDP socket, a userspace TCP stack
//! for the TCP forwards, and UDP carried as UDP.
//!
//! One task owns all of the state: the WireGuard session, the TCP stack and both
//! UDP session tables. Everything else - accepted connections, public UDP
//! sockets, per-flow sockets towards a local service - talks to it over bounded
//! channels and is refused (dropped) rather than queued when those are full, so
//! memory has a ceiling whatever arrives.
//!
//! UDP never waits behind anything: each datagram is wrapped into one IP packet,
//! encrypted and sent on its own, so a datagram lost on the way delays nothing
//! after it. Only the TCP forwards retransmit, each connection by itself.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use boringtun::noise::errors::WireGuardError;
use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpListenEndpoint};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, Notify};
use tokio::task::JoinHandle;

use crate::config::{Config, Peer};
use crate::fragment::{self, Joined, Reassembly};
use crate::packet::{self, Parsed};
use crate::session::{PortPool, SessionTable};

/// Ceilings on everything the daemon holds. TCP buffers are bounded by
/// `tcp_memory` together (pages a quiet connection never touched are not even
/// resident), the rest by a few megabytes of queues.
#[derive(Debug, Clone)]
pub struct Limits {
    pub max_tcp: usize,
    /// Connections one address may hold through a `[TCPClientTunnel]` listener.
    pub max_tcp_per_source: usize,
    pub backlog: usize,
    /// Each connection's receive and send buffer while memory is plentiful
    /// (`tcp_buffer_max`), and the floor it falls back to.
    pub tcp_buffer: usize,
    pub tcp_buffer_max: usize,
    /// What every TCP buffer together may reserve: half of it for full-size
    /// buffers, the rest only for floor-size ones, then new connections wait.
    pub tcp_memory: usize,
    /// A connection half closed (or closing) that moves nothing for this long
    /// is ended. An open connection is never ended for being quiet.
    pub stuck_timeout: Duration,
    /// An open connection whose peer has accepted none of its pending data for
    /// this long (a window held at zero) is ended.
    pub zero_window_timeout: Duration,
    /// A peer not heard from for this long is out of reach, and the time it
    /// stays out of reach does not count towards the two timeouts above: an
    /// outage ends no connection, however long it lasts.
    pub peer_quiet: Duration,
    /// Packets waiting for the TCP stack, either way.
    pub device_queue: usize,
    /// Datagrams and accepted connections waiting for the engine.
    pub event_queue: usize,
    /// How often an end that dials out tries again while it has no handshake.
    pub retry: Duration,
    /// A handshake older than this on the dialling end is a link that stopped.
    pub stale_handshake: Duration,
    /// Datagrams half-joined from fragments, the bytes they hold, and how long
    /// one waits for its last fragment (the IP stack's own figure).
    pub reassembly_entries: usize,
    pub reassembly_bytes: usize,
    pub reassembly_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            // Every port of the dynamic range a connection can be dialled from.
            max_tcp: 16384,
            max_tcp_per_source: 1024,
            backlog: 64,
            tcp_buffer: 64 * 1024,
            tcp_buffer_max: 1024 * 1024,
            tcp_memory: 1024 * 1024 * 1024,
            stuck_timeout: Duration::from_secs(120),
            zero_window_timeout: Duration::from_secs(300),
            // Three times the longest retransmission interval: a peer in reach
            // answers a probe well within it.
            peer_quiet: Duration::from_secs(30),
            device_queue: 1024,
            event_queue: 4096,
            retry: Duration::from_secs(5),
            stale_handshake: Duration::from_secs(150),
            reassembly_entries: 256,
            reassembly_bytes: 4 * 1024 * 1024,
            reassembly_timeout: Duration::from_secs(30),
        }
    }
}

/// What `/metrics` reports, refreshed by the engine several times a second.
#[derive(Debug, Clone, Default)]
pub struct Status {
    pub listen_port: u16,
    pub public_key: [u8; 32],
    pub endpoint: Option<SocketAddr>,
    pub last_handshake: Option<SystemTime>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub keepalive: u16,
    pub allowed_ips: Vec<String>,
    pub counters: Counters,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Counters {
    pub udp_sessions: u64,
    pub tcp_connections: u64,
    pub handshakes: u64,
    /// Dropped because a queue or table was full.
    pub dropped_full: u64,
    /// Dropped because it was not a packet the daemon can read.
    pub dropped_malformed: u64,
    /// Dropped because its addresses are not the peer's or ours.
    pub dropped_unrouted: u64,
    /// WireGuard datagrams that failed to authenticate or decrypt.
    pub rejected_wire: u64,
    /// UDP datagrams too large for one packet of the MTU, sent as fragments.
    pub fragmented_out: u64,
    /// Datagrams joined again from the peer's fragments.
    pub reassembled_in: u64,
}

enum Event {
    ProxyIn(usize, SocketAddr, Vec<u8>),
    FlowReply(u64, Vec<u8>),
    Accept(usize, TcpStream),
    Endpoint(Vec<SocketAddr>),
    ServerTarget(usize, Option<SocketAddr>),
}

/// The packet queues between the TCP stack and the tunnel.
struct Phy {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
    mtu: usize,
    cap: usize,
}

struct RxToken(Vec<u8>);
struct TxToken<'a>(&'a mut VecDeque<Vec<u8>>, usize);

impl phy::RxToken for RxToken {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

impl phy::TxToken for TxToken<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0u8; len];
        let result = f(&mut buf);
        if self.0.len() < self.1 {
            self.0.push_back(buf);
        }
        result
    }
}

impl phy::Device for Phy {
    type RxToken<'a> = RxToken;
    type TxToken<'a> = TxToken<'a>;

    fn receive(&mut self, _: smoltcp::time::Instant) -> Option<(RxToken, TxToken<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((RxToken(packet), TxToken(&mut self.tx, self.cap)))
    }

    fn transmit(&mut self, _: smoltcp::time::Instant) -> Option<TxToken<'_>> {
        let cap = self.cap;
        (self.tx.len() < cap).then_some(TxToken(&mut self.tx, cap))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = self.mtu;
        caps
    }
}

/// One TCP connection between the stack and a local stream.
struct Conn {
    to_local: Option<mpsc::Sender<Vec<u8>>>,
    from_local: mpsc::Receiver<Vec<u8>>,
    pending: Option<(Vec<u8>, usize)>,
    local_done: bool,
    closed: bool,
    /// Seen finished once: removed on the next pass, after the stack has sent
    /// its last segment (a reset, or the final ACK).
    reaped: bool,
    port: Option<u16>,
    /// The client's address, for a connection accepted on a public listener.
    source: Option<IpAddr>,
    /// When bytes last moved either way, or the peer took some of ours.
    progress: Instant,
    queued: usize,
    /// Dropped with the connection: tells the local stream's task to finish.
    _alive: mpsc::Receiver<()>,
}

struct Listener {
    port: u16,
    target: String,
    sockets: Vec<SocketHandle>,
}

struct Proxy {
    socket: Arc<UdpSocket>,
    target: SocketAddr,
    /// Client address to the port it has on the tunnel address.
    table: SessionTable<SocketAddr, u16>,
}

struct Server {
    port: u16,
    target: String,
    resolved: Option<SocketAddr>,
    resolving: bool,
    resolved_at: Option<Instant>,
    /// Sender inside the tunnel to the flow's id.
    table: SessionTable<SocketAddr, u64>,
}

struct Flow {
    socket: Arc<UdpSocket>,
    task: JoinHandle<()>,
    server: usize,
    remote: SocketAddr,
    /// Where the flow's socket sends: the target as it resolved when it opened.
    target: SocketAddr,
}

/// How often a `[UDPServerTunnel]` target given by name is looked up again while
/// datagrams reach it. A container recreated behind that name comes back on a new
/// address; the flows still sending to the old one are closed when it is seen, so
/// a stream that never pauses (a keepalive every 25 s) cannot keep a dead address.
const RESOLVE_EVERY: Duration = Duration::from_secs(5);

/// How often the dialling end looks its peer's name up again, so a peer
/// recreated on a new address is found in seconds.
const RESOLVE_ENDPOINT_EVERY: Duration = Duration::from_secs(5);
/// A handshake initiation with no answer for this long means the peer is not
/// where this end is sending (WireGuard's own REKEY_TIMEOUT).
const UNANSWERED: Duration = Duration::from_secs(5);
/// A session older than this is dead (WireGuard's REJECT_AFTER_TIME).
const SESSION_LIFETIME: Duration = Duration::from_secs(180);
/// At most one handshake per this, started because data arrived for a lost session.
const ANSWER_EVERY: Duration = Duration::from_secs(1);
/// How often the timers run, whatever else keeps the engine busy.
const TICK: Duration = Duration::from_millis(100);
/// Wire datagrams and events handled per turn, so neither can starve the other.
const WIRE_BATCH: usize = 64;
const EVENT_BATCH: usize = 256;
/// Rounds of the TCP stack per turn at most: the stack sends one segment per
/// connection on each poll, so this also bounds the burst one turn puts on the
/// wire (more measured slower: bursts overflow socket buffers on the way).
const SERVICE_ROUNDS: usize = 4;
/// How long a local stream may take to accept the last bytes of a connection
/// the engine has already finished with.
const DRAIN_GRACE: Duration = Duration::from_secs(60);

impl Drop for Flow {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A running daemon, as `start` hands it back.
pub struct Handle {
    /// Where the WireGuard socket listens.
    pub wire_addr: SocketAddr,
    /// Where each `[TCPClientTunnel]` listens, in file order.
    pub tcp_client_addrs: Vec<SocketAddr>,
    /// Where each `[UDPProxyTunnel]` listens, in file order.
    pub udp_proxy_addrs: Vec<SocketAddr>,
    pub status: Arc<Mutex<Status>>,
    streams: Arc<AtomicUsize>,
    shutdown: Option<oneshot::Sender<()>>,
    tasks: Vec<JoinHandle<()>>,
    engine: Option<JoinHandle<()>>,
}

impl Handle {
    /// Local TCP streams still open, for the tests that check none is left behind.
    #[doc(hidden)]
    pub fn local_streams(&self) -> usize {
        self.streams.load(Ordering::Relaxed)
    }

    /// Stop everything and wait for the engine to finish.
    pub async fn stop(mut self) {
        self.halt();
        if let Some(engine) = self.engine.take() {
            let _ = engine.await;
        }
    }

    fn halt(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        for task in &self.tasks {
            task.abort();
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.halt();
        if let Some(engine) = &self.engine {
            engine.abort();
        }
    }
}

pub fn log(message: &str) {
    if !crate::SILENT.load(std::sync::atomic::Ordering::Relaxed) {
        eprintln!("polaris-tunnel: {message}");
    }
}

fn resolve(host: &str) -> Option<SocketAddr> {
    resolve_all(host).first().copied()
}

/// Every address `host` resolves to, pinned names first.
fn resolve_all(host: &str) -> Vec<SocketAddr> {
    if let Some(found) = resolve_pinned(host) {
        return vec![found];
    }
    host.to_socket_addrs()
        .map(|a| a.collect())
        .unwrap_or_default()
}

fn resolve_pinned(host: &str) -> Option<SocketAddr> {
    PINNED
        .lock()
        .ok()
        .and_then(|p| p.iter().find(|(n, _)| n == host).map(|(_, a)| *a))
}

/// Resolve off the engine's thread and hand the answer back as an event. The
/// answer waits for room in the queue: dropping it would leave the name marked
/// as being resolved, and never looked up again.
fn look_up(events: mpsc::Sender<Event>, event: impl FnOnce() -> Event + Send + 'static) {
    tokio::task::spawn_blocking(move || {
        let _ = events.blocking_send(event());
    });
}

/// Names pinned to an address ahead of the system resolver, for the tests that
/// move a target the way a recreated container moves: nothing else sets them.
static PINNED: Mutex<Vec<(String, SocketAddr)>> = Mutex::new(Vec::new());

/// Pin `host` (`name:port`, as a config writes it) to `to`, or unpin it.
#[doc(hidden)]
pub fn pin_name(host: &str, to: Option<SocketAddr>) {
    if let Ok(mut pinned) = PINNED.lock() {
        pinned.retain(|(n, _)| n != host);
        if let Some(to) = to {
            pinned.push((host.to_string(), to));
        }
    }
}

/// Bind every socket and start the engine.
pub async fn start(config: Config, limits: Limits) -> io::Result<Handle> {
    let peer = config.peer.clone();
    let mut endpoint = peer
        .endpoint
        .as_deref()
        .and_then(|e| e.parse::<SocketAddr>().ok());
    // A name is looked up now so the socket is bound in the family it resolves
    // to; the engine keeps looking it up afterwards.
    if let (None, Some(host)) = (endpoint, peer.endpoint.clone()) {
        let lookup = tokio::task::spawn_blocking(move || resolve_all(&host));
        if let Ok(Ok(found)) = tokio::time::timeout(Duration::from_secs(5), lookup).await {
            endpoint = found.first().copied();
        }
    }
    let v6_wire = endpoint.is_some_and(|e| e.is_ipv6());
    let unspecified: IpAddr = if v6_wire {
        Ipv6Addr::UNSPECIFIED.into()
    } else {
        Ipv4Addr::UNSPECIFIED.into()
    };
    let wire = Arc::new(
        UdpSocket::bind(SocketAddr::new(
            unspecified,
            config.interface.listen_port.unwrap_or(0),
        ))
        .await?,
    );
    let wire_addr = wire.local_addr()?;

    let (events, event_rx) = mpsc::channel(limits.event_queue);
    let notify = Arc::new(Notify::new());
    let mut tasks = Vec::new();

    let mut tcp_client_addrs = Vec::new();
    for (index, forward) in config.tcp_clients.iter().enumerate() {
        let listener = TcpListener::bind(forward.bind).await?;
        tcp_client_addrs.push(listener.local_addr()?);
        let events = events.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let _ = stream.set_nodelay(true);
                        if events.send(Event::Accept(index, stream)).await.is_err() {
                            return;
                        }
                    }
                    // Out of descriptors and the like: wait instead of spinning.
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            }
        }));
    }

    let door = Arc::new(AtomicU64::new(0));
    let mut proxies = Vec::new();
    let mut udp_proxy_addrs = Vec::new();
    for (index, forward) in config.udp_proxies.iter().enumerate() {
        let socket = Arc::new(UdpSocket::bind(forward.bind).await?);
        udp_proxy_addrs.push(socket.local_addr()?);
        let reader = socket.clone();
        let events = events.clone();
        let door = door.clone();
        tasks.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.recv_from(&mut buf).await {
                    Ok((n, from)) => {
                        if events
                            .try_send(Event::ProxyIn(index, from, buf[..n].to_vec()))
                            .is_err()
                        {
                            if events.is_closed() {
                                return;
                            }
                            door.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    // An ICMP error for an earlier send; the socket is still good.
                    Err(_) => tokio::task::yield_now().await,
                }
            }
        }));
        proxies.push(Proxy {
            socket,
            target: forward.target,
            table: SessionTable::new(forward.max_sessions, forward.idle),
        });
    }

    let servers = config
        .udp_servers
        .iter()
        .map(|s| Server {
            port: s.listen_port,
            target: s.target.clone(),
            resolved: s.target.parse().ok(),
            resolving: false,
            resolved_at: None,
            table: SessionTable::new(s.max_sessions, s.idle),
        })
        .collect();

    let status = Arc::new(Mutex::new(Status::default()));
    let streams = Arc::new(AtomicUsize::new(0));
    let secret = StaticSecret::from(config.interface.private_key);
    let tunn = Tunn::new(
        secret,
        PublicKey::from(peer.public_key),
        peer.preshared_key,
        peer.keepalive,
        rand_index(),
        None,
    );

    let mtu = usize::from(config.interface.mtu);
    let mut phy = Phy {
        rx: VecDeque::new(),
        tx: VecDeque::new(),
        mtu,
        cap: limits.device_queue,
    };
    let mut iface = Interface::new(
        IfaceConfig::new(HardwareAddress::Ip),
        &mut phy,
        smoltcp::time::Instant::from_millis(0),
    );
    iface.update_ip_addrs(|addrs| {
        for a in &config.interface.addresses {
            let _ = addrs.push(IpCidr::new(IpAddress::from(a.addr), a.prefix));
        }
    });
    for a in &config.interface.addresses {
        // Every destination is the peer's: the route only has to exist.
        let _ = match a.addr {
            IpAddr::V4(v4) => iface.routes_mut().add_default_ipv4_route(v4).map(|_| ()),
            IpAddr::V6(v6) => iface.routes_mut().add_default_ipv6_route(v6).map(|_| ()),
        };
    }

    let reassembly = Reassembly::new(
        limits.reassembly_entries,
        limits.reassembly_bytes,
        limits.reassembly_timeout,
    );
    let mut engine = Engine {
        limits,
        started: Instant::now(),
        wire,
        tunn,
        peer,
        endpoint,
        v6_wire,
        resolved: endpoint.into_iter().collect(),
        resolving: false,
        last_resolve: endpoint.map(|_| Instant::now()),
        last_init: None,
        init_sent: None,
        heard: None,
        last_answer: None,
        iface,
        phy,
        sockets: SocketSet::new(Vec::new()),
        conns: HashMap::new(),
        listeners: Vec::new(),
        tcp_targets: config.tcp_clients.iter().map(|c| c.target).collect(),
        tcp_ports: reserved_pool(config.tcp_servers.iter().map(|s| s.listen_port)),
        udp_ports: reserved_pool(config.udp_servers.iter().map(|s| s.listen_port)),
        tcp_reserved: 0,
        per_source: HashMap::new(),
        proxies,
        ephemeral: HashMap::new(),
        servers,
        flows: HashMap::new(),
        next_flow: 0,
        addresses: config.interface.addresses.iter().map(|a| a.addr).collect(),
        events: events.clone(),
        notify,
        status: status.clone(),
        streams: streams.clone(),
        counters: Counters::default(),
        door,
        out: vec![0u8; 65536 + 256],
        listen_port: wire_addr.port(),
        last_sweep: Instant::now(),
        reassembly,
        next_ip_id: rand_index(),
        fragments: Vec::new(),
    };
    for server in &config.tcp_servers {
        engine.listeners.push(Listener {
            port: server.listen_port,
            target: server.target.clone(),
            sockets: Vec::new(),
        });
    }
    engine.refill_listeners();
    engine.dial();
    engine.publish_status();

    let (shutdown, shutdown_rx) = oneshot::channel();
    let engine = tokio::spawn(engine.run(event_rx, shutdown_rx));
    Ok(Handle {
        wire_addr,
        tcp_client_addrs,
        udp_proxy_addrs,
        status,
        streams,
        shutdown: Some(shutdown),
        tasks,
        engine: Some(engine),
    })
}

/// A pool of the dynamic range without the ports configured listeners use, so
/// replies to a flow opened from one never reach the listener instead.
fn reserved_pool(ports: impl Iterator<Item = u16>) -> PortPool {
    let mut pool = PortPool::default();
    for port in ports {
        pool.reserve(port);
    }
    pool
}

/// A session index nobody else is likely to pick: WireGuard only needs it to
/// differ between this end's own sessions and to change across restarts.
fn rand_index() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos ^ std::process::id().rotate_left(13)) & 0x00ff_ffff
}

struct Engine {
    limits: Limits,
    started: Instant,
    wire: Arc<UdpSocket>,
    tunn: Tunn,
    peer: Peer,
    endpoint: Option<SocketAddr>,
    v6_wire: bool,
    /// What the endpoint's name resolved to last time.
    resolved: Vec<SocketAddr>,
    resolving: bool,
    last_resolve: Option<Instant>,
    last_init: Option<Instant>,
    /// When the oldest handshake initiation still unanswered went out.
    init_sent: Option<Instant>,
    /// When the peer last proved itself with a datagram.
    heard: Option<Instant>,
    last_answer: Option<Instant>,
    iface: Interface,
    phy: Phy,
    sockets: SocketSet<'static>,
    conns: HashMap<SocketHandle, Conn>,
    listeners: Vec<Listener>,
    tcp_targets: Vec<SocketAddr>,
    tcp_ports: PortPool,
    udp_ports: PortPool,
    /// Bytes of TCP buffers held by every socket.
    tcp_reserved: usize,
    /// Connections each client address holds through the public listeners.
    per_source: HashMap<IpAddr, usize>,
    proxies: Vec<Proxy>,
    /// A port on the tunnel address to the proxy and client it belongs to.
    ephemeral: HashMap<u16, (usize, SocketAddr)>,
    servers: Vec<Server>,
    flows: HashMap<u64, Flow>,
    next_flow: u64,
    addresses: Vec<IpAddr>,
    events: mpsc::Sender<Event>,
    notify: Arc<Notify>,
    status: Arc<Mutex<Status>>,
    streams: Arc<AtomicUsize>,
    counters: Counters,
    /// Datagrams the readers dropped because the engine's queue was full.
    door: Arc<AtomicU64>,
    out: Vec<u8>,
    listen_port: u16,
    last_sweep: Instant,
    reassembly: Reassembly,
    /// The identification of the next datagram sent as fragments.
    next_ip_id: u32,
    fragments: Vec<Vec<u8>>,
}

/// Send one datagram to the peer. A full socket buffer drops it, as a router would.
fn wire_send(wire: &UdpSocket, to: Option<SocketAddr>, datagram: &[u8]) {
    if let Some(to) = to {
        let _ = wire.try_send_to(datagram, to);
    }
}

impl Engine {
    fn now(&self) -> smoltcp::time::Instant {
        smoltcp::time::Instant::from_micros(self.started.elapsed().as_micros() as i64)
    }

    async fn run(mut self, mut events: mpsc::Receiver<Event>, mut shutdown: oneshot::Receiver<()>) {
        let mut buf = vec![0u8; 65536];
        let mut last_tick = Instant::now();
        loop {
            let now = self.now();
            let delay = self
                .iface
                .poll_delay(now, &self.sockets)
                .map(|d| Duration::from_micros(d.total_micros()))
                .unwrap_or(TICK)
                .min(TICK.saturating_sub(last_tick.elapsed()));
            let wire = self.wire.clone();
            let notify = self.notify.clone();
            tokio::select! {
                biased;
                _ = &mut shutdown => break,
                received = wire.recv_from(&mut buf) => {
                    if let Ok((n, from)) = received {
                        self.on_wire(from, &buf[..n]);
                    }
                }
                event = events.recv() => {
                    let Some(event) = event else { break };
                    self.on_event(event);
                }
                _ = notify.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            // Whatever woke the loop, the wire and the events each get a bounded
            // turn and the timers run on time: a flood on one side cannot starve
            // flow replies, accepted connections, rekeys or the sweeps.
            for _ in 0..WIRE_BATCH {
                match wire.try_recv_from(&mut buf) {
                    Ok((n, from)) => self.on_wire(from, &buf[..n]),
                    Err(_) => break,
                }
            }
            for _ in 0..EVENT_BATCH {
                match events.try_recv() {
                    Ok(event) => self.on_event(event),
                    Err(_) => break,
                }
            }
            if last_tick.elapsed() >= TICK {
                last_tick = Instant::now();
                self.on_tick();
            }
            self.service();
        }
        log("stopping");
    }

    /// Run the TCP stack, move data between it and the local streams, and send
    /// what it produced.
    fn service(&mut self) {
        for _ in 0..SERVICE_ROUNDS {
            let now = self.now();
            self.iface.poll(now, &mut self.phy, &mut self.sockets);
            let moved = self.pump_tcp();
            let now = self.now();
            self.iface.poll(now, &mut self.phy, &mut self.sockets);
            let sent = !self.phy.tx.is_empty();
            while let Some(packet) = self.phy.tx.pop_front() {
                self.send_into_tunnel(&packet);
            }
            if !moved && !sent && self.phy.rx.is_empty() {
                break;
            }
        }
    }

    /// One IP packet into the tunnel, if its destination is the peer's.
    fn send_into_tunnel(&mut self, packet: &[u8]) {
        let Some((_, dst)) = packet::addresses(packet) else {
            self.counters.dropped_malformed += 1;
            return;
        };
        if !self.peer.allowed_ips.iter().any(|c| c.contains(dst)) {
            self.counters.dropped_unrouted += 1;
            return;
        }
        let to = self.endpoint;
        // Anything else is queued until a handshake completes, or refused:
        // either way there is nothing to send now.
        if let TunnResult::WriteToNetwork(datagram) = self.tunn.encapsulate(packet, &mut self.out) {
            wire_send(&self.wire, to, datagram);
        }
    }

    fn on_wire(&mut self, from: SocketAddr, datagram: &[u8]) {
        // Empty is how the session is asked for its queue: never from the network.
        if datagram.is_empty() {
            self.counters.rejected_wire += 1;
            return;
        }
        let kind = datagram.first().copied();
        let mut input = datagram;
        loop {
            let result = self.tunn.decapsulate(Some(from.ip()), input, &mut self.out);
            let repeat = input.is_empty();
            input = &[];
            match result {
                TunnResult::Done => {
                    if !repeat {
                        self.authenticated(kind, from);
                    }
                    break;
                }
                TunnResult::Err(e) => {
                    if !repeat {
                        self.counters.rejected_wire += 1;
                        if kind == Some(4) && matches!(e, WireGuardError::NoCurrentSession) {
                            self.answer_lost_session(from);
                        }
                    }
                    break;
                }
                // Queued packets released by a proven handshake: to the peer.
                TunnResult::WriteToNetwork(queued) if repeat => {
                    wire_send(&self.wire, self.endpoint, queued);
                }
                TunnResult::WriteToNetwork(reply) => {
                    // The keepalive that completes a handshake proves the sender.
                    // A handshake response or a cookie reply proves nothing: under
                    // load boringtun answers a handshake with a cookie before it
                    // checks anything but the public-key MAC.
                    let proof = reply.first() == Some(&4);
                    wire_send(&self.wire, Some(from), reply);
                    if !proof {
                        break;
                    }
                    self.authenticated(kind, from);
                }
                TunnResult::WriteToTunnelV4(packet, _) | TunnResult::WriteToTunnelV6(packet, _) => {
                    let packet = packet.to_vec();
                    self.authenticated(kind, from);
                    self.deliver_from_tunnel(&packet);
                    break;
                }
            }
        }
    }

    /// The peer proved itself from `from`: that is where it is now.
    fn authenticated(&mut self, kind: Option<u8>, from: SocketAddr) {
        // A handshake initiation is answered where it came from but moves nothing:
        // anyone who knows this end's public key can produce one that passes the
        // first check, and only a response or data proves the peer's key.
        if !matches!(kind, Some(2) | Some(4)) {
            return;
        }
        self.init_sent = None;
        self.heard = Some(Instant::now());
        if self.endpoint != Some(from) {
            if self.endpoint.is_some() {
                log(&format!("peer moved to {from}"));
            }
            self.endpoint = Some(from);
        }
        if kind == Some(2) {
            self.counters.handshakes += 1;
        }
    }

    /// Start a handshake with the peer, at most once per retry interval.
    /// `force` replaces one already in flight.
    fn initiate(&mut self, force: bool) {
        if self
            .last_init
            .is_some_and(|t| t.elapsed() < self.limits.retry)
        {
            return;
        }
        let Some(to) = self.endpoint else {
            return;
        };
        self.last_init = Some(Instant::now());
        if let TunnResult::WriteToNetwork(init) =
            self.tunn.format_handshake_initiation(&mut self.out, force)
        {
            wire_send(&self.wire, Some(to), init);
            self.init_sent.get_or_insert_with(Instant::now);
        }
    }

    /// Data encrypted for a session this end does not have: this end restarted,
    /// or the peer did. A handshake from here ends that at once instead of at the
    /// peer's next rekey. Anyone can send such a packet, so it only counts when
    /// this end has no live session, goes to the peer this end knows rather than
    /// to the sender when there is one, and at most once a second.
    ///
    /// An end that knows no peer address yet (the listening end, just
    /// restarted) has every earlier initiation in flight sent nowhere: a local
    /// packet or a timer started it with no endpoint to send it to. Waiting on
    /// it would leave the session down until the peer's own rekey, so that end
    /// replaces it with one sent to `from`; the once-a-second bound still holds.
    fn answer_lost_session(&mut self, from: SocketAddr) {
        let live = self
            .tunn
            .time_since_last_handshake()
            .is_some_and(|age| age < SESSION_LIFETIME);
        if live || self.last_answer.is_some_and(|t| t.elapsed() < ANSWER_EVERY) {
            return;
        }
        self.last_answer = Some(Instant::now());
        let (to, replace) = match self.endpoint {
            Some(known) => (known, false),
            None => (from, true),
        };
        if let TunnResult::WriteToNetwork(init) = self
            .tunn
            .format_handshake_initiation(&mut self.out, replace)
        {
            wire_send(&self.wire, Some(to), init);
            self.init_sent.get_or_insert_with(Instant::now);
        }
    }

    fn stale(&self) -> bool {
        self.tunn
            .time_since_last_handshake()
            .is_none_or(|age| age > self.limits.stale_handshake)
    }

    /// A handshake went out and nothing proven came back in time.
    fn unanswered(&self) -> bool {
        self.init_sent.is_some_and(|t| t.elapsed() >= UNANSWERED)
    }

    /// The dialling end's duty: keep a handshake alive whatever happened to the
    /// link, and find the peer again if its name now points somewhere else.
    fn dial(&mut self) {
        let Some(host) = self.peer.endpoint.clone() else {
            return;
        };
        let stale = self.stale();
        let unanswered = self.unanswered();
        match host.parse::<SocketAddr>() {
            // The peer may have been heard from elsewhere and gone quiet there:
            // the configured address is where to look for it again.
            Ok(configured) => {
                if (stale || unanswered) && self.endpoint != Some(configured) {
                    log(&format!("no answer, back to {configured}"));
                    self.endpoint = Some(configured);
                    self.last_init = None;
                }
            }
            Err(_) => {
                let due = self
                    .last_resolve
                    .is_none_or(|t| t.elapsed() >= RESOLVE_ENDPOINT_EVERY);
                if !self.resolving && due {
                    self.resolving = true;
                    self.last_resolve = Some(Instant::now());
                    look_up(self.events.clone(), move || {
                        Event::Endpoint(resolve_all(&host))
                    });
                }
            }
        }
        if stale || unanswered {
            self.initiate(stale);
        }
    }

    /// The endpoint's name answered. Move only when the address in use is not
    /// among the answers and either the answers changed (the peer was
    /// recreated somewhere else) or the peer stopped answering.
    fn on_resolved(&mut self, found: Vec<SocketAddr>) {
        self.resolving = false;
        let usable: Vec<SocketAddr> = found
            .into_iter()
            .filter(|a| a.is_ipv6() == self.v6_wire)
            .collect();
        let Some(&first) = usable.first() else {
            return;
        };
        let changed = usable != self.resolved;
        self.resolved = usable;
        let elsewhere = self.endpoint.is_none_or(|e| !self.resolved.contains(&e));
        let quiet = self.endpoint.is_none() || self.stale() || self.unanswered();
        if elsewhere && (changed || quiet) {
            if self.endpoint.is_some() {
                log(&format!("the peer's name now points at {first}"));
            }
            self.endpoint = Some(first);
            self.last_init = None;
            self.initiate(true);
        }
    }

    fn on_tick(&mut self) {
        let to = self.endpoint;
        if let TunnResult::WriteToNetwork(datagram) = self.tunn.update_timers(&mut self.out) {
            if datagram.first() == Some(&1) {
                self.init_sent.get_or_insert_with(Instant::now);
            }
            wire_send(&self.wire, to, datagram);
        }
        self.dial();
        if self.last_sweep.elapsed() >= Duration::from_secs(1) {
            self.last_sweep = Instant::now();
            self.sweep(Instant::now());
        }
        self.publish_status();
    }

    fn publish_status(&mut self) {
        let (since, tx, rx, _, _) = self.tunn.stats();
        self.counters.udp_sessions = (self.ephemeral.len() + self.flows.len()) as u64;
        self.counters.tcp_connections = self.conns.len() as u64;
        if let Ok(mut status) = self.status.lock() {
            status.listen_port = self.listen_port;
            status.public_key = self.peer.public_key;
            status.endpoint = self.endpoint;
            status.last_handshake = since.and_then(|age| SystemTime::now().checked_sub(age));
            status.rx_bytes = rx as u64;
            status.tx_bytes = tx as u64;
            status.keepalive = self.peer.keepalive.unwrap_or(0);
            status.allowed_ips = self
                .peer
                .allowed_ips
                .iter()
                .map(|c| format!("{}/{}", c.addr, c.prefix))
                .collect();
            status.counters = self.counters.clone();
            status.counters.dropped_full += self.door.load(Ordering::Relaxed);
        }
    }

    fn ours(&self, ip: IpAddr) -> bool {
        self.addresses.contains(&ip)
    }

    fn address_for(&self, family_of: IpAddr) -> Option<IpAddr> {
        self.addresses
            .iter()
            .copied()
            .find(|a| a.is_ipv4() == family_of.is_ipv4())
    }

    /// A decrypted packet from the peer: a fragment waits for the rest of its
    /// datagram, which is then read as if it had arrived whole.
    fn deliver_from_tunnel(&mut self, packet: &[u8]) {
        if !fragment::is_fragment(packet) {
            self.deliver_whole(packet);
            return;
        }
        let routed = packet::addresses(packet).is_some_and(|(src, dst)| {
            self.peer.allowed_ips.iter().any(|c| c.contains(src)) && self.ours(dst)
        });
        if !routed {
            self.counters.dropped_unrouted += 1;
            return;
        }
        match self.reassembly.push(packet, Instant::now()) {
            // Joined into another fragment header: nothing a sender does on purpose.
            Joined::Whole(whole) if fragment::is_fragment(&whole) => {
                self.counters.dropped_malformed += 1
            }
            Joined::Whole(whole) => {
                self.counters.reassembled_in += 1;
                self.deliver_whole(&whole)
            }
            Joined::Waiting => {}
            Joined::Malformed => self.counters.dropped_malformed += 1,
            Joined::Full => self.counters.dropped_full += 1,
        }
    }

    fn deliver_whole(&mut self, packet: &[u8]) {
        match packet::parse(packet) {
            Err(_) => self.counters.dropped_malformed += 1,
            Ok(Parsed::Udp { src, dst, payload }) => {
                if !self.peer.allowed_ips.iter().any(|c| c.contains(src.ip()))
                    || !self.ours(dst.ip())
                {
                    self.counters.dropped_unrouted += 1;
                    return;
                }
                let payload = payload.to_vec();
                self.udp_in(src, dst, &payload);
            }
            Ok(Parsed::Tcp { src, dst }) => {
                if !self.peer.allowed_ips.iter().any(|c| c.contains(src)) || !self.ours(dst) {
                    self.counters.dropped_unrouted += 1;
                } else if self.phy.rx.len() >= self.phy.cap {
                    self.counters.dropped_full += 1;
                } else {
                    self.phy.rx.push_back(packet.to_vec());
                }
            }
            Ok(Parsed::Other { .. }) => self.counters.dropped_unrouted += 1,
        }
    }

    fn udp_in(&mut self, src: SocketAddr, dst: SocketAddr, payload: &[u8]) {
        let now = Instant::now();
        if let Some(index) = self.servers.iter().position(|s| s.port == dst.port()) {
            self.server_in(index, src, payload, now);
            return;
        }
        let Some(&(index, client)) = self.ephemeral.get(&dst.port()) else {
            self.counters.dropped_unrouted += 1;
            return;
        };
        let Some(proxy) = self.proxies.get_mut(index) else {
            return;
        };
        if src != proxy.target {
            self.counters.dropped_unrouted += 1;
            return;
        }
        proxy.table.touch(&client, now);
        let _ = proxy.socket.try_send_to(payload, client);
    }

    /// A datagram for a `[UDPServerTunnel]`: onto its flow's socket, opening one
    /// for a sender not seen before.
    fn server_in(&mut self, index: usize, src: SocketAddr, payload: &[u8], now: Instant) {
        let Some(server) = self.servers.get_mut(index) else {
            return;
        };
        let refresh = server
            .resolved_at
            .is_none_or(|t| now.saturating_duration_since(t) >= RESOLVE_EVERY);
        if server.target.parse::<SocketAddr>().is_err() && refresh && !server.resolving {
            server.resolving = true;
            server.resolved_at = Some(now);
            let host = server.target.clone();
            look_up(self.events.clone(), move || {
                Event::ServerTarget(index, resolve(&host))
            });
        }
        if let Some(id) = server.table.touch(&src, now).map(|id| *id) {
            if let Some(flow) = self.flows.get(&id) {
                let _ = flow.socket.try_send(payload);
            }
            return;
        }
        let Some(target) = server.resolved else {
            self.counters.dropped_unrouted += 1;
            return;
        };
        let socket = match open_flow_socket(target, payload) {
            Ok(s) => Arc::new(s),
            Err(_) => {
                self.counters.dropped_full += 1;
                return;
            }
        };
        let id = self.next_flow;
        match server.table.insert(src, id, now) {
            Ok(expired) => {
                for (_, gone) in expired {
                    self.flows.remove(&gone);
                }
            }
            Err(_) => {
                self.counters.dropped_full += 1;
                return;
            }
        }
        self.next_flow += 1;
        let reader = socket.clone();
        let events = self.events.clone();
        let door = self.door.clone();
        let task = tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                match reader.recv(&mut buf).await {
                    Ok(n) => {
                        if events
                            .try_send(Event::FlowReply(id, buf[..n].to_vec()))
                            .is_err()
                        {
                            if events.is_closed() {
                                return;
                            }
                            door.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    // The service is not listening yet (an ICMP came back): keep the flow.
                    Err(_) => tokio::time::sleep(Duration::from_millis(10)).await,
                }
            }
        });
        self.flows.insert(
            id,
            Flow {
                socket,
                task,
                server: index,
                remote: src,
                target,
            },
        );
    }

    fn on_event(&mut self, event: Event) {
        match event {
            Event::ProxyIn(index, client, data) => self.proxy_out(index, client, &data),
            Event::FlowReply(id, data) => {
                let Some(flow) = self.flows.get(&id) else {
                    return;
                };
                let (server, remote) = (flow.server, flow.remote);
                let Some(port) = self.servers.get_mut(server).map(|s| {
                    s.table.touch(&remote, Instant::now());
                    s.port
                }) else {
                    return;
                };
                self.udp_out(port, remote, &data);
            }
            Event::Accept(index, stream) => self.accept(index, stream),
            Event::Endpoint(found) => self.on_resolved(found),
            Event::ServerTarget(index, found) => {
                let Some(server) = self.servers.get_mut(index) else {
                    return;
                };
                server.resolving = false;
                let Some(found) = found else {
                    return;
                };
                server.resolved = Some(found);
                // Flows to the address the name no longer has: the next datagram
                // from each sender opens a new one to where the name points now.
                let stale: Vec<(u64, SocketAddr)> = self
                    .flows
                    .iter()
                    .filter(|(_, f)| f.server == index && f.target != found)
                    .map(|(id, f)| (*id, f.remote))
                    .collect();
                for (id, remote) in stale {
                    server.table.remove(&remote);
                    self.flows.remove(&id);
                }
            }
        }
    }

    /// A datagram from the tunnel's side of this end, wrapped and sent.
    fn udp_out(&mut self, local_port: u16, remote: SocketAddr, payload: &[u8]) {
        let Some(ip) = self.address_for(remote.ip()) else {
            self.counters.dropped_unrouted += 1;
            return;
        };
        let mut packets = std::mem::take(&mut self.fragments);
        let id = self.next_ip_id;
        match fragment::udp_packets(
            SocketAddr::new(ip, local_port),
            remote,
            payload,
            self.phy.mtu,
            id,
            &mut packets,
        ) {
            Ok(()) => {
                if packets.len() > 1 {
                    self.next_ip_id = id.wrapping_add(1);
                    self.counters.fragmented_out += 1;
                }
                for p in &packets {
                    self.send_into_tunnel(p);
                }
            }
            Err(_) => self.counters.dropped_malformed += 1,
        }
        self.fragments = packets;
    }

    fn proxy_out(&mut self, index: usize, client: SocketAddr, data: &[u8]) {
        let now = Instant::now();
        let Some(proxy) = self.proxies.get_mut(index) else {
            return;
        };
        let target = proxy.target;
        let port = match proxy.table.touch(&client, now) {
            Some(port) => *port,
            None => {
                let Some(port) = self.udp_ports.take() else {
                    self.counters.dropped_full += 1;
                    return;
                };
                match proxy.table.insert(client, port, now) {
                    Ok(expired) => {
                        for (_, gone) in expired {
                            self.ephemeral.remove(&gone);
                            self.udp_ports.give_back(gone);
                        }
                    }
                    Err(_) => {
                        self.udp_ports.give_back(port);
                        self.counters.dropped_full += 1;
                        return;
                    }
                }
                self.ephemeral.insert(port, (index, client));
                port
            }
        };
        self.udp_out(port, target, data);
    }

    fn sweep(&mut self, now: Instant) {
        self.reassembly.sweep(now);
        for proxy in &mut self.proxies {
            for (_, port) in proxy.table.sweep(now) {
                self.ephemeral.remove(&port);
                self.udp_ports.give_back(port);
            }
        }
        for server in &mut self.servers {
            for (_, id) in server.table.sweep(now) {
                self.flows.remove(&id);
            }
        }
        self.end_stuck(now);
    }

    /// End the connections stuck where nothing can move them again: half closed
    /// or closing with nothing moving, or a peer that has taken none of the data
    /// waiting for it for a long time. An open connection that is only quiet is
    /// never ended here: games and websockets hold those for hours.
    fn end_stuck(&mut self, now: Instant) {
        let in_reach = self
            .heard
            .is_some_and(|t| now.saturating_duration_since(t) < self.limits.peer_quiet);
        for (&handle, conn) in self.conns.iter_mut() {
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            let queued = socket.send_queue();
            if queued < conn.queued {
                conn.progress = now;
            }
            conn.queued = queued;
            // Nothing can move while the peer is out of reach: an outage is not
            // a stuck connection, and it comes back when the link does.
            let finished = matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait);
            if !in_reach && !finished {
                conn.progress = now;
            }
            let still = now.saturating_duration_since(conn.progress);
            let stuck = match socket.state() {
                tcp::State::CloseWait
                | tcp::State::FinWait1
                | tcp::State::FinWait2
                | tcp::State::Closing
                | tcp::State::LastAck => still >= self.limits.stuck_timeout,
                tcp::State::Established => queued > 0 && still >= self.limits.zero_window_timeout,
                // Finished, with bytes the local stream stopped taking: nothing
                // will ever drain them, so the connection is let go.
                tcp::State::Closed | tcp::State::TimeWait => {
                    if conn.to_local.is_some() && still >= self.limits.stuck_timeout {
                        conn.to_local = None;
                    }
                    false
                }
                _ => false,
            };
            if stuck {
                socket.abort();
            }
        }
    }

    /// A socket with buffers as large as the memory budget allows: full size
    /// (the window scales to fill a long path) while under half the budget,
    /// the floor after that, and none at all once the budget is spent.
    fn new_tcp_socket(&mut self) -> Option<tcp::Socket<'static>> {
        let max = self.limits.tcp_buffer_max.max(self.limits.tcp_buffer);
        let floor = self.limits.tcp_buffer;
        let size = if self.tcp_reserved.saturating_add(2 * max) <= self.limits.tcp_memory / 2 {
            max
        } else if self.tcp_reserved.saturating_add(2 * floor) <= self.limits.tcp_memory {
            floor
        } else {
            return None;
        };
        self.tcp_reserved += 2 * size;
        let rx = tcp::SocketBuffer::new(vec![0u8; size]);
        let tx = tcp::SocketBuffer::new(vec![0u8; size]);
        let mut socket = tcp::Socket::new(rx, tx);
        socket.set_nagle_enabled(false);
        // Backs off on loss instead of flooding the path the call media shares.
        socket.set_congestion_control(tcp::CongestionControl::Reno);
        // Probes keep a quiet connection known alive; a peer gone for fifteen
        // minutes ends it, and any outage shorter than that is ridden out.
        socket.set_keep_alive(Some(smoltcp::time::Duration::from_secs(30)));
        socket.set_timeout(Some(smoltcp::time::Duration::from_secs(900)));
        Some(socket)
    }

    /// Remove a socket and give its buffers back to the budget.
    fn remove_socket(&mut self, handle: SocketHandle) {
        let socket = self.sockets.get::<tcp::Socket>(handle);
        let size = socket.recv_capacity() + socket.send_capacity();
        self.tcp_reserved = self.tcp_reserved.saturating_sub(size);
        self.sockets.remove(handle);
    }

    fn accept(&mut self, index: usize, stream: TcpStream) {
        if self.conns.len() >= self.limits.max_tcp {
            self.counters.dropped_full += 1;
            return;
        }
        let source = stream.peer_addr().ok().map(|a| a.ip());
        let held = source.map_or(0, |ip| self.per_source.get(&ip).copied().unwrap_or(0));
        if held >= self.limits.max_tcp_per_source {
            self.counters.dropped_full += 1;
            return;
        }
        let Some(&target) = self.tcp_targets.get(index) else {
            return;
        };
        let Some(local) = self.address_for(target.ip()) else {
            self.counters.dropped_unrouted += 1;
            return;
        };
        let Some(port) = self.tcp_ports.take() else {
            self.counters.dropped_full += 1;
            return;
        };
        let Some(mut socket) = self.new_tcp_socket() else {
            self.tcp_ports.give_back(port);
            self.counters.dropped_full += 1;
            return;
        };
        if socket
            .connect(self.iface.context(), target, (local, port))
            .is_err()
        {
            self.tcp_ports.give_back(port);
            let handle = self.sockets.add(socket);
            self.remove_socket(handle);
            return;
        }
        let handle = self.sockets.add(socket);
        let (mut conn, ends) = channels(Some(port));
        conn.source = source;
        if let Some(ip) = source {
            *self.per_source.entry(ip).or_default() += 1;
        }
        self.conns.insert(handle, conn);
        tokio::spawn(pump(
            stream,
            ends,
            self.notify.clone(),
            self.streams.clone(),
        ));
    }

    /// Keep `backlog` sockets listening on each `[TCPServerTunnel]` port while
    /// there is room for more connections.
    fn refill_listeners(&mut self) {
        for index in 0..self.listeners.len() {
            while self.listeners[index].sockets.len() < self.limits.backlog
                && self.conns.len() + self.listening() < self.limits.max_tcp + self.limits.backlog
            {
                let Some(mut socket) = self.new_tcp_socket() else {
                    break;
                };
                let port = self.listeners[index].port;
                if socket
                    .listen(IpListenEndpoint { addr: None, port })
                    .is_err()
                {
                    let handle = self.sockets.add(socket);
                    self.remove_socket(handle);
                    break;
                }
                let handle = self.sockets.add(socket);
                self.listeners[index].sockets.push(handle);
            }
        }
    }

    fn listening(&self) -> usize {
        self.listeners.iter().map(|l| l.sockets.len()).sum()
    }

    /// A listening socket that took a connection becomes one, with a local
    /// connection to the target opened for it.
    fn promote_listeners(&mut self) -> bool {
        let mut promoted = false;
        for index in 0..self.listeners.len() {
            let handles = std::mem::take(&mut self.listeners[index].sockets);
            let mut keep = Vec::with_capacity(handles.len());
            for handle in handles {
                let state = self.sockets.get_mut::<tcp::Socket>(handle).state();
                if state == tcp::State::Listen {
                    keep.push(handle);
                    continue;
                }
                promoted = true;
                if self.conns.len() >= self.limits.max_tcp {
                    self.sockets.get_mut::<tcp::Socket>(handle).abort();
                    self.counters.dropped_full += 1;
                    keep.push(handle);
                    continue;
                }
                let (conn, ends) = channels(None);
                self.conns.insert(handle, conn);
                let target = self.listeners[index].target.clone();
                let notify = self.notify.clone();
                let streams = self.streams.clone();
                tokio::spawn(async move {
                    let connect = tokio::time::timeout(
                        Duration::from_secs(10),
                        TcpStream::connect(target.as_str()),
                    );
                    match connect.await {
                        Ok(Ok(stream)) => {
                            let _ = stream.set_nodelay(true);
                            pump(stream, ends, notify, streams).await;
                        }
                        _ => {
                            drop(ends);
                            notify.notify_one();
                        }
                    }
                });
            }
            // An aborted socket goes back to listening.
            for &handle in &keep {
                let socket = self.sockets.get_mut::<tcp::Socket>(handle);
                if socket.state() == tcp::State::Closed {
                    let _ = socket.listen(IpListenEndpoint {
                        addr: None,
                        port: self.listeners[index].port,
                    });
                }
            }
            self.listeners[index].sockets = keep;
        }
        if promoted {
            self.refill_listeners();
        }
        promoted
    }

    /// Move bytes between every connection and its local stream. True when
    /// anything moved or changed.
    fn pump_tcp(&mut self) -> bool {
        let mut moved = self.promote_listeners();
        let mut finished = Vec::new();
        for (&handle, conn) in self.conns.iter_mut() {
            let socket = self.sockets.get_mut::<tcp::Socket>(handle);
            // The local side went away without a word (refused, reset): reset this one too.
            if conn.to_local.as_ref().is_some_and(|tx| tx.is_closed()) {
                socket.abort();
                conn.to_local = None;
                moved = true;
            }
            // Local to tunnel, as fast as the socket's window takes it.
            loop {
                if conn.pending.is_none() && !conn.local_done {
                    match conn.from_local.try_recv() {
                        Ok(data) => conn.pending = Some((data, 0)),
                        Err(mpsc::error::TryRecvError::Empty) => break,
                        Err(mpsc::error::TryRecvError::Disconnected) => conn.local_done = true,
                    }
                }
                let Some((data, offset)) = conn.pending.as_mut() else {
                    break;
                };
                if !socket.can_send() {
                    break;
                }
                match socket.send_slice(&data[*offset..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        moved = true;
                        conn.progress = Instant::now();
                        *offset += n;
                        if *offset >= data.len() {
                            conn.pending = None;
                        }
                    }
                }
            }
            if conn.local_done && conn.pending.is_none() && !conn.closed {
                socket.close();
                conn.closed = true;
                moved = true;
            }
            // Tunnel to local, as fast as the local stream drains.
            while socket.can_recv() {
                let Some(tx) = conn.to_local.as_ref() else {
                    break;
                };
                let Ok(permit) = tx.try_reserve() else { break };
                match socket.recv(|buf| {
                    let n = buf.len().min(16 * 1024);
                    (n, buf[..n].to_vec())
                }) {
                    Ok(data) if !data.is_empty() => {
                        permit.send(data);
                        conn.progress = Instant::now();
                        moved = true;
                    }
                    _ => break,
                }
            }
            let remote_done = matches!(
                socket.state(),
                tcp::State::CloseWait
                    | tcp::State::LastAck
                    | tcp::State::Closing
                    | tcp::State::TimeWait
                    | tcp::State::Closed
            );
            if remote_done && !socket.can_recv() && conn.to_local.is_some() {
                conn.to_local = None;
                moved = true;
            }
            if matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait)
                && conn.to_local.is_none()
            {
                if conn.reaped {
                    finished.push(handle);
                } else {
                    conn.reaped = true;
                    moved = true;
                }
            }
        }
        for handle in finished {
            if let Some(conn) = self.conns.remove(&handle) {
                if let Some(port) = conn.port {
                    self.tcp_ports.give_back(port);
                }
                if let Some(ip) = conn.source {
                    if let Some(n) = self.per_source.get_mut(&ip) {
                        *n -= 1;
                        if *n == 0 {
                            self.per_source.remove(&ip);
                        }
                    }
                }
            }
            self.remove_socket(handle);
            moved = true;
        }
        moved
    }
}

/// A flow's socket towards the service, with its first datagram already sent: a
/// socket the reactor has not polled yet refuses a non-blocking send.
fn open_flow_socket(target: SocketAddr, first: &[u8]) -> io::Result<UdpSocket> {
    let unspecified: IpAddr = if target.is_ipv4() {
        Ipv4Addr::UNSPECIFIED.into()
    } else {
        Ipv6Addr::UNSPECIFIED.into()
    };
    let socket = std::net::UdpSocket::bind(SocketAddr::new(unspecified, 0))?;
    socket.connect(target)?;
    socket.set_nonblocking(true)?;
    let _ = socket.send(first);
    UdpSocket::from_std(socket)
}

/// The local stream's side of a connection's two channels.
struct Ends {
    to_local: mpsc::Receiver<Vec<u8>>,
    from_local: mpsc::Sender<Vec<u8>>,
    /// Closes when the engine drops the connection.
    alive: mpsc::Sender<()>,
}

fn channels(port: Option<u16>) -> (Conn, Ends) {
    let (to_tx, to_rx) = mpsc::channel(16);
    let (from_tx, from_rx) = mpsc::channel(16);
    let (alive_tx, alive_rx) = mpsc::channel(1);
    let conn = Conn {
        to_local: Some(to_tx),
        from_local: from_rx,
        pending: None,
        local_done: false,
        closed: false,
        reaped: false,
        port,
        source: None,
        progress: Instant::now(),
        queued: 0,
        _alive: alive_rx,
    };
    (
        conn,
        Ends {
            to_local: to_rx,
            from_local: from_tx,
            alive: alive_tx,
        },
    )
}

/// Copy between a local stream and the engine until both directions end.
async fn pump(stream: TcpStream, ends: Ends, notify: Arc<Notify>, streams: Arc<AtomicUsize>) {
    struct Open(Arc<AtomicUsize>);
    impl Drop for Open {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::Relaxed);
        }
    }
    streams.fetch_add(1, Ordering::Relaxed);
    let _open = Open(streams);
    let (mut read, mut write) = stream.into_split();
    let Ends {
        mut to_local,
        from_local,
        alive,
    } = ends;
    let wake = notify.clone();
    let gone = alive.clone();
    // Once the engine has dropped the connection nothing it reads can go
    // anywhere: a client that never sends again must not hold the task and the
    // descriptor for ever.
    let reader = async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let read = tokio::select! {
                read = read.read(&mut buf) => read,
                _ = gone.closed() => break,
            };
            match read {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if from_local.send(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                    wake.notify_one();
                }
            }
        }
        drop(from_local);
        wake.notify_one();
    };
    // The last bytes still go out after the engine is done, for a while.
    let drained = async move {
        alive.closed().await;
        tokio::time::sleep(DRAIN_GRACE).await;
    };
    let writer = async move {
        tokio::pin!(drained);
        while let Some(data) = to_local.recv().await {
            let written = tokio::select! {
                written = write.write_all(&data) => written.is_ok(),
                _ = &mut drained => false,
            };
            if !written {
                // Dropping the receiver tells the engine to reset the connection.
                drop(to_local);
                notify.notify_one();
                return;
            }
            notify.notify_one();
        }
        let _ = write.shutdown().await;
    };
    tokio::join!(reader, writer);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A lookup that finishes while the engine's queue is full still reaches
    /// it: a lost answer would leave the name marked as resolving for good.
    #[tokio::test(flavor = "current_thread")]
    async fn a_lookup_answer_waits_for_room_in_a_full_queue() {
        let (events, mut rx) = mpsc::channel(1);
        events.try_send(Event::Endpoint(Vec::new())).unwrap();
        pin_name(
            "full-queue.test:1",
            Some(SocketAddr::from(([10, 1, 2, 3], 1))),
        );
        look_up(events, || Event::Endpoint(resolve_all("full-queue.test:1")));
        // The blocking lookup is done long before the queue is drained.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(matches!(rx.recv().await, Some(Event::Endpoint(found)) if found.is_empty()));
        let answer = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await;
        assert!(
            matches!(&answer, Ok(Some(Event::Endpoint(found))) if found.first().map(|a| a.port()) == Some(1)),
            "the answer was lost"
        );
        pin_name("full-queue.test:1", None);
    }
}
