//! SPAKE2 as BoringSSL speaks it.
//!
//! The vectors are the ones pinned in `desktop/test/main/adb-pairing.test.ts`,
//! computed by `desktop/test/fixtures/spake2-vectors.py`, an independent
//! transcription of BoringSSL's spake25519.cc over djb's reference ed25519.py.
//! BoringSSL and AOSP publish no fixed SPAKE2 vectors, so these are
//! cross-implementation answers, and the TypeScript module meets them too.

use polaris_client::adb_spake2::{
    password_scalar, Spake2, Spake2Error, Spake2Role, CLIENT_NAME, SERVER_NAME,
};
use sha2::{Digest, Sha512};

pub const ALICE: &str = "ba2893bc172e95f246fdb91eb8d30efdb5ba61e906557220cc8e98ea198b03c5";
pub const BOB: &str = "afbd8e5c381d1d71058a72928150e17f2fb4a1cefbe57e8d1a7cb85fdc4fd355";
pub const KEY: &str = "4c170897ef29d6ea6eba4d7eecbaeb352ced49b8c7ab3a2e16e8b28ffe55829244fe81fc94e8ef9c8699edeb679c66cd5dd2ef2a148fe5ab479467e3c9c93390";
const BOB_WRONG: &str = "7e5f8d8e33cfbe34d5afd8bf2852aef02dccc4d9ec030331af603b3483c491d8";
const ALICE_VS_WRONG: &str = "f41641c25178dcaabf6f864dde46e960adf155e607eb0169a9d7364b70cf0caece233d8a6b518746003c07845a6353c9914f3ab4d7d8a60ffa9d61183f9b83f0";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

pub fn keying() -> Vec<u8> {
    (0u8..64).collect()
}

pub fn password(code: &str) -> Vec<u8> {
    [code.as_bytes(), &keying()].concat()
}

pub fn alice_random() -> [u8; 64] {
    Sha512::digest(b"alice").into()
}

pub fn bob_random() -> [u8; 64] {
    Sha512::digest(b"bob").into()
}

fn alice() -> Spake2 {
    Spake2::with_random(
        Spake2Role::Alice,
        CLIENT_NAME,
        SERVER_NAME,
        &password("123456"),
        &alice_random(),
    )
    .unwrap()
}

#[test]
fn matches_the_reference_messages_and_key_for_both_roles() {
    let mut alice = alice();
    let mut bob = Spake2::with_random(
        Spake2Role::Bob,
        SERVER_NAME,
        CLIENT_NAME,
        &password("123456"),
        &bob_random(),
    )
    .unwrap();
    assert_eq!(hex(alice.message()), ALICE);
    assert_eq!(hex(bob.message()), BOB);
    let bob_message = *bob.message();
    let alice_message = *alice.message();
    assert_eq!(hex(&alice.finish(&bob_message).unwrap()), KEY);
    assert_eq!(hex(&bob.finish(&alice_message).unwrap()), KEY);
}

#[test]
fn gives_a_different_key_when_the_other_side_used_another_code() {
    let bob = Spake2::with_random(
        Spake2Role::Bob,
        SERVER_NAME,
        CLIENT_NAME,
        &password("654321"),
        &bob_random(),
    )
    .unwrap();
    assert_eq!(hex(bob.message()), BOB_WRONG);
    assert_eq!(hex(&alice().finish(bob.message()).unwrap()), ALICE_VS_WRONG);
}

#[test]
fn keeps_the_password_scalar_a_multiple_of_eight_below_eight_times_the_order() {
    for code in ["000000", "123456", "999999"] {
        let scalar = password_scalar(code.as_bytes());
        let bytes = scalar.scalar_le();
        assert_eq!(bytes[0] % 8, 0);
        // 8 * 2^253 = 2^256: nothing above the 32nd byte.
        assert_eq!(bytes[32], 0);
    }
}

#[test]
fn refuses_a_message_off_the_curve_a_short_one_and_a_second_finish() {
    assert_eq!(alice().finish(&[0u8; 31]), Err(Spake2Error::MessageLength));
    assert_eq!(
        Spake2Error::MessageLength.to_string(),
        "The SPAKE2 message is not 32 bytes."
    );
    // y = 2 has no x on edwards25519.
    let mut off_curve = [0u8; 32];
    off_curve[0] = 2;
    assert_eq!(alice().finish(&off_curve), Err(Spake2Error::NotAPoint));
    let mut once = alice();
    once.finish(&unhex(BOB)).unwrap();
    assert_eq!(once.finish(&unhex(BOB)), Err(Spake2Error::AlreadyFinished));
}

#[test]
fn refuses_a_zero_random_scalar() {
    assert!(matches!(
        Spake2::with_random(
            Spake2Role::Alice,
            CLIENT_NAME,
            SERVER_NAME,
            b"x",
            &[0u8; 64]
        ),
        Err(Spake2Error::ZeroScalar)
    ));
}

#[test]
fn fresh_exchanges_agree_with_the_same_code() {
    let mut a = Spake2::new(Spake2Role::Alice, CLIENT_NAME, SERVER_NAME, b"pw").unwrap();
    let mut b = Spake2::new(Spake2Role::Bob, SERVER_NAME, CLIENT_NAME, b"pw").unwrap();
    let (am, bm) = (*a.message(), *b.message());
    assert_eq!(a.finish(&bm).unwrap(), b.finish(&am).unwrap());
}
