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
use crate::deploy::{self, DeploySpec};
use crate::docker;
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
        "docker": config.docker_socket.exists(),
        "deploy": config.docker_socket.exists(),
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

/// A request to forward to the Docker socket. Only `method` and `path` are
/// accepted; no request body is ever relayed (the allowlisted endpoints take
/// none), which removes an entire class of forwarding surface.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DockerProxyRequest {
    method: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DownRequest {
    project: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PullRequest {
    image: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LoginRequest {
    #[serde(default)]
    registry: String,
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LogsRequest {
    container: String,
    #[serde(default)]
    follow: bool,
    tail: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
// cmd/tty are forwarded to the socket only on unix; unused on the dev shim.
#[cfg_attr(not(unix), allow(dead_code))]
struct ExecCreateRequest {
    container: String,
    cmd: Vec<String>,
    #[serde(default)]
    tty: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FsReadRequest {
    container: String,
    argv: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecResizeRequest {
    #[serde(rename = "execId")]
    exec_id: String,
    width: u32,
    height: u32,
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
        ("POST", "/v1/update") => update(state),
        ("POST", "/v1/docker") => docker_proxy(state, req, body),
        ("POST", "/v1/deploy/up") => deploy_up(state, req, body),
        ("POST", "/v1/deploy/down") => deploy_down(state, req, body),
        ("POST", "/v1/deploy/stack/up") => deploy_stack_up(state, req, body),
        ("POST", "/v1/deploy/stack/down") => deploy_stack_down(state, req, body),
        ("POST", "/v1/deploy/pull") => deploy_pull(state, req, body),
        ("POST", "/v1/deploy/login") => deploy_login(state, req, body),
        ("POST", "/v1/deploy/logs") => deploy_logs(state, req, body),
        ("POST", "/v1/deploy/build") => deploy_build(state, req, body),
        ("POST", "/v1/deploy/exec/create") => deploy_exec_create(state, req, body),
        ("POST", "/v1/deploy/exec/resize") => deploy_exec_resize(state, req, body),
        ("POST", "/v1/deploy/fs/read") => deploy_fs_read(req, body),
        ("POST", "/v1/deploy/fs/write") => deploy_fs_write(state, req, body),
        _ if path.starts_with("/v1/fs/") => fs_handler(state, req, body),
        ("DELETE", _) if path.starts_with("/v1/mounts/") => {
            mount_delete(state, &path["/v1/mounts/".len()..])
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

/// Trigger a host-side update + redeploy. Runs the operator-configured update
/// command detached (in its own session) so it survives this daemon being
/// recreated by the redeploy it kicks off. Gated on the auto-update capability;
/// reports not-implemented when no command is configured.
fn update(state: &AppState) -> Response {
    if !state.config.auto_update {
        return Response::forbidden("auto-update is disabled on this host");
    }
    let cmd = match state.config.update_cmd.as_deref() {
        Some(cmd) => cmd,
        None => {
            return Response::not_implemented(
                "no update command configured (set POLARIS_HOSTD_UPDATE_CMD)",
            );
        }
    };
    match spawn_update(cmd) {
        Ok(()) => Response::json(202, "Accepted", &serde_json::json!({ "status": "started" })),
        Err(_) => Response::json(
            500,
            "Internal Server Error",
            &serde_json::json!({ "error": "failed to start the update" }),
        ),
    }
}

/// Spawn the update command detached from this process. `setsid` puts it in a new
/// session so a redeploy that recreates this daemon does not kill the update
/// mid-flight; stdio is discarded. The command is the operator's own configured
/// string - no network input ever reaches it.
#[cfg(unix)]
fn spawn_update(cmd: &str) -> std::io::Result<()> {
    use std::process::{Command, Stdio};
    Command::new("setsid")
        .arg("sh")
        .arg("-c")
        .arg(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(not(unix))]
fn spawn_update(_cmd: &str) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "update is only supported on unix hosts",
    ))
}

/// Proxy an allowlisted Docker Engine API call. The body is a `{ method, path }`
/// envelope; the pair is validated against a fixed allowlist before anything is
/// forwarded, and the Docker reply is returned wrapped as
/// `{ status, body }` so the Docker status never masquerades as this daemon's
/// own HTTP status. The Docker response is untrusted: it is passed back verbatim
/// as a string, never parsed or acted on here.
fn docker_proxy<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: DockerProxyRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid docker proxy request body"),
    };

    let allowed = match docker::validate(&request.method, &request.path) {
        Ok(a) => a,
        Err(msg) => return Response::forbidden(msg),
    };

    match docker::forward(&state.config.docker_socket, &allowed) {
        Ok((status, body)) => Response::json(
            200,
            "OK",
            &serde_json::json!({
                "status": status,
                "body": String::from_utf8_lossy(&body),
            }),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
            Response::not_implemented("docker proxy is only supported on unix hosts")
        }
        Err(_) => Response::text(502, "Bad Gateway", "could not reach the docker socket"),
    }
}

/// Deploy a validated compose project on the local host, streaming `docker
/// compose up` output. The spec is structured (never raw YAML), validated, and
/// rendered here, so the web container can only ever request Polaris-shaped
/// containers.
fn deploy_up<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let spec: DeploySpec = match serde_json::from_slice(&raw) {
        Ok(s) => s,
        Err(_) => return Response::bad_request("invalid deploy spec"),
    };
    if let Err(msg) = deploy::validate_spec(&spec, &state.config) {
        return Response::bad_request(&msg);
    }
    let yaml = deploy::render_compose(&spec, &state.config);
    match deploy::compose_up(&state.config, &spec.project, &yaml) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not start docker compose"),
    }
}

/// Deploy a validated spec onto a swarm via `docker stack deploy`, streaming
/// output. Same structured spec as compose up; replicas are honored by swarm.
fn deploy_stack_up<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let spec: DeploySpec = match serde_json::from_slice(&raw) {
        Ok(s) => s,
        Err(_) => return Response::bad_request("invalid deploy spec"),
    };
    if let Err(msg) = deploy::validate_spec(&spec, &state.config) {
        return Response::bad_request(&msg);
    }
    let yaml = deploy::render_compose(&spec, &state.config);
    match deploy::stack_up(&state.config, &spec.project, &yaml) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not deploy the stack"),
    }
}

