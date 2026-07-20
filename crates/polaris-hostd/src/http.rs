//! Minimal hand-rolled HTTP/1.1 for the hostd API.
//!
//! A full HTTP stack (hyper/axum) is deliberately avoided to keep the static
//! musl binary small and its dependency surface auditable. Only what the API
//! needs is implemented: one request per connection (`Connection: close`),
//! header parsing, a percent-decoded target, `Range` support, and a response
//! whose body may be either an in-memory buffer or a streamed file.

use std::fs::File;
use std::io::{self, BufRead, Read, Seek, SeekFrom, Write};

/// Maximum size of the request head (request line + headers). Bounds the memory
/// a single connection can force us to buffer before auth is even checked.
const MAX_HEAD_BYTES: usize = 64 * 1024;

pub struct Request {
    pub method: String,
    /// Percent-decoded path, e.g. `/v1/fs/etc/hosts`. Query string stripped.
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub content_length: u64,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Extract the bearer token from the `Authorization` header, if present.
    pub fn bearer_token(&self) -> Option<&str> {
        self.header("authorization")
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::trim)
    }
}

/// Read and parse the request head from `reader`. Returns `Ok(None)` on a clean
/// EOF (client closed without sending anything).
pub fn read_request<R: BufRead>(reader: &mut R) -> io::Result<Option<Request>> {
    let mut head = Vec::new();
    // Read byte-by-byte until the blank line; a bounded, streaming parse avoids
    // pulling an unbounded body into the head buffer.
    let mut last4 = [0u8; 4];
    loop {
        let mut byte = [0u8; 1];
        match reader.read(&mut byte)? {
            0 => {
                if head.is_empty() {
                    return Ok(None);
                }
                break;
            }
            _ => {
                head.push(byte[0]);
                last4.rotate_left(1);
                last4[3] = byte[0];
                if head.len() >= 4 && last4 == *b"\r\n\r\n" {
                    break;
                }
                if head.len() > MAX_HEAD_BYTES {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "request head too large",
                    ));
                }
            }
        }
    }

    let text = String::from_utf8_lossy(&head);
    let mut lines = text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let raw_target = parts.next().unwrap_or("");

    let path = percent_decode(raw_target.split('?').next().unwrap_or(""));

    let mut headers = Vec::new();
    let mut content_length = 0u64;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim().to_string();
            let value = v.trim().to_string();
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap_or(0);
            }
            headers.push((key, value));
        }
    }

    Ok(Some(Request {
        method,
        path,
        headers,
        content_length,
    }))
}

/// Percent-decode a URL path segment. Invalid escapes are left verbatim rather
/// than erroring; the path allowlist is the real gate, this is only decoding.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A parsed `Range: bytes=start-end` header (single range only).
pub struct ByteRange {
    pub start: u64,
    /// Inclusive end, if the client bounded it.
    pub end: Option<u64>,
}

/// Parse a single-range `Range` header value. Returns `None` if absent or not a
/// form we support (multi-ranges and suffix ranges are declined, not errored).
pub fn parse_range(value: &str) -> Option<ByteRange> {
    let spec = value.trim().strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    let end = end.trim();
    let end = if end.is_empty() {
        None
    } else {
        Some(end.parse().ok()?)
    };
    Some(ByteRange { start, end })
}

/// Response body: an in-memory buffer, a file seeked to the start offset (of
/// which exactly `len` bytes are sent), or an open-ended reader streamed to the
/// client until EOF. A `Stream` body has no known length, so it is framed by
/// connection close (no `Content-Length`) - used for live build/deploy/log output
/// whose size is not known up front.
pub enum Body {
    Bytes(Vec<u8>),
    File { file: File, len: u64 },
    Stream(Box<dyn Read + Send>),
}

pub struct Response {
    pub status: u16,
    pub reason: &'static str,
    pub headers: Vec<(String, String)>,
    pub body: Body,
}

impl Response {
    fn new(status: u16, reason: &'static str, body: Body) -> Self {
        Self {
            status,
            reason,
            headers: Vec::new(),
            body,
        }
    }

