//! The controller over WinUSB, once Polaris' own driver package is on it
//! (`polaris-stream100.inf`: WinUSB for `USB\VID_06F8&PID_E053`, registering
//! [`DEVICE_INTERFACE_GUID`]). No Hercules software is involved.
//!
//! The session follows [`crate::session`]: interface 1 to alternate setting 1,
//! the two start-up vendor reads, then reports read from endpoint `0x81` while
//! a keep-alive goes to endpoint `0x01` at least twice a second. WinUSB is the
//! function driver of the whole device, so interface 0 comes from
//! `WinUsb_Initialize` and interface 1 from `WinUsb_GetAssociatedInterface`.
//! Windows' USB stack has already selected configuration 1 by then.
//!
//! Isochronous writes go through `WinUsb_WriteIsochPipeAsap` (Windows 8.1+);
//! `nusb` 0.2 has no isochronous transfers, which is why this route talks to
//! WinUSB directly through the `windows` crate the add-on already pins.

use crate::display::PACKET_SIZE;
use crate::report::{Report, REPORT_LEN};
use crate::session::{
    keepalive_due, read_slice, KeepAlive, DEVICE_INTERFACE_GUID_U128, DISPLAY_ALT_SETTING,
    DISPLAY_ENDPOINT, INIT_READS, INPUT_ENDPOINT,
};
use crate::transport::TransportError;
use std::ffi::c_void;
use std::time::{Duration, Instant};
use windows::core::{GUID, PCWSTR};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
    SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
    SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
};
use windows::Win32::Devices::Usb::{
    WinUsb_ControlTransfer, WinUsb_Free, WinUsb_GetAssociatedInterface, WinUsb_Initialize,
    WinUsb_ReadPipe, WinUsb_RegisterIsochBuffer, WinUsb_SetCurrentAlternateSetting,
    WinUsb_UnregisterIsochBuffer, WinUsb_WriteIsochPipeAsap, WINUSB_INTERFACE_HANDLE,
    WINUSB_SETUP_PACKET,
};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_IO_PENDING, ERROR_SHARING_VIOLATION, GENERIC_READ,
    GENERIC_WRITE, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

/// How long one keep-alive write may take before it is given up.
const WRITE_WAIT_MS: u32 = 100;

