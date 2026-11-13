//! Thin commands over `polaris-client`'s deploy and developer side: push from
//! local, "Upload a folder", installing an allow-listed tool, and the running game.
//!
//! Reachable only from the app's own pages: no capability lets a remote origin
//! invoke anything. Every input is a closed shape (`deny_unknown_fields`) checked
//! again here; a page never names a path, a program or an argument. Folders come
//! from the app's own picker, and what an install runs comes from the Rust table.

use polaris_client::folder_zip::{zip_folder, FolderError};
use polaris_client::game_detect::{self, CustomGame, GameWatcher, RunningGame};
use polaris_client::install_tools::{
    self as tools, InstallFailure, InstallRequest, InstallResult, InstallTool, InstallVia,
};
use polaris_client::push_local::{self, PushEvent, PushPlan, SystemTools};
use polaris_client::{ApiClient, ApiKey, InstanceUrl};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio_util::sync::CancellationToken;

/// Per service: the folder picked for it, and the push running, if any.
type Pushes = HashMap<String, (Option<PathBuf>, Option<CancellationToken>)>;

/// What this module keeps while the app runs.
#[derive(Default)]
pub struct Developer {
    pushes: Mutex<Pushes>,
    games: Arc<Mutex<GameWatcher>>,
    watching: Mutex<bool>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A service id as the dashboard sends it: a UUID.
fn uuid(text: &str) -> Result<(), String> {
    let groups: Vec<&str> = text.split('-').collect();
    let shape = groups.iter().map(|g| g.len()).collect::<Vec<_>>() == [8, 4, 4, 4, 12];
    let hex = groups
        .iter()
        .all(|g| g.bytes().all(|b| b.is_ascii_hexdigit()));
    if shape && hex {
        Ok(())
    } else {
        Err("That service could not be read.".into())
    }
}

async fn pick_folder(app: &AppHandle, title: String) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .pick_folder(move |picked| {
            let _ = tx.send(picked.and_then(|path| path.into_path().ok()));
        });
    rx.await.ok().flatten()
}

async fn confirm(app: &AppHandle, question: String, detail: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(detail)
        .title(question)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Cancel".into(),
        ))
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServiceInput {
    service_id: String,
    name: String,
}