    pub fn with_header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.push((key.to_string(), value.into()));
        self
    }

    pub fn json(status: u16, reason: &'static str, value: &serde_json::Value) -> Self {
        let body = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
        Self::new(status, reason, Body::Bytes(body)).with_header("Content-Type", "application/json")
    }

    /// A plain-text response. Used for errors and stubs; messages must be safe
    /// (never echo internal error detail) so nothing leaks to the client.
    pub fn text(status: u16, reason: &'static str, msg: &str) -> Self {
        Self::new(status, reason, Body::Bytes(msg.as_bytes().to_vec()))
            .with_header("Content-Type", "text/plain; charset=utf-8")
    }

    pub fn empty(status: u16, reason: &'static str) -> Self {
        Self::new(status, reason, Body::Bytes(Vec::new()))
    }

    pub fn file(status: u16, reason: &'static str, file: File, len: u64) -> Self {
        Self::new(status, reason, Body::File { file, len })
    }

    /// A response whose body is streamed from `reader` until EOF, framed by
    /// connection close. The client reads to the end of the connection.
    pub fn stream(status: u16, reason: &'static str, reader: Box<dyn Read + Send>) -> Self {
        Self::new(status, reason, Body::Stream(reader))
    }

    // Common error shapes with safe, generic messages.
    pub fn bad_request(msg: &str) -> Self {
        Response::text(400, "Bad Request", msg)
    }
    pub fn unauthorized() -> Self {
        Response::text(401, "Unauthorized", "missing or invalid bearer token")
            .with_header("WWW-Authenticate", "Bearer")
    }
    pub fn forbidden(msg: &str) -> Self {
        Response::text(403, "Forbidden", msg)
    }
    pub fn not_found() -> Self {
        Response::text(404, "Not Found", "no such route")
    }
    pub fn not_implemented(msg: &str) -> Self {
        Response::text(501, "Not Implemented", msg)
    }
    pub fn server_error() -> Self {
        Response::text(500, "Internal Server Error", "internal error")
    }

    /// Write the full response to `w`, streaming a file or open-ended body in
    /// chunks. A `Stream` body omits `Content-Length` (its size is unknown) and
    /// relies on `Connection: close` to frame the end.
    pub fn write_to<W: Write>(mut self, w: &mut W) -> io::Result<()> {
        let content_length = match &self.body {
            Body::Bytes(b) => Some(b.len() as u64),
            Body::File { len, .. } => Some(*len),
            Body::Stream(_) => None,
        };
        let mut head = format!("HTTP/1.1 {} {}\r\n", self.status, self.reason);
        if let Some(len) = content_length {
            head.push_str(&format!("Content-Length: {len}\r\n"));
        }
        head.push_str("Connection: close\r\n");
        for (k, v) in &self.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        w.write_all(head.as_bytes())?;

        match &mut self.body {
            Body::Bytes(b) => w.write_all(b)?,
            Body::File { file, len } => {
                let mut remaining = *len;
                let mut buf = [0u8; 64 * 1024];
                while remaining > 0 {
                    let want = remaining.min(buf.len() as u64) as usize;
                    let n = file.read(&mut buf[..want])?;
                    if n == 0 {
                        break;
                    }
                    w.write_all(&buf[..n])?;
                    remaining -= n as u64;
                }
            }
            Body::Stream(reader) => {
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = reader.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    w.write_all(&buf[..n])?;
                    // Flush each chunk so the client sees output as it is produced
                    // (live build/deploy logs), not only at the end.
                    w.flush()?;
                }
            }
        }
        w.flush()
    }
}

/// Open `path` for a ranged read, seeking to `range.start` and returning the
/// prepared file plus the number of bytes to send and the total file size.
pub fn open_ranged(path: &std::path::Path, range: &ByteRange) -> io::Result<(File, u64, u64)> {
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    let start = range.start.min(total);
    let end = match range.end {
        Some(e) => e.min(total.saturating_sub(1)),
        None => total.saturating_sub(1),
    };
    let len = if total == 0 || end < start {
        0
    } else {
        end - start + 1
    };
    file.seek(SeekFrom::Start(start))?;
    Ok((file, len, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("etc/hosts"), "etc/hosts");
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%2e%2e/x"), "../x");
        // Malformed escapes pass through untouched.
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }

    #[test]
    fn parse_range_forms() {
        let r = parse_range("bytes=0-99").unwrap();
        assert_eq!(r.start, 0);
        assert_eq!(r.end, Some(99));
        let r = parse_range("bytes=100-").unwrap();
        assert_eq!(r.start, 100);
        assert_eq!(r.end, None);
        assert!(parse_range("bytes=0-1,2-3").is_none());
        assert!(parse_range("items=0-1").is_none());
    }

    #[test]
    fn read_request_parses_head() {
        let raw = b"PUT /v1/fs/a%20b HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nAuthorization: Bearer abc\r\n\r\nhello";
        let mut cursor = std::io::Cursor::new(&raw[..]);
        let req = read_request(&mut cursor).unwrap().unwrap();
        assert_eq!(req.method, "PUT");
        assert_eq!(req.path, "/v1/fs/a b");
        assert_eq!(req.content_length, 5);
        assert_eq!(req.bearer_token(), Some("abc"));
        // The body remains available on the reader for streaming.
        let mut rest = Vec::new();
        cursor.read_to_end(&mut rest).unwrap();
        assert_eq!(rest, b"hello");
    }
}
