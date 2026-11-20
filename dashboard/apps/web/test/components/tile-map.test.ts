/**
 * The arithmetic under the location map: where a point lands on the tile grid,
 * how much ground a pixel covers, and the zoom that fits several people.
 */

import { describe, expect, it } from "vitest";
import { fittingZoom, metersPerPixel, worldPixel } from "@/components/map/tile-map";

describe("the tile grid", () => {
    it("puts the origin in the middle of the world", () => {
        expect(worldPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
        expect(worldPixel(0, 0, 1)).toEqual({ x: 256, y: 256 });
    });

    it("puts the date line at the edges", () => {
        expect(worldPixel(0, -180, 2).x).toBe(0);
        expect(worldPixel(0, 180, 2).x).toBe(1024);
    });

    it("covers about 2.4 m a pixel at the equator on zoom 16", () => {
        expect(metersPerPixel(0, 16)).toBeCloseTo(2.39, 1);
    });

    it("zooms out until everybody fits, and stays deep for one", () => {
        const one = [{ latitude: 40.4, longitude: -3.7 }];
        expect(fittingZoom(one, 320, 160)).toBe(16);
        const apart = [
            { latitude: 40.4, longitude: -3.7 },
            { latitude: 41.4, longitude: 2.17 }
        ];
        expect(fittingZoom(apart, 320, 160)).toBeLessThan(8);
    });
});
