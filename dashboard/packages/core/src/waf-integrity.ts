/**
 * The browser integrity check: does this request's headers hold together as a
 * browser's?
 *
 * The rule packs ask what a request wanted - `/.env`, `/wp-admin`, a scanner's own
 * user agent. This asks something different and orthogonal: whether the client is
 * what it says it is. A harvester that sets `User-Agent: Mozilla/5.0 ...` and sends
 * nothing else defeats a user-agent blocklist by construction, and is caught here by
 * the headers it did not bother to forge.
 *
 * The line it draws is deliberate, and it is the reason this is safe to arm on a
 * scope that also serves an API: it never refuses a client for failing to be a
 * browser, only for CLAIMING to be one and then not behaving like one. `curl/8.7.1`
 * with no Accept-Language is honest and passes; `Mozilla/5.0 (Windows NT 10.0)` with
 * no Accept header at all is not, and does not. The one exception is a request with no
 * user agent whatsoever, which no browser and no well-made client sends.
 *
 * Pure and I/O-free, like the rest of the guard's decision path: it runs per request
 * inside the co-located guard, where there is nothing to consult and no time to
 * consult it in.
 */

/** The headers this check reads. All are forwarded by the edge; any can be absent,
 *  which is most of what it is looking at. */
export interface WafIntegrityHeaders {
    readonly userAgent?: string | null;
    readonly accept?: string | null;
    readonly acceptLanguage?: string | null;
    readonly acceptEncoding?: string | null;
}

/** A user agent longer than this is not a browser's; it is a buffer somebody is
 *  probing with. Real ones top out around 200 characters. */
const USER_AGENT_MAX = 512;

/** Tokens that mean "I am a graphical browser". A client carrying one of these has
 *  made a claim the rest of its headers have to support. `mozilla/` covers Chrome,
 *  Firefox, Safari and Edge, all of which still open with it for historical reasons. */
const BROWSER_CLAIMS = ["mozilla/", "opera/", "chrome/", "safari/"];

/** Present and not just whitespace. */
function has(value: string | null | undefined): value is string {
    return typeof value === "string" && value.trim() !== "";
}

/** A C0 control or DEL anywhere in the value. Written as a scan rather than a regex
 *  because the character class would be a row of escapes nobody can read or review. */
function hasControlCharacter(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f) return true;
    }
    return false;
}

/**
 * Why the request fails the check, or null when it passes.
 *
 * A reason rather than a boolean because it is written into the refusal: an operator
 * looking at a blocked request needs to know which of these fired, both to trust it
 * and to turn it off when it is wrong.
 */
export function browserIntegrityFailure(headers: WafIntegrityHeaders): string | null {
    const agent = headers.userAgent;
    if (!has(agent)) return "no user agent";
    // A control character in a user agent is either a broken client or an attempt to
    // split a header somewhere downstream. Neither is traffic worth serving.
    if (hasControlCharacter(agent)) return "malformed user agent";
    if (agent.length > USER_AGENT_MAX) return "oversized user agent";

    const claimsBrowser = BROWSER_CLAIMS.some((token) => agent.toLowerCase().includes(token));
    if (!claimsBrowser) return null;

    // From here on the client has said it is a browser, so it is held to what one
    // sends. Accept is the strongest single tell: every browser sends it on every
    // request, and scripted clients wearing a browser's user agent routinely omit it.
    if (!has(headers.accept)) return "browser user agent without an Accept header";
    // Language and encoding are individually skippable by a legitimate-but-unusual
    // client, so neither alone is enough. Both missing, on something claiming to be a
    // browser, is not a browser.
    if (!has(headers.acceptLanguage) && !has(headers.acceptEncoding)) {
        return "browser user agent without Accept-Language or Accept-Encoding";
    }
    return null;
}
