//! A list of Polaris hosts carried from one device to another, and the QR code
//! it travels in.
//!
//! Mirrors `dashboard/packages/core/src/host-list.ts` (the form the desktop app
//! and the browser extension both read) and `qr.ts`. Three shapes are read, all
//! to the same list: a code (`polaris-hosts:1:` and the list base64url-encoded),
//! a link (`polaris://hosts?list=<code>`) and a JSON file. Only addresses and
//! names cross. Whatever is read is untrusted: every address is re-parsed and
//! must be a bare http(s) origin, names are trimmed and capped, and the list is
//! capped.

use base64::alphabet;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use base64::Engine;
use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
use serde::Serialize;
use serde_json::Value;
use url::Url;

/// One host as both apps store it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct PortableHost {
    pub origin: String,
    /// `None` when nobody named it; the host is shown instead.
    pub name: Option<String>,
}

impl PortableHost {
    pub fn new(origin: &str, name: Option<&str>) -> Self {
        Self {
            origin: origin.to_owned(),
            name: name.map(str::to_owned),
        }
    }
}

pub const HOST_LIST_PREFIX: &str = "polaris-hosts:1:";
pub const HOST_LIST_LINK: &str = "polaris://hosts";
/// The most hosts one list carries - more than either app keeps.
pub const HOST_LIST_MAX: usize = 50;
/// The longest name kept; a longer one is cut, the host is never dropped for it.
pub const HOST_NAME_MAX: usize = 40;
/// The most text read: a list at its cap is well under this.
const INPUT_MAX: usize = 64 * 1024;
const FILE_KIND: &str = "polaris-hosts";

/// base64url without padding, lenient on the last character's spare bits the
/// way `atob` is.
const CODE: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::RequireNone)
        .with_decode_allow_trailing_bits(true),
);

fn has_scheme(value: &str) -> bool {
    let Some((scheme, _)) = value.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// An address as it is stored, or `None` when it is not a bare http(s) origin.
fn origin_of(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    if value.encode_utf16().count() > 2048 {
        return None;
    }
    // A bare host in the compact form is https, the only scheme left out of it.
    let typed = if has_scheme(value) {
        value.to_owned()
    } else {
        format!("https://{value}")
    };
    let url = Url::parse(&typed).ok()?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let bare = url.path() == "/"
        && url.query().is_none_or(str::is_empty)
        && url.fragment().is_none_or(str::is_empty);
    bare.then(|| url.origin().ascii_serialization())
}

fn name_of(value: &Value) -> Option<String> {
    let collapsed = value
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let name: String = collapsed.chars().take(HOST_NAME_MAX).collect();
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// The rows of a list as read, with duplicates and unusable rows dropped.
fn settle<'a>(rows: impl IntoIterator<Item = (&'a Value, &'a Value)>) -> Vec<PortableHost> {
    let mut hosts: Vec<PortableHost> = Vec::new();
    for (origin, name) in rows {
        if hosts.len() == HOST_LIST_MAX {
            break;
        }
        let Some(origin) = origin_of(origin) else {
            continue;
        };
        if hosts.iter().any(|one| one.origin == origin) {
            continue;
        }
        hosts.push(PortableHost {
            origin,
            name: name_of(name),
        });
    }
    hosts
}

fn settle_hosts(hosts: &[PortableHost]) -> Vec<PortableHost> {
    let rows: Vec<(Value, Value)> = hosts
        .iter()
        .map(|one| {
            (
                Value::from(one.origin.as_str()),
                one.name.as_deref().map_or(Value::Null, Value::from),
            )
        })
        .collect();
    settle(rows.iter().map(|(origin, name)| (origin, name)))
}

/// The list as a code. https is left out of each address to keep the QR small.
pub fn encode_host_list(hosts: &[PortableHost]) -> String {
    let rows: Vec<Vec<String>> = settle_hosts(hosts)
        .into_iter()
        .map(|PortableHost { origin, name }| {
            let short = origin
                .strip_prefix("https://")
                .map_or(origin.clone(), str::to_owned);
            match name {
                Some(name) => vec![short, name],
                None => vec![short],
            }
        })
        .collect();
    let json = serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_owned());
    format!("{HOST_LIST_PREFIX}{}", CODE.encode(json))
}

/// The list as a link a QR can hold.
pub fn host_list_link(hosts: &[PortableHost]) -> String {
    format!("{HOST_LIST_LINK}?list={}", encode_host_list(hosts))
}

#[derive(Serialize)]
struct HostFile {
    kind: &'static str,
    version: u8,
    hosts: Vec<PortableHost>,
}

/// The list as a file somebody can open and read.
pub fn host_list_file(hosts: &[PortableHost]) -> String {
    let file = HostFile {
        kind: FILE_KIND,
        version: 1,
        hosts: settle_hosts(hosts),
    };
    let mut out = Vec::new();
    let mut writer = serde_json::Serializer::with_formatter(
        &mut out,
        serde_json::ser::PrettyFormatter::with_indent(b"    "),
    );
    if file.serialize(&mut writer).is_err() {
        return String::new();
    }
    format!("{}\n", String::from_utf8_lossy(&out))
}

