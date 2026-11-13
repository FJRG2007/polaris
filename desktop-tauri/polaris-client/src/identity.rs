//! Whether an address really is a Polaris, asked before it is opened.
//!
//! The Rust twin of `probeServer` in `desktop/src/shared/server-identity.ts`:
//! `/api/polaris/identity` first, then the older `/api/instance` and
//! `/api/health` for a Polaris that predates it, every answer capped at 4 KiB,
//! the whole probe held to five seconds, and a redirect to another origin
//! treated as "this is not where Polaris is" rather than followed.

use crate::address::InstanceUrl;
use crate::net::NetFailure;
use serde::Deserialize;
use std::time::Duration;

pub const IDENTITY_PATH: &str = "/api/polaris/identity";
const INSTANCE_PATH: &str = "/api/instance";
const HEALTH_PATH: &str = "/api/health";
/// The whole probe, every request included.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Largest answer read; anything bigger is not what a Polaris sends here.
pub const MAX_BODY_BYTES: usize = 4_096;
const MAX_SAME_ORIGIN_REDIRECTS: usize = 10;

/// What the probe found at an address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// A Polaris. `legacy` when it answered only the older routes.
    Polaris {
        name: Option<String>,
        version: Option<String>,
        legacy: bool,
    },
    /// A Polaris that is starting, or cannot reach its database yet.
    Starting,
    /// Something answers, but it is not Polaris.
    NotPolaris,
    /// It sends visitors to another origin.
    Redirects,
    /// Nothing answered.
    Unreachable(NetFailure),
}

impl Verdict {
    /// The sentence shown for this verdict (`describeVerdict`).
    pub fn describe(&self, host: &str) -> String {
        match self {
            Self::Polaris { name: Some(name), .. } => format!("Polaris found: {name}."),
            Self::Polaris { name: None, .. } => format!("Polaris found at {host}."),
            Self::Starting => format!("Polaris at {host} is starting, or cannot reach its database yet. Try again in a minute."),
            Self::NotPolaris => format!("{host} answers, but it is not Polaris. Check the address you open Polaris at."),
            Self::Redirects => format!("{host} sends visitors to another address. Type the address you open Polaris at."),
            Self::Unreachable(failure) => failure.describe(host),
        }
    }
}

#[derive(Deserialize)]
struct Identity {
    product: String,
    protocol: i64,
    name: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
struct Instance {
    id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    addresses: Vec<String>,
}

#[derive(Deserialize)]
struct Health {
    status: String,
}

/// The HTTP client a probe uses: same-origin redirects followed, any other one
/// stopped and reported, no cookies, no credentials.
pub fn probe_client() -> reqwest::Result<reqwest::Client> {
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let start = attempt.previous().first().map(|url| url.origin());
        if start.as_ref() != Some(&attempt.url().origin()) {
            attempt.stop()
        } else if attempt.previous().len() > MAX_SAME_ORIGIN_REDIRECTS {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder().redirect(policy).build()
}

enum Reply {
    Answer {
        status: u16,
        body: Option<serde_json::Value>,
    },
    Redirect,
}

/// Probes `origin` and says what is there. Never fails: a network error is the
/// `Unreachable` verdict.
pub async fn probe(client: &reqwest::Client, origin: &InstanceUrl) -> Verdict {
    probe_within(client, origin, PROBE_TIMEOUT).await
}

/// [`probe`] with a budget of its own, for the tests.
pub async fn probe_within(
    client: &reqwest::Client,
    origin: &InstanceUrl,
    budget: Duration,
) -> Verdict {
    match tokio::time::timeout(budget, ask_all(client, origin)).await {
        Ok(Ok(verdict)) => verdict,
        Ok(Err(error)) => Verdict::Unreachable(NetFailure::classify(&error)),
        Err(_) => Verdict::Unreachable(NetFailure::TimedOut),
    }
}

fn moves_on(status: u16) -> bool {
    matches!(status, 404 | 429 | 503)
}

async fn ask_all(client: &reqwest::Client, origin: &InstanceUrl) -> reqwest::Result<Verdict> {
    let Reply::Answer { status, body } = ask(client, origin, IDENTITY_PATH).await? else {
        return Ok(Verdict::Redirects);
    };
    if status == 200 {
        return Ok(match parse::<Identity>(body) {
            Some(identity) if is_identity(&identity) => Verdict::Polaris {
                name: trimmed(identity.name, 80),
                version: trimmed(identity.version, 40),
                legacy: false,
            },
            _ => Verdict::NotPolaris,
        });
    }
    if !moves_on(status) {
        return Ok(Verdict::NotPolaris);
    }

    let Reply::Answer { status, body } = ask(client, origin, INSTANCE_PATH).await? else {
        return Ok(Verdict::Redirects);
    };
    if status == 200 {
        let legacy = parse::<Instance>(body).is_some_and(|instance| is_instance(&instance));
        return Ok(if legacy {
            Verdict::Polaris {
                name: None,
                version: None,
                legacy: true,
            }
        } else {
            Verdict::NotPolaris
        });
    }
    if !moves_on(status) {
        return Ok(Verdict::NotPolaris);
    }

    let Reply::Answer { status, body } = ask(client, origin, HEALTH_PATH).await? else {
        return Ok(Verdict::Redirects);
    };
    let health = parse::<Health>(body).map(|health| health.status);
    Ok(match (status, health.as_deref()) {
        (200, Some("ok")) => Verdict::Polaris {
            name: None,
            version: None,
            legacy: true,
        },
        (503, Some("error")) => Verdict::Starting,
        _ => Verdict::NotPolaris,
    })
}

async fn ask(client: &reqwest::Client, origin: &InstanceUrl, path: &str) -> reqwest::Result<Reply> {
    let mut response = client
        .get(format!("{origin}{path}"))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let status = response.status().as_u16();
    if response.status().is_redirection() || response.url().origin() != origin.to_url().origin() {
        return Ok(Reply::Redirect);
    }
    let is_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .to_ascii_lowercase()
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|word| word == "json")
        });
    if !is_json
        || response
            .content_length()
            .is_some_and(|length| length > MAX_BODY_BYTES as u64)
    {
        return Ok(Reply::Answer { status, body: None });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BODY_BYTES {
            return Ok(Reply::Answer { status, body: None });
        }
    }
    Ok(Reply::Answer {
        status,
        body: serde_json::from_slice(&bytes).ok(),
    })
}

fn parse<T: serde::de::DeserializeOwned>(body: Option<serde_json::Value>) -> Option<T> {
    body.and_then(|value| serde_json::from_value(value).ok())
}

fn is_identity(identity: &Identity) -> bool {
    let fits = |text: &Option<String>, max: usize| {
        text.as_ref()
            .is_none_or(|text| (1..=max).contains(&text.trim().chars().count()))
    };
    identity.product == "polaris"
        && (1..=1_000).contains(&identity.protocol)
        && fits(&identity.name, 80)
        && fits(&identity.version, 40)
}

fn is_instance(instance: &Instance) -> bool {
    let token = |text: &str| {
        text.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    (8..=64).contains(&instance.id.len())
        && token(&instance.id)
        && instance.public_key.len() == 43
        && token(&instance.public_key)
        && instance.addresses.len() <= 16
        && instance
            .addresses
            .iter()
            .all(|address| address.chars().count() <= 300)
}

fn trimmed(text: Option<String>, max: usize) -> Option<String> {
    text.map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty() && text.chars().count() <= max)
}
