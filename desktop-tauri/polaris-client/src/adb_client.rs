//! The little of the ADB wire protocol that installing on a TV needs: connect,
//! authenticate, run a shell command, push a file. Spoken directly over TCP so
//! nobody has to install platform-tools.
//!
//! The Rust twin of `desktop/src/main/adb-client.ts`. Protocol as AOSP documents
//! it (packages/modules/adb, protocol.txt and SYNC.TXT). Over TCP, or over any
//! other link that carries the same packets - a USB cable's bulk endpoints
//! (`usb_link`). Android 11's Wireless debugging port asks for TLS first
//! (A_STLS); the pairing that makes it trust this key is `adb_pairing`.
//!
//! The TypeScript connection matches answers to waiters as packets arrive; the
//! installer only ever runs one command at a time, so here the connection reads
//! the link itself until the packet it waits for arrives, keeping the others in
//! the same inbox the TypeScript one keeps.

use std::future::Future;
use std::io;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use rsa::traits::PublicKeyParts;
use rsa::{Pkcs1v15Sign, PrivateKey};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::adb_pairing::{self, TlsIdentity};

pub const A_CNXN: u32 = 0x4e58_4e43;
pub const A_AUTH: u32 = 0x4854_5541;
pub const A_OPEN: u32 = 0x4e45_504f;
pub const A_OKAY: u32 = 0x5941_4b4f;
pub const A_CLSE: u32 = 0x4553_4c43;
pub const A_WRTE: u32 = 0x4554_5257;
pub const A_STLS: u32 = 0x534c_5453;
const STLS_VERSION: u32 = 0x0100_0000;
pub const VERSION: u32 = 0x0100_0000;
pub const MAX_PAYLOAD: u32 = 4096;
pub const AUTH_TOKEN: u32 = 1;
pub const AUTH_SIGNATURE: u32 = 2;
pub const AUTH_PUBLIC_KEY: u32 = 3;
pub const HEADER_BYTES: usize = 24;
const MAX_INBOUND: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 4 * 1024 * 1024;
pub const SYNC_CHUNK: usize = 64 * 1024;
/// DigestInfo for SHA-1: ADB's token stands in for the digest itself.
const SHA1_PREFIX: [u8; 15] = [
    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
];

/// Why talking to the TV's adbd failed. The sentences are the TypeScript module's.
#[derive(Debug, thiserror::Error)]
pub enum AdbError {
    #[error("That address does not speak ADB.")]
    NotAdb,
    #[error("The TV stopped answering.")]
    Stopped,
    #[error("The TV refused that.")]
    Refused,
    #[error("The TV refused the file.")]
    FileRefused,
    #[error("The connection was closed.")]
    Closed,
    #[error("The TV closed the connection.")]
    ClosedByTv,
    #[error("The TV asks for TLS on this link.")]
    TlsNotOffered,
    /// `TLS_REFUSED`: the TV does not know this key over TLS.
    #[error("The TV did not accept this computer over TLS.")]
    TlsRefused,
    /// The link did not connect in time.
    #[error("timeout")]
    ConnectTimeout,
    #[error("The ADB key is not usable.")]
    Key,
    /// A USB link failure, with the code `usb_link` gives it (`USB_BUSY`, `USB_GONE`).
    #[error("{message}")]
    Usb { code: &'static str, message: String },
    #[error("{0}")]
    Io(#[from] io::Error),
}

impl AdbError {
    /// The code a Node error would carry, which is what the installer sorts failures by.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::TlsRefused => Some("TLS_REFUSED"),
            Self::Usb { code, .. } => Some(code),
            Self::Io(error) => match error.kind() {
                io::ErrorKind::ConnectionRefused => Some("ECONNREFUSED"),
                io::ErrorKind::HostUnreachable => Some("EHOSTUNREACH"),
                io::ErrorKind::NetworkUnreachable => Some("ENETUNREACH"),
                _ => None,
            },
            _ => None,
        }
    }
}

/// One ADB packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub command: u32,
    pub arg0: u32,
    pub arg1: u32,
    pub data: Vec<u8>,
}

