//! The real binary as the container runs it: flags, config loading, the status
//! endpoint `--info` serves, `--configtest`, and shutdown.

mod common;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use common::*;

const BIN: &str = env!("CARGO_BIN_EXE_polaris-tunnel");

fn scratch(name: &str, text: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("polaris-tunnel-process-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, text).unwrap();
    path
}

fn free_tcp_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn free_udp() -> u16 {
    UdpSocket::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn relay_file(name: &str, listen: u16) -> PathBuf {
    let text = relay_config(listen, "127.0.0.1:1".parse().unwrap(), &Options::default());
    scratch(name, &text)
}

fn get(addr: SocketAddr, path: &str) -> Option<String> {
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").ok()?;
    let mut text = String::new();
    s.read_to_string(&mut text).ok()?;
    Some(text)
}

fn hex(b64: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .unwrap()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The running daemon, killed if a failed assertion leaves it behind.
struct Daemon(Option<Child>);

impl Drop for Daemon {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Stop the daemon the way the container runtime does, and wait for it.
fn stop(mut daemon: Daemon) -> ExitStatus {
    let mut child = daemon.0.take().unwrap();
    #[cfg(unix)]
    {
        let sent = Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status()
            .unwrap();
        assert!(sent.success(), "kill -TERM failed");
    }
    #[cfg(not(unix))]
    {
        // No SIGTERM on Windows: the graceful path is exercised on Unix (CI) only.
        child.kill().unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(
            Instant::now() < deadline,
            "the daemon did not stop within 5 s"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn version_help_and_missing_config() {
    let out = Command::new(BIN).arg("--version").output().unwrap();
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        format!("polaris-tunnel {}", env!("CARGO_PKG_VERSION"))
    );
    let out = Command::new(BIN).arg("--help").output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("--configtest"));
    let out = Command::new(BIN).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--config is required"));
    let out = Command::new(BIN).args(["--info", "nope"]).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn configtest_accepts_a_good_file_and_names_a_bad_one() {
    let good = relay_file("good.conf", free_udp());
    let out = Command::new(BIN)
        .args(["--configtest", "--config"])
        .arg(&good)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "configuration ok"
    );

    let bad = scratch("bad.conf", "[Interface]\nPrivateKey = nope\n");
    let out = Command::new(BIN)
        .args(["-n", "-c"])
        .arg(&bad)
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("bad.conf"));

    let missing = std::env::temp_dir().join("polaris-tunnel-no-such-file.conf");
    let out = Command::new(BIN).arg("-c").arg(&missing).output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("cannot read"));
}

#[test]
fn runs_serves_its_status_and_stops() {
    let listen = free_udp();
    let status_port = free_tcp_port();
    let file = relay_file("run.conf", listen);
    let daemon = Command::new(BIN)
        .arg("--config")
        .arg(&file)
        .args(["--info", &format!("127.0.0.1:{status_port}"), "--silent"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let daemon = Daemon(Some(daemon));
    let status: SocketAddr = ([127, 0, 0, 1], status_port).into();
    let deadline = Instant::now() + Duration::from_secs(10);
    let metrics = loop {
        if let Some(text) = get(status, "/metrics").filter(|t| t.starts_with("HTTP/1.1 200")) {
            break text;
        }
        assert!(Instant::now() < deadline, "/metrics never answered");
        std::thread::sleep(Duration::from_millis(100));
    };
    // The peer the file names, the port it listens on, no handshake yet, and never
    // the private key.
    let (_, house_public) = key(2);
    assert!(
        metrics.contains(&format!("public_key={}\n", hex(&house_public))),
        "{metrics}"
    );
    assert!(metrics.contains(&format!("listen_port={listen}\n")));
    assert!(metrics.contains("last_handshake_time_sec=0\n"));
    assert!(metrics.contains(&format!("allowed_ip={HOUSE_IP}/32\n")));
    assert!(!metrics.contains("private_key"));
    let ready = get(status, "/readyz").unwrap();
    assert!(ready.starts_with("HTTP/1.1 200") && ready.ends_with("{}"));
    // Its WireGuard port is held while it runs.
    assert!(UdpSocket::bind(("0.0.0.0", listen)).is_err());

    let exit = stop(daemon);
    #[cfg(unix)]
    assert!(exit.success(), "SIGTERM is a clean stop, got {exit}");
    #[cfg(not(unix))]
    let _ = exit;
    // Everything it held is released.
    assert!(TcpListener::bind(status).is_ok());
    assert!(UdpSocket::bind(("0.0.0.0", listen)).is_ok());
}

#[test]
fn a_status_port_in_use_is_reported() {
    let held = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    // The WireGuard port was free a moment ago; a test running beside this one
    // may take it first, which is a different failure from the one under test.
    let mut attempts = 0;
    let (out, stderr) = loop {
        let file = relay_file("busy.conf", free_udp());
        let out = Command::new(BIN)
            .arg("-c")
            .arg(&file)
            .args(["-i", &format!("127.0.0.1:{port}")])
            .output()
            .unwrap();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        attempts += 1;
        if !stderr.contains("cannot start") || attempts == 20 {
            break (out, stderr);
        }
    };
    assert_eq!(out.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("cannot serve status"), "{stderr}");
}
