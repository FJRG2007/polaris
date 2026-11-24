//! Windows implementation of login-item registration.
//!
//! Rook starts at sign-in through a Task Scheduler task with a logon trigger,
//! scoped to the current user and needing no elevation. Earlier builds used a
//! value under HKCU `Software\Microsoft\Windows\CurrentVersion\Run`, which
//! Explorer works through one entry at a time once the desktop is up: on a
//! machine with a long startup list, an entry near the end of it started six
//! minutes after sign-in while Rook itself took three seconds to open. A logon
//! task fires with the session instead, so it does not wait behind that queue.
//!
//! An existing Run value is moved to a task on the next launch, and the Run
//! value remains the fallback for a machine where a task cannot be registered.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use ::settings::Setting;
use command::blocking::Command;
use rook_core::channel::ChannelState;
use rook_errors::report_if_error;
use rookui::{AppContext, SingletonEntity};
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};

use crate::terminal::general_settings::GeneralSettings;

/// The registry subkey Explorer scans on sign-in to launch per-user startup apps.
const RUN_SUBKEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// Where Task Manager's Startup apps page records a Run entry the user turned off.
const STARTUP_APPROVED_RUN_SUBKEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

pub(super) fn maybe_register_app_as_login_item(ctx: &mut AppContext) {
    GeneralSettings::handle(ctx).update(ctx, |settings, ctx| {
        let add_app_as_login_item = *settings.add_app_as_login_item;
        let app_added_as_login_item = *settings.app_added_as_login_item;

        let exe = match current_exe_path() {
            Some(p) => p,
            None => {
                log::warn!("Could not resolve current exe; skipping login-item registration");
                return;
            }
        };

        let app_name = login_item_value_name();

        // Registry I/O and spawning `schtasks.exe` are sync and touch the disk -
        // run them off the UI thread to match the macOS path.
        ctx.spawn(
            async move {
                reconcile(
                    add_app_as_login_item,
                    app_added_as_login_item,
                    &app_name,
                    &exe,
                )
            },
            |settings, app_added_as_login_item, ctx| {
                if let Some(app_added_as_login_item) = app_added_as_login_item {
                    report_if_error!(
                        settings
                            .app_added_as_login_item
                            .set_value(app_added_as_login_item, ctx)
                    );
                }
            },
        );
    });
}

/// Brings the OS registration in line with the setting. Returns the new value
/// of `app_added_as_login_item`, or `None` to leave it as it is.
fn reconcile(
    add_app_as_login_item: bool,
    app_added_as_login_item: bool,
    app_name: &str,
    exe: &Path,
) -> Option<bool> {
    if !add_app_as_login_item {
        if let Err(err) = unregister_run_value(app_name) {
            // Don't flip app_added_as_login_item on failure - let a later
            // retoggle try again.
            log::warn!("Failed to unregister Rook as a login item: {err}");
            return None;
        }
        // Only a build that set app_added_as_login_item can have registered a
        // task, so a default install never spawns schtasks here.
        if app_added_as_login_item && let Err(err) = unregister_task(app_name) {
            log::warn!("Failed to remove Rook's sign-in task: {err}");
            return None;
        }
        return Some(false);
    }

    if app_added_as_login_item {
        // Already registered. Don't re-register - the user may have removed the
        // task through Task Scheduler, and re-adding it on every
        // launch would override that. The one thing still to do is move an
        // earlier build's Run value to a task, unless the user turned that
        // value off in Task Manager.
        if run_value_is_enabled(app_name) {
            match register_task(app_name, exe) {
                Ok(()) => {
                    if let Err(err) = unregister_run_value(app_name) {
                        log::warn!("Failed to remove Rook's old Run entry: {err}");
                    }
                }
                Err(err) => log::warn!("Failed to move Rook's Run entry to a sign-in task: {err}"),
            }
        }
        return None;
    }

    match register_task(app_name, exe) {
        Ok(()) => {
            if let Err(err) = unregister_run_value(app_name) {
                log::warn!("Failed to remove Rook's old Run entry: {err}");
            }
            Some(true)
        }
        Err(err) => {
            log::warn!("Failed to register Rook's sign-in task, using the Run key: {err}");
            match register_run_value(app_name, exe) {
                Ok(()) => Some(true),
                Err(err) => {
                    log::warn!("Failed to register Rook as a login item: {err}");
                    Some(false)
                }
            }
        }
    }
}

