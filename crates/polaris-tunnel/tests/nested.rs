//! The relay's two links, nested as Polaris runs them: the side link (games and
//! calls) rides inside the web link through one constant UDP forward, and only the
//! web link touches the lossy network between the two machines.
//!
//! ```text
//! player -> side relay --(side WireGuard, MTU 1360)--> web relay [UDPServerTunnel]
//!        -> web link (MTU 1420, lossy) -> web house [UDPProxyTunnel] -> side house -> game
//! ```

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use polaris_tunnel::config;
use polaris_tunnel::engine::{self, Handle, Limits};
use tokio::net::{TcpStream, UdpSocket};

const WEB_RELAY_IP: &str = "10.9.0.1";
const WEB_HOUSE_IP: &str = "10.9.0.2";
const SIDE_RELAY_IP: &str = "10.9.1.1";
const SIDE_HOUSE_IP: &str = "10.9.1.2";
/// The side link's port inside the web link, the same in every config.
const SIDE_PORT: u16 = 52001;
const GAME_UDP: u16 = 19132;
const GAME_TCP: u16 = 25565;
/// The web link's MTU and the side link's: the web link's less IPv4 (20), UDP (8)
/// and WireGuard's data header and tag (32).
const WEB_MTU: usize = 1420;
const SIDE_MTU: usize = WEB_MTU - 20 - 8 - 32;

struct Nest {
    link: Link,
    web_relay: Handle,
    web_house: Handle,
    side_relay: Handle,
    side_house: Handle,
    side_name: String,
    side_mtu: usize,
    udp_echo: SocketAddr,
    tcp_echo: SocketAddr,
    _services: Vec<tokio::task::JoinHandle<()>>,
}

fn web_relay_config(listen: u16, side: &str) -> String {
    let (relay, _) = key(11);
    let (_, house) = key(12);
    format!(
        "[Interface]\nPrivateKey = {relay}\nAddress = {WEB_RELAY_IP}/32\nListenPort = {listen}\n\n[Peer]\nPublicKey = {house}\nAllowedIPs = {WEB_HOUSE_IP}/32\n\n[TCPClientTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {WEB_HOUSE_IP}:{WEB_PORT}\n\n[UDPServerTunnel]\nListenPort = {SIDE_PORT}\nTarget = {side}\n"
    )
}

fn web_house_config(endpoint: SocketAddr, web: SocketAddr) -> String {
    let (house, _) = key(12);
    let (_, relay) = key(11);
    format!(
        "[Interface]\nPrivateKey = {house}\nAddress = {WEB_HOUSE_IP}/32\n\n[Peer]\nPublicKey = {relay}\nEndpoint = {endpoint}\nAllowedIPs = {WEB_RELAY_IP}/32\nPersistentKeepalive = 1\n\n[TCPServerTunnel]\nListenPort = {WEB_PORT}\nTarget = {web}\n\n[UDPProxyTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {WEB_RELAY_IP}:{SIDE_PORT}\n"
    )
}

fn side_relay_config(listen: u16, mtu: usize) -> String {
    let (relay, _) = key(13);
    let (_, house) = key(14);
    format!(
        "[Interface]\nPrivateKey = {relay}\nAddress = {SIDE_RELAY_IP}/32\nListenPort = {listen}\nMTU = {mtu}\n\n[Peer]\nPublicKey = {house}\nAllowedIPs = {SIDE_HOUSE_IP}/32\n\n[TCPClientTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {SIDE_HOUSE_IP}:{GAME_TCP}\n\n[UDPProxyTunnel]\nBindAddress = 127.0.0.1:0\nTarget = {SIDE_HOUSE_IP}:{GAME_UDP}\n"
    )
}

fn side_house_config(endpoint: SocketAddr, mtu: usize, udp: SocketAddr, tcp: SocketAddr) -> String {
    let (house, _) = key(14);
    let (_, relay) = key(13);
    format!(
        "[Interface]\nPrivateKey = {house}\nAddress = {SIDE_HOUSE_IP}/32\nMTU = {mtu}\n\n[Peer]\nPublicKey = {relay}\nEndpoint = {endpoint}\nAllowedIPs = {SIDE_RELAY_IP}/32\nPersistentKeepalive = 1\n\n[UDPServerTunnel]\nListenPort = {GAME_UDP}\nTarget = {udp}\n\n[TCPServerTunnel]\nListenPort = {GAME_TCP}\nTarget = {tcp}\n"
    )
}

