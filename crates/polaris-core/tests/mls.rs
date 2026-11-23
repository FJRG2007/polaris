//! The MLS domain's protocol behaviour and the adversarial checklist in the
//! ledger's E1 row (docs/rust-core-ledger.md): every known pitfall is one
//! test here, on both accepted suites, natively and in WebAssembly.

use polaris_core::mls::{
    ErrorKind, Member, MemoryStorage, ProcessedKind, CLASSIC_CIPHERSUITE, CONTENT_SIGNATURE_LABEL,
    MAX_PAST_EPOCHS, POLARIS_CIPHERSUITE,
};
use std::collections::HashMap;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const SUITES: [u16; 2] = [POLARIS_CIPHERSUITE, CLASSIC_CIPHERSUITE];
const GROUP: &[u8] = b"polaris/chat/1";

fn seed(tag: &str) -> [u8; 32] {
    let mut seed = [0u8; 32];
    for (i, byte) in tag.bytes().enumerate() {
        seed[i % 32] ^= byte.rotate_left(i as u32 % 8);
    }
    seed[31] ^= tag.len() as u8;
    seed
}

fn member(name: &str, suite: u16) -> Member {
    Member::new(name.as_bytes(), suite, seed(name)).expect("member")
}

/// A copy of a member's whole storage: what an attacker who seized the
/// device at that moment holds.
fn snapshot(storage: &MemoryStorage) -> MemoryStorage {
    let copy = MemoryStorage::default();
    *copy.values.write().unwrap() = storage.values.read().unwrap().clone();
    copy
}

fn clone_member(name: &str, suite: u16, from: &Member) -> Member {
    Member::open(
        name.as_bytes(),
        suite,
        seed(&format!("{name}/clone")),
        snapshot(from.storage()),
        from.signature_public_key(),
    )
    .expect("open clone")
}

/// alice creates the group and adds bob; both at epoch 1.
fn pair(suite: u16) -> (Member, Member) {
    let alice = member("alice", suite);
    let bob = member("bob", suite);
    alice.create_group(GROUP).unwrap();
    let out = alice
        .add_members(GROUP, &[bob.key_package().unwrap()])
        .unwrap();
    alice.merge_pending_commit(GROUP).unwrap();
    assert_eq!(bob.join_by_welcome(&out.welcome.unwrap()).unwrap(), GROUP);
    (alice, bob)
}

fn assert_kind<T: std::fmt::Debug>(
    result: polaris_core::mls::Result<T>,
    kind: ErrorKind,
    what: &str,
) {
    match result {
        Err(error) => assert_eq!(error.kind, kind, "{what}: {error}"),
        Ok(value) => panic!("{what}: accepted, got {value:?}"),
    }
}

fn assert_agree(members: &[&Member]) {
    let first = members[0];
    for other in &members[1..] {
        assert_eq!(first.epoch(GROUP).unwrap(), other.epoch(GROUP).unwrap());
        assert_eq!(
            first.epoch_authenticator(GROUP).unwrap(),
            other.epoch_authenticator(GROUP).unwrap()
        );
        assert_eq!(
            first
                .export_secret(GROUP, "polaris/content", b"", 32)
                .unwrap(),
            other
                .export_secret(GROUP, "polaris/content", b"", 32)
                .unwrap()
        );
    }
}

