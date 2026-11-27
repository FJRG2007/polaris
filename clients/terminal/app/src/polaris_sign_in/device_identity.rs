//! The hashed machine id the instance's sessions screen groups a computer's
//! clients by. It is the same value Polaris Desktop and the command line send
//! (`dashboard/packages/core/src/device-identity-node.ts`): the operating
//! system's machine id (Windows' MachineGuid, macOS' IOPlatformUUID, systemd's
//! machine-id), hashed with a fixed label so the raw id never leaves the
//! computer.

use std::time::Duration;

use futures::future::{Either, select};
use ptermui::r#async::Timer;
use sha2::{Digest, Sha256};

/// Fixed label so this hash means "Polaris device" and nothing else.
const LABEL: &str = "polaris-device-v1";

/// How long a system tool may take to answer before the id is left out.
const TOOL_TIMEOUT: Duration = Duration::from_secs(3);

/// The identifier sent for a raw machine id.
pub(super) fn device_id_from(machine_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(LABEL.as_bytes());
    hasher.update([0u8]);
    hasher.update(machine_id.trim().to_lowercase().as_bytes());
    hex::encode(hasher.finalize())
}

fn is_uuid_like(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// MachineGuid out of `reg query` output.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(super) fn parse_windows_machine_guid(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        if parts.next()? != "MachineGuid" || parts.next()? != "REG_SZ" {
            return None;
        }
        let value = parts.next()?;
        is_uuid_like(value, 32, 36).then(|| value.to_owned())
    })
}

/// IOPlatformUUID out of `ioreg -rd1 -c IOPlatformExpertDevice` output.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) fn parse_mac_platform_uuid(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "\"IOPlatformUUID\"" {
            return None;
        }
        let value = value.trim().strip_prefix('"')?.strip_suffix('"')?;
        is_uuid_like(value, 32, 36).then(|| value.to_owned())
    })
}

/// A machine-id file's contents, when it holds one.
#[cfg_attr(any(target_os = "windows", target_os = "macos"), allow(dead_code))]
pub(super) fn parse_machine_id_file(contents: &str) -> Option<String> {
    let value = contents.trim();
    is_uuid_like(value, 8, 64).then(|| value.to_owned())
}

/// A program's standard output, or `None` when it could not run in time.
/// Argument array, no shell.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
async fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut command = command::r#async::Command::new(program);
    command.args(args);
    let output = Box::pin(command.output());
    match select(output, Box::pin(Timer::after(TOOL_TIMEOUT))).await {
        Either::Left((Ok(output), _)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        _ => None,
    }
}

async fn read_machine_id() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        // /reg:64 so a 32-bit build reads the key and not its empty redirect.
        let output = run(
            "reg",
            &[
                "query",
                "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
                "/v",
                "MachineGuid",
                "/reg:64",
            ],
        )
        .await?;
        parse_windows_machine_guid(&output)
    }
    #[cfg(target_os = "macos")]
    {
        let output = run("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"]).await?;
        parse_mac_platform_uuid(&output)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        for file in ["/etc/machine-id", "/var/lib/dbus/machine-id", "/etc/hostid"] {
            if let Ok(contents) = async_fs::read_to_string(file).await
                && let Some(id) = parse_machine_id_file(&contents)
            {
                return Some(id);
            }
        }
        None
    }
}

/// This computer's hashed machine id, or `None` when the system gives none.
pub(super) async fn device_id() -> Option<String> {
    read_machine_id().await.map(|id| device_id_from(&id))
}

#[cfg(test)]
#[path = "device_identity_tests.rs"]
mod tests;
