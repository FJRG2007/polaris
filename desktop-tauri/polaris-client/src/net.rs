//! Why a Polaris could not be reached, in words.
//!
//! The Rust twin of `describeNetError` in `desktop/src/main/reachability.ts`.
//! Chromium names a failure with a code (`ERR_NAME_NOT_RESOLVED`); reqwest gives
//! an error chain instead, so the chain is sorted into the same kinds and each
//! kind keeps the Electron app's sentence.

use std::error::Error as StdError;
use std::io;

/// What kind of failure stopped a request before Polaris answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetFailure {
    /// The name does not resolve (`ERR_NAME_NOT_RESOLVED`).
    NameNotResolved,
    /// Nothing listens there, or the connection was dropped (`ERR_CONNECTION_REFUSED`).
    Refused,
    /// No answer in time, or no route to it (`ERR_TIMED_OUT`, `ERR_ADDRESS_UNREACHABLE`).
    TimedOut,
    /// The certificate is not trusted by this computer (`ERR_CERT_*`).
    Certificate,
    /// Anything else.
    Other,
}

impl NetFailure {
    /// Sorts a reqwest error by walking its source chain.
    ///
    /// reqwest has no typed DNS or TLS error, so those two are recognized by the
    /// wording hyper-util and rustls put in their messages; anything not
    /// recognized falls back to the generic sentence rather than a wrong one.
    pub fn classify(error: &reqwest::Error) -> Self {
        if error.is_timeout() {
            return Self::TimedOut;
        }
        let mut source: Option<&(dyn StdError + 'static)> = Some(error);
        while let Some(current) = source {
            if let Some(io_error) = current.downcast_ref::<io::Error>() {
                match io_error.kind() {
                    io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted => {
                        return Self::Refused;
                    }
                    io::ErrorKind::TimedOut
                    | io::ErrorKind::HostUnreachable
                    | io::ErrorKind::NetworkUnreachable => {
                        return Self::TimedOut;
                    }
                    _ => {}
                }
            }
            let text = current.to_string().to_ascii_lowercase();
            if text.contains("dns error")
                || text.contains("failed to lookup address")
                || text.contains("no such host")
            {
                return Self::NameNotResolved;
            }
            if text.contains("certificate") || text.contains("unknownissuer") {
                return Self::Certificate;
            }
            source = current.source();
        }
        Self::Other
    }

    /// The sentence the Electron app shows for the same failure.
    pub fn describe(self, host: &str) -> String {
        match self {
            Self::NameNotResolved => format!("{host} does not resolve to a server. Check the address for a typo."),
            Self::Refused => format!("Nothing is answering at {host}. The server may be down or restarting."),
            Self::TimedOut => format!("{host} did not answer in time. It may be off, or only reachable from another network."),
            Self::Certificate => format!(
                "The certificate of {host} is not trusted by this computer. Use an address of your Polaris that has a trusted certificate."
            ),
            Self::Other => format!("Could not reach {host}."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentences_match_the_electron_app() {
        let host = "polaris.example.com";
        assert_eq!(
            NetFailure::NameNotResolved.describe(host),
            "polaris.example.com does not resolve to a server. Check the address for a typo."
        );
        assert_eq!(
            NetFailure::Refused.describe(host),
            "Nothing is answering at polaris.example.com. The server may be down or restarting."
        );
        assert_eq!(
            NetFailure::Other.describe(host),
            "Could not reach polaris.example.com."
        );
    }
}