fn deploy_stack_down<R: Read>(_state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: DownRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid down request"),
    };
    if !deploy::valid_project(&request.project) {
        return Response::bad_request("invalid project name");
    }
    match deploy::stack_down(&request.project) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not remove the stack"),
    }
}

fn deploy_down<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: DownRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid down request"),
    };
    if !deploy::valid_project(&request.project) {
        return Response::bad_request("invalid project name");
    }
    match deploy::compose_down(&state.config, &request.project) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not stop the project"),
    }
}

fn deploy_pull<R: Read>(_state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: PullRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid pull request"),
    };
    if !deploy::valid_image(&request.image) {
        return Response::bad_request("invalid image reference");
    }
    match deploy::pull(&request.image) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not pull the image"),
    }
}

fn deploy_login<R: Read>(_state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: LoginRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid login request"),
    };
    if !deploy::valid_registry(&request.registry)
        || !deploy::valid_registry_username(&request.username)
    {
        return Response::bad_request("invalid registry or username");
    }
    if request.password.is_empty() || request.password.len() > 4096 {
        return Response::bad_request("invalid password");
    }
    match deploy::login(&request.registry, &request.username, &request.password) {
        Ok(true) => Response::empty(204, "No Content"),
        Ok(false) => Response::text(502, "Bad Gateway", "registry login failed"),
        Err(_) => Response::text(502, "Bad Gateway", "could not run registry login"),
    }
}

fn deploy_logs<R: Read>(_state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: LogsRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid logs request"),
    };
    if !deploy::valid_container_ref(&request.container) {
        return Response::bad_request("invalid container reference");
    }
    match deploy::logs(&request.container, request.follow, request.tail) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not read container logs"),
    }
}

/// Build an image from a tar context streamed as the request body. The image tag
/// and dockerfile path travel in headers, since hostd strips query strings.
fn deploy_build<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let tag = req.header("x-polaris-tag").unwrap_or("");
    let dockerfile = req.header("x-polaris-dockerfile").unwrap_or("Dockerfile");
    if !deploy::valid_image(tag) {
        return Response::bad_request("invalid or missing X-Polaris-Tag");
    }
    if dockerfile.is_empty()
        || dockerfile.bytes().any(|b| b < 0x20 || b == 0x7f)
        || dockerfile.contains("..")
    {
        return Response::bad_request("invalid X-Polaris-Dockerfile");
    }

    // Stream the tar context to a private file under the deploy root, bounded.
    let build_dir = state.config.deploy_root.join("_build");
    if std::fs::create_dir_all(&build_dir).is_err() {
        return Response::server_error();
    }
    let tar_path = build_dir.join(format!("ctx-{}.tar", std::process::id()));
    let mut file = match std::fs::File::create(&tar_path) {
        Ok(f) => f,
        Err(_) => return Response::server_error(),
    };
    const MAX_CONTEXT: u64 = 2 * 1024 * 1024 * 1024;
    let mut limited = body.take(req.content_length.min(MAX_CONTEXT));
    if std::io::copy(&mut limited, &mut file).is_err() {
        let _ = std::fs::remove_file(&tar_path);
        return Response::server_error();
    }
    drop(file);
    let reopened = match std::fs::File::open(&tar_path) {
        Ok(f) => f,
        Err(_) => return Response::server_error(),
    };
    // The tar file can be removed now; the child holds an open descriptor.
    let _ = std::fs::remove_file(&tar_path);
    match deploy::build(tag, dockerfile, reopened) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not start the build"),
    }
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn deploy_exec_create<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: ExecCreateRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid exec request"),
    };
    if !deploy::valid_container_ref(&request.container) {
        return Response::bad_request("invalid container reference");
    }
    #[cfg(unix)]
    {
        match deploy::exec_create(
            &state.config.docker_socket,
            &request.container,
            &request.cmd,
            request.tty,
        ) {
            Ok(id) => Response::json(200, "OK", &serde_json::json!({ "execId": id })),
            Err(_) => Response::text(502, "Bad Gateway", "could not create the exec"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (state, request);
        Response::not_implemented("exec is only supported on unix hosts")
    }
}

#[cfg_attr(not(unix), allow(unused_variables))]
fn deploy_exec_resize<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: ExecResizeRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid resize request"),
    };
    if !deploy::valid_container_ref(&request.exec_id) {
        return Response::bad_request("invalid exec id");
    }
    let width = request.width.clamp(1, 500);
    let height = request.height.clamp(1, 300);
    #[cfg(unix)]
    {
        match deploy::exec_resize(&state.config.docker_socket, &request.exec_id, width, height) {
            Ok(()) => Response::empty(200, "OK"),
            Err(_) => Response::text(502, "Bad Gateway", "could not resize the exec"),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (state, width, height);
        Response::not_implemented("exec is only supported on unix hosts")
    }
}

