/**
 * The settings window: the first run, File > Settings, and where a window that
 * could not load comes back to with the reason.
 *
 * Every server this app has opened is a row: pressing Open puts it in front,
 * the pencil names it and the bin takes it off the list. Below, the form adds
 * another. The address is checked as it is typed against the same schema the
 * main process keeps it with. An empty field is incomplete rather than wrong,
 * so it only disables the button; the reason something is not an address
 * appears once there is text. A well-formed address is then asked whether it
 * is a Polaris, 400 ms after typing pauses, and Open stays off until it is.
 * An address already on the list says so at once and is never asked about:
 * its row is the way to open it. The name is optional and kept with the
 * address, so the row reads "Home" instead of the host.
 */

import { available, byId, say } from "./dom";
import { serverAddressSchema } from "@/shared/server-address";
import { describeUpdateCheck } from "@/shared/update-check";
import { describeServer, normalizeServerName, SERVER_NAME_MAX, type ServerRow } from "@/shared/servers";
import { encodeHostList, HOST_LIST_PREFIX } from "../../../dashboard/packages/core/src/host-list";
import { encodeQr, qrSvgPath } from "../../../dashboard/packages/core/src/qr";
import type { HostImport } from "@/shared/bridge";
import jsQR from "jsqr";

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("address");
const nameInput = byId<HTMLInputElement>("name");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("address-note");
const list = byId<HTMLUListElement>("server-list");
const title = byId<HTMLHeadingElement>("title");
const tabs = byId<HTMLElement>("tabs");
const serversPage = byId<HTMLElement>("servers-page");
const generalPage = byId<HTMLElement>("general-page");
const advancedPage = byId<HTMLElement>("advanced-page");
const showAdd = byId<HTMLButtonElement>("show-add");
const hideAdd = byId<HTMLButtonElement>("hide-add");
const removeDialog = byId<HTMLDialogElement>("confirm-remove");
const removeTitle = byId<HTMLParagraphElement>("remove-title");
const openAtLogin = byId<HTMLInputElement>("open-at-login");
const hardwareAcceleration = byId<HTMLInputElement>("hardware-acceleration");
const toggles = {
    minimizeToTray: byId<HTMLInputElement>("minimize-to-tray"),
    startMinimized: byId<HTMLInputElement>("start-minimized"),
    voiceWidget: byId<HTMLInputElement>("voice-widget"),
    voiceWidgetGameOnly: byId<HTMLInputElement>("voice-widget-game-only")
} as const;
const restartDialog = byId<HTMLDialogElement>("confirm-restart");
const restartFailure = byId<HTMLParagraphElement>("restart-failure");
const restartPending = byId<HTMLElement>("restart-pending");
const hint = note.textContent ?? "";

let busy = false;
/** How many servers are listed; null until the first answer. */
let known: number | null = null;
/** The hosts listed, so a typed address already among them is caught as it is typed. */
let rows: readonly ServerRow[] = [];
let removing: ServerRow | null = null;

/** How long the field waits after the last keystroke before it asks. */
const ASK_AFTER_MS = 400;
/** The address the live check last found to be a Polaris. */
let confirmed: string | null = null;
/** Which question an answer belongs to, so a slow one never lands on a newer address. */
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The address when it can be opened: well-formed, and found to be a Polaris. */
function check(): string | null {
    const text = input.value;
    const parsed = serverAddressSchema.safeParse(text);
    if (!parsed.success) {
        const problem = text.trim() ? (parsed.error.issues[0]?.message ?? null) : null;
        input.setAttribute("aria-invalid", String(Boolean(problem)));
        note.textContent = problem ?? hint;
        note.className = problem ? "error" : "hint";
        available(submit, false);
        return null;
    }
    const listed = rows.find((row) => row.origin === parsed.data);
    if (listed) {
        // Typed again with another name, it is a rename: the host is already
        // there, so the form saves the name instead of refusing it.
        const typedName = normalizeServerName(nameInput.value);
        const renaming = typedName !== null && typedName !== listed.name;
        input.setAttribute("aria-invalid", String(!renaming));
        note.textContent = renaming
            ? `Already on your list as ${describeServer(listed)}. Save to rename it.`
            : `Already on your list as ${describeServer(listed)}.`;
        note.className = renaming ? "hint" : "error";
        if (!busy) submit.textContent = renaming ? "Save name" : "Open";
        available(submit, renaming && !busy);
        return renaming ? parsed.data : null;
    }
    if (!busy) submit.textContent = "Open";
    const found = confirmed === parsed.data;
    available(submit, found && !busy);
    return found ? parsed.data : null;
}

