//! The controller's input through the Hercules SDK, the route used while the
//! Hercules driver is bound to the device and Windows' HID collection is
//! therefore missing (`crate::sdk` holds the layouts).
//!
//! - The SDK is loaded only from the Hercules install folder under Program
//!   Files, by full path, and only after its Authenticode signature checks out
//!   as Hercules' (the signer `hercules-official-run.ts` requires). The file is
//!   held open, refusing writes and deletes, from the check until it is loaded.
//!   Nothing is redistributed: a machine without the Hercules software simply
//!   has no SDK route.
//! - Eight exports are bound and nothing else: `HSM_Get_SDK_Version`,
//!   `HSM_Init`, `HSM_Exit`, `HSM_IsDeviceChanged`, `HSM_GetDeviceCount`,
//!   `HSM_GetDeviceInfo`, `HSM_OpenDevice`, `HSM_CloseDevice`. No screen, LED,
//!   audio-level or firmware call is reachable from here.
//! - While a device is open the SDK's own thread keeps the session alive (its
//!   keep-alive every 500 ms, `send_keepalive` in New-Hera-lunx's
//!   `docs/re/dll-map.md`) and calls back on every change of the controls.
//!   Opening follows hercules-wave-link-bridge (`NativeHsmSdk.cs`): init, poll
//!   `HSM_IsDeviceChanged` and the count until the device shows up, then open
//!   with zeroed output and context buffers that outlive the session.
//! - The callback runs on the SDK's thread. It only copies the state into a
//!   bounded channel and never blocks or panics.
//! - Stream Control drives the device through the same SDK, and two programs
//!   would fight over it, so this route is not tried while it runs; the
//!   ownership check then asks the person to close it.

use crate::report::Report;
use crate::sdk::{
    baseline, decode_state, info_buffer, info_is_stream100, signer_is_hercules, SDK_DIR, SDK_DLL,
    STATE_LEN, USB_DLL,
};
use crate::transport::TransportError;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, HMODULE, HWND};
use windows::Win32::Security::Cryptography::{
    szOID_ORGANIZATION_NAME, CertGetNameStringW, CERT_CONTEXT, CERT_NAME_ATTR_TYPE,
    CERT_NAME_SIMPLE_DISPLAY_TYPE,
};
use windows::Win32::Security::WinTrust::{
    WTHelperGetProvCertFromChain, WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData,
    WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA, WINTRUST_DATA_0,
    WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOKE_NONE,
    WTD_STATEACTION_CLOSE, WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, OPEN_EXISTING,
};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};

type NoArgs = unsafe extern "C" fn() -> i32;
type OutU16 = unsafe extern "C" fn(*mut u16) -> i32;
type OutI32 = unsafe extern "C" fn(*mut i32) -> i32;
type InfoFn = unsafe extern "C" fn(i32, *mut u8) -> i32;
/// `int cb(int handle, const HSM_INPUT* state, void* user)`.
type Callback = unsafe extern "C" fn(i32, *const u8, *mut c_void) -> i32;
type OpenFn = unsafe extern "C" fn(i32, *mut i32, Callback, *mut c_void) -> i32;
type CloseFn = unsafe extern "C" fn(i32) -> i32;

/// The eight exports, bound once per process. The library is never unloaded:
/// its threads may outlive a session by a moment, and loading it again buys
/// nothing.
struct Api {
    init: NoArgs,
    exit: NoArgs,
    is_device_changed: NoArgs,
    device_count: OutI32,
    device_info: InfoFn,
    open: OpenFn,
    close: CloseFn,
}

