//! The dashboard's `window.polarisDesktop` (`desktop/src/preload/app.ts`) and
//! the account's text size both ways (`preload/text-size.ts`).
//!
//! The bridge is an initialization script (`bridge.js`) given to the Polaris
//! windows only, with the origins it may define itself on baked in: the server
//! in use and the addresses that same Polaris said it answers on, which is where
//! the failover can take the window. A page on any other origin, or in a frame,
//! gets nothing. Underneath, every call is a command that only the remote
//! capability granted to the configured origin lets through (`ipc::allow_origin`),
//! and that checks the window and origin again (`ipc::from_polaris`).
//!
//! `withGlobalTauri` stays on because the app's own pages use `window.__TAURI__`.
//! Tauri injects that object and `__TAURI_INTERNALS__` into every webview,
//! remote pages included; on an origin no capability names, every `invoke` is
//! refused by the ACL, so another site in a Polaris window can reach nothing.

use crate::{shared, MAIN, SERVERS};
use polaris_client::settings::read_text_size;
use polaris_client::InstanceUrl;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

/// The script, a function expression the configuration is applied to.
const BRIDGE_JS: &str = include_str!("bridge.js");

/// The app's own windows that take the account's text size.
const LOCAL_WINDOWS: [&str; 2] = [SERVERS, crate::key_flow::KEY_WINDOW];

/// `process.platform` as the Electron app reports it.
pub fn platform_name(os: &str) -> &str {
    match os {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    }
}

