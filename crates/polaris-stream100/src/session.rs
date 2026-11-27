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
//!
//! The display is fed from a thread of its own, so a display write (up to
//! [`WRITE_WAIT`]) never holds back an input report: the input and display
//! interfaces are independent, and a report is handed back the moment it
//! arrives.

use crate::display::{self, MAX_TRANSFER_PACKETS, PACKET_SIZE};
use crate::report::{Report, REPORT_LEN};
use crate::screen::{self, Painter};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
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
///
/// Once started, [`Link::write_transfer`] is called from the display thread
/// while [`Link::read_report`] may be waiting on the session's own thread, so
/// a link keeps the two directions' state apart.
pub trait Link: Send + Sync + 'static {
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
    fn write_transfer(&self, transfer: &[u8], wait: Duration);

    /// One input report from [`INPUT_ENDPOINT`] into `buffer`, waiting at
    /// most `wait`; `Ok(None)` when none came in that time.
    fn read_report(
        &self,
        buffer: &mut [u8; REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, Self::Error>;
}

/// How long one display write may take before it is given up.
pub const WRITE_WAIT: Duration = Duration::from_millis(100);

/// The largest transfer the display takes, sync packet included.
pub const TRANSFER_LEN: usize = MAX_TRANSFER_PACKETS * PACKET_SIZE;

/// What the session tells its display thread.
enum Signal {
    /// The controller asked for an acknowledgement.
    Ack,
    Stop,
}

/// The display thread: the keep-alive, acknowledgements and the newest page.
struct Display {
    signals: Sender<Signal>,
    thread: Option<JoinHandle<()>>,
}

/// A session with the controller over any [`Link`].
pub struct Session<L: Link> {
    link: Arc<L>,
    display: Option<Display>,
    report: Box<[u8; REPORT_LEN]>,
}

/// Feeds the display until told to stop: whatever [`Painter`] has due, and in
/// between, waits for the next slot or a signal from the session.
fn pump<L: Link>(link: &L, signals: &Receiver<Signal>) {
    let mut painter = Box::<Painter>::default();
    loop {
        if let Some(page) = screen::latest() {
            painter.show(&page);
        }
        if let Some(transfer) = painter.next(Instant::now()) {
            let length = transfer.len().min(TRANSFER_LEN);
            link.write_transfer(&transfer[..length], WRITE_WAIT);
        }
        match signals.recv_timeout(painter.wait(Instant::now())) {
            Ok(Signal::Ack) => painter.acknowledge(),
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

impl<L: Link> Session<L> {
    /// Starts the session: the display interface first, then the documented
    /// start-up reads, then the display thread. A controller that refuses
    /// either is still read.
    pub fn start(mut link: L) -> Self {
        let display = link.start_display();
        for read in INIT_READS {
            if let Some(setup) = read.setup() {
                link.control_in(setup);
            }
        }
        let link = Arc::new(link);
        let display = display.then(|| {
            let (signals, received) = mpsc::channel();
            let shared = Arc::clone(&link);
            let thread = std::thread::Builder::new()
                .name("stream100-display".into())
                .spawn(move || pump(&*shared, &received))
                .ok();
            Display { signals, thread }
        });
        Self {
            link,
            display: display.filter(|display| display.thread.is_some()),
            report: Box::new([0u8; REPORT_LEN]),
        }
    }

    /// Whether the display interface is up (and so the keep-alive goes out).
    pub fn has_display(&self) -> bool {
        self.display.is_some()
    }

    pub fn link(&self) -> &L {
        &self.link
    }

    /// Waits up to `timeout` for the next report; `Ok(None)` when none came.
    /// The display thread keeps the controller fed meanwhile; a request for
    /// an acknowledgement is passed on to it.
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, L::Error> {
        let Some(read) = self.link.read_report(&mut self.report, timeout)? else {
            return Ok(None);
        };
        let read = read.min(REPORT_LEN);
        if display::asks_for_ack(&self.report[..read]) {
            if let Some(display) = &self.display {
                let _ = display.signals.send(Signal::Ack);
            }
        }
        Ok(Report::parse(&self.report[..read]))
    }
}

impl<L: Link> Drop for Session<L> {
    fn drop(&mut self) {
        if let Some(mut display) = self.display.take() {
            let _ = display.signals.send(Signal::Stop);
            if let Some(thread) = display.thread.take() {
                let _ = thread.join();
            }
        }
    }
}
