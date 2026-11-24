//! Prints the device add-on manifest as `clients/device-addons/hercules-stream100/manifest.json` holds it:
//!
//!   cargo run -q -p polaris-stream100 --example manifest > clients/device-addons/hercules-stream100/manifest.json

use serde::Serialize;

fn main() {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    polaris_stream100::manifest::manifest()
        .serialize(&mut serializer)
        .expect("a JSON value always serializes");
    println!(
        "{}",
        String::from_utf8(out).expect("serde_json writes UTF-8")
    );
}
