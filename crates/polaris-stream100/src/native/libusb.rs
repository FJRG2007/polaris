//! The controller over libusb, on Linux and macOS: the same
//! [`crate::session::Session`] the WinUSB route runs on Windows, carried by
//! libusb instead. libusb is built from its own source into the module, so
//! nothing is installed on the machine.
//!
//! Both interfaces are vendor-specific (class `0xFF`), so neither Linux nor
//! macOS binds a class driver to them and libusb claims them directly
//! (cont1nuity/hercules-stream-linux, `docs/DEVICE-IO.md`). Auto-detach is
//! still asked for on Linux, so a driver some other program bound is let go
//! while Polaris holds the controller and given back after.
//!
//! On Linux opening needs the `uaccess` udev rule for `06f8:e053`, which the
//! desktop app installs with the plugin (`clients/desktop/src/main/plugins/
//! hercules-udev.ts`); without it the open answers
//! [`TransportError::NoAccess`]. macOS asks for nothing.
//!
//! Reports are read with a synchronous interrupt transfer per wait. A wait
//! that times out cancels its transfer; a report that lands exactly then is
//! lost, which costs nothing for the knobs (their counters are absolute) and
//! at worst one press for a button released inside the same instant.

use crate::display::PACKET_SIZE;
use crate::report::REPORT_LEN;
use crate::session::{
    Link, Session, Setup, DISPLAY_ALT_SETTING, DISPLAY_ENDPOINT, DISPLAY_INTERFACE, INPUT_ENDPOINT,
    INPUT_INTERFACE, TRANSFER_LEN,
};
use crate::transport::TransportError;
use crate::{PRODUCT_ID, VENDOR_ID};
use libusb1_sys::constants::{
    LIBUSB_ERROR_ACCESS, LIBUSB_ERROR_BUSY, LIBUSB_ERROR_NOT_FOUND, LIBUSB_ERROR_NO_DEVICE,
    LIBUSB_ERROR_TIMEOUT,
};
use libusb1_sys::*;
use std::ffi::{c_int, c_void};
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one start-up control read may take.
const CONTROL_WAIT_MS: u32 = 500;

/// What a libusb error means to the reader.
pub fn refused(code: c_int) -> TransportError {
    match code {
        LIBUSB_ERROR_ACCESS => TransportError::NoAccess,
        LIBUSB_ERROR_NO_DEVICE | LIBUSB_ERROR_NOT_FOUND => TransportError::NotFound,
        LIBUSB_ERROR_BUSY => TransportError::Busy,
        other => TransportError::Io(format!("libusb error {other}")),
    }
}

/// libusb waits in whole milliseconds and reads 0 as "forever".
fn millis(wait: Duration) -> u32 {
    u32::try_from(wait.as_millis()).unwrap_or(u32::MAX).max(1)
}

/// The controller, opened through libusb.
pub type LibUsbInput = Session<LibUsbLink>;

/// Opens the controller, or [`TransportError::NotFound`] when it is not
/// plugged in.
pub fn open() -> Result<LibUsbInput, TransportError> {
    LibUsbLink::open().map(Session::start)
}

/// How libusb carries a [`Session`].
pub struct LibUsbLink {
    context: *mut libusb_context,
    handle: *mut libusb_device_handle,
    input_claimed: bool,
    display_claimed: bool,
    /// The display thread's buffer; the input side reads into the caller's.
    packet: Mutex<Box<[u8; TRANSFER_LEN]>>,
}

// SAFETY: a libusb context and handle are usable from any thread, and libusb
// supports a synchronous read on one thread while another handles the events
// of its own asynchronous write ("Multi-threaded applications and asynchronous
// I/O" in the libusb documentation). The write's buffer is behind a lock.
unsafe impl Send for LibUsbLink {}
unsafe impl Sync for LibUsbLink {}

/// Set by the isochronous write's callback when libusb is done with it.
extern "system" fn write_done(transfer: *mut libusb_transfer) {
    // SAFETY: `user_data` is the `c_int` flag `write_transfer` passed, alive
    // until the transfer has completed (which this call reports).
    unsafe { *((*transfer).user_data as *mut c_int) = 1 };
}

impl LibUsbLink {
    fn open() -> Result<Self, TransportError> {
        let mut link = Self {
            context: null_mut(),
            handle: null_mut(),
            input_claimed: false,
            display_claimed: false,
            packet: Mutex::new(Box::new([0u8; TRANSFER_LEN])),
        };
        // From here on `Drop` releases whatever was set up.
        // SAFETY: plain libusb calls; the device list is freed before
        // returning and the opened handle is owned by `link`.
        unsafe {
            let code = libusb_init(&mut link.context);
            if code < 0 {
                link.context = null_mut();
                return Err(TransportError::Io(format!("libusb error {code}")));
            }
            let mut list: *const *mut libusb_device = null();
            let count = libusb_get_device_list(link.context, &mut list);
            if count < 0 {
                return Err(refused(count as c_int));
            }
            let mut opened = Err(TransportError::NotFound);
            for index in 0..count as usize {
                let device = *list.add(index);
                let mut descriptor = std::mem::zeroed::<libusb_device_descriptor>();
                if libusb_get_device_descriptor(device, &mut descriptor) < 0
                    || descriptor.idVendor != VENDOR_ID
                    || descriptor.idProduct != PRODUCT_ID
                {
                    continue;
                }
                let code = libusb_open(device, &mut link.handle);
                opened = if code < 0 {
                    link.handle = null_mut();
                    Err(refused(code))
                } else {
                    Ok(())
                };
                break;
            }
            libusb_free_device_list(list, 1);
            opened?;
            // Not every system supports it (macOS answers "not supported"),
            // and a vendor interface has no class driver to detach anyway.
            let _ = libusb_set_auto_detach_kernel_driver(link.handle, 1);
            let code = libusb_claim_interface(link.handle, c_int::from(INPUT_INTERFACE));
            if code < 0 {
                return Err(refused(code));
            }
            link.input_claimed = true;
        }
        Ok(link)
    }
}

