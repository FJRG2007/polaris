//! Ported from `desktop/test/main/notice-once.test.ts`, `notice-layout.test.ts`
//! and the pure half of `app-badge.test.ts`.

use polaris_client::app_badge::{badge_plan, AppBadge, BadgePlan};
use polaris_client::notice::{
    icon_acceptable, notice_layout, NoticeLayout, NoticeWords, OnceNotices, Platform, ICON_ACCEPT,
    ICON_MAX_BYTES, ONCE_MS,
};
use serde_json::json;

const WORDS: &str = "Deployed shop / api\nshop / api is serving the new release.";
const START: u64 = 1_000_000;

#[test]
fn drops_the_other_announcers_notice_for_the_same_deploy_in_either_order() {
    let mut push_first = OnceNotices::new();
    assert!(!push_first.repeated("deploy:d1", WORDS, START));
    assert!(push_first.repeated("notification:n1", WORDS, START));

    let mut feed_first = OnceNotices::new();
    assert!(!feed_first.repeated("notification:n1", WORDS, START));
    assert!(feed_first.repeated("deploy:d1", WORDS, START));
}

#[test]
fn shows_a_second_push_of_the_same_service_and_pairs_each_with_its_own_alert() {
    let mut said = OnceNotices::new();
    assert!(!said.repeated("deploy:d1", WORDS, START));
    let later = START + 30_000;
    assert!(!said.repeated("deploy:d2", WORDS, later));
    assert!(said.repeated("notification:n2", WORDS, later));
    assert!(!said.repeated("notification:n3", WORDS, later));
}

#[test]
fn forgets_the_words_once_the_window_has_passed() {
    let mut said = OnceNotices::new();
    assert!(!said.repeated("deploy:d1", WORDS, START));
    assert!(!said.repeated("notification:n1", WORDS, START + ONCE_MS + 1));
}

#[test]
fn never_pairs_different_words() {
    let mut said = OnceNotices::new();
    assert!(!said.repeated("deploy:d1", WORDS, START));
    assert!(!said.repeated(
        "notification:n1",
        "Deploy failed: shop / api\nexit 1",
        START
    ));
}

fn words(title: &str, subtitle: Option<&str>, body: Option<&str>) -> NoticeWords {
    NoticeWords {
        title: title.into(),
        subtitle: subtitle.map(Into::into),
        body: body.map(Into::into),
    }
}

fn layout(title: &str, subtitle: Option<&str>, body: &str) -> NoticeLayout {
    NoticeLayout {
        title: title.into(),
        subtitle: subtitle.map(Into::into),
        body: body.into(),
    }
}

#[test]
fn keeps_the_conversation_as_the_subtitle_on_macos() {
    assert_eq!(
        notice_layout(&words("Ada", Some("#general"), Some("hi")), Platform::Mac),
        layout("Ada", Some("#general"), "hi")
    );
}

#[test]
fn joins_the_conversation_to_the_title_where_there_is_no_subtitle_line() {
    for platform in [Platform::Windows, Platform::Linux] {
        assert_eq!(
            notice_layout(&words("Ada", Some("Mail"), Some("Invoice")), platform),
            layout("Ada - Mail", None, "Invoice")
        );
    }
}

#[test]
fn draws_a_notice_without_a_subtitle_exactly_as_before() {
    assert_eq!(
        notice_layout(
            &words("Deployed shop", None, Some("Serving")),
            Platform::Windows
        ),
        layout("Deployed shop", None, "Serving")
    );
    assert_eq!(
        notice_layout(&words("Ada", Some("  "), None), Platform::Mac),
        layout("Ada", None, "")
    );
    assert_eq!(
        notice_layout(&words("Ada", Some("Ada"), None), Platform::Windows),
        layout("Ada", None, "")
    );
}

#[test]
fn clips_a_title_long_enough_to_push_the_body_off_the_notice() {
    let long = notice_layout(
        &words(&"x".repeat(100), Some(&"y".repeat(100)), None),
        Platform::Windows,
    );
    assert_eq!(long.title.chars().count(), 120);
    assert!(long.title.ends_with("..."));
}

#[test]
fn takes_a_png_or_jpeg_of_avatar_size_up_to_the_largest_polaris_stores() {
    assert!(icon_acceptable(Some("image/png"), 2048));
    assert!(icon_acceptable(Some("image/jpeg; charset=binary"), 2048));
    assert!(icon_acceptable(Some("image/png"), 2 * 1024 * 1024));
    assert_eq!(ICON_ACCEPT, "image/png, image/jpeg");
}