#[test]
fn group_lifecycle_on_both_suites() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        assert_eq!(alice.ciphersuite(), suite);
        assert_agree(&[&alice, &bob]);
        assert_eq!(bob.epoch(GROUP).unwrap(), 1);

        let sealed = alice.encrypt(GROUP, b"hola").unwrap();
        let opened = bob.process(GROUP, &sealed).unwrap();
        assert_eq!(opened.kind, ProcessedKind::Application);
        assert_eq!(opened.plaintext, b"hola");
        assert_eq!(opened.sender_identity, b"alice");
        assert_eq!(opened.sender_leaf, Some(alice.own_leaf(GROUP).unwrap()));

        // carol joins by external commit from bob's GroupInfo.
        let carol = member("carol", suite);
        let (group, commit) = carol
            .join_by_external_commit(&bob.group_info(GROUP).unwrap())
            .unwrap();
        assert_eq!(group, GROUP);
        // Applied on the spot: there is nothing pending to merge.
        assert_kind(
            carol.merge_pending_commit(GROUP),
            ErrorKind::Rejected,
            "nothing pending",
        );
        for existing in [&alice, &bob] {
            let processed = existing.process(GROUP, &commit).unwrap();
            assert_eq!(processed.kind, ProcessedKind::Commit);
            assert_eq!(processed.sender_leaf, None);
            assert_eq!(processed.sender_identity, b"carol");
        }
        assert_agree(&[&alice, &bob, &carol]);
        let names: Vec<Vec<u8>> = alice
            .members(GROUP)
            .unwrap()
            .into_iter()
            .map(|m| m.identity)
            .collect();
        assert_eq!(
            names,
            [b"alice".to_vec(), b"bob".to_vec(), b"carol".to_vec()]
        );

        // bob updates his own path; then alice removes carol.
        let update = bob.self_update(GROUP).unwrap();
        bob.merge_pending_commit(GROUP).unwrap();
        alice.process(GROUP, &update.commit).unwrap();
        carol.process(GROUP, &update.commit).unwrap();
        assert_agree(&[&alice, &bob, &carol]);

        let carol_leaf = carol.own_leaf(GROUP).unwrap();
        let removal = alice.remove_members(GROUP, &[carol_leaf]).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        assert!(bob.process(GROUP, &removal.commit).unwrap().active);
        let removed = carol.process(GROUP, &removal.commit).unwrap();
        assert!(!removed.active, "carol learns she was removed");
        assert_agree(&[&alice, &bob]);

        let echo = bob.encrypt(GROUP, b"after").unwrap();
        assert_eq!(alice.process(GROUP, &echo).unwrap().plaintext, b"after");
    }
}

#[test]
fn every_member_decrypts_every_message_in_a_group_of_five() {
    let suite = POLARIS_CIPHERSUITE;
    let names = ["m0", "m1", "m2", "m3", "m4"];
    let members: Vec<Member> = names.iter().map(|n| member(n, suite)).collect();
    members[0].create_group(GROUP).unwrap();
    let packages: Vec<Vec<u8>> = members[1..]
        .iter()
        .map(|m| m.key_package().unwrap())
        .collect();
    let out = members[0].add_members(GROUP, &packages).unwrap();
    members[0].merge_pending_commit(GROUP).unwrap();
    let welcome = out.welcome.unwrap();
    for joiner in &members[1..] {
        joiner.join_by_welcome(&welcome).unwrap();
    }
    for (i, sender) in members.iter().enumerate() {
        let text = format!("from {i}");
        let sealed = sender.encrypt(GROUP, text.as_bytes()).unwrap();
        for (j, receiver) in members.iter().enumerate().filter(|(j, _)| *j != i) {
            let opened = receiver.process(GROUP, &sealed).unwrap();
            assert_eq!(opened.plaintext, text.as_bytes(), "{i} -> {j}");
        }
    }
    let refs: Vec<&Member> = members.iter().collect();
    assert_agree(&refs);
}

// --- The adversarial checklist (ledger E1) ---------------------------------

/// P1 replay: the same PrivateMessage twice opens once. Its key is deleted
/// after use (RFC 9420, 9.2), so the replay fails and leaves no trace.
#[test]
fn p1_replayed_application_message_is_refused() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let sealed = alice.encrypt(GROUP, b"once").unwrap();
        assert_eq!(bob.process(GROUP, &sealed).unwrap().plaintext, b"once");
        assert_kind(bob.process(GROUP, &sealed), ErrorKind::Rejected, "replay");
        let next = alice.encrypt(GROUP, b"twice").unwrap();
        assert_eq!(bob.process(GROUP, &next).unwrap().plaintext, b"twice");
    }
}

/// P2 epoch rollback: a commit already applied, delivered again, cannot take
/// the group back or forward; neither can a commit from an older epoch.
#[test]
fn p2_old_commits_cannot_roll_the_epoch_back() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let first = alice.self_update(GROUP).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &first.commit).unwrap();
        let second = alice.self_update(GROUP).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &second.commit).unwrap();
        let epoch = bob.epoch(GROUP).unwrap();
        let authenticator = bob.epoch_authenticator(GROUP).unwrap();
        for stale in [&first.commit, &second.commit] {
            assert_kind(
                bob.process(GROUP, stale),
                ErrorKind::Rejected,
                "stale commit",
            );
        }
        assert_eq!(bob.epoch(GROUP).unwrap(), epoch);
        assert_eq!(bob.epoch_authenticator(GROUP).unwrap(), authenticator);
        assert_agree(&[&alice, &bob]);
    }
}

