//! The phone domain on any input (plan 4.3): no function panics, an error is
//! one of the two classes the TypeScript implementation throws, every slice
//! handed back lies inside the input on UTF-16 boundaries, and a number
//! accepted as E.164 reads back as itself.
//!
//! The first byte picks the country argument (none, a real one, or a name the
//! twin treats specially); the rest is the typed value.

#![no_main]

use libfuzzer_sys::fuzz_target;
use polaris_core::phone::{
    format_phone_as_typed, format_phone_international, phone_country_of, split_phone, to_e164,
    PhoneError, Text,
};

const ODD_COUNTRIES: [&str; 5] = ["", "XX", "es", "001", "toString"];

fn check_error(error: &PhoneError) {
    assert!(matches!(error.class, "Error" | "TypeError"), "{error:?}");
}

fn check_slice(text: &Text, value: &str) {
    if let Text::Slice { start, end } = *text {
        let units: Vec<u16> = value.encode_utf16().collect();
        assert!(
            start <= end && end <= units.len(),
            "{start}..{end} of {}",
            units.len()
        );
        assert!(
            String::from_utf16(&units[start..end]).is_ok(),
            "slice splits a character"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let Some((&pick, rest)) = data.split_first() else {
        return;
    };
    let Ok(value) = std::str::from_utf8(rest) else {
        return;
    };
    let countries = polaris_core::phone::phone_countries();
    let country = match pick % 3 {
        0 => None,
        1 => Some(countries[usize::from(pick) % countries.len()]),
        _ => Some(ODD_COUNTRIES[usize::from(pick) % ODD_COUNTRIES.len()]),
    };

    match to_e164(value, country) {
        Ok(Some(e164)) => {
            assert!(
                e164.starts_with('+') && e164[1..].bytes().all(|b| b.is_ascii_digit()),
                "{e164}"
            );
            assert_eq!(
                to_e164(&e164, None).map_err(|e| e.message),
                Ok(Some(e164.clone()))
            );
        }
        Ok(None) => {}
        Err(error) => check_error(&error),
    }
    if let Err(error) = phone_country_of(value) {
        check_error(&error);
    }
    match split_phone(value) {
        Ok((_, national)) => check_slice(&national, value),
        Err(error) => check_error(&error),
    }
    if let Err(error) = format_phone_as_typed(value, country) {
        check_error(&error);
    }
    match format_phone_international(value) {
        Ok(text) => check_slice(&text, value),
        Err(error) => check_error(&error),
    }
});
