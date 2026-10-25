/**
 * Which dashboards an app bundle can run on.
 *
 * The dashboard offers apps one API - the services of `host` and `hostUi`, and
 * the shared libraries a bundle takes instead of carrying - and gives it a
 * version, `MAJOR.MINOR`. A new service raises the minor; taking one away or
 * changing what one takes or returns raises the major. An app says which version
 * it was written against (`polaris.hostApi` in its package.json, written into its
 * bundle's manifest), and runs on any dashboard with the same major and at least
 * that minor: the caret range Grafana plugins and npm use.
 *
 * Pure, so the dashboard, the bundler's tests and an app can all read it.
 */

/** The host API this dashboard provides. Kept equal to `hostApi` in this
 *  package's package.json, which is what the bundler reads. */
export const HOST_API = "1.0";

/** What a bundle built before bundles declared a version was built against. */
export const LEGACY_HOST_API = "1.0";

const VERSION = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/** The two numbers of a `MAJOR.MINOR`, or null for anything else. */
export function parseHostApi(text: unknown): readonly [number, number] | null {
    if (typeof text !== "string") return null;
    const match = VERSION.exec(text.trim());
    return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * Whether an app that needs `required` runs on a dashboard that provides
 * `provided`, and if not, which side has to be updated: the dashboard when the
 * app is newer than it, the app when the dashboard has moved past what it needs.
 */
export type HostApiVerdict =
    { readonly ok: true } | { readonly ok: false; readonly update: "dashboard" | "app" };

export function hostApiVerdict(required: unknown, provided: string = HOST_API): HostApiVerdict {
    const host = parseHostApi(provided);
    if (!host) throw new Error(`The dashboard's host API "${provided}" is not MAJOR.MINOR`);
    const app = required === undefined ? parseHostApi(LEGACY_HOST_API) : parseHostApi(required);
    // A requirement nobody can read was written by a bundler this dashboard
    // does not know, so the newer side is the app's.
    if (!app) return { ok: false, update: "dashboard" };
    if (app[0] < host[0]) return { ok: false, update: "app" };
    if (app[0] > host[0] || app[1] > host[1]) return { ok: false, update: "dashboard" };
    return { ok: true };
}
