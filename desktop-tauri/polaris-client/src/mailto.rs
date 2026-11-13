//! A `mailto:` link opens the Mail composer on the Polaris in use, and nothing
//! else (`desktop/src/shared/mailto.ts`). The whole link goes to the web app,
//! which reads the address, subject and body itself.

use crate::servers::utf16_len;

/// Longer than any link a mail program hands over, in UTF-16 units as in the TS module.
const MAX_LENGTH: usize = 8192;

/// `encodeURIComponent`.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The composer's path for a mailto link, or `None` for anything that is not one.
pub fn mailto_path(value: &str) -> Option<String> {
    if utf16_len(value) > MAX_LENGTH {
        return None;
    }
    if !value
        .get(..7)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
    {
        return None;
    }
    if value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return None;
    }
    Some(format!("/mail/compose?url={}", encode_component(value)))
}

/// The first mailto link among the arguments the app was started with.
pub fn mailto_in(argv: &[String]) -> Option<String> {
    argv.iter().find_map(|argument| mailto_path(argument))
}
