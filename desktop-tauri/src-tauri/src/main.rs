//! Polaris desktop, Tauri beta: one window on the saved Polaris, a first-run page
//! that asks for it, a tray icon, one instance, and the `polaris://` scheme.
//!
//! Not released and not offered to anybody: the Electron app in `desktop/` is
//! the shipped one until `docs/desktop-tauri-parity.md` says otherwise.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod call_keys;
mod developer;
mod host_transfer;
mod key_flow;
mod login_item;
mod mail_handler;
mod notices;
mod os_prefs;
mod tray;

use polaris_client::{probe, probe_client, InstanceUrl, Verdict};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

const MAIN: &str = "main";
const SETTINGS_FILE: &str = "settings.json";

/// What the beta remembers between runs. Nothing secret.
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    server: Option<String>,
    /// Start with the computer (`login_item`); off until switched on.
    #[serde(default)]
    open_at_login: bool,
    /// Offered for `mailto:` links on Windows (`mail_handler`); off until switched on.
    #[serde(default)]
    mail_handler: bool,
}

/// The client every probe goes through, built once.
struct Http(reqwest::Client);

fn settings_path(app: &AppHandle) -> tauri::Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join(SETTINGS_FILE))
}

/// The saved Polaris, checked again on the way in: the file is on disk and
/// anything may have written it.
fn saved_server(app: &AppHandle) -> Option<InstanceUrl> {
    let text = std::fs::read_to_string(settings_path(app).ok()?).ok()?;
    let settings: Settings = serde_json::from_str(&text).ok()?;
    InstanceUrl::parse(settings.server.as_deref()?).ok()
}

fn save_server(app: &AppHandle, server: &InstanceUrl) -> Result<(), String> {
    let path = settings_path(app)
        .map_err(|_| "This computer gave the app no folder to keep its settings in.".to_owned())?;
    let failed = |_| "The address could not be saved on this computer.".to_owned();
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(failed)?;
    }
    let text = serde_json::to_string_pretty(&Settings {
        server: Some(server.to_string()),
        ..os_prefs::read_settings(app)
    })
    .map_err(|_| "The address could not be saved.".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, text).map_err(failed)?;
    std::fs::rename(&temporary, &path).map_err(failed)
}

/// The first-run page asking for an address: checked here, saved only when a
/// Polaris answers at it, and then opened in the same window.
#[tauri::command]
async fn connect(app: AppHandle, http: State<'_, Http>, address: String) -> Result<(), String> {
    let server = InstanceUrl::parse(&address).map_err(|error| error.to_string())?;
    let verdict = probe(&http.0, &server).await;
    if !matches!(verdict, Verdict::Polaris { .. }) {
        return Err(verdict.describe(server.host()));
    }
    save_server(&app, &server)?;
    let window = app
        .get_webview_window(MAIN)
        .ok_or("The window was closed.")?;
    window
        .navigate(server.to_url())
        .map_err(|_| "The window could not open that address.".to_owned())
}

fn show(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        show(&window);
    }
}

fn open_main_window(app: &AppHandle) -> tauri::Result<()> {
    let url = match saved_server(app) {
        Some(server) => WebviewUrl::External(server.to_url()),
        None => WebviewUrl::App("index.html".into()),
    };
    let window = WebviewWindowBuilder::new(app, MAIN, url)
        .title("Polaris Beta")
        .inner_size(1200.0, 800.0)
        .min_inner_size(480.0, 360.0)
        .build()?;
    // Closing keeps the app in the tray, as the Electron app does on Windows and
    // Linux; Quit in the tray menu ends it.
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handle.hide();
        }
    });
    Ok(())
}

fn main() {
    let http = probe_client().expect("the HTTP client builds with its defaults");
    tauri::Builder::default()
        // First, so a second launch hands over its arguments (a polaris:// link
        // included, through the deep-link feature) before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(login_item::plugin())
        .manage(notices::Notices::default())
        .manage(call_keys::CallKeys::default())
        .manage(key_flow::Keys::default())
        .manage(tray::Zoom::default())
        .manage(Http(http))
        .manage(developer::Developer::default())
        .invoke_handler(tauri::generate_handler![
            connect,
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
            developer::running_programs
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Installers register the scheme; a development run has none, so it
            // registers itself (Windows and Linux only, as the plugin documents).
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;
            let opened = handle.clone();
            // Which page a link names is not acted on yet (see the parity ledger):
            // a link brings the window forward.
            app.deep_link()
                .on_open_url(move |_event| show_main(&opened));
            open_main_window(&handle)?;
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
