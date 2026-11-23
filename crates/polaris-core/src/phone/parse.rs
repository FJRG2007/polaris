//! libphonenumber-js's parser (`parse` with `v2`, as `parsePhoneNumberFromString`
//! runs it), `PhoneNumber#isValid`, the NATIONAL and INTERNATIONAL formats and
//! the helpers `AsYouType` shares with them. Each function names the
//! libphonenumber-js function it reproduces.

use super::js;
use super::metadata::{self, FormatRef, Plan, PlanId, FIXED_LINE, NON_FIXED_LINE_TYPES};
use super::PhoneError;
use std::sync::atomic::{AtomicBool, Ordering};

pub const VALID_DIGITS: &str = "0-9\u{FF10}-\u{FF19}\u{0660}-\u{0669}\u{06F0}-\u{06F9}";
pub const VALID_PUNCTUATION: &str = "-\u{2010}-\u{2015}\u{2212}\u{30FC}\u{FF0D}\u{FF0F}/\u{FF0E}. \u{A0}\u{AD}\u{200B}\u{2060}\u{3000}()\u{FF08}\u{FF09}\u{FF3B}\u{FF3D}\\[\\]~\u{2053}\u{223C}\u{FF5E}";
pub const PLUS_CHARS: &str = "+\u{FF0B}";
const MIN_LENGTH_FOR_NSN: usize = 2;
const MAX_LENGTH_FOR_NSN: usize = 17;
const MAX_LENGTH_COUNTRY_CODE: usize = 3;
const MAX_INPUT_STRING_LENGTH: usize = 250;

/// `parseDigit`: the ASCII digit for a Western, full-width, Arabic-Indic or
/// Persian digit.
pub fn parse_digit(c: char) -> Option<char> {
    let base = match c {
        '0'..='9' => '0',
        '\u{FF10}'..='\u{FF19}' => '\u{FF10}',
        '\u{0660}'..='\u{0669}' => '\u{0660}',
        '\u{06F0}'..='\u{06F9}' => '\u{06F0}',
        _ => return None,
    };
    char::from_digit(c as u32 - base as u32, 10)
}

/// `parseDigits`.
pub fn parse_digits(text: &str) -> String {
    text.chars().filter_map(parse_digit).collect()
}

/// `parseIncompletePhoneNumber`: digits, and a `+` only as the first character kept.
fn parse_incomplete(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c == '+' {
            if out.is_empty() {
                out.push('+');
            }
        } else if let Some(d) = parse_digit(c) {
            out.push(d);
        }
    }
    out
}

/// The extension pattern of `createExtensionPattern()`, written out with the
/// case variants JavaScript's `i` flag accepts (simple upper-casing, never
/// mapping a non-ASCII letter onto an ASCII one).
fn extension_pattern() -> String {
    let digits = |max: u8| format!("([{VALID_DIGITS}]{{1,{max}}})");
    let sep = "[ \u{A0}\\t,]*";
    let after = "[:\\.\u{FF0E}]?[ \u{A0}\\t,-]*";
    let explicit = "(?:[eE]?[xX][tT](?:[eE][nN][sS][iI](?:[oO]\u{301}?|[\u{F3}\u{D3}]))?[nN]?|[\u{FF45}\u{FF25}]?[\u{FF58}\u{FF38}][\u{FF54}\u{FF34}][\u{FF4E}\u{FF2E}]?|[\u{434}\u{414}][\u{43E}\u{41E}][\u{431}\u{411}]|[aA][nN][eE][xX][oO])";
    let ambiguous = "(?:[xX\u{FF58}\u{FF38}#\u{FF03}~\u{FF5E}]|[iI][nN][tT]|[\u{FF49}\u{FF29}][\u{FF4E}\u{FF2E}][\u{FF54}\u{FF34}])";
    let no_comma = "[ \u{A0}\\t]*";
    [
        format!(";ext={}", digits(20)),
        format!("{sep}{explicit}{after}{}#?", digits(20)),
        format!("{sep}{ambiguous}{after}{}#?", digits(9)),
        format!("[- ]+{}#", digits(6)),
        format!("{no_comma}(?:,{{2}}|;){after}{}#?", digits(15)),
        format!("{no_comma}(?:,)+{after}{}#?", digits(9)),
    ]
    .join("|")
}

