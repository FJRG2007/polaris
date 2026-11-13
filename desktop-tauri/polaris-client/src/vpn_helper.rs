//! Talking to the VPN service (`desktop/src/main/vpn-helper-client.ts`; the
//! service is `desktop/vpn-helper`): one order per connection on the loopback
//! address. Each side proves the secret by answering the other's challenge, the
//! service first: an order can carry a private key, so nothing is sent until
//! whatever holds the port has shown it is the service. The secret never crosses
//! the socket.
//!
//! The service is a binary crate of its own workspace, so its message types
//! cannot be shared without changing it; the lines here are the ones its
//! `server.rs` and `auth.rs` read and write, pinned by the tests against a fake
//! service built from that source.

use crate::servers::utf16_len;
use hmac::{Hmac, KeyInit, Mac};
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::sync::LazyLock;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// The service's port (`PORT` in its `server.rs`).
pub const HELPER_PORT: u16 = 51898;
/// The service version this app speaks; an older one is replaced.
pub const HELPER_VERSION: f64 = 1.0;

/// How long the socket may stay quiet (`setTimeout` on the Electron socket).
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REPLY: usize = 4096;
const MAX_NONCE: usize = 128;

type Signer = Hmac<Sha256>;

fn signer(secret: &str, message: &str) -> Signer {
    let mut mac = Signer::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(message.as_bytes());
    mac
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// The app's answer to the service's challenge.
pub fn answer_for(secret: &str, nonce: &str) -> String {
    hex(&signer(secret, nonce).finalize().into_bytes())
}

fn service_message(nonce: &str, ours: &str) -> String {
    format!("service\n{nonce}\n{ours}")
}

/// What the service answers with. Its own label keeps it from ever being
/// mistaken for the app's answer to the same nonce.
pub fn service_proof(secret: &str, nonce: &str, ours: &str) -> String {
    hex(&signer(secret, &service_message(nonce, ours))
        .finalize()
        .into_bytes())
}

static PROOF: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[0-9a-f]{64}$").expect("valid"));

/// Whether `proof` is the service's, compared in constant time.
fn same_proof(secret: &str, nonce: &str, ours: &str, proof: &str) -> bool {
    PROOF.is_match(proof)
        && unhex(proof).is_some_and(|bytes| {
            signer(secret, &service_message(nonce, ours))
                .verify_slice(&bytes)
                .is_ok()
        })
}

/// What the service answered (`replySchema`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HelperReply {
    pub ok: bool,
    pub code: Option<String>,
    pub version: Option<f64>,
    pub node_id: Option<String>,
    pub public_key: Option<String>,
}

fn optional<T>(
    object: &Map<String, Value>,
    key: &str,
    read: impl Fn(&Value) -> Option<T>,
) -> Result<Option<T>, ()> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => read(value).map(Some).ok_or(()),
    }
}

fn short_string(value: &Value, max: usize) -> Option<String> {
    value
        .as_str()
        .filter(|text| utf16_len(text) <= max)
        .map(str::to_owned)
}

/// Reads a reply as `replySchema` does: other keys are ignored, a known key of
/// the wrong shape refuses the whole reply.
pub fn read_reply(value: &Value) -> Option<HelperReply> {
    let object = value.as_object()?;
    let ok = object.get("ok")?.as_bool()?;
    let code = optional(object, "code", |value| short_string(value, 64)).ok()?;
    let version = optional(object, "version", Value::as_f64).ok()?;
    let node_id = optional(object, "nodeId", |value| match value {
        Value::Null => Some(None),
        Value::String(text) => Some(Some(text.clone())),
        _ => None,
    })
    .ok()?
    .flatten();
    let public_key = optional(object, "publicKey", |value| short_string(value, 64)).ok()?;
    Some(HelperReply {
        ok,
        code,
        version,
        node_id,
        public_key,
    })
}

/// The service's challenge (`challengeSchema`).
fn read_challenge(value: &Value) -> Option<String> {
    let nonce = value.as_object()?.get("nonce")?.as_str()?;
    let size = utf16_len(nonce);
    (1..=MAX_NONCE).contains(&size).then(|| nonce.to_owned())
}

fn read_proof(value: &Value) -> Option<&str> {
    value.as_object()?.get("proof")?.as_str()
}

fn fresh_nonce() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the operating system's random source works");
    hex(&bytes)
}

async fn write_line(socket: &mut TcpStream, value: &Value) -> Option<()> {
    let line = format!("{value}\n");
    tokio::time::timeout(TIMEOUT, socket.write_all(line.as_bytes()))
        .await
        .ok()?
        .ok()
}

/// Sends one order. `None` when no service answered it, or it was not the
/// service. `fields` are the order's own; `order` names it and wins over a
/// field of the same name, as `{ ...connection, order: "up" }` does.
pub async fn ask_helper(
    order: &str,
    fields: Map<String, Value>,
    secret: &str,
    port: u16,
) -> Option<HelperReply> {
    let connecting = TcpStream::connect(("127.0.0.1", port));
    let mut socket = tokio::time::timeout(TIMEOUT, connecting).await.ok()?.ok()?;
    let ours = fresh_nonce();
    let mut nonce: Option<String> = None;
    let mut sent = false;
    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let read = tokio::time::timeout(TIMEOUT, socket.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_REPLY {
            return None;
        }
        while let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let parsed: Value = serde_json::from_slice(&line[..end]).ok()?;
            if sent {
                return read_reply(&parsed);
            }
            let Some(challenge) = &nonce else {
                nonce = Some(read_challenge(&parsed)?);
                write_line(&mut socket, &json!({ "nonce": ours })).await?;
                continue;
            };
            if !same_proof(secret, challenge, &ours, read_proof(&parsed)?) {
                return None;
            }
            sent = true;
            let mut message = fields.clone();
            message.insert("order".into(), Value::String(order.to_owned()));
            message.insert(
                "answer".into(),
                Value::String(answer_for(secret, challenge)),
            );
            write_line(&mut socket, &Value::Object(message)).await?;
        }
    }
}

