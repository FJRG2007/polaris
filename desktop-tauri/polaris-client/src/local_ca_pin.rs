//! Accept the same Polaris's own local certificate on its proven local address,
//! with nothing installed by the person.
//!
//! The Rust twin of `desktop/src/main/local-ca-pin.ts`. `GET /api/instance`
//! publishes the instance's local CA SHA-256, learned only over the usual
//! address (https, trusted by the system). A chain is accepted only when all of
//! this holds:
//!
//! - the usual address is https and the host asked for is one of the instance's
//!   other addresses (never the usual one, never anything else);
//! - the system's only complaint is the unknown authority;
//! - the leaf names that host, every certificate is in date, and each one is
//!   signed by the next, up to a CA certificate whose SHA-256 is the pin.
//!
//! Signatures, names and the leaf's dates are checked by webpki with the pinned
//! certificate as the only trust anchor; the anchor's own dates and CA flag, which
//! webpki does not look at for an anchor, are read here.

use crate::instance::InstanceRecord;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{
    CertificateError, DigitallySignedStruct, Error as TlsError, RootCertStore, SignatureScheme,
};
use std::sync::{Arc, RwLock};

const MAX_CHAIN: usize = 6;

/// Where the pin applies, for the one server the app is on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinScope {
    /// Hostnames of the instance's other addresses, lowercase, without brackets.
    pub hosts: Vec<String>,
    /// Lowercase hex SHA-256 of the local CA certificate(s).
    pub pins: Vec<String>,
}

fn bare_host(hostname: &str) -> String {
    let host = hostname.trim().to_ascii_lowercase();
    match host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    {
        Some(inner) => inner.to_owned(),
        None => host,
    }
}

/// The scope for `primary` given what was learned over it, or `None` when nothing
/// may be accepted: no record, no published CA, or a usual address that is not
/// https (a pin learned over plain HTTP proves nothing).
pub fn pin_scope(primary: Option<&str>, record: Option<&InstanceRecord>) -> Option<PinScope> {
    let record = record?;
    let pins = &record.local_ca_sha256;
    if pins.is_empty() {
        return None;
    }
    let primary = url::Url::parse(primary?).ok()?;
    if primary.scheme() != "https" {
        return None;
    }
    let primary_host = bare_host(primary.host_str()?);
    let mut hosts: Vec<String> = Vec::new();
    for address in &record.addresses {
        let Ok(url) = url::Url::parse(address) else {
            continue;
        };
        let host = bare_host(url.host_str().unwrap_or_default());
        if url.scheme() == "https"
            && !host.is_empty()
            && host != primary_host
            && !hosts.contains(&host)
        {
            hosts.push(host);
        }
    }
    (!hosts.is_empty()).then(|| PinScope {
        hosts,
        pins: pins.clone(),
    })
}

/// Lowercase hex SHA-256 of a DER certificate.
pub fn sha256_hex(der: &[u8]) -> String {
    aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, der)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// The DER certificates in a PEM text, in order.
pub fn pem_certificates(pem: &str) -> Vec<Vec<u8>> {
    use base64::Engine;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let mut found = Vec::new();
    let mut rest = pem;
    while let Some(start) = rest.find(BEGIN) {
        let after = &rest[start + BEGIN.len()..];
        let Some(end) = after.find(END) else { break };
        let body: String = after[..end]
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(body) {
            found.push(der);
        }
        rest = &after[end + END.len()..];
    }
    found
}

