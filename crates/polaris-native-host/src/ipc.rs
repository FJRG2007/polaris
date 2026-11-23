//! The local connection to the running desktop app, and the checks that it
//! really is this user's desktop app before a nonce is handed to it.
//!
//! - macOS and Linux: a Unix socket in a directory only this user may enter
//!   (owned by this uid, mode 0700). Anything else at that path - another
//!   owner, wider permissions, a symlink - is treated as no desktop at all.
//! - Windows: a named pipe whose name carries the user name. Pipe names are
//!   machine-wide, so after connecting, the process serving the pipe must run
//!   as this same user (its token's SID) or nothing is sent. The desktop app
//!   creates the pipe with the creating user's default DACL, under which only
//!   that user, SYSTEM and administrators may write to it.
//!
//! `desktop/src/main/native-host/ipc-path.ts` computes the same locations.

use std::io::{Read, Write};

/// Why there is nobody to talk to.
#[derive(Debug)]
pub enum IpcError {
    /// Nothing is listening: the desktop app is not running.
    Absent,
    /// Something is listening that is not this user's desktop app.
    Untrusted(&'static str),
}

pub trait Duplex: Read + Write {}
impl<T: Read + Write> Duplex for T {}

/// The user name as it appears in the endpoint name: ASCII letters and digits
/// (lowercased), `.`, `-` and `_` kept, every other character turned into `_`.
#[cfg(any(windows, test))]
pub fn endpoint_user(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(unix)]
pub use unix::connect;
#[cfg(windows)]
pub use windows::connect;

#[cfg(unix)]
pub mod unix {
    use super::{Duplex, IpcError};
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    /// The directory the desktop app listens in, from the environment given.
    pub fn socket_dir(
        macos: bool,
        home: Option<&str>,
        xdg_config_home: Option<&str>,
    ) -> Option<PathBuf> {
        let home = home.filter(|h| h.starts_with('/'));
        let base = if macos {
            Path::new(home?).join("Library/Application Support")
        } else {
            match xdg_config_home.filter(|x| x.starts_with('/')) {
                Some(xdg) => PathBuf::from(xdg),
                None => Path::new(home?).join(".config"),
            }
        };
        Some(base.join("Polaris").join("native-host"))
    }

    /// Whether a directory with this owner and mode is private to `uid`.
    pub fn private_to(uid: u32, owner: u32, mode: u32, is_dir: bool) -> bool {
        is_dir && owner == uid && mode & 0o077 == 0
    }

    pub fn connect() -> Result<Box<dyn Duplex>, IpcError> {
        let home = std::env::var("HOME").ok();
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let dir = socket_dir(cfg!(target_os = "macos"), home.as_deref(), xdg.as_deref())
            .ok_or(IpcError::Absent)?;
        // symlink_metadata: a symlink is refused, never followed.
        let meta = std::fs::symlink_metadata(&dir).map_err(|_| IpcError::Absent)?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let uid = unsafe { libc::geteuid() };
        if !private_to(uid, meta.uid(), meta.mode(), meta.file_type().is_dir()) {
            return Err(IpcError::Untrusted(
                "the socket's folder is not private to this user",
            ));
        }
        let stream = UnixStream::connect(dir.join("desktop.sock")).map_err(|_| IpcError::Absent)?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        Ok(Box::new(stream))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn macos_lives_under_application_support() {
            let dir = socket_dir(true, Some("/Users/a"), Some("/x")).unwrap();
            assert_eq!(
                dir,
                PathBuf::from("/Users/a/Library/Application Support/Polaris/native-host")
            );
        }

        #[test]
        fn linux_follows_xdg_config_home_when_absolute() {
            assert_eq!(
                socket_dir(false, Some("/home/a"), Some("/cfg")).unwrap(),
                PathBuf::from("/cfg/Polaris/native-host")
            );
            assert_eq!(
                socket_dir(false, Some("/home/a"), Some("relative")).unwrap(),
                PathBuf::from("/home/a/.config/Polaris/native-host")
            );
            assert_eq!(socket_dir(false, None, None), None);
        }

        #[test]
        fn only_a_0700_directory_of_this_user_is_private() {
            assert!(private_to(501, 501, 0o40700, true));
            assert!(!private_to(501, 502, 0o40700, true));
            assert!(!private_to(501, 501, 0o40750, true));
            assert!(!private_to(501, 501, 0o40707, true));
            assert!(!private_to(501, 501, 0o100600, false));
        }
    }
}

#[cfg(windows)]
pub mod windows {
    use super::{endpoint_user, Duplex, IpcError};
    use std::fs::{File, OpenOptions};
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_PIPE_BUSY, HANDLE};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

