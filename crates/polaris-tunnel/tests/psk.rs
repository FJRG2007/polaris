//! A link with a preshared key: both ends with the same key shake hands and
//! carry traffic; ends whose keys differ never complete a handshake.

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::*;
use polaris_tunnel::config;
use polaris_tunnel::engine::{self, Handle};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

const PSK_A: &str = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=";
const PSK_B: &str = "IB8eHRwbGhkYFxYVFBMSERAPDg0MCwoJCAcGBQQDAgE=";

/// The same file with a `PresharedKey` line in its `[Peer]` section.
fn with_psk(text: &str, psk: &str) -> String {
    let at = text.find("[Peer]\n").expect("a [Peer] section") + "[Peer]\n".len();
    format!("{}PresharedKey = {psk}\n{}", &text[..at], &text[at..])
}

async fn pair(
    relay_psk: &str,
    house_psk: &str,
) -> (Handle, Handle, Vec<tokio::task::JoinHandle<()>>) {
    let options = Options {
        keepalive: 1,
        ..Options::default()
    };
    let (udp_echo, a) = udp_echo().await;
    let (tcp_echo, b) = tcp_echo().await;
    let mut relay = None;
    for _ in 0..50 {
        let port = free_udp_port().await;
        let text = with_psk(&relay_config(port, tcp_echo, &options), relay_psk);
        let cfg = config::parse(&text).unwrap();
        assert!(cfg.peer.preshared_key.is_some());
        if let Ok(h) = engine::start(cfg, options.limits.clone()).await {
            relay = Some(h);
            break;
        }
    }
    let relay = relay.expect("the relay could not bind");
    let endpoint = SocketAddr::from(([127, 0, 0, 1], relay.wire_addr.port()));
    let text = with_psk(
        &house_config(endpoint, udp_echo, tcp_echo, &options),
        house_psk,
    );
    let house = engine::start(config::parse(&text).unwrap(), options.limits.clone())
        .await
        .unwrap();
    (relay, house, vec![a, b])
}

fn handshaken(handle: &Handle) -> bool {
    handle.status.lock().unwrap().last_handshake.is_some()
}

#[tokio::test(flavor = "current_thread")]
async fn matching_preshared_keys_carry_udp_and_tcp() {
    let (relay, house, _services) = pair(PSK_A, PSK_A).await;
    eventually(Duration::from_secs(10), || {
        handshaken(&relay) && handshaken(&house)
    })
    .await;

    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut buf = [0u8; 64];
    let mut echoed = false;
    for _ in 0..20 {
        client
            .send_to(b"psk", relay.udp_proxy_addrs[0])
            .await
            .unwrap();
        if let Ok(Ok((n, _))) =
            tokio::time::timeout(Duration::from_millis(250), client.recv_from(&mut buf)).await
        {
            assert_eq!(&buf[..n], b"psk");
            echoed = true;
            break;
        }
    }
    assert!(echoed, "no UDP echo through a link with a preshared key");

    let mut tcp = TcpStream::connect(relay.tcp_client_addrs[0]).await.unwrap();
    tcp.write_all(b"hello over psk").await.unwrap();
    let mut back = [0u8; 14];
    tokio::time::timeout(Duration::from_secs(5), tcp.read_exact(&mut back))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&back, b"hello over psk");
    relay.stop().await;
    house.stop().await;
}

#[tokio::test(flavor = "current_thread")]
async fn different_preshared_keys_never_shake_hands() {
    let (relay, house, _services) = pair(PSK_A, PSK_B).await;
    // Keepalive is 1 s, so the house tries several handshakes in this window.
    tokio::time::sleep(Duration::from_secs(4)).await;
    assert!(
        !handshaken(&relay),
        "the relay accepted a handshake with another preshared key"
    );
    assert!(!handshaken(&house));
    let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    client
        .send_to(b"psk", relay.udp_proxy_addrs[0])
        .await
        .unwrap();
    let mut buf = [0u8; 64];
    let got = tokio::time::timeout(Duration::from_millis(800), client.recv_from(&mut buf)).await;
    assert!(
        got.is_err(),
        "a datagram crossed a link whose keys do not match"
    );
    relay.stop().await;
    house.stop().await;
}

#[test]
fn the_preshared_key_is_read_from_the_peer_section() {
    let options = Options::default();
    let plain = relay_config(51820, "127.0.0.1:1".parse().unwrap(), &options);
    assert!(config::parse(&plain).unwrap().peer.preshared_key.is_none());
    let keyed = config::parse(&with_psk(&plain, PSK_A)).unwrap();
    assert_eq!(keyed.peer.preshared_key.unwrap()[0], 1);
}
