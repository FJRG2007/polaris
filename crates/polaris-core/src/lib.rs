//! Polaris' shared core (docs/rust-core-plan.md).
//!
//! Pure logic only: no I/O, no platform code, no clock and no randomness that
//! is not passed in as an argument. Every domain is one module, reached from
//! Node through `polaris-core-node` and from browsers through
//! `polaris-core-wasm`; both bindings only convert types and map errors.

pub mod phone;
pub mod probe;

#[cfg(feature = "mls")]
pub mod mls;

#[cfg(feature = "opaque")]
pub mod opaque;

/// USB presence for the desktop's device plugins. Platform I/O, so it is its
/// own crate (`polaris-core-usb`) and nothing here: re-exported so the Node
/// binding, which may depend on polaris-core alone, can reach it.
#[cfg(feature = "usb")]
pub use polaris_core_usb as usb;
