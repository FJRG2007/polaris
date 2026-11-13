//! The local-address failover against local mock servers: an alternate is used
//! only after it signs a fresh nonce with the instance's key, and the key is
//! never sent to one that does not. No network leaves the machine.

use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use polaris_client::instance::{
    challenge_message, read_instance, read_origin, refused_words, verify_alternate,
    AlternateVerdict, Failover, InstanceRecord, USING_LOCAL_WORDS,
};
use polaris_client::{ApiClient, ApiKey, InstanceUrl};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const ID: &str = "instance_fixture_1";
const KEY: &str = "plk_abcd1234.fixture-secret";

fn keypair() -> Ed25519KeyPair {
    Ed25519KeyPair::generate().unwrap()
}

fn record(pair: &Ed25519KeyPair, addresses: &[&str]) -> InstanceRecord {
    InstanceRecord {
        id: ID.into(),
        public_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        addresses: addresses.iter().map(|a| (*a).to_owned()).collect(),
        local_ca_sha256: Vec::new(),
    }
}

/// Answers the challenge as the instance would, signing with `pair` over `origin`.
struct Signer {
    pair: Ed25519KeyPair,
    origin: String,
    id: String,
}

impl Respond for Signer {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        let nonce = body["nonce"].as_str().unwrap().to_owned();
        let signature = self
            .pair
            .sign(challenge_message(&self.id, &self.origin, &nonce).as_bytes());
        ResponseTemplate::new(200).set_body_json(json!({
            "id": self.id, "nonce": nonce, "signature": URL_SAFE_NO_PAD.encode(signature.as_ref())
        }))
    }
}

async fn signing(server: &MockServer, pair: Ed25519KeyPair) {
    Mock::given(method("POST"))
        .and(path("/api/instance/challenge"))
        .respond_with(Signer {
            pair,
            origin: server.uri(),
            id: ID.into(),
        })
        .mount(server)
        .await;
}

fn quick(
    http: reqwest::Client,
    primary: &str,
    instance: Option<InstanceRecord>,
    clock: Arc<AtomicU64>,
) -> Failover {
    Failover::with_options(
        http,
        primary,
        instance,
        Arc::new(move || clock.load(Ordering::SeqCst)),
        Duration::from_secs(60),
        Duration::from_secs(600),
        Duration::from_secs(2),
    )
}

#[test]
fn reads_an_instance_strictly() {
    let key = "A".repeat(43);
    let good = json!({ "id": "abcdefgh", "publicKey": key, "addresses": ["https://a.example/", "http://b.local:8080", "https://a.example"],
        "localCaSha256": ["AB".repeat(32), "nope", "ab".repeat(32)] });
    let read = read_instance(&good).unwrap();
    assert_eq!(
        read.addresses,
        vec!["https://a.example", "http://b.local:8080"]
    );
    assert_eq!(read.local_ca_sha256, vec!["ab".repeat(32)]);
    assert!(read_instance(&json!({ "id": "short", "publicKey": key, "addresses": [] })).is_none());
    assert!(
        read_instance(&json!({ "id": "abcdefgh", "publicKey": "x", "addresses": [] })).is_none()
    );
    assert!(read_instance(
        &json!({ "id": "abcdefgh", "publicKey": key, "addresses": ["ftp://x"] })
    )
    .is_none());
    let many: Vec<String> = (0..17).map(|n| format!("https://h{n}.example")).collect();
    assert!(
        read_instance(&json!({ "id": "abcdefgh", "publicKey": key, "addresses": many })).is_none()
    );
    assert_eq!(read_origin("https://user:pw@a.example"), None);
    assert_eq!(
        read_origin(" https://a.example/path "),
        Some("https://a.example".into())
    );
    assert_eq!(
        refused_words("https://polaris.local:8443"),
        "polaris.local:8443 answers as a different Polaris, so your sign-in was not sent there."
    );
}

#[tokio::test]
async fn an_alternate_is_the_same_only_with_the_instance_signature() {
    let alternate = MockServer::start().await;
    let pair = keypair();
    let known = record(&pair, &[]);
    signing(&alternate, pair).await;
    let http = reqwest::Client::new();
    let timeout = Duration::from_secs(2);
    assert_eq!(
        verify_alternate(&http, &alternate.uri(), &known, timeout).await,
        AlternateVerdict::Same
    );
    // The same id with another key is somebody else.
    let other = record(&keypair(), &[]);
    assert_eq!(
        verify_alternate(&http, &alternate.uri(), &other, timeout).await,
        AlternateVerdict::Different
    );

    let tunnel = MockServer::start().await;
    Mock::given(path("/api/instance/challenge"))
        .respond_with(ResponseTemplate::new(530))
        .mount(&tunnel)
        .await;
    assert_eq!(
        verify_alternate(&http, &tunnel.uri(), &known, timeout).await,
        AlternateVerdict::Unreachable { certificate: false }
    );
}

