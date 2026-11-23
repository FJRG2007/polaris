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

use napi::bindgen_prelude::{BigInt, Uint8Array};
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

// ---- mls (docs/rust-core-plan.md Phase 2, E1) ----------------------------
// One device's MLS state behind a class. Every argument and result is the
// RFC 9420 wire encoding; an error carries the domain's code (`MlsRejected`,
// ...) and OpenMLS's explanation.

fn mls_error(error: polaris_core::mls::MlsError) -> napi::Error<ErrorClass> {
    napi::Error::new(ErrorClass(error.code()), error.message)
}

/// What a commit produced (`polaris_core::mls::CommitOutput`).
#[napi(object)]
pub struct MlsCommit {
    pub commit: Uint8Array,
    pub welcome: Option<Uint8Array>,
    pub group_info: Option<Uint8Array>,
}

fn mls_commit(output: polaris_core::mls::CommitOutput) -> MlsCommit {
    MlsCommit {
        commit: output.commit.into(),
        welcome: output.welcome.map(Uint8Array::from),
        group_info: output.group_info.map(Uint8Array::from),
    }
}

/// An external join: the group id and the commit to send.
#[napi(object)]
pub struct MlsExternalJoin {
    pub group_id: Uint8Array,
    pub commit: Uint8Array,
}

/// The outcome of processing a message (`polaris_core::mls::Processed`).
#[napi(object)]
pub struct MlsProcessed {
    pub kind: String,
    pub sender_leaf: Option<u32>,
    pub sender_identity: Uint8Array,
    pub plaintext: Uint8Array,
    pub epoch: BigInt,
    pub active: bool,
}

/// One leaf of a group (`polaris_core::mls::GroupMember`).
#[napi(object)]
pub struct MlsGroupMember {
    pub leaf: u32,
    pub identity: Uint8Array,
    pub signature_key: Uint8Array,
}

#[napi]
pub struct MlsMember {
    inner: polaris_core::mls::Member,
    journal: polaris_core::mls::Journal,
}

/// One key the host's store writes (`value`) or deletes (no `value`),
/// `polaris_core::mls::StoreChange`.
#[napi(object)]
pub struct MlsStoreChange {
    pub key: Uint8Array,
    pub value: Option<Uint8Array>,
}

#[napi]
impl MlsMember {
    #[napi(constructor, catch_unwind)]
    pub fn new(
        identity: Uint8Array,
        ciphersuite: u32,
        seed: Uint8Array,
    ) -> napi::Result<Self, ErrorClass> {
        polaris_core::mls::Member::from_binding(&identity, ciphersuite, &seed)
            .map(|inner| MlsMember {
                inner,
                journal: polaris_core::mls::Journal::default(),
            })
            .map_err(mls_error)
    }

    /// The device as the host's store holds it (`keys[i]` holds `values[i]`);
    /// `seed` is fresh for this boot.
    #[napi(factory, catch_unwind)]
    pub fn restore(
        identity: Uint8Array,
        ciphersuite: u32,
        seed: Uint8Array,
        keys: Vec<Uint8Array>,
        values: Vec<Uint8Array>,
        signature_public_key: Uint8Array,
    ) -> napi::Result<Self, ErrorClass> {
        polaris_core::mls::Member::restore_from_binding(
            &identity,
            ciphersuite,
            &seed,
            keys.iter().map(|key| key.to_vec()).collect(),
            values.iter().map(|value| value.to_vec()).collect(),
            &signature_public_key,
        )
        .map(|(inner, journal)| MlsMember { inner, journal })
        .map_err(mls_error)
    }

    /// Everything changed since the last call, for the host to write in one
    /// transaction (`polaris_core::mls::Journal`).
    #[napi(catch_unwind)]
    pub fn store_changes(&self) -> Vec<MlsStoreChange> {
        polaris_core::mls::Journal::changes(&self.journal, self.inner.storage())
            .into_iter()
            .map(|change| MlsStoreChange {
                key: change.key.into(),
                value: change.value.map(Uint8Array::from),
            })
            .collect()
    }

    #[napi(catch_unwind)]
    pub fn signature_public_key(&self) -> Uint8Array {
        polaris_core::mls::Member::signature_public_key(&self.inner)
            .to_vec()
            .into()
    }

