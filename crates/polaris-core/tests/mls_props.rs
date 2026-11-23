//! The MLS domain's invariants under random operation sequences (plan 4.2):
//! whatever mix of messages, self-updates, removals and re-adds a group goes
//! through, every current member ends each step in the same epoch with the
//! same epoch authenticator and exporter secret, and every message opens at
//! every other current member with its exact bytes.

#![cfg(not(target_arch = "wasm32"))]

use polaris_core::mls::{Member, POLARIS_CIPHERSUITE};
use proptest::prelude::*;

const GROUP: &[u8] = b"prop-group";
const SIZE: usize = 4;

#[derive(Debug, Clone)]
enum Op {
    Message {
        from: usize,
        text: Vec<u8>,
    },
    Update {
        who: usize,
    },
    /// Remove the member in `target`, or add a new device there if it is empty.
    Churn {
        by: usize,
        target: usize,
    },
}

fn op() -> impl Strategy<Value = Op> {
    prop_oneof![
        4 => (0..SIZE, proptest::collection::vec(any::<u8>(), 0..64))
            .prop_map(|(from, text)| Op::Message { from, text }),
        2 => (0..SIZE).prop_map(|who| Op::Update { who }),
        2 => (0..SIZE, 0..SIZE).prop_map(|(by, target)| Op::Churn { by, target }),
    ]
}

fn fresh(name: usize, round: u32, seed_byte: u8) -> Member {
    let mut seed = [seed_byte; 32];
    seed[0] = name as u8;
    seed[1..5].copy_from_slice(&round.to_le_bytes());
    Member::new(format!("m{name}").as_bytes(), POLARIS_CIPHERSUITE, seed).unwrap()
}

/// Deliver a commit to every current member except its author.
fn deliver(members: &[Option<Member>], author: usize, commit: &[u8]) {
    for (i, m) in members.iter().enumerate() {
        if let (true, Some(m)) = (i != author, m) {
            m.process(GROUP, commit).unwrap();
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn members_always_agree(ops in proptest::collection::vec(op(), 1..24), seed_byte in any::<u8>()) {
        let mut members: Vec<Option<Member>> = (0..SIZE).map(|n| Some(fresh(n, 0, seed_byte))).collect();
        {
            let creator = members[0].as_ref().unwrap();
            creator.create_group(GROUP).unwrap();
            let packages: Vec<Vec<u8>> =
                members[1..].iter().flatten().map(|m| m.key_package().unwrap()).collect();
            let welcome = creator.add_members(GROUP, &packages).unwrap().welcome.unwrap();
            creator.merge_pending_commit(GROUP).unwrap();
            for m in members[1..].iter().flatten() {
                m.join_by_welcome(&welcome).unwrap();
            }
        }
        for (round, op) in (1u32..).zip(ops) {
            match op {
                Op::Message { from, text } => {
                    let Some(sender) = members[from].as_ref() else { continue };
                    let sealed = sender.encrypt(GROUP, &text).unwrap();
                    for (i, m) in members.iter().enumerate() {
                        if let (true, Some(m)) = (i != from, m) {
                            prop_assert_eq!(&m.process(GROUP, &sealed).unwrap().plaintext, &text);
                        }
                    }
                }
                Op::Update { who } => {
                    let Some(updater) = members[who].as_ref() else { continue };
                    let commit = updater.self_update(GROUP).unwrap().commit;
                    updater.merge_pending_commit(GROUP).unwrap();
                    deliver(&members, who, &commit);
                }
                Op::Churn { by, target } => {
                    if by == target || members[by].is_none() {
                        continue;
                    }
                    match members[target].take() {
                        Some(gone) => {
                            let remover = members[by].as_ref().unwrap();
                            let leaf = gone.own_leaf(GROUP).unwrap();
                            let commit = remover.remove_members(GROUP, &[leaf]).unwrap().commit;
                            remover.merge_pending_commit(GROUP).unwrap();
                            prop_assert!(!gone.process(GROUP, &commit).unwrap().active);
                            deliver(&members, by, &commit);
                        }
                        None => {
                            let remover = members[by].as_ref().unwrap();
                            let newcomer = fresh(target, round, seed_byte);
                            let out = remover.add_members(GROUP, &[newcomer.key_package().unwrap()]).unwrap();
                            remover.merge_pending_commit(GROUP).unwrap();
                            deliver(&members, by, &out.commit);
                            newcomer.join_by_welcome(&out.welcome.unwrap()).unwrap();
                            members[target] = Some(newcomer);
                        }
                    }
                }
            }
            let live: Vec<&Member> = members.iter().flatten().collect();
            for other in &live[1..] {
                prop_assert_eq!(live[0].epoch(GROUP).unwrap(), other.epoch(GROUP).unwrap());
                prop_assert_eq!(
                    live[0].epoch_authenticator(GROUP).unwrap(),
                    other.epoch_authenticator(GROUP).unwrap()
                );
                prop_assert_eq!(
                    live[0].export_secret(GROUP, "polaris/content", b"", 32).unwrap(),
                    other.export_secret(GROUP, "polaris/content", b"", 32).unwrap()
                );
            }
        }
    }
}
