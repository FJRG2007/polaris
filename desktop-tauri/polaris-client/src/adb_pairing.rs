//! Android 11+ Wireless debugging pairing: the six-digit code shown on the TV
//! makes it trust this computer's ADB key, so the TLS debugging port then lets
//! it in. Spoken directly, so nobody has to install platform-tools.
//!
//! The Rust twin of `desktop/src/main/adb-pairing.ts`. Protocol as AOSP
//! implements it (packages/modules/adb):
//! - pairing_connection/pairing_connection.cpp: TLS 1.3 to the pairing port with
//!   any certificate accepted, then 64 bytes of exported keying material (label
//!   "adb-label" with its NUL, no context) appended to the code as the password;
//!   packets are a 6-byte header (version 1, type, big-endian length) and payload.
//! - pairing_auth/pairing_auth.cpp, aes_128_gcm.cpp: SPAKE2 (`adb_spake2`), then
//!   HKDF-SHA256 of its key into an AES-128-GCM key; the nonce is a per-direction
//!   64-bit counter in the first 8 bytes, little-endian.
//! - PeerInfo: 8192 bytes, a type byte then the data; ours carries the ADB public
//!   key, the TV answers with its GUID. A wrong code shows up here, as a PeerInfo
//!   neither side can decrypt.
//! - crypto/x509_generator.cpp: the TLS certificate is self-signed over the same
//!   RSA key, which is what the TLS debugging port later checks (A_STLS).

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::Aes128Gcm;
use base64::Engine as _;
use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
use rsa::Pkcs1v15Sign;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::adb_client::{read_key, AdbError};
use crate::adb_spake2::{Spake2, Spake2Role, CLIENT_NAME, SERVER_NAME};

const HEADER_VERSION: u8 = 1;
pub const PACKET_SPAKE2: u8 = 0;
pub const PACKET_PEER_INFO: u8 = 1;
pub const HEADER_BYTES: usize = 6;
pub const PEER_INFO_BYTES: usize = 8192;
const MAX_PAYLOAD: u32 = (PEER_INFO_BYTES * 2) as u32;
const PEER_RSA_KEY: u8 = 0;
const GCM_TAG_BYTES: usize = 16;
const GCM_INFO: &[u8] = b"adb pairing_auth aes-128-gcm key";
pub const EXPORTED_LABEL: &[u8] = b"adb-label\0";
pub const EXPORTED_BYTES: usize = 64;

/// Why a pairing ended without the TV trusting this computer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingFailure {
    WrongCode,
    Timeout,
    Cancelled,
    Unreachable,
    Protocol,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PairingError {
    pub reason: PairingFailure,
    pub message: String,
}

impl PairingError {
    pub fn new(reason: PairingFailure, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    fn wrong_code() -> Self {
        Self::new(
            PairingFailure::WrongCode,
            "The TV did not accept the pairing code.",
        )
    }
}

/// The code exactly as the TV shows it: six digits. Spaces a person typed are dropped.
pub fn read_pairing_code(raw: &str) -> Option<String> {
    let code: String = raw
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    (code.len() == 6 && code.bytes().all(|byte| byte.is_ascii_digit())).then_some(code)
}

pub fn encode_pairing_packet(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut packet = vec![HEADER_VERSION, kind];
    packet.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    packet.extend_from_slice(payload);
    packet
}

/// One header's packet type and payload length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairingHeader {
    pub kind: u8,
    pub length: u32,
}

/// Reads one header as adbd checks it: a known version and type, and a length that is neither zero nor too large.
pub fn read_pairing_header(header: &[u8]) -> Result<PairingHeader, PairingError> {
    let protocol = |message: String| PairingError::new(PairingFailure::Protocol, message);
    if header.len() != HEADER_BYTES {
        return Err(protocol("Short pairing header.".into()));
    }
    let (version, kind) = (header[0], header[1]);
    let length = u32::from_be_bytes([header[2], header[3], header[4], header[5]]);
    if version != HEADER_VERSION {
        return Err(protocol(format!("Unsupported pairing version {version}.")));
    }
    if kind != PACKET_SPAKE2 && kind != PACKET_PEER_INFO {
        return Err(protocol(format!("Unknown pairing packet {kind}.")));
    }
    if length == 0 || length > MAX_PAYLOAD {
        return Err(protocol(format!("Pairing packet of {length} bytes.")));
    }
    Ok(PairingHeader { kind, length })
}

