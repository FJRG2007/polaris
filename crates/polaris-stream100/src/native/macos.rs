//! macOS: per-app volume through Core Audio process taps (macOS 14.2 and
//! later), and the whole output's volume and mute through Core Audio's
//! property API on the default output device (every version).
//!
//! macOS has no per-app volume API. Per-app mixers there take an app's audio
//! away from the output and play it back themselves at the app's own gain.
//! Background Music and older SoundSource versions do it with an audio driver
//! (a HAL plug-in that needs an administrator); since macOS 14.2 Apple's
//! process taps do it with no driver ("Capturing system audio with Core Audio
//! taps", and the insidegui/AudioCap sample this follows):
//!
//! 1. A `CATapDescription` of the app's process (`initStereoMixdownOfProcesses:`)
//!    with `CATapMutedWhenTapped`, so the app is silent at the output only
//!    while Polaris plays it, and comes back by itself the moment Polaris
//!    stops (or its process exits: a private tap dies with its owner).
//! 2. `AudioHardwareCreateProcessTap`, then a private aggregate device whose
//!    main sub-device is the default output and whose one tap is that one.
//! 3. An IO proc on the aggregate device copying the tap into the output at
//!    the knob's gain ([`crate::audio::mix`]).
//!
//! An app at 100% and not muted has no tap at all: its audio is untouched.
//! Apps are Core Audio's process objects (`kAudioHardwarePropertyProcessObjectList`),
//! named by their outermost `.app` bundle so the same categories as on
//! Windows and Linux apply ([`crate::audio::bundle_program`]).
//!
//! Tapping needs the person's "system audio recording" consent, asked for by
//! the desktop app (whose bundle declares `NSAudioCaptureUsageDescription`)
//! through [`request_access`], never by the plugin on its own: the plugin only
//! reads it ([`access`]), and with no consent nothing is tapped, so an app is
//! never muted by a tap that would deliver silence. Before 14.2 the tap API
//! and `CATapDescription` are absent; both are looked up at run time, so this
//! module still loads there and the whole output keeps working.

use crate::audio::{bundle_program, mix, tap_gain, AudioError, AudioSessions, Session};
use crate::ownership::Observed;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;

type AudioObjectId = u32;
type OsStatus = i32;
type CfRef = *const c_void;
type Id = *mut c_void;
type Sel = *const c_void;
type IoProcId = *mut c_void;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 1],
}

type IoProc = extern "C" fn(
    AudioObjectId,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OsStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectHasProperty(object: AudioObjectId, address: *const PropertyAddress) -> u8;
    fn AudioObjectGetPropertyDataSize(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
    ) -> OsStatus;
    fn AudioObjectGetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioObjectSetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: u32,
        data: *const c_void,
    ) -> OsStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: CfRef,
        device: *mut AudioObjectId,
    ) -> OsStatus;
    fn AudioHardwareDestroyAggregateDevice(device: AudioObjectId) -> OsStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectId,
        callback: IoProc,
        client: *mut c_void,
        id: *mut IoProcId,
    ) -> OsStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectId, id: IoProcId) -> OsStatus;
    fn AudioDeviceStart(device: AudioObjectId, id: IoProcId) -> OsStatus;
    fn AudioDeviceStop(device: AudioObjectId, id: IoProcId) -> OsStatus;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFTypeDictionaryKeyCallBacks: u8;
    static kCFTypeDictionaryValueCallBacks: u8;
    static kCFTypeArrayCallBacks: u8;
    static kCFBooleanTrue: CfRef;
    static kCFBooleanFalse: CfRef;
    fn CFRelease(value: CfRef);
    fn CFStringCreateWithBytes(
        allocator: CfRef,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> CfRef;
    fn CFStringGetCString(value: CfRef, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFDictionaryCreate(
        allocator: CfRef,
        keys: *const CfRef,
        values: *const CfRef,
        count: isize,
        key_callbacks: *const c_void,
        value_callbacks: *const c_void,
    ) -> CfRef;
    fn CFArrayCreate(
        allocator: CfRef,
        values: *const CfRef,
        count: isize,
        callbacks: *const c_void,
    ) -> CfRef;
    fn CFUUIDCreate(allocator: CfRef) -> CfRef;
    fn CFUUIDCreateString(allocator: CfRef, uuid: CfRef) -> CfRef;
}

// Foundation for `NSNumber` and `NSArray`; `CATapDescription` is Core Audio's.
#[link(name = "Foundation", kind = "framework")]
extern "C" {}

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

extern "C" {
    static _NSConcreteGlobalBlock: u8;
}

const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const UTF8: u32 = 0x0800_0100;
const SYSTEM_OBJECT: AudioObjectId = 1;
const DEFAULT_OUTPUT: u32 = four(b"dOut");
const SCOPE_GLOBAL: u32 = four(b"glob");
const SCOPE_OUTPUT: u32 = four(b"outp");
const ELEMENT_MAIN: u32 = 0;
const VOLUME_SCALAR: u32 = four(b"volm");
const MUTE: u32 = four(b"mute");
const STEREO_CHANNELS: u32 = four(b"dch2");
const DEVICE_UID: u32 = four(b"uid ");
const PROCESS_LIST: u32 = four(b"prs#");
const PROCESS_PID: u32 = four(b"ppid");
const PROCESS_BUNDLE: u32 = four(b"pbid");
const PROCESS_RUNNING_OUTPUT: u32 = four(b"piro");
/// `CATapMutedWhenTapped`: the app is silent at the output only while the tap is read.
const MUTED_WHEN_TAPPED: isize = 2;

fn status(code: OsStatus) -> Result<(), AudioError> {
    if code == 0 {
        Ok(())
    } else {
        Err(AudioError::Backend(format!("Core Audio error {code}")))
    }
}

fn get<T: Copy>(
    object: AudioObjectId,
    address: &PropertyAddress,
    mut value: T,
) -> Result<T, AudioError> {
    let mut size = size_of::<T>() as u32;
    // SAFETY: `value` is a plain value of exactly `size` bytes.
    status(unsafe {
        AudioObjectGetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            &mut size,
            (&mut value as *mut T).cast(),
        )
    })?;
    Ok(value)
}

