//! Loader for the golden vectors in this crate's directory.
//!
//! The format is described in this crate's README. The loader is strict: an
//! unknown tag, a malformed tag body or a case that expects both a value and
//! an error is a load error, never silently skipped, so a broken file cannot
//! turn into a test that checks nothing.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};

/// Largest `$repeat` expansion accepted, in bytes. Big enough for any "huge"
/// case, small enough that a typo cannot exhaust memory.
pub const MAX_REPEAT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error("invalid vector name {0:?}: only a-z, A-Z, 0-9, '-' and '_' are allowed")]
    BadName(String),
    #[error("cannot read {path}: {source}")]
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("cannot parse {path}: {source}")]
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    #[error("{path}: case {case:?}: {reason}")]
    Case {
        path: PathBuf,
        case: String,
        reason: String,
    },
    #[error("{path}: {reason}")]
    File { path: PathBuf, reason: String },
}

/// A decoded vector value.
#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    /// A string that is valid Unicode.
    Text(String),
    /// A string holding unpaired surrogates, as raw UTF-16 code units.
    Utf16(Vec<u16>),
    Bytes(Vec<u8>),
    Array(Vec<Decoded>),
    Object(Vec<(String, Decoded)>),
}

impl Decoded {
    /// The string a binding receives for this value: a JavaScript string with
    /// unpaired surrogates arrives with each one replaced by U+FFFD.
    pub fn as_binding_str(&self) -> Option<String> {
        match self {
            Decoded::Text(s) => Some(s.clone()),
            Decoded::Utf16(units) => Some(String::from_utf16_lossy(units)),
            _ => None,
        }
    }
}

