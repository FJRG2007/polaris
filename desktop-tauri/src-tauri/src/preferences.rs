//! The servers page's General and Advanced tabs (`connect.html`): the switches
//! Electron's settings window holds, read and written here for the servers
//! page only (`from(event, "connect")` in `ipc.ts`).

use crate::ipc::is_servers;
use crate::os_prefs::{read_settings, update_settings};
use crate::Outcome;
use polaris_client::settings::Settings;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewWindow};

/// What the tabs show (`preferences` in Electron's `index.ts`).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    open_at_login: bool,
    hardware_acceleration: bool,
    /// The saved setting differs from what this run uses.
    restart_pending: bool,
    /// Whether this system can turn it off at all (not macOS).
    hardware_acceleration_available: bool,
    minimize_to_tray: bool,
    start_minimized: bool,
    voice_widget: bool,
    voice_widget_game_only: bool,
    version: String,
}

impl Preferences {
    fn read(settings: &Settings, accelerated: bool, version: String) -> Self {
        Self {
            open_at_login: settings.open_at_login,
            hardware_acceleration: settings.hardware_acceleration,
            restart_pending: settings.hardware_acceleration != accelerated,
            hardware_acceleration_available: crate::hardware::AVAILABLE,
            minimize_to_tray: settings.minimize_to_tray,
            start_minimized: settings.start_minimized,
            voice_widget: settings.voice_widget,
            voice_widget_game_only: settings.voice_widget_game_only,
            version,
        }
    }
}

/// A switch by name (`z.object({ name: z.enum(PREFERENCE_TOGGLES), on: z.boolean() })`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToggleInput {
    name: String,
    on: bool,
}

/// What a relaunch says while a push would be cut short, or `None` to go ahead.
fn relaunch_refusal(pushing: bool) -> Option<&'static str> {
    pushing.then_some("A push is still running. Restart once it finishes.")
}

/// The answer to "Check for updates": the beta never updates itself, which is
/// Electron's answer for a build that does not (`{ kind: "unsupported" }`).
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateCheck {
    Unsupported,
}

#[tauri::command]
pub fn connect_preferences(app: AppHandle, window: WebviewWindow) -> Option<Preferences> {
    is_servers(&window).then(|| {
        Preferences::read(
            &read_settings(&app),
            crate::hardware::accelerated(),
            app.package_info().version.to_string(),
        )
    })
}

/// Saved only when the system took it.
#[tauri::command]
pub fn connect_open_at_login(app: AppHandle, window: WebviewWindow, open: bool) -> bool {
    let applied = is_servers(&window) && crate::login_item::set(&app, open).is_ok();
    crate::tray::refresh(&app);
    applied
}

/// Kept for the next start: the engine takes it only then.
#[tauri::command]
pub fn connect_hardware_acceleration(app: AppHandle, window: WebviewWindow, on: bool) -> bool {
    is_servers(&window)
        && crate::hardware::AVAILABLE
        && update_settings(&app, |settings| settings.hardware_acceleration = on).is_ok()
}

#[tauri::command]
pub fn connect_toggle(app: AppHandle, window: WebviewWindow, input: ToggleInput) -> bool {
    if !is_servers(&window) || read_settings(&app).toggle(&input.name).is_none() {
        return false;
    }
    let mut known = false;
    let saved = update_settings(&app, |settings| {
        known = settings.remember_toggle(&input.name, input.on);
    });
    crate::voice_widget::refresh(&app);
    crate::tray::refresh(&app);
    known && saved.is_ok()
}

/// Close and open the app again, unless a push would be cut short.
#[tauri::command]
pub fn connect_relaunch(app: AppHandle, window: WebviewWindow) -> Outcome {
    if !is_servers(&window) {
        return Outcome::error(crate::ipc::REFUSAL);
    }
    if let Some(refusal) = relaunch_refusal(app.state::<crate::developer::Developer>().pushing()) {
        return Outcome::error(refusal);
    }
    app.restart()
}

#[tauri::command]
pub fn connect_check_updates(window: WebviewWindow) -> Option<UpdateCheck> {
    is_servers(&window).then_some(UpdateCheck::Unsupported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_restart_is_pending_only_when_the_saved_setting_differs_from_this_run() {
        let mut settings = Settings::read(&json!({}));
        let read = |settings: &Settings, accelerated| {
            Preferences::read(settings, accelerated, "0.1.0".into())
        };
        assert!(!read(&settings, true).restart_pending);
        settings.hardware_acceleration = false;
        assert!(read(&settings, true).restart_pending);
        assert!(!read(&settings, false).restart_pending);
    }

    #[test]
    fn preferences_read_as_the_electron_page_expects() {
        let settings = Settings::read(&json!({}));
        let value =
            serde_json::to_value(Preferences::read(&settings, true, "0.1.0".into())).unwrap();
        assert_eq!(value["openAtLogin"], settings.open_at_login);
        assert_eq!(value["hardwareAcceleration"], true);
        assert_eq!(value["restartPending"], false);
        assert_eq!(value["minimizeToTray"], true);
        assert_eq!(value["startMinimized"], false);
        assert_eq!(value["voiceWidget"], true);
        assert_eq!(value["voiceWidgetGameOnly"], false);
        assert_eq!(value["version"], "0.1.0");
        assert_eq!(
            value["hardwareAccelerationAvailable"],
            cfg!(not(target_os = "macos"))
        );
    }

    #[test]
    fn a_toggle_names_a_switch_and_nothing_else() {
        let input: ToggleInput =
            serde_json::from_value(json!({ "name": "minimizeToTray", "on": false })).unwrap();
        let mut settings = Settings::read(&json!({}));
        assert!(settings.remember_toggle(&input.name, input.on));
        assert!(!settings.minimize_to_tray);
        assert!(serde_json::from_value::<ToggleInput>(
            json!({ "name": "voiceWidget", "on": true, "extra": 1 })
        )
        .is_err());
        assert!(serde_json::from_value::<ToggleInput>(
            json!({ "name": "voiceWidget", "on": "yes" })
        )
        .is_err());
        assert_eq!(settings.toggle("openAtLogin"), None);
        assert!(!settings.remember_toggle("hardwareAcceleration", false));
    }

    #[test]
    fn a_relaunch_waits_for_a_push() {
        assert_eq!(
            relaunch_refusal(true),
            Some("A push is still running. Restart once it finishes.")
        );
        assert_eq!(relaunch_refusal(false), None);
    }

    #[test]
    fn the_beta_says_it_does_not_update_itself() {
        assert_eq!(
            serde_json::to_value(UpdateCheck::Unsupported).unwrap(),
            json!({ "kind": "unsupported" })
        );
    }

    #[test]
    fn the_servers_page_calls_each_preference_and_only_its_window_is_granted_them() {
        let page = include_str!("../../ui/main.js");
        let local = include_str!("../capabilities/local.json");
        let manifest = include_str!("../build.rs");
        for command in [
            "connect_preferences",
            "connect_open_at_login",
            "connect_hardware_acceleration",
            "connect_toggle",
            "connect_relaunch",
            "connect_check_updates",
        ] {
            assert!(page.contains(&format!("\"{command}\"")), "{command}");
            assert!(manifest.contains(&format!("\"{command}\"")), "{command}");
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(local.contains(&format!("\"{permission}\"")), "{command}");
            assert!(!crate::ipc::POLARIS_COMMANDS.contains(&command.replace('_', "-").as_str()));
        }
    }
}
