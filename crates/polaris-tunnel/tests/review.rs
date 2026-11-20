//! What a hostile or unlucky network does to the daemon: packets from strangers,
//! a peer that moves or is recreated, bulk transfers next to call media, and
//! connections that never finish. Every test here runs on a current-thread
//! runtime, as the daemon does in production.

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use common::*;
use polaris_tunnel::config;
use polaris_tunnel::engine::{self, Handle, Limits};
use polaris_tunnel::status;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

const UP: Duration = Duration::from_secs(15);

async fn ready(options: Options, seed: u64) -> Pair {
    let pair = Pair::new(options, seed).await;
    eventually(UP, || handshaken(pair.relay()) && handshaken(pair.house())).await;
    pair
}

fn endpoint(h: &Handle) -> Option<SocketAddr> {
    h.status.lock().unwrap().endpoint
}

fn tcp_connections(h: &Handle) -> u64 {
    h.status.lock().unwrap().counters.tcp_connections
}

fn relay_wire(pair: &Pair) -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], pair.relay_port))
}

/// Every datagram `socket` receives within `window`, by its first byte.
async fn received_kinds(socket: &UdpSocket, window: Duration) -> Vec<u8> {
    let mut kinds = Vec::new();
    let mut buf = vec![0u8; 2048];
    let end = Instant::now() + window;
    while let Some(left) = end.checked_duration_since(Instant::now()) {
        match tokio::time::timeout(left, socket.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) if n > 0 => kinds.push(buf[0]),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    kinds
}

/// A handshake response whose mac1 is valid for the relay's key: computing one
/// needs only the relay's public key, so anyone who has it can send these. (The
/// test borrows the relay's private key only to let boringtun build one.)
fn forged_response() -> Vec<u8> {
    let relay = StaticSecret::from([1u8; 32]);
    let stranger = StaticSecret::from([77u8; 32]);
    let mut x = Tunn::new(
        relay.clone(),
        PublicKey::from(&stranger),
        None,
        None,
        1,
        None,
    );
    let mut y = Tunn::new(stranger, PublicKey::from(&relay), None, None, 2, None);
    let (mut a, mut b) = (vec![0u8; 2048], vec![0u8; 2048]);
    let TunnResult::WriteToNetwork(init) = x.format_handshake_initiation(&mut a, false) else {
        panic!("no initiation");
    };
    let init = init.to_vec();
    let TunnResult::WriteToNetwork(response) = y.decapsulate(None, &init, &mut b) else {
        panic!("no response");
    };
    assert_eq!(response[0], 2);
    response.to_vec()
}

/// A flood of handshake responses puts boringtun under load, where it answers
/// with a cookie instead of checking them. A cookie reply proves nothing about
/// the sender, so the relay must keep sending to the house.
#[tokio::test(flavor = "current_thread")]
async fn a_cookie_reply_never_moves_the_endpoint() {
    let pair = ready(Options::default(), 101).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), UP).await;
    let house = endpoint(pair.relay()).expect("the relay knows the house");

    let attacker = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let me = attacker.local_addr().unwrap();
    let response = forged_response();
    let mut junk = vec![4u8, 0, 0, 0];
    junk.extend((0..60u8).map(|i| i.wrapping_mul(37)));
    let mut kinds = Vec::new();
    for round in 0..5 {
        for _ in 0..30 {
            attacker
                .send_to(&response, relay_wire(&pair))
                .await
                .unwrap();
        }
        attacker.send_to(&junk, relay_wire(&pair)).await.unwrap();
        kinds.extend(received_kinds(&attacker, Duration::from_millis(250)).await);
        assert_ne!(endpoint(pair.relay()), Some(me), "moved in round {round}");
    }
    assert!(kinds.contains(&3), "the cookie path never ran: {kinds:?}");
    assert_eq!(endpoint(pair.relay()), Some(house));
    // And the call carries on where it was.
    let rtt = udp_round_trip(&client, pair.media(), b"after", Duration::from_secs(2)).await;
    assert!(rtt.is_some(), "media stopped after the flood");
}

