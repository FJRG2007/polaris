//! Audio categories, who owns the device, and the module manifest.

use polaris_stream100::audio::{self, Category, Session, Target};
use polaris_stream100::manifest;
use polaris_stream100::ownership::{decide, Observed, Ownership};

fn session(id: &str, program: &str) -> Session {
    Session {
        id: id.into(),
        program: program.into(),
        pid: 1,
        system: false,
        volume: 50,
        muted: false,
    }
}

fn no_games(_: &str) -> bool {
    false
}

#[test]
fn programs_land_in_their_category() {
    let cases = [
        ("C:\\Program Files\\Spotify\\Spotify.exe", Category::Music),
        ("/usr/bin/discord", Category::Calls),
        ("ms-teams.exe", Category::Calls),
        ("Polaris.exe", Category::Calls),
        ("msedge.exe", Category::Browser),
        ("notepad.exe", Category::Other),
    ];
    for (program, category) in cases {
        assert_eq!(
            audio::classify(&session("a", program), no_games),
            category,
            "{program}"
        );
    }
    let system = Session {
        system: true,
        ..session("s", "svchost.exe")
    };
    assert_eq!(audio::classify(&system, no_games), Category::System);
}

#[test]
fn games_come_from_the_desktop_detection() {
    let is_game = |key: &str| key == "eldenring";
    assert_eq!(
        audio::classify(&session("g", "eldenring.exe"), is_game),
        Category::Games
    );
}

#[test]
fn a_polaris_call_takes_the_calls_knob_alone() {
    let sessions = [
        session("1", "Discord.exe"),
        session("2", "Polaris.exe"),
        session("3", "Spotify.exe"),
    ];
    let calls = Target::Category {
        category: Category::Calls,
    };
    assert_eq!(audio::resolve(&calls, &sessions, no_games), Some(vec!["2"]));
    assert_eq!(
        audio::resolve(&calls, &sessions[..1], no_games),
        Some(vec!["1"])
    );
}

#[test]
fn a_pinned_program_and_the_output() {
    let sessions = [session("1", "Spotify.exe"), session("2", "spotify")];
    let pinned = Target::Program {
        program: "SPOTIFY.EXE".into(),
    };
    assert_eq!(
        audio::resolve(&pinned, &sessions, no_games),
        Some(vec!["1", "2"])
    );
    assert_eq!(audio::resolve(&Target::Output, &sessions, no_games), None);
    assert_eq!(
        audio::resolve(&Target::None, &sessions, no_games),
        Some(vec![])
    );
    let music = Target::Category {
        category: Category::Music,
    };
    assert_eq!(audio::resolve(&music, &[], no_games), Some(vec![]));
}

#[test]
fn several_sessions_show_the_loudest() {
    let sessions = [
        Session {
            volume: 20,
            ..session("1", "a")
        },
        Session {
            volume: 70,
            ..session("2", "b")
        },
    ];
    assert_eq!(audio::shown_volume(&sessions, &["1", "2"]), Some(70));
    assert_eq!(audio::shown_volume(&sessions, &[]), None);
}

#[test]
fn targets_round_trip_as_stored_settings() {
    let stored = serde_json::to_string(&audio::default_targets()).unwrap();
    assert_eq!(
        stored,
        r#"[{"kind":"category","category":"calls"},{"kind":"category","category":"music"},{"kind":"category","category":"games"},{"kind":"output"}]"#
    );
    let back: [Target; 4] = serde_json::from_str(&stored).unwrap();
    assert_eq!(back, audio::default_targets());
}

fn windows(service: Option<&str>, stream_control: bool) -> Observed {
    Observed {
        os: "windows".into(),
        service: service.map(Into::into),
        stream_control_running: stream_control,
        present: true,
    }
}

#[test]
fn who_holds_the_device() {
    assert_eq!(decide(&Observed::default()), Ownership::Absent);
    assert_eq!(
        decide(&windows(Some("HercStreamMixDevice"), true)),
        Ownership::HerculesBusy
    );
    assert_eq!(
        decide(&windows(Some("hercstreammixdevice"), false)),
        Ownership::HerculesSdk
    );
    assert_eq!(decide(&windows(Some("usbccgp"), false)), Ownership::Direct);
    assert_eq!(decide(&windows(Some("WinUSB"), false)), Ownership::Direct);
    assert_eq!(
        decide(&windows(Some("libusbK"), false)),
        Ownership::Unknown {
            service: "libusbK".into()
        }
    );
    let linux = Observed {
        os: "linux".into(),
        present: true,
        ..Observed::default()
    };
    assert_eq!(decide(&linux), Ownership::Direct);
}

#[test]
fn the_manifest_claims_only_the_stream_100() {
    let manifest = manifest::manifest();
    assert_eq!(manifest["id"], "hercules-stream100");
    assert!(manifest::claims(0x06f8, 0xe053));
    assert!(!manifest::claims(0x06f8, 0xe054));
    assert_eq!(manifest["claims"][0]["vendorId"], 0x06f8);
    assert_eq!(manifest["claims"][0]["productId"], 0xe053);
    assert_eq!(
        manifest["permissions"],
        serde_json::json!(["usb", "audio-sessions", "polaris-actions"])
    );
}

#[test]
fn the_published_manifest_is_the_crates_own() {
    // device-addons/hercules-stream100/manifest.json is what CI packages; it
    // must be exactly what the code declares (regenerate it from `manifest()`).
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../device-addons/hercules-stream100/manifest.json"
    );
    let published: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(published, manifest::manifest());
}

#[test]
fn settings_default_and_survive_a_damaged_file() {
    use polaris_stream100::settings::{schema, DisplayMode, Settings};
    let defaults = Settings::default();
    assert_eq!(Settings::from_json("not json"), defaults);
    let partial =
        Settings::from_json(r#"{"brightness":0,"tuning":{"deadBand":200},"display":"call"}"#);
    assert_eq!(partial.brightness, 10);
    assert_eq!(partial.tuning.dead_band, 24);
    assert_eq!(partial.display, DisplayMode::Call);
    assert_eq!(partial.knobs, defaults.knobs);
    // One value past its type's range resets that value alone.
    let damaged = Settings::from_json(
        r#"{"brightness":500,"display":"call","buttons":["call.share",7],"knobs":[{"kind":"output"},{"kind":"bogus"}],"tuning":{"deadBand":-1,"maxStep":4}}"#,
    );
    assert_eq!(damaged.brightness, defaults.brightness);
    assert_eq!(damaged.display, DisplayMode::Call);
    assert_eq!(damaged.buttons[0], "call.share");
    assert_eq!(damaged.buttons[1], defaults.buttons[1]);
    assert_eq!(damaged.knobs[0], Target::Output);
    assert_eq!(damaged.knobs[1], defaults.knobs[1]);
    assert_eq!(damaged.tuning.dead_band, defaults.tuning.dead_band);
    assert_eq!(damaged.tuning.max_step, 4);
    let page = serde_json::to_value(schema()).unwrap();
    assert_eq!(
        page[0],
        serde_json::json!({"kind": "switch", "key": "enabled", "default": true})
    );
    assert!(page
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field["key"] == "brightness"));
}
