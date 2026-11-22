//! The probe domain against the golden vectors generated from its TypeScript
//! twin (plan 4.1), and its invariants under random input (plan 4.2).

use polaris_core::probe::{decode_hex, fnv1a32, HexError};
use polaris_core_vectors::{load, Decoded, Expect};
use proptest::prelude::*;

fn only_string_arg(args: &[Decoded], case: &str) -> String {
    match args {
        [arg] => arg
            .as_binding_str()
            .unwrap_or_else(|| panic!("{case}: argument is not a string")),
        _ => panic!("{case}: expected exactly one argument"),
    }
}

#[test]
fn fnv1a32_matches_every_vector() {
    let file = load("probe", "fnv1a32").expect("load fnv1a32 vectors");
    assert!(file.cases.len() >= 10);
    for case in &file.cases {
        let text = only_string_arg(&case.args, &case.name);
        let expected = match &case.expect {
            Expect::Ok(Decoded::Number(n)) => n.as_u64().expect("a u32"),
            other => panic!("{}: unexpected expectation {other:?}", case.name),
        };
        assert_eq!(u64::from(fnv1a32(&text)), expected, "case {:?}", case.name);
    }
}

#[test]
fn decode_hex_matches_every_vector() {
    let file = load("probe", "decodeHex").expect("load decodeHex vectors");
    let (mut ok, mut failed) = (0, 0);
    for case in &file.cases {
        let hex = only_string_arg(&case.args, &case.name);
        match (&case.expect, decode_hex(&hex)) {
            (Expect::Ok(Decoded::Bytes(want)), Ok(got)) => {
                assert_eq!(&got, want, "case {:?}", case.name);
                ok += 1;
            }
            (Expect::Error { kind, message }, Err(got)) => {
                assert_eq!(kind, "RangeError", "case {:?}", case.name);
                assert_eq!(&got.to_string(), message, "case {:?}", case.name);
                failed += 1;
            }
            (want, got) => panic!("case {:?}: expected {want:?}, got {got:?}", case.name),
        }
    }
    assert!(ok > 0 && failed > 0, "the vectors must cover both outcomes");
}

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn hex_round_trips_in_either_case(bytes in proptest::collection::vec(any::<u8>(), 0..256)) {
        let hex = lower_hex(&bytes);
        prop_assert_eq!(decode_hex(&hex).unwrap(), bytes.clone());
        prop_assert_eq!(decode_hex(&hex.to_uppercase()).unwrap(), bytes);
    }

    #[test]
    fn a_refused_string_points_inside_it(text in "\\PC{0,64}") {
        let len = text.encode_utf16().count();
        match decode_hex(&text) {
            Ok(bytes) => prop_assert_eq!(bytes.len() * 2, len),
            Err(HexError::OddLength) => prop_assert_eq!(len % 2, 1),
            Err(HexError::InvalidChar { index }) => {
                prop_assert!(index < len);
                prop_assert_eq!(len % 2, 0);
                let unit = text.encode_utf16().nth(index).unwrap();
                prop_assert!(!(unit < 128 && (unit as u8).is_ascii_hexdigit()));
            }
        }
    }

    #[test]
    fn fnv_is_a_fold_over_utf8(a in "\\PC{0,32}", b in "\\PC{0,32}") {
        // FNV-1a is a left fold, so hashing a+b equals continuing from a's state.
        let continued = b.bytes().fold(fnv1a32(&a), |h, byte| (h ^ u32::from(byte)).wrapping_mul(0x0100_0193));
        prop_assert_eq!(fnv1a32(&format!("{a}{b}")), continued);
    }
}
