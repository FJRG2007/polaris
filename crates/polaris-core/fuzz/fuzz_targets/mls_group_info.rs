//! `Member::join_by_external_commit` on any bytes as a GroupInfo: never
//! panics.

#![no_main]

use libfuzzer_sys::fuzz_target;
use polaris_core::mls::{ErrorKind, Member, MemoryStorage, POLARIS_CIPHERSUITE};
use std::sync::OnceLock;

const GROUP: &[u8] = b"fuzz-group";

struct Fixture {
    storage: MemoryStorage,
    key: Vec<u8>,
    authenticator: Vec<u8>,
}

/// bob in a two-member group at epoch 1, built once; every input runs against
/// a fresh copy of his storage, so one input cannot influence the next.
fn fixture() -> &'static Fixture {
    static STATE: OnceLock<Fixture> = OnceLock::new();
    STATE.get_or_init(|| {
        let alice = Member::new(b"alice", POLARIS_CIPHERSUITE, [1; 32]).unwrap();
        let bob = Member::new(b"bob", POLARIS_CIPHERSUITE, [2; 32]).unwrap();
        alice.create_group(GROUP).unwrap();
        let out = alice
            .add_members(GROUP, &[bob.key_package().unwrap()])
            .unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.join_by_welcome(&out.welcome.unwrap()).unwrap();
        let storage = MemoryStorage::default();
        *storage.values.write().unwrap() = bob.storage().values.read().unwrap().clone();
        Fixture {
            storage,
            key: bob.signature_public_key().to_vec(),
            authenticator: bob.epoch_authenticator(GROUP).unwrap(),
        }
    })
}

fn bob() -> (Member, &'static [u8]) {
    let fixture = fixture();
    let copy = MemoryStorage::default();
    *copy.values.write().unwrap() = fixture.storage.values.read().unwrap().clone();
    let bob = Member::open(b"bob", POLARIS_CIPHERSUITE, [3; 32], copy, &fixture.key).unwrap();
    (bob, &fixture.authenticator)
}

/// Untrusted bytes may be refused, never reach a storage or internal error.
fn refused_cleanly(kind: ErrorKind) {
    assert!(
        kind != ErrorKind::Internal && kind != ErrorKind::Storage,
        "untrusted input reached {kind:?}"
    );
}

fuzz_target!(|data: &[u8]| {
    let (bob, _) = bob();
    if let Err(error) = bob.join_by_external_commit(data) {
        refused_cleanly(error.kind);
    }
});
