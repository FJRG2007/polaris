//! The ADB wire protocol against a scripted adbd over an in-memory stream:
//! packets, the key, a whole session, A_STLS, and a cancelled prompt.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use polaris_client::adb_client::*;
use polaris_client::adb_pairing::adb_certificate;
use rsa::traits::PublicKeyParts;
use rsa::{Pkcs1v15Sign, PublicKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};

use crate::fake::{key, tv_acceptor};

fn options(certificate: Option<String>) -> AdbOptions {
    AdbOptions {
        key: key().to_string(),
        certificate,
        connect: Duration::from_secs(2),
        approve: Duration::from_secs(2),
        command: Duration::from_secs(2),
    }
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

#[test]
fn reads_what_it_writes_in_pieces() {
    let bytes = encode_packet(A_WRTE, 1, 2, b"hello");
    let mut reader = PacketReader::new();
    assert!(reader.push(&bytes[..10]).unwrap().is_empty());
    let packets = reader.push(&bytes[10..]).unwrap();
    let expected = Packet {
        command: A_WRTE,
        arg0: 1,
        arg1: 2,
        data: b"hello".to_vec(),
    };
    assert_eq!(packets, vec![expected]);
}

#[test]
fn refuses_something_that_is_not_adb() {
    let error = PacketReader::new().push(&[0x41; 24]).unwrap_err();
    assert_eq!(error.to_string(), "That address does not speak ADB.");
}

#[test]
fn frames_the_header_as_adbd_reads_it() {
    let bytes = encode_packet(A_CNXN, VERSION, MAX_PAYLOAD, b"host::\0");
    assert_eq!(&bytes[..4], b"CNXN");
    assert_eq!(word(&bytes, 12), 7);
    let sum: u32 = b"host::\0".iter().map(|byte| u32::from(*byte)).sum();
    assert_eq!(word(&bytes, 16), sum);
    assert_eq!(word(&bytes, 20), A_CNXN ^ 0xffff_ffff);
}

fn public_key() -> PublicKey {
    read_key(key()).unwrap().to_public_key()
}

#[test]
fn signs_a_token_so_the_public_half_verifies_it_as_a_sha1_digest() {
    let token = [7u8; 20];
    let signature = sign_token(key(), &token).unwrap();
    assert_eq!(signature.len(), 256);
    let digest_info = [
        0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
    ];
    let prefixed = [&digest_info[..], &token].concat();
    public_key()
        .verify(Pkcs1v15Sign::new_unprefixed(), &prefixed, &signature)
        .unwrap();
}

/// Little-endian words to a big-endian byte string.
fn big_endian(words: &[u8]) -> Vec<u8> {
    words.iter().rev().copied().collect()
}

#[test]
fn writes_androids_public_key_layout() {
    use base64::Engine as _;
    let text = String::from_utf8(android_public_key(key(), "test").unwrap()).unwrap();
    assert!(text.ends_with(" test\0"));
    let raw = base64::engine::general_purpose::STANDARD
        .decode(text.split(' ').next().unwrap())
        .unwrap();
    assert_eq!(raw.len(), 4 + 4 + 256 + 256 + 4);
    assert_eq!(word(&raw, 0), 64);
    assert_eq!(word(&raw, raw.len() - 4), 65537);
    assert_eq!(word(&raw, 8).wrapping_mul(word(&raw, 4)).wrapping_add(1), 0);
    let n = public_key().n().to_be_bytes();
    let modulus = big_endian(&raw[8..8 + 256]);
    assert_eq!(&modulus[..], &n[n.len() - 256..]);
    // rr itself is checked byte for byte against the TypeScript module's output in pairing.rs.
    let rr = big_endian(&raw[8 + 256..8 + 512]);
    assert!(rr < modulus);
    assert!(rr.iter().any(|byte| *byte != 0));
}

#[derive(Default)]
struct Seen {
    pushed: Vec<u8>,
    shells: Vec<String>,
    prompted: u32,
}

/// A device that asks for a signature, then the public key, then answers shell and sync.
async fn fake_device<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, seen: Arc<Mutex<Seen>>) {
    let mut reader = PacketReader::new();
    let mut auth_tries = 0;
    let mut sync_local = 0;
    let mut buffer = vec![0u8; 65536];
    loop {
        let read = match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => read,
        };
        for packet in reader.push(&buffer[..read]).unwrap() {
            let mut out = Vec::new();
            match packet.command {
                A_CNXN => out.push(encode_packet(A_AUTH, AUTH_TOKEN, 0, &[3; 20])),
                A_AUTH => {
                    auth_tries += 1;
                    if packet.arg0 == AUTH_SIGNATURE {
                        out.push(encode_packet(A_AUTH, AUTH_TOKEN, 0, &[4; 20]));
                    } else {
                        seen.lock().unwrap().prompted = auth_tries;
                        out.push(encode_packet(A_CNXN, VERSION, 4096, b"device::\0"));
                    }
                }
                A_OPEN => {
                    let service = String::from_utf8_lossy(&packet.data)
                        .trim_end_matches('\0')
                        .to_string();
                    if service == "sync:" {
                        sync_local = packet.arg0;
                        out.push(encode_packet(A_OKAY, 99, packet.arg0, &[]));
                    } else if service == "shell:refuse" {
                        out.push(encode_packet(A_CLSE, 0, packet.arg0, &[]));
                    } else {
                        seen.lock()
                            .unwrap()
                            .shells
                            .push(service["shell:".len()..].to_string());
                        out.push(encode_packet(A_OKAY, 99, packet.arg0, &[]));
                        out.push(encode_packet(A_WRTE, 99, packet.arg0, b"Success\n"));
                        out.push(encode_packet(A_CLSE, 99, packet.arg0, &[]));
                    }
                }
                A_WRTE if packet.arg1 == 99 => {
                    seen.lock().unwrap().pushed.extend_from_slice(&packet.data);
                    out.push(encode_packet(A_OKAY, 99, sync_local, &[]));
                    if packet.data.windows(4).any(|window| window == b"DONE") {
                        out.push(encode_packet(A_WRTE, 99, sync_local, b"OKAY\0\0\0\0"));
                    }
                }
                _ => {}
            }
            for bytes in out {
                if stream.write_all(&bytes).await.is_err() {
                    return;
                }
            }
        }
    }
}

