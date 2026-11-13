//! The app's own pages beyond the servers page and the key form - the push
//! window, Install on a TV and the updating splash (`openLocalWindow` in
//! `desktop/src/main/windows.ts`) - and the `polarisDesktop` members that open
//! them or answer from the system: the default browser, whether anybody is at
//! the computer, the mail defaults page, closing a notice and the update.
//!
//! Every page is `ui/<page>.html` with its strings in `ui/i18n.js`, in English
//! and Spanish. A test below keeps the files, this table and those strings in step.

use crate::Outcome;
use polaris_client::install_tools::{browser_from_name, ExtensionBrowser};
use polaris_client::update_ready::{UpdateReady, NO_UPDATE_WAITING};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow};

/// The TV window's label (`openLocalWindow("tv")`).
pub const TV_WINDOW: &str = "tv";
/// The updating splash's label.
pub const UPDATING_WINDOW: &str = "updating";

/// Seconds without input after which the computer reads as idle
/// (`IDLE_AFTER_SECONDS`): fixed here so a page cannot turn it into a probe.
pub const IDLE_AFTER_SECONDS: u64 = 120;

/// The app's own pages opened by this module, each with its file and size as
/// `openLocalWindow` is given them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Push,
    Tv,
    Updating,
}

impl Page {
    #[cfg(test)]
    pub const ALL: [Page; 3] = [Page::Push, Page::Tv, Page::Updating];

    pub fn file(self) -> &'static str {
        match self {
            Page::Push => "push.html",
            Page::Tv => "tv.html",
            Page::Updating => "updating.html",
        }
    }

    fn size(self) -> (f64, f64) {
        match self {
            Page::Push => (760.0, 620.0),
            Page::Tv => (560.0, 620.0),
            Page::Updating => (380.0, 360.0),
        }
    }
}

/// Open one of the app's pages in a window of its own, at the account's text size.
pub fn open_page(
    app: &AppHandle,
    label: &str,
    page: Page,
    title: &str,
) -> tauri::Result<WebviewWindow> {
    let (width, height) = page.size();
    crate::hardware::window(app, label, WebviewUrl::App(page.file().into()))
        .initialization_script(crate::bridge::local_script(app))
        .title(title)
        .inner_size(width, height)
        .resizable(page != Page::Updating)
        .build()
}

