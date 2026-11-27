/**
 * A preview of the Stream 100's screen, shown in a sandboxed frame on the
 * plugin's page in Polaris (docs/device-plugins.md, Views): what the screen is
 * set to show, at its brightness, with the name of what each knob turns. Every
 * control is a declared setting that Polaris draws with its own components
 * around it. The page's `hello` and `settings` messages bring the look, the
 * language and every change.
 *
 * Above the preview, on Windows, a line about Polaris' own WinUSB driver: where
 * it stands, and why its last setup did not go through (`driver.look`,
 * answered by the desktop app's `plugins/official.ts`). The driver is set up by
 * the app as the plugin's requirement (`requires` in the manifest), by itself:
 * a missing one is being set up, and only one whose setup was declined or
 * failed has the page's "Set up the driver" action next to it. The view never
 * asks for a manual step. Text only, like the rest of the view. Nothing is
 * drawn where the app answers null (another system, or an older app).
 */

"use strict";

const KNOBS = ["knob1", "knob2", "knob3", "knob4"];
const BUTTONS = ["button1", "button2", "button3", "button4"];
const CATEGORIES = ["calls", "music", "games", "browser", "system", "other", "output", "none"];
const ACTIONS = ["none", "call.mic", "call.deafen", "call.camera", "call.share", "call.hangup"];
const DISPLAYS = ["mixer", "call", "nowPlaying", "off"];
const DEFAULTS = {
    knob1: "calls",
    knob2: "music",
    knob3: "games",
    knob4: "output",
    button1: "call.mic",
    button2: "call.deafen",
    button3: "call.camera",
    button4: "call.hangup",
    display: "mixer",
    brightness: 80
};
/** Levels drawn on the screen preview; the real ones are the volumes of what each knob turns. */
const SAMPLE_LEVELS = [0.7, 0.45, 0.6, 0.85];

const WORDS = {
    en: {
        screen: "Preview of the Stream 100 screen",
        caption: "Screen preview: {display}, {brightness}% bright",
        captionOff: "Screen preview: off",
        callNote: "The people in the call show here.",
        nowPlayingNote: "What is playing shows here.",
        offNote: "The screen is off.",
        driver: {
            settingUp: "Setting up the Polaris driver for the Stream 100. Windows asks once; choose Yes.",
            repair: "Another driver took the Stream 100. Polaris is putting its own back; Windows asks once.",
            stopped: "Polaris' driver is not on the Stream 100 yet, so its knobs and buttons do nothing here.",
            unplugged: "Polaris sets up its driver when the Stream 100 is plugged in.",
            installed: "Stream 100 driver is set up on this PC.",
            pending: "The driver is on the Stream 100. Restart Windows to finish setting it up.",
            failed: {
                declined: "Windows' permission was not given. Choose Set up the driver, then Yes.",
                unplugged: "The Stream 100 was unplugged. Plug it in and choose Set up the driver.",
                certificate: "Windows did not create the driver's certificate. Choose Set up the driver to try again.",
                signing: "Windows did not accept the driver's signature. Choose Set up the driver to try again.",
                binding: "Windows did not put the driver on the Stream 100. Plug it in again and choose Set up the driver.",
                restart: "Windows needs a restart to finish. If it still does not work after that, choose Set up the driver.",
                removing: "The driver could not be removed. Choose Set up the driver to try again.",
                failed: "The driver setup did not finish. Choose Set up the driver to try again."
            }
        },
        categories: { calls: "Calls", music: "Music", games: "Games", browser: "Browser", system: "System sounds", other: "Other apps", output: "Whole output", none: "Nothing" },
        displays: { mixer: "Volume of each knob", call: "People in the call", nowPlaying: "What is playing", off: "Off" }
    },
    es: {
        screen: "Vista previa de la pantalla del Stream 100",
        caption: "Vista previa: {display}, brillo al {brightness}%",
        captionOff: "Vista previa: pantalla apagada",
        callNote: "Aquí aparecen las personas de la llamada.",
        nowPlayingNote: "Aquí aparece lo que suena.",
        offNote: "La pantalla está apagada.",
        driver: {
            settingUp: "Configurando el driver de Polaris para el Stream 100. Windows pide permiso una vez; elige Sí.",
            repair: "Otro driver se quedó el Stream 100. Polaris está poniendo el suyo; Windows pide permiso una vez.",
            stopped: "El driver de Polaris aún no está en el Stream 100: sus ruedas y botones no hacen nada aquí.",
            unplugged: "Polaris configura su driver en cuanto conectes el Stream 100.",
            installed: "El driver del Stream 100 está configurado en este PC.",
            pending: "El driver ya está en el Stream 100. Reinicia Windows para terminar de configurarlo.",
            failed: {
                declined: "No se dio el permiso de Windows. Elige Configurar el driver y luego Sí.",
                unplugged: "Se desconectó el Stream 100. Conéctalo y elige Configurar el driver.",
                certificate: "Windows no creó el certificado del driver. Elige Configurar el driver para reintentar.",
                signing: "Windows no aceptó la firma del driver. Elige Configurar el driver para reintentar.",
                binding: "Windows no puso el driver en el Stream 100. Reconéctalo y elige Configurar el driver.",
                restart: "Windows necesita reiniciarse para terminar. Si después sigue sin ir, elige Configurar el driver.",
                removing: "No se pudo quitar el driver. Elige Configurar el driver para reintentar.",
                failed: "La configuración del driver no terminó. Elige Configurar el driver para reintentar."
            }
        },
        categories: { calls: "Llamadas", music: "Música", games: "Juegos", browser: "Navegador", system: "Sonidos del sistema", other: "Otras apps", output: "Toda la salida", none: "Nada" },
        displays: { mixer: "Volumen de cada rueda", call: "Personas en la llamada", nowPlaying: "Lo que suena", off: "Apagada" }
    }
};