/// The NUL-terminated paths of every present device interface of `guid`.
pub fn interface_paths(guid: &GUID) -> Vec<Vec<u16>> {
    let mut found = Vec::new();
    // SAFETY: plain SetupAPI calls; every buffer outlives the call that fills
    // it and the device list is destroyed before returning.
    unsafe {
        let Ok(set) = SetupDiGetClassDevsW(
            Some(guid),
            PCWSTR::null(),
            None,
            DIGCF_PRESENT | DIGCF_DEVICEINTERFACE,
        ) else {
            return found;
        };
        let mut index = 0;
        loop {
            let mut data = SP_DEVICE_INTERFACE_DATA {
                cbSize: size_of::<SP_DEVICE_INTERFACE_DATA>() as u32,
                ..Default::default()
            };
            if SetupDiEnumDeviceInterfaces(set, None, guid, index, &mut data).is_err() {
                break;
            }
            index += 1;
            let mut needed = 0u32;
            let _ = SetupDiGetDeviceInterfaceDetailW(set, &data, None, 0, Some(&mut needed), None);
            if needed == 0 {
                continue;
            }
            let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
            let detail = buffer.as_mut_ptr() as *mut SP_DEVICE_INTERFACE_DETAIL_DATA_W;
            (*detail).cbSize = size_of::<SP_DEVICE_INTERFACE_DETAIL_DATA_W>() as u32;
            if SetupDiGetDeviceInterfaceDetailW(set, &data, Some(detail), needed, None, None)
                .is_err()
            {
                continue;
            }
            let start = std::ptr::addr_of!((*detail).DevicePath) as *const u16;
            let mut len = 0;
            while *start.add(len) != 0 {
                len += 1;
            }
            let mut path = std::slice::from_raw_parts(start, len).to_vec();
            path.push(0);
            found.push(path);
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    found
}

/// An unnamed manual-reset event, as overlapped transfers want.
fn event() -> Result<HANDLE, TransportError> {
    // SAFETY: creates a new event owned by the caller.
    unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map_err(|error| TransportError::Io(error.message()))
}

/// The controller, opened through Polaris' WinUSB driver.
pub struct WinUsbInput {
    file: HANDLE,
    input: WINUSB_INTERFACE_HANDLE,
    /// Interface 1, or null when it could not be set up: input is still read,
    /// with no keep-alive.
    display: WINUSB_INTERFACE_HANDLE,
    /// The registered isochronous buffer, or null.
    isoch: *mut c_void,
    keepalive: KeepAlive,
    last_keepalive: Option<Instant>,
    read_event: HANDLE,
    write_event: HANDLE,
    // Boxed: the system writes into these while a transfer is pending, so
    // they must not move.
    read_overlapped: Box<OVERLAPPED>,
    write_overlapped: Box<OVERLAPPED>,
    report: Box<[u8; REPORT_LEN]>,
    packet: Box<[u8; PACKET_SIZE]>,
    pending: bool,
}

// SAFETY: plain kernel and WinUSB handles, usable from any thread; the struct
// is only ever used by one thread at a time (`&mut self`).
unsafe impl Send for WinUsbInput {}

impl WinUsbInput {
    /// Opens the controller, or [`TransportError::NotFound`] when Polaris'
    /// driver is not on it (no device interface of ours is present).
    pub fn open() -> Result<Self, TransportError> {
        let guid = GUID::from_u128(DEVICE_INTERFACE_GUID_U128);
        let path = interface_paths(&guid)
            .into_iter()
            .next()
            .ok_or(TransportError::NotFound)?;
        // SAFETY: `path` is NUL-terminated (built that way in `interface_paths`).
        let file = unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED,
                None,
            )
        }
        .map_err(|error| {
            let code = error.code();
            if code == ERROR_ACCESS_DENIED.to_hresult()
                || code == ERROR_SHARING_VIOLATION.to_hresult()
            {
                TransportError::Busy
            } else {
                TransportError::Io(error.message())
            }
        })?;
        let mut opened = Self {
            file,
            input: WINUSB_INTERFACE_HANDLE::default(),
            display: WINUSB_INTERFACE_HANDLE::default(),
            isoch: std::ptr::null_mut(),
            keepalive: KeepAlive::default(),
            last_keepalive: None,
            read_event: HANDLE::default(),
            write_event: HANDLE::default(),
            read_overlapped: Box::default(),
            write_overlapped: Box::default(),
            report: Box::new([0u8; REPORT_LEN]),
            packet: Box::new([0u8; PACKET_SIZE]),
            pending: false,
        };
        // From here on `Drop` releases whatever was set up.
        opened.read_event = event()?;
        opened.write_event = event()?;
        // SAFETY: `file` is an open WinUSB device handle.
        unsafe { WinUsb_Initialize(opened.file, &mut opened.input) }
            .map_err(|error| TransportError::Io(error.message()))?;
        opened.start_display();
        opened.start_up_reads();
        Ok(opened)
    }

    /// Interface 1 to its alternate setting and the keep-alive buffer
    /// registered; on any failure the display stays off and input goes on.
    fn start_display(&mut self) {
        let mut display = WINUSB_INTERFACE_HANDLE::default();
        // SAFETY: `input` is initialized; index 0 is the interface after it.
        if unsafe { WinUsb_GetAssociatedInterface(self.input, 0, &mut display) }.is_err() {
            return;
        }
        self.display = display;
        // SAFETY: `display` is a live interface handle.
        if unsafe { WinUsb_SetCurrentAlternateSetting(self.display, DISPLAY_ALT_SETTING) }.is_err()
        {
            return;
        }
        let mut isoch = std::ptr::null_mut();
        // SAFETY: `packet` is boxed and outlives the registration (released in `drop`).
        if unsafe {
            WinUsb_RegisterIsochBuffer(
                self.display,
                DISPLAY_ENDPOINT,
                &mut self.packet[..],
                &mut isoch,
            )
        }
        .is_ok()
        {
            self.isoch = isoch;
        }
    }

    /// The documented start-up reads. Their answers are not needed, and a
    /// controller that refuses one is still read.
    fn start_up_reads(&mut self) {
        for read in INIT_READS {
            let Some((kind, request, value, index, length)) = read.setup() else {
                continue;
            };
            let setup = WINUSB_SETUP_PACKET {
                RequestType: kind,
                Request: request,
                Value: value,
                Index: index,
                Length: length,
            };
            let mut answer = [0u8; 8];
            let mut got = 0u32;
            // SAFETY: a synchronous control read into a local buffer.
            let _ = unsafe {
                WinUsb_ControlTransfer(
                    self.input,
                    setup,
                    Some(&mut answer[..usize::from(length)]),
                    Some(&mut got),
                    None,
                )
            };
        }
    }

    /// Sends a keep-alive when one is due. A failed write is left for the next
    /// one: input keeps being read either way.
    fn keep_alive(&mut self) {
        if self.isoch.is_null() || !keepalive_due(self.last_keepalive.map(|at| at.elapsed())) {
            return;
        }
        self.last_keepalive = Some(Instant::now());
        *self.packet = self.keepalive.next_packet();
        *self.write_overlapped = OVERLAPPED {
            hEvent: self.write_event,
            ..Default::default()
        };
        // SAFETY: the buffer is registered and boxed, the overlapped boxed;
        // the write is waited for (or cancelled and waited for) below, so
        // neither is touched by the system after this function returns.
        unsafe {
            let started = WinUsb_WriteIsochPipeAsap(
                self.isoch,
                0,
                PACKET_SIZE as u32,
                false,
                Some(&*self.write_overlapped),
            );
            match started {
                Ok(()) => {}
                Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
                Err(_) => return,
            }
            if WaitForSingleObject(self.write_event, WRITE_WAIT_MS) != WAIT_OBJECT_0 {
                let _ = CancelIoEx(self.file, Some(&*self.write_overlapped));
            }
            let mut written = 0u32;
            let _ = GetOverlappedResult(self.file, &*self.write_overlapped, &mut written, true);
        }
    }

    /// Waits up to `timeout` for the next report; `Ok(None)` when none came.
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, TransportError> {
        let deadline = Instant::now() + timeout;
        loop {
            self.keep_alive();
            if !self.pending {
                *self.read_overlapped = OVERLAPPED {
                    hEvent: self.read_event,
                    ..Default::default()
                };
                // SAFETY: buffer and overlapped are boxed and stay alive until
                // the read completes or is cancelled in `drop`.
                let started = unsafe {
                    WinUsb_ReadPipe(
                        self.input,
                        INPUT_ENDPOINT,
                        Some(&mut self.report[..]),
                        None,
                        Some(&*self.read_overlapped),
                    )
                };
                match started {
                    Ok(()) => {}
                    Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
                    Err(error) => return Err(TransportError::Io(error.message())),
                }
                self.pending = true;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let slice = if self.isoch.is_null() {
                remaining
            } else {
                let since = self.last_keepalive.map_or(Duration::MAX, |at| at.elapsed());
                read_slice(remaining, since)
            };
            let wait = u32::try_from(slice.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: waits on the event this struct owns.
            match unsafe { WaitForSingleObject(self.read_event, wait) } {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => {
                    if Instant::now() >= deadline {
                        return Ok(None);
                    }
                    continue;
                }
                _ => {
                    return Err(TransportError::Io(
                        "waiting for the controller failed".into(),
                    ))
                }
            }
            let mut read = 0u32;
            // SAFETY: the read has completed (its event is set).
            let done =
                unsafe { GetOverlappedResult(self.file, &*self.read_overlapped, &mut read, false) };
            self.pending = false;
            done.map_err(|error| TransportError::Io(error.message()))?;
            let read = (read as usize).min(REPORT_LEN);
            return Ok(Report::parse(&self.report[..read]));
        }
    }
}

impl Drop for WinUsbInput {
    fn drop(&mut self) {
        // SAFETY: cancels this struct's own read and waits for it, so the
        // system is done with the buffers; then every handle opened in `open`
        // is released once, in reverse order. Null handles are skipped.
        unsafe {
            if self.pending {
                let _ = CancelIoEx(self.file, Some(&*self.read_overlapped));
                let mut read = 0u32;
                let _ = GetOverlappedResult(self.file, &*self.read_overlapped, &mut read, true);
            }
            if !self.isoch.is_null() {
                let _ = WinUsb_UnregisterIsochBuffer(self.isoch);
            }
            if !self.display.is_invalid() {
                let _ = WinUsb_Free(self.display);
            }
            if !self.input.is_invalid() {
                let _ = WinUsb_Free(self.input);
            }
            for handle in [self.write_event, self.read_event, self.file] {
                if !handle.is_invalid() {
                    let _ = CloseHandle(handle);
                }
            }
        }
    }
}