    #[napi(catch_unwind)]
    pub fn key_package(&self) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::key_package(&self.inner)
            .map(Uint8Array::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn create_group(&self, group_id: Uint8Array) -> napi::Result<(), ErrorClass> {
        polaris_core::mls::Member::create_group(&self.inner, &group_id).map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn add_members(
        &self,
        group_id: Uint8Array,
        key_packages: Vec<Uint8Array>,
    ) -> napi::Result<MlsCommit, ErrorClass> {
        let packages: Vec<Vec<u8>> = key_packages
            .iter()
            .map(|package| package.to_vec())
            .collect();
        polaris_core::mls::Member::add_members(&self.inner, &group_id, &packages)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn remove_members(
        &self,
        group_id: Uint8Array,
        leaves: Vec<u32>,
    ) -> napi::Result<MlsCommit, ErrorClass> {
        polaris_core::mls::Member::remove_members(&self.inner, &group_id, &leaves)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn self_update(&self, group_id: Uint8Array) -> napi::Result<MlsCommit, ErrorClass> {
        polaris_core::mls::Member::self_update(&self.inner, &group_id)
            .map(mls_commit)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn merge_pending_commit(&self, group_id: Uint8Array) -> napi::Result<(), ErrorClass> {
        polaris_core::mls::Member::merge_pending_commit(&self.inner, &group_id).map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn clear_pending_commit(&self, group_id: Uint8Array) -> napi::Result<(), ErrorClass> {
        polaris_core::mls::Member::clear_pending_commit(&self.inner, &group_id).map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn join_by_welcome(&self, welcome: Uint8Array) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::join_by_welcome(&self.inner, &welcome)
            .map(Uint8Array::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn group_info(&self, group_id: Uint8Array) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::group_info(&self.inner, &group_id)
            .map(Uint8Array::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn join_by_external_commit(
        &self,
        group_info: Uint8Array,
    ) -> napi::Result<MlsExternalJoin, ErrorClass> {
        polaris_core::mls::Member::join_by_external_commit(&self.inner, &group_info)
            .map(|(group_id, commit)| MlsExternalJoin {
                group_id: group_id.into(),
                commit: commit.into(),
            })
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn encrypt(
        &self,
        group_id: Uint8Array,
        plaintext: Uint8Array,
    ) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::encrypt(&self.inner, &group_id, &plaintext)
            .map(Uint8Array::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn process(
        &self,
        group_id: Uint8Array,
        message: Uint8Array,
    ) -> napi::Result<MlsProcessed, ErrorClass> {
        polaris_core::mls::Member::process(&self.inner, &group_id, &message)
            .map(|processed| MlsProcessed {
                kind: processed.kind.as_str().to_string(),
                sender_leaf: processed.sender_leaf,
                sender_identity: processed.sender_identity.into(),
                plaintext: processed.plaintext.into(),
                epoch: BigInt::from(processed.epoch),
                active: processed.active,
            })
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn epoch(&self, group_id: Uint8Array) -> napi::Result<BigInt, ErrorClass> {
        polaris_core::mls::Member::epoch(&self.inner, &group_id)
            .map(BigInt::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn epoch_authenticator(
        &self,
        group_id: Uint8Array,
    ) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::epoch_authenticator(&self.inner, &group_id)
            .map(Uint8Array::from)
            .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn export_secret(
        &self,
        group_id: Uint8Array,
        label: String,
        context: Uint8Array,
        length: u32,
    ) -> napi::Result<Uint8Array, ErrorClass> {
        polaris_core::mls::Member::export_secret(
            &self.inner,
            &group_id,
            &label,
            &context,
            length as usize,
        )
        .map(Uint8Array::from)
        .map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn own_leaf(&self, group_id: Uint8Array) -> napi::Result<u32, ErrorClass> {
        polaris_core::mls::Member::own_leaf(&self.inner, &group_id).map_err(mls_error)
    }

    #[napi(catch_unwind)]
    pub fn members(&self, group_id: Uint8Array) -> napi::Result<Vec<MlsGroupMember>, ErrorClass> {
        polaris_core::mls::Member::members(&self.inner, &group_id)
            .map(|members| {
                members
                    .into_iter()
                    .map(|member| MlsGroupMember {
                        leaf: member.leaf,
                        identity: member.identity.into(),
                        signature_key: member.signature_key.into(),
                    })
                    .collect()
            })
            .map_err(mls_error)
    }
}

fn coded(error: polaris_core::phone::PhoneError) -> napi::Error<ErrorClass> {
    napi::Error::new(ErrorClass(error.class), error.message)
}

/// `splitPhone` across the boundary: `national` is new text, or else the
/// input's UTF-16 range `start..end` is.
#[napi(object)]
pub struct PhoneSplit {
    pub country: Option<String>,
    pub national: Option<String>,
    pub start: u32,
    pub end: u32,
}

#[napi(catch_unwind)]
pub fn phone_countries() -> Vec<&'static str> {
    polaris_core::phone::phone_countries()
}

#[napi(catch_unwind)]
pub fn phone_is_country(code: Option<String>) -> bool {
    polaris_core::phone::is_phone_country(code.as_deref())
}

#[napi(catch_unwind)]
pub fn phone_calling_code(country: String) -> napi::Result<Option<&'static str>, ErrorClass> {
    polaris_core::phone::phone_calling_code(&country).map_err(coded)
}

#[napi(catch_unwind)]
pub fn phone_main_country(calling_code: String) -> Option<&'static str> {
    polaris_core::phone::phone_main_country(&calling_code)
}

#[napi(js_name = "phoneToE164", catch_unwind)]
pub fn phone_to_e164(
    value: String,
    country: Option<String>,
) -> napi::Result<Option<String>, ErrorClass> {
    polaris_core::phone::to_e164(&value, country.as_deref()).map_err(coded)
}

#[napi(catch_unwind)]
pub fn phone_country_of(value: String) -> napi::Result<Option<&'static str>, ErrorClass> {
    polaris_core::phone::phone_country_of(&value).map_err(coded)
}

#[napi(catch_unwind)]
pub fn phone_split(value: String) -> napi::Result<PhoneSplit, ErrorClass> {
    polaris_core::phone::split_phone(&value)
        .map(|(country, text)| PhoneSplit {
            country: country.map(str::to_string),
            national: text.owned().map(str::to_string),
            start: text.range().0 as u32,
            end: text.range().1 as u32,
        })
        .map_err(coded)
}

#[napi(catch_unwind)]
pub fn phone_format_as_typed(
    value: String,
    country: Option<String>,
) -> napi::Result<String, ErrorClass> {
    polaris_core::phone::format_phone_as_typed(&value, country.as_deref()).map_err(coded)
}

/// `None` means the input comes back unchanged.
#[napi(catch_unwind)]
pub fn phone_format_international(value: String) -> napi::Result<Option<String>, ErrorClass> {
    polaris_core::phone::format_phone_international(&value)
        .map(|text| text.owned().map(str::to_string))
        .map_err(coded)
}

#[napi(catch_unwind)]
pub fn phone_country_from_regions(regions: Vec<Option<String>>) -> Option<&'static str> {
    polaris_core::phone::phone_country_from_regions(regions.iter().map(Option::as_deref))
}