/// Our PeerInfo: the ADB public key (Android's format, with its NUL), zero-padded to 8192 bytes.
pub fn peer_info(public_key: &[u8]) -> Result<Vec<u8>, PairingError> {
    if public_key.len() > PEER_INFO_BYTES - 1 {
        return Err(PairingError::new(
            PairingFailure::Protocol,
            "The ADB public key does not fit a PeerInfo.",
        ));
    }
    let mut info = vec![0u8; PEER_INFO_BYTES];
    info[0] = PEER_RSA_KEY;
    info[1..=public_key.len()].copy_from_slice(public_key);
    Ok(info)
}

/// AES-128-GCM keyed from the SPAKE2 key, one counter per direction (aes_128_gcm.cpp).
pub struct PairingCipher {
    cipher: Aes128Gcm,
    sent: u64,
    received: u64,
}

impl PairingCipher {
    pub fn new(key_material: &[u8]) -> Self {
        let mut key = [0u8; 16];
        hkdf::Hkdf::<Sha256>::new(None, key_material)
            .expand(GCM_INFO, &mut key)
            .expect("16 bytes is a valid HKDF-SHA256 length");
        Self {
            cipher: Aes128Gcm::new(&key.into()),
            sent: 0,
            received: 0,
        }
    }

    fn nonce(sequence: u64) -> aes_gcm::aead::Nonce<Aes128Gcm> {
        let mut nonce = [0u8; 12];
        nonce[..8].copy_from_slice(&sequence.to_le_bytes());
        nonce.into()
    }

    pub fn encrypt(&mut self, plain: &[u8]) -> Vec<u8> {
        let sealed = self
            .cipher
            .encrypt(&Self::nonce(self.sent), plain)
            .expect("AES-GCM seals any PeerInfo-sized message");
        self.sent += 1;
        sealed
    }

    /// None when the data does not authenticate: the two sides did not derive the same key.
    pub fn decrypt(&mut self, sealed: &[u8]) -> Option<Vec<u8>> {
        if sealed.len() < GCM_TAG_BYTES {
            return None;
        }
        let plain = self
            .cipher
            .decrypt(&Self::nonce(self.received), sealed)
            .ok()?;
        self.received += 1;
        Some(plain)
    }
}

/// The TLS side of a pairing, as the exchange needs it.
pub trait PairingChannel: Send {
    fn write(&mut self, data: &[u8]) -> impl Future<Output = Result<(), PairingError>> + Send;
    /// Exactly `length` bytes; fails as `Unreachable` when the peer closes first.
    fn read(&mut self, length: usize)
        -> impl Future<Output = Result<Vec<u8>, PairingError>> + Send;
    /// RFC 5705 keying material of this TLS session, with no context.
    fn export_keying_material(&self, length: usize, label: &[u8]) -> Result<Vec<u8>, PairingError>;
}

async fn read_packet(
    channel: &mut impl PairingChannel,
    expected: u8,
) -> Result<Vec<u8>, PairingError> {
    let header = read_pairing_header(&channel.read(HEADER_BYTES).await?)?;
    if header.kind != expected {
        return Err(PairingError::new(
            PairingFailure::Protocol,
            format!("Expected pairing packet {expected}, got {}.", header.kind),
        ));
    }
    channel.read(header.length as usize).await
}

fn protocol(error: impl ToString) -> PairingError {
    PairingError::new(PairingFailure::Protocol, error.to_string())
}

