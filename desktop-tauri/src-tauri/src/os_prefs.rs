//! The two OS integrations a person switches on themselves in the beta - opening
//! with the computer, and being offered for `mailto:` links - kept in the
//! beta's `settings.json` beside the saved server. Both are off until switched
//! on, and each is applied again on every start so the system matches the file.

use crate::{settings_path, Settings};
use tauri::AppHandle;

/// The settings as saved, or the defaults when there are none yet.
pub fn read_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Change the saved settings, written whole to a temporary file and renamed over
/// the old one so a failed write never leaves half a file.
pub fn update_settings(app: &AppHandle, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
    let mut settings = read_settings(app);
    change(&mut settings);
    let path = settings_path(app)
        .map_err(|_| "This computer gave the app no folder to keep its settings in.".to_owned())?;
    let failed = |_| "The setting could not be saved on this computer.".to_owned();
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(failed)?;
    }
    let text = serde_json::to_string_pretty(&settings)
        .map_err(|_| "The setting could not be saved.".to_owned())?;
    let temporary = path.with_extension("json.prefs.tmp");
    std::fs::write(&temporary, text).map_err(failed)?;
    std::fs::rename(&temporary, &path).map_err(failed)
}
