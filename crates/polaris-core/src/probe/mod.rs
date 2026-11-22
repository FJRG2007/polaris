//! The probe domain: two small, fully specified functions that exist to prove
//! the whole chain - golden vectors from the TypeScript twin
//! (`dashboard/packages/core-rs/src/domains/probe/ts.ts`), this crate, the
//! Node and WebAssembly bindings, and the facade's modes and fallback - before
//! any real domain is moved. Its outputs must match the twin exactly,
//! including error messages and the UTF-16 positions they report.

use std::fmt;

const FNV_OFFSET: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

/// 32-bit FNV-1a over the UTF-8 encoding of `text`.
///
/// A JavaScript string can hold an unpaired surrogate; both bindings hand it
/// over as U+FFFD, which is exactly what `TextEncoder` does on the TypeScript
/// side, so the hash agrees for every JavaScript string.
pub fn fnv1a32(text: &str) -> u32 {
    text.bytes().fold(FNV_OFFSET, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

/// Why a hex string was refused. The messages are the TypeScript twin's,
/// word for word, and the index counts UTF-16 code units like a JavaScript
/// string index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HexError {
    OddLength,
    InvalidChar { index: usize },
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HexError::OddLength => f.write_str("Invalid hex string: odd length"),
            HexError::InvalidChar { index } => write!(f, "Invalid hex string at index {index}"),
        }
    }
}

impl std::error::Error for HexError {}

fn hex_value(unit: u16) -> Option<u8> {
    match unit {
        0x30..=0x39 => Some((unit - 0x30) as u8),
        0x41..=0x46 => Some((unit - 0x41 + 10) as u8),
        0x61..=0x66 => Some((unit - 0x61 + 10) as u8),
        _ => None,
    }
}

/// Decode a hex string (either case, no prefix, no separators) into bytes.
pub fn decode_hex(hex: &str) -> Result<Vec<u8>, HexError> {
    let units: Vec<u16> = hex.encode_utf16().collect();
    if units.len() % 2 != 0 {
        return Err(HexError::OddLength);
    }
    let mut out = Vec::with_capacity(units.len() / 2);
    for (pair_index, pair) in units.chunks_exact(2).enumerate() {
        let index = pair_index * 2;
        let high = hex_value(pair[0]).ok_or(HexError::InvalidChar { index })?;
        let low = hex_value(pair[1]).ok_or(HexError::InvalidChar { index: index + 1 })?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv_known_values() {
        assert_eq!(fnv1a32(""), 0x811c_9dc5);
        assert_eq!(fnv1a32("a"), 0xe40c_292c);
        assert_eq!(fnv1a32("foobar"), 0xbf9c_f968);
    }

    #[test]
    fn fnv_hashes_utf8_bytes() {
        // "é" is two UTF-8 bytes; hashing them one by one must agree.
        let manual = [0xc3u8, 0xa9].iter().fold(FNV_OFFSET, |h, b| {
            (h ^ u32::from(*b)).wrapping_mul(FNV_PRIME)
        });
        assert_eq!(fnv1a32("é"), manual);
    }

    #[test]
    fn decode_both_cases() {
        assert_eq!(
            decode_hex("00ffAb10").unwrap(),
            vec![0x00, 0xff, 0xab, 0x10]
        );
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn odd_length_is_checked_before_characters() {
        assert_eq!(decode_hex("zzz"), Err(HexError::OddLength));
    }

    #[test]
    fn invalid_index_counts_utf16_units() {
        // "😀" is two UTF-16 units and four UTF-8 bytes: the index must be 2,
        // as a JavaScript string reports it, and so is the low half's.
        assert_eq!(decode_hex("00😀"), Err(HexError::InvalidChar { index: 2 }));
        assert_eq!(decode_hex("0g"), Err(HexError::InvalidChar { index: 1 }));
        assert_eq!(decode_hex("é0"), Err(HexError::InvalidChar { index: 0 }));
    }

    #[test]
    fn messages_match_the_typescript_twin() {
        assert_eq!(
            HexError::OddLength.to_string(),
            "Invalid hex string: odd length"
        );
        assert_eq!(
            HexError::InvalidChar { index: 7 }.to_string(),
            "Invalid hex string at index 7"
        );
    }
}
