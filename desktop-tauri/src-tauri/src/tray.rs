//! The tray icon's menu (`desktop/src/main/tray.ts`) and the application menu
//! (`menu.ts`).
//!
//! The tray holds what is the app's own - the servers, the saved API key, the
//! update entry - the way Discord and Slack keep theirs. The beta never
//! updates, so that entry is there and disabled. The application menu is drawn
//! only on macOS: on Windows and Linux a Tauri menu is a strip across every
//! window, which the Electron app hides, so there the engine's own keys (reload,
//! zoom, back) and the tray stand in for it.

use crate::os_prefs::read_settings;
use crate::{saved_server, show_polaris, Outcome, MAIN};
use polaris_client::host_list::PortableHost;
use std::sync::Mutex;
use tauri::menu::{
    CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Url, Wry};
use tauri_plugin_opener::OpenerExt;

const TRAY: &str = "main";
const SWITCH: &str = "switch:";

/// The page zoom the menu's zoom items step through.
#[derive(Default)]
pub struct Zoom(Mutex<Option<f64>>);

fn item(app: &AppHandle, id: &str, label: &str, enabled: bool) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, label, enabled, None::<&str>)
}

/// What a host is called on the menu: its name, or its address.
fn describe(host: &PortableHost) -> String {
    host.name.clone().unwrap_or_else(|| {
        Url::parse(&host.origin)
            .ok()
            .and_then(|url| {
                let host = url.host_str()?.to_owned();
                Some(match url.port() {
                    Some(port) => format!("{host}:{port}"),
                    None => host,
                })
            })
            .unwrap_or_else(|| host.origin.clone())
    })
}

/// One line per server, the one in use ticked. Only worth a submenu once there
/// is somewhere else to go.
fn switch_to(app: &AppHandle) -> tauri::Result<Option<Submenu<Wry>>> {
    let hosts = crate::host_transfer::saved_hosts(app);
    if hosts.len() < 2 {
        return Ok(None);
    }
    let active = saved_server(app).map(|server| server.to_string());
    let mut submenu = SubmenuBuilder::new(app, "Switch to");
    for host in &hosts {
        let checked = active.as_deref() == Some(host.origin.as_str());
        let line = CheckMenuItem::with_id(
            app,
            format!("{SWITCH}{}", host.origin),
            describe(host),
            true,
            checked,
            None::<&str>,
        )?;
        submenu = submenu.item(&line);
    }
    submenu.build().map(Some)
}

/// The line about updates. The beta is never updated, so it says so and does
/// nothing.
fn update_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    item(app, "update", "Updates are off in this beta", false)
}

/// What the app itself offers, for the tray: the servers, the saved API key,
/// the update entry and the browser, then the beta's own OS switches.
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let server = saved_server(app).is_some();
    let settings = read_settings(app);
    let separator = || PredefinedMenuItem::separator(app);
    let switch = switch_to(app)?;
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![
        Box::new(item(app, "open", "Open Polaris", true)?),
        Box::new(separator()?),
        Box::new(update_item(app)?),
        Box::new(separator()?),
        Box::new(item(app, "settings", "Settings...", true)?),
    ];
    if let Some(switch) = switch {
        items.push(Box::new(switch));
    }
    items.extend::<[Box<dyn IsMenuItem<Wry>>; 11]>([
        Box::new(separator()?),
        Box::new(item(app, "api-keys", "API keys", server)?),
        // The TV installer is not in the beta yet.
        Box::new(item(app, "tv", "Install on a TV...", false)?),
        Box::new(item(app, "forget-key", "Forget the saved API key", server)?),
        Box::new(item(
            app,
            "browser",
            "Open this Polaris in the browser",
            server,
        )?),
        Box::new(separator()?),
        Box::new(CheckMenuItem::with_id(
            app,
            "login",
            "Open with the computer",
            true,
            settings.open_at_login,
            None::<&str>,
        )?),
        Box::new(CheckMenuItem::with_id(
            app,
            "mail",
            "Offer this beta for email links",
            cfg!(windows),
            settings.mail_handler,
            None::<&str>,
        )?),
        Box::new(CheckMenuItem::with_id(
            app,
            "voice-widget",
            "Show the call over other windows",
            true,
            settings.voice_widget,
            None::<&str>,
        )?),
        Box::new(CheckMenuItem::with_id(
            app,
            "voice-widget-game",
            "Only while a game is running",
            settings.voice_widget,
            settings.voice_widget_game_only,
            None::<&str>,
        )?),
        Box::new(separator()?),
    ]);
    items.push(Box::new(item(app, "quit", "Quit Polaris", true)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|one| one.as_ref()).collect();
    Menu::with_items(app, &refs)
}