/** Ask the main process whether the address in the field is a Polaris. */
function ask(): void {
    clearTimeout(timer);
    const ticket = (asked += 1);
    const parsed = serverAddressSchema.safeParse(input.value);
    if (!parsed.success || confirmed === parsed.data) return;
    if (rows.some((row) => row.origin === parsed.data)) return;
    const origin = parsed.data;
    confirmed = null;
    input.setAttribute("aria-invalid", "false");
    note.textContent = `Checking ${new URL(origin).host}...`;
    note.className = "hint";
    timer = setTimeout(() => {
        void window.polarisLocal.connect
            .check(origin)
            .catch(() => null)
            .then((answer) => {
                if (ticket !== asked || !answer || answer.message === null) return;
                if (answer.ok) confirmed = origin;
                input.setAttribute("aria-invalid", String(!answer.ok));
                note.textContent = answer.message;
                note.className = answer.ok ? "found" : "error";
                check();
            });
    }, ASK_AFTER_MS);
}

const SVG = "http://www.w3.org/2000/svg";

/** A 16-pixel stroke icon from path data, the way the dashboard draws its own. */
function icon(...paths: string[]): SVGSVGElement {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of paths) {
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", d);
        svg.append(path);
    }
    return svg;
}

const PENCIL = ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"];
const BIN = ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"];

function iconButton(label: string, paths: string[], onPress: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(icon(...paths));
    button.addEventListener("click", onPress);
    return button;
}

function textButton(label: string, onPress: () => void, primary = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", onPress);
    return button;
}

/** Run one request from a row, showing what it says when it refuses. */
async function act(run: () => Promise<{ ok: boolean; error?: string; }>): Promise<void> {
    if (busy) return;
    busy = true;
    say(failure, null);
    try {
        const outcome = await run();
        if (!outcome.ok) say(failure, outcome.error ?? "Something went wrong. Try again.");
    } catch {
        say(failure, "Something went wrong. Try again.");
    } finally {
        busy = false;
        await refresh();
    }
}

function viewRow(server: ServerRow, row: HTMLLIElement): void {
    const label = describeServer(server);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "server-open";
    open.title = server.active ? server.origin : `Open ${label}`;
    if (server.active) open.setAttribute("aria-current", "true");
    const names = document.createElement("span");
    names.className = "names";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label;
    const where = document.createElement("span");
    where.className = "host";
    where.textContent = server.name ? server.host : "";
    names.append(name, where);
    open.append(names);
    if (server.active) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "In use";
        open.append(badge);
    }
    open.addEventListener("click", () => {
        if (server.active) return;
        where.textContent = "Checking...";
        void act(() => window.polarisLocal.connect.switchTo(server.origin));
    });
    const acts = document.createElement("div");
    acts.className = "acts";
    acts.append(
        // A host with no name says so in words: a pencil alone was easy to miss.
        server.name
            ? iconButton(`Rename ${label}`, PENCIL, () => editRow(server, row))
            : textButton("Add a name", () => editRow(server, row)),
        iconButton(`Remove ${label}`, BIN, () => askRemove(server))
    );
    row.replaceChildren(open, acts);
}

