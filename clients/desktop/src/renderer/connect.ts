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

import { available, byId, dressMark, say } from "./dom";
import { serverAddressSchema } from "@/shared/server-address";
import { describeUpdateCheck, type UpdateCheck } from "@/shared/update-check";
import { describeServer, normalizeServerName, SERVER_NAME_MAX, type ServerRow } from "@/shared/servers";
import { encodeHostList, HOST_LIST_PREFIX, hostListLink } from "../../../../dashboard/packages/core/src/host-list";
import { encodeQr, qrSvgPath } from "../../../../dashboard/packages/core/src/qr";
import type { HostImport, LauncherStatus } from "@/shared/bridge";
import { picker } from "./picker";
import { SEARCH_ENGINE_IDS, SEARCH_ENGINES, type SearchEngine } from "@/shared/launcher";
import type { ClipboardKeep } from "@/shared/clipboard-store";
import { OPACITIES, type LookChange } from "@/shared/voice-widget";
import { bindingFromPress } from "@/shared/launcher-hotkey";
import jsQR from "jsqr";
import { APP_SETTING_CATEGORIES, APP_SETTINGS, type AppSettingCategory } from "@polaris/core/app-settings";
import { HOST_UPDATE_PATH, settingsPath, type LocalSettingsState } from "@/shared/settings-route";

dressMark(window.polarisLocal.season);

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("address");
const nameInput = byId<HTMLInputElement>("name");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("address-note");
const list = byId<HTMLUListElement>("server-list");
const title = byId<HTMLHeadingElement>("title");
const tabs = byId<HTMLElement>("tabs");
const nav = byId<HTMLElement>("nav");
const searchBox = byId<HTMLLabelElement>("search-box");
const search = byId<HTMLInputElement>("settings-search");
const searchEmpty = byId<HTMLParagraphElement>("search-empty");
const serversPage = byId<HTMLElement>("servers-page");
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
    voiceWidgetGameOnly: byId<HTMLInputElement>("voice-widget-game-only"),
    launcher: byId<HTMLInputElement>("launcher"),
    launcherClipboard: byId<HTMLInputElement>("launcher-clipboard"),
    launcherGameMode: byId<HTMLInputElement>("launcher-game-mode")
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

/** The icons the page names with `data-icon`, drawn once it loads. */
const ICONS: Record<string, string[]> = {
    send: ["M14.5 21.7a.5.5 0 0 0 .9 0l6.5-19a.5.5 0 0 0-.6-.6l-19 6.5a.5.5 0 0 0 0 .9l7.9 3.2a2 2 0 0 1 1.1 1.1Z", "m21.9 2.1-11 11"],
    receive: ["M12 3v12", "m7 10 5 5 5-5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    copy: ["M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"],
    save: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M12 18v-6", "m9 15 3 3 3-3"],
    open: ["M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", "M14 2v4a2 2 0 0 0 2 2h4", "M12 12v6", "m15 15-3-3-3 3"],
    paste: ["M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z", "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"],
    scan: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2", "M7 12h10"],
    plus: ["M12 5v14", "M5 12h14"],
    import: ["M12 3v12", "m7 10 5 5 5-5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"],
    export: ["M12 15V3", "m7 8 5-5 5 5", "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"]
};

for (const slot of document.querySelectorAll<HTMLElement>("[data-icon]")) {
    const paths = ICONS[slot.dataset.icon ?? ""];
    if (paths) slot.replaceChildren(icon(...paths));
}

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
    row.classList.remove("editing");
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
        iconButton(`Edit ${label}`, PENCIL, () => editRow(server, row)),
        iconButton(`Remove ${label}`, BIN, () => askRemove(server))
    );
    row.replaceChildren(open, acts);
}

/** What an edited row would keep, or why it cannot: the same address schema and
 *  name normalizer as the form that adds a host. Null when there is nothing to save. */
function checkEdit(server: ServerRow, address: string, typedName: string): { origin: string; } | { problem: string | null; } {
    const parsed = serverAddressSchema.safeParse(address);
    if (!parsed.success) return { problem: address.trim() ? (parsed.error.issues[0]?.message ?? null) : null };
    const other = rows.find((row) => row.origin === parsed.data && row.origin !== server.origin);
    if (other) return { problem: `Already on your list as ${describeServer(other)}.` };
    const unchanged = parsed.data === server.origin && normalizeServerName(typedName) === server.name;
    return unchanged ? { problem: null } : { origin: parsed.data };
}

