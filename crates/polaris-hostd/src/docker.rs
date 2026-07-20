//! Allowlisted Docker Engine API proxy.
//!
//! The web container is deliberately never given the Docker socket: it is
//! root-equivalent on the host. Instead the container asks this daemon to
//! perform a small, fixed set of read and lifecycle operations, and the daemon
//! forwards only those to the socket. Even a fully compromised web container can
//! therefore reach nothing beyond listing/inspecting containers and
//! starting/stopping/restarting them - never `create`, `exec`, image pulls, or
//! arbitrary bind-mounted runs.
//!
//! The request the container sends is a JSON envelope `{ method, path }` rather
//! than the docker path in the URL, so the query string survives hostd's parser
//! and every value is validated here before it is spliced into an HTTP request
//! line bound for the socket.

use std::io;
use std::path::Path;
use std::time::Duration;

/// Upper bound on a forwarded Docker response we buffer. The allowlisted
/// endpoints (ping, info, a container list, one stats sample) are small; this
/// only refuses a pathological or hostile response from exhausting memory.
#[cfg_attr(not(unix), allow(dead_code))]
const MAX_DOCKER_RESPONSE: u64 = 32 * 1024 * 1024;

/// Read/write timeout for the socket round-trip, so a stuck daemon cannot pin a
/// request thread forever.
#[cfg_attr(not(unix), allow(dead_code))]
const DOCKER_TIMEOUT: Duration = Duration::from_secs(30);

/// The result of a validated allowlist match: the concrete Docker API path to
/// forward (already checked to be smuggling-safe). Fields are read only by the
/// unix `forward`, hence unused on the non-unix dev shim.
#[cfg_attr(not(unix), allow(dead_code))]
pub struct AllowedRequest<'a> {
    pub method: &'a str,
    pub path: &'a str,
}

/// Validate a proxy request against the allowlist. Returns `Ok` only for the
/// exact (method, path-shape) pairs the Containers app needs; everything else
/// is refused. Rejects any non-printable or whitespace byte first, which alone
/// defeats CRLF request-smuggling into the socket, then matches the route shape
/// and validates any `{id}` segment against the Docker id/name charset.
pub fn validate<'a>(method: &'a str, path: &'a str) -> Result<AllowedRequest<'a>, &'static str> {
    // Only printable ASCII, no spaces: blocks CR/LF (header injection) and any
    // control byte before the value ever reaches the request line.
    if path.is_empty() || !path.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("path must be printable ASCII with no spaces");
    }
    if !path.starts_with('/') {
        return Err("path must be absolute");
    }

    // Split the route from its query string; the route decides the allowlist,
    // the query is only length- and charset-bounded (already printable above).
    let route = path.split('?').next().unwrap_or("");
    let segments: Vec<&str> = route[1..].split('/').collect();

    let allowed = match (method, segments.as_slice()) {
        ("GET", ["_ping"]) => true,
        ("GET", ["info"]) => true,
        ("GET", ["version"]) => true,
        ("GET", ["containers", "json"]) => true,
        ("GET", ["containers", id, "stats"]) => valid_container_id(id),
        ("POST", ["containers", id, "start"]) => valid_container_id(id),
        ("POST", ["containers", id, "stop"]) => valid_container_id(id),
        ("POST", ["containers", id, "restart"]) => valid_container_id(id),
        _ => false,
    };
    if !allowed {
        return Err("operation not permitted by the docker proxy allowlist");
    }
    if path.len() > 512 {
        return Err("path too long");
    }
    Ok(AllowedRequest { method, path })
}

/// Docker container ids and names: start alphanumeric, then `[A-Za-z0-9_.-]`.
/// This is stricter than Docker itself but covers every real id/name and keeps
/// a path segment free of separators or traversal.
fn valid_container_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    id.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// Forward one already-validated request to the Docker socket and return the
/// response status and body. One request per connection (`Connection: close`),
/// so the body is read to EOF. Unix-only: the socket is a Unix domain socket.
#[cfg(unix)]
pub fn forward(socket: &Path, request: &AllowedRequest) -> io::Result<(u16, Vec<u8>)> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(DOCKER_TIMEOUT))?;
    stream.set_write_timeout(Some(DOCKER_TIMEOUT))?;

    // No request body is ever forwarded: the allowlisted endpoints take none.
    let head = format!(
        "{} {} HTTP/1.1\r\nHost: docker\r\nConnection: close\r\nAccept: application/json\r\n\r\n",
        request.method, request.path
    );
    stream.write_all(head.as_bytes())?;
    stream.flush()?;

    let mut raw = Vec::new();
    stream.take(MAX_DOCKER_RESPONSE).read_to_end(&mut raw)?;
    parse_response(&raw)
}

