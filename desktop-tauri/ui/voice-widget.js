// The voice widget's page (`desktop/src/renderer/voice-widget.ts`): one row per
// person in the call - a face with their initials, their name, a ring while
// they talk, and whether they are muted or deafened - and, while unlocked,
// mute, deafen and leave. What to draw comes from the app as
// `polaris://widget-view`; each person's initials and color are worked out
// by the app (`polaris_client::voice_widget`) and handed over with them.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

/** The most rows drawn before the widget says how many more there are (`MAX_ROWS`). */
const MAX_ROWS = 8;

const ICONS = {
    mic: ["M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z", "M19 10v2a7 7 0 0 1-14 0v-2", "M12 19v3"],
    micOff: [
        "M2 2l20 20",
        "M18.89 13.23A7.12 7.12 0 0 0 19 12v-2",
        "M5 10v2a7 7 0 0 0 12 5",
        "M15 9.34V5a3 3 0 0 0-5.68-1.33",
        "M9 9v3a3 3 0 0 0 5.12 2.12",
        "M12 19v3"
    ],
    headphones: [
        "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"
    ],
    headphonesOff: [
        "M21 14h-1.343",
        "M9.128 3.47A9 9 0 0 1 21 12v3.343",
        "M2 2l20 20",
        "M20.414 20.414A2 2 0 0 1 19 21h-1a2 2 0 0 1-2-2v-3",
        "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 2.636-6.364"
    ],
    leave: [
        "M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91",
        "M22 2L2 22"
    ]
};

const SVG = "http://www.w3.org/2000/svg";

function icon(name) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ICONS[name]) {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", d);
        svg.append(path);
    }
    return svg;
}

const panel = document.getElementById("panel");
const people = document.getElementById("people");
const controls = document.getElementById("controls");
const mic = document.getElementById("mic");
const deafen = document.getElementById("deafen");
const leave = document.getElementById("leave");
const lockHint = document.getElementById("lock-hint");
let unlocked = false;

function label(button, text) {
    button.title = text;
    button.setAttribute("aria-label", text);
}

leave.replaceChildren(icon("leave"));
label(leave, "Leave the call");

function row(person) {
    const line = document.createElement("div");
    line.className = "row";
    const face = document.createElement("span");
    face.className = person.speaking ? "face speaking" : "face";
    face.style.background = person.color;
    face.textContent = person.initials;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = person.name || "Guest";
    name.title = name.textContent;
    const state = document.createElement("span");
    state.className = "state";
    if (person.muted) state.append(icon("micOff"));
    if (person.deafened) state.append(icon("headphonesOff"));
    line.append(face, name, state);
    return line;
}

function draw(view) {
    if (!view) {
        people.replaceChildren();
        controls.hidden = true;
        unlocked = false;
        return;
    }
    const { participants, selfMuted, selfDeafened } = view.state;
    const rows = participants.slice(0, MAX_ROWS).map(row);
    if (participants.length > MAX_ROWS) {
        const more = document.createElement("div");
        more.className = "row more";
        more.textContent = `and ${participants.length - MAX_ROWS} more`;
        rows.push(more);
    }
    people.replaceChildren(...rows);
    unlocked = view.unlocked;
    panel.classList.toggle("unlocked", view.unlocked);
    controls.hidden = !view.unlocked;
    mic.replaceChildren(icon(selfMuted ? "micOff" : "mic"));
    mic.classList.toggle("on", selfMuted);
    label(mic, selfMuted ? "Unmute" : "Mute");
    deafen.replaceChildren(icon(selfDeafened ? "headphonesOff" : "headphones"));
    deafen.classList.toggle("on", selfDeafened);
    label(deafen, selfDeafened ? "Undeafen" : "Deafen");
    lockHint.textContent = view.lockKey ? `${view.lockKey} to lock` : "";
}

function press(action) {
    invoke("voice_widget_act", { input: action }).catch(() => false);
}

mic.addEventListener("click", () => press("mic"));
deafen.addEventListener("click", () => press("deafen"));
leave.addEventListener("click", () => press("leave"));

// Unlocked, the panel drags the window; the buttons stay buttons.
panel.addEventListener("mousedown", (event) => {
    if (!unlocked || event.button !== 0 || event.target.closest("button")) return;
    getCurrentWindow()
        .startDragging()
        .catch(() => undefined);
});

listen("polaris://widget-view", (event) => draw(event.payload));
