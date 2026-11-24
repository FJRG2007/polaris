use std::collections::HashMap;

use settings::macros::define_settings_group;
use settings::{RespectUserSyncSetting, SupportedPlatforms, SyncToCloud};

define_settings_group!(PaneSettings, settings: [
    should_dim_inactive_panes: ShouldDimInactivePanes {
        type: bool,
        default: false,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "appearance.panes.should_dim_inactive_panes",
        description: "Whether inactive panes are visually dimmed.",
    },
    focus_panes_on_hover: FocusPaneOnHover {
        type: bool,
        default: false,
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "appearance.panes.focus_pane_on_hover",
        description: "Whether panes are focused when hovered over.",
    },
    default_names_by_path: DefaultPaneNamesByPath {
        type: HashMap<String, String>,
        default: HashMap::new(),
        supported_platforms: SupportedPlatforms::ALL,
        sync_to_cloud: SyncToCloud::Globally(RespectUserSyncSetting::Yes),
        surface: settings::SettingSurfaces::GUI,
        private: false,
        toml_path: "appearance.panes.default_names_by_path",
        description: "Names for panes, keyed by working directory. A pane working in one of these directories, or anywhere inside it, takes that name until it is renamed.",
    }
]);

/// The name configured for a pane working in `path`, if there is one.
///
/// Keys match as directory prefixes, so a name set on a repository root also
/// covers everything inside it, and the longest key wins: a name on
/// `.../rook/app` takes precedence over one on `.../rook`. The prefix has to
/// end on a path component, so `/src/foo` is not covered by a key of `/src/f`.
pub fn default_pane_name_for_path<'a>(
    names_by_path: &'a HashMap<String, String>,
    path: &str,
) -> Option<&'a str> {
    let path = comparable(path);
    names_by_path
        .iter()
        .filter_map(|(directory, name)| {
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            let directory = comparable(directory);
            let rest = path.strip_prefix(&directory)?;
            (rest.is_empty() || rest.starts_with('/')).then_some((directory.len(), name))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, name)| name)
}

/// Puts a path in the one form the prefix comparison above can be done in:
/// a single separator, no trailing one, and folded case wherever the
/// filesystem folds it too, so a drive letter typed either way still matches.
fn comparable(path: &str) -> String {
    let path = path.replace('\\', "/");
    let path = path.trim_end_matches('/');
    if cfg!(target_os = "linux") {
        path.to_owned()
    } else {
        path.to_lowercase()
    }
}

#[cfg(test)]
#[path = "pane_tests.rs"]
mod tests;
