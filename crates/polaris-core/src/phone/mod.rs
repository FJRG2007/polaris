//! The phone domain: `dashboard/packages/core-rs/src/domains/phone/ts.ts`
//! (what `packages/core/src/phone.ts` ran before it became a facade) over
//! libphonenumber-js 1.13.15 with its `/min` metadata, reproduced function for
//! function so every answer is the TypeScript one, errors included.
//! `metadata.min.json` is that package's file, byte for byte; a test in
//! `core-rs` fails when the installed package's copy differs.
//!
//! Strings arrive as JavaScript strings converted to UTF-8 (an unpaired
//! surrogate becomes U+FFFD, one UTF-16 unit like the surrogate it replaces).
//! Where the TypeScript code hands back part of its own input, the answer is a
//! [`Text::Slice`] in UTF-16 units, so the binding returns the caller's own
//! string rather than a re-encoded copy.

mod as_you_type;
mod js;
mod metadata;
mod parse;

use std::fmt;

/// An error the TypeScript implementation throws: its class and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneError {
    pub class: &'static str,
    pub message: String,
}

impl PhoneError {
    fn error(message: String) -> Self {
        PhoneError {
            class: "Error",
            message,
        }
    }

    fn type_error(message: String) -> Self {
        PhoneError {
            class: "TypeError",
            message,
        }
    }
}

impl fmt::Display for PhoneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PhoneError {}

/// Text that is either new or a range of the caller's input, in UTF-16 units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Text {
    Owned(String),
    Slice { start: usize, end: usize },
}

impl Text {
    /// The new text, when it is not a slice of the input.
    pub fn owned(&self) -> Option<&str> {
        match self {
            Text::Owned(s) => Some(s),
            Text::Slice { .. } => None,
        }
    }

    /// The slice of the input in UTF-16 units; `(0, 0)` for new text.
    pub fn range(&self) -> (usize, usize) {
        match self {
            Text::Owned(_) => (0, 0),
            Text::Slice { start, end } => (*start, *end),
        }
    }
}

fn own_country(code: &str) -> Option<&'static str> {
    metadata::country_keys().find(|k| *k == code)
}

/// `phoneCountries()`: every country a number can belong to, in the metadata's order.
pub fn phone_countries() -> Vec<&'static str> {
    metadata::country_keys().filter(|k| *k != "001").collect()
}

/// `isPhoneCountry(code)`.
pub fn is_phone_country(code: Option<&str>) -> bool {
    code.is_some_and(|c| c != "001" && metadata::country(c).is_some())
}

/// `phoneCallingCode(country)`. `Ok(None)` is `undefined`, which a name
/// `Object.prototype` carries (`toString`, ...) produces.
pub fn phone_calling_code(country: &str) -> Result<Option<&'static str>, PhoneError> {
    if let Some(plan) = metadata::country(country) {
        return Ok(Some(plan.plan().calling_code));
    }
    if metadata::is_prototype_key(country) {
        return Ok(None);
    }
    Err(PhoneError::error(format!("Unknown country: {country}")))
}

/// `phoneMainCountry(callingCode)`.
pub fn phone_main_country(calling_code: &str) -> Option<&'static str> {
    let first = metadata::calling_code_entry(calling_code)?.first()?;
    is_phone_country(Some(first)).then_some(*first)
}

/// `toE164(value, country)`.
pub fn to_e164(value: &str, country: Option<&str>) -> Result<Option<String>, PhoneError> {
    let (typed, _, _) = js::js_trim(value);
    if typed.is_empty() {
        return Ok(None);
    }
    let country = if typed.starts_with('+') {
        None
    } else {
        country
    };
    let Some(parsed) = parse::parse(typed, country)? else {
        return Ok(None);
    };
    Ok(if parsed.is_valid()? {
        Some(parsed.e164())
    } else {
        None
    })
}

/// `phoneCountryOf(value)`.
pub fn phone_country_of(value: &str) -> Result<Option<&'static str>, PhoneError> {
    let (typed, _, _) = js::js_trim(value);
    Ok(parse::parse(typed, None)?.and_then(|p| p.country))
}

/// `splitPhone(value)`.
pub fn split_phone(value: &str) -> Result<(Option<&'static str>, Text), PhoneError> {
    let (typed, start, end) = js::js_trim(value);
    let whole = Text::Slice { start, end };
    if !typed.starts_with('+') {
        return Ok((None, whole));
    }
    let Some(parsed) = parse::parse(typed, None)? else {
        return Ok((None, whole));
    };
    let Some(country) = parsed.country else {
        return Ok((None, whole));
    };
    Ok((Some(country), Text::Owned(parsed.format(false)?)))
}

/// `formatPhoneAsTyped(value, country)`.
pub fn format_phone_as_typed(value: &str, country: Option<&str>) -> Result<String, PhoneError> {
    let country = match country.filter(|c| !c.is_empty()) {
        None => None,
        Some(c) if metadata::is_prototype_key(c) => {
            // `new AsYouType(name)` accepts a name `Object.prototype` carries
            // and fails reading the formats of the "plan" it finds there.
            return Err(PhoneError::type_error(
                "Cannot read properties of undefined (reading '4')".into(),
            ));
        }
        Some(c) => own_country(c),
    };
    as_you_type::format_as_typed(value, country)
}

/// `formatPhoneInternational(value)`: a slice covering all of `value` when it
/// does not parse (the input is returned as it was).
pub fn format_phone_international(value: &str) -> Result<Text, PhoneError> {
    let (typed, _, _) = js::js_trim(value);
    match parse::parse(typed, None)? {
        Some(parsed) => Ok(Text::Owned(parsed.format(true)?)),
        None => Ok(Text::Slice {
            start: 0,
            end: js::utf16_len(value),
        }),
    }
}

/// The loop of `phoneCountryFromLocales` after `new Intl.Locale(tag).region`,
/// which the caller evaluates (it is the platform's locale data, not this
/// domain's): the first region that is a phone country.
pub fn phone_country_from_regions<'a>(
    regions: impl IntoIterator<Item = Option<&'a str>>,
) -> Option<&'static str> {
    regions
        .into_iter()
        .flatten()
        .find_map(|r| own_country(r).filter(|k| *k != "001"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spain() {
        assert_eq!(
            to_e164(" 600 11 12 22 ", Some("ES")).unwrap().as_deref(),
            Some("+34600111222")
        );
        assert_eq!(
            to_e164("+34600111222", None).unwrap().as_deref(),
            Some("+34600111222")
        );
        assert_eq!(to_e164("600111222", None).unwrap(), None);
        assert_eq!(phone_country_of("+34600111222").unwrap(), Some("ES"));
        assert_eq!(
            format_phone_international("+34600111222").unwrap(),
            Text::Owned("+34 600 11 12 22".into())
        );
        assert_eq!(
            split_phone("+34600111222").unwrap(),
            (Some("ES"), Text::Owned("600 11 12 22".into()))
        );
        assert_eq!(
            format_phone_as_typed("600111222", Some("ES")).unwrap(),
            "600 11 12 22"
        );
    }

    #[test]
    fn calling_codes() {
        assert_eq!(phone_calling_code("ES").unwrap(), Some("34"));
        assert_eq!(phone_calling_code("toString").unwrap(), None);
        assert_eq!(
            phone_calling_code("XX").unwrap_err().message,
            "Unknown country: XX"
        );
        assert_eq!(phone_main_country("1"), Some("US"));
        assert_eq!(phone_main_country("800"), None);
        assert!(phone_countries().len() > 200);
    }
}