/** The row as its address and name: Enter or Save keeps them, Escape or Cancel leaves it. */
function editRow(server: ServerRow, row: HTMLLIElement): void {
    const editor = document.createElement("form");
    editor.className = "row-edit";
    editor.noValidate = true;
    const field = (text: string, input: HTMLInputElement) => {
        const label = document.createElement("label");
        label.className = "field-label";
        const caption = document.createElement("span");
        caption.textContent = text;
        label.append(caption, input);
        return label;
    };
    const address = document.createElement("input");
    address.type = "url";
    address.inputMode = "url";
    address.spellcheck = false;
    address.value = server.origin;
    address.placeholder = "https://polaris.example.com";
    const name = document.createElement("input");
    name.type = "text";
    name.spellcheck = false;
    name.value = server.name ?? "";
    name.placeholder = server.host;
    name.maxLength = SERVER_NAME_MAX;
    const message = document.createElement("p");
    message.className = "hint";
    message.setAttribute("aria-live", "polite");
    const quiet = "A new address is checked before it is kept.";
    message.textContent = quiet;
    const save = textButton("Save", () => editor.requestSubmit(), true);
    save.type = "submit";
    const cancel = textButton("Cancel", () => viewRow(server, row));
    cancel.classList.add("ghost");
    const buttons = document.createElement("div");
    buttons.className = "row end";
    buttons.append(cancel, save);
    let saving = false;
    const update = () => {
        const verdict = checkEdit(server, address.value, name.value);
        const problem = "problem" in verdict ? verdict.problem : null;
        address.setAttribute("aria-invalid", String(Boolean(problem)));
        message.textContent = problem ?? quiet;
        message.className = problem ? "error" : "hint";
        available(save, "origin" in verdict && !saving);
        return verdict;
    };
    address.addEventListener("input", update);
    name.addEventListener("input", update);
    editor.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        // The row's own Escape, not the sheet's.
        event.preventDefault();
        viewRow(server, row);
    });
    editor.addEventListener("submit", (event) => {
        event.preventDefault();
        const verdict = update();
        if (saving || !("origin" in verdict)) return;
        saving = true;
        available(save, false);
        if (verdict.origin !== server.origin) message.textContent = `Checking ${new URL(verdict.origin).host}...`;
        void window.polarisLocal.connect
            .edit(server.origin, address.value, normalizeServerName(name.value) ?? "")
            .catch(() => ({ ok: false, error: "Something went wrong. Try again." }))
            .then(async (outcome) => {
                saving = false;
                if (!outcome.ok) {
                    update();
                    message.textContent = outcome.error ?? "Something went wrong. Try again.";
                    message.className = "error";
                    return;
                }
                await refresh();
            });
    });
    editor.append(field("Address *", address), field("Name", name), message, buttons);
    row.classList.add("editing");
    row.replaceChildren(editor);
    available(save, false);
    name.focus();
    name.select();
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

/** The name of each category, as the host's Settings lists them. */
const CATEGORY_NAMES: Record<AppSettingCategory, string> = {
    general: "General",
    window: "Window and tray",
    search: "Search and shortcuts",
    clipboard: "Clipboard",
    voice: "Voice widget and games",
    hosts: "Hosts",
    advanced: "Advanced",
    updates: "Updates"
};

/** A page's title, as each page of the host's Settings opens with one. */
function pageTitle(text: string): HTMLHeadingElement {
    const heading = document.createElement("h2");
    heading.className = "page-title";
    heading.textContent = text;
    return heading;
}

/**
 * One page per category of the shared schema (`@polaris/core/app-settings`),
 * the same categories in the same order as Settings > This app on the host.
 * The rows are written once in the markup, each naming its setting, and are
 * moved here into the page of that setting's category - so the schema, not
 * the markup, decides where a setting is listed. The hosts are their own page.
 */
