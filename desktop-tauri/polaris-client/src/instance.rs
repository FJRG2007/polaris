//! Reaching the same Polaris on another address when its usual one stops
//! answering. Mirrors `dashboard/packages/core/src/instance-fallback.ts`, which
//! the Electron app's `polaris-api.ts` builds its failover from.
//!
//! 1. Over the address the client already trusts, it learns the instance's id, its
//!    Ed25519 public key and the other addresses it answers on (`GET /api/instance`).
//! 2. Before it uses one of those other addresses, it sends a fresh nonce there and
//!    checks the answer is signed by the key it stored, over that nonce and that
//!    address. An id alone proves nothing - anybody on the LAN can repeat it.
//! 3. Only then does a request carrying the credential go there. An address that
//!    signs with another key, or not at all, never sees the credential.

use crate::net::NetFailure;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where an instance describes itself. Public, no credential.
pub const INSTANCE_PATH: &str = "/api/instance";
/// Where an instance signs a client's nonce. Public, no credential.
pub const CHALLENGE_PATH: &str = "/api/instance/challenge";
/// Domain separation for the signed message, so the key signs nothing else.
pub const SIGNATURE_CONTEXT: &str = "polaris-instance-v1";

/// How long an address that worked is used before the usual one is tried again.
pub const DEFAULT_HOLD: Duration = Duration::from_secs(60);
/// How long a verified address stays verified before it is challenged again.
pub const DEFAULT_VERIFIED: Duration = Duration::from_secs(10 * 60);
/// How long a request to one address may take before the next one is tried.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(8);
/// How often a client asks its usual address again, so a local address that moved is picked up.
pub const RELEARN: Duration = Duration::from_secs(24 * 60 * 60);

/// Shown while a client is on an address other than the one it was given.
pub const USING_LOCAL_WORDS: &str = "Using your local network address";

/// Why a local address could not be used, for a client that relies on the system's trust.
pub const UNTRUSTED_WORDS: &str = "Your local network address uses Polaris's own certificate, which this device does not trust yet. An administrator can download it in Admin -> Domains (Trust this device) for you to install.";

const MAX_ADDRESSES: usize = 16;
const MAX_LOCAL_CAS: usize = 4;

/// What a client keeps about the instance, learned over its trusted address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    /// Stable id of this Polaris. Identifies; does not prove.
    pub id: String,
    /// Ed25519 public key, raw 32 bytes as base64url. This is what proves.
    pub public_key: String,
    /// Every origin the instance says it answers on, the usual one included.
    pub addresses: Vec<String>,
    /// SHA-256 of the local CA certificate(s), lowercase hex of the DER.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_ca_sha256: Vec<String>,
}

