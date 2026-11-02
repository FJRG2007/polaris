/**
 * The Install on a TV window: find the set, say what will happen, and report each
 * step as the app takes it.
 */

import { available, byId, say } from "./dom";
import type { TvInstallState, TvOutcome, TvPhase } from "@/shared/bridge";

const STEPS: Partial<Record<TvPhase, string>> = {
    searching: "Looking for TVs on this network...",
    connecting: "Connecting to the TV...",
    allow: "On the TV, choose Allow on the debugging prompt.",
    checking: "Checking the TV...",
    backup: "Saving a backup of the TV's settings...",
    download: "Downloading Polaris TV...",
    install: "Installing...",
    home: "Making it the Home screen...",
    closing: "Closing network debugging on the TV..."
};

const OUTCOMES: Record<TvOutcome, string> = {
    installed: "Polaris TV is installed. Find it among the TV's apps.",
    "installed-home": "Polaris TV is installed and is now the Home screen.",
    "installed-home-refused":
        "Polaris TV is installed, but this TV kept its own Home screen. Open Polaris TV from the TV's apps.",
    "adb-off":
        "The TV refused the connection. On the TV, open Settings, About, press Build 7 times, then turn on USB debugging and Network debugging in Developer options.",
    "not-allowed": "Nobody answered on the TV. Try again and choose Allow on the TV's prompt.",
    unreachable: "Nothing answered at that address. Check that the TV is on and on this network.",
    "not-android-tv":
        "This is not an Android TV or Google TV. Samsung, LG, Roku, Vizio and VIDAA sets cannot run Polaris TV.",
    "too-old": "This TV runs a version of Android older than 8.0, which Polaris TV does not support.",
    "not-released": "Polaris TV has not been published yet, so there is nothing to install. Nothing changed on the TV.",
    "download-failed": "Polaris TV could not be downloaded. Nothing changed on the TV. Check this computer's connection.",
    "sideload-refused": "This TV refuses apps that do not come from its store. Nothing changed on it.",
    "install-failed": "The TV could not install it. Nothing else changed on it."
};

const heading = byId<HTMLHeadingElement>("title");
const address = byId<HTMLInputElement>("address");
const found = byId<HTMLDivElement>("found");
const home = byId<HTMLInputElement>("home");
const find = byId<HTMLButtonElement>("find");
const start = byId<HTMLButtonElement>("start");
const step = byId<HTMLParagraphElement>("step");
const result = byId<HTMLParagraphElement>("result");
const backup = byId<HTMLParagraphElement>("backup");
const closed = byId<HTMLParagraphElement>("closed");

const IDLE = new Set<TvPhase>(["ready", "done", "failed"]);
const bridge = window.polarisLocal.tv;

function validAddress(): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(address.value.trim());
}

function render(state: TvInstallState): void {
    const idle = IDLE.has(state.phase);
    address.disabled = !idle;
    home.disabled = !idle;
    available(find, idle);
    available(start, idle && validAddress());
    say(step, STEPS[state.phase] ?? null);
    say(result, state.outcome ? OUTCOMES[state.outcome] : null);
    heading.textContent = state.phase === "done" ? "Installed" : "Install on a TV";
    say(backup, state.backup ? `Backup kept on this computer: ${state.backup}` : null);
    say(
        closed,
        state.closed === null
            ? null
            : state.closed
              ? "Network debugging is closed on the TV."
              : "Network debugging is still open on this TV. Turn it off in Developer options on the TV."
    );
    found.replaceChildren(
        ...state.found.map((host) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = host;
            button.addEventListener("click", () => {
                address.value = host;
                render(state);
            });
            return button;
        })
    );
}

let latest: TvInstallState | null = null;
bridge.onState((next) => {
    latest = next;
    render(next);
});
address.addEventListener("input", () => {
    if (latest) render(latest);
});
find.addEventListener("click", () => {
    if (find.getAttribute("aria-disabled") !== "true") void bridge.find();
});
start.addEventListener("click", () => {
    if (start.getAttribute("aria-disabled") === "true") return;
    void bridge.start({ host: address.value.trim(), home: home.checked });
});
void bridge.state().then((state) => {
    latest = state;
    render(state);
});
