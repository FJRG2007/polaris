//! Opening with the computer (`desktop/src/main/login-item.ts`), through
//! `tauri-plugin-autostart`: a `Run` entry on Windows, a Launch Agent on macOS
//! and an autostart desktop file on Linux, each named after the beta so the
//! Electron app's own entry is never touched.
//!
//! The setting is the shared `Settings::open_at_login`, off by default in the beta, unlike the
//! Electron app. A development run has no business starting with the computer,
//! so it never writes the entry.

use crate::os_prefs::{read_settings, update_settings};
use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// On the command line of a start the computer made, so the app can tell it
/// apart from somebody opening it.
pub const LOGIN_ARG: &str = "--hidden";

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![LOGIN_ARG]))
}

/// Whether this run was started by signing in to the computer.
pub fn started_at_login(argv: &[String]) -> bool {
    argv.iter().any(|arg| arg == LOGIN_ARG)
}

/// Make the system match the setting. Answers whether it took; a preference
/// that could not be written never stops the app opening.
pub fn apply(app: &AppHandle, open: bool) -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    let launcher = app.autolaunch();
    let result = if open {
        launcher.enable()
    } else if launcher.is_enabled().unwrap_or(false) {
        launcher.disable()
    } else {
        Ok(())
    };
    if let Err(error) = &result {
        eprintln!("polaris: opening with the computer could not be set: {error}");
    }
    result.is_ok()
}

/// Apply the saved setting, on every start.
pub fn restore(app: &AppHandle) {
    apply(app, read_settings(app).open_at_login);
}

/// Switch it from the tray. The setting is saved only when the system took it.
pub fn set(app: &AppHandle, open: bool) -> Result<(), String> {
    if !apply(app, open) {
        return Err("Opening with the computer could not be changed.".to_owned());
    }
    update_settings(app, |settings| settings.open_at_login = open)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_the_computer_made_is_told_apart() {
        let argv = |args: &[&str]| args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>();
        assert!(started_at_login(&argv(&["polaris", "--hidden"])));
        assert!(!started_at_login(&argv(&["polaris"])));
        assert!(!started_at_login(&argv(&["polaris", "polaris://open"])));
    }
}
