//! The voice widget (`desktop/src/main/voice-widget.ts`): the people in the
//! call, over every window while a call is on - a window kept on top covers
//! games running windowed or borderless; one in exclusive full screen owns the
//! display and draws over it, as with the Electron app.
//!
//! Locked, clicks go through it. The lock key (Shift and the key under Esc
//! while a game runs, Ctrl/Cmd+Shift and that key always) unlocks it: it then
//! takes clicks, shows mute, deafen and leave, and can be dragged; where it is
//! left is kept. The Polaris page in the call says what to draw
//! (`set_voice_state`), and a press on the widget goes back to that page as
//! `polaris://voice-action`.

use crate::os_prefs::{read_settings, update_settings};
use polaris_client::settings::Point;
use polaris_client::voice_widget::{
    lock_keys, read_voice_action, read_voice_state, start_point, widget_size, widget_visible,
    VoiceState, WidgetView, WorkArea,
};
use serde_json::Value;
use std::sync::{Mutex, MutexGuard};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// The widget window's label, and the only window `voice_widget_act` answers.
pub const VOICE_WIDGET: &str = "voice-widget";
/// What the widget page draws, sent to it alone.
pub const WIDGET_VIEW_EVENT: &str = "polaris://widget-view";
/// A press on the widget, sent to the page in the call alone.
pub const VOICE_ACTION_EVENT: &str = "polaris://voice-action";

#[derive(Default)]
struct Inner {
    state: Option<VoiceState>,
    /// The label of the window whose call this is.
    holder: Option<String>,
    game_running: bool,
    unlocked: bool,
    ready: bool,
    /// The lock key held: accelerator and the name the widget shows.
    lock: Option<(String, String)>,
}

#[derive(Default)]
pub struct VoiceWidget(Mutex<Inner>);

fn inner(app: &AppHandle) -> MutexGuard<'_, Inner> {
    app.state::<VoiceWidget>()
        .inner()
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// What the page in a call says, or `null` when its call ended. Another page's
/// `null` does not end the call this one is in; a shape that does not parse
/// ends what this page had shown rather than keeping it.
#[tauri::command]
pub fn set_voice_state(app: AppHandle, window: WebviewWindow, input: Value) -> bool {
    if !crate::ipc::from_polaris(&app, &window) {
        return false;
    }
    let read = read_voice_state(&input);
    let next = read.clone().ok().flatten();
    let label = window.label().to_owned();
    {
        let mut held = inner(&app);
        match next {
            None => {
                if held.holder.as_ref().is_some_and(|holder| *holder != label) {
                    return read.is_ok();
                }
                held.holder = None;
                held.state = None;
            }
            Some(state) => {
                if held.holder.as_deref() != Some(label.as_str()) {
                    // A page that closes mid-call is out of the call.
                    let handle = app.clone();
                    let gone = label.clone();
                    window.on_window_event(move |event| {
                        if matches!(event, WindowEvent::Destroyed) {
                            page_left(&handle, &gone);
                        }
                    });
                }
                held.holder = Some(label);
                held.state = Some(state);
            }
        }
    }
    // The game-only mode needs the game watcher, which otherwise starts on the
    // page's first question.
    crate::developer::watch_games(&app);
    refresh(&app);
    read.is_ok()
}

/// A window left the page it was on, or closed: its call is over.
pub fn page_left(app: &AppHandle, label: &str) {
    {
        let mut held = inner(app);
        if held.holder.as_deref() != Some(label) {
            return;
        }
        held.holder = None;
        held.state = None;
    }
    refresh(app);
}

/// Whether a game is running now, as the game watcher last saw it.
pub fn set_game(app: &AppHandle, running: bool) {
    let open = {
        let mut held = inner(app);
        if held.game_running == running {
            return;
        }
        held.game_running = running;
        app.get_webview_window(VOICE_WIDGET).is_some()
    };
    // Shift+` is only taken while a game runs; see `lock_keys`.
    if open {
        hold_lock_key(app);
    }
    refresh(app);
}

/// A press on the widget, handed to the page in the call.
#[tauri::command]
pub fn voice_widget_act(app: AppHandle, window: WebviewWindow, input: Value) -> bool {
    if !crate::ipc::from_local(&window, VOICE_WIDGET) {
        return false;
    }
    let Some(action) = read_voice_action(&input) else {
        return false;
    };
    let holder = {
        let held = inner(&app);
        if held.state.is_none() {
            return false;
        }
        held.holder.clone()
    };
    holder.is_some_and(|holder| {
        app.emit_to(holder.as_str(), VOICE_ACTION_EVENT, action)
            .is_ok()
    })
}

/// Show, update or close the widget after anything it depends on changed.
pub fn refresh(app: &AppHandle) {
    let settings = read_settings(app);
    let (visible, people) = {
        let held = inner(app);
        let visible = widget_visible(
            held.state.is_some(),
            settings.voice_widget,
            settings.voice_widget_game_only,
            held.game_running,
        );
        (
            visible,
            held.state.as_ref().map(|state| state.participants.len()),
        )
    };
    let Some(people) = people.filter(|_| visible) else {
        close(app);
        return;
    };
    if app.get_webview_window(VOICE_WIDGET).is_none() && open(app, people).is_err() {
        eprintln!("polaris: the voice widget could not be opened");
        return;
    }
    draw(app);
}

