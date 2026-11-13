//! Polaris desktop, Tauri beta: the Polaris window on the server in use, the
//! servers page (first run, and the list to add, rename, remove and switch),
//! navigation kept on the Polaris, permissions for it alone, the same Polaris on
//! its local address when the usual one stops answering, a tray icon, one
//! instance, and `polaris://` links.
//!
//! Not released and not offered to anybody: the Electron app in `desktop/` is
//! the shipped one until `docs/desktop-tauri-parity.md` says otherwise.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod call_keys;
mod developer;
mod host_transfer;
mod ipc;
mod key_flow;
mod login_item;
mod mail_handler;
#[cfg(feature = "measure")]
mod measure;
mod notices;
mod os_prefs;
mod share;
mod tray;
mod tv;
mod updater;
mod voice_widget;
mod vpn;
#[cfg(windows)]
mod webview2;

use polaris_client::deep_link::{read_deep_link, DeepLinkSteps, DeepLinks};
use polaris_client::instance::{Failover, InstanceRecord, DEFAULT_HOLD, UNTRUSTED_WORDS};
use polaris_client::instance_store::{
    read_instances_value, read_stored_instance, write_stored_instance, INSTANCES_FILE, RELEARN_MS,
};
use polaris_client::local_ca_pin::{pin_scope, PinVerifier};
use polaris_client::mailto::mailto_in;
use polaris_client::navigation::{
    is_safe_external_url, is_server_url, main_frame_step, server_path, NavigationVerdict,
};
use polaris_client::same_instance::SameInstance;
use polaris_client::servers::{list_servers, same_instance_words, SavedServer};
use polaris_client::settings::{
    electron_data_folder, import_electron_settings, import_once, Settings, SETTINGS_FILE,
};
use polaris_client::window_failover::{
    back_step, failed_load_step, same_place_on, title_with, BackStep, FailedLoad,
};
use polaris_client::{probe, probe_client, InstanceUrl, NetFailure, Verdict};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const SERVERS: &str = "servers";
/// Where a Polaris window opens.
const START: &str = "/home";
/// The titles of the page Polaris's service worker answers with when the server
/// is gone (`OFFLINE_TITLES` in `reachability.ts`). The load succeeds, so no
/// failure event reports it.
const OFFLINE_TITLES: [&str; 2] = ["Polaris is not reachable", "No se puede acceder a Polaris"];

/// What a command that changes something answers (`Outcome` in `shared/bridge.ts`).
#[derive(Debug, Serialize)]
#[serde(untagged)]
enum Outcome {
    Ok { ok: bool },
    Error { ok: bool, error: String },
}

impl Outcome {
    fn ok() -> Self {
        Self::Ok { ok: true }
    }
    fn error(error: impl Into<String>) -> Self {
        Self::Error {
            ok: false,
            error: error.into(),
        }
    }
}

/// The client the Polaris commands talk to the server with: the one that
/// trusts the pinned local CA, shared with the failover.
struct Http(reqwest::Client);

/// The Polaris in use, checked again on the way out: the list on disk is
/// anything anybody wrote.
fn saved_server(app: &AppHandle) -> Option<InstanceUrl> {
    InstanceUrl::parse(&shared(app).current()?).ok()
}