fn set<T: Copy>(
    object: AudioObjectId,
    address: &PropertyAddress,
    value: T,
) -> Result<(), AudioError> {
    // SAFETY: `value` is a plain value of `size_of::<T>()` bytes.
    status(unsafe {
        AudioObjectSetPropertyData(
            object,
            address,
            0,
            std::ptr::null(),
            size_of::<T>() as u32,
            (&value as *const T).cast(),
        )
    })
}

fn has(object: AudioObjectId, address: &PropertyAddress) -> bool {
    // SAFETY: a read-only query with a valid address.
    unsafe { AudioObjectHasProperty(object, address) != 0 }
}

fn output(selector: u32, element: u32) -> PropertyAddress {
    PropertyAddress {
        selector,
        scope: SCOPE_OUTPUT,
        element,
    }
}

fn global(selector: u32) -> PropertyAddress {
    PropertyAddress {
        selector,
        scope: SCOPE_GLOBAL,
        element: ELEMENT_MAIN,
    }
}

/// The default output device, asked for on every call so a switch to other
/// speakers or headphones is followed at once.
fn device() -> Result<AudioObjectId, AudioError> {
    match get(SYSTEM_OBJECT, &global(DEFAULT_OUTPUT), 0u32)? {
        0 => Err(AudioError::Unsupported),
        id => Ok(id),
    }
}

/// The elements that carry `selector`: the main one when the device has it,
/// else its stereo pair (most built-in and USB outputs set volume per channel).
fn elements(device: AudioObjectId, selector: u32) -> Vec<u32> {
    if has(device, &output(selector, ELEMENT_MAIN)) {
        return vec![ELEMENT_MAIN];
    }
    let pair = get(device, &output(STEREO_CHANNELS, ELEMENT_MAIN), [1u32, 2u32]).unwrap_or([1, 2]);
    pair.into_iter()
        .filter(|channel| has(device, &output(selector, *channel)))
        .collect()
}

// --- Core Foundation and Objective-C, the little this needs ---------------

/// An owned Core Foundation object, released when dropped.
struct Cf(CfRef);

impl Drop for Cf {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: an object this module created or was handed at +1.
            unsafe { CFRelease(self.0) }
        }
    }
}

fn cf_string(text: &str) -> Cf {
    // SAFETY: `text` is valid UTF-8 of the given length.
    Cf(unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            text.as_ptr(),
            text.len() as isize,
            UTF8,
            0,
        )
    })
}