fn valid_phone_number() -> String {
    format!("[{PLUS_CHARS}]{{0,1}}(?:[{VALID_PUNCTUATION}]*[{VALID_DIGITS}]){{3,}}[{VALID_PUNCTUATION}{VALID_DIGITS}]*")
}

/// `extractExtension`.
fn extract_extension(number: &str) -> Option<(String, String)> {
    let source = format!("(?:{})$", extension_pattern());
    let regex = js::re(&source);
    let caps = regex.captures(number)?;
    let start = caps.get(0)?.start();
    (1..caps.len())
        .filter_map(|i| caps.get(i))
        .map(|m| m.as_str())
        .find(|s| !s.is_empty())
        .map(|ext| (number[..start].to_string(), ext.to_string()))
}

/// `isViablePhoneNumber` and `isViablePhoneNumberStart`.
fn is_viable(number: &str) -> bool {
    js::utf16_len(number) >= MIN_LENGTH_FOR_NSN
        && js::test(
            &format!(
                "^[{VALID_DIGITS}]{{{MIN_LENGTH_FOR_NSN}}}$|^{}(?:{})?$",
                valid_phone_number(),
                extension_pattern()
            ),
            number,
        )
}

// The two `phone-context` patterns are created with the `g` flag and used with
// `test()`, so each keeps `lastIndex` between calls: after a match the next
// test of either pattern fails (it is anchored at 0) and resets it. This is
// libphonenumber-js's observable behaviour, and it is kept.
static GLOBAL_DIGITS_ARMED: AtomicBool = AtomicBool::new(false);
static DOMAIN_NAME_ARMED: AtomicBool = AtomicBool::new(false);

fn sticky_test(armed: &AtomicBool, source: &str, text: &str) -> bool {
    if armed.swap(false, Ordering::Relaxed) {
        return false;
    }
    let found = js::test(source, text);
    if found {
        armed.store(true, Ordering::Relaxed);
    }
    found
}

const PHONE_CONTEXT: &str = ";phone-context=";

/// `extractPhoneContext` + `isPhoneContextValid`: `Err` is the `NOT_A_NUMBER`
/// parse error.
fn phone_context(number: &str) -> Result<Option<&str>, ()> {
    let Some(index) = number.find(PHONE_CONTEXT) else {
        return Ok(None);
    };
    let start = index + PHONE_CONTEXT.len();
    let context = if start >= number.len() {
        ""
    } else {
        let rest = &number[start..];
        rest.find(';').map_or(rest, |end| &rest[..end])
    };
    if context.is_empty() {
        return Err(());
    }
    let digit = format!("([{VALID_DIGITS}]|[\\-\\.\\(\\)]?)");
    let global = format!("^\\+{digit}*[{VALID_DIGITS}]{digit}*$");
    let label = format!("[{VALID_DIGITS}]+((\\-)*[{VALID_DIGITS}])*");
    let domain = format!("^({label}\\.)*[a-zA-Z]+((\\-)*[{VALID_DIGITS}])*\\.?$");
    if sticky_test(&GLOBAL_DIGITS_ARMED, &global, context)
        || sticky_test(&DOMAIN_NAME_ARMED, &domain, context)
    {
        Ok(Some(context))
    } else {
        Err(())
    }
}

/// `extractFormattedPhoneNumber` for the `v2` parser: `Err` is a parse error.
fn extract_formatted(text: &str) -> Result<Option<String>, ()> {
    if text.is_empty() {
        return Ok(None);
    }
    if js::utf16_len(text) > MAX_INPUT_STRING_LENGTH {
        return Err(());
    }
    let Some(start) = js::search(&format!("[{PLUS_CHARS}{VALID_DIGITS}]"), text) else {
        return Ok(None);
    };
    let tail = &text[start..];
    let end = js::search(&format!("[^{VALID_DIGITS}#]+$"), tail).unwrap_or(tail.len());
    Ok(Some(tail[..end].to_string()))
}

