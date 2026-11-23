//! `probe::decode_hex` on any string: it never panics, a decoded string
//! re-encodes to itself, and a refusal is the right one, at an index inside the
//! string that really holds a non-hex UTF-16 unit, with the twin's message.

#![no_main]

use libfuzzer_sys::fuzz_target;
use polaris_core::probe::{decode_hex, HexError};

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else {
        return;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    match decode_hex(text) {
        Ok(bytes) => {
            assert_eq!(bytes.len() * 2, units.len());
            assert_eq!(lower_hex(&bytes), text.to_ascii_lowercase());
        }
        Err(error @ HexError::OddLength) => {
            assert_eq!(units.len() % 2, 1);
            assert_eq!(error.to_string(), "Invalid hex string: odd length");
        }
        Err(error @ HexError::InvalidChar { index }) => {
            assert_eq!(units.len() % 2, 0);
            assert!(index < units.len());
            let unit = units[index];
            assert!(!(unit < 128 && (unit as u8).is_ascii_hexdigit()));
            // Every pair before the refused one is valid hex.
            assert!(units[..index - index % 2]
                .iter()
                .all(|&u| u < 128 && (u as u8).is_ascii_hexdigit()));
            assert_eq!(
                error.to_string(),
                format!("Invalid hex string at index {index}")
            );
        }
    }
});
