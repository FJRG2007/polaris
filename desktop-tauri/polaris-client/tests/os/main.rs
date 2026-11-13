//! Ported from `desktop/test/shared/call-hotkeys.test.ts`,
//! `desktop/test/main/context-menu.test.ts` and `api-key-store.test.ts`, with
//! the key check of `key-flow.ts` against a local mock server.

use polaris_client::context_menu::{
    context_menu_items, openable_link, ContextItem, EditRole, MenuParams,
};
use polaris_client::hotkeys::{
    call_accelerators, shortcut_spelling, to_accelerator, CallHotkey, CallHotkeys,
};
use polaris_client::keys::{check_key, KeyRing, SecretStore, REFUSED};
use polaris_client::{ApiKey, InstanceUrl};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn turns_the_dashboards_spelling_into_an_accelerator() {
    assert_eq!(to_accelerator("F9").as_deref(), Some("F9"));
    assert_eq!(
        to_accelerator("Mod+Shift+m").as_deref(),
        Some("CommandOrControl+Shift+M")
    );
    assert_eq!(to_accelerator("Alt+ArrowUp").as_deref(), Some("Alt+Up"));
    assert_eq!(
        to_accelerator("Mod++").as_deref(),
        Some("CommandOrControl+Plus")
    );
    assert_eq!(to_accelerator("Shift+F10").as_deref(), Some("Shift+F10"));
}

#[test]
fn never_takes_a_key_somebody_types_in_another_program() {
    for binding in ["m", "Shift+m", "Space", "Ctrl+m", "", "F25", "F09", "++"] {
        assert_eq!(to_accelerator(binding), None, "{binding}");
    }
}

#[test]
fn drops_a_key_both_controls_would_answer_to_and_keeps_a_repeat_once() {
    let input = CallHotkeys {
        mic: vec!["F9".into(), "F9".into(), "Mod+m".into()],
        deafen: vec!["F10".into(), "Mod+m".into()],
    };
    assert_eq!(
        call_accelerators(&input),
        vec![
            ("F9".to_owned(), CallHotkey::Mic),
            ("F10".to_owned(), CallHotkey::Deafen)
        ]
    );
}

#[test]
fn takes_only_the_two_lists_or_null_to_let_go() {
    let read = |value| {
        serde_json::from_value::<Option<CallHotkeys>>(value)
            .map_err(|e| e.to_string())
            .and_then(|input| match input {
                Some(input) => input.checked().map(Some).map_err(str::to_owned),
                None => Ok(None),
            })
    };
    assert_eq!(read(json!(null)), Ok(None));
    assert!(read(json!({ "mic": ["F9"], "deafen": [] })).is_ok());
    assert!(read(json!({ "mic": ["F9"], "deafen": [], "camera": [] })).is_err());
    assert!(read(json!({ "mic": ["F9", "F9", "F9", "F9", "F9"], "deafen": [] })).is_err());
    assert!(read(json!({ "mic": ["x".repeat(41)], "deafen": [] })).is_err());
}

#[test]
fn spells_plus_as_the_key_the_system_parser_knows() {
    assert_eq!(
        shortcut_spelling("CommandOrControl+Plus"),
        "CommandOrControl+Equal"
    );
    assert_eq!(shortcut_spelling("Alt+F9"), "Alt+F9");
}

fn params() -> MenuParams {
    MenuParams::default()
}

#[test]
fn offers_to_open_and_copy_a_link() {
    let items = context_menu_items(&MenuParams {
        link_url: "https://example.com/a?b=1".into(),
        ..params()
    });
    assert_eq!(
        items,
        vec![
            ContextItem::OpenExternal {
                label: "Open link in browser",
                url: "https://example.com/a?b=1".into()
            },
            ContextItem::CopyText {
                label: "Copy link",
                text: "https://example.com/a?b=1".into()
            },
        ]
    );
}

#[test]
fn copies_the_address_of_a_mail_link_not_the_scheme() {
    let items = context_menu_items(&MenuParams {
        link_url: "mailto:someone@example.com".into(),
        ..params()
    });
    assert_eq!(
        items[1],
        ContextItem::CopyText {
            label: "Copy email address",
            text: "someone@example.com".into()
        }
    );
}

#[test]
fn never_hands_a_script_or_file_address_to_the_system() {
    assert_eq!(openable_link("javascript:alert(1)"), None);
    assert_eq!(openable_link("file:///etc/passwd"), None);
    assert_eq!(openable_link("not a url"), None);
    let items = context_menu_items(&MenuParams {
        link_url: "javascript:alert(1)".into(),
        ..params()
    });
    assert!(items.is_empty());
}