/// Where a daemon's WireGuard socket is reached: it listens on every address.
fn loopback(h: &Handle) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], h.wire_addr.port()))
}

async fn start(text: &str) -> Handle {
    let cfg = config::parse(text).unwrap();
    for _ in 0..50 {
        if let Ok(h) = engine::start(cfg.clone(), Limits::default()).await {
            return h;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("could not start a daemon");
}

impl Nest {
    async fn new(seed: u64, side_mtu: usize) -> Nest {
        let (udp_echo, a) = udp_echo().await;
        let (tcp_echo, b) = tcp_echo().await;
        // The name the web relay forwards to: the side relay's container.
        let side_name = format!("side-{seed}.test:{SIDE_PORT}");
        let side_port = free_udp_port().await;
        let side_relay = start(&side_relay_config(side_port, side_mtu)).await;
        engine::pin_name(&side_name, Some(loopback(&side_relay)));
        let web_port = free_udp_port().await;
        let web_relay = start(&web_relay_config(web_port, &side_name)).await;
        let link = Link::new(SocketAddr::from(([127, 0, 0, 1], web_port)), seed).await;
        let web_house = start(&web_house_config(link.addr, tcp_echo)).await;
        let side_house = start(&side_house_config(
            web_house.udp_proxy_addrs[0],
            side_mtu,
            udp_echo,
            tcp_echo,
        ))
        .await;
        let nest = Nest {
            link,
            web_relay,
            web_house,
            side_relay,
            side_house,
            side_name,
            side_mtu,
            udp_echo,
            tcp_echo,
            _services: vec![a, b],
        };
        eventually(Duration::from_secs(20), || {
            handshaken(&nest.web_relay) && handshaken(&nest.side_relay)
        })
        .await;
        nest
    }

    fn game_udp(&self) -> SocketAddr {
        self.side_relay.udp_proxy_addrs[0]
    }

    fn game_tcp(&self) -> SocketAddr {
        self.side_relay.tcp_client_addrs[0]
    }

    fn web(&self) -> SocketAddr {
        self.web_relay.tcp_client_addrs[0]
    }

    fn counters(h: &Handle) -> engine::Counters {
        h.status.lock().unwrap().counters.clone()
    }
}

/// A call's media: a datagram every `gap`, each stamped with its sequence.
async fn stream(
    to: SocketAddr,
    count: u32,
    gap: Duration,
    mut during: impl FnMut(u32),
) -> (Vec<Instant>, HashMap<u32, Instant>) {
    let client = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let arrivals = Arc::new(Mutex::new(HashMap::new()));
    let reader = {
        let (client, arrivals) = (client.clone(), arrivals.clone());
        tokio::spawn(async move {
            let mut buf = [0u8; 2048];
            while let Ok((n, _)) = client.recv_from(&mut buf).await {
                if n >= 4 {
                    let seq = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]);
                    arrivals
                        .lock()
                        .unwrap()
                        .entry(seq)
                        .or_insert_with(Instant::now);
                }
            }
        })
    };
    let mut sent = Vec::new();
    let mut frame = vec![0u8; 1100];
    for seq in 0..count {
        during(seq);
        frame[..4].copy_from_slice(&seq.to_be_bytes());
        sent.push(Instant::now());
        client.send_to(&frame, to).await.unwrap();
        tokio::time::sleep(gap).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    reader.abort();
    let arrived = arrivals.lock().unwrap().clone();
    (sent, arrived)
}

/// THE regression, through both links: a 2 s blackout under 5% loss leaves no
/// datagram to arrive late afterwards, and the stream resumes at once.
#[tokio::test(flavor = "current_thread")]
async fn nested_udp_after_a_blackout_does_not_arrive_late() {
    let nest = Nest::new(31, SIDE_MTU).await;
    nest.link.shape(Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(10),
        jitter: Duration::from_millis(5),
        blackout: false,
    });
    let link = &nest.link;
    let (from, to) = (200u32, 600u32);
    let (sent, arrived) = stream(nest.game_udp(), 1000, Duration::from_millis(5), |seq| {
        if seq == from {
            link.blackout(true);
        }
        if seq == to {
            link.blackout(false);
        }
    })
    .await;
    let late: Vec<_> = (from..to - 20)
        .filter(|s| arrived.contains_key(s))
        .collect();
    assert!(
        late.is_empty(),
        "blackout datagrams arrived later: {late:?}"
    );
    let before = (0..from).filter(|s| arrived.contains_key(s)).count();
    assert!(before > 150, "under 5% loss only {before}/200 arrived");
    let after: Vec<_> = (to + 20..1000)
        .filter_map(|s| arrived.get(&s).map(|at| *at - sent[s as usize]))
        .collect();
    assert!(
        after.len() > 300,
        "the stream did not resume: {}",
        after.len()
    );
    let worst = after.iter().max().unwrap();
    assert!(
        *worst < Duration::from_millis(250),
        "after the blackout a datagram took {worst:?}"
    );
}

