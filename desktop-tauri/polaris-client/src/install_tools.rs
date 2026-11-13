//! What the app can install on this computer with one press, and exactly how.
//! Mirrors `desktop/src/shared/install-tools.ts` (the table) and the running part
//! of `desktop/src/main/install-tool.ts`; the confirmation dialog is the shell's.
//!
//! The page only ever names a tool from this list. The script's address and the
//! way it is started are decided here, in Rust, so a page cannot make the app run
//! anything else. They are the same official scripts the downloads screen shows
//! as a line to paste.

use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::AsyncReadExt;

/// The most a script may take: a slow download, not a stuck one.
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// The most a shell may take to start and say its PATH.
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(10);
/// How much of a script's output is kept, from its end.
const KEEP_OUTPUT: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallTool {
    Extension,
    Cli,
    Deck,
}

pub const INSTALL_TOOLS: [InstallTool; 3] =
    [InstallTool::Extension, InstallTool::Cli, InstallTool::Deck];

/// The browsers an unpacked extension can be loaded into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionBrowser {
    Chrome,
    Edge,
    Brave,
    Opera,
}

/// What a page may ask for: a tool from the list, and for the extension, a browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallRequest {
    pub tool: InstallTool,
    #[serde(default)]
    pub browser: Option<ExtensionBrowser>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallVia {
    StoreEntry,
    Unpacked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallFailure {
    Cancelled,
    Unsupported,
    Busy,
    Refused,
    Failed,
}

/// Answered to the page, which words the reason in its reader's language. `said`
/// is the script's own sentence for a refusal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum InstallResult {
    Done {
        ok: True,
        #[serde(skip_serializing_if = "Option::is_none")]
        via: Option<InstallVia>,
    },
    Failed {
        ok: False,
        reason: InstallFailure,
        #[serde(skip_serializing_if = "Option::is_none")]
        said: Option<String>,
    },
}

/// `true` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;
/// `false` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct False;

impl Serialize for True {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(true)
    }
}

impl Serialize for False {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl InstallResult {
    pub fn done(via: Option<InstallVia>) -> Self {
        Self::Done { ok: True, via }
    }

    pub fn failed(reason: InstallFailure) -> Self {
        Self::Failed {
            ok: False,
            reason,
            said: None,
        }
    }
}

fn scripts(tool: InstallTool) -> &'static str {
    match tool {
        InstallTool::Extension => "dashboard/apps/extension/scripts",
        InstallTool::Cli => "dashboard/packages/cli/scripts",
        InstallTool::Deck => "dashboard/apps/streamdeck/scripts",
    }
}

/// The sentence the confirmation asks.
pub fn install_question(tool: InstallTool) -> String {
    let name = match tool {
        InstallTool::Extension => "the Polaris browser extension",
        InstallTool::Cli => "the Polaris command-line client",
        InstallTool::Deck => "the Polaris Stream Deck plugin",
    };
    format!("Install {name} on this computer?")
}

/// The confirmation's detail for a script install.
pub const SCRIPT_DETAIL: &str =
    "It downloads the official release from GitHub and needs no administrator rights.";
/// The confirmation's detail for a store entry.
pub const STORE_DETAIL: &str = "Your browser installs it from its store and asks you to enable it when it opens. It needs no administrator rights, and removing the Polaris app removes this too.";

/// Whether a tool can be installed on a system (`std::env::consts::OS` names).
/// The deck's app has no Linux build.
pub fn installable(tool: InstallTool, platform: &str) -> bool {
    match tool {
        InstallTool::Deck => matches!(platform, "windows" | "macos"),
        _ => matches!(platform, "windows" | "macos" | "linux"),
    }
}

/// A program and its arguments, started with no shell in between on Windows and
/// a fixed line on the others.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
}

