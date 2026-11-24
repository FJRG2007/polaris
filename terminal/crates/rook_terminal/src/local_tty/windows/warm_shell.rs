//! A PowerShell session started ahead of time, so the next new session does not wait for it.
//!
//! Windows PowerShell spends one to four seconds loading .NET and PSReadLine before it reaches the
//! first prompt, where Rook's init command reports in with `InitShell`, and every new tab waited
//! through all of it before bootstrapping could even begin. Each PowerShell spawn now starts a spare
//! behind it. The spare runs the same init command under a pseudoconsole that nothing reads yet, so
//! it parks at its first prompt with its `InitShell` report sitting in the pipe. The next request
//! for the same shell with the same environment takes it over, and reads that report exactly as if
//! the shell had just started.
//!
//! The spare is started in the home directory and without the pane's own variables (its session
//! UUID and focus URL). A claim writes an assignment of those, and of the requested directory into
//! the variable the bootstrap already reads it from, to a script it sources ahead of the bootstrap
//! itself, which also moves the process working directory there as a cold start would. The spare's
//! environment is compared with a freshly built one at claim time, so a change to the user's or the
//! machine's variables (a tool installed, PATH edited) or to a setting passed through the
//! environment discards the spare instead of handing out a stale shell.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rook_core::SessionId;
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};

use super::environment::{INITIAL_WORKING_DIR_NAME, get_shell_environment_variables};
use super::{SpawnedProcess, spawn_process};
use crate::focus_env::{FOCUS_URL_ENV, TERMINAL_SESSION_UUID_ENV};
use crate::local_tty::PtyOptions;
use crate::local_tty::shell::{DirectShellStarter, ShellStarter};
use crate::shell::{ShellType, shell_quote_arg};

/// How long a refill waits before starting the spare, so that it does not compete for the CPU with
/// the shell the user is waiting on.
const REFILL_DELAY: Duration = Duration::from_secs(2);

/// The variables each pane gets its own value of. A spare is started without them and given them
/// when claimed; any other extra variable makes a request ineligible.
const PER_SESSION_VARS: [&str; 2] = [TERMINAL_SESSION_UUID_ENV, FOCUS_URL_ENV];

static SPARE: Mutex<Option<WarmShell>> = Mutex::new(None);

/// Set while a refill is scheduled or running, so that a burst of spawns (restoring a window full
/// of tabs) starts one spare rather than one per tab.
static REFILLING: AtomicBool = AtomicBool::new(false);

/// Set once the app is shutting down, so that a refill already in flight does not leave a spare
/// behind that nothing will ever terminate.
static SHUT_DOWN: AtomicBool = AtomicBool::new(false);

pub(super) struct WarmShell {
    /// Always `Some` until the shell is claimed; `Drop` terminates whatever is left.
    process: Option<SpawnedProcess>,
    shell_path: PathBuf,
    environment_block: Vec<u16>,
    session_id: SessionId,
}

// The handles inside are owned by this value alone, and it is only ever used by one thread at a
// time: behind the `SPARE` mutex, or by whoever took it out.
unsafe impl Send for WarmShell {}

impl WarmShell {
    pub(super) fn session_id(&self) -> SessionId {
        self.session_id
    }

    pub(super) fn into_process(mut self) -> SpawnedProcess {
        self.process
            .take()
            .expect("a warm shell holds its process until it is claimed")
    }

    fn matches(&self, shell_path: &Path, environment_block: &[u16]) -> bool {
        self.shell_path == shell_path
            && self.environment_block == environment_block
            && !self.has_exited()
    }

    fn has_exited(&self) -> bool {
        self.process.as_ref().is_none_or(|process| {
            (unsafe { WaitForSingleObject(process.process_information.hProcess, 0) })
                == WAIT_OBJECT_0
        })
    }
}

impl Drop for WarmShell {
    fn drop(&mut self) {
        let Some(process) = self.process.take() else {
            return;
        };
        unsafe {
            let _ = TerminateProcess(process.process_information.hProcess, 1);
            // Close our end of the pipe before the pseudoconsole: with nothing reading it, closing
            // the pseudoconsole first could wait on output that can never be delivered.
            let _ = CloseHandle(process.server);
            process.conpty_api.close(process.pty_handle);
            let _ = CloseHandle(process.process_information.hThread);
            let _ = CloseHandle(process.process_information.hProcess);
        }
    }
}