fn is_b64url(text: &str, length: usize) -> bool {
    text.len() == length
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn is_id(text: &str) -> bool {
    (8..=64).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The local CA fingerprints in an answer: the well-formed ones only, at most a few.
fn read_local_cas(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(list) = value.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut found: Vec<String> = Vec::new();
    for one in list.iter().take(MAX_LOCAL_CAS) {
        let Some(text) = one.as_str() else { continue };
        let hex = text.trim().to_ascii_lowercase();
        let valid = hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit());
        if valid && !found.contains(&hex) {
            found.push(hex);
        }
    }
    found
}

/// An `http(s)` origin with no path, or `None`.
pub fn read_origin(value: &str) -> Option<String> {
    if value.chars().count() > 300 {
        return None;
    }
    let url = url::Url::parse(value.trim()).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

/// Read what `GET /api/instance` answered, or `None` when it is not one. Strict:
/// an answer with a malformed id or key is refused whole rather than half-kept.
pub fn read_instance(body: &serde_json::Value) -> Option<InstanceRecord> {
    let record = body.as_object()?;
    let id = record.get("id")?.as_str()?;
    let public_key = record.get("publicKey")?.as_str()?;
    if !is_id(id) || !is_b64url(public_key, 43) {
        return None;
    }
    let addresses = record.get("addresses")?.as_array()?;
    if addresses.len() > MAX_ADDRESSES {
        return None;
    }
    let mut origins: Vec<String> = Vec::new();
    for one in addresses {
        let origin = read_origin(one.as_str()?)?;
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Some(InstanceRecord {
        id: id.to_owned(),
        public_key: public_key.to_owned(),
        addresses: origins,
        local_ca_sha256: read_local_cas(record.get("localCaSha256")),
    })
}

/// The bytes the instance signs: context, id, origin and nonce, one per line.
pub fn challenge_message(id: &str, origin: &str, nonce: &str) -> String {
    format!("{SIGNATURE_CONTEXT}\n{id}\n{origin}\n{nonce}")
}

/// A fresh 32-byte nonce, base64url.
pub fn fresh_nonce() -> String {
    let mut bytes = [0u8; 32];
    aws_lc_rs::rand::fill(&mut bytes).expect("the system random source is available");
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Whether `signature` is the instance's signature over this challenge. Never panics.
pub fn verify_challenge(
    record: &InstanceRecord,
    origin: &str,
    nonce: &str,
    signature: Option<&serde_json::Value>,
) -> bool {
    let Some(signature) = signature.and_then(serde_json::Value::as_str) else {
        return false;
    };
    if !is_b64url(signature, 86) {
        return false;
    }
    let (Ok(key), Ok(signature)) = (
        URL_SAFE_NO_PAD.decode(&record.public_key),
        URL_SAFE_NO_PAD.decode(signature),
    ) else {
        return false;
    };
    let message = challenge_message(&record.id, origin, nonce);
    aws_lc_rs::signature::UnparsedPublicKey::new(&aws_lc_rs::signature::ED25519, key)
        .verify(message.as_bytes(), &signature)
        .is_ok()
}

/// Whether a status means the address did not really answer: a gateway or tunnel
/// in front of a Polaris it cannot reach. A 401 or 403 is an answer.
pub fn is_gateway_failure(status: u16) -> bool {
    matches!(status, 502..=504 | 520..=530)
}

/// Why a request to an address did not get an answer.
#[derive(Debug, thiserror::Error)]
pub enum FetchError {
    /// Nothing answered within the wait for the response headers.
    #[error("timed out")]
    TimedOut,
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}

impl FetchError {
    pub fn failure(&self) -> NetFailure {
        match self {
            Self::TimedOut => NetFailure::TimedOut,
            Self::Http(error) => NetFailure::classify(error),
        }
    }
}

/// One request whose wait for an answer is bounded. The timeout covers only the
/// wait for the response headers, so a long download or a followed log that
/// answered in time is never cut off.
async fn timed(
    request: reqwest::RequestBuilder,
    timeout: Duration,
) -> Result<reqwest::Response, FetchError> {
    match tokio::time::timeout(timeout, request.send()).await {
        Ok(answer) => Ok(answer?),
        Err(_) => Err(FetchError::TimedOut),
    }
}

/// Learn the instance over its trusted address. `None` when it does not describe
/// itself (an older Polaris) - the client then simply has no alternates.
pub async fn learn_instance(
    http: &reqwest::Client,
    primary: &str,
    timeout: Duration,
) -> Option<InstanceRecord> {
    let request = http
        .get(format!("{primary}{INSTANCE_PATH}"))
        .header(reqwest::header::ACCEPT, "application/json");
    let response = timed(request, timeout).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    read_instance(&response.json::<serde_json::Value>().await.ok()?)
}

/// What challenging one alternate found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlternateVerdict {
    Same,
    Different,
    Unreachable { certificate: bool },
}

/// Challenge an alternate. The request carries no credential and no cookie: until
/// this says `Same`, nothing of the client's goes to that address.
pub async fn verify_alternate(
    http: &reqwest::Client,
    origin: &str,
    record: &InstanceRecord,
    timeout: Duration,
) -> AlternateVerdict {
    let nonce = fresh_nonce();
    let request = http
        .post(format!("{origin}{CHALLENGE_PATH}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&serde_json::json!({ "nonce": nonce }));
    let response = match timed(request, timeout).await {
        Ok(response) => response,
        Err(error) => {
            return AlternateVerdict::Unreachable {
                certificate: error.failure() == NetFailure::Certificate,
            }
        }
    };
    let status = response.status();
    if is_gateway_failure(status.as_u16()) {
        return AlternateVerdict::Unreachable { certificate: false };
    }
    // Something that is not Polaris may answer; it is not this one either way.
    let body = response
        .json::<serde_json::Value>()
        .await
        .unwrap_or(serde_json::Value::Null);
    let said = |field: &str| body.get(field).and_then(serde_json::Value::as_str);
    if !status.is_success() || said("id") != Some(&record.id) || said("nonce") != Some(&nonce) {
        return AlternateVerdict::Different;
    }
    if verify_challenge(record, origin, &nonce, body.get("signature")) {
        AlternateVerdict::Same
    } else {
        AlternateVerdict::Different
    }
}

/// An instance a client already has on its list, as learned over that address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownInstance {
    /// The address it is listed under.
    pub origin: String,
    pub record: InstanceRecord,
}

/// Which listed instance an address being added already is, or `None`. The
/// address must sign a fresh nonce with that instance's key, over its own origin.
pub async fn find_same_instance(
    http: &reqwest::Client,
    candidates: &[String],
    known: &[KnownInstance],
    timeout: Duration,
) -> Option<KnownInstance> {
    if known.is_empty() {
        return None;
    }
    for candidate in candidates {
        let Some(claimed) = learn_instance(http, candidate, timeout).await else {
            continue;
        };
        let matching = known.iter().filter(|one| {
            &one.origin != candidate
                && one.record.id == claimed.id
                && one.record.public_key == claimed.public_key
        });
        for one in matching {
            if verify_alternate(http, candidate, &one.record, timeout).await
                == AlternateVerdict::Same
            {
                return Some(one.clone());
            }
        }
    }
    None
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

/// Which address a client is on, for the screen that shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FailoverStatus {
    /// The origin the last request went to.
    pub origin: String,
    /// Whether that is an alternate rather than the address the client was given.
    pub local: bool,
    /// `USING_LOCAL_WORDS` while on an alternate, otherwise `None`.
    pub words: Option<&'static str>,
    /// Alternates that answered as a different Polaris and were never sent the credential.
    pub refused: Vec<String>,
    /// Alternates this client could not open because it does not trust their certificate.
    pub untrusted: Vec<String>,
}

/// Milliseconds on some monotonic clock; injectable for the tests.
pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

#[derive(Default)]
struct State {
    current: String,
    held_until: u64,
    verified_until: HashMap<String, u64>,
    refused: Vec<String>,
    untrusted: Vec<String>,
}

fn forget(list: &mut Vec<String>, origin: &str) {
    list.retain(|one| one != origin);
}

fn remember(list: &mut Vec<String>, origin: &str) {
    if !list.iter().any(|one| one == origin) {
        list.push(origin.to_owned());
    }
}

/// The address-picking state for one client and one instance.
///
/// Order on every request: the address it is holding (if the hold has not run
/// out), then the primary, then each verified alternate. A network failure or a
/// gateway status moves on to the next; any real answer - a 401 included - is
/// returned as it is. Once the hold runs out the primary is tried first again.
pub struct Failover {
    http: reqwest::Client,
    primary: String,
    instance: Option<InstanceRecord>,
    alternates: Vec<String>,
    now: Clock,
    hold: u64,
    verified_for: u64,
    timeout: Duration,
    state: Mutex<State>,
}

impl std::fmt::Debug for Failover {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Failover")
            .field("primary", &self.primary)
            .field("alternates", &self.alternates)
            .finish_non_exhaustive()
    }
}

impl Failover {
    /// A failover for `primary` from what was learned over it (`None`: no alternates).
    pub fn new(http: reqwest::Client, primary: &str, instance: Option<InstanceRecord>) -> Self {
        let start = Instant::now();
        Self::with_options(
            http,
            primary,
            instance,
            Arc::new(move || u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)),
            DEFAULT_HOLD,
            DEFAULT_VERIFIED,
            DEFAULT_TIMEOUT,
        )
    }

    pub fn with_options(
        http: reqwest::Client,
        primary: &str,
        instance: Option<InstanceRecord>,
        now: Clock,
        hold: Duration,
        verified_for: Duration,
        timeout: Duration,
    ) -> Self {
        let primary =
            read_origin(primary).unwrap_or_else(|| primary.trim_end_matches('/').to_owned());
        let alternates = instance
            .as_ref()
            .map(|record| {
                record
                    .addresses
                    .iter()
                    .filter(|origin| **origin != primary)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let millis = |d: Duration| u64::try_from(d.as_millis()).unwrap_or(u64::MAX);
        Self {
            http,
            state: Mutex::new(State {
                current: primary.clone(),
                ..State::default()
            }),
            primary,
            instance,
            alternates,
            now,
            hold: millis(hold),
            verified_for: millis(verified_for),
            timeout,
        }
    }

    pub fn primary(&self) -> &str {
        &self.primary
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn verified(&self, origin: &str) -> bool {
        if self.lock().verified_until.get(origin).copied().unwrap_or(0) > (self.now)() {
            return true;
        }
        let Some(instance) = &self.instance else {
            return false;
        };
        let verdict = verify_alternate(&self.http, origin, instance, self.timeout).await;
        let mut state = self.lock();
        match verdict {
            AlternateVerdict::Same => {
                let until = (self.now)().saturating_add(self.verified_for);
                state.verified_until.insert(origin.to_owned(), until);
                forget(&mut state.refused, origin);
                forget(&mut state.untrusted, origin);
                return true;
            }
            AlternateVerdict::Different => remember(&mut state.refused, origin),
            AlternateVerdict::Unreachable { certificate: true } => {
                remember(&mut state.untrusted, origin);
            }
            AlternateVerdict::Unreachable { certificate: false } => {
                forget(&mut state.untrusted, origin);
            }
        }
        state.verified_until.remove(origin);
        false
    }

    fn order(&self) -> Vec<String> {
        let state = self.lock();
        let mut order: Vec<String> = Vec::new();
        if state.current != self.primary && state.held_until > (self.now)() {
            order.push(state.current.clone());
        }
        let mut seen: HashSet<String> = order.iter().cloned().collect();
        for origin in std::iter::once(&self.primary).chain(&self.alternates) {
            if seen.insert(origin.clone()) {
                order.push(origin.clone());
            }
        }
        order
    }

    fn settle(&self, origin: &str) {
        let now = (self.now)();
        let mut state = self.lock();
        if origin == self.primary {
            state.current = self.primary.clone();
            state.held_until = 0;
        } else if origin != state.current || state.held_until <= now {
            state.current = origin.to_owned();
            state.held_until = now.saturating_add(self.hold);
        }
    }

    fn unverify(&self, origin: &str) {
        if origin != self.primary {
            self.lock().verified_until.remove(origin);
        }
    }

    /// Send `path` (with its query) to the address that answers. `make` builds
    /// the request for a full URL and is called once per address tried, so the
    /// credential it adds goes to an alternate only after that alternate proved
    /// it is the same instance.
    pub async fn request(
        &self,
        path: &str,
        make: impl Fn(&str) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, FetchError> {
        let mut first_failure: Option<FetchError> = None;
        let mut last_gateway: Option<reqwest::Response> = None;
        for origin in self.order() {
            if origin != self.primary && !self.verified(&origin).await {
                continue;
            }
            match timed(make(&format!("{origin}{path}")), self.timeout).await {
                Ok(response) if is_gateway_failure(response.status().as_u16()) => {
                    last_gateway = Some(response);
                    self.unverify(&origin);
                }
                Ok(response) => {
                    self.settle(&origin);
                    return Ok(response);
                }
                Err(error) => {
                    self.unverify(&origin);
                    first_failure.get_or_insert(error);
                }
            }
        }
        if let Some(response) = last_gateway {
            return Ok(response);
        }
        Err(first_failure.unwrap_or(FetchError::TimedOut))
    }

    /// The origin to use right now, verifying an alternate first when the primary is down.
    pub async fn resolve(&self) -> String {
        for origin in self.order() {
            if origin != self.primary && !self.verified(&origin).await {
                continue;
            }
            let request = self.http.get(format!("{origin}{INSTANCE_PATH}"));
            match timed(request, self.timeout).await {
                Ok(response) if is_gateway_failure(response.status().as_u16()) => {}
                Ok(_) => {
                    self.settle(&origin);
                    return origin;
                }
                Err(_) => {}
            }
        }
        self.primary.clone()
    }

    pub fn status(&self) -> FailoverStatus {
        let state = self.lock();
        let local = state.current != self.primary;
        FailoverStatus {
            origin: state.current.clone(),
            local,
            words: local.then_some(USING_LOCAL_WORDS),
            refused: state.refused.clone(),
            untrusted: state.untrusted.clone(),
        }
    }
}
