//! OPAQUE (RFC 9807): the RFC's own vectors replayed through the module's
//! generic steps, then the production suite's behaviour - round trips, every
//! refusal, enumeration resistance, tampering and malformed input.
//! Native only: the vectors are read from disk and the properties use
//! proptest, which does not build for wasm32.

#![cfg(not(target_arch = "wasm32"))]

use polaris_core::opaque::{self, generic, Error, Idents, KsfParams};
use proptest::prelude::*;
use rand_core::{CryptoRng, OsRng, RngCore};
use serde_json::Value;
use std::collections::VecDeque;

/// The RFC vectors' suite: ours with the identity KSF (RFC 9807, C.1).
type Identity = opaque_ke::ksf::Identity;
type VectorSuite = opaque::Suite<Identity>;

/// Hands out the vector's random inputs in the order the protocol draws them.
/// A 32-byte scalar asked for as 64 bytes (the OPRF blind, reduced wide) is
/// padded with zeros, which reduces to the scalar itself.
/// `random_first` draws come from the OS before the script starts: the
/// server's login start always builds a dummy record first (constant time, so
/// a known account costs the same as an unknown one), and the vector does not
/// cover those draws because a real record replaces the dummy.
struct Script(VecDeque<Vec<u8>>, usize, usize);

impl Script {
    fn new(chunks: &[&str]) -> Self {
        Script(chunks.iter().map(|c| hex(c)).collect(), 0, 0)
    }
    fn after_random(random_first: usize, chunks: &[&str]) -> Self {
        Script(chunks.iter().map(|c| hex(c)).collect(), random_first, 0)
    }
    fn drained(&self) -> bool {
        self.0.is_empty()
    }
}

impl RngCore for Script {
    fn next_u32(&mut self) -> u32 {
        unreachable!("the protocol only fills byte buffers")
    }
    fn next_u64(&mut self) -> u64 {
        unreachable!("the protocol only fills byte buffers")
    }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        self.2 += 1;
        if self.1 > 0 {
            self.1 -= 1;
            return OsRng.fill_bytes(dest);
        }
        let Some(chunk) = self.0.pop_front() else {
            panic!(
                "the script ran out of random inputs ({} bytes asked)",
                dest.len()
            )
        };
        assert!(
            chunk.len() <= dest.len(),
            "asked for {} bytes, script has {}",
            dest.len(),
            chunk.len()
        );
        dest.fill(0);
        dest[..chunk.len()].copy_from_slice(&chunk);
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl CryptoRng for Script {}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unb64(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text)
        .unwrap()
}

fn vectors() -> Vec<Value> {
    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/opaque-rfc9807.json"
    );
    let data: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    data["vectors"].as_array().unwrap().clone()
}