/// The push window's "Choose folder": the app's own picker, kept per service.
#[tauri::command]
pub async fn push_choose_folder(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Developer>,
    input: ServiceInput,
) -> Result<Option<String>, String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    uuid(&input.service_id)?;
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("That service could not be read.".into());
    }
    let picked = pick_folder(&app, format!("The folder to build {name} from")).await;
    if let Some(folder) = &picked {
        lock(&state.pushes).entry(input.service_id).or_default().0 = Some(folder.clone());
    }
    Ok(picked.map(|folder| folder.to_string_lossy().into_owned()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PushInput {
    service_id: String,
    name: String,
    server: String,
    platform: String,
    /// Checked for its shape, used for this push only and never kept: the key
    /// store is its own row of the parity ledger.
    api_key: String,
}

/// Start a push; its events arrive on `events`, and its end is the answer.
#[tauri::command]
pub async fn push_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Developer>,
    http: State<'_, crate::Http>,
    input: PushInput,
    events: Channel<PushEvent>,
) -> Result<push_local::PushEnd, String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    uuid(&input.service_id)?;
    let name = input.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 200 {
        return Err("That service could not be read.".into());
    }
    if !push_local::is_platform(&input.platform) {
        return Err("Choose a platform from the list.".into());
    }
    let server = InstanceUrl::parse(&input.server)
        .map_err(|_| "Choose the Polaris to push to first.".to_owned())?;
    let key = ApiKey::parse(&input.api_key).map_err(|error| error.to_string())?;
    let cancel = CancellationToken::new();
    let folder = {
        let mut pushes = lock(&state.pushes);
        let entry = pushes.entry(input.service_id.clone()).or_default();
        if entry.1.is_some() {
            return Err("A push is already running.".into());
        }
        let folder = entry.0.clone().ok_or("Choose the folder to build first.")?;
        entry.1 = Some(cancel.clone());
        folder
    };
    let release = || {
        if let Some(entry) = lock(&state.pushes).get_mut(&input.service_id) {
            entry.1 = None;
        }
    };
    if !tokio::fs::metadata(&folder)
        .await
        .is_ok_and(|info| info.is_dir())
    {
        release();
        return Err("That folder is not there any more. Choose it again.".into());
    }
    let client = ApiClient::new(http.0.clone(), server, key);
    let plan = PushPlan {
        service_id: input.service_id.clone(),
        name,
        folder,
        platform: input.platform,
    };
    let end = push_local::push(
        &client,
        &SystemTools,
        &plan,
        move |event| drop(events.send(event)),
        &cancel,
    )
    .await;
    release();
    Ok(end)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ServiceId {
    service_id: String,
}

/// Stop a push; once it is deploying, this only stops following it.
#[tauri::command]
pub fn push_cancel(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Developer>,
    input: ServiceId,
) {
    if !crate::ipc::from_polaris(&app, &window) {
        return;
    }
    if let Some((_, Some(cancel))) = lock(&state.pushes).get(&input.service_id) {
        cancel.cancel();
    }
}

/// "Upload a folder": the app's picker, then the folder zipped by the browser
/// zipper's rules. Answered as bytes: a 4-byte big-endian length, that much JSON
/// (`{"ok":true,"name","files"}`, `{"ok":false,"error"}` or `null` when nothing
/// was picked), then the zip.
#[tauri::command]
pub async fn upload_folder(app: AppHandle, window: WebviewWindow) -> Response {
    let frame = |head: serde_json::Value, zip: Vec<u8>| {
        let head = head.to_string().into_bytes();
        let mut bytes = u32::try_from(head.len())
            .unwrap_or(0)
            .to_be_bytes()
            .to_vec();
        bytes.extend(head);
        bytes.extend(zip);
        Response::new(bytes)
    };
    if !crate::ipc::from_polaris(&app, &window) {
        return frame(
            serde_json::json!({ "ok": false, "error": crate::ipc::REFUSAL }),
            Vec::new(),
        );
    }
    let Some(folder) = pick_folder(&app, "Choose the folder to upload".into()).await else {
        return frame(serde_json::Value::Null, Vec::new());
    };
    let zipped =
        tokio::task::spawn_blocking(move || zip_folder(&folder, Cursor::new(Vec::new()))).await;
    match zipped {
        Ok(Ok((zipped, out))) => frame(
            serde_json::json!({ "ok": true, "name": zipped.name, "files": zipped.files }),
            out.into_inner(),
        ),
        Ok(Err(FolderError::Refusal(error))) => frame(
            serde_json::json!({ "ok": false, "error": error }),
            Vec::new(),
        ),
        Ok(Err(error)) => {
            eprintln!("[folder] {error:?}");
            frame(
                serde_json::json!({ "ok": false, "error": polaris_client::folder_zip::UNREADABLE }),
                Vec::new(),
            )
        }
        Err(_) => frame(
            serde_json::json!({ "ok": false, "error": polaris_client::folder_zip::UNREADABLE }),
            Vec::new(),
        ),
    }
}

/// Opens a launch from the table, detached; a program that is not there only logs.
fn open_launch(launch: &tools::Launch) {
    let mut command = std::process::Command::new(&launch.file);
    command
        .args(&launch.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    if let Err(error) = command.spawn() {
        eprintln!("polaris: the browser did not open: {error}");
    }
}

/// Install an allow-listed tool after the app's own confirmation.
#[tauri::command]
pub async fn install_tool(
    app: AppHandle,
    window: WebviewWindow,
    request: InstallRequest,
) -> InstallResult {
    if !crate::ipc::from_polaris(&app, &window) {
        return InstallResult::failed(InstallFailure::Refused);
    }
    let platform = std::env::consts::OS;
    let Some(repo) = tools::repository_slug(env!("CARGO_PKG_REPOSITORY")) else {
        return InstallResult::failed(InstallFailure::Unsupported);
    };
    if !tools::installable(request.tool, platform) {
        return InstallResult::failed(InstallFailure::Unsupported);
    }
    let Some(_slot) = tools::InstallSlot::take() else {
        return InstallResult::failed(InstallFailure::Busy);
    };
    let folders = tools::Folders::current();
    let browser = request
        .browser
        .filter(|_| request.tool == InstallTool::Extension);
    // Listed in the browser's store: the browser installs it.
    if let Some(browser) = browser {
        if let Some(entry) =
            tools::external_entry(browser, platform, &folders, tools::STORE_LISTINGS)
        {
            if !confirm(
                &app,
                tools::install_question(request.tool),
                tools::STORE_DETAIL,
            )
            .await
            {
                return InstallResult::failed(InstallFailure::Cancelled);
            }
            let written = match entry {
                tools::ExternalEntry::Registry { key, update_url } => {
                    let launch = tools::registry_add_launch(&key, &update_url);
                    matches!(
                        tools::run_launch(&launch, tools::SHELL_TIMEOUT, None).await,
                        Ok((Some(0), _))
                    )
                }
                tools::ExternalEntry::File { path, contents } => {
                    let path = PathBuf::from(path);
                    let folder = path
                        .parent()
                        .map(std::path::Path::to_path_buf)
                        .unwrap_or_default();
                    tokio::fs::create_dir_all(folder).await.is_ok()
                        && tokio::fs::write(&path, contents).await.is_ok()
                }
            };
            if !written {
                return InstallResult::failed(InstallFailure::Failed);
            }
            open_launch(&tools::browser_launch(browser, platform));
            return InstallResult::done(Some(InstallVia::StoreEntry));
        }
    }
    if !confirm(
        &app,
        tools::install_question(request.tool),
        tools::SCRIPT_DETAIL,
    )
    .await
    {
        return InstallResult::failed(InstallFailure::Cancelled);
    }
    let installed = match tools::run_script(request.tool, platform, &repo, &folders).await {
        Ok(path) => path,
        Err(result) => return result,
    };
    if request.tool != InstallTool::Extension {
        return InstallResult::done(None);
    }
    // The steps left for the browser: the folder copied and shown, and the
    // browser on its extensions page.
    let _ = app.clipboard().write_text(installed.clone());
    let _ = tauri_plugin_opener::reveal_item_in_dir(&installed);
    if let Some(browser) = request.browser {
        open_launch(&tools::extensions_page_launch(browser, platform));
    }
    InstallResult::done(Some(InstallVia::Unpacked))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(0))
}

/// One read of the process list; an error when the system gave none.
fn programs(system: &mut Option<sysinfo::System>) -> Result<Vec<String>, sysinfo::Error> {
    if system.is_none() {
        *system = Some(sysinfo::System::new()?);
    }
    Ok(system
        .as_mut()
        .map(game_detect::running_programs)
        .unwrap_or_default())
}

async fn look(games: &Arc<Mutex<GameWatcher>>, system: &Arc<Mutex<Option<sysinfo::System>>>) {
    let system = Arc::clone(system);
    let programs = tokio::task::spawn_blocking(move || programs(&mut lock(&system))).await;
    let programs = programs
        .map_err(|_| ())
        .and_then(|read| read.map_err(|_| ()));
    lock(games).check(programs, now_ms());
}

fn start_watching(state: &Developer) {
    let mut watching = lock(&state.watching);
    if *watching {
        return;
    }
    *watching = true;
    let games = Arc::clone(&state.games);
    tauri::async_runtime::spawn(async move {
        let system = Arc::new(Mutex::new(None));
        let mut every = tokio::time::interval(game_detect::CHECK);
        loop {
            every.tick().await;
            look(&games, &system).await;
        }
    });
}

/// The game running now, as last seen; starts watching on the first ask.
#[tauri::command]
pub fn running_game(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Developer>,
) -> Option<RunningGame> {
    if !crate::ipc::from_polaris(&app, &window) {
        return None;
    }
    start_watching(&state);
    lock(&state.games).running().cloned()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomGames {
    games: Vec<CustomGame>,
}

/// The programs somebody added as games, looked for at once.
#[tauri::command]
pub async fn set_custom_games(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Developer>,
    input: CustomGames,
) -> Result<(), String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Err(crate::ipc::REFUSAL.to_owned());
    }
    let valid = |text: &str| !text.trim().is_empty() && text.chars().count() <= 200;
    if input.games.len() > 100
        || !input
            .games
            .iter()
            .all(|game| valid(&game.executable) && valid(&game.name))
    {
        return Err("Those games could not be read.".into());
    }
    lock(&state.games).set_custom_games(input.games);
    start_watching(&state);
    let system = Arc::new(Mutex::new(None));
    look(&state.games, &system).await;
    Ok(())
}

/// The names of what is running, for the settings page to pick a game from, on
/// a press. Goes to the page on screen and nowhere else.
#[tauri::command]
pub async fn running_programs(app: AppHandle, window: WebviewWindow) -> Vec<String> {
    if !crate::ipc::from_polaris(&app, &window) {
        return Vec::new();
    }
    let names = tokio::task::spawn_blocking(|| programs(&mut None))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let mut unique: Vec<String> = names
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    unique.truncate(2000);
    unique
}
