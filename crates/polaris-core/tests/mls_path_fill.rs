//! Large groups, part two (ledger row 12 of docs/chat-e2ee-mls.md): filling
//! the tree. A group one device built by adding everyone has a blank parent
//! node everywhere but on that device's own path, and a blank node is
//! encrypted to through every leaf under it (RFC 9420, 4.2), so each commit
//! grows by one HPKE ciphertext per member. A joiner that commits a path of
//! its own soon after joining (`blank_path` says when) fills its ancestors,
//! and commits fall back to a handful of ciphertexts. Past the delivery
//! service's limit a commit is refused before it is staged (`CommitTooLarge`),
//! and an add that would only pass the limit through its optional path is
//! built without one (RFC 9420, 12.4: an Add does not require a path).

use polaris_core::mls::{ErrorKind, Member, MAX_COMMIT_BYTES, POLARIS_CIPHERSUITE};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

const GROUP: &[u8] = b"polaris/chat/path-fill";
const MEMBERS: usize = 64;
const BATCH: usize = 16;

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

/// `alice` adds `MEMBERS - 1` others in batches. With `fill`, every joiner
/// of a batch joins and commits its own path before the next batch, the way a
/// device does after its Welcome; the commits are applied by `alice` and by
/// the joiners still waiting their turn. Returns the last batch's joiners,
/// current with `alice` when `fill` is off.
fn grow(alice: &Member, tag: &str, fill: bool) -> Vec<Member> {
    alice.create_group(GROUP).unwrap();
    let mut last = Vec::new();
    let mut next = 1;
    while next < MEMBERS {
        let joiners: Vec<Member> = (next..(next + BATCH).min(MEMBERS))
            .map(|i| member(&format!("{tag}-{i}")))
            .collect();
        next += joiners.len();
        let packages: Vec<Vec<u8>> = joiners.iter().map(|m| m.key_package().unwrap()).collect();
        let out = alice.add_members(GROUP, &packages).unwrap();
        alice.merge_pending_commit(GROUP).unwrap();
        let welcome = out.welcome.expect("welcome");
        for joiner in &joiners {
            joiner
                .join_by_welcome_with_tree(&welcome, out.ratchet_tree.as_deref())
                .unwrap();
        }
        if fill {
            for (turn, joiner) in joiners.iter().enumerate() {
                let update = joiner.self_update(GROUP).unwrap();
                joiner.merge_pending_commit(GROUP).unwrap();
                alice.process(GROUP, &update.commit).unwrap();
                for waiting in &joiners[turn + 1..] {
                    waiting.process(GROUP, &update.commit).unwrap();
                }
            }
        }
        last = joiners;
    }
    assert_eq!(alice.members(GROUP).unwrap().len(), MEMBERS);
    last
}

fn assert_kind<T: std::fmt::Debug>(result: polaris_core::mls::Result<T>, kind: ErrorKind, what: &str) {
    match result {
        Err(error) => assert_eq!(error.kind, kind, "{what}: {error}"),
        Ok(value) => panic!("{what}: accepted, got {value:?}"),
    }
}

#[test]
fn the_route_limit_is_the_default() {
    assert_eq!(MAX_COMMIT_BYTES, 1024 * 1024);
    assert_eq!(member("limit").commit_limit(), MAX_COMMIT_BYTES);
}

#[test]
fn a_joiner_has_blanks_on_its_path_until_it_commits_one() {
    let alice = member("alice");
    let joiners = grow(&alice, "blank", false);
    // The adder's commits carry its path: nothing of its own is blank.
    assert_eq!(alice.blank_path(GROUP).unwrap(), 0);
    let joiner = &joiners[0];
    assert!(joiner.blank_path(GROUP).unwrap() > 0, "a joiner's ancestors are blank");

    let update = joiner.self_update(GROUP).unwrap();
    joiner.merge_pending_commit(GROUP).unwrap();
    alice.process(GROUP, &update.commit).unwrap();
    assert_eq!(joiner.blank_path(GROUP).unwrap(), 0, "its own commit filled them");
    // Nodes whose other side holds nobody are left out of a path (RFC 9420,
    // 4.1.2) and stay blank; they must not count, or a device would commit
    // again and again.
    assert_eq!(alice.blank_path(GROUP).unwrap(), 0);
}

