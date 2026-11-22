/**
 * The keys that open Polaris's search, and the rules for the launcher the
 * browser extension draws on other sites. One definition, read by the
 * dashboard's palette (`general.commandPalette` in `shortcuts.ts`), the
 * extension's on-page launcher and Polaris Desktop's global hotkey.
 *
 * Why Alt+Space, and what happens to it on the way to a page:
 *
 * - **Launchers converged on it.** Raycast for Windows, PowerToys Run (before
 *   Command Palette moved to Win+Alt+Space) and Flow Launcher bind Alt+Space by
 *   default; Raycast and Alfred suggest Option+Space on a Mac. They take it with a
 *   system-wide hotkey (RegisterHotKey / a low-level hook on Windows, a Carbon
 *   hotkey on macOS), and a key taken that way is delivered to that program and
 *   never to the focused window - so no page, extension or browser can see it,
 *   detect it, or take it back. That is also how Polaris Desktop wins: when it
 *   owns the global Alt+Space, the press never reaches a browser, the dashboard's
 *   palette and the extension's launcher simply stay quiet, and Desktop's own
 *   window answers. Nothing has to coordinate for "Desktop first" to hold, and a
 *   launcher already holding the key (Raycast and friends) is avoided the same
 *   way: the page cannot be told, because it is never asked.
 * - **Windows' window menu.** Alt+Space is also the system menu of the focused
 *   window. A browser receives the keydown first (WM_SYSKEYDOWN), dispatches it
 *   to the page, and the menu comes from the WM_SYSCHAR that follows. Whether a
 *   page's preventDefault suppresses that menu is the browser's choice: Chromium
 *   generally lets a handled keydown swallow its char, while Firefox documents
 *   leaving Alt+Space to Windows (bugzilla 37660, 606171), so there the menu can
 *   open over the palette. Hence Ctrl/Cmd+K stays bound as the second key on the
 *   dashboard and Alt+Shift+K on other sites: a reader whose Alt+Space is eaten by
 *   the OS or a launcher still has a key that always arrives.
 * - **macOS types with Option.** Option+Space is a non-breaking space, so in a
 *   text field it is typing, not a shortcut - see `launcherPressAllowed`.
 *
 * Pure, with no dependencies beyond the key reader, so the extension's content
 * script stays small: safe in the browser, a content script and Node alike.
 */

import { bindingOfEvent, isBindable } from "./key-binding.js";

/** The dashboard's keys for its palette, in the order hints show them. */
export const LAUNCHER_SHORTCUTS: readonly string[] = ["Alt+Space", "Mod+k"];

/**
 * The extension's keys on other sites. Not Ctrl+K: most web apps with a search
 * of their own (GitHub, Slack, Notion, Linear) answer to it, and Ctrl+Shift+K is
 * Firefox's web console and Edge's "duplicate tab".
 */
export const PAGE_LAUNCHER_SHORTCUTS: readonly string[] = ["Alt+Space", "Alt+Shift+k"];

/** Desktop's global hotkey, in this table's form. Desktop takes it first. */
export const DESKTOP_LAUNCHER_SHORTCUT = "Alt+Space";

/**
 * A binding (`Mod+Shift+k`) as an Electron accelerator (`CommandOrControl+Shift+K`),
 * for Desktop's `globalShortcut.register`.
 */
export function launcherAccelerator(binding: string): string {
    return binding
        .split("+")
        .map((part, at, all) => {
            if (at < all.length - 1) return part === "Mod" ? "CommandOrControl" : part;
            return part.length === 1 ? part.toUpperCase() : part;
        })
        .join("+");
}

/**
 * Whether a launcher press should be taken where it happened. Anywhere outside
 * a text field. Inside one, a Mod binding is still taken - the dashboard's Ctrl+K
 * always was - and so is Alt+Space on Windows and Linux, where it types nothing;
 * on a Mac an Option binding without Cmd types a character (Option+Space is a
 * non-breaking space), so it is left to the field.
 */
export function launcherPressAllowed(
    binding: string,
    where: { readonly editable: boolean; readonly apple: boolean }
): boolean {
    if (!where.editable || !where.apple) return true;
    const parts = binding.split("+");
    return parts.includes("Mod") || !parts.includes("Alt");
}

