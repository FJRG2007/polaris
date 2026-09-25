/**
 * Which page is handed the code for the login just filled.
 *
 * The cost of being wrong is a code typed into a page that did not ask for it -
 * another tab, another site, or a sign-in long finished - so each of those is
 * named here rather than assumed.
 */

import { describe, expect, it } from "vitest";
import { sameSite, stepFor, type SecondStep } from "../src/lib/second-step";

const NOW = 1_000_000;

const held: SecondStep = {
    tabId: 7,
    itemId: "item-1",
    url: "https://login.example.com/signin",
    until: NOW + 60_000
};

describe("the code step waiting for a page", () => {
    it("is handed to the same tab on the same site", () => {
        expect(stepFor(held, { tabId: 7, url: "https://login.example.com/2fa" }, NOW)).toBe(held);
    });

    it("follows a sign-in that hands over to another host of the site", () => {
        expect(stepFor(held, { tabId: 7, url: "https://auth.example.com/otp" }, NOW)).toBe(held);
    });

    it("is not handed to another tab", () => {
        expect(stepFor(held, { tabId: 8, url: "https://login.example.com/2fa" }, NOW)).toBeNull();
    });

    it("is not handed to a tab that has gone to another site", () => {
        expect(stepFor(held, { tabId: 7, url: "https://example.org/2fa" }, NOW)).toBeNull();
    });

    it("runs out", () => {
        expect(stepFor(held, { tabId: 7, url: held.url }, held.until)).toBeNull();
    });

    it("is nothing when nothing was filled", () => {
        expect(stepFor(null, { tabId: 7, url: held.url }, NOW)).toBeNull();
    });
});

describe("whether two pages are one site", () => {
    it("reads an address it cannot parse as no site at all", () => {
        expect(sameSite("not a url", "not a url")).toBe(false);
    });
});
