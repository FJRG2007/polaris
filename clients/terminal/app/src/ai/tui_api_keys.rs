use ai::api_keys::ApiKeyManager;
use anyhow::Context as _;
use ptermui::{ModelContext, SingletonEntity as _};
use uuid::Uuid;

use crate::pterm_managed_paths_watcher::{
    PtermManagedPathsWatcher, PtermManagedPathsWatcherEvent, repository_update_touches_path,
};

fn revision_file_path() -> std::path::PathBuf {
    pterm_core::paths::tui_config_local_dir().join("api_keys.revision")
}

/// Signals running TUI processes to reload their API keys from secure storage.
#[cfg_attr(not(feature = "tui"), allow(dead_code))]
pub fn notify_tui_api_keys_changed() -> anyhow::Result<()> {
    let path = revision_file_path();
    let parent = path
        .parent()
        .context("TUI API-key revision path has no parent directory")?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("Failed to create TUI config directory {}", parent.display()))?;
    std::fs::write(&path, Uuid::new_v4().to_string())
        .with_context(|| format!("Failed to update TUI API-key revision {}", path.display()))
}

/// Reloads the TUI-owned secure-storage namespace when another process changes it.
pub(crate) trait TuiApiKeyRefresher {
    fn subscribe_to_tui_api_key_changes(&mut self, ctx: &mut ModelContext<Self>)
    where
        Self: Sized;
}

impl TuiApiKeyRefresher for ApiKeyManager {
    fn subscribe_to_tui_api_key_changes(&mut self, ctx: &mut ModelContext<Self>) {
        ctx.subscribe_to_model(
            &PtermManagedPathsWatcher::handle(ctx),
            |manager, _, event, ctx| {
                let PtermManagedPathsWatcherEvent::FilesChanged(update) = event;
                if repository_update_touches_path(update, &revision_file_path()) {
                    manager.reload_keys_from_secure_storage(ctx);
                }
            },
        );
    }
}
