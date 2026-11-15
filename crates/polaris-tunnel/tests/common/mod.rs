//! Two daemons on loopback joined by a link the test controls: loss, delay,
//! jitter (which reorders), blackouts and a change of the house's address.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use boringtun::x25519::{PublicKey, StaticSecret};
use polaris_tunnel::config;
use polaris_tunnel::engine::{self, Handle, Limits};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};
use tokio::task::JoinHandle;

pub const RELAY_IP: &str = "10.9.0.1";
pub const HOUSE_IP: &str = "10.9.0.2";
pub const MEDIA_PORT: u16 = 7882;
pub const WEB_PORT: u16 = 80;
pub const BACK_PORT: u16 = 9000;

pub fn key(seed: u8) -> (String, String) {
    let secret = StaticSecret::from([seed; 32]);
    let public = PublicKey::from(&secret);
    let b64 = base64::engine::general_purpose::STANDARD;
    (b64.encode(secret.to_bytes()), b64.encode(public.to_bytes()))
}

#[derive(Clone, Copy, Default)]
pub struct Shape {
    /// Chance in a million that a datagram is lost, each direction.
    pub loss_ppm: u32,
    pub delay: Duration,
    /// Up to this much more delay, drawn per datagram: reorders them.
    pub jitter: Duration,
    pub blackout: bool,
}

struct Ctl {
    shape: Shape,
    rng: u64,
    house: Option<SocketAddr>,
    lost: u64,
}

impl Ctl {
    fn next(&mut self) -> u64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        self.rng
    }

    /// None to drop, else the delay to apply.
    fn verdict(&mut self) -> Option<Duration> {
        if self.shape.blackout {
            self.lost += 1;
            return None;
        }
        if (self.next() % 1_000_000) < u64::from(self.shape.loss_ppm) {
            self.lost += 1;
            return None;
        }
        let jitter = self.shape.jitter.as_micros() as u64;
        let extra = if jitter == 0 { 0 } else { self.next() % jitter };
        Some(self.shape.delay + Duration::from_micros(extra))
    }
}

/// The house dials `addr`; the link carries each datagram on to the relay from
/// its own socket, which `rebind` replaces to look like a NAT that moved.
pub struct Link {
    pub addr: SocketAddr,
    ctl: Arc<Mutex<Ctl>>,
    front: Arc<UdpSocket>,
    back: Arc<Mutex<Arc<UdpSocket>>>,
    relay: Arc<Mutex<SocketAddr>>,
    /// A second address the relay answers from, as if it had moved.
    alt: Arc<Mutex<Option<Arc<UdpSocket>>>>,
    alt_dead: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}

impl Link {
    pub async fn new(relay: SocketAddr, seed: u64) -> Link {
        Link::new_at(relay, seed, "127.0.0.1:0").await
    }

    /// A link whose house-facing side listens on `front` (`[::1]:0` for IPv6).
    pub async fn new_at(relay: SocketAddr, seed: u64, front: &str) -> Link {
        let front = Arc::new(UdpSocket::bind(front).await.unwrap());
        let back = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let ctl = Arc::new(Mutex::new(Ctl {
            shape: Shape::default(),
            rng: seed | 1,
            house: None,
            lost: 0,
        }));
        let mut link = Link {
            addr: front.local_addr().unwrap(),
            ctl,
            front,
            back: Arc::new(Mutex::new(back.clone())),
            relay: Arc::new(Mutex::new(relay)),
            alt: Arc::new(Mutex::new(None)),
            alt_dead: Arc::new(AtomicBool::new(false)),
            tasks: Vec::new(),
        };
        link.spawn_front_reader(link.front.clone(), false);
        link.spawn_back_reader(back);
        link
    }

