//! One-time copy of a Rook install's settings and data into Polaris Terminal.
//!
//! Polaris Terminal is Rook renamed (docs/terminal-integration.md, "Settings
//! storage and user data"). Somebody who ran the released Rook build has their
//! settings in `~/.rook-oss` (or `~/.rook`) and their app state, `rook.sqlite`
//! included, in the per-user directories of the `dev.rook.RookOss` app id. On
//! the first launch of the released Polaris Terminal build, before anything
//! creates its own home directory, both are copied across.
//!
//! Copied, never moved: Rook may still be installed and run side by side.
//! Nothing that already exists on the Polaris side is overwritten. The home
//! directory is assembled under a temporary name and renamed into place last,
//! with the marker inside it, so an interrupted copy leaves no half-made home
//! directory behind and simply runs again on the next launch. The template is
//! `app/src/preview_config_migration.rs`.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use crate::channel::{Channel, ChannelState};
use crate::paths::{project_dirs_for_app_id, pterm_home_config_dir};

/// Written inside the new home directory once the copy is done; it names where
/// the settings came from.
pub const MIGRATION_MARKER: &str = ".migrated-from-rook";

/// Rook's home directories, most specific first: the released build's, then the
/// stable channel's that older installs kept.
const ROOK_HOME_DIRS: &[&str] = &[".rook-oss", ".rook"];

/// Rook's database file name and the one it becomes, with SQLite's side files.
const DATABASE_RENAMES: &[(&str, &str)] = &[
    ("rook.sqlite", "polaris-terminal.sqlite"),
    ("rook.sqlite-wal", "polaris-terminal.sqlite-wal"),
    ("rook.sqlite-shm", "polaris-terminal.sqlite-shm"),
];

/// What one migration should copy, as plain paths so it can be tested.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationPlan {
    /// Rook's home directories to try, in order; the first that exists is used.
    pub old_homes: Vec<PathBuf>,
    /// Polaris Terminal's home directory for this channel.
    pub new_home: PathBuf,
    /// Per-user data directories: (Rook's, Polaris Terminal's).
    pub data_dirs: Vec<(PathBuf, PathBuf)>,
}

/// What a migration did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// The Rook home directory that was copied, if any.
    pub home_from: Option<PathBuf>,
    /// Files copied, across the home and data directories.
    pub files: u32,
    /// Entries left alone: symbolic links, and anything already present.
    pub skipped: u32,
}

/// Runs the migration for the current process, once. A no-op on every channel
/// but the released (OSS) build, under a development data profile, or once the
/// Polaris Terminal home directory exists.
pub fn migrate_from_rook_if_needed() {
    let Some(plan) = plan_for_current_process() else {
        return;
    };
    match migrate(&plan) {
        Ok(Some(report)) => log::info!(
            "Copied Rook settings from {} into {}: {} files, {} left alone",
            report
                .home_from
                .as_deref()
                .map(Path::display)
                .map(|path| path.to_string())
                .unwrap_or_default(),
            plan.new_home.display(),
            report.files,
            report.skipped
        ),
        Ok(None) => {}
        Err(err) => log::warn!("Copying Rook settings failed, will retry next launch: {err}"),
    }
}

fn plan_for_current_process() -> Option<MigrationPlan> {
    // The released GUI only: the terminal UI front-end keeps its own folders.
    if ChannelState::channel() != Channel::Oss
        || ChannelState::data_profile().is_some()
        || ChannelState::app_id().application_name() != "PolarisTerminal"
    {
        return None;
    }
    let home = dirs::home_dir()?;
    let new_home = pterm_home_config_dir()?;
    let old_dirs = rook_project_dirs()?;
    let new_dirs = project_dirs_for_app_id(ChannelState::app_id(), None)?;
    Some(plan_from(&home, new_home, &old_dirs, &new_dirs))
}

/// The per-user directories of Rook's released build (`dev.rook.RookOss`),
/// named as Rook named them: on Linux its folders were `rook-oss`, not the
/// application name.
fn rook_project_dirs() -> Option<directories::ProjectDirs> {
    cfg_if::cfg_if! {
        if #[cfg(any(target_os = "linux", target_os = "freebsd"))] {
            directories::ProjectDirs::from("dev", "rook", "Rook-Oss")
        } else {
            directories::ProjectDirs::from("dev", "rook", "RookOss")
        }
    }
}

