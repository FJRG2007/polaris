//! Choosing a TV's install path from core's data, waiting on the TV, installing
//! on it, and the USB cable.

use std::sync::OnceLock;

use polaris_client::adb_client::new_adb_key;

mod install;
mod mdns;
mod path;
mod usb;
mod wait;

/// One RSA key for the whole run: generating 2048-bit keys is slow.
pub fn key() -> &'static str {
    static KEY: OnceLock<String> = OnceLock::new();
    KEY.get_or_init(|| new_adb_key().unwrap())
}