/// The origins the bridge defines itself on: the server in use, then every
/// address its instance record names, each in the one stored form, once.
pub fn bridge_origins(current: &str, addresses: &[String]) -> Vec<String> {
    let mut origins: Vec<String> = Vec::new();
    for raw in std::iter::once(current).chain(addresses.iter().map(String::as_str)) {
        let Ok(origin) = InstanceUrl::parse(raw) else {
            continue;
        };
        let origin = origin.to_url().origin().ascii_serialization();
        if origin != "null" && !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    origins
}

/// The script for a Polaris window allowed on `origins`. No origin, no bridge.
pub fn bridge_script(origins: &[String], version: &str, platform: &str) -> Option<String> {
    if origins.is_empty() {
        return None;
    }
    let config = json!({ "origins": origins, "version": version, "platform": platform });
    Some(format!("{BRIDGE_JS}({config});\n"))
}

/// What the app's own pages run before they draw: the root takes the size,
/// which every rem follows (`applyTextSize`).
pub fn text_size_script(size: u16) -> String {
    format!(
        "(function (size) {{\n    var apply = function () {{ document.documentElement.style.setProperty(\"font-size\", size + \"px\"); }};\n    if (document.documentElement) {{ apply(); return; }}\n    var watch = new MutationObserver(function () {{\n        if (!document.documentElement) return;\n        watch.disconnect();\n        apply();\n    }});\n    watch.observe(document, {{ childList: true }});\n}})({size});\n"
    )
}

/// The script a Polaris window is built with, from the app's state now.
pub fn script_for(app: &AppHandle) -> Option<String> {
    let current = shared(app).current()?;
    let addresses = crate::stored_addresses(app, &current);
    bridge_script(
        &bridge_origins(&current, &addresses),
        &app.package_info().version.to_string(),
        platform_name(std::env::consts::OS),
    )
}

/// The size an app page is built with.
pub fn local_script(app: &AppHandle) -> String {
    text_size_script(shared(app).settings().text_size())
}

/// The Polaris window reporting the account's text size. Answers false for a
/// window that may not, or a size that is not one of the offered ones.
#[tauri::command]
pub fn text_size_seen(app: AppHandle, window: WebviewWindow, raw: Value) -> bool {
    let Some(size) = read_text_size(&raw).filter(|_| crate::ipc::from_polaris(&app, &window))
    else {
        return false;
    };
    let mut changed = false;
    let saved = shared(&app).update_settings(|settings| {
        changed = settings.remember_text_size(size);
    });
    if saved.is_ok() && changed {
        let apply =
            format!("document.documentElement.style.setProperty(\"font-size\", \"{size}px\")");
        for label in LOCAL_WINDOWS {
            if let Some(local) = app.get_webview_window(label) {
                let _ = local.eval(&apply);
            }
        }
    }
    true
}

/// Restores the main window where it was unless that place is out of reach
/// (`restoredPlace`): `tauri-plugin-window-state` keeps and restores it, but
/// moves it back only when any corner is on a monitor, so a window whose title
/// bar is off every display is opened at a size that fits the primary one,
/// centred. Queued after the plugin's own restore on the main thread.
pub fn keep_reachable(window: &WebviewWindow) {
    let held = window.clone();
    let _ = window.run_on_main_thread(move || {
        if held.label() != MAIN || held.is_maximized().unwrap_or(false) {
            return;
        }
        let (Ok(position), Ok(size), Ok(monitors)) = (
            held.outer_position(),
            held.outer_size(),
            held.available_monitors(),
        ) else {
            return;
        };
        let area = |rect: &tauri::PhysicalRect<i32, u32>| polaris_client::window_place::Area {
            x: i64::from(rect.position.x),
            y: i64::from(rect.position.y),
            width: i64::from(rect.size.width),
            height: i64::from(rect.size.height),
        };
        let displays: Vec<_> = monitors.iter().map(|m| area(m.work_area())).collect();
        let Some(primary) = held
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| area(m.work_area()))
            .or_else(|| displays.first().copied())
        else {
            return;
        };
        let saved = polaris_client::window_place::WindowPlace {
            x: i64::from(position.x),
            y: i64::from(position.y),
            width: i64::from(size.width),
            height: i64::from(size.height),
            maximized: false,
        };
        let place = polaris_client::window_place::restored_place(&saved, &displays, &primary);
        if place.x.is_some() {
            return;
        }
        let fit = |value: i64| u32::try_from(value.max(1)).unwrap_or(u32::MAX);
        let _ = held.set_size(tauri::PhysicalSize::new(
            fit(place.width),
            fit(place.height),
        ));
        let _ = held.center();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn repo(path: &str) -> String {
        let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(path);
        std::fs::read_to_string(&file)
            .unwrap_or_else(|error| panic!("{} could not be read: {error}", file.display()))
    }

    /// The member names of an object literal or interface laid out at four
    /// spaces, with the members of a nested object at eight as `parent.child`.
    fn members(block: &str) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        let mut parent: Option<String> = None;
        for line in block.lines() {
            let depth = line.len() - line.trim_start().len();
            let text = line.trim_start();
            let text = text.strip_prefix("readonly ").unwrap_or(text);
            let name: String = text
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .collect();
            let rest = &text[name.len()..];
            let is_member = !name.is_empty()
                && (rest.starts_with(':')
                    || rest.starts_with('?')
                    || rest.starts_with('(')
                    || rest.starts_with(','));
            if depth == 4 {
                parent = None;
                if is_member {
                    let property = rest.starts_with(':') || rest.starts_with("?:");
                    if property && rest.trim_end().ends_with('{') {
                        parent = Some(name.clone());
                    }
                    names.insert(name);
                }
            } else if depth == 8 && is_member {
                if let Some(parent) = &parent {
                    names.insert(format!("{parent}.{name}"));
                }
            }
        }
        names
    }

    fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
        let from = text.find(start).expect("the block starts") + start.len();
        let to = text[from..].find(end).expect("the block ends") + from;
        &text[from..to]
    }

    fn script_members() -> BTreeSet<String> {
        members(between(BRIDGE_JS, "var bridge = {", "\n    };"))
    }

    #[test]
    fn the_script_has_exactly_the_preloads_members() {
        let preload = repo("desktop/src/preload/app.ts");
        let electron = members(between(
            &preload,
            "const bridge: PolarisDesktop = {",
            "\n};",
        ));
        assert!(electron.contains("tv.onState") && electron.contains("vpn.joinNetwork"));
        assert_eq!(script_members(), electron);
    }

    #[test]
    fn the_script_answers_everything_the_dashboard_reads() {
        let page = repo("dashboard/apps/web/src/lib/desktop-bridge.ts");
        let mut wanted = members(between(&page, "export interface PolarisDesktop {", "\n}"));
        // `readonly vpn?: {` is nested at eight spaces; the TV install is its own interface.
        for name in members(between(&page, "export interface DesktopTv {", "\n}")) {
            wanted.insert(format!("tv.{name}"));
        }
        assert!(wanted.contains("notify") && wanted.contains("tv.start"));
        assert!(wanted.contains("vpn.up"), "{wanted:?}");
        let script = script_members();
        let missing: Vec<_> = wanted.difference(&script).collect();
        assert!(missing.is_empty(), "missing from bridge.js: {missing:?}");
        // The members `isDesktopBridge` requires.
        let required = between(&page, "const METHODS = [", "]");
        for name in required.split(',').map(|n| n.trim().trim_matches('"')) {
            assert!(script_members().contains(name), "{name}");
        }
    }

    #[test]
    fn the_bridge_is_defined_only_on_the_polaris_it_was_given() {
        let origins = bridge_origins(
            "https://polaris.example.com",
            &[
                "https://polaris.example.com/".into(),
                "https://192.168.1.20:8443".into(),
                "not an address".into(),
                "javascript:alert(1)".into(),
            ],
        );
        assert_eq!(
            origins,
            ["https://polaris.example.com", "https://192.168.1.20:8443"]
        );
        let script = bridge_script(&origins, "0.0.1", "win32").expect("a script");
        assert!(script.contains(
            r#"{"origins":["https://polaris.example.com","https://192.168.1.20:8443"],"platform":"win32","version":"0.0.1"}"#
        ));
        assert!(script.contains("config.origins.indexOf(window.location.origin) < 0) return;"));
        assert!(script.contains("if (window.top !== window) return;"));
        assert!(bridge_script(&[], "0.0.1", "win32").is_none());
        assert!(bridge_origins("not an address", &[]).is_empty());
    }

    /// The commands `bridge.js` calls, by their Tauri names.
    fn script_commands() -> BTreeSet<String> {
        let mut found = BTreeSet::new();
        for call in ["ask(\"", "invoke(\""] {
            for (at, _) in BRIDGE_JS.match_indices(call) {
                let rest = &BRIDGE_JS[at + call.len()..];
                let name = &rest[..rest.find('"').expect("a closed name")];
                if !name.starts_with("plugin:") {
                    found.insert(name.replace('_', "-"));
                }
            }
        }
        found
    }

    #[test]
    fn the_script_calls_every_polaris_command_and_nothing_else() {
        let called = script_commands();
        let granted: BTreeSet<String> = crate::ipc::POLARIS_COMMANDS
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        let unknown: Vec<_> = called.difference(&granted).collect();
        assert!(unknown.is_empty(), "not Polaris commands: {unknown:?}");
        // Every Polaris command is reached from the bridge: the push window's own
        // steps went to that window's capability with `pushLocal`.
        let unmapped: Vec<_> = granted.difference(&called).collect();
        assert!(
            unmapped.is_empty(),
            "a Polaris command bridge.js does not map: {unmapped:?}"
        );
    }

    /// The commands a page of the app's own calls, by their Tauri names.
    fn page_commands(script: &str) -> BTreeSet<String> {
        script
            .match_indices("invoke(\"")
            .map(|(at, _)| {
                let rest = &script[at + 8..];
                rest[..rest.find('"').expect("a closed name")].replace('_', "-")
            })
            .collect()
    }

    /// The commands a capability file grants.
    fn granted(capability: &str) -> BTreeSet<String> {
        let parsed: Value = serde_json::from_str(capability).expect("a capability");
        parsed["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|one| one.as_str()?.strip_prefix("allow-").map(str::to_owned))
            .collect()
    }

    #[test]
    fn the_push_and_tv_pages_call_exactly_what_their_windows_are_granted() {
        for (script, capability) in [
            (
                include_str!("../../ui/push.js"),
                include_str!("../capabilities/push.json"),
            ),
            (
                include_str!("../../ui/tv.js"),
                include_str!("../capabilities/tv.json"),
            ),
        ] {
            assert_eq!(page_commands(script), granted(capability));
        }
        // No Polaris window is granted the push window's steps, and the push page
        // is the only one granted them.
        for step in [
            "push-state",
            "push-choose-folder",
            "push-start",
            "push-cancel",
            "push-open-service",
        ] {
            assert!(!crate::ipc::POLARIS_COMMANDS.contains(&step), "{step}");
        }
        let push: Value =
            serde_json::from_str(include_str!("../capabilities/push.json")).expect("push");
        assert_eq!(push["windows"], serde_json::json!(["push-*"]));
        assert_eq!(push["local"], true);
    }

    #[test]
    fn only_the_polaris_windows_are_built_with_the_bridge() {
        let main = include_str!("main.rs");
        let key_flow = include_str!("key_flow.rs");
        assert_eq!(main.matches("bridge::script_for(").count(), 1);
        let builder = between(main, "fn polaris_builder<", "\n}\n");
        assert!(builder.contains("bridge::script_for(app)"));
        assert!(!key_flow.contains("script_for("));
        // The guards run before anything is defined.
        let guards = BRIDGE_JS.find("config.origins.indexOf(window.location.origin) < 0) return;");
        let defined = BRIDGE_JS.find("var bridge = {");
        assert!(guards.expect("the origin guard") < defined.expect("the bridge"));
        let other = bridge_origins("https://polaris.example.com", &[]);
        assert!(!other.contains(&"https://evil.example.com".to_owned()));
        assert_eq!(other, ["https://polaris.example.com"]);
    }

    #[test]
    fn the_platform_reads_as_nodes() {
        assert_eq!(platform_name("windows"), "win32");
        assert_eq!(platform_name("macos"), "darwin");
        assert_eq!(platform_name("linux"), "linux");
    }

    #[test]
    fn an_app_page_takes_the_size_before_it_draws() {
        assert!(text_size_script(18).ends_with("})(18);\n"));
    }

    #[test]
    fn the_update_check_answers_a_build_that_does_not_update() {
        assert!(BRIDGE_JS.contains("return answer({ kind: \"unsupported\" });"));
        assert!(BRIDGE_JS.contains("return ask(\"update_ready\", {}, null);"));
        assert!(BRIDGE_JS.contains("return listen(\"polaris://update-ready\", listener);"));
    }
}