fn from_code(code: &str) -> Option<Vec<PortableHost>> {
    let data = &code[HOST_LIST_PREFIX.len()..];
    if !data
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return None;
    }
    let bytes = CODE.decode(data).ok()?;
    let json = String::from_utf8(bytes).ok()?;
    let rows: Value = serde_json::from_str(&json).ok()?;
    let rows = rows.as_array()?;
    let null = Value::Null;
    Some(settle(rows.iter().filter_map(Value::as_array).map(|row| {
        (row.first().unwrap_or(&null), row.get(1).unwrap_or(&null))
    })))
}

fn from_file(text: &str) -> Option<Vec<PortableHost>> {
    let file: Value = serde_json::from_str(text).ok()?;
    let file = file.as_object()?;
    if file.get("kind").and_then(Value::as_str) != Some(FILE_KIND) {
        return None;
    }
    let hosts = file.get("hosts")?.as_array()?;
    let null = Value::Null;
    Some(settle(hosts.iter().filter_map(Value::as_object).map(
        |row| {
            (
                row.get("origin").unwrap_or(&null),
                row.get("name").unwrap_or(&null),
            )
        },
    )))
}

/// The hosts in a code, a link or a file, or `None` when the text is none of
/// them. An empty list is a list: a code of nobody's hosts reads as `[]`.
pub fn read_host_list(raw: &str) -> Option<Vec<PortableHost>> {
    if raw.encode_utf16().count() > INPUT_MAX {
        return None;
    }
    let text = raw.trim();
    if text.starts_with(HOST_LIST_PREFIX) {
        return from_code(text);
    }
    let link = format!("{HOST_LIST_LINK}?");
    if text.len() >= link.len()
        && text.is_char_boundary(link.len())
        && text[..link.len()].eq_ignore_ascii_case(&link)
    {
        let query = &text[text.find('?')? + 1..];
        let list = url::form_urlencoded::parse(query.as_bytes())
            .find(|(name, _)| name == "list")
            .map(|(_, value)| value.into_owned())?;
        return if list.starts_with(HOST_LIST_PREFIX) {
            from_code(&list)
        } else {
            None
        };
    }
    if text.starts_with('{') {
        return from_file(text);
    }
    None
}

/// The list a device keeps after taking another's in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Merged {
    pub hosts: Vec<PortableHost>,
    pub added: usize,
    pub named: usize,
    pub skipped: usize,
}

/// Its own hosts first and untouched, then each new one in the order it came.
/// A host already listed without a name takes the one it arrived with; a name
/// somebody already gave is never overwritten. Capped at `max`: what does not
/// fit is counted, never dropped silently.
pub fn merge_host_lists(saved: &[PortableHost], incoming: &[PortableHost], max: usize) -> Merged {
    let mut merged = Merged {
        hosts: saved.to_vec(),
        added: 0,
        named: 0,
        skipped: 0,
    };
    for host in incoming {
        if let Some(listed) = merged
            .hosts
            .iter_mut()
            .find(|one| one.origin == host.origin)
        {
            if listed.name.is_none() && host.name.is_some() {
                listed.name.clone_from(&host.name);
                merged.named += 1;
            }
            continue;
        }
        if merged.hosts.len() >= max {
            merged.skipped += 1;
            continue;
        }
        merged.hosts.push(host.clone());
        merged.added += 1;
    }
    merged
}

/// The modules of a QR code for `text`: byte mode, error correction level M,
/// the smallest version that fits (1 to 40) and the mask with the lowest
/// penalty, as `qr.ts` lays it out (both follow Project Nayuki's generator).
/// `None` when the text fits no code.
pub fn encode_qr(text: &str) -> Option<Vec<Vec<bool>>> {
    let segments = [QrSegment::make_bytes(text.as_bytes())];
    let code = QrCode::encode_segments_advanced(
        &segments,
        QrCodeEcc::Medium,
        Version::MIN,
        Version::MAX,
        None,
        false,
    )
    .ok()?;
    let size = code.size();
    Some(
        (0..size)
            .map(|y| (0..size).map(|x| code.get_module(x, y)).collect())
            .collect(),
    )
}

/// An SVG path drawing the dark modules, with the four-module quiet zone, and
/// the side of the square it is drawn in.
pub fn qr_svg_path(modules: &[Vec<bool>]) -> (String, usize) {
    const QUIET: usize = 4;
    let mut path = String::new();
    for (y, row) in modules.iter().enumerate() {
        for (x, dark) in row.iter().enumerate() {
            if *dark {
                path.push_str(&format!("M{} {}h1v1h-1z", x + QUIET, y + QUIET));
            }
        }
    }
    (path, modules.len() + QUIET * 2)
}
