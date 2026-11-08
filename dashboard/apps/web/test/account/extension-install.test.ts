/**
 * What the extension card's one Install button does, per browser.
 *
 * The order is the contract: the store's one press first, then Firefox's own
 * prompt for a signed package, then the desktop app, and the steps by hand only
 * when none of those exists. A browser that loads nothing (Safari) is told so
 * instead of being handed a package it cannot take.
 */

import { describe, expect, it } from "vitest";
import {
    EXTENSION_LISTINGS,
    installMethod,
    isSafari,
    signedFirefoxFile,
    type ExtensionListings,
    type InstallBrowser
} from "@polaris/ui/account-downloads/extension-install";
import { isReleaseAsset, XPI_CONTENT_TYPE } from "@/lib/extension-package";

const NONE: ExtensionListings = { chromeWebStore: null, edgeAddons: null, operaAddons: null };
const CWS = "a".repeat(32);
const LISTED: ExtensionListings = {
    chromeWebStore: CWS,
    edgeAddons: "edgeid",
    operaAddons: "polaris"
};
const XPI = "/api/polaris/extension/firefox";

function method(
    browser: InstallBrowser,
    {
        listings = NONE,
        signedFirefox = null,
        desktop = false
    }: { listings?: ExtensionListings; signedFirefox?: string | null; desktop?: boolean } = {}
) {
    return installMethod({ browser, listings, signedFirefox, desktop });
}

describe("with nothing published", () => {
    it("has no listing that could be a link to a 404", () => {
        expect(EXTENSION_LISTINGS).toEqual(NONE);
    });

    it("sends every Chromium browser to the desktop app when the page is in it", () => {
        for (const browser of ["chrome", "edge", "brave", "opera"] as const) {
            expect(method(browser, { desktop: true })).toEqual({ kind: "desktop" });
            expect(method(browser)).toEqual({ kind: "manual" });
        }
    });

    it("never hands Firefox to the desktop app, which only writes an unsigned folder", () => {
        expect(method("firefox", { desktop: true })).toEqual({ kind: "manual" });
    });

    it("tells Safari there is nothing to install", () => {
        expect(method("safari", { desktop: true, listings: LISTED })).toEqual({
            kind: "unavailable"
        });
    });
});

describe("the most automatic way first", () => {
    it("prefers the store over the desktop app", () => {
        expect(method("chrome", { listings: LISTED, desktop: true })).toEqual({
            kind: "store",
            store: "chrome",
            url: `https://chromewebstore.google.com/detail/${CWS}`
        });
    });

    it("sends Brave to the Chrome Web Store, which it installs from", () => {
        expect(method("brave", { listings: LISTED })).toMatchObject({
            kind: "store",
            store: "chrome"
        });
    });

    it("sends Edge to its own store, and to Chrome's when it is only listed there", () => {
        expect(method("edge", { listings: LISTED })).toMatchObject({
            store: "edge",
            url: "https://microsoftedge.microsoft.com/addons/detail/edgeid"
        });
        expect(method("edge", { listings: { ...NONE, chromeWebStore: CWS } })).toMatchObject({
            store: "chrome"
        });
    });

    it("does not send Opera to the Chrome Web Store", () => {
        expect(method("opera", { listings: { ...NONE, chromeWebStore: CWS } })).toEqual({
            kind: "manual"
        });
        expect(method("opera", { listings: LISTED })).toMatchObject({
            kind: "store",
            store: "opera"
        });
    });

    it("offers Firefox its install prompt once a signed package exists", () => {
        expect(method("firefox", { signedFirefox: XPI })).toEqual({ kind: "package", url: XPI });
    });
});

describe("telling Safari apart", () => {
    it("reads Safari as Safari and the browsers that also say Safari as themselves", () => {
        const mac =
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
        const chrome =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
        const iosFirefox =
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15";
        expect(isSafari(mac)).toBe(true);
        expect(isSafari(chrome)).toBe(false);
        expect(isSafari(`${chrome} Edg/126.0.0.0`)).toBe(false);
        expect(isSafari(iosFirefox)).toBe(false);
        expect(
            isSafari("Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0")
        ).toBe(false);
    });
});

describe("the signed package", () => {
    it("is the .xpi for Firefox and never the zips", () => {
        const files = [
            { name: "polaris-extension-firefox.zip" },
            { name: "polaris-extension-chrome.zip" },
            { name: "polaris-extension-firefox.xpi" }
        ];
        expect(signedFirefoxFile(files)?.name).toBe("polaris-extension-firefox.xpi");
        expect(signedFirefoxFile(files.slice(0, 2))).toBeNull();
    });

    it("is relayed only from this repository's GitHub releases, as the type Firefox installs", () => {
        const repo = "example/polaris";
        const own = "https://github.com/example/polaris/releases/download/extension-v1/a.xpi";
        expect(isReleaseAsset(own, repo)).toBe(true);
        expect(isReleaseAsset(own.replace("example", "other"), repo)).toBe(false);
        expect(isReleaseAsset(own.replace("https", "http"), repo)).toBe(false);
        expect(isReleaseAsset(own.replace("github.com", "github.com.evil.test"), repo)).toBe(false);
        expect(isReleaseAsset("not a url", repo)).toBe(false);
        expect(XPI_CONTENT_TYPE).toBe("application/x-xpinstall");
    });
});
