/**
 * Which Chromium browser a chrome-target build is running in, from what it says
 * about itself.
 *
 * Pure, so the rule can be asserted without a browser. The worker gathers the
 * inputs - `navigator.userAgentData.brands` and the user agent - because it is
 * the one that signs in, and the name it arrives at is the one the dashboard's
 * session list shows.
 *
 * Brave is found by its brand. Its own `navigator.brave` check exists only on a
 * window's navigator, and this runs in the service worker, where there is none;
 * the brand list is where Brave says what it is from a worker. Its user agent
 * says Chrome on purpose.
 */

/** One entry of `navigator.userAgentData.brands`. */
export interface BrandEntry {
    readonly brand: string;
}

/** The browser's name, spelled the way the dashboard spells it, or Chrome when
 *  nothing more specific is said. */
export function chromiumBrowser(brands: readonly BrandEntry[], userAgent: string): string {
    const agent = userAgent.toLowerCase();
    const claims = (word: string): boolean =>
        brands.some((entry) => entry.brand.toLowerCase().includes(word)) || agent.includes(word);
    // Order matters only in that Chrome is last: every one of these reports a
    // Chrome-shaped user agent as well as its own name.
    if (claims("brave")) return "Brave";
    if (claims("edg")) return "Edge";
    if (claims("opr") || claims("opera")) return "Opera";
    if (claims("vivaldi")) return "Vivaldi";
    return "Chrome";
}
