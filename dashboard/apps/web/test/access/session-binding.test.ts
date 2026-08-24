/**
 * Whether a session may still be used by whoever has just turned up with it.
 *
 * Half of this file is about the refusals and half is about the things that must
 * never be refused, and the second half is the important one. A binding that
 * signs an honest person out is worse than no binding at all: they turn it off,
 * and the account ends up with less than it started with.
 *
 * So the false positives are enumerated. A browser updating itself. A phone that
 * cannot report its platform. A session opened before any of this existed and
 * carrying no address. A laptop moving between wifi and a hotspot while the
 * account has only asked for the client binding.
 *
 * And the refusals are the two the whole thing exists for: a cookie pasted into
 * a different browser, and a cookie used from a different address by an account
 * that asked for that to be impossible.
 */

import { describe, expect, it } from "vitest";
import { addressPinned, bindingBreach, isHandheld } from "@polaris/core";
import type { BindingRules, RequestOrigin, SessionOrigin } from "@polaris/core";

/** What the phone this was reported from looks like. */
const PHONE: SessionOrigin = {
    os: "Android",
    browser: "Brave",
    ip: "203.0.113.7",
    handheld: true
};

/** And a laptop at a desk. */
const LAPTOP: SessionOrigin = {
    os: "Windows",
    browser: "Brave",
    ip: "198.51.100.4",
    handheld: false
};

/** The same person, still there. */
const SAME: RequestOrigin = { os: "Windows", browser: "Brave", ip: "198.51.100.4" };

const rules = (over: Partial<BindingRules> = {}): BindingRules => ({
    bindClient: true,
    pinScope: "off",
    pinThisSession: null,
    ...over
});

describe("a cookie somewhere it should not be", () => {
    it("is refused when the browser is not the one it was opened in", () => {
        expect(
            bindingBreach(rules(), LAPTOP, { os: "Windows", browser: "Chrome", ip: LAPTOP.ip })
        ).toBe("client");
    });

    it("is refused when the system is not the one it was opened on", () => {
        // The reported shape exactly: taken off Windows, replayed from Linux.
        expect(
            bindingBreach(rules(), LAPTOP, { os: "Linux", browser: "Brave", ip: LAPTOP.ip })
        ).toBe("client");
    });

    it("is refused from another address once the account asks for that", () => {
        expect(
            bindingBreach(rules({ pinScope: "all" }), LAPTOP, { ...SAME, ip: "203.0.113.99" })
        ).toBe("address");
    });

    it("says the client broke when both did, since that is the one worth saying", () => {
        expect(
            bindingBreach(rules({ pinScope: "all" }), LAPTOP, {
                os: "Linux",
                browser: "Chrome",
                ip: "203.0.113.99"
            })
        ).toBe("client");
    });
});

describe("the same person, still there", () => {
    it("passes with everything on", () => {
        expect(bindingBreach(rules({ pinScope: "all" }), LAPTOP, SAME)).toBeNull();
    });

    it("survives the browser updating itself", () => {
        // Only names are ever compared. A version moves several times a year and
        // a name moves never, which is the whole reason the check is safe to have
        // on for everybody.
        expect(bindingBreach(rules(), LAPTOP, { ...SAME, browser: "Brave" })).toBeNull();
    });

    it("survives a client that will not say what it is", () => {
        // Safari and Firefox send no platform hint, so a reading can come back
        // unknown at either end. Unknown is not a disagreement - treating it as
        // one would sign people out for the browser they chose.
        expect(
            bindingBreach(rules(), { ...LAPTOP, os: "Unknown OS" }, SAME)
        ).toBeNull();
        expect(
            bindingBreach(rules(), LAPTOP, { ...SAME, os: "Unknown OS", browser: "Unknown browser" })
        ).toBeNull();
    });

    it("survives a session older than the address ever being recorded", () => {
        // Refusing these would sign out every session that predates the setting
        // the moment somebody turned it on.
        expect(
            bindingBreach(rules({ pinScope: "all" }), { ...LAPTOP, ip: null }, SAME)
        ).toBeNull();
    });

    it("survives a request whose address could not be read", () => {
        expect(
            bindingBreach(rules({ pinScope: "all" }), LAPTOP, { ...SAME, ip: null })
        ).toBeNull();
    });

    it("moves address freely while only the client binding is on", () => {
        expect(bindingBreach(rules(), LAPTOP, { ...SAME, ip: "203.0.113.99" })).toBeNull();
    });

    it("is not judged at all when the account has asked for neither", () => {
        expect(
            bindingBreach(rules({ bindClient: false }), LAPTOP, {
                os: "Linux",
                browser: "Chrome",
                ip: "203.0.113.99"
            })
        ).toBeNull();
    });
});

describe("which devices the address binding covers", () => {
    it("leaves the phone alone on the setting most people want", () => {
        // The reason "desktop" is the sane default: a phone changes address
        // several times an hour walking between cell and wifi, and "all" on one
        // is an account that signs itself out all day.
        expect(addressPinned(rules({ pinScope: "desktop" }), PHONE)).toBe(false);
        expect(addressPinned(rules({ pinScope: "desktop" }), LAPTOP)).toBe(true);
    });

    it("covers only the phone on the other one", () => {
        expect(addressPinned(rules({ pinScope: "mobile" }), PHONE)).toBe(true);
        expect(addressPinned(rules({ pinScope: "mobile" }), LAPTOP)).toBe(false);
    });

    it("lets one session answer differently from the rule, either way", () => {
        expect(addressPinned(rules({ pinScope: "off", pinThisSession: true }), LAPTOP)).toBe(true);
        expect(addressPinned(rules({ pinScope: "all", pinThisSession: false }), LAPTOP)).toBe(false);
    });
});

describe("what counts as something held in a hand", () => {
    it("is the two systems that only ever are one", () => {
        expect(isHandheld("Android")).toBe(true);
        expect(isHandheld("iOS")).toBe(true);
    });

    it("counts everything else as a computer, unknown included", () => {
        // A scope that named phones must not quietly include every system it
        // could not read.
        for (const os of ["Windows", "macOS", "Linux", "ChromeOS", "Unknown OS"]) {
            expect(isHandheld(os)).toBe(false);
        }
    });
});
