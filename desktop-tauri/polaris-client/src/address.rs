//! The address of a Polaris and the API key used against it, as typed.
//!
//! The Rust twin of `desktop/src/shared/server-address.ts` and
//! `desktop/src/shared/api-key.ts`: the same normalization, the same refusals,
//! in the same words, so both apps answer a typed address the same way.

use std::fmt;
use url::Url;

/// Host suffixes that only ever name a machine on the reader's own network.
const OWN_NETWORK_SUFFIXES: [&str; 5] = [".local", ".lan", ".home.arpa", ".internal", ".localhost"];

const EMPTY: &str = "Enter the address of your Polaris.";
const NOT_AN_ADDRESS: &str = "That is not an address. It looks like https://polaris.example.com.";
const WRONG_SCHEME: &str = "The address starts with https:// (or http:// on your own network).";
const NEEDS_HTTPS: &str =
    "An address on the internet needs https://. http:// works only on your own network.";
const HAS_CREDENTIALS: &str = "Leave the user name and password out of the address.";

/// Why a typed address was refused. `Display` is the sentence shown under the field.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AddressError(String);

/// The origin of a Polaris (`https://polaris.example.com`), the one stored form.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct InstanceUrl(String);

impl InstanceUrl {
    /// Normalizes and checks a typed address: a missing scheme becomes `https://`,
    /// `http://` is only accepted on the reader's own network, and a path, query,
    /// fragment or credentials are refused rather than dropped.
    pub fn parse(raw: &str) -> Result<Self, AddressError> {
        let text = normalize_input(raw);
        if text.is_empty() {
            return Err(AddressError(EMPTY.into()));
        }
        let url = Url::parse(&text).map_err(|_| AddressError(NOT_AN_ADDRESS.into()))?;
        let scheme = url.scheme();
        if scheme != "https" && scheme != "http" {
            return Err(AddressError(WRONG_SCHEME.into()));
        }
        let host = match url.host_str() {
            Some(host) if !host.is_empty() && !text.chars().any(char::is_whitespace) => host,
            _ => return Err(AddressError(NOT_AN_ADDRESS.into())),
        };
        if scheme == "http" && !is_own_network_host(host) {
            return Err(AddressError(NEEDS_HTTPS.into()));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(AddressError(HAS_CREDENTIALS.into()));
        }
        let origin = url.origin().ascii_serialization();
        if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
            return Err(AddressError(format!(
                "Only the address, without a path: {origin}"
            )));
        }
        Ok(Self(origin))
    }

    /// The origin, with no trailing slash.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The host (and port, when it is not the scheme's default), as sentences name it.
    pub fn host(&self) -> &str {
        self.0
            .split_once("://")
            .map_or(self.0.as_str(), |(_, host)| host)
    }

    /// The origin as a URL, for a webview to load.
    pub fn to_url(&self) -> Url {
        Url::parse(&self.0).expect("an InstanceUrl is always a valid origin")
    }
}

impl fmt::Display for InstanceUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Trims the text and adds `https://` when no scheme was typed.
fn normalize_input(raw: &str) -> String {
    let text = raw.trim();
    if text.is_empty() || has_scheme(text) {
        return text.to_owned();
    }
    format!("https://{text}")
}

/// `^[a-z][a-z0-9+.-]*://`, case-insensitive.
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    let mut chars = scheme.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// Whether a host can only be on the reader's own network: a private or loopback
/// address, a single-label name, or one of the local-only suffixes.
pub fn is_own_network_host(hostname: &str) -> bool {
    let lowered = hostname.to_ascii_lowercase();
    let host = lowered.strip_suffix('.').unwrap_or(&lowered);
    if host.starts_with('[') {
        return is_private_ipv6(host);
    }
    if !host.is_empty() && host.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return is_private_ipv4(host);
    }
    !host.contains('.')
        || OWN_NETWORK_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

fn is_private_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 || parts.iter().any(|part| part.is_empty() || part.len() > 3) {
        return false;
    }
    let number = |index: usize| parts[index].parse::<u16>().unwrap_or(u16::MAX);
    let (a, b) = (number(0), number(1));
    a == 10
        || a == 127
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
}

fn is_private_ipv6(host: &str) -> bool {
    let address = host.trim_start_matches('[').trim_end_matches(']');
    let bytes = address.as_bytes();
    let hex = |at: usize| bytes.get(at).is_some_and(u8::is_ascii_hexdigit);
    address == "::1"
        || (bytes.len() > 4
            && bytes[0] == b'f'
            && matches!(bytes[1], b'c' | b'd')
            && hex(2)
            && hex(3)
            && bytes[4] == b':')
        || (bytes.len() > 4
            && bytes[0] == b'f'
            && bytes[1] == b'e'
            && matches!(bytes[2], b'8' | b'9' | b'a' | b'b')
            && hex(3)
            && bytes[4] == b':')
}

