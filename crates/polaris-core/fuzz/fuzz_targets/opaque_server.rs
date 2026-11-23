//! The server's OPAQUE steps on untrusted messages: a registration request, a
//! stored record, a login request, a login finish and a login state. None may
//! panic, and every refusal is an encoding or protocol error.

#![no_main]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use libfuzzer_sys::fuzz_target;
use polaris_core::opaque::{self, seeded, Error, Idents};
use std::sync::OnceLock;

/// Each fuzz input becomes several fields: split on 0xff, each part sent both
/// base64url-encoded (so it reaches the message parsers) and raw as text (so it
/// exercises the decoder).
fn fields(data: &[u8]) -> Vec<String> {
    data.split(|b| *b == 0xff)
        .flat_map(|part| {
            [
                URL_SAFE_NO_PAD.encode(part),
                String::from_utf8_lossy(part).into_owned(),
            ]
        })
        .collect()
}

fn field(all: &[String], i: usize) -> &str {
    all.get(i).map(String::as_str).unwrap_or("")
}

fn setup() -> &'static str {
    static SETUP: OnceLock<String> = OnceLock::new();
    SETUP.get_or_init(|| seeded::create_server_setup(&[7; 32]).unwrap())
}

fn refusal(result: Result<impl Sized, Error>) {
    if let Err(error) = result {
        assert!(
            matches!(error, Error::Encoding(_) | Error::Protocol(_)),
            "{error}"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let f = fields(data);
    let idents = Idents {
        client: Some("fuzz"),
        server: None,
    };
    refusal(opaque::server_public_key(field(&f, 0)));
    refusal(opaque::create_registration_response(
        setup(),
        "fuzz",
        field(&f, 0),
    ));
    refusal(seeded::start_server_login(
        &[9; 32],
        setup(),
        Some(field(&f, 2)),
        field(&f, 0),
        "fuzz",
        idents,
    ));
    refusal(seeded::start_server_login(
        &[9; 32],
        setup(),
        None,
        field(&f, 1),
        "fuzz",
        idents,
    ));
    refusal(opaque::finish_server_login(
        field(&f, 4),
        field(&f, 2),
        idents,
    ));
});
