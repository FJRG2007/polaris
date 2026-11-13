//! Ported from `desktop/test/shared/voice-widget.test.ts`,
//! `desktop/test/shared/annotate.test.ts` and
//! `desktop/test/main/screen-share.test.ts`, with the placement and overlay
//! rules of `desktop/src/main/voice-widget.ts` and `annotate-overlay.ts`.

use polaris_client::annotate::{
    read_stroke, shared_display, Delivery, Display, Overlay, QUEUE_MAX,
};
use polaris_client::screen_share::{
    dashboard_picker, is_source_id, read_choice, share_list, sound_supported, wants_thumbnails,
    Pick, RawSource, SourceKind, MAX_NAME, MAX_WINDOWS, PICK_MS,
};
use polaris_client::settings::Point;
use polaris_client::voice_widget::{
    face_color, initials, lock_keys, read_voice_action, read_voice_state, start_point,
    widget_height, widget_size, widget_visible, VoiceAction, WidgetView, WorkArea, MARGIN,
    MAX_PEOPLE, MAX_ROWS, WIDGET_WIDTH,
};
use serde_json::{json, Value};

#[test]
fn the_widget_is_on_screen_only_in_a_call_switched_on_and_with_a_game_when_asked() {
    // inCall, enabled, onlyWithGame, gameRunning -> visible
    let cases = [
        (true, true, false, false, true),
        (true, true, false, true, true),
        (true, true, true, true, true),
        (true, true, true, false, false),
        (true, false, false, true, false),
        (true, false, true, true, false),
        (false, true, false, true, false),
        (false, true, true, true, false),
    ];
    for (in_call, enabled, only, game, visible) in cases {
        assert_eq!(
            widget_visible(in_call, enabled, only, game),
            visible,
            "{in_call} {enabled} {only} {game}"
        );
    }
}

fn person(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "speaking": false, "muted": true, "deafened": false })
}

#[test]
fn takes_the_calls_people_and_the_readers_own_mute_and_deafen() {
    let state = json!({ "participants": [person("a", "  Ada  ")], "selfMuted": true, "selfDeafened": false });
    let read = read_voice_state(&state).unwrap().unwrap();
    assert_eq!(read.participants[0].name, "Ada");
    assert!(read.self_muted);
    assert_eq!(read_voice_state(&Value::Null), Ok(None));
}

#[test]
fn refuses_a_person_without_an_id_and_any_other_shape() {
    let with = |people: Vec<Value>| json!({ "participants": people, "selfMuted": false, "selfDeafened": false });
    assert!(read_voice_state(&with(vec![person("", "x")])).is_err());
    assert!(read_voice_state(&with(vec![person(&"i".repeat(129), "x")])).is_err());
    assert!(read_voice_state(&with(vec![person("a", &"n".repeat(121))])).is_err());
    assert!(read_voice_state(&with(vec![person(
        "a",
        &format!("  {}  ", "n".repeat(120))
    )]))
    .is_ok());
    assert!(read_voice_state(&with(
        (0..=MAX_PEOPLE)
            .map(|i| person(&i.to_string(), "x"))
            .collect()
    ))
    .is_err());
    assert!(read_voice_state(&with(
        (0..MAX_PEOPLE)
            .map(|i| person(&i.to_string(), "x"))
            .collect()
    ))
    .is_ok());
    assert!(read_voice_state(
        &json!({ "participants": [], "selfMuted": false, "selfDeafened": false, "extra": 1 })
    )
    .is_err());
    assert!(read_voice_state(&json!("call")).is_err());
}

#[test]
fn takes_only_the_three_widget_presses() {
    assert_eq!(read_voice_action(&json!("leave")), Some(VoiceAction::Leave));
    assert_eq!(read_voice_action(&json!("mic")), Some(VoiceAction::Mic));
    assert_eq!(read_voice_action(&json!("camera")), None);
    assert_eq!(
        serde_json::to_value(VoiceAction::Deafen).unwrap(),
        json!("deafen")
    );
}

#[test]
fn the_view_is_spelled_as_the_widget_page_reads_it() {
    let state = read_voice_state(&json!({ "participants": [person("p1", "Ada Lovelace")], "selfMuted": false, "selfDeafened": true }))
        .unwrap()
        .unwrap();
    let view = WidgetView::new(&state, true, Some("Shift+`".into()));
    assert_eq!(
        serde_json::to_value(view).unwrap(),
        json!({
            "state": {
                "participants": [{
                    "id": "p1", "name": "Ada Lovelace", "speaking": false, "muted": true, "deafened": false,
                    "initials": "AL", "color": "hsl(262 55% 45%)"
                }],
                "selfMuted": false,
                "selfDeafened": true
            },
            "unlocked": true,
            "lockKey": "Shift+`"
        })
    );
}

#[test]
fn grows_with_the_people_up_to_its_row_limit_then_counts_the_rest() {
    assert!(widget_height(2, false) < widget_height(3, false));
    assert_eq!(
        widget_height(MAX_ROWS + 5, false),
        widget_height(MAX_ROWS + 50, false)
    );
    assert!(widget_height(MAX_ROWS + 1, false) > widget_height(MAX_ROWS, false));
    assert_eq!(widget_height(0, false), widget_height(1, false));
}

