//! The MLS domain's cost per operation (plan 4.7) at the group sizes phase 0
//! measured (docs/chat-e2ee-phase0.md), on Polaris' post-quantum suite:
//! sealing and opening one 200-byte message, and creating and processing an
//! add commit. Scale runs (1,000 and 5,000 members) are unit E4.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use polaris_core::mls::{Member, POLARIS_CIPHERSUITE};
use std::hint::black_box;

const GROUP: &[u8] = b"bench-group";

fn seed(n: u32) -> [u8; 32] {
    let mut seed = [7u8; 32];
    seed[..4].copy_from_slice(&n.to_le_bytes());
    seed
}

fn member(n: u32) -> Member {
    Member::new(
        format!("member-{n}").as_bytes(),
        POLARIS_CIPHERSUITE,
        seed(n),
    )
    .expect("member")
}

/// A group of `size` members: the creator and one receiver that joined by
/// Welcome, the rest added in the same commit.
fn group(size: u32) -> (Member, Member) {
    let creator = member(0);
    creator.create_group(GROUP).expect("create");
    let receiver = member(1);
    let mut packages = vec![receiver.key_package().expect("kp")];
    packages.extend((2..size).map(|n| member(n).key_package().expect("kp")));
    let out = creator.add_members(GROUP, &packages).expect("add");
    creator.merge_pending_commit(GROUP).expect("merge");
    receiver
        .join_by_welcome(&out.welcome.expect("welcome"))
        .expect("join");
    (creator, receiver)
}

fn mls(c: &mut Criterion) {
    let mut bench = c.benchmark_group("mls");
    bench.sample_size(10);
    for size in [2u32, 50] {
        let (creator, receiver) = group(size);
        let text = vec![0x61u8; 200];
        bench.bench_with_input(
            BenchmarkId::new("encrypt+decrypt 200 B", size),
            &size,
            |b, _| {
                b.iter(|| {
                    let sealed = creator.encrypt(GROUP, black_box(&text)).expect("encrypt");
                    black_box(receiver.process(GROUP, &sealed).expect("decrypt"));
                })
            },
        );
        let mut n = 10_000u32;
        bench.bench_with_input(
            BenchmarkId::new("add commit + process", size),
            &size,
            |b, _| {
                b.iter(|| {
                    n += 1;
                    let package = member(n).key_package().expect("kp");
                    let out = creator.add_members(GROUP, &[package]).expect("add");
                    creator.merge_pending_commit(GROUP).expect("merge");
                    black_box(receiver.process(GROUP, &out.commit).expect("process"));
                })
            },
        );
    }
    bench.finish();
}

criterion_group!(benches, mls);
criterion_main!(benches);