/// What a case expects.
#[derive(Debug, Clone, PartialEq)]
pub enum Expect {
    Ok(Decoded),
    Error { kind: String, message: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct Case {
    pub name: String,
    pub args: Vec<Decoded>,
    pub expect: Expect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VectorFile {
    pub domain: String,
    pub op: String,
    pub source: String,
    pub cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    domain: String,
    op: String,
    source: String,
    cases: Vec<RawCase>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCase {
    name: String,
    args: Vec<Value>,
    expect: Map<String, Value>,
}

/// The directory holding every domain's vectors.
pub fn vectors_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn check_name(name: &str) -> Result<(), LoadError> {
    let ok = !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(LoadError::BadName(name.to_string()))
    }
}

/// Load `<domain>/<op>.json` from this crate's directory.
pub fn load(domain: &str, op: &str) -> Result<VectorFile, LoadError> {
    check_name(domain)?;
    check_name(op)?;
    let path = vectors_dir().join(domain).join(format!("{op}.json"));
    let file = load_path(&path)?;
    if file.domain != domain || file.op != op {
        return Err(LoadError::File {
            reason: format!(
                "names {}/{} but lives at {domain}/{op}",
                file.domain, file.op
            ),
            path,
        });
    }
    Ok(file)
}

/// Load and decode one vector file from any path.
pub fn load_path(path: &Path) -> Result<VectorFile, LoadError> {
    let text = std::fs::read_to_string(path).map_err(|source| LoadError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    parse(path, &text)
}

/// Decode vector file text; `path` is only used in error messages.
pub fn parse(path: &Path, text: &str) -> Result<VectorFile, LoadError> {
    let raw: RawFile = serde_json::from_str(text).map_err(|source| LoadError::Json {
        path: path.to_path_buf(),
        source,
    })?;
    if raw.cases.is_empty() {
        return Err(LoadError::File {
            path: path.to_path_buf(),
            reason: "has no cases".into(),
        });
    }
    let mut cases = Vec::with_capacity(raw.cases.len());
    for case in raw.cases {
        let fail = |reason: String| LoadError::Case {
            path: path.to_path_buf(),
            case: case.name.clone(),
            reason,
        };
        let args = case
            .args
            .iter()
            .map(decode)
            .collect::<Result<Vec<_>, _>>()
            .map_err(fail)?;
        let expect = decode_expect(&case.expect).map_err(fail)?;
        cases.push(Case {
            name: case.name,
            args,
            expect,
        });
    }
    Ok(VectorFile {
        domain: raw.domain,
        op: raw.op,
        source: raw.source,
        cases,
    })
}

fn decode_expect(expect: &Map<String, Value>) -> Result<Expect, String> {
    match (expect.len(), expect.get("ok"), expect.get("error")) {
        (1, Some(value), None) => Ok(Expect::Ok(decode(value)?)),
        (1, None, Some(Value::Object(error))) => {
            let field = |key: &str| match error.get(key) {
                Some(Value::String(s)) => Ok(s.clone()),
                _ => Err(format!("error.{key} must be a string")),
            };
            if error.len() != 2 {
                return Err("error must have exactly kind and message".into());
            }
            Ok(Expect::Error {
                kind: field("kind")?,
                message: field("message")?,
            })
        }
        _ => Err("expect must be exactly one of {\"ok\": ...} or {\"error\": {...}}".into()),
    }
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if !hex.is_ascii() {
        return Err("$bytes must be ASCII".into());
    }
    if hex.len() % 2 != 0 {
        return Err("$bytes must have an even number of digits".into());
    }
    if hex.bytes().any(|b| b.is_ascii_uppercase()) {
        return Err("$bytes must be lowercase".into());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            let pair = &hex[i..i + 2];
            u8::from_str_radix(pair, 16)
                .map_err(|_| format!("$bytes has a bad digit pair {pair:?}"))
        })
        .collect()
}

/// Decode one value, expanding the tags in the README.
pub fn decode(value: &Value) -> Result<Decoded, String> {
    Ok(match value {
        Value::Null => Decoded::Null,
        Value::Bool(b) => Decoded::Bool(*b),
        Value::Number(n) => Decoded::Number(n.clone()),
        Value::String(s) => Decoded::Text(s.clone()),
        Value::Array(items) => Decoded::Array(items.iter().map(decode).collect::<Result<_, _>>()?),
        Value::Object(map) => {
            if let Some(tag) = map.keys().find(|k| k.starts_with('$')) {
                if map.len() != 1 {
                    return Err(format!("{tag} must be the only key of its object"));
                }
                decode_tag(tag, &map[tag])?
            } else {
                Decoded::Object(
                    map.iter()
                        .map(|(k, v)| Ok((k.clone(), decode(v)?)))
                        .collect::<Result<_, String>>()?,
                )
            }
        }
    })
}

fn decode_tag(tag: &str, body: &Value) -> Result<Decoded, String> {
    match (tag, body) {
        ("$bytes", Value::String(hex)) => Ok(Decoded::Bytes(decode_hex(hex)?)),
        ("$utf16", Value::Array(units)) => {
            let units = units
                .iter()
                .map(|u| {
                    u.as_u64()
                        .and_then(|u| u16::try_from(u).ok())
                        .ok_or_else(|| "$utf16 holds code units 0..=65535".to_string())
                })
                .collect::<Result<Vec<u16>, _>>()?;
            Ok(Decoded::Utf16(units))
        }
        ("$repeat", Value::Object(spec)) => {
            if spec.len() != 2 {
                return Err("$repeat takes exactly text and times".into());
            }
            let text = spec
                .get("text")
                .and_then(Value::as_str)
                .ok_or("$repeat.text must be a string")?;
            let times = spec
                .get("times")
                .and_then(Value::as_u64)
                .ok_or("$repeat.times must be a count")?;
            let total = usize::try_from(times)
                .ok()
                .and_then(|t| t.checked_mul(text.len()))
                .filter(|n| *n <= MAX_REPEAT_BYTES)
                .ok_or("$repeat expands past MAX_REPEAT_BYTES")?;
            let mut out = String::with_capacity(total);
            for _ in 0..times {
                out.push_str(text);
            }
            Ok(Decoded::Text(out))
        }
        _ => Err(format!("unknown or malformed tag {tag}")),
    }
}