/// A Polaris API key (`plk_<8 characters>.<secret>`). `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// Checks the shape only; whether the key is real is for the instance to say.
    pub fn parse(raw: &str) -> Result<Self, AddressError> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(AddressError("Paste an API key.".into()));
        }
        if text.len() > 512 {
            return Err(AddressError("That is longer than any API key.".into()));
        }
        if !has_key_shape(text) {
            return Err(AddressError(
                "An API key looks like plk_... - copy the whole key, as Polaris showed it.".into(),
            ));
        }
        Ok(Self(text.to_owned()))
    }

    pub(crate) fn secret(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(<redacted>)")
    }
}

/// `^plk_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]+$`
fn has_key_shape(text: &str) -> bool {
    let token = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let Some(rest) = text.strip_prefix("plk_") else {
        return false;
    };
    let Some((id, secret)) = rest.split_once('.') else {
        return false;
    };
    id.chars().count() == 8
        && id.chars().all(token)
        && !secret.is_empty()
        && secret.chars().all(token)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(raw: &str) -> String {
        InstanceUrl::parse(raw).unwrap_err().to_string()
    }

    #[test]
    fn adds_https_and_keeps_only_the_origin() {
        assert_eq!(
            InstanceUrl::parse("  polaris.example.com ")
                .unwrap()
                .as_str(),
            "https://polaris.example.com"
        );
        assert_eq!(
            InstanceUrl::parse("https://Polaris.Example.com/")
                .unwrap()
                .as_str(),
            "https://polaris.example.com"
        );
        assert_eq!(
            InstanceUrl::parse("https://polaris.example.com:443")
                .unwrap()
                .as_str(),
            "https://polaris.example.com"
        );
        assert_eq!(
            InstanceUrl::parse("https://polaris.example.com:8443")
                .unwrap()
                .host(),
            "polaris.example.com:8443"
        );
    }

    #[test]
    fn http_only_on_the_own_network() {
        assert_eq!(
            InstanceUrl::parse("http://polaris.local").unwrap().as_str(),
            "http://polaris.local"
        );
        assert_eq!(
            InstanceUrl::parse("http://192.168.1.20:3000")
                .unwrap()
                .as_str(),
            "http://192.168.1.20:3000"
        );
        assert_eq!(
            InstanceUrl::parse("http://[::1]").unwrap().as_str(),
            "http://[::1]"
        );
        assert_eq!(refusal("http://polaris.example.com"), NEEDS_HTTPS);
        assert_eq!(refusal("http://8.8.8.8"), NEEDS_HTTPS);
    }

    #[test]
    fn refuses_what_is_not_an_origin() {
        assert_eq!(refusal("   "), EMPTY);
        assert_eq!(refusal("ftp://polaris.example.com"), WRONG_SCHEME);
        assert_eq!(
            refusal("https://user:pass@polaris.example.com"),
            HAS_CREDENTIALS
        );
        assert_eq!(
            refusal("https://polaris.example.com/apps"),
            "Only the address, without a path: https://polaris.example.com"
        );
        assert_eq!(
            refusal("https://polaris.example.com/?a=1"),
            "Only the address, without a path: https://polaris.example.com"
        );
        assert_eq!(refusal("polaris example.com"), NOT_AN_ADDRESS);
    }

    #[test]
    fn own_network_hosts() {
        for host in [
            "nas",
            "polaris.local",
            "box.home.arpa",
            "10.0.0.1",
            "172.31.0.1",
            "100.64.0.1",
            "[fd12:3456::1]",
            "[fe80::1]",
        ] {
            assert!(is_own_network_host(host), "{host}");
        }
        for host in ["example.com", "172.32.0.1", "8.8.8.8", "[2001:db8::1]"] {
            assert!(!is_own_network_host(host), "{host}");
        }
    }

    #[test]
    fn api_key_shape_and_redaction() {
        let key = ApiKey::parse(" plk_abcd1234.s3cr3t-_ ").unwrap();
        assert_eq!(key.secret(), "plk_abcd1234.s3cr3t-_");
        assert_eq!(format!("{key:?}"), "ApiKey(<redacted>)");
        assert!(ApiKey::parse("plk_short.secret").is_err());
        assert!(ApiKey::parse("plk_abcd1234.").is_err());
        assert!(ApiKey::parse("").is_err());
    }
}
