//! Shared sign-in with Polaris Desktop (docs/terminal-integration.md, "Auth and
//! sign-in"): when Desktop is running and signed in to the same Polaris, it asks
//! the person in its own dialog and approves the terminal's request over its
//! session, so nobody has to switch to a browser.
//!
//! One frame each way, a 32-bit little-endian length then JSON. Desktop listens
//! where `crates/polaris-native-host/src/ipc.rs` connects, with the same checks
//! that it really is this user's Desktop before the code is handed over: on
//! macOS and Linux a socket in a folder only this user may enter, on Windows a
//! named pipe served by a process of this same user.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Desktop's answer is a few dozen bytes; anything longer is not Desktop.
const LONGEST_ANSWER: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Ask<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    server: &'a str,
    user_code: &'a str,
}

#[derive(Deserialize)]
struct Answer {
    ok: bool,
    reason: Option<String>,
}

/// Asks the running Desktop to approve `user_code` for `server`. True only
/// when it did; any other outcome (no Desktop, another Polaris, declined, an
/// older Desktop) is false and the caller opens the approval page instead.
pub(super) fn ask(server: &str, user_code: &str) -> bool {
    let Some(mut stream) = platform::connect() else {
        return false;
    };
    match exchange(&mut stream, server, user_code) {
        Ok(true) => true,
        Ok(false) => false,
        Err(error) => {
            log::info!("Polaris Desktop did not answer the sign-in request: {error}");
            false
        }
    }
}

fn exchange(stream: &mut impl ReadWrite, server: &str, user_code: &str) -> io::Result<bool> {
    let ask = serde_json::to_vec(&Ask {
        kind: "terminal-sign-in",
        server,
        user_code,
    })
    .map_err(io::Error::other)?;
    let length = u32::try_from(ask.len()).map_err(io::Error::other)?;
    stream.write_all(&length.to_le_bytes())?;
    stream.write_all(&ask)?;
    stream.flush()?;

    let mut length = [0u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > LONGEST_ANSWER {
        return Err(io::Error::other("the answer is too long"));
    }
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body)?;
    let answer: Answer = serde_json::from_slice(&body).map_err(io::Error::other)?;
    if !answer.ok {
        log::info!(
            "Polaris Desktop did not approve this terminal ({})",
            answer.reason.as_deref().unwrap_or("no reason given")
        );
    }
    Ok(answer.ok)
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

/// The user name as Desktop puts it in the pipe's name: ASCII letters and
/// digits lowercased, `.`, `-` and `_` kept, anything else `_`.
#[cfg(any(windows, test))]
fn endpoint_user(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(unix)]
mod platform {
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::net::UnixStream;
    use std::path::PathBuf;
    use std::time::Duration;

    /// Long enough for the person to read Desktop's dialog and answer it.
    const ANSWER_WITHIN: Duration = Duration::from_secs(180);

    fn socket_dir() -> Option<PathBuf> {
        let absolute = |value: std::ffi::OsString| {
            let path = PathBuf::from(value);
            path.is_absolute().then_some(path)
        };
        let home = std::env::var_os("HOME").and_then(absolute);
        let base = if cfg!(target_os = "macos") {
            home?.join("Library/Application Support")
        } else {
            match std::env::var_os("XDG_CONFIG_HOME").and_then(absolute) {
                Some(config) => config,
                None => home?.join(".config"),
            }
        };
        Some(base.join("Polaris").join("native-host"))
    }

    pub(super) fn connect() -> Option<UnixStream> {
        let dir = socket_dir()?;
        // symlink_metadata: a symlink is refused, never followed.
        let meta = std::fs::symlink_metadata(&dir).ok()?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        if !meta.file_type().is_dir() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
            log::warn!("Polaris Desktop's socket folder is not private to this user; not using it");
            return None;
        }
        let stream = UnixStream::connect(dir.join("desktop.sock")).ok()?;
        stream.set_read_timeout(Some(ANSWER_WITHIN)).ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .ok()?;
        Some(stream)
    }
}

#[cfg(windows)]
mod platform {
    use std::fs::{File, OpenOptions};
    use std::os::windows::io::AsRawHandle as _;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetLengthSid, GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser,
    };
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    pub(super) fn connect() -> Option<File> {
        let user = std::env::var("USERNAME").ok()?;
        let name = format!(
            r"\\.\pipe\polaris-desktop-native-host-{}",
            super::endpoint_user(&user)
        );
        let pipe = OpenOptions::new().read(true).write(true).open(name).ok()?;
        if !server_is_this_user(&pipe) {
            log::warn!("Polaris Desktop's pipe is served by another user; not using it");
            return None;
        }
        Some(pipe)
    }

    /// The SID of the user a process runs as.
    fn process_user(process: HANDLE) -> Option<Vec<u8>> {
        let mut token = HANDLE::default();
        // SAFETY: a valid process handle and an out pointer for the token.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        // u64s so the buffer is aligned for TOKEN_USER.
        let mut buffer = vec![0u64; 64];
        let mut needed = 0u32;
        // SAFETY: the buffer is writable for the size given; the token is open.
        let read = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                (buffer.len() * 8) as u32,
                &mut needed,
            )
        };
        // SAFETY: opened above and closed once.
        let _ = unsafe { CloseHandle(token) };
        read.ok()?;
        // SAFETY: GetTokenInformation wrote a TOKEN_USER at the start of the
        // aligned buffer, whose Sid points inside the same buffer.
        let sid = unsafe { (*(buffer.as_ptr() as *const TOKEN_USER)).User.Sid };
        // SAFETY: a valid SID, as above.
        let length = unsafe { GetLengthSid(sid) } as usize;
        // SAFETY: the SID is `length` bytes long and lives in `buffer`.
        let bytes = unsafe { std::slice::from_raw_parts(sid.0 as *const u8, length) };
        Some(bytes.to_vec())
    }

    fn server_is_this_user(pipe: &File) -> bool {
        let mut pid = 0u32;
        // SAFETY: the handle is an open pipe client handle.
        if unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut pid) }.is_err() {
            return false;
        }
        // SAFETY: OpenProcess with a pid; a failure is handled.
        let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
        else {
            return false;
        };
        let theirs = process_user(process);
        // SAFETY: opened above and closed once.
        let _ = unsafe { CloseHandle(process) };
        // SAFETY: this process's pseudo handle needs no closing.
        let mine = process_user(unsafe { GetCurrentProcess() });
        matches!((theirs, mine), (Some(theirs), Some(mine)) if theirs == mine)
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    pub(super) fn connect() -> Option<std::fs::File> {
        None
    }
}

#[cfg(test)]
#[path = "desktop_tests.rs"]
mod tests;