/// Garbage that looks like data draws no handshake back to whoever sent it: that
/// would reflect traffic at a spoofed address and restart the peer's handshake.
#[tokio::test(flavor = "current_thread")]
async fn junk_data_draws_no_handshake_to_its_sender() {
    let pair = ready(Options::default(), 102).await;
    let handshakes = pair.relay().status.lock().unwrap().counters.handshakes;
    let attacker = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    for i in 0..40u8 {
        let mut junk = vec![4u8, 0, 0, 0, i, 1, 2, 3];
        junk.extend([i; 40]);
        attacker.send_to(&junk, relay_wire(&pair)).await.unwrap();
    }
    let kinds = received_kinds(&attacker, Duration::from_millis(1500)).await;
    assert!(kinds.is_empty(), "the relay answered junk with {kinds:?}");
    let after = pair.relay().status.lock().unwrap().counters.handshakes;
    assert_eq!(after, handshakes, "junk restarted the handshake");
}

/// A relay that just restarted knows no peer address, so data for its lost
/// session is answered where it came from - and junk is too, but never more
/// than once a second however much of it arrives.
#[tokio::test(flavor = "current_thread")]
async fn a_restarted_relay_answers_junk_at_a_bounded_rate() {
    let mut pair = ready(Options::default(), 130).await;
    if let Some(house) = pair.house.take() {
        house.stop().await;
    }
    pair.restart_relay().await;
    let attacker = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let start = Instant::now();
    for i in 0..40u8 {
        let mut junk = vec![4u8, 0, 0, 0, i, 1, 2, 3];
        junk.extend([i; 40]);
        attacker.send_to(&junk, relay_wire(&pair)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let kinds = received_kinds(&attacker, Duration::from_millis(1500)).await;
    let window = start.elapsed().as_secs() + 1;
    assert!(kinds.iter().all(|&k| k == 1), "answered with {kinds:?}");
    assert!(
        (1..=window as usize).contains(&kinds.len()),
        "{} answers in {window} s",
        kinds.len()
    );
    assert_eq!(endpoint(pair.relay()), None, "junk set the endpoint");
    assert_eq!(pair.relay().status.lock().unwrap().counters.handshakes, 0);
}

/// The house heard the relay from a new address, which then went dead. The
/// address the house was configured with still works, and the house returns to
/// it instead of sending into the dead one for good.
#[tokio::test(flavor = "current_thread")]
async fn the_dialling_end_returns_to_its_configured_endpoint() {
    let mut pair = ready(Options::default(), 103).await;
    let moved = pair.link.answer_from_elsewhere().await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), UP).await;
    eventually(Duration::from_secs(5), || {
        endpoint(pair.house()) == Some(moved)
    })
    .await;
    pair.link.silence_elsewhere();
    let start = Instant::now();
    let mut back = TcpStream::connect(pair.back()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(90), tcp_transfer(&mut back, 4096, 9))
        .await
        .expect("the house never found the relay again");
    let took = start.elapsed();
    eprintln!("back to the configured endpoint in {took:?}");
    assert!(took < Duration::from_secs(45), "took {took:?}");
    assert_eq!(endpoint(pair.house()), Some(pair.link.addr));
}