fn current_exe_path() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| dunce::canonicalize(p).ok())
}

/// Returns the per-channel name used for the `Run` value and the task.
///
/// Using the channel's application name keeps Dogfood / Preview / Stable installs
/// isolated (`Rook`, `RookPreview`, `RookDev`, etc.) so installing multiple
/// channels doesn't cause one to overwrite another's startup entry.
fn login_item_value_name() -> String {
    ChannelState::app_id().application_name().to_owned()
}

/// Task names share one namespace across every account on the machine, so the
/// user's SID keeps two accounts from overwriting each other's task - the
/// convention OneDrive's `OneDrive Startup Task-<SID>` follows.
///
/// NOTE: `script/windows/windows-installer.iss` removes tasks by this prefix on
/// uninstall.
fn task_name(app_name: &str, user_sid: &str) -> String {
    format!("{app_name} Startup Task-{user_sid}")
}

/// The task definition. The trigger has to name the user: a logon trigger for
/// any user needs elevation.
fn task_xml(user_sid: &str, exe: &Path) -> String {
    let user_sid = xml_escape(user_sid);
    let exe = xml_escape(&exe.display().to_string());
    let autostart_arg = rook_cli::AUTOSTART_ARG;
    // ExecutionTimeLimit: the default of three days would end Rook after it.
    // Priority: the default of 7 also lowers the process's I/O and memory
    // priority; 5 runs it as a normal app.
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user_sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user_sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>--{autostart_arg}</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Creates or replaces the sign-in task for the current user.
fn register_task(app_name: &str, exe: &Path) -> std::io::Result<()> {
    let user_sid = current_user_sid()?;
    let xml = task_xml(&user_sid, exe);

    // schtasks reads a UTF-16 file reliably, whatever the system code page.
    let mut contents = vec![0xFF, 0xFE];
    contents.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
    let mut file = tempfile::Builder::new()
        .prefix("rook-startup-task")
        .suffix(".xml")
        .tempfile()?;
    file.write_all(&contents)?;
    // Closes the file so schtasks can open it; the path is deleted on drop.
    let path = file.into_temp_path();

    run_schtasks(&[
        "/Create".as_ref(),
        "/TN".as_ref(),
        task_name(app_name, &user_sid).as_ref(),
        "/XML".as_ref(),
        path.as_os_str(),
        "/F".as_ref(),
    ])
}

/// Removes the current user's sign-in task. It is not an error for it to be
/// absent already.
///
/// Goes through the Task Scheduler API rather than schtasks, which reports a
/// missing task with the same exit code as any other failure and tells them
/// apart only through a localized message.
fn unregister_task(app_name: &str) -> std::io::Result<()> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, RPC_E_CHANGED_MODE};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::TaskScheduler::{ITaskService, TaskScheduler};
    use windows::Win32::System::Variant::VARIANT;
    use windows::core::{BSTR, HRESULT};

    struct ComGuard;
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    let task_name = task_name(app_name, &current_user_sid()?);
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        // A thread already in the multithreaded apartment can use COM as it is.
        let _guard = if hr.is_ok() {
            Some(ComGuard)
        } else if hr == RPC_E_CHANGED_MODE {
            None
        } else {
            return Err(windows::core::Error::from(hr).into());
        };

        let service: ITaskService = CoCreateInstance(&TaskScheduler, None, CLSCTX_INPROC_SERVER)?;
        let none = VARIANT::default();
        service.Connect(&none, &none, &none, &none)?;
        let folder = service.GetFolder(&BSTR::from("\\"))?;
        match folder.DeleteTask(&BSTR::from(task_name), 0) {
            Err(err) if err.code() == HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0) => Ok(()),
            result => result.map_err(Into::into),
        }
    }
}