/// How to run the installer under the system's own prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// The installer under each system's own prompt. Paths travel in the
/// environment on the two that go through a script, so none is ever spliced
/// into one. `platform` is Node's name for it (`win32`, `darwin`, `linux`).
pub fn elevated_install(platform: &str, helper: &str, secret_file: &str) -> Launch {
    let env = vec![
        ("POLARIS_VPN_HELPER".to_owned(), helper.to_owned()),
        ("POLARIS_VPN_SECRET".to_owned(), secret_file.to_owned()),
    ];
    let owned = |args: &[&str]| args.iter().map(|arg| (*arg).to_owned()).collect();
    match platform {
        "win32" => Launch {
            file: "powershell.exe".into(),
            args: owned(&[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"$p = Start-Process -FilePath $env:POLARIS_VPN_HELPER -ArgumentList "install", ('"' + $env:POLARIS_VPN_SECRET + '"') -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode"#,
            ]),
            env,
        },
        "darwin" => Launch {
            file: "/usr/bin/osascript".into(),
            args: owned(&[
                "-e",
                r#"do shell script quoted form of (system attribute "POLARIS_VPN_HELPER") & " install " & quoted form of (system attribute "POLARIS_VPN_SECRET") with administrator privileges"#,
            ]),
            env,
        },
        _ => Launch {
            file: "pkexec".into(),
            args: owned(&[helper, "install", secret_file]),
            env: Vec::new(),
        },
    }
}

/// This system, in Node's words (`process.platform`).
pub fn this_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// A private network to sign into (`joinSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JoinInput {
    pub server: String,
    pub key: String,
}

static ONE_TIME_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[A-Za-z0-9_-]{8,256}$").expect("valid"));

/// The server as `z.string().url()` passes it on: trimmed, tabs and line breaks
/// taken out, and only when the URL parser reads it.
fn read_server(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    url::Url::parse(trimmed).ok()?;
    let server: String = trimmed
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let web = server.starts_with("http://") || server.starts_with("https://");
    (utf16_len(&server) <= 2048 && web).then_some(server)
}

/// Reads a join request: no other keys, an http(s) server and a one-time key.
pub fn read_join(raw: &Value) -> Option<JoinInput> {
    let input = JoinInput::deserialize(raw).ok()?;
    let server = read_server(&input.server)?;
    ONE_TIME_KEY.is_match(&input.key).then_some(JoinInput {
        server,
        key: input.key,
    })
}

/// Where each system puts the Tailscale client.
pub fn tailscale_path(platform: &str) -> &'static str {
    match platform {
        "win32" => r"C:\Program Files\Tailscale\tailscale.exe",
        "darwin" => "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        _ => "tailscale",
    }
}

static TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\p{L}\p{N} ._-]").expect("valid"));

/// What a computer calls itself on the device list: at most 40 UTF-16 units,
/// never splitting a character.
pub fn device_name_from(hostname: &str) -> String {
    let kept = TEXT.replace_all(hostname, "");
    let mut units = 0;
    let name: String = kept
        .trim()
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 40
        })
        .collect();
    if name.is_empty() {
        "Computer".into()
    } else {
        name
    }
}

/// The tunnel a page asks for, as Polaris answered it (`connectionSchema` in
/// `ipc.ts`).
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VpnConnection {
    pub node_id: String,
    pub address: String,
    pub dns: Vec<String>,
    pub node_public_key: String,
    pub endpoint: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own: Option<OwnTunnel>,
}

/// A VPN from elsewhere: its own keys and what it carries.
#[derive(Debug, Clone, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnTunnel {
    pub private_key: String,
    #[serde(deserialize_with = "present")]
    pub preshared_key: Option<String>,
    pub more_addresses: Vec<String>,
    pub allowed_ips: Vec<String>,
    #[serde(deserialize_with = "present")]
    pub mtu: Option<u32>,
}

/// A nullable key that must still be there, as zod's `.nullable()` wants it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer)
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$")
        .expect("valid")
});

fn fits(text: &str, max: usize) -> bool {
    (1..=max).contains(&utf16_len(text))
}

fn all_fit(list: &[String], max: usize) -> bool {
    list.iter().all(|item| fits(item, max))
}

impl VpnConnection {
    /// Reads a page's tunnel with the limits of `connectionSchema`.
    pub fn read(raw: &Value) -> Option<Self> {
        let connection = Self::deserialize(raw).ok()?;
        let own_ok = connection.own.as_ref().is_none_or(|own| {
            fits(&own.private_key, 64)
                && own.preshared_key.as_deref().is_none_or(|key| fits(key, 64))
                && own.more_addresses.len() <= 3
                && all_fit(&own.more_addresses, 64)
                && (1..=64).contains(&own.allowed_ips.len())
                && all_fit(&own.allowed_ips, 64)
                && own.mtu.is_none_or(|mtu| (576..=9000).contains(&mtu))
        });
        let valid = UUID.is_match(&connection.node_id)
            && fits(&connection.address, 64)
            && connection.dns.len() <= 4
            && all_fit(&connection.dns, 64)
            && fits(&connection.node_public_key, 64)
            && fits(&connection.endpoint, 255)
            && connection.port >= 1
            && own_ok;
        valid.then_some(connection)
    }

    /// The order's fields, as the service reads them.
    pub fn fields(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(fields)) => fields,
            _ => Map::new(),
        }
    }
}