/// TCP through the side link under loss and reordering, and a held connection
/// that outlives a 10 s blackout of the network under both links.
#[tokio::test(flavor = "current_thread")]
async fn nested_tcp_under_loss_and_blackout() {
    let nest = Nest::new(32, SIDE_MTU).await;
    nest.link.shape(Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(5),
        jitter: Duration::from_millis(5),
        blackout: false,
    });
    let mut game = TcpStream::connect(nest.game_tcp()).await.unwrap();
    let mut web = TcpStream::connect(nest.web()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(120), async {
        tokio::join!(
            tcp_transfer(&mut game, 256 * 1024, 1),
            tcp_transfer(&mut web, 256 * 1024, 2)
        )
    })
    .await
    .expect("transfers stalled");
    nest.link.blackout(true);
    tokio::time::sleep(Duration::from_secs(10)).await;
    nest.link.blackout(false);
    tokio::time::timeout(
        Duration::from_secs(60),
        tcp_transfer(&mut game, 64 * 1024, 3),
    )
    .await
    .expect("the held game connection did not survive the blackout");
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, nest.game_udp(), Duration::from_secs(20)).await;
}

/// Many long-lived game connections at once, as a busy server holds them: every
/// one carries data before, survives a 10 s blackout under loss, and carries
/// data after. One TCP connection per player, end to end, so one stalled
/// stream cannot end the others.
#[tokio::test(flavor = "current_thread")]
async fn nested_many_long_lived_tcp_connections_survive_a_blackout() {
    let nest = Nest::new(33, SIDE_MTU).await;
    nest.link.shape(Shape {
        loss_ppm: 20_000,
        delay: Duration::from_millis(5),
        jitter: Duration::from_millis(3),
        blackout: false,
    });
    let mut players = Vec::new();
    for _ in 0..100 {
        players.push(TcpStream::connect(nest.game_tcp()).await.unwrap());
    }
    tokio::time::timeout(Duration::from_secs(60), round(&mut players, 1))
        .await
        .expect("players stalled before the blackout");
    nest.link.blackout(true);
    tokio::time::sleep(Duration::from_secs(10)).await;
    nest.link.blackout(false);
    tokio::time::timeout(Duration::from_secs(90), round(&mut players, 2))
        .await
        .expect("players stalled after the blackout");
    let c = Nest::counters(&nest.side_relay);
    assert!(c.tcp_connections >= 100, "{c:?}");
}

/// Every held connection carries `bytes` there and back, one after another.
async fn round(players: &mut [TcpStream], seed: u8) {
    for (i, p) in players.iter_mut().enumerate() {
        tcp_transfer(p, 2048, seed.wrapping_add(i as u8)).await;
    }
}

/// Send one datagram of `size` through the side link and wait for its echo.
async fn echo(client: &UdpSocket, to: SocketAddr, size: usize, tag: u8) -> bool {
    let payload: Vec<u8> = (0..size).map(|i| (i as u8) ^ tag).collect();
    for _ in 0..10 {
        if udp_round_trip(client, to, &payload, Duration::from_millis(500))
            .await
            .is_some()
        {
            return true;
        }
    }
    false
}