/// A packet as it goes on the wire: the 24-byte header, then the payload.
pub fn encode_packet(command: u32, arg0: u32, arg1: u32, data: &[u8]) -> Vec<u8> {
    let sum = data
        .iter()
        .fold(0u32, |sum, byte| sum.wrapping_add(u32::from(*byte)));
    let mut packet = Vec::with_capacity(HEADER_BYTES + data.len());
    for word in [
        command,
        arg0,
        arg1,
        data.len() as u32,
        sum,
        command ^ 0xffff_ffff,
    ] {
        packet.extend_from_slice(&word.to_le_bytes());
    }
    packet.extend_from_slice(data);
    packet
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// Packets read off a stream that hands them over in arbitrary pieces.
#[derive(Default)]
pub struct PacketReader {
    pending: Vec<u8>,
}

impl PacketReader {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Packet>, AdbError> {
        self.pending.extend_from_slice(chunk);
        let mut packets = Vec::new();
        let mut at = 0;
        while self.pending.len() - at >= HEADER_BYTES {
            let command = word(&self.pending, at);
            let length = word(&self.pending, at + 12) as usize;
            let magic = word(&self.pending, at + 20);
            if command ^ 0xffff_ffff != magic || length > MAX_INBOUND {
                return Err(AdbError::NotAdb);
            }
            if self.pending.len() - at < HEADER_BYTES + length {
                break;
            }
            packets.push(Packet {
                command,
                arg0: word(&self.pending, at + 4),
                arg1: word(&self.pending, at + 8),
                data: self.pending[at + HEADER_BYTES..at + HEADER_BYTES + length].to_vec(),
            });
            at += HEADER_BYTES + length;
        }
        self.pending.drain(..at);
        Ok(packets)
    }
}

/// A new 2048-bit RSA key, as PKCS#8 PEM.
pub fn new_adb_key() -> Result<String, AdbError> {
    let key = PrivateKey::new(&mut getrandom::SysRng, 2048).map_err(|_| AdbError::Key)?;
    Ok(key
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|_| AdbError::Key)?
        .to_string())
}

/// Reads a PEM private key: PKCS#8, as `new_adb_key` writes it, or PKCS#1.
pub fn read_key(pem: &str) -> Result<PrivateKey, AdbError> {
    use rsa::pkcs1::DecodeRsaPrivateKey;
    PrivateKey::from_pkcs8_pem(pem)
        .or_else(|_| PrivateKey::from_pkcs1_pem(pem))
        .map_err(|_| AdbError::Key)
}

/// 64 little-endian 32-bit words of a big-endian number.
fn words_of(big_endian: &[u8], count: usize) -> Vec<u32> {
    let mut words = vec![0u32; count];
    for (index, byte) in big_endian.iter().rev().enumerate() {
        if index / 4 < count {
            words[index / 4] |= u32::from(*byte) << ((index % 4) * 8);
        }
    }
    words
}

fn at_least(left: &[u32], right: &[u32]) -> bool {
    for (a, b) in left.iter().rev().zip(right.iter().rev()) {
        if a != b {
            return a > b;
        }
    }
    true
}

/// The public key in Android's own format: mincrypt's RSAPublicKey, base64, then a name.
pub fn android_public_key(key_pem: &str, comment: &str) -> Result<Vec<u8>, AdbError> {
    const WORDS: usize = 64;
    let key = read_key(key_pem)?;
    let n = words_of(&key.n().to_be_bytes(), WORDS);
    // n0inv = -1 / n[0] mod 2^32, by Newton's iteration.
    let mut inverse = 1u32;
    for _ in 0..6 {
        inverse = inverse.wrapping_mul(2u32.wrapping_sub(n[0].wrapping_mul(inverse)));
    }
    let n0inv = inverse.wrapping_neg();
    // rr = 2^4096 mod n, by doubling one 4096 times modulo n.
    let mut rr = vec![0u32; WORDS + 1];
    rr[0] = 1;
    let mut wide_n = n.clone();
    wide_n.push(0);
    for _ in 0..4096 {
        let mut carry = 0u32;
        for limb in rr.iter_mut() {
            let next = *limb >> 31;
            *limb = (*limb << 1) | carry;
            carry = next;
        }
        if at_least(&rr, &wide_n) {
            let mut borrow = 0i64;
            for (limb, subtrahend) in rr.iter_mut().zip(&wide_n) {
                let value = i64::from(*limb) - i64::from(*subtrahend) - borrow;
                borrow = i64::from(value < 0);
                *limb = value.rem_euclid(1 << 32) as u32;
            }
        }
    }
    let mut raw = Vec::with_capacity(8 + WORDS * 8 + 4);
    raw.extend_from_slice(&(WORDS as u32).to_le_bytes());
    raw.extend_from_slice(&n0inv.to_le_bytes());
    for limb in n.iter().chain(&rr[..WORDS]) {
        raw.extend_from_slice(&limb.to_le_bytes());
    }
    raw.extend_from_slice(&65537u32.to_le_bytes());
    let mut out = base64::engine::general_purpose::STANDARD
        .encode(raw)
        .into_bytes();
    out.push(b' ');
    out.extend_from_slice(comment.as_bytes());
    out.push(0);
    Ok(out)
}

