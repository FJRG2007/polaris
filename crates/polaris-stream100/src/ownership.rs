//! Who holds the controller on this machine, and what Polaris can offer.
//!
//! Only one program can drive the device at a time. On Windows the Hercules
//! "HSM Series" driver binds the whole device (its INF matches
//! `USB\VID_06F8&PID_E053`, no interface suffix), so while it is installed
//! nothing else can open the device directly; the only way in is the
//! Hercules SDK, and only while Hercules Stream Control is closed.
//!
//! The reasoning behind each answer is in the protocol document, section
//! "Windows: the Hercules driver".

use serde::{Deserialize, Serialize};

/// The Windows service name the Hercules driver installs.
pub const HERCULES_SERVICE: &str = "HercStreamMixDevice";
/// Hercules Stream Control's process name.
pub const STREAM_CONTROL_PROCESS: &str = "Stream-control";

/// What the operating system reports about the device.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Observed {
    /// `windows`, `linux`, `macos`.
    pub os: String,
    /// Windows: the service bound to the device node (`DEVPKEY_Device_Service`).
    pub service: Option<String>,
    /// Hercules Stream Control is running.
    pub stream_control_running: bool,
    /// The device is plugged in at all.
    pub present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Ownership {
    /// Not plugged in: the module stays unloaded.
    Absent,
    /// Polaris can open it directly.
    Direct,
    /// The Hercules driver holds it and Stream Control is using it: Polaris
    /// asks the person to close Stream Control (it never closes it itself).
    HerculesBusy,
    /// The Hercules driver holds it and nothing is using it: Polaris can drive
    /// it through the Hercules SDK installed with that driver.
    HerculesSdk,
    /// Bound to something Polaris does not know: it says which, does nothing.
    Unknown { service: String },
}

pub fn decide(observed: &Observed) -> Ownership {
    if !observed.present {
        return Ownership::Absent;
    }
    if observed.os != "windows" {
        return Ownership::Direct;
    }
    match observed.service.as_deref() {
        Some(service) if service.eq_ignore_ascii_case(HERCULES_SERVICE) => {
            if observed.stream_control_running {
                Ownership::HerculesBusy
            } else {
                Ownership::HerculesSdk
            }
        }
        // The composite parent with Windows' own class drivers under it, or
        // WinUSB: both are opened directly.
        None => Ownership::Direct,
        Some(service)
            if ["usbccgp", "winusb", "hidusb"]
                .iter()
                .any(|s| service.eq_ignore_ascii_case(s)) =>
        {
            Ownership::Direct
        }
        Some(service) => Ownership::Unknown {
            service: service.to_owned(),
        },
    }
}
