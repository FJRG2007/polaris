//! Whether the Polaris this terminal is signed in to may change it through the
//! relay (docs/terminal-integration.md, "Remote control").
//!
//! Off by default. While it is off the relay only answers read-only requests
//! (lists, inspections, watching a pane); typing into a shell, opening
//! panes, changing settings and every other action needs it on. It is
//! separate from Settings > Scripting, which governs local processes.
use settings::macros::define_settings_group;
use settings::{SupportedPlatforms, SyncToCloud};

define_settings_group!(PolarisControlSettings,
    settings: [
        allow_polaris_control: AllowPolarisControl {
            type: bool,
            default: false,
            supported_platforms: SupportedPlatforms::DESKTOP,
            // A grant for this computer only: never carried to another device.
            sync_to_cloud: SyncToCloud::Never,
            surface: settings::SettingSurfaces::GUI,
            private: true,
            storage_key: "AllowPolarisControl",
        },
    ]
);

impl PolarisControlSettings {
    /// Whether the signed-in Polaris may run actions that change this terminal.
    pub fn allows_changes(&self) -> bool {
        *self.allow_polaris_control
    }
}