/// Takes the spare for the shell `options` describes, if there is one that matches it.
pub(super) fn claim(options: &PtyOptions) -> Option<WarmShell> {
    let starter = eligible_starter(options)?;
    // Taken out unconditionally: a spare that does not match this request is stale for every
    // later request too, since they are all built from the same settings.
    let spare = lock_spare().take()?;
    if !spare.matches(starter.logical_shell_path(), &spare_environment(options)) {
        log::info!("Discarding a pre-started shell that no longer matches the requested one");
        return None;
    }
    log::info!(
        "Starting the session in a pre-started shell: {:?}",
        starter.logical_shell_path()
    );
    Some(spare)
}

/// Returns the input that gives a claimed spare what it was started without: the pane's own
/// variables and the directory the session should start in.
///
/// They are written to a script the input only dot-sources, the way the bootstrap itself is
/// loaded, because characters typed into a PowerShell pseudoconsole can be dropped and a long
/// line of assignments would then silently start the session with wrong values.
pub(super) fn claim_input(options: &PtyOptions, session_id: SessionId) -> Option<Vec<u8>> {
    let statements = claim_statements(options);
    if statements.is_empty() {
        return None;
    }
    let file_name = format!("rook-claim-{}.ps1", session_id.as_u64());
    let path = std::env::temp_dir().join(file_name);
    let line = match write_claim_script(&path, &statements) {
        Ok(()) => format!(
            ". {}",
            shell_quote_arg(&path.to_string_lossy(), ShellType::PowerShell)
        ),
        Err(err) => {
            log::warn!("Could not write the script for a pre-started shell: {err:#}");
            statements.join("; ")
        }
    };
    // The leading space matches how the bootstrap itself is sourced.
    Some(format!(" {line}\r").into_bytes())
}

