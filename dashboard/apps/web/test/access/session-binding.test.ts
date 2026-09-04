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
 * account has only asked for the client binding. And the two that were reported
 * from a live deployment: a Brave that named itself in the client hints on the
 * request that opened the session and had none to send on a later one - reading
 * as Brave against Chrome, which is one browser and was treated as two - and the
 * same laptop with its developer tools open, whose device toolbar puts an
 * iPhone's user-agent on it and leaves it exactly where it was.
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
    claimedOs: "Android",
    claimedBrowser: "Chrome",
    brandHinted: true,
    platformHinted: true,
    ip: "203.0.113.7",
    handheld: true
};

/**
 * And a laptop at a desk.
 *
 * Brave, which is the case every one of these turns on: it writes Chrome into
 * its user-agent on purpose, so `claimedBrowser` is Chrome and only the hints
 * say otherwise.
 */
const LAPTOP: SessionOrigin = {
    os: "Windows",
    browser: "Brave",
    claimedOs: "Windows",
    claimedBrowser: "Chrome",
    brandHinted: true,
    platformHinted: true,
    ip: "198.51.100.4",
    handheld: false
};

/** The same person, still there, on a request that carried hints. */
const SAME: RequestOrigin = {
    os: "Windows",
    browser: "Brave",
    claimedOs: "Windows",
    claimedBrowser: "Chrome",
    brandHinted: true,
    platformHinted: true,
    ip: "198.51.100.4"
};

const rules = (over: Partial<BindingRules> = {}): BindingRules => ({
    bindClient: true,
    pinScope: "off",
    pinThisSession: null,
    ...over
});

describe("a cookie somewhere it should not be", () => {
    it("is refused when the browser is not the one it was opened in", () => {
        // Both sides named themselves in the hints, so the names mean the same
        // thing and a real Chrome is a real difference.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Windows",
                browser: "Chrome",
                claimedOs: "Windows",
                claimedBrowser: "Chrome",
                brandHinted: true,
                platformHinted: true,
                ip: LAPTOP.ip
            })
        ).toBe("client");
    });

    it("is refused when the system is not the one it was opened on, from elsewhere", () => {
        // Taken off Windows, replayed from Linux, at another address - which is
        // the half that makes it a second machine rather than the first one
        // describing itself differently. Caught whether or not the second
        // request carried any hints, because the user-agent names the system on
        // its own.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Linux",
                browser: "Brave",
                claimedOs: "Linux",
                claimedBrowser: "Chrome",
                brandHinted: true,
                platformHinted: true,
                ip: "203.0.113.99"
            })
        ).toBe("client");
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Linux",
                browser: "Chrome",
                claimedOs: "Linux",
                claimedBrowser: "Chrome",
                brandHinted: false,
                platformHinted: false,
                ip: "203.0.113.99"
            })
        ).toBe("client");
    });

    it("is refused for the browser alone, wherever the request came from", () => {
        // The browser half needs no corroborating address: a browser does not
        // become another browser without the cookie being carried into one.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Windows",
                browser: "Firefox",
                claimedOs: "Windows",
                claimedBrowser: "Firefox",
                brandHinted: false,
                platformHinted: false,
                ip: LAPTOP.ip
            })
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

    it("survives the same browser sending no hints on one request", () => {
        // The reported false positive, and the reason the readings are compared
        // like with like. Brave says "Brave" only in the hints; without them the
        // very same browser reads as Chrome, and calling that a stolen cookie
        // signs its owner out of their own account.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Windows",
                browser: "Chrome",
                claimedOs: "Windows",
                claimedBrowser: "Chrome",
                brandHinted: false,
                platformHinted: false,
                ip: LAPTOP.ip
            })
        ).toBeNull();
    });

    it("survives a session that was recorded without hints and used with them", () => {
        // The same thing the other way round: a session opened over http on the
        // home network, then used over the deployment's own name.
        const opened: SessionOrigin = {
            ...LAPTOP,
            browser: "Chrome",
            brandHinted: false,
            platformHinted: false
        };
        expect(bindingBreach(rules(), opened, SAME)).toBeNull();
    });

    it("survives the device toolbar in a set of developer tools", () => {
        // The second report from a live deployment. Pressing F12 restores the
        // device the tools were last emulating, the browser starts sending an
        // iPhone's user-agent from the same Windows laptop, and the session was
        // ended with an alert telling its owner somebody else had used it.
        //
        // The brands still say Brave, because the tools rewrite the user-agent
        // and not who the browser is. The address is the one it has been at all
        // along. Nothing moved.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "iOS",
                browser: "Brave",
                claimedOs: "iOS",
                claimedBrowser: "Safari",
                brandHinted: true,
                platformHinted: false,
                ip: LAPTOP.ip
            })
        ).toBeNull();
    });

    it("survives an emulated device that takes the hints with it", () => {
        // The same tools set to a custom user-agent, which drops the brands as
        // well. Both sides fall back to what the user-agent claims, and Brave's
        // claim is Chrome either way - so the browser matches, the system does
        // not, and the address says the laptop never left the desk.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Linux",
                browser: "Chrome",
                claimedOs: "Linux",
                claimedBrowser: "Chrome",
                brandHinted: false,
                platformHinted: false,
                ip: LAPTOP.ip
            })
        ).toBeNull();
    });

    it("survives a phone asked for the desktop version of a page", () => {
        // Android's "request desktop site" sends a desktop Linux user-agent and
        // goes on saying Android in the platform hint. Read like with like, the
        // hint is what both sides are compared on and the two agree.
        expect(
            bindingBreach(rules(), PHONE, {
                os: "Android",
                browser: "Brave",
                claimedOs: "Linux",
                claimedBrowser: "Chrome",
                brandHinted: true,
                platformHinted: true,
                ip: PHONE.ip
            })
        ).toBeNull();
    });

    it("survives a request that carried the brands and not the platform", () => {
        // One header can arrive without the other, and each half of the reading
        // is compared against the header it came from. Comparing a hinted
        // browser against a user-agent's is what signed people out for using
        // Brave; comparing a hinted system against a user-agent's is what signed
        // them out for opening their developer tools.
        expect(
            bindingBreach(rules(), LAPTOP, {
                os: "Windows",
                browser: "Brave",
                claimedOs: "Windows",
                claimedBrowser: "Chrome",
                brandHinted: true,
                platformHinted: false,
                ip: LAPTOP.ip
            })
        ).toBeNull();
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
