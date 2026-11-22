//! WebAssembly binding of `polaris-core`. Conversion and error mapping only:
//! no domain logic lives here (docs/rust-core-plan.md, 3.1).
//!
//! The export names match the Node binding's, so the facade drives both
//! through one interface. A domain error crosses as a JavaScript `Error` whose
//! `code` is the TypeScript error class name and whose message is the
//! TypeScript message. A panic traps (wasm32 aborts on panic), which reaches
//! JavaScript as a `WebAssembly.RuntimeError`; the facade then drops the
//! instance and falls back.

use wasm_bindgen::prelude::*;

fn coded_error(class: &str, message: String) -> JsValue {
    let error = js_sys::Error::new(&message);
    // Setting a plain data property on a fresh Error object cannot fail.
    let _ = js_sys::Reflect::set(
        &error,
        &JsValue::from_str("code"),
        &JsValue::from_str(class),
    );
    error.into()
}

#[wasm_bindgen(js_name = probeFnv1a32)]
pub fn probe_fnv1a32(text: &str) -> u32 {
    polaris_core::probe::fnv1a32(text)
}

#[wasm_bindgen(js_name = probeDecodeHex)]
pub fn probe_decode_hex(hex: &str) -> Result<Vec<u8>, JsValue> {
    polaris_core::probe::decode_hex(hex).map_err(|e| coded_error("RangeError", e.to_string()))
}

/// Panics on purpose, so the facade's tests can prove a real trap is caught
/// and answered by the TypeScript implementation.
#[wasm_bindgen(js_name = probePanic)]
pub fn probe_panic() {
    panic!("polaris-core-wasm: deliberate panic for the facade's fallback test");
}
