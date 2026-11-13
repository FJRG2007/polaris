//! What each server said about itself, kept on disk.
//!
//! The Rust twin of `desktop/src/main/instance-store.ts`, with the same file
//! format (`instances.json`). The local addresses are learned over the server's
//! own address; held only in memory, an app started while the internet is down
//! would have none, which is exactly the day they are needed. Whoever can write
//! this file can name their own key and address, so it is written readable by
//! this user only.

use crate::instance::{read_instance, InstanceRecord};
use crate::settings::write_json_atomically;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;

/// How old a stored record may get before it is learned again, in milliseconds.
pub const RELEARN_MS: u64 = crate::instance::RELEARN.as_millis() as u64;

/// The file name, the same in the beta's folder and in the Electron app's.
pub const INSTANCES_FILE: &str = "instances.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredInstance {
    pub record: InstanceRecord,
    /// Milliseconds since the epoch, 0 when the file did not say.
    pub learned_at: u64,
}

/// Every record in a parsed file, keyed by server origin. Anything malformed is left out.
pub fn read_instances_value(raw: &Value) -> BTreeMap<String, StoredInstance> {
    let mut held = BTreeMap::new();
    let Some(entries) = raw.as_object() else {
        return held;
    };
    for (server, entry) in entries {
        let Some(record) = read_instance(entry.get("record").unwrap_or(&Value::Null)) else {
            continue;
        };
        let learned_at = entry
            .get("learnedAt")
            .and_then(Value::as_f64)
            .filter(|number| number.is_finite() && *number >= 0.0)
            .map_or(0, |number| number as u64);
        held.insert(server.clone(), StoredInstance { record, learned_at });
    }
    held
}

/// Every stored record, keyed by server origin.
pub fn read_instances(file: &Path) -> BTreeMap<String, StoredInstance> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map(|raw| read_instances_value(&raw))
        .unwrap_or_default()
}

/// The record for one server, or `None`.
pub fn read_stored_instance(file: &Path, server: &str) -> Option<StoredInstance> {
    read_instances(file).remove(server)
}

/// The file's text for these records.
pub fn instances_value(all: &BTreeMap<String, StoredInstance>) -> Value {
    let mut object = Map::new();
    for (server, stored) in all {
        object.insert(
            server.clone(),
            json!({ "record": stored.record, "learnedAt": stored.learned_at }),
        );
    }
    Value::Object(object)
}

/// Keep the record for one server, replacing what was there. Written atomically.
pub fn write_stored_instance(
    file: &Path,
    server: &str,
    record: InstanceRecord,
    now: u64,
) -> io::Result<()> {
    let mut all = read_instances(file);
    all.insert(
        server.to_owned(),
        StoredInstance {
            record,
            learned_at: now,
        },
    );
    write_json_atomically(file, &instances_value(&all))
}
