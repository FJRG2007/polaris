/**
 * The Install on a TV window: find the set, say what will happen, and report each
 * step as the app takes it.
 */

import { available, byId, say } from "./dom";
import { readTvAddress } from "@/shared/tv-address";
import type { TvControl, TvControlRung, TvInstallState, TvOutcome, TvPhase, TvWaiting } from "@/shared/bridge";

const STEPS: Partial<Record<TvPhase, string>> = {
    searching: "Looking for TVs on this network...",
    connecting: "Connecting to the TV...",
    allow: "On the TV, choose Allow when it asks to allow USB debugging.",
    checking: "Checking the TV...",
    backup: "Saving a backup of the TV's settings...",
    download: "Downloading Polaris TV...",
    install: "Installing...",
    home: "Making it the Home screen...",
    control: "Asking the TV for each permission...",
    closing: "Turning off debugging on the TV..."
};

const LINKING =
    "The TV now shows your Polaris on its link screen. Press OK on the remote to get the code, then scan it with your phone.";

const OUTCOMES: Record<TvOutcome, string> = {
    installed: "Polaris TV is installed. Find it among the TV's apps.",
    "installed-home": "Polaris TV is installed and is now the Home screen.",
    "installed-home-refused":
        "Polaris TV is installed, but this TV kept its own Home screen. Open Polaris TV from the TV's apps.",
    "installed-home-unknown":
        "Polaris TV is installed, but the connection was lost before Home was confirmed. Press Home on the TV to see which screen opens.",
    "installed-home-key":
        "Polaris TV is installed. This TV keeps its own Home screen, so the remote's Home button now opens Polaris TV instead.",
    "installed-home-key-off":
        "Polaris TV is installed, but the TV did not let the Home button open it. Open Polaris TV from the TV's apps, or install again.",
    "home-key-not-released":
        "This TV removes other Home screens every time it restarts, and the version of Polaris TV made for it has not been published yet. Nothing changed on the TV.",
    "adb-off":
        "Debugging was not turned on at the TV in time. Install again and follow the step shown here, or use the USB cable tab.",
    "not-allowed": "Nobody answered on the TV. Try again and choose Allow on the TV's prompt.",
    unreachable: "Nothing answered at that address. Check that the TV is on and on this network.",
    "not-android-tv":
        "This is not an Android TV or Google TV. Samsung, LG, Roku, Vizio and VIDAA sets cannot run Polaris TV.",
    "too-old": "This TV runs a version of Android older than 8.0, which Polaris TV does not support.",
    "not-released": "Polaris TV has not been published yet, so there is nothing to install. Nothing changed on the TV.",
    "download-failed": "Polaris TV could not be downloaded. Nothing changed on the TV. Check this computer's connection.",
    "key-failed": "Polaris could not save its key on this computer, so it did not contact the TV. Try again.",
    "connection-lost": "The connection to the TV was lost before anything was installed. Try again.",
    "backup-failed":
        "The backup could not be saved, so nothing was installed. Check the free space on this computer and try again.",
    "sideload-refused": "This TV refuses apps that do not come from its store. Nothing changed on it.",
    "install-failed": "The TV could not install it. Nothing else changed on it.",
    "install-interrupted":
        "The connection was lost during the install, so it may not have finished. Look for Polaris TV among the TV's apps, or try again.",
    "usb-busy":
        "The TV is plugged in, but another program is using its USB debugging. Close adb, Android Studio or scrcpy and try again. On Windows, the TV may also need the Google USB Driver.",
    "usb-gone": "The TV is no longer connected by USB. Check the cable and try again.",
    "needs-pairing":
        "This TV turns on debugging with a pairing code. On the TV, open Wireless debugging, then Pair device with pairing code, and type the six digits below while they are on screen.",
    "pairing-refused":
        "The TV did not accept that code. Open Pair device with pairing code again on the TV and type the new code it shows."
};

const RUNGS: Record<TvControlRung, string> = {
    home: "Home screen",
    "secure-settings": "Change system settings, for ad blocking and keeping its helpers on",
    "notification-listener": "Restart itself when the TV closes it",
    "install-packages": "Update itself",
    battery: "Keep running when the TV saves power"
};

const CONTROL_STATES: Record<TvControl["state"], string> = {
    got: "allowed",
    refused: "refused by this TV",
    skipped: "not tried on this TV"
};

const APP_ONLY = "Installed only as an app. Nothing else on the TV was changed.";