function buildPages(): Record<AppSettingCategory, HTMLElement> {
    const holder = byId<HTMLElement>("pages");
    const categoryOf = new Map<string, AppSettingCategory>(APP_SETTINGS.map((entry) => [entry.key, entry.category]));
    const pages = { hosts: serversPage } as Record<AppSettingCategory, HTMLElement>;
    const lists = new Map<AppSettingCategory, HTMLElement>();
    for (const category of APP_SETTING_CATEGORIES) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.id = `tab-${category}`;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", `${category}-page`);
        tab.textContent = CATEGORY_NAMES[category];
        tab.addEventListener("click", () => showPage(category));
        tabs.append(tab);
        if (category === "hosts") continue;
        const page = document.createElement("section");
        page.id = `${category}-page`;
        page.setAttribute("role", "tabpanel");
        page.hidden = true;
        const list = document.createElement("div");
        list.className = "settings-list";
        page.append(pageTitle(CATEGORY_NAMES[category]), list);
        holder.append(page);
        pages[category] = page;
        lists.set(category, list);
    }
    serversPage.id = "hosts-page";
    serversPage.prepend(pageTitle(CATEGORY_NAMES.hosts));
    for (const row of document.querySelectorAll<HTMLElement>("[data-setting], [data-category]")) {
        const category = (row.dataset.category as AppSettingCategory | undefined) ?? categoryOf.get(row.dataset.setting ?? "");
        const list = category ? lists.get(category) : undefined;
        if (!category || !list) continue;
        // A row goes in its page's list; anything else (the version line, a notice) below it.
        if (row.classList.contains("setting") || row.parentElement?.classList.contains("settings-list")) list.append(row);
        else pages[category].append(row);
    }
    for (const id of ["general-page", "advanced-page"]) document.getElementById(id)?.remove();
    return pages;
}

const PAGES: Record<string, HTMLElement> = buildPages();

/**
 * The device add-ons installed here, after the categories as on the host's
 * Settings, each with its state and a switch to turn it on or off. Offline
 * included: the list is the app's own. Their settings open on the host.
 */
function buildAddonsPage(): void {
    const local = window.polarisLocal.connect;
    if (!local.addons || !local.setAddonEnabled) return;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.id = "tab-addons";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "addons-page");
    tab.textContent = "Device add-ons";
    tab.addEventListener("click", () => {
        showPage("addons");
        void fill();
    });
    tabs.append(tab);
    const page = document.createElement("section");
    page.id = "addons-page";
    page.setAttribute("role", "tabpanel");
    page.hidden = true;
    const list = document.createElement("div");
    list.className = "settings-list";
    // Nothing installed: the store is on the host, so the way there is a button,
    // never directions to a menu.
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const emptyText = document.createElement("p");
    emptyText.className = "hint";
    emptyText.textContent = "Nothing installed on this computer yet.";
    const browse = textButton("Browse add-ons", () => void openOnHost(settingsPath("addons")), true);
    empty.append(emptyText, browse);
    page.append(pageTitle("Device add-ons"), list, empty);
    byId<HTMLElement>("pages").append(page);
    PAGES.addons = page;

    const fill = async (): Promise<void> => {
        const rows = await local.addons!().catch(() => null);
        if (!Array.isArray(rows)) return;
        empty.hidden = rows.length > 0;
        list.hidden = rows.length === 0;
        list.replaceChildren(
            ...rows.map((row) => {
                const item = document.createElement("label");
                item.className = "setting";
                const text = document.createElement("span");
                text.className = "setting-text";
                const name = document.createElement("span");
                name.className = "name";
                name.textContent = row.name;
                const hint = document.createElement("span");
                hint.className = "hint";
                hint.textContent = `${row.status} - version ${row.version}`;
                text.append(name, hint);
                const toggle = document.createElement("input");
                toggle.type = "checkbox";
                toggle.className = "switch";
                toggle.setAttribute("role", "switch");
                toggle.setAttribute("aria-label", `Use ${row.name}`);
                toggle.checked = row.enabled;
                toggle.addEventListener("change", () => {
                    const wanted = toggle.checked;
                    toggle.disabled = true;
                    void local.setAddonEnabled!(row.id, wanted)
                        .catch(() => false)
                        .then((took) => {
                            // The switch goes back when it did not take.
                            if (!took) toggle.checked = !wanted;
                            toggle.disabled = false;
                        });
                });
                item.append(text, toggle);
                return item;
            })
        );
    };
    void fill();
    local.onAddonsChange?.(() => void fill());
}
buildAddonsPage();

