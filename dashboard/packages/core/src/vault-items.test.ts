/**
 * The parts of a vault item that had to be given a convention.
 *
 * Recovery codes are the interesting one, because of the shapes sites hand them
 * out in: one per line, in a row separated by spaces, in a numbered list, with
 * dashes inside the codes themselves. What they never contain is whitespace,
 * which is what makes the split reliable - and the numbering is what has to come
 * back off without taking a code with it.
 */

import { describe, expect, it } from "vitest";
import { itemInitials, looksLikeEmail, readRecoveryCodes, writeRecoveryCodes } from "./vault-items.js";

describe("codes pasted out of whatever a site printed", () => {
    it("reads them one per line", () => {
        expect(readRecoveryCodes("abcd-1234\nefgh-5678\n")).toEqual(["abcd-1234", "efgh-5678"]);
    });

    it("reads them off one line", () => {
        expect(readRecoveryCodes("abcd1234  efgh5678")).toEqual(["abcd1234", "efgh5678"]);
    });

    it("takes the list numbering off without taking the code", () => {
        expect(readRecoveryCodes("1. abcd1234\n2. efgh5678")).toEqual(["abcd1234", "efgh5678"]);
        expect(readRecoveryCodes("1) abcd1234")).toEqual(["abcd1234"]);
        // The number written against the code rather than beside it.
        expect(readRecoveryCodes("1.abcd1234")).toEqual(["abcd1234"]);
    });

    it("keeps a code that is only digits", () => {
        // Some sites really do hand out eight-digit codes, and reading one as
        // list numbering would quietly drop it.
        expect(readRecoveryCodes("12345678 87654321")).toEqual(["12345678", "87654321"]);
    });

    it("keeps the order they were given in", () => {
        // People work down the list they were handed; a set that came back in a
        // different order each time makes "which have I used" unanswerable.
        expect(readRecoveryCodes("c b a")).toEqual(["c", "b", "a"]);
    });

    it("reads nothing out of nothing", () => {
        expect(readRecoveryCodes("")).toEqual([]);
        expect(readRecoveryCodes("   \n  ")).toEqual([]);
    });

    it("writes them back the way a site prints them", () => {
        expect(writeRecoveryCodes(["a", "b"])).toBe("a\nb");
    });
});

describe("what is in the username box", () => {
    it("is recognised as an address when it is one", () => {
        expect(looksLikeEmail("ada@example.com")).toBe(true);
        expect(looksLikeEmail(" ada.lovelace+vault@example.co.uk ")).toBe(true);
    });

    it("is not an address when it is a handle", () => {
        expect(looksLikeEmail("ada")).toBe(false);
        expect(looksLikeEmail("ada@localhost")).toBe(false);
        expect(looksLikeEmail("two words@example.com")).toBe(false);
        expect(looksLikeEmail("")).toBe(false);
    });
});

describe("the letters on an item with no icon", () => {
    it("come from the site rather than the name", () => {
        // "Work" and "Work (old)" are the same two letters; github and gitlab
        // are not.
        expect(itemInitials("Work", "github.com")).toBe("GI");
        expect(itemInitials("Work", "www.gitlab.com")).toBe("GI");
    });

    it("fall back to the name when there is no site", () => {
        expect(itemInitials("Router admin", null)).toBe("RO");
    });

    it("are something rather than nothing for an item with neither", () => {
        expect(itemInitials("", null)).toBe("?");
    });
});
