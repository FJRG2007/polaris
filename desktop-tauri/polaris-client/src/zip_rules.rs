//! What goes into a folder sent as a service's source, and how much of it.
//! Mirrors `desktop/src/main/zip-rules.ts`.
//!
//! The same rules the dashboard's browser zipper applies
//! (`dashboard/apps/web/src/app/(app)/apps/deploy/upload-source.tsx`), so a folder
//! picked here and one dropped in the browser arrive as the same zip: no
//! `node_modules`, no `.git`, no macOS resource forks or `.DS_Store`, and the same
//! two ceilings with the same words. A test reads the browser zipper to keep the
//! two in step.

/// The largest zip the server takes.
pub const MAX_ZIP: u64 = 200 * 1024 * 1024;
/// The most a folder may hold before it is zipped.
pub const MAX_FOLDER: u64 = 1024 * 1024 * 1024;

/// Folder names left out, with everything in them.
pub const SKIPPED: [&str; 3] = ["node_modules", ".git", "__MACOSX"];

pub const EMPTY_FOLDER: &str = "There are no files in that folder.";

/// Whether a path inside the picked folder, written with `/`, is left out. A
/// folder that matches is left out with everything in it.
pub fn skipped(path: &str) -> bool {
    path.split('/').any(|segment| SKIPPED.contains(&segment)) || path.ends_with(".DS_Store")
}

const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];

/// "1.5 GB" - the same arithmetic as `formatBytes` in `@polaris/core`, so a limit
/// reads the same here as it does in the dashboard.
pub fn format_bytes(bytes: u64) -> String {
    #[allow(clippy::cast_precision_loss)]
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let rounded = if unit == 0 {
        value
    } else {
        (value * 10.0).round() / 10.0
    };
    // JavaScript prints a whole number without a decimal point; so does this.
    format!("{rounded} {}", UNITS[unit])
}

/// "That folder holds more than 1 GB."
pub fn folder_too_large() -> String {
    format!("That folder holds more than {}.", format_bytes(MAX_FOLDER))
}

/// "Zipped, that folder is larger than 200 MB."
pub fn zip_too_large() -> String {
    format!(
        "Zipped, that folder is larger than {}.",
        format_bytes(MAX_ZIP)
    )
}
