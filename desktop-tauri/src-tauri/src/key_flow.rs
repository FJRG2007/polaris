//! Getting the API key a push needs (`desktop/src/main/key-flow.ts`): the one
//! kept for this Polaris, or one pasted into the key window, checked with
//! `GET /api/v1/me` and then kept in the system's credential store.
//!
//! Asked for once: every push waiting on the same Polaris shares the one form.
//! Where the system cannot keep the key it is held in memory for this run.

use crate::{saved_server, Http};
use polaris_client::keys::{check_key, KeyRing, SystemStore};
use polaris_client::{ApiKey, InstanceUrl};
use serde::Serialize;
use std::sync::Mutex;
use tauri::async_runtime::{channel, Sender};
use tauri::{
    AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

pub const KEY_WINDOW: &str = "api-key";

/// The open key form, and every push waiting on it.
struct Asking {
    server: InstanceUrl,
    waiting: Vec<Sender<Option<ApiKey>>>,
}

pub struct Keys {
    ring: KeyRing<SystemStore>,
    asking: Mutex<Option<Asking>>,
}

impl Default for Keys {
    fn default() -> Self {
        Self {
            ring: KeyRing::new(SystemStore),
            asking: Mutex::new(None),
        }
    }
}

impl Keys {
    fn asking(&self) -> std::sync::MutexGuard<'_, Option<Asking>> {
        self.asking
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Hand `key` (or nothing) to every push waiting, and close the form.
    fn settle(&self, key: Option<ApiKey>) {
        for waiting in self.asking().take().map(|a| a.waiting).unwrap_or_default() {
            let _ = waiting.try_send(key.clone());
        }
    }
}

/// The key for this Polaris, asking for it when there is none. `None` when the
/// person closed the form.
pub async fn api_key_for(app: &AppHandle, server: &InstanceUrl) -> Option<ApiKey> {
    let keys = app.state::<Keys>();
    if let Some(key) = keys.ring.key_for(server) {
        return Some(key);
    }
    let (give, mut take) = channel(1);
    let open_new = {
        let mut asking = keys.asking();
        match asking.as_mut() {
            Some(current) if current.server == *server => {
                current.waiting.push(give);
                false
            }
            _ => {
                let replaced = asking.replace(Asking {
                    server: server.clone(),
                    waiting: vec![give],
                });
                for waiting in replaced.map(|a| a.waiting).unwrap_or_default() {
                    let _ = waiting.try_send(None);
                }
                true
            }
        }
    };
    if let Some(window) = app.get_webview_window(KEY_WINDOW) {
        if open_new {
            let _ = window.reload();
        }
        let _ = window.set_focus();
    } else if open_key_window(app).is_err() {
        keys.settle(None);
    }
    take.recv().await.flatten()
}

fn open_key_window(app: &AppHandle) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, KEY_WINDOW, WebviewUrl::App("api-key.html".into()))
        .initialization_script(crate::bridge::local_script(app))
        .title("API key - Polaris")
        .inner_size(520.0, 470.0)
        .resizable(false)
        .build()?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            handle.state::<Keys>().settle(None);
        }
    });
    Ok(())
}

/// Forget the key for the saved Polaris, after it refused it or somebody asked.
pub fn forget(app: &AppHandle) {
    if let Some(server) = saved_server(app) {
        app.state::<Keys>().ring.forget(&server);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyFormState {
    server: String,
    can_keep: bool,
}

#[tauri::command]
pub fn api_key_form(window: WebviewWindow, keys: State<'_, Keys>) -> Result<KeyFormState, String> {
    if !crate::ipc::from_local(&window, KEY_WINDOW) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    Ok(KeyFormState {
        server: keys
            .asking()
            .as_ref()
            .map(|a| a.server.to_string())
            .unwrap_or_default(),
        can_keep: keys.ring.can_keep(),
    })
}

/// A key pasted into the form: checked, kept, and handed to the pushes waiting.
#[tauri::command]
pub async fn submit_api_key(
    app: AppHandle,
    window: WebviewWindow,
    keys: State<'_, Keys>,
    http: State<'_, Http>,
    key: String,
) -> Result<(), String> {
    if !crate::ipc::from_local(&window, KEY_WINDOW) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    let server = keys
        .asking()
        .as_ref()
        .map(|a| a.server.clone())
        .ok_or("Nothing is waiting for a key. Close this window.")?;
    let key = check_key(&http.0, &server, &key).await?;
    if keys.asking().as_ref().map(|a| &a.server) != Some(&server) {
        return Err("This form was replaced. Close this window.".into());
    }
    keys.ring.remember(&server, &key);
    keys.settle(Some(key));
    if let Some(window) = app.get_webview_window(KEY_WINDOW) {
        let _ = window.close();
    }
    Ok(())
}

/// "Create one in Account > API keys": that page of the saved Polaris.
#[tauri::command]
pub fn open_api_keys(app: AppHandle, window: WebviewWindow) {
    if !crate::ipc::from_local(&window, KEY_WINDOW) {
        return;
    }
    crate::show_polaris(&app, Some("/account/api-keys"));
}

#[tauri::command]
pub fn cancel_api_key(app: AppHandle, window: WebviewWindow) {
    if !crate::ipc::from_local(&window, KEY_WINDOW) {
        return;
    }
    if let Some(window) = app.get_webview_window(KEY_WINDOW) {
        let _ = window.close();
    }
}
