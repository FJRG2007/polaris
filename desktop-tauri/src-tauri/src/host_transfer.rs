//! Moving the list of hosts to and from another device: a file, the clipboard
//! or a QR code (`desktop/src/main/host-transfer.ts`). The list carries
//! addresses and names only; every sign-in stays with the session it belongs
//! to.
//!
//! The beta keeps the list in its own `hosts.json` beside `settings.json`, with
//! the saved server always first.

use crate::saved_server;
use polaris_client::host_list::{
    encode_host_list, encode_qr, host_list_file, host_list_link, merge_host_lists, qr_svg_path,
    read_host_list, PortableHost,
};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

/// The most hosts kept, as the Electron app's server list (`SERVERS_MAX`).
pub const SERVERS_MAX: usize = 20;
/// A list file is a few kilobytes; anything far larger is not one.
const FILE_MAX: u64 = 64 * 1024;
const HOSTS_FILE: &str = "hosts.json";

/// What taking a list in, or writing one out, came to. `error: null` when the
/// person cancelled.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum HostImport {
    Done {
        ok: bool,
        added: usize,
        named: usize,
        skipped: usize,
    },
    Failed {
        ok: bool,
        error: Option<String>,
    },
}

fn failed(error: Option<&str>) -> HostImport {
    HostImport::Failed {
        ok: false,
        error: error.map(str::to_owned),
    }
}

fn hosts_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join(HOSTS_FILE))
}

/// The hosts kept, the saved server first. Read leniently: the file is on disk
/// and anything may have written it, so it goes through the same reader as a
/// list from another device.
pub fn saved_hosts(app: &AppHandle) -> Vec<PortableHost> {
    let kept = hosts_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| read_host_list(&text))
        .unwrap_or_default();
    let first: Vec<PortableHost> = saved_server(app)
        .map(|server| vec![PortableHost::new(server.as_str(), None)])
        .unwrap_or_default();
    let mut hosts = merge_host_lists(&first, &kept, SERVERS_MAX).hosts;
    hosts.truncate(SERVERS_MAX);
    hosts
}

fn keep(app: &AppHandle, hosts: &[PortableHost]) -> Result<(), ()> {
    let path = hosts_path(app).ok_or(())?;
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder).map_err(drop)?;
    }
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, host_list_file(hosts)).map_err(drop)?;
    std::fs::rename(&temporary, &path).map_err(drop)
}

/// Take in a list read from a code, a link or a file's text. Pure but for the
/// store, for the tests.
pub fn import_into(
    saved: &[PortableHost],
    text: &str,
    keep: impl FnOnce(&[PortableHost]) -> Result<(), ()>,
) -> HostImport {
    let Some(incoming) = read_host_list(text) else {
        return failed(Some("That is not a list of Polaris hosts."));
    };
    let merged = merge_host_lists(saved, &incoming, SERVERS_MAX);
    if (merged.added > 0 || merged.named > 0) && keep(&merged.hosts).is_err() {
        return failed(Some("Polaris could not keep that list on this computer."));
    }
    HostImport::Done {
        ok: true,
        added: merged.added,
        named: merged.named,
        skipped: merged.skipped,
    }
}

#[derive(Serialize)]
pub struct Copied {
    ok: bool,
    count: usize,
}

/// The list as a code, put on the clipboard.
#[tauri::command]
pub fn copy_hosts(app: AppHandle) -> Result<Copied, String> {
    let hosts = saved_hosts(&app);
    app.clipboard()
        .write_text(encode_host_list(&hosts))
        .map_err(|_| "The list could not be put on the clipboard.".to_owned())?;
    Ok(Copied {
        ok: true,
        count: hosts.len(),
    })
}

/// Take in a list pasted or read off a QR code.
#[tauri::command]
pub fn import_hosts(app: AppHandle, text: String) -> HostImport {
    import_into(&saved_hosts(&app), &text, |hosts| keep(&app, hosts))
}

/// The list written to a file somebody picks.
#[tauri::command]
pub async fn save_hosts_file(app: AppHandle) -> HostImport {
    let picked = app
        .dialog()
        .file()
        .set_title("Export hosts")
        .set_file_name("polaris-hosts.json")
        .add_filter("Polaris hosts", &["json"])
        .blocking_save_file();
    let Some(path) = picked.and_then(|path| path.into_path().ok()) else {
        return failed(None);
    };
    match std::fs::write(path, host_list_file(&saved_hosts(&app))) {
        Ok(()) => HostImport::Done {
            ok: true,
            added: 0,
            named: 0,
            skipped: 0,
        },
        Err(_) => failed(Some(
            "Polaris could not write that file. Pick another folder.",
        )),
    }
}

/// Take in a list from a file somebody picks.
#[tauri::command]
pub async fn import_hosts_file(app: AppHandle) -> HostImport {
    let picked = app
        .dialog()
        .file()
        .set_title("Import hosts")
        .add_filter("Polaris hosts", &["json", "txt"])
        .blocking_pick_file();
    let Some(path) = picked.and_then(|path| path.into_path().ok()) else {
        return failed(None);
    };
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() > FILE_MAX => {
            return failed(Some("That file is too large to be a list of hosts."))
        }
        Err(_) => return failed(Some("Polaris could not read that file.")),
        Ok(_) => {}
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => import_hosts(app, text),
        Err(_) => failed(Some("Polaris could not read that file.")),
    }
}

/// The QR code that carries the list, as an SVG path and the side of its
/// square; `null` when the list is too long for any code.
#[derive(Serialize)]
pub struct HostsQr {
    path: String,
    size: usize,
}

#[tauri::command]
pub fn hosts_qr(app: AppHandle) -> Option<HostsQr> {
    let modules = encode_qr(&host_list_link(&saved_hosts(&app)))?;
    let (path, size) = qr_svg_path(&modules);
    Some(HostsQr { path, size })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn writes_nothing_when_nothing_changed_and_refuses_what_is_not_a_list() {
        let saved = vec![PortableHost::new(
            "https://polaris.example.com",
            Some("Casa"),
        )];
        let wrote = RefCell::new(false);
        let keep = |_: &[PortableHost]| {
            *wrote.borrow_mut() = true;
            Ok(())
        };
        assert_eq!(
            import_into(&saved, &encode_host_list(&saved), keep),
            HostImport::Done {
                ok: true,
                added: 0,
                named: 0,
                skipped: 0
            }
        );
        assert_eq!(
            import_into(&saved, "https://polaris.example.com", |_| Ok(())),
            failed(Some("That is not a list of Polaris hosts."))
        );
        assert!(!*wrote.borrow());
    }

    #[test]
    fn keeps_the_merged_list_and_answers_in_the_shape_the_pages_read() {
        let kept = RefCell::new(Vec::new());
        let code = encode_host_list(&[PortableHost::new("https://new.example", None)]);
        let outcome = import_into(&[], &code, |hosts| {
            *kept.borrow_mut() = hosts.to_vec();
            Ok(())
        });
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({ "ok": true, "added": 1, "named": 0, "skipped": 0 })
        );
        assert_eq!(kept.borrow().len(), 1);
        assert_eq!(
            serde_json::to_value(failed(None)).unwrap(),
            serde_json::json!({ "ok": false, "error": null })
        );
    }
}
