//! Screen sharing and the strokes drawn on it (`desktop/src/main/screen-share.ts`
//! and `annotate-overlay.ts`).
//!
//! `share_sources` answers `null` on every system: no engine the beta runs on
//! lets the app answer `getDisplayMedia` with a source of its choosing
//! (`polaris_client::screen_share::dashboard_picker` says why per system), so
//! the page calls `getDisplayMedia` straight away and the engine's own picker
//! asks - what the Electron app does on macOS. `choose_share` still keeps the
//! pick by the same rules, for the engine that grows such a hook.
//!
//! The drawing overlay is a see-through, click-through window over the shared
//! display. Only a share this app picked says which display that is, so until
//! then `can_draw_on_share` and `draw_on_share` answer false, as the Electron
//! app does for a share made through the system picker.

use polaris_client::annotate::{read_stroke, shared_display, Delivery, Display, Overlay, IDLE_MS};
use polaris_client::screen_share::{
    read_choice, sound_supported, wants_thumbnails, Pick, ShareSources,
};
use serde_json::Value;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
};

/// The overlay window's label.
pub const OVERLAY: &str = "overlay";
/// One stroke for the overlay page, sent to it alone.
pub const OVERLAY_STROKE_EVENT: &str = "polaris://overlay-stroke";

#[derive(Default)]
struct Inner {
    // Read by the display-media hook no engine offers yet (see the module doc).
    #[allow(dead_code)]
    pick: Option<Pick>,
    /// What is being shared now: the source id and its display's name.
    shared: Option<(String, String)>,
    overlay: Option<Overlay>,
    /// Bumped on every stroke; the idle timer closes only its own generation.
    strokes: u64,
}

#[derive(Default)]
pub struct Share(Mutex<Inner>);

fn inner(app: &AppHandle) -> MutexGuard<'_, Inner> {
    app.state::<Share>()
        .inner()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0))
}

/// The screens and windows for the page's picker, or `null` where the engine's
/// own picker is the one to use - every system the beta runs on, for now.
#[tauri::command]
pub fn share_sources(
    app: AppHandle,
    window: WebviewWindow,
    input: Option<Value>,
) -> Option<ShareSources> {
    if !crate::ipc::from_polaris(&app, &window) {
        return None;
    }
    let _ = wants_thumbnails(input.as_ref());
    None
}

/// Remember what the page's picker chose, for the request that follows it.
#[tauri::command]
pub fn choose_share(app: AppHandle, window: WebviewWindow, input: Value) -> bool {
    if !crate::ipc::from_polaris(&app, &window) {
        return false;
    }
    let Some(choice) = read_choice(&input) else {
        return false;
    };
    inner(&app).pick = Some(Pick::new(
        choice,
        sound_supported(std::env::consts::OS),
        now_ms(),
    ));
    true
}

struct Screen(tauri::Monitor);

impl Display for Screen {
    fn id(&self) -> String {
        self.0.name().cloned().unwrap_or_default()
    }
}

/// The display the current share is of, or `None`.
fn shared_screen(app: &AppHandle) -> Option<Screen> {
    let shared = inner(app).shared.clone();
    let screens: Vec<Screen> = app
        .available_monitors()
        .ok()?
        .into_iter()
        .map(Screen)
        .collect();
    let found = shared_display(
        shared
            .as_ref()
            .map(|(id, display)| (id.as_str(), display.as_str())),
        &screens,
    )?;
    let name = found.id();
    screens.into_iter().find(|screen| screen.id() == name)
}

/// Whether what is being shared now is a display the strokes can be shown on.
#[tauri::command]
pub fn can_draw_on_share(app: AppHandle, window: WebviewWindow) -> bool {
    crate::ipc::from_polaris(&app, &window) && shared_screen(&app).is_some()
}

/// Show one stroke on the shared display. False when there is none to show it on.
#[tauri::command]
pub fn draw_on_share(app: AppHandle, window: WebviewWindow, input: Value) -> bool {
    if !crate::ipc::from_polaris(&app, &window) {
        return false;
    }
    let Some(stroke) = read_stroke(&input) else {
        return false;
    };
    let Some(screen) = shared_screen(&app) else {
        return false;
    };
    let display = screen.id();
    let moved = inner(&app)
        .overlay
        .as_ref()
        .is_some_and(|overlay| overlay.moves_to(&display))
        || app.get_webview_window(OVERLAY).is_none();
    if moved {
        close_overlay(&app);
        if open_overlay(&app, &screen.0).is_err() {
            eprintln!("polaris: the drawing overlay could not be opened");
            return false;
        }
        inner(&app).overlay = Some(Overlay::open_on(display));
    }
    let (delivery, generation) = {
        let mut held = inner(&app);
        held.strokes += 1;
        let generation = held.strokes;
        (
            held.overlay.as_mut().map(|overlay| overlay.deliver(stroke)),
            generation,
        )
    };
    if let Some(Delivery::Send(stroke)) = delivery {
        let _ = app.emit_to(OVERLAY, OVERLAY_STROKE_EVENT, stroke);
    }
    // Closed on its own once nothing has been drawn for a while.
    let idle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(IDLE_MS)).await;
        if inner(&idle).strokes == generation {
            close_overlay(&idle);
        }
    });
    true
}

/// Take the drawing off the display: the share ended.
#[tauri::command]
pub fn stop_drawing(app: AppHandle, window: WebviewWindow) {
    if !crate::ipc::from_polaris(&app, &window) {
        return;
    }
    close_overlay(&app);
    inner(&app).shared = None;
}

fn close_overlay(app: &AppHandle) {
    inner(app).overlay = None;
    if let Some(window) = app.get_webview_window(OVERLAY) {
        let _ = window.destroy();
    }
}

/// A see-through window over the whole display, taking no clicks and no focus,
/// kept out of screen captures so the share does not carry the strokes a
/// second time behind the ones the room already draws.
fn open_overlay(app: &AppHandle, monitor: &tauri::Monitor) -> tauri::Result<()> {
    let loaded = app.clone();
    let window = crate::hardware::window(app, OVERLAY, WebviewUrl::App("overlay.html".into()))
        .title("Drawing - Polaris")
        .visible(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .content_protected(true)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let queued = inner(&loaded)
                .overlay
                .as_mut()
                .map(Overlay::loaded)
                .unwrap_or_default();
            let _ = window.show();
            for stroke in queued {
                let _ = loaded.emit_to(OVERLAY, OVERLAY_STROKE_EVENT, stroke);
            }
        })
        .build()?;
    let position = monitor.position();
    let size = monitor.size();
    let _ = window.set_position(PhysicalPosition::new(position.x, position.y));
    let _ = window.set_size(PhysicalSize::new(size.width, size.height));
    let _ = window.set_ignore_cursor_events(true);
    Ok(())
}
