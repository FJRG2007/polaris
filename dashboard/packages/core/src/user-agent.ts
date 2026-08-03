/**
 * What a browser says it is: which browser, and which operating system.
 *
 * Every device list on the account is written from this - the sessions, the
 * remembered devices, the passkeys - so one laptop reads the same way wherever
 * it appears. Two lists naming the same machine differently are two lists nobody
 * can reconcile, which on a security screen defeats the point of having them.
 *
 * Both inputs are the caller's to write, so this is a label and never an input
 * to a decision. The reading is coarse for the same reason: a claim is worth
 * repeating at the resolution somebody can recognise their own device by, and no
 * finer.
 *
 * The user-agent on its own cannot name a Chromium browser that rebadges Chrome.
 * Brave, Vivaldi and Arc all report themselves as Chrome deliberately; the
 * client-hints header is where they say who they are. So the hints are preferred
 * when the request carried them, and the user-agent is the fallback for the
 * browsers that send none.
 */

export interface ClientReading {
    browser: string;
    os: string;
    /** "Brave on Windows" - the single string a table cell or a card shows. */
    label: string;
}

/** Brands the hints header carries that name no browser: the engine every
 *  Chromium shares, and the deliberate nonsense entry they all pad the list
 *  with so parsers cannot assume a fixed shape. */
const UNNAMED_BRAND = /^chromium$|not.?a.?brand/i;

/** A hints header is a header. Read a bounded amount of it and no more. */
const MAX_BRANDS = 256;

/** The browser named by a `sec-ch-ua` value, or null when it names none. */
function brandFromHints(brands: string | null | undefined): string | null {
    if (!brands) return null;
    for (const [, brand] of brands.slice(0, MAX_BRANDS).matchAll(/"([^"]{1,40})"/g)) {
        const name = brand?.trim();
        if (!name || UNNAMED_BRAND.test(name)) continue;
        // Chrome is the only one that brands itself with the vendor attached.
        return name === "Google Chrome" ? "Chrome" : name;
    }
    return null;
}

function browserFromUserAgent(userAgent: string): string {
    return (
        /\bEdg\//.test(userAgent) ? "Edge"
        : /\bOPR\//.test(userAgent) ? "Opera"
        : /\bVivaldi\//.test(userAgent) ? "Vivaldi"
        : /\bSamsungBrowser\//.test(userAgent) ? "Samsung Internet"
        : /\bFirefox\//.test(userAgent) ? "Firefox"
        : /\bChrome\//.test(userAgent) ? "Chrome"
        : /\bSafari\//.test(userAgent) ? "Safari"
        : "Browser"
    );
}

/** Android and ChromeOS both say Linux, and an iPad says Mac, so the narrower
 *  claims are read first. */
function osFromUserAgent(userAgent: string): string {
    return (
        /Windows/.test(userAgent) ? "Windows"
        : /Android/.test(userAgent) ? "Android"
        : /iPhone|iPad|iPod|iOS/.test(userAgent) ? "iOS"
        : /Mac OS X|Macintosh/.test(userAgent) ? "macOS"
        : /CrOS/.test(userAgent) ? "ChromeOS"
        : /Linux/.test(userAgent) ? "Linux"
        : "Unknown OS"
    );
}

/**
 * The browser and operating system a request described itself with.
 *
 * @param userAgent The `user-agent` header, as stored against the row.
 * @param brands The `sec-ch-ua` header, when one was recorded. It is what names
 *               a browser the user-agent hides.
 */
export function describeClient(
    userAgent: string | null | undefined,
    brands?: string | null
): ClientReading {
    if (!userAgent) return { browser: "Unknown browser", os: "Unknown OS", label: "Unknown device" };
    const browser = brandFromHints(brands) ?? browserFromUserAgent(userAgent);
    const os = osFromUserAgent(userAgent);
    return { browser, os, label: `${browser} on ${os}` };
}

/** The one-line reading, for the lists that show a device as a single string. */
export function describeDevice(
    userAgent: string | null | undefined,
    brands?: string | null
): string {
    return describeClient(userAgent, brands).label;
}
