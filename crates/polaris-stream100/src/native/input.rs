//! The controller's input reports, read the way each system lets a program
//! read them:
//!
//! - **Windows**: the HID API. With Windows' own drivers bound, interface 0 is
//!   a HID device that Windows' HID driver holds, so it is opened as a HID
//!   collection (read access only, shared) rather than claimed over USB. With
//!   the Hercules driver bound there is no HID collection at all; the input
//!   is then read through the Hercules SDK ([`super::sdk`]), and when that is
//!   not possible either, opening answers [`TransportError::NotFound`] and
//!   [`crate::ownership`] says why.
//! - **Linux**: the USB transport ([`crate::transport`]).
//! - **macOS**: not yet; the HID manager route is not written.
//!
//! Nothing here writes to the device: no output or feature report is sent.
//! (Through the SDK, the SDK's own thread keeps its session alive while the
//! device is open; Polaris sets nothing on it.)

use crate::report::Report;
use crate::transport::TransportError;
use std::time::Duration;

/// The controller's input, opened.
pub struct Input {
    #[cfg(windows)]
    inner: Windows,
    #[cfg(target_os = "linux")]
    inner: crate::transport::Input,
    #[cfg(not(any(windows, target_os = "linux")))]
    inner: std::convert::Infallible,
}

impl Input {
    pub fn open() -> Result<Self, TransportError> {
        #[cfg(windows)]
        return Ok(Self {
            inner: match hid::HidInput::open() {
                Ok(input) => Windows::Hid(input),
                Err(TransportError::NotFound) => Windows::Sdk(super::sdk::SdkInput::open()?),
                Err(error) => return Err(error),
            },
        });
        #[cfg(target_os = "linux")]
        return Ok(Self {
            inner: crate::transport::Input::open()?,
        });
        #[cfg(not(any(windows, target_os = "linux")))]
        Err(TransportError::Unsupported)
    }

    /// Waits up to `timeout` for the next report; `Ok(None)` when none came.
    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, TransportError> {
        #[cfg(windows)]
        return match &mut self.inner {
            Windows::Hid(input) => input.next(timeout),
            Windows::Sdk(input) => input.next(timeout),
        };
        #[cfg(target_os = "linux")]
        return self.inner.next(timeout);
        #[cfg(not(any(windows, target_os = "linux")))]
        match self.inner {}
    }
}

/// The two Windows routes: Windows' HID driver, or the Hercules SDK.
#[cfg(windows)]
enum Windows {
    Hid(hid::HidInput),
    Sdk(super::sdk::SdkInput),
}

