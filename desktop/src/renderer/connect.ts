/**
 * The servers window: the first run, File > Servers, and where a window that
 * could not load comes back to with the reason.
 *
 * Every server this app has opened is a row: pressing Open puts it in front,
 * the pencil names it and the bin takes it off the list. Below, the form adds
 * another. The address is checked as it is typed against the same schema the
 * main process keeps it with. An empty field is incomplete rather than wrong,
 * so it only disables the button; the reason something is not an address
 * appears once there is text.
 */

import { available, byId, say } from "./dom";
import { serverAddressSchema } from "@/shared/server-address";
import { describeServer, normalizeServerName, SERVER_NAME_MAX, type ServerRow } from "@/shared/servers";

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("address");
const submit = byId<HTMLButtonElement>("submit");
const failure = byId<HTMLParagraphElement>("failure");
const note = byId<HTMLSpanElement>("address-note");
const saved = byId<HTMLElement>("saved");
const list = byId<HTMLUListElement>("server-list");
const addTitle = byId<HTMLHeadingElement>("add-title");
const hint = note.textContent ?? "";

let busy = false;

function check(): string | null {
    const text = input.value;
    const parsed = serverAddressSchema.safeParse(text);
    const problem = text.trim() && !parsed.success ? (parsed.error.issues[0]?.message ?? null) : null;
    input.setAttribute("aria-invalid", String(Boolean(problem)));
    note.textContent = problem ?? (parsed.success ? `Opens ${parsed.data}` : hint);
    note.className = problem ? "error" : "hint";
    available(submit, parsed.success && !busy);
    return parsed.success ? parsed.data : null;
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
    const names = document.createElement("div");
    names.className = "names";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = label;
    name.title = label;
    names.append(name);
    if (server.name) {
        const host = document.createElement("span");
        host.className = "host";
        host.textContent = server.host;
        host.title = server.origin;
        names.append(host);
    }
    row.replaceChildren(names);
    if (server.active) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "In use";
        row.append(badge);
    } else {
        const open = textButton("Open", () => {
            open.textContent = "Checking...";
            void act(() => window.polarisLocal.connect.switchTo(server.origin));
        });
        open.setAttribute("aria-label", `Open ${label}`);
        row.append(open);
    }
    row.append(
        iconButton(`Rename ${label}`, PENCIL, () => editRow(server, row)),
        iconButton(`Remove ${label}`, BIN, () => void act(() => window.polarisLocal.connect.remove(server.origin)))
    );
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
        if (event.key === "Escape") viewRow(server, row);
    });
    row.replaceChildren(field, textButton("Save", save, true), textButton("Cancel", () => viewRow(server, row)));
    field.focus();
    field.select();
}

function draw(servers: readonly ServerRow[]): void {
    saved.hidden = servers.length === 0;
    addTitle.hidden = servers.length === 0;
    list.replaceChildren(
        ...servers.map((server) => {
            const row = document.createElement("li");
            row.className = "server";
            row.dataset.active = String(server.active);
            viewRow(server, row);
            return row;
        })
    );
}

async function refresh(): Promise<void> {
    const state = await window.polarisLocal.connect.state().catch(() => null);
    draw(state?.servers ?? []);
}

input.addEventListener("input", () => {
    say(failure, null);
    check();
});

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = check();
    if (!address || busy) return;
    busy = true;
    submit.textContent = "Checking...";
    check();
    void window.polarisLocal.connect
        .submit(input.value)
        .then((result) => {
            if (!result.ok) say(failure, result.error);
        })
        .catch(() => say(failure, "Something went wrong. Try again."))
        .finally(() => {
            busy = false;
            submit.textContent = "Open";
            check();
            void refresh();
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
});