/// Everything the windows share.
struct Shared {
    folder: PathBuf,
    settings: Mutex<()>,
    current: Mutex<Option<String>>,
    /// The proven local address the main window is on, or `None` on the usual one.
    alternate: Mutex<Option<String>>,
    /// Why the server in use failed to open, for the servers page.
    load_error: Mutex<Option<String>>,
    /// Whether the main window is out on a provider's round trip.
    trip: AtomicBool,
    offline: AtomicBool,
    failing_over: AtomicBool,
    back_on_blur: AtomicBool,
    watching: AtomicBool,
    http: reqwest::Client,
    probe_http: reqwest::Client,
    pins: Arc<PinVerifier>,
    failovers: Mutex<HashMap<String, Arc<Failover>>>,
    learning: Mutex<HashSet<String>>,
    same_instance: SameInstance,
    capabilities: Mutex<HashSet<String>>,
    windows: AtomicUsize,
    links: OnceLock<Arc<DeepLinks<Steps>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn shared(app: &AppHandle) -> tauri::State<'_, Shared> {
    app.state::<Shared>()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl Shared {
    fn settings_file(&self) -> PathBuf {
        self.folder.join(SETTINGS_FILE)
    }
    fn instances_file(&self) -> PathBuf {
        self.folder.join(INSTANCES_FILE)
    }
    fn settings(&self) -> Settings {
        Settings::load(&self.settings_file())
    }
    /// Read, change and write the file, one writer at a time.
    fn update_settings(&self, change: impl FnOnce(&mut Settings)) -> Result<(), String> {
        self.change_settings(change, "The list could not be saved on this computer.")
    }
    /// The same, saying `failure` when the file cannot be written.
    fn change_settings(
        &self,
        change: impl FnOnce(&mut Settings),
        failure: &str,
    ) -> Result<(), String> {
        let _writer = lock(&self.settings);
        let mut settings = self.settings();
        change(&mut settings);
        settings
            .save(&self.settings_file())
            .map_err(|_| failure.to_owned())
    }
    fn saved(&self) -> Vec<SavedServer> {
        self.settings().known_servers()
    }
    fn current(&self) -> Option<String> {
        lock(&self.current).clone()
    }
    fn alternate(&self) -> Option<String> {
        lock(&self.alternate).clone()
    }
    fn load_error(&self) -> Option<String> {
        lock(&self.load_error).clone()
    }
    /// The one origin Polaris windows may be on.
    fn active_origin(&self) -> Option<String> {
        let current = self.current();
        polaris_client::window_failover::active_origin(
            current.as_deref(),
            self.alternate().as_deref(),
        )
        .map(str::to_owned)
    }
    fn mark_capability(&self, origin: &str) -> bool {
        lock(&self.capabilities).insert(origin.to_owned())
    }
    fn capability_count(&self) -> usize {
        lock(&self.capabilities).len()
    }
}

/// Every address the stored record of `server` says it answers on.
fn stored_addresses(app: &AppHandle, server: &str) -> Vec<String> {
    read_stored_instance(&shared(app).instances_file(), server)
        .map(|stored| stored.record.addresses)
        .unwrap_or_default()
}

fn is_polaris_label(label: &str) -> bool {
    label == MAIN || label.starts_with("polaris-")
}

/// Who a listed server is: the record kept on disk, or asked over its own address.
async fn known_instance(app: &AppHandle, server: String) -> Option<InstanceRecord> {
    let state = shared(app);
    if let Some(stored) = read_stored_instance(&state.instances_file(), &server) {
        return Some(stored.record);
    }
    learn_server(app, &server).await
}

/// Learn the server's identity and local addresses over its own address.
async fn learn_server(app: &AppHandle, server: &str) -> Option<InstanceRecord> {
    let state = shared(app);
    let timeout = polaris_client::instance::DEFAULT_TIMEOUT;
    let record = polaris_client::instance::learn_instance(&state.http, server, timeout).await?;
    let failover = Failover::new(state.http.clone(), server, Some(record.clone()));
    lock(&state.failovers).insert(server.to_owned(), Arc::new(failover));
    // Kept in memory for this run when the file cannot be written.
    let _ = write_stored_instance(&state.instances_file(), server, record.clone(), now_ms());
    if state.current().as_deref() == Some(server) {
        state.pins.set_scope(pin_scope(Some(server), Some(&record)));
    }
    Some(record)
}

/// The failover for a server, read back from disk the first time. `None` while
/// nothing has been learned yet; asking also starts learning it (once a run).
fn failover_for(app: &AppHandle, server: &str) -> Option<Arc<Failover>> {
    let state = shared(app);
    if let Some(held) = lock(&state.failovers).get(server) {
        return Some(held.clone());
    }
    let Some(stored) = read_stored_instance(&state.instances_file(), server) else {
        if lock(&state.learning).insert(server.to_owned()) {
            let app = app.clone();
            let server = server.to_owned();
            tauri::async_runtime::spawn(async move { learn_server(&app, &server).await });
        }
        return None;
    };
    let relearn = now_ms().saturating_sub(stored.learned_at) > RELEARN_MS;
    if relearn && lock(&state.learning).insert(server.to_owned()) {
        let app = app.clone();
        let server = server.to_owned();
        tauri::async_runtime::spawn(async move { learn_server(&app, &server).await });
    }
    state
        .pins
        .set_scope(pin_scope(state.current().as_deref(), Some(&stored.record)));
    let failover = Arc::new(Failover::new(
        state.http.clone(),
        server,
        Some(stored.record),
    ));
    lock(&state.failovers).insert(server.to_owned(), failover.clone());
    Some(failover)
}

/// Whether the reason a probe failed is a certificate this computer does not trust.
fn untrusted(verdict: &Verdict) -> bool {
    matches!(verdict, Verdict::Unreachable(NetFailure::Certificate))
}

/// The sentence for an address that is a Polaris already listed under another name.
async fn already_listed(app: &AppHandle, origin: &str, verdict: &Verdict) -> Option<String> {
    let untrusted = untrusted(verdict);
    if !matches!(verdict, Verdict::Polaris { .. }) && !untrusted {
        return None;
    }
    let state = shared(app);
    let saved = state.saved();
    if saved.iter().any(|server| server.origin == origin) {
        return None;
    }
    let same = state
        .same_instance
        .same_instance_as(origin, &saved, untrusted, &state.http, |server| {
            known_instance(app, server)
        })
        .await?;
    list_servers(&saved, state.current().as_deref())
        .into_iter()
        .find(|row| row.origin == same)
        .map(|row| same_instance_words(&row))
}

async fn verdict_for(app: &AppHandle, origin: &str) -> Verdict {
    match InstanceUrl::parse(origin) {
        Ok(url) => probe(&shared(app).probe_http, &url).await,
        Err(_) => Verdict::NotPolaris,
    }
}

fn host_of(origin: &str) -> String {
    polaris_client::servers::origin_host(origin)
}

/// Whether an address is a Polaris that can be opened now, and if not, why.
async fn probe_words(app: &AppHandle, origin: &str) -> Option<String> {
    let verdict = verdict_for(app, origin).await;
    if let Some(listed) = already_listed(app, origin, &verdict).await {
        return Some(listed);
    }
    (!matches!(verdict, Verdict::Polaris { .. })).then(|| verdict.describe(&host_of(origin)))
}

/// The servers page's live check of a typed address.
async fn check_words(app: &AppHandle, origin: &str) -> (bool, Option<String>) {
    let verdict = verdict_for(app, origin).await;
    if let Some(listed) = already_listed(app, origin, &verdict).await {
        return (false, Some(listed));
    }
    let ok = matches!(verdict, Verdict::Polaris { .. });
    (ok, Some(verdict.describe(&host_of(origin))))
}

fn show(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Bring a Polaris window forward, at a page of the Polaris in use when one is given.
fn show_polaris(app: &AppHandle, path: Option<&str>) {
    let state = shared(app);
    let Some(origin) = state.active_origin() else {
        open_servers_window(app);
        return;
    };
    let target = path.and_then(|path| server_path(path, &origin));
    match app.get_webview_window(MAIN) {
        Some(window) => {
            if let Some(url) = target.and_then(|target| url::Url::parse(&target).ok()) {
                let _ = window.navigate(url);
            }
            show(&window);
        }
        None => {
            let url = target.unwrap_or_else(|| format!("{origin}{START}"));
            if let Err(error) = open_main(app, &url) {
                eprintln!("polaris: the Polaris window could not open: {error}");
            }
        }
    }
}

/// Put the windows on a server already kept as the one in use.
fn open_server(app: &AppHandle, origin: &str) {
    let state = shared(app);
    if state.current().as_deref() != Some(origin) {
        leave_server(app);
    }
    *lock(&state.alternate) = None;
    *lock(&state.current) = Some(origin.to_owned());
    *lock(&state.load_error) = None;
    state.pins.set_scope(None);
    let _ = failover_for(app, origin);
    show_polaris(app, None);
    if let Some(window) = app.get_webview_window(SERVERS) {
        let _ = window.close();
    }
    tray::refresh(app);
}

/// Every window on the instance in use goes: none may stay open on an origin the
/// navigation rules no longer allow.
fn leave_server(app: &AppHandle) {
    let state = shared(app);
    *lock(&state.current) = state.settings().server.clone();
    *lock(&state.alternate) = None;
    for (label, window) in app.webview_windows() {
        if is_polaris_label(&label) {
            let _ = window.destroy();
        }
    }
    if state.current().is_none() {
        open_servers_window(app);
    }
    tray::refresh(app);
}

fn open_servers_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SERVERS) {
        let _ = window.eval("window.dispatchEvent(new Event('polaris-refresh'))");
        show(&window);
        return;
    }
    let built = WebviewWindowBuilder::new(app, SERVERS, WebviewUrl::App("index.html".into()))
        .initialization_script(bridge::local_script(app))
        .title("Polaris Beta - Servers")
        .inner_size(560.0, 640.0)
        .min_inner_size(400.0, 420.0)
        // The app's own page goes nowhere else.
        .on_navigation(|url| matches!(url.host_str(), Some("localhost") | Some("tauri.localhost")))
        .build();
    match built {
        Ok(window) => attach_engine_hooks(app, &window, false),
        Err(error) => eprintln!("polaris: the servers window could not open: {error}"),
    }
}