fn rust_string(value: CfRef) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let mut buffer = [0 as c_char; 1024];
    // SAFETY: `buffer` is writable for its whole length.
    let done =
        unsafe { CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) };
    // SAFETY: CFStringGetCString wrote a NUL-terminated string when it succeeded.
    (done != 0).then(|| {
        unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned()
    })
}

fn cf_dictionary(pairs: &[(&str, CfRef)]) -> Cf {
    let keys: Vec<Cf> = pairs.iter().map(|(key, _)| cf_string(key)).collect();
    let raw_keys: Vec<CfRef> = keys.iter().map(|key| key.0).collect();
    let values: Vec<CfRef> = pairs.iter().map(|(_, value)| *value).collect();
    // SAFETY: both arrays hold `pairs.len()` valid objects; the dictionary retains them.
    Cf(unsafe {
        CFDictionaryCreate(
            std::ptr::null(),
            raw_keys.as_ptr(),
            values.as_ptr(),
            pairs.len() as isize,
            std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
            std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast(),
        )
    })
}

fn cf_array(values: &[CfRef]) -> Cf {
    // SAFETY: `values` holds valid objects; the array retains them.
    Cf(unsafe {
        CFArrayCreate(
            std::ptr::null(),
            values.as_ptr(),
            values.len() as isize,
            std::ptr::addr_of!(kCFTypeArrayCallBacks).cast(),
        )
    })
}

fn cf_bool(value: bool) -> CfRef {
    // SAFETY: constant singletons, never released.
    unsafe {
        if value {
            kCFBooleanTrue
        } else {
            kCFBooleanFalse
        }
    }
}

fn new_uuid() -> Option<String> {
    // SAFETY: plain constructors; both results are owned and released by `Cf`.
    let uuid = Cf(unsafe { CFUUIDCreate(std::ptr::null()) });
    let text = Cf(unsafe { CFUUIDCreateString(std::ptr::null(), uuid.0) });
    rust_string(text.0)
}

fn class(name: &CStr) -> Id {
    // SAFETY: a lookup; null when the class does not exist on this system.
    unsafe { objc_getClass(name.as_ptr()) }
}

fn sel(name: &CStr) -> Sel {
    // SAFETY: registering a selector name is always valid.
    unsafe { sel_registerName(name.as_ptr()) }
}

/// `objc_msgSend` cast to the exact signature of the method it calls.
macro_rules! send {
    ($receiver:expr, $selector:expr $(, $arg:expr => $ty:ty)* ; -> $ret:ty) => {{
        // SAFETY: the method named takes exactly these arguments and returns `$ret`.
        let send: unsafe extern "C" fn(Id, Sel $(, $ty)*) -> $ret =
            unsafe { std::mem::transmute(objc_msgSend as unsafe extern "C" fn()) };
        // SAFETY: as above; `$receiver` is a live object or class.
        unsafe { send($receiver, sel($selector) $(, $arg)*) }
    }};
}

struct Pool(*mut c_void);

impl Pool {
    fn new() -> Self {
        // SAFETY: paired with the pop in `drop`, on the same thread.
        Self(unsafe { objc_autoreleasePoolPush() })
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        // SAFETY: the pool pushed in `new`.
        unsafe { objc_autoreleasePoolPop(self.0) }
    }
}

// --- What this system allows ------------------------------------------------

type CreateTap = unsafe extern "C" fn(Id, *mut AudioObjectId) -> OsStatus;
type DestroyTap = unsafe extern "C" fn(AudioObjectId) -> OsStatus;

struct TapApi {
    create: CreateTap,
    destroy: DestroyTap,
}

fn symbol(handle: *mut c_void, name: &CStr) -> *mut c_void {
    // SAFETY: a lookup in an open image; null when absent.
    unsafe { libc::dlsym(handle, name.as_ptr()) }
}

/// The process tap API, present from macOS 14.2. Looked up, not linked, so
/// the module loads on older versions too.
fn tap_api() -> Option<&'static TapApi> {
    static API: OnceLock<Option<TapApi>> = OnceLock::new();
    API.get_or_init(|| {
        let create = symbol(libc::RTLD_DEFAULT, c"AudioHardwareCreateProcessTap");
        let destroy = symbol(libc::RTLD_DEFAULT, c"AudioHardwareDestroyProcessTap");
        if create.is_null() || destroy.is_null() || class(c"CATapDescription").is_null() {
            return None;
        }
        // SAFETY: both symbols have exactly these signatures (AudioHardware.h, macOS 14.2).
        Some(unsafe {
            TapApi {
                create: std::mem::transmute::<*mut c_void, CreateTap>(create),
                destroy: std::mem::transmute::<*mut c_void, DestroyTap>(destroy),
            }
        })
    })
    .as_ref()
}

