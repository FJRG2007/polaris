//! Stand-ins for `desktop/vpn-helper`. `FakeService` is its `server.rs` and
//! `auth.rs` with the tunnel left out: the same line order, the same types and
//! checks, the same replies. `Scripted` is the Electron test's `helper()`, a
//! program on the port that answers whatever it is told to.

use hmac::{Hmac, KeyInit, Mac};
use polaris_client::vpn::Installer;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What the fake's `key` order answers.
pub const PUBLIC_KEY: &str = "fake-public-key";
const MAX_LINE: u64 = 16 * 1024;
const MAX_NONCE: usize = 128;

type Signer = Hmac<Sha256>;

fn signer(secret: &str, nonce: &str) -> Signer {
    let mut mac = Signer::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(nonce.as_bytes());
    mac
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// `auth::verify`.
pub fn verify(secret: &str, nonce: &str, answer: &str) -> bool {
    unhex(answer).is_some_and(|bytes| signer(secret, nonce).verify_slice(&bytes).is_ok())
}

/// `auth::prove`.
fn prove(secret: &str, nonce: &str, theirs: &str) -> String {
    hex(&signer(secret, &format!("service\n{nonce}\n{theirs}"))
        .finalize()
        .into_bytes())
}

/// `auth::valid_secret`.
fn valid_secret(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpRequest {
    node_id: String,
    address: String,
    dns: Vec<String>,
    node_public_key: String,
    endpoint: String,
    port: u16,
    #[serde(default)]
    own: Option<OwnTunnel>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnTunnel {
    private_key: String,
    preshared_key: Option<String>,
    more_addresses: Vec<String>,
    allowed_ips: Vec<String>,
    mtu: Option<u32>,
}

#[derive(Deserialize)]
#[serde(tag = "order", rename_all = "camelCase")]
enum Order {
    Status,
    Key,
    Down,
    Up(Box<UpRequest>),
}

#[derive(Deserialize)]
struct Hello {
    nonce: String,
}

#[derive(Deserialize)]
struct Envelope {
    answer: String,
    #[serde(flatten)]
    order: Order,
}

#[derive(Default)]
struct State {
    /// `None` until installed: nothing answers the port.
    secret: Option<String>,
    version: u32,
    node_id: Option<String>,
    up_refusal: Option<String>,
}

fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn run(order: Order, state: &mut State) -> Value {
    match order {
        Order::Status => json!({ "ok": true, "version": state.version, "nodeId": state.node_id }),
        Order::Key => json!({ "ok": true, "publicKey": PUBLIC_KEY }),
        Order::Down => {
            state.node_id = None;
            json!({ "ok": true })
        }
        Order::Up(request) => match &state.up_refusal {
            Some(code) => json!({ "ok": false, "code": code }),
            None => {
                state.node_id = Some(request.node_id);
                json!({ "ok": true })
            }
        },
    }
}

fn proof_for(line: &str, secret: &str, nonce: &str) -> Result<Value, &'static str> {
    let hello: Hello = serde_json::from_str(line).map_err(|_| "badRequest")?;
    if hello.nonce.is_empty() || hello.nonce.len() > MAX_NONCE {
        return Err("badRequest");
    }
    Ok(json!({ "proof": prove(secret, nonce, &hello.nonce) }))
}

fn read_order(line: &str, secret: &str, nonce: &str) -> Result<Order, &'static str> {
    let envelope: Envelope = serde_json::from_str(line).map_err(|_| "badRequest")?;
    if verify(secret, nonce, &envelope.answer) {
        Ok(envelope.order)
    } else {
        Err("denied")
    }
}

fn fresh_nonce() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).unwrap();
    hex(&bytes)
}

fn serve_one(stream: TcpStream, state: &Mutex<State>) -> io::Result<()> {
    let Some(secret) = lock(state).secret.clone() else {
        return Ok(());
    };
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut writer = stream.try_clone()?;
    let nonce = fresh_nonce();
    writeln!(writer, "{}", json!({ "nonce": nonce }))?;
    let mut reader = BufReader::new(stream.take(MAX_LINE));
    let mut line = String::new();
    reader.read_line(&mut line)?;
    match proof_for(&line, &secret, &nonce) {
        Ok(proof) => writeln!(writer, "{proof}")?,
        Err(code) => return writeln!(writer, "{}", json!({ "ok": false, "code": code })),
    }
    line.clear();
    reader.read_line(&mut line)?;
    let reply = match read_order(&line, &secret, &nonce) {
        Ok(order) => run(order, &mut lock(state)),
        Err(code) => json!({ "ok": false, "code": code }),
    };
    writeln!(writer, "{reply}")
}

/// The service, on a port of its own, one order at a time.
pub struct FakeService {
    pub port: u16,
    state: Arc<Mutex<State>>,
}

impl FakeService {
    pub fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State::default()));
        let serving = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let _ = stream.and_then(|one| serve_one(one, &serving));
            }
        });
        Self { port, state }
    }

    /// As if `install` had run with this secret, reporting `version`.
    pub fn installed(&self, secret: &str, version: u32) {
        let mut state = lock(&self.state);
        state.secret = Some(secret.to_owned());
        state.version = version;
    }

    pub fn refuse_up(&self, code: &str) {
        lock(&self.state).up_refusal = Some(code.to_owned());
    }
}

/// The installer as the service's `install <secret-file>` behaves, never elevated.
#[derive(Clone)]
pub struct FakeInstaller {
    state: Arc<Mutex<State>>,
    succeeds: bool,
    calls: Arc<AtomicUsize>,
}

impl FakeInstaller {
    pub fn new(service: &FakeService, succeeds: bool) -> Self {
        Self {
            state: service.state.clone(),
            succeeds,
            calls: Arc::default(),
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Installer for FakeInstaller {
    async fn install(&self, secret_file: &Path) -> bool {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.succeeds {
            return false;
        }
        let secret = std::fs::read_to_string(secret_file).unwrap_or_default();
        let secret = secret.trim();
        if !valid_secret(secret) {
            return false;
        }
        let mut state = lock(&self.state);
        state.secret = Some(secret.to_owned());
        state.version = 1;
        true
    }
}

/// The Electron test's `helper()`: challenges with `abc`, proves itself with
/// `prove`, and answers the order with `reply`. Keeps the order it was sent.
pub struct Scripted {
    pub port: u16,
    seen: Arc<Mutex<Option<Value>>>,
}

impl Scripted {
    pub fn start(prove: impl Fn(&str) -> String + Send + 'static, reply: &str) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(None));
        let keep = seen.clone();
        let reply = reply.to_owned();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut writer = stream.try_clone().unwrap();
                let mut reader = BufReader::new(stream);
                let _ = writeln!(writer, "{}", json!({ "nonce": "abc" }));
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                let hello: Value = serde_json::from_str(&line).unwrap_or_default();
                let ours = hello["nonce"].as_str().unwrap_or_default().to_owned();
                let _ = writeln!(writer, "{}", json!({ "proof": prove(&ours) }));
                line.clear();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
                *keep.lock().unwrap() = serde_json::from_str(&line).ok();
                let _ = writeln!(writer, "{reply}");
            }
        });
        Self { port, seen }
    }

    pub fn order(&self) -> Option<Value> {
        self.seen.lock().unwrap().clone()
    }
}
