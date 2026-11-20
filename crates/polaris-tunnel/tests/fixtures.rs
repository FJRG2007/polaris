//! The config files the dashboard renders for this daemon, written by the
//! dashboard's `test/deploy/wireguard/tunnel-fixtures.test.ts`, and the
//! `/metrics` output its status reader is tested against.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use polaris_tunnel::config::{self, Config};
use polaris_tunnel::engine::{Counters, Status};
use polaris_tunnel::status::render_metrics;

/// The relay's side link rides its web link over IPv4: IP 20, UDP 8, WireGuard 32.
const NESTED_OVERHEAD_V4: u16 = 20 + 8 + 32;
const SIDE_WIRE_PORT: u16 = 52000;
/// The call link's wire port, the next one up (`CALL_WIRE_PORT` in relay.ts).
const CALL_WIRE_PORT: u16 = 52001;

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
}

fn load(name: &str) -> Config {
    let text = std::fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    config::parse(&text).unwrap_or_else(|e| panic!("{name}: {e}"))
}

#[test]
fn every_rendered_config_parses() {
    let mut names: Vec<String> = std::fs::read_dir(dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .filter(|n| n.ends_with(".conf"))
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "deploy-nat.conf",
            "deploy-public.conf",
            "relay-call-home.conf",
            "relay-call-relay.conf",
            "relay-side-home.conf",
            "relay-side-relay.conf",
            "relay-web-home.conf",
            "relay-web-relay.conf",
        ]
    );
    for name in &names {
        load(name);
    }
}

#[test]
fn deploy_tunnel_ends() {
    let public = load("deploy-public.conf");
    assert_eq!(public.interface.listen_port, Some(51821));
    assert_eq!(public.interface.mtu, 1420);
    assert_eq!(public.tcp_clients.len(), 1);
    assert_eq!(public.tcp_clients[0].bind.port(), 8080);
    assert_eq!(
        public.peer.public_key,
        config::parse_key("1MQX58+13U+z3jOrS+Pi1jy73Uo/164DFt+EJ+mBAWw=").unwrap()
    );
    let nat = load("deploy-nat.conf");
    assert_eq!(nat.peer.endpoint.as_deref(), Some("203.0.113.7:51821"));
    assert_eq!(nat.peer.keepalive, Some(25));
    assert_eq!(nat.tcp_servers[0].target, "web-app:3000");
}

#[test]
fn relay_links_nest_without_fragmenting() {
    let web_relay = load("relay-web-relay.conf");
    let web_home = load("relay-web-home.conf");
    let side_relay = load("relay-side-relay.conf");
    let side_home = load("relay-side-home.conf");
    let call_relay = load("relay-call-relay.conf");
    let call_home = load("relay-call-home.conf");

    // The web link carries only the web ports and two constant UDP forwards, one
    // per inner link...
    let web_ports: Vec<u16> = web_relay
        .tcp_clients
        .iter()
        .map(|t| t.bind.port())
        .collect();
    assert_eq!(web_ports, [80, 443]);
    assert!(web_relay.udp_proxies.is_empty());
    let wires: Vec<u16> = web_relay
        .udp_servers
        .iter()
        .map(|u| u.listen_port)
        .collect();
    assert_eq!(wires, [SIDE_WIRE_PORT, CALL_WIRE_PORT]);
    let home_wires: Vec<u16> = web_home.udp_proxies.iter().map(|u| u.bind.port()).collect();
    assert_eq!(home_wires, [SIDE_WIRE_PORT, CALL_WIRE_PORT]);
    // ... to the relay end's tunnel address, inside the web link.
    assert_eq!(
        web_home.udp_proxies[0].target.ip(),
        web_relay.interface.addresses[0].addr
    );
    assert_eq!(side_relay.interface.listen_port, Some(SIDE_WIRE_PORT));
    let endpoint = side_home.peer.endpoint.as_deref().unwrap();
    assert!(
        endpoint.ends_with(&format!(":{SIDE_WIRE_PORT}")),
        "{endpoint}"
    );
    assert_eq!(call_relay.interface.listen_port, Some(CALL_WIRE_PORT));
    let endpoint = call_home.peer.endpoint.as_deref().unwrap();
    assert!(
        endpoint.ends_with(&format!(":{CALL_WIRE_PORT}")),
        "{endpoint}"
    );

    // A full side packet, wrapped, is exactly one web link packet.
    for c in [&web_relay, &web_home] {
        assert_eq!(c.interface.mtu, 1420);
        assert!(c
            .interface
            .addresses
            .iter()
            .all(|a| matches!(a.addr, IpAddr::V4(_))));
    }
    for c in [&side_relay, &side_home, &call_relay, &call_home] {
        assert_eq!(c.interface.mtu, 1360);
        assert_eq!(
            c.interface.mtu + NESTED_OVERHEAD_V4,
            web_relay.interface.mtu
        );
    }

    // The call ports on their own link, so a game added or removed never
    // recreates what a call rides.
    let call_tcp: Vec<u16> = call_relay
        .tcp_clients
        .iter()
        .map(|t| t.bind.port())
        .collect();
    let call_udp: Vec<u16> = call_relay
        .udp_proxies
        .iter()
        .map(|u| u.bind.port())
        .collect();
    assert_eq!(call_tcp, [7881]);
    assert_eq!(call_udp, [7882]);

    // Every other side port natively, TCP as TCP and UDP as UDP.
    let mut tcp: Vec<u16> = side_relay
        .tcp_clients
        .iter()
        .map(|t| t.bind.port())
        .collect();
    let mut udp: Vec<u16> = side_relay
        .udp_proxies
        .iter()
        .map(|u| u.bind.port())
        .collect();
    tcp.sort_unstable();
    udp.sort_unstable();
    assert_eq!(tcp, [25565]);
    assert_eq!(udp, [19132]);
    let mut home_udp: Vec<u16> = side_home
        .udp_servers
        .iter()
        .map(|u| u.listen_port)
        .collect();
    home_udp.sort_unstable();
    assert_eq!(home_udp, [19132]);
    assert!(side_home
        .udp_servers
        .iter()
        .all(|u| u.target.starts_with("192.0.2.10:")));
}

fn check_golden(name: &str, text: &str) {
    let path = dir().join(name);
    if std::env::var("UPDATE_TUNNEL_FIXTURES").as_deref() == Ok("1") {
        std::fs::write(&path, text).unwrap();
    }
    let pinned = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(
        pinned, text,
        "{name} differs from render_metrics; the dashboard parses this file"
    );
}

#[test]
fn metrics_fixtures_are_what_the_daemon_serves() {
    let status = Status {
        listen_port: 0,
        public_key: config::parse_key("H1rVTCq9R6uneqH/iHv0NA/BmI22UIbLYWfxWXEBw38=").unwrap(),
        endpoint: Some("198.51.100.20:52000".parse().unwrap()),
        last_handshake: Some(SystemTime::UNIX_EPOCH + Duration::new(1_763_100_000, 500)),
        rx_bytes: 1_048_576,
        tx_bytes: 2048,
        keepalive: 25,
        allowed_ips: vec!["10.213.127.254/32".into()],
        counters: Counters {
            udp_sessions: 3,
            tcp_connections: 2,
            handshakes: 4,
            ..Counters::default()
        },
    };
    check_golden("metrics.txt", &render_metrics(&status));
    check_golden("metrics-fresh.txt", &render_metrics(&Status::default()));
}
