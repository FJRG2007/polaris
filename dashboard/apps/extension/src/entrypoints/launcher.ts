/**
 * Polaris's search on any site: Alt+Space (or the keys set in Settings) opens a
 * small launcher over the page that finds what the dashboard's own palette finds
 * and opens it in Polaris.
 *
 * Idle, this is one keydown listener and one storage read. Nothing is drawn, no
 * words are loaded and the worker is not woken until the keys are pressed: the
 * launcher's sentences come back from the worker with the first answer, so this
 * bundle carries no catalog. Which sites it runs on is decided by the worker
 * when it registers this script (`syncLauncher`), not here, and the Polaris
 * instance's own origin is never one of them - its own palette answers there.
 *
 * When Polaris Desktop or another launcher (Raycast, PowerToys Run, Flow
 * Launcher) holds Alt+Space system-wide, the OS hands it to that program and
 * this listener never sees it - which is the order wanted ("Desktop first"), with
 * nothing to coordinate. The second key still reaches the page.
 *
 * Drawn in a closed shadow root, like the login menu, so a page can neither
 * restyle nor read it.
 */

import {
    isEditableTarget,
    launcherPress,
    launcherPressAllowed,
    readLauncherSettings,
    type LauncherSettings
} from "@polaris/core/launcher";
import { LAUNCHER_KEY } from "@/lib/launcher-settings";
import type { LauncherEntry, LauncherWords, Reply, Request } from "@/lib/messages";

/** The worker, asked without `askBackground`, whose fallback sentence would
 *  pull the whole catalog into this bundle. */
async function askBackground(request: Request): Promise<Reply> {
    try {
        const reply = (await browser.runtime.sendMessage(request)) as Reply | undefined;
        return reply && typeof reply === "object" && "ok" in reply ? reply : { ok: false, error: "" };
    } catch {
        return { ok: false, error: "" };
    }
}

let settings: LauncherSettings = readLauncherSettings(undefined);
let close: (() => void) | null = null;

export default defineUnlistedScript({
    main() {
        if (window.top !== window) return;
        const name = LAUNCHER_KEY.slice("local:".length);
        void browser.storage.local
            .get(name)
            .then((held) => (settings = readLauncherSettings(held[name])))
            .catch(() => undefined);
        browser.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes[name]) settings = readLauncherSettings(changes[name].newValue);
        });
        window.addEventListener("keydown", onKey, true);
    }
});

function onKey(event: KeyboardEvent): void {
    // A page can dispatch a keydown of its own; only a real press opens this.
    if (!event.isTrusted || !settings.enabled) return;
    const pressed = launcherPress(event, settings.shortcuts);
    if (!pressed) return;
    const apple = /mac|iphone|ipad/i.test(navigator.platform);
    if (!launcherPressAllowed(pressed, { editable: isEditableTarget(event.composedPath()[0]), apple })) return;
    event.preventDefault();
    event.stopPropagation();
    if (close) close();
    else open();
}

const STYLE = `
:host { all: initial; }
.backdrop { position: fixed; inset: 0; z-index: 2147483647; background: rgb(0 0 0 / 0.35);
  display: flex; justify-content: center; align-items: flex-start; padding: 12vh 16px 16px;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme: light dark; }
.panel { width: min(560px, 100%); max-height: 70vh; display: flex; flex-direction: column; overflow: hidden;
  background: Canvas; color: CanvasText; border-radius: 12px; box-shadow: 0 20px 60px rgb(0 0 0 / 0.35); }
input { all: unset; box-sizing: border-box; width: 100%; padding: 14px 16px; font-size: 16px;
  border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
ul { list-style: none; margin: 0; padding: 6px; overflow-y: auto; }
li { display: flex; gap: 8px; align-items: baseline; padding: 8px 10px; border-radius: 8px; cursor: pointer; min-width: 0; }
li[aria-selected="true"] { background: color-mix(in srgb, CanvasText 10%, transparent); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.context { margin-inline-start: auto; opacity: 0.6; font-size: 12px; white-space: nowrap; flex-shrink: 0; }
.note { padding: 10px 16px; opacity: 0.7; }
`;

/** Entries matching every word of `query`, in their order, capped. */
function matching(entries: readonly LauncherEntry[], query: string): LauncherEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return entries.slice(0, 8);
    return entries
        .filter((entry) => {
            const text = `${entry.label} ${entry.context}`.toLowerCase();
            return words.every((word) => text.includes(word));
        })
        .slice(0, 50);
}

function open(): void {
    const host = document.createElement("polaris-launcher");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    const input = document.createElement("input");
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-controls", "polaris-launcher-list");
    const list = document.createElement("ul");
    list.id = "polaris-launcher-list";
    list.setAttribute("role", "listbox");
    const note = document.createElement("p");
    note.className = "note";
    panel.append(input, list, note);
    backdrop.append(panel);
    root.append(style, backdrop);
    document.documentElement.append(host);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.focus();

    let entries: LauncherEntry[] = [];
    let shown: LauncherEntry[] = [];
    let active = 0;
    let words: LauncherWords | null = null;

    const draw = (): void => {
        shown = matching(entries, input.value);
        active = Math.min(active, Math.max(shown.length - 1, 0));
        list.replaceChildren(
            ...shown.map((entry, at) => {
                const row = document.createElement("li");
                row.setAttribute("role", "option");
                row.setAttribute("aria-selected", String(at === active));
                const label = document.createElement("span");
                label.className = "label";
                label.textContent = entry.label;
                label.title = entry.label;
                const context = document.createElement("span");
                context.className = "context";
                context.textContent = entry.context;
                row.append(label, context);
                row.addEventListener("mousedown", (event) => event.preventDefault());
                row.addEventListener("click", () => choose(entry));
                return row;
            })
        );
        note.hidden = shown.length > 0 || words === null;
        if (words && shown.length === 0) note.textContent = words.empty;
    };

    const choose = (entry: LauncherEntry): void => {
        finish();
        void askBackground({ kind: "launcherOpen", href: entry.href });
    };

    const finish = (): void => {
        host.remove();
        close = null;
        before?.focus();
    };
    close = finish;

    backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop) finish();
    });
    input.addEventListener("input", () => {
        active = 0;
        draw();
    });
    input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Escape") finish();
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (shown.length === 0) return;
            active = (active + (event.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
            draw();
            list.children[active]?.scrollIntoView({ block: "nearest" });
        } else if (event.key === "Enter") {
            event.preventDefault();
            const entry = shown[active];
            if (entry) choose(entry);
        }
    });

    draw();
    void askBackground({ kind: "launcherIndex" }).then((reply) => {
        if (close !== finish) return;
        if (!reply.ok || !("launcher" in reply)) {
            note.hidden = false;
            note.textContent = reply.ok ? "" : reply.error;
            return;
        }
        words = reply.launcher.words;
        input.placeholder = words.placeholder;
        input.setAttribute("aria-label", words.placeholder);
        panel.setAttribute("aria-label", words.placeholder);
        entries = [...reply.launcher.entries];
        draw();
    });
}