/// `extractFormattedPhoneNumberFromPossibleRfc3966NumberUri`.
fn from_possible_uri(text: &str) -> Result<Option<String>, ()> {
    let context = phone_context(text)?;
    let mut number = match context {
        None => extract_formatted(text)?.unwrap_or_default(),
        Some(context) => {
            let mut s = String::new();
            if context.starts_with('+') {
                s.push_str(context);
            }
            let from = text.find("tel:").map_or(0, |i| i + 4);
            let to = text.find(PHONE_CONTEXT).unwrap_or(text.len());
            // `substring` swaps reversed bounds.
            let (a, b) = if from <= to { (from, to) } else { (to, from) };
            s.push_str(&text[a..b]);
            s
        }
    };
    if let Some(i) = number.find(";isub=") {
        if i > 0 {
            number.truncate(i);
        }
    }
    Ok(if number.is_empty() { None } else { Some(number) })
}

/// What `parseInput` hands on: the number and its extension.
fn parse_input(text: &str) -> Result<Option<(String, Option<String>)>, ()> {
    let Some(number) = from_possible_uri(text)? else {
        return Ok(None);
    };
    if !is_viable(&number) {
        return Ok(None);
    }
    if let Some((rest, ext)) = extract_extension(&number) {
        return Ok(Some((rest, Some(ext))));
    }
    Ok(Some((number, None)))
}

/// `checkNumberLength` results.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Length {
    IsPossible,
    TooShort,
    TooLong,
    InvalidLength,
}

/// `checkNumberLength(nationalNumber, undefined, metadata)` for `plan`.
pub fn check_length(national: &str, plan: &'static Plan) -> Length {
    let Some(lengths) = plan.possible_lengths else {
        return Length::IsPossible;
    };
    let actual = national.len();
    let Some(&min) = lengths.first() else {
        // `possible_lengths[0]` is undefined: every comparison is false, and
        // `indexOf(n, 1)` finds nothing.
        return Length::InvalidLength;
    };
    let min = usize::from(min);
    if min == actual {
        return Length::IsPossible;
    }
    if min > actual {
        return Length::TooShort;
    }
    if lengths.last().is_some_and(|&max| usize::from(max) < actual) {
        return Length::TooLong;
    }
    if lengths.iter().skip(1).any(|&l| usize::from(l) == actual) {
        Length::IsPossible
    } else {
        Length::InvalidLength
    }
}

fn is_type(national: &str, index: usize, plan: &'static Plan) -> bool {
    let Some(t) = plan.type_def(index) else {
        return false;
    };
    let Some(pattern) = t.pattern.filter(|p| !p.is_empty()) else {
        return false;
    };
    if let Some(lengths) = plan.type_lengths(t) {
        if !lengths.iter().any(|&l| usize::from(l) == national.len()) {
            return false;
        }
    }
    js::matches_entirely(national, pattern)
}

/// `getNumberType(...) !== undefined`.
pub fn has_number_type(national: &str, plan: &'static Plan) -> bool {
    if !js::matches_entirely(national, plan.national_pattern.unwrap_or("undefined")) {
        return false;
    }
    if is_type(national, FIXED_LINE, plan) {
        return true;
    }
    NON_FIXED_LINE_TYPES
        .iter()
        .any(|&index| is_type(national, index, plan))
}

