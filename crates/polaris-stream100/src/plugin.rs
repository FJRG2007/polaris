//! The settings as the device plugin page stores them: flat keys, each a
//! switch, a choice, a range or a Polaris action, the shape the desktop's
//! plugin manifest declares (`@polaris/core/device-plugins`). The page draws
//! them with Polaris' own controls; this module turns the stored values back
//! into [`Settings`], so the two never drift.
//!
//! A knob pinned to one program has no flat form: that is the plugin's own
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

/// A text in every language Polaris ships (`en-US`, `es-ES`).
pub(crate) fn label(en: &str, es: &str) -> Value {
    json!({ "en-US": en, "es-ES": es })
}

/// The language the screen is drawn in: one Polaris ships, or `en-US` for
/// any other (the same fallback the plugin page's texts use).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    EnUs,
    EsEs,
}

impl Locale {
    /// A BCP 47 tag as the desktop app reports it (`es-ES`, `es_MX`, `es`,
    /// `en-GB`, ...): any Spanish one is Spanish, anything else English.
    pub fn from_tag(tag: &str) -> Self {
        let language = tag.trim().split(['-', '_']).next().unwrap_or_default();
        if language.eq_ignore_ascii_case("es") {
            Locale::EsEs
        } else {
            Locale::EnUs
        }
    }

    /// One of a pair of texts, in this language.
    pub fn pick<'a>(self, en: &'a str, es: &'a str) -> &'a str {
        match self {
            Locale::EnUs => en,
            Locale::EsEs => es,
        }
    }
}

/// A call action's name on the screen's action zone, in English and Spanish
/// (the plugin page's words, shortened where a column would cut them), or
/// `None` for anything that is not one.
pub fn action_name(id: &str) -> Option<(&'static str, &'static str)> {
    Some(match id {
        "call.mic" => ("Mute mic", "Silenciar"),
        "call.deafen" => ("Deafen", "Sin audio"),
        "call.camera" => ("Camera", "Cámara"),
        "call.share" => ("Share screen", "Compartir"),
        "call.hangup" | "call.leave" => ("Hang up", "Colgar"),
        _ => return None,
    })
}

/// A knob choice's name on the controller's screen, where a column fits nine
/// characters: the page's own label where it fits, a shorter word where not.
pub fn screen_name(value: &str) -> (&'static str, &'static str) {
    match value {
        "system" => ("System", "Sistema"),
        "other" => ("Other", "Otras"),
        "output" => ("Output", "Salida"),
        "none" => ("", ""),
        other => choice_label(other),
    }
}

fn choice_label(value: &str) -> (&'static str, &'static str) {
    match value {
        "calls" => ("Calls", "Llamadas"),
        "music" => ("Music", "Música"),
        "games" => ("Games", "Juegos"),
        "browser" => ("Browser", "Navegador"),
        "system" => ("System sounds", "Sonidos del sistema"),
        "other" => ("Other apps", "Otras apps"),
        "output" => ("Whole output", "Toda la salida"),
        "none" => ("Nothing", "Nada"),
        "mixer" => ("Volume of each knob", "Volumen de cada rueda"),
        "call" => ("People in the call", "Personas en la llamada"),
        "nowPlaying" => ("What is playing", "Lo que suena"),
        _ => ("Off", "Apagada"),
    }
}

fn options(values: &[&str]) -> Value {
    Value::Array(
        values
            .iter()
            .map(|value| {
                let (en, es) = choice_label(value);
                json!({ "value": value, "label": label(en, es) })
            })
            .collect(),
    )
}

pub(crate) fn knob_value(target: &Target) -> &'static str {
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

fn range(key: &str, text: (&str, &str), min: u32, max: u32, default: u32) -> Value {
    json!({ "kind": "range", "key": key, "group": "turning", "label": label(text.0, text.1), "min": min, "max": max, "step": 1, "default": default })
}

/// The manifest's `groups`: how the page lays the settings out, as the controller.
pub fn plugin_groups() -> Value {
    json!([
        { "key": "knobs", "label": label("Knobs", "Ruedas"), "hint": label("What each knob turns up and down.", "Lo que sube y baja cada rueda."), "look": "dials" },
        { "key": "buttons", "label": label("Lit buttons", "Botones iluminados"), "hint": label("What each button does in a Polaris call.", "Lo que hace cada botón en una llamada de Polaris."), "look": "buttons" },
        { "key": "turning", "label": label("How the knobs turn", "Cómo giran las ruedas"), "look": "rows" },
        { "key": "screen", "label": label("Screen", "Pantalla"), "hint": label("What the controller's screen shows with Polaris' driver.", "Lo que muestra la pantalla del controlador con el driver de Polaris."), "look": "rows" },
        { "key": "look", "label": label("Look", "Aspecto"), "hint": label("Colors and images on the screen, like Stream Control's graphic settings.", "Colores e imágenes de la pantalla, como los ajustes gráficos de Stream Control."), "look": "rows" },
    ])
}