/// P3 malformed commits: truncated, extended, or with any single bit flipped,
/// a commit is refused and the receiver's state is untouched - the real
/// commit still applies afterwards.
#[test]
fn p3_malformed_commits_are_refused_without_side_effects() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let commit = alice.self_update(GROUP).unwrap().commit;
        alice.merge_pending_commit(GROUP).unwrap();
        let before = bob.epoch_authenticator(GROUP).unwrap();
        let mut variants: Vec<Vec<u8>> = vec![
            Vec::new(),
            commit[..commit.len() / 2].to_vec(),
            commit[..commit.len() - 1].to_vec(),
            [commit.as_slice(), &[0]].concat(),
        ];
        // A bit flip at a spread of positions: framing, header, ciphertext, tag.
        let step = (commit.len() / 61).max(1);
        for at in (0..commit.len()).step_by(step) {
            let mut flipped = commit.clone();
            flipped[at] ^= 0x01;
            variants.push(flipped);
        }
        for (n, bad) in variants.iter().enumerate() {
            let result = bob.process(GROUP, bad);
            assert!(result.is_err(), "variant {n} accepted");
            assert_eq!(
                bob.epoch_authenticator(GROUP).unwrap(),
                before,
                "variant {n} changed state"
            );
        }
        bob.process(GROUP, &commit).unwrap();
        assert_agree(&[&alice, &bob]);
    }
}

/// P4 a Welcome reaches only the member it was made for: anyone else, even a
/// member of the same service, cannot join with it.
#[test]
fn p4_welcome_for_someone_else_is_refused() {
    for suite in SUITES {
        let alice = member("alice", suite);
        let bob = member("bob", suite);
        let mallory = member("mallory", suite);
        let _ = mallory.key_package().unwrap();
        alice.create_group(GROUP).unwrap();
        let out = alice
            .add_members(GROUP, &[bob.key_package().unwrap()])
            .unwrap();
        let welcome = out.welcome.unwrap();
        assert_kind(
            mallory.join_by_welcome(&welcome),
            ErrorKind::Rejected,
            "welcome to mallory",
        );
        assert_kind(
            mallory.epoch(GROUP),
            ErrorKind::UnknownGroup,
            "mallory has no group",
        );
        bob.join_by_welcome(&welcome).unwrap();
    }
}

/// P5 key package reuse: a KeyPackage's private keys open one Welcome only.
/// A second group adding the same package cannot bring its owner in.
#[test]
fn p5_a_key_package_opens_one_welcome_only() {
    for suite in SUITES {
        let bob = member("bob", suite);
        let package = bob.key_package().unwrap();
        let alice = member("alice", suite);
        let eve = member("eve", suite);
        alice.create_group(b"first").unwrap();
        eve.create_group(b"second").unwrap();
        let first = alice
            .add_members(b"first", std::slice::from_ref(&package))
            .unwrap();
        let second = eve.add_members(b"second", &[package]).unwrap();
        bob.join_by_welcome(&first.welcome.unwrap()).unwrap();
        assert_kind(
            bob.join_by_welcome(&second.welcome.unwrap()),
            ErrorKind::Rejected,
            "second welcome on a used key package",
        );
    }
}

/// P6 forward secrecy inside an epoch: once bob opened a message, a full copy
/// of his device taken afterwards cannot open it again.
#[test]
fn p6_forward_secrecy_a_seized_device_cannot_reopen_read_messages() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let sealed = alice.encrypt(GROUP, b"read before the seizure").unwrap();
        bob.process(GROUP, &sealed).unwrap();
        let seized = clone_member("bob", suite, &bob);
        assert_kind(
            seized.process(GROUP, &sealed),
            ErrorKind::Rejected,
            "seized reopen",
        );
    }
}