#[tokio::test]
async fn a_dead_primary_fails_over_to_a_proven_alternate_with_the_key() {
    let (primary, alternate) = (MockServer::start().await, MockServer::start().await);
    let pair = keypair();
    let known = record(&pair, &[&primary.uri(), &alternate.uri()]);
    signing(&alternate, pair).await;
    Mock::given(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(530))
        .mount(&primary)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/v1/me"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({ "user": { "name": "Ada" } })),
        )
        .expect(1)
        .mount(&alternate)
        .await;
    let clock = Arc::new(AtomicU64::new(1));
    let failover = Arc::new(quick(
        reqwest::Client::new(),
        &primary.uri(),
        Some(known),
        clock,
    ));
    let client = ApiClient::new(
        reqwest::Client::new(),
        InstanceUrl::parse(&primary.uri()).unwrap(),
        ApiKey::parse(KEY).unwrap(),
    )
    .with_failover(Arc::clone(&failover));
    assert_eq!(client.me().await.unwrap().user.name.as_deref(), Some("Ada"));
    let status = failover.status();
    assert!(status.local);
    assert_eq!(status.words, Some(USING_LOCAL_WORDS));
    assert_eq!(client.address_words(), Some(USING_LOCAL_WORDS));
}

#[tokio::test]
async fn an_impostor_never_sees_the_key() {
    let (primary, impostor) = (MockServer::start().await, MockServer::start().await);
    let known = record(&keypair(), &[&primary.uri(), &impostor.uri()]);
    // Signs with its own key: claims the id, cannot prove it.
    signing(&impostor, keypair()).await;
    Mock::given(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(502))
        .mount(&primary)
        .await;
    Mock::given(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(200))
        .expect(0)
        .mount(&impostor)
        .await;
    let failover = quick(
        reqwest::Client::new(),
        &primary.uri(),
        Some(known),
        Arc::new(AtomicU64::new(1)),
    );
    let answer = failover
        .request("/api/v1/me", |url| {
            reqwest::Client::new().get(url).bearer_auth("secret")
        })
        .await
        .unwrap();
    assert_eq!(answer.status().as_u16(), 502);
    assert_eq!(failover.status().refused, vec![impostor.uri()]);
    assert!(!failover.status().local);
}

#[tokio::test]
async fn a_real_answer_from_the_primary_is_final_and_the_hold_runs_out() {
    let (primary, alternate) = (MockServer::start().await, MockServer::start().await);
    let pair = keypair();
    let known = record(&pair, &[&alternate.uri()]);
    signing(&alternate, pair).await;
    Mock::given(path("/x"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&primary)
        .await;
    Mock::given(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&alternate)
        .await;
    let clock = Arc::new(AtomicU64::new(1));
    let failover = quick(
        reqwest::Client::new(),
        &primary.uri(),
        Some(known),
        Arc::clone(&clock),
    );
    let make = |url: &str| reqwest::Client::new().get(url);
    // A 401 is an answer: no alternate is tried.
    assert_eq!(
        failover
            .request("/x", make)
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    assert!(!failover.status().local);

    // The primary goes down: the alternate is used and held.
    primary.reset().await;
    Mock::given(path("/x"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&primary)
        .await;
    assert_eq!(
        failover
            .request("/x", make)
            .await
            .unwrap()
            .status()
            .as_u16(),
        200
    );
    assert!(failover.status().local);
    primary.reset().await;
    Mock::given(path("/x"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&primary)
        .await;
    assert_eq!(
        failover
            .request("/x", make)
            .await
            .unwrap()
            .status()
            .as_u16(),
        200
    );
    // Once the hold has run out, the usual address is asked first again.
    clock.store(61_002, Ordering::SeqCst);
    assert_eq!(
        failover
            .request("/x", make)
            .await
            .unwrap()
            .status()
            .as_u16(),
        204
    );
    assert!(!failover.status().local);
    assert_eq!(failover.resolve().await, primary.uri());
}