/// Pairs each of Rook's per-user directories with Polaris Terminal's, without
/// repeating a pair (several of them are the same folder on some systems) and
/// without pairing anything with the home directory, which is copied on its own.
pub fn plan_from(
    home: &Path,
    new_home: PathBuf,
    old: &directories::ProjectDirs,
    new: &directories::ProjectDirs,
) -> MigrationPlan {
    let mut data_dirs: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut pairs = vec![
        (old.data_dir(), new.data_dir()),
        (old.data_local_dir(), new.data_local_dir()),
        (old.config_dir(), new.config_dir()),
        (old.config_local_dir(), new.config_local_dir()),
    ];
    if let (Some(old_state), Some(new_state)) = (old.state_dir(), new.state_dir()) {
        pairs.push((old_state, new_state));
    }
    for (from, to) in pairs {
        if to == new_home || data_dirs.iter().any(|(_, seen)| seen == to) {
            continue;
        }
        data_dirs.push((from.to_owned(), to.to_owned()));
    }
    MigrationPlan {
        old_homes: ROOK_HOME_DIRS.iter().map(|name| home.join(name)).collect(),
        new_home,
        data_dirs,
    }
}

/// Copies what `plan` names. `Ok(None)` when there was nothing to do: the new
/// home directory already exists, or no Rook home directory does.
pub fn migrate(plan: &MigrationPlan) -> io::Result<Option<MigrationReport>> {
    if plan.new_home.exists() {
        return Ok(None);
    }
    let Some(old_home) = plan.old_homes.iter().find(|dir| dir.is_dir()) else {
        return Ok(None);
    };
    let mut report = MigrationReport {
        home_from: Some(old_home.clone()),
        ..MigrationReport::default()
    };

    // Data first: the home directory appearing is what marks the migration as
    // done, so it has to be the last thing that happens.
    for (from, to) in &plan.data_dirs {
        if from.is_dir() {
            std::fs::create_dir_all(to)?;
            copy_tree(from, to, true, &mut report)?;
        }
    }

    let staging = staging_path(&plan.new_home);
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;
    copy_tree(old_home, &staging, false, &mut report)?;
    std::fs::write(
        staging.join(MIGRATION_MARKER),
        format!("{}\n", old_home.display()),
    )?;
    match std::fs::rename(&staging, &plan.new_home) {
        Ok(()) => Ok(Some(report)),
        // Something else made the home directory meanwhile (another launch):
        // theirs stands, ours is dropped.
        Err(_) if plan.new_home.exists() => {
            std::fs::remove_dir_all(&staging)?;
            Ok(None)
        }
        Err(err) => Err(err),
    }
}

fn staging_path(new_home: &Path) -> PathBuf {
    let mut name: OsString = new_home.file_name().map(OsString::from).unwrap_or_default();
    name.push(".rook-copy");
    new_home.with_file_name(name)
}

/// The name a top-level entry takes on the Polaris side.
fn renamed(name: &OsString, top_level: bool) -> OsString {
    if top_level
        && let Some(text) = name.to_str()
        && let Some((_, to)) = DATABASE_RENAMES.iter().find(|(from, _)| *from == text)
    {
        return OsString::from(*to);
    }
    name.clone()
}

/// Copies `from` into `to` without overwriting anything, renaming the database
/// when `top_level` is set. Symbolic links are not followed: they are counted
/// as skipped.
fn copy_tree(
    from: &Path,
    to: &Path,
    top_level: bool,
    report: &mut MigrationReport,
) -> io::Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(renamed(&entry.file_name(), top_level));
        if kind.is_symlink() {
            report.skipped += 1;
        } else if kind.is_dir() {
            if target.exists() && !target.is_dir() {
                report.skipped += 1;
                continue;
            }
            std::fs::create_dir_all(&target)?;
            copy_tree(&entry.path(), &target, false, report)?;
        } else if kind.is_file() {
            if target.exists() {
                report.skipped += 1;
                continue;
            }
            std::fs::copy(entry.path(), &target)?;
            report.files += 1;
        } else {
            report.skipped += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "rook_migration_tests.rs"]
mod tests;
