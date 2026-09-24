/**
 * Where the inline login script may run.
 *
 * The one that matters is the wildcard. The manifest has to offer a broad host
 * pattern as an optional permission - a browser refuses a specific origin that no
 * optional pattern covers - and a browser that has been given the broad one
 * reports it back like any other grant. Registering on it would put this
 * extension's script inside every page somebody opens, in one step, with nothing
 * on any screen saying so. That is the exact reach the whole design refuses, so
 * it is asserted rather than left to a reviewer to notice.
 */

import { describe, expect, it } from "vitest";
import { injectableOrigins } from "../src/lib/injection";

describe("which sites the inline script runs on", () => {
    it("takes the sites that were granted one at a time", () => {
        expect(
            injectableOrigins(["https://example.com/*", "https://bank.example/*"], null)
        ).toEqual(["https://example.com/*", "https://bank.example/*"]);
    });

    it("never registers on a wildcard, however it is written", () => {
        expect(
            injectableOrigins(
                ["https://*/*", "http://*/*", "*://*/*", "<all_urls>", "https://*.*/"],
                null
            )
        ).toEqual([]);
    });

    it("keeps the real sites even when the wildcard is granted too", () => {
        // Which is the normal case: the broad grant is how a browser is able to
        // hand over the narrow ones.
        expect(injectableOrigins(["https://*/*", "https://example.com/*"], null)).toEqual([
            "https://example.com/*"
        ]);
    });

    it("leaves the dashboard's own pages alone", () => {
        // Polaris's own sign-in does not want a fill mark over it, and the
        // extension's reach into that origin is for the vault rather than for
        // running a script inside the page.
        expect(
            injectableOrigins(
                ["https://polaris.example.com/*", "https://example.com/*"],
                "https://polaris.example.com"
            )
        ).toEqual(["https://example.com/*"]);
    });

    it("matches the dashboard however its address was written", () => {
        expect(
            injectableOrigins(["HTTPS://Polaris.Example.com/*"], "https://polaris.example.com")
        ).toEqual([]);
    });

    it("does not confuse a different host that starts the same way", () => {
        expect(
            injectableOrigins(
                ["https://polaris.example.com.evil.test/*"],
                "https://polaris.example.com"
            )
        ).toEqual(["https://polaris.example.com.evil.test/*"]);
    });

    it("says nothing when nothing has been granted", () => {
        expect(injectableOrigins([], "https://polaris.example.com")).toEqual([]);
    });

    it("registers on every site only when somebody switched that on", () => {
        const held = ["https://*/*", "http://*/*", "https://example.com/*"];
        expect(injectableOrigins(held, null, true)).toEqual([
            "https://*/*",
            "http://*/*",
            "https://example.com/*"
        ]);
        // The same grant without the switch is still one site at a time.
        expect(injectableOrigins(held, null, false)).toEqual(["https://example.com/*"]);
    });

    it("does not register on every site the browser never granted", () => {
        // Switched on, then refused by the browser's prompt.
        expect(injectableOrigins(["https://example.com/*"], null, true)).toEqual([
            "https://example.com/*"
        ]);
        // And never on a pattern broader than web pages, switch or not.
        expect(injectableOrigins(["<all_urls>", "*://*/*"], null, true)).toEqual([]);
    });

    it("hands each site over once", () => {
        expect(injectableOrigins(["https://example.com/*", "https://example.com/*"], null)).toEqual(
            ["https://example.com/*"]
        );
    });
});
