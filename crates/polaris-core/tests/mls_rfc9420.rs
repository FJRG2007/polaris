//! The IETF MLS working group's interoperability vectors (RFC 9420; plan 4.1,
//! "for standards, the official test vectors are replayed too"), run through
//! the provider `polaris_core::mls` ships: its seeded generator, RustCrypto,
//! and OpenMLS's memory storage.
//!
//! The passive-client vectors are the end-to-end ones: a client joins from a
//! Welcome (key schedule, tree hashes, GroupInfo signature, path secret
//! decryption) and then follows every epoch's proposals and commits (TreeKEM,
//! transcript hashes, PSKs), and must reach the same epoch authenticator as
//! the implementation that wrote the vector, after every commit.
//!
//! Source: github.com/mlswg/mls-implementations, `test-vectors/`, commit
//! 2034fe72e0c805a683ba76165660c834f2a8142a (the files'
//! SHA-256 are in crates/polaris-core-vectors/README.md). Suites the
//! RustCrypto provider does not implement (P-521, X448, P-384: 4-7) are
//! counted and must be exactly those; every vector of suites 1-3 must pass.

use openmls::prelude::tls_codec::Deserialize as _;
use openmls::prelude::*;
use openmls::schedule::PreSharedKeyId;
use openmls_traits::crypto::OpenMlsCrypto;
use openmls_traits::storage::StorageProvider as _;
use polaris_core::mls::{MemoryStorage, Provider};
use serde::Deserialize;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const WELCOME: &str =
    include_str!("../../polaris-core-vectors/mls/rfc9420/passive-client-welcome.json");
const HANDLING_COMMIT: &str =
    include_str!("../../polaris-core-vectors/mls/rfc9420/passive-client-handling-commit.json");
const RANDOM: &str =
    include_str!("../../polaris-core-vectors/mls/rfc9420/passive-client-random.json");

fn hex(text: &str) -> Vec<u8> {
    assert!(text.len() % 2 == 0, "odd hex length");
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).expect("hex"))
        .collect()
}

#[derive(Deserialize)]
struct Psk {
    psk_id: String,
    psk: String,
}

#[derive(Deserialize)]
struct Epoch {
    proposals: Vec<String>,
    commit: String,
    epoch_authenticator: String,
}

#[derive(Deserialize)]
struct Vector {
    cipher_suite: u16,
    external_psks: Vec<Psk>,
    key_package: String,
    encryption_priv: String,
    init_priv: String,
    welcome: String,
    ratchet_tree: Option<String>,
    initial_epoch_authenticator: String,
    epochs: Vec<Epoch>,
}

type TestProvider = Provider<MemoryStorage>;

fn message(bytes: &str) -> MlsMessageIn {
    MlsMessageIn::tls_deserialize_exact(hex(bytes)).expect("an MLSMessage")
}

fn process(provider: &TestProvider, group: &mut MlsGroup, bytes: &str) {
    let protocol = message(bytes)
        .try_into_protocol_message()
        .expect("a protocol message");
    let processed = group.process_message(provider, protocol).expect("process");
    match processed.into_content() {
        ProcessedMessageContent::ProposalMessage(proposal) => group
            .store_pending_proposal(provider.storage(), *proposal)
            .expect("store proposal"),
        ProcessedMessageContent::StagedCommitMessage(commit) => group
            .merge_staged_commit(provider, *commit)
            .expect("merge commit"),
        other => panic!("unexpected content {other:?}"),
    }
}

