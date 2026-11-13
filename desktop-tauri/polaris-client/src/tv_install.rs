//! Installing Polaris TV on a set on this network, with no terminal. The Rust
//! twin of `desktop/src/main/tv-install.ts`.
//!
//! What this keeps from the launcher's own PROMPT.md: a backup before the first
//! change, nothing uninstalled or disabled, the set's own launcher left enabled so
//! Home always has a way back, Home confirmed rather than assumed, and network and
//! USB debugging switched off afterwards with only a refused connection on port
//! 5555 counting as closed - or, over a USB cable, the TV no longer offering ADB.
//!
//! Over the network or over a USB cable: the TV's own Wireless debugging can be
//! one a set switches straight back off, and a cable needs none of it.
//!
//! What it does not: PROMPT.md's closing also revokes USB debugging authorisations,
//! checks the Wireless debugging port, reboots the set and checks again. Nobody
//! asked this window to restart their TV, so those stay with the tools in `tv/`,
//! as does debloating, which needs a person's choices per set.
//!
//! Differences from the Electron module, none visible on screen: the ADB key is
//! kept in the system's credential store rather than a 0600 file (held for this
//! run only where the system has no store), and a cancel drops a connection under
//! way instead of closing it from outside.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::sync::watch;

use crate::adb_client::{
    android_public_key, new_adb_key, tcp_link, AdbConnection, AdbError, AdbLink, AdbOptions,
    StreamLink, KEY_COMMENT,
};
use crate::adb_pairing::{
    adb_certificate, pair_tv, read_pairing_code, PairOptions, PairingError, PairingFailure,
    TlsIdentity,
};
use crate::tv_address::read_tv_address;
use crate::tv_mdns::{browse_tvs, merge_found, names_of, sighting_of, TvAnnouncement};
use crate::tv_path::{
    choose_path, lists_package, TvEdition, TvHomeRule, TvIdentity, TvPath, TvRoute, TvSighting,
    HOME_GUARD_PACKAGE, MIN_SDK,
};
use crate::tv_wait::{wait_for_tv, PortState, TvWaitHooks, TvWaitResult, TvWaitStep};
use crate::usb_adb::{TvUsbDevice, UsbAdbPipe};
use crate::usb_link::{usb_devices, usb_link, NusbBulk};

pub const PACKAGE: &str = "app.polaris.tv";
const ADB_PORT: u16 = 5555;
const TAG_PREFIX: &str = "tv-v";
const APK_NAME: &str = "polaris-tv.apk";
const REMOTE_APK: &str = "/data/local/tmp/polaris-tv.apk";
const SCAN: Duration = Duration::from_millis(700);
const SCAN_WIDTH: usize = 48;
const CLOSE_ATTEMPTS: u32 = 6;
const CLOSE_WAIT: Duration = Duration::from_millis(1_500);
const PAGE_SIZE: usize = 100;
const MAX_PAGES: u32 = 5;
const LOOKUP: Duration = Duration::from_secs(15);
const DOWNLOAD: Duration = Duration::from_secs(300);
/// How often the port is tried while the person turns debugging on, and for how long in all.
const WAIT_EVERY: Duration = Duration::from_secs(2);
const WAIT_FOR: Duration = Duration::from_secs(600);
/// How long a search listens for TVs announcing themselves, and how long an install does when the address was typed.
const BROWSE: Duration = Duration::from_secs(3);
const INSTALL_BROWSE: Duration = Duration::from_millis(1_500);
/// The release files' checksum list (`releases.ts`).
pub const CHECKSUMS: &str = "SHA256SUMS";
/// The repository the TV releases are published from (`desktop/package.json`).
pub const REPOSITORY: &str = "https://github.com/FJRG2007/polaris";
/// Where the ADB key is kept in the system's credential store.
const KEY_SERVICE: &str = "io.github.fjrg2007.polaris.beta.tv-adb-key";
const KEY_USER: &str = "tv-adb-key";

/// How it ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvOutcome {
    Installed,
    InstalledHome,
    InstalledHomeRefused,
    InstalledHomeUnknown,
    InstalledHomeKey,
    InstalledHomeKeyOff,
    HomeKeyNotReleased,
    AdbOff,
    NotAllowed,
    Unreachable,
    NotAndroidTv,
    TooOld,
    NotReleased,
    DownloadFailed,
    KeyFailed,
    ConnectionLost,
    BackupFailed,
    SideloadRefused,
    InstallFailed,
    InstallInterrupted,
    UsbBusy,
    UsbGone,
    NeedsPairing,
    PairingRefused,
}

impl TvOutcome {
    const ALL: [TvOutcome; 24] = [
        Self::Installed,
        Self::InstalledHome,
        Self::InstalledHomeRefused,
        Self::InstalledHomeUnknown,
        Self::InstalledHomeKey,
        Self::InstalledHomeKeyOff,
        Self::HomeKeyNotReleased,
        Self::AdbOff,
        Self::NotAllowed,
        Self::Unreachable,
        Self::NotAndroidTv,
        Self::TooOld,
        Self::NotReleased,
        Self::DownloadFailed,
        Self::KeyFailed,
        Self::ConnectionLost,
        Self::BackupFailed,
        Self::SideloadRefused,
        Self::InstallFailed,
        Self::InstallInterrupted,
        Self::UsbBusy,
        Self::UsbGone,
        Self::NeedsPairing,
        Self::PairingRefused,
    ];

    /// The name the dashboard reads, as `TvOutcome` in `bridge.ts`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::InstalledHome => "installed-home",
            Self::InstalledHomeRefused => "installed-home-refused",
            Self::InstalledHomeUnknown => "installed-home-unknown",
            Self::InstalledHomeKey => "installed-home-key",
            Self::InstalledHomeKeyOff => "installed-home-key-off",
            Self::HomeKeyNotReleased => "home-key-not-released",
            Self::AdbOff => "adb-off",
            Self::NotAllowed => "not-allowed",
            Self::Unreachable => "unreachable",
            Self::NotAndroidTv => "not-android-tv",
            Self::TooOld => "too-old",
            Self::NotReleased => "not-released",
            Self::DownloadFailed => "download-failed",
            Self::KeyFailed => "key-failed",
            Self::ConnectionLost => "connection-lost",
            Self::BackupFailed => "backup-failed",
            Self::SideloadRefused => "sideload-refused",
            Self::InstallFailed => "install-failed",
            Self::InstallInterrupted => "install-interrupted",
            Self::UsbBusy => "usb-busy",
            Self::UsbGone => "usb-gone",
            Self::NeedsPairing => "needs-pairing",
            Self::PairingRefused => "pairing-refused",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|one| one.as_str() == name)
    }

    fn installed(self) -> bool {
        self.as_str().starts_with("installed")
    }
}

/// Where installing on a TV has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvPhase {
    Ready,
    Searching,
    Connecting,
    Allow,
    Checking,
    Backup,
    Download,
    Install,
    Home,
    Control,
    Closing,
    Done,
    Failed,
}

/// One level of control the system mode tries, strongest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvControlRung {
    Home,
    SecureSettings,
    NotificationListener,
    InstallPackages,
    Battery,
}

/// got: the TV allowed it, checked afterwards. refused: this TV said no. skipped: not tried on this TV.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvControlState {
    Got,
    Refused,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TvControl {
    pub rung: TvControlRung,
    pub state: TvControlState,
}

/// The instruction shown while waiting: turn on debugging (the menu path for this TV's platform), or accept the prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TvWaiting {
    pub step: TvWaitStep,
    /// The `id` of these steps in the TV checker's data, so a page can show them in its own language.
    pub steps: String,
    pub about: String,
    pub press: String,
    pub presses: u32,
    pub developer: String,
    pub switches: Vec<String>,
}