/// Call media keeps a normal round trip while a bulk transfer fills the link
/// towards the house and junk arrives on its wire socket. (Starvation by a
/// wire that never runs dry is `a_flooded_wire_still_serves_local_traffic`.)
#[tokio::test(flavor = "current_thread")]
async fn media_stays_fast_under_inbound_bulk() {
    let pair = ready(Options::default(), 104).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, pair.media(), UP).await;
    let web = pair.web();
    let bulk = tokio::spawn(async move {
        let stream = TcpStream::connect(web).await.unwrap();
        let (mut r, mut w) = stream.into_split();
        let drain = tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            while matches!(r.read(&mut buf).await, Ok(n) if n > 0) {}
        });
        let chunk = vec![7u8; 64 * 1024];
        while w.write_all(&chunk).await.is_ok() {}
        drain.abort();
    });
    // And datagrams flooding the house's wire socket from outside, faster than
    // one turn of the engine reads them.
    let house_wire = SocketAddr::from(([127, 0, 0, 1], pair.house().wire_addr.port()));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flooders: Vec<_> = (0..2)
        .map(|i| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
                let junk = [9u8 + i; 64];
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let _ = socket.send_to(&junk, house_wire);
                }
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut rtts = Vec::new();
    let mut lost = 0;
    for i in 0..150u32 {
        let payload = format!("media-{i}");
        match udp_round_trip(
            &client,
            pair.media(),
            payload.as_bytes(),
            Duration::from_secs(1),
        )
        .await
        {
            Some(rtt) => rtts.push(rtt),
            None => lost += 1,
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    bulk.abort();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    for f in flooders {
        f.join().unwrap();
    }
    rtts.sort();
    let p95 = rtts[rtts.len() * 95 / 100];
    let max = *rtts.last().unwrap();
    eprintln!(
        "media under bulk: p50 {:?} p95 {p95:?} max {max:?} lost {lost}",
        rtts[rtts.len() / 2]
    );
    // The daemon itself drops none of the media: every drop it makes is
    // counted, and none is. What is lost is lost in the kernel, at the wire
    // socket the junk keeps full; how much depends on how much CPU the machine
    // gives the daemon (0-2 on a quiet one, up to 10 on a loaded CI runner),
    // so the bound only catches a broken path.
    for side in [pair.relay(), pair.house()] {
        let c = side.status.lock().unwrap().counters.clone();
        assert_eq!(
            (c.dropped_full, c.dropped_malformed, c.dropped_unrouted),
            (0, 0, 0),
            "the daemon dropped media"
        );
    }
    assert!(lost <= 15, "{lost} of 150 media datagrams lost");
    // Latency is bounded the same way: a quiet machine sees a p95 of a few ms, a
    // loaded CI runner has shown 121 ms, and a broken path (media queued behind
    // the bulk, or waiting out a turn) shows up as the 1 s timeout instead.
    assert!(p95 < Duration::from_millis(300), "p95 {p95:?}");
}

/// Accept on `listener` and echo, but never close after the other side does,
/// and stop reading when `read` is false: a service that holds connections.
async fn holder(read: bool) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut stream, _)) = listener.accept().await {
            if !read {
                held.push(stream);
                continue;
            }
            tokio::spawn(async move {
                let mut buf = vec![0u8; 65536];
                loop {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if stream.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    }
                }
                // Hold the half-closed connection open for good.
                std::future::pending::<()>().await;
                drop(stream);
            });
        }
    });
    (addr, task)
}

/// A relay and house whose web forward reaches `web_target`.
async fn pair_with_web_target(
    web_target: SocketAddr,
    options: &Options,
    seed: u64,
) -> (Handle, Handle, Link) {
    let (udp, _) = udp_echo().await;
    let port = free_udp_port().await;
    let relay = start_relay(port, web_target, options).await;
    let link = Link::new(SocketAddr::from(([127, 0, 0, 1], port)), seed).await;
    let house = start_house(link.addr, udp, web_target, options).await;
    eventually(UP, || handshaken(&relay) && handshaken(&house)).await;
    (relay, house, link)
}

fn stuck_limits() -> Options {
    Options {
        limits: Limits {
            stuck_timeout: Duration::from_secs(2),
            zero_window_timeout: Duration::from_secs(3),
            ..Limits::default()
        },
        ..Options::default()
    }
}

/// A connection one side closed and the other never does is ended after the
/// stuck timeout, while a connection that is merely quiet is left alone.
#[tokio::test(flavor = "current_thread")]
async fn a_half_closed_connection_is_ended_and_a_quiet_one_never() {
    let (target, _t) = holder(true).await;
    let options = stuck_limits();
    let (relay, house, _link) = pair_with_web_target(target, &options, 105).await;
    let web = relay.tcp_client_addrs[0];
    let mut quiet = TcpStream::connect(web).await.unwrap();
    tcp_transfer(&mut quiet, 16, 1).await;
    let mut half = TcpStream::connect(web).await.unwrap();
    tcp_transfer(&mut half, 16, 2).await;
    half.shutdown().await.unwrap();
    eventually(Duration::from_secs(3), || tcp_connections(&house) == 2).await;
    eventually(Duration::from_secs(10), || {
        tcp_connections(&house) == 1 && tcp_connections(&relay) == 1
    })
    .await;
    // Well past the stuck timeout, the quiet one still works.
    tokio::time::sleep(Duration::from_secs(6)).await;
    tcp_transfer(&mut quiet, 1024, 3).await;
    assert_eq!(tcp_connections(&relay), 1);
}