pub fn close(app: &AppHandle) {
    release_lock_key(app);
    {
        let mut held = inner(app);
        held.unlocked = false;
        held.ready = false;
    }
    if let Some(window) = app.get_webview_window(VOICE_WIDGET) {
        let _ = window.destroy();
    }
}

fn work_area(monitor: &tauri::Monitor) -> WorkArea {
    let area = monitor.work_area();
    WorkArea {
        x: i64::from(area.position.x),
        y: i64::from(area.position.y),
        width: i64::from(area.size.width),
        height: i64::from(area.size.height),
    }
}

fn open(app: &AppHandle, people: usize) -> tauri::Result<()> {
    let settings = read_settings(app);
    let (width, height) = widget_size(people, false, settings.text_size());
    let screens: Vec<WorkArea> = app.available_monitors()?.iter().map(work_area).collect();
    let primary = app
        .primary_monitor()?
        .map(|monitor| work_area(&monitor))
        .or_else(|| screens.first().copied())
        .unwrap_or(WorkArea {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
        });
    // Kept in physical pixels, as the window reports where it was moved to.
    let place = start_point(settings.voice_widget_place, height, &screens, primary);
    let loaded = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        VOICE_WIDGET,
        WebviewUrl::App("voice-widget.html".into()),
    )
    .title("Voice - Polaris")
    .inner_size(f64::from(width), f64::from(height))
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
    // Kept out of screen captures, so a share does not show it.
    .content_protected(true)
    .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            inner(&loaded).ready = true;
            draw(&loaded);
            let _ = window.show();
        }
    })
    .build()?;
    let _ = window.set_position(PhysicalPosition::new(
        i32::try_from(place.x).unwrap_or(0),
        i32::try_from(place.y).unwrap_or(0),
    ));
    let _ = window.set_ignore_cursor_events(true);
    let moved = app.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(position) => remember(&moved, position.x, position.y),
        WindowEvent::Destroyed => {
            let mut held = inner(&moved);
            held.ready = false;
            held.unlocked = false;
        }
        _ => {}
    });
    hold_lock_key(app);
    Ok(())
}

fn release_lock_key(app: &AppHandle) {
    let held = inner(app).lock.take();
    if let Some((accelerator, _)) = held {
        let _ = app.global_shortcut().unregister(accelerator.as_str());
    }
}

/// Hold the first lock key the system gives, letting go of the one held before.
fn hold_lock_key(app: &AppHandle) {
    release_lock_key(app);
    let in_game = inner(app).game_running;
    for (accelerator, label) in lock_keys(std::env::consts::OS, in_game) {
        let taken = app
            .global_shortcut()
            .on_shortcut(accelerator, |app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    toggle_lock(app);
                }
            })
            .is_ok();
        if taken {
            inner(app).lock = Some((accelerator.to_owned(), label.to_owned()));
            return;
        }
    }
}

fn remember(app: &AppHandle, x: i32, y: i32) {
    let place = Point {
        x: i64::from(x),
        y: i64::from(y),
    };
    if read_settings(app).voice_widget_place == Some(place) {
        return;
    }
    let _ = update_settings(app, |settings| settings.voice_widget_place = Some(place));
}

fn toggle_lock(app: &AppHandle) {
    let Some(window) = app.get_webview_window(VOICE_WIDGET) else {
        return;
    };
    let unlocked = {
        let mut held = inner(app);
        held.unlocked = !held.unlocked;
        held.unlocked
    };
    // Unlocked it takes clicks and can be dragged; locked, clicks go through.
    let _ = window.set_focusable(unlocked);
    let _ = window.set_ignore_cursor_events(!unlocked);
    if !unlocked {
        if let Ok(position) = window.outer_position() {
            remember(app, position.x, position.y);
        }
    }
    draw(app);
}

/// Size the window for what it shows and hand the page its view.
fn draw(app: &AppHandle) {
    let Some(window) = app.get_webview_window(VOICE_WIDGET) else {
        return;
    };
    let text_size = read_settings(app).text_size();
    let Some((view, people, unlocked, ready)) = ({
        let held = inner(app);
        held.state.as_ref().map(|state| {
            let lock_key = held.lock.as_ref().map(|(_, label)| label.clone());
            (
                WidgetView::new(state, held.unlocked, lock_key),
                state.participants.len(),
                held.unlocked,
                held.ready,
            )
        })
    }) else {
        return;
    };
    let (width, height) = widget_size(people, unlocked, text_size);
    let size = LogicalSize::new(f64::from(width), f64::from(height));
    let current = window
        .inner_size()
        .ok()
        .zip(window.scale_factor().ok())
        .map(|(size, scale)| size.to_logical::<f64>(scale));
    if current.is_none_or(|current| current != size) {
        let _ = window.set_size(size);
    }
    if ready {
        let _ = app.emit_to(VOICE_WIDGET, WIDGET_VIEW_EVENT, view);
    }
}