/** The page shown, and the one to go back to once a search is cleared. */
let currentPage = "hosts";

function showPage(shown: string): void {
    if (!PAGES[shown]) return;
    currentPage = shown;
    if (search.value) {
        search.value = "";
        filterSettings("");
    }
    for (const [page, element] of Object.entries(PAGES)) {
        element.hidden = page !== shown;
        byId(`tab-${page}`).setAttribute("aria-selected", String(page === shown));
    }
    // In a narrow window the categories scroll across; the chosen one stays in view.
    byId(`tab-${shown}`).scrollIntoView({ block: "nearest", inline: "nearest" });
}
showPage("hosts");

function draw(servers: readonly ServerRow[]): void {
    const first = known === null;
    known = servers.length;
    rows = servers;
    list.hidden = servers.length === 0;
    // Exporting needs something to export; taking a list in never does.
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-needs-hosts]")) {
        button.hidden = servers.length === 0;
    }
    nav.hidden = servers.length === 0;
    searchBox.hidden = servers.length === 0;
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
    if (opened) openAt(state?.settings ?? null);
}

// ---- Why this page, and not the host's Settings ----

const reason = byId<HTMLElement>("reason");
const reasonText = byId<HTMLParagraphElement>("reason-text");
const reasonActs = byId<HTMLElement>("reason-acts");

/**
 * Open a page of the host in the Polaris window. When it cannot be - no host
 * in reach, or one older than the page - the notice says which, with the
 * button that fixes it.
 */
async function openOnHost(path: string): Promise<void> {
    const outcome = (await window.polarisLocal.connect.openOnHost?.(path).catch(() => null)) ?? "offline";
    if (outcome !== "opened") explain(outcome);
}

/**
 * The notice over every page when the host's Settings could not be opened:
 * out of reach, or a Polaris from before this app's settings were in it. Each
 * says what the reader can do about it, with the button that does it.
 */
function explain(why: LocalSettingsState["reason"]): void {
    reason.hidden = why === null;
    if (why === "outdated") {
        reasonText.textContent =
            "Your Polaris is older than this app, so these settings open here instead of in Settings. Update Polaris to have them there, next to the rest.";
        reasonActs.replaceChildren(textButton("Update Polaris", () => void openOnHost(HOST_UPDATE_PATH), true));
    } else if (why === "offline") {
        reasonText.textContent = "Polaris cannot be reached, so these are the settings kept on this computer.";
        reasonActs.replaceChildren(textButton("Connect", () => showPage("hosts"), true));
    } else reasonActs.replaceChildren();
}

/** The place and the notice the app opened this page with. */
function openAt(state: LocalSettingsState | null): void {
    explain(state?.reason ?? null);
    if (state && known) showPage(state.place);
}

// ---- Search, as the host's Settings search finds a setting ----

/** Lower case and without accents, so a word typed either way finds the row. */
function folded(text: string): string {
    return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Every page at once, showing only the rows whose name or hint holds every
 * word typed, under the title of their page; cleared, the page that was open
 * comes back. A page with no rows of its own (the hosts) is found by its title.
 */
function filterSettings(query: string): void {
    const words = folded(query).split(/\s+/).filter(Boolean);
    document.body.classList.toggle("searching", words.length > 0);
    let found = 0;
    for (const [name, page] of Object.entries(PAGES)) {
        const rows = [...page.querySelectorAll<HTMLElement>(".setting")];
        if (words.length === 0) {
            page.hidden = name !== currentPage;
            for (const row of rows) delete row.dataset.searchMiss;
            continue;
        }
        const title = folded(page.querySelector(".page-title")?.textContent ?? "");
        let matches = 0;
        for (const row of rows) {
            const text = `${title} ${folded(row.textContent ?? "")}`;
            const hit = words.every((word) => text.includes(word));
            if (hit) {
                delete row.dataset.searchMiss;
                if (!row.hidden) matches++;
            } else row.dataset.searchMiss = "";
        }
        const hit = matches > 0 || (rows.length === 0 && words.every((word) => title.includes(word)));
        page.hidden = !hit;
        if (hit) found++;
    }
    searchEmpty.hidden = words.length === 0 || found > 0;
    for (const name of Object.keys(PAGES)) {
        byId(`tab-${name}`).setAttribute("aria-selected", String(words.length === 0 && name === currentPage));
    }
}

search.addEventListener("input", () => filterSettings(search.value));
search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && search.value) {
        event.preventDefault();
        search.value = "";
        filterSettings("");
    }
});
document.addEventListener("keydown", (event) => {
    if (searchBox.hidden) return;
    // Ctrl+K, or / outside a field, puts the cursor in the search, as in Polaris.
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if ((event.key === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !typing)) {
        event.preventDefault();
        search.focus();
        search.select();
    }
});

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
        if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) closeSheet();
    });
    document.body.addEventListener("mousedown", (event) => {
        if (event.target === document.body) closeSheet();
    });
}

