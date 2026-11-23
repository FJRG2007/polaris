//! Polaris' driver for the Hercules Stream 100 (USB `06f8:e053`).
//!
//! The protocol is written down in `docs/devices/hercules-stream100.md`; this
//! crate is its implementation, written from those facts:
//!
//! - [`report`]: the 64-byte input report (buttons and the four encoders).
//! - [`encoder`]: turning raw encoder counts into volume steps without the
//!   jitter, the banked counts and the runaway jumps the official software has.
//! - [`display`]: the `SM` message framing, its checksum, and the 480x272
//!   indexed framebuffer split into the messages the controller accepts.
//! - [`audio`]: what a knob controls - a category of apps (music, calls,
//!   games, browser, system) or a pinned program - and the trait each
//!   operating system's per-app volume backend implements.
//! - [`manifest`]: how the module describes itself to the desktop app, so it
//!   is loaded only while the controller is plugged in.
//! - [`ownership`]: who holds the device on this machine, and what to offer.
//! - [`settings`]: stored values, defaults, and the declarative settings schema.
//!
//! Everything above is pure. The USB transport is behind the `usb` feature.

pub mod audio;
pub mod display;
pub mod encoder;
pub mod manifest;
pub mod ownership;
pub mod report;
pub mod settings;

#[cfg(feature = "usb")]
pub mod transport;

/// The controller's USB vendor id (Guillemot / Hercules).
pub const VENDOR_ID: u16 = 0x06f8;
/// The Stream 100's USB product id.
pub const PRODUCT_ID: u16 = 0xe053;
