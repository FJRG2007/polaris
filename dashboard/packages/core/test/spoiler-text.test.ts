/**
 * `||like this||`.
 *
 * The syntax every client of this kind uses, so somebody who has typed it
 * before types it here and it works - including in messages sent before Polaris
 * understood it, where the bars were typed because the writer expected them to
 * mean exactly this.
 *
 * What the rules protect is the ordinary line. Nearly every line ever written
 * has no cover in it, and a rule that turned a table or a sentence about the
 * operator into a blur would be worse than not having the feature.
 */

import { describe, expect, it } from "vitest";
import { hasSpoiler, splitSpoilers, withoutSpoilers } from "../src/spoiler-text.js";

describe("finding what is covered", () => {
    it("covers what is between the bars and nothing else", () => {
        expect(splitSpoilers("he ||dies|| at the end")).toEqual([
            { text: "he ", covered: false },
            { text: "dies", covered: true },
            { text: " at the end", covered: false }
        ]);
    });

    // Non-greedy, or the first pair swallows everything up to the last.
    it("reads two covers as two", () => {
        expect(splitSpoilers("||a|| and ||b||").filter((part) => part.covered)).toEqual([
            { text: "a", covered: true },
            { text: "b", covered: true }
        ]);
    });

    it("leaves an ordinary line exactly as it was", () => {
        const line = "nothing to hide here";
        expect(splitSpoilers(line)).toEqual([{ text: line, covered: false }]);
        expect(hasSpoiler(line)).toBe(false);
    });
});

describe("what is not a cover", () => {
    // A table, and the commonest false positive there is.
    it("leaves a table alone", () => {
        expect(hasSpoiler("| a | b |")).toBe(false);
        expect(hasSpoiler("||")).toBe(false);
    });

    it("does not cover nothing", () => {
        expect(hasSpoiler("||||")).toBe(false);
    });

    // Somebody writing about the operator, which is a line of code far more
    // often than it is a spoiler.
    it("does not run across a line break", () => {
        expect(hasSpoiler("a || b\nc || d")).toBe(false);
    });
});

describe("where a cover cannot exist", () => {
    /**
     * A browser notification, the line under a conversation in the list, the
     * subject of an email: all read somewhere there is nothing to press, so a
     * cover there would be a permanent blank rather than a choice.
     */
    it("hands back the words with the bars taken out", () => {
        expect(withoutSpoilers("he ||dies|| at the end")).toBe("he dies at the end");
        expect(withoutSpoilers("nothing here")).toBe("nothing here");
    });
});