/// A peer that accepts none of the data waiting for it (its window held at zero)
/// does not hold the connection for ever.
#[tokio::test(flavor = "current_thread")]
async fn a_window_held_at_zero_ends_the_connection() {
    let (target, _t) = holder(false).await;
    let options = stuck_limits();
    let (relay, house, _link) = pair_with_web_target(target, &options, 106).await;
    let web = relay.tcp_client_addrs[0];
    let writer = tokio::spawn(async move {
        let mut stream = TcpStream::connect(web).await.unwrap();
        let chunk = vec![1u8; 64 * 1024];
        while stream.write_all(&chunk).await.is_ok() {}
        std::future::pending::<()>().await;
    });
    eventually(Duration::from_secs(3), || tcp_connections(&relay) == 1).await;
    eventually(Duration::from_secs(20), || {
        tcp_connections(&relay) == 0 && tcp_connections(&house) == 0
    })
    .await;
    writer.abort();
}

/// More connections than one address may hold are refused; the rest keep going.
#[tokio::test(flavor = "current_thread")]
async fn one_address_cannot_take_every_connection() {
    let options = Options {
        limits: Limits {
            max_tcp_per_source: 4,
            ..Limits::default()
        },
        ..Options::default()
    };
    let pair = ready(options, 107).await;
    let mut open = Vec::new();
    for i in 0..4u8 {
        let mut s = TcpStream::connect(pair.web()).await.unwrap();
        tcp_transfer(&mut s, 64, i).await;
        open.push(s);
    }
    eventually(Duration::from_secs(2), || {
        tcp_connections(pair.relay()) == 4
    })
    .await;
    let mut fifth = TcpStream::connect(pair.web()).await.unwrap();
    let _ = fifth.write_all(b"x").await;
    let mut buf = [0u8; 4];
    let read = tokio::time::timeout(Duration::from_secs(5), fifth.read(&mut buf)).await;
    assert!(
        matches!(read, Ok(Ok(0)) | Ok(Err(_))),
        "the fifth was carried: {read:?}"
    );
    drop(open.pop());
    eventually(Duration::from_secs(5), || {
        tcp_connections(pair.relay()) <= 3
    })
    .await;
    let mut again = TcpStream::connect(pair.web()).await.unwrap();
    tcp_transfer(&mut again, 64, 9).await;
}

/// The old cap of 512 connections per daemon is gone: far more than that are
/// carried at once with the default limits.
#[tokio::test(flavor = "current_thread")]
async fn more_connections_than_the_old_cap() {
    let pair = ready(Options::default(), 108).await;
    let mut open = Vec::new();
    for i in 0..600u32 {
        let mut s = TcpStream::connect(pair.web()).await.unwrap();
        tokio::time::timeout(Duration::from_secs(10), tcp_transfer(&mut s, 8, i as u8))
            .await
            .unwrap_or_else(|_| panic!("connection {i} was not carried"));
        open.push(s);
    }
    eventually(Duration::from_secs(3), || {
        tcp_connections(pair.relay()) >= 600
    })
    .await;
    assert!(Limits::default().max_tcp >= 4096);
}

/// When the engine drops a connection (the target refused it), the local
/// stream is closed both ways even if the client never sends another byte.
#[tokio::test(flavor = "current_thread")]
async fn a_dropped_connection_closes_its_silent_local_stream() {
    let dead = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap()
    };
    let (relay, _house, _link) = pair_with_web_target(dead, &Options::default(), 109).await;
    let mut silent = TcpStream::connect(relay.tcp_client_addrs[0]).await.unwrap();
    let mut buf = [0u8; 4];
    let read = tokio::time::timeout(Duration::from_secs(15), silent.read(&mut buf)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "{read:?}");
    eventually(Duration::from_secs(5), || relay.local_streams() == 0).await;
    eventually(Duration::from_secs(5), || tcp_connections(&relay) == 0).await;
    drop(silent);
}

fn named(text: &str, addr: SocketAddr, name: &str) -> String {
    text.replace(&format!("Endpoint = {addr}"), &format!("Endpoint = {name}"))
}

