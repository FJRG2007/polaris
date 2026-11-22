//! Polaris' shared core (docs/rust-core-plan.md).
//!
//! Pure logic only: no I/O, no platform code, no clock and no randomness that
//! is not passed in as an argument. Every domain is one module, reached from
//! Node through `polaris-core-node` and from browsers through
//! `polaris-core-wasm`; both bindings only convert types and map errors.

pub mod probe;
