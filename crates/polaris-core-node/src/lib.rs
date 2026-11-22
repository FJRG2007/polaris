//! Node binding of `polaris-core`. Conversion and error mapping only: no
//! domain logic lives here (docs/rust-core-plan.md, 3.1).
//!
//! A domain error crosses as a JavaScript `Error` whose `code` is the name of
//! the error class the TypeScript implementation throws (`RangeError`, ...)
//! and whose message is that implementation's message; the facade rebuilds
//! the same class from it. Every export catches panics, so a defect surfaces
//! as an `Error` without that code and the facade falls back, instead of
//! aborting the process (built with the `release-node` profile, which
//! unwinds).

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

/// The code a domain error carries across the boundary.
pub struct ErrorClass(&'static str);

impl AsRef<str> for ErrorClass {
    fn as_ref(&self) -> &str {
        self.0
    }
}

fn range_error(error: impl ToString) -> napi::Error<ErrorClass> {
    napi::Error::new(ErrorClass("RangeError"), error.to_string())
}

// napi-rs would camel-case this as probeFnv1A32; the name must equal the
// WebAssembly binding's.
#[napi(js_name = "probeFnv1a32", catch_unwind)]
pub fn probe_fnv1a32(text: String) -> u32 {
    polaris_core::probe::fnv1a32(&text)
}

#[napi(catch_unwind)]
pub fn probe_decode_hex(hex: String) -> napi::Result<Uint8Array, ErrorClass> {
    polaris_core::probe::decode_hex(&hex)
        .map(Uint8Array::from)
        .map_err(range_error)
}

/// Panics on purpose. The facade's failure-injection tests call it to prove
/// that a real panic inside the binding reaches JavaScript as a catchable
/// error and is answered by the TypeScript implementation.
#[napi(catch_unwind)]
pub fn probe_panic() {
    panic!("polaris-core-node: deliberate panic for the facade's fallback test");
}
