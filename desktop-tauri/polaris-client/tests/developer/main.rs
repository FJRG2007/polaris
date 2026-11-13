//! Installing a tool (the page names one, the app decides what runs) and telling
//! which game is running. Nothing is installed and no process list is read here.

use polaris_client::game_detect::{
    iso_time, match_game, parse_cmdline, program_key, CustomGame, GameWatcher, REPEAT_MS,
};
use polaris_client::install_tools::{
    browser_from_name, extensions_page_launch, install_failure, install_launch, install_path,
    installable, installed_path, last_said, repository_slug, script_finished, windows_entry_keys,
    ExtensionBrowser, Folders, InstallRequest, InstallResult, InstallTool, Launch, StoreListings,
    INSTALL_TOOLS, STORE_LISTINGS,
};
use polaris_client::known_games::KNOWN_GAMES;
use std::path::Path;

const REPO: &str = "example/polaris";

fn repo_root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

#[test]
fn a_page_names_a_tool_from_the_list_and_nothing_else() {
    let parse = |text: &str| serde_json::from_str::<InstallRequest>(text);
    assert_eq!(parse(r#"{"tool":"cli"}"#).unwrap().tool, InstallTool::Cli);
    assert!(parse(r#"{"tool":"calc.exe"}"#).is_err());
    assert!(parse(r#"{"tool":"extension","browser":"x; rm -rf"}"#).is_err());
    assert!(parse(r#"{"tool":"cli","command":"calc.exe"}"#).is_err());
    assert!(!installable(InstallTool::Deck, "linux"));
    assert!(installable(InstallTool::Cli, "linux"));
}

#[test]
fn runs_the_official_scripts() {
    let windows = install_launch(InstallTool::Cli, "windows", REPO);
    assert_eq!(windows.file, "powershell.exe");
    assert_eq!(
        windows.args.last().unwrap(),
        "irm 'https://raw.githubusercontent.com/example/polaris/main/dashboard/packages/cli/scripts/install.ps1' | iex"
    );
    assert_eq!(
        install_launch(InstallTool::Extension, "macos", REPO).args,
        ["-c", "curl -fsSL 'https://raw.githubusercontent.com/example/polaris/main/dashboard/apps/extension/scripts/install.sh' | sh"]
    );
    assert_eq!(
        repository_slug("https://github.com/example/polaris.git").as_deref(),
        Some(REPO)
    );
    assert_eq!(
        repository_slug("git+https://github.com/example/polaris/").as_deref(),
        Some(REPO)
    );
    assert_eq!(repository_slug("https://example.test/not-github"), None);
    assert_eq!(repository_slug("https://github.com/a/b/c"), None);
    assert_eq!(
        repository_slug(env!("CARGO_PKG_REPOSITORY")).as_deref(),
        Some("FJRG2007/polaris")
    );
}

#[test]
fn the_path_a_script_gets() {
    assert_eq!(
        install_path(
            "welcome\n__POLARIS_PATH__/nvm/bin:/usr/bin__POLARIS_PATH__\n",
            Some("/usr/bin:/bin")
        ),
        "/nvm/bin:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
    );
    assert_eq!(
        install_path("", Some("/usr/bin")),
        "/usr/bin:/usr/local/bin:/opt/homebrew/bin"
    );
    assert_eq!(install_path("", None), "/usr/local/bin:/opt/homebrew/bin");
}

#[test]
fn looks_where_each_script_installs() {
    let windows = Folders {
        home: "C:\\Users\\fixture".into(),
        local_app_data: Some("C:\\Local".into()),
        app_data: Some("C:\\Roaming".into()),
        xdg_data: None,
    };
    assert_eq!(
        installed_path(InstallTool::Extension, "windows", &windows),
        "C:\\Local\\Polaris\\extension\\chrome"
    );
    assert_eq!(
        installed_path(InstallTool::Cli, "windows", &windows),
        "C:\\Local\\Programs\\polaris-cli\\polaris.mjs"
    );
    assert!(installed_path(InstallTool::Deck, "windows", &windows)
        .contains("C:\\Roaming\\Elgato\\StreamDeck\\Plugins"));
    let linux = Folders {
        home: "/home/fixture".into(),
        ..Folders::default()
    };
    assert_eq!(
        installed_path(InstallTool::Cli, "linux", &linux),
        "/home/fixture/.local/share/polaris-cli/polaris.mjs"
    );
    let mac = Folders {
        home: "/Users/fixture".into(),
        ..Folders::default()
    };
    assert_eq!(
        installed_path(InstallTool::Extension, "macos", &mac),
        "/Users/fixture/Library/Application Support/Polaris/extension/chrome"
    );
}

#[test]
fn knows_the_end_of_every_script_on_every_system() {
    let folders = [
        (InstallTool::Extension, "dashboard/apps/extension/scripts"),
        (InstallTool::Cli, "dashboard/packages/cli/scripts"),
        (InstallTool::Deck, "dashboard/apps/streamdeck/scripts"),
    ];
    assert_eq!(folders.len(), INSTALL_TOOLS.len());
    for (tool, folder) in folders {
        for file in ["install.ps1", "install.sh"] {
            let script = std::fs::read_to_string(repo_root().join(folder).join(file)).unwrap();
            assert!(script_finished(tool, &script), "{tool:?} {file}");
        }
    }
}

#[test]
fn tells_a_refusal_from_a_real_install() {
    assert!(!script_finished(
        InstallTool::Cli,
        "+  Polaris CLI\n!  polaris-cli: could not find a CLI release\n"
    ));
    assert!(!script_finished(
        InstallTool::Extension,
        "polaris: could not reach GitHub: timed out\n"
    ));
    assert!(!script_finished(InstallTool::Deck, ""));
    assert_eq!(
        last_said(
            "polaris: fetching\r\npolaris: the download does not match\r\npolaris: \r\n",
            "/h"
        )
        .as_deref(),
        Some("the download does not match")
    );
    assert_eq!(
        last_said(
            "+  Polaris CLI\n!  polaris-cli: node is not installed: https://nodejs.org\n",
            "/h"
        )
        .as_deref(),
        Some("node is not installed: https://nodejs.org")
    );
    let several = "+  Polaris CLI\n!  polaris-cli: this computer runs a Polaris server (a server checkout at /opt/polaris).\n!  polaris-cli: the server has its own polaris and plr commands,\n!  polaris-cli: so it is not installed here.\n";
    assert_eq!(
        last_said(several, "/h").as_deref(),
        Some("this computer runs a Polaris server (a server checkout at /opt/polaris). the server has its own polaris and plr commands, so it is not installed here.")
    );
    assert_eq!(
        last_said(
            "irm : Unable to connect\n    + FullyQualifiedErrorId : WebCmdlet\n",
            "/h"
        ),
        None
    );
    assert_eq!(last_said("curl: (6) Could not resolve host\n", "/h"), None);
    assert_eq!(last_said("\n\n", "/h"), None);
    assert_eq!(
        last_said("!  polaris-cli: this computer runs a Polaris server (C:\\Users\\fixture\\AppData\\polaris.ps1).\n", "C:\\Users\\fixture").as_deref(),
        Some("this computer runs a Polaris server (~\\AppData\\polaris.ps1).")
    );
}

#[test]
fn hands_a_failure_to_the_page_as_a_reason_and_its_sentence() {
    let ended = install_failure(
        InstallTool::Deck,
        "polaris: Next: open the Stream Deck app, find Polaris in the actions list\n",
        "/h",
    );
    assert_eq!(
        serde_json::to_value(ended).unwrap(),
        serde_json::json!({ "ok": false, "reason": "failed" })
    );
    let refused = install_failure(InstallTool::Cli, "!  polaris-cli: nope\n", "/h");
    assert_eq!(
        serde_json::to_value(refused).unwrap(),
        serde_json::json!({ "ok": false, "reason": "failed", "said": "nope" })
    );
    let done = InstallResult::done(Some(polaris_client::install_tools::InstallVia::StoreEntry));
    assert_eq!(
        serde_json::to_value(done).unwrap(),
        serde_json::json!({ "ok": true, "via": "store-entry" })
    );
}

#[test]
fn the_browser() {
    assert_eq!(
        browser_from_name("Google Chrome"),
        Some(ExtensionBrowser::Chrome)
    );
    assert_eq!(browser_from_name("Brave"), Some(ExtensionBrowser::Brave));
    assert_eq!(
        browser_from_name("Microsoft Edge"),
        Some(ExtensionBrowser::Edge)
    );
    assert_eq!(
        browser_from_name("Opera Internet Browser"),
        Some(ExtensionBrowser::Opera)
    );
    assert_eq!(browser_from_name("Firefox"), None);
    assert_eq!(
        extensions_page_launch(ExtensionBrowser::Brave, "macos"),
        Launch {
            file: "/usr/bin/open".into(),
            args: vec![
                "-a".into(),
                "Brave Browser".into(),
                "brave://extensions".into()
            ]
        }
    );
    assert_eq!(
        extensions_page_launch(ExtensionBrowser::Edge, "windows")
            .args
            .last()
            .unwrap(),
        "Start-Process 'msedge' 'edge://extensions'"
    );
    // Nothing is listed yet, so nothing is written for the store.
    assert!(windows_entry_keys(STORE_LISTINGS).is_empty());
    let listed = StoreListings {
        chrome_web_store: Some("abcdefghijklmnopabcdefghijklmnop"),
        edge_addons: None,
    };
    assert_eq!(
        windows_entry_keys(listed),
        ["HKCU\\Software\\Google\\Chrome\\Extensions\\abcdefghijklmnopabcdefghijklmnop"]
    );
}

// ---- games ----------------------------------------------------------------------

#[test]
fn the_known_games_are_the_electron_list() {
    // known-games.ts stays the one place the list is edited.
    let source =
        std::fs::read_to_string(repo_root().join("desktop/src/main/known-games.ts")).unwrap();
    let mut listed = Vec::new();
    for line in source
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with("{ name: \""))
    {
        let name = line.split('"').nth(1).unwrap().to_owned();
        let programs = line.split('[').nth(1).unwrap().split(']').next().unwrap();
        let programs: Vec<String> = programs
            .split(',')
            .map(|p| p.trim().trim_matches('"').to_owned())
            .collect();
        listed.push((name, programs));
    }
    let mine: Vec<(String, Vec<String>)> = KNOWN_GAMES
        .iter()
        .map(|game| {
            (
                game.name.to_owned(),
                game.programs.iter().map(|p| (*p).to_owned()).collect(),
            )
        })
        .collect();
    assert_eq!(mine, listed);
}

#[test]
fn never_treats_a_shared_program_as_a_game() {
    let shared = [
        "java",
        "java.exe",
        "javaw.exe",
        "python",
        "python.exe",
        "node",
        "node.exe",
        "electron",
    ];
    for game in KNOWN_GAMES {
        for program in game.programs {
            assert!(!shared.contains(program));
            assert_eq!(*program, program.to_lowercase());
            assert!(!program.contains(['\\', '/']));
        }
    }
}

#[test]
fn reads_program_names_down_to_one_key() {
    assert_eq!(
        program_key("C:\\Games\\Hollow_Knight.exe"),
        "hollow_knight.exe"
    );
    assert_eq!(
        program_key("/Applications/Factorio.app/Contents/MacOS/factorio\n"),
        "factorio"
    );
    let args = [
        "/usr/bin/wine64-preloader",
        "Z:\\games\\ELDEN RING\\Game\\eldenring.exe",
        "",
    ];
    assert_eq!(parse_cmdline(&args), ["wine64-preloader", "eldenring.exe"]);
    assert!(parse_cmdline::<&str>(&[]).is_empty());
}

#[test]
fn matches_a_game_and_lets_somebodys_own_name_win() {
    let found = match_game(&["explorer.exe", "EldenRing.exe"], &[], KNOWN_GAMES);
    assert_eq!(found, Some(("eldenring.exe".into(), "Elden Ring".into())));
    assert_eq!(
        match_game(&["explorer.exe", "code.exe"], &[], KNOWN_GAMES),
        None
    );
    let custom = [CustomGame {
        executable: "EldenRing.exe".into(),
        name: "The one with the dragons".into(),
    }];
    assert_eq!(
        match_game(&["eldenring.exe"], &custom, KNOWN_GAMES)
            .unwrap()
            .1,
        "The one with the dragons"
    );
}

fn names(said: &[Option<polaris_client::game_detect::RunningGame>]) -> Vec<Option<String>> {
    said.iter()
        .map(|game| game.as_ref().map(|game| game.name.clone()))
        .collect()
}

#[test]
fn says_a_game_once_as_a_heartbeat_and_once_when_it_stops() {
    let mut watch = GameWatcher::default();
    let list = |names: &[&str]| Ok::<_, ()>(names.iter().map(|n| (*n).to_owned()).collect());
    let said: Vec<_> = [
        watch.check(list(&["a.exe"]), 0),
        watch.check(list(&["celeste.exe"]), 15_000),
        watch.check(list(&["celeste.exe"]), 30_000),
        watch.check(list(&["celeste.exe"]), 15_000 + REPEAT_MS),
        watch.check(list(&["a.exe"]), 15_000 + REPEAT_MS + 15_000),
    ]
    .into_iter()
    .flatten()
    .collect();
    assert_eq!(
        names(&said),
        [None, Some("Celeste".into()), Some("Celeste".into()), None]
    );
    assert_eq!(
        said[1].as_ref().unwrap().started_at,
        "1970-01-01T00:00:15.000Z"
    );
    assert_eq!(iso_time(1_763_000_000_123), "2025-11-13T02:13:20.123Z");
}

#[test]
fn recognizes_a_game_added_while_running_and_changes_nothing_when_it_could_not_look() {
    let mut watch = GameWatcher::default();
    assert_eq!(
        watch.check(Ok::<_, ()>(vec!["mygame.exe".into()]), 0),
        Some(None)
    );
    watch.set_custom_games(vec![CustomGame {
        executable: "mygame.exe".into(),
        name: "My game".into(),
    }]);
    let said = watch
        .check(Ok::<_, ()>(vec!["mygame.exe".into()]), 10)
        .flatten();
    assert_eq!(said.map(|game| game.name), Some("My game".into()));
    assert_eq!(watch.check(Err::<Vec<String>, _>("no list"), 20), None);
    assert_eq!(
        watch.running().map(|game| game.name.as_str()),
        Some("My game")
    );
}
