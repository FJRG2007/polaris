//! A start that can be timed and weighed without anybody seeing it, for
//! `desktop-tauri/tools/measure-startup`. Compiled only with the `measure` feature,
//! so no build anybody runs contains it.
//!
//! With `POLARIS_MEASURE_PAGE` set to a loopback `http` address, the app starts the
//! same runtime, plugins and engine as a normal start, opens that page in one
//! window that is never shown (created hidden, off-screen and off the taskbar),
//! prints one JSON line when the page has loaded, and quits by itself after
//! [`GIVE_UP_AFTER`]. It reads and writes no settings, no tray icon is added, and
//! the one-instance plugin is left out, so a beta already running is not woken.

use std::io::Write;
use std::time::{Duration, Instant};
use tauri::webview::PageLoadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

const PAGE_VARIABLE: &str = "POLARIS_MEASURE_PAGE";
/// Ends a measured start the tool forgot to end.
const GIVE_UP_AFTER: Duration = Duration::from_secs(120);

/// The page to measure against, when this start is a measured one. Only a
/// loopback `http` page: the measurement never reaches anything else.
pub fn page() -> Option<url::Url> {
    read_page(&std::env::var(PAGE_VARIABLE).ok()?)
}

fn read_page(raw: &str) -> Option<url::Url> {
    let page = url::Url::parse(raw).ok()?;
    let loopback = match page.host()? {
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
        url::Host::Domain(name) => name == "localhost",
    };
    (page.scheme() == "http" && loopback && page.username().is_empty() && page.password().is_none())
        .then_some(page)
}

pub fn run(page: url::Url, started: Instant) {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(crate::updater::plugin())
        .setup(move |app| {
            let reported = std::sync::atomic::AtomicBool::new(false);
            WebviewWindowBuilder::new(app, "measure", WebviewUrl::External(page))
                .title("Polaris Beta")
                .visible(false)
                .focused(false)
                .skip_taskbar(true)
                .position(-32_000.0, -32_000.0)
                .inner_size(1200.0, 800.0)
                .on_page_load(move |_window, payload| {
                    if payload.event() == PageLoadEvent::Finished
                        && !reported.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        let line = serde_json::json!({
                            "event": "loaded",
                            "ms": started.elapsed().as_secs_f64() * 1000.0,
                        });
                        let mut out = std::io::stdout().lock();
                        let _ = writeln!(out, "{line}");
                        let _ = out.flush();
                    }
                })
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(GIVE_UP_AFTER);
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the measured start failed");
}

#[cfg(test)]
mod tests {
    use super::read_page;

    #[test]
    fn measures_only_against_a_loopback_http_page() {
        assert!(read_page("http://127.0.0.1:8123/").is_some());
        assert!(read_page("http://localhost:8123/index.html").is_some());
        assert!(read_page("http://[::1]:8123/").is_some());
        for refused in [
            "https://127.0.0.1/",
            "http://example.com/",
            "http://10.0.0.2/",
            "http://user:pass@127.0.0.1/",
            "file:///C:/page.html",
            "not a url",
        ] {
            assert!(read_page(refused).is_none(), "{refused}");
        }
    }
}
