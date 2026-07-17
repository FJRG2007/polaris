//! Code generator: emits the Python module shared with the Home Assistant glue.
//!
//! The MQTT topic layout and the device-model list live once, in Rust. This
//! example renders them as Python so the integration never re-declares (and
//! never drifts from) the on-device agent's contract.
//!
//! Run: `cargo run -p polaris-unas-core --example gen_python`
//! CI regenerates this and fails if the committed file differs.

use polaris_unas_core::bays::DeviceModel;
use polaris_unas_core::mqtt::seg;

fn main() {
    let mut out = String::new();
    out.push_str("# Auto-generated from polaris-unas-core. Do not edit by hand.\n");
    out.push_str("# Regenerate: cargo run -p polaris-unas-core --example gen_python\n");
    out.push_str("# Source of truth: plugins/unifi-unas/core (mqtt.rs, bays.rs).\n\n");

    out.push_str("DEVICE_MODELS = {\n");
    for model in DeviceModel::ALL {
        out.push_str(&format!("    {:?}: {:?},\n", model.as_key(), model.label()));
    }
    out.push_str("}\n\n");

    out.push_str("def get_mqtt_root(entry_id: str) -> str:\n");
    out.push_str(&format!(
        "    return f\"{}/{{entry_id[:8]}}\"\n\n",
        seg::PREFIX
    ));

    out.push_str("def get_mqtt_topics(entry_id: str) -> dict:\n");
    out.push_str("    root = get_mqtt_root(entry_id)\n");
    out.push_str("    return {\n");
    out.push_str("        \"root\": root,\n");
    for segment in [
        seg::AVAILABILITY,
        seg::CONTROL,
        seg::SYSTEM,
        seg::HDD,
        seg::NVME,
        seg::POOL,
        seg::SMB,
        seg::NFS,
        seg::SHARE,
    ] {
        out.push_str(&format!(
            "        \"{segment}\": f\"{{root}}/{segment}\",\n"
        ));
    }
    out.push_str("    }\n");

    print!("{out}");
}
