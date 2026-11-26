//! The operating system's side: per-app volume, the controller's input, and
//! who holds the controller.
//!
//! - Windows: Core Audio sessions on every active output, and the Hercules
//!   driver / Stream Control probe ([`windows`]).
//! - Linux: the PulseAudio protocol, which PipeWire also serves ([`linux`]).
//! - macOS: per-app volume needs process taps (macOS 14.2+) plus an audio
//!   driver of its own; not built yet, and [`open`] says so.

use crate::audio::{AudioError, AudioSessions};
use crate::ownership::Observed;

pub mod input;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(windows)]
pub mod sdk;
#[cfg(windows)]
pub mod windows;

/// This system's per-app volume, opened on the calling thread.
pub fn open() -> Result<Box<dyn AudioSessions>, AudioError> {
    #[cfg(windows)]
    return Ok(Box::new(windows::CoreAudio::open()?));
    #[cfg(target_os = "linux")]
    return Ok(Box::new(linux::Pulse::open()?));
    #[cfg(not(any(windows, target_os = "linux")))]
    Err(AudioError::Unsupported)
}

/// What this system says about the controller. Outside Windows `present` is
/// left to the caller's USB listing.
pub fn observe() -> Observed {
    #[cfg(windows)]
    return windows::observe();
    #[cfg(target_os = "linux")]
    return linux::observe();
    #[cfg(not(any(windows, target_os = "linux")))]
    Observed {
        os: "macos".into(),
        present: true,
        ..Default::default()
    }
}
