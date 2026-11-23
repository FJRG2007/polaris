//! How this module describes itself to the desktop app.
//!
//! It is shaped as the first "device add-on": the desktop reads the manifest,
//! watches for one of the USB ids it claims, and loads the module only while
//! such a device is plugged in. With no controller there is nothing running
//! and nothing loaded.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbId {
    pub vendor_id: u16,
    pub product_id: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    /// The devices that make the desktop load this module.
    pub usb: Vec<UsbId>,
    /// What the module needs from the machine and from Polaris, so a screen
    /// can list it before anything is enabled.
    pub permissions: Vec<&'static str>,
}

pub fn manifest() -> Manifest {
    Manifest {
        id: "hercules-stream100",
        name: "Hercules Stream 100",
        version: env!("CARGO_PKG_VERSION"),
        usb: vec![UsbId {
            vendor_id: crate::VENDOR_ID,
            product_id: crate::PRODUCT_ID,
        }],
        permissions: vec![
            // Read the knobs and buttons, draw on the display.
            "usb:device",
            // List the apps playing audio and change their volume and mute.
            "audio:sessions",
            // Run the same actions the Stream Deck plugin runs (call mute,
            // deafen, hang up...), with the desktop's signed-in account.
            "polaris:actions",
            // Show call participants and what is playing.
            "polaris:call-state",
            "media:now-playing",
        ],
    }
}

/// Whether a plugged-in device is one this module drives.
pub fn claims(vendor_id: u16, product_id: u16) -> bool {
    manifest()
        .usb
        .iter()
        .any(|id| id.vendor_id == vendor_id && id.product_id == product_id)
}