/// The PowerShell statements that give a claimed spare the pane's own variables and move it to
/// the directory the session should start in.
fn claim_statements(options: &PtyOptions) -> Vec<String> {
    let mut assignments: Vec<(String, String)> = options
        .env_vars
        .iter()
        .filter(|(name, _)| is_per_session_var(name))
        .map(|(name, value)| {
            (
                name.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    assignments.sort();
    let start_dir = options
        .start_dir
        .as_ref()
        .filter(|dir| dir.is_dir())
        .map(|dir| dir.to_string_lossy().into_owned());
    if let Some(start_dir) = &start_dir {
        assignments.push((INITIAL_WORKING_DIR_NAME.to_owned(), start_dir.clone()));
    }
    let mut statements: Vec<String> = assignments
        .iter()
        .map(|(name, value)| {
            format!(
                "$env:{name} = {}",
                shell_quote_arg(value, ShellType::PowerShell)
            )
        })
        .collect();
    // A shell started cold has the directory as its process working directory too, which .NET
    // resolves relative paths against; the bootstrap only moves PowerShell's own location.
    if let Some(start_dir) = &start_dir {
        statements.push(format!(
            "try {{ [Environment]::CurrentDirectory = {} }} catch {{}}",
            shell_quote_arg(start_dir, ShellType::PowerShell)
        ));
    }
    statements
}

/// Writes `statements` to a new script at `path` that deletes itself once it has run.
fn write_claim_script(path: &Path, statements: &[String]) -> std::io::Result<()> {
    use std::io::Write as _;

    let quoted_path = shell_quote_arg(&path.to_string_lossy(), ShellType::PowerShell);
    // The byte order mark makes Windows PowerShell read the script as UTF-8 rather than in the
    // system code page, which would mangle any non-ASCII path or value.
    let mut script = String::from("\u{FEFF}");
    for statement in statements {
        script.push_str(statement);
        script.push_str("\r\n");
    }
    script.push_str(&format!(
        "Remove-Item -LiteralPath {quoted_path} -Force -ErrorAction Ignore\r\n"
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let written = file.write_all(script.as_bytes());
    drop(file);
    if written.is_err() {
        let _ = std::fs::remove_file(path);
    }
    written
}

/// Starts a spare for the shell `options` describes in the background, unless one is already
/// waiting or on its way.
pub(super) fn refill(options: &PtyOptions) {
    if SHUT_DOWN.load(Ordering::Acquire)
        || eligible_starter(options).is_none()
        || REFILLING.swap(true, Ordering::AcqRel)
    {
        return;
    }
    let options = options.clone();
    let scheduled = std::thread::Builder::new()
        .name("warm-shell".to_owned())
        .spawn(move || {
            std::thread::sleep(REFILL_DELAY);
            start_spare(&options);
            REFILLING.store(false, Ordering::Release);
        });
    if let Err(err) = scheduled {
        log::warn!("Could not schedule a pre-started shell: {err:#}");
        REFILLING.store(false, Ordering::Release);
    }
}

fn start_spare(options: &PtyOptions) {
    let Some(starter) = eligible_starter(options) else {
        return;
    };
    let environment_block = spare_environment(options);
    if lock_spare()
        .as_ref()
        .is_some_and(|spare| spare.matches(starter.logical_shell_path(), &environment_block))
    {
        return;
    }

    let Some(spare_starter) = starter.with_new_session_id() else {
        return;
    };
    let shell_path = spare_starter.logical_shell_path().to_owned();
    let session_id = spare_starter.session_id();
    let options = PtyOptions {
        shell_starter: ShellStarter::Direct(spare_starter),
        ..spare_options(options)
    };
    match spawn_process(&options, &environment_block) {
        Ok(process) => {
            let spare = WarmShell {
                process: Some(process),
                shell_path,
                environment_block,
                session_id,
            };
            // Dropped outside the lock: replacing a stale spare terminates its process, and so does
            // finding that the app started shutting down while this one was starting.
            let previous = {
                let mut slot = lock_spare();
                if SHUT_DOWN.load(Ordering::Acquire) {
                    Some(spare)
                } else {
                    slot.replace(spare)
                }
            };
            drop(previous);
        }
        Err(err) => log::warn!("Could not pre-start a shell: {err:#}"),
    }
}

/// Terminates the spare, if there is one, and stops new ones from being started. The spare lives in
/// a static that is never dropped, and it is spawned outside Rook's job object, so without this it
/// would outlive the app.
pub(super) fn shut_down() {
    SHUT_DOWN.store(true, Ordering::Release);
    let spare = lock_spare().take();
    drop(spare);
}

/// Returns the starter for the shell `options` describes if it is one a spare is kept for: a local
/// PowerShell started with Rook's standard arguments and no variables beyond the per-pane ones,
/// which is what an ordinary new tab asks for. A variable the shell could read while starting up
/// cannot be supplied afterwards, so sessions with others (agents, integrations) are left out; that
/// also keeps them from evicting the spare the next ordinary tab would use.
fn eligible_starter(options: &PtyOptions) -> Option<&DirectShellStarter> {
    let ShellStarter::Direct(starter) = &options.shell_starter else {
        return None;
    };
    let eligible = starter.shell_type() == ShellType::PowerShell
        && options.env_vars.keys().all(is_per_session_var)
        && starter.has_standard_args();
    eligible.then_some(starter)
}

fn is_per_session_var(name: &OsString) -> bool {
    name.to_str().is_some_and(|name| {
        PER_SESSION_VARS
            .iter()
            .any(|var| name.eq_ignore_ascii_case(var))
    })
}

/// The options a spare for `options` is started with: the requested ones without the starting
/// directory and the per-pane variables, which a claim supplies separately.
fn spare_options(options: &PtyOptions) -> PtyOptions {
    PtyOptions {
        start_dir: None,
        env_vars: HashMap::new(),
        ..options.clone()
    }
}

/// The environment a spare for `options` is started with.
fn spare_environment(options: &PtyOptions) -> Vec<u16> {
    get_shell_environment_variables(&spare_options(options))
}

fn lock_spare() -> MutexGuard<'static, Option<WarmShell>> {
    SPARE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
#[path = "warm_shell_tests.rs"]
mod tests;
