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
const showAdd = byId<HTMLButtonElement>("show-add");
const hideAdd = byId<HTMLButtonElement>("hide-add");
const removeDialog = byId<HTMLDialogElement>("confirm-remove");
const removeTitle = byId<HTMLParagraphElement>("remove-title");
const openAtLogin = byId<HTMLInputElement>("open-at-login");
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
        input.setAttribute("aria-invalid", "true");
        note.textContent = `Already on your list as ${describeServer(listed)}.`;
        note.className = "error";
        available(submit, false);
        return null;
    }
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
        iconButton(`Rename ${label}`, PENCIL, () => editRow(server, row)),
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

function showPage(general: boolean): void {
    serversPage.hidden = general;
    generalPage.hidden = !general;
    byId("tab-servers").setAttribute("aria-selected", String(!general));
    byId("tab-general").setAttribute("aria-selected", String(general));
}

function draw(servers: readonly ServerRow[]): void {
    const first = known === null;
    known = servers.length;
    rows = servers;
    list.hidden = servers.length === 0;
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
        if (event.key === "Escape" && !event.defaultPrevented && !removeDialog.open) closeSheet();
    });
    document.body.addEventListener("mousedown", (event) => {
        if (event.target === document.body) closeSheet();
    });
}

showAdd.addEventListener("click", () => showForm(true));
hideAdd.addEventListener("click", () => showForm(false));
byId("tab-servers").addEventListener("click", () => showPage(false));
byId("tab-general").addEventListener("click", () => showPage(true));
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
void window.polarisLocal.connect.preferences().catch(() => null).then((preferences) => {
    if (!preferences) return;
    openAtLogin.checked = preferences.openAtLogin;
    byId("version").textContent = `Polaris ${preferences.version}`;
});

const checkUpdates = byId<HTMLButtonElement>("check-updates");
const restartUpdate = byId<HTMLButtonElement>("restart-update");
const updateStatus = byId<HTMLParagraphElement>("update-status");
checkUpdates.addEventListener("click", () => {
    if (checkUpdates.getAttribute("aria-disabled") === "true") return;
    available(checkUpdates, false);
    restartUpdate.hidden = true;
    updateStatus.className = "hint";
    updateStatus.textContent = "Checking for updates...";
    void window.polarisLocal.connect
        .checkForUpdates()
        .catch(() => ({ kind: "failed", reason: "Polaris did not answer." }) as const)
        .then((found) => {
            updateStatus.textContent = describeUpdateCheck(found);
            updateStatus.className = found.kind === "failed" ? "error" : "hint";
            restartUpdate.hidden = found.kind !== "ready";
            available(checkUpdates, true);
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

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = check();
    if (!address || busy) return;
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
