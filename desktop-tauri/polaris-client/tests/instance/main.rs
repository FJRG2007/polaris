//! Reading an instance's answer, the stored records and the same-instance
//! check (the proof and the failover are in tests/failover), against local mock servers signing with a real Ed25519 key. Ported
//! from desktop/test/main/window-failover.test.ts, instance-store.test.ts and the
//! core instance-fallback tests.

use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use polaris_client::instance::{
    challenge_message, find_same_instance, read_instance, refused_words, InstanceRecord,
    KnownInstance,
};
use polaris_client::instance_store::{read_instances, read_stored_instance, write_stored_instance};
use polaris_client::same_instance::SameInstance;
use polaris_client::servers::SavedServer;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const ID: &str = "instance-0001";

fn key() -> Arc<Ed25519KeyPair> {
    let rng = aws_lc_rs::rand::SystemRandom::new();
    let document = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
    Arc::new(Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap())
}

fn record(key: &Ed25519KeyPair, addresses: &[&str]) -> InstanceRecord {
    InstanceRecord {
        id: ID.into(),
        public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
        addresses: addresses.iter().map(|one| (*one).to_owned()).collect(),
        local_ca_sha256: Vec::new(),
    }
}

/// Answers the challenge as the instance would, signing over the origin it is asked on.
struct Signer {
    key: Arc<Ed25519KeyPair>,
    origin: String,
}

impl Respond for Signer {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let nonce = body["nonce"].as_str().unwrap_or_default();
        let signature = self
            .key
            .sign(challenge_message(ID, &self.origin, nonce).as_bytes());
        ResponseTemplate::new(200).set_body_json(json!({
            "id": ID,
            "nonce": nonce,
            "signature": URL_SAFE_NO_PAD.encode(signature.as_ref())
        }))
    }
}

async fn instance_at(server: &MockServer, key: &Arc<Ed25519KeyPair>, describes: &InstanceRecord) {
    Mock::given(method("POST"))
        .and(path("/api/instance/challenge"))
        .respond_with(Signer {
            key: key.clone(),
            origin: server.uri(),
        })
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/instance"))
        .respond_with(ResponseTemplate::new(200).set_body_json(describes))
        .mount(server)
        .await;
}

const TIMEOUT: Duration = Duration::from_secs(2);

#[test]
fn an_answer_is_read_strictly() {
    let good = json!({
        "id": ID,
        "publicKey": "A".repeat(43),
        "addresses": ["https://polaris.example.com/", "https://polaris.example.com", "http://192.168.1.20:3000"],
        "localCaSha256": ["  9F4F55C5188F09E449A8264EFBBD36B8F4223B1F4B71411C4B748CE4BB897719 ", "short", 7]
    });
    let read = read_instance(&good).unwrap();
    assert_eq!(
        read.addresses,
        ["https://polaris.example.com", "http://192.168.1.20:3000"]
    );
    assert_eq!(
        read.local_ca_sha256,
        ["9f4f55c5188f09e449a8264efbbd36b8f4223b1f4b71411c4b748ce4bb897719"]
    );
    for bad in [
        json!({ "id": "short", "publicKey": "A".repeat(43), "addresses": [] }),
        json!({ "id": ID, "publicKey": "A".repeat(42), "addresses": [] }),
        json!({ "id": ID, "publicKey": "A".repeat(43), "addresses": ["ftp://x"] }),
        json!({ "id": ID, "publicKey": "A".repeat(43), "addresses": vec!["https://a.example"; 17] }),
        json!("junk"),
    ] {
        assert_eq!(read_instance(&bad), None, "{bad}");
    }
    assert_eq!(
        refused_words("https://polaris.local:8443"),
        "polaris.local:8443 answers as a different Polaris, so your sign-in was not sent there."
    );
}

#[tokio::test]
async fn a_second_name_of_a_listed_polaris_is_recognized_by_its_signature() {
    let real = key();
    let local = MockServer::start().await;
    let listed = "https://polaris.example.com";
    let learned = record(&real, &[listed, &local.uri()]);
    instance_at(&local, &real, &learned).await;
    let known = [KnownInstance {
        origin: listed.into(),
        record: learned.clone(),
    }];
    let client = reqwest::Client::new();
    let found = find_same_instance(&client, &[local.uri()], &known, TIMEOUT).await;
    assert_eq!(found.map(|one| one.origin).as_deref(), Some(listed));

    let saved = [SavedServer {
        origin: listed.into(),
        name: None,
    }];
    let checker = SameInstance::default();
    let asked = Arc::new(AtomicU64::new(0));
    let counter = asked.clone();
    let record_for = move |_origin: String| {
        counter.fetch_add(1, Ordering::SeqCst);
        let record = learned.clone();
        async move { Some(record) }
    };
    let same = checker
        .same_instance_as(&local.uri(), &saved, false, &client, &record_for)
        .await;
    assert_eq!(same.as_deref(), Some(listed));
    // Asked again within 30 seconds: the answer is reused.
    let again = checker
        .same_instance_as(&local.uri(), &saved, false, &client, &record_for)
        .await;
    assert_eq!(again.as_deref(), Some(listed));
    assert_eq!(asked.load(Ordering::SeqCst), 1);

    let stranger = MockServer::start().await;
    instance_at(&stranger, &key(), &record(&key(), &[])).await;
    assert_eq!(
        checker
            .same_instance_as(&stranger.uri(), &saved, false, &client, &record_for)
            .await,
        None
    );
}

#[test]
fn records_are_kept_per_server_and_a_bad_file_reads_as_none() {
    let dir = std::env::temp_dir().join(format!(
        "polaris-client-test-instances-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    let file = dir.join("instances.json");
    assert!(read_instances(&file).is_empty());
    let one = record(
        &key(),
        &["https://polaris.example.com", "https://polaris.local"],
    );
    write_stored_instance(&file, "https://polaris.example.com", one.clone(), 42).unwrap();
    write_stored_instance(&file, "https://other.example.com", one.clone(), 43).unwrap();
    let stored = read_stored_instance(&file, "https://polaris.example.com").unwrap();
    assert_eq!((stored.record, stored.learned_at), (one, 42));
    assert_eq!(read_instances(&file).len(), 2);
    std::fs::write(
        &file,
        r#"{"https://a.example": {"record": {"id": "x"}}, "https://b.example": 5}"#,
    )
    .unwrap();
    assert!(read_instances(&file).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}
