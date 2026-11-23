//! Crash and restart around every step of a commit (plan Phase 2, E2): a
//! member's storage is persisted through `Journal` into a host store (here a
//! map standing in for IndexedDB or the server's table, written one
//! transaction per operation), and a "crash" drops the member and restores it
//! from that store with a fresh seed.

use polaris_core::mls::{Journal, Member, MemoryStorage, StoreChange, POLARIS_CIPHERSUITE};
use std::collections::HashMap;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const GROUP: &[u8] = b"polaris/chat/journal";

/// The host's store for one device and the member running over it.
struct Device {
    name: &'static str,
    store: HashMap<Vec<u8>, Vec<u8>>,
    member: Member<MemoryStorage>,
    journal: Journal,
    signature_public_key: Vec<u8>,
    boots: u8,
}

fn seed(name: &str, boot: u8) -> [u8; 32] {
    let mut seed = [boot; 32];
    for (i, byte) in name.bytes().enumerate() {
        seed[i % 32] ^= byte;
    }
    seed
}

impl Device {
    fn new(name: &'static str) -> Self {
        let (storage, journal) = Journal::restore([]);
        let member =
            Member::with_storage(name.as_bytes(), POLARIS_CIPHERSUITE, seed(name, 0), storage)
                .unwrap();
        let signature_public_key = member.signature_public_key().to_vec();
        let mut device = Device {
            name,
            store: HashMap::new(),
            member,
            journal,
            signature_public_key,
            boots: 0,
        };
        device.persist();
        device
    }

    /// One transaction: every change since the last one.
    fn persist(&mut self) -> Vec<StoreChange> {
        let changes = self.journal.changes(self.member.storage());
        for change in &changes {
            match &change.value {
                Some(value) => self.store.insert(change.key.clone(), value.clone()),
                None => self.store.remove(&change.key),
            };
        }
        changes
    }

    /// The process dies: whatever was not persisted is gone.
    fn crash(&mut self) {
        self.boots += 1;
        let (storage, journal) = Journal::restore(self.store.clone());
        self.member = Member::open(
            self.name.as_bytes(),
            POLARIS_CIPHERSUITE,
            seed(self.name, self.boots),
            storage,
            &self.signature_public_key,
        )
        .unwrap();
        self.journal = journal;
    }

    fn epoch(&self) -> u64 {
        self.member.epoch(GROUP).unwrap()
    }
}

/// alice creates the group and adds bob, both persisted at epoch 1.
fn pair() -> (Device, Device) {
    let mut alice = Device::new("alice");
    let mut bob = Device::new("bob");
    let key_package = bob.member.key_package().unwrap();
    bob.persist();
    alice.member.create_group(GROUP).unwrap();
    let out = alice.member.add_members(GROUP, &[key_package]).unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    alice.persist();
    bob.member.join_by_welcome(&out.welcome.unwrap()).unwrap();
    bob.persist();
    (alice, bob)
}

fn talk(from: &Device, to: &Device, text: &[u8]) {
    let sealed = from.member.encrypt(GROUP, text).unwrap();
    assert_eq!(to.member.process(GROUP, &sealed).unwrap().plaintext, text);
}

#[test]
fn a_restart_carries_on_where_the_store_stopped() {
    let (mut alice, mut bob) = pair();
    talk(&alice, &bob, b"before");
    alice.persist();
    bob.persist();
    alice.crash();
    bob.crash();
    assert_eq!((alice.epoch(), bob.epoch()), (1, 1));
    talk(&alice, &bob, b"after both restarted");
    talk(&bob, &alice, b"and back");
}

#[test]
fn nothing_changed_means_nothing_to_write() {
    let (alice, _bob) = pair();
    alice.member.epoch(GROUP).unwrap();
    alice.member.members(GROUP).unwrap();
    assert!(alice.journal.changes(alice.member.storage()).is_empty());
}

