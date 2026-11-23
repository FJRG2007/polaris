//! The few JavaScript semantics libphonenumber-js leans on, reproduced
//! exactly: `RegExp` source read the way V8 reads it without the `u` flag,
//! `String.prototype.replace` with a replacement template, `trim()` and
//! UTF-16 lengths.

use regex_lite::Regex;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// A string's length as JavaScript counts it: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// ECMAScript WhiteSpace and LineTerminator, the set `String.prototype.trim`
/// removes. It differs from `char::is_whitespace`: U+FEFF is in, U+0085 is out.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`, with the kept range in UTF-16 code units of `text` so a
/// caller holding the original JavaScript string can slice it unchanged.
pub fn js_trim(text: &str) -> (&str, usize, usize) {
    let trimmed = text.trim_matches(is_js_space);
    let lead = text.len() - text.trim_start_matches(is_js_space).len();
    let start = utf16_len(&text[..lead]);
    (trimmed, start, start + utf16_len(trimmed))
}

/// Rewrite a JavaScript (non-`u`) pattern for `regex-lite`: `\d` is ASCII
/// in JavaScript and `.` stops at the four JavaScript line terminators.
pub fn translate(source: &str) -> String {
    let mut out = String::with_capacity(source.len() + 8);
    let mut in_class = false;
    let mut chars = source.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => match chars.next() {
                Some('d') => out.push_str(if in_class { "0-9" } else { "[0-9]" }),
                Some(next) => {
                    out.push('\\');
                    out.push(next);
                }
                None => out.push_str("\\\\"),
            },
            '[' if !in_class => {
                in_class = true;
                out.push('[');
            }
            ']' if in_class => {
                in_class = false;
                out.push(']');
            }
            '[' => out.push_str("\\["),
            '.' if !in_class => out.push_str("[^\\n\\r\\u{2028}\\u{2029}]"),
            _ => out.push(c),
        }
    }
    out
}

fn cache() -> &'static Mutex<HashMap<String, Regex>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Regex>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `new RegExp(source)`, compiled once per distinct source. Every source comes
/// from the bundled metadata or from this module's own constants, and a test
/// compiles all of them, so a failure here is a defect, not an input error.
pub fn re(source: &str) -> Regex {
    let mut map = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(found) = map.get(source) {
        return found.clone();
    }
    let compiled = Regex::new(&translate(source))
        .unwrap_or_else(|e| panic!("phone: pattern {source:?} does not compile: {e}"));
    map.insert(source.to_string(), compiled.clone());
    compiled
}

/// `new RegExp(source).test(text)`.
pub fn test(source: &str, text: &str) -> bool {
    re(source).is_match(text)
}

/// `text.search(new RegExp(source))` as a byte offset (callers only compare it
/// with 0 or slice the same string with it).
pub fn search(source: &str, text: &str) -> Option<usize> {
    re(source).find(text).map(|m| m.start())
}

/// `matchesEntirely(text, pattern)`: `^(?:pattern)$`.
pub fn matches_entirely(text: &str, pattern: &str) -> bool {
    test(&format!("^(?:{pattern})$"), text)
}

/// `text.replace(new RegExp(source), template)`: the first match only, with
/// JavaScript's `GetSubstitution` rules for `$$`, `$&`, `` $` ``, `$'` and
/// `$n`/`$nn` (a group that did not take part is the empty string; a number
/// above the group count stays literal).
pub fn replace_first(source: &str, text: &str, template: &str) -> String {
    let regex = re(source);
    let Some(caps) = regex.captures(text) else {
        return text.to_string();
    };
    let whole = caps.get(0).map_or(0..0, |m| m.range());
    let groups = caps.len() - 1;
    let mut out = String::with_capacity(text.len() + template.len());
    out.push_str(&text[..whole.start]);
    let t = template.as_bytes();
    let mut i = 0;
    while i < t.len() {
        if t[i] == b'$' && i + 1 < t.len() {
            let next = t[i + 1];
            match next {
                b'$' => {
                    out.push('$');
                    i += 2;
                    continue;
                }
                b'&' => {
                    out.push_str(&text[whole.clone()]);
                    i += 2;
                    continue;
                }
                b'`' => {
                    out.push_str(&text[..whole.start]);
                    i += 2;
                    continue;
                }
                b'\'' => {
                    out.push_str(&text[whole.end..]);
                    i += 2;
                    continue;
                }
                b'0'..=b'9' => {
                    let one = usize::from(next - b'0');
                    let two = t
                        .get(i + 2)
                        .filter(|d| d.is_ascii_digit())
                        .map(|d| one * 10 + usize::from(d - b'0'));
                    if let Some(n) = two.filter(|n| *n >= 1 && *n <= groups) {
                        out.push_str(caps.get(n).map_or("", |m| m.as_str()));
                        i += 3;
                        continue;
                    }
                    if one >= 1 && one <= groups {
                        out.push_str(caps.get(one).map_or("", |m| m.as_str()));
                        i += 2;
                        continue;
                    }
                }
                _ => {}
            }
        }
        // Copy one whole UTF-8 character.
        let len = template[i..].chars().next().map_or(1, char::len_utf8);
        out.push_str(&template[i..i + len]);
        i += len;
    }
    out.push_str(&text[whole.end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_ecmascript() {
        assert_eq!(js_trim("\u{feff} +34 \u{3000}"), ("+34", 2, 5));
        assert_eq!(js_trim("\u{85}1"), ("\u{85}1", 0, 2));
        assert_eq!(js_trim("😀 "), ("😀", 0, 2));
    }

    #[test]
    fn digit_class_is_ascii() {
        assert!(test("^\\d$", "7"));
        assert!(!test("^\\d$", "\u{0667}"));
        assert!(test("^[\\d]+$", "123"));
        assert!(!test("^.$", "\u{2028}"));
    }

    #[test]
    fn replacement_templates() {
        assert_eq!(
            replace_first("(\\d{3})(\\d{2})", "12345", "$1 $2"),
            "123 45"
        );
        assert_eq!(replace_first("(\\d)", "5", "$$1 $& $9 $01"), "$1 5 $9 5");
        assert_eq!(replace_first("x", "axb", "[$`|$']"), "a[a|b]b");
        assert_eq!(replace_first("(\\$\\d)", "$1 $2", "0$1"), "0$1 $2");
        assert_eq!(replace_first("(a)|(b)", "b", "<$1>"), "<>");
    }
}
