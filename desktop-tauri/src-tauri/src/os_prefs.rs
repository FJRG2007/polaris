//! The two OS integrations a person switches on themselves in the beta - opening
//! with the computer, and being offered for `mailto:` links - kept in the
//! beta's `settings.json` (`polaris_client::settings::Settings`) beside the
//! servers. Each is applied again on every start so the system matches the file.

use polaris_client::settings::Settings;
use tauri::AppHandle;

/// The settings as saved, or the defaults when there are none yet.
pub fn read_settings(app: &AppHandle) -> Settings {
    crate::shared(app).settings()
}

/// Change the saved settings, one writer at a time, written whole to a
/// temporary file and renamed over the old one so a failed write never leaves
/// half a file.
pub fn update_settings(app: &AppHandle, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    crate::shared(app).change_settings(change, "The setting could not be saved on this computer.")
}