/// The side link's MTU is the web link's less the 60 bytes one nested IPv4
/// WireGuard packet adds: its full-size packets ride the web link whole, so the
/// web link never fragments. Anything a game sends that is larger is fragmented
/// inside the side link and joined again at the other end.
#[tokio::test(flavor = "current_thread")]
async fn nested_mtu_never_fragments_the_web_link() {
    assert_eq!(SIDE_MTU, 1360);
    let nest = Nest::new(34, SIDE_MTU).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    // The largest datagram one side packet holds: MTU less IPv4 and UDP.
    for (size, tag) in [(1, 1), (1100, 2), (SIDE_MTU - 28, 3)] {
        assert!(
            echo(&client, nest.game_udp(), size, tag).await,
            "{size} bytes lost"
        );
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    for h in [
        &nest.web_relay,
        &nest.web_house,
        &nest.side_relay,
        &nest.side_house,
    ] {
        let c = Nest::counters(h);
        assert_eq!((c.fragmented_out, c.dropped_malformed), (0, 0), "{c:?}");
    }
    // Larger than the side MTU, as a game with 1400-byte packets sends them.
    for (size, tag) in [(SIDE_MTU - 27, 4), (1400, 5), (1472, 6), (8000, 7)] {
        assert!(
            echo(&client, nest.game_udp(), size, tag).await,
            "{size} bytes lost"
        );
    }
    // The status the engine publishes trails it by a tick.
    eventually(Duration::from_secs(3), || {
        let relay = Nest::counters(&nest.side_relay);
        let house = Nest::counters(&nest.side_house);
        relay.fragmented_out > 0
            && house.reassembled_in > 0
            && house.fragmented_out > 0
            && relay.reassembled_in > 0
    })
    .await;
    for h in [&nest.web_relay, &nest.web_house] {
        let c = Nest::counters(h);
        assert_eq!((c.fragmented_out, c.reassembled_in), (0, 0), "{c:?}");
        assert_eq!(c.dropped_malformed, 0, "{c:?}");
    }
    // TCP's segments follow the side MTU, so a bulk transfer fragments nothing.
    let mut game = TcpStream::connect(nest.game_tcp()).await.unwrap();
    tcp_transfer(&mut game, 256 * 1024, 9).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    for h in [&nest.web_relay, &nest.web_house] {
        assert_eq!(Nest::counters(h).fragmented_out, 0);
    }
}

/// The bound is tight: eight bytes more and the web link has to fragment.
#[tokio::test(flavor = "current_thread")]
async fn a_side_mtu_past_the_bound_fragments_the_web_link() {
    let nest = Nest::new(35, SIDE_MTU + 16).await;
    assert_eq!(nest.side_mtu, 1376);
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    assert!(echo(&client, nest.game_udp(), nest.side_mtu - 28, 1).await);
    eventually(Duration::from_secs(3), || {
        Nest::counters(&nest.web_house).fragmented_out
            + Nest::counters(&nest.web_relay).fragmented_out
            > 0
    })
    .await;
}

/// The side relay's container is recreated when a game is added and comes back on
/// another address under the same name. The web link is not touched, and the side
/// link follows the name within seconds, though the house's keepalives never let
/// the old flow go idle.
#[tokio::test(flavor = "current_thread")]
async fn the_side_relay_moving_is_followed_and_the_web_link_stays() {
    let mut nest = Nest::new(36, SIDE_MTU).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    assert!(echo(&client, nest.game_udp(), 100, 1).await);
    let mut web = TcpStream::connect(nest.web()).await.unwrap();
    tcp_transfer(&mut web, 16 * 1024, 1).await;
    let handshakes = Nest::counters(&nest.web_house).handshakes;
    // Recreated: a new daemon, a new port, the same keys and the same name.
    let port = free_udp_port().await;
    let moved = start(&side_relay_config(port, SIDE_MTU)).await;
    engine::pin_name(&nest.side_name, Some(loopback(&moved)));
    let old = std::mem::replace(&mut nest.side_relay, moved);
    old.stop().await;
    let took = udp_recovers(&client, nest.game_udp(), Duration::from_secs(30)).await;
    assert!(
        took < Duration::from_secs(15),
        "the side link took {took:?} to follow"
    );
    let mut game = TcpStream::connect(nest.game_tcp()).await.unwrap();
    tcp_transfer(&mut game, 64 * 1024, 2).await;
    // The web connection opened before the move still carries data, and the web
    // link did not have to shake hands again for it.
    tcp_transfer(&mut web, 16 * 1024, 3).await;
    assert_eq!(Nest::counters(&nest.web_house).handshakes, handshakes);
    let _ = (nest.udp_echo, nest.tcp_echo);
}
