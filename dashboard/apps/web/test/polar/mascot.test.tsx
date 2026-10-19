/**
 * Polar's North Star sits in the sky over the bear, never on its face, and
 * stays inside the drawing at its twinkle's largest, so no size cuts it off.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { POLAR_MOODS, PolarMascot, STAR } from "@/components/polar/polar-mascot";

/** The twinkle's largest scale, around the star's centre. */
const TWINKLE = 1.18;
const CENTRE = { x: 56, y: 8 };

function points(): Array<{ x: number; y: number }> {
    const numbers = (STAR.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
    const out: Array<{ x: number; y: number }> = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) {
        out.push({ x: numbers[index]!, y: numbers[index + 1]! });
    }
    return out;
}

describe("the North Star", () => {
    it("stays inside the 64-unit box even at its twinkle's largest", () => {
        for (const point of points()) {
            const x = CENTRE.x + (point.x - CENTRE.x) * TWINKLE;
            const y = CENTRE.y + (point.y - CENTRE.y) * TWINKLE;
            expect(x).toBeGreaterThanOrEqual(0.5);
            expect(x).toBeLessThanOrEqual(63.5);
            expect(y).toBeGreaterThanOrEqual(0.5);
            expect(y).toBeLessThanOrEqual(63.5);
        }
    });

    it("sits above the head and to its side, clear of the face", () => {
        // The head is the ellipse centred at (32, 37), 22.5 by 19.5.
        for (const point of points()) {
            const inHead = ((point.x - 32) / 22.5) ** 2 + ((point.y - 37) / 19.5) ** 2 <= 1;
            expect(inHead).toBe(false);
            expect(point.y).toBeLessThan(17.5);
        }
        expect(CENTRE.x).toBeGreaterThan(32);
    });

    it("is drawn in every mood, and spins only while thinking", () => {
        for (const mood of POLAR_MOODS) {
            const markup = renderToStaticMarkup(<PolarMascot mood={mood} />);
            expect(markup).toContain(`d="${STAR}"`);
            expect(/class="polar-star-spin" d=/.test(markup)).toBe(mood === "thinking");
        }
    });

    it("keeps its spin and twinkle centred on the star, and still for reduced motion", () => {
        const markup = renderToStaticMarkup(<PolarMascot />);
        expect(markup).toContain("transform-origin:56px 8px;animation:polar-spin");
        expect(markup).toContain("transform-origin:56px 8px;animation:polar-twinkle");
        expect(markup).toMatch(/prefers-reduced-motion: reduce\)\{[^}]*\.polar-twinkle/);
    });
});
