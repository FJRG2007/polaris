//! The orders the app sends, one per connection on the loopback address. A line of
//! JSON each way: a challenge, the proved order, its answer. Orders run one at a
//! time, which is all a single tunnel can use.

use crate::{auth, config, tunnel::Tunnel};
use defguard_wireguard_rs::key::Key;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    io::{self, BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, TcpListener, TcpStream},
    str::FromStr,
    time::Duration,
};

pub const PORT: u16 = 51898;
/// Reported to the app, which reinstalls a service older than it expects.
pub const VERSION: u32 = 1;
const MAX_LINE: u64 = 16 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpRequest {
    pub node_id: String,
    pub address: String,
    pub dns: Vec<String>,
    pub node_public_key: String,
    pub endpoint: String,
    pub port: u16,
    /// A VPN from elsewhere has its own keys and may not carry everything.
    #[serde(default)]
    pub own: Option<OwnTunnel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnTunnel {
    pub private_key: String,
    pub preshared_key: Option<String>,
    pub more_addresses: Vec<String>,
    pub allowed_ips: Vec<String>,
    pub mtu: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "order", rename_all = "camelCase")]
enum Order {
    Status,
    Key,
    Down,
    Up(UpRequest),
}

#[derive(Deserialize)]
struct Envelope {
    answer: String,
    #[serde(flatten)]
    order: Order,
}

fn run(order: Order, tunnel: &mut Tunnel, private_key: &str) -> Value {
    match order {
        Order::Status => json!({ "ok": true, "version": VERSION, "nodeId": tunnel.node_id() }),
        Order::Key => match Key::from_str(private_key) {
            Ok(key) => json!({ "ok": true, "publicKey": key.public_key().to_string() }),
            Err(_) => json!({ "ok": false, "code": "failed" }),
        },
        Order::Down => {
            tunnel.down();
            json!({ "ok": true })
        }
        Order::Up(request) => match tunnel.up(private_key, &request) {
            Ok(()) => json!({ "ok": true }),
            Err(code) => json!({ "ok": false, "code": code }),
        },
    }
}

/// Reads the order on a line, after checking it proves the secret.
fn read_order(line: &str, secret: &str, nonce: &str) -> Result<Order, &'static str> {
    let envelope: Envelope = serde_json::from_str(line).map_err(|_| "badRequest")?;
    if auth::verify(secret, nonce, &envelope.answer) {
        Ok(envelope.order)
    } else {
        Err("denied")
    }
}

fn serve_one(stream: TcpStream, tunnel: &mut Tunnel, config: &config::Config) -> io::Result<()> {
    stream.set_read_timeout(Some(TIMEOUT))?;
    let mut writer = stream.try_clone()?;
    let nonce = Key::generate().to_lower_hex();
    writeln!(writer, "{}", json!({ "nonce": nonce }))?;
    let mut line = String::new();
    BufReader::new(stream.take(MAX_LINE)).read_line(&mut line)?;
    let reply = match read_order(&line, &config.secret, &nonce) {
        Ok(order) => run(order, tunnel, &config.private_key),
        Err(code) => json!({ "ok": false, "code": code }),
    };
    writeln!(writer, "{reply}")
}

/// Runs until the process ends. Loopback only: nothing off this computer can reach it.
pub fn serve() -> io::Result<()> {
    let config = config::load()?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, PORT))?;
    let mut tunnel = Tunnel::default();
    for stream in listener.incoming() {
        if let Err(error) = stream.and_then(|one| serve_one(one, &mut tunnel, &config)) {
            eprintln!("polaris-vpn: {error}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "secret";

    fn line(body: Value) -> String {
        let mut value = body;
        value["answer"] = json!(auth::respond(SECRET, "nonce"));
        value.to_string()
    }

    #[test]
    fn takes_a_proved_order() {
        let order = read_order(&line(json!({ "order": "status" })), SECRET, "nonce");
        assert!(matches!(order, Ok(Order::Status)));
    }

    #[test]
    fn refuses_an_answer_to_another_challenge() {
        let order = read_order(&line(json!({ "order": "down" })), SECRET, "fresh");
        assert!(matches!(order, Err("denied")));
    }

    #[test]
    fn reads_a_tunnel_with_its_own_keys() {
        let body = json!({
            "order": "up", "nodeId": "n", "address": "10.2.0.2/32", "dns": [],
            "nodePublicKey": "k", "endpoint": "198.51.100.1", "port": 51820,
            "own": { "privateKey": "p", "presharedKey": null, "moreAddresses": [],
                     "allowedIps": ["0.0.0.0/0"], "mtu": 1320 }
        });
        let order = read_order(&line(body), SECRET, "nonce");
        assert!(matches!(order, Ok(Order::Up(UpRequest { own: Some(_), .. }))));
    }

    #[test]
    fn refuses_what_is_not_an_order() {
        assert!(matches!(read_order("nonsense", SECRET, "nonce"), Err("badRequest")));
        let order = read_order(&line(json!({ "order": "format" })), SECRET, "nonce");
        assert!(matches!(order, Err("badRequest")));
    }

    #[test]
    fn reads_an_up_order() {
        let body = json!({
            "order": "up", "nodeId": "n", "address": "10.128.0.2/32", "dns": ["1.1.1.1"],
            "nodePublicKey": "k", "endpoint": "198.51.100.1", "port": 51820
        });
        let order = read_order(&line(body), SECRET, "nonce");
        assert!(matches!(order, Ok(Order::Up(UpRequest { port: 51820, .. }))));
    }
}