#[test]
fn filled_paths_keep_commits_small() {
    let blank = member("alice-blank");
    grow(&blank, "sparse", false);
    let filled = member("alice-filled");
    grow(&filled, "dense", true);

    let removed = |alice: &Member| {
        let leaf = alice
            .members(GROUP)
            .unwrap()
            .into_iter()
            .find(|m| m.leaf != alice.own_leaf(GROUP).unwrap())
            .unwrap()
            .leaf;
        let out = alice.remove_members(GROUP, &[leaf]).unwrap();
        alice.clear_pending_commit(GROUP).unwrap();
        out.commit.len()
    };
    let sparse = removed(&blank);
    let dense = removed(&filled);
    assert!(dense * 3 < sparse, "one leaving: {dense} bytes filled, {sparse} sparse");

    let update = |alice: &Member| {
        let out = alice.self_update(GROUP).unwrap();
        alice.clear_pending_commit(GROUP).unwrap();
        out.commit.len()
    };
    let sparse = update(&blank);
    let dense = update(&filled);
    assert!(dense * 3 < sparse, "an update: {dense} bytes filled, {sparse} sparse");
}

#[test]
fn a_commit_past_the_limit_is_refused_unstaged() {
    let alice = member("alice-limit");
    grow(&alice, "limit", false);
    let epoch = alice.epoch(GROUP).unwrap();
    let leaf = alice
        .members(GROUP)
        .unwrap()
        .into_iter()
        .find(|m| m.leaf != alice.own_leaf(GROUP).unwrap())
        .unwrap()
        .leaf;

    alice.set_commit_limit(4 * 1024);
    assert_kind(alice.remove_members(GROUP, &[leaf]), ErrorKind::CommitTooLarge, "a removal");
    assert_kind(alice.self_update(GROUP), ErrorKind::CommitTooLarge, "an update");
    assert_eq!(alice.epoch(GROUP).unwrap(), epoch);

    // Nothing was left staged: with the limit back the same removal goes.
    alice.set_commit_limit(MAX_COMMIT_BYTES);
    let out = alice.remove_members(GROUP, &[leaf]).unwrap();
    assert!(out.commit.len() > 4 * 1024);
    alice.merge_pending_commit(GROUP).unwrap();
    assert_eq!(alice.epoch(GROUP).unwrap(), epoch + 1);
}

#[test]
fn an_add_drops_its_path_rather_than_pass_the_limit() {
    let alice = member("alice-add");
    let joiners = grow(&alice, "add", false);
    let with_path = {
        let out = alice.add_members(GROUP, &[member("probe").key_package().unwrap()]).unwrap();
        alice.clear_pending_commit(GROUP).unwrap();
        out.commit.len()
    };
    let limit = with_path / 4;
    alice.set_commit_limit(limit);

    let late = member("late");
    let out = alice.add_members(GROUP, &[late.key_package().unwrap()]).unwrap();
    assert!(out.commit.len() <= limit, "{} bytes past {limit}", out.commit.len());
    alice.merge_pending_commit(GROUP).unwrap();

    // The path-less commit is a valid commit: the newcomer joins and a member applies it.
    late.join_by_welcome_with_tree(out.welcome.as_deref().unwrap(), out.ratchet_tree.as_deref())
        .unwrap();
    joiners[0].process(GROUP, &out.commit).unwrap();
    assert_eq!(late.epoch(GROUP).unwrap(), alice.epoch(GROUP).unwrap());
    assert_eq!(joiners[0].epoch(GROUP).unwrap(), alice.epoch(GROUP).unwrap());
    let sealed = alice.encrypt(GROUP, b"after a path-less add").unwrap();
    assert_eq!(late.process(GROUP, &sealed).unwrap().plaintext, b"after a path-less add");

    // A key package alone past the limit is refused, not sent.
    alice.set_commit_limit(64);
    assert_kind(
        alice.add_members(GROUP, &[member("too-late").key_package().unwrap()]),
        ErrorKind::CommitTooLarge,
        "an add past the limit",
    );
}
