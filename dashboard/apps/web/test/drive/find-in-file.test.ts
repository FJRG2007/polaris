/**
 * Finding a run of text in the file somebody has open.
 *
 * The decisions worth pinning are the ones a find bar is judged on within three
 * presses: an empty box highlights nothing rather than everything, a word typed
 * in lower case finds it in capitals, stepping wraps at both ends, and the split
 * that paints the hits gives back every character of the file - a viewer that
 * drops text while searching is showing something other than the file.
 */

import { describe, expect, it } from "vitest";
import { findMatches, markedParts, MOST_MATCHES, stepMatch } from "@/app/(app)/drive/viewer/find-in-file";

const CONFIG = [
    "[corpse.access]",
    "    only_owner = false",
    "    skeleton = false",
    "",
    "[corpse.despawn]",
    "    time = 600"
].join("\n");

describe("finding text in a file", () => {
    it("finds every place a word appears", () => {
        const found = findMatches(CONFIG, "false");
        expect(found).toHaveLength(2);
        expect(CONFIG.slice(found[0]!.start, found[0]!.end)).toBe("false");
    });

    it("ignores case, because a reader types what they remember", () => {
        expect(findMatches(CONFIG, "ONLY_OWNER")).toHaveLength(1);
        expect(findMatches(CONFIG, "only_owner", true)).toHaveLength(1);
        expect(findMatches(CONFIG, "ONLY_OWNER", true)).toHaveLength(0);
    });

    it("matches nothing at all for an empty query", () => {
        // The alternative is every position in the file being a hit, which paints
        // the whole thing and says "1 of 4,000".
        expect(findMatches(CONFIG, "")).toEqual([]);
    });

    it("does not report a hit twice by overlapping itself", () => {
        expect(findMatches("aaaa", "aa")).toEqual([
            { start: 0, end: 2 },
            { start: 2, end: 4 }
        ]);
    });

    it("stops counting somewhere, and says so by stopping at the cap", () => {
        const many = "x".repeat(MOST_MATCHES + 500);
        expect(findMatches(many, "x")).toHaveLength(MOST_MATCHES);
    });

    it("searches across lines as one text", () => {
        expect(findMatches(CONFIG, "false\n    skeleton")).toHaveLength(1);
    });
});

describe("painting the hits", () => {
    it("gives back the whole file, in order", () => {
        const parts = markedParts(CONFIG, findMatches(CONFIG, "false"), 0);
        expect(parts.map((part) => part.text).join("")).toBe(CONFIG);
    });

    it("marks one of them as the one being stepped through", () => {
        const parts = markedParts(CONFIG, findMatches(CONFIG, "false"), 1);
        const hits = parts.filter((part) => part.hit);
        expect(hits).toHaveLength(2);
        expect(hits.map((part) => part.current)).toEqual([false, true]);
    });

    it("hands back the text untouched when nothing matched", () => {
        expect(markedParts(CONFIG, [], 0)).toEqual([{ text: CONFIG, hit: false, current: false }]);
    });

    it("keeps a hit at the very start and the very end", () => {
        const text = "ab";
        expect(markedParts(text, findMatches(text, "a"), 0).map((part) => part.text)).toEqual(["a", "b"]);
        expect(markedParts(text, findMatches(text, "b"), 0).map((part) => part.text)).toEqual(["a", "b"]);
    });
});

describe("stepping through them", () => {
    it("wraps at both ends", () => {
        expect(stepMatch(2, 3, 1)).toBe(0);
        expect(stepMatch(0, 3, -1)).toBe(2);
    });

    it("stays put when there is nothing to step through", () => {
        expect(stepMatch(0, 0, 1)).toBe(0);
    });
});
