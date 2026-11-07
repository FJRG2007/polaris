/**
 * How the extension's Install button installs it, for one browser.
 *
 * Every way on the card - Store, Download, Command - presses the same button, and
 * this decides what that button does. The order is the order of how little the
 * reader has to do, and each step is only taken when the browser really allows it:
 *
 * 1. The browser's own store, which installs with one press of its Add button.
 * 2. A signed package (Firefox): a link to a signed .xpi opens Firefox's own
 *    install prompt. Firefox installs nothing unsigned in its release builds.
 * 3. The desktop app, which runs on the reader's computer and can do what a page
 *    cannot: register the store listing with the browser, or fetch the package
 *    and open the browser's extensions page with the folder already copied.
 * 4. The steps by hand, which is the only thing left without any of the above.
 *
 * Pure, so the whole table can be asserted without a browser.
 */

import type { BrowserId } from "./browser-guide";

/**
 * Where the extension is listed, per store. Empty until it is published there:
 * a listing that does not exist is a link to a 404, so nothing here is guessed.
 * Fill the id in once the store has accepted it, and the button starts using it.
 */
export interface ExtensionListings {
    /** The Chrome Web Store item id, 32 letters. */
    readonly chromeWebStore: string | null;
    /** The Microsoft Edge Add-ons item id. */
    readonly edgeAddons: string | null;
    /** The Opera add-ons slug. */
    readonly operaAddons: string | null;
}

export const EXTENSION_LISTINGS: ExtensionListings = {
    chromeWebStore: null,
    edgeAddons: null,
    operaAddons: null
};

/** The browsers the card can be about: the ones with a build, and Safari, which has none. */
export type InstallBrowser = BrowserId | "safari";

export type InstallMethod =
    | { readonly kind: "store"; readonly url: string; readonly store: "chrome" | "edge" | "opera" }
    | { readonly kind: "package"; readonly url: string }
    | { readonly kind: "desktop" }
    | { readonly kind: "manual" }
    | { readonly kind: "unavailable" };

export interface InstallContext {
    readonly browser: InstallBrowser;
    readonly listings: ExtensionListings;
    /** The address of a signed Firefox package, when the release carries one. */
    readonly signedFirefox: string | null;
    /** Whether this page runs inside the desktop app, on a system it installs on. */
    readonly desktop: boolean;
}

function chromeStore(id: string): string {
    return `https://chromewebstore.google.com/detail/${id}`;
}

/** The store listing a browser installs from with one press, or null. */
function storeFor(
    browser: InstallBrowser,
    listings: ExtensionListings
): Extract<InstallMethod, { kind: "store" }> | null {
    if (browser === "chrome" || browser === "brave") {
        // Brave installs from the Chrome Web Store itself.
        return listings.chromeWebStore
            ? { kind: "store", store: "chrome", url: chromeStore(listings.chromeWebStore) }
            : null;
    }
    if (browser === "edge") {
        if (listings.edgeAddons) {
            const url = `https://microsoftedge.microsoft.com/addons/detail/${listings.edgeAddons}`;
            return { kind: "store", store: "edge", url };
        }
        // Edge takes Chrome Web Store items once the reader allows other stores,
        // which it asks for on that page.
        return listings.chromeWebStore
            ? { kind: "store", store: "chrome", url: chromeStore(listings.chromeWebStore) }
            : null;
    }
    if (browser === "opera") {
        return listings.operaAddons
            ? {
                  kind: "store",
                  store: "opera",
                  url: `https://addons.opera.com/extensions/details/${listings.operaAddons}/`
              }
            : null;
    }
    return null;
}

export function installMethod(context: InstallContext): InstallMethod {
    const { browser } = context;
    // Safari takes extensions only inside a signed Mac app, and there is none.
    if (browser === "safari") return { kind: "unavailable" };
    const store = storeFor(browser, context.listings);
    if (store) return store;
    if (browser === "firefox") {
        // The desktop app cannot help Firefox: what it puts on disk is unsigned.
        return context.signedFirefox
            ? { kind: "package", url: context.signedFirefox }
            : { kind: "manual" };
    }
    return context.desktop ? { kind: "desktop" } : { kind: "manual" };
}

/**
 * Whether a user agent is Safari, which reports Safari and nothing else. Every
 * Chromium browser and Firefox on iOS say Safari too, so they are ruled out first.
 */
export function isSafari(userAgent: string): boolean {
    if (!/safari/i.test(userAgent)) return false;
    return !/chrom(e|ium)|crios|fxios|edg(e|a|ios)?\/|opr\/|android/i.test(userAgent);
}

/** The signed Firefox package in a release's files, by the name the signing step gives it. */
export function signedFirefoxFile<T extends { readonly name: string }>(
    files: readonly T[]
): T | null {
    return files.find((file) => /firefox.*\.xpi$/i.test(file.name)) ?? null;
}