/** The row as a name field: Enter or Save keeps it, Escape or Cancel leaves it. */
function editRow(server: ServerRow, row: HTMLLIElement): void {
    const field = document.createElement("input");
    field.type = "text";
    field.value = server.name ?? "";
    field.placeholder = server.host;
    field.maxLength = SERVER_NAME_MAX;
    field.setAttribute("aria-label", `Name for ${server.host}`);
    const save = () => {
        const name = normalizeServerName(field.value) ?? "";
        void act(() => window.polarisLocal.connect.rename(server.origin, name));
    };
    field.addEventListener("keydown", (event) => {
        if (event.key === "Enter") save();
        if (event.key !== "Escape") return;
        // The row's own Escape, not the sheet's.
        event.preventDefault();
        viewRow(server, row);
    });
    row.replaceChildren(field, textButton("Save", save, true), textButton("Cancel", () => viewRow(server, row)));
    field.focus();
    field.select();
}

/** Asked first and named, as in the extension. Cancel has the focus. */
function askRemove(server: ServerRow): void {
    removing = server;
    removeTitle.textContent = `Remove ${describeServer(server)}?`;
    removeDialog.showModal();
    byId<HTMLButtonElement>("remove-cancel").focus();
}

/** With a list the field is one press away; with none, it is the whole screen. */
function showForm(shown: boolean): void {
    form.hidden = !shown;
    showAdd.hidden = shown || known === 0;
    hideAdd.hidden = known === 0;
    if (shown) input.focus();
}

type Page = "servers" | "general" | "advanced";

const PAGES: Record<Page, HTMLElement> = { servers: serversPage, general: generalPage, advanced: advancedPage };

function showPage(shown: Page): void {
    for (const [page, element] of Object.entries(PAGES)) {
        element.hidden = page !== shown;
        byId(`tab-${page}`).setAttribute("aria-selected", String(page === shown));
    }
}

function draw(servers: readonly ServerRow[]): void {
    const first = known === null;
    known = servers.length;
    rows = servers;
    list.hidden = servers.length === 0;
    // Exporting needs something to export; taking a list in never does.
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-needs-hosts]")) {
        button.hidden = servers.length === 0;
    }
    tabs.hidden = servers.length === 0;
    title.textContent = servers.length === 0 ? "Open your Polaris" : "Polaris";
    if (first || servers.length === 0) showForm(servers.length === 0);
    list.replaceChildren(
        ...servers.map((server) => {
            const row = document.createElement("li");
            row.className = "server";
            row.dataset.active = String(server.active);
            viewRow(server, row);
            return row;
        })
    );
    // A host removed or added changes what the typed address is.
    check();
    ask();
}

async function refresh(): Promise<void> {
    const state = await window.polarisLocal.connect.state().catch(() => null);
    draw(state?.servers ?? []);
}

// Laid over the Polaris window: Escape, the cross or a press beside the card
// puts it away.
if (new URLSearchParams(location.search).has("sheet")) {
    const closeSheet = () => void window.polarisLocal.connect.close().catch(() => undefined);
    document.body.classList.add("sheet");
    const cross = byId<HTMLButtonElement>("close-sheet");
    cross.hidden = false;
    cross.addEventListener("click", closeSheet);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) closeSheet();
    });
    document.body.addEventListener("mousedown", (event) => {
        if (event.target === document.body) closeSheet();
    });
}

// ---- Moving the list to and from another device ----

const transferNote = byId<HTMLParagraphElement>("transfer-note");
const qrDialog = byId<HTMLDialogElement>("qr-dialog");
const scanDialog = byId<HTMLDialogElement>("scan-dialog");
const scanVideo = byId<HTMLVideoElement>("scan-video");
const scanNote = byId<HTMLParagraphElement>("scan-note");
const pasteDialog = byId<HTMLDialogElement>("paste-dialog");
const pasteText = byId<HTMLTextAreaElement>("paste-text");
const pasteError = byId<HTMLParagraphElement>("paste-error");
const pasteConfirm = byId<HTMLButtonElement>("paste-confirm");

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** What a list taken in did, in one line; null when it was cancelled. */
function describeImport(outcome: HostImport): string | null {
    if (!outcome.ok) return outcome.error;
    const parts: string[] = [];
    if (outcome.added) parts.push(`${plural(outcome.added, "host", "hosts")} added`);
    if (outcome.named) parts.push(`${plural(outcome.named, "host", "hosts")} named`);
    if (outcome.skipped) parts.push(`${outcome.skipped} left out: the list is full`);
    return parts.length ? `${parts.join(", ")}.` : "Every host in it was already on your list.";
}