/** The words for a locale such as "es-ES", English when there are none. */
function wordsFor(locale) {
    const language = String(locale || "").split("-")[0].toLowerCase();
    return Object.prototype.hasOwnProperty.call(WORDS, language) ? WORDS[language] : WORDS.en;
}

/** The values as this editor draws them: what is stored, with the default for what is missing or unknown. */
function readValues(values) {
    const given = values && typeof values === "object" ? values : {};
    const out = { ...DEFAULTS };
    for (const key of KNOBS) if (CATEGORIES.includes(given[key])) out[key] = given[key];
    for (const key of BUTTONS) {
        const value = given[key] === "call.leave" ? "call.hangup" : given[key];
        if (value === null) out[key] = "none";
        else if (ACTIONS.includes(value)) out[key] = value;
    }
    if (DISPLAYS.includes(given.display)) out.display = given.display;
    if (typeof given.brightness === "number" && Number.isFinite(given.brightness)) out.brightness = Math.min(100, Math.max(10, given.brightness));
    return out;
}

/** Only the tokens the page hands over that are custom properties; anything else is dropped. */
function tokenEntries(tokens) {
    if (!tokens || typeof tokens !== "object") return [];
    return Object.entries(tokens).filter(([name, value]) => /^--[a-z0-9-]{1,40}$/.test(name) && typeof value === "string" && value.length <= 400);
}

function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

const DRIVER_STATES = ["notNeeded", "installed", "needed", "repair", "unplugged"];
const DRIVER_FAILURES = ["declined", "unplugged", "certificate", "signing", "binding", "restart", "removing", "failed"];

/** The app's answer to `driver.look`, checked field by field, or null to draw nothing. */
function readDriver(value) {
    if (!value || typeof value !== "object" || !DRIVER_STATES.includes(value.state)) return null;
    // Once the driver is on the device, an earlier setup's failure no longer applies.
    const failure = value.state === "installed" || value.failure === undefined || value.failure === null ? null : DRIVER_FAILURES.includes(value.failure) ? value.failure : "failed";
    return { state: value.state, hercules: value.hercules === true, installed: value.installed === true, pending: value.pending === true, failure };
}

/**
 * The key under `driver` of the line to show, or null for none. A missing
 * driver with no failure is one the app is setting up by itself; after a
 * declined or failed setup the line says what does not work, and the failure
 * line beside it points at the page's action.
 */