#[test]
fn rfc9807_real_vectors_replay() {
    let all = vectors();
    assert_eq!(all.len(), 2, "both ristretto255 vectors of C.1");
    for v in all {
        let f = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("{} lacks {k}", v["name"]))
                .to_string()
        };
        let name = f("name");
        let password = String::from_utf8(hex(&f("password"))).unwrap();
        let user = String::from_utf8(hex(&f("credential_identifier"))).unwrap();
        let client_id = v["client_identity"]
            .as_str()
            .map(|h| String::from_utf8(hex(h)).unwrap());
        let server_id = v["server_identity"]
            .as_str()
            .map(|h| String::from_utf8(hex(h)).unwrap());
        let idents = Idents {
            client: client_id.as_deref(),
            server: server_id.as_deref(),
        };
        let context = hex(&f("Context"));

        // ServerSetup serialises as oprf_seed || server private key || dummy public key.
        let setup_bytes = [
            hex(&f("oprf_seed")),
            hex(&f("server_private_key")),
            hex(&f("server_public_key")),
        ]
        .concat();
        let setup = opaque_ke::ServerSetup::<VectorSuite>::deserialize(&setup_bytes).unwrap();

        let mut rng = Script::new(&[&f("blind_registration")]);
        let reg = generic::start_client_registration::<Identity, _>(&mut rng, &password).unwrap();
        assert!(rng.drained(), "{name}: registration start");
        assert_eq!(
            unb64(&reg.request),
            hex(&f("registration_request")),
            "{name}: registration_request"
        );

        let response =
            generic::registration_response::<Identity>(&setup, &user, &reg.request).unwrap();
        assert_eq!(
            unb64(&response),
            hex(&f("registration_response")),
            "{name}: registration_response"
        );

        let mut rng = Script::new(&[&f("envelope_nonce")]);
        let fin = generic::finish_client_registration::<Identity, _>(
            &mut rng, &reg.state, &response, &password, idents, None,
        )
        .unwrap();
        assert!(rng.drained(), "{name}: registration finish");
        assert_eq!(
            unb64(&fin.registration_record),
            hex(&f("registration_upload")),
            "{name}: registration_upload"
        );
        assert_eq!(
            unb64(&fin.export_key),
            hex(&f("export_key")),
            "{name}: export_key at registration"
        );

        let mut rng = Script::new(&[
            &f("blind_login"),
            &f("client_keyshare_seed"),
            &f("client_nonce"),
        ]);
        let login = generic::start_client_login::<Identity, _>(&mut rng, &password).unwrap();
        assert!(rng.drained(), "{name}: login start");
        assert_eq!(unb64(&login.request), hex(&f("KE1")), "{name}: KE1");

        // Count the dummy record's draws once, then script what follows them.
        let mut counter = Script::after_random(usize::MAX, &[]);
        generic::start_server_login::<Identity, _>(
            &mut counter,
            &setup,
            Some(&fin.registration_record),
            &login.request,
            &user,
            idents,
            Some(&context),
        )
        .unwrap();
        let mut rng = Script::after_random(
            counter.2 - 3,
            &[
                &f("masking_nonce"),
                &f("server_keyshare_seed"),
                &f("server_nonce"),
            ],
        );
        let server = generic::start_server_login::<Identity, _>(
            &mut rng,
            &setup,
            Some(&fin.registration_record),
            &login.request,
            &user,
            idents,
            Some(&context),
        )
        .unwrap();
        assert!(rng.drained(), "{name}: server login start");
        assert_eq!(unb64(&server.login_response), hex(&f("KE2")), "{name}: KE2");

        let mut rng = Script::new(&[]);
        let client = generic::finish_client_login::<Identity, _>(
            &mut rng,
            &login.state,
            &server.login_response,
            &password,
            idents,
            None,
            Some(&context),
        )
        .unwrap()
        .expect("the vector's login succeeds");
        assert_eq!(
            unb64(&client.finish_login_request),
            hex(&f("KE3")),
            "{name}: KE3"
        );
        assert_eq!(
            unb64(&client.export_key),
            hex(&f("export_key")),
            "{name}: export_key"
        );
        assert_eq!(
            unb64(&client.session_key),
            hex(&f("session_key")),
            "{name}: client session_key"
        );

        let key = generic::finish_server_login::<Identity>(
            &server.server_login_state,
            &client.finish_login_request,
            idents,
            Some(&context),
        )
        .unwrap();
        assert_eq!(
            unb64(&key),
            hex(&f("session_key")),
            "{name}: server session_key"
        );
    }
}

/// Cheap Argon2id for the many-case tests; the production profile has its own test.
const FAST: KsfParams = KsfParams {
    memory: 8,
    iterations: 1,
    parallelism: 1,
};

struct Registered {
    setup: String,
    record: String,
    export_key: String,
}

fn register(setup: &str, user: &str, password: &str, ksf: KsfParams) -> Registered {
    let start = opaque::start_client_registration(&mut OsRng, password).unwrap();
    let response = opaque::create_registration_response(setup, user, &start.request).unwrap();
    let idents = Idents {
        client: Some(user),
        server: None,
    };
    let fin = opaque::finish_client_registration(
        &mut OsRng,
        &start.state,
        &response,
        password,
        idents,
        ksf,
    )
    .unwrap();
    assert_eq!(
        fin.server_static_public_key,
        opaque::server_public_key(setup).unwrap()
    );
    Registered {
        setup: setup.to_string(),
        record: fin.registration_record,
        export_key: fin.export_key,
    }
}