/// Opens a URL in the system browser, only for web pages and mail links.
fn open_external(app: &AppHandle, url: &str) {
    if is_safe_external_url(url) {
        let _ = app.opener().open_url(url, None::<&str>);
    }
}

/// The rules every Polaris window keeps (`navigation.ts`): the main frame stays on
/// the Polaris, except during a provider round trip, and a window it opens is a
/// Polaris window or the system browser.
fn polaris_builder<'a>(
    app: &'a AppHandle,
    label: &'a str,
    url: url::Url,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let navigating = app.clone();
    let opening = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url));
    // `window.polarisDesktop`, on the Polaris in use and nowhere else.
    let builder = match bridge::script_for(app) {
        Some(script) => builder.initialization_script(script),
        None => builder,
    };
    builder
        .on_navigation(move |url| {
            let state = shared(&navigating);
            let Some(origin) = state.active_origin() else {
                return false;
            };
            let step = main_frame_step(url.as_str(), &origin, state.trip.load(Ordering::SeqCst));
            state.trip.store(step.trip, Ordering::SeqCst);
            if step.verdict == NavigationVerdict::External {
                open_external(&navigating, url.as_str());
            }
            step.verdict == NavigationVerdict::Allow
        })
        .on_new_window(move |url, _features| {
            let origin = shared(&opening).active_origin();
            match origin
                .as_deref()
                .map(|origin| polaris_client::navigation::classify_navigation(url.as_str(), origin))
            {
                Some(NavigationVerdict::Allow) => {
                    let _ = open_polaris_window(&opening, url.as_str(), "Polaris");
                }
                Some(NavigationVerdict::External) | None => open_external(&opening, url.as_str()),
                Some(NavigationVerdict::Block) => {}
            }
            NewWindowResponse::Deny
        })
}

