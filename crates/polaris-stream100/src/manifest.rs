//! How this module describes itself to the desktop app: the device plugin
//! manifest (`docs/device-plugins.md`, schema in `@polaris/core/device-plugins`).
//!
//! `clients/device-plugins/hercules-stream100/manifest.json` is this function's output,
//! checked by a test, so the published package and the code cannot drift. The
//! desktop watches for the USB id it claims and runs the plugin only while
//! such a device can be there; with no controller nothing runs.

use serde_json::{json, Value};

/// The platforms a package is built for: every desktop the app runs on. The
/// controller is read over WinUSB (or the HID API, or the Hercules SDK) on
/// Windows and over libusb on Linux and macOS, x64 and arm64 alike.
pub const PLATFORMS: [&str; 6] = [
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
];

/// The script each platform's package starts.
pub const ENTRY: &str = "main.cjs";

/// The page in the package that draws the controller (`docs/device-plugins.md`).
pub const VIEW: &str = "view/index.html";

/// The first desktop release with the plugin host.
pub const MIN_APP_VERSION: &str = "0.1.138";

pub fn manifest() -> Value {
    let entries: serde_json::Map<String, Value> = PLATFORMS
        .iter()
        .map(|platform| ((*platform).to_owned(), json!(ENTRY)))
        .collect();
    json!({
        "schema": 1,
        "id": "hercules-stream100",
        "name": "Hercules Stream 100",
        "version": env!("CARGO_PKG_VERSION"),
        "publisher": "Polaris",
        "summary": "Knobs follow calls, music and games instead of one app each, and the lit buttons mute, deafen or hang up a Polaris call.",
        "category": "devices",
        "minAppVersion": MIN_APP_VERSION,
        "entries": entries,
        "claims": [{
            "vendorId": crate::VENDOR_ID,
            "productId": crate::PRODUCT_ID,
            "name": "Hercules Stream 100",
        }],
        // Read the knobs and buttons; set the volume and mute of the apps
        // playing audio; run Polaris' call actions from the buttons. The
        // display is asked for once something is drawn on it.
        "permissions": ["usb", "audio-sessions", "polaris-actions"],
        "settings": crate::plugin::plugin_settings(),
        "groups": crate::plugin::plugin_groups(),
        // The desktop keeps several sets of the grouped settings (`docs/device-plugins.md`, profiles).
        "profiles": true,
        // On Windows the desktop app puts Polaris' own WinUSB driver on the
        // controller (`clients/desktop/src/main/plugins/requirements.ts`): listed
        // in the install consent, one Windows prompt, put back when another
        // driver takes the device. On Linux it adds the udev rule that lets the
        // signed-in user open it (one polkit prompt). On macOS the person
        // allows Polaris to record system audio, which per-app volume's
        // process taps need (one system prompt; whole output works without).
        "requires": {
            "win32-x64": [driver_requirement()],
            "win32-arm64": [driver_requirement()],
            "linux-x64": [udev_requirement()],
            "linux-arm64": [udev_requirement()],
            "darwin-x64": [audio_capture_requirement()],
            "darwin-arm64": [audio_capture_requirement()],
        },
        // The plugin's own status sentences (`code` in its status messages),
        // in every language, so the page needs no Polaris update to say them.
        "statusTexts": status_texts(),
        // The editor that shows the controller: its screen, knobs and buttons.
        "view": VIEW,
    })
}

/// The sentences of the status codes only this plugin sends.
fn status_texts() -> Value {
    use crate::plugin::label;
    json!({
        "herculesApp": label(
            "Close Hercules Stream Control to use the Stream 100 here. While it runs, it has the controller.",
            "Cierra Hercules Stream Control para usar el Stream 100 aquí. Mientras está abierto, tiene el control.",
        ),
        "herculesDriver": label(
            "The Stream 100 still has the Hercules driver. It works here once Polaris' driver is on it.",
            "El Stream 100 aún tiene el driver de Hercules. Funciona aquí en cuanto tenga el driver de Polaris.",
        ),
        "perAppNeedsMacos": label(
            "Knobs for calls, music, games or the browser need macOS 14.2 or later. Whole output works here.",
            "Las ruedas de llamadas, música, juegos o navegador piden macOS 14.2 o posterior. Toda la salida funciona.",
        ),
        "perAppNotAllowed": label(
            "Knobs for calls, music, games or the browser need Polaris to be allowed to record system audio.",
            "Las ruedas de llamadas, música, juegos o navegador necesitan que Polaris pueda grabar el audio del sistema.",
        ),
    })
}

/// Recording system audio, which macOS asks the person for before Polaris
/// may tap an app's audio to set its volume (`native/macos.rs`).
fn audio_capture_requirement() -> Value {
    use crate::plugin::label;
    json!({
        "key": "audioCapture",
        "label": label("Let Polaris set each app's volume", "Dejar que Polaris ajuste el volumen de cada app"),
        "hint": label(
            "macOS asks once to let Polaris record system audio, so each knob can set its apps' volume.",
            "macOS pide una vez que Polaris pueda grabar el audio del sistema, para ajustar el volumen de cada app.",
        ),
        "missing": label(
            "macOS does not let Polaris record system audio, so knobs for calls, music, games or the browser do nothing.",
            "macOS no deja a Polaris grabar el audio del sistema: las ruedas por tipo de app no hacen nada.",
        ),
        "restored": label(
            "Polaris can set each app's volume again.",
            "Polaris vuelve a poder ajustar el volumen de cada app.",
        ),
    })
}

/// Polaris' driver for the Stream 100, as the Windows install lists it.
fn driver_requirement() -> Value {
    use crate::plugin::label;
    json!({
        "key": "driver",
        "label": label("Set up the driver", "Configurar el driver"),
        "hint": label(
            "Polaris sets up its driver for the Stream 100 (Windows asks once).",
            "Polaris instala su driver para el Stream 100 (Windows pide permiso una vez).",
        ),
        "missing": label(
            "Polaris' driver is not on the Stream 100 yet, so its knobs and buttons do nothing here.",
            "El driver de Polaris aún no está en el Stream 100: sus ruedas y botones no hacen nada aquí.",
        ),
        "restored": label(
            "Another driver had taken the Stream 100. Polaris put its own back.",
            "Otro driver se había quedado el Stream 100. Polaris ha vuelto a poner el suyo.",
        ),
    })
}

/// The udev rule that lets the signed-in user open the Stream 100, as the
/// Linux install lists it (`clients/desktop/src/main/plugins/hercules-udev.ts`).
fn udev_requirement() -> Value {
    use crate::plugin::label;
    json!({
        "key": "udevRule",
        "label": label("Let Polaris open the Stream 100", "Dejar que Polaris abra el Stream 100"),
        "hint": label(
            "Polaris adds a system rule so it can read the Stream 100 (Linux asks for your password once).",
            "Polaris añade una regla del sistema para leer el Stream 100 (Linux pide tu contraseña una vez).",
        ),
        "missing": label(
            "Linux does not let Polaris open the Stream 100 yet, so its knobs and buttons do nothing.",
            "Linux aún no deja a Polaris abrir el Stream 100: sus ruedas y botones no hacen nada.",
        ),
        "restored": label(
            "The rule that lets Polaris open the Stream 100 was gone. Polaris put it back.",
            "Faltaba la regla que deja a Polaris abrir el Stream 100. Polaris la ha vuelto a poner.",
        ),
    })
}

/// Whether a plugged-in device is one this module drives.
pub fn claims(vendor_id: u16, product_id: u16) -> bool {
    vendor_id == crate::VENDOR_ID && product_id == crate::PRODUCT_ID
}
