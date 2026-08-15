/**
 * The colour a link card takes from the site it points at.
 *
 * Two things are being tested and only one of them is cosmetic. The colour goes
 * into a style attribute on a card built from a page somebody else controls, so
 * anything that is not plainly a hex colour has to come back as nothing - a site
 * that answers `red; background: url(...)` is not choosing a colour.
 */

import { describe, expect, it } from "vitest";
import { usableAccent } from "@/lib/chat/accent";

describe("what it takes", () => {
    it("takes a hex colour", () => {
        expect(usableAccent("#ff0033")).toBe("#ff0033");
        expect(usableAccent("#FF0033")).toBe("#ff0033");
        expect(usableAccent("#c33")).toBe("#c33");
    });

    it("trims what a page put around it", () => {
        expect(usableAccent(" #ff0033 ")).toBe("#ff0033");
    });
});

describe("what it refuses", () => {
    it.each([
        ["nothing", null],
        ["an empty string", ""],
        ["a named colour", "red"],
        ["the rgba a page reports its own chrome as", "rgba(255, 255, 255, 0.98)"],
        ["anything with more in it", "#ff0033; background: url(https://tracker.test/x)"],
        ["a hex that is not one", "#ff00zz"],
        ["four digits", "#ff003"]
    ])("refuses %s", (_case, value) => {
        expect(usableAccent(value)).toBeNull();
    });

    it("refuses a colour that would not be visible", () => {
        // A site saying it is white is saying nothing about itself, and a white
        // bar on a white card is no bar at all. Same for black in the dark
        // theme.
        expect(usableAccent("#ffffff")).toBeNull();
        expect(usableAccent("#000000")).toBeNull();
    });
});