/// A path of the Polaris in a window of its own; asking twice brings the first forward.
fn open_polaris_window(app: &AppHandle, url: &str, title: &str) -> tauri::Result<()> {
    if let Some(window) = app
        .webview_windows()
        .into_iter()
        .find_map(|(label, window)| {
            (label.starts_with("polaris-") && window.url().is_ok_and(|open| open.as_str() == url))
                .then_some(window)
        })
    {
        show(&window);
        return Ok(());
    }
    let parsed = url::Url::parse(url).map_err(|_| tauri::Error::InvalidWebviewUrl("not a URL"))?;
    let label = format!(
        "polaris-{}",
        shared(app).windows.fetch_add(1, Ordering::SeqCst)
    );
    let window = polaris_builder(app, &label, parsed)
        .title(title)
        .inner_size(1100.0, 720.0)
        .build()?;
    attach_engine_hooks(app, &window, true);
    Ok(())
}

/// The main window on `url`.
fn open_main(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let parsed = url::Url::parse(url).map_err(|_| tauri::Error::InvalidWebviewUrl("not a URL"))?;
    let loaded = app.clone();
    let titled = app.clone();
    let window = polaris_builder(app, MAIN, parsed)
        .title("Polaris Beta")
        .inner_size(1200.0, 800.0)
        .min_inner_size(480.0, 360.0)
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                page_loaded(&loaded, &window, payload.url().as_str());
            } else {
                // A page that loads another one mid-call is out of the call.
                voice_widget::page_left(&loaded, window.label());
            }
        })
        .on_document_title_changed(move |window, title| title_changed(&titled, &window, &title))
        .build()?;
    bridge::keep_reachable(&window);
    // Closing keeps the app in the tray, as the Electron app does on Windows and
    // Linux; Quit in the tray menu ends it.
    let handle = window.clone();
    let blurred = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = handle.hide();
        }
        WindowEvent::Focused(false) => {
            let state = shared(&blurred);
            if state.back_on_blur.swap(false, Ordering::SeqCst) && state.alternate().is_some() {
                move_to(&blurred, &handle, None, None);
            }
        }
        _ => {}
    });
    attach_engine_hooks(app, &window, true);
    Ok(())
}