/** One line per level the system mode tried; the one line an app-only install changed nothing past. */
function controlLines(control: readonly TvControl[] | null | undefined): string[] {
    if (!control) return [];
    if (control.length === 0) return [APP_ONLY];
    return control.map((one) => `${RUNGS[one.rung]}: ${CONTROL_STATES[one.state]}`);
}

const HOME_RULES = {
    "app-only": "This TV keeps its own Home screen, so Polaris TV opens as an app from the TV's apps.",
    "refused-by-maker": "The Home switch stays off: on this maker's TVs it has left a set unable to start."
} as const;

/** The one thing to do on the TV while the install waits; it carries on by itself once that is done. */
function waitingText(waiting: TvWaiting | null | undefined): string | null {
    if (!waiting || waiting.step !== "debugging") return null;
    const switches = waiting.switches.join(" and ");
    const pairing = waiting.switches.includes("Wireless debugging")
        ? " If the TV offers only Wireless debugging, turn it on and press Install: this then asks for its pairing code."
        : "";
    return `On the TV, open ${waiting.about} and press OK on ${waiting.press} ${waiting.presses} times. Then in ${waiting.developer}, turn on ${switches}. This carries on by itself once it is on.${pairing}`;
}

const NOT_AN_ADDRESS = "Type the TV's address on this network, like 192.168.1.50.";
const NOT_STARTED = "The install could not start. Check the address and try again.";

const heading = byId<HTMLHeadingElement>("title");
const address = byId<HTMLInputElement>("address");
const codeField = byId<HTMLLabelElement>("code-field");
const code = byId<HTMLInputElement>("code");
const addressError = byId<HTMLParagraphElement>("address-error");
const found = byId<HTMLDivElement>("found");
const modeSystem = byId<HTMLInputElement>("mode-system");
const modeApp = byId<HTMLInputElement>("mode-app");
const control = byId<HTMLUListElement>("control");
const blockAds = byId<HTMLInputElement>("block-ads");
const find = byId<HTMLButtonElement>("find");
const start = byId<HTMLButtonElement>("start");
const step = byId<HTMLParagraphElement>("step");
const waitingNote = byId<HTMLParagraphElement>("waiting");
const homeRule = byId<HTMLParagraphElement>("home-rule");
const result = byId<HTMLParagraphElement>("result");
const backup = byId<HTMLParagraphElement>("backup");
const closed = byId<HTMLParagraphElement>("closed");
const tabNetwork = byId<HTMLButtonElement>("tab-network");
const tabUsb = byId<HTMLButtonElement>("tab-usb");
const networkPanel = byId<HTMLDivElement>("network");
const usbPanel = byId<HTMLDivElement>("usb");
const findUsb = byId<HTMLButtonElement>("find-usb");
const usbFound = byId<HTMLDivElement>("usb-found");
const usbNone = byId<HTMLParagraphElement>("usb-none");

const IDLE = new Set<TvPhase>(["ready", "done", "failed"]);
const bridge = window.polarisLocal.tv;

let notStarted = false;
let overUsb = false;
/** The address whose TV asked for a Wireless debugging pairing code. */
let codeFor: string | null = null;
/** The USB TV picked from the list, by id. */
let chosen: string | null = null;

function validAddress(): boolean {
    return readTvAddress(address.value) !== null;
}

/** The USB TV to install on: the one picked, or the only one plugged in. */
function usbTarget(state: TvInstallState): string | null {
    const listed = state.usb ?? [];
    if (chosen && listed.some((one) => one.id === chosen)) return chosen;
    return listed.length === 1 ? (listed[0]?.id ?? null) : null;
}

function addressProblem(): string | null {
    if (!address.value.trim()) return null;
    if (!validAddress()) return NOT_AN_ADDRESS;
    return notStarted ? NOT_STARTED : null;
}

/** Whether the code field is showing: the TV at this address asked for one. */
function asksCode(): boolean {
    return !overUsb && codeFor !== null && codeFor === readTvAddress(address.value);
}