/// P7 forward secrecy across epochs: messages older than MAX_PAST_EPOCHS no
/// longer open, because their epoch secrets are deleted.
#[test]
fn p7_forward_secrecy_old_epochs_are_forgotten() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let old = alice.encrypt(GROUP, b"old").unwrap();
        let recent = alice.encrypt(GROUP, b"recent").unwrap();
        for _ in 0..MAX_PAST_EPOCHS {
            let commit = alice.self_update(GROUP).unwrap().commit;
            alice.merge_pending_commit(GROUP).unwrap();
            bob.process(GROUP, &commit).unwrap();
        }
        // Still inside the window: the message from MAX_PAST_EPOCHS ago opens.
        assert_eq!(bob.process(GROUP, &recent).unwrap().plaintext, b"recent");
        let commit = alice.self_update(GROUP).unwrap().commit;
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &commit).unwrap();
        assert_kind(
            bob.process(GROUP, &old),
            ErrorKind::Rejected,
            "message beyond the window",
        );
    }
}

/// P8 post-compromise security: an attacker holding a full copy of alice's
/// device loses access once alice commits a fresh path.
#[test]
fn p8_post_compromise_security_after_a_self_update() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let seized = clone_member("alice", suite, &alice);
        let update = alice.self_update(GROUP).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &update.commit).unwrap();
        // The copy cannot follow alice's own commit (its path secrets came
        // from alice's generator, never stored), so it stays behind...
        assert!(seized.process(GROUP, &update.commit).is_err());
        // ...and cannot open what is said in the new epoch.
        let sealed = bob.encrypt(GROUP, b"after the heal").unwrap();
        assert!(seized.process(GROUP, &sealed).is_err());
        assert_ne!(
            seized
                .export_secret(GROUP, "polaris/content", b"", 32)
                .unwrap(),
            bob.export_secret(GROUP, "polaris/content", b"", 32)
                .unwrap()
        );
        assert_eq!(
            alice.process(GROUP, &sealed).unwrap().plaintext,
            b"after the heal"
        );
    }
}

/// P9 a removed member cannot read anything said after the removal, nor
/// follow later commits.
#[test]
fn p9_removed_member_is_locked_out() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let carol = member("carol", suite);
        let added = alice
            .add_members(GROUP, &[carol.key_package().unwrap()])
            .unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &added.commit).unwrap();
        carol.join_by_welcome(&added.welcome.unwrap()).unwrap();
        let removal = alice
            .remove_members(GROUP, &[carol.own_leaf(GROUP).unwrap()])
            .unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &removal.commit).unwrap();
        let sealed = alice.encrypt(GROUP, b"carol is gone").unwrap();
        assert!(carol.process(GROUP, &sealed).is_err());
        assert_eq!(
            bob.process(GROUP, &sealed).unwrap().plaintext,
            b"carol is gone"
        );
    }
}

/// P10 forged or foreign input: a message for another group, a message from
/// another group with the same id, wrong message types and an unsupported
/// cipher suite are all refused with the right reason.
#[test]
fn p10_foreign_and_mistyped_input_is_refused() {
    let (alice, bob) = pair(POLARIS_CIPHERSUITE);
    let sealed = alice.encrypt(GROUP, b"x").unwrap();
    assert_kind(
        bob.process(b"other", &sealed),
        ErrorKind::Rejected,
        "other group id",
    );
    // A parallel group with the same id, run by mallory: its messages do not
    // verify in alice's group.
    let (mallory, _) = {
        let mallory = member("mallory", POLARIS_CIPHERSUITE);
        let trudy = member("trudy", POLARIS_CIPHERSUITE);
        mallory.create_group(GROUP).unwrap();
        let out = mallory
            .add_members(GROUP, &[trudy.key_package().unwrap()])
            .unwrap();
        mallory.merge_pending_commit(GROUP).unwrap();
        trudy.join_by_welcome(&out.welcome.unwrap()).unwrap();
        (mallory, trudy)
    };
    let forged = mallory.encrypt(GROUP, b"forged").unwrap();
    assert_kind(
        bob.process(GROUP, &forged),
        ErrorKind::Rejected,
        "same id, other group",
    );

    let package = member("dave", POLARIS_CIPHERSUITE).key_package().unwrap();
    assert_kind(
        bob.process(GROUP, &package),
        ErrorKind::WrongMessageType,
        "key package as message",
    );
    assert_kind(
        bob.join_by_welcome(&sealed),
        ErrorKind::WrongMessageType,
        "message as welcome",
    );
    assert_kind(
        bob.join_by_external_commit(&package),
        ErrorKind::WrongMessageType,
        "key package as group info",
    );
    assert_kind(
        alice.add_members(GROUP, std::slice::from_ref(&sealed)),
        ErrorKind::WrongMessageType,
        "message as key package",
    );
    assert_kind(
        bob.process(GROUP, &[0xff; 3]),
        ErrorKind::Malformed,
        "garbage",
    );
    assert_kind(
        Member::new(b"x", 0x0002, [0; 32]).map(|_| ()),
        ErrorKind::UnsupportedCiphersuite,
        "suite 2",
    );
    // A key package for the other suite cannot join a PQ group.
    let classic = member("erin", CLASSIC_CIPHERSUITE).key_package().unwrap();
    assert_kind(
        alice.add_members(GROUP, &[classic]),
        ErrorKind::Rejected,
        "suite mismatch",
    );
}

