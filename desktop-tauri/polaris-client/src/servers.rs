//! The Polaris servers this app knows, and which one it opens.
//!
//! The Rust twin of `desktop/src/shared/servers.ts`. Every address opened here is
//! kept in a list with the name somebody gave it. Switching only changes which
//! one the windows open: the sign-in on each stays in its own cookies.
//!
//! Lengths are counted in UTF-16 code units, as the TypeScript `length` and
//! `slice` count them, so a name accepted by one app is accepted by the other.

use crate::InstanceUrl;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One server as it is stored: an address, and what somebody called it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedServer {
    pub origin: String,
    /// `None` until somebody names it; the host is shown until then.
    pub name: Option<String>,
}

/// One server as the servers page draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ServerRow {
    pub origin: String,
    pub name: Option<String>,
    pub host: String,
    /// Whether it is the one the windows are open on.
    pub active: bool,
}

/// The longest name a server may be given.
pub const SERVER_NAME_MAX: usize = 40;

/// How many servers are kept. A list longer than this is not one anybody reads.
pub const SERVERS_MAX: usize = 20;

/// The length JavaScript gives a string: UTF-16 code units.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `max` UTF-16 code units, never splitting a character.
fn utf16_prefix(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        units += character.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// An address as it is stored (`readServerAddress`): the one origin form, or `None`.
pub fn read_server_address(value: &Value) -> Option<String> {
    let text = value.as_str().unwrap_or("");
    InstanceUrl::parse(text).ok().map(|url| url.to_string())
}

/// Surrounding space trimmed and inner runs collapsed; empty means "show the host".
pub fn normalize_server_name(typed: &str) -> Option<String> {
    let name = typed.split_whitespace().collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then_some(name)
}

/// The list as stored, read leniently: anything malformed or repeated is left out.
pub fn read_servers(raw: &Value) -> Vec<SavedServer> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    let mut kept: Vec<SavedServer> = Vec::new();
    for entry in entries {
        let Some(origin) = read_server_address(entry.get("origin").unwrap_or(&Value::Null)) else {
            continue;
        };
        if kept.iter().any(|server| server.origin == origin) {
            continue;
        }
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .and_then(|name| normalize_server_name(utf16_prefix(name, SERVER_NAME_MAX)));
        kept.push(SavedServer { origin, name });
        if kept.len() == SERVERS_MAX {
            break;
        }
    }
    kept
}

/// The list with this server in it, at the front when it is new.
pub fn with_server(saved: &[SavedServer], origin: &str) -> Vec<SavedServer> {
    if saved.iter().any(|server| server.origin == origin) {
        return saved.to_vec();
    }
    let mut list = vec![SavedServer {
        origin: origin.to_owned(),
        name: None,
    }];
    list.extend_from_slice(saved);
    list.truncate(SERVERS_MAX);
    list
}

pub fn rename_server(
    saved: &[SavedServer],
    origin: &str,
    name: Option<String>,
) -> Vec<SavedServer> {
    saved
        .iter()
        .map(|server| {
            if server.origin == origin {
                SavedServer {
                    origin: origin.to_owned(),
                    name: name.clone(),
                }
            } else {
                server.clone()
            }
        })
        .collect()
}

/// The list with one server moved to another address and name, where it stood.
/// An entry already at the new address is dropped, so it is never listed twice.
pub fn replace_server(
    saved: &[SavedServer],
    origin: &str,
    next: &str,
    name: Option<String>,
) -> Vec<SavedServer> {
    saved
        .iter()
        .filter(|server| server.origin != next || next == origin)
        .map(|server| {
            if server.origin == origin {
                SavedServer {
                    origin: next.to_owned(),
                    name: name.clone(),
                }
            } else {
                server.clone()
            }
        })
        .collect()
}

pub fn without_server(saved: &[SavedServer], origin: &str) -> Vec<SavedServer> {
    saved
        .iter()
        .filter(|server| server.origin != origin)
        .cloned()
        .collect()
}

/// `new URL(origin).host`: the host, and the port when it is not the default.
pub fn origin_host(origin: &str) -> String {
    match url::Url::parse(origin) {
        Ok(url) => {
            let host = url.host_str().unwrap_or_default();
            match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_owned(),
            }
        }
        Err(_) => origin.to_owned(),
    }
}

pub fn list_servers(saved: &[SavedServer], active: Option<&str>) -> Vec<ServerRow> {
    saved
        .iter()
        .map(|server| ServerRow {
            origin: server.origin.clone(),
            name: server.name.clone(),
            host: origin_host(&server.origin),
            active: Some(server.origin.as_str()) == active,
        })
        .collect()
}

/// What a row is called: its name, or its host until it has one.
pub fn describe_server(row: &ServerRow) -> &str {
    row.name.as_deref().unwrap_or(&row.host)
}

/// What the field says when the address typed is a Polaris already listed under another one.
pub fn same_instance_words(row: &ServerRow) -> String {
    format!(
        "This is the same Polaris as {}, already on your list.",
        describe_server(row)
    )
}
