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

// OPAQUE (RFC 9807), polaris_core::opaque. Every message and state is
// unpadded base64url, exactly as @serenity-kit/opaque speaks it; `seed` is 32
// bytes the facade draws from crypto.getRandomValues for this one call.

fn opaque_error(error: polaris_core::opaque::Error) -> napi::Error<ErrorClass> {
    napi::Error::new(ErrorClass("Error"), error.to_string())
}

fn idents<'a>(
    client: &'a Option<String>,
    server: &'a Option<String>,
) -> polaris_core::opaque::Idents<'a> {
    polaris_core::opaque::Idents {
        client: client.as_deref(),
        server: server.as_deref(),
    }
}

#[napi(object)]
pub struct OpaqueServerLoginStart {
    pub server_login_state: String,
    pub login_response: String,
}

#[napi(object)]
pub struct OpaqueClientStart {
    pub state: String,
    pub request: String,
}

#[napi(object)]
pub struct OpaqueClientRegistrationFinish {
    pub registration_record: String,
    pub export_key: String,
    pub server_static_public_key: String,
}

#[napi(object)]
pub struct OpaqueClientLoginFinish {
    pub finish_login_request: String,
    pub session_key: String,
    pub export_key: String,
    pub server_static_public_key: String,
}

#[napi(catch_unwind)]
pub fn opaque_create_server_setup(seed: Uint8Array) -> napi::Result<String, ErrorClass> {
    polaris_core::opaque::seeded::create_server_setup(&seed).map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_server_public_key(server_setup: String) -> napi::Result<String, ErrorClass> {
    polaris_core::opaque::server_public_key(&server_setup).map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_create_registration_response(
    server_setup: String,
    user_identifier: String,
    registration_request: String,
) -> napi::Result<String, ErrorClass> {
    polaris_core::opaque::create_registration_response(
        &server_setup,
        &user_identifier,
        &registration_request,
    )
    .map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_start_server_login(
    seed: Uint8Array,
    server_setup: String,
    registration_record: Option<String>,
    start_login_request: String,
    user_identifier: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
) -> napi::Result<OpaqueServerLoginStart, ErrorClass> {
    polaris_core::opaque::seeded::start_server_login(
        &seed,
        &server_setup,
        registration_record.as_deref(),
        &start_login_request,
        &user_identifier,
        idents(&client_identity, &server_identity),
    )
    .map(|s| OpaqueServerLoginStart {
        server_login_state: s.server_login_state,
        login_response: s.login_response,
    })
    .map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_finish_server_login(
    server_login_state: String,
    finish_login_request: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
) -> napi::Result<String, ErrorClass> {
    polaris_core::opaque::finish_server_login(
        &server_login_state,
        &finish_login_request,
        idents(&client_identity, &server_identity),
    )
    .map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_start_client_registration(
    seed: Uint8Array,
    password: String,
) -> napi::Result<OpaqueClientStart, ErrorClass> {
    polaris_core::opaque::seeded::start_client_registration(&seed, &password)
        .map(|s| OpaqueClientStart {
            state: s.state,
            request: s.request,
        })
        .map_err(opaque_error)
}

#[allow(clippy::too_many_arguments)]
#[napi(catch_unwind)]
pub fn opaque_finish_client_registration(
    seed: Uint8Array,
    client_registration_state: String,
    registration_response: String,
    password: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
    memory: u32,
    iterations: u32,
    parallelism: u32,
) -> napi::Result<OpaqueClientRegistrationFinish, ErrorClass> {
    polaris_core::opaque::seeded::finish_client_registration(
        &seed,
        &client_registration_state,
        &registration_response,
        &password,
        idents(&client_identity, &server_identity),
        memory,
        iterations,
        parallelism,
    )
    .map(|f| OpaqueClientRegistrationFinish {
        registration_record: f.registration_record,
        export_key: f.export_key,
        server_static_public_key: f.server_static_public_key,
    })
    .map_err(opaque_error)
}

#[napi(catch_unwind)]
pub fn opaque_start_client_login(
    seed: Uint8Array,
    password: String,
) -> napi::Result<OpaqueClientStart, ErrorClass> {
    polaris_core::opaque::seeded::start_client_login(&seed, &password)
        .map(|s| OpaqueClientStart {
            state: s.state,
            request: s.request,
        })
        .map_err(opaque_error)
}

#[allow(clippy::too_many_arguments)]
#[napi(catch_unwind)]
pub fn opaque_finish_client_login(
    seed: Uint8Array,
    client_login_state: String,
    login_response: String,
    password: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
    memory: u32,
    iterations: u32,
    parallelism: u32,
) -> napi::Result<Option<OpaqueClientLoginFinish>, ErrorClass> {
    polaris_core::opaque::seeded::finish_client_login(
        &seed,
        &client_login_state,
        &login_response,
        &password,
        idents(&client_identity, &server_identity),
        memory,
        iterations,
        parallelism,
    )
    .map(|done| {
        done.map(|f| OpaqueClientLoginFinish {
            finish_login_request: f.finish_login_request,
            session_key: f.session_key,
            export_key: f.export_key,
            server_static_public_key: f.server_static_public_key,
        })
    })
    .map_err(opaque_error)
}