/// A minimal DER reader for the two facts webpki does not check on a trust
/// anchor: its validity dates and whether it is a CA.
mod der {
    pub struct Tlv<'a> {
        pub tag: u8,
        pub value: &'a [u8],
    }

    /// One element and what follows it.
    pub fn read(input: &[u8]) -> Option<(Tlv<'_>, &[u8])> {
        let (&tag, rest) = input.split_first()?;
        let (&first, mut rest) = rest.split_first()?;
        let length = if first < 0x80 {
            usize::from(first)
        } else {
            let count = usize::from(first & 0x7f);
            if count == 0 || count > 4 || rest.len() < count {
                return None;
            }
            let (bytes, after) = rest.split_at(count);
            rest = after;
            bytes
                .iter()
                .fold(0usize, |total, byte| (total << 8) | usize::from(*byte))
        };
        if rest.len() < length {
            return None;
        }
        let (value, after) = rest.split_at(length);
        Some((Tlv { tag, value }, after))
    }

    fn digits(bytes: &[u8]) -> Option<i64> {
        bytes.iter().try_fold(0i64, |total, byte| {
            byte.is_ascii_digit()
                .then(|| total * 10 + i64::from(byte - b'0'))
        })
    }

    /// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
    fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
        let year = if month <= 2 { year - 1 } else { year };
        let era = year.div_euclid(400);
        let year_of_era = year - era * 400;
        let month_index = (month + 9) % 12;
        let day_of_year = (153 * month_index + 2) / 5 + day - 1;
        let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
        era * 146_097 + day_of_era - 719_468
    }

    /// A UTCTime (0x17) or GeneralizedTime (0x18) in seconds since the epoch, `Z` form only.
    fn time(element: &Tlv<'_>) -> Option<i64> {
        let text = element.value.strip_suffix(b"Z")?;
        let (year, rest) = match element.tag {
            0x17 if text.len() == 12 => {
                let two = digits(&text[..2])?;
                (if two >= 50 { 1900 + two } else { 2000 + two }, &text[2..])
            }
            0x18 if text.len() == 14 => (digits(&text[..4])?, &text[4..]),
            _ => return None,
        };
        let field = |at: usize| digits(&rest[at..at + 2]);
        let (month, day) = (field(0)?, field(2)?);
        let (hour, minute, second) = (field(4)?, field(6)?, field(8)?);
        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || hour > 23
            || minute > 59
            || second > 60
        {
            return None;
        }
        Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
    }

    /// The fields of a certificate this needs.
    pub struct Facts {
        pub not_before: i64,
        pub not_after: i64,
        pub ca: bool,
    }

    const BASIC_CONSTRAINTS: &[u8] = &[0x55, 0x1d, 0x13];

    fn is_ca(extensions: &[u8]) -> Option<bool> {
        let (list, _) = read(extensions)?;
        let mut rest = list.value;
        while !rest.is_empty() {
            let (extension, after) = read(rest)?;
            rest = after;
            let (oid, mut inner) = read(extension.value)?;
            if oid.tag != 0x06 || oid.value != BASIC_CONSTRAINTS {
                continue;
            }
            let (mut value, after) = read(inner)?;
            if value.tag == 0x01 {
                // The `critical` flag; the value follows it.
                inner = after;
                value = read(inner)?.0;
            }
            if value.tag != 0x04 {
                return None;
            }
            let (constraints, _) = read(value.value)?;
            return Some(match read(constraints.value) {
                Some((flag, _)) if flag.tag == 0x01 => {
                    flag.value.first().is_some_and(|byte| *byte != 0)
                }
                _ => false,
            });
        }
        Some(false)
    }

    pub fn facts(certificate: &[u8]) -> Option<Facts> {
        let (outer, _) = read(certificate)?;
        let (tbs, _) = read(outer.value)?;
        let mut rest = tbs.value;
        let (mut element, mut after) = read(rest)?;
        if element.tag == 0xa0 {
            // The version, present on every v3 certificate.
            (element, after) = read(after)?;
        }
        let _serial = element;
        let (_signature, after) = read(after)?;
        let (_issuer, after) = read(after)?;
        let (validity, after) = read(after)?;
        let (not_before, rest_validity) = read(validity.value)?;
        let (not_after, _) = read(rest_validity)?;
        let (_subject, after) = read(after)?;
        let (_key, after) = read(after)?;
        rest = after;
        let mut ca = false;
        while !rest.is_empty() {
            let (element, after) = read(rest)?;
            rest = after;
            if element.tag == 0xa3 {
                ca = is_ca(element.value)?;
            }
        }
        Some(Facts {
            not_before: time(&not_before)?,
            not_after: time(&not_after)?,
            ca,
        })
    }
}

/// The crypto provider the TLS stack uses (aws-lc-rs, as reqwest's rustls does).
fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
}