/// The web helper is recreated: same keys, a new address behind the same name.
/// The house follows the name within seconds, not after a stale handshake.
#[tokio::test(flavor = "current_thread")]
async fn the_dialling_end_follows_its_name_to_a_new_address() {
    let options = Options::default();
    let (udp, _a) = udp_echo().await;
    let (tcp, _b) = tcp_echo().await;
    let p1 = free_udp_port().await;
    let r1 = start_relay(p1, tcp, &options).await;
    let l1 = Link::new(SocketAddr::from(([127, 0, 0, 1], p1)), 1).await;
    let name = format!("relay-moves.test:{}", l1.addr.port());
    engine::pin_name(&name, Some(l1.addr));
    let text = named(&house_config(l1.addr, udp, tcp, &options), l1.addr, &name);
    let house = engine::start(config::parse(&text).unwrap(), options.limits.clone())
        .await
        .unwrap();
    eventually(UP, || handshaken(&r1) && handshaken(&house)).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, r1.udp_proxy_addrs[0], UP).await;

    let p2 = free_udp_port().await;
    let r2 = start_relay(p2, tcp, &options).await;
    let l2 = Link::new(SocketAddr::from(([127, 0, 0, 1], p2)), 2).await;
    engine::pin_name(&name, Some(l2.addr));
    r1.stop().await;
    let took = udp_recovers(&client, r2.udp_proxy_addrs[0], Duration::from_secs(60)).await;
    eprintln!("followed the name in {took:?}");
    assert!(took < Duration::from_secs(20), "took {took:?}");
    engine::pin_name(&name, None);
}

/// An endpoint name that resolves to an IPv6 address is reached over IPv6.
#[tokio::test(flavor = "current_thread")]
async fn a_name_that_resolves_to_ipv6_is_reached() {
    let options = Options::default();
    let (udp, _a) = udp_echo().await;
    let (tcp, _b) = tcp_echo().await;
    let port = free_udp_port().await;
    let relay = start_relay(port, tcp, &options).await;
    let link = Link::new_at(SocketAddr::from(([127, 0, 0, 1], port)), 3, "[::1]:0").await;
    let name = format!("relay-v6.test:{}", link.addr.port());
    engine::pin_name(&name, Some(link.addr));
    let text = named(
        &house_config(link.addr, udp, tcp, &options),
        link.addr,
        &name,
    );
    let house = engine::start(config::parse(&text).unwrap(), options.limits.clone())
        .await
        .unwrap();
    eventually(UP, || handshaken(&relay) && handshaken(&house)).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, relay.udp_proxy_addrs[0], UP).await;
    engine::pin_name(&name, None);
}

/// A `[UDPServerTunnel]` listening on a port of the dynamic range: the ports
/// handed to proxy clients skip it, so their replies are not taken by it.
#[tokio::test(flavor = "current_thread")]
async fn a_configured_port_in_the_dynamic_range_is_never_handed_out() {
    let options = Options::default();
    let (udp, _a) = udp_echo().await;
    let (tcp, _b) = tcp_echo().await;
    let port = free_udp_port().await;
    let text = format!(
        "{}\n[UDPServerTunnel]\nListenPort = 49152\nTarget = 127.0.0.1:9\n",
        relay_config(port, tcp, &options)
    );
    let relay = engine::start(config::parse(&text).unwrap(), options.limits.clone())
        .await
        .unwrap();
    let link = Link::new(SocketAddr::from(([127, 0, 0, 1], port)), 4).await;
    let house = start_house(link.addr, udp, tcp, &options).await;
    eventually(UP, || handshaken(&relay) && handshaken(&house)).await;
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    udp_recovers(&client, relay.udp_proxy_addrs[0], Duration::from_secs(5)).await;
}

