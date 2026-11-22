import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@polaris/core";

const ICON = readFileSync(join(__dirname, "../../public/icon.svg"), "utf8");

describe("the seasonal mark", () => {
    it("is the app's own icon when no season is in force", () => {
        const plain = core.seasonMarkSvg(null);
        expect(ICON).toContain(core.MARK_STAR);
        expect(plain).toContain(`d="${core.MARK_STAR}"`);
        expect(plain).toContain(`fill="${core.MARK_BACKGROUND}"`);
        expect(plain.match(/<path/g)).toHaveLength(1);
    });

    it.each(core.SEASONS)("dresses the mark for %s without hiding it", (season) => {
        const shapes = core.SEASON_MARK_ACCESSORIES[season];
        expect(shapes.length).toBeGreaterThan(0);
        const svg = core.seasonMarkSvg(season, 512);
        // The square and the star come first, the accessory on top of them.
        expect(svg.indexOf(core.MARK_STAR)).toBeLessThan(svg.indexOf(shapes[0]!.d));
        expect(svg).toContain('width="512"');
        for (const shape of shapes) {
            expect(shape.fill).toMatch(/^#[0-9A-F]{6}$/i);
            // Every absolute coordinate stays inside the 32-unit square.
            for (const value of shape.d.match(/-?\d+(\.\d+)?/g) ?? []) {
                expect(Math.abs(Number(value))).toBeLessThanOrEqual(core.MARK_SIZE);
            }
        }
    });
});