/// Whether `chain` (leaf first, DER) is a certificate for `hostname` signed, link
/// by link, up to a CA whose SHA-256 is one of `pins`. Signatures are checked,
/// not taken from the chain's own claims: a leaf of someone else's that merely
/// names the real CA as its issuer fails.
pub fn chain_ends_in_pin(
    chain: &[Vec<u8>],
    hostname: &str,
    pins: &[String],
    now: UnixTime,
) -> bool {
    let mut certificates: Vec<&[u8]> = Vec::new();
    for certificate in chain.iter().take(MAX_CHAIN) {
        if certificates
            .last()
            .is_some_and(|last| sha256_hex(last) == sha256_hex(certificate))
        {
            break;
        }
        certificates.push(certificate);
    }
    let Some(anchor) = certificates
        .iter()
        .enumerate()
        .skip(1)
        .find(|(_, certificate)| pins.contains(&sha256_hex(certificate)))
        .map(|(index, _)| index)
    else {
        return false;
    };
    let Some(anchor_facts) = der::facts(certificates[anchor]) else {
        return false;
    };
    let seconds = now.as_secs() as i64;
    if !anchor_facts.ca || anchor_facts.not_before > seconds || seconds > anchor_facts.not_after {
        return false;
    }
    let mut roots = RootCertStore::empty();
    if roots
        .add(CertificateDer::from(certificates[anchor].to_vec()))
        .is_err()
    {
        return false;
    }
    let Ok(verifier) =
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider()).build()
    else {
        return false;
    };
    let Ok(name) = ServerName::try_from(bare_host(hostname)) else {
        return false;
    };
    let leaf = CertificateDer::from(certificates[0].to_vec());
    let intermediates: Vec<CertificateDer<'static>> = certificates[1..anchor]
        .iter()
        .map(|certificate| CertificateDer::from(certificate.to_vec()))
        .collect();
    verifier
        .verify_server_cert(&leaf, &intermediates, &name, &[], now)
        .is_ok()
}

/// Whether the system's refusal is the unknown authority and nothing else.
fn only_unknown_authority(error: &TlsError) -> bool {
    matches!(
        error,
        TlsError::InvalidCertificate(CertificateError::UnknownIssuer)
    )
}

/// The verifier for the app's own requests: the system's trust, plus, on the
/// in-scope hosts only, a chain that ends in the pinned local CA. The scope is
/// set for the server the app is on and cleared when it leaves it.
#[derive(Debug)]
pub struct PinVerifier {
    system: Arc<dyn ServerCertVerifier>,
    scope: RwLock<Option<PinScope>>,
}

impl PinVerifier {
    pub fn new() -> Result<Arc<Self>, TlsError> {
        let system = rustls_platform_verifier::Verifier::new(provider())?;
        Ok(Arc::new(Self {
            system: Arc::new(system),
            scope: RwLock::new(None),
        }))
    }

    pub fn set_scope(&self, scope: Option<PinScope>) {
        *self
            .scope
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = scope;
    }

    pub fn scope(&self) -> Option<PinScope> {
        self.scope
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// A client whose TLS goes through this verifier.
    pub fn client(
        self: &Arc<Self>,
        builder: reqwest::ClientBuilder,
    ) -> reqwest::Result<reqwest::Client> {
        let config = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .expect("the default provider supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(self.clone())
            .with_no_client_auth();
        builder.tls_backend_preconfigured(config).build()
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let verdict = self.system.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        );
        let Err(error) = &verdict else { return verdict };
        let Some(scope) = self.scope().filter(|_| only_unknown_authority(error)) else {
            return verdict;
        };
        let host = bare_host(&server_name.to_str());
        if !scope.hosts.contains(&host) {
            return verdict;
        }
        let chain: Vec<Vec<u8>> = std::iter::once(end_entity)
            .chain(intermediates)
            .map(|certificate| certificate.to_vec())
            .collect();
        if chain_ends_in_pin(&chain, &host, &scope.pins, now) {
            Ok(ServerCertVerified::assertion())
        } else {
            verdict
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.system.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.system.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.system.supported_verify_schemes()
    }
}

/// A verifier that accepts the certificate of one host, whatever it is, and keeps
/// the system's verdict for every other. Only for the same-instance comparison,
/// whose requests carry nothing of the person's (`same_instance`).
#[derive(Debug)]
pub struct AcceptHost {
    system: Arc<dyn ServerCertVerifier>,
    host: String,
}

impl AcceptHost {
    pub fn client(host: &str, builder: reqwest::ClientBuilder) -> Result<reqwest::Client, String> {
        let system = rustls_platform_verifier::Verifier::new(provider())
            .map_err(|error| error.to_string())?;
        let verifier = Arc::new(Self {
            system: Arc::new(system),
            host: bare_host(host),
        });
        let config = rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        builder
            .tls_backend_preconfigured(config)
            .build()
            .map_err(|error| error.to_string())
    }
}

impl ServerCertVerifier for AcceptHost {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if bare_host(&server_name.to_str()) == self.host {
            return Ok(ServerCertVerified::assertion());
        }
        self.system
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.system.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        self.system.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.system.supported_verify_schemes()
    }
}
