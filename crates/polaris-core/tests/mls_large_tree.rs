//! Large groups (ledger row 12 of docs/chat-e2ee-mls.md): past
//! `INLINE_TREE_BYTES` a Welcome and a GroupInfo leave the ratchet tree out
//! (RFC 9420, 12.4.3.3), the commit hands the tree back on its own for the
//! delivery service to keep, and a joiner brings it to the join - where
//! OpenMLS checks it against the tree hash the signed GroupInfo commits to.

use polaris_core::mls::{ErrorKind, Member, INLINE_TREE_BYTES, POLARIS_CIPHERSUITE};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const GROUP: &[u8] = b"polaris/chat/large";
/// Enough hybrid-suite leaves (each well over 1 KB) for the tree to pass the inline limit.
const MEMBERS: usize = 64;

fn seed(tag: &str) -> [u8; 32] {
    let mut seed = [0u8; 32];
    for (i, byte) in tag.bytes().enumerate() {
        seed[i % 32] ^= byte.rotate_left(i as u32 % 8);
    }
    seed[31] ^= tag.len() as u8;
    seed
}

fn member(name: &str) -> Member {
    Member::new(name.as_bytes(), POLARIS_CIPHERSUITE, seed(name)).expect("member")
}

/// A group of `MEMBERS` built by `alice` in batches of 16, and the tree the
/// last batch handed back (`None` while the tree was still inline).
fn large_group(alice: &Member) -> Option<Vec<u8>> {
    alice.create_group(GROUP).unwrap();
    let mut tree = None;
    let others: Vec<Vec<u8>> = (1..MEMBERS)
        .map(|i| member(&format!("member-{i}")).key_package().unwrap())
        .collect();
    for batch in others.chunks(16) {
        let out = alice.add_members(GROUP, batch).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        tree = out.ratchet_tree;
    }
    assert_eq!(alice.members(GROUP).unwrap().len(), MEMBERS);
    tree
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

#[test]
fn a_small_group_keeps_the_tree_inline() {
    let alice = member("alice");
    let bob = member("bob");
    alice.create_group(GROUP).unwrap();
    let out = alice
        .add_members(GROUP, &[bob.key_package().unwrap()])
        .unwrap();
    assert!(
        out.ratchet_tree.is_none(),
        "a two-member tree is far under the limit"
    );
    assert!(out.group_info.is_some());
    alice.merge_pending_commit(GROUP).unwrap();
    // A device that predates the split joins exactly as before.
    assert_eq!(bob.join_by_welcome(&out.welcome.unwrap()).unwrap(), GROUP);
    let (info, tree) = alice.group_info_parts(GROUP).unwrap();
    assert!(tree.is_none());
    assert_eq!(info, alice.group_info(GROUP).unwrap());
}

#[test]
fn past_the_limit_the_welcome_leaves_the_tree_out_and_the_joiner_brings_it() {
    let alice = member("alice");
    large_group(&alice);
    let (carol, dave) = (member("carol"), member("dave"));
    let before = alice
        .group_info_parts(GROUP)
        .unwrap()
        .1
        .expect("the tree is past the limit");
    assert!(before.len() > INLINE_TREE_BYTES);

    let out = alice
        .add_members(
            GROUP,
            &[carol.key_package().unwrap(), dave.key_package().unwrap()],
        )
        .unwrap();
    let tree = out
        .ratchet_tree
        .clone()
        .expect("the commit hands the new tree back");
    let welcome = out.welcome.clone().unwrap();
    assert!(
        welcome.len() < tree.len() / 4,
        "the Welcome ({} bytes) no longer repeats the tree ({} bytes)",
        welcome.len(),
        tree.len()
    );
    assert!(out.group_info.as_ref().unwrap().len() < tree.len() / 4);
    alice.merge_pending_commit(GROUP).unwrap();

    // Without the tree the join says what it is missing.
    assert_kind(
        carol.join_by_welcome(&welcome),
        ErrorKind::MissingTree,
        "no tree",
    );
    // The tree of another epoch does not hash to what the Welcome commits to.
    assert_kind(
        carol.join_by_welcome_with_tree(&welcome, Some(&before)),
        ErrorKind::Rejected,
        "the previous epoch's tree",
    );
    assert_kind(
        carol.join_by_welcome_with_tree(&welcome, Some(&tree[..tree.len() - 1])),
        ErrorKind::Malformed,
        "a cut tree",
    );
    // The right tree, from an untrusted store, joins - and the joiner agrees with the group.
    assert_eq!(
        dave.join_by_welcome_with_tree(&welcome, Some(&tree))
            .unwrap(),
        GROUP
    );
    assert_eq!(dave.epoch(GROUP).unwrap(), alice.epoch(GROUP).unwrap());
    assert_eq!(
        dave.epoch_authenticator(GROUP).unwrap(),
        alice.epoch_authenticator(GROUP).unwrap()
    );
    assert_eq!(dave.members(GROUP).unwrap().len(), MEMBERS + 2);

    let sealed = alice.encrypt(GROUP, b"to a large room").unwrap();
    assert_eq!(
        dave.process(GROUP, &sealed).unwrap().plaintext,
        b"to a large room"
    );
}

#[test]
fn removals_and_updates_in_a_large_group_hand_the_tree_back() {
    let alice = member("alice");
    large_group(&alice);
    let leaf = alice
        .members(GROUP)
        .unwrap()
        .into_iter()
        .map(|m| m.leaf)
        .find(|&leaf| leaf != alice.own_leaf(GROUP).unwrap())
        .unwrap();
    let removed = alice.remove_members(GROUP, &[leaf]).unwrap();
    assert!(removed.ratchet_tree.is_some());
    assert!(removed.welcome.is_none());
    alice.merge_pending_commit(GROUP).unwrap();
    let updated = alice.self_update(GROUP).unwrap();
    assert!(updated.ratchet_tree.is_some());
    alice.merge_pending_commit(GROUP).unwrap();
    assert_eq!(alice.members(GROUP).unwrap().len(), MEMBERS - 1);
}

#[test]
fn an_external_join_takes_the_tree_beside_a_bare_group_info() {
    let alice = member("alice");
    large_group(&alice);
    let (info, tree) = alice.group_info_parts(GROUP).unwrap();
    let tree = tree.expect("past the limit the GroupInfo leaves the tree out");
    assert!(info.len() < tree.len() / 4);

    let erin = member("erin");
    assert_kind(
        erin.join_by_external_commit(&info),
        ErrorKind::Rejected,
        "no tree",
    );
    let (group, commit) = erin
        .join_by_external_commit_with_tree(&info, Some(&tree))
        .unwrap();
    assert_eq!(group, GROUP);
    alice.process(GROUP, &commit).unwrap();
    assert_eq!(
        erin.epoch_authenticator(GROUP).unwrap(),
        alice.epoch_authenticator(GROUP).unwrap()
    );
}
