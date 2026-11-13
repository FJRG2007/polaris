//! Every request a page can make of the app, checked at the door (`ipc.ts`).
//!
//! A command answers only the kind of window it was made for, and the Polaris
//! commands answer only a window that is on the configured Polaris at the moment
//! of the call. Every argument is read with a strict schema (`deny_unknown_fields`
//! plus the same length limits as the zod schemas) before it is used. The
//! capabilities say the same thing a second time: `capabilities/local.json` for
//! the servers page, and a remote capability added at run time for the
//! configured origin only.

use crate::{shared, Outcome, Shared, SERVERS};
use polaris_client::navigation::{is_server_url, server_path};
use polaris_client::servers::{
    describe_server, normalize_server_name, read_server_address, rename_server, replace_server,
    utf16_len, without_server, ServerRow, SERVER_NAME_MAX,
};
use polaris_client::InstanceUrl;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewWindow};

/// What a refused command says (`REFUSAL` in `ipc.ts`).
pub const REFUSAL: &str = "This window may not do that.";

fn refused() -> Outcome {
    Outcome::error(REFUSAL)
}

/// The window kind, from its label: one of the app's own pages, in the window
/// made for it (`from(event, kind)`).
pub fn from_local(window: &WebviewWindow, label: &str) -> bool {
    window.label() == label
        && window.url().is_ok_and(|url| {
            matches!(url.scheme(), "tauri" | "http" | "https") && is_app_page(&url)
        })
}

/// The servers page (`from(event, "connect")`).
pub fn is_servers(window: &WebviewWindow) -> bool {
    from_local(window, SERVERS)
}

/// The app's own pages are served from `tauri://localhost` (macOS, Linux) or
/// `http(s)://tauri.localhost` (Windows).
fn is_app_page(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("localhost") if url.scheme() == "tauri")
        || url.host_str() == Some("tauri.localhost")
}

/// A Polaris window on the configured Polaris (`fromPolaris`).
pub fn from_polaris(app: &AppHandle, window: &WebviewWindow) -> bool {
    let Some(origin) = shared(app).active_origin() else {
        return false;
    };
    crate::is_polaris_label(window.label())
        && window
            .url()
            .is_ok_and(|url| is_server_url(url.as_str(), &origin))
}

/// A server named by the list: an address in the one stored form (`listedSchema`).
fn listed(raw: &str) -> Option<String> {
    read_server_address(&Value::String(raw.to_owned()))
}

#[derive(Serialize)]
pub struct ConnectState {
    address: Option<String>,
    error: Option<String>,
    servers: Vec<ServerRow>,
}

#[tauri::command]
pub fn connect_state(app: AppHandle, window: WebviewWindow) -> Option<ConnectState> {
    if !is_servers(&window) {
        return None;
    }
    let state = shared(&app);
    Some(ConnectState {
        address: state.current(),
        error: state.load_error(),
        servers: state.rows(),
    })
}

/// An address to open, and the name to list it under. A bare string is what a
/// page from before names were asked for sends.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Submit {
    Address(String),
    Named(NamedAddress),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NamedAddress {
    address: String,
    #[serde(default)]
    name: String,
}

#[tauri::command]
pub async fn connect_submit(
    app: AppHandle,
    window: WebviewWindow,
    input: Submit,
) -> Result<Outcome, ()> {
    if !is_servers(&window) {
        return Ok(refused());
    }
    Ok(match input {
        Submit::Address(address) => connect_submit_as(&app, &address, "").await,
        Submit::Named(named) if utf16_len(&named.name) <= 200 => {
            connect_submit_as(&app, &named.address, &named.name).await
        }
        Submit::Named(_) => refused(),
    })
}

/// Probe, keep and open an address (`connectSubmit` in `index.ts`).
pub async fn connect_submit_as(app: &AppHandle, typed: &str, typed_name: &str) -> Outcome {
    let origin = match InstanceUrl::parse(typed) {
        Ok(origin) => origin.to_string(),
        Err(error) => return Outcome::error(error.to_string()),
    };
    let name = normalize_server_name(typed_name);
    if name
        .as_deref()
        .is_some_and(|name| utf16_len(name) > SERVER_NAME_MAX)
    {
        return Outcome::error(format!("Use at most {SERVER_NAME_MAX} characters."));
    }
    if let Some(problem) = crate::probe_words(app, &origin).await {
        return Outcome::error(problem);
    }
    let state = shared(app);
    let saved = state.update_settings(|settings| {
        settings.set_server_address(Some(origin.clone()));
        if name.is_some() {
            let list = rename_server(&settings.known_servers(), &origin, name.clone());
            settings.set_saved_servers(list);
        }
    });
    if let Err(error) = saved {
        return Outcome::error(error);
    }
    crate::open_server(app, &origin);
    Outcome::ok()
}