async function afterImport(outcome: HostImport): Promise<void> {
    say(transferNote, describeImport(outcome));
    if (outcome.ok) await refresh();
}

function showQr(): void {
    const modules = encodeQr(encodeHostList(rows));
    const svg = byId<HTMLElement>("qr-code") as unknown as SVGSVGElement;
    byId("qr-too-long").hidden = modules !== null;
    svg.style.display = modules ? "" : "none";
    if (modules) {
        const { path, size } = qrSvgPath(modules);
        svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
        const drawn = document.createElementNS(SVG, "path");
        drawn.setAttribute("d", path);
        drawn.setAttribute("fill", "#000000");
        svg.replaceChildren(drawn);
    }
    qrDialog.showModal();
}

let scanStream: MediaStream | null = null;
let scanFrame = 0;

function stopScan(): void {
    cancelAnimationFrame(scanFrame);
    for (const track of scanStream?.getTracks() ?? []) track.stop();
    scanStream = null;
    scanVideo.srcObject = null;
    if (scanDialog.open) scanDialog.close();
}

/** Read frames until one holds a list of hosts; anything else is ignored. */
function readFrames(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const frame = () => {
        if (!scanStream || !context) return;
        if (scanVideo.readyState >= scanVideo.HAVE_CURRENT_DATA && scanVideo.videoWidth > 0) {
            canvas.width = scanVideo.videoWidth;
            canvas.height = scanVideo.videoHeight;
            context.drawImage(scanVideo, 0, 0);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            const found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
            if (found?.data.startsWith(HOST_LIST_PREFIX)) {
                stopScan();
                void window.polarisLocal.connect.importHosts(found.data).then(afterImport, () => undefined);
                return;
            }
            if (found) say(scanNote, "That QR is not a list of Polaris hosts.");
        }
        scanFrame = requestAnimationFrame(frame);
    };
    scanFrame = requestAnimationFrame(frame);
}

async function startScan(): Promise<void> {
    say(transferNote, null);
    say(scanNote, "Hold the other device's QR up to the camera.");
    scanDialog.showModal();
    try {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
        say(scanNote, "Polaris could not use a camera. Check that one is connected and allowed, or use Paste code.");
        return;
    }
    if (!scanDialog.open) {
        stopScan();
        return;
    }
    scanVideo.srcObject = scanStream;
    await scanVideo.play().catch(() => undefined);
    readFrames(document.createElement("canvas"));
}

function checkPaste(): boolean {
    const text = pasteText.value.trim();
    available(pasteConfirm, text !== "");
    return text !== "";
}

async function confirmPaste(): Promise<void> {
    if (!checkPaste()) return;
    const outcome = await window.polarisLocal.connect.importHosts(pasteText.value).catch(() => null);
    if (!outcome || !outcome.ok) {
        say(pasteError, outcome?.error ?? "Something went wrong. Try again.");
        return;
    }
    pasteDialog.close();
    await afterImport(outcome);
}

