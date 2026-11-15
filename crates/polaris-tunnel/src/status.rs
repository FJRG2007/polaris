//! The status endpoint `--info` serves: `/metrics` with the device's state as
//! `key=value` lines (the fields `wg show <iface> dump` prints), and `/readyz`.

use std::fmt::Write as _;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

use crate::engine::Status;

/// The device state, without the private key: nothing that reads this needs it.
pub fn render_metrics(status: &Status) -> String {
    let mut out = String::new();
    let c = &status.counters;
    let _ = writeln!(out, "listen_port={}", status.listen_port);
    let _ = writeln!(out, "polaris_udp_sessions={}", c.udp_sessions);
    let _ = writeln!(out, "polaris_tcp_connections={}", c.tcp_connections);
    let _ = writeln!(out, "polaris_handshakes={}", c.handshakes);
    let _ = writeln!(out, "polaris_dropped_full={}", c.dropped_full);
    let _ = writeln!(out, "polaris_dropped_malformed={}", c.dropped_malformed);
    let _ = writeln!(out, "polaris_fragmented_out={}", c.fragmented_out);
    let _ = writeln!(out, "polaris_reassembled_in={}", c.reassembled_in);
    let _ = writeln!(out, "polaris_dropped_unrouted={}", c.dropped_unrouted);
    let _ = writeln!(out, "polaris_rejected_wire={}", c.rejected_wire);
    let hex: String = status
        .public_key
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let _ = writeln!(out, "public_key={hex}");
    if let Some(endpoint) = status.endpoint {
        let _ = writeln!(out, "endpoint={endpoint}");
    }
    let since = status
        .last_handshake
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .unwrap_or(Duration::ZERO);
    let _ = writeln!(out, "last_handshake_time_sec={}", since.as_secs());
    let _ = writeln!(out, "last_handshake_time_nsec={}", since.subsec_nanos());
    let _ = writeln!(out, "tx_bytes={}", status.tx_bytes);
    let _ = writeln!(out, "rx_bytes={}", status.rx_bytes);
    let _ = writeln!(out, "persistent_keepalive_interval={}", status.keepalive);
    for ip in &status.allowed_ips {
        let _ = writeln!(out, "allowed_ip={ip}");
    }
    out
}

/// The answer to one request: status code, content type and body.
pub fn respond(request: &[u8], status: &Status) -> (u16, &'static str, String) {
    let line = request.split(|&b| b == b'\n').next().unwrap_or_default();
    let line = String::from_utf8_lossy(line);
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method != "GET" && method != "HEAD" {
        return (405, "text/plain", "method not allowed\n".into());
    }
    match path.split('?').next().unwrap_or("") {
        "/metrics" => (200, "text/plain", render_metrics(status)),
        // No liveness addresses are configured, so every one of them answered.
        "/readyz" => (200, "application/json", "{}".into()),
        _ => (404, "text/plain", "not found\n".into()),
    }
}

/// Serve the endpoint until the task is dropped. Requests are small and
/// answered at once; a slow or oversized one is cut off.
pub async fn serve(listener: TcpListener, status: Arc<Mutex<Status>>) {
    let slots = Arc::new(Semaphore::new(16));
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let status = status.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(3), answer(stream, status)).await;
            drop(permit);
        });
    }
}

async fn answer(mut stream: TcpStream, status: Arc<Mutex<Status>>) -> std::io::Result<()> {
    let mut buf = vec![0u8; 4096];
    let mut len = 0;
    while len < buf.len() {
        let n = stream.read(&mut buf[len..]).await?;
        if n == 0 {
            break;
        }
        len += n;
        if buf[..len].windows(4).any(|w| w == b"\r\n\r\n")
            || buf[..len].windows(2).any(|w| w == b"\n\n")
        {
            break;
        }
    }
    let snapshot = status.lock().map(|s| s.clone()).unwrap_or_default();
    let (code, kind, body) = respond(&buf[..len], &snapshot);
    let reason = match code {
        200 => "OK",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

/// Bind the endpoint's listener.
pub async fn bind(addr: SocketAddr) -> std::io::Result<TcpListener> {
    TcpListener::bind(addr).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_lines() {
        let status = Status {
            listen_port: 51820,
            public_key: [0xab; 32],
            endpoint: Some("1.2.3.4:5".parse().unwrap()),
            last_handshake: Some(SystemTime::UNIX_EPOCH + Duration::new(1_700_000_000, 500)),
            rx_bytes: 10,
            tx_bytes: 20,
            keepalive: 25,
            allowed_ips: vec!["10.0.0.2/32".into()],
            ..Default::default()
        };
        let text = render_metrics(&status);
        assert!(text.contains(&format!("public_key={}\n", "ab".repeat(32))));
        for line in [
            "endpoint=1.2.3.4:5",
            "last_handshake_time_sec=1700000000",
            "last_handshake_time_nsec=500",
            "rx_bytes=10",
            "tx_bytes=20",
            "persistent_keepalive_interval=25",
            "allowed_ip=10.0.0.2/32",
            "listen_port=51820",
        ] {
            assert!(text.contains(line), "{line}");
        }
        assert!(!text.contains("private_key"));
        let fresh = render_metrics(&Status::default());
        assert!(fresh.contains("last_handshake_time_sec=0\n"));
        assert!(!fresh.contains("endpoint="));
    }

    #[test]
    fn routes() {
        let s = Status::default();
        assert_eq!(respond(b"GET /metrics HTTP/1.1\r\n\r\n", &s).0, 200);
        assert_eq!(
            respond(b"GET /readyz HTTP/1.1\r\n\r\n", &s),
            (200, "application/json", "{}".into())
        );
        assert_eq!(respond(b"GET /metrics?x=1 HTTP/1.0\r\n", &s).0, 200);
        assert_eq!(respond(b"GET /nope HTTP/1.1\r\n", &s).0, 404);
        assert_eq!(respond(b"POST /metrics HTTP/1.1\r\n", &s).0, 405);
        assert_eq!(respond(b"", &s).0, 405);
        assert_eq!(respond(&[0xff, 0xfe], &s).0, 405);
    }

    proptest::proptest! {
        #[test]
        fn any_request_is_answered(bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..512)) {
            let _ = respond(&bytes, &Status::default());
        }
    }
}
