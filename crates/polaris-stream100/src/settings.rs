//! The module's settings: the stored values with their defaults, and the
//! declarative schema the plugin settings page draws them from.
//!
//! The schema is data only (switches, choices, sliders, per-knob lists and
//! action pickers), so the page renders it without any code from this module.
//! A rich editor such as a display layout preview is a separate view and is
//! not part of this schema.

use crate::audio::{default_targets, Target};
use crate::encoder::Tuning;
use serde::{Deserialize, Serialize};

/// What the display shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DisplayMode {
    /// The four knobs: what each controls and its volume.
    Mixer,
    /// The people in the current call, falling back to the mixer.
    Call,
    /// What is playing, falling back to the mixer.
    NowPlaying,
    Off,
}

/// A lit button's action: an id from the Polaris deck catalogue
/// (`GET /api/deck/actions`, the one the Stream Deck plugin uses, such as
/// `call.mic` or `call.deafen`), or nothing (empty).
pub type ActionId = String;

/// What a knob of a page follows. Wider than [`Target`]: a page can keep
/// what Stream Control had (a hand-picked list of apps by name, the
/// microphone) before the engine drives it, so nothing imported is lost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageKnob {
    Category {
        category: String,
        #[serde(default)]
        label: String,
    },
    /// Apps picked by hand, by the name Stream Control shows; one app is a list of one.
    Apps {
        apps: Vec<String>,
        #[serde(default)]
        label: String,
    },
    Program {
        program: String,
        #[serde(default)]
        label: String,
    },
    Microphone {
        #[serde(default)]
        label: String,
    },
    Output {
        #[serde(default)]
        label: String,
    },
    None {
        #[serde(default)]
        label: String,
    },
}

/// What a button of a page does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageAction {
    /// A Polaris action ([`ActionId`]).
    Action {
        action: ActionId,
    },
    /// A media key: `playPause`, `next` or `previous`.
    Media {
        key: String,
    },
    /// Turn to the `next` or `previous` page.
    Page {
        to: String,
    },
    /// Discord's own mute or deafen (`mute`, `deafen`).
    Discord {
        action: String,
    },
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageButton {
    pub action: PageAction,
    #[serde(default)]
    pub label: String,
    /// The label while the button is on; none keeps one label.
    #[serde(default)]
    pub toggled_label: Option<String>,
}

/// Four knobs and four buttons, the way Stream Control lays a page out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    pub knobs: [PageKnob; 4],
    pub buttons: [PageButton; 4],
}

/// Pages that come up while one of `apps` is in front.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub apps: Vec<String>,
    pub page: u8,
}

/// The most pages kept, as many as Stream Control offers.
pub const MAX_PAGES: usize = 8;
/// The most profiles kept.
pub const MAX_PROFILES: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub knobs: [Target; 4],
    pub buttons: [ActionId; 4],
    /// What pressing each knob runs; empty mutes what the knob follows, as before.
    pub knob_press: [ActionId; 4],
    pub tuning: Tuning,
    pub display: DisplayMode,
    pub brightness: u8,
    /// Every page beyond the live knobs and buttons, as imported from Stream
    /// Control (`clients/desktop/src/main/plugins/hercules-official.ts`, `Layout`).
    pub pages: Vec<Page>,
    pub profiles: Vec<Profile>,
    /// How the screen looks; every value defaults to today's page.
    pub look: crate::theme::Look,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            knobs: default_targets(),
            buttons: ["call.mic", "call.deafen", "call.camera", "call.hangup"].map(String::from),
            knob_press: Default::default(),
            tuning: Tuning::default(),
            display: DisplayMode::Mixer,
            brightness: 80,
            pages: Vec::new(),
            profiles: Vec::new(),
            look: crate::theme::Look::default(),
        }
    }
}

