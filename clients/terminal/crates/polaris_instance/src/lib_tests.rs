use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{Ed25519KeyPair, KeyPair as _};

use super::*;

fn key_pair() -> Ed25519KeyPair {
    let rng = ring::rand::SystemRandom::new();
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("key generates");
    Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("key parses")
}

fn record_for(pair: &Ed25519KeyPair) -> InstanceRecord {
    InstanceRecord {
        id: "inst_abcdefgh".to_owned(),
        public_key: URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        addresses: vec![
            "https://polaris.example.com".to_owned(),
            "https://polaris.local".to_owned(),
        ],
        local_ca_sha256: Vec::new(),
    }
}

fn sign(pair: &Ed25519KeyPair, record: &InstanceRecord, origin: &str, nonce: &str) -> String {
    let message = challenge_message(&record.id, origin, nonce);
    URL_SAFE_NO_PAD.encode(pair.sign(message.as_bytes()).as_ref())
}

#[test]
fn reads_an_instance_and_drops_malformed_ca_pins() {
    let pin = "AB".repeat(32);
    let body = serde_json::json!({
        "id": "inst_abcdefgh",
        "publicKey": "A".repeat(43),
        "addresses": ["https://Polaris.Example.com/home", "https://polaris.example.com", "http://192.168.1.10:3000"],
        "localCaSha256": [pin, "nothex", 7],
    });
    let record = read_instance(&body).expect("a valid answer");
    assert_eq!(
        record.addresses,
        ["https://polaris.example.com", "http://192.168.1.10:3000"]
    );
    assert_eq!(record.local_ca_sha256, ["ab".repeat(32)]);
}

#[test]
fn refuses_an_answer_with_a_bad_id_key_or_address() {
    let good =
        serde_json::json!({ "id": "inst_abcdefgh", "publicKey": "A".repeat(43), "addresses": [] });
    assert!(read_instance(&good).is_some());
    for (field, value) in [
        ("id", serde_json::json!("short")),
        ("publicKey", serde_json::json!("A".repeat(42))),
        ("addresses", serde_json::json!(["ftp://polaris.local"])),
        (
            "addresses",
            serde_json::json!(["https://user:pw@polaris.local"]),
        ),
    ] {
        let mut body = good.clone();
        body[field] = value;
        assert!(read_instance(&body).is_none(), "{field} must be refused");
    }
}

#[test]
fn the_signed_message_matches_the_dashboard_format() {
    assert_eq!(
        challenge_message("inst_abcdefgh", "https://polaris.local", "n0nce"),
        "polaris-instance-v1\ninst_abcdefgh\nhttps://polaris.local\nn0nce"
    );
    assert_eq!(fresh_nonce().len(), 43);
    assert_ne!(fresh_nonce(), fresh_nonce());
}

#[test]
fn an_alternate_that_signs_with_the_stored_key_is_the_same_polaris() {
    let pair = key_pair();
    let record = record_for(&pair);
    let origin = "https://polaris.local";
    let nonce = fresh_nonce();
    let signature = sign(&pair, &record, origin, &nonce);
    let body = serde_json::json!({ "id": record.id, "nonce": nonce, "signature": signature });
    assert_eq!(
        judge_challenge(&record, origin, &nonce, 200, Some(&body)),
        AlternateVerdict::Same
    );
}

#[test]
fn another_key_another_origin_or_a_replayed_nonce_is_a_different_polaris() {
    let pair = key_pair();
    let record = record_for(&pair);
    let origin = "https://polaris.local";
    let nonce = fresh_nonce();

    let impostor = key_pair();
    let forged = sign(&impostor, &record, origin, &nonce);
    let body = serde_json::json!({ "id": record.id, "nonce": nonce, "signature": forged });
    assert_eq!(
        judge_challenge(&record, origin, &nonce, 200, Some(&body)),
        AlternateVerdict::Different
    );

    // Signed for another address: replaying it here proves nothing.
    let elsewhere = sign(&pair, &record, "https://polaris.example.com", &nonce);
    assert!(!verify_challenge(&record, origin, &nonce, &elsewhere));

    // An old answer to another nonce.
    let old = sign(&pair, &record, origin, "old");
    let body = serde_json::json!({ "id": record.id, "nonce": "old", "signature": old });
    assert_eq!(
        judge_challenge(&record, origin, &nonce, 200, Some(&body)),
        AlternateVerdict::Different
    );

    assert_eq!(
        judge_challenge(&record, origin, &nonce, 200, None),
        AlternateVerdict::Different
    );
    assert_eq!(
        judge_challenge(&record, origin, &nonce, 530, None),
        AlternateVerdict::Unreachable { certificate: false }
    );
}

#[test]
fn gateway_statuses_are_not_answers_but_401_is() {
    for status in [502, 503, 504, 520, 530] {
        assert!(is_gateway_failure(status));
    }
    for status in [200, 401, 403, 404, 500, 531] {
        assert!(!is_gateway_failure(status));
    }
}

#[test]
fn failover_uses_an_alternate_only_once_verified_and_returns_to_the_primary() {
    let pair = key_pair();
    let record = record_for(&pair);
    let mut state = FailoverState::new("https://polaris.example.com/", Some(record));
    let local = "https://polaris.local";

    assert_eq!(state.order(0), ["https://polaris.example.com", local]);
    assert!(state.is_verified("https://polaris.example.com", 0));
    assert!(!state.is_verified(local, 0));

    state.record_verdict(local, AlternateVerdict::Same, 0);
    assert!(state.is_verified(local, 1));
    assert!(!state.is_verified(local, DEFAULT_VERIFIED_MS));

    state.settle(local, 10);
    assert!(state.is_local());
    assert_eq!(state.order(20), [local, "https://polaris.example.com"]);
    // Once the hold runs out the primary is tried first again.
    assert_eq!(
        state.order(10 + DEFAULT_HOLD_MS),
        ["https://polaris.example.com", local]
    );
    state.settle("https://polaris.example.com", 10 + DEFAULT_HOLD_MS);
    assert!(!state.is_local());

    state.record_failure(local);
    assert!(!state.is_verified(local, 20));
    state.record_verdict(local, AlternateVerdict::Different, 30);
    assert_eq!(state.refused().collect::<Vec<_>>(), [local]);
    state.record_verdict(
        local,
        AlternateVerdict::Unreachable { certificate: true },
        40,
    );
    assert_eq!(state.untrusted().collect::<Vec<_>>(), [local]);
}

#[test]
fn refused_words_name_the_host() {
    assert_eq!(
        refused_words("https://polaris.local:8443"),
        "polaris.local:8443 answers as a different Polaris, so your sign-in was not sent there."
    );
}

#[test]
fn ca_pins_are_lowercase_sha256_of_the_der() {
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}