#[tokio::test]
async fn authenticates_prompts_runs_a_command_and_pushes_a_file_larger_than_a_packet() {
    let (ours, theirs) = tokio::io::duplex(1 << 20);
    let seen = Arc::new(Mutex::new(Seen::default()));
    tokio::spawn(fake_device(theirs, seen.clone()));
    let mut adb = AdbConnection::new(StreamLink::new(ours), options(None));
    let mut prompts = 0;
    adb.open(|| prompts += 1).await.unwrap();
    assert_eq!(prompts, 1);
    assert_eq!(seen.lock().unwrap().prompted, 2);
    assert_eq!(
        adb.shell("pm install -r /x.apk").await.unwrap(),
        "Success\n"
    );
    assert_eq!(seen.lock().unwrap().shells, vec!["pm install -r /x.apk"]);
    let apk = vec![0xab; 100_000];
    adb.push("/data/local/tmp/x.apk", &apk, 0o644)
        .await
        .unwrap();
    let pushed = seen.lock().unwrap().pushed.clone();
    assert_eq!(&pushed[..4], b"SEND");
    assert!(pushed
        .windows(25)
        .any(|window| window == b"/data/local/tmp/x.apk,420"));
    assert!(pushed
        .windows(60_000)
        .any(|window| window == &apk[..60_000]));
    let refused = adb.shell("refuse").await.unwrap_err();
    assert_eq!(refused.to_string(), "The TV refused that.");
    adb.close().await;
}

/// A link to a TV that never accepts: every handshake packet gets a fresh token, the key nothing.
#[derive(Default)]
struct NeverAccepts {
    queued: Vec<Vec<u8>>,
}

impl AdbLink for NeverAccepts {
    async fn send(&mut self, header: &[u8], _data: &[u8]) -> Result<(), AdbError> {
        if word(header, 0) != A_AUTH || word(header, 4) != AUTH_PUBLIC_KEY {
            self.queued
                .push(encode_packet(A_AUTH, AUTH_TOKEN, 0, &[7; 20]));
        }
        Ok(())
    }

    async fn receive(&mut self) -> Result<Vec<u8>, AdbError> {
        if self.queued.is_empty() {
            std::future::pending::<()>().await;
        }
        Ok(self.queued.remove(0))
    }

    async fn close(&mut self) {}
}

#[tokio::test]
async fn ends_a_wait_on_the_tvs_prompt_as_soon_as_it_is_cancelled() {
    let mut adb = AdbConnection::new(
        NeverAccepts::default(),
        AdbOptions {
            approve: Duration::from_secs(60),
            ..options(None)
        },
    );
    let (prompted, on_prompt) = tokio::sync::oneshot::channel::<()>();
    let mut prompted = Some(prompted);
    let started = Instant::now();
    // A cancel drops the open under way: the prompt's 60 seconds are not waited out.
    tokio::select! {
        result = adb.open(move || {
            if let Some(sender) = prompted.take() {
                let _ = sender.send(());
            }
        }) => panic!("opened: {:?}", result.err()),
        _ = on_prompt => {}
    }
    adb.close().await;
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        adb.shell("id").await.unwrap_err().to_string(),
        "The connection was closed."
    );
}

