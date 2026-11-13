//! Whether a macOS app is signed with a Developer ID, which Squirrel.Mac requires
//! before it replaces an app: it checks the update against the running app's
//! signature, and an unsigned or ad-hoc signed app (every arm64 build is ad-hoc
//! signed at least) has no team to check it against.
//!
//! The Tauri updater checks its own minisign signature instead, so the beta does
//! not need this to update; it is here for the cutover, which has to know whether
//! the Electron app it replaces could have updated itself on macOS.
//!
//! The Rust twin of `desktop/src/main/mac-signature.ts`.

use std::path::Path;
use std::time::Duration;
use tokio::process::Command;

const CODESIGN: &str = "/usr/bin/codesign";
const CODESIGN_TIMEOUT: Duration = Duration::from_secs(30);

/// The team in `codesign --display --verbose` output, or `None` when the
/// signature names none (ad-hoc, or unsigned).
pub fn team_identifier(output: &str) -> Option<&str> {
    output
        .split(['\n', '\r'])
        .find_map(|line| {
            let team = line.strip_prefix("TeamIdentifier=")?.trim_end();
            (!team.is_empty() && !team.contains(char::is_whitespace)).then_some(team)
        })
        .filter(|team| *team != "not set")
}

/// `codesign` with these arguments: its output, or `None` when it failed.
async fn codesign(args: &[&std::ffi::OsStr]) -> Option<String> {
    let run = Command::new(CODESIGN)
        .args(args)
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(CODESIGN_TIMEOUT, run)
        .await
        .ok()?
        .ok()?;
    output.status.success().then(|| {
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

/// Whether the bundle's signature is valid and carries a team.
pub async fn developer_signed(bundle: &Path) -> bool {
    let bundle = bundle.as_os_str();
    if codesign(&["--verify".as_ref(), "--strict".as_ref(), bundle])
        .await
        .is_none()
    {
        return false;
    }
    codesign(&["--display".as_ref(), "--verbose=2".as_ref(), bundle])
        .await
        .is_some_and(|details| team_identifier(&details).is_some())
}
