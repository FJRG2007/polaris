//! Phase 0 MLS spike scenario on OpenMLS, the same steps as `../src/bench.ts`.
//! Builds natively (`cargo run --release -- 2 50`) and to wasm32 (`run_size_json` export).

use openmls::prelude::{tls_codec::*, *};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::OpenMlsProvider;
use serde_json::{json, Map, Value};
use web_time::Instant;

const CS: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

struct Device {
    signer: SignatureKeyPair,
    credential: CredentialWithKey,
}

fn device(name: &str, provider: &OpenMlsRustCrypto) -> Device {
    let signer = SignatureKeyPair::new(CS.signature_algorithm()).unwrap();
    signer.store(provider.storage()).unwrap();
    let credential = CredentialWithKey {
        credential: BasicCredential::new(name.as_bytes().to_vec()).into(),
        signature_key: signer.public().into(),
    };
    Device { signer, credential }
}

fn key_package(d: &Device, provider: &OpenMlsRustCrypto) -> KeyPackage {
    KeyPackage::builder().build(CS, provider, &d.signer, d.credential.clone()).unwrap().key_package().clone()
}

/// Serializes then parses, so every measured message really crosses the wire format.
fn wire(message: &MlsMessageOut) -> (usize, MlsMessageIn) {
    let bytes = message.tls_serialize_detached().unwrap();
    (bytes.len(), MlsMessageIn::tls_deserialize_exact(&bytes).unwrap())
}

fn receive(group: &mut MlsGroup, provider: &OpenMlsRustCrypto, message: MlsMessageIn) -> Option<Vec<u8>> {
    let processed = group.process_message(provider, message.try_into_protocol_message().unwrap()).unwrap();
    match processed.into_content() {
        ProcessedMessageContent::ApplicationMessage(m) => Some(m.into_bytes()),
        ProcessedMessageContent::StagedCommitMessage(c) => {
            group.merge_staged_commit(provider, *c).unwrap();
            None
        }
        _ => None,
    }
}