/// What the TV window and the dashboard's dialog are shown, as `TvInstallState` in `bridge.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TvInstallState {
    pub phase: TvPhase,
    /// Addresses on this network that answer on the ADB port.
    pub found: Vec<String>,
    /// TVs plugged in by USB; None until somebody looked.
    pub usb: Option<Vec<TvUsbDevice>>,
    /// Whether the USB list is being read now.
    pub usb_listing: bool,
    pub outcome: Option<TvOutcome>,
    /// The folder the TV's backup was written to.
    pub backup: Option<String>,
    /// Whether the port refused afterwards; None until that was checked.
    pub closed: Option<bool>,
    pub waiting: Option<TvWaiting>,
    /// Whether this TV lets Polaris TV be Home, once it is known.
    pub home: Option<TvHomeRule>,
    /// Whether the TV was left on its link screen with this app's Polaris filled in.
    pub linking: Option<bool>,
    /// The name a found TV announced (its Cast name or model), by address.
    pub named: BTreeMap<String, String>,
    /// What the system mode got, level by level; empty for an app-only install, None before.
    pub control: Option<Vec<TvControl>>,
}

impl Default for TvInstallState {
    fn default() -> Self {
        Self {
            phase: TvPhase::Ready,
            found: Vec::new(),
            usb: None,
            usb_listing: false,
            outcome: None,
            backup: None,
            closed: None,
            waiting: None,
            home: None,
            linking: None,
            named: BTreeMap::new(),
            control: None,
        }
    }
}

/// What a failed connection means, in terms the person can act on.
pub fn connect_failure(error: &AdbError) -> TvOutcome {
    match error.code() {
        Some("USB_BUSY") => return TvOutcome::UsbBusy,
        Some("USB_GONE") => return TvOutcome::UsbGone,
        Some("ECONNREFUSED") => return TvOutcome::AdbOff,
        _ => {}
    }
    if error.to_string() == "The TV stopped answering." {
        return TvOutcome::NotAllowed;
    }
    TvOutcome::Unreachable
}

/// `Number.parseInt`: the leading digits after whitespace, None when there are none.
fn leading_number(text: &str) -> Option<u32> {
    let digits: String = text
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Whether the shell's answer is an Android TV this launcher can run on.
pub fn tv_refusal(sdk: &str, leanback: &str) -> Option<TvOutcome> {
    if !leanback.contains("feature:android.software.leanback") {
        return Some(TvOutcome::NotAndroidTv);
    }
    match leading_number(sdk) {
        Some(level) if level >= MIN_SDK => None,
        _ => Some(TvOutcome::TooOld),
    }
}

pub fn home_is_ours(resolved: &str) -> bool {
    let ours = format!("{PACKAGE}/.MainActivity");
    let long = format!("{PACKAGE}/{PACKAGE}.MainActivity");
    resolved
        .split_whitespace()
        .any(|line| line == ours || line == long)
}

/// The one instruction for this TV while the install waits on it.
pub fn waiting_for(step: TvWaitStep, path: &TvPath) -> TvWaiting {
    let steps = path.instruction;
    TvWaiting {
        step,
        steps: steps.id.clone(),
        about: steps.about.clone(),
        press: steps.press.clone(),
        presses: steps.presses,
        developer: steps.developer.clone(),
        switches: steps.switches.clone(),
    }
}

/// What a wait that ended without a connection tells the person; None for one that connected or was cancelled.
pub fn wait_outcome<T>(waited: &TvWaitResult<T>) -> Option<TvOutcome> {
    match waited {
        TvWaitResult::Failed(name) => {
            Some(TvOutcome::from_name(name).unwrap_or(TvOutcome::Unreachable))
        }
        TvWaitResult::Timeout(TvWaitStep::Prompt) => Some(TvOutcome::NotAllowed),
        TvWaitResult::Timeout(TvWaitStep::Debugging) => Some(TvOutcome::AdbOff),
        TvWaitResult::Connected(_) | TvWaitResult::Cancelled => None,
    }
}

/// The release asset an edition is published as (`.github/workflows/tv.yml`).
pub fn apk_name_of(edition: TvEdition) -> String {
    match edition {
        TvEdition::Standard => APK_NAME.to_owned(),
        TvEdition::HomeKey => "polaris-tv-home-key.apk".to_owned(),
    }
}

/// A TV on the network by its address, or one plugged in by USB by its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TvTarget {
    Network { host: String },
    Usb { id: String },
}

/// The backup folder's name for a TV: its address, or its USB id with only safe characters.
pub fn target_label(target: &TvTarget) -> String {
    match target {
        TvTarget::Network { host } => host.clone(),
        TvTarget::Usb { id } => {
            let safe: String = id
                .chars()
                .map(|one| {
                    if one.is_ascii_alphanumeric() || one == '-' {
                        one
                    } else {
                        '-'
                    }
                })
                .collect();
            // The TS module slices UTF-16 units; every character here is ASCII.
            format!("usb-{}", safe.chars().take(64).collect::<String>())
        }
    }
}

/// The TV's Private DNS before anything changed, named, so a missing key reads as "null" rather than a blank line.
pub const PRIVATE_DNS_READ: &str = "echo private_dns_mode=$(settings get global private_dns_mode); echo private_dns_specifier=$(settings get global private_dns_specifier)";

fn loopback(host: &str) -> bool {
    let lower = host.to_lowercase();
    let name = lower.strip_suffix('.').unwrap_or(&lower);
    name == "localhost"
        || name.ends_with(".localhost")
        || name.starts_with("127.")
        || name == "0.0.0.0"
}

/// Opens the TV's link screen with this app's Polaris filled in, one press on the remote from the code to scan.
/// None when there is no Polaris yet, when its address is this computer's own loopback (the TV would ask itself),
/// or when it is not a plain http(s) origin: the value goes into a shell command line, so nothing else is let through.
pub fn link_command(server: Option<&str>) -> Option<String> {
    let parsed = url::Url::parse(server?).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    if rest.is_empty()
        || !rest
            .chars()
            .all(|one| one.is_ascii_alphanumeric() || matches!(one, '.' | ':' | '[' | ']' | '-'))
    {
        return None;
    }
    let local = match parsed.host()? {
        // `[::1]`, `[::]` and `[::ffff:7f..]` in the TS module, which reads Node's spelling of the address.
        url::Host::Ipv6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| mapped.octets()[0] == 127)
        }
        other => loopback(&other.to_string()),
    };
    if local {
        return None;
    }
    Some(format!(
        "am start -n {PACKAGE}/.LinkFromInstall --es origin {origin}"
    ))
}

/// Asks the installed launcher whether this TV is already linked; stopped packages included, as a fresh install is.
pub const LINK_STATE_READ: &str = "am broadcast -f 32 -n app.polaris.tv/.LinkState";

/// Whether the launcher answered that it is linked; anything else, an error included, reads as not linked.
pub fn already_linked(output: &str) -> bool {
    output.contains("data=\"linked=true\"")
}

/// Whether `am start` reported the activity started rather than an error.
pub fn opened(output: &str) -> bool {
    let lower = output.to_lowercase();
    !output.trim().is_empty() && !lower.contains("error") && !lower.contains("exception")
}

/// The runtime grants after the install. Location names the Wi-Fi in the launcher's network row;
/// WRITE_SECURE_SETTINGS lets "Block ads and trackers" set Private DNS and put the TV's own back when it
/// does not work; here it is granted only when that was asked for, though system mode grants it anyway
/// as one of its control levels. Neither is ever revoked here: the launcher's own scripts may have
/// granted the second for another switch.
pub fn grant_commands(block_ads: bool) -> Vec<String> {
    let mut grants = vec![format!(
        "pm grant {PACKAGE} android.permission.ACCESS_FINE_LOCATION"
    )];
    if block_ads {
        grants.push(format!(
            "pm grant {PACKAGE} android.permission.WRITE_SECURE_SETTINGS"
        ));
    }
    grants
}

const HOME_KEY_SERVICE: &str = "app.polaris.tv/.HomeKeyService";
const ACCESSIBILITY_LIST: &str = "enabled_accessibility_services";

/// Reads the accessibility list.
pub const ACCESSIBILITY_READ: &str = "settings get secure enabled_accessibility_services";

/// Reads the list and the switch back, one per line.
pub const HOME_KEY_READ: &str =
    "settings get secure enabled_accessibility_services; settings get secure accessibility_enabled";

/// `^[\w.$]+\/[\w.$]+$`
fn is_component(entry: &str) -> bool {
    let part = |text: &str| {
        !text.is_empty()
            && text
                .chars()
                .all(|one| one.is_ascii_alphanumeric() || matches!(one, '_' | '.' | '$'))
    };
    match entry.split_once('/') {
        Some((left, right)) => part(left) && part(right),
        None => false,
    }
}

