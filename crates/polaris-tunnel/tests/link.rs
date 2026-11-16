//! Two daemons through a link the test shapes. Each test names what it proves.

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

const UP: Duration = Duration::from_secs(10);

async fn ready(seed: u64) -> Pair {
    let pair = Pair::new(Options::default(), seed).await;
    eventually(UP, || handshaken(pair.relay()) && handshaken(pair.house())).await;
    pair
}

/// Send `count` numbered datagrams every `gap`, and report each one's send time
/// and the arrival of its echo.
async fn media_stream(
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
    let start = Instant::now();
    for seq in 0..count {
        during(seq);
        frame[..4].copy_from_slice(&seq.to_be_bytes());
        sent.push(Instant::now());
        let _ = client.send_to(&frame, to).await;
        let next = start + gap * (seq + 1);
        tokio::time::sleep_until(next.into()).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    reader.abort();
    let arrivals = arrivals.lock().unwrap().clone();
    (sent, arrivals)
}

/// The call-freeze regression. Under 5% loss each way with jitter, every media
/// datagram that arrives does so within a normal round trip: a lost one delays
/// nothing behind it. The same stream over one TCP connection would hold every
/// datagram after a loss until the retransmission, which is the 5-7 s freeze.
#[tokio::test(flavor = "current_thread")]
async fn udp_under_loss_has_no_head_of_line_stall() {
    let pair = ready(11).await;
    pair.link.shape(Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(10),
        jitter: Duration::from_millis(5),
        blackout: false,
    });
    let (sent, arrived) = media_stream(pair.media(), 600, Duration::from_millis(5), |_| {}).await;
    let delivered = arrived.len() as f64 / sent.len() as f64;
    // Two crossings at 5% each: about 90% should come back.
    assert!(delivered > 0.8, "only {delivered:.2} delivered");
    assert!(
        delivered < 0.99,
        "the link lost nothing ({delivered:.2}): the test did not test loss"
    );
    let worst = arrived
        .iter()
        .map(|(&seq, &at)| at - sent[seq as usize])
        .max()
        .unwrap();
    assert!(
        worst < Duration::from_millis(250),
        "a datagram took {worst:?}"
    );
    // The datagram right after each lost one is not late either.
    for seq in 1..sent.len() as u32 {
        if !arrived.contains_key(&(seq - 1)) {
            if let Some(at) = arrived.get(&seq) {
                assert!(*at - sent[seq as usize] < Duration::from_millis(250));
            }
        }
    }
}

/// The other half of the bug: a short outage. What was sent during it is lost,
/// as on a phone line, and nothing arrives late in a burst afterwards; what is
/// sent after it flows at once at a normal round trip.
#[tokio::test(flavor = "current_thread")]
async fn udp_after_a_blackout_does_not_arrive_late_in_a_burst() {
    let pair = ready(12).await;
    pair.link.shape(Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(10),
        jitter: Duration::from_millis(5),
        blackout: false,
    });
    let link = &pair.link;
    let gap = Duration::from_millis(5);
    let (blackout_from, blackout_to) = (200u32, 600u32); // 2 s dark
    let (sent, arrived) = media_stream(pair.media(), 1000, gap, |seq| {
        if seq == blackout_from {
            link.blackout(true);
        }
        if seq == blackout_to {
            link.blackout(false);
        }
    })
    .await;
    let late: Vec<_> = (blackout_from..blackout_to - 20)
        .filter(|s| arrived.contains_key(s))
        .collect();
    assert!(
        late.is_empty(),
        "datagrams from the blackout arrived afterwards: {late:?}"
    );
    let after: Vec<_> = (blackout_to + 20..1000)
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

/// TCP both ways under 5% loss and reordering: relay to house (the web ports)
/// and house to relay (the way the house reaches a service on the relay).
#[tokio::test(flavor = "current_thread")]
async fn tcp_both_directions_under_loss() {
    let pair = ready(13).await;
    pair.link.shape(Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(5),
        jitter: Duration::from_millis(5),
        blackout: false,
    });
    let mut inbound = TcpStream::connect(pair.web()).await.unwrap();
    let mut outbound = TcpStream::connect(pair.back()).await.unwrap();
    let a = tcp_transfer(&mut inbound, 512 * 1024, 1);
    let b = tcp_transfer(&mut outbound, 512 * 1024, 2);
    tokio::time::timeout(Duration::from_secs(90), async { tokio::join!(a, b) })
        .await
        .expect("transfers stalled");
    assert!(pair.link.lost() > 0);
}