/// A page of the Polaris was shown: the round trip is over, and the origin it is
/// on gets the Polaris commands.
fn page_loaded(app: &AppHandle, window: &WebviewWindow, url: &str) {
    let state = shared(app);
    let Some(origin) = state.active_origin() else {
        return;
    };
    if !is_server_url(url, &origin) {
        return;
    }
    state.trip.store(false, Ordering::SeqCst);
    ipc::allow_origin(app, &origin);
    let _ = window;
}

/// The Polaris's own worker answers for it when it is gone, so that load
/// succeeded: the same Polaris is looked for elsewhere first; failing that the
/// window stays for its Try again, and the servers page says why.
fn title_changed(app: &AppHandle, window: &WebviewWindow, title: &str) {
    let state = shared(app);
    let Some(current) = state.current() else {
        return;
    };
    let offline = OFFLINE_TITLES.contains(&title);
    let was_offline = state.offline.swap(offline, Ordering::SeqCst);
    if !offline {
        if was_offline {
            *lock(&state.load_error) = None;
        }
        // Online on the usual address: learn, or refresh, where else it answers.
        if state.alternate().is_none() {
            let _ = failover_for(app, &current);
        } else {
            let words = failover_for(app, &current).and_then(|failover| failover.status().words);
            let _ = window.set_title(&title_with(title, words));
        }
        return;
    }
    if state.failing_over.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let window = window.clone();
    let failed_url = window.url().map(|url| url.to_string()).unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let outcome = fail_over(&app, &window, &failed_url).await;
        let state = shared(&app);
        state.failing_over.store(false, Ordering::SeqCst);
        if outcome == Outcome2::Moved {
            return;
        }
        let mut error = NetFailure::Other.describe(&host_of(&current));
        if outcome == Outcome2::Untrusted {
            error = format!("{error} {UNTRUSTED_WORDS}");
        }
        *lock(&state.load_error) = Some(error);
        open_servers_window(&app);
    });
}

/// A failed main-frame load (Windows: WebView2's NavigationCompleted).
fn failed_load(app: &AppHandle, code: i32, name: &str, url: String) {
    let state = shared(app);
    let Some(origin) = state.active_origin() else {
        return;
    };
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let step = failed_load_step(code, name, &url, &origin);
    if step == FailedLoad::Ignore {
        return;
    }
    state.offline.store(false, Ordering::SeqCst);
    let error = chromium_failure(name).describe(&host_of(&origin));
    if step == FailedLoad::Error {
        give_up(app, &window, error);
        return;
    }
    if state.failing_over.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = fail_over(&app, &window, &url).await;
        shared(&app).failing_over.store(false, Ordering::SeqCst);
        match outcome {
            Outcome2::Moved => {}
            Outcome2::Untrusted => give_up(&app, &window, format!("{error} {UNTRUSTED_WORDS}")),
            Outcome2::None => give_up(&app, &window, error),
        }
    });
}

/// Chromium's code as the kind of failure the core names in words.
fn chromium_failure(code: &str) -> NetFailure {
    match code {
        "ERR_NAME_NOT_RESOLVED" | "ERR_NAME_RESOLUTION_FAILED" => NetFailure::NameNotResolved,
        "ERR_CONNECTION_REFUSED"
        | "ERR_CONNECTION_RESET"
        | "ERR_CONNECTION_CLOSED"
        | "ERR_CONNECTION_FAILED" => NetFailure::Refused,
        "ERR_TIMED_OUT"
        | "ERR_CONNECTION_TIMED_OUT"
        | "ERR_ADDRESS_UNREACHABLE"
        | "ERR_NETWORK_UNREACHABLE" => NetFailure::TimedOut,
        code if polaris_client::window_failover::is_certificate_error(Some(code)) => {
            NetFailure::Certificate
        }
        _ => NetFailure::Other,
    }
}