/// P11 the author cannot be impersonated by a replayed own message, and the
/// delivery service echoing an author's own message back is refused, not
/// reported as an empty message.
#[test]
fn p11_own_messages_echoed_back_are_refused() {
    let (alice, _bob) = pair(POLARIS_CIPHERSUITE);
    let sealed = alice.encrypt(GROUP, b"mine").unwrap();
    assert_kind(
        alice.process(GROUP, &sealed),
        ErrorKind::Rejected,
        "own message echo",
    );
}

/// P12 a group id cannot be taken over: creating or joining a group whose id
/// is already in storage is refused instead of overwriting it.
#[test]
fn p12_existing_group_is_never_overwritten() {
    let (alice, bob) = pair(POLARIS_CIPHERSUITE);
    assert_kind(
        alice.create_group(GROUP),
        ErrorKind::Rejected,
        "create over existing",
    );
    let other = member("zoe", POLARIS_CIPHERSUITE);
    other.create_group(GROUP).unwrap();
    let out = other
        .add_members(GROUP, &[bob.key_package().unwrap()])
        .unwrap();
    assert_kind(
        bob.join_by_welcome(&out.welcome.unwrap()),
        ErrorKind::Rejected,
        "join over existing",
    );
    assert_agree(&[&alice, &bob]);
}

/// P13 state survives a restart: a member rebuilt from its storage and seed-
/// independent signature key carries on in the same epoch.
#[test]
fn p13_member_restored_from_storage_carries_on() {
    let (alice, bob) = pair(POLARIS_CIPHERSUITE);
    let restored = Member::open(
        b"bob",
        POLARIS_CIPHERSUITE,
        seed("bob/after-restart"),
        snapshot(bob.storage()),
        bob.signature_public_key(),
    )
    .unwrap();
    drop(bob);
    let sealed = alice.encrypt(GROUP, b"still here").unwrap();
    assert_eq!(
        restored.process(GROUP, &sealed).unwrap().plaintext,
        b"still here"
    );
    let reply = restored.encrypt(GROUP, b"yes").unwrap();
    assert_eq!(alice.process(GROUP, &reply).unwrap().plaintext, b"yes");
    assert_kind(
        Member::open(
            b"bob",
            POLARIS_CIPHERSUITE,
            [0; 32],
            MemoryStorage::default(),
            &[1; 32],
        )
        .map(|_| ()),
        ErrorKind::Storage,
        "open without a stored key",
    );
}

/// P14 out-of-order delivery inside an epoch still opens every message.
#[test]
fn p14_out_of_order_messages_open() {
    let (alice, bob) = pair(POLARIS_CIPHERSUITE);
    let sealed: Vec<Vec<u8>> = (0..5)
        .map(|i| alice.encrypt(GROUP, &[i]).unwrap())
        .collect();
    let mut seen = HashMap::new();
    for i in [4usize, 0, 3, 1, 2] {
        seen.insert(i, bob.process(GROUP, &sealed[i]).unwrap().plaintext);
    }
    for i in 0..5u8 {
        assert_eq!(seen[&(i as usize)], [i]);
    }
}

