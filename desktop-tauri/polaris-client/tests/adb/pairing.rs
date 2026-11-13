//! Wireless debugging pairing: the packet framing, the cipher, the exchange
//! against a scripted TV (right code, wrong code, a TV that hangs up, garbage),
//! the same exchange over a real in-memory TLS 1.3 session so both ends export
//! the same keying material, and the key and certificate bytes against what the
//! TypeScript module produces for the same key (`tests/fixtures/adb-key-vectors.json`).

use std::collections::VecDeque;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use polaris_client::adb_client::{android_public_key, sign_token, KEY_COMMENT};
use polaris_client::adb_pairing::*;
use polaris_client::adb_spake2::{Spake2, Spake2Role, CLIENT_NAME, SERVER_NAME};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::fake::{key, tv_acceptor};
use crate::spake2::{alice_random, bob_random, hex, keying, unhex, KEY};

#[test]
fn frames_a_packet_with_version_1_its_type_and_a_big_endian_length() {
    let packet = encode_pairing_packet(PACKET_PEER_INFO, &[7; 300]);
    assert_eq!(&packet[..6], &[1, 1, 0, 0, 1, 44]);
    let header = read_pairing_header(&packet[..6]).unwrap();
    assert_eq!(
        header,
        PairingHeader {
            kind: PACKET_PEER_INFO,
            length: 300
        }
    );
}

#[test]
fn refuses_what_adbd_refuses() {
    let header = |version: u8, kind: u8, length: u32| {
        let mut out = vec![version, kind];
        out.extend_from_slice(&length.to_be_bytes());
        out
    };
    for (bytes, message) in [
        (header(2, 0, 32), "Unsupported pairing version 2."),
        (header(1, 9, 32), "Unknown pairing packet 9."),
        (header(1, 0, 0), "Pairing packet of 0 bytes."),
        (header(1, 1, 16385), "Pairing packet of 16385 bytes."),
        (vec![1, 0, 0], "Short pairing header."),
    ] {
        let error = read_pairing_header(&bytes).unwrap_err();
        assert_eq!(error.reason, PairingFailure::Protocol);
        assert_eq!(error.message, message);
    }
    assert_eq!(
        read_pairing_header(&header(1, 1, 16384)).unwrap().length,
        16384
    );
}

#[test]
fn puts_the_adb_key_in_an_8192_byte_peer_info_of_type_0() {
    let info = peer_info(b"key user@host\0").unwrap();
    assert_eq!(info.len(), PEER_INFO_BYTES);
    assert_eq!(info[0], 0);
    assert_eq!(&info[1..15], b"key user@host\0");
    assert!(info[15..].iter().all(|byte| *byte == 0));
    assert!(peer_info(&[1; PEER_INFO_BYTES]).is_err());
}

#[test]
fn seals_with_a_per_direction_counter_nonce_and_a_wrong_key_does_not_open() {
    let key = unhex(KEY);
    let mut ours = PairingCipher::new(&key);
    let mut theirs = PairingCipher::new(&key);
    let first = ours.encrypt(b"one");
    let second = ours.encrypt(b"one");
    assert_eq!(first.len(), 3 + 16);
    assert_ne!(first, second);
    assert_eq!(theirs.decrypt(&first).as_deref(), Some(&b"one"[..]));
    assert_eq!(theirs.decrypt(&second).as_deref(), Some(&b"one"[..]));
    assert_eq!(
        PairingCipher::new(&[1; 64]).decrypt(&ours.encrypt(b"x")),
        None
    );
    assert_eq!(theirs.decrypt(&[0; 15]), None);
}

#[test]
fn reads_a_six_digit_code_and_nothing_else() {
    assert_eq!(read_pairing_code(" 123 456 ").as_deref(), Some("123456"));
    assert_eq!(read_pairing_code("12345"), None);
    assert_eq!(read_pairing_code("12345a"), None);
    assert_eq!(read_pairing_code("1234567"), None);
}

/// An in-memory channel whose other end is a scripted TV, run step by step.
struct Scripted {
    to_tv: Vec<u8>,
    to_client: VecDeque<u8>,
    tv: Option<Tv>,
    received: Vec<Vec<u8>>,
}

struct Tv {
    code: &'static str,
    behaviour: &'static str,
    bob: Option<Spake2>,
    cipher: Option<PairingCipher>,
}

impl Scripted {
    fn new(code: &'static str, behaviour: &'static str) -> Self {
        Self {
            to_tv: Vec::new(),
            to_client: VecDeque::new(),
            tv: Some(Tv {
                code,
                behaviour,
                bob: None,
                cipher: None,
            }),
            received: Vec::new(),
        }
    }

