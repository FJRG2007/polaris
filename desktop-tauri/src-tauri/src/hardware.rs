//! Hardware acceleration (`app.disableHardwareAcceleration()` in Electron's
//! `index.ts`), read once at start from the saved setting, since that is the
//! only moment each engine takes it: a change waits for a restart.
//!
//! - Windows: WebView2's `--disable-gpu`, given to every window through
//!   [`window`]. WebView2 refuses windows of one data folder with different
//!   arguments, so no window is built any other way (a test holds that).
//! - Linux: WebKitGTK's `WEBKIT_DISABLE_COMPOSITING_MODE`, set before the first
//!   webview exists.
//! - macOS: WKWebView has no public switch for it, so the setting is not
//!   offered there.

use polaris_client::settings::{Settings, SETTINGS_FILE};
use std::path::Path;
use std::sync::OnceLock;
use tauri::{Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// What this run uses, read once at start.
static ACCELERATED: OnceLock<bool> = OnceLock::new();

/// The arguments wry passes by default; setting arguments replaces them, so
/// they are kept.
const WRY_DEFAULT_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Whether this system can turn it off.
pub const AVAILABLE: bool = cfg!(any(windows, target_os = "linux"));

/// Read the setting from `settings.json` in `folder`, before any window, and
/// apply it to the engine. Called once, first thing in `main`.
pub fn start(folder: Option<&Path>) {
    let accelerated = folder
        .is_none_or(|folder| Settings::load(&folder.join(SETTINGS_FILE)).hardware_acceleration);
    let _ = ACCELERATED.set(accelerated);
    #[cfg(target_os = "linux")]
    if !accelerated {
        // Still one thread: nothing reads the environment at the same time.
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

/// Whether this run uses the graphics card.
pub fn accelerated() -> bool {
    *ACCELERATED.get().unwrap_or(&true)
}

/// The WebView2 arguments for a run, or `None` for wry's own.
pub fn browser_args(accelerated: bool) -> Option<String> {
    (!accelerated).then(|| format!("{WRY_DEFAULT_ARGS} --disable-gpu"))
}

/// Every window of the app, built with this run's engine arguments.
pub fn window<'a, R: Runtime, M: Manager<R>>(
    manager: &'a M,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, R, M> {
    let builder = WebviewWindowBuilder::new(manager, label, url);
    match browser_args(accelerated()) {
        Some(args) => builder.additional_browser_args(&args),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turned_off_keeps_wrys_arguments_and_adds_the_gpu_switch() {
        assert_eq!(browser_args(true), None);
        assert_eq!(
            browser_args(false).as_deref(),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu")
        );
    }

    #[test]
    fn every_window_is_built_with_the_runs_arguments() {
        let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for entry in std::fs::read_dir(folder).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "hardware.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            assert!(
                !source.contains("WebviewWindowBuilder::new("),
                "{} builds a window without hardware::window",
                path.display()
            );
        }
    }
}
