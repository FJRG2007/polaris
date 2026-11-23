//! The module's settings: the stored values with their defaults, and the
//! declarative schema the add-on settings page draws them from.
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub enabled: bool,
    pub knobs: [Target; 4],
    pub buttons: [ActionId; 4],
    pub tuning: Tuning,
    pub display: DisplayMode,
    pub brightness: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            knobs: default_targets(),
            buttons: ["call.mic", "call.deafen", "call.camera", "call.hangup"].map(String::from),
            tuning: Tuning::default(),
            display: DisplayMode::Mixer,
            brightness: 80,
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
        settings.tuning = settings.tuning.clamped();
        settings.brightness = settings.brightness.clamp(10, 100);
        settings
    }
}

/// Takes `value` into `slot` when it reads as the slot's type; keeps the slot otherwise.
fn set<T: serde::de::DeserializeOwned>(slot: &mut T, value: Option<&serde_json::Value>) {
    if let Some(read) = value.and_then(|value| T::deserialize(value).ok()) {
        *slot = read;
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
