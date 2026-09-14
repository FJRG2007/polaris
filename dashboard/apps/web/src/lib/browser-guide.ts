/**
 * What loading the extension by hand actually involves, per browser.
 *
 * The same shape as `router-guide`, and for the same reason: everything here is a
 * value somebody has to type or press in a window that is not this one, so it is
 * held as a value rather than described in a sentence they have to translate
 * back. The component draws the prose; the addresses, menu labels and which file
 * to take live here, where they can be asserted without a DOM.
 *
 * The address is deliberately not a link. A page cannot navigate to
 * `chrome://extensions` or `about:debugging` - Chrome's own documentation says
 * it outright, "by design chrome:// URLs are not linkable" - and an anchor that
 * silently does nothing is worse than no anchor. It is shown verbatim with a copy
 * button, the way the router guide shows a gateway address.
 *
 * The Chromium browsers are listed separately even though the steps are
 * identical, because the address is not: Brave answers on `brave://extensions`,
 * Edge on `edge://extensions`, Opera on `opera://extensions`. Each accepts
 * `chrome://extensions` too, but telling a Brave user to paste a Chrome address
 * is telling them to trust that it is the same browser underneath, which is not
 * something a person should have to know.
 *
 * Two packages exist because `wxt zip` writes two: manifest v3 for the Chromium
 * family and v2 for Firefox. A browser that is neither gets no build and is told
 * so, rather than being handed a package that will not load.
 */

export type BrowserId = "chrome" | "edge" | "brave" | "opera" | "firefox";

export interface BrowserGuide {
    readonly id: BrowserId;
    /** The browser's own name, as its users call it. */
    readonly label: string;
    /** The address to paste, complete enough to land on the right pane. */
    readonly page: string;
    /** What that page is called, for the sentence that names it. */
    readonly pageLabel: string;
    /** The word in the release file that belongs to this browser. */
    readonly file: string;
    /** Whether the .zip has to be unpacked first, or is loaded as it comes. */
    readonly unpack: boolean;
    /** The control that takes the extension, named as the browser names it. */
    readonly action: string;
    /** What this way of loading it costs, which is different in each. */
    readonly caveat: string;
}

/** Everything the Chromium family shares: one build, one set of steps. */
const CHROMIUM = {
    pageLabel: "Extensions",
    file: "chrome",
    // Chromium takes a folder here, never the archive: pointing Load unpacked
    // at a .zip is the commonest way this goes wrong.
    unpack: true,
    action: "Load unpacked",
    caveat: "It stays until you remove it, and it does not update itself. Replacing the files in the same folder and pressing the refresh arrow is how it takes a new version."
} as const;

export const BROWSER_GUIDES: readonly BrowserGuide[] = [
    { id: "chrome", label: "Chrome", page: "chrome://extensions", ...CHROMIUM },
    { id: "edge", label: "Edge", page: "edge://extensions", ...CHROMIUM },
    { id: "brave", label: "Brave", page: "brave://extensions", ...CHROMIUM },
    { id: "opera", label: "Opera", page: "opera://extensions", ...CHROMIUM },
    {
        id: "firefox",
        label: "Firefox",
        // The fragment matters: plain about:debugging opens the setup pane, and
        // the extension is loaded from This Firefox.
        page: "about:debugging#/runtime/this-firefox",
        pageLabel: "This Firefox",
        file: "firefox",
        unpack: false,
        action: "Load Temporary Add-on",
        caveat: "Temporary is literal: Firefox lets it go when it closes, so it has to be loaded again next time."
    }
];

const BY_ID = new Map(BROWSER_GUIDES.map((guide) => [guide.id, guide]));

export function browserGuide(id: BrowserId): BrowserGuide {
    // Non-null: the map is built from the list the type is derived from.
    return BY_ID.get(id)!;
}

/**
 * Which browser the reader is on, or null when it cannot be told from the user
 * agent.
 *
 * Null is a real answer rather than a fallback to Chrome. Safari is the case
 * that matters: its user agent says Safari and not Chrome, it loads neither
 * package, and quietly handing it the Chromium steps would send somebody to a
 * menu their browser does not have.
 *
 * Brave is deliberately absent. It is not in the user agent - that is the point
 * of it - and the only way to ask is a `navigator.brave` object that no
 * specification documents. Rather than branch on something unverifiable, Brave
 * is one of the choices in the picker and a Brave user takes it in one click.
 * Being wrong about Brave costs nothing anyway: it is detected as Chrome, whose
 * address it also accepts.
 */
export function detectBrowser(userAgent: string): BrowserId | null {
    if (/firefox|fxios/i.test(userAgent)) return "firefox";
    if (/edg[ea]?\//i.test(userAgent)) return "edge";
    if (/opr\//i.test(userAgent)) return "opera";
    if (/chrom(e|ium)/i.test(userAgent)) return "chrome";
    return null;
}
