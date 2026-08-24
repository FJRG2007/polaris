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
 *
 * The same holds for the operating system, for a blunter reason: a browser put
 * into its device-emulation mode rewrites the user-agent to a phone's and leaves
 * every hint alone, so the string says iPhone while the machine on the desk is a
 * Windows laptop. A device list that repeats that is not merely imprecise - it
 * shows an account holder a session they have never opened, on a platform they do
 * not own, which is exactly the shape of the thing these lists exist to catch. So
 * the platform hint wins where there is one, and the user-agent's version is
 * dropped rather than transplanted when the two name different systems.
 */

export interface ClientReading {
    browser: string;
    /** The major version, as the client stated it, or null when it stated none.
     *  Major only: a table asking "is this browser current" is answered by 131,
     *  and 131.0.6778.86 is four numbers nobody reads. */
    browserVersion: string | null;
    os: string;
    /** The operating system's version, where the claim carries one. Null on
     *  Linux, which names no version, and on anything unrecognised. */
    osVersion: string | null;
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
 * The brands that announce themselves with the vendor attached, against the name
 * everyone else uses for them.
 *
 * The user-agent path already yields the short name for both of these - `Edg/`
 * reads as Edge, `Chrome/` as Chrome - so without this the same browser is named
 * one way when it sent hints and another when it did not. That is the split this
 * module exists to close: one laptop has to read the same way in every list, and
 * anything keyed on the name (a brand mark, a filter) silently misses the half
 * that came in through the other path.
 *
 * A Map rather than an object literal because the key here is header text: a
 * plain object would answer a lookup for `constructor` or `toString` with
 * something off the prototype, and hand back a browser name nobody sent.
 */
const VENDOR_PREFIXED = new Map([
    ["Google Chrome", "Chrome"],
    ["Microsoft Edge", "Edge"]
]);

/**
 * The browser named by a `sec-ch-ua` value, or null when it names none.
 *
 * The header is a comma-separated list of `"Brand";v="version"`, so the version
 * is quoted exactly like the brand is. Each entry is therefore read on its own
 * and only its first quoted token taken - reading every quoted string in the
 * header would name browsers after their version numbers.
 */
function brandFromHints(brands: string | null | undefined): { name: string; version: string | null } | null {
    if (!brands) return null;
    for (const entry of brands.slice(0, MAX_BRANDS).split(",")) {
        const name = entry.match(/"([^"]{1,40})"/)?.[1]?.trim();
        if (!name || UNNAMED_BRAND.test(name)) continue;
        // The version is the brand's own `v="..."`, read from this entry alone.
        // Taken from the header at large it would be whichever brand came first,
        // which on a Chromium is the padding entry's made-up number.
        const version = entry.match(/v="(\d{1,4})/)?.[1] ?? null;
        return { name: VENDOR_PREFIXED.get(name) ?? name, version };
    }
    return null;
}

/**
 * The browser a user-agent claims, and the token its version is written in.
 *
 * Order matters and is the whole trick: every Chromium keeps `Chrome/` in the
 * string and Safari's token trails all of them, so the narrower claim is tested
 * first and the broadest last. Safari states its own version as `Version/`,
 * because the number after `Safari/` is the engine build and not what anybody
 * calls their browser.
 *
 * A browser writes a different token on each mobile platform, and every one of
 * those trails `Safari/` in the string: iOS forbids any engine but WebKit, so
 * Edge, Opera, Chrome and Firefox there are Safari wearing a name, and each says
 * which name in a token of its own. Miss the token and the row is not merely
 * unnamed, it is named as a competitor - and no hint can correct it, because
 * WebKit sends no `sec-ch-ua` at all. So every token a browser answers to is
 * grouped with its desktop entry and ahead of any broader claim, and `Safari/`
 * stays last as the claim nothing narrower matched. Keeping a browser's own
 * tokens together and above `Chrome/` and `Firefox/` is what makes the order
 * hold on its own: a mobile string that later starts carrying the broad token
 * too would otherwise be read as whichever browser it merely embeds.
 */
const BROWSERS: readonly { readonly test: RegExp; readonly name: string; readonly version: RegExp }[] = [
    { test: /\bEdg\//, name: "Edge", version: /\bEdg\/(\d{1,4})/ },
    { test: /\bEdgA\//, name: "Edge", version: /\bEdgA\/(\d{1,4})/ },
    { test: /\bEdgiOS\//, name: "Edge", version: /\bEdgiOS\/(\d{1,4})/ },
    { test: /\bOPR\//, name: "Opera", version: /\bOPR\/(\d{1,4})/ },
    { test: /\bOPT\//, name: "Opera", version: /\bOPT\/(\d{1,4})/ },
    { test: /\bOPiOS\//, name: "Opera", version: /\bOPiOS\/(\d{1,4})/ },
    { test: /\bVivaldi\//, name: "Vivaldi", version: /\bVivaldi\/(\d{1,4})/ },
    { test: /\bSamsungBrowser\//, name: "Samsung Internet", version: /\bSamsungBrowser\/(\d{1,4})/ },
    { test: /\bFxiOS\//, name: "Firefox", version: /\bFxiOS\/(\d{1,4})/ },
    { test: /\bFirefox\//, name: "Firefox", version: /\bFirefox\/(\d{1,4})/ },
    { test: /\bCriOS\//, name: "Chrome", version: /\bCriOS\/(\d{1,4})/ },
    { test: /\bChrome\//, name: "Chrome", version: /\bChrome\/(\d{1,4})/ },
    { test: /\bSafari\//, name: "Safari", version: /\bVersion\/(\d{1,4})/ }
];

function browserFromUserAgent(userAgent: string): { name: string; version: string | null } {
    for (const entry of BROWSERS) {
        if (!entry.test.test(userAgent)) continue;
        return { name: entry.name, version: userAgent.match(entry.version)?.[1] ?? null };
    }
    return { name: "Browser", version: null };
}

/**
 * The operating system a user-agent claims, and its version where it states one.
 *
 * Android and ChromeOS both say Linux, and an iPad says Mac, so the narrower
 * claims are read first. Apple writes its versions with underscores, so those
 * come back as the dots people read them in.
 *
 * Windows is the one that cannot be pinned down: 10 and 11 both report
 * `Windows NT 10.0`, deliberately, so the number is left off rather than
 * guessed. Telling them apart needs `sec-ch-ua-platform-version`, which is a
 * high-entropy hint a site has to ask for and this deployment does not.
 */
const OPERATING_SYSTEMS: readonly { readonly test: RegExp; readonly name: string; readonly version?: RegExp }[] = [
    { test: /Windows/, name: "Windows" },
    { test: /Android/, name: "Android", version: /Android (\d{1,3}(?:\.\d{1,3})?)/ },
    { test: /iPhone|iPad|iPod|iOS/, name: "iOS", version: /OS (\d{1,3}(?:[._]\d{1,3})?)/ },
    { test: /Mac OS X|Macintosh/, name: "macOS", version: /Mac OS X (\d{1,3}(?:[._]\d{1,3})?)/ },
    { test: /CrOS/, name: "ChromeOS", version: /CrOS \S+ (\d{1,5}(?:\.\d{1,5})?)/ },
    { test: /Linux/, name: "Linux" }
];

/**
 * The systems `sec-ch-ua-platform` can name, against the spelling the rest of
 * this module uses for them.
 *
 * A lookup rather than the header's own text, so one machine reads the same way
 * whichever half of the request described it - "Chrome OS" and ChromeOS are the
 * same laptop, and a list that spells it both ways is one nobody can group. The
 * header may also say "Unknown", and anything not named here - that included -
 * falls back to the user-agent rather than inventing a platform.
 *
 * A Map for the reason the brand lookup is one: the key is header text, and a
 * plain object would answer `constructor` with something off the prototype.
 */
const PLATFORM_HINTS = new Map([
    ["windows", "Windows"],
    ["macos", "macOS"],
    ["android", "Android"],
    ["ios", "iOS"],
    ["linux", "Linux"],
    ["chrome os", "ChromeOS"],
    ["chromium os", "ChromeOS"]
]);

/** The system a `sec-ch-ua-platform` value names, or null when it names none. */
function osFromHint(platform: string | null | undefined): string | null {
    if (!platform) return null;
    return PLATFORM_HINTS.get(platform.trim().replace(/^"|"$/g, "").toLowerCase()) ?? null;
}

function osFromUserAgent(userAgent: string): { name: string; version: string | null } {
    for (const entry of OPERATING_SYSTEMS) {
        if (!entry.test.test(userAgent)) continue;
        const version = entry.version ? (userAgent.match(entry.version)?.[1] ?? null) : null;
        return { name: entry.name, version: version?.replace(/_/g, ".") ?? null };
    }
    return { name: "Unknown OS", version: null };
}

/**
 * The browser and operating system a request described itself with.
 *
 * @param userAgent The `user-agent` header, as stored against the row.
 * @param brands The `sec-ch-ua` header, when one was recorded. It is what names
 *               a browser the user-agent hides.
 * @param platform The `sec-ch-ua-platform` header, when one was recorded. It is
 *                 what names the system a rewritten user-agent hides.
 */
export function describeClient(
    userAgent: string | null | undefined,
    brands?: string | null,
    platform?: string | null
): ClientReading {
    if (!userAgent) {
        return {
            browser: "Unknown browser",
            browserVersion: null,
            os: "Unknown OS",
            osVersion: null,
            label: "Unknown device"
        };
    }

    const claimed = browserFromUserAgent(userAgent);
    const hinted = brandFromHints(brands);
    // The hints name the browser; the user-agent is the fallback. A rebadged
    // Chromium sends both, and its own `Brave/` token does not exist - so where
    // the hints named it and gave no number, the user-agent's Chrome version is
    // the one it actually ships, which is the number worth showing.
    const browser = hinted?.name ?? claimed.name;
    const browserVersion = hinted?.version ?? claimed.version;

    const claimedOs = osFromUserAgent(userAgent);
    const hintedOs = osFromHint(platform);
    // The version only ever comes from the user-agent - no hint carries one
    // without being asked for - so it is kept only while the user-agent is
    // describing the same system the hint named. "Windows 18.5" would be the
    // reading that is wrong in a way neither half of it is.
    const os = hintedOs ?? claimedOs.name;
    const osVersion = hintedOs && hintedOs !== claimedOs.name ? null : claimedOs.version;

    return {
        browser,
        browserVersion,
        os,
        osVersion,
        label: `${browser} on ${os}`
    };
}

/** The one-line reading, for the lists that show a device as a single string. */
export function describeDevice(
    userAgent: string | null | undefined,
    brands?: string | null,
    platform?: string | null
): string {
    return describeClient(userAgent, brands, platform).label;
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

/**
 * Whether a system name is one that lives in a hand.
 *
 * The distinction the address binding is scoped by, and the only thing it turns
 * on: a phone changes address several times an hour walking between cell and
 * wifi, and a desk does not. Read from the system rather than from the
 * user-agent's "Mobile" token, which an iPad omits and a desktop browser in
 * device-emulation mode adds.
 *
 * ChromeOS is a laptop and Linux might be anything, so both count as neither -
 * which is to say, as a computer. An unknown system is a computer as well: a
 * scope that named phones must not quietly include everything it could not read.
 */
export function isHandheld(os: string): boolean {
    const name = os.trim().toLowerCase();
    return name === "android" || name === "ios";
}
