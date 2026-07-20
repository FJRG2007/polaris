//! Deploy endpoints: build, ship, and observe Polaris-managed containers on the
//! local host without ever handing the web container the Docker socket or a
//! shell.
//!
//! The security boundary is a *structured* deploy spec, not free-form compose
//! YAML. The web container sends a JSON `DeploySpec` (serde, `deny_unknown_fields`)
//! that can only express safe shapes - there is no `privileged`, `cap_add`,
//! `network_mode: host`, or arbitrary bind field to smuggle - and this daemon
//! validates every value and renders the compose file itself. Bind mounts are
//! confined under the volume root; images, names, env, and labels are charset-
//! checked. Even a fully compromised web container can therefore deploy only
//! Polaris-shaped containers, never escalate to host root.

use std::collections::BTreeMap;
use std::io::{self, Read};
// Only the unix exec helpers take a `&Path`; the rest use owned PathBufs.
#[cfg(unix)]
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;

use serde::Deserialize;

use crate::config::Config;
use crate::security::{self, PathError};

/// A deploy request: one compose project made of one or more services.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploySpec {
    pub project: String,
    pub services: Vec<ServiceSpec>,
    /// Named volumes to declare at the top level.
    #[serde(default)]
    pub volumes: Vec<String>,
    /// External networks the services join (the shared proxy network).
    #[serde(default)]
    pub networks: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSpec {
    pub name: String,
    pub image: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub ports: Vec<PortSpec>,
    #[serde(default)]
    pub volumes: Vec<VolumeSpec>,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub command: Vec<String>,
    #[serde(default)]
    pub networks: Vec<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub restart: Option<String>,
    pub healthcheck: Option<HealthSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortSpec {
    pub host: u16,
    pub container: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolumeSpec {
    /// For "volume": a named volume. For "bind": a path confined under the
    /// volume root (never an arbitrary host path).
    pub source: String,
    pub target: String,
    /// volume | bind
    pub kind: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HealthSpec {
    pub test: Vec<String>,
    pub interval: Option<u32>,
    pub retries: Option<u32>,
    pub start_period: Option<u32>,
}

const ALLOWED_RESTART: &[&str] = &["no", "always", "unless-stopped", "on-failure"];

/// Validate a deploy spec against the host's roots. Returns a client-safe error
/// message describing the first offending field, or `Ok`.
pub fn validate_spec(spec: &DeploySpec, config: &Config) -> Result<(), String> {
    if !valid_project(&spec.project) {
        return Err("project name must be 1-64 chars of [a-z0-9-]".into());
    }
    if spec.services.is_empty() {
        return Err("at least one service is required".into());
    }
    let mut seen = std::collections::HashSet::new();
    for service in &spec.services {
        if !valid_name(&service.name) {
            return Err(format!("invalid service name: {}", service.name));
        }
        if !seen.insert(service.name.as_str()) {
            return Err(format!("duplicate service name: {}", service.name));
        }
        if !valid_image(&service.image) {
            return Err(format!("invalid image reference for {}", service.name));
        }
        for (key, value) in &service.env {
            if !valid_env_key(key) {
                return Err(format!("invalid env key: {key}"));
            }
            if has_control(value) {
                return Err(format!("env value for {key} contains a control character"));
            }
        }
        for (key, value) in &service.labels {
            if !valid_label_key(key) {
                return Err(format!("invalid label key: {key}"));
            }
            if has_control(value) {
                return Err(format!("label value for {key} contains a control character"));
            }
        }
        for arg in &service.command {
            if has_control(arg) {
                return Err("command arguments must not contain control characters".into());
            }
        }
        if let Some(restart) = &service.restart {
            if !ALLOWED_RESTART.contains(&restart.as_str()) {
                return Err(format!("invalid restart policy: {restart}"));
            }
        }
        for net in &service.networks {
            if !valid_name(net) {
                return Err(format!("invalid network name: {net}"));
            }
        }
        for dep in &service.depends_on {
            if !valid_name(dep) {
                return Err(format!("invalid depends_on: {dep}"));
            }
        }
        for volume in &service.volumes {
            validate_volume(volume, config)?;
        }
        if let Some(health) = &service.healthcheck {
            if health.test.is_empty() {
                return Err("healthcheck test must not be empty".into());
            }
            for part in &health.test {
                if has_control(part) {
                    return Err("healthcheck test contains a control character".into());
                }
            }
        }
    }
    for net in &spec.networks {
        if !valid_name(net) {
            return Err(format!("invalid network name: {net}"));
        }
    }
    for vol in &spec.volumes {
        if !valid_name(vol) {
            return Err(format!("invalid volume name: {vol}"));
        }
    }
    Ok(())
}

fn validate_volume(volume: &VolumeSpec, config: &Config) -> Result<(), String> {
    if has_control(&volume.target) || !volume.target.starts_with('/') {
        return Err("volume target must be an absolute path with no control chars".into());
    }
    match volume.kind.as_str() {
        "volume" => {
            if !valid_name(&volume.source) {
                return Err(format!("invalid named volume: {}", volume.source));
            }
            Ok(())
        }
        "bind" => {
            // A bind source is a path confined under the volume root - never an
            // arbitrary host path. resolve_within rejects `..`, absolute, and
            // symlink escapes.
            match security::resolve_within(&config.volume_root, &volume.source) {
                Ok(_) => Ok(()),
                Err(PathError::Nul) => Err("bind source contains a NUL byte".into()),
                Err(PathError::Escape) => Err("bind source escapes the volume root".into()),
            }
        }
        other => Err(format!("invalid volume kind: {other}")),
    }
}

/// Render a validated spec into a compose file. Every string is emitted as a
/// double-quoted YAML scalar, so a value can never break out of its field. Only
/// call after `validate_spec` has succeeded.
pub fn render_compose(spec: &DeploySpec, config: &Config) -> String {
    let mut out = String::from("services:\n");
    for service in &spec.services {
        out.push_str(&format!("  {}:\n", service.name));
        out.push_str(&format!("    image: {}\n", yaml_quote(&service.image)));
        out.push_str(&format!("    container_name: {}\n", yaml_quote(&service.name)));
        if let Some(restart) = &service.restart {
            out.push_str(&format!("    restart: {}\n", yaml_quote(restart)));
        }
        if !service.env.is_empty() {
            out.push_str("    environment:\n");
            for (key, value) in &service.env {
                out.push_str(&format!("      - {}\n", yaml_quote(&format!("{key}={value}"))));
            }
        }
        if !service.ports.is_empty() {
            out.push_str("    ports:\n");
            for port in &service.ports {
                out.push_str(&format!(
                    "      - {}\n",
                    yaml_quote(&format!("{}:{}", port.host, port.container))
                ));
            }
        }
        if !service.volumes.is_empty() {
            out.push_str("    volumes:\n");
            for volume in &service.volumes {
                let source = if volume.kind == "bind" {
                    config
                        .volume_root
                        .join(&volume.source)
                        .to_string_lossy()
                        .into_owned()
                } else {
                    volume.source.clone()
                };
                out.push_str(&format!(
                    "      - {}\n",
                    yaml_quote(&format!("{}:{}", source, volume.target))
                ));
            }
        }
        if !service.labels.is_empty() {
            out.push_str("    labels:\n");
            for (key, value) in &service.labels {
                out.push_str(&format!("      - {}\n", yaml_quote(&format!("{key}={value}"))));
            }
        }
        if !service.networks.is_empty() {
            out.push_str("    networks:\n");
            for net in &service.networks {
                out.push_str(&format!("      - {net}\n"));
            }
        }
        if !service.depends_on.is_empty() {
            out.push_str("    depends_on:\n");
            for dep in &service.depends_on {
                out.push_str(&format!("      - {dep}\n"));
            }
        }
        if !service.command.is_empty() {
            let parts: Vec<String> = service.command.iter().map(|c| yaml_quote(c)).collect();
            out.push_str(&format!("    command: [{}]\n", parts.join(", ")));
        }
        if let Some(health) = &service.healthcheck {
            out.push_str("    healthcheck:\n");
            let test: Vec<String> = health.test.iter().map(|t| yaml_quote(t)).collect();
            out.push_str(&format!("      test: [{}]\n", test.join(", ")));
            if let Some(interval) = health.interval {
                out.push_str(&format!("      interval: {interval}s\n"));
            }
            if let Some(retries) = health.retries {
                out.push_str(&format!("      retries: {retries}\n"));
            }
            if let Some(start) = health.start_period {
                out.push_str(&format!("      start_period: {start}s\n"));
            }
        }
    }
    if !spec.networks.is_empty() {
        out.push_str("networks:\n");
        for net in &spec.networks {
            out.push_str(&format!("  {net}:\n    external: true\n"));
        }
    }
    if !spec.volumes.is_empty() {
        out.push_str("volumes:\n");
        for vol in &spec.volumes {
            out.push_str(&format!("  {vol}:\n"));
        }
    }
    out
}

/// Double-quote a string as a YAML scalar, escaping backslash and quote. Callers
/// have already rejected control characters, so no further escaping is needed.
fn yaml_quote(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

// --- charset validators -----------------------------------------------------

pub fn valid_project(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && name.bytes().next().is_some_and(|b| b != b'-')
}

/// Docker object name: starts alphanumeric, then `[a-z0-9_.-]`, max 64.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

pub fn valid_image(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 256
        && image
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'/' | b':' | b'@' | b'-'))
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    !key.is_empty() && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_label_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn has_control(value: &str) -> bool {
    value.bytes().any(|b| b < 0x20 || b == 0x7f)
}

// --- process streaming ------------------------------------------------------

/// Reaps the child when the streaming reader is dropped, so a client that
/// disconnects early does not leave a zombie.
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A `Read` that yields the merged stdout+stderr of a child process, chunk by
/// chunk, and ends (EOF) once the process closes both streams.
struct ChildReader {
    rx: mpsc::Receiver<Vec<u8>>,
    leftover: Vec<u8>,
    pos: usize,
    _child: ChildGuard,
}

impl Read for ChildReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.pos < self.leftover.len() {
                let n = (self.leftover.len() - self.pos).min(buf.len());
                buf[..n].copy_from_slice(&self.leftover[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            match self.rx.recv() {
                Ok(chunk) => {
                    self.leftover = chunk;
                    self.pos = 0;
                }
                // All senders dropped: the process has exited and its pipes closed.
                Err(_) => return Ok(0),
            }
        }
    }
}

/// Spawn `cmd`, streaming its merged stdout+stderr. stdin is whatever the caller
/// configured (default null); stdout/stderr are captured here.
fn stream_command(mut cmd: Command) -> io::Result<Box<dyn Read + Send>> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let (tx, rx) = mpsc::channel();
    let tx_err = tx.clone();
    thread::spawn(move || pump(stdout, tx));
    thread::spawn(move || pump(stderr, tx_err));
    Ok(Box::new(ChildReader {
        rx,
        leftover: Vec::new(),
        pos: 0,
        _child: ChildGuard(child),
    }))
}

fn pump<R: Read>(mut reader: R, tx: mpsc::Sender<Vec<u8>>) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        }
    }
}