#[test]
fn makes_room_for_the_buttons_when_unlocked() {
    assert!(widget_height(2, true) > widget_height(2, false));
}

#[test]
fn grows_with_the_accounts_text_size() {
    assert_eq!(
        widget_size(1, false, 16),
        (WIDGET_WIDTH, widget_height(1, false))
    );
    assert_eq!(widget_size(1, false, 24), (360, 75));
    // A size the dashboard does not offer draws at the default.
    assert_eq!(widget_size(1, false, 17), widget_size(1, false, 16));
}

#[test]
fn a_face_with_no_picture() {
    for (name, shown) in [
        ("Ada Lovelace", "AL"),
        ("ada", "AD"),
        ("Jean Luc Picard", "JP"),
        ("", "?"),
        ("   ", "?"),
    ] {
        assert_eq!(initials(name), shown, "{name:?}");
    }
    assert_eq!(face_color("p1"), face_color("p1"));
    // ("p".charCodeAt(0) * 31 + "1".charCodeAt(0)) % 8 = 3521 % 8 = 1
    assert_eq!(face_color("p1"), "hsl(262 55% 45%)");
    assert_eq!(face_color(""), "hsl(210 55% 45%)");
}

#[test]
fn takes_shift_backquote_only_while_a_game_runs() {
    let accelerators = |os, game| {
        lock_keys(os, game)
            .into_iter()
            .map(|(key, _)| key)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        accelerators("windows", true),
        ["Shift+`", "CommandOrControl+Shift+`"]
    );
    assert_eq!(accelerators("windows", false), ["CommandOrControl+Shift+`"]);
    assert_eq!(lock_keys("macos", false)[0].1, "Cmd+Shift+`");
    assert_eq!(lock_keys("linux", false)[0].1, "Ctrl+Shift+`");
}

#[test]
fn the_widget_opens_where_it_was_left_while_that_is_on_a_screen() {
    let primary = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    let second = WorkArea {
        x: 1920,
        y: 0,
        width: 1280,
        height: 1024,
    };
    let corner = Point {
        x: MARGIN,
        y: MARGIN,
    };
    assert_eq!(start_point(None, 100, &[primary, second], primary), corner);
    let kept = Point { x: 2000, y: 300 };
    assert_eq!(
        start_point(Some(kept), 100, &[primary, second], primary),
        kept
    );
    // That display is gone: back to the corner of the main one.
    assert_eq!(start_point(Some(kept), 100, &[primary], primary), corner);
    // Just off the left edge still counts while its margin is on screen.
    let edge = Point { x: -MARGIN, y: 0 };
    assert_eq!(start_point(Some(edge), 100, &[primary], primary), edge);
    assert_eq!(
        start_point(
            Some(Point {
                x: -MARGIN - 1,
                y: 0
            }),
            100,
            &[primary],
            primary
        ),
        corner
    );
    let shifted = WorkArea {
        x: -1280,
        y: 40,
        ..second
    };
    assert_eq!(
        start_point(None, 100, &[shifted], shifted),
        Point {
            x: -1280 + MARGIN,
            y: 40 + MARGIN
        }
    );
}

fn stroke() -> Value {
    json!({ "key": "seat-1/abc", "color": "#ef4444", "points": [[0.5, 0.5]], "end": false })
}

fn with(field: &str, value: Value) -> Value {
    let mut stroke = stroke();
    stroke[field] = value;
    stroke
}

#[test]
fn takes_a_stroke_the_dashboard_believed_and_nothing_shaped_otherwise() {
    assert!(read_stroke(&stroke()).is_some());
    assert!(read_stroke(&with("color", json!("#EF4444"))).is_some());
    assert!(read_stroke(&with("points", json!([[1, 0]]))).is_some());
    assert!(read_stroke(&with("points", json!([]))).is_some());
    assert!(read_stroke(&with("color", json!("red; background:url(x)"))).is_none());
    assert!(read_stroke(&with("color", json!("#ef444"))).is_none());
    assert!(read_stroke(&with("points", json!([[1.5, 0]]))).is_none());
    assert!(read_stroke(&with("points", json!([[-0.1, 0]]))).is_none());
    assert!(read_stroke(&with("points", json!([[0.1]]))).is_none());
    assert!(read_stroke(&with("points", json!(vec![[0, 0]; 65]))).is_none());
    assert!(read_stroke(&with("extra", json!(1))).is_none());
    assert!(read_stroke(&with("key", json!(""))).is_none());
    assert!(read_stroke(&with("key", json!("a b"))).is_none());
    assert!(read_stroke(&with("key", json!("a\u{7}"))).is_none());
    assert!(read_stroke(&with("key", json!("k".repeat(161)))).is_none());
    assert!(read_stroke(&with("key", json!("\u{e9}".repeat(160)))).is_some());
}

