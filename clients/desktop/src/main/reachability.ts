/**
 * Why the Polaris could not be opened, in words. Pure, so the sentences are
 * tested without a network.
 *
 * Chromium reports a failed load as a code (`ERR_NAME_NOT_RESOLVED`); the reader
 * needs to know which of their own mistakes or circumstances it is - a typo, an
 * offline laptop, a server that is down, a certificate this computer does not
 * trust - and what to do about it.
 */

/** The Chromium error code inside a message or description, if there is one. */
export function netErrorCode(text: string): string | null {
    return /ERR_[A-Z0-9_]+/.exec(text)?.[0] ?? null;
}

/**
 * Everything a thrown network error says, its causes included: a wrapped error
 * ("fetch failed") keeps Chromium's or Node's code on its `cause`, and reading
 * only the outer message loses the reason.
 */
export function errorText(caught: unknown): string {
    const parts: string[] = [];
    let at: unknown = caught;
    for (let depth = 0; at !== undefined && at !== null && depth < 4; depth += 1) {
        parts.push(String(at));
        if (typeof at !== "object") break;
        const code = (at as { code?: unknown; }).code;
        if (typeof code === "string") parts.push(code);
        at = (at as { cause?: unknown; }).cause;
    }
    return parts.join(" ");
}

/** Said whenever the app is already asking again by itself. */
export const RECONNECTS_WORDS = "This app reconnects by itself as soon as it answers.";

/** The window ended on the worker's offline page: the server is up somewhere but
 *  not answering yet - most often restarting for an update. Not a wrong address. */
export function describeOfflinePage(host: string): string {
    return `Polaris at ${host} is restarting or not answering yet. ${RECONNECTS_WORDS}`;
}

/** The titles of the page Polaris's service worker answers with when the server is
 *  gone. The load succeeds, so no failure event ever reports it. */
const OFFLINE_TITLES: ReadonlySet<string> = new Set([
    "Polaris is not reachable",
    "No se puede acceder a Polaris"
]);

/** Whether a page with this title is that one, in place of a Polaris. */
export function isOfflinePage(title: string): boolean {
    return OFFLINE_TITLES.has(title.trim());
}

/** What a finished load means, given whether the last one ended on that page. */
export function finishedLoad(title: string, wasOffline: boolean): "offline" | "recovered" | "online" {
    if (isOfflinePage(title)) return "offline";
    return wasOffline ? "recovered" : "online";
}

/** Whether a Chromium error code is a certificate this computer does not trust. */
export function isCertificateError(code: string | null): boolean {
    return code !== null && (code.startsWith("ERR_CERT_") || code === "ERR_SSL_PROTOCOL_ERROR" || code === "ERR_BAD_SSL_CLIENT_AUTH_CERT");
}

/** A sentence for a failed load of `host`, from Chromium's error code. */
export function describeNetError(code: string | null, host: string): string {
    if (!code) return `Could not reach ${host}.`;
    if (code === "ERR_NAME_NOT_RESOLVED" || code === "ERR_NAME_RESOLUTION_FAILED") {
        return `${host} does not resolve to a server. Check the address for a typo.`;
    }
    if (code === "ERR_INTERNET_DISCONNECTED" || code === "ERR_NETWORK_CHANGED") {
        return "This computer is not connected to a network.";
    }
    if (code === "ERR_CONNECTION_REFUSED" || code === "ERR_CONNECTION_RESET" || code === "ERR_CONNECTION_CLOSED") {
        return `Nothing is answering at ${host}. The server may be down or restarting.`;
    }
    if (code === "ERR_CONNECTION_TIMED_OUT" || code === "ERR_TIMED_OUT" || code === "ERR_ADDRESS_UNREACHABLE") {
        return `${host} did not answer in time. It may be off, or only reachable from another network.`;
    }
    if (isCertificateError(code)) {
        return `The certificate of ${host} is not trusted by this computer. Use an address of your Polaris that has a trusted certificate.`;
    }
    return `Could not reach ${host} (${code}).`;
}
