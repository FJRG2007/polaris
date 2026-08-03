/**
 * Who a request says it is coming from: the address, the browser, and which of
 * this deployment's names it arrived on.
 *
 * Every one of these reads a header, and a header is the caller's to write. They
 * are labels - what a session list shows so a person can tell one of their
 * devices from another - and never an input to a decision. The one exception is
 * the address, which does feed the account's network rules; how far the
 * forwarded header is believed is settled by the trusted-proxy configuration
 * before it gets here.
 *
 * Pure so the same parse serves the places that hold a Headers object (a
 * better-auth hook) and the places that reach for the request store (a server
 * action), rather than each growing its own copy to drift.
 */

/** Anything that can be asked for a header: a `Headers`, or the read-only view
 *  Next hands a server component. Structural so neither side has to import the
 *  other's type. */
export interface HeaderSource {
    get(name: string): string | null;
}

/** Best-effort client address from the forwarded headers, or undefined. */
export function originIp(headers: HeaderSource): string | undefined {
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwarded || headers.get("x-real-ip")?.trim() || undefined;
}

/** The client user-agent string, or undefined. */
export function originUserAgent(headers: HeaderSource): string | undefined {
    return headers.get("user-agent")?.trim() || undefined;
}

/** Hostnames are matched, stored and shown as this; anything else is dropped
 *  rather than kept, since a Host header is the caller's to write. */
const HOSTNAME = /^[a-z0-9.-]+$/;

/**
 * The name this deployment was reached under, without the port. Polaris answers
 * on several - polaris.local on the LAN, its domain from outside - and which one
 * a request came in on is what tells two otherwise identical sessions apart.
 */
export function originHost(headers: HeaderSource): string | undefined {
    const header = headers.get("x-forwarded-host") ?? headers.get("host");
    const host = header?.split(",")[0]?.trim().toLowerCase().replace(/:\d+$/, "");
    return host && HOSTNAME.test(host) ? host : undefined;
}
