//! The probe domain's speed over its golden vectors (plan 4.7): one iteration
//! replays every case of a vector file, the refused ones included, so the
//! numbers line up with the Node benchmark of the TypeScript twin
//! (`npm run bench -w @polaris/core-rs`), which times the same files.

use criterion::{criterion_group, criterion_main, Criterion};
use polaris_core::probe::{decode_hex, fnv1a32};
use polaris_core_vectors::load;
use std::hint::black_box;

/// Every case's single string argument, as a binding would receive it.
fn inputs(op: &str) -> Vec<String> {
    let file = load("probe", op).unwrap_or_else(|e| panic!("load probe/{op} vectors: {e}"));
    file.cases
        .iter()
        .map(|case| match case.args.as_slice() {
            [arg] => arg
                .as_binding_str()
                .unwrap_or_else(|| panic!("{}: argument is not a string", case.name)),
            _ => panic!("{}: expected exactly one argument", case.name),
        })
        .collect::<Vec<_>>()
}

fn probe(c: &mut Criterion) {
    let texts = inputs("fnv1a32");
    c.bench_function("probe/fnv1a32 (all vectors)", |b| {
        b.iter(|| {
            for text in &texts {
                black_box(fnv1a32(black_box(text)));
            }
        })
    });
    let hexes = inputs("decodeHex");
    c.bench_function("probe/decodeHex (all vectors)", |b| {
        b.iter(|| {
            for hex in &hexes {
                let _ = black_box(decode_hex(black_box(hex)));
            }
        })
    });
}

criterion_group!(benches, probe);
criterion_main!(benches);