type Preflight = unsafe extern "C" fn(CfRef, CfRef) -> i32;
type Request = unsafe extern "C" fn(CfRef, CfRef, *const c_void);

/// The system's consent store (TCC): the entry points AudioCap uses to read
/// and ask for `kTCCServiceAudioCapture`, which has no public API.
fn tcc() -> Option<(Preflight, Request)> {
    static TCC: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    let (preflight, request) = (*TCC.get_or_init(|| {
        // SAFETY: opening a system framework by its absolute path.
        let handle = unsafe {
            libc::dlopen(
                c"/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC".as_ptr(),
                libc::RTLD_NOW,
            )
        };
        if handle.is_null() {
            return None;
        }
        let preflight = symbol(handle, c"TCCAccessPreflight");
        let request = symbol(handle, c"TCCAccessRequest");
        (!preflight.is_null() && !request.is_null())
            .then_some((preflight as usize, request as usize))
    }))?;
    // SAFETY: both functions have these signatures (AudioCap's AudioRecordingPermission).
    Some(unsafe {
        (
            std::mem::transmute::<usize, Preflight>(preflight),
            std::mem::transmute::<usize, Request>(request),
        )
    })
}

/// Where per-app volume stands on this Mac.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// Taps exist and the person allowed system audio recording.
    Ready,
    /// The person has not been asked yet.
    NotAsked,
    /// The person said no, or turned it off in System Settings.
    NotAllowed,
    /// Before macOS 14.2: no process taps. The whole output still works.
    NeedsNewerMacos,
}

impl Access {
    pub fn code(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NotAsked => "notAsked",
            Self::NotAllowed => "notAllowed",
            Self::NeedsNewerMacos => "needsNewerMacos",
        }
    }
}

pub fn access() -> Access {
    if tap_api().is_none() {
        return Access::NeedsNewerMacos;
    }
    let Some((preflight, _)) = tcc() else {
        return Access::NotAsked;
    };
    let service = cf_string("kTCCServiceAudioCapture");
    // SAFETY: a read of the consent store with a valid service name.
    match unsafe { preflight(service.0, std::ptr::null()) } {
        0 => Access::Ready,
        1 => Access::NotAllowed,
        _ => Access::NotAsked,
    }
}

#[repr(C)]
struct BlockDescriptor {
    reserved: usize,
    size: usize,
}

#[repr(C)]
struct Block {
    isa: *const c_void,
    flags: i32,
    reserved: i32,
    invoke: extern "C" fn(*const Block, u8),
    descriptor: *const BlockDescriptor,
}

// SAFETY: a global block captures nothing and is never written after creation.
unsafe impl Sync for Block {}
// SAFETY: as above.
unsafe impl Send for Block {}

/// The answer is read back with [`access`]; nothing to do with it here.
extern "C" fn answered(_block: *const Block, _granted: u8) {}

/// Shows the system's "record system audio" prompt when the person was not
/// asked yet (once they answered, macOS does not ask again and only System
/// Settings changes it). Called by the desktop app, never by the plugin.
pub fn request_access() {
    if tap_api().is_none() {
        return;
    }
    let Some((_, request)) = tcc() else { return };
    static DESCRIPTOR: BlockDescriptor = BlockDescriptor {
        reserved: 0,
        size: size_of::<Block>(),
    };
    static BLOCK: OnceLock<Block> = OnceLock::new();
    let block = BLOCK.get_or_init(|| Block {
        isa: std::ptr::addr_of!(_NSConcreteGlobalBlock).cast(),
        // BLOCK_IS_GLOBAL: copying it returns itself, so it is never freed.
        flags: 1 << 28,
        reserved: 0,
        invoke: answered,
        descriptor: &DESCRIPTOR,
    });
    let service = cf_string("kTCCServiceAudioCapture");
    // SAFETY: a valid service name and a global block that lives forever.
    unsafe { request(service.0, std::ptr::null(), (block as *const Block).cast()) }
}