#[test]
fn refuses_what_is_not_a_picture_the_system_decodes_empty_or_oversized() {
    assert!(!icon_acceptable(Some("image/svg+xml"), 2048));
    assert!(!icon_acceptable(Some("text/html"), 2048));
    assert!(!icon_acceptable(None, 2048));
    assert!(!icon_acceptable(Some("image/png"), 0));
    assert!(!icon_acceptable(Some("image/png"), ICON_MAX_BYTES + 1));
}

const PNG: &str = "data:image/png;base64,iVBORw0KGgo=";

fn badge(value: serde_json::Value) -> Result<AppBadge, String> {
    serde_json::from_value::<AppBadge>(value)
        .map_err(|error| error.to_string())?
        .checked()
        .map_err(str::to_owned)
}

#[test]
fn a_badge_takes_a_count_with_its_picture() {
    assert!(badge(json!({ "label": "3", "dot": false, "count": 3, "overlay": PNG })).is_ok());
}

#[test]
fn a_badge_refuses_a_picture_that_is_not_a_png_drawn_by_the_page() {
    let remote =
        json!({ "label": "3", "dot": false, "count": 3, "overlay": "https://example.com/x.png" });
    assert!(badge(remote).is_err());
    let svg = json!({ "label": "3", "dot": false, "count": 3, "overlay": "data:image/svg+xml;base64,PHN2Zz4=" });
    assert!(badge(svg).is_err());
}

#[test]
fn a_badge_refuses_a_long_label_a_missing_field_and_anything_it_does_not_expect() {
    assert!(badge(json!({ "label": "12345", "dot": false, "count": 1, "overlay": null })).is_err());
    assert!(
        badge(json!({ "label": null, "dot": false, "count": 0, "overlay": null, "extra": 1 }))
            .is_err()
    );
    assert!(badge(json!({ "dot": false, "count": 0, "overlay": null })).is_err());
    assert!(badge(json!({ "label": null, "dot": false, "count": -1, "overlay": null })).is_err());
    assert!(
        badge(json!({ "label": null, "dot": false, "count": 100_001, "overlay": null })).is_err()
    );
}

fn shown(value: serde_json::Value, platform: Platform) -> BadgePlan {
    badge_plan(&badge(value).unwrap(), platform)
}

#[test]
fn puts_the_picture_on_the_taskbar_button_on_windows_and_takes_it_off_at_zero() {
    let BadgePlan::Overlay { png, label } = shown(
        json!({ "label": "9+", "dot": false, "count": 12, "overlay": PNG }),
        Platform::Windows,
    ) else {
        panic!("Windows draws an overlay");
    };
    assert!(png.is_some_and(|bytes| bytes.starts_with(b"\x89PNG")));
    assert_eq!(label, "9+");
    assert_eq!(
        shown(
            json!({ "label": null, "dot": false, "count": 0, "overlay": null }),
            Platform::Windows
        ),
        BadgePlan::Overlay {
            png: None,
            label: String::new()
        }
    );
}

#[test]
fn writes_the_label_on_the_dock_and_a_bullet_for_a_dot() {
    let mac = |value| shown(value, Platform::Mac);
    assert_eq!(
        mac(json!({ "label": "4", "dot": false, "count": 4, "overlay": null })),
        BadgePlan::Dock(Some("4".into()))
    );
    assert_eq!(
        mac(json!({ "label": null, "dot": true, "count": 4, "overlay": null })),
        BadgePlan::Dock(Some("\u{2022}".into()))
    );
    assert_eq!(
        mac(json!({ "label": null, "dot": false, "count": 0, "overlay": null })),
        BadgePlan::Dock(None)
    );
}

#[test]
fn gives_linux_the_number_and_nothing_for_a_dot_it_cannot_draw() {
    let linux = |value| shown(value, Platform::Linux);
    assert_eq!(
        linux(json!({ "label": "4", "dot": false, "count": 4, "overlay": null })),
        BadgePlan::Count(Some(4))
    );
    assert_eq!(
        linux(json!({ "label": null, "dot": true, "count": 4, "overlay": null })),
        BadgePlan::Count(None)
    );
}
