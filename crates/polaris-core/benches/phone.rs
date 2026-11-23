//! The phone domain's speed over its golden vectors (plan 4.7): one iteration
//! replays every case of a vector file, so the numbers line up with the Node
//! benchmark of the TypeScript twin (`npm run bench -w @polaris/core-rs`),
//! which times the same files.

use criterion::{criterion_group, criterion_main, Criterion};
use polaris_core::phone;
use polaris_core_vectors::{load, Decoded};
use std::hint::black_box;

/// Every case's arguments as optional strings (`null`/absent is `None`).
fn inputs(op: &str) -> Vec<Vec<Option<String>>> {
    let file = load("phone", op).unwrap_or_else(|e| panic!("load phone/{op} vectors: {e}"));
    file.cases
        .iter()
        .map(|case| {
            case.args
                .iter()
                .map(|arg| match arg {
                    Decoded::Null => None,
                    other => other.as_binding_str(),
                })
                .collect()
        })
        .collect()
}

fn arg(args: &[Option<String>], i: usize) -> Option<&str> {
    args.get(i).and_then(|a| a.as_deref())
}

fn bench(c: &mut Criterion) {
    let cases = inputs("toE164");
    c.bench_function("phone/toE164 (all vectors)", |b| {
        b.iter(|| {
            for a in &cases {
                let _ = black_box(phone::to_e164(arg(a, 0).unwrap_or(""), arg(a, 1)));
            }
        })
    });
    let cases = inputs("formatPhoneAsTyped");
    c.bench_function("phone/formatPhoneAsTyped (all vectors)", |b| {
        b.iter(|| {
            for a in &cases {
                let _ = black_box(phone::format_phone_as_typed(arg(a, 0).unwrap_or(""), arg(a, 1)));
            }
        })
    });
    let cases = inputs("formatPhoneInternational");
    c.bench_function("phone/formatPhoneInternational (all vectors)", |b| {
        b.iter(|| {
            for a in &cases {
                let _ = black_box(phone::format_phone_international(arg(a, 0).unwrap_or("")));
            }
        })
    });
    let cases = inputs("splitPhone");
    c.bench_function("phone/splitPhone (all vectors)", |b| {
        b.iter(|| {
            for a in &cases {
                let _ = black_box(phone::split_phone(arg(a, 0).unwrap_or("")));
            }
        })
    });
}

criterion_group!(benches, bench);
criterion_main!(benches);
