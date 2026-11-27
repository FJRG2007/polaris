use std::io::{self, Cursor, Read, Write};

use super::*;

/// Desktop's side of the socket: what it will answer, and what it was sent.
struct FakeDesktop {
    answer: Cursor<Vec<u8>>,
    sent: Vec<u8>,
}

impl FakeDesktop {
    fn answering(json: &str) -> Self {
        let mut answer = (json.len() as u32).to_le_bytes().to_vec();
        answer.extend_from_slice(json.as_bytes());
        Self {
            answer: Cursor::new(answer),
            sent: Vec::new(),
        }
    }
}

impl Read for FakeDesktop {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.answer.read(buf)
    }
}

impl Write for FakeDesktop {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.sent.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn sends_one_length_prefixed_frame() {
    let mut desktop = FakeDesktop::answering(r#"{"ok":true}"#);
    assert!(exchange(&mut desktop, "https://polaris.example.com", "BCDF-GHJK").unwrap());
    let length = u32::from_le_bytes(desktop.sent[..4].try_into().unwrap()) as usize;
    assert_eq!(length, desktop.sent.len() - 4);
    let frame: serde_json::Value = serde_json::from_slice(&desktop.sent[4..]).unwrap();
    assert_eq!(
        frame,
        serde_json::json!({
            "type": "terminal-sign-in",
            "server": "https://polaris.example.com",
            "userCode": "BCDF-GHJK"
        })
    );
}

#[test]
fn a_refusal_is_not_an_approval() {
    for reason in [
        "other-server",
        "signed-out",
        "refused",
        "unreachable",
        "bad-request",
    ] {
        let mut desktop = FakeDesktop::answering(&format!(r#"{{"ok":false,"reason":"{reason}"}}"#));
        assert!(!exchange(&mut desktop, "https://polaris.example.com", "BCDF-GHJK").unwrap());
    }
}

#[test]
fn an_oversized_or_cut_answer_is_an_error() {
    let mut oversized = FakeDesktop::answering("");
    oversized.answer = Cursor::new(u32::MAX.to_le_bytes().to_vec());
    assert!(exchange(&mut oversized, "https://polaris.example.com", "BCDF-GHJK").is_err());

    let mut cut = FakeDesktop::answering(r#"{"ok":true}"#);
    let mut bytes = cut.answer.into_inner();
    bytes.truncate(6);
    cut.answer = Cursor::new(bytes);
    assert!(exchange(&mut cut, "https://polaris.example.com", "BCDF-GHJK").is_err());
}

#[test]
fn endpoint_user_keeps_only_safe_characters() {
    assert_eq!(endpoint_user("Jose Maria"), "jose_maria");
    assert_eq!(endpoint_user("ana.b-c_d"), "ana.b-c_d");
    assert_eq!(endpoint_user("Jos\u{e9}"), "jos_");
}