// ---- Moving the list to and from another device ----

const transferNote = byId<HTMLParagraphElement>("transfer-note");
const sendDialog = byId<HTMLDialogElement>("send-dialog");
const sendNote = byId<HTMLParagraphElement>("send-note");
const receiveDialog = byId<HTMLDialogElement>("receive-dialog");
const receiveScan = byId<HTMLElement>("receive-scan");
const receivePaste = byId<HTMLElement>("receive-paste");
const receiveModeLabel = byId<HTMLSpanElement>("receive-mode-label");
const receiveModeIcon = byId<HTMLButtonElement>("receive-mode").querySelector<HTMLElement>("[data-icon]");
const scanVideo = byId<HTMLVideoElement>("scan-video");
const scanNote = byId<HTMLParagraphElement>("scan-note");
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

/** Send: the QR code first, with the code and the file for when a camera is not at hand. */
function openSend(): void {
    say(transferNote, null);
    say(sendNote, null);
    // The link, not the bare code: a phone camera opens the Polaris app on it.
    const modules = encodeQr(hostListLink(rows));
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
    sendDialog.showModal();
    byId<HTMLButtonElement>("send-close").focus();
}

let scanStream: MediaStream | null = null;
let scanFrame = 0;

function stopCamera(): void {
    cancelAnimationFrame(scanFrame);
    for (const track of scanStream?.getTracks() ?? []) track.stop();
    scanStream = null;
    scanVideo.srcObject = null;
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
                receiveDialog.close();
                void window.polarisLocal.connect.importHosts(found.data).then(afterImport, () => undefined);
                return;
            }
            if (found) say(scanNote, "That QR code is not a list of Polaris hosts.");
        }
        scanFrame = requestAnimationFrame(frame);
    };
    scanFrame = requestAnimationFrame(frame);
}

async function startCamera(): Promise<void> {
    say(scanNote, "Hold the other device's QR code up to the camera.");
    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
        say(scanNote, "Polaris could not use a camera. Paste a code or open a file instead.");
        return;
    }
    // Closed, or switched to pasting, while the camera was being asked for.
    if (!receiveDialog.open || receiveScan.hidden) {
        for (const track of stream.getTracks()) track.stop();
        return;
    }
    scanStream = stream;
    scanVideo.srcObject = stream;
    await scanVideo.play().catch(() => undefined);
    readFrames(document.createElement("canvas"));
}

/** Receive shows one way at a time: the camera, or a field to paste the code in. */
function receiveMode(pasting: boolean): void {
    receiveScan.hidden = pasting;
    receivePaste.hidden = !pasting;
    pasteConfirm.hidden = !pasting;
    receiveModeLabel.textContent = pasting ? "Scan a QR code" : "Paste a code";
    receiveModeIcon?.replaceChildren(icon(...(ICONS[pasting ? "scan" : "paste"] ?? [])));
    if (pasting) {
        stopCamera();
        say(pasteError, null);
        checkPaste();
        pasteText.focus();
    } else void startCamera();
}

function openReceive(): void {
    say(transferNote, null);
    pasteText.value = "";
    receiveDialog.showModal();
    receiveMode(false);
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
    receiveDialog.close();
    await afterImport(outcome);
}

