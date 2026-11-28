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
//! - [`theme`]: the screen's colours, label size and pictures, and the
//!   palette they are drawn with.
//! - [`plugin`]: the same settings as the plugin page's flat fields.
//! - [`sdk`]: the Hercules SDK's input state, as the same reports.
//! - [`engine`]: reports in, volume changes and Polaris actions out.
//! - [`screen`]: what the screen shows (each knob's volume), drawn into
//!   frames, and the order a session sends them and its keep-alive in.
//! - [`session`]: the start-up reads and keep-alive of a plain-USB session,
//!   and the device interface of Polaris' own WinUSB driver package.
//!
//! Everything above is pure. The USB transport is behind the `usb` feature;
//! the operating system's per-app volume and the Windows ownership probe are
//! behind `native` ([`native`]).

pub mod audio;
pub mod display;
pub mod encoder;
pub mod engine;
pub mod manifest;
pub mod ownership;
pub mod plugin;
pub mod report;
pub mod screen;
pub mod sdk;
pub mod session;
pub mod settings;
pub mod theme;

#[cfg(feature = "native")]
pub mod native;
#[cfg(feature = "usb")]
pub mod transport;

/// The controller's USB vendor id (Guillemot / Hercules).
pub const VENDOR_ID: u16 = 0x06f8;
/// The Stream 100's USB product id.
pub const PRODUCT_ID: u16 = 0xe053;
