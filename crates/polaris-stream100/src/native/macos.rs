//! macOS: the whole output's volume and mute, through Core Audio's property
//! API on the default output device.
//!
//! macOS has no per-app volume API. What per-app mixers do there instead is
//! re-route every app's audio: Background Music and older SoundSource
//! versions install an audio driver (a HAL plug-in in
//! `/Library/Audio/Plug-Ins/HAL`, which needs an administrator and a Core
//! Audio restart), and on macOS 14.2+ a process tap
//! (`AudioHardwareCreateProcessTap` with a `CATapDescription` muting the app)
//! feeds a private aggregate device whose IO callback plays the app back at
//! its own gain. Neither is built here yet, so on macOS [`sessions`] lists no
//! apps and a knob set to calls, music, games or the browser does nothing;
//! [`crate::audio::backend_status`] says so. The whole output works on every
//! macOS version.
//!
//! [`sessions`]: AudioSessions::sessions

use crate::audio::{AudioError, AudioSessions, Session};
use crate::ownership::Observed;
use std::ffi::c_void;

type AudioObjectId = u32;
type OsStatus = i32;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectHasProperty(object: AudioObjectId, address: *const PropertyAddress) -> u8;
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
}

const fn four(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const SYSTEM_OBJECT: AudioObjectId = 1;
const DEFAULT_OUTPUT: u32 = four(b"dOut");
const SCOPE_GLOBAL: u32 = four(b"glob");
const SCOPE_OUTPUT: u32 = four(b"outp");
const ELEMENT_MAIN: u32 = 0;
const VOLUME_SCALAR: u32 = four(b"volm");
const MUTE: u32 = four(b"mute");
const STEREO_CHANNELS: u32 = four(b"dch2");

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

/// The default output device, asked for on every call so a switch to other
/// speakers or headphones is followed at once.
fn device() -> Result<AudioObjectId, AudioError> {
    let address = PropertyAddress {
        selector: DEFAULT_OUTPUT,
        scope: SCOPE_GLOBAL,
        element: ELEMENT_MAIN,
    };
    match get(SYSTEM_OBJECT, &address, 0u32)? {
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

pub struct CoreAudioOutput;

impl CoreAudioOutput {
    pub fn open() -> Result<Self, AudioError> {
        device()?;
        Ok(Self)
    }
}

impl AudioSessions for CoreAudioOutput {
    fn sessions(&mut self) -> Result<Vec<Session>, AudioError> {
        Ok(Vec::new())
    }

    fn set_volume(&mut self, _id: &str, _volume: u8) -> Result<(), AudioError> {
        Err(AudioError::Unsupported)
    }

    fn set_muted(&mut self, _id: &str, _muted: bool) -> Result<(), AudioError> {
        Err(AudioError::Unsupported)
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