/// The client half of one pairing over an established TLS channel. Succeeds once
/// the TV answered with its own PeerInfo, which only happens when it decrypted
/// ours - that is, when the code was right. `random` is for known-answer tests.
pub async fn pair_over(
    channel: &mut impl PairingChannel,
    code: &str,
    public_key: &[u8],
    random: Option<&[u8; 64]>,
) -> Result<(), PairingError> {
    let password = [
        code.as_bytes(),
        &channel.export_keying_material(EXPORTED_BYTES, EXPORTED_LABEL)?,
    ]
    .concat();
    let mut spake = match random {
        Some(random) => Spake2::with_random(
            Spake2Role::Alice,
            CLIENT_NAME,
            SERVER_NAME,
            &password,
            random,
        ),
        None => Spake2::new(Spake2Role::Alice, CLIENT_NAME, SERVER_NAME, &password),
    }
    .map_err(protocol)?;
    channel
        .write(&encode_pairing_packet(PACKET_SPAKE2, spake.message()))
        .await?;
    let theirs = read_packet(channel, PACKET_SPAKE2).await?;
    let mut cipher = PairingCipher::new(&spake.finish(&theirs).map_err(protocol)?);
    let sealed_ours = cipher.encrypt(&peer_info(public_key)?);
    channel
        .write(&encode_pairing_packet(PACKET_PEER_INFO, &sealed_ours))
        .await?;
    let sealed = match read_packet(channel, PACKET_PEER_INFO).await {
        Ok(sealed) => sealed,
        // adbd hangs up on a PeerInfo it cannot decrypt, which is what a wrong code looks like from here.
        Err(error) if error.reason == PairingFailure::Unreachable => {
            return Err(PairingError::wrong_code())
        }
        Err(error) => return Err(error),
    };
    match cipher.decrypt(&sealed) {
        Some(theirs) if theirs.len() == PEER_INFO_BYTES => Ok(()),
        _ => Err(PairingError::wrong_code()),
    }
}

fn der_length(length: usize) -> Vec<u8> {
    if length < 0x80 {
        return vec![length as u8];
    }
    let bytes: Vec<u8> = length
        .to_be_bytes()
        .into_iter()
        .skip_while(|byte| *byte == 0)
        .collect();
    [vec![0x80 | bytes.len() as u8], bytes].concat()
}

fn der(tag: u8, parts: &[&[u8]]) -> Vec<u8> {
    let body = parts.concat();
    [vec![tag], der_length(body.len()), body].concat()
}

/// A Unix time as `YYYYMMDDHHMMSS`, UTC.
fn utc_digits(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}{:02}{:02}{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

fn der_time(seconds: u64) -> Vec<u8> {
    let text = utc_digits(seconds);
    let year: u32 = text[..4].parse().unwrap_or(0);
    if year < 2050 {
        der(0x17, &[format!("{}Z", &text[2..]).as_bytes()])
    } else {
        der(0x18, &[format!("{text}Z").as_bytes()])
    }
}

fn sha256_with_rsa() -> Vec<u8> {
    let oid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
    der(0x30, &[&der(0x06, &[&oid]), &der(0x05, &[])])
}

/// A self-signed X.509 v3 certificate over `key_pem` (RSA), as adb's
/// x509_generator.cpp makes one: serial 1, ten years, subject C=US, O=Android,
/// CN=Adb, SHA-256 with RSA. The TV reads only the public key out of it. PEM.
pub fn adb_certificate(key_pem: &str, now: SystemTime) -> Result<String, AdbError> {
    let der_bytes = adb_certificate_der(key_pem, now)?;
    let body = base64::engine::general_purpose::STANDARD.encode(der_bytes);
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for line in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    Ok(pem)
}

fn adb_certificate_der(key_pem: &str, now: SystemTime) -> Result<Vec<u8>, AdbError> {
    let key = read_key(key_pem)?;
    let attribute = |oid: &[u8], value: &str| {
        der(
            0x31,
            &[&der(
                0x30,
                &[&der(0x06, &[oid]), &der(0x13, &[value.as_bytes()])],
            )],
        )
    };
    let name = der(
        0x30,
        &[
            &attribute(&[0x55, 0x04, 0x06], "US"),
            &attribute(&[0x55, 0x04, 0x0a], "Android"),
            &attribute(&[0x55, 0x04, 0x03], "Adb"),
        ],
    );
    let start = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let later = start + 10 * 365 * 24 * 3600;
    let spki = key
        .to_public_key()
        .to_public_key_der()
        .map_err(|_| AdbError::Key)?;
    let algorithm = sha256_with_rsa();
    let tbs = der(
        0x30,
        &[
            &der(0xa0, &[&der(0x02, &[&[2]])]),
            &der(0x02, &[&[1]]),
            &algorithm,
            &name,
            &der(0x30, &[&der_time(start), &der_time(later)]),
            &name,
            spki.as_bytes(),
        ],
    );
    let signature = key
        .sign(Pkcs1v15Sign::new::<Sha256>(), &Sha256::digest(&tbs))
        .map_err(|_| AdbError::Key)?;
    Ok(der(
        0x30,
        &[&tbs, &algorithm, &der(0x03, &[&[0], &signature])],
    ))
}

/// The certificate and key this computer shows over TLS, in DER.
#[derive(Clone)]
pub struct TlsIdentity {
    pub certificate: CertificateDer<'static>,
    key: Vec<u8>,
}

impl TlsIdentity {
    pub fn from_pem(certificate_pem: &str, key_pem: &str) -> Result<Self, AdbError> {
        let certificate = CertificateDer::from_pem_slice(certificate_pem.as_bytes())
            .map_err(|_| AdbError::Key)?;
        let key = read_key(key_pem)?
            .to_pkcs8_der()
            .map_err(|_| AdbError::Key)?;
        Ok(Self {
            certificate,
            key: key.as_bytes().to_vec(),
        })
    }

    /// A fresh certificate over `key_pem`.
    pub fn for_key(key_pem: &str) -> Result<Self, AdbError> {
        Self::from_pem(&adb_certificate(key_pem, SystemTime::now())?, key_pem)
    }

    pub fn key_der(&self) -> PrivateKeyDer<'static> {
        PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.key.clone()))
    }
}