/// A full login; `Some(export key)` when both sides agree.
fn login(
    reg: &Registered,
    record: Option<&str>,
    user: &str,
    password: &str,
    ksf: KsfParams,
) -> Option<String> {
    let idents = Idents {
        client: Some(user),
        server: None,
    };
    let start = opaque::start_client_login(&mut OsRng, password).unwrap();
    let server =
        opaque::start_server_login(&mut OsRng, &reg.setup, record, &start.request, user, idents)
            .unwrap();
    let client = opaque::finish_client_login(
        &mut OsRng,
        &start.state,
        &server.login_response,
        password,
        idents,
        ksf,
    )
    .unwrap()?;
    let key = opaque::finish_server_login(
        &server.server_login_state,
        &client.finish_login_request,
        idents,
    )
    .ok()?;
    assert_eq!(key, client.session_key, "both sides derive one session key");
    Some(client.export_key)
}

#[test]
fn production_profile_round_trip() {
    let setup = opaque::create_server_setup(&mut OsRng);
    let reg = register(&setup, "user-1", "correct horse", KsfParams::PROFILE_V1);
    assert_eq!(
        login(
            &reg,
            Some(&reg.record),
            "user-1",
            "correct horse",
            KsfParams::PROFILE_V1
        ),
        Some(reg.export_key.clone())
    );
    // The profile is part of the secret: another cost never opens the record.
    assert_eq!(
        login(&reg, Some(&reg.record), "user-1", "correct horse", FAST),
        None
    );
}

#[test]
fn refusals() {
    let setup = opaque::create_server_setup(&mut OsRng);
    let reg = register(&setup, "user-1", "pw", FAST);
    assert_eq!(
        login(&reg, Some(&reg.record), "user-1", "pw", FAST),
        Some(reg.export_key.clone())
    );
    assert_eq!(
        login(&reg, Some(&reg.record), "user-1", "wrong", FAST),
        None,
        "wrong password"
    );
    assert_eq!(
        login(&reg, Some(&reg.record), "user-2", "pw", FAST),
        None,
        "record under another account"
    );
    assert_eq!(login(&reg, None, "user-1", "pw", FAST), None, "no record");
    let other = Registered {
        setup: opaque::create_server_setup(&mut OsRng),
        ..reg
    };
    assert_eq!(
        login(&other, Some(&other.record), "user-1", "pw", FAST),
        None,
        "another server setup"
    );
}

#[test]
fn unknown_account_response_is_shaped_like_a_real_one() {
    let setup = opaque::create_server_setup(&mut OsRng);
    let reg = register(&setup, "known", "pw", FAST);
    let start = opaque::start_client_login(&mut OsRng, "pw").unwrap();
    let idents = |u| Idents {
        client: Some(u),
        server: None,
    };
    let known = opaque::start_server_login(
        &mut OsRng,
        &setup,
        Some(&reg.record),
        &start.request,
        "known",
        idents("known"),
    )
    .unwrap();
    let unknown = opaque::start_server_login(
        &mut OsRng,
        &setup,
        None,
        &start.request,
        "nobody",
        idents("nobody"),
    )
    .unwrap();
    assert_eq!(known.login_response.len(), unknown.login_response.len());
    assert_eq!(
        known.server_login_state.len(),
        unknown.server_login_state.len()
    );
    // The OPRF answer for an unknown account is stable per identifier, as for a
    // known one, so asking twice does not tell the two apart either.
    let again = opaque::start_server_login(
        &mut OsRng,
        &setup,
        None,
        &start.request,
        "nobody",
        idents("nobody"),
    )
    .unwrap();
    assert_eq!(
        unb64(&unknown.login_response)[..32],
        unb64(&again.login_response)[..32]
    );
}

#[test]
fn replayed_or_swapped_finish_is_refused() {
    let setup = opaque::create_server_setup(&mut OsRng);
    let reg = register(&setup, "u", "pw", FAST);
    let idents = Idents {
        client: Some("u"),
        server: None,
    };
    let run = || {
        let start = opaque::start_client_login(&mut OsRng, "pw").unwrap();
        let server = opaque::start_server_login(
            &mut OsRng,
            &setup,
            Some(&reg.record),
            &start.request,
            "u",
            idents,
        )
        .unwrap();
        let client = opaque::finish_client_login(
            &mut OsRng,
            &start.state,
            &server.login_response,
            "pw",
            idents,
            FAST,
        )
        .unwrap()
        .unwrap();
        (server.server_login_state, client.finish_login_request)
    };
    let (state_a, finish_a) = run();
    let (state_b, finish_b) = run();
    assert!(
        opaque::finish_server_login(&state_a, &finish_b, idents).is_err(),
        "finish from another login"
    );
    assert!(
        opaque::finish_server_login(&state_b, &finish_a, idents).is_err(),
        "finish from another login"
    );
    // The identities are bound at the server's start (KE2's MAC); its finish
    // only checks the client's MAC against the state, so the right pair passes.
    assert!(opaque::finish_server_login(&state_a, &finish_a, idents).is_ok());
}