/// Say why in the servers page, in place of the Polaris window.
fn give_up(app: &AppHandle, window: &WebviewWindow, error: String) {
    let state = shared(app);
    *lock(&state.load_error) = Some(error);
    *lock(&state.alternate) = None;
    let _ = window.destroy();
    open_servers_window(app);
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome2 {
    Moved,
    None,
    Untrusted,
}

/// The address the window is on did not answer at `failed_url`: go to the same
/// Polaris elsewhere if one proves itself (`failOver` in `index.ts`).
async fn fail_over(app: &AppHandle, window: &WebviewWindow, failed_url: &str) -> Outcome2 {
    let state = shared(app);
    let Some(primary) = state.current() else {
        return Outcome2::Moved;
    };
    let failover = failover_for(app, &primary);
    let found = match &failover {
        Some(failover) => Some((
            failover.resolve().await,
            !failover.status().untrusted.is_empty(),
        )),
        None => None,
    };
    if state.current().as_deref() != Some(primary.as_str()) {
        return Outcome2::Moved;
    }
    if let Some((origin, _)) = found.as_ref().filter(|(origin, _)| *origin != primary) {
        move_to(app, window, Some(origin.clone()), Some(failed_url));
        return Outcome2::Moved;
    }
    if state.alternate().is_some() {
        // The alternate stopped answering: the usual address gets one more go.
        move_to(app, window, None, Some(failed_url));
        return Outcome2::Moved;
    }
    if found.is_some_and(|(_, untrusted)| untrusted) {
        Outcome2::Untrusted
    } else {
        Outcome2::None
    }
}

/// Put the main window on `to` - an alternate the failover proved, or `None` for
/// the usual address - at the place it is on now.
fn move_to(app: &AppHandle, window: &WebviewWindow, to: Option<String>, from: Option<&str>) {
    let state = shared(app);
    let Some(primary) = state.current() else {
        return;
    };
    let origin = to.clone().unwrap_or_else(|| primary.clone());
    let watch = to.is_some();
    *lock(&state.alternate) = to;
    state.back_on_blur.store(false, Ordering::SeqCst);
    let from = from
        .map(str::to_owned)
        .or_else(|| window.url().ok().map(|url| url.to_string()))
        .unwrap_or_default();
    let target = same_place_on(&from, &origin).unwrap_or_else(|| format!("{origin}{START}"));
    if let Ok(url) = url::Url::parse(&target) {
        let _ = window.navigate(url);
    }
    if watch {
        watch_for_primary(app, window);
    }
}

/// Ask the usual address again on the failover's own rhythm while the window is
/// on the alternate, and go back once it answers.
fn watch_for_primary(app: &AppHandle, window: &WebviewWindow) {
    let state = shared(app);
    if state.watching.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DEFAULT_HOLD).await;
            let state = shared(&app);
            let (Some(primary), Some(_)) = (state.current(), state.alternate()) else {
                break;
            };
            let Some(failover) = failover_for(&app, &primary) else {
                break;
            };
            let resolved = failover.resolve().await;
            if state.current().as_deref() != Some(primary.as_str()) || state.alternate().is_none() {
                break;
            }
            match back_step(&resolved, &primary, window.is_focused().unwrap_or(false)) {
                BackStep::Now => {
                    move_to(&app, &window, None, None);
                    break;
                }
                BackStep::OnBlur => state.back_on_blur.store(true, Ordering::SeqCst),
                BackStep::Stay => {}
            }
        }
        shared(&app).watching.store(false, Ordering::SeqCst);
    });
}

/// The engine's own events: permissions, failed loads and certificate errors.
/// Windows only (WebView2); macOS and Linux keep the engine's defaults.
fn attach_engine_hooks(app: &AppHandle, window: &WebviewWindow, polaris: bool) {
    #[cfg(windows)]
    {
        let asking = app.clone();
        let failing = app.clone();
        let pinning = app.clone();
        let hooks = webview2::Hooks {
            permission: Box::new(move |permission, url, media| {
                if polaris {
                    let origin = shared(&asking).active_origin();
                    polaris_client::permissions::allow_permission(
                        permission,
                        url,
                        origin.as_deref(),
                    )
                } else {
                    let media = (!media.is_empty()).then_some(media);
                    polaris_client::permissions::allow_local_permission(
                        permission,
                        Some("connect"),
                        media,
                    )
                }
            }),
            failed_load: Box::new(move |code, name, url| {
                if polaris {
                    failed_load(&failing, code, name, url);
                }
            }),
            certificate: Box::new(move |host, chain| {
                polaris
                    && polaris_client::local_ca_pin::accepts_chain(
                        shared(&pinning).pins.scope().as_ref(),
                        host,
                        chain,
                    )
            }),
        };
        if let Err(error) = webview2::attach(window, hooks) {
            eprintln!("polaris: the window's engine hooks could not be attached: {error}");
        }
    }
    #[cfg(not(windows))]
    let _ = (app, window, polaris);
}

