//! The settings as the device add-on page stores them: flat keys, each a
//! switch, a choice, a range or a Polaris action, the shape the desktop's
//! add-on manifest declares (`@polaris/core/device-addons`). The page draws
//! them with Polaris' own controls; this module turns the stored values back
//! into [`Settings`], so the two never drift.
//!
//! A knob pinned to one program has no flat form: that is the add-on's own
//! editor's job, and a stored `knobN` it cannot read keeps the default.

use crate::audio::{default_targets, Category, Target};
use crate::encoder::Tuning;
use crate::settings::{DisplayMode, Settings};
use serde_json::{json, Map, Value};

/// What a knob can follow from a plain choice.
pub const KNOB_CHOICES: &[&str] = &[
    "calls", "music", "games", "browser", "system", "other", "output", "none",
];
pub const DISPLAY_CHOICES: &[&str] = &["mixer", "call", "nowPlaying", "off"];

fn label(text: &str) -> Value {
    json!({ "en-US": text })
}

fn choice_label(value: &str) -> &'static str {
    match value {
        "calls" => "Calls",
        "music" => "Music",
        "games" => "Games",
        "browser" => "Browser",
        "system" => "System sounds",
        "other" => "Other apps",
        "output" => "Whole output",
        "none" => "Nothing",
        "mixer" => "Volume of each knob",
        "call" => "People in the call",
        "nowPlaying" => "What is playing",
        _ => "Off",
    }
}

fn options(values: &[&str]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| json!({ "value": value, "label": label(choice_label(value)) }))
            .collect(),
    )
}

fn knob_value(target: &Target) -> &'static str {
    match target {
        Target::Category { category } => match category {
            Category::Music => "music",
            Category::Calls => "calls",
            Category::Games => "games",
            Category::Browser => "browser",
            Category::System => "system",
            Category::Other => "other",
        },
        Target::Output => "output",
        Target::None | Target::Program { .. } => "none",
    }
}

fn knob_target(value: &str) -> Option<Target> {
    let category = match value {
        "calls" => Category::Calls,
        "music" => Category::Music,
        "games" => Category::Games,
        "browser" => Category::Browser,
        "system" => Category::System,
        "other" => Category::Other,
        "output" => return Some(Target::Output),
        "none" => return Some(Target::None),
        _ => return None,
    };
    Some(Target::Category { category })
}

fn range(key: &str, text: &str, min: u32, max: u32, default: u32) -> Value {
    json!({ "kind": "range", "key": key, "label": label(text), "min": min, "max": max, "step": 1, "default": default })
}

/// The manifest's `settings` list.
pub fn addon_settings() -> Value {
    let defaults = Settings::default();
    let mut list = vec![
        json!({ "kind": "toggle", "key": "enabled", "label": label("Use the Stream 100"), "default": defaults.enabled }),
    ];
    for (index, target) in defaults.knobs.iter().enumerate() {
        list.push(json!({
            "kind": "choice",
            "key": format!("knob{}", index + 1),
            "label": label(&format!("Knob {}", index + 1)),
            "options": options(KNOB_CHOICES),
            "default": knob_value(target),
        }));
    }
    for (index, action) in defaults.buttons.iter().enumerate() {
        list.push(json!({
            "kind": "action",
            "key": format!("button{}", index + 1),
            "label": label(&format!("Button {}", index + 1)),
            "default": action,
        }));
    }
    list.push(range(
        "percentPerDetent",
        "Volume per click",
        1,
        10,
        defaults.tuning.percent_per_detent.into(),
    ));
    list.push(range(
        "maxAcceleration",
        "Speed-up on a fast turn",
        1,
        5,
        defaults.tuning.max_acceleration.into(),
    ));
    list.push(range(
        "deadBand",
        "Ignore tiny movements",
        0,
        24,
        defaults.tuning.dead_band.into(),
    ));
    list.push(json!({ "kind": "choice", "key": "display", "label": label("Screen shows"), "options": options(DISPLAY_CHOICES), "default": "mixer" }));
    list.push(json!({ "kind": "range", "key": "brightness", "label": label("Screen brightness"), "min": 10, "max": 100, "step": 5, "default": defaults.brightness }));
    Value::Array(list)
}

fn number(values: &Map<String, Value>, key: &str) -> Option<u8> {
    values
        .get(key)?
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| n.round().clamp(0.0, 255.0) as u8)
}

/// Stored flat values to [`Settings`]. Each value is read on its own: one that
/// is missing or does not fit keeps its default, and the rest still apply.
pub fn settings_from_addon(values: &Map<String, Value>) -> Settings {
    let defaults = Settings::default();
    let mut knobs = default_targets();
    for (index, knob) in knobs.iter_mut().enumerate() {
        if let Some(target) = values
            .get(&format!("knob{}", index + 1))
            .and_then(Value::as_str)
            .and_then(knob_target)
        {
            *knob = target;
        }
    }
    let mut buttons = defaults.buttons.clone();
    for (index, button) in buttons.iter_mut().enumerate() {
        match values.get(&format!("button{}", index + 1)) {
            Some(Value::String(id)) if id.len() <= 64 => *button = id.clone(),
            Some(Value::Null) => button.clear(),
            _ => {}
        }
    }
    let display = match values.get("display").and_then(Value::as_str) {
        Some("call") => DisplayMode::Call,
        Some("nowPlaying") => DisplayMode::NowPlaying,
        Some("off") => DisplayMode::Off,
        Some("mixer") => DisplayMode::Mixer,
        _ => defaults.display,
    };
    let tuning = Tuning {
        percent_per_detent: number(values, "percentPerDetent")
            .unwrap_or(defaults.tuning.percent_per_detent),
        max_acceleration: number(values, "maxAcceleration")
            .unwrap_or(defaults.tuning.max_acceleration),
        dead_band: number(values, "deadBand").unwrap_or(defaults.tuning.dead_band),
        ..defaults.tuning
    }
    .clamped();
    Settings {
        enabled: values
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(defaults.enabled),
        knobs,
        buttons,
        tuning,
        display,
        brightness: number(values, "brightness")
            .unwrap_or(defaults.brightness)
            .clamp(10, 100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults_of(list: &Value) -> Map<String, Value> {
        list.as_array()
            .unwrap()
            .iter()
            .map(|field| {
                (
                    field["key"].as_str().unwrap().to_owned(),
                    field["default"].clone(),
                )
            })
            .collect()
    }

    #[test]
    fn the_declared_defaults_are_the_crate_defaults() {
        assert_eq!(
            settings_from_addon(&defaults_of(&addon_settings())),
            Settings::default()
        );
    }

    #[test]
    fn keys_fit_the_manifest_schema() {
        for field in addon_settings().as_array().unwrap() {
            let key = field["key"].as_str().unwrap();
            assert!(
                key.len() <= 40
                    && key.chars().next().unwrap().is_ascii_lowercase()
                    && key.chars().all(|c| c.is_ascii_alphanumeric()),
                "{key}"
            );
        }
    }

    #[test]
    fn one_bad_value_keeps_only_its_own_default() {
        let values = json!({ "knob1": "games", "knob2": "spotify", "brightness": 900, "button3": null, "deadBand": "x" });
        let settings = settings_from_addon(values.as_object().unwrap());
        assert_eq!(
            settings.knobs[0],
            Target::Category {
                category: Category::Games
            }
        );
        assert_eq!(settings.knobs[1], Settings::default().knobs[1]);
        assert_eq!(settings.brightness, 100);
        assert_eq!(settings.buttons[2], "");
        assert_eq!(
            settings.tuning.dead_band,
            Settings::default().tuning.dead_band
        );
    }
}
