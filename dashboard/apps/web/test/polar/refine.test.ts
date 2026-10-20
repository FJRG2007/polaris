/**
 * Answering again with more detail or fewer words: the line the model is told
 * is fixed text chosen from a menu, and nothing at all for a plain retry.
 */

import { describe, expect, it } from "vitest";
import { refineLine } from "@/lib/polar/prompt";

describe("refineLine", () => {
    it("asks for more detail, or for fewer words", () => {
        expect(refineLine("longer")).toMatch(/more detail/);
        expect(refineLine("shorter")).toMatch(/concise/);
    });

    it("adds nothing to a plain retry", () => {
        expect(refineLine(null)).toBe("");
    });
});
