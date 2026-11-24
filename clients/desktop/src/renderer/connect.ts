/**
 * The hosts window: only what reaches a Polaris where no Polaris page can be
 * shown - the first run, before any host, and a host that cannot be opened
 * (out of reach with nothing kept, or older than this app), with the reason.
 * Managing the hosts - naming, editing, removing, export and import - is the
 * host's Settings > This app > Hosts, in the Polaris window (`manageHosts`).
 *
 * Every server this app has opened is a row: pressing one opens it. Below, the
 * form adds another. The address is checked as it is typed against the same
 * schema the main process keeps it with. An empty field is incomplete rather
 * than wrong, so it only disables the button; the reason something is not an
 * address appears once there is text. A well-formed address is then asked
 * whether it is a Polaris, 400 ms after typing pauses, and Open stays off until
 * it is. An address already on the list says so at once and is never asked
 * about: its row is the way to open it. The name is optional and kept with the
 * address, so the row reads "Home" instead of the host.
 */

import { available, byId, dressMark, say } from "./dom";
import { serverAddressSchema } from "@/shared/server-address";
import { describeServer, normalizeServerName, SERVER_NAME_MAX, type ServerRow } from "@/shared/servers";
import { HOST_UPDATE_PATH, type LocalSettingsState } from "@/shared/settings-route";

dressMark(window.polarisLocal.season);

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("address");
const nameInput = byId<HTMLInputElement>("name");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("address-note");
const list = byId<HTMLUListElement>("server-list");
const title = byId<HTMLHeadingElement>("title");
const showAdd = byId<HTMLButtonElement>("show-add");
const hideAdd = byId<HTMLButtonElement>("hide-add");
const hint = note.textContent ?? "";

let busy = false;
/** How many servers are listed; null until the first answer. */
let known: number | null = null;
/** The hosts listed, so a typed address already among them is caught as it is typed. */
let rows: readonly ServerRow[] = [];

/** How long the field waits after the last keystroke before it asks. */
const ASK_AFTER_MS = 400;
/** The address the live check last found to be a Polaris. */
let confirmed: string | null = null;
/** Which question an answer belongs to, so a slow one never lands on a newer address. */
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

/** The address when it can be opened: well-formed, not listed, and found to be a Polaris. */
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

/** The icons the page names with `data-icon`, drawn once it loads. */
const ICONS: Record<string, string[]> = {
    plus: ["M12 5v14", "M5 12h14"]
};

for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const paths = ICONS[slot.dataset.icon ?? ""];
    if (paths) slot.replaceChildren(icon(...paths));
}

function textButton(label: string, onPress: () => void, primary = false): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (primary) button.className = "primary";
    button.addEventListener("click", onPress);
    return button;
}

/** Open a listed host, showing what it says when it cannot. */
async function openRow(server: ServerRow, where: HTMLElement): Promise<void> {
    if (busy) return;
    busy = true;
    say(failure, null);
    where.textContent = "Checking...";
    try {
        const outcome = await window.polarisLocal.connect.switchTo(server.origin);
        if (!outcome.ok) say(failure, outcome.error);
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
    // The host in use is opened again too: here it is the one that did not open.
    open.addEventListener("click", () => void openRow(server, where));
    row.replaceChildren(open);
}

/** With a list the field is one press away; with none, it is the whole screen. */
function showForm(shown: boolean): void {
    form.hidden = !shown;
    showAdd.hidden = shown || known === 0;
    hideAdd.hidden = known === 0;
    if (shown) input.focus();
}

function draw(servers: readonly ServerRow[]): void {
    const first = known === null;
    known = servers.length;
    rows = servers;
    list.hidden = servers.length === 0;
    document.body.classList.toggle("first-run", servers.length === 0);
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

async function refresh(opened = false): Promise<void> {
    const state = await window.polarisLocal.connect.state().catch(() => null);
    draw(state?.servers ?? []);
    if (opened) {
        say(failure, state?.error ?? null);
        explain(state?.settings ?? null);
    }
}

// ---- Why this window, in place of the host's own screen ----

const reason = byId<HTMLElement>("reason");
const reasonText = byId<HTMLParagraphElement>("reason-text");
const reasonActs = byId<HTMLElement>("reason-acts");

/**
 * The line over the hosts when the host in use is older than this app's
 * Settings > This app: what the reader can do about it, with the update when
 * the host lets them run it. Nothing otherwise.
 */
function explain(state: LocalSettingsState | null): void {
    reason.hidden = state?.reason !== "outdated";
    reasonActs.replaceChildren();
    if (state?.reason !== "outdated") return;
    if (state.canUpdate === true) {
        reasonText.textContent = "This Polaris is older than this app, so this app's settings and hosts are not in its Settings yet. Update Polaris to have them there.";
        reasonActs.replaceChildren(textButton("Update Polaris", () => void openUpdate(), true));
    } else {
        // Only an administrator can update it; nobody else is offered a page that would refuse them.
        reasonText.textContent = "This Polaris is older than this app, so this app's settings and hosts are not in its Settings yet. An administrator has to update it.";
    }
}

/** The host's update page, in the Polaris window; when it cannot open, why. */
async function openUpdate(): Promise<void> {
    const outcome = (await window.polarisLocal.connect.openOnHost?.(HOST_UPDATE_PATH).catch(() => null)) ?? "offline";
    if (outcome !== "opened") say(failure, "Polaris cannot be reached right now. Try again in a moment.");
}

// Laid over the Polaris window: Escape, the cross or a press beside the card
// puts it away.
if (new URLSearchParams(location.search).has("sheet")) {
    const closeSheet = () => void window.polarisLocal.connect.close().catch(() => undefined);
    document.body.classList.add("sheet");
    // The window's own buttons are on the left there, and the header keeps clear of them.
    document.body.classList.toggle("mac", navigator.platform.startsWith("Mac"));
    const cross = byId<HTMLButtonElement>("close-sheet");
    cross.hidden = false;
    cross.addEventListener("click", closeSheet);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !event.defaultPrevented) closeSheet();
    });
    document.body.addEventListener("mousedown", (event) => {
        if (event.target === document.body) closeSheet();
    });
}

showAdd.addEventListener("click", () => showForm(true));
hideAdd.addEventListener("click", () => showForm(false));
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

const stateLoaded = window.polarisLocal.connect.state().catch(() => null).then((state) => {
    const servers = state?.servers ?? [];
    // The first run has nothing to list, so the field starts with the address
    // in use; once there is a list, that address is a row and the field is for
    // another one.
    if (state?.address && !input.value && servers.length === 0) input.value = state.address;
    say(failure, state?.error ?? null);
    draw(servers);
    explain(state?.settings ?? null);
    check();
    ask();
});

// The page as written is the first run's - the address form, no list - so it
// stays out of sight until the list is in, rather than showing that form for a
// moment and swapping it for the list.
void stateLoaded.then(() => {
    delete byId("panel").dataset.loading;
    if (!form.hidden) input.focus();
});

// Kept open between visits (`openLocalSheet` hides it instead of closing it):
// shown again, it reads the list and the reason anew, since either may have
// changed elsewhere while it was away.
window.polarisLocal.connect.onShown?.(() => void refresh(true));