/// A connection closed from either side closes through the tunnel, and its slot
/// is given back.
#[tokio::test(flavor = "current_thread")]
async fn tcp_close_reaches_the_other_side_and_frees_the_connection() {
    let pair = ready(14).await;
    for _ in 0..3 {
        let mut stream = TcpStream::connect(pair.web()).await.unwrap();
        tcp_transfer(&mut stream, 4096, 3).await;
        drop(stream);
    }
    eventually(Duration::from_secs(15), || {
        pair.relay().status.lock().unwrap().counters.tcp_connections == 0
            && pair.house().status.lock().unwrap().counters.tcp_connections == 0
    })
    .await;
}

/// A forward whose local service refuses resets the tunnel's connection, so the
/// client sees it end rather than hang.
#[tokio::test(flavor = "current_thread")]
async fn tcp_refused_target_ends_the_client_connection() {
    let (udp, _a) = udp_echo().await;
    let refused = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };
    let o = Options::default();
    let port = free_udp_port().await;
    let relay = start_relay(port, refused, &o).await;
    let link = Link::new(SocketAddr::from(([127, 0, 0, 1], port)), 5).await;
    let house = start_house(link.addr, udp, refused, &o).await;
    eventually(UP, || handshaken(&relay)).await;
    let mut stream = TcpStream::connect(relay.tcp_client_addrs[0]).await.unwrap();
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 16];
    let read = tokio::time::timeout(Duration::from_secs(20), stream.read(&mut buf))
        .await
        .expect("the connection hung");
    assert!(matches!(read, Ok(0) | Err(_)));
    drop(house);
}

async fn blackout_recovers(seconds: u64, seed: u64) {
    let pair = ready(seed).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), UP).await;
    let mut held = TcpStream::connect(pair.web()).await.unwrap();
    tcp_transfer(&mut held, 8192, 4).await;
    pair.link.blackout(true);
    tokio::time::sleep(Duration::from_secs(seconds)).await;
    pair.link.blackout(false);
    let took = udp_recovers(&client, pair.media(), Duration::from_secs(30)).await;
    assert!(took < Duration::from_secs(30));
    // The connection opened before the outage carries on after it.
    tokio::time::timeout(
        Duration::from_secs(60),
        tcp_transfer(&mut held, 64 * 1024, 5),
    )
    .await
    .expect("held connection stalled");
}

/// A 10 s outage ends by itself: UDP flows again and an open TCP connection survives.
#[tokio::test(flavor = "current_thread")]
async fn recovers_from_a_10s_blackout() {
    blackout_recovers(10, 21).await;
}

/// A 60 s outage ends by itself the same way.
#[tokio::test(flavor = "current_thread")]
async fn recovers_from_a_60s_blackout() {
    blackout_recovers(60, 22).await;
}