/// What a `polaris://` link does to the windows (`DeepLinkSteps`).
struct Steps(AppHandle);

impl DeepLinkSteps for Steps {
    fn current(&self) -> Option<String> {
        shared(&self.0).current()
    }
    fn saved(&self) -> Vec<String> {
        shared(&self.0)
            .saved()
            .into_iter()
            .map(|server| server.origin)
            .collect()
    }
    fn show(&self, path: Option<&str>) {
        show_polaris(&self.0, path);
    }
    async fn confirm_switch(&self, server: &str) -> bool {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        self.0
            .dialog()
            .message(
                "A link asked to open a page there. Switching closes the Polaris windows open now.",
            )
            .title(format!("Switch to {}?", host_of(server)))
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Switch".into(),
                "Cancel".into(),
            ))
            .show(move |yes| {
                let _ = sender.send(yes);
            });
        receiver.await.unwrap_or(false)
    }
    async fn switch_to(&self, server: &str) -> bool {
        match ipc::switch_server(&self.0, server).await {
            Outcome::Ok { .. } => true,
            Outcome::Error { error, .. } => {
                *lock(&shared(&self.0).load_error) = Some(error);
                open_servers_window(&self.0);
                false
            }
        }
    }
    fn open_in_browser(&self, url: &str) {
        open_external(&self.0, url);
    }
}

/// A link reached the app: opened now, or held until the first window is up.
fn link_arrived(app: &AppHandle, raw: &str) {
    let Some(link) = read_deep_link(raw) else {
        return;
    };
    let Some(links) = shared(app).links.get().cloned() else {
        return;
    };
    if let Some(now) = links.arrive(link) {
        tauri::async_runtime::spawn(async move { links.open(now).await });
    }
}

/// The Electron app's settings and instance records, carried over once, read only.
fn import_from_electron(app: &AppHandle, folder: &std::path::Path) {
    let Ok(config) = app.path().config_dir() else {
        return;
    };
    let electron = electron_data_folder(&config);
    if let Err(error) = import_electron_settings(&electron, folder) {
        eprintln!("polaris: the Electron app's settings could not be carried over: {error}");
    }
    let records = import_once(&electron, folder, INSTANCES_FILE, |raw| {
        polaris_client::instance_store::instances_value(&read_instances_value(raw))
    });
    if let Err(error) = records {
        eprintln!("polaris: the Electron app's server records could not be carried over: {error}");
    }
}

