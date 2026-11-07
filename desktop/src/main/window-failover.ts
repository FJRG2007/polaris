/**
 * When the main window goes to the same Polaris on its local address, and when
 * it comes back. Pure, with no `electron` import, so the rules are tested
 * without a runtime.
 *
 * The address itself is picked by the failover in `polaris-api` (see
 * `@polaris/core/instance-fallback`): an alternate is used only after it signed
 * a fresh challenge with the instance key learned over the usual address, and
 * only over TLS this computer trusts - the system's roots, or the instance's own
 * local CA learned over the usual address (`local-ca-pin`). Nothing here
 * accepts a certificate; an alternate whose certificate is neither is never
 * proven, so the window never goes there.
 */

import { isServerUrl } from "./navigation";
import { isCertificateError, netErrorCode } from "./reachability";

/** Chromium's codes for an address that did not answer at all - the internet, DNS or the route to it is gone. */
const UNANSWERED: ReadonlySet<string> = new Set([
    "ERR_NAME_NOT_RESOLVED",
    "ERR_NAME_RESOLUTION_FAILED",
    "ERR_INTERNET_DISCONNECTED",
    "ERR_NETWORK_CHANGED",
    "ERR_CONNECTION_REFUSED",
    "ERR_CONNECTION_RESET",
    "ERR_CONNECTION_CLOSED",
    "ERR_CONNECTION_FAILED",
    "ERR_CONNECTION_TIMED_OUT",
    "ERR_TIMED_OUT",
    "ERR_ADDRESS_UNREACHABLE",
    "ERR_NETWORK_UNREACHABLE",
    "ERR_PROXY_CONNECTION_FAILED",
    "ERR_TUNNEL_CONNECTION_FAILED"
]);

/**
 * Whether a failed load is the address not answering, which another address of
 * the same Polaris may get around. A certificate error is not: that address did
 * answer, with something this computer does not trust.
 */
export function triggersFailover(code: string | null): boolean {
    return code !== null && !isCertificateError(code) && UNANSWERED.has(code);
}

/** What to do with a failed load of the main window. */
export type FailedLoad = "ignore" | "failover" | "error";

/**
 * A `did-fail-load` of the main frame, given the origin the window is on now.
 * -3 is a load another one replaced (a redirect, a click): nothing wrong.
 */
export function failedLoadStep(code: number, description: string, url: string, active: string): FailedLoad {
    if (code === -3 || !isServerUrl(url, active)) return "ignore";
    return triggersFailover(netErrorCode(description)) ? "failover" : "error";
}

/**
 * The same place - path, query and hash - on `origin`, or null for a URL that
 * cannot be read. Moves only within the one Polaris: the caller passes an
 * origin the failover proved.
 */
export function samePlaceOn(url: string, origin: string): string | null {
    try {
        const from = new URL(url);
        const to = new URL(origin);
        if (!["http:", "https:"].includes(from.protocol) || !["http:", "https:"].includes(to.protocol)) return null;
        return `${to.origin}${from.pathname}${from.search}${from.hash}`;
    } catch {
        return null;
    }
}

/**
 * The one origin Polaris windows may be on: the proven alternate while the
 * window is on it, otherwise the usual address. Never both.
 */
export function activeOrigin(primary: string | null, alternate: string | null): string | null {
    if (!primary) return null;
    return alternate ?? primary;
}

/** What a recheck of the usual address means for a window on an alternate. */
export type BackStep = "stay" | "now" | "on-blur";

/**
 * The failover answered `resolved` on its recheck. Back to the usual address
 * when it answers: at once when the window is not in use, otherwise as soon as
 * the person leaves it, so a form being typed is not reloaded under them.
 */
export function backStep(resolved: string, primary: string, focused: boolean): BackStep {
    if (resolved !== primary) return "stay";
    return focused ? "on-blur" : "now";
}

/** The window title while on an alternate: the page's own, then the words. */
export function titleWith(title: string, words: string | null): string {
    if (!words) return title;
    const base = title.trim();
    return base ? `${base} - ${words}` : words;
}

/**
 * Mark a refused certificate in a thrown `net.fetch` error the way the failover
 * reads one (`isCertificateFailure`, which knows Node's codes), so a local
 * address that failed only on its certificate is reported as untrusted rather
 * than as not answering. Answers the same error.
 */
export function markCertificateFailure(caught: unknown): unknown {
    if (caught && typeof caught === "object" && isCertificateError(netErrorCode(String(caught)))) {
        Object.assign(caught, { code: "CERT_UNTRUSTED" });
    }
    return caught;
}