fn is_home_key(entry: &str) -> bool {
    entry == HOME_KEY_SERVICE || entry == format!("{PACKAGE}/{PACKAGE}.HomeKeyService")
}

/// The services on ACCESSIBILITY_READ's answer: "null" and empty are none. None when the answer is
/// not a list of components (an error from the TV), so nothing is written over what is really there.
pub fn accessibility_entries(read: &str) -> Option<Vec<String>> {
    let list = read.trim();
    if list.is_empty() || list == "null" {
        return Some(Vec::new());
    }
    let entries: Vec<String> = list
        .split(':')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    entries
        .iter()
        .all(|entry| is_component(entry))
        .then_some(entries)
}

fn setting_value(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The commands that put the launcher's HomeKeyService on the accessibility list after whatever is
/// there, never in place of it, and switch accessibility on. A service already listed was dropped
/// while its APK was replaced and binds again only once the list changes, so the list is cleared and
/// written back as it was (`tv/launcher/build-and-install.sh`, enable_service).
pub fn home_key_commands(entries: &[String]) -> Vec<String> {
    let put = |list: &[String]| {
        format!(
            "settings put secure {ACCESSIBILITY_LIST} {}",
            setting_value(&list.join(":"))
        )
    };
    let on = "settings put secure accessibility_enabled 1".to_owned();
    if !entries.iter().any(|entry| is_home_key(entry)) {
        let mut with = entries.to_vec();
        with.push(HOME_KEY_SERVICE.to_owned());
        return vec![put(&with), on];
    }
    vec![
        format!(
            "{}; settings put secure accessibility_enabled 0; sleep 1; {}",
            put(&[]),
            put(entries)
        ),
        on,
    ]
}

/// Whether HOME_KEY_READ shows HomeKeyService listed, in either spelling, with accessibility on.
pub fn home_key_on(read: &str) -> bool {
    let mut lines = read.trim().lines().map(str::trim);
    let list = lines.next().unwrap_or_default();
    let enabled = lines.next().unwrap_or_default();
    accessibility_entries(list)
        .unwrap_or_default()
        .iter()
        .any(|entry| is_home_key(entry))
        && enabled == "1"
}

/// system: Polaris TV becomes the TV's system, with every level of control the TV allows. app: installed, nothing else changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TvInstallMode {
    System,
    App,
}

/// What an install was asked to do: `mode` when the page sends it, else what `home` meant before it existed.
pub fn install_mode(mode: Option<TvInstallMode>, home: Option<bool>) -> TvInstallMode {
    mode.unwrap_or(if home == Some(false) {
        TvInstallMode::App
    } else {
        TvInstallMode::System
    })
}

/// The Home level, from how the Home step ended: skipped where the TV keeps its own Home.
pub fn home_control(offered: bool, outcome: TvOutcome) -> TvControl {
    let state = if !offered {
        TvControlState::Skipped
    } else if matches!(
        outcome,
        TvOutcome::InstalledHome | TvOutcome::InstalledHomeKey
    ) {
        TvControlState::Got
    } else {
        TvControlState::Refused
    };
    TvControl {
        rung: TvControlRung::Home,
        state,
    }
}

const LISTENER_LIST: &str = "enabled_notification_listeners";
const GUARD_REVIVAL: &str = "app.polaris.tv/.GuardRevival";

fn is_guard_revival(entry: &str) -> bool {
    entry == GUARD_REVIVAL || entry == format!("{PACKAGE}/{PACKAGE}.GuardRevival")
}

/// One level of control past Home. `before` is read first where the command has to keep what is
/// there; `commands` answers None when that read is not what it should be, so nothing is written.
/// `check` is read afterwards and `got` says whether it shows the level in place.
pub struct TvControlGrant {
    pub rung: TvControlRung,
    pub before: Option<String>,
    pub commands: fn(&str) -> Option<Vec<String>>,
    pub check: String,
    pub got: fn(&str) -> bool,
}

/// The listener list with GuardRevival after whatever is there, never in place of it; nothing
/// when it is listed already, and None when the list is not a list of components. Only for a TV
/// older than Android 8, which has no `cmd notification` and binds listeners from this setting.
pub fn listener_commands(read: &str) -> Option<Vec<String>> {
    let mut entries = accessibility_entries(read)?;
    if entries.iter().any(|entry| is_guard_revival(entry)) {
        return Some(Vec::new());
    }
    entries.push(GUARD_REVIVAL.to_owned());
    Some(vec![format!(
        "settings put secure {LISTENER_LIST} {}",
        setting_value(&entries.join(":"))
    )])
}

/// The first Android with `cmd notification`, where the service approves listeners rather than the setting.
const NOTIFICATION_CMD_SDK: u32 = 26;

/// Whether `dumpsys notification` shows GuardRevival among the listeners the service enabled or bound.
pub fn listener_enabled(check: &str) -> bool {
    check.contains(&format!(
        "ComponentInfo{{{PACKAGE}/{PACKAGE}.GuardRevival}}"
    )) || check.contains(&format!("ComponentInfo{{{GUARD_REVIVAL}}}"))
}

fn listener_listed(check: &str) -> bool {
    accessibility_entries(check)
        .unwrap_or_default()
        .iter()
        .any(|entry| is_guard_revival(entry))
}

/// GuardRevival as a notification listener: through the service where it has a command, else through the setting.
fn listener_grant(sdk: Option<u32>) -> TvControlGrant {
    if sdk.is_some_and(|level| level < NOTIFICATION_CMD_SDK) {
        return TvControlGrant {
            rung: TvControlRung::NotificationListener,
            before: Some(format!("settings get secure {LISTENER_LIST}")),
            commands: listener_commands,
            check: format!("settings get secure {LISTENER_LIST}"),
            got: listener_listed,
        };
    }
    TvControlGrant {
        rung: TvControlRung::NotificationListener,
        before: None,
        commands: |_| {
            Some(vec![format!(
                "cmd notification allow_listener {GUARD_REVIVAL}"
            )])
        },
        check: "dumpsys notification | grep -F GuardRevival".to_owned(),
        got: listener_enabled,
    }
}

/// Whether `dumpsys package` lines show WRITE_SECURE_SETTINGS granted.
pub fn secure_settings_granted(check: &str) -> bool {
    check.contains("android.permission.WRITE_SECURE_SETTINGS: granted=true")
}

/// Whether `appops get` answers that installing apps is allowed.
pub fn install_packages_allowed(check: &str) -> bool {
    check.lines().any(|line| {
        line.trim_start()
            .strip_prefix("REQUEST_INSTALL_PACKAGES: allow")
            .is_some_and(|rest| {
                !rest
                    .chars()
                    .next()
                    .is_some_and(|next| next.is_alphanumeric() || next == '_')
            })
    })
}

/// Whether `dumpsys deviceidle whitelist` lists the launcher (lines like `user,app.polaris.tv,10123`).
pub fn battery_whitelisted(check: &str) -> bool {
    check
        .lines()
        .any(|line| line.trim().split(',').nth(1) == Some(PACKAGE))
}

/// What the system mode asks for past Home, strongest first. Only what the launcher declares or
/// implements (tv/launcher/app/src/main/AndroidManifest.xml): it has no usage-stats or overlay
/// permission, so those app-ops are not asked for.
pub fn control_grants(sdk: Option<u32>) -> Vec<TvControlGrant> {
    vec![
        TvControlGrant {
            rung: TvControlRung::SecureSettings,
            before: None,
            commands: |_| {
                Some(vec![format!(
                    "pm grant {PACKAGE} android.permission.WRITE_SECURE_SETTINGS"
                )])
            },
            check: format!("dumpsys package {PACKAGE} | grep -F WRITE_SECURE_SETTINGS"),
            got: secure_settings_granted,
        },
        // GuardRevival brings the launcher back after the firmware force-stops it; it reads no notification.
        listener_grant(sdk),
        TvControlGrant {
            rung: TvControlRung::InstallPackages,
            before: None,
            commands: |_| {
                Some(vec![format!(
                    "appops set {PACKAGE} REQUEST_INSTALL_PACKAGES allow"
                )])
            },
            check: format!("appops get {PACKAGE} REQUEST_INSTALL_PACKAGES"),
            got: install_packages_allowed,
        },
        TvControlGrant {
            rung: TvControlRung::Battery,
            before: None,
            commands: |_| Some(vec![format!("dumpsys deviceidle whitelist +{PACKAGE}")]),
            check: "dumpsys deviceidle whitelist".to_owned(),
            got: battery_whitelisted,
        },
    ]
}