/// Neither the metrics nor any other status answer carries the private key, in
/// any of the forms it could be printed in.
#[test]
fn the_private_key_is_never_printed() {
    let (private, public) = key(2);
    let secret = StaticSecret::from([2u8; 32]).to_bytes();
    let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    let forms = [
        private.clone(),
        private.trim_end_matches('=').to_string(),
        hex.clone(),
        hex.to_uppercase(),
        format!("{:?}", secret),
        format!("{:?}", &secret[..8]),
    ];
    let cfg = config::parse(&house_config(
        "127.0.0.1:1".parse().unwrap(),
        "127.0.0.1:2".parse().unwrap(),
        "127.0.0.1:3".parse().unwrap(),
        &Options::default(),
    ))
    .unwrap();
    let mut s = engine::Status {
        listen_port: 51820,
        public_key: cfg.peer.public_key,
        keepalive: 25,
        ..Default::default()
    };
    s.allowed_ips = vec!["10.9.0.1/32".into()];
    let mut outputs = vec![status::render_metrics(&s), format!("{s:?}")];
    for path in ["/metrics", "/readyz", "/", "/debug"] {
        let request = format!("GET {path} HTTP/1.1\r\n\r\n");
        outputs.push(status::respond(request.as_bytes(), &s).2);
    }
    for out in &outputs {
        for form in &forms {
            assert!(!out.contains(form.as_str()), "printed {form:?} in {out:?}");
        }
        assert!(!out.contains("private_key"));
    }
    // The peer's key is printed, so the check above is looking at real output.
    assert_ne!(public, private);
    assert!(outputs[0].contains("public_key="));
}

/// A service that sends `bytes` to whoever connects, then closes.
async fn source(bytes: usize) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let chunk = vec![5u8; 64 * 1024];
                let mut left = bytes;
                while left > 0 {
                    let n = left.min(chunk.len());
                    if stream.write_all(&chunk[..n]).await.is_err() {
                        return;
                    }
                    left -= n;
                }
                let _ = stream.shutdown().await;
            });
        }
    });
    (addr, task)
}

/// Mbit/s of one download from the house through the relay over `shape`.
async fn download_rate(shape: Shape, bytes: usize, seed: u64) -> f64 {
    let (target, _t) = source(bytes).await;
    let (relay, _house, link) = pair_with_web_target(target, &Options::default(), seed).await;
    link.shape(shape);
    let start = Instant::now();
    let mut stream = TcpStream::connect(relay.tcp_client_addrs[0]).await.unwrap();
    let mut got = 0usize;
    let mut buf = vec![0u8; 65536];
    loop {
        match tokio::time::timeout(Duration::from_secs(120), stream.read(&mut buf)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => got += n,
            other => panic!("download stalled at {got} bytes: {other:?}"),
        }
    }
    assert_eq!(got, bytes);
    (bytes as f64 * 8.0) / start.elapsed().as_secs_f64() / 1e6
}

/// One TCP connection at a satellite round trip (60 ms) with and without 1%
/// loss: big enough windows to fill the path, and congestion control that backs
/// off on loss instead of flooding the link the call media shares.
#[tokio::test(flavor = "current_thread")]
async fn throughput_at_satellite_round_trip() {
    let clean = Shape {
        delay: Duration::from_millis(30),
        ..Shape::default()
    };
    let lossy = Shape {
        loss_ppm: 10_000,
        ..clean
    };
    let clean_rate = download_rate(clean, 8 << 20, 110).await;
    let lossy_rate = download_rate(lossy, 4 << 20, 111).await;
    eprintln!(
        "download at 60 ms RTT: {clean_rate:.1} Mbit/s clean, {lossy_rate:.1} Mbit/s at 1% loss"
    );
    // Before: 4.5 Mbit/s clean and 0.9 at 1% loss (64 KiB buffers, no
    // congestion control, four service rounds per wake); after: 5.5-5.8 clean
    // and 2.0-2.5 at 1% loss on the same Windows machine. Clean, the harness is
    // the ceiling, not the daemon: both daemons, the link and both ends share
    // one thread, and the link's 64 KiB loopback socket buffers drop bursts
    // (with 4 MiB buffers the same build carries 14 Mbit/s here, and hundreds
    // with no delay). So the clean floor only catches a collapse, such as the
    // congestion controller that resets its window on every send, while the
    // lossy floor sits between before and after.
    assert!(clean_rate > 4.0, "{clean_rate:.1} Mbit/s clean");
    assert!(lossy_rate > 1.5, "{lossy_rate:.1} Mbit/s at 1% loss");
}

