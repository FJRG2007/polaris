/**
 * Where a window may go. Pure predicates with no `electron` import, so the rules
 * are tested without a runtime.
 *
 * The invariant: the preload bridge is attached to whatever the main frame
 * loads, and `window.polarisDesktop` is not scoped to an origin by Electron. The
 * dashboard renders text other people wrote - service names, build logs, chat -
 * so a frame that could be pointed at another origin would hand that origin the
 * bridge. Only the configured Polaris is loaded in a window; every other web
 * address is opened in the system browser, and anything that is not a web
 * address is dropped.
 *
 * One exception: a round trip to an outside provider that the Polaris itself
 * starts (linking an account, signing in with one, or signing one of Polar's
 * MCP connectors in). Its state cookie lives in
 * this app's session, so the provider's pages have to be shown here and the
 * callback has to land here. From the moment the Polaris sends the window out
 * until a page of the Polaris is shown again, the main frame may go anywhere on
 * the web. The bridge still answers only a main frame on the Polaris (`ipc`).
 */

const WEB = new Set(["http:", "https:"]);

/** The Polaris routes that send the window to a provider and expect it back. */
const PROVIDER_TRIPS: readonly RegExp[] = [
    /^\/api\/connections\/[a-z0-9_-]+\/(link|signin)$/,
    /^\/api\/polar\/connectors\/[0-9a-f-]{36}\/sign-in$/
];

/** Schemes handed to the operating system: web pages, and a mail link, which
 *  opens the mail app. Nothing else - a `file:` or UNC path, or a custom scheme,
 *  would launch whatever the machine has registered for it. */
const EXTERNAL = new Set(["http:", "https:", "mailto:"]);