/// What the install needs of a connection to the TV; `AdbConnection` and the tests' fake.
pub trait TvAdb: Send {
    fn shell(&mut self, command: &str) -> impl Future<Output = Result<String, AdbError>> + Send;
    fn shell_within(
        &mut self,
        command: &str,
        timeout: Duration,
    ) -> impl Future<Output = Result<String, AdbError>> + Send;
    fn push(
        &mut self,
        path: &str,
        data: &[u8],
    ) -> impl Future<Output = Result<(), AdbError>> + Send;
    fn close(&mut self) -> impl Future<Output = ()> + Send;
}

impl<L: AdbLink> TvAdb for AdbConnection<L> {
    async fn shell(&mut self, command: &str) -> Result<String, AdbError> {
        AdbConnection::shell(self, command).await
    }

    async fn shell_within(&mut self, command: &str, timeout: Duration) -> Result<String, AdbError> {
        AdbConnection::shell_within(self, command, timeout).await
    }

    async fn push(&mut self, path: &str, data: &[u8]) -> Result<(), AdbError> {
        AdbConnection::push(self, path, data, 0o644).await
    }

    async fn close(&mut self) {
        AdbConnection::close(self).await;
    }
}

/// Runs each grant and reads it back; one the TV refuses, or that fails, is recorded and the next is tried.
pub async fn grant_control<A: TvAdb>(adb: &mut A, grants: &[TvControlGrant]) -> Vec<TvControl> {
    let mut control = Vec::new();
    for grant in grants {
        let attempt = async {
            let before = match &grant.before {
                Some(read) => adb.shell(read).await?,
                None => String::new(),
            };
            for command in (grant.commands)(&before).unwrap_or_default() {
                adb.shell(&command).await?;
            }
            Ok::<bool, AdbError>((grant.got)(&adb.shell(&grant.check).await?))
        };
        let got = match attempt.await {
            Ok(got) => got,
            Err(error) => {
                eprintln!("[tv] control {:?} {error}", grant.rung);
                false
            }
        };
        control.push(TvControl {
            rung: grant.rung,
            state: if got {
                TvControlState::Got
            } else {
                TvControlState::Refused
            },
        });
    }
    control
}

/// How far an install got, which decides what a failure can truthfully say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TvStage {
    Check,
    Backup,
    Send,
    Install,
    Home,
}

/// What an error part way through means for the set.
pub fn late_failure(stage: TvStage) -> TvOutcome {
    match stage {
        TvStage::Backup => TvOutcome::BackupFailed,
        TvStage::Install => TvOutcome::InstallInterrupted,
        TvStage::Home => TvOutcome::InstalledHomeUnknown,
        TvStage::Check | TvStage::Send => TvOutcome::ConnectionLost,
    }
}

/// What a failed pairing means on screen; None for a cancel, which says nothing.
pub fn pairing_failure(error: &PairingError) -> Option<TvOutcome> {
    match error.reason {
        PairingFailure::Cancelled => None,
        PairingFailure::WrongCode => Some(TvOutcome::PairingRefused),
        PairingFailure::Timeout | PairingFailure::Unreachable | PairingFailure::Protocol => {
            Some(TvOutcome::Unreachable)
        }
    }
}

/// What a page sends to start an install: `host` for a TV on the network, `usb` for one from the USB list.
/// `mode` from pages that know it; `home` alone from pages older than it. One of them is required.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NetworkStart {
    host: serde_json::Value,
    #[serde(default)]
    mode: Option<TvInstallMode>,
    #[serde(default)]
    home: Option<bool>,
    #[serde(default)]
    block_ads: Option<bool>,
    /// The Wireless debugging pairing code the TV shows; absent until it asked for one.
    #[serde(default)]
    code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UsbStart {
    usb: String,
    #[serde(default)]
    mode: Option<TvInstallMode>,
    #[serde(default)]
    home: Option<bool>,
    #[serde(default)]
    block_ads: Option<bool>,
}

/// Where a start asked to install, read and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartWhere {
    /// A private IPv4 address, and the pairing code as typed (at most 32 characters).
    Network { host: String, code: Option<String> },
    /// A USB id, 1 to 200 characters once trimmed.
    Usb { id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartRequest {
    pub target: StartWhere,
    pub mode: Option<TvInstallMode>,
    pub home: Option<bool>,
    pub block_ads: bool,
}

/// `startSchema`: None for anything that is not one of the two shapes, a host that is not a
/// private address, or a request that says neither `mode` nor `home`.
pub fn read_start(raw: &serde_json::Value) -> Option<StartRequest> {
    let request = if let Ok(network) = NetworkStart::deserialize(raw) {
        let host = read_tv_address(network.host.as_str()?)?;
        if network
            .code
            .as_ref()
            .is_some_and(|code| code.chars().count() > 32)
        {
            return None;
        }
        StartRequest {
            target: StartWhere::Network {
                host,
                code: network.code,
            },
            mode: network.mode,
            home: network.home,
            block_ads: network.block_ads == Some(true),
        }
    } else {
        let usb = UsbStart::deserialize(raw).ok()?;
        let id = usb.usb.trim();
        let length = id.chars().count();
        if !(1..=200).contains(&length) {
            return None;
        }
        StartRequest {
            target: StartWhere::Usb { id: id.to_owned() },
            mode: usb.mode,
            home: usb.home,
            block_ads: usb.block_ads == Some(true),
        }
    };
    (request.mode.is_some() || request.home.is_some()).then_some(request)
}

/// Where a start asked to install; a USB id only counts if it was listed.
pub fn start_target(request: &StartRequest, listed: Option<&[TvUsbDevice]>) -> Option<TvTarget> {
    match &request.target {
        StartWhere::Network { host, .. } => Some(TvTarget::Network { host: host.clone() }),
        StartWhere::Usb { id } => listed
            .is_some_and(|devices| devices.iter().any(|one| &one.id == id))
            .then(|| TvTarget::Usb { id: id.clone() }),
    }
}

/// One published release, as GitHub lists it; the fields not read here are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct PublishedRelease {
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
}

/// The release list of a GitHub repository (`releaseSource(...).api` in `releases.ts`).
pub fn release_api(repository: &str) -> Option<String> {
    let rest = repository
        .strip_prefix("git+")
        .unwrap_or(repository)
        .strip_prefix("https://github.com/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, repo) = rest.split_once('/')?;
    let word = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|one| one.is_ascii_alphanumeric() || matches!(one, '_' | '.' | '-'))
    };
    (word(owner) && word(repo))
        .then(|| format!("https://api.github.com/repos/{owner}/{repo}/releases?per_page=100"))
}

/// `sha256sum` output as file name to lowercase digest. Lines that are not one
/// are skipped; a name listed twice keeps neither, since it is not known which
/// one is right.
pub fn parse_checksums(text: &str) -> BTreeMap<String, String> {
    let mut sums = BTreeMap::new();
    let mut repeated = Vec::new();
    for line in text.split('\n') {
        let line = line.trim();
        let (Some(digest), Some(separator)) = (line.get(..64), line.get(64..65)) else {
            continue;
        };
        if !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) || separator != " " {
            continue;
        }
        let Some(name) = line.get(66..).filter(|name| !name.is_empty()) else {
            continue;
        };
        if !matches!(line.get(65..66), Some(" " | "*")) {
            continue;
        }
        if sums.contains_key(name) {
            repeated.push(name.to_owned());
        }
        sums.insert(name.to_owned(), digest.to_lowercase());
    }
    for name in repeated {
        sums.remove(&name);
    }
    sums
}

/// Why a release could not be fetched; the screen says "download-failed" for each.
#[derive(Debug, thiserror::Error)]
#[error("download")]
pub struct DownloadFailed;

/// An edition's APK, verified, and the release version it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedApk {
    pub apk: Vec<u8>,
    pub version: String,
}