fn launch(file: &str, args: &[&str]) -> Launch {
    Launch {
        file: file.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn is_slug_part(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
}

/// The owner/name of a GitHub repository address, or `None` when it is not one.
pub fn repository_slug(repository: &str) -> Option<String> {
    let rest = repository.strip_prefix("git+").unwrap_or(repository);
    let rest = rest.strip_prefix("https://github.com/")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let rest = match rest.strip_suffix(".git") {
        Some(bare) if bare.contains('/') && !bare.ends_with('/') => bare,
        _ => rest,
    };
    let (owner, name) = rest.split_once('/')?;
    (is_slug_part(owner) && is_slug_part(name)).then(|| format!("{owner}/{name}"))
}

/// How to run a tool's installer.
pub fn install_launch(tool: InstallTool, platform: &str, repo: &str) -> Launch {
    let scripts = format!(
        "https://raw.githubusercontent.com/{repo}/main/{}",
        scripts(tool)
    );
    if platform == "windows" {
        let line = format!("irm '{scripts}/install.ps1' | iex");
        return launch(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", &line],
        );
    }
    let line = format!("curl -fsSL '{scripts}/install.sh' | sh");
    launch("/bin/sh", &["-c", &line])
}

const PATH_MARK: &str = "__POLARIS_PATH__";
const USUAL_PATHS: [&str; 2] = ["/usr/local/bin", "/opt/homebrew/bin"];

/// Prints the PATH of a shell, marked off from whatever its startup files print.
pub const PATH_PROBE: &str = "printf '__POLARIS_PATH__%s__POLARIS_PATH__' \"$PATH\"";

/// The PATH a script needs on macOS and Linux. An app opened from the desktop does
/// not get the one a terminal has, so Node would look missing where it is there.
pub fn install_path(probed: &str, inherited: Option<&str>) -> String {
    let said = probed
        .split_once(PATH_MARK)
        .and_then(|(_, rest)| rest.split_once(PATH_MARK))
        .map(|(path, _)| path)
        .filter(|path| !path.contains('\n'));
    let mut entries: Vec<&str> = Vec::new();
    for entry in [said, inherited].into_iter().flatten().chain(USUAL_PATHS) {
        for part in entry.split(':') {
            if !part.is_empty() && !entries.contains(&part) {
                entries.push(part);
            }
        }
    }
    entries.join(":")
}

/// The folders a script installs under.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Folders {
    pub home: String,
    /// %LOCALAPPDATA% on Windows.
    pub local_app_data: Option<String>,
    /// %APPDATA% on Windows.
    pub app_data: Option<String>,
    pub xdg_data: Option<String>,
}

impl Folders {
    /// This computer's.
    pub fn current() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        let home = var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
        Self {
            home,
            local_app_data: var("LOCALAPPDATA"),
            app_data: var("APPDATA"),
            xdg_data: var("XDG_DATA_HOME"),
        }
    }
}

/// What the script leaves behind when it worked.
pub fn installed_path(tool: InstallTool, platform: &str, folders: &Folders) -> String {
    let windows = platform == "windows";
    let join = |parts: &[&str]| parts.join(if windows { "\\" } else { "/" });
    let mac_data = join(&[&folders.home, "Library", "Application Support"]);
    let xdg = folders
        .xdg_data
        .clone()
        .unwrap_or_else(|| join(&[&folders.home, ".local", "share"]));
    let local = folders.local_app_data.as_deref().unwrap_or("");
    match tool {
        InstallTool::Extension if windows => join(&[local, "Polaris", "extension", "chrome"]),
        InstallTool::Extension if platform == "macos" => {
            join(&[&mac_data, "Polaris", "extension", "chrome"])
        }
        InstallTool::Extension => join(&[&xdg, "polaris", "extension", "chrome"]),
        InstallTool::Cli if windows => join(&[local, "Programs", "polaris-cli", "polaris.mjs"]),
        InstallTool::Cli => join(&[&xdg, "polaris-cli", "polaris.mjs"]),
        InstallTool::Deck => {
            let plugin = "io.github.fjrg2007.polaris.sdPlugin";
            if windows {
                join(&[
                    folders.app_data.as_deref().unwrap_or(""),
                    "Elgato",
                    "StreamDeck",
                    "Plugins",
                    plugin,
                ])
            } else {
                join(&[&mac_data, "com.elgato.StreamDeck", "Plugins", plugin])
            }
        }
    }
}

