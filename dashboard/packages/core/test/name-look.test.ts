/**
 * A name painted the way its owner chose.
 *
 * The catalogue that came before this could make exactly one thing: a gradient
 * between two colours somebody else picked. So every name in the product that
 * was anything at all was the same idea in ten palettes, and "your own colour"
 * was not on offer at any price.
 *
 * A style is now either one of those ids or a composed value, and which it is is
 * decided by whether there is a separator in it - the same trick the banner
 * uses. What is asserted here is the two things that keeps honest: the ids that
 * are already stored still paint what they always painted, and nothing that is
 * not a style Polaris ships can reach the `style` attribute a name is drawn
 * with.
 */

import { describe, expect, it } from "vitest";
import {
    effectTakesTwo,
    nameLookOf,
    NAME_EFFECTS,
    NAME_FONTS,
    writeNameLook
} from "../src/profile-style.js";

describe("a name style somebody composed", () => {
    it("survives being written and read back", () => {
        for (const effect of NAME_EFFECTS) {
            for (const font of NAME_FONTS) {
                const written = writeNameLook({
                    effect,
                    font,
                    colors: ["#5b8def", "#a06bff"],
                    moving: false
                });
                const read = nameLookOf(written);
                expect([effect, font, read?.effect, read?.font]).toEqual([
                    effect,
                    font,
                    effect,
                    font
                ]);
                expect(read?.colors[0]).toBe("#5b8def");
            }
        }
    });

    it("keeps a second colour only for the effects that run between two", () => {
        // A second colour on Solid is a control that changes nothing, which is
        // worse than one that is not there.
        expect(nameLookOf("solid:sans:#5b8def:#a06bff")?.colors).toEqual(["#5b8def"]);
        expect(nameLookOf("gradient:sans:#5b8def:#a06bff")?.colors).toEqual([
            "#5b8def",
            "#a06bff"
        ]);
        expect(effectTakesTwo("neon")).toBe(false);
    });

    it("only moves for the one built to come back to where it began", () => {
        // Every other effect is a still picture, and a still picture that
        // animates is a name that flickers in every list its owner appears in.
        expect(nameLookOf("prism:sans:#5b8def:#a06bff")?.moving).toBe(true);
        for (const effect of NAME_EFFECTS.filter((entry) => entry !== "prism")) {
            expect(nameLookOf(`${effect}:sans:#5b8def`)?.moving).toBe(false);
        }
    });

    it("refuses anything that is not a style Polaris ships", () => {
        // This ends up in a `style` attribute. The one rule that makes that safe
        // is that nothing reaches it without having been recognised here.
        expect(nameLookOf("javascript:sans:#5b8def")).toBeNull();
        expect(nameLookOf("solid:comic:#5b8def")).toBeNull();
        expect(nameLookOf("solid:sans:red")).toBeNull();
        expect(nameLookOf("solid:sans:url(x)")).toBeNull();
        expect(nameLookOf("solid:sans:")).toBeNull();
        expect(nameLookOf("")).toBeNull();
        expect(nameLookOf(null)).toBeNull();
    });

    it("still paints the ids people already have", () => {
        // Nobody's name changes because the screen that chose it did. A still
        // catalogue entry was a gradient; a moving one was the walking version
        // of the same thing.
        const still = nameLookOf("aurora");
        expect(still?.effect).toBe("gradient");
        expect(still?.moving).toBe(false);
        expect(still?.colors.length).toBeGreaterThan(1);

        const moving = nameLookOf("flow");
        expect(moving?.effect).toBe("prism");
        expect(moving?.moving).toBe(true);
    });

    it("drops an id that has been withdrawn", () => {
        expect(nameLookOf("a-style-that-was-removed")).toBeNull();
    });
});
