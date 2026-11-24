/**
 * The Stream 100's own editor, shown in a sandboxed frame on the add-on's page
 * in Polaris (docs/device-addons.md, Views). It draws the controller - the
 * screen with what it is set to show, the four knobs and the four lit buttons -
 * and changes the same settings the list above it does, through the page:
 * `settings.set` for a change, and the page's `hello` and `settings` messages
 * for the look, the language and changes made elsewhere.
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
        knob: "Knob {n}",
        button: "Button {n}",
        display: "Screen shows",
        brightness: "Screen brightness",
        screen: "Preview of the Stream 100 screen",
        saveFailed: "That change was not saved.",
        callNote: "The people in the call show here.",
        nowPlayingNote: "What is playing shows here.",
        offNote: "The screen is off.",
        categories: { calls: "Calls", music: "Music", games: "Games", browser: "Browser", system: "System sounds", other: "Other apps", output: "Whole output", none: "Nothing" },
        actions: { none: "Nothing", "call.mic": "Mute mic", "call.deafen": "Deafen", "call.camera": "Camera", "call.share": "Share your screen", "call.hangup": "Hang up" },
        displays: { mixer: "Volume of each knob", call: "People in the call", nowPlaying: "What is playing", off: "Off" }
    },
    es: {
        knob: "Rueda {n}",
        button: "Botón {n}",
        display: "La pantalla muestra",
        brightness: "Brillo de la pantalla",
        screen: "Vista previa de la pantalla del Stream 100",
        saveFailed: "Ese cambio no se guardó.",
        callNote: "Aquí aparecen las personas de la llamada.",
        nowPlayingNote: "Aquí aparece lo que suena.",
        offNote: "La pantalla está apagada.",
        categories: { calls: "Llamadas", music: "Música", games: "Juegos", browser: "Navegador", system: "Sonidos del sistema", other: "Otras apps", output: "Toda la salida", none: "Nada" },
        actions: { none: "Nada", "call.mic": "Silenciar", "call.deafen": "Sin audio", "call.camera": "Cámara", "call.share": "Compartir pantalla", "call.hangup": "Colgar" },
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

/** What one control's choice is stored as: a button set to nothing is null, the brightness a number. */
function storedValue(key, value) {
    if (BUTTONS.includes(key)) return value === "none" ? null : value;
    if (key === "brightness") return Number(value);
    return value;
}

/** Only the tokens the page hands over that are custom properties; anything else is dropped. */
function tokenEntries(tokens) {
    if (!tokens || typeof tokens !== "object") return [];
    return Object.entries(tokens).filter(([name, value]) => /^--[a-z0-9-]{1,40}$/.test(name) && typeof value === "string" && value.length <= 400);
}

function fill(text, values) {
    return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match));
}

if (typeof module !== "undefined") module.exports = { wordsFor, readValues, storedValue, tokenEntries, DEFAULTS };

if (typeof document !== "undefined") {
    const state = { words: WORDS.en, values: null, nextId: 1 };
    const pending = new Map();
    const parentWindow = window.parent;
    const byId = (id) => document.getElementById(id);
    const post = (message) => parentWindow.postMessage(message, "*");
    const resize = () => post({ type: "resize", height: Math.ceil(document.documentElement.scrollHeight) });

    function call(method, params) {
        const id = state.nextId++;
        post({ type: "call", id, method, params });
        return new Promise((resolve) => pending.set(id, resolve));
    }

    function option(select, value, label) {
        const item = document.createElement("option");
        item.value = value;
        item.textContent = label;
        select.append(item);
    }

    function control(kind, index, key, choices, labels) {
        const current = (state.values ?? DEFAULTS)[key];
        const card = document.createElement("div");
        card.className = "control";
        const shape = document.createElement("div");
        shape.className = kind;
        if (kind === "button" && current !== "none") shape.classList.add("lit");
        shape.setAttribute("aria-hidden", "true");
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = fill(state.words[kind], { n: index + 1 });
        const select = document.createElement("select");
        for (const value of choices) option(select, value, labels[value]);
        select.value = current;
        select.disabled = state.values === null;
        select.setAttribute("aria-label", title.textContent);
        select.addEventListener("change", () => void change(key, select.value));
        card.append(shape, title, select);
        return card;
    }

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
        const words = state.words;
        const loading = state.values === null;
        byId("root").setAttribute("aria-busy", loading ? "true" : "false");
        byId("display-label").textContent = words.display;
        byId("brightness-label").textContent = words.brightness;
        const display = byId("display");
        display.replaceChildren();
        for (const value of DISPLAYS) option(display, value, words.displays[value]);
        display.value = values.display;
        display.disabled = loading;
        const brightness = byId("brightness");
        brightness.value = String(values.brightness);
        brightness.disabled = loading;
        byId("knobs").replaceChildren(...KNOBS.map((key, index) => control("knob", index, key, CATEGORIES, words.categories)));
        byId("buttons").replaceChildren(...BUTTONS.map((key, index) => control("button", index, key, ACTIONS, words.actions)));
        drawScreen(values);
        resize();
    }

    /** Shown at once, and put back when the app refuses it. */
    async function change(key, raw) {
        if (state.values === null) return;
        const before = state.values;
        const drawn = key === "brightness" ? Number(raw) : raw;
        if (before[key] === drawn) return;
        state.values = { ...before, [key]: drawn };
        byId("error").hidden = true;
        draw();
        const reply = await call("settings.set", { key, value: storedValue(key, raw) });
        if (reply && reply.ok) {
            state.values = readValues(reply.value);
        } else {
            state.values = before;
            byId("error").textContent = state.words.saveFailed;
            byId("error").hidden = false;
        }
        draw();
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
        } else if (message.type === "reply" && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    });

    byId("display").addEventListener("change", () => void change("display", byId("display").value));
    byId("brightness").addEventListener("change", () => void change("brightness", byId("brightness").value));
    new ResizeObserver(resize).observe(document.body);
    draw();
    post({ type: "ready" });
}