    /// Carries what the house sends to `front` on to the relay.
    fn spawn_front_reader(&mut self, front: Arc<UdpSocket>, alt: bool) {
        let (ctl, backs, relay, dead) = (
            self.ctl.clone(),
            self.back.clone(),
            self.relay.clone(),
            self.alt_dead.clone(),
        );
        self.tasks.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                let Ok((n, from)) = front.recv_from(&mut buf).await else {
                    continue;
                };
                if alt && dead.load(Ordering::Relaxed) {
                    continue;
                }
                let verdict = {
                    let mut c = ctl.lock().unwrap();
                    c.house = Some(from);
                    c.verdict()
                };
                let Some(delay) = verdict else { continue };
                let back = backs.lock().unwrap().clone();
                let to = *relay.lock().unwrap();
                let data = buf[..n].to_vec();
                tokio::spawn(async move {
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let _ = back.send_to(&data, to).await;
                });
            }
        }));
    }

    fn spawn_back_reader(&mut self, back: Arc<UdpSocket>) {
        let (main, ctl) = (self.front.clone(), self.ctl.clone());
        let (alt, dead) = (self.alt.clone(), self.alt_dead.clone());
        self.tasks.push(tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            loop {
                let Ok((n, _)) = back.recv_from(&mut buf).await else {
                    continue;
                };
                let (verdict, house) = {
                    let mut c = ctl.lock().unwrap();
                    (c.verdict(), c.house)
                };
                let (Some(delay), Some(house)) = (verdict, house) else {
                    continue;
                };
                // Once the other address is silenced the relay is only heard
                // from where it always was.
                let front = match alt.lock().unwrap().clone() {
                    Some(alt) if !dead.load(Ordering::Relaxed) => alt,
                    _ => main.clone(),
                };
                let data = buf[..n].to_vec();
                tokio::spawn(async move {
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    let _ = front.send_to(&data, house).await;
                });
            }
        }));
    }

    pub fn shape(&self, shape: Shape) {
        self.ctl.lock().unwrap().shape = shape;
    }

    pub fn blackout(&self, on: bool) {
        self.ctl.lock().unwrap().shape.blackout = on;
    }

    pub fn lost(&self) -> u64 {
        self.ctl.lock().unwrap().lost
    }

    /// The relay now sees the house from another address.
    pub async fn rebind(&mut self) -> SocketAddr {
        let back = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let addr = back.local_addr().unwrap();
        *self.back.lock().unwrap() = back.clone();
        self.spawn_back_reader(back);
        addr
    }

    /// From now on the house hears the relay from another address, which also
    /// carries what the house sends to it: a peer that moved.
    pub async fn answer_from_elsewhere(&mut self) -> SocketAddr {
        let alt = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let addr = alt.local_addr().unwrap();
        *self.alt.lock().unwrap() = Some(alt.clone());
        self.spawn_front_reader(alt, true);
        addr
    }

    /// The address `answer_from_elsewhere` gave goes dead: what the house sends
    /// there is lost, and the relay answers from the link's own address again.
    pub fn silence_elsewhere(&self) {
        self.alt_dead.store(true, Ordering::Relaxed);
    }

    pub fn point_at(&self, relay: SocketAddr) {
        *self.relay.lock().unwrap() = relay;
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

pub async fn udp_echo() -> (SocketAddr, JoinHandle<()>) {
    let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = socket.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut buf = vec![0u8; 65536];
        loop {
            if let Ok((n, from)) = socket.recv_from(&mut buf).await {
                let _ = socket.send_to(&buf[..n], from).await;
            }
        }
    });
    (addr, task)
}

pub async fn tcp_echo() -> (SocketAddr, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if stream.write_all(&buf[..n]).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
        }
    });
    (addr, task)
}

pub struct Options {
    pub udp_idle: u64,
    pub udp_sessions: usize,
    pub keepalive: u16,
    pub limits: Limits,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            udp_idle: 120,
            udp_sessions: 1024,
            keepalive: 25,
            limits: Limits::default(),
        }
    }
}

pub fn relay_config(listen: u16, back_target: SocketAddr, o: &Options) -> String {
    let (relay, _) = key(1);
    let (_, house) = key(2);
    format!(
        "[Interface]\nPrivateKey = {relay}\nAddress = {RELAY_IP}/32\nListenPort = {listen}\n\n[Peer]\nPublicKey = {house}\nAllowedIPs = {HOUSE_IP}/32\n\n[TCPClientTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {HOUSE_IP}:{WEB_PORT}\n\n[UDPProxyTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {HOUSE_IP}:{MEDIA_PORT}\nInactivityTimeout = {}\nMaxSessions = {}\n\n[TCPServerTunnel]\nListenPort = {BACK_PORT}\nTarget = {back_target}\n",
        o.udp_idle, o.udp_sessions
    )
}

pub fn house_config(
    endpoint: SocketAddr,
    udp_target: SocketAddr,
    tcp_target: SocketAddr,
    o: &Options,
) -> String {
    let (house, _) = key(2);
    let (_, relay) = key(1);
    format!(
        "[Interface]\nPrivateKey = {house}\nAddress = {HOUSE_IP}/32\n\n[Peer]\nPublicKey = {relay}\nEndpoint = {endpoint}\nAllowedIPs = {RELAY_IP}/32\nPersistentKeepalive = {}\n\n[UDPServerTunnel]\nListenPort = {MEDIA_PORT}\nTarget = {udp_target}\nInactivityTimeout = {}\nMaxSessions = {}\n\n[TCPServerTunnel]\nListenPort = {WEB_PORT}\nTarget = {tcp_target}\n\n[TCPClientTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {RELAY_IP}:{BACK_PORT}\n",
        o.keepalive, o.udp_idle, o.udp_sessions
    )
}

/// A relay and a house joined by a link, with echo services behind both.
pub struct Pair {
    pub relay: Option<Handle>,
    pub house: Option<Handle>,
    pub link: Link,
    pub relay_port: u16,
    pub udp_echo: SocketAddr,
    pub tcp_echo: SocketAddr,
    pub options: Options,
    _services: Vec<JoinHandle<()>>,
}