/// `getCountryByNationalNumber`.
pub fn country_by_national_number(national: &str, countries: &[&'static str]) -> Option<&'static str> {
    for &country in countries {
        let Some(plan) = metadata::country(country) else {
            continue;
        };
        let plan = plan.plan();
        if let Some(leading) = plan.leading_digits {
            if !national.is_empty() && js::search(leading, national) == Some(0) {
                return Some(country);
            }
        } else if has_number_type(national, plan) {
            return Some(country);
        }
    }
    None
}

/// `getCountryByCallingCode`.
pub fn country_by_calling_code(code: &str, national: &str) -> Option<&'static str> {
    let countries = metadata::countries_for_code(code)?;
    if countries.len() == 1 {
        return Some(countries[0]);
    }
    country_by_national_number(national, countries)
}

/// What `extractNationalNumberFromPossiblyIncompleteNumber` returns.
pub struct Extracted {
    pub national: String,
    pub national_prefix: Option<String>,
    pub carrier: Option<String>,
}

/// `extractNationalNumberFromPossiblyIncompleteNumber(number, metadata)` with
/// `plan` selected.
pub fn extract_national_incomplete(number: &str, plan: &'static Plan) -> Extracted {
    let unchanged = || Extracted { national: number.to_string(), national_prefix: None, carrier: None };
    let Some(prefix) = plan.np_for_parsing().filter(|_| !number.is_empty()) else {
        return unchanged();
    };
    let source = format!("^(?:{prefix})");
    let regex = js::re(&source);
    let Some(caps) = regex.captures(number) else {
        return unchanged();
    };
    let whole = caps.get(0).map_or("", |m| m.as_str());
    let count = caps.len() - 1;
    let last_group = if count > 0 { caps.get(count).map(|m| m.as_str()).filter(|s| !s.is_empty()) } else { None };
    let has_groups = last_group.is_some();
    let first_group = caps.get(1).map(|m| m.as_str());
    let mut carrier = None;
    let national = match plan.transform_rule.filter(|_| has_groups) {
        Some(rule) => {
            if count > 1 {
                carrier = first_group.map(str::to_string);
            }
            js::replace_first(&source, number, rule)
        }
        None => {
            if has_groups {
                carrier = first_group.map(str::to_string);
            }
            number[whole.len()..].to_string()
        }
    };
    let national_prefix = if has_groups {
        // `number.indexOf(prefixMatch[1])`: an unmatched group is `undefined`,
        // which `indexOf` looks for as the text "undefined".
        let needle = first_group.unwrap_or("undefined");
        let position = number.find(needle);
        let before = match position {
            Some(p) => &number[..p],
            // `slice(0, -1)`: all but the last character.
            None => &number[..number.len().saturating_sub(1)],
        };
        plan.national_prefix
            .filter(|np| *np == before)
            .map(str::to_string)
    } else {
        Some(whole.to_string())
    };
    Extracted { national, national_prefix, carrier }
}

/// `extractNationalNumber(number, undefined, metadata)` with `plan` selected.
pub fn extract_national(number: &str, plan: &'static Plan) -> (String, Option<String>) {
    let extracted = extract_national_incomplete(number, plan);
    let national = extracted.national;
    if national != number {
        let pattern = plan.national_pattern.unwrap_or("undefined");
        if js::matches_entirely(number, pattern) && !js::matches_entirely(&national, pattern) {
            return (number.to_string(), None);
        }
        if plan.possible_lengths.is_some() {
            let country = country_by_calling_code(plan.calling_code, &national);
            let target = match country {
                Some(c) => metadata::country(c).map_or(plan, PlanId::plan),
                None => plan,
            };
            if matches!(check_length(&national, target), Length::TooShort | Length::InvalidLength) {
                return (number.to_string(), None);
            }
        }
    }
    (national, extracted.carrier)
}

/// `getCountryCallingCode(country)` for a country the metadata has.
fn calling_code_of(country: &str) -> Result<&'static str, PhoneError> {
    metadata::country(country)
        .map(|p| p.plan().calling_code)
        .ok_or_else(|| PhoneError::error(format!("Unknown country: {country}")))
}

/// `extractCountryCallingCodeFromInternationalNumberWithoutPlusSign` with no
/// default calling code.
pub fn extract_code_without_plus(
    number: &str,
    country: Option<&str>,
) -> Result<Option<(&'static str, String)>, PhoneError> {
    let Some(country) = country else {
        return Ok(None);
    };
    let code = calling_code_of(country)?;
    if !number.starts_with(code) {
        return Ok(None);
    }
    let Some(plan) = metadata::select(country)? else {
        return Ok(None);
    };
    let plan = plan.plan();
    let shorter = &number[code.len()..];
    let (shorter_national, _) = extract_national(shorter, plan);
    let (national, _) = extract_national(number, plan);
    let pattern = plan.national_pattern.unwrap_or("undefined");
    if (!js::matches_entirely(&national, pattern) && js::matches_entirely(&shorter_national, pattern))
        || check_length(&national, plan) == Length::TooLong
    {
        return Ok(Some((code, shorter.to_string())));
    }
    Ok(None)
}

