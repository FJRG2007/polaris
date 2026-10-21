/**
 * Polar in the side panel: the parts that are not drawing.
 *
 * The panel frames the deployment's own `/polar/embed`, so the chat is always
 * the one that Polaris serves and a dashboard update reaches it without an
 * extension release. What the extension adds is the page in front of the
 * person, and only for a site they allowed here: the list of those sites is
 * this extension's own, the page is read by the panel itself (never by a
 * content script, and never from a message a page can send), and it reaches
 * the frame by `postMessage` addressed to the deployment's origin alone.
 *
 * Mirrors `apps/web/src/lib/polar/embed-bridge.ts`: the message shapes and the
 * caps are the ones the embed accepts.
 */

/** Who the panel's messages say they are from, and who the embed's are. */
export const FROM_EXTENSION = "polaris-extension";
export const FROM_EMBED = "polaris-embed";

/** The most of a selection and of a page's text the embed takes. */
export const SELECTION_MOST = 4000;
export const TEXT_MOST = 12_000;

/** The shortcut's command: the browser's own sidebar command on Firefox, and
 *  one of ours on Chromium, which opens the side panel from the worker. */
export const OPEN_POLAR = "open-polar";
export const FIREFOX_SIDEBAR = "_execute_sidebar_action";
export const DEFAULT_SHORTCUT = "Alt+P";

/** The browser APIs that open the panel, which neither browser has both of. */
export interface PanelOpeners {
    readonly sidePanel?: { open(options: { windowId: number }): Promise<void> };
    readonly sidebarAction?: { open(): Promise<void> };
}

/**
 * Open Polar beside the page: Chromium's side panel for the window, or
 * Firefox's sidebar. Synchronous up to the browser call, because both open
 * only inside the gesture that asked - one await before and they refuse.
 * True when there was a panel to open.
 */
export function openSidePanel(api: unknown, windowId: number | undefined): boolean {
    const openers = api as PanelOpeners;
    if (openers.sidePanel) {
        if (windowId === undefined) return false;
        openers.sidePanel.open({ windowId }).catch(() => undefined);
        return true;
    }
    if (openers.sidebarAction) {
        openers.sidebarAction.open().catch(() => undefined);
        return true;
    }
    return false;
}

/** What the panel hands the embed about a page. */
export interface SharedPage {
    readonly url: string;
    readonly title?: string;
    readonly selection?: string;
    readonly text?: string;
}

/** The embed's address for this extension, on the deployment at `server`. */
export function embedUrl(server: string, extensionOrigin: string): string {
    const url = new URL("/polar/embed", server);
    url.searchParams.set("ext", extensionOrigin);
    return url.toString();
}

/**
 * The site a tab is on, as consent is kept: a web page's origin, or null for
 * anything that is not one (a browser page, a new tab, a file) and for the
 * deployment itself, whose own Polar already sees its pages.
 */
export function siteOf(url: string | undefined, server: string | null): string | null {
    if (!url) return null;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (server !== null && parsed.origin === new URL(server).origin) return null;
    return parsed.origin;
}

/** The message that hands the embed a page, or tells it there is none. */
export function pageMessage(page: SharedPage | null): {
    source: string;
    kind: "page";
    page: SharedPage | null;
} {
    return { source: FROM_EXTENSION, kind: "page", page };
}

/** Whether a message that reached the panel is the embed asking for the page
 *  again - and only from the frame it put there, on the deployment's origin. */
export function isRefresh(
    event: { data: unknown; origin: string; source: unknown },
    frame: unknown,
    server: string
): boolean {
    if (event.source !== frame || event.origin !== new URL(server).origin) return false;
    const data = event.data as { source?: unknown; kind?: unknown } | null;
    return (
        typeof data === "object" &&
        data !== null &&
        data.source === FROM_EMBED &&
        data.kind === "refresh"
    );
}

/** A page as read, trimmed to what the embed takes. */
export function trimPage(raw: {
    url?: unknown;
    title?: unknown;
    selection?: unknown;
    text?: unknown;
}): SharedPage | null {
    if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) return null;
    const cut = (value: unknown, most: number): string | undefined =>
        typeof value === "string" && value.trim() ? value.trim().slice(0, most) : undefined;
    return {
        url: raw.url.slice(0, 2048),
        title: cut(raw.title, 200),
        selection: cut(raw.selection, SELECTION_MOST),
        text: cut(raw.text, TEXT_MOST)
    };
}

/**
 * Runs inside the tab, so it is self-contained: the browser serializes it.
 * The page's readable text is the main article's when it marks one, the
 * body's otherwise - what a person reading it sees, not its markup.
 */
export function readPageInTab(): {
    url: string;
    title: string;
    selection: string;
    text: string;
} {
    const root = document.querySelector("article, main, [role=main]") ?? document.body;
    return {
        url: location.href,
        title: document.title,
        selection: String(window.getSelection?.() ?? ""),
        text: (root as HTMLElement | null)?.innerText?.slice(0, 24_000) ?? ""
    };
}

/**
 * A shortcut as Firefox's `commands.update` takes it, from a key press, or
 * null for a press that cannot be one: a modifier (Ctrl, Alt, or Command on a
 * Mac) and a letter, digit or function key. Shift only as a second modifier.
 */
export function shortcutFrom(
    press: {
        code: string;
        ctrlKey: boolean;
        altKey: boolean;
        shiftKey: boolean;
        metaKey: boolean;
    },
    mac: boolean
): string | null {
    const key = /^Key([A-Z])$/.exec(press.code)?.[1] ?? /^Digit([0-9])$/.exec(press.code)?.[1];
    const fn = /^F([1-9]|1[0-2])$/.test(press.code) ? press.code : null;
    const main = key ?? fn;
    if (!main) return null;
    const mods: string[] = [];
    if (mac ? press.metaKey : press.ctrlKey) mods.push(mac ? "Command" : "Ctrl");
    if (mac && press.ctrlKey) mods.push("MacCtrl");
    if (press.altKey) mods.push("Alt");
    if (mods.length > 2) return null;
    if (press.shiftKey) mods.push("Shift");
    if (mods.length > 2) return null;
    // A letter or digit needs a real modifier; a function key may stand alone.
    if (!fn && mods.filter((mod) => mod !== "Shift").length === 0) return null;
    return [...mods, main].join("+");
}

/** Where a Chromium browser changes an extension's shortcuts. */
export function shortcutsPage(browserName: string): string {
    if (browserName === "Edge") return "edge://extensions/shortcuts";
    if (browserName === "Opera") return "opera://extensions/shortcuts";
    return "chrome://extensions/shortcuts";
}
