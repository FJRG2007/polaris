//! The server list and the settings file, and the one-time import of the Electron
//! app's file. Ported from desktop/test/shared/servers.test.ts and
//! desktop/test/main/settings.test.ts.

use polaris_client::servers::{
    describe_server, list_servers, normalize_server_name, read_servers, rename_server,
    replace_server, same_instance_words, with_server, without_server, SavedServer, ServerRow,
    SERVERS_MAX,
};
use polaris_client::settings::{import_electron_settings, Imported, PushChoice, Settings};
use serde_json::json;
use std::path::PathBuf;

const HOME: &str = "https://polaris.example.com";
const WORK: &str = "http://192.168.1.20:3000";

fn saved(origin: &str, name: Option<&str>) -> SavedServer {
    SavedServer {
        origin: origin.into(),
        name: name.map(str::to_owned),
    }
}

#[test]
fn reads_what_was_stored_and_leaves_out_what_is_not_an_address() {
    let raw = json!([
        { "origin": HOME, "name": "  Home   lab " },
        { "origin": "https://polaris.example.com/" },
        { "origin": "not an address" },
        { "origin": WORK, "name": 7 },
        "junk"
    ]);
    assert_eq!(
        read_servers(&raw),
        [saved(HOME, Some("Home lab")), saved(WORK, None)]
    );
    assert!(read_servers(&json!(null)).is_empty());
    let many: Vec<_> = (0..30)
        .map(|i| json!({ "origin": format!("https://p{i}.example.com") }))
        .collect();
    assert_eq!(read_servers(&json!(many)).len(), SERVERS_MAX);
    let long = "n".repeat(60);
    assert_eq!(
        read_servers(&json!([{ "origin": HOME, "name": long }]))[0]
            .name
            .as_deref(),
        Some(&*"n".repeat(40))
    );
}

#[test]
fn adds_at_the_front_renames_removes_and_marks_the_one_in_use() {
    let two = with_server(&with_server(&[], HOME), WORK);
    assert_eq!(
        two.iter().map(|s| s.origin.as_str()).collect::<Vec<_>>(),
        [WORK, HOME]
    );
    assert_eq!(with_server(&two, HOME), two);
    let named = rename_server(&two, WORK, normalize_server_name("Office"));
    let rows = list_servers(&named, Some(HOME));
    let seen: Vec<_> = rows
        .iter()
        .map(|row| (describe_server(row).to_owned(), row.active))
        .collect();
    assert_eq!(
        seen,
        [
            ("Office".to_owned(), false),
            ("polaris.example.com".to_owned(), true)
        ]
    );
    assert_eq!(rows[0].host, "192.168.1.20:3000");
    assert_eq!(without_server(&named, WORK), [saved(HOME, None)]);
    assert_eq!(normalize_server_name("   "), None);
}

#[test]
fn names_the_server_already_listed() {
    let row = |name: Option<&str>| ServerRow {
        origin: HOME.into(),
        name: name.map(str::to_owned),
        host: "polaris.example.com".into(),
        active: false,
    };
    assert_eq!(
        same_instance_words(&row(None)),
        "This is the same Polaris as polaris.example.com, already on your list."
    );
    assert_eq!(
        same_instance_words(&row(Some("Home"))),
        "This is the same Polaris as Home, already on your list."
    );
}

#[test]
fn replace_moves_a_server_where_it_stood_and_never_lists_it_twice() {
    let list = [
        saved("https://a.example.com", Some("A")),
        saved("https://b.example.com", None),
        saved("https://c.example.com", Some("C")),
    ];
    assert_eq!(
        replace_server(
            &list,
            "https://b.example.com",
            "https://d.example.com",
            Some("D".into())
        ),
        [
            saved("https://a.example.com", Some("A")),
            saved("https://d.example.com", Some("D")),
            saved("https://c.example.com", Some("C"))
        ]
    );
    let moved = replace_server(
        &list,
        "https://b.example.com",
        "https://c.example.com",
        None,
    );
    assert_eq!(
        moved.iter().map(|s| s.origin.as_str()).collect::<Vec<_>>(),
        ["https://a.example.com", "https://c.example.com"]
    );
    assert_eq!(
        replace_server(
            &list,
            "https://a.example.com",
            "https://a.example.com",
            Some("Home".into())
        )[0],
        saved("https://a.example.com", Some("Home"))
    );
}