/// Whether the script ran to its end: what each script prints only once it has
/// reached it. Neither the exit code nor a file an earlier install left can tell.
pub fn script_finished(tool: InstallTool, output: &str) -> bool {
    output.contains(match tool {
        InstallTool::Extension => "First time: open chrome://extensions",
        InstallTool::Cli => "installed plr",
        InstallTool::Deck => "Next: open the Stream Deck app",
    })
}

/// `^!\s*polaris-cli:\s*` stripped, or `None` when the line is not one.
fn cli_problem(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('!')?.trim_start();
    Some(rest.strip_prefix("polaris-cli:")?.trim_start())
}

/// `^polaris:\s*` stripped, or `None` when the line is not one.
fn script_line(line: &str) -> Option<&str> {
    Some(line.strip_prefix("polaris:")?.trim_start())
}

/// The script's own last sentence, without its prefix or this account's folder,
/// or `None` when it said nothing of its own. A CLI refusal can span several lines.
pub fn last_said(output: &str, home: &str) -> Option<String> {
    let lines: Vec<&str> = output
        .split('\n')
        .map(|line| line.trim_end_matches('\r').trim())
        .collect();
    let end = lines.iter().rposition(|line| cli_problem(line).is_some());
    let said = if let Some(end) = end {
        let mut start = end;
        while start > 0 && cli_problem(lines[start - 1]).is_some() {
            start -= 1;
        }
        lines[start..=end]
            .iter()
            .filter_map(|line| cli_problem(line))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        lines
            .iter()
            .rev()
            .filter_map(|line| script_line(line))
            .find(|line| line.chars().any(|c| c.is_ascii_alphabetic()))?
            .to_owned()
    };
    if said.is_empty() {
        return None;
    }
    let said = if home.is_empty() {
        said
    } else {
        said.replace(home, "~")
    };
    let units: Vec<u16> = said.encode_utf16().collect();
    Some(String::from_utf16_lossy(&units[..units.len().min(300)]))
}

/// The answer for a script that did not leave the tool installed.
pub fn install_failure(tool: InstallTool, output: &str, home: &str) -> InstallResult {
    let said = if script_finished(tool, output) {
        None
    } else {
        last_said(output, home)
    };
    InstallResult::Failed {
        ok: False,
        reason: InstallFailure::Failed,
        said,
    }
}

/// A browser by the name the system gives the default one, or `None` for one no
/// extension of ours loads into.
pub fn browser_from_name(name: &str) -> Option<ExtensionBrowser> {
    let lower = name.to_lowercase();
    [
        ("brave", ExtensionBrowser::Brave),
        ("edge", ExtensionBrowser::Edge),
        ("opera", ExtensionBrowser::Opera),
        ("chrome", ExtensionBrowser::Chrome),
    ]
    .into_iter()
    .find(|(word, _)| lower.contains(word))
    .map(|(_, browser)| browser)
}

/// (Windows program, macOS app, Linux program).
fn programs(browser: ExtensionBrowser) -> (&'static str, &'static str, &'static str) {
    match browser {
        ExtensionBrowser::Chrome => ("chrome", "Google Chrome", "google-chrome"),
        ExtensionBrowser::Edge => ("msedge", "Microsoft Edge", "microsoft-edge"),
        ExtensionBrowser::Brave => ("brave", "Brave Browser", "brave-browser"),
        ExtensionBrowser::Opera => ("opera", "Opera", "opera"),
    }
}

fn browser_word(browser: ExtensionBrowser) -> &'static str {
    match browser {
        ExtensionBrowser::Chrome => "chrome",
        ExtensionBrowser::Edge => "edge",
        ExtensionBrowser::Brave => "brave",
        ExtensionBrowser::Opera => "opera",
    }
}

/// How to open a browser on its extensions page, the one step a script cannot
/// take for it: browsers only install on their own from their store.
pub fn extensions_page_launch(browser: ExtensionBrowser, platform: &str) -> Launch {
    let page = format!("{}://extensions", browser_word(browser));
    let (windows, mac, linux) = programs(browser);
    match platform {
        "windows" => {
            let line = format!("Start-Process '{windows}' '{page}'");
            launch(
                "powershell.exe",
                &["-NoProfile", "-NonInteractive", "-Command", &line],
            )
        }
        "macos" => launch("/usr/bin/open", &["-a", mac, &page]),
        _ => launch(linux, &[&page]),
    }
}