/// The client releases are read with: GitHub's API refuses a request with no user agent.
pub fn release_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("polaris-desktop-beta")
        .build()
}

/// The newest TV release. One list holds every kind of release, so it can be
/// pages back from the first.
pub async fn newest_release(
    http: &reqwest::Client,
    api: &str,
) -> Result<Option<PublishedRelease>, DownloadFailed> {
    for page in 1..=MAX_PAGES {
        let response = http
            .get(format!("{api}&page={page}"))
            .header("accept", "application/vnd.github+json")
            .timeout(LOOKUP)
            .send()
            .await
            .map_err(|_| DownloadFailed)?;
        if !response.status().is_success() {
            return Err(DownloadFailed);
        }
        let releases: Vec<PublishedRelease> = response.json().await.map_err(|_| DownloadFailed)?;
        let found = releases
            .iter()
            .find(|one| one.tag_name.starts_with(TAG_PREFIX) && !one.draft && !one.prerelease);
        if let Some(release) = found {
            return Ok(Some(release.clone()));
        }
        if releases.len() < PAGE_SIZE {
            return Ok(None);
        }
    }
    Ok(None)
}

/// The newest TV release, or None when none is published or it has no ordinary APK to install.
pub async fn latest_tv_release(
    http: &reqwest::Client,
    api: &str,
) -> Result<Option<PublishedRelease>, DownloadFailed> {
    let release = newest_release(http, api).await?;
    Ok(release.filter(|one| one.assets.iter().any(|asset| asset.name == APK_NAME)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// An edition's APK from a release, verified, or None when the release does not publish it.
pub async fn apk_of(
    http: &reqwest::Client,
    release: &PublishedRelease,
    edition: TvEdition,
) -> Result<Option<FetchedApk>, DownloadFailed> {
    let name = apk_name_of(edition);
    let apk_asset = release.assets.iter().find(|one| one.name == name);
    let sums = release.assets.iter().find(|one| one.name == CHECKSUMS);
    let (Some(apk_asset), Some(sums)) = (apk_asset, sums) else {
        return Ok(None);
    };
    let listed = http
        .get(&sums.browser_download_url)
        .timeout(LOOKUP)
        .send()
        .await
        .map_err(|_| DownloadFailed)?;
    let listed_ok = listed.status().is_success();
    let expected = parse_checksums(&listed.text().await.map_err(|_| DownloadFailed)?).remove(&name);
    let download = http
        .get(&apk_asset.browser_download_url)
        .timeout(DOWNLOAD)
        .send()
        .await
        .map_err(|_| DownloadFailed)?;
    let (true, true, Some(expected)) = (listed_ok, download.status().is_success(), expected) else {
        return Err(DownloadFailed);
    };
    let apk = download.bytes().await.map_err(|_| DownloadFailed)?.to_vec();
    if hex(&Sha256::digest(&apk)) != expected {
        return Err(DownloadFailed);
    }
    Ok(Some(FetchedApk {
        apk,
        version: release.tag_name[TAG_PREFIX.len()..].to_owned(),
    }))
}

/// The newest published APK of an edition, verified, or None when the newest release has none.
pub async fn latest_apk(
    http: &reqwest::Client,
    api: &str,
    edition: TvEdition,
) -> Result<Option<FetchedApk>, DownloadFailed> {
    match newest_release(http, api).await? {
        Some(release) => apk_of(http, &release, edition).await,
        None => Ok(None),
    }
}

/// `new Date().toISOString().replace(/[:.]/g, "-")`.
pub fn backup_stamp(now: SystemTime) -> String {
    let elapsed = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = elapsed.as_secs();
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}-{:02}-{:02}-{:03}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        elapsed.subsec_millis()
    )
}

/// The reads a backup writes, by file name.
pub const BACKUP_READS: [(&str, &str); 7] = [
    ("packages.txt", "pm list packages"),
    ("disabled.txt", "pm list packages -d"),
    ("getprop.txt", "getprop"),
    ("settings-global.txt", "settings list global"),
    ("settings-secure.txt", "settings list secure"),
    ("settings-system.txt", "settings list system"),
    ("private-dns.txt", PRIVATE_DNS_READ),
];

async fn back_up<A: TvAdb>(adb: &mut A, folder: &Path) -> Result<(), AdbError> {
    std::fs::create_dir_all(folder)?;
    for (name, command) in BACKUP_READS {
        let read = adb.shell(command).await?;
        std::fs::write(folder.join(name), read)?;
    }
    Ok(())
}

/// What the steps after the connection need from the app around them.
pub trait TvSteps: Sync {
    fn publish(&self, change: &dyn Fn(&mut TvInstallState));
    /// The edition's APK from the release looked up before connecting.
    fn fetch_apk(
        &self,
        edition: TvEdition,
    ) -> impl Future<Output = Result<Option<FetchedApk>, DownloadFailed>> + Send;
    /// Where this TV's backup goes: a new folder under the app's data.
    fn backup_folder(&self, target: &TvTarget) -> Option<PathBuf>;
    /// This app's Polaris, for the TV's link screen.
    fn server(&self) -> Option<String>;
    /// Whether debugging is off now: the port refuses, or the cable no longer offers ADB.
    fn closed(&self, target: &TvTarget) -> impl Future<Output = bool> + Send;
}

async fn finish<A: TvAdb, S: TvSteps>(
    adb: &mut A,
    steps: &S,
    target: &TvTarget,
    outcome: TvOutcome,
) {
    steps.publish(&|state| state.phase = TvPhase::Closing);
    let _ = adb
        .shell("settings put global adb_wifi_enabled 0; settings put global adb_enabled 0")
        .await;
    adb.close().await;
    let closed = steps.closed(target).await;
    steps.publish(&|state| {
        state.phase = if outcome.installed() {
            TvPhase::Done
        } else {
            TvPhase::Failed
        };
        state.outcome = Some(outcome);
        state.closed = Some(closed);
    });
}

/// Everything after the TV let this computer in: check it, back it up, install,
/// make it Home where asked and allowed, the levels of control, its link screen,
/// and debugging off. Never ends without switching debugging off.
pub async fn install_steps<A: TvAdb, S: TvSteps>(
    adb: &mut A,
    steps: &S,
    target: &TvTarget,
    sighting: &TvSighting,
    mode: TvInstallMode,
    block_ads: bool,
) {
    let mut stage = TvStage::Check;
    let result: Result<TvOutcome, AdbError> = async {
        steps.publish(&|state| state.phase = TvPhase::Checking);
        let sdk = adb.shell("getprop ro.build.version.sdk").await?;
        let sdk_level = leading_number(&sdk).filter(|level| *level != 0);
        let features = adb.shell("pm list features").await?;
        if let Some(refusal) = tv_refusal(&sdk, &features) {
            return Ok(refusal);
        }
        let identity = TvIdentity {
            manufacturer: adb.shell("getprop ro.product.manufacturer").await?,
            model: adb.shell("getprop ro.product.model").await?,
            sdk: sdk_level,
            home_guard: Some(lists_package(
                &adb.shell(&format!("pm list packages {HOME_GUARD_PACKAGE}"))
                    .await?,
                HOME_GUARD_PACKAGE,
            )),
        };
        let path = choose_path(sighting, Some(&identity));
        let home = path.home;
        steps.publish(&|state| state.home = Some(home));
        // A box that uninstalls Home apps at boot gets the edition without the HOME category, so the APK is
        // fetched, from the release looked up before connecting, once the TV said which it is.
        steps.publish(&|state| state.phase = TvPhase::Download);
        let fetched = match steps.fetch_apk(path.edition).await {
            Ok(Some(fetched)) => fetched,
            Ok(None) if path.edition == TvEdition::Standard => return Ok(TvOutcome::NotReleased),
            Ok(None) => return Ok(TvOutcome::HomeKeyNotReleased),
            Err(error) => {
                eprintln!("[tv] {error}");
                return Ok(TvOutcome::DownloadFailed);
            }
        };
        stage = TvStage::Backup;
        steps.publish(&|state| state.phase = TvPhase::Backup);
        let folder = steps
            .backup_folder(target)
            .ok_or_else(|| AdbError::Io(std::io::Error::other("no folder for the backup")))?;
        back_up(adb, &folder).await?;
        let shown = folder.to_string_lossy().into_owned();
        steps.publish(&|state| state.backup = Some(shown.clone()));

        stage = TvStage::Send;
        steps.publish(&|state| state.phase = TvPhase::Install);
        adb.push(REMOTE_APK, &fetched.apk).await?;
        stage = TvStage::Install;
        let installed = adb
            .shell_within(&format!("pm install -r {REMOTE_APK}"), Duration::from_secs(180))
            .await?;
        let _ = adb.shell(&format!("rm -f {REMOTE_APK}")).await;
        if !installed.contains("Success") {
            return Ok(if installed.contains("VERIFICATION_FAILURE") {
                TvOutcome::SideloadRefused
            } else {
                TvOutcome::InstallFailed
            });
        }
        stage = TvStage::Home;
        for grant in grant_commands(block_ads) {
            let _ = adb.shell(&grant).await;
        }
        // TCL's app-ops: a TV without that firmware answers an error, which changes nothing.
        for line in &path.after_install {
            let _ = adb.shell(&format!("{line} 2>/dev/null; true")).await;
        }

        let make_home = mode == TvInstallMode::System;
        let mut outcome = TvOutcome::Installed;
        if make_home && path.home == TvHomeRule::Offered && path.edition == TvEdition::HomeKey {
            // set-home-activity changes nothing on these boxes: the remote's Home key opens it instead.
            steps.publish(&|state| state.phase = TvPhase::Home);
            if let Some(entries) = accessibility_entries(&adb.shell(ACCESSIBILITY_READ).await?) {
                for command in home_key_commands(&entries) {
                    adb.shell(&command).await?;
                }
            }
            outcome = if home_key_on(&adb.shell(HOME_KEY_READ).await?) {
                TvOutcome::InstalledHomeKey
            } else {
                TvOutcome::InstalledHomeKeyOff
            };
        } else if make_home && path.home == TvHomeRule::Offered {
            steps.publish(&|state| state.phase = TvPhase::Home);
            adb.shell(&format!(
                "cmd package set-home-activity --user 0 {PACKAGE}/.MainActivity"
            ))
            .await?;
            let resolved = adb
                .shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")
                .await?;
            outcome = if home_is_ours(&resolved) {
                TvOutcome::InstalledHome
            } else {
                TvOutcome::InstalledHomeRefused
            };
        }
        if mode == TvInstallMode::System {
            // Each level past Home is tried and checked on its own; none of them can fail the install.
            steps.publish(&|state| state.phase = TvPhase::Control);
            let mut control = vec![home_control(path.home == TvHomeRule::Offered, outcome)];
            control.extend(grant_control(adb, &control_grants(sdk_level)).await);
            steps.publish(&|state| state.control = Some(control.clone()));
        } else {
            steps.publish(&|state| state.control = Some(Vec::new()));
        }
        if let Some(link) = link_command(steps.server().as_deref()) {
            let state = adb.shell(LINK_STATE_READ).await.unwrap_or_default();
            if !already_linked(&state) {
                let answer = adb.shell(&link).await.unwrap_or_else(|_| "Error".to_owned());
                let linking = opened(&answer);
                steps.publish(&|state| state.linking = Some(linking));
            }
        }
        Ok(outcome)
    }
    .await;
    let outcome = result.unwrap_or_else(|error| {
        eprintln!("[tv] {error}");
        late_failure(stage)
    });
    finish(adb, steps, target, outcome).await;
}

/// Whether something answers on `host`:`port`: open, refused (nothing listening), or silent.
pub async fn answers_on(host: &str, port: u16, timeout: Duration) -> PortState {
    match tokio::time::timeout(timeout, TcpStream::connect((host, port))).await {
        Ok(Ok(_)) => PortState::Open,
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            PortState::Refused
        }
        _ => PortState::Silent,
    }
}