fn folder(name: &str) -> PathBuf {
    let path =
        std::env::temp_dir().join(format!("polaris-client-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn every_field_falls_back_on_its_own() {
    let defaults = Settings::read(&json!({ "server": HOME }));
    assert_eq!(defaults.server.as_deref(), Some(HOME));
    assert!(
        defaults.hardware_acceleration
            && defaults.minimize_to_tray
            && defaults.open_at_login
            && defaults.voice_widget
    );
    assert!(!defaults.start_minimized && !defaults.voice_widget_game_only);
    assert_eq!(defaults.update_attempted, None);
    assert_eq!(defaults.text_size(), 16);
    let odd = Settings::read(&json!({
        "server": "not an address",
        "hardwareAcceleration": false,
        "updateAttempted": 7,
        "textSize": "18px",
        "windowPlace": { "x": 1, "y": 2, "width": 0, "height": 10, "maximized": false },
        "voiceWidgetPlace": { "x": 3, "y": 4 }
    }));
    assert_eq!(odd.server, None);
    assert!(!odd.hardware_acceleration);
    assert_eq!(odd.update_attempted, None);
    assert_eq!(odd.text_size, Some(18));
    assert_eq!(odd.window_place, None);
    assert_eq!(odd.voice_widget_place.map(|p| (p.x, p.y)), Some((3, 4)));
    assert_eq!(Settings::read(&json!({ "textSize": 17 })).text_size, None);
    assert_eq!(Settings::read(&json!("junk")), Settings::default());
}

#[test]
fn pushes_keep_a_folder_per_service_and_a_bad_record_reads_as_none() {
    let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    let read = Settings::read(
        &json!({ "pushes": { id: { "folder": "C:/code/app", "platform": "linux/s390x" } } }),
    );
    assert_eq!(
        read.push_choice(id),
        Some(&PushChoice {
            folder: "C:/code/app".into(),
            platform: String::new()
        })
    );
    let bad = Settings::read(
        &json!({ "pushes": { id: { "folder": "a" }, "not-a-uuid": { "folder": "b" } } }),
    );
    assert!(bad.pushes.is_empty());
}

#[test]
fn the_server_in_use_stays_on_the_list_and_the_file_round_trips() {
    let dir = folder("settings");
    let file = dir.join("settings.json");
    assert_eq!(Settings::load(&file), Settings::default());
    let mut settings = Settings::load(&file);
    settings.set_server_address(Some(HOME.into()));
    settings.set_server_address(Some(WORK.into()));
    settings.set_saved_servers(vec![]);
    assert_eq!(settings.known_servers(), [saved(WORK, None)]);
    assert!(settings.remember_text_size(20));
    assert!(!settings.remember_text_size(20));
    assert!(settings.remember_toggle("startMinimized", true));
    assert!(!settings.remember_toggle("nope", true));
    settings.save(&file).unwrap();
    assert_eq!(Settings::load(&file), settings);
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("{\n    \"server\": "), "{text}");
    std::fs::write(&file, "not json").unwrap();
    assert_eq!(Settings::load(&file), Settings::default());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_electron_file_is_read_once_and_never_written() {
    let dir = folder("import");
    let electron = dir.join("Polaris");
    let beta = dir.join("beta");
    std::fs::create_dir_all(&electron).unwrap();
    assert_eq!(
        import_electron_settings(&electron, &beta).unwrap(),
        Imported::NothingThere
    );
    let original = format!(
        "{{\"server\":\"{HOME}\",\"servers\":[{{\"origin\":\"{WORK}\",\"name\":\"Office\"}}],\"futureField\":1}}"
    );
    std::fs::write(electron.join("settings.json"), &original).unwrap();
    assert_eq!(
        import_electron_settings(&electron, &beta).unwrap(),
        Imported::Copied
    );
    let imported = Settings::load(&beta.join("settings.json"));
    assert_eq!(imported.server.as_deref(), Some(HOME));
    assert_eq!(
        imported.known_servers(),
        [saved(HOME, None), saved(WORK, Some("Office"))]
    );
    assert_eq!(
        std::fs::read_to_string(electron.join("settings.json")).unwrap(),
        original
    );
    std::fs::write(electron.join("settings.json"), "{}").unwrap();
    assert_eq!(
        import_electron_settings(&electron, &beta).unwrap(),
        Imported::AlreadyHad
    );
    assert_eq!(
        Settings::load(&beta.join("settings.json"))
            .server
            .as_deref(),
        Some(HOME)
    );
    let _ = std::fs::remove_dir_all(dir);
}