/// The manifest's `settings` list.
pub fn plugin_settings() -> Value {
    let defaults = Settings::default();
    let mut list = vec![
        json!({ "kind": "toggle", "key": "enabled", "label": label("Use the Stream 100", "Usar el Stream 100"), "default": defaults.enabled }),
    ];
    for (index, target) in defaults.knobs.iter().enumerate() {
        list.push(json!({
            "kind": "choice",
            "key": format!("knob{}", index + 1),
            "group": "knobs",
            "label": label(&format!("Knob {}", index + 1), &format!("Rueda {}", index + 1)),
            "options": options(KNOB_CHOICES),
            "default": knob_value(target),
        }));
    }
    for index in 0..4 {
        list.push(json!({
            "kind": "action",
            "key": format!("press{}", index + 1),
            "group": "knobs",
            "label": label(&format!("Press knob {}", index + 1), &format!("Pulsar rueda {}", index + 1)),
            "hint": label("Nothing mutes what the knob turns.", "Nada silencia lo que mueve la rueda."),
            "default": Value::Null,
        }));
    }
    for (index, action) in defaults.buttons.iter().enumerate() {
        list.push(json!({
            "kind": "action",
            "key": format!("button{}", index + 1),
            "group": "buttons",
            "label": label(&format!("Button {}", index + 1), &format!("Botón {}", index + 1)),
            "default": action,
        }));
    }
    list.push(range(
        "percentPerDetent",
        ("Volume per click", "Volumen por paso"),
        1,
        10,
        defaults.tuning.percent_per_detent.into(),
    ));
    list.push(range(
        "maxAcceleration",
        ("Speed-up on a fast turn", "Aceleración al girar rápido"),
        1,
        5,
        defaults.tuning.max_acceleration.into(),
    ));
    list.push(range(
        "deadBand",
        ("Ignore tiny movements", "Ignorar movimientos mínimos"),
        0,
        24,
        defaults.tuning.dead_band.into(),
    ));
    list.push(json!({ "kind": "choice", "key": "display", "group": "screen", "label": label("Screen shows", "La pantalla muestra"), "hint": label("With no call or nothing playing it shows the knobs. macOS does not let apps read what is playing.", "Sin llamada o sin nada sonando muestra las ruedas. macOS no deja a las apps leer lo que suena."), "options": options(DISPLAY_CHOICES), "default": "mixer" }));
    list.push(json!({ "kind": "range", "key": "idleAfter", "group": "screen", "label": label("Show this computer's stats after (seconds, 0 = never)", "Mostrar datos del ordenador tras (segundos, 0 = nunca)"), "hint": label("Clock, CPU, memory, disk and Linux network until a control is touched. GPU load is left out: no light way to read it.", "Hora, CPU, memoria, disco y red en Linux hasta tocar un control. Sin carga de GPU: no hay forma ligera de leerla."), "min": 0, "max": 600, "step": 5, "default": 0 }));
    list.push(json!({ "kind": "range", "key": "brightness", "group": "screen", "label": label("Screen brightness", "Brillo de la pantalla"), "min": 10, "max": 100, "step": 5, "default": defaults.brightness }));
    list.push(json!({ "kind": "choice", "key": "labelSize", "group": "screen", "label": label("Knob name size", "Tamaño del nombre de cada rueda"), "options": [
        { "value": "small", "label": label("Small", "Pequeño") },
        { "value": "medium", "label": label("Medium", "Mediano") },
        { "value": "large", "label": label("Large", "Grande") }
    ], "default": "medium" }));
    list.extend(look_settings());
    Value::Array(list)
}

/// Today's colours as `#rrggbb`, shown by the page while nothing is picked.
fn default_color(role: usize) -> String {
    let (red, green, blue) = crate::theme::DEFAULT_COLORS[role];
    format!("#{red:02x}{green:02x}{blue:02x}")
}