fn run_schtasks(args: &[&std::ffi::OsStr]) -> std::io::Result<()> {
    // No CREATE_BREAKAWAY_FROM_JOB: schtasks is waited on, so it can share
    // Rook's job, and breaking away fails outright inside a job that forbids it.
    let output = Command::new(system_directory()?.join("schtasks.exe"))
        .creation_flags(0)
        .args(args)
        .output()?;
    if output.status.success() {
        return Ok(());
    }
    Err(std::io::Error::other(format!(
        "schtasks exited with {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    )))
}

/// `System32`, resolved by the OS rather than through `PATH`.
fn system_directory() -> std::io::Result<PathBuf> {
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;

    let mut buffer = [0u16; 260];
    let len = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if len == 0 || len > buffer.len() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
}

/// The SID of the user this process runs as, e.g. `S-1-5-21-...-1001`.
fn current_user_sid() -> std::io::Result<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows::core::PWSTR;

    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;

        // The first call only reports the size, so its error is expected.
        let mut len = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        // u64 elements give the buffer the alignment TOKEN_USER needs.
        let mut buffer = vec![0u64; (len as usize).div_ceil(size_of::<u64>())];
        let result = GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            len,
            &mut len,
        );
        let _ = CloseHandle(token);
        result?;

        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid)?;
        let string = sid.to_string();
        LocalFree(Some(HLOCAL(sid.0.cast())));
        string.map_err(std::io::Error::other)
    }
}

/// Whether an earlier build's Run value is present and not turned off in Task
/// Manager, which marks an entry disabled in `StartupApproved` by setting the
/// low bit of its first byte rather than deleting it.
fn run_value_is_enabled(value_name: &str) -> bool {
    run_value_is_enabled_in(
        HKEY_CURRENT_USER,
        RUN_SUBKEY,
        STARTUP_APPROVED_RUN_SUBKEY,
        value_name,
    )
}

fn run_value_is_enabled_in(
    hive: winreg::HKEY,
    run_subkey: &str,
    startup_approved_subkey: &str,
    value_name: &str,
) -> bool {
    let hkey = RegKey::predef(hive);
    let present = hkey
        .open_subkey(run_subkey)
        .and_then(|key| key.get_raw_value(value_name))
        .is_ok();
    let disabled = hkey
        .open_subkey(startup_approved_subkey)
        .and_then(|key| key.get_raw_value(value_name))
        .is_ok_and(|value| value.bytes.first().is_some_and(|flags| flags & 1 == 1));
    present && !disabled
}

/// Writes the startup registry value pointing at `exe` under `value_name`.
///
/// The path is wrapped in quotes so paths containing spaces (e.g.
/// `C:\Program Files\Rook\rook.exe`) are parsed as a single executable path.
fn register_run_value(value_name: &str, exe: &Path) -> std::io::Result<()> {
    register_run_value_in(HKEY_CURRENT_USER, RUN_SUBKEY, value_name, exe)
}

fn register_run_value_in(
    hive: winreg::HKEY,
    subkey: &str,
    value_name: &str,
    exe: &Path,
) -> std::io::Result<()> {
    let hkey = RegKey::predef(hive);
    let (run_key, _) = hkey.create_subkey(subkey)?;
    let command = format!("\"{}\" --{}", exe.display(), rook_cli::AUTOSTART_ARG);
    run_key.set_value(value_name, &command)
}

/// Removes the startup registry value under `value_name` if present. It is not
/// an error for the value to already be absent.
fn unregister_run_value(value_name: &str) -> std::io::Result<()> {
    unregister_run_value_in(HKEY_CURRENT_USER, RUN_SUBKEY, value_name)
}

fn unregister_run_value_in(
    hive: winreg::HKEY,
    subkey: &str,
    value_name: &str,
) -> std::io::Result<()> {
    let hkey = RegKey::predef(hive);
    let run_key = match hkey.open_subkey_with_flags(subkey, KEY_SET_VALUE) {
        Ok(k) => k,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    match run_key.delete_value(value_name) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
#[path = "windows_tests.rs"]
mod tests;
