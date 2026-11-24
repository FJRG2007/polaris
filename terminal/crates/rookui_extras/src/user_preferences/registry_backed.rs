use std::io;

use rook_errors::report_error;
use windows_registry::{CURRENT_USER, Key};
use windows_result::HRESULT;

/// Store user preferences in the Windows Registry.
/// Modeled after https://github.com/neovide/neovide/blob/main/src/windows_utils.rs .
use super::UserPreferences;

pub struct RegistryBackedPreferences {
    app_key_path: String,
}

static ROOK_REGISTRY_BASE_PATH: &str = "Software\\Rook.dev\\";
pub const KEY_NOT_FOUND_ERR: HRESULT = HRESULT::from_win32(0x80070002);

impl RegistryBackedPreferences {
    /// Construct a separate registry path for each channel (stable, dev, local, etc.)
    pub fn new(app_name: &str) -> Self {
        Self {
            app_key_path: ROOK_REGISTRY_BASE_PATH.to_owned() + app_name,
        }
    }

    /// Gets Rook's registry key, creating it if it does not already exist.
    fn get_rook_registry(&self) -> Result<Key, super::Error> {
        CURRENT_USER.create(self.app_key_path.clone()).map_err(|e| {
            report_error!(
                anyhow::Error::new(e.clone())
                    .context("unable to access Rook app key in Windows Registry")
            );
            super::Error::IoError(io::Error::from(e))
        })
    }
}

impl UserPreferences for RegistryBackedPreferences {
    fn read_value(&self, name: &str) -> Result<Option<String>, super::Error> {
        Ok(self.get_rook_registry()?.get_string(name).ok())
    }

    fn write_value(&self, key: &str, value: String) -> Result<(), super::Error> {
        self.get_rook_registry()?
            .set_string(key, value.as_str())
            .map_err(|e| super::Error::from(io::Error::from(e)))
    }

    fn remove_value(&self, key: &str) -> Result<(), super::Error> {
        match self.get_rook_registry()?.remove_value(key) {
            Ok(_) => Ok(()),
            // If the key doesn't exist, then treat removal of that nonexistent key as a success.
            Err(e) if e.code() == KEY_NOT_FOUND_ERR => Ok(()),
            Err(e) => Err(super::Error::from(io::Error::from(e))),
        }
    }
}
