/**
 * A world nobody chose a seed for.
 *
 * The bug this pins: an empty seed was handed to the image, and what an image
 * does with an empty property is its own business - somewhere between leaving it
 * unset, writing it empty, and writing a zero, which is a real seed that
 * generates the same world every time. Every new server, the same map.
 *
 * So one is minted here. What matters about it is that it is different every
 * time and that it is a number the game reads as itself rather than hashes -
 * anything else is a seed nobody could reproduce on purpose.
 */

import { describe, expect, it } from "vitest";
import { isSeed, randomSeed } from "@/lib/apps/minecraft/world";

describe("a seed for a world nobody chose one for", () => {
    it("is different every time", () => {
        const seen = new Set(Array.from({ length: 200 }, () => randomSeed()));
        expect(seen.size).toBe(200);
    });

    it("is never empty and never zero", () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const seed = randomSeed();
            expect(seed).not.toBe("");
            expect(seed).not.toBe("0");
        }
    });

    it("is a number the game reads as itself", () => {
        // Signed 64-bit, which is the range Minecraft takes a numeric seed in.
        // Outside it the game would hash the text instead, and the seed somebody
        // is shown would not be the seed the world has.
        const limit = 2n ** 63n;
        for (let attempt = 0; attempt < 200; attempt += 1) {
            const seed = randomSeed();
            expect(seed).toMatch(/^-?[0-9]+$/);
            const value = BigInt(seed);
            expect(value >= -limit && value < limit).toBe(true);
        }
    });

    it("is one the schema would accept from a person", () => {
        expect(isSeed(randomSeed())).toBe(true);
    });
});