// --- One app's tap ----------------------------------------------------------

/// What the IO proc reads on Core Audio's real-time thread: the gain as f32 bits.
struct Gain(AtomicU32);

extern "C" fn play(
    _device: AudioObjectId,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus {
    // SAFETY: `client` is the tap's `Gain`, alive until its IO proc is destroyed.
    let gain = f32::from_bits(
        unsafe { &*(client as *const Gain) }
            .0
            .load(Ordering::Relaxed),
    );
    // SAFETY: Core Audio hands valid buffer lists for this cycle, `count`
    // buffers long; every buffer holds Float32 samples, the HAL's IO format.
    unsafe {
        let Some(output) = output.as_mut() else {
            return 0;
        };
        let outs =
            std::slice::from_raw_parts_mut(output.buffers.as_mut_ptr(), output.count as usize);
        let tapped = input.as_ref().and_then(|input| {
            // The tap's stream comes after any input of the output device itself.
            let ins = std::slice::from_raw_parts(input.buffers.as_ptr(), input.count as usize);
            ins.last().filter(|buffer| !buffer.data.is_null())
        });
        for (index, out) in outs.iter_mut().enumerate() {
            if out.data.is_null() {
                continue;
            }
            let samples =
                std::slice::from_raw_parts_mut(out.data.cast::<f32>(), out.byte_size as usize / 4);
            match tapped.filter(|_| index == 0) {
                Some(buffer) => {
                    let source = std::slice::from_raw_parts(
                        buffer.data.cast::<f32>(),
                        buffer.byte_size as usize / 4,
                    );
                    mix(
                        source,
                        buffer.channels as usize,
                        samples,
                        out.channels as usize,
                        gain,
                    );
                }
                None => samples.fill(0.0),
            }
        }
    }
    0
}

struct Tap {
    api: &'static TapApi,
    tap: AudioObjectId,
    aggregate: AudioObjectId,
    io: IoProcId,
    gain: Box<Gain>,
    /// The output device it plays to; a switch of the default output rebuilds it.
    output: String,
}

impl Tap {
    fn create(process: AudioObjectId, output: &str, gain: f32) -> Result<Self, AudioError> {
        let api = tap_api().ok_or(AudioError::Unsupported)?;
        let _pool = Pool::new();
        let number = send!(class(c"NSNumber"), c"numberWithUnsignedInt:", process => u32; -> Id);
        let processes = send!(class(c"NSArray"), c"arrayWithObject:", number => Id; -> Id);
        let allocated = send!(class(c"CATapDescription"), c"alloc"; -> Id);
        let description =
            send!(allocated, c"initStereoMixdownOfProcesses:", processes => Id; -> Id);
        if description.is_null() {
            return Err(AudioError::Backend(
                "Core Audio refused the tap description".into(),
            ));
        }
        send!(description, c"setMuteBehavior:", MUTED_WHEN_TAPPED => isize; -> ());
        send!(description, c"setPrivate:", 1 => u8; -> ());
        let uuid = send!(description, c"UUID"; -> Id);
        let tap_uid = rust_string(send!(uuid, c"UUIDString"; -> Id) as CfRef);
        let mut tap = 0;
        // SAFETY: a valid description; the tap id is written on success.
        let created = status(unsafe { (api.create)(description, &mut tap) });
        send!(description, c"release"; -> ());
        created?;
        // From here `made` tears down whatever was built if a later step fails.
        let mut made = Self {
            api,
            tap,
            aggregate: 0,
            io: std::ptr::null_mut(),
            gain: Box::new(Gain(AtomicU32::new(gain.to_bits()))),
            output: output.to_owned(),
        };
        let tap_uid = tap_uid.ok_or_else(|| AudioError::Backend("the tap has no id".into()))?;
        let own_uid =
            new_uuid().ok_or_else(|| AudioError::Backend("no id for the device".into()))?;
        let output_uid = cf_string(output);
        let tap_uid = cf_string(&tap_uid);
        let sub_device = cf_dictionary(&[("uid", output_uid.0)]);
        let sub_tap = cf_dictionary(&[("uid", tap_uid.0), ("drift", cf_bool(true))]);
        let sub_devices = cf_array(&[sub_device.0]);
        let taps = cf_array(&[sub_tap.0]);
        let name = cf_string("Polaris Stream 100");
        let uid = cf_string(&own_uid);
        // kAudioAggregateDevice*Key, as AudioHardware.h spells them.
        let description = cf_dictionary(&[
            ("name", name.0),
            ("uid", uid.0),
            ("master", output_uid.0),
            ("private", cf_bool(true)),
            ("stacked", cf_bool(false)),
            ("tapautostart", cf_bool(true)),
            ("subdevices", sub_devices.0),
            ("taps", taps.0),
        ]);
        // SAFETY: a valid description; the device id is written on success.
        status(unsafe { AudioHardwareCreateAggregateDevice(description.0, &mut made.aggregate) })?;
        let client = (&*made.gain as *const Gain).cast_mut().cast();
        // SAFETY: `play` is an AudioDeviceIOProc; `client` outlives the proc (see Drop).
        status(unsafe { AudioDeviceCreateIOProcID(made.aggregate, play, client, &mut made.io) })?;
        // SAFETY: the proc just created on this device.
        status(unsafe { AudioDeviceStart(made.aggregate, made.io) })?;
        Ok(made)
    }

    fn set_gain(&self, gain: f32) {
        self.gain.0.store(gain.to_bits(), Ordering::Relaxed);
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        // SAFETY: tearing down, in reverse, only what `create` made; the gain
        // is dropped after the IO proc that reads it is gone.
        unsafe {
            if !self.io.is_null() {
                AudioDeviceStop(self.aggregate, self.io);
                AudioDeviceDestroyIOProcID(self.aggregate, self.io);
            }
            if self.aggregate != 0 {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            (self.api.destroy)(self.tap);
        }
    }
}

// --- The backend ------------------------------------------------------------

/// The volume and mute a person set on one app, and its tap while it has one.
struct App {
    volume: u8,
    muted: bool,
    tap: Option<Tap>,
}

fn output_uid() -> Result<String, AudioError> {
    let device = device()?;
    let value = Cf(get(
        device,
        &global(DEVICE_UID),
        std::ptr::null::<c_void>(),
    )?);
    rust_string(value.0).ok_or(AudioError::Unsupported)
}

fn processes() -> Vec<AudioObjectId> {
    let address = global(PROCESS_LIST);
    let mut size = 0u32;
    // SAFETY: a size query with a valid address.
    let asked = unsafe {
        AudioObjectGetPropertyDataSize(SYSTEM_OBJECT, &address, 0, std::ptr::null(), &mut size)
    };
    if asked != 0 || size == 0 {
        return Vec::new();
    }
    let mut ids = vec![0u32; size as usize / size_of::<AudioObjectId>()];
    // SAFETY: `ids` holds `size` bytes.
    let read = unsafe {
        AudioObjectGetPropertyData(
            SYSTEM_OBJECT,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            ids.as_mut_ptr().cast(),
        )
    };
    if read != 0 {
        return Vec::new();
    }
    ids.truncate(size as usize / size_of::<AudioObjectId>());
    ids
}

fn program_of(process: AudioObjectId, pid: i32) -> String {
    let mut path = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `path` is writable for its whole length.
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    if length > 0 {
        return bundle_program(&String::from_utf8_lossy(&path[..length as usize]));
    }
    get(process, &global(PROCESS_BUNDLE), std::ptr::null::<c_void>())
        .ok()
        .map(Cf)
        .and_then(|bundle| rust_string(bundle.0))
        .unwrap_or_default()
}

pub struct CoreAudioOutput {
    apps: HashMap<AudioObjectId, App>,
}

impl CoreAudioOutput {
    pub fn open() -> Result<Self, AudioError> {
        device()?;
        Ok(Self {
            apps: HashMap::new(),
        })
    }

    /// Put one app's tap in line with its volume: none at 100% and unmuted,
    /// else one playing to the current default output at its gain.
    fn apply(&mut self, process: AudioObjectId) -> Result<(), AudioError> {
        let app = self.apps.get_mut(&process).ok_or(AudioError::Gone)?;
        if app.volume >= 100 && !app.muted {
            app.tap = None;
            return Ok(());
        }
        let gain = tap_gain(app.volume, app.muted);
        let output = output_uid()?;
        if let Some(tap) = app.tap.as_ref().filter(|tap| tap.output == output) {
            tap.set_gain(gain);
            return Ok(());
        }
        app.tap = None;
        if access() != Access::Ready {
            return Err(AudioError::NotAllowed);
        }
        app.tap = Some(Tap::create(process, &output, gain)?);
        Ok(())
    }

    fn change(&mut self, id: &str, update: impl FnOnce(&mut App)) -> Result<(), AudioError> {
        let process: AudioObjectId = id.parse().map_err(|_| AudioError::Gone)?;
        if !processes().contains(&process) {
            self.apps.remove(&process);
            return Err(AudioError::Gone);
        }
        let app = self.apps.entry(process).or_insert(App {
            volume: 100,
            muted: false,
            tap: None,
        });
        update(app);
        self.apply(process)
    }
}

impl AudioSessions for CoreAudioOutput {
    fn sessions(&mut self) -> Result<Vec<Session>, AudioError> {
        if tap_api().is_none() {
            return Ok(Vec::new());
        }
        let live = processes();
        // An app that quit took its tap with it.
        self.apps.retain(|process, _| live.contains(process));
        // A switch of the default output moves every tap to the new one.
        let current = output_uid().ok();
        let moved: Vec<AudioObjectId> = self
            .apps
            .iter()
            .filter(|(_, app)| {
                app.tap
                    .as_ref()
                    .is_some_and(|tap| Some(&tap.output) != current.as_ref())
            })
            .map(|(process, _)| *process)
            .collect();
        for process in moved {
            // Not fatal: the next turn of the knob tries again.
            let _ = self.apply(process);
        }
        let own = std::process::id() as i32;
        let mut found = Vec::new();
        for process in live {
            let Ok(pid) = get(process, &global(PROCESS_PID), 0i32) else {
                continue;
            };
            let playing = get(process, &global(PROCESS_RUNNING_OUTPUT), 0u32)
                .is_ok_and(|running| running != 0);
            let app = self.apps.get(&process);
            // An app paused at a set volume stays listed, so it resumes at it.
            if pid == own || (!playing && app.is_none()) {
                continue;
            }
            found.push(Session {
                id: process.to_string(),
                program: program_of(process, pid),
                pid: pid.max(0) as u32,
                system: false,
                volume: app.map_or(100, |app| app.volume),
                muted: app.is_some_and(|app| app.muted),
            });
        }
        Ok(found)
    }

    fn set_volume(&mut self, id: &str, volume: u8) -> Result<(), AudioError> {
        self.change(id, |app| app.volume = volume.min(100))
    }

    fn set_muted(&mut self, id: &str, muted: bool) -> Result<(), AudioError> {
        self.change(id, |app| app.muted = muted)
    }

    fn output_volume(&mut self) -> Result<(u8, bool), AudioError> {
        let device = device()?;
        let mut loudest: Option<f32> = None;
        for element in elements(device, VOLUME_SCALAR) {
            let level = get(device, &output(VOLUME_SCALAR, element), 0f32)?;
            loudest = Some(loudest.map_or(level, |seen| seen.max(level)));
        }
        let volume = loudest.ok_or(AudioError::Unsupported)?;
        let muted = elements(device, MUTE)
            .first()
            .map(|element| get(device, &output(MUTE, *element), 0u32))
            .transpose()?
            .is_some_and(|muted| muted != 0);
        Ok(((volume.clamp(0.0, 1.0) * 100.0).round() as u8, muted))
    }

    fn set_output_volume(&mut self, volume: u8) -> Result<(), AudioError> {
        let device = device()?;
        let found = elements(device, VOLUME_SCALAR);
        if found.is_empty() {
            return Err(AudioError::Unsupported);
        }
        let level = f32::from(volume.min(100)) / 100.0;
        for element in found {
            set(device, &output(VOLUME_SCALAR, element), level)?;
        }
        Ok(())
    }

    fn set_output_muted(&mut self, muted: bool) -> Result<(), AudioError> {
        let device = device()?;
        let found = elements(device, MUTE);
        if found.is_empty() {
            return Err(AudioError::Unsupported);
        }
        for element in found {
            set(device, &output(MUTE, element), u32::from(muted))?;
        }
        Ok(())
    }
}

/// macOS binds no driver to the controller's vendor interfaces, so nothing
/// can hold it but another program; presence is the caller's USB listing.
pub fn observe() -> Observed {
    Observed {
        os: "macos".into(),
        present: true,
        ..Default::default()
    }
}