#[test]
fn a_crash_before_the_commit_is_persisted_undoes_it() {
    let (mut alice, bob) = pair();
    let lost = alice.member.self_update(GROUP).unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    assert_eq!(alice.epoch(), 2);
    alice.crash();
    // The commit was never handed out, so the group is still at epoch 1 everywhere.
    assert_eq!((alice.epoch(), bob.epoch()), (1, 1));
    talk(&alice, &bob, b"epoch 1 still works");
    // A new commit replaces the lost one; the lost one is never accepted.
    let out = alice.member.self_update(GROUP).unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    alice.persist();
    bob.member.process(GROUP, &out.commit).unwrap();
    assert_eq!((alice.epoch(), bob.epoch()), (2, 2));
    assert!(bob.member.process(GROUP, &lost.commit).is_err());
    talk(&bob, &alice, b"epoch 2");
}

#[test]
fn a_crash_with_a_pending_commit_not_merged_leaves_epoch_one() {
    let (mut alice, bob) = pair();
    alice.member.self_update(GROUP).unwrap();
    alice.persist(); // the pending commit itself is persisted
    alice.crash();
    assert_eq!(alice.epoch(), 1);
    alice.member.clear_pending_commit(GROUP).unwrap();
    alice.persist();
    talk(&alice, &bob, b"pending commit discarded");
}

#[test]
fn a_crash_after_persisting_lets_the_host_resend_the_commit() {
    let (mut alice, mut bob) = pair();
    let out = alice.member.self_update(GROUP).unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    alice.persist();
    alice.crash(); // died before sending; the outbox still holds `out.commit`
    assert_eq!(alice.epoch(), 2);
    bob.member.process(GROUP, &out.commit).unwrap();
    bob.persist();
    bob.crash();
    assert_eq!((alice.epoch(), bob.epoch()), (2, 2));
    talk(&alice, &bob, b"resent commit");
}

#[test]
fn a_receiver_that_crashes_before_persisting_takes_the_commit_again() {
    let (alice, mut bob) = pair();
    let out = alice.member.self_update(GROUP).unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    bob.member.process(GROUP, &out.commit).unwrap();
    bob.crash();
    assert_eq!(bob.epoch(), 1);
    bob.member.process(GROUP, &out.commit).unwrap();
    bob.persist();
    assert_eq!(bob.epoch(), 2);
    talk(&alice, &bob, b"redelivered commit");
}

#[test]
fn a_receiver_that_crashes_before_persisting_opens_the_message_again() {
    let (alice, mut bob) = pair();
    let sealed = alice.member.encrypt(GROUP, b"at least once").unwrap();
    bob.member.process(GROUP, &sealed).unwrap();
    bob.crash();
    assert_eq!(
        bob.member.process(GROUP, &sealed).unwrap().plaintext,
        b"at least once"
    );
    bob.persist();
    // Once persisted, the same ciphertext is a replay.
    bob.crash();
    assert!(bob.member.process(GROUP, &sealed).is_err());
}

#[test]
fn deletions_and_a_removal_survive_a_restart() {
    let (mut alice, mut bob) = pair();
    let mut deleted = 0;
    for _ in 0..4 {
        let out = alice.member.self_update(GROUP).unwrap();
        alice.member.merge_pending_commit(GROUP).unwrap();
        alice.persist();
        bob.member.process(GROUP, &out.commit).unwrap();
        deleted += bob.persist().iter().filter(|c| c.value.is_none()).count();
    }
    // Epochs past the window are dropped, and the drop reaches the store.
    assert!(deleted > 0, "no deletion reached the store");
    let out = alice
        .member
        .remove_members(GROUP, &[bob.member.own_leaf(GROUP).unwrap()])
        .unwrap();
    alice.member.merge_pending_commit(GROUP).unwrap();
    alice.persist();
    assert!(!bob.member.process(GROUP, &out.commit).unwrap().active);
    bob.persist();
    bob.crash();
    assert!(bob.member.encrypt(GROUP, b"x").is_err());
    alice.crash();
    assert_eq!(alice.member.members(GROUP).unwrap().len(), 1);
}
