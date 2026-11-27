//! Opening a session with the controller over plain USB, the way the official
//! software does, without any of its software: which control requests are
//! sent at start, the keep-alive that keeps the controller reporting, and the
//! device interface Polaris' own WinUSB driver package registers on Windows.
//!
//! Written from the documented protocol (CataclysmX/New-Hera-lunx,
//! `docs/protocol/usb.md` and `commands.md`), not from its code:
//!
//! 1. configuration 1 (Windows' USB stack selects it when WinUSB loads);
//! 2. interface 1, alternate setting 1, which carries the isochronous OUT
//!    endpoint `0x01` (952-byte packets);
//! 3. two vendor reads: request `0x52` (value 0, 2 bytes) and `0x02`
//!    (2 bytes, the firmware version);
//! 4. a keep-alive on endpoint `0x01` at least twice a second, in a
//!    transfer that starts with the `HERCULES` sync packet
//!    ([`crate::screen::Painter`] sends it, with the screen's frames).
//!
//! The controller also answers requests that reboot it into its firmware
//! updater (`0xF2`) or write its flash. Those are never sent: the only
//! control requests this crate can build are the reads in [`INIT_READS`],
//! and [`VendorRead::setup`] refuses anything else.
//!
//! The whole session is [`Session`], written once: each system only supplies
//! a [`Link`] - how it opens the device and moves bytes (WinUSB on Windows,
//! libusb on Linux and macOS). What is sent, in which order and how often is
//! the same everywhere.

use crate::display::{self, MAX_TRANSFER_PACKETS, PACKET_SIZE};
use crate::report::{Report, REPORT_LEN};
use crate::screen::{self, Painter};
use std::time::{Duration, Instant};

/// The input interface and its interrupt IN endpoint (64-byte reports).
pub const INPUT_INTERFACE: u8 = 0;
pub const INPUT_ENDPOINT: u8 = 0x81;
/// The display interface, its alternate setting, and its isochronous OUT endpoint.
pub const DISPLAY_INTERFACE: u8 = 1;
pub const DISPLAY_ALT_SETTING: u8 = 1;
pub const DISPLAY_ENDPOINT: u8 = 0x01;

/// The device interface Polaris' WinUSB package (`polaris-stream100.inf`)
/// registers, so Polaris finds the controller it installed for and nothing
/// else. Generated at random for Polaris; the desktop app's INF renderer uses the same
/// value (`clients/desktop/src/main/plugins/hercules-driver.ts`, a test there
/// keeps the two equal).
pub const DEVICE_INTERFACE_GUID: &str = "{24a30efc-7c61-4f1a-baaa-f87f84a38ce1}";
/// [`DEVICE_INTERFACE_GUID`] as the number Windows' `GUID` holds.
pub const DEVICE_INTERFACE_GUID_U128: u128 = 0x24a30efc_7c61_4f1a_baaa_f87f84a38ce1;

/// The keep-alive must reach the controller at least twice a second; once
/// every 250 ms leaves room for a late write.
pub const KEEPALIVE_EVERY: Duration = Duration::from_millis(250);

/// Requests the controller must never receive: reboot into the firmware
/// updater (`0xF2`). Flash writes are not control reads at all, so nothing
/// here can build one.
pub const FORBIDDEN_REQUESTS: [u8; 1] = [0xf2];

/// `bmRequestType` of a vendor read addressed to the device: device to host,
/// vendor, device recipient.
pub const VENDOR_IN: u8 = 0xc0;

/// One vendor control read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VendorRead {
    pub request: u8,
    pub value: u16,
    pub length: u16,
}

/// The reads sent when a session starts, in order.
pub const INIT_READS: [VendorRead; 2] = [
    VendorRead {
        request: 0x52,
        value: 0,
        length: 2,
    },
    VendorRead {
        request: 0x02,
        value: 0,
        length: 2,
    },
];

/// A control setup packet: request type, request, value, index, length.
pub type Setup = (u8, u8, u16, u16, u16);

impl VendorRead {
    /// The setup packet for this read, or `None` for anything that is not one
    /// of [`INIT_READS`] - which every forbidden request is not.
    pub fn setup(&self) -> Option<Setup> {
        if FORBIDDEN_REQUESTS.contains(&self.request) || !INIT_READS.contains(self) {
            return None;
        }
        Some((VENDOR_IN, self.request, self.value, 0, self.length))
    }
}