fn main() {
    #[cfg(feature = "measure")]
    if let Some(page) = measure::page() {
        return measure::run(page, std::time::Instant::now());
    }
    let probe_http = probe_client().expect("the HTTP client builds with its defaults");
    let pins = PinVerifier::new().expect("the system certificate verifier loads");
    let http = pins
        .client(reqwest::Client::builder())
        .expect("the HTTP client builds with the pinned verifier");
    tauri::Builder::default()
        // First, so a second launch hands over its arguments (a polaris:// link
        // included, through the deep-link feature) before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show_polaris(app, mailto_in(&argv).as_deref())
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(login_item::plugin())
        .plugin(updater::plugin())
        // The main window's size and place; `bridge::keep_reachable` moves it
        // back on screen when the display it was on is gone.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .with_filter(|label| label == MAIN)
                .build(),
        )
        .manage(notices::Notices::default())
        .manage(call_keys::CallKeys::default())
        .manage(key_flow::Keys::default())
        .manage(tray::Zoom::default())
        .manage(Http(http.clone()))
        .manage(developer::Developer::default())
        .manage(voice_widget::VoiceWidget::default())
        .manage(share::Share::default())
        .invoke_handler(tauri::generate_handler![
            ipc::connect_state,
            ipc::connect_submit,
            ipc::connect_check,
            ipc::connect_switch,
            ipc::connect_rename,
            ipc::connect_edit,
            ipc::connect_remove,
            ipc::connect_close,
            ipc::open_servers,
            ipc::open_window,
            bridge::text_size_seen,
            notices::show_notice,
            notices::set_app_badge,
            call_keys::set_call_hotkeys,
            key_flow::api_key_form,
            key_flow::submit_api_key,
            key_flow::cancel_api_key,
            key_flow::open_api_keys,
            host_transfer::copy_hosts,
            host_transfer::import_hosts,
            host_transfer::save_hosts_file,
            host_transfer::import_hosts_file,
            host_transfer::hosts_qr,
            developer::push_choose_folder,
            developer::push_start,
            developer::push_cancel,
            developer::upload_folder,
            developer::install_tool,
            developer::running_game,
            developer::set_custom_games,
            developer::running_programs,
            tv::tv_state,
            tv::tv_find,
            tv::tv_find_usb,
            tv::tv_cancel,
            tv::tv_start,
            vpn::vpn_device_name,
            vpn::vpn_key,
            vpn::vpn_up,
            vpn::vpn_down,
            vpn::vpn_status,
            vpn::vpn_join,
            voice_widget::set_voice_state,
            voice_widget::voice_widget_act,
            share::share_sources,
            share::choose_share,
            share::draw_on_share,
            share::can_draw_on_share,
            share::stop_drawing
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let folder = app.path().app_config_dir()?;
            import_from_electron(&handle, &folder);
            app.manage(vpn::VpnService::new(&handle, &folder));
            let settings = Settings::load(&folder.join(SETTINGS_FILE));
            app.manage(Shared {
                folder,
                settings: Mutex::new(()),
                current: Mutex::new(settings.server.clone()),
                alternate: Mutex::new(None),
                load_error: Mutex::new(None),
                trip: AtomicBool::new(false),
                offline: AtomicBool::new(false),
                failing_over: AtomicBool::new(false),
                back_on_blur: AtomicBool::new(false),
                watching: AtomicBool::new(false),
                http,
                probe_http,
                pins,
                failovers: Mutex::new(HashMap::new()),
                learning: Mutex::new(HashSet::new()),
                same_instance: SameInstance::default(),
                capabilities: Mutex::new(HashSet::new()),
                windows: AtomicUsize::new(0),
                links: OnceLock::new(),
            });
            // Installers register the scheme; a development run has none, so it
            // registers itself (Windows and Linux only, as the plugin documents).
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;
            let started_for = app
                .deep_link()
                .get_current()
                .ok()
                .flatten()
                .and_then(|urls| urls.iter().find_map(|url| read_deep_link(url.as_str())));
            let links = DeepLinks::new(Steps(handle.clone()), started_for);
            let _ = shared(&handle).links.set(links.clone());
            let arrived = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    link_arrived(&arrived, url.as_str());
                }
            });
            if let Some(server) = settings.server.as_deref() {
                let _ = failover_for(&handle, server);
            }
            // The first window: what the app was started for, and always something on screen.
            let waiting = links.opened();
            if let Some(tv) = tv::Tv::new(&handle) {
                app.manage(tv);
            }
            show_polaris(
                &handle,
                mailto_in(&std::env::args().collect::<Vec<_>>()).as_deref(),
            );
            if let Some(link) = waiting {
                tauri::async_runtime::spawn(async move { links.open(link).await });
            }
            tray::install(&handle)?;
            // A start the computer made opens in the tray, as the Electron app does.
            if login_item::started_at_login(&std::env::args().collect::<Vec<_>>()) {
                if let Some(window) = handle.get_webview_window(MAIN) {
                    let _ = window.hide();
                }
            }
            login_item::restore(&handle);
            mail_handler::restore(&handle);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the Tauri beta failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polaris_windows_are_the_main_one_and_those_it_opens() {
        assert!(is_polaris_label(MAIN));
        assert!(is_polaris_label("polaris-3"));
        assert!(!is_polaris_label(SERVERS));
    }

    #[test]
    fn an_outcome_reads_as_the_bridge_expects() {
        assert_eq!(
            serde_json::to_string(&Outcome::ok()).unwrap(),
            r#"{"ok":true}"#
        );
        assert_eq!(
            serde_json::to_string(&Outcome::error(ipc::REFUSAL)).unwrap(),
            r#"{"ok":false,"error":"This window may not do that."}"#
        );
    }

    #[cfg(windows)]
    #[test]
    fn webview2_failures_read_as_chromium_codes() {
        use polaris_client::window_failover::triggers_failover;
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        let code = |status| webview2::chromium_error(status).1;
        assert!(triggers_failover(Some(code(
            COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED
        ))));
        assert!(triggers_failover(Some(code(
            COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED
        ))));
        assert!(!triggers_failover(Some(code(
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID
        ))));
        assert_eq!(
            webview2::chromium_error(COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED).0,
            -3
        );
    }
}