/// The servers page asking about the address in its field while it is typed.
#[derive(Serialize)]
pub struct AddressCheck {
    ok: bool,
    message: Option<String>,
}

#[tauri::command]
pub async fn connect_check(app: AppHandle, window: WebviewWindow, address: String) -> AddressCheck {
    if !is_servers(&window) {
        return AddressCheck {
            ok: false,
            message: None,
        };
    }
    let origin = match InstanceUrl::parse(&address) {
        Ok(origin) => origin.to_string(),
        Err(error) => {
            return AddressCheck {
                ok: false,
                message: Some(error.to_string()),
            }
        }
    };
    let (ok, message) = crate::check_words(&app, &origin).await;
    AddressCheck { ok, message }
}

#[tauri::command]
pub async fn connect_switch(app: AppHandle, window: WebviewWindow, origin: String) -> Outcome {
    match listed(&origin) {
        Some(origin) if is_servers(&window) => switch_server(&app, &origin).await,
        _ => refused(),
    }
}

/// Open a server from the list: the same door as typing its address.
pub async fn switch_server(app: &AppHandle, origin: &str) -> Outcome {
    if !shared(app)
        .saved()
        .iter()
        .any(|server| server.origin == origin)
    {
        return Outcome::error("That host is not on the list any more.");
    }
    connect_submit_as(app, origin, "").await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rename {
    origin: String,
    name: String,
}

#[tauri::command]
pub fn connect_rename(app: AppHandle, window: WebviewWindow, input: Rename) -> Outcome {
    match listed(&input.origin) {
        Some(origin) if is_servers(&window) && utf16_len(&input.name) <= 200 => {
            name_server(&app, &origin, &input.name)
        }
        _ => refused(),
    }
}

fn name_server(app: &AppHandle, origin: &str, typed: &str) -> Outcome {
    let name = normalize_server_name(typed);
    if name
        .as_deref()
        .is_some_and(|name| utf16_len(name) > SERVER_NAME_MAX)
    {
        return Outcome::error(format!("Use at most {SERVER_NAME_MAX} characters."));
    }
    let saved = shared(app).update_settings(|settings| {
        let list = rename_server(&settings.known_servers(), origin, name);
        settings.set_saved_servers(list);
    });
    if let Err(error) = saved {
        return Outcome::error(error);
    }
    crate::tray::refresh(app);
    Outcome::ok()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Edit {
    origin: String,
    address: String,
    name: String,
}

#[tauri::command]
pub async fn connect_edit(app: AppHandle, window: WebviewWindow, input: Edit) -> Outcome {
    let fits = utf16_len(&input.address) <= 2048 && utf16_len(&input.name) <= 200;
    match listed(&input.origin) {
        Some(origin) if is_servers(&window) && fits => {
            edit_server(&app, &origin, &input.address, &input.name).await
        }
        _ => refused(),
    }
}

/// A row edited: its name, and its address if that changed (`editServer`).
async fn edit_server(app: &AppHandle, origin: &str, typed: &str, typed_name: &str) -> Outcome {
    let state = shared(app);
    if !state.saved().iter().any(|server| server.origin == origin) {
        return Outcome::error("That host is not on the list any more.");
    }
    let next = match InstanceUrl::parse(typed) {
        Ok(next) => next.to_string(),
        Err(error) => return Outcome::error(error.to_string()),
    };
    if next == origin {
        return name_server(app, origin, typed_name);
    }
    let name = normalize_server_name(typed_name);
    if name
        .as_deref()
        .is_some_and(|name| utf16_len(name) > SERVER_NAME_MAX)
    {
        return Outcome::error(format!("Use at most {SERVER_NAME_MAX} characters."));
    }
    if let Some(taken) = state.rows().into_iter().find(|row| row.origin == next) {
        return Outcome::error(format!(
            "Already on your list as {}.",
            describe_server(&taken)
        ));
    }
    if let Some(problem) = crate::probe_words(app, &next).await {
        return Outcome::error(problem);
    }
    let in_use = state.current().as_deref() == Some(origin);
    let saved = state.update_settings(|settings| {
        // The address in use first, so the list kept next never puts the old one back.
        if in_use {
            settings.set_server_address(Some(next.clone()));
        }
        let list = replace_server(&settings.known_servers(), origin, &next, name);
        settings.set_saved_servers(list);
    });
    if let Err(error) = saved {
        return Outcome::error(error);
    }
    if in_use {
        crate::open_server(app, &next);
    }
    Outcome::ok()
}

#[tauri::command]
pub fn connect_remove(app: AppHandle, window: WebviewWindow, origin: String) -> Outcome {
    let Some(origin) = listed(&origin).filter(|_| is_servers(&window)) else {
        return refused();
    };
    let state = shared(&app);
    let in_use = state.current().as_deref() == Some(origin.as_str());
    let saved = state.update_settings(|settings| {
        if in_use {
            settings.set_server_address(None);
        }
        let list = without_server(&settings.known_servers(), &origin);
        settings.set_saved_servers(list);
    });
    if let Err(error) = saved {
        return Outcome::error(error);
    }
    if in_use {
        // Every window on the server goes; its sign-in is not touched.
        crate::leave_server(&app);
    }
    Outcome::ok()
}

#[tauri::command]
pub fn connect_close(app: AppHandle, window: WebviewWindow) {
    if is_servers(&window) && shared(&app).current().is_some() {
        let _ = window.close();
        crate::show_polaris(&app, None);
    }
}

#[tauri::command]
pub fn open_servers(app: AppHandle, window: WebviewWindow) {
    if from_polaris(&app, &window) {
        crate::open_servers_window(&app);
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenWindow {
    path: String,
    title: String,
}

/// Open a path of the Polaris in a window of its own - a service's logs.
#[tauri::command]
pub fn open_window(app: AppHandle, window: WebviewWindow, input: OpenWindow) -> Outcome {
    if !from_polaris(&app, &window) {
        return refused();
    }
    let title = input.title.trim();
    let valid = !input.path.is_empty()
        && utf16_len(&input.path) <= 2048
        && !title.is_empty()
        && utf16_len(title) <= 200;
    let url = shared(&app)
        .active_origin()
        .filter(|_| valid)
        .and_then(|origin| server_path(&input.path, &origin));
    let Some(url) = url else {
        return Outcome::error("That is not a page of this Polaris.");
    };
    crate::open_polaris_window(&app, &url, title).map_or_else(
        |_| Outcome::error("That window could not be opened."),
        |()| Outcome::ok(),
    )
}

/// The commands a Polaris window may call, each checked again with `from_polaris`.
pub const POLARIS_COMMANDS: [&str; 31] = [
    "open-servers",
    "open-window",
    "show-notice",
    "set-app-badge",
    "set-call-hotkeys",
    "push-choose-folder",
    "push-start",
    "push-cancel",
    "upload-folder",
    "install-tool",
    "running-game",
    "set-custom-games",
    "running-programs",
    "tv-state",
    "tv-find",
    "tv-find-usb",
    "tv-cancel",
    "tv-start",
    "vpn-device-name",
    "vpn-key",
    "vpn-up",
    "vpn-down",
    "vpn-status",
    "vpn-join",
    "set-voice-state",
    "share-sources",
    "choose-share",
    "draw-on-share",
    "can-draw-on-share",
    "stop-drawing",
    "text-size-seen",
];

/// What `bridge.js` needs beyond the commands: hearing the events the app
/// sends this window (a TV install's progress, a call key), never emitting one.
pub const POLARIS_CORE: [&str; 2] = ["core:event:allow-listen", "core:event:allow-unlisten"];

/// Grants the Polaris commands to the configured origin. Tauri cannot take a
/// capability back, so one is added per origin the app has been on, and every
/// command checks the origin again at the moment of the call (`from_polaris`).
pub fn allow_origin(app: &AppHandle, origin: &str) {
    let state = shared(app);
    if !state.mark_capability(origin) {
        return;
    }
    let capability = POLARIS_COMMANDS
        .iter()
        .map(|command| format!("allow-{command}"))
        .chain(POLARIS_CORE.iter().map(|core| (*core).to_owned()))
        .fold(
            tauri::ipc::CapabilityBuilder::new(format!("remote-{}", state.capability_count()))
                .remote(format!("{origin}/*"))
                .windows([crate::MAIN, "polaris-*"]),
            |capability, permission| capability.permission(permission),
        );
    if let Err(error) = app.add_capability(capability) {
        eprintln!("polaris: the Polaris window's commands could not be granted: {error}");
    }
}

impl Shared {
    fn rows(&self) -> Vec<ServerRow> {
        polaris_client::servers::list_servers(&self.saved(), self.current().as_deref())
    }
}
