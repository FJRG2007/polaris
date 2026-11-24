use pterm_core::features::FeatureFlag;
use settings::macros::define_settings_group;
use settings::{RespectUserSyncSetting, SupportedPlatforms, SyncToCloud};

use super::DriveSortOrder;

pub const HAS_AUTO_OPENED_WELCOME_FOLDER: &str = "HasAutoOpenedWelcomeFolder";

define_settings_group!(PtermDriveSettings, settings: [
    sorting_choice: PtermDriveSortingChoice {
        type: DriveSortOrder,
        default: DriveSortOrder::ByObjectType,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "pterm_drive.sorting_choice",
        description: "The sort order for items in Polaris Terminal Drive.",
    },
    sharing_onboarding_block_shown: PtermDriveSharingOnboardingBlockShown {
        type: bool,
        default: false,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: true,
    },
    // Controls whether Polaris Terminal Drive appears in the tools panel, command palette, and command search.
    enable_pterm_drive: EnablePtermDrive {
        type: bool,
        default: true,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "pterm_drive.enabled",
        description: "Whether Polaris Terminal Drive is enabled.",
    },
]);

impl PtermDriveSettings {
    /// Returns whether Polaris Terminal Drive is available for the current auth state.
    ///
    /// This is intentionally separate from the stored `enable_pterm_drive`
    /// preference. Logged-out and anonymous users can retain their onboarding
    /// preference so Polaris Terminal Drive appears automatically after signup, while the
    /// feature remains unavailable until then.
    pub fn is_pterm_drive_available(app: &ptermui::AppContext) -> bool {
        use ptermui::SingletonEntity as _;
        !FeatureFlag::SkipFirebaseAnonymousUser.is_enabled()
            || !crate::auth::AuthStateProvider::as_ref(app)
                .get()
                .is_anonymous_or_logged_out()
    }
    /// Returns whether Polaris Terminal Drive should be considered enabled.
    /// Returns `false` when the user is anonymous or fully logged out,
    /// regardless of the user setting.
    pub fn is_pterm_drive_enabled(app: &ptermui::AppContext) -> bool {
        use ptermui::SingletonEntity as _;
        *Self::as_ref(app).enable_pterm_drive && Self::is_pterm_drive_available(app)
    }
}