/// adbd's own certificate is self-signed and the code is what proves who it is,
/// so any certificate is taken; the handshake signature is still checked.
#[derive(Debug)]
struct AnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS 1.3 only, any server certificate, this computer's certificate for client auth.
pub fn client_config(identity: &TlsIdentity) -> Result<Arc<ClientConfig>, AdbError> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| AdbError::TlsRefused)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
        .with_client_auth_cert(vec![identity.certificate.clone()], identity.key_der())
        .map_err(|_| AdbError::Key)?;
    Ok(Arc::new(config))
}

/// A pairing channel over a TLS stream.
pub struct TlsChannel<S>(pub tokio_rustls::client::TlsStream<S>);

impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> PairingChannel
    for TlsChannel<S>
{
    async fn write(&mut self, data: &[u8]) -> Result<(), PairingError> {
        let unreachable = |error: std::io::Error| {
            PairingError::new(PairingFailure::Unreachable, error.to_string())
        };
        self.0.write_all(data).await.map_err(unreachable)?;
        self.0.flush().await.map_err(unreachable)
    }

    async fn read(&mut self, length: usize) -> Result<Vec<u8>, PairingError> {
        let mut data = vec![0u8; length];
        match self.0.read_exact(&mut data).await {
            Ok(_) => Ok(data),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Err(
                PairingError::new(PairingFailure::Unreachable, "The TV closed the connection."),
            ),
            Err(error) => Err(PairingError::new(
                PairingFailure::Unreachable,
                error.to_string(),
            )),
        }
    }

    fn export_keying_material(&self, length: usize, label: &[u8]) -> Result<Vec<u8>, PairingError> {
        // TLS 1.3 treats an empty context as none (RFC 8446 7.5), which is what adbd asks for.
        self.0
            .get_ref()
            .1
            .export_keying_material(vec![0u8; length], label, None)
            .map_err(protocol)
    }
}

/// What one pairing needs.
pub struct PairOptions {
    pub host: String,
    /// The TV's `_adb-tls-pairing._tcp` port.
    pub port: u16,
    pub code: String,
    /// PEM, the same key the install connects with.
    pub key: String,
    pub public_key: Vec<u8>,
    pub timeout: Duration,
}

/// Pairs with the TV at `host`:`port`. `cancel` ends a pairing in progress; it then fails as `Cancelled`.
pub async fn pair_tv(
    options: PairOptions,
    cancel: impl Future<Output = ()>,
) -> Result<(), PairingError> {
    let run = async {
        let identity = TlsIdentity::for_key(&options.key).map_err(protocol)?;
        let config = client_config(&identity).map_err(protocol)?;
        let unreachable = |message: String| PairingError::new(PairingFailure::Unreachable, message);
        let socket = TcpStream::connect((options.host.as_str(), options.port))
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        let name = ServerName::try_from("adb").map_err(protocol)?;
        let secure = tokio_rustls::TlsConnector::from(config)
            .connect(name, socket)
            .await
            .map_err(|error| unreachable(error.to_string()))?;
        pair_over(
            &mut TlsChannel(secure),
            &options.code,
            &options.public_key,
            None,
        )
        .await
    };
    tokio::select! {
        result = tokio::time::timeout(options.timeout, run) => result.unwrap_or_else(|_| Err(PairingError::new(PairingFailure::Timeout, "The TV stopped answering."))),
        () = cancel => Err(PairingError::new(PairingFailure::Cancelled, "The pairing was stopped.")),
    }
}