impl Link for LibUsbLink {
    type Error = TransportError;

    fn control_in(&mut self, (kind, request, value, index, length): Setup) {
        let mut answer = [0u8; 8];
        let length = length.min(answer.len() as u16);
        // SAFETY: a synchronous control read into a local buffer of at least
        // `length` bytes.
        let _ = unsafe {
            libusb_control_transfer(
                self.handle,
                kind,
                request,
                value,
                index,
                answer.as_mut_ptr(),
                length,
                CONTROL_WAIT_MS,
            )
        };
    }

    fn start_display(&mut self) -> bool {
        let interface = c_int::from(DISPLAY_INTERFACE);
        // SAFETY: `handle` is open; the interface is released in `drop`.
        unsafe {
            if libusb_claim_interface(self.handle, interface) < 0 {
                return false;
            }
            self.display_claimed = true;
            libusb_set_interface_alt_setting(
                self.handle,
                interface,
                c_int::from(DISPLAY_ALT_SETTING),
            ) >= 0
        }
    }

    fn write_transfer(&self, transfer: &[u8], wait: Duration) {
        let length = transfer.len().min(TRANSFER_LEN);
        if !self.display_claimed || length == 0 {
            return;
        }
        // Whole packets (the painter's transfers always are; a short tail is
        // padded with zeros). TRANSFER_LEN is whole packets, so it still fits.
        let count = length.div_ceil(PACKET_SIZE);
        let padded = count * PACKET_SIZE;
        let mut packet = self
            .packet
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        packet[..length].copy_from_slice(&transfer[..length]);
        packet[length..padded].fill(0);
        let mut done: c_int = 0;
        // SAFETY: `count` isochronous packets from the boxed buffer. The transfer
        // is always waited for - cancelled first when it outlives `wait` -
        // before it is freed, so libusb never touches the buffer, the flag or
        // the transfer after this function returns.
        unsafe {
            let transfer = libusb_alloc_transfer(count as c_int);
            if transfer.is_null() {
                return;
            }
            libusb_fill_iso_transfer(
                transfer,
                self.handle,
                DISPLAY_ENDPOINT,
                packet.as_mut_ptr(),
                padded as c_int,
                count as c_int,
                write_done,
                (&mut done as *mut c_int).cast::<c_void>(),
                millis(wait),
            );
            libusb_set_iso_packet_lengths(transfer, PACKET_SIZE as u32);
            if libusb_submit_transfer(transfer) < 0 {
                libusb_free_transfer(transfer);
                return;
            }
            let deadline = Instant::now() + wait;
            let mut cancelled = false;
            while done == 0 {
                if !cancelled && Instant::now() >= deadline {
                    libusb_cancel_transfer(transfer);
                    cancelled = true;
                }
                let tv = libc::timeval {
                    tv_sec: 0,
                    tv_usec: 10_000,
                };
                if libusb_handle_events_timeout_completed(self.context, &tv, &mut done) < 0
                    && !cancelled
                {
                    libusb_cancel_transfer(transfer);
                    cancelled = true;
                }
            }
            libusb_free_transfer(transfer);
        }
    }

    fn read_report(
        &self,
        buffer: &mut [u8; REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, TransportError> {
        let mut read: c_int = 0;
        // SAFETY: a synchronous interrupt read into `buffer`, which is
        // REPORT_LEN bytes long.
        let code = unsafe {
            libusb_interrupt_transfer(
                self.handle,
                INPUT_ENDPOINT,
                buffer.as_mut_ptr(),
                REPORT_LEN as c_int,
                &mut read,
                millis(wait),
            )
        };
        let read = usize::try_from(read).unwrap_or(0).min(REPORT_LEN);
        match code {
            0 => Ok(Some(read)),
            LIBUSB_ERROR_TIMEOUT if read > 0 => Ok(Some(read)),
            LIBUSB_ERROR_TIMEOUT => Ok(None),
            code => Err(refused(code)),
        }
    }
}

impl Drop for LibUsbLink {
    fn drop(&mut self) {
        // SAFETY: releases what `open` and `start_display` set up, once, in
        // reverse order; null handles are skipped.
        unsafe {
            if !self.handle.is_null() {
                if self.display_claimed {
                    let _ = libusb_release_interface(self.handle, c_int::from(DISPLAY_INTERFACE));
                }
                if self.input_claimed {
                    let _ = libusb_release_interface(self.handle, c_int::from(INPUT_INTERFACE));
                }
                libusb_close(self.handle);
            }
            if !self.context.is_null() {
                libusb_exit(self.context);
            }
        }
    }
}