/// The name the installer gives this computer's key on the TV.
pub const KEY_COMMENT: &str = "polaris@desktop";

/// The token signed as `RSA_private_encrypt` with PKCS#1 padding over SHA-1's DigestInfo, as adbd checks it.
pub fn sign_token(key_pem: &str, token: &[u8]) -> Result<Vec<u8>, AdbError> {
    let key = read_key(key_pem)?;
    let digest = [&SHA1_PREFIX[..], token].concat();
    key.sign(Pkcs1v15Sign::new_unprefixed(), &digest)
        .map_err(|_| AdbError::Key)
}

/// A path to the TV's adbd that carries whole packets.
pub trait AdbLink: Send {
    /// One packet: USB sends its header and payload as two transfers, TCP as one write.
    fn send(
        &mut self,
        header: &[u8],
        data: &[u8],
    ) -> impl Future<Output = Result<(), AdbError>> + Send;
    /// The next bytes the TV sent; an error once the link is gone.
    fn receive(&mut self) -> impl Future<Output = Result<Vec<u8>, AdbError>> + Send;
    /// Whether this link can carry on over TLS (A_STLS). Only the network link can.
    fn can_start_tls(&self) -> bool {
        false
    }
    /// Carries on over TLS with this certificate and key.
    fn start_tls(
        &mut self,
        _identity: &TlsIdentity,
        _timeout: Duration,
    ) -> impl Future<Output = Result<(), AdbError>> + Send {
        async { Err(AdbError::TlsNotOffered) }
    }
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

enum Stream<S> {
    Plain(S),
    Tls(Box<tokio_rustls::client::TlsStream<S>>),
    Gone,
}

/// A link over a byte stream: a TCP socket to the TV's port, or anything that behaves like one.
pub struct StreamLink<S> {
    stream: Stream<S>,
}

impl<S> StreamLink<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream: Stream::Plain(stream),
        }
    }
}

