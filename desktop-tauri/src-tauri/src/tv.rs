//! Installing Polaris TV on a set (`desktop/src/main/tv-install.ts`, its IPC
//! half): the commands the dashboard's TV install dialog calls through
//! `polarisDesktop.tv` - state, find, findUsb, cancel and start - and the
//! `tv-event` every page that asked for the state hears on each change.
//!
//! The install itself is `polaris_client::tv_install`. Only a Polaris window on
//! its own saved Polaris may drive it, as `fromPolaris` allows in the Electron
//! app; anything else is answered with nothing, as the Electron handlers answer
//! `null`/`false`. The app's own TV window (`ui/tv.html`, opened by
//! `pages::open_tv_install`) may drive it too.

use crate::{saved_server, MAIN};
use polaris_client::tv_install::{release_client, TvHost, TvInstallState, TvInstaller};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, EventTarget, Manager, State, Webview};

/// The event a page hears on every change, as `CHANNELS.tvEvent`.
const TV_EVENT: &str = "tv-event";

type Pages = Arc<Mutex<HashSet<String>>>;

fn pages_of(pages: &Pages) -> std::sync::MutexGuard<'_, HashSet<String>> {
    pages
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

struct Host {
    app: AppHandle,
    pages: Pages,
}

impl TvHost for Host {
    fn publish(&self, state: &TvInstallState) {
        let labels: Vec<String> = pages_of(&self.pages).iter().cloned().collect();
        for label in labels {
            if self.app.get_webview_window(&label).is_none() {
                pages_of(&self.pages).remove(&label);
                continue;
            }
            let _ = self
                .app
                .emit_to(EventTarget::webview(label.as_str()), TV_EVENT, state);
        }
    }

    fn data_dir(&self) -> Option<PathBuf> {
        self.app.path().app_data_dir().ok()
    }

    fn server(&self) -> Option<String> {
        saved_server(&self.app).map(|server| server.to_string())
    }
}

/// The installer and the pages that hear it.
pub struct Tv {
    installer: Arc<TvInstaller>,
    pages: Pages,
}

impl Tv {
    pub fn new(app: &AppHandle) -> Option<Self> {
        let pages = Pages::default();
        let http = release_client().ok()?;
        let host = Host {
            app: app.clone(),
            pages: pages.clone(),
        };
        Some(Self {
            installer: TvInstaller::new(host, http),
            pages,
        })
    }
}

/// Whether the caller is the main window showing the saved Polaris, on its own origin.
fn from_polaris(app: &AppHandle, webview: &Webview) -> bool {
    // The app's own Install on a TV window (`kindOf(sender) === "tv"`).
    if app
        .get_webview_window(webview.label())
        .is_some_and(|window| crate::ipc::from_local(&window, crate::pages::TV_WINDOW))
    {
        return true;
    }
    if webview.window().label() != MAIN {
        return false;
    }
    let (Some(server), Ok(url)) = (saved_server(app), webview.url()) else {
        return false;
    };
    url.origin() == server.to_url().origin()
}

#[tauri::command]
pub fn tv_state(app: AppHandle, webview: Webview, tv: State<'_, Tv>) -> Option<TvInstallState> {
    if !from_polaris(&app, &webview) {
        return None;
    }
    pages_of(&tv.pages).insert(webview.label().to_owned());
    Some(tv.installer.state())
}

#[tauri::command]
pub fn tv_cancel(app: AppHandle, webview: Webview, tv: State<'_, Tv>) -> Option<TvInstallState> {
    from_polaris(&app, &webview).then(|| tv.installer.cancel())
}

#[tauri::command]
pub async fn tv_find(
    app: AppHandle,
    webview: Webview,
    tv: State<'_, Tv>,
) -> Result<Option<TvInstallState>, ()> {
    if !from_polaris(&app, &webview) {
        return Ok(None);
    }
    Ok(Some(tv.installer.find().await))
}

#[tauri::command]
pub async fn tv_find_usb(
    app: AppHandle,
    webview: Webview,
    tv: State<'_, Tv>,
) -> Result<Option<TvInstallState>, ()> {
    if !from_polaris(&app, &webview) {
        return Ok(None);
    }
    Ok(Some(tv.installer.find_usb().await))
}

/// `input` is checked by `read_start`: one of the two shapes, no other keys, a
/// private address or a listed USB id, and a six-digit pairing code when there is one.
#[tauri::command]
pub async fn tv_start(
    app: AppHandle,
    webview: Webview,
    tv: State<'_, Tv>,
    input: serde_json::Value,
) -> Result<bool, ()> {
    Ok(from_polaris(&app, &webview) && tv.installer.start(&input))
}
