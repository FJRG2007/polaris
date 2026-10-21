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

/**
 * The shortcut's command, ours on both browsers so the worker hears it and can
 * hand it to Polaris's own Polar on a Polaris tab. Firefox's reserved sidebar
 * command never reaches the worker, so it could only ever open the sidebar.
 */
export const OPEN_POLAR = "open-polar";
export const FIREFOX_SIDEBAR = "_execute_sidebar_action";
/**
 * The key Polaris itself opens Polar with (`PolarProvider` in the dashboard),
 * so the same press does the same thing in and out of Polaris. Chromium only:
 * Ctrl+J is Firefox's Downloads window, and Firefox never calls an extension
 * for a key it keeps, so Firefox keeps Alt+P.
 */
export const POLARIS_SHORTCUT = "Ctrl+J";
export const POLARIS_SHORTCUT_MAC = "Command+J";
export const FIREFOX_SHORTCUT = "Alt+P";
export const DEFAULT_SHORTCUT = POLARIS_SHORTCUT;

/** Where Polar opens: the one panel every tab shares, or one per tab. */
export type PanelScope = "all" | "tab";
/** Whose conversation the panel shows: one for every tab, or one per tab. */
export type ChatScope = "shared" | "tab";
export const PANEL_SCOPE_KEY = "local:polar.panelScope";
export const CHAT_SCOPE_KEY = "local:polar.chatScope";

/** What a stored choice reads as, whatever was stored: the default otherwise. */
export function readPanelScope(value: unknown): PanelScope {
    return value === "tab" ? "tab" : "all";
}
export function readChatScope(value: unknown): ChatScope {
    return value === "tab" ? "tab" : "shared";
}

interface LocalArea {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
}
const localArea = (api: unknown): LocalArea | undefined =>
    (api as { storage?: { local?: LocalArea } }).storage?.local;

/** Both choices as stored, read straight from the browser's local area under the
 *  names the storage items above use - for screens that do not load WXT's. */
export async function readScopes(api: unknown): Promise<{ panel: PanelScope; chat: ChatScope }> {
    const area = localArea(api);
    const panelName = PANEL_SCOPE_KEY.slice("local:".length);
    const chatName = CHAT_SCOPE_KEY.slice("local:".length);
    const [panel, chat] = await Promise.all([
        area?.get(panelName).catch(() => ({})) ?? {},
        area?.get(chatName).catch(() => ({})) ?? {}
    ]);
    return {
        panel: readPanelScope((panel as Record<string, unknown>)[panelName]),
        chat: readChatScope((chat as Record<string, unknown>)[chatName])
    };
}

/** Store one of the choices. */
export async function saveScope(
    api: unknown,
    which: "panel" | "chat",
    value: PanelScope | ChatScope
): Promise<void> {
    const key = (which === "panel" ? PANEL_SCOPE_KEY : CHAT_SCOPE_KEY).slice("local:".length);
    await localArea(api)?.set({ [key]: value });
}

/** The panel's page; a tab's own panel carries its tab so it knows whose it is. */
export const PANEL_PAGE = "sidepanel.html";
export function panelPath(tabId?: number): string {
    return tabId === undefined ? PANEL_PAGE : `${PANEL_PAGE}?tab=${tabId}`;
}

/** The port an open panel holds to the worker: connected exactly while it is open. */
export const PANEL_PORT = "polar-panel";

/** What a panel and the worker say over that port. */
export type PanelMessage =
    | { kind: "hello"; windowId: number | null; tabId: number | null }
    | { kind: "bounce"; tabId: number }
    | { kind: "close" }
    | { kind: "ask"; quote?: string; draft?: string };