/// `stripIddPrefix(number, country)`.
pub fn strip_idd_prefix(number: &str, country: Option<&str>) -> Result<Option<String>, PhoneError> {
    let Some(country) = country else {
        return Ok(None);
    };
    let Some(plan) = metadata::select(country)? else {
        return Ok(None);
    };
    // `new RegExp(metadata.IDDPrefix())`: a plan without one stores the number
    // 0, which `RegExp` reads as the pattern "0".
    let idd = plan.plan().idd.unwrap_or("0");
    let regex = js::re(idd);
    let Some(found) = regex.find(number).filter(|m| m.start() == 0) else {
        return Ok(None);
    };
    let rest = &number[found.end()..];
    if let Some(c) = js::re(&format!("([{VALID_DIGITS}])")).find(rest) {
        if c.as_str() == "0" {
            return Ok(None);
        }
    }
    Ok(Some(rest.to_string()))
}

/// Where `extractCountryCallingCode` found the calling code.
pub struct CodeExtraction {
    pub code: Option<String>,
    pub number: Option<String>,
}

/// `extractCountryCallingCode(number, country, defaultCountry, undefined, metadata)`;
/// `country` is `country || defaultCountry`.
pub fn extract_calling_code(number: &str, country: Option<&str>) -> Result<CodeExtraction, PhoneError> {
    let none = CodeExtraction { code: None, number: None };
    if number.is_empty() {
        return Ok(none);
    }
    let mut number = number.to_string();
    if !number.starts_with('+') {
        let stripped = strip_idd_prefix(&number, country)?;
        match stripped {
            Some(rest) if !rest.is_empty() && rest != number => number = format!("+{rest}"),
            _ => {
                if country.is_some() {
                    if let Some((code, shorter)) = extract_code_without_plus(&number, country)? {
                        return Ok(CodeExtraction { code: Some(code.to_string()), number: Some(shorter) });
                    }
                }
                return Ok(CodeExtraction { code: None, number: Some(number) });
            }
        }
    }
    if number.as_bytes().get(1) == Some(&b'0') {
        return Ok(none);
    }
    // `number` holds only `+` and ASCII digits here, so byte and UTF-16
    // positions agree.
    let mut i = 2;
    while i - 1 <= MAX_LENGTH_COUNTRY_CODE && i <= number.len() {
        let code = &number[1..i];
        if metadata::has_calling_code(code) {
            return Ok(CodeExtraction { code: Some(code.to_string()), number: Some(number[i..].to_string()) });
        }
        i += 1;
    }
    Ok(none)
}

/// A parsed number: `PhoneNumber` as `parse` builds it.
pub struct PhoneNumber {
    pub country: Option<&'static str>,
    pub calling_code: String,
    pub national: String,
    pub ext: Option<String>,
}

impl PhoneNumber {
    /// `number`: E.164.
    pub fn e164(&self) -> String {
        format!("+{}{}", self.calling_code, self.national)
    }

    fn plan(&self) -> Result<Option<&'static Plan>, PhoneError> {
        let key = self.country.unwrap_or(&self.calling_code);
        Ok(metadata::select(key)?.map(PlanId::plan))
    }

    /// `isValid()`.
    pub fn is_valid(&self) -> Result<bool, PhoneError> {
        let Some(plan) = self.plan()? else {
            return Ok(false);
        };
        if plan.types.is_some_and(|t| !t.is_empty()) {
            return Ok(has_number_type(&self.national, plan));
        }
        Ok(js::matches_entirely(&self.national, plan.national_pattern.unwrap_or("undefined")))
    }

    /// `format('NATIONAL')` and `format('INTERNATIONAL')`.
    pub fn format(&self, international: bool) -> Result<String, PhoneError> {
        let plan = match self.country {
            Some(country) => metadata::select(country)?,
            None => metadata::select(&self.calling_code)?,
        };
        let Some(plan) = plan.map(PlanId::plan) else {
            return Ok(String::new());
        };
        let formatted = format_national(&self.national, plan, international);
        let number = if international {
            format!("+{} {}", plan.calling_code, formatted)
        } else {
            formatted
        };
        Ok(match &self.ext {
            Some(ext) => format!("{number}{}{ext}", plan.ext.unwrap_or(" ext. ")),
            None => number,
        })
    }
}

