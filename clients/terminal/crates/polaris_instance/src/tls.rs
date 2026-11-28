//! The TLS side of an alternate address: a client configuration that trusts
//! the system's roots and, on top, the instance's own local CA, and telling a
//! certificate refusal apart from an address that did not answer.

use std::sync::Arc;

use crate::LocalCaVerifier;

/// A client configuration for an alternate that has proven it is the instance:
/// the platform verifier first, then a chain ending in one of `pins`.
pub fn local_ca_client_config(pins: &[String]) -> Result<rustls::ClientConfig, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let system = Arc::new(rustls_platform_verifier::Verifier::new(provider.clone())?);
    Ok(rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(LocalCaVerifier::new(system, pins.to_vec())))
        .with_no_client_auth())
}

/// Whether `error`, or anything it wraps, is a certificate the terminal does not
/// trust (as opposed to an address that did not answer at all).
pub fn is_certificate_failure(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut cause = Some(error);
    while let Some(current) = cause {
        if is_certificate_error(current) {
            return true;
        }
        if let Some(io) = current.downcast_ref::<std::io::Error>()
            && io
                .get_ref()
                .is_some_and(|inner| is_certificate_error(inner))
        {
            return true;
        }
        cause = current.source();
    }
    false
}

fn is_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    matches!(
        error.downcast_ref::<rustls::Error>(),
        Some(rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented)
    )
}
