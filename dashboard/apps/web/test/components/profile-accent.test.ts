/**
 * The colour a profile banner takes from the face above it.
 *
 * The part worth testing is the part that decides which colour a picture is
 * "of", and it has two failure modes that both look like a bug on screen: a
 * photograph is mostly muddy midtones, so a plain count of pixels hands the
 * answer to whichever grey there is the most of and every banner comes out
 * beige; and hue is a circle, so averaging it arithmetically turns red - which
 * sits at both ends - into cyan, the colour opposite the one in the picture.
 *
 * The band it draws is also held inside a range on purpose. A photograph of a
 * neon sign must not put a fully saturated stripe behind somebody's face, and a
 * washed-out one must not put up a rectangle that reads as a failed image.
 */

import { describe, expect, it } from "vitest";
import { accentGradient, cssColor, dominantColor } from "@/lib/profile-accent";

/** A picture, as the canvas hands one over: four bytes per pixel. */
function pixels(colours: [number, number, number, number][]): Uint8ClampedArray {
    return new Uint8ClampedArray(colours.flat());
}

/** `count` pixels of one colour, fully opaque. */
function block(count: number, red: number, green: number, blue: number) {
    return Array.from({ length: count }, () => [red, green, blue, 255] as [number, number, number, number]);
}

describe("the colour a picture is of", () => {
    it("finds the one colour in a picture of one colour", () => {
        const accent = dominantColor(pixels(block(16, 30, 90, 200)));
        expect(Math.round(accent!.hue)).toBeGreaterThan(200);
        expect(Math.round(accent!.hue)).toBeLessThan(230);
    });

    it("ignores the greys a photograph is mostly made of", () => {
        // Nine parts grey to one part orange: the grey is what there is most of
        // and the orange is what the picture is of.
        const accent = dominantColor(pixels([...block(90, 128, 128, 130), ...block(10, 230, 120, 20)]));
        expect(Math.round(accent!.hue)).toBeGreaterThan(15);
        expect(Math.round(accent!.hue)).toBeLessThan(45);
    });

    it("averages hue around the circle rather than through the middle of it", () => {
        // Half just clockwise of red, half just anticlockwise. The mean is red,
        // not the cyan an arithmetic average of 5 and 355 would give.
        const accent = dominantColor(pixels([...block(8, 200, 20, 30), ...block(8, 200, 30, 20)]));
        const hue = accent!.hue;
        expect(hue > 340 || hue < 20).toBe(true);
    });

    it("has no answer for a picture with no colour in it", () => {
        expect(dominantColor(pixels(block(16, 20, 20, 20)))).toBeNull();
        expect(dominantColor(pixels(block(16, 250, 250, 250)))).toBeNull();
        expect(dominantColor(new Uint8ClampedArray([0, 0, 0, 0]))).toBeNull();
    });

    it("keeps the band inside what a background can be", () => {
        const shouting = dominantColor(pixels(block(16, 255, 0, 0)))!;
        expect(shouting.saturation).toBeLessThanOrEqual(70);
        expect(shouting.lightness).toBeGreaterThanOrEqual(32);
        expect(shouting.lightness).toBeLessThanOrEqual(52);

        const washed = dominantColor(pixels(block(16, 185, 150, 150)))!;
        expect(washed.saturation).toBeGreaterThanOrEqual(30);
    });
});

describe("the band", () => {
    it("is the colour and a shade of itself, not a flat rectangle", () => {
        const accent = { hue: 200, saturation: 50, lightness: 44 };
        const gradient = accentGradient(accent);
        expect(gradient).toContain(cssColor(accent));
        expect(gradient.startsWith("linear-gradient(")).toBe(true);
        // The far end is a different colour, or there was no point drawing one.
        expect(gradient).not.toBe(`linear-gradient(135deg, ${cssColor(accent)} 0%, ${cssColor(accent)} 100%)`);
    });

    it("stays inside the lightness a colour can have, however dark the start", () => {
        // The far end is darker than the near one, and a dark enough colour would
        // otherwise be asked for at a negative lightness - which is not a colour,
        // and paints as nothing at all.
        const gradient = accentGradient({ hue: 10, saturation: 40, lightness: 10 });
        const lightnesses = [...gradient.matchAll(/hsl\(\d+ \d+% (\d+)%\)/g)].map((match) =>
            Number(match[1])
        );
        expect(lightnesses).toHaveLength(2);
        for (const lightness of lightnesses) expect(lightness).toBeGreaterThan(0);
    });
});