/** Something to ask Polar, from a right-click entry. */
export interface PolarAsk {
    readonly quote?: string;
    readonly draft?: string;
}

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
export function embedUrl(server: string, extensionOrigin: string, chat?: string | null): string {
    const url = new URL("/polar/embed", server);
    url.searchParams.set("ext", extensionOrigin);
    if (chat) url.searchParams.set("chat", chat);
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

/**
 * Whether a tab is on one of the Polaris deployments this browser is connected
 * to, whose own pages already carry Polar - where the extension's panel would
 * be a second copy of the same chat.
 */
export function isPolarisTab(url: string | undefined, origins: Iterable<string>): boolean {
    if (!url) return false;
    let origin: string;
    try {
        origin = new URL(url).origin;
    } catch {
        return false;
    }
    if (origin === "null") return false;
    for (const one of origins) {
        try {
            if (new URL(one).origin === origin) return true;
        } catch {
            // A saved address that is not one is nobody's tab.
        }
    }
    return false;
}

function trimAsk(ask: PolarAsk): PolarAsk {
    const quote = ask.quote?.trim().slice(0, SELECTION_MOST);
    const draft = ask.draft?.trim().slice(0, 2000);
    return { ...(quote ? { quote } : {}), ...(draft ? { draft } : {}) };
}

/**
 * What a Polaris page is told: open or close its own Polar (what its own Ctrl+J
 * does), or open it with something to ask. Mirrors `polarCommandFrom` in the
 * dashboard's `lib/polar/embed-bridge.ts`.
 */
export function polarisCommand(ask?: PolarAsk): {
    source: string;
    kind: "polar";
    action: "toggle" | "ask";
    quote?: string;
    draft?: string;
} {
    if (!ask) return { source: FROM_EXTENSION, kind: "polar", action: "toggle" };
    return { source: FROM_EXTENSION, kind: "polar", action: "ask", ...trimAsk(ask) };
}

/** The message that hands the embed something to ask. */
export function askMessage(ask: PolarAsk): {
    source: string;
    kind: "ask";
    quote?: string;
    draft?: string;
} {
    return { source: FROM_EXTENSION, kind: "ask", ...trimAsk(ask) };
}

/**
 * Runs inside a Polaris tab, so it is self-contained: hands the page the
 * command, addressed to its own origin. The page checks the message came from
 * its own window and origin before it does anything with it.
 */
export function postToPolarisPage(message: unknown): void {
    window.postMessage(message, location.origin);
}

/** Send a Polaris tab its command, the way each browser lets an extension. */
export function sendToPolarisTab(api: unknown, tabId: number, message: unknown): void {
    const scripting = (
        api as {
            scripting?: {
                executeScript(details: {
                    target: { tabId: number };
                    func: (message: unknown) => void;
                    args: unknown[];
                }): Promise<unknown>;
            };
        }
    ).scripting;
    if (scripting?.executeScript) {
        scripting
            .executeScript({ target: { tabId }, func: postToPolarisPage, args: [message] })
            .catch(() => undefined);
        return;
    }
    // Manifest v2 (Firefox): the older call, with the same function serialized.
    const tabs = (
        api as {
            tabs?: { executeScript?(id: number, details: { code: string }): Promise<unknown> };
        }
    ).tabs;
    tabs
        ?.executeScript?.(tabId, {
            code: `(${postToPolarisPage.toString()})(${JSON.stringify(message)})`
        })
        ?.catch(() => undefined);
}

/** Chromium's side panel calls used here, as far as each version has them. */
export interface SidePanelApi {
    open(options: { windowId?: number; tabId?: number }): Promise<void>;
    setOptions(options: { tabId?: number; path?: string; enabled?: boolean }): Promise<void>;
    /** Chrome 141 and later. */
    close?(options: { windowId?: number; tabId?: number }): Promise<void>;
}

/**
 * Open Polar for a tab, in the scope somebody chose. Synchronous up to the
 * browser call, like `openSidePanel`. One panel per tab is a panel set on that
 * tab alone and opened there; the browser hides it on every other tab. Firefox
 * has one sidebar per window, so there it is always the shared one.
 */
export function openPolarFor(
    api: unknown,
    tab: { id?: number; windowId?: number },
    scope: PanelScope
): boolean {
    const side = (api as { sidePanel?: SidePanelApi }).sidePanel;
    if (side && scope === "tab" && tab.id !== undefined) {
        // Not awaited: the open has to be in the same turn as the gesture, and
        // the browser runs the two calls in the order they were made.
        side.setOptions({ tabId: tab.id, path: panelPath(tab.id), enabled: true }).catch(
            () => undefined
        );
        side.open({ tabId: tab.id }).catch(() => undefined);
        return true;
    }
    return openSidePanel(api, tab.windowId);
}

/**
 * What the shortcut does on a tab: hand it to Polaris's own Polar there, close
 * the panel that is open, or open one.
 */
export type PolarRoute = "polaris" | "close" | "open";
export function routeFor(
    tab: { url?: string } | undefined,
    origins: Iterable<string>,
    panelOpen: boolean
): PolarRoute {
    if (isPolarisTab(tab?.url, origins)) return "polaris";
    return panelOpen ? "close" : "open";
}

/** The conversation a panel shows, for the embed: none for the one every tab
 *  shares, the tab's own otherwise. */
export function chatScopeFor(scope: ChatScope, tabId: number | null): string | null {
    return scope === "tab" && tabId !== null ? `tab-${tabId}` : null;
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

/** Whether this is Firefox, which has a sidebar where Chromium has a side panel. */
export function isFirefox(api: unknown): boolean {
    return typeof (api as PanelOpeners).sidebarAction !== "undefined";
}

/** Where a Chromium browser changes an extension's shortcuts. */
export function shortcutsPage(browserName: string): string {
    if (browserName === "Edge") return "edge://extensions/shortcuts";
    if (browserName === "Opera") return "opera://extensions/shortcuts";
    return "chrome://extensions/shortcuts";
}