/// `chooseFormatForNumber`.
fn choose_format(plan: &'static Plan, national: &str) -> Option<FormatRef> {
    FormatRef::all(plan).into_iter().find(|f| {
        if let Some(last) = f.format.leading.last() {
            if js::search(last, national) != Some(0) {
                return false;
            }
        }
        js::matches_entirely(national, f.format.pattern)
    })
}

/// `formatNationalNumber` for the NATIONAL and INTERNATIONAL formats.
fn format_national(national: &str, plan: &'static Plan, international: bool) -> String {
    match choose_format(plan, national) {
        Some(format) => format_using(national, &format, international, true),
        None => national.to_string(),
    }
}

/// `formatNationalNumberUsingFormat`.
pub fn format_using(national: &str, format: &FormatRef, international: bool, with_np: bool) -> String {
    let template = if international {
        format.international_format().to_string()
    } else {
        match format.np_rule().filter(|_| with_np) {
            Some(rule) => js::replace_first("(\\$\\d)", format.format.format, rule),
            None => format.format.format.to_string(),
        }
    };
    let formatted = js::replace_first(format.format.pattern, national, &template);
    if international {
        international_separators(&formatted)
    } else {
        formatted
    }
}

/// `applyInternationalSeparatorStyle`.
pub fn international_separators(text: &str) -> String {
    let regex = js::re(&format!("[{VALID_PUNCTUATION}]+"));
    let spaced = regex.replace_all(text, " ");
    spaced.trim_matches(js::is_js_space).to_string()
}

/// `parsePhoneNumberFromString(text, defaultCountry)`: `None` where it returns
/// `undefined` (a parse error, caught).
pub fn parse(text: &str, default_country: Option<&str>) -> Result<Option<PhoneNumber>, PhoneError> {
    // An unsupported default country (no own key) is dropped, as `isSupportedCountry` does.
    let default_country = default_country.filter(|c| !c.is_empty() && metadata::country(c).is_some());
    let Ok(input) = parse_input(text) else {
        return Ok(None);
    };
    let Some((formatted, ext)) = input else {
        return Ok(None);
    };
    let extraction = extract_calling_code(&parse_incomplete(&formatted), default_country)?;
    let mut country: Option<&'static str> = None;
    let (code, plan) = match (extraction.code, &extraction.number) {
        (Some(code), _) => {
            let plan = metadata::select(&code)?;
            (code, plan)
        }
        (None, Some(n)) if !n.is_empty() && default_country.is_some() => {
            let dc = default_country.unwrap_or_default();
            let plan = metadata::select(dc)?;
            country = metadata::country_keys().find(|k| *k == dc);
            let code = plan.map(|p| p.plan().calling_code.to_string()).unwrap_or_default();
            (code, plan)
        }
        _ => return Ok(None),
    };
    let Some(mut plan) = plan else {
        return Ok(None);
    };
    let number = extraction.number.unwrap_or_default();
    if number.is_empty() {
        return Ok(None);
    }
    let (national, _carrier) = extract_national(&parse_incomplete(&number), plan.plan());
    if let Some(exact) = country_by_calling_code(&code, &national) {
        country = Some(exact);
        if let Some(p) = metadata::select(exact)? {
            plan = p;
        }
    }
    let _ = plan;
    if national.len() < MIN_LENGTH_FOR_NSN || national.len() > MAX_LENGTH_FOR_NSN {
        return Ok(None);
    }
    Ok(Some(PhoneNumber { country, calling_code: code, national, ext }))
}