/// How to open a browser as it is, for the confirmation it shows on opening.
pub fn browser_launch(browser: ExtensionBrowser, platform: &str) -> Launch {
    let (windows, mac, linux) = programs(browser);
    match platform {
        "windows" => {
            let line = format!("Start-Process '{windows}'");
            launch(
                "powershell.exe",
                &["-NoProfile", "-NonInteractive", "-Command", &line],
            )
        }
        "macos" => launch("/usr/bin/open", &["-a", mac]),
        _ => launch(linux, &[]),
    }
}

/// Where the extension is listed. Empty until it is published: nothing is guessed.
/// The same ids as the page's `EXTENSION_LISTINGS` (dashboard/packages/ui).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StoreListings {
    pub chrome_web_store: Option<&'static str>,
    pub edge_addons: Option<&'static str>,
}

pub const STORE_LISTINGS: StoreListings = StoreListings {
    chrome_web_store: None,
    edge_addons: None,
};

/// The update addresses the stores serve their items from.
pub const CHROME_WEB_STORE_UPDATE: &str = "https://clients2.google.com/service/update2/crx";
pub const EDGE_ADDONS_UPDATE: &str = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

fn is_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// A browser's "external extension" entry for the store listing (per-user and
/// documented only; see the TypeScript original for the sources).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalEntry {
    Registry { key: String, update_url: String },
    File { path: String, contents: String },
}

pub fn external_entry(
    browser: ExtensionBrowser,
    platform: &str,
    folders: &Folders,
    listings: StoreListings,
) -> Option<ExternalEntry> {
    let chrome = listings.chrome_web_store.filter(|id| is_extension_id(id));
    let edge = listings.edge_addons.filter(|id| is_extension_id(id));
    let file = |path: String, update_url: &str| ExternalEntry::File {
        path,
        contents: format!("{{\n    \"external_update_url\": \"{update_url}\"\n}}\n"),
    };
    match browser {
        ExtensionBrowser::Chrome => {
            let chrome = chrome?;
            match platform {
                "windows" => Some(ExternalEntry::Registry {
                    key: format!("HKCU\\Software\\Google\\Chrome\\Extensions\\{chrome}"),
                    update_url: CHROME_WEB_STORE_UPDATE.to_owned(),
                }),
                "macos" => {
                    let dir = [
                        &folders.home,
                        "Library",
                        "Application Support",
                        "Google",
                        "Chrome",
                        "External Extensions",
                    ]
                    .join("/");
                    Some(file(
                        format!("{dir}/{chrome}.json"),
                        CHROME_WEB_STORE_UPDATE,
                    ))
                }
                _ => None,
            }
        }
        ExtensionBrowser::Edge if platform != "windows" => {
            let (id, update_url) = match (edge, chrome) {
                (Some(edge), _) => (edge, EDGE_ADDONS_UPDATE),
                (None, Some(chrome)) => (chrome, CHROME_WEB_STORE_UPDATE),
                (None, None) => return None,
            };
            let dir = if platform == "macos" {
                [
                    &folders.home,
                    "Library",
                    "Application Support",
                    "Microsoft Edge",
                    "External Extensions",
                ]
                .join("/")
            } else {
                [
                    &folders.home,
                    ".config",
                    "microsoft-edge",
                    "External Extensions",
                ]
                .join("/")
            };
            Some(file(format!("{dir}/{id}.json"), update_url))
        }
        _ => None,
    }
}

/// Writes a registry entry, replacing the same one: running it twice is running it once.
pub fn registry_add_launch(key: &str, update_url: &str) -> Launch {
    launch(
        "reg.exe",
        &[
            "add",
            key,
            "/v",
            "update_url",
            "/t",
            "REG_SZ",
            "/d",
            update_url,
            "/f",
        ],
    )
}

