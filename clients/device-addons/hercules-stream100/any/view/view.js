/**
 * A preview of the Stream 100's screen, shown in a sandboxed frame on the
 * add-on's page in Polaris (docs/device-addons.md, Views): what the screen is
 * set to show, at its brightness, with the name of what each knob turns. It
 * shows, it does not ask - every control is a declared setting that Polaris
 * draws with its own components around it. The page's `hello` and `settings`
 * messages bring the look, the language and every change.
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

if (typeof module !== "undefined") module.exports = { wordsFor, readValues, tokenEntries, fill, DEFAULTS };

if (typeof document !== "undefined") {
    const state = { words: WORDS.en, values: null };
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

    function draw() {
        const values = state.values ?? DEFAULTS;
        byId("root").setAttribute("aria-busy", state.values === null ? "true" : "false");
        drawScreen(values);
        byId("caption").textContent = values.display === "off" ? state.words.captionOff : fill(state.words.caption, { display: state.words.displays[values.display], brightness: values.brightness });
        resize();
    }

    window.addEventListener("message", (event) => {
        if (event.source !== parentWindow) return;
        const message = event.data;
        if (!message || typeof message !== "object") return;
        if (message.type === "hello") {
            const root = document.documentElement;
            for (const [name, value] of tokenEntries(message.tokens)) root.style.setProperty(name, value);
            root.dataset.theme = message.theme === "light" ? "light" : "dark";
            root.lang = typeof message.locale === "string" ? message.locale.slice(0, 35) : "en";
            state.words = wordsFor(message.locale);
            draw();
        } else if (message.type === "settings") {
            state.values = readValues(message.values);
            draw();
        }
    });

    new ResizeObserver(resize).observe(byId("root"));
    draw();
    parentWindow.postMessage({ type: "ready" }, "*");
}
