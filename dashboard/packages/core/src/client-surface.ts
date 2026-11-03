/**
 * Which Polaris the person is looking at: a browser tab, the desktop app, or
 * the dashboard installed as an app from the browser's menu.
 *
 * One answer for the whole dashboard, so a screen never asks "am I in the
 * desktop app" on its own and words it its own way. What differs between them
 * is described here once, as facts a screen reads (`clientFacts`), and as two
 * values every message can choose its wording by (`clientMessageValues`):
 *
 *     "{surface, select, app {This app} other {This browser}} cannot record video."
 *
 * `surface` is the dimension nearly every sentence needs - is there a browser
 * around Polaris, with tabs and site settings, or is Polaris the app - so a new
 * client is one line in `FACTS` rather than another branch in every catalog.
 * `clientKind` is there for the rare sentence that has to name one of them.
 * Neither is called `host` or `client`, because catalogs already pass those
 * (a hostname, an OAuth client) and a caller's value always wins.
 *
 * A phone or a TV app that renders the dashboard joins by adding its name to
 * `CLIENTS`, its facts to `FACTS`, and the mark its user-agent carries to
 * `clientFromUserAgent`.
 */

export const CLIENTS = ["browser", "desktop", "installed"] as const;
export type Client = (typeof CLIENTS)[number];

/** Whether a browser is wrapped around Polaris (tabs, site permissions, a
 *  download list) or Polaris is the app. */
export type ClientHost = "browser" | "app";

export interface ClientFacts {
    readonly host: ClientHost;
    /** How a notice outside the window is shown: through the browser, which has
     *  to be allowed first, or drawn by the app through the system. */
    readonly notices: "browser-permission" | "system";
    /** Where "something is waiting" is drawn: on the tab's icon, or on the
     *  app's icon in the taskbar or Dock. */
    readonly badge: "tab" | "app-icon";
}

const FACTS: Readonly<Record<Client, ClientFacts>> = {
    browser: { host: "browser", notices: "browser-permission", badge: "tab" },
    desktop: { host: "app", notices: "system", badge: "app-icon" },
    // Installed from the browser's menu: its own window and icon, but the
    // browser still owns permissions and notices.
    installed: { host: "app", notices: "browser-permission", badge: "app-icon" }
};

export function clientFacts(client: Client): ClientFacts {
    return FACTS[client];
}

export function isClient(value: unknown): value is Client {
    return typeof value === "string" && (CLIENTS as readonly string[]).includes(value);
}

/**
 * The client a request comes from, as far as its user-agent says.
 *
 * The desktop app is Electron, which writes its own product name and an
 * `Electron/` token into the user-agent; nothing else a person browses with
 * carries both. An installed web app cannot be told from its browser here - it
 * sends the same user-agent - so it starts as `browser` and the page corrects
 * itself once it can ask the display mode.
 */
export function clientFromUserAgent(userAgent: string | null | undefined): Client {
    if (!userAgent) return "browser";
    return /\bElectron\/\d/.test(userAgent) && /\b(?:Polaris|polaris-desktop)\/\d/.test(userAgent) ? "desktop" : "browser";
}

/** The values every message is formatted with, so a catalog entry can choose
 *  its words by client without the screen passing anything. */
export function clientMessageValues(client: Client): { readonly clientKind: Client; readonly surface: ClientHost } {
    return { clientKind: client, surface: FACTS[client].host };
}