static API: Mutex<Option<&'static Api>> = Mutex::new(None);
/// Where the callback puts each state; `None` outside a session.
static SINK: Mutex<Option<SyncSender<[u8; STATE_LEN]>>> = Mutex::new(None);
/// One SDK session per process: the SDK's callback has nowhere to say which.
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// How long to wait for the SDK to list the device after init.
const DISCOVERY: Duration = Duration::from_secs(3);
const DISCOVERY_POLL: Duration = Duration::from_millis(100);
/// States waiting for the reader. The SDK calls back only on a change, so
/// this holds seconds of fast turning; when full the newest is dropped rather
/// than the SDK's thread blocked.
const QUEUE: usize = 1_024;
/// Sizes of the zeroed buffers `HSM_OpenDevice` gets, as the Wave Link bridge
/// passes them (8 KiB output, 4 KiB context).
const OPEN_OUTPUT_INTS: usize = 2_048;
const CONTEXT_BYTES: usize = 4_096;

/// A kernel handle, closed when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle was opened here and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// The Hercules SDK folder, when Program Files is known and absolute.
fn sdk_dir() -> Option<PathBuf> {
    let base = PathBuf::from(std::env::var_os("ProgramFiles")?);
    if !base.is_absolute() {
        return None;
    }
    Some(SDK_DIR.iter().fold(base, |path, part| path.join(part)))
}

/// Opens `path` for reading while refusing writers and deleters, so the file
/// checked is the file loaded.
fn hold(path: &[u16]) -> Option<Owned> {
    // SAFETY: `path` is NUL-terminated (`wide`).
    unsafe {
        CreateFileW(
            PCWSTR(path.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
        .ok()
        .map(Owned)
    }
}

/// One name of a certificate: `kind` is a `CERT_NAME_*` type.
unsafe fn cert_name(cert: *const CERT_CONTEXT, kind: u32, para: Option<*const c_void>) -> String {
    let mut buffer = [0u16; 512];
    let written = CertGetNameStringW(cert, kind, 0, para, Some(&mut buffer)) as usize;
    String::from_utf16_lossy(&buffer[..written.saturating_sub(1).min(buffer.len())])
}

/// A valid Authenticode signature whose signer is Hercules'. Revocation is
/// not fetched (`WTD_REVOKE_NONE`, cache only), so a machine offline never
/// waits on the network here.
fn signed_by_hercules(path: &[u16], file: &Owned) -> bool {
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: PCWSTR(path.as_ptr()),
        hFile: file.0,
        ..Default::default()
    };
    let mut data = WINTRUST_DATA {
        cbStruct: size_of::<WINTRUST_DATA>() as u32,
        dwUIChoice: WTD_UI_NONE,
        fdwRevocationChecks: WTD_REVOKE_NONE,
        dwUnionChoice: WTD_CHOICE_FILE,
        Anonymous: WINTRUST_DATA_0 { pFile: &mut info },
        dwStateAction: WTD_STATEACTION_VERIFY,
        dwProvFlags: WTD_CACHE_ONLY_URL_RETRIEVAL,
        ..Default::default()
    };
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // No window: nothing is ever shown to the person.
    let no_window = HWND(-1isize as *mut c_void);
    // SAFETY: `info` and `data` outlive both calls; the state opened by the
    // first call is closed by the second whatever the outcome.
    unsafe {
        let status = WinVerifyTrust(no_window, &mut action, &mut data as *mut _ as *mut c_void);
        let mut trusted = false;
        if status == 0 {
            let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
            let signer = if provider.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvSignerFromChain(provider, 0, false, 0)
            };
            let cert = if signer.is_null() {
                std::ptr::null_mut()
            } else {
                WTHelperGetProvCertFromChain(signer, 0)
            };
            if !cert.is_null() && !(*cert).pCert.is_null() {
                let cert = (*cert).pCert;
                let organization = cert_name(
                    cert,
                    CERT_NAME_ATTR_TYPE,
                    Some(szOID_ORGANIZATION_NAME.0 as *const c_void),
                );
                let common = cert_name(cert, CERT_NAME_SIMPLE_DISPLAY_TYPE, None);
                trusted = signer_is_hercules(&organization) || signer_is_hercules(&common);
            }
        }
        data.dwStateAction = WTD_STATEACTION_CLOSE;
        let _ = WinVerifyTrust(no_window, &mut action, &mut data as *mut _ as *mut c_void);
        trusted
    }
}

