//! Minimal client for the on-box UniFi Drive API (`127.0.0.1:16080`).
//!
//! A hand-rolled HTTP/1.1 client over `TcpStream` avoids pulling a full HTTP
//! stack into the static binary. Only localhost GETs are needed; the Home
//! Assistant side owns the write/backup endpoints over SSH.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::Value;

use crate::util::log;

const API_HOST: &str = "127.0.0.1";
const API_PORT: u16 = 16080;
const USERS_CACHE: &str = "/data/unifi-core/config/cache/users.json";

pub struct ApiClient {
    admin_uid: Option<String>,
    warned: bool,
}

impl ApiClient {
    pub fn new() -> Self {
        Self {
            admin_uid: None,
            warned: false,
        }
    }

    fn admin_uid(&mut self) -> Option<String> {
        if let Some(uid) = &self.admin_uid {
            return Some(uid.clone());
        }
        let raw = std::fs::read_to_string(USERS_CACHE).ok()?;
        let users: Value = serde_json::from_str(&raw).ok()?;
        let uid = users.get(0)?.get("id")?.as_str()?.to_string();
        self.admin_uid = Some(uid.clone());
        Some(uid)
    }

    /// GET a JSON document. `need_auth` adds the admin identity headers the
    /// Drive API requires for user/share endpoints. Returns `None` on any
    /// failure, warning at most once to avoid log spam.
    pub fn get(&mut self, path: &str, need_auth: bool) -> Option<Value> {
        let mut headers: Vec<(String, String)> = Vec::new();
        if need_auth {
            match self.admin_uid() {
                Some(uid) => {
                    headers.push(("X-UserId".into(), uid));
                    headers.push(("X-UserRole".into(), "admin".into()));
                }
                None => {
                    self.warn_once("Cannot determine admin user id for Drive API auth");
                    return None;
                }
            }
        }
        match http_get(path, &headers) {
            Ok(Some(v)) => Some(v),
            Ok(None) => None,
            Err(e) => {
                self.warn_once(&format!("Drive API unavailable ({e}), falling back"));
                None
            }
        }
    }

    fn warn_once(&mut self, msg: &str) {
        if !self.warned {
            log(format!("WARNING: {msg}"));
            self.warned = true;
        }
    }
}

/// Perform the GET and parse the body as JSON. `Ok(None)` means a non-200
/// status or an empty/unparseable body; `Err` means a transport failure.
fn http_get(path: &str, headers: &[(String, String)]) -> Result<Option<Value>, String> {
    let mut stream = TcpStream::connect((API_HOST, API_PORT)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok();

    let mut req = format!("GET {path} HTTP/1.1\r\nHost: {API_HOST}\r\nConnection: close\r\n");
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 4 * 1024 * 1024 {
                    break; // safety cap
                }
            }
            Err(_) => break, // timeout or reset: use what we have
        }
    }

    let split = buf.windows(4).position(|w| w == b"\r\n\r\n");
    let Some(idx) = split else {
        return Ok(None);
    };
    let head = &buf[..idx];
    let body = &buf[idx + 4..];

    let status_ok = head
        .split(|&b| b == b'\n')
        .next()
        .and_then(|line| std::str::from_utf8(line).ok())
        .map(|line| line.contains(" 200"))
        .unwrap_or(false);
    if !status_ok {
        return Ok(None);
    }

    Ok(serde_json::from_slice::<Value>(body).ok())
}