    /// What the TV does with each whole packet the client wrote.
    fn tv_reads(&mut self) {
        while self.to_tv.len() >= 6 {
            let header = read_pairing_header(&self.to_tv[..6]).unwrap();
            let end = 6 + header.length as usize;
            if self.to_tv.len() < end {
                return;
            }
            let payload = self.to_tv[6..end].to_vec();
            self.to_tv.drain(..end);
            let Some(tv) = self.tv.as_mut() else { return };
            if header.kind == PACKET_SPAKE2 {
                let password = [tv.code.as_bytes(), &keying()].concat();
                let mut bob = Spake2::with_random(
                    Spake2Role::Bob,
                    SERVER_NAME,
                    CLIENT_NAME,
                    &password,
                    &bob_random(),
                )
                .unwrap();
                self.to_client
                    .extend(encode_pairing_packet(PACKET_SPAKE2, bob.message()));
                tv.cipher = Some(PairingCipher::new(&bob.finish(&payload).unwrap()));
                tv.bob = Some(bob);
            } else {
                let cipher = tv.cipher.as_mut().unwrap();
                let plain = cipher.decrypt(&payload);
                let hang_up = plain.is_none() || tv.behaviour == "hang-up";
                if let Some(plain) = plain {
                    self.received.push(plain);
                }
                if hang_up {
                    self.tv = None;
                    return;
                }
                let mut reply = vec![0u8; PEER_INFO_BYTES];
                reply[0] = 1;
                reply[1..8].copy_from_slice(b"tv-guid");
                let sealed = if tv.behaviour == "garbage" {
                    vec![9; PEER_INFO_BYTES + 16]
                } else {
                    cipher.encrypt(&reply)
                };
                self.to_client
                    .extend(encode_pairing_packet(PACKET_PEER_INFO, &sealed));
            }
        }
    }
}

impl PairingChannel for Scripted {
    async fn write(&mut self, data: &[u8]) -> Result<(), PairingError> {
        self.to_tv.extend_from_slice(data);
        self.tv_reads();
        Ok(())
    }

    async fn read(&mut self, length: usize) -> Result<Vec<u8>, PairingError> {
        if self.to_client.len() < length {
            return Err(PairingError::new(
                PairingFailure::Unreachable,
                "The TV closed the connection.",
            ));
        }
        Ok(self.to_client.drain(..length).collect())
    }

    fn export_keying_material(&self, length: usize, label: &[u8]) -> Result<Vec<u8>, PairingError> {
        assert_eq!(label, b"adb-label\0");
        Ok(keying()[..length].to_vec())
    }
}

fn adb_public_key() -> Vec<u8> {
    android_public_key(key(), KEY_COMMENT).unwrap()
}

#[tokio::test]
async fn pairs_when_the_code_is_right_and_the_tv_receives_our_adb_key() {
    let mut tv = Scripted::new("123456", "answer");
    let public = adb_public_key();
    pair_over(&mut tv, "123456", &public, Some(&alice_random()))
        .await
        .unwrap();
    assert_eq!(tv.received.len(), 1);
    assert_eq!(&tv.received[0][1..1 + public.len()], &public[..]);
}

#[tokio::test]
async fn reports_a_wrong_code_when_the_tv_hangs_up_on_a_peer_info_it_cannot_read() {
    let mut tv = Scripted::new("654321", "answer");
    let error = pair_over(&mut tv, "123456", &adb_public_key(), Some(&alice_random()))
        .await
        .unwrap_err();
    assert_eq!(error.reason, PairingFailure::WrongCode);
    assert_eq!(error.message, "The TV did not accept the pairing code.");
    assert!(tv.received.is_empty());
}

#[tokio::test]
async fn reports_a_wrong_code_when_the_tvs_answer_does_not_decrypt() {
    let mut tv = Scripted::new("123456", "garbage");
    let error = pair_over(&mut tv, "123456", &adb_public_key(), Some(&alice_random()))
        .await
        .unwrap_err();
    assert_eq!(error.reason, PairingFailure::WrongCode);
}

#[tokio::test]
async fn reports_a_protocol_failure_not_a_wrong_code_for_a_malformed_answer() {
    let mut tv = Scripted::new("123456", "answer");
    tv.tv = None;
    tv.to_client.extend([7, 0, 0, 0, 0, 32]);
    let error = pair_over(&mut tv, "123456", &adb_public_key(), None)
        .await
        .unwrap_err();
    assert_eq!(error.reason, PairingFailure::Protocol);
}