/// The addresses to try on the networks this computer is on.
pub fn neighbours() -> Vec<String> {
    let mut found = std::collections::BTreeSet::new();
    let mut own = Vec::new();
    for interface in if_addrs::get_if_addrs().unwrap_or_default() {
        let if_addrs::IfAddr::V4(address) = &interface.addr else {
            continue;
        };
        let ip = address.ip.to_string();
        if interface.is_loopback() || read_tv_address(&ip).is_none() {
            continue;
        }
        let [a, b, c, _] = address.ip.octets();
        for last in 1..255u8 {
            found.insert(format!("{a}.{b}.{c}.{last}"));
        }
        own.push(ip);
    }
    for ip in own {
        found.remove(&ip);
    }
    found.into_iter().collect()
}

/// A future that ends once `counter` is no longer `run`.
fn changed_from(
    counter: &watch::Sender<u64>,
    run: u64,
) -> impl Future<Output = ()> + Send + 'static {
    let mut seen = counter.subscribe();
    async move {
        loop {
            if *seen.borrow_and_update() != run {
                return;
            }
            if seen.changed().await.is_err() {
                return std::future::pending().await;
            }
        }
    }
}

fn bump(counter: &watch::Sender<u64>) -> u64 {
    counter.send_modify(|value| *value += 1);
    *counter.borrow()
}

/// The two ways to a TV's adbd.
pub enum TvLink {
    Network(StreamLink<TcpStream>),
    Usb(UsbAdbPipe<NusbBulk>),
}

impl AdbLink for TvLink {
    async fn send(&mut self, header: &[u8], data: &[u8]) -> Result<(), AdbError> {
        match self {
            Self::Network(link) => link.send(header, data).await,
            Self::Usb(link) => link.send(header, data).await,
        }
    }

    async fn receive(&mut self) -> Result<Vec<u8>, AdbError> {
        match self {
            Self::Network(link) => link.receive().await,
            Self::Usb(link) => link.receive().await,
        }
    }

    fn can_start_tls(&self) -> bool {
        match self {
            Self::Network(link) => link.can_start_tls(),
            Self::Usb(link) => link.can_start_tls(),
        }
    }

    async fn start_tls(
        &mut self,
        identity: &TlsIdentity,
        timeout: Duration,
    ) -> Result<(), AdbError> {
        match self {
            Self::Network(link) => link.start_tls(identity, timeout).await,
            Self::Usb(link) => link.start_tls(identity, timeout).await,
        }
    }

    async fn close(&mut self) {
        match self {
            Self::Network(link) => link.close().await,
            Self::Usb(link) => link.close().await,
        }
    }
}

type TvConnection = AdbConnection<TvLink>;

/// What the installer needs from the app: where to tell the pages, where its data is, and its Polaris.
pub trait TvHost: Send + Sync + 'static {
    fn publish(&self, state: &TvInstallState);
    fn data_dir(&self) -> Option<PathBuf>;
    fn server(&self) -> Option<String>;
}

/// The installer: one at a time, its state shared by every page that asked for it.
pub struct TvInstaller {
    host: Box<dyn TvHost>,
    http: reqwest::Client,
    state: Mutex<TvInstallState>,
    busy: AtomicBool,
    /// Bumped by a cancel, so a search started before it stops taking addresses.
    search: watch::Sender<u64>,
    /// Bumped by a cancel and when a wait ends, so a wait for the TV stops; a connection waiting on the prompt is dropped.
    wait_run: watch::Sender<u64>,
    /// Bumped by a cancel, which ends a Wireless debugging pairing in progress.
    pairing: watch::Sender<u64>,
    /// What TVs announced in the last search, by address.
    announced: Mutex<BTreeMap<String, TvAnnouncement>>,
    /// The ADB key, when the system's store could not keep it.
    held_key: Mutex<Option<String>>,
    started: Instant,
}

impl TvInstaller {
    pub fn new(host: impl TvHost, http: reqwest::Client) -> Arc<Self> {
        Arc::new(Self {
            host: Box::new(host),
            http,
            state: Mutex::new(TvInstallState::default()),
            busy: AtomicBool::new(false),
            search: watch::Sender::new(0),
            wait_run: watch::Sender::new(0),
            pairing: watch::Sender::new(0),
            announced: Mutex::new(BTreeMap::new()),
            held_key: Mutex::new(None),
            started: Instant::now(),
        })
    }

    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn state(&self) -> TvInstallState {
        Self::lock(&self.state).clone()
    }