function parse(url: string): URL | null {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

/** Whether a URL is on the Polaris this app opens. */
export function isServerUrl(url: string, serverOrigin: string): boolean {
    const target = parse(url);
    return Boolean(target && WEB.has(target.protocol) && target.origin === serverOrigin);
}

/** Whether a URL may be handed to `shell.openExternal`. */
export function isSafeExternalUrl(url: string): boolean {
    const target = parse(url);
    return Boolean(target && EXTERNAL.has(target.protocol));
}

/**
 * What to do with a navigation of the main frame, or a window it opens.
 *
 * - `allow`    - the configured Polaris.
 * - `external` - somewhere else on the web: cancelled here and opened in the
 *                system browser, so a link that has no `target` still works.
 * - `block`    - anything else (`data:`, `file:`, `javascript:`, unparseable).
 */
export type NavigationVerdict = "allow" | "external" | "block";

export function classifyNavigation(url: string, serverOrigin: string): NavigationVerdict {
    if (isServerUrl(url, serverOrigin)) return "allow";
    if (isSafeExternalUrl(url)) return "external";
    return "block";
}

/**
 * The verdict for a link a Polaris page opens in a new window, given the origin
 * the windows may be on right now - null while no server is set or the app is
 * between two of them. An outside link is still opened in the system browser
 * then: it never loads in a window, so it needs no server to be checked against.
 */
export function openVerdict(url: string, serverOrigin: string | null): NavigationVerdict {
    if (serverOrigin) return classifyNavigation(url, serverOrigin);
    return isSafeExternalUrl(url) ? "external" : "block";
}

/** Whether a URL is the Polaris sending the window out to a provider. */
export function startsProviderTrip(url: string, serverOrigin: string): boolean {
    const target = parse(url);
    return Boolean(target && isServerUrl(url, serverOrigin) && PROVIDER_TRIPS.some((trip) => trip.test(target.pathname)));
}

export interface MainFrameStep {
    readonly verdict: NavigationVerdict;
    /** Whether the window is out on a provider's round trip after this step. */
    readonly trip: boolean;
}

/**
 * A navigation or redirect of the main frame, given whether the window is out on
 * a provider's round trip. A trip starts on one of the Polaris routes that begin
 * one and ends when a page of the Polaris is shown again (`did-navigate`).
 */
export function mainFrameStep(url: string, serverOrigin: string, trip: boolean): MainFrameStep {
    if (isServerUrl(url, serverOrigin)) return { verdict: "allow", trip: trip || startsProviderTrip(url, serverOrigin) };
    const target = parse(url);
    if (trip && target && WEB.has(target.protocol)) return { verdict: "allow", trip };
    return { verdict: classifyNavigation(url, serverOrigin), trip };
}

/**
 * Where Back goes from the history entry at `active`: the entry before it when
 * that is on the Polaris, or, from a page elsewhere, the last page of the
 * Polaris before it. Null when there is nowhere to go.
 */
export function backIndex(urls: readonly string[], active: number, serverOrigin: string): number | null {
    const away = !isServerUrl(urls[active] ?? "", serverOrigin);
    for (let index = active - 1; index >= 0; index -= 1) {
        if (isServerUrl(urls[index] ?? "", serverOrigin)) return index;
        if (!away) return null;
    }
    return null;
}

/**
 * A path on the Polaris, as the dashboard asks for one (a notification's link, a
 * logs window). Answers the full URL, or null for anything that is not a plain
 * path on the same origin - `//elsewhere.example`, a full URL, a backslash that a
 * URL parser reads as a slash.
 */
export function serverPath(path: string, serverOrigin: string): string | null {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
    const target = parse(`${serverOrigin}${path}`);
    return target && target.origin === serverOrigin ? target.toString() : null;
}

/**
 * Paths on the Polaris that answer with something other than a dashboard
 * screen: its route handlers (a file, an attachment, a raw paste, the live
 * preview of a server an agent runs - `/api/agents/preview/...`) and the build's
 * own assets. Every screen draws a strip that drags the window (`app-drag-strip`
 * in the dashboard's root layout); these carry none of it, and the preview is a
 * page the agent wrote. The handlers outside `/api` are pinned by a test that
 * reads the dashboard's routes.
 */
const BARE_PATHS: readonly RegExp[] = [
    /^\/api(\/|$)/,
    /^\/_next(\/|$)/,
    /^\/\.well-known(\/|$)/,
    /^\/c\/[^/]+\/files(\/|$)/,
    /^\/p\/[^/]+\/raw(\/|$)/,
    /^\/cli\/[^/]+$/,
    /^\/season-icon\/[^/]+$/
];

/**
 * Whether a URL is a screen of the dashboard on the Polaris: on its origin and
 * not under one of the bare paths. Only such a page draws its own title bar.
 */
export function isDashboardPage(url: string, serverOrigin: string): boolean {
    const target = parse(url);
    return Boolean(target && isServerUrl(url, serverOrigin) && !BARE_PATHS.some((path) => path.test(target.pathname)));
}

/**
 * How a window the dashboard opens on its own origin is framed.
 *
 * - `overlay` - a dashboard screen: the title bar is hidden and the system's
 *               buttons are drawn over the page's header, which drags it.
 * - `native`  - anything else on the origin: the operating system's own frame,
 *               so it moves, resizes and snaps without the page's help, and the
 *               page gets no bridge, since it is not the dashboard.
 *
 * What Electron's custom title bar guide asks of a hidden title bar - the page
 * has to declare its own `app-region: drag` - is only true of the dashboard.
 */
export type PopupChrome = "overlay" | "native";

export function popupChrome(url: string, serverOrigin: string): PopupChrome {
    return isDashboardPage(url, serverOrigin) ? "overlay" : "native";
}

/**
 * Whether a main frame may use the dashboard's bridge: a dashboard screen whose
 * frame really runs on the Polaris's origin. The URL alone is not enough - the
 * live preview is served on the Polaris's address in a sandbox (an opaque
 * origin, `"null"`), and it is a page the agent wrote.
 */
export function isPolarisFrame(url: string, frameOrigin: string, serverOrigin: string): boolean {
    return frameOrigin === serverOrigin && isDashboardPage(url, serverOrigin);
}

/**
 * Whether a page in a window whose title bar is hidden has to be given the band
 * the window buttons sit in (`foreignPageCss`): every page but a dashboard
 * screen, which draws its own.
 */
export function needsForeignTitleBar(url: string, serverOrigin: string): boolean {
    return !isDashboardPage(url, serverOrigin);
}