/// The menu bar on macOS: File, Edit, View, Window and Help.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let server = saved_server(app).is_some();
    let separator = || PredefinedMenuItem::separator(app);
    let name = app.package_info().name.clone();
    let about = SubmenuBuilder::new(app, name)
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::services(app, None)?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let mut file =
        SubmenuBuilder::new(app, "File").item(&item(app, "settings", "Settings...", true)?);
    if let Some(switch) = switch_to(app)? {
        file = file.item(&switch);
    }
    let file = file
        .item(&MenuItem::with_id(
            app,
            "back",
            "Back",
            true,
            Some("Cmd+["),
        )?)
        .item(&MenuItem::with_id(
            app,
            "reload",
            "Reload",
            true,
            Some("CmdOrCtrl+R"),
        )?)
        .item(&separator()?)
        .item(&item(app, "api-keys", "API keys", server)?)
        .item(&item(app, "tv", "Install on a TV...", false)?)
        .item(&item(
            app,
            "forget-key",
            "Forget the saved API key",
            server,
        )?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItem::with_id(
            app,
            "force-reload",
            "Force Reload",
            true,
            Some("CmdOrCtrl+Shift+R"),
        )?)
        .item(&separator()?)
        .item(&MenuItem::with_id(
            app,
            "zoom-reset",
            "Actual Size",
            true,
            Some("CmdOrCtrl+0"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom-in",
            "Zoom In",
            true,
            Some("CmdOrCtrl+Plus"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "zoom-out",
            "Zoom Out",
            true,
            Some("CmdOrCtrl+-"),
        )?)
        .item(&separator()?)
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .build()?;
    let help = SubmenuBuilder::new(app, "Help")
        .item(&update_item(app)?)
        .item(&separator()?)
        .item(&item(
            app,
            "browser",
            "Open this Polaris in the browser",
            server,
        )?)
        .build()?;
    Menu::with_items(app, &[&about, &file, &edit, &view, &window, &help])
}

fn zoom(app: &AppHandle, step: Option<f64>) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let state = app.state::<Zoom>();
    let mut level = state
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // The same steps as Chromium's, between 50% and 300%.
    let next = step.map_or(1.0, |step| (level.unwrap_or(1.0) + step).clamp(0.5, 3.0));
    if window.set_zoom(next).is_ok() {
        *level = Some(next);
    }
}

fn say(app: &AppHandle, error: &str) {
    let notice = crate::notices::NoticeInput::problem(error);
    let _ = crate::notices::show(app, &app.state::<crate::notices::Notices>(), notice);
}

fn handle(app: &AppHandle, id: &str) {
    let window = app.get_webview_window(MAIN);
    match id {
        "open" => show_polaris(app, None),
        "quit" => app.exit(0),
        "settings" => crate::open_servers_window(app),
        "api-keys" => show_polaris(app, Some("/account/api-keys")),
        "forget-key" => crate::key_flow::forget(app),
        "browser" => {
            if let Some(server) = saved_server(app) {
                let _ = app.opener().open_url(server.to_string(), None::<&str>);
            }
        }
        "back" => {
            if let Some(window) = window {
                let _ = window.eval("history.back()");
            }
        }
        "reload" | "force-reload" => {
            if let Some(window) = window {
                let _ = window.reload();
            }
        }
        "zoom-reset" => zoom(app, None),
        "zoom-in" => zoom(app, Some(0.1)),
        "zoom-out" => zoom(app, Some(-0.1)),
        "login" => {
            let on = !read_settings(app).open_at_login;
            if let Err(error) = crate::login_item::set(app, on) {
                say(app, &error);
            }
            refresh(app);
        }
        "mail" => {
            let on = !read_settings(app).mail_handler;
            if let Err(error) = crate::mail_handler::set(app, on) {
                say(app, &error);
            }
            refresh(app);
        }
        "voice-widget" | "voice-widget-game" => {
            let saved = crate::os_prefs::update_settings(app, |settings| {
                if id == "voice-widget" {
                    settings.voice_widget = !settings.voice_widget;
                } else {
                    settings.voice_widget_game_only = !settings.voice_widget_game_only;
                }
            });
            if let Err(error) = saved {
                say(app, &error);
            }
            crate::voice_widget::refresh(app);
            refresh(app);
        }
        _ => {
            if let Some(origin) = id.strip_prefix(SWITCH) {
                switch(app, origin.to_owned());
            }
        }
    }
}

/// Go to another kept Polaris: the servers page's own switch, checked like an
/// address typed there and kept only when a Polaris answers.
fn switch(app: &AppHandle, origin: String) {
    if saved_server(app).is_some_and(|server| server.to_string() == origin) {
        refresh(app);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Outcome::Error { error, .. } = crate::ipc::switch_server(&app, &origin).await {
            say(&app, &error);
        }
        refresh(&app);
    });
}

/// Put the tray icon up, and on macOS the menu bar. Clicking the icon brings
/// Polaris forward.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("Polaris Beta")
        .menu(&tray_menu(app)?)
        .show_menu_on_left_click(false)
        // Called for every menu event, the menu bar's included.
        .on_menu_event(|app, event| handle(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_polaris(tray.app_handle(), None);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    if cfg!(target_os = "macos") {
        app.set_menu(app_menu(app)?)?;
    }
    Ok(())
}

/// Build the menus again after the servers or a switch changed.
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
    if cfg!(target_os = "macos") {
        if let Ok(menu) = app_menu(app) {
            let _ = app.set_menu(menu);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_host_by_its_name_or_its_address() {
        assert_eq!(
            describe(&PortableHost::new(
                "https://polaris.example.com",
                Some("Casa")
            )),
            "Casa"
        );
        assert_eq!(
            describe(&PortableHost::new("http://192.168.1.20:3000", None)),
            "192.168.1.20:3000"
        );
    }
}
