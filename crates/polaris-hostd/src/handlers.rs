//! API v1 route handlers and shared application state.
//!
//! Every handler returns an [`http::Response`]; none may panic on bad input.
//! Client-facing error text is deliberately generic so internal detail (paths,
//! errno strings) never leaks to the caller.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Deserialize;

use crate::config::Config;
use crate::http::{self, Request, Response};
use crate::security::{self, PathError};

/// Body cap for control endpoints (JSON). `fs` PUT is streamed and not bound by
/// this. 16 MiB is far more than any control payload needs while still refusing
/// a memory-exhaustion attempt.
const MAX_CONTROL_BODY: u64 = 16 * 1024 * 1024;

/// Shared, thread-safe daemon state. One instance is created at startup and
/// shared (via `Arc`) across every accepted connection.
pub struct AppState {
    pub config: Config,
    /// The bearer token generated this run. Never logged.
    pub token: String,
    /// Active mounts this daemon created, id -> resolved target. Needed to
    /// unmount by id later. enigma: in-memory only, so a daemon restart forgets
    /// mounts it made (the kernel keeps them). Upgrade path: reconcile against
    /// /proc/mounts on start if restart-survival becomes a requirement.
    mounts: Mutex<HashMap<String, PathBuf>>,
}

impl AppState {
    pub fn new(config: Config, token: String) -> Self {
        Self {
            config,
            token,
            mounts: Mutex::new(HashMap::new()),
        }
    }
}

/// Probe the host for the capabilities the full edition exposes. Cheap, purely
/// presence-based checks; run per health request so a socket appearing later is
/// reflected without restarting the daemon.
fn capabilities(config: &Config) -> serde_json::Value {
    let path_exists = |p: &str| std::path::Path::new(p).exists();
    let kubernetes = std::env::var("KUBECONFIG").is_ok_and(|v| !v.is_empty())
        || path_exists("/var/run/secrets/kubernetes.io");
    serde_json::json!({
        "hostFilesystem": true,
        "nativeMounts": true,
        "docker": path_exists("/var/run/docker.sock"),
        "kubernetes": kubernetes,
        "systemd": path_exists("/run/systemd/system"),
        "autoUpdate": config.auto_update,
    })
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum MountKind {
    Smb,
    Nfs,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MountRequest {
    id: String,
    // Selects the `-t` filesystem type in run_mount (unix only).
    #[cfg_attr(not(unix), allow(dead_code))]
    kind: MountKind,
    source: String,
    target: String,
    options: Option<String>,
}

/// Route a request to its handler. `body` is a reader bounded to the request's
/// declared `Content-Length`; handlers that consume a body read from it.
pub fn dispatch<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let path = req.path.as_str();
    match (req.method.as_str(), path) {
        ("GET", "/v1/health") => health(state),
        ("POST", "/v1/mounts") => mount_create(state, req, body),
        ("POST", "/v1/update") => {
            // TODO(auto-update): perform the host-side image/binary update.
            // Stubbed until the update channel and signature checks land.
            Response::not_implemented("auto-update not yet implemented")
        }
        _ if path.starts_with("/v1/fs/") => fs_handler(state, req, body),
        ("DELETE", _) if path.starts_with("/v1/mounts/") => {
            mount_delete(state, &path["/v1/mounts/".len()..])
        }
        _ if path.starts_with("/v1/docker/") => {
            Response::not_implemented("docker control not yet implemented")
        }
        _ if path.starts_with("/v1/k8s/") => {
            Response::not_implemented("kubernetes control not yet implemented")
        }
        _ if path.starts_with("/v1/systemd/") => {
            Response::not_implemented("systemd control not yet implemented")
        }
        _ => Response::not_found(),
    }
}

fn health(state: &AppState) -> Response {
    let body = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "capabilities": capabilities(&state.config),
    });
    Response::json(200, "OK", &body)
}

/// Map a path-resolution error to a safe 403/400 response.
fn path_error_response(err: PathError) -> Response {
    match err {
        PathError::Nul => Response::bad_request("path contains a NUL byte"),
        PathError::Escape => Response::forbidden("path escapes the allowed root"),
    }
}