byId("hosts-send").addEventListener("click", openSend);
byId("send-close").addEventListener("click", () => sendDialog.close());
byId("hosts-copy").addEventListener("click", () => {
    void window.polarisLocal.connect.copyHosts().then(
        (copied) => say(sendNote, copied.ok ? `Code for ${plural(copied.count, "host", "hosts")} copied. Paste it on the other device.` : "Polaris could not copy the code."),
        () => say(sendNote, "Polaris could not copy the code.")
    );
});
byId("hosts-export").addEventListener("click", () => {
    say(sendNote, null);
    void window.polarisLocal.connect.exportHostsFile().then(
        (outcome) => say(sendNote, outcome.ok ? "Hosts saved. Open the file on the other device." : outcome.error),
        () => say(sendNote, "Something went wrong. Try again.")
    );
});
byId("hosts-receive").addEventListener("click", openReceive);
byId("receive-mode").addEventListener("click", () => receiveMode(receivePaste.hidden));
byId("receive-cancel").addEventListener("click", () => receiveDialog.close());
receiveDialog.addEventListener("close", stopCamera);
pasteText.addEventListener("input", () => {
    say(pasteError, null);
    checkPaste();
});
pasteText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void confirmPaste();
});
pasteConfirm.addEventListener("click", () => void confirmPaste());
byId("hosts-import").addEventListener("click", () => {
    receiveDialog.close();
    void window.polarisLocal.connect.importHostsFile().then(afterImport, () =>
        say(transferNote, "Something went wrong. Try again.")
    );
});
showAdd.addEventListener("click", () => showForm(true));
hideAdd.addEventListener("click", () => showForm(false));
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
const launcherRecord = byId<HTMLButtonElement>("launcher-record");
const launcherKeyHint = byId<HTMLSpanElement>("launcher-key-hint");
const launcherProblem = byId<HTMLParagraphElement>("launcher-problem");
const launcherName = byId<HTMLSpanElement>("launcher-name");
const launcherOnHint = byId<HTMLSpanElement>("launcher-on-hint");
const launcherClipboardHint = byId<HTMLSpanElement>("launcher-clipboard-hint");
const launcherKeepRow = byId<HTMLDivElement>("launcher-keep-row");
const clearClipsDialog = byId<HTMLDialogElement>("confirm-clear-clips");
/** Said under "Clipboard history": where the copies are kept, and for how long. */
const CLIPBOARD_HINT = {
    kept: 'Polaris search keeps what you copy on this computer, encrypted, for the time below. Passwords from password managers are skipped. Type "clip" to see them.',
    memory: 'This computer has no system key store, so copies stay in memory and are gone when Polaris closes. Passwords from password managers are skipped. Type "clip" to see them.'
} as const;
/** Saving a choice from a dropdown; a refusal is said where the switches say theirs. */
function savedOrSay(saving: Promise<boolean>): void {
    say(failure, null);
    void saving.catch(() => false).then((kept) => {
        if (!kept) say(failure, "Polaris could not save this setting. Try again.");
    });
}
const launcherEngine = picker(
    byId("launcher-engine"),
    SEARCH_ENGINE_IDS.map((id) => ({ value: id, label: SEARCH_ENGINES[id].name })),
    (value) => savedOrSay(window.polarisLocal.connect.setLauncherEngine(value as SearchEngine))
);
const launcherKeep = picker(
    byId("launcher-keep"),
    [
        { value: "day", label: "1 day" },
        { value: "week", label: "1 week" },
        { value: "month", label: "1 month" },
        { value: "quarter", label: "3 months" }
    ],
    (value) => savedOrSay(window.polarisLocal.connect.setClipboardKeep(value as ClipboardKeep))
);
/** The voice widget's looks, the choices Discord's overlay voice widget offers. */
function lookPicker<K extends LookChange["key"]>(key: K, options: readonly { value: string; label: string; }[]) {
    const id = `voice-widget-${key}`;
    const chosen = picker(byId(id), options, (value) =>
        savedOrSay(window.polarisLocal.connect.setVoiceWidgetLook({ key, value: key === "opacity" ? Number(value) : value } as LookChange))
    );
    return { picker: chosen, row: byId<HTMLDivElement>(`${id}-row`) };
}
const widgetLook = {
    avatars: lookPicker("avatars", [
        { value: "large", label: "Large" },
        { value: "small", label: "Small" }
    ]),
    names: lookPicker("names", [
        { value: "always", label: "Always" },
        { value: "speaking", label: "While talking" },
        { value: "never", label: "Never" }
    ]),
    people: lookPicker("people", [
        { value: "always", label: "Everyone in the call" },
        { value: "speaking", label: "Only who is talking" }
    ]),
    opacity: lookPicker("opacity", OPACITIES.map((value) => ({ value: String(value), label: `${value}%` }))),
    corner: lookPicker("corner", [
        { value: "top-left", label: "Top left" },
        { value: "top-right", label: "Top right" },
        { value: "bottom-left", label: "Bottom left" },
        { value: "bottom-right", label: "Bottom right" }
    ])
};
const launcherClear = byId<HTMLButtonElement>("launcher-clear");
const launcherClearRow = byId<HTMLDivElement>("launcher-clear-row");
let recordingKey = false;

