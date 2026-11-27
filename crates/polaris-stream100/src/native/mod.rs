//! The operating system's side: per-app volume, the controller's input, and
//! who holds the controller.
//!
//! - Windows: Core Audio sessions on every active output, and the Hercules
//!   driver / Stream Control probe ([`windows`]).
//! - Linux: the PulseAudio protocol, which PipeWire also serves ([`linux`]).
//! - macOS: Core Audio process taps for each app (macOS 14.2+, once the
//!   person allows system audio recording) and Core Audio's output volume
//!   ([`macos`]).
//! - What is playing, from the system's media session ([`media`]).

use crate::audio::{AudioError, AudioSessions, Cached};
use crate::ownership::Observed;

pub mod input;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub mod libusb;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod media;
#[cfg(windows)]
pub mod sdk;
#[cfg(windows)]
pub mod windows;
#[cfg(windows)]
pub mod winusb;

/// This system's per-app volume, opened on the calling thread, with its
/// reads kept for [`crate::audio::AUDIO_FRESH`] ([`Cached`]).
pub fn open() -> Result<Box<dyn AudioSessions>, AudioError> {
    #[cfg(windows)]
    return Ok(Box::new(Cached::new(windows::CoreAudio::open()?)));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(Cached::new(linux::Pulse::open()?)));
    #[cfg(target_os = "macos")]
    return Ok(Box::new(Cached::new(macos::CoreAudioOutput::open()?)));
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    Err(AudioError::Unsupported)
}

/// Whether per-app volume can be used here: `ready`, or on macOS `notAsked`,
/// `notAllowed` (system audio recording is off for Polaris) or
/// `needsNewerMacos` (before 14.2; the whole output still works).
pub fn per_app_access() -> &'static str {
    #[cfg(target_os = "macos")]
    return macos::access().code();
    #[cfg(not(target_os = "macos"))]
    "ready"
}

/// Asks the person for what per-app volume needs, where the system asks
/// (macOS: the system audio recording prompt). Nothing elsewhere.
pub fn request_per_app_access() {
    #[cfg(target_os = "macos")]
    macos::request_access();
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