pub async fn free_udp_port() -> u16 {
    UdpSocket::bind("127.0.0.1:0")
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

impl Pair {
    pub async fn new(options: Options, seed: u64) -> Pair {
        let (udp_echo, a) = udp_echo().await;
        let (tcp_echo, b) = tcp_echo().await;
        let relay_port = free_udp_port().await;
        let relay = start_relay(relay_port, tcp_echo, &options).await;
        let link = Link::new(SocketAddr::from(([127, 0, 0, 1], relay_port)), seed).await;
        let house = start_house(link.addr, udp_echo, tcp_echo, &options).await;
        Pair {
            relay: Some(relay),
            house: Some(house),
            link,
            relay_port,
            udp_echo,
            tcp_echo,
            options,
            _services: vec![a, b],
        }
    }

    pub fn relay(&self) -> &Handle {
        self.relay.as_ref().unwrap()
    }

    pub fn house(&self) -> &Handle {
        self.house.as_ref().unwrap()
    }

    pub fn media(&self) -> SocketAddr {
        self.relay().udp_proxy_addrs[0]
    }

    pub fn web(&self) -> SocketAddr {
        self.relay().tcp_client_addrs[0]
    }

    pub fn back(&self) -> SocketAddr {
        self.house().tcp_client_addrs[0]
    }

    pub async fn restart_relay(&mut self) {
        if let Some(old) = self.relay.take() {
            old.stop().await;
        }
        self.relay = Some(start_relay(self.relay_port, self.tcp_echo, &self.options).await);
    }

    pub async fn restart_house(&mut self) {
        if let Some(old) = self.house.take() {
            old.stop().await;
        }
        self.house =
            Some(start_house(self.link.addr, self.udp_echo, self.tcp_echo, &self.options).await);
    }
}

pub async fn start_relay(port: u16, back: SocketAddr, o: &Options) -> Handle {
    let cfg = config::parse(&relay_config(port, back, o)).unwrap();
    // The port was just free; on a busy machine another test may take it first.
    for _ in 0..50 {
        if let Ok(h) = engine::start(cfg.clone(), o.limits.clone()).await {
            return h;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("relay could not bind {port}");
}

pub async fn start_house(
    endpoint: SocketAddr,
    udp: SocketAddr,
    tcp: SocketAddr,
    o: &Options,
) -> Handle {
    let cfg = config::parse(&house_config(endpoint, udp, tcp, o)).unwrap();
    engine::start(cfg, o.limits.clone()).await.unwrap()
}

/// Wait until `f` holds, or fail after `limit`.
pub async fn eventually(limit: Duration, mut f: impl FnMut() -> bool) -> Duration {
    let start = Instant::now();
    while start.elapsed() < limit {
        if f() {
            return start.elapsed();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("condition not met within {limit:?}");
}

pub fn handshaken(h: &Handle) -> bool {
    h.status.lock().unwrap().last_handshake.is_some()
}

/// Send one datagram through the relay's media port and wait for its echo.
pub async fn udp_round_trip(
    client: &UdpSocket,
    to: SocketAddr,
    payload: &[u8],
    wait: Duration,
) -> Option<Duration> {
    let start = Instant::now();
    client.send_to(payload, to).await.ok()?;
    let mut buf = vec![0u8; 65536];
    loop {
        let left = wait.checked_sub(start.elapsed())?;
        match tokio::time::timeout(left, client.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) if &buf[..n] == payload => return Some(start.elapsed()),
            Ok(_) => continue,
            Err(_) => return None,
        }
    }
}

/// Retry a round trip until it works or `limit` passes: how long the link took to come back.
pub async fn udp_recovers(client: &UdpSocket, to: SocketAddr, limit: Duration) -> Duration {
    let start = Instant::now();
    let mut n = 0u32;
    while start.elapsed() < limit {
        n += 1;
        if udp_round_trip(
            client,
            to,
            format!("probe-{n}").as_bytes(),
            Duration::from_millis(500),
        )
        .await
        .is_some()
        {
            return start.elapsed();
        }
    }
    panic!("UDP did not recover within {limit:?}");
}

/// Write `bytes` through a TCP forward to an echo and read all of them back.
pub async fn tcp_transfer(stream: &mut tokio::net::TcpStream, bytes: usize, seed: u8) {
    let data: Vec<u8> = (0..bytes)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect();
    let (mut r, mut w) = stream.split();
    let send = async {
        w.write_all(&data).await.unwrap();
    };
    let recv = async {
        let mut got = vec![0u8; bytes];
        r.read_exact(&mut got).await.unwrap();
        got
    };
    let ((), got) = tokio::join!(send, recv);
    assert!(got == data, "bytes came back changed");
}