/// When the next keep-alive is due, given when the last one went out.
pub fn keepalive_due(since_last: Option<Duration>) -> bool {
    since_last.is_none_or(|elapsed| elapsed >= KEEPALIVE_EVERY)
}

/// How long one read may block so the keep-alive is never late: whatever is
/// left of the caller's wait, but never past the next keep-alive.
pub fn read_slice(remaining: Duration, since_last: Duration) -> Duration {
    remaining.min(KEEPALIVE_EVERY.saturating_sub(since_last))
}

/// How one system's USB stack moves the session's bytes. Everything the
/// session decides - the start-up reads, the keep-alive cadence, how long a
/// read may block - lives in [`Session`]; a link only carries it out.
pub trait Link {
    type Error;

    /// One vendor control read; its answer is not needed.
    fn control_in(&mut self, setup: Setup);

    /// Interface 1 to [`DISPLAY_ALT_SETTING`], ready for isochronous writes
    /// to [`DISPLAY_ENDPOINT`]. `false` when it could not be set up: input is
    /// still read, with no keep-alive.
    fn start_display(&mut self) -> bool;

    /// One isochronous transfer to [`DISPLAY_ENDPOINT`]: whole
    /// [`PACKET_SIZE`] packets, at most [`TRANSFER_LEN`] bytes (the sync
    /// packet and the message, as [`Painter::next`] builds it), given up
    /// after `wait`. A failed write is left behind.
    fn write_transfer(&mut self, transfer: &[u8], wait: Duration);

    /// One input report from [`INPUT_ENDPOINT`] into `buffer`, waiting at
    /// most `wait`; `Ok(None)` when none came in that time.
    fn read_report(
        &mut self,
        buffer: &mut [u8; REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, Self::Error>;
}

/// How long one display write may take before it is given up.
pub const WRITE_WAIT: Duration = Duration::from_millis(100);

/// The largest transfer the display takes, sync packet included.
pub const TRANSFER_LEN: usize = MAX_TRANSFER_PACKETS * PACKET_SIZE;

/// A session with the controller over any [`Link`].
pub struct Session<L> {
    link: L,
    display: bool,
    // Boxed: it holds two pages, and the input enum stays small.
    painter: Box<Painter>,
    report: Box<[u8; REPORT_LEN]>,
}

impl<L: Link> Session<L> {
    /// Starts the session: the display interface first, then the documented
    /// start-up reads. A controller that refuses either is still read.
    pub fn start(mut link: L) -> Self {
        let display = link.start_display();
        for read in INIT_READS {
            if let Some(setup) = read.setup() {
                link.control_in(setup);
            }
        }
        Self {
            link,
            display,
            painter: Box::default(),
            report: Box::new([0u8; REPORT_LEN]),
        }
    }

    /// Whether the display interface is up (and so the keep-alive goes out).
    pub fn has_display(&self) -> bool {
        self.display
    }

    pub fn link(&self) -> &L {
        &self.link
    }

    /// Sends what the display is due: the keep-alive, an acknowledgement,
    /// a heartbeat or the next tile of the newest page ([`Painter`]).
    fn paint(&mut self) {
        if !self.display {
            return;
        }
        if let Some(page) = screen::latest() {
            self.painter.show(&page);
        }
        let Some(transfer) = self.painter.next(Instant::now()) else {
            return;
        };
        let length = transfer.len().min(TRANSFER_LEN);
        self.link.write_transfer(&transfer[..length], WRITE_WAIT);
    }

    /// Waits up to `timeout` for the next report; `Ok(None)` when none came.
    /// The display is kept fed on time while it waits, and the controller's
    /// requests for an acknowledgement are answered.
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, L::Error> {
        let deadline = Instant::now() + timeout;
        loop {
            self.paint();
            let remaining = deadline.saturating_duration_since(Instant::now());
            let slice = if self.display {
                remaining.min(self.painter.wait(Instant::now()))
            } else {
                remaining
            };
            match self.link.read_report(&mut self.report, slice)? {
                Some(read) => {
                    let read = read.min(REPORT_LEN);
                    if display::asks_for_ack(&self.report[..read]) {
                        self.painter.acknowledge();
                    }
                    return Ok(Report::parse(&self.report[..read]));
                }
                None if Instant::now() >= deadline => return Ok(None),
                None => continue,
            }
        }
    }
}
