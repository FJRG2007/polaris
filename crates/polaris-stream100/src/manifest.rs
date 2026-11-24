//! How this module describes itself to the desktop app: the device add-on
//! manifest (`docs/device-addons.md`, schema in `@polaris/core/device-addons`).
//!
//! `clients/device-addons/hercules-stream100/manifest.json` is this function's output,
//! checked by a test, so the published package and the code cannot drift. The
//! desktop watches for the USB id it claims and runs the add-on only while
//! such a device can be there; with no controller nothing runs.

use serde_json::{json, Value};

/// The platforms a package is built for: input is read on Windows (HID API)
/// and Linux (USB). macOS has no input route yet, so it gets no package.
pub const PLATFORMS: [&str; 2] = ["win32-x64", "linux-x64"];

/// The script each platform's package starts.
pub const ENTRY: &str = "main.cjs";

/// The first desktop release with the add-on host.
pub const MIN_APP_VERSION: &str = "0.1.75";

pub fn manifest() -> Value {
    let entries: serde_json::Map<String, Value> = PLATFORMS
        .iter()
        .map(|platform| ((*platform).to_owned(), json!(ENTRY)))
        .collect();
    json!({
        "schema": 1,
        "id": "hercules-stream100",
        "name": "Hercules Stream 100",
        "version": env!("CARGO_PKG_VERSION"),
        "publisher": "Polaris",
        "summary": "Knobs follow calls, music and games instead of one app each, and the lit buttons mute, deafen or hang up a Polaris call.",
        "category": "devices",
        "minAppVersion": MIN_APP_VERSION,
        "entries": entries,
        "claims": [{
            "vendorId": crate::VENDOR_ID,
            "productId": crate::PRODUCT_ID,
            "name": "Hercules Stream 100",
        }],
        // Read the knobs and buttons; set the volume and mute of the apps
        // playing audio; run Polaris' call actions from the buttons. The
        // display is asked for once something is drawn on it.
        "permissions": ["usb", "audio-sessions", "polaris-actions"],
        "settings": crate::addon::addon_settings(),
    })
}

/// Whether a plugged-in device is one this module drives.
pub fn claims(vendor_id: u16, product_id: u16) -> bool {
    vendor_id == crate::VENDOR_ID && product_id == crate::PRODUCT_ID
}