#[cfg(not(unix))]
pub fn forward(_socket: &Path, _request: &AllowedRequest) -> io::Result<(u16, Vec<u8>)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "docker proxy is only supported on unix hosts",
    ))
}

/// Parse a buffered HTTP/1.1 response into its status code and decoded body,
/// decoding chunked transfer-encoding when present. Treated as untrusted input:
/// a malformed response yields an error rather than a panic. Called by the unix
/// `forward` and the tests; unused on the non-unix bin build.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_response(raw: &[u8]) -> io::Result<(u16, Vec<u8>)> {
    let split = find_headers_end(raw)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no header terminator"))?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let mut lines = head.split("\r\n");

    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no status code"))?;

    let mut chunked = false;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
            {
                chunked = true;
            }
        }
    }

    let body = &raw[split + 4..];
    let body = if chunked {
        decode_chunked(body)
    } else {
        body.to_vec()
    };
    Ok((status, body))
}

/// Offset of the `\r\n\r\n` that ends the header block, if present.
fn find_headers_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Decode HTTP chunked transfer-encoding into the raw body bytes. Stops at the
/// terminating zero-size chunk or when the input is exhausted/malformed.
fn decode_chunked(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset = 0;
    while offset < input.len() {
        let line_end = match find_crlf(&input[offset..]) {
            Some(pos) => offset + pos,
            None => break,
        };
        let size_str = String::from_utf8_lossy(&input[offset..line_end]);
        let size = match usize::from_str_radix(size_str.trim(), 16) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        let start = line_end + 2;
        let end = start + size;
        if end > input.len() {
            break;
        }
        out.extend_from_slice(&input[start..end]);
        offset = end + 2; // skip the chunk's trailing CRLF
    }
    out
}

fn find_crlf(input: &[u8]) -> Option<usize> {
    input.windows(2).position(|w| w == b"\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_accepts_expected_operations() {
        assert!(validate("GET", "/_ping").is_ok());
        assert!(validate("GET", "/info").is_ok());
        assert!(validate("GET", "/version").is_ok());
        assert!(validate("GET", "/containers/json?all=1").is_ok());
        assert!(validate("GET", "/containers/abc123/stats?stream=false").is_ok());
        assert!(validate("POST", "/containers/abc123/start").is_ok());
        assert!(validate("POST", "/containers/web.1/stop").is_ok());
        assert!(validate("POST", "/containers/a-b_c/restart").is_ok());
    }

    #[test]
    fn allowlist_refuses_everything_else() {
        // Dangerous or simply out-of-scope docker operations.
        assert!(validate("POST", "/containers/create").is_err());
        assert!(validate("POST", "/containers/abc/exec").is_err());
        assert!(validate("GET", "/images/json").is_err());
        assert!(validate("POST", "/images/create?fromImage=x").is_err());
        assert!(validate("DELETE", "/containers/abc").is_err());
        assert!(validate("GET", "/containers/abc/logs").is_err());
        // Method must match the route.
        assert!(validate("GET", "/containers/abc/start").is_err());
        assert!(validate("POST", "/info").is_err());
    }

    #[test]
    fn allowlist_blocks_smuggling_and_traversal() {
        // CRLF and spaces are refused outright (header injection into the socket).
        assert!(validate("GET", "/info\r\nX: y").is_err());
        assert!(validate("GET", "/containers/json all=1").is_err());
        // Traversal / separators in the id segment.
        assert!(validate("POST", "/containers/../secret/start").is_err());
        assert!(validate("GET", "/containers//stats").is_err());
        assert!(validate("POST", "/containers/a b/start").is_err());
        // Relative path is refused.
        assert!(validate("GET", "info").is_err());
    }

    #[test]
    fn parse_response_plain_body() {
        let raw =
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
        let (status, body) = parse_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"{}");
    }

    #[test]
    fn parse_response_chunked_body() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n[{}]\r\n0\r\n\r\n";
        let (status, body) = parse_response(raw).unwrap();
        assert_eq!(status, 200);
        assert_eq!(body, b"[{}]");
    }

    #[test]
    fn parse_response_rejects_malformed() {
        assert!(parse_response(b"garbage-without-terminator").is_err());
        assert!(parse_response(b"HTTP/1.1\r\n\r\n").is_err());
    }
}