byId("hosts-qr").addEventListener("click", showQr);
byId("qr-close").addEventListener("click", () => qrDialog.close());
byId("hosts-scan").addEventListener("click", () => void startScan());
byId("scan-cancel").addEventListener("click", stopScan);
scanDialog.addEventListener("close", stopScan);
byId("hosts-copy").addEventListener("click", () => {
    void window.polarisLocal.connect.copyHosts().then(
        (copied) => say(transferNote, copied.ok ? `Code for ${plural(copied.count, "host", "hosts")} copied. Paste it on the other device.` : "Polaris could not copy the code."),
        () => say(transferNote, "Polaris could not copy the code.")
    );
});
byId("hosts-paste").addEventListener("click", () => {
    say(transferNote, null);
    pasteText.value = "";
    say(pasteError, null);
    checkPaste();
    pasteDialog.showModal();
    pasteText.focus();
});
pasteText.addEventListener("input", () => {
    say(pasteError, null);
    checkPaste();
});
byId("paste-cancel").addEventListener("click", () => pasteDialog.close());
pasteConfirm.addEventListener("click", () => void confirmPaste());
byId("hosts-export").addEventListener("click", () => {
    say(transferNote, null);
    void window.polarisLocal.connect.exportHostsFile().then(
        (outcome) => say(transferNote, outcome.ok ? "Hosts exported." : outcome.error),
        () => say(transferNote, "Something went wrong. Try again.")
    );
});
byId("hosts-import").addEventListener("click", () => {
    say(transferNote, null);
    void window.polarisLocal.connect.importHostsFile().then(afterImport, () =>
        say(transferNote, "Something went wrong. Try again.")
    );
});

showAdd.addEventListener("click", () => showForm(true));
hideAdd.addEventListener("click", () => showForm(false));
byId("tab-servers").addEventListener("click", () => showPage("servers"));
byId("tab-general").addEventListener("click", () => showPage("general"));
byId("tab-advanced").addEventListener("click", () => showPage("advanced"));
byId("remove-cancel").addEventListener("click", () => removeDialog.close());
byId("remove-confirm").addEventListener("click", () => {
    const server = removing;
    removeDialog.close();
    if (server) void act(() => window.polarisLocal.connect.remove(server.origin));
});
openAtLogin.addEventListener("change", () => {
    const wanted = openAtLogin.checked;
    say(failure, null);
    void window.polarisLocal.connect
        .setOpenAtLogin(wanted)
        .catch(() => false)
        .then((applied) => {
            if (applied) return;
            openAtLogin.checked = !wanted;
            say(failure, "Polaris could not change this on this computer.");
        });
});
/** "Only while a game is running" means nothing with the widget off. */
function followVoiceWidget(): void {
    toggles.voiceWidgetGameOnly.disabled = !toggles.voiceWidget.checked;
}
for (const [name, input] of Object.entries(toggles) as [keyof typeof toggles, HTMLInputElement][]) {
    input.addEventListener("change", () => {
        const wanted = input.checked;
        say(failure, null);
        followVoiceWidget();
        void window.polarisLocal.connect
            .setToggle(name, wanted)
            .catch(() => false)
            .then((kept) => {
                if (kept) return;
                input.checked = !wanted;
                followVoiceWidget();
                say(failure, "Polaris could not save this setting. Try again.");
            });
    });
}
/** Close and open the app again; on a refusal, say why where the press was. */
function relaunch(): void {
    say(restartFailure, null);
    void window.polarisLocal.connect
        .relaunch()
        .catch(() => ({ ok: false, error: "Polaris could not restart. Close it and open it again." }) as const)
        .then((outcome) => {
            if (outcome.ok) return;
            if (restartDialog.open) say(restartFailure, outcome.error);
            else say(failure, outcome.error);
        });
}
hardwareAcceleration.addEventListener("change", () => {
    const wanted = hardwareAcceleration.checked;
    say(failure, null);
    void window.polarisLocal.connect
        .setHardwareAcceleration(wanted)
        .catch(() => false)
        .then(async (kept) => {
            if (!kept) {
                hardwareAcceleration.checked = !wanted;
                say(failure, "Polaris could not save this setting. Try again.");
                return;
            }
            const preferences = await window.polarisLocal.connect.preferences().catch(() => null);
            const pending = preferences?.restartPending ?? true;
            restartPending.hidden = !pending;
            // Turned back to what this run already uses: nothing to restart for.
            if (!pending) return;
            say(restartFailure, null);
            restartDialog.showModal();
        });
});
byId("restart-later").addEventListener("click", () => restartDialog.close());
byId("restart-now").addEventListener("click", relaunch);
byId("restart-pending-now").addEventListener("click", relaunch);
void window.polarisLocal.connect.preferences().catch(() => null).then((preferences) => {
    if (!preferences) return;
    openAtLogin.checked = preferences.openAtLogin;
    hardwareAcceleration.checked = preferences.hardwareAcceleration;
    toggles.minimizeToTray.checked = preferences.minimizeToTray;
    toggles.startMinimized.checked = preferences.startMinimized;
    toggles.voiceWidget.checked = preferences.voiceWidget;
    toggles.voiceWidgetGameOnly.checked = preferences.voiceWidgetGameOnly;
    followVoiceWidget();
    restartPending.hidden = !preferences.restartPending;
    byId("version").textContent = `Polaris ${preferences.version}`;
});

