//! Host tools installed the first time a feature uses them, not shipped in the
//! image.
//!
//! NUT and cifs-utils each pull in libraries with open advisories and no fixed
//! release (libmodbus and net-snmp for NUT, libwbclient for cifs-utils), and
//! most hosts never drive a UPS or mount an SMB share. So the image leaves them
//! out and this module installs one with `apk` the first time it is needed. The
//! repositories are the image's own `/etc/apk/repositories`, so what lands is
//! always from the Alpine branch the image is built on.
//!
//! A container starts from its image on every recreation, so the check runs on
//! every use rather than once. The packages and index of the last good install
//! are kept under `CACHE_ROOT` (a volume of its own), and an install that cannot
//! reach the network falls back to them: a UPS still comes back after a power
//! cut that took the internet down with it, as long as it was installed once.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Where each tool's last good install is kept, one directory per package.
pub const CACHE_ROOT: &str = "/var/cache/polaris-hostd/apk";
const APK: &str = "/sbin/apk";
/// Longest one `apk add` may run; a network that drops packets would otherwise
/// hold every caller that waits on it.
const INSTALL_DEADLINE: Duration = Duration::from_secs(5 * 60);
/// How long a failed install is answered from memory before it is tried again,
/// so a dozen mount requests on a machine with no network run `apk` once.
const RETRY_AFTER: Duration = Duration::from_secs(30);
/// Most of `apk`'s error output that is kept for the daemon's log.
const MAX_LOG: u64 = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Tool {
    /// Network UPS Tools: `upsd` and the `usbhid-ups`/`snmp-ups` drivers.
    Nut,
    /// `mount.cifs`, which SMB mounts need to resolve the server and read the
    /// credentials file. Only the unix mount path asks for it.
    #[cfg_attr(not(unix), allow(dead_code))]
    Cifs,
}

impl Tool {
    pub fn package(self) -> &'static str {
        match self {
            Tool::Nut => "nut",
            Tool::Cifs => "cifs-utils",
        }
    }

    /// A file the package installs, present exactly when the tool is usable.
    pub fn probe(self) -> &'static str {
        match self {
            Tool::Nut => "/usr/sbin/upsd",
            Tool::Cifs => "/usr/sbin/mount.cifs",
        }
    }

    /// The tool as the person reading the error knows it.
    fn label(self) -> &'static str {
        match self {
            Tool::Nut => "The UPS service",
            Tool::Cifs => "SMB support",
        }
    }

    pub fn installed(self) -> bool {
        Path::new(self.probe()).exists()
    }

    /// Installed, or installable here: an image whose package manager can
    /// fetch it. False only off Alpine (a development build).
    pub fn available(self) -> bool {
        self.installed() || Path::new(APK).exists()
    }

    /// What a reader sees while the first install is still running.
    pub fn installing_message(self) -> String {
        format!(
            "{} is being installed on first use; it is ready in a minute",
            self.label()
        )
    }

    fn failed_message(self) -> String {
        format!(
            "{} is downloaded the first time it is used, and the download failed. \
             Check that this machine can reach the internet, then try again",
            self.label()
        )
    }
}

/// Where a tool's install stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Ready,
    Installing,
    Failed(String),
}

#[derive(Default)]
struct Slot {
    installing: bool,
    failed: Option<(Instant, String)>,
}

fn slots() -> &'static Mutex<HashMap<Tool, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<Tool, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One `apk` at a time: a second one fails on the database lock.
static APK_RUNNING: Mutex<()> = Mutex::new(());

fn recent_failure(tool: Tool) -> Option<String> {
    let slots = slots().lock().unwrap_or_else(|p| p.into_inner());
    slots
        .get(&tool)
        .and_then(|s| s.failed.as_ref())
        .filter(|(at, _)| at.elapsed() < RETRY_AFTER)
        .map(|(_, why)| why.clone())
}

/// Make `tool` usable, installing it now if it is not. Blocks until it is
/// installed or the install failed; the error is a sentence for the reader.
pub fn ensure(tool: Tool) -> Result<(), String> {
    if tool.installed() {
        return Ok(());
    }
    if let Some(why) = recent_failure(tool) {
        return Err(why);
    }
    let _apk = APK_RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    // Another caller may have installed it while this one waited.
    if tool.installed() {
        return Ok(());
    }
    let result = install(tool);
    let mut slots = slots().lock().unwrap_or_else(|p| p.into_inner());
    let slot = slots.entry(tool).or_default();
    slot.failed = result
        .as_ref()
        .err()
        .map(|why| (Instant::now(), why.clone()));
    result
}

/// Where `tool` stands, starting its install in the background when it is
/// neither installed nor already being installed. For callers that answer on
/// a poll and must not hold a request open for a download.
pub fn start(tool: Tool) -> Status {
    if tool.installed() {
        return Status::Ready;
    }
    if let Some(why) = recent_failure(tool) {
        return Status::Failed(why);
    }
    {
        let mut slots = slots().lock().unwrap_or_else(|p| p.into_inner());
        let slot = slots.entry(tool).or_default();
        if slot.installing {
            return Status::Installing;
        }
        slot.installing = true;
    }
    thread::spawn(move || {
        let _ = ensure(tool);
        let mut slots = slots().lock().unwrap_or_else(|p| p.into_inner());
        slots.entry(tool).or_default().installing = false;
    });
    Status::Installing
}

