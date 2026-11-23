//! The phone domain against the golden vectors generated from its TypeScript
//! twin (plan 4.1). One test replays every file in order from the state the
//! generator starts each file in (see `PHONE_RESET_INPUT` in the corpus), so
//! libphonenumber-js's `phone-context` memory is reproduced too.

use polaris_core::phone::{self, PhoneError, Text};
use polaris_core_vectors::{load, Decoded, Expect};

const RESET: &str = "tel:1;phone-context=!";

fn units(arg: &Decoded) -> Vec<u16> {
    match arg {
        Decoded::Text(s) => s.encode_utf16().collect(),
        Decoded::Utf16(u) => u.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

fn text_arg(args: &[Decoded], i: usize) -> Option<String> {
    match args.get(i) {
        None | Some(Decoded::Null) => None,
        Some(other) => Some(other.as_binding_str().expect("a string argument")),
    }
}

fn s(value: &str) -> Decoded {
    Decoded::Text(value.to_string())
}

fn opt(value: Option<&str>) -> Decoded {
    value.map_or(Decoded::Null, s)
}

/// A JavaScript string slice as the vector format writes it.
fn slice(original: &[u16], start: usize, end: usize) -> Decoded {
    let part = &original[start..end];
    match String::from_utf16(part) {
        Ok(text) => Decoded::Text(text),
        Err(_) => Decoded::Utf16(part.to_vec()),
    }
}

fn text(t: Text, original: &[u16]) -> Decoded {
    match t {
        Text::Owned(v) => Decoded::Text(v),
        Text::Slice { start, end } => slice(original, start, end),
    }
}

fn run(op: &str, args: &[Decoded]) -> Result<Decoded, PhoneError> {
    let a0 = || text_arg(args, 0).unwrap_or_default();
    Ok(match op {
        "phoneCountries" => Decoded::Array(phone::phone_countries().into_iter().map(s).collect()),
        "isPhoneCountry" => Decoded::Bool(phone::is_phone_country(text_arg(args, 0).as_deref())),
        "phoneCallingCode" => opt(phone::phone_calling_code(&a0())?),
        "phoneMainCountry" => opt(phone::phone_main_country(&a0())),
        "toE164" => opt(phone::to_e164(&a0(), text_arg(args, 1).as_deref())?.as_deref()),
        "phoneCountryOf" => opt(phone::phone_country_of(&a0())?),
        "splitPhone" => {
            let (country, national) = phone::split_phone(&a0())?;
            let national = text(national, &units(&args[0]));
            let mut fields = Vec::new();
            if let Some(c) = country {
                fields.push(("country".to_string(), s(c)));
            }
            fields.push(("national".to_string(), national));
            Decoded::Object(fields)
        }
        "formatPhoneAsTyped" => s(&phone::format_phone_as_typed(&a0(), text_arg(args, 1).as_deref())?),
        "formatPhoneInternational" => text(phone::format_phone_international(&a0())?, &units(&args[0])),
        other => panic!("no Rust replay for phone/{other}"),
    })
}

#[test]
fn every_phone_vector_matches() {
    // `phoneCountryFromLocales` starts with `Intl.Locale`, which the caller
    // evaluates; its vectors are replayed through the facade on every binding.
    let ops = [
        "phoneCountries",
        "isPhoneCountry",
        "phoneCallingCode",
        "phoneMainCountry",
        "toE164",
        "phoneCountryOf",
        "splitPhone",
        "formatPhoneAsTyped",
        "formatPhoneInternational",
    ];
    let mut failures = Vec::new();
    let mut total = 0;
    for op in ops {
        let file = load("phone", op).unwrap_or_else(|e| panic!("load phone/{op}: {e}"));
        let _ = phone::to_e164(RESET, None);
        for case in &file.cases {
            total += 1;
            let got = run(op, &case.args);
            let same = match (&case.expect, &got) {
                (Expect::Ok(want), Ok(have)) => want == have,
                (Expect::Error { kind, message }, Err(e)) => kind == e.class && message == &e.message,
                _ => false,
            };
            if !same {
                failures.push(format!("{op} / {}: expected {:?}, got {:?}", case.name, case.expect, got));
            }
        }
    }
    assert!(total > 10_000, "the corpus shrank to {total} cases");
    assert!(
        failures.is_empty(),
        "{} of {total} cases differ:\n{}",
        failures.len(),
        failures.iter().take(40).cloned().collect::<Vec<_>>().join("\n")
    );
}
