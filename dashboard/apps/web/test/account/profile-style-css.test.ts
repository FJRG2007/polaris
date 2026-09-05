/**
 * The properties a chosen appearance turns into, and the one thing about them
 * that is arithmetic rather than taste.
 *
 * Two of these treatments move, and both used to move badly: the light on a
 * profile card crossed it, vanished, waited, and reappeared out of nowhere, and
 * a name in moving colours would have snapped back to its first frame several
 * times a minute. Both are now the same trick - a tiled gradient walked by
 * exactly one tile - and both are only seamless while three numbers agree: the
 * width of the layer, the width of one tile on it, and the distance the
 * keyframes move it.
 *
 * Those three numbers live in three different files, which is exactly the shape
 * of a thing that drifts. So they are checked against each other here rather
 * than looked at, because the failure is not a crash or a wrong colour - it is a
 * flicker somebody notices a week later and reports as "the card is glitching".
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME_STYLES, effectOf, nameStyleOf, decorationOf } from "@polaris/core";
import {
    nameStyleClass,
    nameStyleCss,
    ringWidth,
    sheenCss,
    SHEEN_LAYER
} from "@/lib/profile-style-css";

const GLOBALS = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");

/** The percentage a named keyframe rule walks its element by. */
function walkOf(animation: string): number {
    const block = GLOBALS.split(`@keyframes ${animation}`)[1] ?? "";
    const found = block.slice(0, 400).match(/translateX\(-(\d+(?:\.\d+)?)%\)/);
    expect(found).not.toBeNull();
    return Number(found![1]);
}

describe("the light on a card", () => {
    it("walks exactly one tile, so the cycle has no beginning", () => {
        // The layer is n card widths and one tile is m of them; walking the
        // layer by one tile lands on a frame identical to the first. Get any of
        // the three wrong and the layer's own edge crosses the card.
        const layer = Number(SHEEN_LAYER.match(/w-\[(\d+)%\]/)![1]);
        const tile = Number(String(sheenCss(effectOf("sheen")!)!.backgroundSize).match(/^(\d+)%/)![1]);
        expect(walkOf("polaris-sheen")).toBe(tile);
        // And the layer still covers the card after the walk: what is left of it
        // over the card is the whole of the card.
        expect(layer - (layer * tile) / 100).toBeGreaterThanOrEqual(100);
    });

    it("tiles, or the gradient is drawn once and the rest of the layer is bare", () => {
        expect(sheenCss(effectOf("sheen")!)!.backgroundRepeat).toBe("repeat-x");
    });

    it("is nothing at all for an effect that is only an edge", () => {
        expect(sheenCss(effectOf("gilded")!)).toBeNull();
    });
});

describe("a name in colour", () => {
    it("paints a still one with the colours it was given and no animation", () => {
        const style = nameStyleOf("aurora")!;
        const css = nameStyleCss(style);
        expect(css.backgroundImage).toBe("linear-gradient(92deg, #3fd0c9 0%, #a06bff 100%)");
        expect(css.backgroundSize).toBeUndefined();
        expect(nameStyleClass(style)).toBeUndefined();
    });

    it("tiles a moving one and walks it by exactly one tile", () => {
        const style = nameStyleOf("flow")!;
        const css = nameStyleCss(style);
        // Flat on purpose: a slanted gradient meets the next tile at a different
        // colour on every line of the letters, and the join stops being invisible.
        expect(css.backgroundImage).toContain("linear-gradient(90deg,");
        expect(css.backgroundSize).toBe("200% 100%");
        expect(css.backgroundRepeat).toBe("repeat-x");
        expect(nameStyleClass(style)).toBe("profile-name-flow");
        // Position 200% of a tile twice the width of the text is one whole tile.
        const block = GLOBALS.split("@keyframes polaris-name-flow")[1] ?? "";
        expect(block.slice(0, 300)).toContain("background-position: 200% center");
    });

    it("closes every moving gradient on the colour it opened with", () => {
        for (const entry of NAME_STYLES.filter((style) => style.moving)) {
            const image = String(nameStyleCss(entry).backgroundImage);
            expect(image).toContain(`${entry.colors[0]} 0%`);
            expect(image).toContain(`${entry.colors[0]} 100%`);
        }
    });

    it("names a colour before it makes the letters transparent", () => {
        // A browser that ignores the clip would otherwise draw an invisible name.
        const css = nameStyleCss(nameStyleOf("ember")!);
        expect(css.color).toBe("#ffcc66");
    });
});

describe("the band a decoration is given", () => {
    it("is a fraction of the face, so one decoration is one ornament at every size", () => {
        const decoration = decorationOf("aurora")!;
        expect(ringWidth(decoration, 100)).toBe(Math.round(100 * decoration.width));
        expect(ringWidth(decoration, 200)).toBe(Math.round(200 * decoration.width));
    });

    it("never rounds down to nothing on the smallest face", () => {
        // A band of zero pixels is a decoration somebody chose and cannot see.
        expect(ringWidth(decorationOf("ink")!, 8)).toBeGreaterThanOrEqual(1);
    });
});