/// Loads one SDK file by full path once its signature is Hercules'. Its own
/// imports resolve from its folder and System32 only.
fn load_signed(path: &Path) -> Option<HMODULE> {
    let path = wide(path);
    let held = hold(&path)?;
    if !signed_by_hercules(&path, &held) {
        return None;
    }
    // SAFETY: a full path to a file verified above and held unchanged since.
    let module = unsafe {
        LoadLibraryExW(
            PCWSTR(path.as_ptr()),
            None,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    };
    drop(held);
    module.ok()
}

/// # Safety
/// `T` must be the export's real function pointer type.
unsafe fn export<T: Copy>(module: HMODULE, name: &'static [u8]) -> Option<T> {
    let found = GetProcAddress(module, PCSTR(name.as_ptr()))?;
    Some(std::mem::transmute_copy(&found))
}

fn bind() -> Option<Api> {
    let dir = sdk_dir()?;
    // The SDK loads the USB library by name at run time; loaded first from
    // the same folder, that name resolves to this signed copy.
    load_signed(&dir.join(USB_DLL))?;
    let module = load_signed(&dir.join(SDK_DLL))?;
    // SAFETY: signatures read from the SDK's own code (FINDINGS, probe5):
    // every export returns an int, 0 on success.
    unsafe {
        let version: OutU16 = export(module, b"HSM_Get_SDK_Version\0")?;
        let mut number = 0u16;
        if version(&mut number) != 0 {
            return None;
        }
        Some(Api {
            init: export(module, b"HSM_Init\0")?,
            exit: export(module, b"HSM_Exit\0")?,
            is_device_changed: export(module, b"HSM_IsDeviceChanged\0")?,
            device_count: export(module, b"HSM_GetDeviceCount\0")?,
            device_info: export(module, b"HSM_GetDeviceInfo\0")?,
            open: export(module, b"HSM_OpenDevice\0")?,
            close: export(module, b"HSM_CloseDevice\0")?,
        })
    }
}

/// The bound SDK, binding it on first use. A failure is not remembered, so
/// the Hercules software installed later is found on the next try.
fn api() -> Option<&'static Api> {
    let mut slot = API.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        *slot = bind().map(|api| &*Box::leak(Box::new(api)));
    }
    *slot
}

/// Runs on the SDK's thread for every change of the controls.
unsafe extern "C" fn on_input(_handle: i32, state: *const u8, _user: *mut c_void) -> i32 {
    if state.is_null() {
        return 0;
    }
    let mut copy = [0u8; STATE_LEN];
    // SAFETY: the SDK passes a state of `STATE_LEN` bytes (its dispatch code).
    std::ptr::copy_nonoverlapping(state, copy.as_mut_ptr(), STATE_LEN);
    if let Ok(sink) = SINK.lock() {
        if let Some(sender) = sink.as_ref() {
            let _ = sender.try_send(copy);
        }
    }
    0
}

fn set_sink(sender: Option<SyncSender<[u8; STATE_LEN]>>) {
    *SINK.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = sender;
}