/// A game-like stream (1.7 KB every 50 ms over a 30 ms link that loses 0.3%)
/// held through a 30 s outage moves again at once and catches up. Before the
/// retransmission fix the RTT estimate sat at 10 s after the outage, so each
/// later loss stalled the stream for 10 s and it never caught up.
#[tokio::test(flavor = "current_thread")]
async fn a_held_stream_catches_up_after_a_30s_blackout() {
    let pair = ready(25).await;
    let lossy = |blackout| Shape {
        loss_ppm: 3_000,
        delay: Duration::from_millis(30),
        jitter: Duration::from_millis(5),
        blackout,
    };
    pair.link.shape(lossy(false));
    let stream = TcpStream::connect(pair.web()).await.unwrap();
    stream.set_nodelay(true).unwrap();
    let (mut r, mut w) = stream.into_split();
    let chunks = 1_000usize;
    let writer = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(50));
        for _ in 0..chunks {
            tick.tick().await;
            w.write_all(&[7u8; 1700]).await.unwrap();
        }
        w
    });
    let reader = tokio::spawn(async move {
        let mut buf = vec![0u8; 1700];
        let mut arrived = Vec::with_capacity(chunks);
        for _ in 0..chunks {
            r.read_exact(&mut buf).await.unwrap();
            arrived.push(Instant::now());
        }
        arrived
    });
    tokio::time::sleep(Duration::from_secs(10)).await;
    pair.link.shape(lossy(true));
    tokio::time::sleep(Duration::from_secs(30)).await;
    pair.link.shape(lossy(false));
    let back = Instant::now();
    let arrived = tokio::time::timeout(Duration::from_secs(30), reader)
        .await
        .expect("the stream never caught up")
        .unwrap();
    let _ = writer.await.unwrap();
    let after: Vec<Instant> = arrived.into_iter().filter(|t| *t > back).collect();
    let first = after[0] - back;
    let worst = after.windows(2).map(|p| p[1] - p[0]).max().unwrap();
    assert!(
        first < Duration::from_secs(3),
        "first data {first:?} after the link returned"
    );
    assert!(
        worst < Duration::from_millis(1500),
        "a {worst:?} stall after the link returned"
    );
}

/// Outages past WireGuard's own clocks: REKEY_ATTEMPT_TIME (90 s), the stale
/// handshake (150 s), REJECT_AFTER_TIME (180 s) and the session's end (540 s).
/// UDP comes back and a connection held open through it carries on. They run
/// for minutes, so only on request: `cargo test -- --ignored`.
#[tokio::test(flavor = "current_thread")]
#[ignore = "runs for over three minutes"]
async fn recovers_from_a_200s_blackout() {
    blackout_recovers(200, 23).await;
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "runs for over ten minutes"]
async fn recovers_from_a_600s_blackout() {
    blackout_recovers(600, 24).await;
}

/// The relay restarts and forgets its session: the house's next keepalive is
/// refused, the relay starts a handshake towards it, and traffic flows again.
#[tokio::test(flavor = "current_thread")]
async fn relay_restart_recovers() {
    let mut pair = Pair::new(
        Options {
            keepalive: 2,
            ..Options::default()
        },
        31,
    )
    .await;
    eventually(UP, || handshaken(pair.relay())).await;
    pair.restart_relay().await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), Duration::from_secs(20)).await;
    let mut stream = TcpStream::connect(pair.web()).await.unwrap();
    tcp_transfer(&mut stream, 16 * 1024, 6).await;
}

/// The house restarts: it dials again at once.
#[tokio::test(flavor = "current_thread")]
async fn house_restart_recovers() {
    let mut pair = ready(32).await;
    pair.restart_house().await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let took = udp_recovers(&client, pair.media(), Duration::from_secs(20)).await;
    assert!(took < Duration::from_secs(10), "took {took:?}");
}

/// The house's address changes mid-call (a NAT rebinding): the relay follows the
/// authenticated packets to the new address and the replies go there.
#[tokio::test(flavor = "current_thread")]
async fn roaming_follows_the_peer() {
    let mut pair = Pair::new(
        Options {
            keepalive: 1,
            ..Options::default()
        },
        33,
    )
    .await;
    eventually(UP, || handshaken(pair.relay())).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), UP).await;
    let moved = pair.link.rebind().await;
    eventually(UP, || {
        pair.relay().status.lock().unwrap().endpoint == Some(moved)
    })
    .await;
    udp_recovers(&client, pair.media(), UP).await;
}