/// Replays one vector; `false` when the provider lacks its suite.
fn replay(vector: &Vector, index: usize) -> bool {
    let provider = TestProvider::new([index as u8; 32], MemoryStorage::default());
    let suite = Ciphersuite::try_from(vector.cipher_suite).expect("a known suite");
    if provider.crypto().supports(suite).is_err() {
        return false;
    }
    for psk in &vector.external_psks {
        PreSharedKeyId::external(hex(&psk.psk_id), Vec::new())
            .store(&provider, &hex(&psk.psk))
            .expect("store psk");
    }
    let MlsMessageBodyIn::KeyPackage(key_package) = message(&vector.key_package).extract() else {
        panic!("vector {index}: key_package is not a KeyPackage");
    };
    let key_package: KeyPackage = key_package.into();
    let bundle = KeyPackageBundle::new(
        key_package.clone(),
        hex(&vector.init_priv).into(),
        hex(&vector.encryption_priv).into(),
    );
    let hash_ref = key_package.hash_ref(provider.crypto()).expect("hash ref");
    provider
        .storage()
        .write_key_package(&hash_ref, &bundle)
        .expect("store key package");

    let MlsMessageBodyIn::Welcome(welcome) = message(&vector.welcome).extract() else {
        panic!("vector {index}: welcome is not a Welcome");
    };
    // Same configuration as OpenMLS's own replay of these files
    // (tests_and_kats/kats/passive_client.rs). The vectors' leaf lifetimes
    // were fixed when they were generated, so lifetimes are not judged here.
    let config = MlsGroupJoinConfig::builder()
        .use_ratchet_tree_extension(true)
        .wire_format_policy(MIXED_PLAINTEXT_WIRE_FORMAT_POLICY)
        .number_of_resumption_psks(16)
        .build();
    let mut join = StagedWelcome::build_from_welcome(&provider, &config, welcome)
        .unwrap_or_else(|e| panic!("vector {index}: welcome: {e}"))
        .skip_lifetime_validation();
    if let Some(tree) = &vector.ratchet_tree {
        join = join.with_ratchet_tree(
            RatchetTreeIn::tls_deserialize_exact(hex(tree)).expect("a ratchet tree"),
        );
    }
    let mut group = join
        .build()
        .unwrap_or_else(|e| panic!("vector {index}: stage welcome: {e}"))
        .into_group(&provider)
        .unwrap_or_else(|e| panic!("vector {index}: join: {e}"));
    assert_eq!(
        group.epoch_authenticator().as_slice(),
        hex(&vector.initial_epoch_authenticator),
        "vector {index}: initial epoch authenticator"
    );
    for (n, epoch) in vector.epochs.iter().enumerate() {
        for proposal in &epoch.proposals {
            process(&provider, &mut group, proposal);
        }
        process(&provider, &mut group, &epoch.commit);
        assert_eq!(
            group.epoch_authenticator().as_slice(),
            hex(&epoch.epoch_authenticator),
            "vector {index}: epoch authenticator after epoch {n}"
        );
    }
    true
}

/// Replays a file; returns how many vectors ran and the suites skipped.
fn replay_file(json: &str) -> (usize, Vec<u16>) {
    let vectors: Vec<Vector> = serde_json::from_str(json).expect("vector file");
    let mut ran = 0;
    let mut skipped = Vec::new();
    for (index, vector) in vectors.iter().enumerate() {
        if replay(vector, index) {
            ran += 1;
        } else {
            skipped.push(vector.cipher_suite);
        }
    }
    skipped.sort_unstable();
    skipped.dedup();
    (ran, skipped)
}

#[test]
fn passive_client_welcome() {
    let (ran, skipped) = replay_file(WELCOME);
    assert_eq!(ran, 24, "8 vectors each for suites 1, 2 and 3");
    assert_eq!(skipped, [4, 5, 6, 7]);
}

#[test]
fn passive_client_handling_commit() {
    let (ran, skipped) = replay_file(HANDLING_COMMIT);
    assert_eq!(ran, 39, "13 vectors each for suites 1, 2 and 3");
    assert_eq!(skipped, [4, 5, 6, 7]);
}

#[test]
fn passive_client_random() {
    let (ran, skipped) = replay_file(RANDOM);
    assert_eq!(ran, 1);
    assert!(skipped.is_empty());
}