/// The network link: a TCP connection to `host`:`port`.
pub async fn tcp_link(
    host: &str,
    port: u16,
    connect: Duration,
) -> Result<StreamLink<TcpStream>, AdbError> {
    match tokio::time::timeout(connect, TcpStream::connect((host, port))).await {
        Ok(Ok(stream)) => {
            let _ = stream.set_nodelay(true);
            Ok(StreamLink::new(stream))
        }
        Ok(Err(error)) => Err(AdbError::Io(error)),
        Err(_) => Err(AdbError::ConnectTimeout),
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + Send> AdbLink for StreamLink<S> {
    async fn send(&mut self, header: &[u8], data: &[u8]) -> Result<(), AdbError> {
        let packet = [header, data].concat();
        match &mut self.stream {
            Stream::Plain(stream) => {
                stream.write_all(&packet).await?;
                stream.flush().await?;
            }
            Stream::Tls(stream) => {
                stream.write_all(&packet).await?;
                stream.flush().await?;
            }
            Stream::Gone => return Err(AdbError::Closed),
        }
        Ok(())
    }

    async fn receive(&mut self) -> Result<Vec<u8>, AdbError> {
        let mut buffer = vec![0u8; 64 * 1024];
        let read = match &mut self.stream {
            Stream::Plain(stream) => stream.read(&mut buffer).await?,
            Stream::Tls(stream) => stream.read(&mut buffer).await?,
            Stream::Gone => return Err(AdbError::Closed),
        };
        if read == 0 {
            return Err(AdbError::ClosedByTv);
        }
        buffer.truncate(read);
        Ok(buffer)
    }

    fn can_start_tls(&self) -> bool {
        matches!(self.stream, Stream::Plain(_))
    }

    async fn start_tls(
        &mut self,
        identity: &TlsIdentity,
        timeout: Duration,
    ) -> Result<(), AdbError> {
        let Stream::Plain(stream) = std::mem::replace(&mut self.stream, Stream::Gone) else {
            return Err(AdbError::TlsNotOffered);
        };
        // adbd's certificate is self-signed; what it checks is that our key is one it paired with.
        let connector = tokio_rustls::TlsConnector::from(adb_pairing::client_config(identity)?);
        let name =
            rustls::pki_types::ServerName::try_from("adb").map_err(|_| AdbError::TlsRefused)?;
        match tokio::time::timeout(timeout, connector.connect(name, stream)).await {
            Ok(Ok(secure)) => {
                self.stream = Stream::Tls(Box::new(secure));
                Ok(())
            }
            Ok(Err(_)) => Err(AdbError::TlsRefused),
            Err(_) => Err(AdbError::ConnectTimeout),
        }
    }

    async fn close(&mut self) {
        match std::mem::replace(&mut self.stream, Stream::Gone) {
            Stream::Plain(mut stream) => {
                let _ = stream.shutdown().await;
            }
            Stream::Tls(mut stream) => {
                let _ = stream.shutdown().await;
            }
            Stream::Gone => {}
        }
    }
}

/// How long each step may take, and what the connection authenticates with.
pub struct AdbOptions {
    /// PEM. Its public half is what the TV is asked to allow.
    pub key: String,
    /// The self-signed certificate over `key`, for a TV that asks for TLS (its Wireless debugging port).
    pub certificate: Option<String>,
    pub connect: Duration,
    /// How long somebody has to answer the prompt on the TV.
    pub approve: Duration,
    pub command: Duration,
}

/// One authenticated connection to a TV's adbd.
pub struct AdbConnection<L: AdbLink> {
    link: Option<L>,
    options: AdbOptions,
    reader: PacketReader,
    inbox: Vec<Packet>,
    failure: Option<String>,
    next_id: u32,
    max_payload: u32,
}

impl<L: AdbLink> AdbConnection<L> {
    pub fn new(link: L, options: AdbOptions) -> Self {
        Self {
            link: Some(link),
            options,
            reader: PacketReader::new(),
            inbox: Vec::new(),
            failure: None,
            next_id: 1,
            max_payload: MAX_PAYLOAD,
        }
    }

    /// The largest payload the TV said it takes, within ADB's 4096.
    pub fn max_payload(&self) -> u32 {
        self.max_payload
    }

    async fn send(
        &mut self,
        command: u32,
        arg0: u32,
        arg1: u32,
        data: &[u8],
    ) -> Result<(), AdbError> {
        let packet = encode_packet(command, arg0, arg1, data);
        let link = self.link.as_mut().ok_or(AdbError::Closed)?;
        link.send(&packet[..HEADER_BYTES], &packet[HEADER_BYTES..])
            .await
    }

    /// The next packet that matches, from the inbox or the link, within `timeout`.
    async fn next(
        &mut self,
        matches: impl Fn(&Packet) -> bool,
        timeout: Duration,
    ) -> Result<Packet, AdbError> {
        if let Some(index) = self.inbox.iter().position(&matches) {
            return Ok(self.inbox.remove(index));
        }
        if self.failure.is_some() {
            return Err(AdbError::Closed);
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let link = self.link.as_mut().ok_or(AdbError::Closed)?;
            let chunk = match tokio::time::timeout_at(deadline, link.receive()).await {
                Err(_) => return Err(AdbError::Stopped),
                Ok(Err(error)) => {
                    self.failure = Some(error.to_string());
                    return Err(error);
                }
                Ok(Ok(chunk)) => chunk,
            };
            let packets = match self.reader.push(&chunk) {
                Ok(packets) => packets,
                Err(error) => {
                    self.failure = Some(error.to_string());
                    self.close().await;
                    return Err(error);
                }
            };
            let mut found = None;
            for packet in packets {
                if found.is_none() && matches(&packet) {
                    found = Some(packet);
                } else {
                    self.inbox.push(packet);
                }
            }
            if let Some(packet) = found {
                return Ok(packet);
            }
        }
    }

    /// Connects and authenticates. `on_prompt` runs when the TV shows its "Allow debugging?" prompt.
    pub async fn open(&mut self, mut on_prompt: impl FnMut() + Send) -> Result<(), AdbError> {
        let connect = self.options.connect;
        self.send(A_CNXN, VERSION, MAX_PAYLOAD, b"host::\0").await?;
        let handshake = |packet: &Packet| matches!(packet.command, A_CNXN | A_AUTH | A_STLS);
        let mut answer = self.next(handshake, connect).await?;
        if answer.command == A_STLS {
            let link = self.link.as_ref().ok_or(AdbError::Closed)?;
            let certificate = match (&self.options.certificate, link.can_start_tls()) {
                (Some(certificate), true) => certificate.clone(),
                _ => return Err(AdbError::TlsNotOffered),
            };
            let identity = TlsIdentity::from_pem(&certificate, &self.options.key)?;
            self.send(A_STLS, STLS_VERSION, 0, &[]).await?;
            let link = self.link.as_mut().ok_or(AdbError::Closed)?;
            link.start_tls(&identity, connect).await?;
            // Over TLS the key was already checked in the handshake: the TV answers with its CNXN.
            answer = self
                .next(|packet| packet.command == A_CNXN, connect)
                .await?;
        }
        if answer.command == A_AUTH && answer.arg0 == AUTH_TOKEN {
            let signature = sign_token(&self.options.key, &answer.data)?;
            self.send(A_AUTH, AUTH_SIGNATURE, 0, &signature).await?;
            answer = self.next(handshake, connect).await?;
        }
        if answer.command == A_AUTH {
            let public = android_public_key(&self.options.key, KEY_COMMENT)?;
            self.send(A_AUTH, AUTH_PUBLIC_KEY, 0, &public).await?;
            on_prompt();
            answer = self
                .next(|packet| packet.command == A_CNXN, self.options.approve)
                .await?;
        }
        self.max_payload = answer.arg1.clamp(1024, MAX_PAYLOAD);
        Ok(())
    }

    async fn stream(&mut self, service: &str) -> Result<(u32, u32), AdbError> {
        let local = self.next_id;
        self.next_id += 1;
        let name = [service.as_bytes(), b"\0"].concat();
        self.send(A_OPEN, local, 0, &name).await?;
        let opened = self
            .next(
                |packet| packet.arg1 == local && matches!(packet.command, A_OKAY | A_CLSE),
                self.options.command,
            )
            .await?;
        if opened.command == A_CLSE {
            return Err(AdbError::Refused);
        }
        Ok((local, opened.arg0))
    }

    /// One shell command's whole output, with the connection's command timeout.
    pub async fn shell(&mut self, command: &str) -> Result<String, AdbError> {
        let timeout = self.options.command;
        self.shell_within(command, timeout).await
    }

    /// One shell command's whole output. Run one at a time.
    pub async fn shell_within(
        &mut self,
        command: &str,
        timeout: Duration,
    ) -> Result<String, AdbError> {
        let (local, remote) = self.stream(&format!("shell:{command}")).await?;
        let mut output = Vec::new();
        let mut size = 0usize;
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1));
            let packet = self
                .next(
                    |one| one.arg1 == local && matches!(one.command, A_WRTE | A_CLSE),
                    left,
                )
                .await?;
            if packet.command == A_CLSE {
                break;
            }
            self.send(A_OKAY, local, remote, &[]).await?;
            size += packet.data.len();
            if size <= MAX_OUTPUT {
                output.extend_from_slice(&packet.data);
            }
        }
        self.send(A_CLSE, local, remote, &[]).await?;
        Ok(String::from_utf8_lossy(&output).into_owned())
    }

    async fn write(&mut self, local: u32, remote: u32, data: &[u8]) -> Result<(), AdbError> {
        for chunk in data.chunks(self.max_payload as usize) {
            self.send(A_WRTE, local, remote, chunk).await?;
            self.next(
                |packet| packet.arg1 == local && packet.command == A_OKAY,
                self.options.command,
            )
            .await?;
        }
        Ok(())
    }

    /// Pushes `data` to `path` through the sync service.
    pub async fn push(&mut self, path: &str, data: &[u8], mode: u32) -> Result<(), AdbError> {
        let (local, remote) = self.stream("sync:").await?;
        let tagged = |tag: &[u8; 4], value: u32, body: &[u8]| {
            [&tag[..], &value.to_le_bytes(), body].concat()
        };
        let target = format!("{path},{mode}").into_bytes();
        self.write(
            local,
            remote,
            &tagged(b"SEND", target.len() as u32, &target),
        )
        .await?;
        for chunk in data.chunks(SYNC_CHUNK) {
            self.write(local, remote, &tagged(b"DATA", chunk.len() as u32, chunk))
                .await?;
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        self.write(local, remote, &tagged(b"DONE", now as u32, &[]))
            .await?;
        let answer = self
            .next(
                |packet| packet.arg1 == local && packet.command == A_WRTE,
                self.options.command,
            )
            .await?;
        self.send(A_OKAY, local, remote, &[]).await?;
        self.send(A_CLSE, local, remote, &[]).await?;
        if answer.data.get(..4) != Some(b"OKAY") {
            return Err(AdbError::FileRefused);
        }
        Ok(())
    }

    /// Ends the connection; nothing waits on it after this.
    pub async fn close(&mut self) {
        if let Some(mut link) = self.link.take() {
            link.close().await;
        }
        self.failure
            .get_or_insert_with(|| AdbError::Closed.to_string());
    }
}