struct Screen(&'static str);

impl Display for Screen {
    fn id(&self) -> String {
        self.0.to_owned()
    }
}

#[test]
fn draws_only_on_a_shared_screen_it_can_find() {
    let two = [Screen("1"), Screen("2")];
    assert_eq!(
        shared_display(Some(("screen:1:0", "2")), &two).map(Display::id),
        Some("2".into())
    );
    assert!(shared_display(Some(("window:9:0", "2")), &two).is_none());
    assert!(shared_display(None, &two).is_none());
    // An empty display id is only a question with more than one display.
    assert!(shared_display(Some(("screen:0:0", "")), &two).is_none());
    assert_eq!(
        shared_display(Some(("screen:0:0", "")), &[Screen("7")]).map(Display::id),
        Some("7".into())
    );
}

#[test]
fn holds_strokes_while_the_page_loads_then_hands_them_over_in_order() {
    let mut overlay = Overlay::open_on("1".into());
    let first = read_stroke(&stroke()).unwrap();
    for _ in 0..QUEUE_MAX {
        assert_eq!(overlay.deliver(first.clone()), Delivery::Queued);
    }
    assert_eq!(overlay.deliver(first.clone()), Delivery::Dropped);
    assert_eq!(overlay.loaded().len(), QUEUE_MAX);
    assert_eq!(overlay.deliver(first.clone()), Delivery::Send(first));
    assert!(overlay.moves_to("2"));
    assert!(!overlay.moves_to("1"));
    assert!(!Overlay::default().moves_to("1"));
}

#[test]
fn takes_only_the_source_ids_the_list_hands_out() {
    for id in ["screen:0:0", "window:1234:0", "window:a_b-c:12"] {
        assert!(is_source_id(id), "{id}");
    }
    for id in [
        "tab:1:0",
        "screen:0",
        "screen::0",
        "screen:0:x",
        "window:a b:0",
        "screen:0:0 ",
        "",
    ] {
        assert!(!is_source_id(id), "{id}");
    }
    assert!(!is_source_id(&format!("window:{}:0", "a".repeat(200))));
    assert_eq!(
        read_choice(&json!({ "id": "screen:0:0", "sound": true })).map(|c| c.sound),
        Some(true)
    );
    assert!(read_choice(&json!({ "id": "screen:0:0" })).is_none());
    assert!(read_choice(&json!({ "id": "screen:0:0", "sound": true, "more": 1 })).is_none());
}

#[test]
fn a_pick_waits_for_its_share_and_carries_sound_only_where_it_can() {
    let choice = read_choice(&json!({ "id": "screen:0:0", "sound": true })).unwrap();
    let pick = Pick::new(choice.clone(), sound_supported("windows"), 1_000);
    assert!(pick.sound);
    assert!(pick.live(1_000 + PICK_MS - 1));
    assert!(!pick.live(1_000 + PICK_MS));
    assert!(!Pick::new(choice, sound_supported("linux"), 0).sound);
}

#[test]
fn asks_for_pictures_unless_told_otherwise() {
    assert!(wants_thumbnails(None));
    assert!(!wants_thumbnails(Some(&json!({ "thumbnails": false }))));
    assert!(wants_thumbnails(Some(&json!({}))));
    assert!(wants_thumbnails(Some(&json!({ "thumbnails": "no" }))));
}

fn raw(id: &str, name: &str) -> RawSource {
    RawSource {
        id: id.into(),
        name: name.into(),
        thumbnail: None,
        icon: None,
    }
}

#[test]
fn lists_screens_first_then_windows_up_to_the_limit() {
    let listed = share_list(
        vec![raw("window:1:0", " Editor "), raw("screen:0:0", "Screen 1")],
        true,
    );
    let shape: Vec<_> = listed
        .sources
        .iter()
        .map(|s| (s.id.as_str(), s.kind, s.name.as_str(), s.thumbnail.clone()))
        .collect();
    assert_eq!(
        shape,
        [
            ("screen:0:0", SourceKind::Screen, "Screen 1", None),
            ("window:1:0", SourceKind::Window, "Editor", None)
        ]
    );
    assert_eq!(
        serde_json::to_value(&listed).unwrap()["sources"][0],
        json!({ "id": "screen:0:0", "name": "Screen 1", "kind": "screen", "thumbnail": null, "icon": null })
    );
    assert_eq!(serde_json::to_value(&listed).unwrap()["sound"], json!(true));
    let many =
        (0..MAX_WINDOWS + 5).map(|i| raw(&format!("window:{i}:0"), &"w".repeat(MAX_NAME + 9)));
    let listed = share_list(many.chain([raw("screen:1:0", "")]).collect(), false);
    assert_eq!(listed.sources.len(), MAX_WINDOWS + 1);
    assert_eq!(listed.sources[0].kind, SourceKind::Screen);
    assert_eq!(listed.sources[1].name.chars().count(), MAX_NAME);
}

#[test]
fn the_dashboards_own_picker_says_why_it_cannot_be_fed_on_each_system() {
    for os in ["windows", "macos", "linux"] {
        assert!(dashboard_picker(os).is_err(), "{os}");
    }
    assert!(dashboard_picker("windows")
        .unwrap_err()
        .contains("ScreenCaptureStarting"));
}
