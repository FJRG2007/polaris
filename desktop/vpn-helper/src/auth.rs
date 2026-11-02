//! Who may give orders: whoever holds the secret the app set at install, proved
//! by answering a fresh challenge. The secret itself never crosses the socket, so
//! a program that took the port while the service was down learns nothing from
//! the app knocking on it.

use hmac::{Hmac, Mac};
use sha2::Sha256;

type Signer = Hmac<Sha256>;

fn signer(secret: &str, nonce: &str) -> Signer {
    let mut mac = Signer::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(nonce.as_bytes());
    mac
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2)?, 16).ok())
        .collect()
}

/// Whether `answer` proves the secret. Compared in constant time.
pub fn verify(secret: &str, nonce: &str, answer: &str) -> bool {
    unhex(answer).is_some_and(|bytes| signer(secret, nonce).verify_slice(&bytes).is_ok())
}

/// A secret the app wrote: 64 hex characters, nothing else.
pub fn valid_secret(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The answer to a challenge, as the app computes it.
#[cfg(test)]
pub fn respond(secret: &str, nonce: &str) -> String {
    signer(secret, nonce)
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "secret";

    #[test]
    fn accepts_the_right_answer_only() {
        let answer = respond(SECRET, "nonce");
        assert!(verify(SECRET, "nonce", &answer));
        assert!(!verify(SECRET, "other", &answer));
        assert!(!verify("other", "nonce", &answer));
    }

    #[test]
    fn refuses_what_is_not_hex() {
        assert!(!verify(SECRET, "nonce", "zz"));
        assert!(!verify(SECRET, "nonce", "abc"));
        assert!(!verify(SECRET, "nonce", ""));
    }

    #[test]
    fn knows_a_well_formed_secret() {
        assert!(valid_secret(&"a".repeat(64)));
        assert!(!valid_secret(&"a".repeat(63)));
        assert!(!valid_secret(&"g".repeat(64)));
    }
}
