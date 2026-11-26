/**
 * Where Settings... opens - from the tray, the app menu, or anything else that
 * asks for the app's settings: the host's own Settings > This app, inside the
 * Polaris window with its sidebar and search, whenever a host is known. There
 * is one view of these settings and the app draws none of its own: before any
 * host, and on a host older than the screen, the hosts window opens instead,
 * saying why and offering the update.
 *
 * The page the window is on says it draws these settings (`announce`), and then
 * the app only asks it to open a category. When it has not said so - the
 * window is closed, on the sign-in page, an error page, or a host older than
 * the screen - the host is asked whether the screen exists, and only a host
 * that answers that it does not gets the hosts window, told why so it can offer
 * the update. A host that does not answer is opened all the same: the window's
 * service worker keeps every category's page, so the same screen draws offline
 * and every value on it, being this computer's, stays editable.
 *
 * Pure, so the decision can be asserted without Electron.
 */

import type { AppSettingCategory } from "@polaris/core/app-settings";

/** A category of This app, or the device plugins listed after them. */
export type SettingsPlace = AppSettingCategory | "plugins";

/**
 * The plugins' page on the host. Hosts from before the rename serve it only at
 * `/account/addons`, and every host after it keeps that address too, so this one
 * works on all of them. Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
export const HOST_PLUGINS_PATH = "/account/addons";

/** The address of a place on the host. */
export function settingsPath(place: SettingsPlace): string {
    return place === "plugins" ? HOST_PLUGINS_PATH : `/account/app/${place}`;
}

/**
 * What the host answered for the screen's address, asked without following a
 * redirect: there, missing (a host from before it), behind the sign-in, or no
 * answer at all.
 */
export type SettingsProbe = "present" | "missing" | "signed-out" | "unreachable";

/** The probe's verdict from the status the host answered; null when none came. */
export function readSettingsProbe(status: number | null): SettingsProbe {
    if (status === null) return "unreachable";
    if (status >= 200 && status < 300) return "present";
    if (status >= 300 && status < 400) return "signed-out";
    if (status === 404) return "missing";
    return "unreachable";
}

/** What the hosts window is told when Settings... opened it: null on the first
 *  run, "outdated" for a host from before Settings > This app. */
export interface LocalSettingsState {
    readonly reason: "outdated" | null;
    /** Whether the person signed in may update the host, as the host itself
     *  answers for its update page; only then is the update offered. */
    readonly canUpdate?: boolean;
}

export type SettingsRoute =
    /** The window's page draws them: ask it to open the place. */
    | { readonly kind: "page"; readonly path: string; }
    /** Load the host's screen in the Polaris window, opening the window when
     *  there is none; offline its service worker answers from the pages it kept. */
    | { readonly kind: "navigate"; readonly path: string; }
    /** Ask the host first; decided again with its answer. */
    | { readonly kind: "probe"; readonly path: string; }
    /** The hosts window, and why. Null on the first run, with no host yet. */
    | { readonly kind: "local"; readonly reason: LocalSettingsState["reason"]; };

export interface SettingsRouteState {
    /** The host the windows are open on, or null before any. */
    readonly origin: string | null;
    /** Whether the Polaris window exists and its page has not crashed. */
    readonly pageLoaded: boolean;
    /** Whether that page said it draws these settings. */
    readonly pageAnnounced: boolean;
    /** The host's answer, once asked (or "present" for a host already seen with
     *  the screen); null before. */
    readonly probe: SettingsProbe | null;
}

export function settingsRoute(place: SettingsPlace, state: SettingsRouteState): SettingsRoute {
    const path = settingsPath(place);
    if (!state.origin) return { kind: "local", reason: null };
    if (state.pageLoaded && state.pageAnnounced) return { kind: "page", path };
    switch (state.probe) {
        case null:
            return { kind: "probe", path };
        case "present":
        case "signed-out":
        case "unreachable":
            // Behind the sign-in the host takes the address back after it. Out of
            // reach, the window's worker draws the kept page - the same screen -
            // and failing that the window says why and offers the hosts.
            return { kind: "navigate", path };
        case "missing":
            return { kind: "local", reason: "outdated" };
    }
}

/** The host's page that updates it, opened from the hosts window. */
export const HOST_UPDATE_PATH = "/admin/updates";

/**
 * What is asked to learn whether the signed-in person may update the host: the
 * update log, which answers 403 to anybody but an administrator - the same flag
 * the update page checks. The page itself cannot be asked: it streams, so a
 * refused person still gets a 200 whose body redirects them home.
 */
export const HOST_UPDATE_ACCESS_PATH = "/api/updates/logs";

/**
 * Whether the host lets the signed-in person update it, from the answer to
 * `HOST_UPDATE_ACCESS_PATH` asked without following a redirect: 2xx for an
 * administrator; anything else - refused, signed out, a host without that
 * endpoint, no answer - is no update button.
 */
export function readUpdateAccess(status: number | null): boolean {
    return status !== null && status >= 200 && status < 300;
}

/** What came of asking the Polaris window to open a host page. */
export type HostPageOutcome = "opened" | "offline";

/** The one host page the hosts window may open in the Polaris window: the update. */
export function readHostPath(raw: unknown): string | null {
    return raw === HOST_UPDATE_PATH ? raw : null;
}

/**
 * Where a Polaris page's "manage hosts" goes (Hosts > Manage, the account
 * menu): the page's own Settings > This app > Hosts when it said it draws them,
 * and otherwise the hosts window, which says the host is older than this app.
 * The hosts window itself only adds a host and opens one: it is what is shown
 * where no Polaris page can be - the first run, or every host out of reach
 * with nothing kept.
 */
export function hostsRoute(state: { readonly pageLoaded: boolean; readonly pageHosts: boolean; }): "page" | "local" {
    return state.pageLoaded && state.pageHosts ? "page" : "local";
}