/// The arguments after `apk` for one install. Online, the index is refreshed
/// and every package fetched is kept in `cache`; offline, only `cache` is read.
pub fn apk_argv(tool: Tool, cache: &Path, online: bool) -> Vec<String> {
    let cache = cache.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["--quiet".into(), "--no-progress".into()];
    if online {
        args.extend(["--update-cache".into(), "--cache-packages".into()]);
    } else {
        args.push("--no-network".into());
    }
    args.extend([
        "--cache-dir".into(),
        cache,
        "add".into(),
        tool.package().into(),
    ]);
    args
}

fn run_apk(args: &[String]) -> io::Result<bool> {
    let mut child = Command::new(APK)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()?;
    let reader = child.stderr.take().map(|stderr| {
        thread::spawn(move || {
            let mut output = Vec::new();
            let _ = stderr.take(MAX_LOG).read_to_end(&mut output);
            output
        })
    });
    let finished =
        crate::host_security::wait_all(&mut [&mut child], Instant::now() + INSTALL_DEADLINE)?;
    let output = reader.and_then(|r| r.join().ok()).unwrap_or_default();
    let ok = finished.as_ref().is_some_and(|s| s[0].success());
    if !ok {
        let said = String::from_utf8_lossy(&output);
        let said = if finished.is_none() {
            "timed out"
        } else {
            said.trim()
        };
        eprintln!("polaris-hostd: apk {} failed: {said}", args.join(" "));
    }
    Ok(ok)
}

/// Swap a finished install's cache in for the last one, so the kept cache is
/// always one whole install: no stale versions pile up across updates.
fn keep(fresh: &Path, kept: &Path) -> io::Result<()> {
    let old = kept.with_extension("old");
    let _ = fs::remove_dir_all(&old);
    if kept.exists() {
        fs::rename(kept, &old)?;
    }
    fs::rename(fresh, kept)?;
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

fn install(tool: Tool) -> Result<(), String> {
    let kept: PathBuf = Path::new(CACHE_ROOT).join(tool.package());
    let fresh = kept.with_extension("new");
    let _ = fs::remove_dir_all(&fresh);
    let online = fs::create_dir_all(&fresh)
        .and_then(|()| run_apk(&apk_argv(tool, &fresh, true)))
        .unwrap_or_else(|error| {
            eprintln!(
                "polaris-hostd: could not run apk for {}: {error}",
                tool.package()
            );
            false
        });
    if online && tool.installed() {
        if let Err(error) = keep(&fresh, &kept) {
            // The tool works; only the offline copy for the next start is missing.
            eprintln!(
                "polaris-hostd: could not keep the {} cache: {error}",
                tool.package()
            );
        }
        return Ok(());
    }
    let _ = fs::remove_dir_all(&fresh);
    if kept.is_dir() && run_apk(&apk_argv(tool, &kept, false)).unwrap_or(false) && tool.installed()
    {
        return Ok(());
    }
    Err(tool.failed_message())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_by_fixed_package_name_with_the_cache_and_no_shell() {
        let cache = Path::new("/var/cache/polaris-hostd/apk/nut.new");
        assert_eq!(
            apk_argv(Tool::Nut, cache, true),
            [
                "--quiet",
                "--no-progress",
                "--update-cache",
                "--cache-packages",
                "--cache-dir",
                "/var/cache/polaris-hostd/apk/nut.new",
                "add",
                "nut",
            ]
        );
        // Global options come before the applet, as apk 3 requires.
        let args = apk_argv(Tool::Cifs, Path::new("/c"), true);
        assert_eq!(args[args.len() - 2..], ["add", "cifs-utils"]);
    }

    #[test]
    fn offline_install_reads_only_the_kept_cache() {
        let args = apk_argv(
            Tool::Cifs,
            Path::new("/var/cache/polaris-hostd/apk/cifs-utils"),
            false,
        );
        assert!(args.contains(&"--no-network".to_string()));
        assert!(!args.contains(&"--update-cache".to_string()));
        assert!(!args.contains(&"--cache-packages".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("cifs-utils"));
    }

    #[test]
    fn probes_are_the_binaries_the_features_run() {
        assert_eq!(Tool::Nut.probe(), "/usr/sbin/upsd");
        assert_eq!(Tool::Cifs.probe(), "/usr/sbin/mount.cifs");
    }

    #[test]
    fn a_kept_cache_is_replaced_whole() {
        let root = std::env::temp_dir().join(format!("polaris-pkg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let kept = root.join("nut");
        let fresh = root.join("nut.new");
        fs::create_dir_all(&kept).unwrap();
        fs::write(kept.join("old.apk"), b"old").unwrap();
        fs::create_dir_all(&fresh).unwrap();
        fs::write(fresh.join("new.apk"), b"new").unwrap();
        keep(&fresh, &kept).unwrap();
        assert!(kept.join("new.apk").exists());
        assert!(!kept.join("old.apk").exists());
        assert!(!fresh.exists());
        assert!(!root.join("nut.old").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
