//! Reaching the same Polaris on another address when its usual one stops
//! answering: the terminal's port of `dashboard/packages/core/src/instance-fallback.ts`.
//!
//! Over the address the terminal already trusts it learns the instance's id, its
//! Ed25519 public key, the other addresses it answers on and the SHA-256 of its
//! local CA (`GET /api/instance`). Before an alternate address ever sees the
//! terminal key, that address must sign a fresh nonce, over its own origin, with
//! the stored key (`POST /api/instance/challenge`). An id alone proves nothing:
//! anybody on the LAN can repeat it. The technique is the one Home Assistant's
//! companion app (internal vs external URL) and Plex (`machineIdentifier` plus a
//! signed certificate) settled on, with the identity proven by a signature.
//!
//! The wire format, limits and timings match the TypeScript module byte for byte;
//! its tests and these assert the same cases.

mod failover;
mod local_ca;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::rand::SecureRandom as _;
use ring::signature::{ED25519, UnparsedPublicKey};

pub use failover::FailoverState;
pub use local_ca::{LocalCaVerifier, sha256_hex};

/// Where an instance describes itself. Public, no credential.
pub const INSTANCE_PATH: &str = "/api/instance";
/// Where an instance signs a client's nonce. Public, no credential.
pub const CHALLENGE_PATH: &str = "/api/instance/challenge";
/// Domain separation for the signed message, so the key signs nothing else.
pub const SIGNATURE_CONTEXT: &str = "polaris-instance-v1";

/// How long an address that worked is used before the usual one is tried again.
pub const DEFAULT_HOLD_MS: u64 = 60_000;
/// How long a verified address stays verified before it is challenged again.
pub const DEFAULT_VERIFIED_MS: u64 = 10 * 60_000;
/// How long a request to one address may take before the next one is tried.
pub const DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// Shown while the terminal is on an address other than the one it was given.
pub const USING_LOCAL_WORDS: &str = "Using your local network address";

const MAX_ADDRESSES: usize = 16;
const MAX_LOCAL_CAS: usize = 4;

/// What the terminal keeps about the instance, learned over its trusted address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstanceRecord {
    /// Stable id of this Polaris. Identifies; does not prove.
    pub id: String,
    /// Ed25519 public key, raw 32 bytes as base64url. This is what proves.
    pub public_key: String,
    /// Every origin the instance says it answers on, the usual one included.
    pub addresses: Vec<String>,
    /// Lowercase hex SHA-256 of the DER of each local CA that signs the
    /// instance's local-name certificates. Trusted only because it was learned
    /// over the usual, publicly trusted address, and used only on an alternate
    /// that proved it is this instance.
    pub local_ca_sha256: Vec<String>,
}

fn is_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_base64url_of_len(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// An `http(s)` origin with no path, or `None`.
pub fn read_origin(value: &str) -> Option<String> {
    if value.len() > 300 {
        return None;
    }
    let url = url::Url::parse(value.trim()).ok()?;
    if !matches!(url.scheme(), "https" | "http") {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Reads what `GET /api/instance` answered, or `None` when it is not one.
/// Strict: an answer with a malformed id, key or address is refused whole.
pub fn read_instance(body: &serde_json::Value) -> Option<InstanceRecord> {
    let record = body.as_object()?;
    let id = record.get("id")?.as_str()?;
    let public_key = record.get("publicKey")?.as_str()?;
    let addresses = record.get("addresses")?.as_array()?;
    if !is_id(id) || !is_base64url_of_len(public_key, 43) || addresses.len() > MAX_ADDRESSES {
        return None;
    }
    let mut origins: Vec<String> = Vec::new();
    for one in addresses {
        let origin = read_origin(one.as_str()?)?;
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    let mut local_cas: Vec<String> = Vec::new();
    if let Some(values) = record
        .get("localCaSha256")
        .and_then(|value| value.as_array())
    {
        for one in values.iter().take(MAX_LOCAL_CAS) {
            let Some(hex) = one.as_str().map(|value| value.trim().to_ascii_lowercase()) else {
                continue;
            };
            if is_sha256_hex(&hex) && !local_cas.contains(&hex) {
                local_cas.push(hex);
            }
        }
    }
    Some(InstanceRecord {
        id: id.to_owned(),
        public_key: public_key.to_owned(),
        addresses: origins,
        local_ca_sha256: local_cas,
    })
}

/// The bytes the instance signs: context, id, origin and nonce, one per line.
pub fn challenge_message(id: &str, origin: &str, nonce: &str) -> String {
    format!("{SIGNATURE_CONTEXT}\n{id}\n{origin}\n{nonce}")
}

/// A fresh 32-byte nonce, base64url without padding.
pub fn fresh_nonce() -> String {
    let mut bytes = [0u8; 32];
    ring::rand::SystemRandom::new()
        .fill(&mut bytes)
        .expect("the system random source is available");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The body of the challenge request for `nonce`.
pub fn challenge_body(nonce: &str) -> serde_json::Value {
    serde_json::json!({ "nonce": nonce })
}

/// Whether `signature` is the instance's signature over this challenge.
pub fn verify_challenge(
    record: &InstanceRecord,
    origin: &str,
    nonce: &str,
    signature: &str,
) -> bool {
    if !is_base64url_of_len(signature, 86) {
        return false;
    }
    let (Ok(key), Ok(signature)) = (
        URL_SAFE_NO_PAD.decode(&record.public_key),
        URL_SAFE_NO_PAD.decode(signature),
    ) else {
        return false;
    };
    let message = challenge_message(&record.id, origin, nonce);
    UnparsedPublicKey::new(&ED25519, key)
        .verify(message.as_bytes(), &signature)
        .is_ok()
}

/// What challenging one alternate found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AlternateVerdict {
    /// It signed the nonce with the stored key: the same Polaris.
    Same,
    /// It answered, but not as this Polaris. It never sees the credential.
    Different,
    /// It did not answer; `certificate` when that was a certificate it does not trust.
    Unreachable { certificate: bool },
}

/// Judges the challenge answer from `origin`: `status` and the parsed body, or
/// `None` for a body that is not JSON.
pub fn judge_challenge(
    record: &InstanceRecord,
    origin: &str,
    nonce: &str,
    status: u16,
    body: Option<&serde_json::Value>,
) -> AlternateVerdict {
    if is_gateway_failure(status) {
        return AlternateVerdict::Unreachable { certificate: false };
    }
    let field = |name: &str| {
        body.and_then(|body| body.get(name))
            .and_then(|value| value.as_str())
    };
    if !(200..300).contains(&status)
        || field("id") != Some(record.id.as_str())
        || field("nonce") != Some(nonce)
    {
        return AlternateVerdict::Different;
    }
    match field("signature") {
        Some(signature) if verify_challenge(record, origin, nonce, signature) => {
            AlternateVerdict::Same
        }
        _ => AlternateVerdict::Different,
    }
}

/// Whether a status means the address did not really answer: a gateway or tunnel
/// in front of a Polaris it cannot reach (a tunnel answers 530 when the house is
/// offline). A 401 or 403 is an answer, and never a reason to try elsewhere.
pub fn is_gateway_failure(status: u16) -> bool {
    matches!(status, 502..=504 | 520..=530)
}

/// Why an address answers as another Polaris, in words.
pub fn refused_words(origin: &str) -> String {
    let host = url::Url::parse(origin)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?.to_owned();
            Some(match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            })
        })
        .unwrap_or_else(|| origin.to_owned());
    format!("{host} answers as a different Polaris, so your sign-in was not sent there.")
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
