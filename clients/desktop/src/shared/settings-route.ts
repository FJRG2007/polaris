/**
 * Where Settings... opens: the host's own Settings > This app, inside the
 * Polaris window with its sidebar and search, whenever the host has that
 * screen; the page bundled with the app only when it does not.
 *
 * The page the window is on says it draws these settings (`announce`), and then
 * the app only asks it to open a category. When it has not said so - the
 * window is on the sign-in page, an error page, or a host older than the
 * screen - the host itself is asked whether the screen exists, so a host that
 * has it is opened there and only a host that does not, or none at all, gets
 * the bundled page, told why so it can offer the update or the connection.
 *
 * Pure, so the decision can be asserted without Electron.
 */

import { readAppSettingCategory, type AppSettingCategory } from "@polaris/core/app-settings";

/** A category of This app, or the device add-ons listed after them. */
export type SettingsPlace = AppSettingCategory | "addons";

/** The address of a place on the host. */
export function settingsPath(place: SettingsPlace): string {
    return place === "addons" ? "/account/addons" : `/account/app/${place}`;
}

/** A place named by a page, or null for anything else. */
export function readSettingsPlace(raw: unknown): SettingsPlace | null {
    return raw === "addons" ? "addons" : readAppSettingCategory(raw);
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

/** Why the bundled page is opened instead, shown at its top with what fixes it. */
export type LocalSettingsReason = "offline" | "outdated";

/** What the bundled page is told when it opens: the place, and why it is open. */
export interface LocalSettingsState {
    readonly place: SettingsPlace;
    readonly reason: LocalSettingsReason | null;
    /** Whether the person signed in may update the host, as the host itself
     *  answers for its update page; only then is the update offered. */
    readonly canUpdate?: boolean;
}

export type SettingsRoute =
    /** The window's page draws them: ask it to open the place. */
    | { readonly kind: "page"; readonly path: string; }
    /** The host has the screen: load it in the Polaris window. */
    | { readonly kind: "navigate"; readonly path: string; }
    /** Ask the host first; decided again with its answer. */
    | { readonly kind: "probe"; readonly path: string; }
    /** The bundled page, and why. Null on the first run, with no host yet. */
    | { readonly kind: "local"; readonly reason: LocalSettingsReason | null; };

export interface SettingsRouteState {
    /** The host the windows are open on, or null before any. */
    readonly origin: string | null;
    /** Whether the Polaris window exists and its page has not crashed. */
    readonly pageLoaded: boolean;
    /** Whether that page said it draws these settings. */
    readonly pageAnnounced: boolean;
    /** The host's answer, once asked; null before. */
    readonly probe: SettingsProbe | null;
}

export function settingsRoute(place: SettingsPlace, state: SettingsRouteState): SettingsRoute {
    const path = settingsPath(place);
    if (!state.origin) return { kind: "local", reason: null };
    if (!state.pageLoaded) return { kind: "local", reason: "offline" };
    if (state.pageAnnounced) return { kind: "page", path };
    switch (state.probe) {
        case null:
            return { kind: "probe", path };
        case "present":
        case "signed-out":
            // Behind the sign-in the host takes the address back after it, and an
            // older host's sign-in page still beats a page that looks like no other.
            return { kind: "navigate", path };
        case "missing":
            return { kind: "local", reason: "outdated" };
        case "unreachable":
            return { kind: "local", reason: "offline" };
    }
}

/** The host's page that updates it, opened from the bundled page. */
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
export type HostPageOutcome = "opened" | LocalSettingsReason;

/** The host pages the bundled page may open in the Polaris window. */
export function readHostPath(raw: unknown): string | null {
    if (raw === HOST_UPDATE_PATH) return raw;
    const place = typeof raw === "string" ? readSettingsPlace(raw.replace(/^\/account\/(?:app\/)?/, "")) : null;
    return place && settingsPath(place) === raw ? raw : null;
}