/// A wire socket that never runs dry - junk arriving faster than one engine
/// reads it - must not stop the engine serving its own side: datagrams sent to
/// a forward still cross the link, and the timers still run. The flood is aimed
/// at the relay and the traffic only leaves it, so nothing the test counts can
/// be lost in the flooded socket's queue: only starvation can stop it.
#[tokio::test(flavor = "current_thread")]
async fn a_flooded_wire_still_serves_local_traffic() {
    let options = Options::default();
    let target = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let target_addr = target.local_addr().unwrap();
    let (tcp_echo, _echo) = tcp_echo().await;
    let relay_port = free_udp_port().await;
    let relay = start_relay(relay_port, tcp_echo, &options).await;
    let link = Link::new(SocketAddr::from(([127, 0, 0, 1], relay_port)), 105).await;
    let house = start_house(link.addr, target_addr, tcp_echo, &options).await;
    eventually(UP, || handshaken(&relay) && handshaken(&house)).await;
    let media = relay.udp_proxy_addrs[0];
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut buf = [0u8; 64];
    // The forward works before the flood.
    let mut warm = false;
    for _ in 0..50 {
        client.send_to(b"warm", media).await.unwrap();
        if tokio::time::timeout(Duration::from_millis(100), target.recv_from(&mut buf))
            .await
            .is_ok()
        {
            warm = true;
            break;
        }
    }
    assert!(warm, "the forward never worked");
    let wire = SocketAddr::from(([127, 0, 0, 1], relay_port));
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flooders: Vec<_> = (0..12u8)
        .map(|i| {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
                let junk = [9u8.wrapping_add(i); 64];
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let _ = socket.send_to(&junk, wire);
                }
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let rejected_before = relay.status.lock().unwrap().counters.rejected_wire;
    let mut received = 0;
    for i in 0..100u32 {
        client
            .send_to(format!("one-way-{i}").as_bytes(), media)
            .await
            .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
        while let Ok(Ok(_)) = tokio::time::timeout_at(deadline, target.recv_from(&mut buf)).await {
            received += 1;
        }
    }
    while let Ok(Ok(_)) =
        tokio::time::timeout(Duration::from_millis(500), target.recv_from(&mut buf)).await
    {
        received += 1;
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    for f in flooders {
        f.join().unwrap();
    }
    let rejected = relay.status.lock().unwrap().counters.rejected_wire - rejected_before;
    eprintln!("flooded wire: {received} of 100 forwarded, {rejected} junk datagrams read");
    assert!(
        received >= 90,
        "{received} of 100 datagrams crossed a flooded relay"
    );
    // The counters are published by the timers: they moved, so the timers ran,
    // and the flood really reached the engine, or the test proves nothing.
    assert!(rejected > 10_000, "only {rejected} junk datagrams counted");
    relay.stop().await;
    house.stop().await;
}

/// An outage longer than the stuck timeouts ends no connection: bytes sent into
/// it wait unacknowledged, which looks like a window held at zero, but the peer
/// is out of reach rather than refusing them, and they arrive once it is back.
/// (The 600 s blackout lost its held connection this way at the 300 s mark.)
#[tokio::test(flavor = "current_thread")]
async fn an_outage_longer_than_the_stuck_timeouts_ends_no_connection() {
    let (target, _t) = tcp_echo().await;
    let mut options = stuck_limits();
    options.limits.peer_quiet = Duration::from_secs(1);
    let (relay, house, link) = pair_with_web_target(target, &options, 112).await;
    let mut held = TcpStream::connect(relay.tcp_client_addrs[0]).await.unwrap();
    tcp_transfer(&mut held, 1024, 1).await;
    link.blackout(true);
    let sent = vec![5u8; 4096];
    held.write_all(&sent).await.unwrap();
    // Well past both stuck timeouts (2 s and 3 s).
    tokio::time::sleep(Duration::from_secs(8)).await;
    assert_eq!(
        tcp_connections(&relay),
        1,
        "the outage ended the relay's connection"
    );
    assert_eq!(
        tcp_connections(&house),
        1,
        "the outage ended the house's connection"
    );
    link.blackout(false);
    let mut got = vec![0u8; sent.len()];
    tokio::time::timeout(Duration::from_secs(30), held.read_exact(&mut got))
        .await
        .expect("held connection stalled after the outage")
        .expect("held connection was closed by the outage");
    assert!(got == sent, "bytes came back changed");
}