/** Whether an event target is somewhere text is typed. */
export function isEditableTarget(target: unknown): boolean {
    if (typeof target !== "object" || target === null) return false;
    const element = target as { tagName?: unknown; isContentEditable?: unknown; type?: unknown };
    if (element.isContentEditable === true) return true;
    const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(type);
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

/** Longest site list kept, so a pasted dump cannot grow storage without end. */
export const MAX_LAUNCHER_SITES = 500;

/**
 * One site as it is kept: a lowercase hostname with no scheme, port, path or
 * leading `www.`/`*.`, or null when the text is not one. `https://www.GitHub.com/x`
 * and `*.github.com` both keep as `github.com`.
 */
export function normalizeLauncherSite(raw: string): string | null {
    let text = raw.trim().toLowerCase();
    if (!text) return null;
    text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    text = text.split(/[/?#]/)[0] ?? "";
    text = text.replace(/:\d+$/, "").replace(/^\*\./, "").replace(/^www\./, "").replace(/\.$/, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(text) || text.length > 253) return null;
    return text;
}

/** Whether `hostname` is `site` or one of its subdomains. */
function onSite(hostname: string, site: string): boolean {
    return hostname === site || hostname.endsWith(`.${site}`);
}

export interface LauncherSettings {
    /** The launcher on other sites at all. */
    readonly enabled: boolean;
    /** Its keys, in this module's binding form. */
    readonly shortcuts: readonly string[];
    /** `all`: every site but `sites`. `only`: `sites` and nothing else. */
    readonly mode: "all" | "only";
    readonly sites: readonly string[];
}

export const LAUNCHER_DEFAULTS: LauncherSettings = {
    enabled: true,
    shortcuts: [...PAGE_LAUNCHER_SHORTCUTS],
    mode: "all",
    sites: []
};

/** Most keys one launcher answers to. */
export const MAX_LAUNCHER_SHORTCUTS = 4;

/**
 * A key somebody may give the launcher on other sites: bindable, and held with
 * Alt or Mod - a bare letter or Shift+letter would fire while somebody types on
 * every site on the web.
 */
export function isLauncherBinding(binding: string): boolean {
    const parts = binding.split("+");
    return isBindable(binding) && (parts.includes("Alt") || parts.includes("Mod"));
}

/** Stored settings, read total: anything unreadable is the defaults, and a
 *  field that fails falls back on its own rather than taking the rest with it. */
export function readLauncherSettings(raw: unknown): LauncherSettings {
    const held = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const list = (value: unknown): string[] | null =>
        Array.isArray(value) && value.every((one) => typeof one === "string") ? (value as string[]) : null;
    const shortcuts = list(held.shortcuts)?.filter(isLauncherBinding).slice(0, MAX_LAUNCHER_SHORTCUTS);
    const sites = (list(held.sites) ?? [])
        .map(normalizeLauncherSite)
        .filter((site): site is string => site !== null);
    return {
        enabled: typeof held.enabled === "boolean" ? held.enabled : LAUNCHER_DEFAULTS.enabled,
        shortcuts: shortcuts && shortcuts.length > 0 ? [...new Set(shortcuts)] : [...LAUNCHER_DEFAULTS.shortcuts],
        mode: held.mode === "only" || held.mode === "all" ? held.mode : LAUNCHER_DEFAULTS.mode,
        sites: [...new Set(sites)].slice(0, MAX_LAUNCHER_SITES)
    };
}

/** Which of `shortcuts` a press is, or null. */
export function launcherPress(
    event: Parameters<typeof bindingOfEvent>[0],
    shortcuts: readonly string[]
): string | null {
    const pressed = bindingOfEvent(event);
    return pressed && shortcuts.includes(pressed) ? pressed : null;
}

/** Whether the launcher runs on a page at `hostname` under these settings. */
export function launcherRunsOn(hostname: string, settings: LauncherSettings): boolean {
    if (!settings.enabled) return false;
    const host = normalizeLauncherSite(hostname);
    if (!host) return false;
    const listed = settings.sites.some((site) => onSite(host, site));
    return settings.mode === "only" ? listed : !listed;
}