fn content_key(group: &MlsGroup, provider: &OpenMlsRustCrypto) -> Vec<u8> {
    group.export_secret(provider.crypto(), "polaris/content", &group.epoch().as_u64().to_be_bytes(), 32).unwrap()
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

pub fn run_size(n: usize, messages: usize) -> Map<String, Value> {
    let mut row = Map::new();
    let mut put = |k: &str, v: Value| {
        row.insert(k.to_string(), v);
    };
    put("members", json!(n));
    let alice_p = OpenMlsRustCrypto::default();
    let bob_p = OpenMlsRustCrypto::default();
    let others_p = OpenMlsRustCrypto::default();
    let outsider_p = OpenMlsRustCrypto::default();

    let t = Instant::now();
    let alice = device("device-0", &alice_p);
    let bob = device("device-1", &bob_p);
    let mut packages = vec![key_package(&bob, &bob_p)];
    for i in 2..n {
        packages.push(key_package(&device(&format!("device-{i}"), &others_p), &others_p));
    }
    let extra = key_package(&device("extra", &others_p), &others_p);
    put("keyPackageMs", json!(ms(t) / n as f64));

    let config = MlsGroupCreateConfig::builder().ciphersuite(CS).use_ratchet_tree_extension(true).build();
    let t = Instant::now();
    let mut a = MlsGroup::new(&alice_p, &alice.signer, &config, alice.credential.clone()).unwrap();
    let (commit, welcome, _) = a.add_members(&alice_p, &alice.signer, &packages).unwrap();
    a.merge_pending_commit(&alice_p).unwrap();
    put("createMs", json!(ms(t)));
    put("createCommitBytes", json!(wire(&commit).0));
    let (welcome_bytes, welcome_in) = wire(&welcome);
    put("welcomeBytes", json!(welcome_bytes));

    let t = Instant::now();
    let join_config = MlsGroupJoinConfig::builder().use_ratchet_tree_extension(true).build();
    let mut b = StagedWelcome::new_from_welcome(&bob_p, &join_config, match welcome_in.extract() {
        MlsMessageBodyIn::Welcome(w) => w,
        _ => panic!("expected welcome"),
    }, None).unwrap().into_group(&bob_p).unwrap();
    put("joinFromWelcomeMs", json!(ms(t)));

    let t = Instant::now();
    let (commit, welcome, _) = a.add_members(&alice_p, &alice.signer, &[extra]).unwrap();
    a.merge_pending_commit(&alice_p).unwrap();
    put("addCommitMs", json!(ms(t)));
    let (bytes, commit_in) = wire(&commit);
    put("addCommitBytes", json!(bytes));
    put("addWelcomeBytes", json!(wire(&welcome).0));
    let t = Instant::now();
    receive(&mut b, &bob_p, commit_in);
    put("addProcessMs", json!(ms(t)));

    let t = Instant::now();
    let (commit, _, _) = a.remove_members(&alice_p, &alice.signer, &[LeafNodeIndex::new(n as u32)]).unwrap();
    a.merge_pending_commit(&alice_p).unwrap();
    put("removeCommitMs", json!(ms(t)));
    let (bytes, commit_in) = wire(&commit);
    put("removeCommitBytes", json!(bytes));
    let t = Instant::now();
    receive(&mut b, &bob_p, commit_in);
    put("removeProcessMs", json!(ms(t)));

    let text = vec![b'x'; 200];
    let (mut enc, mut dec, mut size) = (0.0, 0.0, 0);
    for _ in 0..messages {
        let t = Instant::now();
        let out = a.create_message(&alice_p, &alice.signer, &text).unwrap();
        enc += ms(t);
        let (bytes, msg_in) = wire(&out);
        size = bytes;
        let t = Instant::now();
        let got = receive(&mut b, &bob_p, msg_in);
        dec += ms(t);
        assert_eq!(got.as_deref(), Some(&text[..]));
    }
    put("encryptMs", json!(enc / messages as f64));
    put("decryptMs", json!(dec / messages as f64));
    put("msg200BCiphertextBytes", json!(size));

    let t = Instant::now();
    let key_a = content_key(&a, &alice_p);
    put("exporterMs", json!(ms(t)));
    put("exporterAgrees", json!(key_a == content_key(&b, &bob_p)));

    // OpenMLS persists through its StorageProvider; the device's store is the state to keep.
    let t = Instant::now();
    let snapshot: Vec<(Vec<u8>, Vec<u8>)> = bob_p.storage().values.read().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    put("serializeMs", json!(ms(t)));
    put("stateBytes", json!(snapshot.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>()));
    let group_id = b.group_id().clone();
    drop(b);
    let restored_p = OpenMlsRustCrypto::default();
    let t = Instant::now();
    restored_p.storage().values.write().unwrap().extend(snapshot);
    let mut restored = MlsGroup::load(restored_p.storage(), &group_id).unwrap().unwrap();
    put("restoreMs", json!(ms(t)));
    let out = a.create_message(&alice_p, &alice.signer, b"after restore").unwrap();
    put("restoredDecrypts", json!(receive(&mut restored, &restored_p, wire(&out).1).as_deref() == Some(&b"after restore"[..])));

    let t = Instant::now();
    let group_info = a.export_group_info(alice_p.crypto(), &alice.signer, true).unwrap();
    let (gi_bytes, gi_in) = wire(&group_info);
    put("groupInfoBytes", json!(gi_bytes));
    let outsider = device("outsider", &outsider_p);
    #[allow(deprecated)] // the builder replacement is newer than this spike; same commit on the wire
    let (o, external, _) = MlsGroup::join_by_external_commit(
        &outsider_p,
        &outsider.signer,
        None,
        match gi_in.extract() {
            MlsMessageBodyIn::GroupInfo(g) => g,
            _ => panic!("expected group info"),
        },
        &join_config,
        None,
        None,
        &[],
        outsider.credential.clone(),
    )
    .unwrap();
    put("externalJoinMs", json!(ms(t)));
    let (bytes, ext_in) = wire(&external);
    put("externalCommitBytes", json!(bytes));
    let t = Instant::now();
    receive(&mut a, &alice_p, ext_in);
    put("externalProcessMs", json!(ms(t)));
    put("externalAgrees", json!(content_key(&a, &alice_p) == content_key(&o, &outsider_p)));
    row
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn run_size_json(n: usize, messages: usize) -> String {
    Value::Object(run_size(n, messages)).to_string()
}
