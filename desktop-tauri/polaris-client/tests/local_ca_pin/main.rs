//! Accepting the instance's own local certificate on its proven local address.
//! Ported from desktop/test/main/local-ca-pin.test.ts with the same fixtures:
//! `ca` signed `leaf` (polaris.local, 192.168.1.20), `rogue` signed `rogue-leaf`
//! for the same names.

use polaris_client::instance::InstanceRecord;
use polaris_client::local_ca_pin::{
    chain_ends_in_pin, pem_certificates, pin_scope, sha256_hex, PinScope,
};
use rustls::pki_types::UnixTime;
use std::time::Duration;

const CA: &str = include_str!("../fixtures/local-ca/ca.crt");
const LEAF: &str = include_str!("../fixtures/local-ca/leaf.crt");
const ROGUE: &str = include_str!("../fixtures/local-ca/rogue.crt");
const ROGUE_LEAF: &str = include_str!("../fixtures/local-ca/rogue-leaf.crt");
/// `openssl x509 -noout -fingerprint -sha256` of the fixture CA.
const CA_SHA256: &str = "9f4f55c5188f09e449a8264efbbd36b8f4223b1f4b71411c4b748ce4bb897719";
const PRIMARY: &str = "https://polaris.example.com";

fn record(addresses: &[&str], pins: Option<Vec<String>>) -> InstanceRecord {
    InstanceRecord {
        id: "instance-0001".into(),
        public_key: "A".repeat(43),
        addresses: addresses.iter().map(|one| (*one).to_owned()).collect(),
        local_ca_sha256: pins.unwrap_or_default(),
    }
}

fn full() -> InstanceRecord {
    record(
        &[
            PRIMARY,
            "https://polaris.local",
            "https://192.168.1.20",
            "http://polaris.lan",
        ],
        Some(vec![CA_SHA256.into()]),
    )
}

fn der(pem: &str) -> Vec<u8> {
    pem_certificates(pem).remove(0)
}

fn chain(pems: &[&str]) -> Vec<Vec<u8>> {
    pems.iter().map(|pem| der(pem)).collect()
}

fn now() -> UnixTime {
    UnixTime::now()
}

#[test]
fn the_fixture_ca_has_the_published_fingerprint() {
    assert_eq!(sha256_hex(&der(CA)), CA_SHA256);
}

#[test]
fn covers_the_instance_s_other_https_hosts_only() {
    assert_eq!(
        pin_scope(Some(PRIMARY), Some(&full())),
        Some(PinScope {
            hosts: vec!["polaris.local".into(), "192.168.1.20".into()],
            pins: vec![CA_SHA256.into()]
        })
    );
}

#[test]
fn applies_nowhere_without_a_pin_a_record_or_an_https_usual_address() {
    let addresses = [PRIMARY, "https://polaris.local"];
    assert_eq!(
        pin_scope(Some(PRIMARY), Some(&record(&addresses, None))),
        None
    );
    assert_eq!(
        pin_scope(Some(PRIMARY), Some(&record(&addresses, Some(vec![])))),
        None
    );
    assert_eq!(pin_scope(Some(PRIMARY), None), None);
    assert_eq!(pin_scope(None, Some(&full())), None);
    assert_eq!(
        pin_scope(Some("http://polaris.example.com"), Some(&full())),
        None
    );
    let same_host = record(
        &[PRIMARY, "https://polaris.example.com:8443"],
        Some(vec![CA_SHA256.into()]),
    );
    assert_eq!(pin_scope(Some(PRIMARY), Some(&same_host)), None);
}

#[test]
fn accepts_the_pinned_chain_by_name_and_by_ip() {
    let pins = [CA_SHA256.to_owned()];
    assert!(chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.local",
        &pins,
        now()
    ));
    assert!(chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "192.168.1.20",
        &pins,
        now()
    ));
    assert!(chain_ends_in_pin(
        &chain(&[LEAF, CA, CA]),
        "POLARIS.local",
        &pins,
        now()
    ));
}

#[test]
fn refuses_a_chain_that_only_claims_the_pinned_ca() {
    let pins = [CA_SHA256.to_owned()];
    // A rogue leaf presented with the real CA beside it: not signed by it.
    assert!(!chain_ends_in_pin(
        &chain(&[ROGUE_LEAF, CA]),
        "polaris.local",
        &pins,
        now()
    ));
    assert!(!chain_ends_in_pin(
        &chain(&[ROGUE_LEAF, ROGUE]),
        "polaris.local",
        &pins,
        now()
    ));
    // The pinned CA itself as the leaf, or alone.
    assert!(!chain_ends_in_pin(
        &chain(&[CA]),
        "polaris.local",
        &pins,
        now()
    ));
    assert!(!chain_ends_in_pin(
        &chain(&[CA, CA]),
        "polaris.local",
        &pins,
        now()
    ));
}

#[test]
fn refuses_another_name_another_pin_or_a_date_outside_the_chain() {
    let pins = [CA_SHA256.to_owned()];
    assert!(!chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.example.com",
        &pins,
        now()
    ));
    assert!(!chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.local",
        &["0".repeat(64)],
        now()
    ));
    assert!(!chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.local",
        &[],
        now()
    ));
    let far = UnixTime::since_unix_epoch(Duration::from_secs(200 * 365 * 86_400));
    assert!(!chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.local",
        &pins,
        far
    ));
    let before = UnixTime::since_unix_epoch(Duration::from_secs(86_400));
    assert!(!chain_ends_in_pin(
        &chain(&[LEAF, CA]),
        "polaris.local",
        &pins,
        before
    ));
    assert!(!chain_ends_in_pin(
        &[vec![1, 2, 3], der(CA)],
        "polaris.local",
        &pins,
        now()
    ));
}