impl Settings {
    /// Reads stored settings; anything missing or out of range takes its
    /// default, so an older or damaged file never turns a guard off.
    ///
    /// Field by field (and knob by knob): one value of the wrong type or past
    /// its type's range (`"brightness": 500`) resets that value only, never
    /// the rest of what the person chose.
    pub fn from_json(json: &str) -> Self {
        let mut settings = Settings::default();
        let Ok(serde_json::Value::Object(stored)) = serde_json::from_str::<serde_json::Value>(json)
        else {
            return settings;
        };
        set(&mut settings.enabled, stored.get("enabled"));
        each(&mut settings.knobs, stored.get("knobs"));
        each(&mut settings.buttons, stored.get("buttons"));
        each(&mut settings.knob_press, stored.get("knobPress"));
        if let Some(serde_json::Value::Object(tuning)) = stored.get("tuning") {
            let target = &mut settings.tuning;
            set(
                &mut target.percent_per_detent,
                tuning.get("percentPerDetent"),
            );
            set(&mut target.dead_band, tuning.get("deadBand"));
            set(&mut target.settle_ms, tuning.get("settleMs"));
            set(&mut target.max_acceleration, tuning.get("maxAcceleration"));
            set(&mut target.max_step, tuning.get("maxStep"));
        }
        set(&mut settings.display, stored.get("display"));
        set(&mut settings.brightness, stored.get("brightness"));
        settings.pages = valid_items(stored.get("pages"), MAX_PAGES);
        settings.profiles = valid_items(stored.get("profiles"), MAX_PROFILES);
        settings
            .profiles
            .retain(|profile| usize::from(profile.page) < settings.pages.len().max(1));
        settings.tuning = settings.tuning.clamped();
        settings.brightness = settings.brightness.clamp(10, 100);
        set(&mut settings.look, stored.get("look"));
        settings.look = settings.look.clone().clamped();
        settings
    }
}

/// Takes `value` into `slot` when it reads as the slot's type; keeps the slot otherwise.
fn set<T: serde::de::DeserializeOwned>(slot: &mut T, value: Option<&serde_json::Value>) {
    if let Some(read) = value.and_then(|value| T::deserialize(value).ok()) {
        *slot = read;
    }
}

/// The entries of a stored list that read as `T`, at most `max`: one damaged
/// page is dropped, never the others.
fn valid_items<T: serde::de::DeserializeOwned>(
    value: Option<&serde_json::Value>,
    max: usize,
) -> Vec<T> {
    match value {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|item| T::deserialize(item).ok())
            .take(max)
            .collect(),
        _ => Vec::new(),
    }
}

/// [`set`] for each entry of a stored list, by position.
fn each<T: serde::de::DeserializeOwned>(slots: &mut [T], value: Option<&serde_json::Value>) {
    if let Some(serde_json::Value::Array(items)) = value {
        for (slot, item) in slots.iter_mut().zip(items) {
            set(slot, Some(item));
        }
    }
}

/// One field of the settings page. `key` is a dotted path into [`Settings`]'s
/// JSON form; labels are looked up by `key` in the page's own catalogs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Field {
    Switch {
        key: &'static str,
        default: bool,
    },
    Choice {
        key: &'static str,
        options: &'static [&'static str],
        default: &'static str,
    },
    Slider {
        key: &'static str,
        min: u32,
        max: u32,
        step: u32,
        default: u32,
    },
    /// A target picker: a category, a pinned program from the running audio
    /// apps, the whole output, or nothing.
    AudioTarget {
        key: &'static str,
    },
    /// A picker over the deck action catalogue.
    Action {
        key: &'static str,
    },
    /// The same fields once per knob or button, `{i}` replaced by 0-3.
    Repeat {
        count: u8,
        fields: Vec<Field>,
    },
}

pub const CATEGORIES: &[&str] = &["music", "calls", "games", "browser", "system", "other"];

