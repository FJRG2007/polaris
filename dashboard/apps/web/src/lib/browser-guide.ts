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
 * `chrome://extensions` or `about:debugging` - every browser refuses that from
 * page content, and an anchor that silently does nothing is worse than no anchor
 * at all - so it is shown verbatim with a copy button, the way the router guide
 * shows a gateway address.
 *
 * Two builds exist because `wxt zip` writes two: manifest v3 for the Chromium
 * family and v2 for Firefox. A browser that is neither gets no build and is told
 * so, rather than being handed a package that will not load.
 */

export type BrowserId = "chromium" | "firefox";

export interface BrowserGuide {
    readonly id: BrowserId;
    /** Every browser this one set of steps is true for. */
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

export const BROWSER_GUIDES: readonly BrowserGuide[] = [
    {
        id: "chromium",
        label: "Chrome, Edge, Brave or Opera",
        page: "chrome://extensions",
        pageLabel: "Extensions",
        file: "chrome",
        // Chromium takes a folder here, never the archive: pointing Load unpacked
        // at a .zip is the commonest way this goes wrong.
        unpack: true,
        action: "Load unpacked",
        caveat: "It stays until you remove it, and it does not update itself. Chrome asks about developer-mode extensions each time it starts."
    },
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
 * Which of the two the reader is on, or null when there is no build for it.
 *
 * Null is a real answer rather than a fallback to Chromium. Safari is the case
 * that matters: its user agent says "Safari" and not "Chrome", it loads neither
 * package, and quietly handing it the Chromium steps would send somebody to a
 * menu their browser does not have.
 *
 * Edge, Brave and Opera all carry "Chrome" in their user agent, which is exactly
 * right here - the steps and the file are the same for all of them.
 */
export function detectBrowser(userAgent: string): BrowserId | null {
    if (/firefox|fxios/i.test(userAgent)) return "firefox";
    if (/edg[ea]?\//i.test(userAgent)) return "chromium";
    if (/opr\//i.test(userAgent)) return "chromium";
    if (/chrom(e|ium)|crios/i.test(userAgent)) return "chromium";
    return null;
}
