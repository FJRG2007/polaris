//! The client's OPAQUE steps on untrusted server messages and stored states:
//! a registration response and a login response (from the server), and the
//! client's own states. None may panic, and every refusal is an encoding or
//! protocol error or a refused login (`None`).

#![no_main]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use libfuzzer_sys::fuzz_target;
use polaris_core::opaque::{seeded, Error, Idents};

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

fn refusal(result: Result<impl Sized, Error>) {
    if let Err(error) = result {
        assert!(
            matches!(error, Error::Encoding(_) | Error::Protocol(_)),
            "{error}"
        );
    }
}

const FAST: [u32; 3] = [8, 1, 1];

fuzz_target!(|data: &[u8]| {
    let f = fields(data);
    let idents = Idents {
        client: Some("fuzz"),
        server: None,
    };
    let [m, t, p] = FAST;
    let reg = seeded::start_client_registration(&[1; 32], "pw").unwrap();
    let login = seeded::start_client_login(&[2; 32], "pw").unwrap();
    refusal(seeded::finish_client_registration(
        &[3; 32],
        &reg.state,
        field(&f, 0),
        "pw",
        idents,
        m,
        t,
        p,
    ));
    refusal(seeded::finish_client_registration(
        &[3; 32],
        field(&f, 1),
        field(&f, 2),
        "pw",
        idents,
        m,
        t,
        p,
    ));
    refusal(seeded::finish_client_login(
        &[4; 32],
        &login.state,
        field(&f, 0),
        "pw",
        idents,
        m,
        t,
        p,
    ));
    refusal(seeded::finish_client_login(
        &[4; 32],
        field(&f, 3),
        field(&f, 2),
        "pw",
        idents,
        m,
        t,
        p,
    ));
});
