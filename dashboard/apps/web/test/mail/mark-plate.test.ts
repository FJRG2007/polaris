/**
 * Whether a sender's mark needs something behind it.
 *
 * The failure this exists for is silent: a near-black logo on transparency, which
 * is what most sites publish, drawn in the dark theme as nothing at all. Nobody
 * reports a missing logo as a bug - they just stop using the column.
 *
 * Two things have to hold. Transparent pixels must not count as black, or every
 * mark on a transparent background measures dark and the whole column grows
 * plates it does not need. And the decision must be the contrast test this
 * product already uses for text, not a threshold someone picked: a mark is
 * plated exactly when it cannot be told from a surface it will land on.
 */

import { describe, expect, it } from "vitest";
import { markColor, plateFor } from "@/lib/mailbox/mark-plate";
import { INK_DARK, INK_LIGHT, contrastRatio } from "@polaris/core";

/** An image of one colour at one opacity, as the browser hands the pixels over. */
function image(color: [number, number, number], alpha = 255, size = 16): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = color[0];
        pixels[index + 1] = color[1];
        pixels[index + 2] = color[2];
        pixels[index + 3] = alpha;
    }
    return pixels;
}

/** A small mark in the middle of a mostly empty file, which is what an
 *  apple-touch-icon usually is. */
function markOnNothing(color: [number, number, number], covered: number): Uint8ClampedArray {
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    for (let index = 0; index < covered; index += 1) {
        const at = index * 4;
        pixels[at] = color[0];
        pixels[at + 1] = color[1];
        pixels[at + 2] = color[2];
        pixels[at + 3] = 255;
    }
    return pixels;
}

describe("measuring a mark", () => {
    it("reads a solid colour as itself", () => {
        expect(markColor(image([255, 72, 0]))).toBe("#ff4800");
    });

    it("does not count what is not there", () => {
        // The whole point: a black logo on transparency is a black logo, and
        // averaging the transparency in would make every mark look mid-grey.
        expect(markColor(markOnNothing([0, 0, 0], 40))).toBe("#000000");
    });

    it("ignores the soft edge of a mark, which is neither the logo nor nothing", () => {
        const pixels = image([255, 255, 255], 20);
        expect(markColor(pixels)).toBeNull();
    });

    it("says nothing about a file that is effectively empty", () => {
        // A couple of stray pixels describe the emptiness rather than a logo.
        expect(markColor(markOnNothing([0, 0, 0], 3))).toBeNull();
    });
});

describe("deciding what goes behind it", () => {
    it("puts white behind a near-black mark, which is most of them", () => {
        const plate = plateFor("#111111");
        expect(plate).toBe(INK_LIGHT);
        expect(contrastRatio("#111111", plate!)).toBeGreaterThanOrEqual(3);
    });

    it("puts ink behind a white mark, which fails the other way round", () => {
        expect(plateFor("#ffffff")).toBe(INK_DARK);
    });

    it("leaves a mark that reads on both themes exactly as it was", () => {
        // A mid-tone brand colour is legible on a white page and on a dark one,
        // and a plate under it would be a badge nobody asked for.
        expect(plateFor("#ff4800")).toBeNull();
        expect(plateFor("#7c3aed")).toBeNull();
    });

    it("has nothing to say about a mark it could not measure", () => {
        expect(plateFor(null)).toBeNull();
    });

    it("never returns a plate the mark cannot be seen on", () => {
        for (const mark of ["#000000", "#0b0d0e", "#1c1917", "#ffffff", "#fafafa", "#e5e5e5"]) {
            const plate = plateFor(mark);
            if (!plate) continue;
            expect(contrastRatio(mark, plate)).toBeGreaterThanOrEqual(3);
        }
    });
});
