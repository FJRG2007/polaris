//! The controller over WinUSB, once Polaris' own driver package is on it
//! (`polaris-stream100.inf`: WinUSB for `USB\VID_06F8&PID_E053`, registering
//! [`DEVICE_INTERFACE_GUID`]). No Hercules software is involved.
//!
//! The session is [`crate::session::Session`], the same one Linux and macOS
//! run; this module is only its [`Link`]: how WinUSB opens the device and
//! moves the bytes. WinUSB is the
//! function driver of the whole device, so interface 0 comes from
//! `WinUsb_Initialize` and interface 1 from `WinUsb_GetAssociatedInterface`.
//! Windows' USB stack has already selected configuration 1 by then.
//!
//! Isochronous writes go through `WinUsb_WriteIsochPipeAsap` (Windows 8.1+);
//! `nusb` 0.2 has no isochronous transfers, which is why this route talks to
//! WinUSB directly through the `windows` crate the plugin already pins.

use crate::report::REPORT_LEN;
use crate::session::{
    Link, Session, Setup, DEVICE_INTERFACE_GUID_U128, DISPLAY_ALT_SETTING, DISPLAY_ENDPOINT,
    INPUT_ENDPOINT, TRANSFER_LEN,
};
use crate::transport::TransportError;
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::Duration;
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

fn millis(wait: Duration) -> u32 {
    u32::try_from(wait.as_millis()).unwrap_or(u32::MAX - 1)
}

/// The controller, opened through Polaris' WinUSB driver.
pub type WinUsbInput = Session<WinUsbLink>;

/// Opens the controller, or [`TransportError::NotFound`] when Polaris' driver
/// is not on it (no device interface of ours is present).
pub fn open() -> Result<WinUsbInput, TransportError> {
    WinUsbLink::open().map(Session::start)
}

/// How WinUSB carries a [`Session`].
pub struct WinUsbLink {
    file: HANDLE,
    input: WINUSB_INTERFACE_HANDLE,
    /// Interface 1, or null when it could not be set up.
    display: WINUSB_INTERFACE_HANDLE,
    /// The registered isochronous buffer, or null.
    isoch: *mut c_void,
    read_event: HANDLE,
    write_event: HANDLE,
    read: Mutex<ReadSide>,
    write: Mutex<WriteSide>,
}

/// The input direction's state, used by the session's thread.
struct ReadSide {
    // Boxed: the system writes into these while a read is pending, so they
    // must not move.
    overlapped: Box<OVERLAPPED>,
    report: Box<[u8; REPORT_LEN]>,
    pending: bool,
}

/// The display direction's state, used by the display thread.
struct WriteSide {
    // Boxed: registered with WinUSB and read while a write is pending.
    overlapped: Box<OVERLAPPED>,
    packet: Box<[u8; TRANSFER_LEN]>,
}

// SAFETY: plain kernel and WinUSB handles, usable from any thread. Each
// direction's buffers and overlapped are behind their own lock, and the two
// directions use different events, pipes and overlapped structures, which
// WinUSB allows concurrently on one device handle.
unsafe impl Send for WinUsbLink {}
unsafe impl Sync for WinUsbLink {}

impl WinUsbLink {
    fn open() -> Result<Self, TransportError> {
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
            read_event: HANDLE::default(),
            write_event: HANDLE::default(),
            read: Mutex::new(ReadSide {
                overlapped: Box::default(),
                report: Box::new([0u8; REPORT_LEN]),
                pending: false,
            }),
            write: Mutex::new(WriteSide {
                overlapped: Box::default(),
                packet: Box::new([0u8; TRANSFER_LEN]),
            }),
        };
        // From here on `Drop` releases whatever was set up.
        opened.read_event = event()?;
        opened.write_event = event()?;
        // SAFETY: `file` is an open WinUSB device handle.
        unsafe { WinUsb_Initialize(opened.file, &mut opened.input) }
            .map_err(|error| TransportError::Io(error.message()))?;
        Ok(opened)
    }
}

impl Link for WinUsbLink {
    type Error = TransportError;