struct Silent;

impl AdbLink for Silent {
    async fn send(&mut self, _header: &[u8], _data: &[u8]) -> Result<(), AdbError> {
        Ok(())
    }

    async fn receive(&mut self) -> Result<Vec<u8>, AdbError> {
        std::future::pending().await
    }

    async fn close(&mut self) {}
}

#[tokio::test]
async fn times_out_as_a_tv_that_stopped_answering() {
    let mut adb = AdbConnection::new(
        Silent,
        AdbOptions {
            connect: Duration::from_millis(50),
            ..options(None)
        },
    );
    let error = adb.open(|| {}).await.unwrap_err();
    assert_eq!(error.to_string(), "The TV stopped answering.");
}

/// A TV that answers CNXN with STLS, then on TLS sends its CNXN - as adbd does on its Wireless debugging port.
async fn tls_tv(mut stream: DuplexStream, peers: Arc<Mutex<Vec<bool>>>) {
    let mut header = [0u8; 24];
    loop {
        if stream.read_exact(&mut header).await.is_err() {
            return;
        }
        let mut data = vec![0u8; word(&header, 12) as usize];
        stream.read_exact(&mut data).await.unwrap();
        match word(&header, 0) {
            A_CNXN => stream
                .write_all(&encode_packet(A_STLS, VERSION, 0, &[]))
                .await
                .unwrap(),
            A_STLS => break,
            _ => {}
        }
    }
    // adbd reads exactly one packet and leaves the rest to TLS.
    let Ok(mut secure) = tv_acceptor().accept(stream).await else {
        return;
    };
    peers
        .lock()
        .unwrap()
        .push(secure.get_ref().1.peer_certificates().is_some());
    let cnxn = encode_packet(
        A_CNXN,
        VERSION,
        4096,
        b"device::ro.product.model=Fixture;\0",
    );
    let _ = secure.write_all(&cnxn).await;
    let _ = secure.flush().await;
    let mut rest = [0u8; 64];
    let _ = secure.read(&mut rest).await;
}

#[tokio::test]
async fn carries_on_over_tls_with_this_computers_certificate_and_opens_on_the_tvs_cnxn() {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let peers = Arc::new(Mutex::new(Vec::new()));
    tokio::spawn(tls_tv(theirs, peers.clone()));
    let certificate = adb_certificate(key(), SystemTime::now()).unwrap();
    let mut adb = AdbConnection::new(StreamLink::new(ours), options(Some(certificate)));
    adb.open(|| panic!("no prompt over TLS")).await.unwrap();
    assert_eq!(*peers.lock().unwrap(), vec![true]);
    adb.close().await;
}

#[tokio::test]
async fn says_the_tv_asks_for_tls_when_there_is_no_certificate_to_offer() {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    tokio::spawn(tls_tv(theirs, Arc::default()));
    let mut adb = AdbConnection::new(StreamLink::new(ours), options(None));
    let error = adb.open(|| {}).await.unwrap_err();
    assert!(error.to_string().contains("asks for TLS"));
}

#[tokio::test]
async fn fails_as_tls_refused_when_the_tv_does_not_accept_the_handshake() {
    let (ours, mut theirs) = tokio::io::duplex(1 << 16);
    tokio::spawn(async move {
        let mut cnxn = [0u8; 24 + 7];
        theirs.read_exact(&mut cnxn).await.unwrap();
        theirs
            .write_all(&encode_packet(A_STLS, VERSION, 0, &[]))
            .await
            .unwrap();
        let mut stls = [0u8; 24];
        theirs.read_exact(&mut stls).await.unwrap();
        // Not TLS: an alert-looking record where the ServerHello should be.
        theirs.write_all(&[0x15; 64]).await.unwrap();
        let mut rest = [0u8; 1024];
        let _ = theirs.read(&mut rest).await;
    });
    let certificate = adb_certificate(key(), SystemTime::now()).unwrap();
    let mut adb = AdbConnection::new(StreamLink::new(ours), options(Some(certificate)));
    let error = adb.open(|| {}).await.unwrap_err();
    assert_eq!(error.code(), Some("TLS_REFUSED"));
}

#[test]
fn names_failures_with_the_codes_the_installer_sorts_by() {
    let refused = AdbError::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));
    assert_eq!(refused.code(), Some("ECONNREFUSED"));
    assert_eq!(AdbError::Stopped.code(), None);
}