function driverSentence(driver) {
    if (!driver) return null;
    switch (driver.state) {
        case "needed":
            return driver.failure ? "stopped" : "settingUp";
        case "repair":
            return driver.failure ? "stopped" : "repair";
        case "unplugged":
            return driver.installed ? null : "unplugged";
        case "installed":
            return driver.pending ? "pending" : "installed";
        default:
            return null;
    }
}

if (typeof module !== "undefined") module.exports = { wordsFor, readValues, tokenEntries, fill, readDriver, driverSentence, DEFAULTS, DRIVER_FAILURES };

if (typeof document !== "undefined") {
    const state = { words: WORDS.en, values: null, driver: null };
    const replies = new Map();
    let nextCall = 1;
    const parentWindow = window.parent;
    const byId = (id) => document.getElementById(id);
    // The frame is as tall as what it draws: measured from the content, never from
    // the document, whose height is at least the frame's and so could never shrink.
    const resize = () => parentWindow.postMessage({ type: "resize", height: Math.ceil(byId("root").getBoundingClientRect().height) }, "*");

    function drawScreen(values) {
        const screen = byId("screen");
        screen.replaceChildren();
        screen.setAttribute("aria-label", `${state.words.screen}: ${state.words.displays[values.display]}`);
        screen.style.opacity = values.display === "off" ? "0.35" : String(0.45 + (values.brightness / 100) * 0.55);
        if (values.display === "mixer") {
            KNOBS.forEach((key, index) => {
                const bar = document.createElement("div");
                bar.className = "bar";
                const level = document.createElement("div");
                level.className = "fill";
                level.style.height = `${Math.round(SAMPLE_LEVELS[index] * 70)}%`;
                const name = document.createElement("div");
                name.className = "name";
                name.textContent = state.words.categories[values[key]];
                name.title = name.textContent;
                bar.append(level, name);
                screen.append(bar);
            });
            return;
        }
        const note = document.createElement("p");
        note.className = "note";
        note.textContent = state.words[values.display === "call" ? "callNote" : values.display === "nowPlaying" ? "nowPlayingNote" : "offNote"];
        screen.append(note);
    }

    /** One call through the page to the app; resolves with its value, or null when it refused or failed. */
    function call(method) {
        const id = nextCall++;
        return new Promise((resolve) => {
            replies.set(id, resolve);
            parentWindow.postMessage({ type: "call", id, method }, "*");
        });
    }

    async function lookDriver() {
        state.driver = readDriver(await call("driver.look"));
        draw();
    }

    function drawDriver() {
        const words = state.words.driver;
        const sentence = driverSentence(state.driver);
        const reason = state.driver?.failure ?? null;
        const box = byId("driver");
        box.hidden = sentence === null && reason === null;
        if (box.hidden) return;
        const line = byId("driver-line");
        line.hidden = sentence === null;
        line.textContent = sentence ? words[sentence] : "";
        const failure = byId("driver-failure");
        failure.hidden = reason === null;
        failure.textContent = reason ? words.failed[reason] : "";
    }

    function draw() {
        const values = state.values ?? DEFAULTS;
        drawDriver();
        byId("root").setAttribute("aria-busy", state.values === null ? "true" : "false");
        drawScreen(values);
        byId("caption").textContent = values.display === "off" ? state.words.captionOff : fill(state.words.caption, { display: state.words.displays[values.display], brightness: values.brightness });
        resize();
    }

    window.addEventListener("message", (event) => {
        if (event.source !== parentWindow) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "reply") {
            const resolve = replies.get(message.id);
            if (!resolve) return;
            replies.delete(message.id);
            resolve(message.ok === true ? message.value : null);
        } else if (message.type === "hello") {
            const root = document.documentElement;
            for (const [name, value] of tokenEntries(message.tokens)) root.style.setProperty(name, value);
            root.dataset.theme = message.theme === "light" ? "light" : "dark";
            root.lang = typeof message.locale === "string" ? message.locale.slice(0, 35) : "en";
            state.words = wordsFor(message.locale);
            draw();
        } else if (message.type === "settings") {
            state.values = readValues(message.values);
            draw();
            // Settings come after ready and after every change, a driver change that did
            // not go through included, so the driver line is looked at again each time.
            void lookDriver();
        }
    });

    new ResizeObserver(resize).observe(byId("root"));
    draw();
    parentWindow.postMessage({ type: "ready" }, "*");
}
