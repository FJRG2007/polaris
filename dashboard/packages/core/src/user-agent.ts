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

/**
 * The browser named by a `sec-ch-ua` value, or null when it names none.
 *
 * The header is a comma-separated list of `"Brand";v="version"`, so the version
 * is quoted exactly like the brand is. Each entry is therefore read on its own
 * and only its first quoted token taken - reading every quoted string in the
 * header would name browsers after their version numbers.
 */
function brandFromHints(brands: string | null | undefined): string | null {
    if (!brands) return null;
    for (const entry of brands.slice(0, MAX_BRANDS).split(",")) {
        const name = entry.match(/"([^"]{1,40})"/)?.[1]?.trim();
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

// ---------------------------------------------------------------------------
// Restricting a credential to particular clients
// ---------------------------------------------------------------------------

/**
 * Which clients an API key will answer to, alongside the addresses it will
 * answer from.
 *
 * An address says where a key is being used; the user-agent says what is using
 * it. A key minted for one deployment script has no business being replayed from
 * a browser, and one that only ever runs from CI can say so. Neither list is a
 * security boundary on its own - a header is written by whoever makes the request
 * - which is why this narrows a credential that is already proven rather than
 * standing in for proving one.
 */
export interface UserAgentRules {
    /** When non-empty, only a client matching one of these may use the key. */
    allowedUserAgents: string[];
    /** Always refused, even when they match the allow list. */
    deniedUserAgents: string[];
}

/** How long a pattern may be. Long enough for a full user-agent, short enough
 *  that a stored rule cannot be used to make matching expensive. */
export const USER_AGENT_PATTERN_MAX = 200;

/**
 * Whether a user-agent matches one pattern.
 *
 * One rule, so a person writing a list can predict it: the pattern is looked for
 * anywhere in the user-agent, ignoring case, and `*` inside it stands for any run
 * of characters. So `curl` matches `curl/8.4.0`, and `Chrome/1*.*` matches the
 * versions it looks like it should.
 */
export function userAgentMatches(userAgent: string, pattern: string): boolean {
    const trimmed = pattern.trim().slice(0, USER_AGENT_PATTERN_MAX);
    if (!trimmed) return false;
    // Split on the wildcard first, so every other character - spaces, dots and
    // slashes very much included - is matched literally.
    const expression = trimmed
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(expression, "i").test(userAgent);
}

/**
 * Whether a client may use a credential carrying these rules.
 *
 * Denial wins over permission, so a pattern added to keep something out keeps it
 * out however the allow list is later widened - the reverse would make the deny
 * list advisory. An empty allow list means "any client", which is the default a
 * key is created with; a request with no user-agent at all cannot match a
 * pattern, so a key that named the clients it expects refuses it.
 */
export function userAgentAllowed(rules: UserAgentRules, userAgent: string | null | undefined): boolean {
    const client = userAgent ?? "";
    if (rules.deniedUserAgents.some((pattern) => userAgentMatches(client, pattern))) return false;
    if (rules.allowedUserAgents.length === 0) return true;
    return rules.allowedUserAgents.some((pattern) => userAgentMatches(client, pattern));
}