    pub fn pipe_name(user: &str) -> String {
        format!(
            r"\\.\pipe\polaris-desktop-native-host-{}",
            endpoint_user(user)
        )
    }

    fn user_name() -> Option<String> {
        let mut buf = [0u16; 257];
        let mut len = buf.len() as u32;
        // SAFETY: buf holds `len` u16s and GetUserNameW writes at most that many.
        if unsafe { GetUserNameW(buf.as_mut_ptr(), &mut len) } == 0 || len == 0 {
            return None;
        }
        // `len` counts the terminating NUL.
        Some(String::from_utf16_lossy(&buf[..len as usize - 1]))
    }

    /// A TOKEN_USER for the user a process runs as, in a buffer aligned for it.
    fn token_user(process: HANDLE) -> Option<Vec<u64>> {
        let mut token: HANDLE = std::ptr::null_mut();
        // SAFETY: a valid process handle and an out pointer for the token.
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return None;
        }
        let mut buf = vec![0u64; 64];
        let mut needed = 0u32;
        // SAFETY: buf is writable for 512 bytes; the token is open.
        let ok = unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buf.as_mut_ptr().cast(),
                (buf.len() * 8) as u32,
                &mut needed,
            )
        };
        // SAFETY: the token was opened above and is closed once.
        unsafe { CloseHandle(token) };
        (ok != 0).then_some(buf)
    }

    fn same_user(a: &[u64], b: &[u64]) -> bool {
        // SAFETY: both buffers hold a TOKEN_USER written by GetTokenInformation,
        // 8-byte aligned, whose Sid points inside the same buffer.
        unsafe {
            let a = &*(a.as_ptr() as *const TOKEN_USER);
            let b = &*(b.as_ptr() as *const TOKEN_USER);
            EqualSid(a.User.Sid, b.User.Sid) != 0
        }
    }

    fn server_is_this_user(pipe: &File) -> bool {
        let mut pid = 0u32;
        // SAFETY: the handle is an open pipe client handle.
        if unsafe { GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) } == 0 {
            return false;
        }
        // SAFETY: OpenProcess with a pid; a null result is handled.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return false;
        }
        let theirs = token_user(process);
        // SAFETY: opened above, closed once.
        unsafe { CloseHandle(process) };
        // SAFETY: the pseudo handle of this process needs no closing.
        let mine = token_user(unsafe { GetCurrentProcess() });
        matches!((theirs, mine), (Some(t), Some(m)) if same_user(&t, &m))
    }

    pub fn connect() -> Result<Box<dyn Duplex>, IpcError> {
        let name = pipe_name(&user_name().ok_or(IpcError::Absent)?);
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain([0])
            .collect();
        for _ in 0..3 {
            match OpenOptions::new().read(true).write(true).open(&name) {
                Ok(pipe) => {
                    if !server_is_this_user(&pipe) {
                        return Err(IpcError::Untrusted("the pipe is served by another user"));
                    }
                    return Ok(Box::new(pipe));
                }
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    // SAFETY: a NUL-terminated wide string.
                    unsafe { WaitNamedPipeW(wide.as_ptr(), 2000) };
                }
                Err(_) => return Err(IpcError::Absent),
            }
        }
        Err(IpcError::Absent)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn the_pipe_name_carries_the_user() {
            assert_eq!(
                pipe_name("Ana María"),
                r"\\.\pipe\polaris-desktop-native-host-ana_mar_a"
            );
        }

        #[test]
        fn this_process_is_its_own_user() {
            // SAFETY: the pseudo handle of this process needs no closing.
            let mine = token_user(unsafe { GetCurrentProcess() }).unwrap();
            assert!(same_user(&mine, &mine));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::endpoint_user;

    #[test]
    fn endpoint_user_keeps_only_safe_characters() {
        assert_eq!(endpoint_user("Ana.María-01_x"), "ana.mar_a-01_x");
        assert_eq!(endpoint_user(r"DOMAIN\user"), "domain_user");
    }
}