/// A refused external join is forgotten and tried again from the newer
/// GroupInfo; a member whose copy forked forgets it, rejoins, and its old
/// leaf is removed - on both suites.
#[test]
fn forgotten_groups_can_be_joined_again() {
    for suite in SUITES {
        let (alice, bob) = pair(suite);
        let stale_info = alice.group_info(GROUP).unwrap();

        // carol joins from epoch 1's GroupInfo, but alice's update wins epoch 1.
        let carol = member("carol", suite);
        let (_, lost) = carol.join_by_external_commit(&stale_info).unwrap();
        let won = alice.self_update(GROUP).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        bob.process(GROUP, &won.commit).unwrap();
        assert_kind(
            carol.join_by_external_commit(&alice.group_info(GROUP).unwrap()),
            ErrorKind::Rejected,
            "a second join over a group still held",
        );
        assert!(alice.process(GROUP, &lost).is_err());
        carol.forget_group(GROUP).unwrap();
        assert_kind(carol.epoch(GROUP), ErrorKind::UnknownGroup, "forgotten");
        assert_kind(
            carol.forget_group(GROUP),
            ErrorKind::UnknownGroup,
            "forgotten twice",
        );
        let (_, commit) = carol
            .join_by_external_commit(&alice.group_info(GROUP).unwrap())
            .unwrap();
        alice.process(GROUP, &commit).unwrap();
        bob.process(GROUP, &commit).unwrap();
        assert_agree(&[&alice, &bob, &carol]);

        let bobs = |m: &Member| {
            m.members(GROUP)
                .unwrap()
                .into_iter()
                .filter(|x| x.identity == b"bob")
                .count()
        };
        // bob forgets its copy and rejoins with the same key: the external
        // commit replaces its old leaf itself (RFC 9420, 12.4.3.2 resync).
        bob.forget_group(GROUP).unwrap();
        let (_, commit) = bob
            .join_by_external_commit(&alice.group_info(GROUP).unwrap())
            .unwrap();
        alice.process(GROUP, &commit).unwrap();
        carol.process(GROUP, &commit).unwrap();
        assert_eq!(bobs(&alice), 1);
        assert_agree(&[&alice, &bob, &carol]);

        // A bob that lost its store has a new key, so its old leaf stays
        // until the new one removes it.
        let old_leaf = bob.own_leaf(GROUP).unwrap();
        let bob = Member::new(b"bob", suite, seed("bob/after-loss")).unwrap();
        let (_, commit) = bob
            .join_by_external_commit(&alice.group_info(GROUP).unwrap())
            .unwrap();
        alice.process(GROUP, &commit).unwrap();
        carol.process(GROUP, &commit).unwrap();
        assert_eq!(bobs(&alice), 2);
        let removal = bob.remove_members(GROUP, &[old_leaf]).unwrap();
        bob.merge_pending_commit(GROUP).unwrap();
        alice.process(GROUP, &removal.commit).unwrap();
        carol.process(GROUP, &removal.commit).unwrap();
        assert_eq!(bobs(&alice), 1);
        assert_agree(&[&alice, &bob, &carol]);
        let sealed = bob.encrypt(GROUP, b"back").unwrap();
        assert_eq!(alice.process(GROUP, &sealed).unwrap().plaintext, b"back");
    }
}

/// A content signature is plain Ed25519 under the device's MLS signature key,
/// over the label and the payload: it verifies against the published key,
/// and not without the label, for another payload or under another key.
#[test]
fn content_signatures_verify_against_the_signature_key() {
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    for suite in SUITES {
        let alice = member("alice", suite);
        let bob = member("bob", suite);
        let payload = b"conversation|message|epoch|digest";
        let signature = alice.sign_content(payload).unwrap();
        let signature = Signature::from_slice(&signature).unwrap();
        let key = |m: &Member| {
            VerifyingKey::from_bytes(m.signature_public_key().try_into().unwrap()).unwrap()
        };
        let labelled = [CONTENT_SIGNATURE_LABEL, payload].concat();
        assert!(key(&alice).verify(&labelled, &signature).is_ok());
        assert!(key(&alice).verify(payload, &signature).is_err());
        assert!(key(&alice)
            .verify(&[CONTENT_SIGNATURE_LABEL, b"another"].concat(), &signature)
            .is_err());
        assert!(key(&bob).verify(&labelled, &signature).is_err());
    }
}
