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

/** How much of the brand list is worth keeping. It is a header, so it is as long
 *  as the caller wants it to be; a real one is well under this. */
const MAX_BRANDS = 256;

/**
 * The browser brands the request announced itself with, or undefined.
 *
 * Recorded alongside the user-agent because it is the only place a Chromium
 * browser that rebadges Chrome - Brave, Vivaldi, Arc - names itself; the
 * user-agent says Chrome on purpose. Browsers that send no hints at all leave
 * this empty and are read from the user-agent as before.
 */
export function originUserAgentBrands(headers: HeaderSource): string | undefined {
    return headers.get("sec-ch-ua")?.trim().slice(0, MAX_BRANDS) || undefined;
}

/** A platform name is one short word. Anything longer is not one. */
const MAX_PLATFORM = 32;

/**
 * The operating system the request announced itself on, or undefined.
 *
 * The other half of the same pair as the brands above, and recorded for a reason
 * of the same shape: a browser told to present itself as a phone rewrites its
 * user-agent and nothing else, so the string says iPhone while the machine is a
 * Windows laptop. This header keeps saying Windows, which makes it the claim
 * worth believing when the two disagree.
 *
 * Sent by every Chromium without being asked for; browsers that send no hints
 * leave it empty and are read from the user-agent as before. The quotes the
 * header wraps the value in are dropped, so what is stored is the bare name.
 */
export function originUserAgentPlatform(headers: HeaderSource): string | undefined {
    const value = headers.get("sec-ch-ua-platform")?.trim().slice(0, MAX_PLATFORM).replace(/^"|"$/g, "");
    return value?.trim() || undefined;
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
