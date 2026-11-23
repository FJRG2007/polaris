//! OPAQUE (RFC 9807) WebAssembly binding of `polaris-core`. Conversion and
//! error mapping only (docs/rust-core-plan.md, 3.1). A module of its own, not
//! part of `polaris-core-wasm`: Argon2id and the curve arithmetic would take the
//! core module far past its size budget, and only the screens that take a
//! password fetch this one. Export names equal the Node binding's.

use wasm_bindgen::prelude::*;

fn opaque_error(error: polaris_core::opaque::Error) -> JsValue {
    let error = js_sys::Error::new(&error.to_string());
    // Setting a plain data property on a fresh Error object cannot fail.
    let _ = js_sys::Reflect::set(
        &error,
        &JsValue::from_str("code"),
        &JsValue::from_str("Error"),
    );
    error.into()
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

#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueServerLoginStart {
    #[wasm_bindgen(js_name = serverLoginState)]
    pub server_login_state: String,
    #[wasm_bindgen(js_name = loginResponse)]
    pub login_response: String,
}

#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueClientStart {
    pub state: String,
    pub request: String,
}

#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueClientRegistrationFinish {
    #[wasm_bindgen(js_name = registrationRecord)]
    pub registration_record: String,
    #[wasm_bindgen(js_name = exportKey)]
    pub export_key: String,
    #[wasm_bindgen(js_name = serverStaticPublicKey)]
    pub server_static_public_key: String,
}

#[wasm_bindgen(getter_with_clone)]
pub struct OpaqueClientLoginFinish {
    #[wasm_bindgen(js_name = finishLoginRequest)]
    pub finish_login_request: String,
    #[wasm_bindgen(js_name = sessionKey)]
    pub session_key: String,
    #[wasm_bindgen(js_name = exportKey)]
    pub export_key: String,
    #[wasm_bindgen(js_name = serverStaticPublicKey)]
    pub server_static_public_key: String,
}

#[wasm_bindgen(js_name = opaqueCreateServerSetup)]
pub fn opaque_create_server_setup(seed: &[u8]) -> Result<String, JsValue> {
    polaris_core::opaque::seeded::create_server_setup(seed).map_err(opaque_error)
}

#[wasm_bindgen(js_name = opaqueServerPublicKey)]
pub fn opaque_server_public_key(server_setup: String) -> Result<String, JsValue> {
    polaris_core::opaque::server_public_key(&server_setup).map_err(opaque_error)
}

#[wasm_bindgen(js_name = opaqueCreateRegistrationResponse)]
pub fn opaque_create_registration_response(
    server_setup: String,
    user_identifier: String,
    registration_request: String,
) -> Result<String, JsValue> {
    polaris_core::opaque::create_registration_response(
        &server_setup,
        &user_identifier,
        &registration_request,
    )
    .map_err(opaque_error)
}

#[wasm_bindgen(js_name = opaqueStartServerLogin)]
pub fn opaque_start_server_login(
    seed: &[u8],
    server_setup: String,
    registration_record: Option<String>,
    start_login_request: String,
    user_identifier: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
) -> Result<OpaqueServerLoginStart, JsValue> {
    polaris_core::opaque::seeded::start_server_login(
        seed,
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

#[wasm_bindgen(js_name = opaqueFinishServerLogin)]
pub fn opaque_finish_server_login(
    server_login_state: String,
    finish_login_request: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
) -> Result<String, JsValue> {
    polaris_core::opaque::finish_server_login(
        &server_login_state,
        &finish_login_request,
        idents(&client_identity, &server_identity),
    )
    .map_err(opaque_error)
}

#[wasm_bindgen(js_name = opaqueStartClientRegistration)]
pub fn opaque_start_client_registration(
    seed: &[u8],
    password: String,
) -> Result<OpaqueClientStart, JsValue> {
    polaris_core::opaque::seeded::start_client_registration(seed, &password)
        .map(|s| OpaqueClientStart {
            state: s.state,
            request: s.request,
        })
        .map_err(opaque_error)
}

#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = opaqueFinishClientRegistration)]
pub fn opaque_finish_client_registration(
    seed: &[u8],
    client_registration_state: String,
    registration_response: String,
    password: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
    memory: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<OpaqueClientRegistrationFinish, JsValue> {
    polaris_core::opaque::seeded::finish_client_registration(
        seed,
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

#[wasm_bindgen(js_name = opaqueStartClientLogin)]
pub fn opaque_start_client_login(
    seed: &[u8],
    password: String,
) -> Result<OpaqueClientStart, JsValue> {
    polaris_core::opaque::seeded::start_client_login(seed, &password)
        .map(|s| OpaqueClientStart {
            state: s.state,
            request: s.request,
        })
        .map_err(opaque_error)
}

#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = opaqueFinishClientLogin)]
pub fn opaque_finish_client_login(
    seed: &[u8],
    client_login_state: String,
    login_response: String,
    password: String,
    client_identity: Option<String>,
    server_identity: Option<String>,
    memory: u32,
    iterations: u32,
    parallelism: u32,
) -> Result<Option<OpaqueClientLoginFinish>, JsValue> {
    polaris_core::opaque::seeded::finish_client_login(
        seed,
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