/** The search shortcut as the system left it, and who likely holds it when it is taken. */
function drawLauncherStatus(status: LauncherStatus): void {
    launcherKeyHint.textContent = status.others.length && status.held
        ? `${status.key} - also installed: ${status.others.join(", ")}`
        : status.key;
    // The switch is named by the key it holds, as the extension's settings name theirs.
    launcherName.textContent = `${status.key} search`;
    launcherProblem.hidden = !status.problem;
    launcherProblem.textContent = status.problem ?? "";
}

async function showLauncherStatus(): Promise<void> {
    const status = await window.polarisLocal.connect.launcherStatus().catch(() => null);
    if (status) drawLauncherStatus(status);
}

function stopRecording(): void {
    recordingKey = false;
    launcherRecord.textContent = "Change";
    document.removeEventListener("keydown", recordKey, true);
}

/** The next press becomes the shortcut; Esc keeps the old one. */
function recordKey(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
        stopRecording();
        void window.polarisLocal.connect.recordLauncherKey(false).then(showLauncherStatus);
        return;
    }
    const binding = bindingFromPress(event, platformOf());
    if (!binding) {
        if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) {
            launcherProblem.hidden = false;
            launcherProblem.textContent = "Use Ctrl, Alt or Cmd with a key, or a function key.";
        }
        return;
    }
    stopRecording();
    void window.polarisLocal.connect
        .setLauncherBinding(binding)
        .catch(() => null)
        .then((status) => {
            if (status) drawLauncherStatus(status);
            else void window.polarisLocal.connect.recordLauncherKey(false).then(showLauncherStatus);
        });
}

/** The platform the page runs on, as Node names it, for how keys are spelled. */
function platformOf(): NodeJS.Platform {
    const agent = navigator.userAgent;
    return /Mac/.test(agent) ? "darwin" : /Windows/.test(agent) ? "win32" : "linux";
}