function render(state: TvInstallState): void {
    const idle = IDLE.has(state.phase) && !state.usbListing;
    const pairing = asksCode();
    codeField.hidden = !pairing;
    code.disabled = !idle;
    address.disabled = !idle;
    modeSystem.disabled = !idle;
    modeApp.disabled = !idle;
    blockAds.disabled = !idle;
    // A search can be stopped from the same button that started it.
    const searching = state.phase === "searching";
    available(find, idle || searching);
    find.textContent = searching ? "Stop search" : "Find TVs";
    // A wait for the TV can be stopped from the button that started it.
    const waiting = Boolean(state.waiting);
    const codeReady = !pairing || /^\d{6}$/.test(code.value);
    available(start, waiting || (idle && codeReady && (overUsb ? usbTarget(state) !== null : validAddress())));
    start.textContent = waiting ? "Stop" : pairing ? "Pair and install" : "Install";
    say(addressError, overUsb ? null : addressProblem());
    tabNetwork.setAttribute("aria-selected", String(!overUsb));
    tabUsb.setAttribute("aria-selected", String(overUsb));
    networkPanel.hidden = overUsb;
    usbPanel.hidden = !overUsb;
    available(findUsb, idle);
    usbNone.hidden = state.usbListing || !(state.usb && state.usb.length === 0);
    const picked = usbTarget(state);
    usbFound.replaceChildren(
        ...(state.usb ?? []).map((device) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = device.name;
            button.title = device.id;
            button.setAttribute("aria-pressed", String(device.id === picked));
            button.addEventListener("click", () => {
                chosen = device.id;
                render(state);
            });
            return button;
        })
    );
    say(step, state.usbListing ? "Looking for TVs plugged in by USB..." : (STEPS[state.phase] ?? null));
    say(waitingNote, waitingText(state.waiting));
    say(homeRule, state.home && state.home !== "offered" ? HOME_RULES[state.home] : null);
    const linking = state.phase === "done" && state.linking ? ` ${LINKING}` : "";
    say(result, state.outcome ? OUTCOMES[state.outcome] + linking : null);
    const lines = state.phase === "done" ? controlLines(state.control) : [];
    control.hidden = lines.length === 0;
    control.replaceChildren(
        ...lines.map((line) => {
            const item = document.createElement("li");
            item.textContent = line;
            return item;
        })
    );
    heading.textContent = state.phase === "done" ? "Installed" : "Install on a TV";
    say(backup, state.backup ? `Backup kept on this computer: ${state.backup}` : null);
    say(
        closed,
        state.closed === null
            ? null
            : state.closed
              ? "Debugging is turned off on the TV."
              : "Debugging may still be on on this TV. Turn it off in Developer options on the TV."
    );
    found.replaceChildren(
        ...state.found.map((host) => {
            const button = document.createElement("button");
            button.type = "button";
            const name = state.named?.[host];
            button.textContent = name ? `${name} - ${host}` : host;
            button.addEventListener("click", () => {
                address.value = host;
                render(state);
            });
            return button;
        })
    );
}

let latest: TvInstallState | null = null;

/** Acts once on an outcome as it arrives, so typing afterwards is not undone by a re-render. */
function arrived(previous: TvInstallState | null, next: TvInstallState): void {
    if (next.outcome === previous?.outcome) return;
    if (next.outcome === "needs-pairing" || next.outcome === "pairing-refused") codeFor = readTvAddress(address.value);
    if (next.outcome === "pairing-refused") code.value = "";
}

bridge.onState((next) => {
    arrived(latest, next);
    latest = next;
    render(next);
});
code.addEventListener("input", () => {
    // Digits only, as the TV shows them; anything else typed or pasted is dropped.
    code.value = code.value.replace(/\D/g, "").slice(0, 6);
    if (latest) render(latest);
});
address.addEventListener("input", () => {
    notStarted = false;
    if (latest) render(latest);
});
find.addEventListener("click", () => {
    if (find.getAttribute("aria-disabled") === "true") return;
    void (latest?.phase === "searching" ? bridge.cancel() : bridge.find());
});
function showTab(usb: boolean): void {
    overUsb = usb;
    if (latest) render(latest);
    // The first look happens on its own, so a plugged-in TV is listed at once.
    if (usb && latest && latest.usb === null && IDLE.has(latest.phase)) void bridge.findUsb();
}
tabNetwork.addEventListener("click", () => showTab(false));
tabUsb.addEventListener("click", () => showTab(true));
findUsb.addEventListener("click", () => {
    if (findUsb.getAttribute("aria-disabled") === "true") return;
    void bridge.findUsb();
});
start.addEventListener("click", () => {
    if (start.getAttribute("aria-disabled") === "true") return;
    if (latest?.waiting) {
        void bridge.cancel();
        return;
    }
    const usb = latest && overUsb ? usbTarget(latest) : null;
    const mode = modeApp.checked ? "app" : "system";
    const choices = { mode, home: mode === "system", blockAds: blockAds.checked } as const;
    const input = usb ? { usb, ...choices } : { host: address.value.trim(), ...choices, ...(asksCode() ? { code: code.value } : {}) };
    void bridge.start(input).then((started) => {
        notStarted = !started;
        if (latest) render(latest);
    });
});
void bridge.state().then((state) => {
    arrived(latest, state);
    latest = state;
    render(state);
});
