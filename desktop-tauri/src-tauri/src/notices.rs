//! Notices drawn by the operating system (`desktop/src/main/notices.ts`), and
//! what is waiting on the app's icon (`app-badge.ts`).
//!
//! The words are laid out by `polaris_client::notice` and a `once` notice the
//! other announcer already showed is dropped there. `tauri-plugin-notification`
//! on desktop draws a title, a body and the app's icon; it has no click, reply,
//! buttons or replace-by-tag there, so a notice is shown and left to the system.

use polaris_client::app_badge::{badge_plan, AppBadge, BadgePlan};
use polaris_client::notice::{notice_layout, NoticeWords, OnceNotices, Platform};
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_notification::NotificationExt;

/// Caps on what a page may hand over: a notice is a line or two, and a tag is
/// an id with its announcer.
const TITLE_MAX: usize = 1_000;
const BODY_MAX: usize = 10_000;
const TAG_MAX: usize = 200;

/// The `once` notices seen this run, on a clock that only goes forward.
pub struct Notices {
    said: Mutex<OnceNotices>,
    started: Instant,
}

impl Default for Notices {
    fn default() -> Self {
        Self {
            said: Mutex::new(OnceNotices::new()),
            started: Instant::now(),
        }
    }
}

/// What a page asks to show.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoticeInput {
    title: String,
    #[serde(default)]
    subtitle: Option<String>,
    #[serde(default)]
    body: Option<String>,
    tag: String,
    /// True when the page already played its own sound for it.
    #[serde(default)]
    silent: bool,
    /// Drop it when the other announcer showed a `once` notice with the same
    /// words a moment ago.
    #[serde(default)]
    once: bool,
}

impl NoticeInput {
    /// A notice from the app itself about something that did not work.
    pub fn problem(body: &str) -> Self {
        Self {
            title: "Polaris Beta".into(),
            subtitle: None,
            body: Some(body.into()),
            tag: "app:problem".into(),
            silent: false,
            once: false,
        }
    }

    fn checked(self) -> Result<Self, String> {
        let long =
            |text: &Option<String>, max| text.as_ref().is_some_and(|t| t.chars().count() > max);
        if self.title.trim().is_empty() || self.title.chars().count() > TITLE_MAX {
            return Err("A notice needs a title of at most 1000 characters.".into());
        }
        if long(&self.subtitle, TITLE_MAX) || long(&self.body, BODY_MAX) {
            return Err("That notice is too long to show.".into());
        }
        if self.tag.is_empty() || self.tag.chars().count() > TAG_MAX {
            return Err("A notice needs a tag of at most 200 characters.".into());
        }
        Ok(self)
    }
}

/// Show one. Answers whether it was shown, or dropped as a repeat.
pub fn show(app: &AppHandle, notices: &Notices, notice: NoticeInput) -> Result<bool, String> {
    let notice = notice.checked()?;
    if notice.once {
        let words = format!("{}\n{}", notice.title, notice.body.as_deref().unwrap_or(""));
        let now = u64::try_from(notices.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut said = notices
            .said
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if said.repeated(&notice.tag, &words, now) {
            return Ok(true);
        }
    }
    let words = notice_layout(
        &NoticeWords {
            title: notice.title,
            subtitle: notice.subtitle,
            body: notice.body,
        },
        Platform::current(),
    );
    // The plugin has no subtitle line on desktop; macOS gets it above the body.
    let body = match words.subtitle {
        Some(subtitle) => format!("{subtitle}\n{}", words.body),
        None => words.body,
    };
    let mut builder = app.notification().builder().title(words.title).body(body);
    if notice.silent {
        builder = builder.silent();
    }
    builder
        .show()
        .map(|()| true)
        .map_err(|_| "This computer did not show the notice.".to_owned())
}

#[tauri::command]
pub fn show_notice(
    app: AppHandle,
    window: WebviewWindow,
    notices: State<'_, Notices>,
    notice: NoticeInput,
) -> Result<bool, String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    show(&app, &notices, notice)
}

/// Put what is waiting on the main window's icon.
#[tauri::command]
pub fn set_app_badge(app: AppHandle, window: WebviewWindow, badge: AppBadge) -> Result<(), String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    let badge = badge.checked().map_err(str::to_owned)?;
    let Some(window) = app.get_webview_window(crate::MAIN) else {
        return Ok(());
    };
    let failed = |_| "The app's icon could not be changed.".to_owned();
    match badge_plan(&badge, Platform::current()) {
        BadgePlan::Overlay { png, .. } => overlay(&window, png.as_deref()).map_err(failed),
        BadgePlan::Dock(label) => dock(&window, label).map_err(failed),
        BadgePlan::Count(count) => window.set_badge_count(count.map(i64::from)).map_err(failed),
    }
}

#[cfg(windows)]
fn overlay(window: &tauri::WebviewWindow, png: Option<&[u8]>) -> tauri::Result<()> {
    let image = png.and_then(|bytes| tauri::image::Image::from_bytes(bytes).ok());
    window.set_overlay_icon(image)
}

#[cfg(not(windows))]
fn overlay(_window: &tauri::WebviewWindow, _png: Option<&[u8]>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn dock(window: &tauri::WebviewWindow, label: Option<String>) -> tauri::Result<()> {
    window.set_badge_label(label)
}

#[cfg(not(target_os = "macos"))]
fn dock(_window: &tauri::WebviewWindow, _label: Option<String>) -> tauri::Result<()> {
    Ok(())
}