fn bring_forward(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// `openTvInstall`: the Install on a TV window, or its open one brought forward.
#[tauri::command]
pub fn open_tv_install(app: AppHandle, window: WebviewWindow) -> bool {
    crate::ipc::from_polaris(&app, &window) && show_tv_window(&app)
}

/// The TV window, or its open one brought forward; the tray's Install on a TV
/// opens it too when no Polaris is loaded.
pub fn show_tv_window(app: &AppHandle) -> bool {
    if let Some(open) = app.get_webview_window(TV_WINDOW) {
        bring_forward(&open);
        return true;
    }
    match open_page(app, TV_WINDOW, Page::Tv, "Install on a TV - Polaris") {
        Ok(_) => true,
        Err(error) => {
            eprintln!("polaris: the TV window could not open: {error}");
            false
        }
    }
}

/// The updating splash, shown while an update goes in before the app opens.
/// Nothing reaches it while the updater has no endpoint (`updater.rs`): only
/// [`install_update`] calls it, and only for an update that is ready.
pub fn show_updating(app: &AppHandle) {
    if let Some(open) = app.get_webview_window(UPDATING_WINDOW) {
        bring_forward(&open);
    } else if let Err(error) = open_page(app, UPDATING_WINDOW, Page::Updating, "Polaris") {
        eprintln!("polaris: the updating window could not open: {error}");
    }
}

/// The update waiting to be installed: always none in the beta, which never
/// downloads one (`updater.rs`).
#[derive(Default)]
pub struct Updates {
    ready: std::sync::Mutex<Option<UpdateReady>>,
}

impl Updates {
    fn current(&self) -> Option<UpdateReady> {
        self.ready
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// `updateReady`: the update waiting, as the dashboard reads it.
#[tauri::command]
pub fn update_ready(
    app: AppHandle,
    window: WebviewWindow,
    updates: tauri::State<'_, Updates>,
) -> Option<UpdateReady> {
    crate::ipc::from_polaris(&app, &window)
        .then(|| updates.current())
        .flatten()
}

/// `installUpdate`: takes nothing, since what is installed is what the app
/// downloaded and checked itself. The beta has nothing to install.
#[tauri::command]
pub fn install_update(
    app: AppHandle,
    window: WebviewWindow,
    updates: tauri::State<'_, Updates>,
) -> Outcome {
    if !crate::ipc::from_polaris(&app, &window) {
        return Outcome::error(crate::ipc::REFUSAL);
    }
    if updates.current().is_none() {
        return Outcome::error(NO_UPDATE_WAITING);
    }
    show_updating(&app);
    Outcome::error(polaris_client::update_ready::UPDATE_NOT_INSTALLED)
}

/// `openMailDefaults`: the Windows page where Polaris is made the mail app. The
/// page cannot open an `ms-settings:` link itself.
#[tauri::command]
pub fn open_mail_defaults(app: AppHandle, window: WebviewWindow) -> bool {
    if !crate::ipc::from_polaris(&app, &window) || !cfg!(windows) {
        return false;
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(mail_defaults_link(), None::<&str>)
        .is_ok()
}

/// The Settings page for the beta's own registration (`REGISTERED_NAME`).
pub fn mail_defaults_link() -> String {
    format!(
        "ms-settings:defaultapps?registeredAppUser={}",
        polaris_client::push_local::encode_uri_component(crate::mail_handler::REGISTERED_NAME)
    )
}

/// The browser by the name the system gives the default one: Firefox first, as
/// the Electron handler reads it, then the ones an extension of ours loads into.
pub fn browser_named(name: &str) -> Option<&'static str> {
    if name.to_lowercase().contains("firefox") {
        return Some("firefox");
    }
    browser_from_name(name).map(|browser| match browser {
        ExtensionBrowser::Chrome => "chrome",
        ExtensionBrowser::Edge => "edge",
        ExtensionBrowser::Brave => "brave",
        ExtensionBrowser::Opera => "opera",
    })
}

/// The name of the program that opens `https:` links.
#[cfg(windows)]
fn default_browser_name() -> Option<String> {
    use winreg::enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
    let choice = winreg::RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice",
        )
        .ok()?;
    let prog_id: String = choice.get_value("ProgId").ok()?;
    let named: Option<String> = winreg::RegKey::predef(HKEY_CLASSES_ROOT)
        .open_subkey(format!(r"{prog_id}\Application"))
        .and_then(|key| key.get_value("ApplicationName"))
        .ok();
    Some(named.map_or(prog_id.clone(), |name| format!("{name} {prog_id}")))
}

/// The desktop file `xdg-settings` names as the default browser.
#[cfg(target_os = "linux")]
fn default_browser_name() -> Option<String> {
    let out = std::process::Command::new("xdg-settings")
        .args(["get", "default-web-browser"])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

/// macOS answers through Launch Services, which the beta does not link.
#[cfg(not(any(windows, target_os = "linux")))]
fn default_browser_name() -> Option<String> {
    None
}

/// `defaultBrowser`: which browser opens links, for the extension's install step.
#[tauri::command]
pub async fn default_browser(app: AppHandle, window: WebviewWindow) -> Option<&'static str> {
    if !crate::ipc::from_polaris(&app, &window) {
        return None;
    }
    let name = tauri::async_runtime::spawn_blocking(default_browser_name)
        .await
        .ok()
        .flatten()?;
    browser_named(&name)
}

/// What `powerMonitor.getSystemIdleState` answers for seconds since the last input.
pub fn idle_state(idle_seconds: Option<u64>) -> &'static str {
    match idle_seconds {
        Some(seconds) if seconds >= IDLE_AFTER_SECONDS => "idle",
        Some(_) => "active",
        None => "unknown",
    }
}

#[cfg(windows)]
fn idle_seconds() -> Option<u64> {
    #[repr(C)]
    struct LastInputInfo {
        size: u32,
        time: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(info: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    let mut info = LastInputInfo {
        size: u32::try_from(std::mem::size_of::<LastInputInfo>()).ok()?,
        time: 0,
    };
    // SAFETY: `info` is a LASTINPUTINFO with its size set, as the call requires,
    // and lives for the whole call; GetTickCount takes nothing.
    let (read, now) = unsafe { (GetLastInputInfo(&mut info), GetTickCount()) };
    (read != 0).then(|| u64::from(now.wrapping_sub(info.time)) / 1000)
}

/// Where the system cannot say, `unknown`, which the dashboard reads as
/// somebody being here.
#[cfg(not(windows))]
fn idle_seconds() -> Option<u64> {
    None
}

/// `systemIdle`: whether anybody is at this computer.
#[tauri::command]
pub fn system_idle(app: AppHandle, window: WebviewWindow) -> &'static str {
    if !crate::ipc::from_polaris(&app, &window) {
        return "unknown";
    }
    idle_state(idle_seconds())
}

/// `closeNotice`: take a notice back by its tag. The notification plugin cannot
/// on desktop (no replace or remove by tag), so a tag is read and nothing more.
#[tauri::command]
pub fn close_notice(app: AppHandle, window: WebviewWindow, tag: serde_json::Value) {
    let _readable =
        crate::ipc::from_polaris(&app, &window) && tag.as_str().is_some_and(|tag| tag.len() <= 200);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const UI: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../ui");

    fn ui(file: &str) -> String {
        std::fs::read_to_string(format!("{UI}/{file}")).unwrap_or_else(|_| panic!("ui/{file}"))
    }

    /// The keys of one language's table in `i18n.js`.
    fn keys(language: &str) -> BTreeSet<String> {
        let text = ui("i18n.js");
        let start = text
            .find(&format!("\n    {language}: {{\n"))
            .expect("the language's table");
        let table = &text[start..];
        let table = &table[..table.find("\n    }").expect("the table's end")];
        table
            .lines()
            .filter_map(|line| line.trim().strip_prefix('"'))
            .map(|line| line[..line.find('"').expect("a closed key")].to_owned())
            .collect()
    }

    /// The keys a page names: `data-text*="key"` in its HTML, `t("key"` in its script.
    fn used(file: &str) -> BTreeSet<String> {
        let text = ui(file);
        let mut found = BTreeSet::new();
        for marker in ["=\"", "t(\""] {
            for (at, _) in text.match_indices(marker) {
                let before = &text[..at];
                let named = if marker == "t(\"" {
                    !before.ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.')
                } else {
                    before
                        .rsplit(char::is_whitespace)
                        .next()
                        .is_some_and(|name| name.starts_with("data-text"))
                };
                if named {
                    let rest = &text[at + marker.len()..];
                    found.insert(rest[..rest.find('"').expect("a closed key")].to_owned());
                }
            }
        }
        found
    }

    const TRANSLATED: [(&str, &str); 5] = [
        ("index.html", "main.js"),
        ("api-key.html", "api-key.js"),
        ("push.html", "push.js"),
        ("tv.html", "tv.js"),
        ("updating.html", "updating.js"),
    ];

    #[test]
    fn both_languages_have_the_same_strings() {
        let english = keys("en");
        assert!(english.len() > 100, "{}", english.len());
        assert_eq!(english, keys("es"));
    }

    #[test]
    fn every_page_names_only_strings_both_languages_have() {
        let known = keys("en");
        for (html, js) in TRANSLATED {
            let page = ui(html);
            assert!(
                page.contains("<script src=\"i18n.js\""),
                "{html} loads its strings"
            );
            assert!(
                page.contains(&format!("<script src=\"{js}\"")),
                "{html} loads {js}"
            );
            let names: BTreeSet<String> = used(html).union(&used(js)).cloned().collect();
            assert!(!names.is_empty(), "{html} is translated");
            let missing: Vec<_> = names.difference(&known).collect();
            assert!(missing.is_empty(), "{html}: {missing:?}");
        }
    }

    #[test]
    fn every_page_is_a_file_the_window_builder_opens() {
        let developer = include_str!("developer.rs");
        let pages = include_str!("pages.rs");
        for page in Page::ALL {
            assert!(std::path::Path::new(&format!("{UI}/{}", page.file())).is_file());
            let script = page.file().replace(".html", ".js");
            assert!(ui(page.file()).contains(&format!("src=\"{script}\"")));
            assert!(std::path::Path::new(&format!("{UI}/{script}")).is_file());
            let named = format!("Page::{page:?}");
            assert!(developer.contains(&named) || pages.matches(&named).count() > 2);
        }
    }

    #[test]
    fn the_shared_assets_are_the_electron_apps_own() {
        let electron = concat!(env!("CARGO_MANIFEST_DIR"), "/../../desktop/src/renderer");
        for file in [
            "mark.svg",
            "fonts/IBMPlexSans-Regular.woff2",
            "fonts/IBMPlexSans-Medium.woff2",
            "fonts/IBMPlexSans-SemiBold.woff2",
            "fonts/NOTICE.md",
        ] {
            let ours = std::fs::read(format!("{UI}/{file}")).expect("copied");
            assert_eq!(
                ours,
                std::fs::read(format!("{electron}/{file}")).expect("Electron's"),
                "{file}"
            );
        }
        let styles = std::fs::read_to_string(format!("{electron}/styles.css")).expect("Electron's");
        assert_eq!(
            ui("page.css").replace("\r\n", "\n"),
            styles.replace("\r\n", "\n")
        );
    }

    /// The values of every `name="..."` attribute in a page.
    fn attributes<'a>(html: &'a str, name: &str) -> Vec<&'a str> {
        let marker = format!(" {name}=\"");
        html.match_indices(&marker)
            .map(|(at, _)| {
                let rest = &html[at + marker.len()..];
                &rest[..rest.find('"').expect("a closed attribute")]
            })
            .collect()
    }

    /// Whether a reference stays inside the app: a relative path, no scheme, no host.
    fn inside_the_app(reference: &str) -> bool {
        !reference.is_empty() && !reference.starts_with("//") && !reference.contains(':')
    }

    /// The only sources a page's policy may name besides keywords: the IPC
    /// origin Tauri's `invoke` posts to.
    const IPC_SOURCES: [&str; 2] = ["ipc:", "http://ipc.localhost"];

    #[test]
    fn pages_take_nothing_from_outside_the_app() {
        for page in Page::ALL {
            assert!(
                ui(page.file()).contains("default-src 'none'; script-src 'self'"),
                "{page:?}"
            );
        }
        for (file, _) in TRANSLATED {
            let html = ui(file);
            for reference in attributes(&html, "src")
                .into_iter()
                .chain(attributes(&html, "href"))
            {
                assert!(inside_the_app(reference), "{file}: {reference}");
            }
            for policy in attributes(&html, "content")
                .into_iter()
                .filter(|one| one.contains("-src "))
            {
                for directive in policy.split(';') {
                    for source in directive.split_whitespace().skip(1) {
                        let keyword = source.starts_with('\'') && source.ends_with('\'');
                        assert!(keyword || IPC_SOURCES.contains(&source), "{file}: {source}");
                    }
                }
            }
        }
        for sheet in ["page.css", "styles.css"] {
            let css = ui(sheet);
            assert!(!css.contains("@import"), "{sheet}");
            for (at, _) in css.match_indices("url(") {
                let rest = &css[at + 4..];
                let reference =
                    rest[..rest.find(')').expect("a closed url")].trim_matches(['"', '\'']);
                assert!(inside_the_app(reference), "{sheet}: {reference}");
            }
        }
    }

    #[test]
    fn the_outside_check_catches_an_outside_script_style_or_font() {
        let page = r#"<script src="https://cdn.example.com/a.js"></script><link href="//fonts.example.com/f.css" />"#;
        let found: Vec<_> = attributes(page, "src")
            .into_iter()
            .chain(attributes(page, "href"))
            .collect();
        assert_eq!(found.len(), 2);
        assert!(found.iter().all(|one| !inside_the_app(one)));
        assert!(!inside_the_app("data:font/woff2;base64,AA"));
        assert!(inside_the_app("fonts/IBMPlexSans-Regular.woff2"));
        assert!(!IPC_SOURCES.contains(&"https://polaris.example.com"));
    }

    #[test]
    fn idle_reads_as_the_power_monitor() {
        assert_eq!(idle_state(None), "unknown");
        assert_eq!(idle_state(Some(0)), "active");
        assert_eq!(idle_state(Some(119)), "active");
        assert_eq!(idle_state(Some(120)), "idle");
    }

    #[test]
    fn the_default_browser_reads_as_the_electron_handler() {
        assert_eq!(
            browser_named("Firefox FirefoxURL-308046B0AF4A39CB"),
            Some("firefox")
        );
        assert_eq!(browser_named("Google Chrome ChromeHTML"), Some("chrome"));
        assert_eq!(browser_named("MSEdgeHTM"), Some("edge"));
        assert_eq!(browser_named("Brave BraveHTML"), Some("brave"));
        assert_eq!(browser_named("Opera OperaStable"), Some("opera"));
        assert_eq!(browser_named("brave-browser.desktop"), Some("brave"));
        assert_eq!(browser_named("Safari"), None);
    }

    #[test]
    fn the_mail_defaults_link_names_the_betas_registration() {
        assert_eq!(
            mail_defaults_link(),
            "ms-settings:defaultapps?registeredAppUser=Polaris%20Beta"
        );
    }

    #[test]
    fn the_update_is_never_ready_in_the_beta() {
        assert!(Updates::default().current().is_none());
        let pages = include_str!("pages.rs");
        // Opened from one place, behind an update that is never there.
        assert_eq!(pages.matches(concat!("show_updating", "(&app)")).count(), 1);
        assert!(!include_str!("main.rs").contains(concat!("show_updating", "(")));
    }
}
