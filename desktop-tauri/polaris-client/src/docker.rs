//! This computer's Docker, run the way `polaris deploy --local` runs it. Mirrors
//! `desktop/src/main/docker.ts`.
//!
//! Every command is spawned with an argument list, never through a shell, so a
//! folder or tag with a space or a quote in it is one argument and nothing else.
//!
//! An app opened from the macOS Dock or Finder does not get the PATH a terminal
//! has, and `/usr/local/bin` - where Docker Desktop links `docker` - is not on
//! it. The usual places are added for the child, after whatever PATH there is.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// How many of the last lines a run keeps, for saying why it failed.
const TAIL_LINES: usize = 20;
/// The longest a line is held while it has no end; past this it is let out as is.
const MAX_LINE: usize = 64 * 1024;
/// How long `docker version` may take to answer.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// The PATH Docker is run with: this process's, with the places Docker is
/// installed to on the end. `None` on Windows, whose installs put Docker on the
/// system PATH, which a Windows app does get, so it is left alone there.
pub fn docker_path(base: Option<&OsStr>, platform: &str, home: &Path) -> Option<OsString> {
    if platform == "windows" {
        return None;
    }
    let extra: Vec<String> = if platform == "macos" {
        vec![
            "/usr/local/bin".into(),
            "/opt/homebrew/bin".into(),
            format!(
                "{}/.docker/bin",
                home.to_string_lossy().trim_end_matches('/')
            ),
        ]
    } else {
        vec![
            "/usr/local/bin".into(),
            "/usr/bin".into(),
            "/snap/bin".into(),
        ]
    };
    let base = base
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut parts: Vec<String> = base
        .split(':')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    for dir in extra {
        if !parts.contains(&dir) {
            parts.push(dir);
        }
    }
    Some(OsString::from(parts.join(":")))
}

fn home() -> std::path::PathBuf {
    std::env::var_os("HOME").map(Into::into).unwrap_or_default()
}

/// A command with Docker's PATH, no window, nothing on its input, and killed when
/// it is dropped.
pub fn command(program: impl AsRef<OsStr>, args: &[OsString]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = docker_path(
        std::env::var_os("PATH").as_deref(),
        std::env::consts::OS,
        &home(),
    ) {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command
}

/// The arguments of `docker build`, as the CLI passes them.
pub fn build_args(image: &str, context: &OsStr, platform: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["build".into(), "-t".into(), image.into()];
    if !platform.is_empty() {
        args.push("--platform".into());
        args.push(platform.into());
    }
    args.push(context.to_owned());
    args
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    /// `None` when it was ended by a signal.
    pub code: Option<i32>,
    /// The last lines it printed, for saying why it failed.
    pub tail: Vec<String>,
}

/// Splits printed bytes into lines on `\r\n`, `\n` or `\r`, as the Electron app
/// does, holding the unfinished end for the next chunk.
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
    newline_only: bool,
}

impl Lines {
    /// Lines that end at a line feed only; a carriage return stays in the line.
    pub fn newline_only() -> Self {
        Self {
            pending: Vec::new(),
            newline_only: true,
        }
    }

    pub fn push(&mut self, chunk: &[u8], mut emit: impl FnMut(String)) {
        for &byte in chunk {
            match byte {
                b'\n' if !self.newline_only && self.pending.last() == Some(&b'\r') => {
                    self.pending.pop();
                    emit(String::from_utf8_lossy(&self.pending).into_owned());
                    self.pending.clear();
                }
                b'\n' => {
                    emit(String::from_utf8_lossy(&self.pending).into_owned());
                    self.pending.clear();
                }
                _ => {
                    if !self.newline_only && self.pending.last() == Some(&b'\r') {
                        self.pending.pop();
                        emit(String::from_utf8_lossy(&self.pending).into_owned());
                        self.pending.clear();
                    }
                    self.pending.push(byte);
                    if self.pending.len() >= MAX_LINE {
                        emit(String::from_utf8_lossy(&self.pending).into_owned());
                        self.pending.clear();
                    }
                }
            }
        }
    }

    pub fn finish(&mut self, mut emit: impl FnMut(String)) {
        if !self.newline_only && self.pending.last() == Some(&b'\r') {
            self.pending.pop();
            emit(String::from_utf8_lossy(&self.pending).into_owned());
        } else if !self.pending.is_empty() {
            emit(String::from_utf8_lossy(&self.pending).into_owned());
        }
        self.pending.clear();
    }
}

async fn read_some(
    stream: &mut Option<impl AsyncRead + Unpin>,
    buffer: &mut [u8],
) -> io::Result<usize> {
    match stream {
        Some(stream) => stream.read(buffer).await,
        None => std::future::pending().await,
    }
}

/// Run a command, handing each line of its output to `on_line` as it is printed.
/// Answers when it exits; fails when it could not be started, and with
/// `ErrorKind::Interrupted` when `cancel` ended it.
pub async fn run(
    program: impl AsRef<OsStr>,
    args: &[OsString],
    cwd: Option<&Path>,
    cancel: &CancellationToken,
    mut on_line: impl FnMut(&str),
) -> io::Result<Run> {
    let mut command = command(program, args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut tail: Vec<String> = Vec::new();
    let mut lines = Lines::default();
    let mut emit = |line: String| {
        on_line(&line);
        tail.push(line);
        if tail.len() > TAIL_LINES {
            tail.remove(0);
        }
    };
    let (mut out_buffer, mut err_buffer) = (vec![0u8; 16 * 1024], vec![0u8; 16 * 1024]);
    while stdout.is_some() || stderr.is_some() {
        tokio::select! {
            () = cancel.cancelled() => {
                let _ = child.kill().await;
                return Err(io::Error::new(io::ErrorKind::Interrupted, "canceled"));
            }
            read = read_some(&mut stdout, &mut out_buffer) => match read {
                Ok(0) | Err(_) => stdout = None,
                Ok(count) => lines.push(&out_buffer[..count], &mut emit),
            },
            read = read_some(&mut stderr, &mut err_buffer) => match read {
                Ok(0) | Err(_) => stderr = None,
                Ok(count) => lines.push(&err_buffer[..count], &mut emit),
            },
        }
    }
    let status = tokio::select! {
        () = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err(io::Error::new(io::ErrorKind::Interrupted, "canceled"));
        }
        status = child.wait() => status?,
    };
    lines.finish(&mut emit);
    Ok(Run {
        code: status.code(),
        tail,
    })
}

/// Whether Docker is there and its engine is answering; if not, what to do.
pub async fn docker_ready(program: impl AsRef<OsStr>) -> Result<(), String> {
    let cancel = CancellationToken::new();
    let args: Vec<OsString> = ["version", "--format", "{{.Server.Version}}"]
        .into_iter()
        .map(OsString::from)
        .collect();
    let answer =
        tokio::time::timeout(READY_TIMEOUT, run(program, &args, None, &cancel, |_| {})).await;
    match answer {
        Ok(Ok(run)) if run.code == Some(0) => Ok(()),
        Ok(Ok(_)) => Err(
            "Docker is installed but its engine is not running. Start Docker, then try again."
                .into(),
        ),
        Ok(Err(error)) if error.kind() == io::ErrorKind::NotFound => {
            Err("Docker is not installed on this computer, so nothing can be built here.".into())
        }
        Ok(Err(_)) => Err("Docker could not be started on this computer.".into()),
        Err(_) => Err("Docker did not answer in time. Check that it is running.".into()),
    }
}