/// Write the rendered compose file for `project` under the deploy root and
/// `docker compose up -d`, streaming build/up output. The project directory is
/// confined under the deploy root.
pub fn compose_up(config: &Config, project: &str, compose_yaml: &str) -> io::Result<Box<dyn Read + Send>> {
    let dir = project_dir(config, project)?;
    std::fs::create_dir_all(&dir)?;
    let file = dir.join("compose.yml");
    std::fs::write(&file, compose_yaml)?;
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("-p")
        .arg(project)
        .arg("-f")
        .arg(&file)
        .arg("up")
        .arg("-d")
        .arg("--remove-orphans")
        .stdin(Stdio::null());
    stream_command(cmd)
}

/// `docker compose down` for a project, streaming output.
pub fn compose_down(config: &Config, project: &str) -> io::Result<Box<dyn Read + Send>> {
    let dir = project_dir(config, project)?;
    let file = dir.join("compose.yml");
    let mut cmd = Command::new("docker");
    cmd.arg("compose")
        .arg("-p")
        .arg(project)
        .arg("-f")
        .arg(&file)
        .arg("down")
        .stdin(Stdio::null());
    stream_command(cmd)
}

/// `docker build` from a tar context on stdin, streaming build output.
pub fn build(tag: &str, dockerfile: &str, context_tar: std::fs::File) -> io::Result<Box<dyn Read + Send>> {
    let mut cmd = Command::new("docker");
    cmd.arg("build")
        .arg("-t")
        .arg(tag)
        .arg("-f")
        .arg(dockerfile)
        .arg("-")
        .stdin(Stdio::from(context_tar));
    stream_command(cmd)
}

