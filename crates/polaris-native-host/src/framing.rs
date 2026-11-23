//! The native messaging wire format: a 32-bit length in the machine's own byte
//! order, then that many bytes of UTF-8 JSON. Chrome and Firefox both use it on
//! stdin and stdout, and the desktop app's socket speaks it too, so one reader
//! and one writer serve both sides.
//!
//! Every target this ships for is little-endian, so "native order" is written
//! as little-endian explicitly and a big-endian build refuses to compile.

use std::io::{self, Read, Write};

#[cfg(not(target_endian = "little"))]
compile_error!("the native messaging length prefix is read as little-endian");

/// The most a browser accepts from a host in one message (Chrome's documented cap).
pub const HOST_TO_BROWSER_MAX: usize = 1024 * 1024;

/// The most this host reads in one message from the browser or the desktop. A
/// pairing message is a few hundred bytes; `NATIVE_MESSAGE_MAX_BYTES` in
/// `@polaris/core` is the same number.
pub const INBOUND_MAX: usize = 4096;

#[derive(Debug)]
pub enum FrameError {
    /// The stream ended inside a length prefix or a body.
    Truncated,
    /// A length above the cap; nothing past the prefix was read.
    TooLarge(usize),
    /// The body is not JSON.
    BadJson,
    Io(io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Truncated => write!(f, "the message ended early"),
            Self::TooLarge(n) => write!(f, "a message of {n} bytes is over the limit"),
            Self::BadJson => write!(f, "the message is not JSON"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

/// Fill `buf` completely, across as many short reads as the stream gives.
/// `Ok(false)` when the stream ended before the first byte.
fn read_full<R: Read>(reader: &mut R, buf: &mut [u8]) -> Result<bool, FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(true)
}

/// One message, or `None` when the stream closed cleanly before it began.
pub fn read_message<R: Read>(
    reader: &mut R,
    max: usize,
) -> Result<Option<serde_json::Value>, FrameError> {
    let mut prefix = [0u8; 4];
    if !read_full(reader, &mut prefix)? {
        return Ok(None);
    }
    let len = u32::from_le_bytes(prefix) as usize;
    if len > max {
        return Err(FrameError::TooLarge(len));
    }
    let mut body = vec![0u8; len];
    if len > 0 && !read_full(reader, &mut body)? {
        return Err(FrameError::Truncated);
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| FrameError::BadJson)
}

/// Write one message, refusing one over `max` before a byte is written.
pub fn write_message<W: Write>(
    writer: &mut W,
    value: &serde_json::Value,
    max: usize,
) -> Result<(), FrameError> {
    let body = serde_json::to_vec(value).map_err(|_| FrameError::BadJson)?;
    if body.len() > max {
        return Err(FrameError::TooLarge(body.len()));
    }
    let len = u32::try_from(body.len()).map_err(|_| FrameError::TooLarge(body.len()))?;
    writer
        .write_all(&len.to_le_bytes())
        .and_then(|()| writer.write_all(&body))
        .and_then(|()| writer.flush())
        .map_err(FrameError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A reader that hands out at most `step` bytes per call.
    struct Trickle {
        data: Vec<u8>,
        at: usize,
        step: usize,
    }

    impl Read for Trickle {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.step.min(buf.len()).min(self.data.len() - self.at);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn reads_a_message_split_across_one_byte_reads() {
        let data = framed(br#"{"type":"pair","nonce":"x"}"#);
        let mut reader = Trickle {
            data,
            at: 0,
            step: 1,
        };
        let value = read_message(&mut reader, INBOUND_MAX).unwrap().unwrap();
        assert_eq!(value, json!({"type": "pair", "nonce": "x"}));
    }

    #[test]
    fn a_clean_close_before_a_message_is_none() {
        let mut reader: &[u8] = &[];
        assert!(read_message(&mut reader, INBOUND_MAX).unwrap().is_none());
    }

    #[test]
    fn a_close_inside_the_prefix_or_body_is_truncated() {
        let mut short_prefix: &[u8] = &[5, 0];
        assert!(matches!(
            read_message(&mut short_prefix, INBOUND_MAX),
            Err(FrameError::Truncated)
        ));
        let data = framed(b"{\"a\":1}");
        let mut short_body: &[u8] = &data[..data.len() - 2];
        assert!(matches!(
            read_message(&mut short_body, INBOUND_MAX),
            Err(FrameError::Truncated)
        ));
    }

    #[test]
    fn an_oversize_length_is_refused_without_reading_the_body() {
        let mut data = ((INBOUND_MAX + 1) as u32).to_le_bytes().to_vec();
        data.extend_from_slice(b"rest");
        let mut reader: &[u8] = &data;
        assert!(
            matches!(read_message(&mut reader, INBOUND_MAX), Err(FrameError::TooLarge(n)) if n == INBOUND_MAX + 1)
        );
        assert_eq!(reader, b"rest");
    }

    #[test]
    fn a_body_that_is_not_json_is_bad_json() {
        let data = framed(b"{not json");
        let mut reader: &[u8] = &data;
        assert!(matches!(
            read_message(&mut reader, INBOUND_MAX),
            Err(FrameError::BadJson)
        ));
        let empty = framed(b"");
        let mut reader: &[u8] = &empty;
        assert!(matches!(
            read_message(&mut reader, INBOUND_MAX),
            Err(FrameError::BadJson)
        ));
    }

    #[test]
    fn writes_the_length_then_the_body() {
        let mut out = Vec::new();
        write_message(&mut out, &json!({"ok": true}), HOST_TO_BROWSER_MAX).unwrap();
        assert_eq!(out, framed(br#"{"ok":true}"#));
        let mut back: &[u8] = &out;
        assert_eq!(
            read_message(&mut back, INBOUND_MAX).unwrap().unwrap(),
            json!({"ok": true})
        );
    }

    #[test]
    fn refuses_to_write_over_the_cap() {
        let mut out = Vec::new();
        let big = json!({"x": "a".repeat(64)});
        assert!(matches!(
            write_message(&mut out, &big, 16),
            Err(FrameError::TooLarge(_))
        ));
        assert!(out.is_empty());
    }
}