#[cfg(windows)]
mod hid {
    use crate::report::{from_hid_read, Report, MIN_REPORT_LEN};
    use crate::transport::TransportError;
    use crate::{PRODUCT_ID, VENDOR_ID};
    use std::time::Duration;
    use windows::core::PCWSTR;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInterfaces, SetupDiGetClassDevsW,
        SetupDiGetDeviceInterfaceDetailW, DIGCF_DEVICEINTERFACE, DIGCF_PRESENT,
        SP_DEVICE_INTERFACE_DATA, SP_DEVICE_INTERFACE_DETAIL_DATA_W,
    };
    use windows::Win32::Devices::HumanInterfaceDevice::{
        HidD_FreePreparsedData, HidD_GetAttributes, HidD_GetHidGuid, HidD_GetPreparsedData,
        HidP_GetCaps, HIDD_ATTRIBUTES, HIDP_CAPS, PHIDP_PREPARSED_DATA,
    };
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_IO_PENDING, GENERIC_READ, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_OVERLAPPED, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    /// A kernel handle, closed when dropped.
    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by this module and is closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// One of the controller's HID collections: its path and input size.
    struct Collection {
        path: Vec<u16>,
        input_len: usize,
    }

    fn open_path(path: &[u16], access: u32, flags: FILE_FLAGS_AND_ATTRIBUTES) -> Option<Owned> {
        // SAFETY: `path` is NUL-terminated (built that way in `collections`).
        unsafe {
            CreateFileW(
                PCWSTR(path.as_ptr()),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                flags,
                None,
            )
            .ok()
            .map(Owned)
        }
    }

    /// The controller's HID collections that send input reports.
    fn collections() -> Vec<Collection> {
        let mut found = Vec::new();
        // SAFETY: plain SetupAPI / HID calls; every buffer outlives the call
        // that fills it and the device list is destroyed before returning.
        unsafe {
            let guid = HidD_GetHidGuid();
            let Ok(set) = SetupDiGetClassDevsW(
                Some(&guid),
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
                if SetupDiEnumDeviceInterfaces(set, None, &guid, index, &mut data).is_err() {
                    break;
                }
                index += 1;
                let mut needed = 0u32;
                let _ =
                    SetupDiGetDeviceInterfaceDetailW(set, &data, None, 0, Some(&mut needed), None);
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
                // No access asked: enough for attributes and capabilities.
                let Some(handle) = open_path(&path, 0, FILE_FLAGS_AND_ATTRIBUTES(0)) else {
                    continue;
                };
                let mut attributes = HIDD_ATTRIBUTES {
                    Size: size_of::<HIDD_ATTRIBUTES>() as u32,
                    ..Default::default()
                };
                if !HidD_GetAttributes(handle.0, &mut attributes)
                    || attributes.VendorID != VENDOR_ID
                    || attributes.ProductID != PRODUCT_ID
                {
                    continue;
                }
                let mut preparsed = PHIDP_PREPARSED_DATA::default();
                let mut caps = HIDP_CAPS::default();
                if HidD_GetPreparsedData(handle.0, &mut preparsed) {
                    let _ = HidP_GetCaps(preparsed, &mut caps);
                    let _ = HidD_FreePreparsedData(preparsed);
                }
                let input_len = usize::from(caps.InputReportByteLength);
                // The report id byte plus every field the decoder reads.
                if input_len > MIN_REPORT_LEN {
                    found.push(Collection { path, input_len });
                }
            }
            let _ = SetupDiDestroyDeviceInfoList(set);
        }
        found
    }

    /// The controller's input collection, read with one overlapped read at a
    /// time so a wait can time out without losing the read in flight.
    pub struct HidInput {
        file: Owned,
        event: Owned,
        // Boxed: the system writes into both while a read is pending, so they
        // must not move.
        overlapped: Box<OVERLAPPED>,
        buffer: Box<[u8]>,
        pending: bool,
    }

    // SAFETY: the handles are plain kernel handles, usable from any thread;
    // the struct is only ever used by one thread at a time (`&mut self`).
    unsafe impl Send for HidInput {}

    impl HidInput {
        pub fn open() -> Result<Self, TransportError> {
            // The biggest input collection is the one with the encoders.
            let collection = collections()
                .into_iter()
                .max_by_key(|collection| collection.input_len)
                .ok_or(TransportError::NotFound)?;
            let file = open_path(&collection.path, GENERIC_READ.0, FILE_FLAG_OVERLAPPED)
                .ok_or(TransportError::Busy)?;
            // SAFETY: an unnamed manual-reset event, as overlapped reads want.
            let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
                .map(Owned)
                .map_err(|error| TransportError::Io(error.message()))?;
            Ok(Self {
                file,
                event,
                overlapped: Box::default(),
                buffer: vec![0u8; collection.input_len].into_boxed_slice(),
                pending: false,
            })
        }

        pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, TransportError> {
            if !self.pending {
                *self.overlapped = OVERLAPPED {
                    hEvent: self.event.0,
                    ..Default::default()
                };
                // SAFETY: buffer and overlapped are boxed and stay alive until
                // the read completes or is cancelled in `drop`.
                let started = unsafe {
                    ReadFile(
                        self.file.0,
                        Some(&mut self.buffer),
                        None,
                        Some(&mut *self.overlapped),
                    )
                };
                match started {
                    Ok(()) => {}
                    Err(error) if error.code() == ERROR_IO_PENDING.to_hresult() => {}
                    Err(error) => return Err(TransportError::Io(error.message())),
                }
                self.pending = true;
            }
            let wait = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
            // SAFETY: waits on the event this struct owns.
            match unsafe { WaitForSingleObject(self.event.0, wait) } {
                WAIT_OBJECT_0 => {}
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
                unsafe { GetOverlappedResult(self.file.0, &*self.overlapped, &mut read, false) };
            self.pending = false;
            done.map_err(|error| TransportError::Io(error.message()))?;
            let read = (read as usize).min(self.buffer.len());
            Ok(Report::parse(from_hid_read(&self.buffer[..read])))
        }
    }

    impl Drop for HidInput {
        fn drop(&mut self) {
            if self.pending {
                // SAFETY: cancels this struct's own read and waits for it to
                // finish, so the system is done with the buffers before they go.
                unsafe {
                    let _ = CancelIoEx(self.file.0, Some(&*self.overlapped));
                    let mut read = 0u32;
                    let _ = GetOverlappedResult(self.file.0, &*self.overlapped, &mut read, true);
                }
            }
        }
    }
}
