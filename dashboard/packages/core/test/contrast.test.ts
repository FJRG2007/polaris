/**
 * Whether text can be read on the colour behind it.
 *
 * The numbers here are WCAG 2's, which is the same formula every browser's
 * accessibility panel reports - deliberately, because it is the only way an
 * argument about "is that legible" ever ends. What this guards is the two
 * places the product asks: which ink to write a nameplate in, and whether a
 * colour somebody chose is one anybody can read.
 */

import { describe, expect, it } from "vitest";
import {
    INK_DARK,
    INK_LIGHT,
    bestContrastOn,
    contrastRatio,
    inkFor,
    isReadableOn,
    luminanceOf,
    READABLE_CONTRAST
} from "../src/contrast.js";

describe("the measure", () => {
    it("agrees with the ends of the scale", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
        expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
    });

    it("reads the same in either direction, because legibility does", () => {
        expect(contrastRatio("#ffffff", "#767676")).toBeCloseTo(
            contrastRatio("#767676", "#ffffff"),
            10
        );
    });

    it("takes the short form and treats nonsense as black", () => {
        expect(luminanceOf("#fff")).toBeCloseTo(luminanceOf("#ffffff"), 10);
        // The safe direction: an unreadable answer beats a confident wrong one.
        expect(luminanceOf("rebeccapurple")).toBe(0);
    });

    // #767676 on white is the canonical AA example, and it passes by a hair -
    // which is what the floor is for. Two colours that are the same fail
    // absolutely.
    it("puts the floor where the standard puts it", () => {
        expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(READABLE_CONTRAST);
        expect(contrastRatio("#777777", "#777777")).toBeLessThan(READABLE_CONTRAST);
    });
});

describe("which ink to write in", () => {
    it("writes dark on a light plate and light on a dark one", () => {
        expect(inkFor("#fde68a", "#fca5a5")).toBe(INK_DARK);
        expect(inkFor("#1e1b4b", "#312e81")).toBe(INK_LIGHT);
    });

    /**
     * The failure this replaced. A plate is a gradient, the letters land on both
     * ends of it, and an ink chosen against one end is an ink that disappears at
     * the other - which is what a flag on the plate could never account for.
     */
    it("chooses against the worst end of a gradient, not the first", () => {
        const ink = inkFor("#ffffff", "#111111");
        expect(Math.min(contrastRatio(ink, "#ffffff"), contrastRatio(ink, "#111111"))).toBe(
            bestContrastOn("#ffffff", "#111111")
        );
    });

    it("still answers for a plate that is one colour", () => {
        expect(inkFor("#ffffff")).toBe(INK_DARK);
    });
});

describe("saying whether a choice is readable", () => {
    it("passes a colour anybody can read and fails one nobody can", () => {
        expect(isReadableOn("#1c1917", "#fde68a")).toBe(true);
        expect(isReadableOn("#9ca3af", "#a3a3a3")).toBe(false);
    });

    /**
     * The hardest colour there is. Around #7c7c7c neither ink clears the floor -
     * the best either can do is about 4.2 - which is exactly the case a flag on
     * the plate could not express and a picker has to be able to refuse.
     */
    it("finds the surface no ink can rescue", () => {
        expect(bestContrastOn("#7c7c7c")).toBeLessThan(READABLE_CONTRAST);
    });

    // A mid-grey plate is the one that cannot be rescued by either ink, and the
    // picker has to be able to say so rather than pick the least bad.
    it("reports how legible the best ink is, so the picker can say why", () => {
        expect(bestContrastOn("#ffffff")).toBeGreaterThan(READABLE_CONTRAST);
        expect(bestContrastOn("#1e1b4b")).toBeGreaterThan(READABLE_CONTRAST);
    });
});

/**
 * Every plate the product ships, measured.
 *
 * This is the test that exists because four of them shipped unreadable. A
 * nameplate is a gradient and a row is two lines, so the letters land on both
 * ends of it - and at the light end of Tide, Ember, Moss and Rose neither ink
 * cleared the floor. Rose was the worst: the best either could do was 2.2:1.
 *
 * So the catalogue is checked rather than eyeballed, and the next plate anybody
 * adds is checked with it.
 */
describe("the plates this product ships", () => {
    it("can every one of them carry text", async () => {
        const { NAMEPLATES } = await import("../src/profile-style.js");
        for (const plate of NAMEPLATES) {
            expect(
                bestContrastOn(plate.from, plate.to),
                `${plate.label} cannot be written on`
            ).toBeGreaterThanOrEqual(READABLE_CONTRAST);
        }
    });
});
