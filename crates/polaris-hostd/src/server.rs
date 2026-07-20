//! Transport and connection handling.
//!
//! The primary transport is a Unix domain socket (privileged, local-only). A
//! TCP fallback is bound only when `POLARIS_HOSTD_ADDR` is set, for setups
//! where a socket bind-mount is impractical. Each connection is handled on its
//! own thread, serves exactly one request, then closes (`Connection: close`),
//! which keeps the hand-rolled server trivial and stateless per connection.

use std::io::{self, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::thread;

use crate::handlers::{self, AppState};
use crate::http::{self, Response};
use crate::security::constant_time_eq;

/// Write the bearer token to `path`, readable by the web client. The web
/// container runs as an unprivileged user (`node`) while this daemon runs as
/// root, and both share only the private `polaris-run` volume; 0600 (root-only)
/// would leave the token unreadable by its one intended reader, stranding the
/// dashboard on the limited edition. 0644 keeps it readable within that trusted,
/// two-container volume (whose host path is itself root-only under Docker).
/// Called once at startup; the token rotates every run.
pub fn write_token_file(path: &std::path::Path, token: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))?;
    }
    Ok(())
}

/// Bind every configured transport and serve forever. Returns an error only if
/// no transport could be bound.
pub fn run(state: Arc<AppState>) -> io::Result<()> {
    let mut handles = Vec::new();

    #[cfg(unix)]
    {
        let socket = state.config.socket.clone();
        let state = state.clone();
        handles.push(thread::spawn(move || {
            if let Err(e) = serve_unix(&socket, state) {
                eprintln!("unix socket listener failed: {e}");
            }
        }));
    }

    if let Some(addr) = state.config.tcp_addr.clone() {
        let state = state.clone();
        handles.push(thread::spawn(move || {
            let listener = match TcpListener::bind(&addr) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("TCP bind {addr} failed: {e}");
                    return;
                }
            };
            eprintln!("polaris-hostd listening on tcp://{addr}");
            for stream in listener.incoming().flatten() {
                let state = state.clone();
                thread::spawn(move || {
                    if let Ok(peer) = stream.try_clone() {
                        handle(BufReader::new(stream), peer, &state);
                    }
                });
            }
        }));
    }

    if handles.is_empty() {
        return Err(io::Error::other(
            "no transport configured: set POLARIS_HOSTD_ADDR or run on a unix host",
        ));
    }
    for h in handles {
        let _ = h.join();
    }
    Ok(())
}

#[cfg(unix)]
fn serve_unix(socket: &std::path::Path, state: Arc<AppState>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Unlink a stale socket left by a previous run so the bind can succeed.
    if socket.exists() {
        std::fs::remove_file(socket)?;
    }
    let listener = UnixListener::bind(socket)?;
    // 0666: the web container connects as an unprivileged user (`node`) that
    // shares no uid/gid with this root daemon, so a restrictive mode would refuse
    // its connection. The socket lives only in the private `polaris-run` volume
    // (mounted by web and hostd alone), and the per-run bearer token - unguessable
    // and required on every request - remains the actual authorization.
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o666))?;
    eprintln!("polaris-hostd listening on {}", socket.display());

    for stream in listener.incoming().flatten() {
        let state = state.clone();
        thread::spawn(move || {
            if let Ok(peer) = stream.try_clone() {
                handle(BufReader::new(stream), peer, &state);
            }
        });
    }
    Ok(())
}

/// Serve one request on an accepted connection: parse, authenticate, dispatch,
/// and write the response. Generic over the concrete stream type so the unix
/// and TCP paths share it.
fn handle<R: Read, W: Write>(mut reader: BufReader<R>, mut writer: W, state: &AppState) {
    let request = match http::read_request(&mut reader) {
        Ok(Some(r)) => r,
        Ok(None) => return, // client closed without sending
        Err(_) => {
            let _ = Response::bad_request("malformed request").write_to(&mut writer);
            return;
        }
    };

    // Authenticate every request (no exceptions, including /v1/health) with a
    // constant-time comparison against the run's token.
    let authorized = request
        .bearer_token()
        .map(|t| constant_time_eq(t.as_bytes(), state.token.as_bytes()))
        .unwrap_or(false);
    if !authorized {
        let _ = Response::unauthorized().write_to(&mut writer);
        return;
    }

    // Bound the body reader to the declared Content-Length so a handler never
    // blocks waiting for a client that keeps its write side open.
    let mut body = reader.by_ref().take(request.content_length);
    let response = handlers::dispatch(state, &request, &mut body);
    let _ = response.write_to(&mut writer);
}