    fn update(&self, change: &dyn Fn(&mut TvInstallState)) {
        let next = {
            let mut state = Self::lock(&self.state);
            change(&mut state);
            state.clone()
        };
        self.host.publish(&next);
    }

    fn take_busy(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// Stops a search, or a wait for the TV, under way; an install is never stopped once the TV let this in.
    pub fn cancel(&self) -> TvInstallState {
        bump(&self.pairing);
        let state = self.state();
        if state.waiting.is_some() || state.phase == TvPhase::Connecting {
            // A prompt nobody answered would otherwise hold the cancel until it times out.
            bump(&self.wait_run);
        }
        if state.phase == TvPhase::Searching {
            bump(&self.search);
            self.busy.store(false, Ordering::SeqCst);
            self.update(&|state| state.phase = TvPhase::Ready);
        }
        self.state()
    }

    /// Looks for TVs: the debugging port on every neighbour, and what announces itself.
    pub async fn find(&self) -> TvInstallState {
        if !self.take_busy() {
            return self.state();
        }
        let run = bump(&self.search);
        self.update(&|state| {
            state.phase = TvPhase::Searching;
            state.found = Vec::new();
        });
        let queue = Arc::new(Mutex::new(neighbours()));
        let open = Arc::new(Mutex::new(Vec::new()));
        let mut sweep = tokio::task::JoinSet::new();
        for _ in 0..SCAN_WIDTH {
            let queue = queue.clone();
            let open = open.clone();
            let search = self.search.subscribe();
            sweep.spawn(async move {
                loop {
                    if *search.borrow() != run {
                        return;
                    }
                    let Some(host) = Self::lock(&queue).pop() else {
                        return;
                    };
                    if answers_on(&host, ADB_PORT, SCAN).await == PortState::Open {
                        Self::lock(&open).push(host);
                    }
                }
            });
        }
        let (heard, ()) =
            tokio::join!(browse_tvs(BROWSE, changed_from(&self.search, run)), async {
                while sweep.join_next().await.is_some() {}
            });
        // A cancelled search has already handed the controls back.
        if *self.search.borrow() != run {
            return self.state();
        }
        self.busy.store(false, Ordering::SeqCst);
        let found = merge_found(&Self::lock(&open), &heard);
        let named = names_of(&heard);
        *Self::lock(&self.announced) = heard;
        self.update(&|state| {
            state.phase = TvPhase::Ready;
            state.found = found.clone();
            state.named = named.clone();
        });
        self.state()
    }

    /// Lists the TVs plugged into this computer by USB with USB debugging on.
    pub async fn find_usb(&self) -> TvInstallState {
        if !self.take_busy() {
            return self.state();
        }
        self.update(&|state| state.usb_listing = true);
        let usb = usb_devices().await.unwrap_or_else(|error| {
            eprintln!("[tv] {error}");
            Vec::new()
        });
        self.busy.store(false, Ordering::SeqCst);
        self.update(&|state| {
            state.usb = Some(usb.clone());
            state.usb_listing = false;
            state.outcome = None;
        });
        self.state()
    }

    /// Starts an install in the background; false when it was refused or one is under way.
    pub fn start(self: &Arc<Self>, raw: &serde_json::Value) -> bool {
        let Some(request) = read_start(raw) else {
            return false;
        };
        if self.busy.load(Ordering::SeqCst) {
            return false;
        }
        let listed = self.state().usb;
        let Some(target) = start_target(&request, listed.as_deref()) else {
            return false;
        };
        let code = match &request.target {
            StartWhere::Network {
                code: Some(typed), ..
            } => match read_pairing_code(typed) {
                Some(code) => Some(code),
                None => return false,
            },
            _ => None,
        };
        if !self.take_busy() {
            return false;
        }
        let mode = install_mode(request.mode, request.home);
        let installer = self.clone();
        tokio::spawn(async move {
            installer
                .install(target, mode, request.block_ads, code)
                .await;
            installer.busy.store(false, Ordering::SeqCst);
        });
        true
    }

    fn adb_key(&self) -> Option<String> {
        if let Some(held) = Self::lock(&self.held_key).clone() {
            return Some(held);
        }
        let entry = keyring::Entry::new(KEY_SERVICE, KEY_USER).ok();
        if let Some(kept) = entry.as_ref().and_then(|one| one.get_password().ok()) {
            return Some(kept);
        }
        let key = new_adb_key().ok()?;
        if !entry.is_some_and(|one| one.set_password(&key).is_ok()) {
            // No store to keep it in: this run uses it, and the TV asks again next time.
            *Self::lock(&self.held_key) = Some(key.clone());
        }
        Some(key)
    }

    async fn connect_on(
        &self,
        host: &str,
        port: u16,
        key: &str,
        certificate: Option<String>,
        run: u64,
    ) -> Result<TvConnection, AdbError> {
        let options = AdbOptions {
            key: key.to_owned(),
            certificate,
            connect: Duration::from_secs(8),
            approve: Duration::from_secs(60),
            command: Duration::from_secs(60),
        };
        let attempt = async {
            let link = tcp_link(host, port, options.connect).await?;
            let mut adb = AdbConnection::new(TvLink::Network(link), options);
            adb.open(|| {}).await?;
            Ok(adb)
        };
        tokio::select! {
            opened = attempt => opened,
            () = changed_from(&self.wait_run, run) => Err(AdbError::Closed),
        }
    }

    async fn ports_now(
        &self,
        host: &str,
        heard: &BTreeMap<String, TvAnnouncement>,
    ) -> BTreeMap<String, u16> {
        let mut ports = heard
            .get(host)
            .map(|one| one.ports.clone())
            .unwrap_or_default();
        let fresh = browse_tvs(INSTALL_BROWSE, std::future::pending()).await;
        if let Some(found) = fresh.get(host) {
            ports.extend(found.ports.clone());
        }
        ports
    }

    /// A TV whose debugging opens only through Wireless debugging: its TLS port lets
    /// in a computer it paired with before; otherwise the six-digit code the TV shows
    /// pairs this one first. The pairing port is announced only while the TV shows
    /// that code, so it is looked for again once the code is typed.
    /// Err(None) is a cancel.
    async fn over_wireless_debugging(
        &self,
        host: &str,
        key: &str,
        heard: &BTreeMap<String, TvAnnouncement>,
        code: Option<String>,
    ) -> Result<TvConnection, Option<TvOutcome>> {
        let certificate =
            adb_certificate(key, SystemTime::now()).map_err(|_| Some(TvOutcome::KeyFailed))?;
        // A Stop pressed while a connect is under way drops it; that failure is the cancel, not the TV's answer.
        let run = bump(&self.wait_run);
        let stopped = || *self.wait_run.borrow() != run;
        let mut ports = heard
            .get(host)
            .map(|one| one.ports.clone())
            .unwrap_or_default();
        let Some(code) = code else {
            let remembered = ports.get("adb-tls-connect").copied();
            if let Some(port) = remembered {
                if let Ok(adb) = self
                    .connect_on(host, port, key, Some(certificate.clone()), run)
                    .await
                {
                    return Ok(adb);
                }
                if stopped() {
                    return Err(None);
                }
            }
            let fresh = self
                .ports_now(host, heard)
                .await
                .get("adb-tls-connect")
                .copied();
            if stopped() {
                return Err(None);
            }
            let Some(fresh) = fresh.filter(|port| Some(*port) != remembered) else {
                return Err(Some(TvOutcome::NeedsPairing));
            };
            return match self
                .connect_on(host, fresh, key, Some(certificate), run)
                .await
            {
                Ok(adb) => Ok(adb),
                Err(_) if stopped() => Err(None),
                Err(_) => Err(Some(TvOutcome::NeedsPairing)),
            };
        };
        ports = self.ports_now(host, heard).await;
        if stopped() {
            return Err(None);
        }
        let Some(pairing_port) = ports.get("adb-tls-pairing").copied() else {
            return Err(Some(TvOutcome::NeedsPairing));
        };
        let public_key =
            android_public_key(key, KEY_COMMENT).map_err(|_| Some(TvOutcome::KeyFailed))?;
        let pairing_run = *self.pairing.borrow();
        let paired = pair_tv(
            PairOptions {
                host: host.to_owned(),
                port: pairing_port,
                code,
                key: key.to_owned(),
                public_key,
                timeout: Duration::from_secs(30),
            },
            changed_from(&self.pairing, pairing_run),
        )
        .await;
        if let Err(error) = paired {
            eprintln!("[tv] pairing {error}");
            return Err(pairing_failure(&error));
        }
        if !ports.contains_key("adb-tls-connect") {
            ports = self.ports_now(host, heard).await;
        }
        let Some(tls_port) = ports.get("adb-tls-connect").copied() else {
            return Err(Some(TvOutcome::Unreachable));
        };
        match self
            .connect_on(host, tls_port, key, Some(certificate), run)
            .await
        {
            Ok(adb) => Ok(adb),
            Err(_) if stopped() => Err(None),
            Err(error) => Err(Some(connect_failure(&error))),
        }
    }

    async fn install(
        self: &Arc<Self>,
        target: TvTarget,
        mode: TvInstallMode,
        block_ads: bool,
        code: Option<String>,
    ) {
        self.update(&|state| {
            state.phase = TvPhase::Download;
            state.outcome = None;
            state.backup = None;
            state.closed = None;
            state.waiting = None;
            state.home = None;
            state.linking = None;
            state.control = None;
        });
        let release = match release_api(REPOSITORY) {
            Some(api) => latest_tv_release(&self.http, &api).await,
            None => Ok(None),
        };
        let release = match release {
            Ok(Some(release)) => release,
            Ok(None) => return self.fail(TvOutcome::NotReleased),
            Err(error) => {
                eprintln!("[tv] {error}");
                return self.fail(TvOutcome::DownloadFailed);
            }
        };
        let Some(key) = self.adb_key() else {
            return self.fail(TvOutcome::KeyFailed);
        };

        self.update(&|state| state.phase = TvPhase::Connecting);
        // A typed address nobody searched for is asked about here, so a pairing-only TV is known at once.
        let (adb_open, heard) = match &target {
            TvTarget::Network { host } => {
                let known = Self::lock(&self.announced).contains_key(host);
                let announced = Self::lock(&self.announced).clone();
                let (open, heard) = tokio::join!(answers_on(host, ADB_PORT, SCAN), async {
                    if known {
                        announced
                    } else {
                        browse_tvs(INSTALL_BROWSE, std::future::pending()).await
                    }
                });
                (open == PortState::Open, heard)
            }
            TvTarget::Usb { .. } => (false, BTreeMap::new()),
        };
        let sighting = sighting_of(
            match &target {
                TvTarget::Network { host } => heard.get(host),
                TvTarget::Usb { .. } => None,
            },
            adb_open,
        );
        let before = choose_path(&sighting, None);
        let mut adb = match &target {
            TvTarget::Network { host } if before.route == TvRoute::Pairing => {
                match self.over_wireless_debugging(host, &key, &heard, code).await {
                    Ok(adb) => adb,
                    Err(None) => {
                        return self.update(&|state| {
                            state.phase = TvPhase::Ready;
                            state.waiting = None;
                        })
                    }
                    Err(Some(outcome)) => {
                        return self.update(&|state| {
                            state.phase = TvPhase::Failed;
                            state.outcome = Some(outcome);
                            state.waiting = None;
                        })
                    }
                }
            }
            _ => {
                let run = bump(&self.wait_run);
                let mut hooks = WaitHooks {
                    installer: self,
                    target: &target,
                    key: &key,
                    path: &before,
                    run,
                };
                let waited = wait_for_tv(&mut hooks, WAIT_EVERY, WAIT_FOR).await;
                bump(&self.wait_run);
                match waited {
                    TvWaitResult::Connected(adb) => adb,
                    TvWaitResult::Cancelled => {
                        return self.update(&|state| {
                            state.phase = TvPhase::Ready;
                            state.waiting = None;
                        })
                    }
                    other => {
                        let outcome = wait_outcome(&other).unwrap_or(TvOutcome::Unreachable);
                        return self.update(&|state| {
                            state.phase = TvPhase::Failed;
                            state.outcome = Some(outcome);
                            state.waiting = None;
                        });
                    }
                }
            }
        };
        self.update(&|state| state.waiting = None);
        let steps = Steps {
            installer: self,
            release,
        };
        install_steps(&mut adb, &steps, &target, &sighting, mode, block_ads).await;
    }

    fn fail(&self, outcome: TvOutcome) {
        self.update(&|state| {
            state.phase = TvPhase::Failed;
            state.outcome = Some(outcome);
        });
    }
}

struct WaitHooks<'a> {
    installer: &'a Arc<TvInstaller>,
    target: &'a TvTarget,
    key: &'a str,
    path: &'a TvPath,
    run: u64,
}