/// `docker pull`, streaming progress.
pub fn pull(image: &str) -> io::Result<Box<dyn Read + Send>> {
    let mut cmd = Command::new("docker");
    cmd.arg("pull").arg(image).stdin(Stdio::null());
    stream_command(cmd)
}

/// `docker logs` for a container, streaming (optionally following) output.
pub fn logs(container: &str, follow: bool, tail: Option<u32>) -> io::Result<Box<dyn Read + Send>> {
    let mut cmd = Command::new("docker");
    cmd.arg("logs").arg("--timestamps");
    if follow {
        cmd.arg("--follow");
    }
    if let Some(n) = tail {
        cmd.arg("--tail").arg(n.to_string());
    }
    cmd.arg(container).stdin(Stdio::null());
    stream_command(cmd)
}

/// Resolve and confine a project's directory under the deploy root.
fn project_dir(config: &Config, project: &str) -> io::Result<std::path::PathBuf> {
    security::resolve_within(&config.deploy_root, project)
        .map_err(|_| io::Error::new(io::ErrorKind::PermissionDenied, "invalid project path"))
}

/// Validate a container id/name for the log/exec endpoints (same rule the docker
/// proxy uses for `{id}` segments).
pub fn valid_container_ref(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    id.len() <= 128 && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

// --- interactive exec -------------------------------------------------------
//
// A terminal is a container-side PTY: exec-create with `Tty:true` asks Docker to
// allocate the pty inside the container, and exec-start hijacks the socket into a
// raw bidirectional stream that this daemon shuttles byte-for-byte to the web
// client. No pseudo-terminal is allocated on the host.

/// Create an exec instance in a container and return its id. `cmd` is the shell
/// argv to run. Unix-only (talks to the Docker socket).
#[cfg(unix)]
pub fn exec_create(
    socket: &Path,
    container: &str,
    cmd: &[String],
    tty: bool,
) -> io::Result<String> {
    let body = serde_json::json!({
        "AttachStdin": true,
        "AttachStdout": true,
        "AttachStderr": true,
        "Tty": tty,
        "Cmd": cmd,
    })
    .to_string();
    let path = format!("/containers/{container}/exec");
    let (status, raw) = crate::docker::socket_request(socket, "POST", &path, Some(&body))?;
    if !(200..300).contains(&status) {
        return Err(io::Error::other("exec create failed"));
    }
    let parsed: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| io::Error::other("bad exec response"))?;
    parsed
        .get("Id")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| io::Error::other("no exec id"))
}

