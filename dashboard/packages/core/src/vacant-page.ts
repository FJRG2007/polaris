/**
 * The page a hostname with nothing behind it answers with.
 *
 * Polaris hands out names under a wildcard, so every label in that zone resolves and
 * reaches the edge whether or not anything was ever deployed on it. Until now the edge
 * answered those two ways, neither of them a page: Traefik's own `404 page not found`
 * for a name no router claims, and `Bad Gateway` for a name whose app is stopped. Both
 * read as a broken site to the person in front of them, and the second one reads as an
 * outage to the operator who merely stopped a container.
 *
 * So the edge answers with a page that says which of the two it is. The wording is the
 * whole feature: "nothing is deployed here" and "the app here is not running" are
 * different problems with different fixes, and a visitor who is the operator can act on
 * either one.
 *
 * The status stays honest - 404 for a name with nothing on it, 502 for an app that is
 * not answering - because that is what every client behind the browser reads, and it is
 * what lets the subdomain-sweep jail tell a name being probed from a name being used.
 * That the two differ is an oracle for whether a subdomain exists; it is one the status
 * code already gave away long before this page did, and the answer to someone walking
 * the zone to collect it is the jail, not vaguer wording.
 */

import { edgePage, edgeText } from "./edge-page.js";

/**
 * Where the edge guard serves this page: one path per state.
 *
 * Namespaced under a path no app would route, because the same listener also proxies
 * app traffic: a route that reached the guard by mistake must not be able to ask for
 * this instead of the app. Traefik rewrites the visitor's path to one of these, so
 * nobody types them and they do not have to be short.
 *
 * The state is the path rather than a parameter because Traefik's path rewrite keeps
 * the visitor's own query string. A `?state=` would therefore be theirs to set, and
 * every name in the zone could be made to claim it has an app that is merely down.
 */
export const VACANT_PATH = "/__polaris/vacant";
export const VACANT_DOWN_PATH = `${VACANT_PATH}/down`;

/**
 * Response header the page carries, so the control plane can tell a guard that serves
 * it from one too old to know the path. An older guard answers there with its generic
 * `Bad gateway`, which is a 502 with no way to recognise it - and pointing the edge at
 * a page that does not exist is how a stopped app turns into a worse error than the one
 * it had. See the sidecar drift the email proxy hit for why this is checked rather than
 * assumed.
 */
export const VACANT_HEADER = "x-polaris-page";
export const VACANT_HEADER_VALUE = "vacant";

/** Which of the two nothings this is. */
export type VacantState = "missing" | "down";

export interface VacantPageInput {
    /** An id for the visitor to quote back. */
    readonly reference: string;
    /** The hostname that was asked for. */
    readonly host?: string;
    /** `missing` when no service claims the name, `down` when one does and is not
     *  answering. */
    readonly state: VacantState;
}

/** A struck-through circle, drawn as the contents of a stroked 24x24 viewBox. Kept to
 *  two strokes because it is rendered at 14px, where anything busier is a smudge. */
const EMPTY = '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>';

/** A stopped square inside a circle, for an app that is deployed and not running. */
const STOPPED = '<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>';

/** The HTTP status each state answers with. */
export function vacantStatus(state: VacantState): number {
    return state === "down" ? 502 : 404;
}

/** The machine-readable code the page shows, for a report that quotes it. */
export function vacantCode(state: VacantState): string {
    return state === "down" ? "SERVICE_NOT_RUNNING" : "NO_SERVICE_HERE";
}

/** Which of the two the edge asked for, read off the rewritten path. Anything that is
 *  not the down path is a name nothing claims - including the bare path, which is what
 *  the catch-all router rewrites to. */
export function vacantStateForPath(path: string): VacantState {
    const bare = path.split("?")[0] ?? "";
    return bare.replace(/\/+$/, "") === VACANT_DOWN_PATH ? "down" : "missing";
}

/** Render the page for a hostname with nothing serving it. */
export function vacantPage(input: VacantPageInput): string {
    const host = edgeText(input.host, "this address");
    const down = input.state === "down";
    return edgePage({
        title: down ? "502: SERVICE_NOT_RUNNING" : "404: NO_SERVICE_HERE",
        badge: down ? "Not running" : "Nothing here",
        tone: "muted",
        icon: down ? STOPPED : EMPTY,
        heading: down ? "This app is not running" : "There is nothing running here",
        lead: down
            ? `Something is deployed on ${host}, and it is not answering.`
            : `No service answers on ${host}.`,
        sections: [
            {
                heading: "Why am I seeing this?",
                body: down
                    ? "The app behind this address is stopped, restarting, or failed to start. The name is still routed to it, so this is what the edge has to answer with until it comes back."
                    : "This address is one Polaris can hand out, and nothing is deployed on it. Either it was never used, or whatever had it has since been removed."
            },
            {
                heading: "What can I do about it?",
                body: down
                    ? "If this is yours, open the app in Polaris and check whether it is running and what its logs say. Otherwise it is worth telling whoever sent you here."
                    : "If this is yours, deploy something on this address or point it at an app in Polaris. Otherwise check the link you followed - it may be old."
            }
        ],
        facts: [
            { label: "Code", value: vacantCode(input.state) },
            { label: "Reference ID", value: edgeText(input.reference, "unavailable", 64) }
        ],
        note: "Served by Polaris"
    });
}
