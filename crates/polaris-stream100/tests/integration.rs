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
    // clients/device-plugins/hercules-stream100/manifest.json is what CI packages; it
    // must be exactly what the code declares (regenerate it from `manifest()`).
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../clients/device-plugins/hercules-stream100/manifest.json"
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

#[test]
fn a_mac_app_is_named_by_its_outermost_bundle() {
    let helper = "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/131.0/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper";
    assert_eq!(audio::bundle_program(helper), "Google Chrome");
    assert_eq!(
        audio::bundle_program("/Applications/Spotify.app/Contents/MacOS/Spotify"),
        "Spotify"
    );
    assert_eq!(
        audio::bundle_program("/usr/libexec/avconferenced"),
        "avconferenced"
    );
    let cases = [
        (
            "/Applications/Google Chrome.app/Contents/MacOS/x",
            Category::Browser,
        ),
        (
            "/Applications/zoom.us.app/Contents/MacOS/zoom.us",
            Category::Calls,
        ),
        (
            "/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams",
            Category::Calls,
        ),
        (
            "/Applications/Discord.app/Contents/MacOS/Discord",
            Category::Calls,
        ),
        (
            "/System/Applications/Music.app/Contents/MacOS/Music",
            Category::Music,
        ),
        (
            "/Applications/Polaris.app/Contents/MacOS/Polaris",
            Category::Calls,
        ),
        (
            "/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU",
            Category::Browser,
        ),
    ];
    for (path, category) in cases {
        let program = audio::bundle_program(path);
        assert_eq!(
            audio::classify(&session("a", &program), no_games),
            category,
            "{path}"
        );
    }
}

#[test]
fn a_tap_plays_the_app_back_at_the_knobs_gain() {
    assert_eq!(audio::tap_gain(100, false), 1.0);
    assert_eq!(audio::tap_gain(0, false), 0.0);
    assert_eq!(audio::tap_gain(80, true), 0.0);
    assert!((audio::tap_gain(50, false) - 0.125).abs() < 1e-6);
    // A stereo tap on a four-channel output: each pair repeats it; the frames
    // past the tap's are silence.
    let input = [1.0, 2.0, 3.0, 4.0];
    let mut output = [9.0f32; 12];
    audio::mix(&input, 2, &mut output, 4, 0.5);
    assert_eq!(
        output,
        [0.5, 1.0, 0.5, 1.0, 1.5, 2.0, 1.5, 2.0, 0.0, 0.0, 0.0, 0.0]
    );
    let mut silent = [9.0f32; 4];
    audio::mix(&input, 0, &mut silent, 2, 1.0);
    assert_eq!(silent, [0.0; 4]);
}

#[test]
fn macos_asks_once_for_recording_system_audio() {
    let value = manifest::manifest();
    for platform in ["darwin-x64", "darwin-arm64"] {
        let listed = &value["requires"][platform];
        assert_eq!(listed[0]["key"], "audioCapture", "{platform}");
        for field in ["label", "hint", "missing", "restored"] {
            for locale in ["en-US", "es-ES"] {
                let text = listed[0][field][locale].as_str().unwrap_or_default();
                assert!(
                    !text.is_empty() && text.chars().count() <= 120,
                    "{platform} {field} {locale}"
                );
            }
        }
    }
    for code in ["perAppNeedsMacos", "perAppNotAllowed"] {
        for locale in ["en-US", "es-ES"] {
            let text = value["statusTexts"][code][locale]
                .as_str()
                .unwrap_or_default();
            assert!(
                !text.is_empty() && text.chars().count() <= 120,
                "{code} {locale}"
            );
        }
    }
}

/// A backend that counts how often it is asked, and can refuse a change.
#[derive(Default)]
struct Counting {
    reads: usize,
    output_reads: usize,
    refuse: bool,
    sessions: Vec<Session>,
}

impl audio::AudioSessions for Counting {
    fn sessions(&mut self) -> Result<Vec<Session>, audio::AudioError> {
        self.reads += 1;
        Ok(self.sessions.clone())
    }
    fn set_volume(&mut self, _id: &str, _volume: u8) -> Result<(), audio::AudioError> {
        if self.refuse {
            return Err(audio::AudioError::Gone);
        }
        Ok(())
    }
    fn set_muted(&mut self, _id: &str, _muted: bool) -> Result<(), audio::AudioError> {
        Ok(())
    }
    fn output_volume(&mut self) -> Result<(u8, bool), audio::AudioError> {
        self.output_reads += 1;
        Ok((30, false))
    }
    fn set_output_volume(&mut self, _volume: u8) -> Result<(), audio::AudioError> {
        Ok(())
    }
    fn set_output_muted(&mut self, _muted: bool) -> Result<(), audio::AudioError> {
        Ok(())
    }
}

fn playing(id: &str, volume: u8) -> Session {
    Session {
        id: id.into(),
        program: "spotify.exe".into(),
        pid: 1,
        system: false,
        volume,
        muted: false,
    }
}

#[test]
fn every_report_reuses_one_read_of_the_sessions_and_its_own_changes_show() {
    use audio::AudioSessions;
    let mut mixer = audio::Cached::fresh_for(
        Counting {
            sessions: vec![playing("a", 40)],
            ..Default::default()
        },
        std::time::Duration::from_secs(3_600),
    );
    for _ in 0..50 {
        mixer.sessions().unwrap();
        mixer.output_volume().unwrap();
    }
    assert_eq!((mixer.inner().reads, mixer.inner().output_reads), (1, 1));
    // A change it made is what the next report starts from.
    mixer.set_volume("a", 46).unwrap();
    mixer.set_muted("a", true).unwrap();
    mixer.set_output_volume(35).unwrap();
    assert_eq!(mixer.sessions().unwrap()[0].volume, 46);
    assert!(mixer.sessions().unwrap()[0].muted);
    assert_eq!(mixer.output_volume().unwrap(), (35, false));
    assert_eq!(mixer.inner().reads, 1);
}

#[test]
fn a_refused_change_or_an_old_read_asks_the_backend_again() {
    use audio::AudioSessions;
    let mut mixer = audio::Cached::fresh_for(
        Counting {
            sessions: vec![playing("a", 40)],
            refuse: true,
            ..Default::default()
        },
        std::time::Duration::from_secs(3_600),
    );
    mixer.sessions().unwrap();
    // The app closed: the kept sessions are dropped, the next read is fresh.
    assert!(mixer.set_volume("a", 46).is_err());
    assert_eq!(mixer.sessions().unwrap()[0].volume, 40);
    assert_eq!(mixer.inner().reads, 2);
    mixer.invalidate();
    mixer.sessions().unwrap();
    assert_eq!(mixer.inner().reads, 3);

    let mut always = audio::Cached::fresh_for(Counting::default(), std::time::Duration::ZERO);
    always.sessions().unwrap();
    always.sessions().unwrap();
    assert_eq!(always.inner().reads, 2);
}
