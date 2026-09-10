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
 */

const WEB = new Set(["http:", "https:"]);

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
