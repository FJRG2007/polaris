use rook_core::features::FeatureFlag;
use settings::macros::define_settings_group;
use settings::{RespectUserSyncSetting, SupportedPlatforms, SyncToCloud};

use super::DriveSortOrder;

pub const HAS_AUTO_OPENED_WELCOME_FOLDER: &str = "HasAutoOpenedWelcomeFolder";

define_settings_group!(RookDriveSettings, settings: [
    sorting_choice: RookDriveSortingChoice {
        type: DriveSortOrder,
        default: DriveSortOrder::ByObjectType,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "rook_drive.sorting_choice",
        description: "The sort order for items in Rook Drive.",
    },
    sharing_onboarding_block_shown: RookDriveSharingOnboardingBlockShown {
        type: bool,
        default: false,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: true,
    },
    // Controls whether Rook Drive appears in the tools panel, command palette, and command search.
    enable_rook_drive: EnableRookDrive {
        type: bool,
        default: true,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "rook_drive.enabled",
        description: "Whether Rook Drive is enabled.",
    },
]);

impl RookDriveSettings {
    /// Returns whether Rook Drive is available for the current auth state.
    ///
    /// This is intentionally separate from the stored `enable_rook_drive`
    /// preference. Logged-out and anonymous users can retain their onboarding
    /// preference so Rook Drive appears automatically after signup, while the
    /// feature remains unavailable until then.
    pub fn is_rook_drive_available(app: &rookui::AppContext) -> bool {
        use rookui::SingletonEntity as _;
        !FeatureFlag::SkipFirebaseAnonymousUser.is_enabled()
            || !crate::auth::AuthStateProvider::as_ref(app)
                .get()
                .is_anonymous_or_logged_out()
    }
    /// Returns whether Rook Drive should be considered enabled.
    /// Returns `false` when the user is anonymous or fully logged out,
    /// regardless of the user setting.
    pub fn is_rook_drive_enabled(app: &rookui::AppContext) -> bool {
        use rookui::SingletonEntity as _;
        *Self::as_ref(app).enable_rook_drive && Self::is_rook_drive_available(app)
    }
}