    fn control_in(&mut self, (kind, request, value, index, length): Setup) {
        let setup = WINUSB_SETUP_PACKET {
            RequestType: kind,
            Request: request,
            Value: value,
            Index: index,
            Length: length,
        };
        let mut answer = [0u8; 8];
        let length = usize::from(length).min(answer.len());
        let mut got = 0u32;
        // SAFETY: a synchronous control read into a local buffer.
        let _ = unsafe {
            WinUsb_ControlTransfer(
                self.input,
                setup,
                Some(&mut answer[..length]),
                Some(&mut got),
                None,
            )
        };
    }

    fn start_display(&mut self) -> bool {
        let mut display = WINUSB_INTERFACE_HANDLE::default();
        // SAFETY: `input` is initialized; index 0 is the interface after it.
        if unsafe { WinUsb_GetAssociatedInterface(self.input, 0, &mut display) }.is_err() {
            return false;
        }
        self.display = display;
        // SAFETY: `display` is a live interface handle.
        if unsafe { WinUsb_SetCurrentAlternateSetting(self.display, DISPLAY_ALT_SETTING) }.is_err()
        {
            return false;
        }
        let mut isoch = std::ptr::null_mut();
        let write = self
            .write
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // SAFETY: `packet` is boxed and outlives the registration (released in `drop`).
        if unsafe {
            WinUsb_RegisterIsochBuffer(
                self.display,
                DISPLAY_ENDPOINT,
                &mut write.packet[..],
                &mut isoch,
            )
        }
        .is_err()
        {
            return false;
        }
        self.isoch = isoch;
        true
    }

    fn write_transfer(&self, transfer: &[u8], wait: Duration) {
        if self.isoch.is_null() {
            return;
        }
        let mut write = self
            .write
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let write = &mut *write;
        let length = transfer.len().min(TRANSFER_LEN);
        write.packet[..length].copy_from_slice(&transfer[..length]);
        *write.overlapped = OVERLAPPED {
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
                length as u32,
                false,
                Some(&*write.overlapped),
            );
            match started {
                Ok(()) => {}
                Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
                Err(_) => return,
            }
            if WaitForSingleObject(self.write_event, millis(wait)) != WAIT_OBJECT_0 {
                let _ = CancelIoEx(self.file, Some(&*write.overlapped));
            }
            let mut written = 0u32;
            let _ = GetOverlappedResult(self.file, &*write.overlapped, &mut written, true);
        }
    }

    fn read_report(
        &self,
        buffer: &mut [u8; REPORT_LEN],
        wait: Duration,
    ) -> Result<Option<usize>, TransportError> {
        let mut read_side = self
            .read
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let side = &mut *read_side;
        if !side.pending {
            *side.overlapped = OVERLAPPED {
                hEvent: self.read_event,
                ..Default::default()
            };
            // SAFETY: buffer and overlapped are boxed and stay alive until
            // the read completes or is cancelled in `drop`.
            let started = unsafe {
                WinUsb_ReadPipe(
                    self.input,
                    INPUT_ENDPOINT,
                    Some(&mut side.report[..]),
                    None,
                    Some(&*side.overlapped),
                )
            };
            match started {
                Ok(()) => {}
                Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
                Err(error) => return Err(TransportError::Io(error.message())),
            }
            side.pending = true;
        }
        // SAFETY: waits on the event this struct owns.
        match unsafe { WaitForSingleObject(self.read_event, millis(wait)) } {
            WAIT_OBJECT_0 => {}
            // The read stays pending for the next call.
            WAIT_TIMEOUT => return Ok(None),
            _ => {
                return Err(TransportError::Io(
                    "waiting for the controller failed".into(),
                ))
            }
        }
        let mut read = 0u32;
        // SAFETY: the read has completed (its event is set).
        let done =
            unsafe { GetOverlappedResult(self.file, &*side.overlapped, &mut read, false) };
        side.pending = false;
        done.map_err(|error| TransportError::Io(error.message()))?;
        let read = (read as usize).min(REPORT_LEN);
        buffer[..read].copy_from_slice(&side.report[..read]);
        Ok(Some(read))
    }
}

impl Drop for WinUsbLink {
    fn drop(&mut self) {
        // SAFETY: cancels this struct's own read and waits for it, so the
        // system is done with the buffers; then every handle opened in `open`
        // is released once, in reverse order. Null handles are skipped.
        let side = self
            .read
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        unsafe {
            if side.pending {
                let _ = CancelIoEx(self.file, Some(&*side.overlapped));
                let mut read = 0u32;
                let _ = GetOverlappedResult(self.file, &*side.overlapped, &mut read, true);
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