/// Removes a registry entry this app wrote.
pub fn registry_delete_launch(key: &str) -> Launch {
    launch("reg.exe", &["delete", key, "/f"])
}

/// The entries the app may have written on Windows, for its uninstaller to take back.
pub fn windows_entry_keys(listings: StoreListings) -> Vec<String> {
    match external_entry(
        ExtensionBrowser::Chrome,
        "windows",
        &Folders::default(),
        listings,
    ) {
        Some(ExternalEntry::Registry { key, .. }) => vec![key],
        _ => Vec::new(),
    }
}

/// Runs a launch with a time limit, answering its exit code (`None` when it was
/// ended) and the end of what it printed. Fails only when it could not start.
pub async fn run_launch(
    launch: &Launch,
    timeout: Duration,
    path: Option<&str>,
) -> std::io::Result<(Option<i32>, String)> {
    let mut command = tokio::process::Command::new(&launch.file);
    command
        .args(launch.args.iter().map(OsString::from))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn()?;
    let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
    let mut output: Vec<u8> = Vec::new();
    let mut keep = |bytes: &[u8]| {
        output.extend_from_slice(bytes);
        if output.len() > KEEP_OUTPUT {
            output.drain(..output.len() - KEEP_OUTPUT);
        }
    };
    let collected = tokio::time::timeout(timeout, async {
        let (mut a, mut b) = ([0u8; 4096], [0u8; 4096]);
        while stdout.is_some() || stderr.is_some() {
            tokio::select! {
                read = async { stdout.as_mut().expect("checked").read(&mut a).await }, if stdout.is_some() => match read {
                    Ok(0) | Err(_) => stdout = None,
                    Ok(count) => keep(&a[..count]),
                },
                read = async { stderr.as_mut().expect("checked").read(&mut b).await }, if stderr.is_some() => match read {
                    Ok(0) | Err(_) => stderr = None,
                    Ok(count) => keep(&b[..count]),
                },
            }
        }
        child.wait().await
    })
    .await;
    let code = match collected {
        Ok(status) => status?.code(),
        Err(_) => {
            let _ = child.kill().await;
            None
        }
    };
    Ok((code, String::from_utf8_lossy(&output).into_owned()))
}

/// The PATH a script runs with: on macOS and Linux, the user's own shell's.
/// `None` on Windows, where the app's own environment is used.
pub async fn script_path(platform: &str) -> Option<String> {
    if platform == "windows" {
        return None;
    }
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.is_empty())
        .unwrap_or_else(|| "/bin/sh".into());
    let probe = launch(&shell, &["-ilc", PATH_PROBE]);
    let output = run_launch(&probe, SHELL_TIMEOUT, None)
        .await
        .map(|(_, output)| output)
        .unwrap_or_default();
    Some(install_path(&output, std::env::var("PATH").ok().as_deref()))
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// One install at a time: held while one runs, released when dropped.
#[derive(Debug)]
pub struct InstallSlot(());

impl InstallSlot {
    pub fn take() -> Option<Self> {
        RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
            .then_some(Self(()))
    }
}

impl Drop for InstallSlot {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::Release);
    }
}

/// Runs the official script for `tool` (after the shell's confirmation) and tells
/// whether it left the tool installed. `Ok(path)` is where it is.
pub async fn run_script(
    tool: InstallTool,
    platform: &str,
    repo: &str,
    folders: &Folders,
) -> Result<String, InstallResult> {
    let launch = install_launch(tool, platform, repo);
    let path = script_path(platform).await;
    let (code, output) = run_launch(&launch, INSTALL_TIMEOUT, path.as_deref())
        .await
        .map_err(|error| {
            eprintln!("polaris: an install did not run: {error}");
            InstallResult::failed(InstallFailure::Failed)
        })?;
    let installed = installed_path(tool, platform, folders);
    if code != Some(0) || !script_finished(tool, &output) || !Path::new(&installed).exists() {
        eprintln!("polaris: an install ended without the tool: {code:?}");
        return Err(install_failure(tool, &output, &folders.home));
    }
    Ok(installed)
}