#[test]
fn malformed_inputs_are_errors_never_panics() {
    let setup = opaque::create_server_setup(&mut OsRng);
    let idents = Idents::default();
    assert_eq!(
        opaque::server_public_key("not base64!"),
        Err(Error::Encoding("serverSetup"))
    );
    assert_eq!(
        opaque::server_public_key("AAAA"),
        Err(Error::Protocol("deserialize serverSetup"))
    );
    assert!(matches!(
        opaque::create_registration_response(&setup, "u", "AA"),
        Err(Error::Protocol(_))
    ));
    assert!(matches!(
        opaque::start_server_login(&mut OsRng, &setup, Some("AA"), "AA", "u", idents),
        Err(Error::Protocol(_))
    ));
    assert!(matches!(
        opaque::finish_server_login("AA", "AA", idents),
        Err(Error::Protocol(_))
    ));
    assert!(matches!(
        opaque::finish_client_login(&mut OsRng, "AA", "AA", "pw", idents, FAST),
        Err(Error::Protocol(_))
    ));
    let bad = KsfParams {
        memory: 0,
        iterations: 0,
        parallelism: 0,
    };
    let start = opaque::start_client_registration(&mut OsRng, "pw").unwrap();
    let response = opaque::create_registration_response(&setup, "u", &start.request).unwrap();
    assert_eq!(
        opaque::finish_client_registration(&mut OsRng, &start.state, &response, "pw", idents, bad)
            .err(),
        Some(Error::Ksf)
    );
    // An all-zero (identity) blinded element is refused, not evaluated.
    assert!(opaque::create_registration_response(&setup, "u", &b64(&[0; 32])).is_err());
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

    #[test]
    fn any_password_round_trips_and_any_other_is_refused(
        password in "\\PC{0,40}",
        other in "\\PC{0,40}",
        user in "[a-z0-9]{1,24}",
    ) {
        let setup = opaque::create_server_setup(&mut OsRng);
        let reg = register(&setup, &user, &password, FAST);
        prop_assert_eq!(login(&reg, Some(&reg.record), &user, &password, FAST), Some(reg.export_key.clone()));
        if other != password {
            prop_assert_eq!(login(&reg, Some(&reg.record), &user, &other, FAST), None);
        }
    }

    #[test]
    fn every_flipped_byte_of_the_login_response_is_refused(index in 0usize..320, bit in 0u8..8) {
        let setup = opaque::create_server_setup(&mut OsRng);
        let reg = register(&setup, "u", "pw", FAST);
        let idents = Idents { client: Some("u"), server: None };
        let start = opaque::start_client_login(&mut OsRng, "pw").unwrap();
        let server = opaque::start_server_login(&mut OsRng, &setup, Some(&reg.record), &start.request, "u", idents).unwrap();
        let mut bytes = unb64(&server.login_response);
        bytes[index] ^= 1 << bit;
        let outcome = opaque::finish_client_login(&mut OsRng, &start.state, &b64(&bytes), "pw", idents, FAST);
        prop_assert!(matches!(outcome, Ok(None) | Err(Error::Protocol(_))));
    }

    #[test]
    fn arbitrary_text_never_panics(input in "\\PC{0,200}") {
        let setup = opaque::create_server_setup(&mut OsRng);
        let idents = Idents::default();
        let _ = opaque::server_public_key(&input);
        let _ = opaque::create_registration_response(&setup, "u", &input);
        let _ = opaque::start_server_login(&mut OsRng, &setup, Some(&input), &input, "u", idents);
        let _ = opaque::finish_server_login(&input, &input, idents);
        let _ = opaque::finish_client_login(&mut OsRng, &input, &input, "pw", idents, FAST);
        let _ = opaque::finish_client_registration(&mut OsRng, &input, &input, "pw", idents, FAST);
    }
}