fn fs_handler<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let requested = &req.path["/v1/fs/".len()..];
    let resolved = match security::resolve_within(&state.config.root, requested) {
        Ok(p) => p,
        Err(e) => return path_error_response(e),
    };

    match req.method.as_str() {
        "GET" => fs_get(&resolved, req),
        "PUT" => fs_put(&resolved, req, body),
        "DELETE" => match std::fs::remove_file(&resolved) {
            Ok(()) => Response::empty(204, "No Content"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Response::not_found(),
            Err(_) => Response::server_error(),
        },
        _ => Response::text(405, "Method Not Allowed", "unsupported method for /v1/fs"),
    }
}

fn fs_get(resolved: &std::path::Path, req: &Request) -> Response {
    // A Range request yields a 206 partial; otherwise the whole file streams.
    if let Some(range) = req.header("range").and_then(http::parse_range) {
        match http::open_ranged(resolved, &range) {
            Ok((file, len, total)) => {
                let start = range.start.min(total);
                let end = start + len.saturating_sub(1);
                Response::file(206, "Partial Content", file, len)
                    .with_header("Content-Range", format!("bytes {start}-{end}/{total}"))
                    .with_header("Accept-Ranges", "bytes")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Response::not_found(),
            Err(_) => Response::server_error(),
        }
    } else {
        match std::fs::File::open(resolved) {
            Ok(file) => {
                let len = file.metadata().map(|m| m.len()).unwrap_or(0);
                Response::file(200, "OK", file, len).with_header("Accept-Ranges", "bytes")
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Response::not_found(),
            Err(_) => Response::server_error(),
        }
    }
}

fn fs_put<R: Read>(resolved: &std::path::Path, req: &Request, body: &mut R) -> Response {
    if let Some(parent) = resolved.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return Response::server_error();
        }
    }
    let mut file = match std::fs::File::create(resolved) {
        Ok(f) => f,
        Err(_) => return Response::server_error(),
    };
    // Stream exactly the declared body length from the connection to disk; the
    // reader is already bounded to Content-Length by the caller.
    let mut limited = body.take(req.content_length);
    match std::io::copy(&mut limited, &mut file) {
        Ok(_) => Response::empty(201, "Created"),
        Err(_) => Response::server_error(),
    }
}

/// Read a control body into memory, refusing anything over the cap.
fn read_control_body<R: Read>(req: &Request, body: &mut R) -> Result<Vec<u8>, Response> {
    if req.content_length > MAX_CONTROL_BODY {
        return Err(Response::text(
            413,
            "Payload Too Large",
            "request body too large",
        ));
    }
    let mut buf = Vec::new();
    let mut limited = body.take(MAX_CONTROL_BODY);
    if limited.read_to_end(&mut buf).is_err() {
        return Err(Response::bad_request("could not read request body"));
    }
    Ok(buf)
}

fn mount_create<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: MountRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid mount request body"),
    };

    // Validate every field before it reaches an argument vector.
    if let Err(msg) = security::validate_mount_id(&request.id) {
        return Response::bad_request(&msg);
    }
    for (name, value) in [("source", &request.source), ("target", &request.target)] {
        if let Err(msg) = security::validate_mount_field(name, value) {
            return Response::bad_request(&msg);
        }
    }
    if let Some(opts) = &request.options {
        if let Err(msg) = security::validate_mount_field("options", opts) {
            return Response::bad_request(&msg);
        }
    }

    // Confine the target under the mount root.
    let target = match security::resolve_within(&state.config.mount_root, &request.target) {
        Ok(p) => p,
        Err(e) => return path_error_response(e),
    };

    match run_mount(&request, &target) {
        Ok(()) => {
            state
                .mounts
                .lock()
                .unwrap()
                .insert(request.id.clone(), target.clone());
            let body = serde_json::json!({
                "id": request.id,
                "mountpoint": target.to_string_lossy(),
            });
            Response::json(201, "Created", &body)
        }
        Err(MountError::Unsupported) => {
            Response::not_implemented("mount is only supported on Linux hosts")
        }
        Err(MountError::Failed) => Response::text(502, "Bad Gateway", "mount command failed"),
    }
}