/// The SDK index of the Stream 100, waiting a moment for the SDK to list it.
fn find_device(api: &Api) -> Option<i32> {
    let deadline = Instant::now() + DISCOVERY;
    let mut count = 0i32;
    loop {
        // SAFETY: plain SDK calls with a valid out pointer.
        unsafe {
            (api.is_device_changed)();
            if (api.device_count)(&mut count) == 0 && count > 0 {
                break;
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(DISCOVERY_POLL);
    }
    (0..count.min(16)).find(|&index| {
        let mut info = info_buffer();
        // SAFETY: the buffer is the size its first field declares.
        unsafe { (api.device_info)(index, info.as_mut_ptr()) == 0 && info_is_stream100(&info) }
    })
}

/// Releases the one-session flag unless the session took it over.
struct Claim(bool);

impl Drop for Claim {
    fn drop(&mut self) {
        if self.0 {
            ACTIVE.store(false, Ordering::Release);
        }
    }
}

/// The controller's input through the SDK, opened.
pub struct SdkInput {
    api: &'static Api,
    handle: i32,
    states: Receiver<[u8; STATE_LEN]>,
    started: bool,
    held: Option<Report>,
    // The SDK was handed these at open; they must outlive the session.
    _output: Box<[i32]>,
    _context: Box<[u8]>,
}

impl SdkInput {
    pub fn open() -> Result<Self, TransportError> {
        if ACTIVE.swap(true, Ordering::AcqRel) {
            return Err(TransportError::Busy);
        }
        let mut claim = Claim(true);
        // Stream Control holds the device through this same SDK; the
        // ownership check then asks the person to close it.
        if super::windows::stream_control_running() {
            return Err(TransportError::NotFound);
        }
        let api = api().ok_or(TransportError::NotFound)?;
        // SAFETY: plain SDK calls; every pointer handed over outlives the
        // session (the boxes live in the returned value).
        unsafe {
            if (api.init)() != 0 {
                return Err(TransportError::NotFound);
            }
            let Some(index) = find_device(api) else {
                (api.exit)();
                return Err(TransportError::NotFound);
            };
            let (sender, states) = sync_channel(QUEUE);
            set_sink(Some(sender));
            let mut output = vec![0i32; OPEN_OUTPUT_INTS].into_boxed_slice();
            let mut context = vec![0u8; CONTEXT_BYTES].into_boxed_slice();
            let opened = (api.open)(
                index,
                output.as_mut_ptr(),
                on_input,
                context.as_mut_ptr() as *mut c_void,
            );
            let handle = output[0];
            if opened < 0 || handle == 0 {
                if handle != 0 {
                    (api.close)(handle);
                }
                set_sink(None);
                (api.exit)();
                return Err(TransportError::Busy);
            }
            claim.0 = false;
            Ok(Self {
                api,
                handle,
                states,
                started: false,
                held: None,
                _output: output,
                _context: context,
            })
        }
    }

    pub fn next(&mut self, timeout: Duration) -> Result<Option<Report>, TransportError> {
        if let Some(report) = self.held.take() {
            return Ok(Some(report));
        }
        match self.states.recv_timeout(timeout) {
            Ok(state) => {
                let Some(report) = decode_state(&state) else {
                    return Ok(None);
                };
                if self.started {
                    return Ok(Some(report));
                }
                self.started = true;
                self.held = Some(report);
                Ok(Some(baseline(&report)))
            }
            Err(RecvTimeoutError::Timeout) => self.still_there(),
            Err(RecvTimeoutError::Disconnected) => Err(TransportError::Io(
                "the Hercules software stopped sending input".into(),
            )),
        }
    }

    /// Quiet is normal (the SDK calls back only on a change); a device the
    /// SDK no longer lists is gone, and the next read opens afresh.
    fn still_there(&mut self) -> Result<Option<Report>, TransportError> {
        let mut count = 0i32;
        // SAFETY: plain SDK calls with a valid out pointer.
        let gone = unsafe {
            (self.api.is_device_changed)() != 0
                && (self.api.device_count)(&mut count) == 0
                && count < 1
        };
        if gone {
            return Err(TransportError::Io("the Stream 100 was unplugged".into()));
        }
        Ok(None)
    }
}

impl Drop for SdkInput {
    fn drop(&mut self) {
        // SAFETY: closes this session's own device, then ends the SDK
        // session; the buffers it was given are freed only after.
        unsafe {
            (self.api.close)(self.handle);
        }
        set_sink(None);
        unsafe {
            (self.api.exit)();
        }
        ACTIVE.store(false, Ordering::Release);
    }
}