const checkUpdates = byId<HTMLButtonElement>("check-updates");
const restartUpdate = byId<HTMLButtonElement>("restart-update");
const updatePage = byId<HTMLButtonElement>("update-page");
const updateStatus = byId<HTMLParagraphElement>("update-status");
checkUpdates.addEventListener("click", () => {
    if (checkUpdates.getAttribute("aria-disabled") === "true") return;
    available(checkUpdates, false);
    restartUpdate.hidden = true;
    updatePage.hidden = true;
    updateStatus.className = "hint";
    updateStatus.textContent = "Checking for updates...";
    void window.polarisLocal.connect
        .checkForUpdates()
        .catch(() => ({ kind: "failed", reason: "Polaris did not answer." }) as const)
        .then((found) => {
            updateStatus.textContent = describeUpdateCheck(found);
            updateStatus.className = found.kind === "failed" ? "error" : "hint";
            restartUpdate.hidden = found.kind !== "ready";
            updatePage.hidden = found.kind !== "available";
            available(checkUpdates, true);
        });
});
updatePage.addEventListener("click", () => {
    void window.polarisLocal.connect
        .openUpdatePage()
        .catch(() => false)
        .then((opened) => {
            if (opened) return;
            updateStatus.textContent = "The download page could not be opened. Check for updates again.";
            updateStatus.className = "error";
        });
});
restartUpdate.addEventListener("click", () => {
    void window.polarisLocal.connect
        .restartToUpdate()
        .catch(() => ({ ok: false, error: "Polaris could not restart. Close it and open it again." }))
        .then((outcome) => {
            if (outcome.ok) return;
            updateStatus.textContent = outcome.error ?? "Polaris could not restart. Close it and open it again.";
            updateStatus.className = "error";
        });
});

nameInput.maxLength = SERVER_NAME_MAX;
input.addEventListener("input", () => {
    say(failure, null);
    check();
    ask();
});

nameInput.addEventListener("input", () => check());

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = check();
    if (!address || busy) return;
    if (rows.some((row) => row.origin === address)) {
        const name = normalizeServerName(nameInput.value) ?? "";
        void act(() => window.polarisLocal.connect.rename(address, name)).then(() => {
            if (failure.hidden) {
                input.value = "";
                nameInput.value = "";
                check();
                if (known) showForm(false);
            }
        });
        return;
    }
    busy = true;
    submit.textContent = "Checking...";
    check();
    let added = false;
    void window.polarisLocal.connect
        .submit(input.value, normalizeServerName(nameInput.value) ?? "")
        .then((result) => {
            added = result.ok;
            if (!result.ok) say(failure, result.error);
        })
        .catch(() => say(failure, "Something went wrong. Try again."))
        .finally(async () => {
            busy = false;
            submit.textContent = "Open";
            // Emptied before the list comes back, so the address just added is
            // not then read as one already on it.
            if (added) {
                input.value = "";
                nameInput.value = "";
            }
            check();
            await refresh();
            if (added && known) showForm(false);
        });
});

void window.polarisLocal.connect.state().then((state) => {
    const servers = state?.servers ?? [];
    // The first run has nothing to list, so the field starts with the address
    // in use; once there is a list, that address is a row and the field is for
    // another one.
    if (state?.address && !input.value && servers.length === 0) input.value = state.address;
    say(failure, state?.error ?? null);
    draw(servers);
    check();
    ask();
});