fn mount_delete(state: &AppState, id: &str) -> Response {
    if let Err(msg) = security::validate_mount_id(id) {
        return Response::bad_request(&msg);
    }
    let target = match state.mounts.lock().unwrap().get(id).cloned() {
        Some(t) => t,
        None => return Response::not_found(),
    };
    match run_umount(&target) {
        Ok(()) => {
            state.mounts.lock().unwrap().remove(id);
            Response::empty(204, "No Content")
        }
        Err(MountError::Unsupported) => {
            Response::not_implemented("umount is only supported on Linux hosts")
        }
        Err(MountError::Failed) => Response::text(502, "Bad Gateway", "umount command failed"),
    }
}

enum MountError {
    /// Non-Linux host: mounting is not available (dev shim).
    Unsupported,
    /// The `mount`/`umount` process returned a non-zero status. Only produced
    /// by the unix implementations.
    #[cfg_attr(not(unix), allow(dead_code))]
    Failed,
}

/// Run `mount` with an argument vector (never a shell). Filesystem type is
/// selected from the validated `kind`, so no client string reaches the type
/// flag. Target has already been confined under the mount root.
#[cfg(unix)]
fn run_mount(request: &MountRequest, target: &std::path::Path) -> Result<(), MountError> {
    use std::process::Command;

    if std::fs::create_dir_all(target).is_err() {
        return Err(MountError::Failed);
    }
    let fstype = match request.kind {
        MountKind::Smb => "cifs",
        MountKind::Nfs => "nfs",
    };
    let mut cmd = Command::new("mount");
    cmd.arg("-t").arg(fstype).arg(&request.source).arg(target);
    if let Some(opts) = &request.options {
        cmd.arg("-o").arg(opts);
    }
    match cmd.status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(MountError::Failed),
    }
}

#[cfg(not(unix))]
fn run_mount(_request: &MountRequest, _target: &std::path::Path) -> Result<(), MountError> {
    Err(MountError::Unsupported)
}

#[cfg(unix)]
fn run_umount(target: &std::path::Path) -> Result<(), MountError> {
    use std::process::Command;
    match Command::new("umount").arg(target).status() {
        Ok(status) if status.success() => Ok(()),
        _ => Err(MountError::Failed),
    }
}

#[cfg(not(unix))]
fn run_umount(_target: &std::path::Path) -> Result<(), MountError> {
    Err(MountError::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_request_parses_and_rejects_unknown_fields() {
        let ok =
            br#"{"id":"nas","kind":"smb","source":"//nas/share","target":"nas","options":"rw"}"#;
        let parsed: MountRequest = serde_json::from_slice(ok).unwrap();
        assert_eq!(parsed.kind, MountKind::Smb);
        assert_eq!(parsed.options.as_deref(), Some("rw"));

        // Unknown field is rejected.
        let unknown = br#"{"id":"nas","kind":"nfs","source":"s","target":"t","evil":1}"#;
        assert!(serde_json::from_slice::<MountRequest>(unknown).is_err());

        // Unknown kind is rejected.
        let bad_kind = br#"{"id":"nas","kind":"ftp","source":"s","target":"t"}"#;
        assert!(serde_json::from_slice::<MountRequest>(bad_kind).is_err());

        // Missing required field is rejected.
        let missing = br#"{"id":"nas","kind":"nfs","source":"s"}"#;
        assert!(serde_json::from_slice::<MountRequest>(missing).is_err());
    }

    #[test]
    fn options_are_optional() {
        let no_opts = br#"{"id":"nas","kind":"nfs","source":"srv:/x","target":"nas"}"#;
        let parsed: MountRequest = serde_json::from_slice(no_opts).unwrap();
        assert!(parsed.options.is_none());
    }

    #[test]
    fn capabilities_reports_flags() {
        let mut config = Config::from_env();
        config.auto_update = false;
        let caps = capabilities(&config);
        assert_eq!(caps["hostFilesystem"], true);
        assert_eq!(caps["nativeMounts"], true);
        assert_eq!(caps["autoUpdate"], false);
        // Presence-based flags are booleans regardless of host.
        assert!(caps["docker"].is_boolean());
        assert!(caps["systemd"].is_boolean());
    }
}