/// The TV's half of the exchange over TLS, as AOSP's server side runs it.
async fn tls_pairing_tv(stream: tokio::io::DuplexStream, code: &str) -> Option<Vec<u8>> {
    let mut secure = tv_acceptor().accept(stream).await.ok()?;
    let mut exported = vec![0u8; EXPORTED_BYTES];
    exported = secure
        .get_ref()
        .1
        .export_keying_material(exported, EXPORTED_LABEL, None)
        .ok()?;
    let mut header = [0u8; 6];
    secure.read_exact(&mut header).await.ok()?;
    let mut message = vec![0u8; read_pairing_header(&header).ok()?.length as usize];
    secure.read_exact(&mut message).await.ok()?;
    let password = [code.as_bytes(), &exported].concat();
    let mut bob = Spake2::new(Spake2Role::Bob, SERVER_NAME, CLIENT_NAME, &password).ok()?;
    secure
        .write_all(&encode_pairing_packet(PACKET_SPAKE2, bob.message()))
        .await
        .ok()?;
    let mut cipher = PairingCipher::new(&bob.finish(&message).ok()?);
    secure.read_exact(&mut header).await.ok()?;
    let mut sealed = vec![0u8; read_pairing_header(&header).ok()?.length as usize];
    secure.read_exact(&mut sealed).await.ok()?;
    let Some(plain) = cipher.decrypt(&sealed) else {
        let _ = secure.shutdown().await;
        return None;
    };
    let reply = cipher.encrypt(&[1u8; PEER_INFO_BYTES]);
    secure
        .write_all(&encode_pairing_packet(PACKET_PEER_INFO, &reply))
        .await
        .ok()?;
    secure.flush().await.ok()?;
    Some(plain)
}

async fn pair_over_tls(tv_code: &'static str) -> (Result<(), PairingError>, Option<Vec<u8>>) {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let tv = tokio::spawn(tls_pairing_tv(theirs, tv_code));
    let identity = TlsIdentity::for_key(key()).unwrap();
    let connector = tokio_rustls::TlsConnector::from(client_config(&identity).unwrap());
    let name = rustls::pki_types::ServerName::try_from("adb").unwrap();
    let secure = connector.connect(name, ours).await.unwrap();
    let mut channel = TlsChannel(secure);
    let result = pair_over(&mut channel, "123456", &adb_public_key(), None).await;
    drop(channel);
    (result, tv.await.unwrap())
}

#[tokio::test]
async fn pairs_over_tls_13_with_the_keying_material_both_ends_export() {
    let (result, received) = pair_over_tls("123456").await;
    result.unwrap();
    let public = adb_public_key();
    assert_eq!(&received.unwrap()[1..1 + public.len()], &public[..]);
}

#[tokio::test]
async fn reports_a_wrong_code_over_tls_when_the_tv_hangs_up() {
    let (result, received) = pair_over_tls("000000").await;
    assert_eq!(result.unwrap_err().reason, PairingFailure::WrongCode);
    assert!(received.is_none());
}

#[tokio::test]
async fn reports_an_unreachable_tv_and_a_cancel() {
    // Port 9 on loopback: nothing listens there on a test machine, and nothing leaves it.
    let options = || PairOptions {
        host: "127.0.0.1".into(),
        port: 9,
        code: "123456".into(),
        key: key().to_string(),
        public_key: adb_public_key(),
        timeout: Duration::from_secs(5),
    };
    let error = pair_tv(options(), std::future::pending())
        .await
        .unwrap_err();
    assert!(matches!(
        error.reason,
        PairingFailure::Unreachable | PairingFailure::Timeout
    ));
    let cancelled = pair_tv(options(), async {}).await.unwrap_err();
    assert_eq!(cancelled.reason, PairingFailure::Cancelled);
    assert_eq!(cancelled.message, "The pairing was stopped.");
}

struct Vectors {
    key: String,
    public_key: String,
    signature: String,
    certificate: String,
}

fn vectors() -> Vectors {
    let text = include_str!("../fixtures/adb-key-vectors.json");
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    let field = |name: &str| value[name].as_str().unwrap().to_string();
    assert_eq!(field("certificateAt"), "2026-11-07T00:00:00Z");
    assert_eq!(field("token"), "07".repeat(20));
    Vectors {
        key: field("key"),
        public_key: field("publicKey"),
        signature: field("signature"),
        certificate: field("certificate"),
    }
}

#[test]
fn writes_the_same_public_key_signature_and_certificate_bytes_as_the_typescript_module() {
    let fixture = vectors();
    let public = android_public_key(&fixture.key, "polaris@desktop").unwrap();
    assert_eq!(String::from_utf8(public).unwrap(), fixture.public_key);
    assert_eq!(
        hex(&sign_token(&fixture.key, &[7; 20]).unwrap()),
        fixture.signature
    );
    // 2026-11-07T00:00:00Z.
    let at = UNIX_EPOCH + Duration::from_secs(1_794_009_600);
    assert_eq!(
        adb_certificate(&fixture.key, at).unwrap(),
        fixture.certificate
    );
}

#[test]
fn switches_to_generalized_time_from_2050_as_x509_asks() {
    let fixture = vectors();
    let late = UNIX_EPOCH + Duration::from_secs(2_556_144_000); // 2051-01-01
    let pem = adb_certificate(&fixture.key, late).unwrap();
    let identity = TlsIdentity::from_pem(&pem, &fixture.key).unwrap();
    let der = identity.certificate.as_ref();
    assert!(der.windows(15).any(|window| window == b"20510101000000Z"));
    assert!(der.windows(15).any(|window| window == b"20601229000000Z"));
    assert!(SystemTime::now() > UNIX_EPOCH);
}
