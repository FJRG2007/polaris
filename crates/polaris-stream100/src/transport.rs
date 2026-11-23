//! Reading the controller over USB (feature `usb`).
//!
//! Built on `nusb`: pure Rust, no libusb to ship or compile, and the same API
//! on Linux (usbfs), Windows (WinUSB) and macOS (IOKit). What it reaches on
//! each system:
//!
//! - **Linux**: interface 0 directly; the kernel's HID driver is detached
//!   while Polaris holds it. Needs the `uaccess` udev rule for the device.
//! - **Windows**: only an interface bound to WinUSB. With the Hercules driver
//!   installed, nothing; see [`crate::ownership`].
//! - **macOS**: HID interfaces stay with the system; input there goes through
//!   the HID manager instead (not written yet).
//!
//! The display uses isochronous transfers, which `nusb` 0.2 does not offer;
//! it is not driven from here yet (see the protocol document).

use crate::report::Report;
use crate::{PRODUCT_ID, VENDOR_ID};
use nusb::transfer::{In, Interrupt};
use nusb::MaybeFuture;
use std::time::Duration;

const INPUT_INTERFACE: u8 = 0;
const INPUT_ENDPOINT: u8 = 0x81;

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("the Stream 100 is not plugged in")]
    NotFound,
    #[error("another program is using the Stream 100")]
    Busy,
    #[error("this system does not let Polaris open the Stream 100")]
    NoAccess,
    #[error("the Stream 100 stopped answering: {0}")]
    Io(String),
    #[error("reading the Stream 100 is not supported on this system yet")]
    Unsupported,
}

/// Why the device or its interface would not open: no permission (on Linux,
/// no `uaccess` rule for it) reads differently from another program holding it.
fn refused(error: nusb::Error) -> TransportError {
    match error.kind() {
        nusb::ErrorKind::PermissionDenied => TransportError::NoAccess,
        nusb::ErrorKind::Disconnected | nusb::ErrorKind::NotFound => TransportError::NotFound,
        _ => TransportError::Busy,
    }
}

/// The controller's input endpoint, opened.
pub struct Input {
    endpoint: nusb::Endpoint<Interrupt, In>,
}

impl Input {
    pub fn open() -> Result<Self, TransportError> {
        let info = nusb::list_devices()
            .wait()
            .map_err(|error| TransportError::Io(error.to_string()))?
            .find(|device| device.vendor_id() == VENDOR_ID && device.product_id() == PRODUCT_ID)
            .ok_or(TransportError::NotFound)?;
        let device = info.open().wait().map_err(refused)?;
        let interface = device
            .detach_and_claim_interface(INPUT_INTERFACE)
            .wait()
            .map_err(refused)?;
        let endpoint = interface
            .endpoint::<Interrupt, In>(INPUT_ENDPOINT)
            .map_err(|error| TransportError::Io(error.to_string()))?;
        Ok(Self { endpoint })
    }

    /// Waits up to `timeout` for the next report; `Ok(None)` when none came.
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, TransportError> {
        if self.endpoint.pending() == 0 {
            // One packet per transfer: the controller sends 64-byte reports.
            let buffer = self.endpoint.allocate(self.endpoint.max_packet_size());
            self.endpoint.submit(buffer);
        }
        let Some(completion) = self.endpoint.wait_next_complete(timeout) else {
            return Ok(None);
        };
        completion
            .status
            .map_err(|error| TransportError::Io(error.to_string()))?;
        Ok(Report::parse(&completion.buffer))
    }
}