launcherRecord.addEventListener("click", () => {
    if (recordingKey) {
        stopRecording();
        void window.polarisLocal.connect.recordLauncherKey(false).then(showLauncherStatus);
        return;
    }
    recordingKey = true;
    launcherRecord.textContent = "Press the new shortcut...";
    launcherProblem.hidden = true;
    void window.polarisLocal.connect.recordLauncherKey(true);
    document.addEventListener("keydown", recordKey, true);
});
launcherClear.addEventListener("click", () => clearClipsDialog.showModal());
byId("clear-clips-cancel").addEventListener("click", () => clearClipsDialog.close());
byId("clear-clips-confirm").addEventListener("click", () => {
    clearClipsDialog.close();
    void window.polarisLocal.connect.clearClipboardHistory().then(() => {
        launcherClear.textContent = "Cleared";
        setTimeout(() => (launcherClear.textContent = "Clear"), 1500);
    });
});
/** The rows that only mean something with the history on, and the search on. */
function followLauncher(): void {
    const searching = toggles.launcher.checked;
    const keeping = searching && toggles.launcherClipboard.checked;
    launcherOnHint.textContent = searching
        ? "Your shortcut opens Polaris search over any app."
        : "The shortcut does nothing outside Polaris.";
    launcherEngine.disabled = !searching;
    toggles.launcherClipboard.disabled = !searching;
    toggles.launcherGameMode.disabled = !searching;
    // Only Windows can tell what is in front.
    byId("launcher-game-mode-row").hidden = platformOf() !== "win32";
    launcherKeepRow.hidden = !keeping;
    launcherClearRow.hidden = !keeping;
}
void showLauncherStatus();
/** "Only while a game is running" means nothing with the widget off. */
function followVoiceWidget(): void {
    toggles.voiceWidgetGameOnly.disabled = !toggles.voiceWidget.checked;
    for (const { row } of Object.values(widgetLook)) row.hidden = !toggles.voiceWidget.checked;
    launcherRecord.disabled = !toggles.launcher.checked;
    followLauncher();
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
                if (kept) {
                    if (name === "launcher") void showLauncherStatus();
                    return;
                }
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
const loadPreferences = () => window.polarisLocal.connect.preferences().catch(() => null).then((preferences) => {
    if (!preferences) return;
    openAtLogin.checked = preferences.openAtLogin;
    hardwareAcceleration.checked = preferences.hardwareAcceleration;
    toggles.minimizeToTray.checked = preferences.minimizeToTray;
    toggles.startMinimized.checked = preferences.startMinimized;
    toggles.voiceWidget.checked = preferences.voiceWidget;
    toggles.voiceWidgetGameOnly.checked = preferences.voiceWidgetGameOnly;
    for (const key of Object.keys(widgetLook) as (keyof typeof widgetLook)[]) widgetLook[key].picker.value = String(preferences.voiceWidgetLook[key]);
    toggles.launcher.checked = preferences.launcher;
    toggles.launcherClipboard.checked = preferences.launcherClipboard;
    toggles.launcherGameMode.checked = preferences.launcherGameMode;
    launcherEngine.value = preferences.launcherEngine;
    launcherKeep.value = preferences.launcherClipboardKeep;
    launcherClipboardHint.textContent = preferences.launcherClipboardPersists ? CLIPBOARD_HINT.kept : CLIPBOARD_HINT.memory;
    followVoiceWidget();
    restartPending.hidden = !preferences.restartPending;
    byId("version").textContent = `Polaris ${preferences.version}`;
});
const preferencesLoaded = loadPreferences();

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
        .then(showUpdateCheck);
});
/** Say what a check found; a download keeps the button until it ends, then
 *  says what it came to, so one press reaches "Restart now". */
function showUpdateCheck(found: UpdateCheck): void {
    updateStatus.textContent = describeUpdateCheck(found);
    updateStatus.className = found.kind === "failed" ? "error" : "hint";
    restartUpdate.hidden = found.kind !== "ready";
    updatePage.hidden = found.kind !== "available";
    if (found.kind !== "downloading") {
        available(checkUpdates, true);
        return;
    }
    void window.polarisLocal.connect
        .updateDownloaded()
        .catch(() => ({ kind: "failed", reason: "Polaris did not answer." }) as const)
        .then((ended) => showUpdateCheck(ended.kind === "downloading" ? { kind: "failed", reason: "Try again." } : ended));
}
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

const stateLoaded = window.polarisLocal.connect.state().catch(() => null).then((state) => {
    const servers = state?.servers ?? [];
    // The first run has nothing to list, so the field starts with the address
    // in use; once there is a list, that address is a row and the field is for
    // another one.
    if (state?.address && !input.value && servers.length === 0) input.value = state.address;
    say(failure, state?.error ?? null);
    draw(servers);
    openAt(state?.settings ?? null);
    check();
    ask();
});

// The page as written is the first run's - the address form, no tabs - so it
// stays out of sight until the list and the settings are in, rather than
// showing that form for a moment and swapping it for the tabs.
void Promise.allSettled([stateLoaded, preferencesLoaded]).then(() => {
    delete byId("panel").dataset.loading;
    if (!form.hidden) input.focus();
});

// Kept open between visits (`openLocalSheet` hides it instead of closing it):
// shown again, it reads the list and the settings anew, since either may have
// changed elsewhere while it was away.
window.polarisLocal.connect.onShown?.(() => {
    void refresh(true);
    void loadPreferences();
});