/// Resize an exec instance's TTY. Dimensions are clamped by the caller.
#[cfg(unix)]
pub fn exec_resize(socket: &Path, exec_id: &str, width: u32, height: u32) -> io::Result<()> {
    let path = format!("/exec/{exec_id}/resize?h={height}&w={width}");
    let (status, _) = crate::docker::socket_request(socket, "POST", &path, None)?;
    if !(200..300).contains(&status) {
        return Err(io::Error::other("exec resize failed"));
    }
    Ok(())
}

/// Start an exec instance and return the raw hijacked socket stream, positioned
/// past the HTTP response head. The caller pumps bytes between this stream and
/// the web client. Unix-only.
#[cfg(unix)]
pub fn connect_exec_start(
    socket: &Path,
    exec_id: &str,
    tty: bool,
) -> io::Result<std::os::unix::net::UnixStream> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    let body = serde_json::json!({ "Detach": false, "Tty": tty }).to_string();
    let path = format!("/exec/{exec_id}/start");
    let mut stream = UnixStream::connect(socket)?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()?;

    // Consume the response head (up to the blank line); everything after is the
    // raw exec stream (the container's pty output when Tty was requested).
    let mut last4 = [0u8; 4];
    let mut seen = 0usize;
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte)?;
        if n == 0 {
            return Err(io::Error::other("exec start closed before headers"));
        }
        last4.rotate_left(1);
        last4[3] = byte[0];
        seen += 1;
        if seen >= 4 && last4 == *b"\r\n\r\n" {
            break;
        }
        if seen > 16 * 1024 {
            return Err(io::Error::other("exec start header too large"));
        }
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        let mut config = Config::from_env();
        config.volume_root = std::env::temp_dir().join("polaris-vol-test");
        std::fs::create_dir_all(&config.volume_root).unwrap();
        config.deploy_root = std::env::temp_dir().join("polaris-deploy-test");
        std::fs::create_dir_all(&config.deploy_root).unwrap();
        config
    }

    fn spec(json: &str) -> DeploySpec {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn rejects_unknown_fields() {
        // A `privileged` field simply does not exist on the struct, so it is
        // refused at parse time - it can never reach validation or rendering.
        let bad = r#"{"project":"p","services":[{"name":"a","image":"nginx","privileged":true}]}"#;
        assert!(serde_json::from_str::<DeploySpec>(bad).is_err());
        let bad2 = r#"{"project":"p","services":[{"name":"a","image":"nginx","network_mode":"host"}]}"#;
        assert!(serde_json::from_str::<DeploySpec>(bad2).is_err());
    }

    #[test]
    fn validates_a_good_spec() {
        let config = test_config();
        let s = spec(r#"{"project":"proj","services":[{"name":"web","image":"nginx:1.27","env":{"PORT":"3000"},"networks":["polaris-proxy"]}],"networks":["polaris-proxy"]}"#);
        assert!(validate_spec(&s, &config).is_ok());
    }

    #[test]
    fn rejects_bad_names_and_images() {
        let config = test_config();
        let bad_name = spec(r#"{"project":"p","services":[{"name":"../x","image":"nginx"}]}"#);
        assert!(validate_spec(&bad_name, &config).is_err());
        let bad_image = spec(r#"{"project":"p","services":[{"name":"a","image":"nginx; rm -rf /"}]}"#);
        assert!(validate_spec(&bad_image, &config).is_err());
        let bad_project = spec(r#"{"project":"Bad Proj","services":[{"name":"a","image":"nginx"}]}"#);
        assert!(validate_spec(&bad_project, &config).is_err());
    }

    #[test]
    fn rejects_bind_escaping_volume_root() {
        let config = test_config();
        let escape = spec(
            r#"{"project":"p","services":[{"name":"a","image":"nginx","volumes":[{"source":"../../etc","target":"/data","kind":"bind"}]}]}"#,
        );
        assert!(validate_spec(&escape, &config).is_err());
    }

    #[test]
    fn rejects_control_chars_in_env() {
        let config = test_config();
        let s = spec(r#"{"project":"p","services":[{"name":"a","image":"nginx","env":{"K":"v\nINJECT"}}]}"#);
        assert!(validate_spec(&s, &config).is_err());
    }

    #[test]
    fn renders_quoted_scalars() {
        let config = test_config();
        let s = spec(r#"{"project":"p","services":[{"name":"web","image":"nginx:1.27","env":{"A":"b"},"ports":[{"host":8080,"container":80}],"labels":{"traefik.enable":"true"},"networks":["polaris-proxy"]}],"networks":["polaris-proxy"]}"#);
        let yaml = render_compose(&s, &config);
        assert!(yaml.contains("image: \"nginx:1.27\""));
        assert!(yaml.contains("- \"A=b\""));
        assert!(yaml.contains("- \"8080:80\""));
        assert!(yaml.contains("- \"traefik.enable=true\""));
        assert!(yaml.contains("external: true"));
    }

    #[test]
    fn yaml_quote_escapes() {
        assert_eq!(yaml_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn container_ref_charset() {
        assert!(valid_container_ref("abc123"));
        assert!(valid_container_ref("web.1"));
        assert!(!valid_container_ref("../x"));
        assert!(!valid_container_ref("a b"));
    }
}
