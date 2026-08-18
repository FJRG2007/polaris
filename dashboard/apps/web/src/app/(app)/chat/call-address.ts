"use client";

/**
 * Where to dial the call server, worked out in the browser.
 *
 * The address can be written two ways and the difference is who knows it. An
 * operator pointing at a call server somebody else runs writes the whole thing
 * - `wss://calls.example.com` - because nothing here could guess it. An
 * instance serving its own through its own edge writes a path, `/livekit`, and
 * that is the interesting case: the host is whatever the reader typed to get
 * here, and the server has no way of knowing what that was. One deployment is
 * reached at `polaris.local` from the sofa and at a domain from a phone on
 * mobile data, and both have to work without anybody maintaining a second
 * address in a settings file.
 *
 * So the page answers it. It is on the host in question by definition.
 *
 * The scheme follows the page rather than being written down, which is not a
 * convenience: a browser on HTTPS refuses to open a plain WebSocket, so a call
 * server addressed as `ws://` from an HTTPS page is one the call never reaches.
 * Following the page cannot get that wrong.
 */

/** Turn whatever the server said into something `connect` can dial. */
export function callServerUrl(address: string): string {
    const given = address.trim();
    if (!given) return "";

    // Already absolute. Only the scheme is adjusted, and only where it is
    // unambiguous: an operator who wrote http:// meant this host over plain
    // WebSocket, and LiveKit is dialled as ws rather than http.
    if (/^wss?:\/\//i.test(given)) return given;
    if (/^https:\/\//i.test(given)) return given.replace(/^https:/i, "wss:");
    if (/^http:\/\//i.test(given)) return given.replace(/^http:/i, "ws:");

    // A path: the same host as this page, over the scheme this page is on.
    if (typeof window === "undefined") return given;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const path = given.startsWith("/") ? given : `/${given}`;
    // No trailing slash. The client appends its own, and a doubled one has been
    // a real source of connection failures.
    return `${scheme}//${window.location.host}${path.replace(/\/+$/, "")}`;
}
