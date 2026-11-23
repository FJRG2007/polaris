//! `probe::fnv1a32` on any string: it never panics, and since FNV-1a is a left
//! fold over the UTF-8 bytes, hashing `a + b` equals continuing from `a`'s hash
//! over `b`, at every split point the fuzzer picks.

#![no_main]

use libfuzzer_sys::fuzz_target;
use polaris_core::probe::fnv1a32;

const FNV_PRIME: u32 = 0x0100_0193;

fuzz_target!(|data: &[u8]| {
    let Some((&split, rest)) = data.split_first() else {
        return;
    };
    let Ok(text) = std::str::from_utf8(rest) else {
        return;
    };
    let mut at = usize::from(split) % (text.len() + 1);
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    let (a, b) = text.split_at(at);
    let continued = b.bytes().fold(fnv1a32(a), |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(FNV_PRIME)
    });
    assert_eq!(fnv1a32(text), continued);
});