/// WireGuard renews a session after 120 s of use. With traffic flowing for
/// longer than that, a second handshake happens and no datagram is lost to it.
#[tokio::test(flavor = "current_thread")]
async fn rekey_happens_on_the_timers() {
    let pair = Pair::new(
        Options {
            keepalive: 5,
            ..Options::default()
        },
        34,
    )
    .await;
    eventually(UP, || handshaken(pair.relay()) && handshaken(pair.house())).await;
    let first = pair.house().status.lock().unwrap().last_handshake.unwrap();
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(135) {
        assert!(
            udp_round_trip(&client, pair.media(), b"tick", Duration::from_secs(2))
                .await
                .is_some(),
            "a datagram was lost at {:?}",
            start.elapsed()
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let last = pair.house().status.lock().unwrap().last_handshake.unwrap();
    assert!(
        last.duration_since(first).unwrap() > Duration::from_secs(100),
        "no rekey happened"
    );
}

/// Many flows at once: 200 UDP clients and 40 TCP connections, all answered.
#[tokio::test(flavor = "current_thread")]
async fn many_concurrent_flows() {
    let pair = ready(41).await;
    let media = pair.media();
    let mut udp = Vec::new();
    for i in 0..200u32 {
        udp.push(tokio::spawn(async move {
            let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
            for j in 0..5u32 {
                let msg = format!("{i}-{j}");
                let mut ok = false;
                for _ in 0..5 {
                    if udp_round_trip(&client, media, msg.as_bytes(), Duration::from_secs(1))
                        .await
                        .is_some()
                    {
                        ok = true;
                        break;
                    }
                }
                assert!(ok, "flow {i} message {j} never came back");
            }
        }));
    }
    let web = pair.web();
    let mut tcp = Vec::new();
    for i in 0..40u8 {
        tcp.push(tokio::spawn(async move {
            let mut s = TcpStream::connect(web).await.unwrap();
            tcp_transfer(&mut s, 32 * 1024, i).await;
        }));
    }
    for t in udp.into_iter().chain(tcp) {
        t.await.unwrap();
    }
    let sessions = pair.house().status.lock().unwrap().counters.udp_sessions;
    assert!(sessions >= 200, "{sessions}");
}

/// The session cap refuses the newest flows while the table is full, and an idle
/// flow expires and gives its slot to a new one.
#[tokio::test(flavor = "current_thread")]
async fn session_cap_and_idle_expiry() {
    let pair = Pair::new(
        Options {
            udp_sessions: 4,
            udp_idle: 2,
            ..Options::default()
        },
        51,
    )
    .await;
    eventually(UP, || handshaken(pair.house()) && handshaken(pair.relay())).await;
    let mut clients = Vec::new();
    for _ in 0..6 {
        clients.push(UdpSocket::bind("127.0.0.1:0").await.unwrap());
    }
    let mut answered = 0;
    for c in &clients {
        if udp_round_trip(c, pair.media(), b"hello", Duration::from_millis(800))
            .await
            .is_some()
        {
            answered += 1;
        }
    }
    assert_eq!(answered, 4, "the cap of four was not held");
    assert!(pair.relay().status.lock().unwrap().counters.dropped_full >= 2);
    // Everyone goes quiet; the flows expire; a newcomer gets through.
    tokio::time::sleep(Duration::from_secs(4)).await;
    let late = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    assert!(
        udp_round_trip(&late, pair.media(), b"late", Duration::from_secs(2))
            .await
            .is_some()
    );
    eventually(Duration::from_secs(5), || {
        pair.relay().status.lock().unwrap().counters.udp_sessions <= 1
    })
    .await;
}

#[cfg(target_os = "linux")]
fn resident_bytes() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
    Some(pages * 4096)
}

#[cfg(not(target_os = "linux"))]
fn resident_bytes() -> Option<u64> {
    None
}

/// A flood from thousands of source addresses and garbage at the WireGuard port:
/// the table holds its cap, nothing panics, memory stays flat (measured where the
/// platform reports it), and real traffic still gets through afterwards.
#[tokio::test(flavor = "current_thread")]
async fn flood_stays_bounded() {
    let pair = Pair::new(
        Options {
            udp_sessions: 64,
            ..Options::default()
        },
        61,
    )
    .await;
    eventually(UP, || handshaken(pair.house())).await;
    let before = resident_bytes();
    let media = pair.media();
    let wire = SocketAddr::from(([127, 0, 0, 1], pair.relay_port));
    let mut flooders = Vec::new();
    for f in 0..8u8 {
        flooders.push(tokio::task::spawn_blocking(move || {
            let junk = vec![f; 1200];
            for _ in 0..40 {
                let s = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
                for _ in 0..250 {
                    let _ = s.send_to(&junk, media);
                    let _ = s.send_to(&junk[..(f as usize * 37) % 200], wire);
                }
            }
        }));
    }
    for f in flooders {
        f.await.unwrap();
    }
    // The flood's flows are refused once the table is full, and the garbage at
    // the WireGuard port is rejected; both are counted.
    eventually(Duration::from_secs(5), || {
        let c = pair.relay().status.lock().unwrap().counters.clone();
        c.rejected_wire > 0 && c.dropped_full > 0
    })
    .await;
    let status = pair.relay().status.lock().unwrap().clone();
    assert!(
        status.counters.udp_sessions <= 64,
        "{}",
        status.counters.udp_sessions
    );
    if let (Some(a), Some(b)) = (before, resident_bytes()) {
        assert!(
            b < a + 64 * 1024 * 1024,
            "resident memory grew from {a} to {b}"
        );
    }
    // The link is still up and a TCP forward still works.
    assert!(handshaken(pair.relay()));
    let mut s = TcpStream::connect(pair.web()).await.unwrap();
    tcp_transfer(&mut s, 16 * 1024, 9).await;
}

/// The status endpoint over HTTP, read the way the dashboard reads it.
#[tokio::test(flavor = "current_thread")]
async fn status_endpoint_reports_the_handshake() {
    let pair = ready(71).await;
    let listener = polaris_tunnel::status::bind("127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(polaris_tunnel::status::serve(
        listener,
        pair.house().status.clone(),
    ));
    tokio::time::sleep(Duration::from_millis(300)).await;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET /metrics HTTP/1.1\r\nHost: x\r\n\r\n")
        .await
        .unwrap();
    let mut text = String::new();
    s.read_to_string(&mut text).await.unwrap();
    assert!(text.starts_with("HTTP/1.1 200 OK"));
    let (_, relay_public) = key(1);
    let hex: String = base64_decode(&relay_public)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert!(text.contains(&format!("public_key={hex}")));
    let sec: u64 = text
        .lines()
        .find_map(|l| l.strip_prefix("last_handshake_time_sec="))
        .unwrap()
        .parse()
        .unwrap();
    assert!(sec > 1_600_000_000);
    let mut s = TcpStream::connect(addr).await.unwrap();
    s.write_all(b"GET /readyz HTTP/1.1\r\n\r\n").await.unwrap();
    let mut text = String::new();
    s.read_to_string(&mut text).await.unwrap();
    assert!(text.starts_with("HTTP/1.1 200 OK") && text.ends_with("{}"));
    task.abort();
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

/// Many long-lived TCP connections - players on a game server - share the link
/// through loss, a blackout and loss again; every one carries on, none is reset.
/// This is what TCP side ports need from the link to ride it without a separate
/// proxy in between.
#[tokio::test(flavor = "current_thread")]
async fn many_long_lived_tcp_connections_survive_loss_and_a_blackout() {
    let pair = ready(81).await;
    let web = pair.web();
    let mut held = Vec::new();
    for i in 0..100u8 {
        let mut s = TcpStream::connect(web).await.unwrap();
        tcp_transfer(&mut s, 2048, i).await;
        held.push(s);
    }
    let lossy = Shape {
        loss_ppm: 50_000,
        delay: Duration::from_millis(10),
        jitter: Duration::from_millis(5),
        blackout: false,
    };
    for round in 0..3u8 {
        pair.link.shape(lossy);
        let mut tasks = Vec::new();
        for (i, mut s) in held.drain(..).enumerate() {
            tasks.push(tokio::spawn(async move {
                tokio::time::timeout(
                    Duration::from_secs(90),
                    tcp_transfer(&mut s, 8192, i as u8 ^ round),
                )
                .await
                .unwrap_or_else(|_| panic!("connection {i} stalled in round {round}"));
                s
            }));
        }
        for task in tasks {
            held.push(task.await.unwrap());
        }
        // Between rounds: a 10 s outage with every connection open and idle.
        if round < 2 {
            pair.link.blackout(true);
            tokio::time::sleep(Duration::from_secs(10)).await;
            pair.link.blackout(false);
        }
    }
    assert_eq!(held.len(), 100);
}