#[test]
fn offers_copy_on_selected_text_and_the_edit_roles_in_a_field() {
    let selected = context_menu_items(&MenuParams {
        selection_text: "hello".into(),
        ..params()
    });
    assert_eq!(
        selected,
        vec![ContextItem::Role {
            role: EditRole::Copy,
            enabled: true
        }]
    );
    let field = context_menu_items(&MenuParams {
        is_editable: true,
        can_paste: true,
        ..params()
    });
    let roles: Vec<_> = field
        .iter()
        .filter_map(|item| match item {
            ContextItem::Role { role, enabled } => Some((*role, *enabled)),
            _ => None,
        })
        .collect();
    assert_eq!(
        roles,
        vec![
            (EditRole::Undo, false),
            (EditRole::Redo, false),
            (EditRole::Cut, false),
            (EditRole::Copy, false),
            (EditRole::Paste, true),
            (EditRole::SelectAll, false),
        ]
    );
}

#[test]
fn puts_spelling_suggestions_first_in_a_field() {
    let items = context_menu_items(&MenuParams {
        is_editable: true,
        misspelled_word: "teh".into(),
        dictionary_suggestions: vec!["the".into(), "ten".into()],
        ..params()
    });
    assert_eq!(
        items[..3],
        [
            ContextItem::Replace("the".into()),
            ContextItem::Replace("ten".into()),
            ContextItem::Separator
        ]
    );
}

#[test]
fn is_empty_where_there_is_nothing_to_offer() {
    assert!(context_menu_items(&params()).is_empty());
}

/// A credential store in memory, standing in for the system's.
#[derive(Default)]
struct Store {
    available: bool,
    kept: Mutex<HashMap<String, String>>,
}

impl SecretStore for Store {
    fn available(&self) -> bool {
        self.available
    }
    fn read(&self, server: &str) -> Option<String> {
        self.kept.lock().unwrap().get(server).cloned()
    }
    fn keep(&self, server: &str, key: &str) -> bool {
        self.kept.lock().unwrap().insert(server.into(), key.into());
        true
    }
    fn forget(&self, server: &str) {
        self.kept.lock().unwrap().remove(server);
    }
}

const KEY: &str = "plk_abcd1234.fixture-secret";

#[test]
fn keeps_one_key_per_server_and_forgets_only_that_one() {
    let ring = KeyRing::new(Store {
        available: true,
        ..Store::default()
    });
    let a = InstanceUrl::parse("https://a.example.com").unwrap();
    let b = InstanceUrl::parse("https://b.example.com").unwrap();
    let key = ApiKey::parse(KEY).unwrap();
    assert!(ring.remember(&a, &key));
    assert!(ring.remember(&b, &key));
    ring.forget(&a);
    assert_eq!(ring.key_for(&a), None);
    assert_eq!(ring.key_for(&b), Some(key));
}

#[test]
fn holds_the_key_in_memory_only_where_the_system_cannot_keep_it() {
    let ring = KeyRing::new(Store::default());
    let a = InstanceUrl::parse("https://a.example.com").unwrap();
    let key = ApiKey::parse(KEY).unwrap();
    assert!(!ring.can_keep());
    assert!(!ring.remember(&a, &key));
    assert_eq!(ring.key_for(&a), Some(key));
}

#[tokio::test]
async fn checks_a_pasted_key_with_the_instance_before_it_is_kept() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/me"))
        .and(header("authorization", format!("Bearer {KEY}").as_str()))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "user": { "id": "u1", "name": "Ada", "email": "ada@example.com" }
        })))
        .mount(&server)
        .await;
    let origin = InstanceUrl::parse(&server.uri()).unwrap();
    let http = reqwest::Client::new();
    assert_eq!(
        check_key(&http, &origin, &format!("  {KEY} ")).await.ok(),
        Some(ApiKey::parse(KEY).unwrap())
    );
    assert_eq!(
        check_key(&http, &origin, "plk_short")
            .await
            .err()
            .as_deref(),
        Some("An API key looks like plk_... - copy the whole key, as Polaris showed it.")
    );
}

#[tokio::test]
async fn refuses_a_revoked_key_in_the_form_it_was_pasted_into() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/api/v1/me"))
        .respond_with(ResponseTemplate::new(401))
        .mount(&server)
        .await;
    let origin = InstanceUrl::parse(&server.uri()).unwrap();
    assert_eq!(
        check_key(&reqwest::Client::new(), &origin, KEY)
            .await
            .err()
            .as_deref(),
        Some(REFUSED)
    );
}