pub fn schema() -> Vec<Field> {
    let defaults = Settings::default();
    vec![
        Field::Switch {
            key: "enabled",
            default: defaults.enabled,
        },
        Field::Repeat {
            count: 4,
            fields: vec![Field::AudioTarget { key: "knobs.{i}" }],
        },
        Field::Repeat {
            count: 4,
            fields: vec![Field::Action { key: "buttons.{i}" }],
        },
        Field::Slider {
            key: "tuning.percentPerDetent",
            min: 1,
            max: 10,
            step: 1,
            default: u32::from(defaults.tuning.percent_per_detent),
        },
        Field::Slider {
            key: "tuning.maxAcceleration",
            min: 1,
            max: 5,
            step: 1,
            default: u32::from(defaults.tuning.max_acceleration),
        },
        Field::Slider {
            key: "tuning.deadBand",
            min: 0,
            max: 24,
            step: 1,
            default: u32::from(defaults.tuning.dead_band),
        },
        Field::Choice {
            key: "display",
            options: &["mixer", "call", "nowPlaying", "off"],
            default: "mixer",
        },
        Field::Slider {
            key: "brightness",
            min: 10,
            max: 100,
            step: 5,
            default: u32::from(defaults.brightness),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape `importStreamControl` writes to `layout.json`, from a real Stream Control 2.05.8 file.
    const LAYOUT: &str = r#"{"pages":[{"knobs":[{"kind":"category","category":"calls","label":"Calls"},{"kind":"apps","apps":["Brave Browser"],"label":"Multimedia"},{"kind":"category","category":"games","label":"Games"},{"kind":"microphone","label":"Mic"}],"buttons":[{"action":{"kind":"discord","action":"mute"},"label":"Mute","toggledLabel":"Muted"},{"action":{"kind":"discord","action":"deafen"},"label":"Deaf","toggledLabel":null},{"action":{"kind":"media","key":"playPause"},"label":"Play / Pause media","toggledLabel":null},{"action":{"kind":"page","to":"next"},"label":"Next page","toggledLabel":null}]},{"knobs":[{"kind":"none","label":""},{"kind":"output","label":""},{"kind":"program","program":"spotify.exe","label":""},{"kind":"none"}],"buttons":[{"action":{"kind":"page","to":"previous"},"label":"Previous page"},{"action":{"kind":"none"},"label":""},{"action":{"kind":"action","action":"call.mic"},"label":""},{"action":{"kind":"media","key":"next"},"label":"Next media"}]}],"profiles":[{"name":"Games","apps":["game.exe"],"page":1}]}"#;

    #[test]
    fn reads_the_imported_pages_and_profiles() {
        let settings = Settings::from_json(LAYOUT);
        assert_eq!(settings.pages.len(), 2);
        assert_eq!(
            settings.pages[0].knobs[1],
            PageKnob::Apps {
                apps: vec!["Brave Browser".into()],
                label: "Multimedia".into()
            }
        );
        assert_eq!(
            settings.pages[0].knobs[3],
            PageKnob::Microphone {
                label: "Mic".into()
            }
        );
        assert_eq!(
            settings.pages[0].buttons[0].toggled_label.as_deref(),
            Some("Muted")
        );
        assert_eq!(
            settings.pages[1].buttons[0].action,
            PageAction::Page {
                to: "previous".into()
            }
        );
        assert_eq!(settings.profiles[0].page, 1);
        // The live controls are untouched by pages.
        assert_eq!(settings.knobs, Settings::default().knobs);
    }

    #[test]
    fn a_damaged_page_drops_alone_and_pages_are_capped() {
        let mut pages: Vec<serde_json::Value> = vec![serde_json::json!({ "knobs": "x" })];
        let good: serde_json::Value =
            serde_json::from_str::<serde_json::Value>(LAYOUT).unwrap()["pages"][0].clone();
        pages.extend(std::iter::repeat_n(good, 12));
        let json = serde_json::json!({ "pages": pages, "profiles": [{ "name": "x", "apps": [], "page": 40 }] });
        let settings = Settings::from_json(&json.to_string());
        assert_eq!(settings.pages.len(), MAX_PAGES);
        assert!(
            settings.profiles.is_empty(),
            "a profile pointing past the pages is dropped"
        );
    }
}
