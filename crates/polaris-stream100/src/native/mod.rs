//! The operating system's side: per-app volume, the controller's input, and
//! who holds the controller.
//!
//! - Windows: Core Audio sessions on every active output, and the Hercules
//!   driver / Stream Control probe ([`windows`]).
//! - Linux: the PulseAudio protocol, which PipeWire also serves ([`linux`]).
//! - macOS: the whole output through Core Audio ([`macos`]); per-app volume
//!   there needs process taps (macOS 14.2+) and is not built yet.

use crate::audio::{AudioError, AudioSessions};
use crate::ownership::Observed;

pub mod input;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod libusb;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(windows)]
pub mod sdk;
#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub mod winusb;

/// This system's per-app volume, opened on the calling thread.
pub fn open() -> Result<Box<dyn AudioSessions>, AudioError> {
    #[cfg(windows)]
    return Ok(Box::new(windows::CoreAudio::open()?));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(linux::Pulse::open()?));
    #[cfg(target_os = "macos")]
    return Ok(Box::new(macos::CoreAudioOutput::open()?));
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err(AudioError::Unsupported)
}

/// What this system says about the controller. Outside Windows `present` is
/// left to the caller's USB listing.
pub fn observe() -> Observed {
    #[cfg(windows)]
    return windows::observe();
    #[cfg(target_os = "linux")]
    return linux::observe();
    #[cfg(target_os = "macos")]
    return macos::observe();
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Observed {
        os: std::env::consts::OS.into(),
        present: true,
        ..Default::default()
    }
}