/// Wrap a streaming reader as a plain-text streamed response.
fn stream_response(reader: Box<dyn std::io::Read + Send>) -> Response {
    Response::stream(200, "OK", reader).with_header("Content-Type", "text/plain; charset=utf-8")
}

/// Read-only container filesystem commands (list/stat/read/tar). argv[0] is held
/// to a small allowlist; the file browser only ever uses these.
const FS_READ_ALLOWED: &[&str] = &["ls", "stat", "cat", "tar", "find", "test"];

/// Run a read-only filesystem command inside a container and stream stdout. stderr
/// is dropped so a binary read (cat/tar) is never corrupted by diagnostics.
fn deploy_fs_read<R: Read>(req: &Request, body: &mut R) -> Response {
    let raw = match read_control_body(req, body) {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let request: FsReadRequest = match serde_json::from_slice(&raw) {
        Ok(r) => r,
        Err(_) => return Response::bad_request("invalid fs read request"),
    };
    if !deploy::valid_container_ref(&request.container) {
        return Response::bad_request("invalid container reference");
    }
    if request.argv.is_empty() || request.argv.len() > 32 {
        return Response::bad_request("argv must have 1-32 elements");
    }
    if !FS_READ_ALLOWED.contains(&request.argv[0].as_str()) {
        return Response::forbidden("command not permitted by the fs read allowlist");
    }
    for arg in &request.argv {
        if arg.len() > 4096 || arg.bytes().any(|b| b == 0) {
            return Response::bad_request("argv element too long or contains a NUL");
        }
    }
    match deploy::exec_run(&request.container, &request.argv, None, false) {
        Ok(reader) => Response::stream(200, "OK", reader)
            .with_header("Content-Type", "application/octet-stream"),
        Err(_) => Response::text(502, "Bad Gateway", "could not run the command"),
    }
}

/// Write a file inside a container: stream the request body to the path via
/// `docker exec -i <c> sh -c 'cat > "$1"' _ <path>`. The path is a positional
/// argument (`$1`), never interpolated into the shell command, so it cannot inject.
fn deploy_fs_write<R: Read>(state: &AppState, req: &Request, body: &mut R) -> Response {
    let container = req.header("x-polaris-container").unwrap_or("");
    let path = req.header("x-polaris-path").unwrap_or("");
    if !deploy::valid_container_ref(container) {
        return Response::bad_request("invalid or missing X-Polaris-Container");
    }
    if path.is_empty() || path.len() > 4096 || path.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Response::bad_request("invalid or missing X-Polaris-Path");
    }

    let build_dir = state.config.deploy_root.join("_fs");
    if std::fs::create_dir_all(&build_dir).is_err() {
        return Response::server_error();
    }
    let tmp = build_dir.join(format!("up-{}.bin", std::process::id()));
    let mut file = match std::fs::File::create(&tmp) {
        Ok(f) => f,
        Err(_) => return Response::server_error(),
    };
    const MAX_UPLOAD: u64 = 4 * 1024 * 1024 * 1024;
    let mut limited = body.take(req.content_length.min(MAX_UPLOAD));
    if std::io::copy(&mut limited, &mut file).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Response::server_error();
    }
    drop(file);
    let reopened = match std::fs::File::open(&tmp) {
        Ok(f) => f,
        Err(_) => return Response::server_error(),
    };
    let _ = std::fs::remove_file(&tmp);
    let argv = vec![
        "sh".to_string(),
        "-c".to_string(),
        "cat > \"$1\"".to_string(),
        "polaris".to_string(),
        path.to_string(),
    ];
    match deploy::exec_run(container, &argv, Some(reopened), true) {
        Ok(reader) => stream_response(reader),
        Err(_) => Response::text(502, "Bad Gateway", "could not write the file"),
    }
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
    /// Non-Linux host: mounting is not available (dev shim). Only produced by the
    /// non-unix implementations, so it is dead code on a unix build.
    #[cfg_attr(unix, allow(dead_code))]
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