/// The screen's look (`look_from_plugin`): every value empty or today's by default.
fn look_settings() -> Vec<Value> {
    use crate::theme::{BACKGROUND, FILL, KNOB_IMAGE_SIDE, TEXT};
    let fit = |key: &str, en: &str, es: &str, default: &str| {
        json!({ "kind": "choice", "key": key, "group": "look", "label": label(en, es), "options": [
            { "value": "cover", "label": label("Fill the space", "Llenar el espacio") },
            { "value": "contain", "label": label("Show it whole", "Mostrarla entera") }
        ], "default": default })
    };
    let mut list = vec![
        json!({ "kind": "color", "key": "backgroundColor", "group": "look", "label": label("Background color", "Color de fondo"), "fallback": default_color(BACKGROUND), "default": "" }),
        json!({ "kind": "color", "key": "textColor", "group": "look", "label": label("Text color", "Color del texto"), "fallback": default_color(TEXT), "default": "" }),
        json!({ "kind": "color", "key": "accentColor", "group": "look", "label": label("Volume bar color", "Color de la barra de volumen"), "fallback": default_color(FILL), "default": "" }),
        json!({ "kind": "image", "key": "backgroundImage", "group": "look", "label": label("Background image", "Imagen de fondo"), "hint": label("Drawn behind everything at 480 x 272, like Stream Control's background.", "Se dibuja detrás de todo a 480 x 272, como el fondo de Stream Control."), "width": crate::display::WIDTH, "height": crate::display::HEIGHT, "default": "" }),
        fit(
            "backgroundFit",
            "Background image fit",
            "Ajuste de la imagen de fondo",
            "cover",
        ),
    ];
    for knob in 1..=4 {
        list.push(json!({ "kind": "image", "key": format!("knob{knob}Image"), "group": "look", "label": label(&format!("Knob {knob} icon"), &format!("Icono de la rueda {knob}")), "width": KNOB_IMAGE_SIDE, "height": KNOB_IMAGE_SIDE, "default": "" }));
    }
    list.push(fit(
        "knobImageFit",
        "Knob icon fit",
        "Ajuste de los iconos",
        "contain",
    ));
    list
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
pub fn settings_from_plugin(values: &Map<String, Value>) -> Settings {
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
    let mut knob_press: [String; 4] = Default::default();
    for (index, press) in knob_press.iter_mut().enumerate() {
        if let Some(Value::String(id)) = values.get(&format!("press{}", index + 1)) {
            if id.len() <= 64 {
                *press = id.clone();
            }
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
        knob_press,
        tuning,
        display,
        brightness: number(values, "brightness")
            .unwrap_or(defaults.brightness)
            .clamp(10, 100),
        // Pages and profiles have no flat form; they come from the imported
        // layout (`Settings::from_json`).
        pages: Vec::new(),
        profiles: Vec::new(),
        look: look_from_plugin(values),
    }
}

/// The screen's look from its flat values (`backgroundColor`, `textColor`,
/// `accentColor`, `labelSize`, `backgroundImage`, `backgroundFit`,
/// `knob1Image`..`knob4Image`, `knobImageFit`); anything missing or that
/// does not read keeps today's look.
pub fn look_from_plugin(values: &Map<String, Value>) -> crate::theme::Look {
    use crate::theme::{Fit, LabelSize, Look};
    let text = |key: &str| {
        values
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let defaults = Look::default();
    Look {
        background_color: text("backgroundColor"),
        text_color: text("textColor"),
        accent_color: text("accentColor"),
        label_size: LabelSize::from_value(&text("labelSize")).unwrap_or(defaults.label_size),
        background_image: text("backgroundImage"),
        background_fit: Fit::from_value(&text("backgroundFit")).unwrap_or(defaults.background_fit),
        knob_images: std::array::from_fn(|knob| text(&format!("knob{}Image", knob + 1))),
        knob_image_fit: Fit::from_value(&text("knobImageFit")).unwrap_or(defaults.knob_image_fit),
    }
    .clamped()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_spanish_tag_is_spanish_and_anything_else_english() {
        for tag in ["es-ES", "es", "es_MX", "ES-419", " es-AR "] {
            assert_eq!(Locale::from_tag(tag), Locale::EsEs, "{tag}");
        }
        for tag in ["en-US", "en-GB", "fr-FR", "", "est", "-es"] {
            assert_eq!(Locale::from_tag(tag), Locale::EnUs, "{tag}");
        }
        assert_eq!(Locale::EsEs.pick("Music", "Música"), "Música");
        assert_eq!(Locale::EnUs.pick("Music", "Música"), "Music");
    }

    #[test]
    fn every_knob_choice_has_a_screen_name_that_fits_its_column() {
        for value in KNOB_CHOICES {
            let (en, es) = screen_name(value);
            assert!(
                en.chars().count() <= 9 && es.chars().count() <= 9,
                "{value}"
            );
            assert_eq!(en.is_empty(), *value == "none", "{value}");
        }
        // The page's own words where they fit.
        assert_eq!(screen_name("music"), choice_label("music"));
    }

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
            settings_from_plugin(&defaults_of(&plugin_settings())),
            Settings::default()
        );
    }

    #[test]
    fn keys_fit_the_manifest_schema() {
        for field in plugin_settings().as_array().unwrap() {
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
        let settings = settings_from_plugin(values.as_object().unwrap());
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