impl TvWaitHooks for WaitHooks<'_> {
    type Connection = TvConnection;
    type Error = AdbError;

    async fn probe(&mut self) -> PortState {
        match self.target {
            TvTarget::Usb { .. } => PortState::Open,
            TvTarget::Network { host } => answers_on(host, ADB_PORT, SCAN).await,
        }
    }

    async fn connect(&mut self) -> Result<TvConnection, AdbError> {
        let options = AdbOptions {
            key: self.key.to_owned(),
            certificate: None,
            connect: Duration::from_secs(8),
            approve: Duration::from_secs(60),
            command: Duration::from_secs(60),
        };
        let installer = self.installer;
        let waiting = waiting_for(TvWaitStep::Prompt, self.path);
        let attempt = async {
            let link = match self.target {
                TvTarget::Usb { id } => TvLink::Usb(usb_link(id).await?),
                TvTarget::Network { host } => {
                    TvLink::Network(tcp_link(host, ADB_PORT, options.connect).await?)
                }
            };
            let mut adb = AdbConnection::new(link, options);
            adb.open(|| {
                installer.update(&|state| {
                    state.phase = TvPhase::Allow;
                    state.waiting = Some(waiting.clone());
                });
            })
            .await?;
            Ok(adb)
        };
        tokio::select! {
            opened = attempt => opened,
            () = changed_from(&self.installer.wait_run, self.run) => Err(AdbError::Closed),
        }
    }

    fn classify(&self, error: &AdbError) -> String {
        connect_failure(error).as_str().to_owned()
    }

    fn on_step(&mut self, step: TvWaitStep) {
        let waiting = waiting_for(step, self.path);
        self.installer.update(&|state| {
            state.phase = if step == TvWaitStep::Prompt {
                TvPhase::Allow
            } else {
                TvPhase::Connecting
            };
            state.waiting = Some(waiting.clone());
        });
    }

    fn cancelled(&self) -> bool {
        *self.installer.wait_run.borrow() != self.run
    }

    async fn sleep(&mut self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn now(&self) -> Duration {
        self.installer.started.elapsed()
    }
}

struct Steps<'a> {
    installer: &'a Arc<TvInstaller>,
    release: PublishedRelease,
}

impl TvSteps for Steps<'_> {
    fn publish(&self, change: &dyn Fn(&mut TvInstallState)) {
        self.installer.update(change);
    }

    async fn fetch_apk(&self, edition: TvEdition) -> Result<Option<FetchedApk>, DownloadFailed> {
        apk_of(&self.installer.http, &self.release, edition).await
    }

    fn backup_folder(&self, target: &TvTarget) -> Option<PathBuf> {
        let folder = format!(
            "{}-{}",
            target_label(target),
            backup_stamp(SystemTime::now())
        );
        Some(
            self.installer
                .host
                .data_dir()?
                .join("tv-backups")
                .join(folder),
        )
    }

    fn server(&self) -> Option<String> {
        self.installer.host.server()
    }

    async fn closed(&self, target: &TvTarget) -> bool {
        for _ in 0..CLOSE_ATTEMPTS {
            match target {
                TvTarget::Usb { id } => {
                    // Debugging off takes the ADB interface off the cable.
                    if let Ok(still) = usb_devices().await {
                        if !still.iter().any(|one| &one.id == id) {
                            return true;
                        }
                    }
                }
                TvTarget::Network { host } => {
                    if answers_on(host, ADB_PORT, SCAN).await == PortState::Refused {
                        return true;
                    }
                }
            }
            tokio::time::sleep(CLOSE_WAIT).await;
        }
        false
    }
}
