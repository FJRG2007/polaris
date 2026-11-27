//! The local CA pin: a TLS verifier for a proven alternate address that also
//! accepts a chain ending in one of the instance's own local CAs
//! (`localCaSha256`), which the system does not trust.
//!
//! The pin is a hash, so it can only recognise a CA certificate the server sent
//! in its chain; that certificate then becomes the only root of a normal WebPKI
//! verification (signatures, name, validity). A server that sends only its leaf
//! is judged by the system verifier alone. Use this verifier only on an
//! alternate that has signed the instance challenge, never on the address the
//! terminal was given: the pin was learned over that address and proves nothing
//! about it.

use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, Error, RootCertStore, SignatureScheme};

/// Lowercase hex SHA-256 of `bytes`, the form `localCaSha256` uses.
pub fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug)]
pub struct LocalCaVerifier {
    system: Arc<dyn ServerCertVerifier>,
    pins: Vec<String>,
    provider: Arc<CryptoProvider>,
}

impl LocalCaVerifier {
    /// `system` is the verifier the terminal uses everywhere else; `pins` the
    /// instance's `localCaSha256`.
    pub fn new(system: Arc<dyn ServerCertVerifier>, pins: Vec<String>) -> Self {
        Self {
            system,
            pins,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
        }
    }

    fn verify_with_pin(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Option<ServerCertVerified> {
        for ca in intermediates
            .iter()
            .filter(|ca| self.pins.contains(&sha256_hex(ca.as_ref())))
        {
            let mut roots = RootCertStore::empty();
            if roots.add(ca.clone().into_owned()).is_err() {
                continue;
            }
            let Ok(pinned) =
                WebPkiServerVerifier::builder_with_provider(Arc::new(roots), self.provider.clone())
                    .build()
            else {
                continue;
            };
            if let Ok(verified) = pinned.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ) {
                return Some(verified);
            }
        }
        None
    }
}

impl ServerCertVerifier for LocalCaVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        match self.system.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(verified) => Ok(verified),
            Err(system_error) => self
                .verify_with_pin(end_entity, intermediates, server_name, ocsp_response, now)
                .ok_or(system_error),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
