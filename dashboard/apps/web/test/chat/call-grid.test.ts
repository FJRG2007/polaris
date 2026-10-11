/**
 * The size of each face in a call.
 *
 * The defect this pins down: five people in a tall voice channel were five
 * portrait strips, because a fixed column count stretched every tile to the
 * panel's height. Tiles keep the 16:9 shape of the video they show, and the
 * column count is whichever makes them biggest.
 */

import { describe, expect, it } from "vitest";
import { fillsTile, fitTiles, TILE_RATIO } from "@/app/(app)/chat/call-grid";

describe("fitTiles", () => {
    it("keeps every tile 16:9", () => {
        for (const count of [1, 2, 3, 5, 8, 12]) {
            const fit = fitTiles(count, 760, 960, 8);
            expect(Math.abs(fit.width / fit.height - TILE_RATIO)).toBeLessThan(0.02);
        }
    });

    it("puts five in two columns of wide tiles in a tall, narrow panel", () => {
        // The panel of the reported screenshot: about 760 wide, 960 tall. Three
        // across was the portrait strips; two across is the biggest 16:9 fit.
        const fit = fitTiles(5, 760, 960, 8);
        expect(fit.columns).toBe(2);
        expect(fit.width).toBe(376);
        expect(fit.height).toBe(211);
    });

    it("lays a wide panel out in columns", () => {
        expect(fitTiles(4, 1600, 900, 8).columns).toBe(2);
        expect(fitTiles(6, 1600, 700, 8).columns).toBe(3);
    });

    it("fits inside the panel", () => {
        for (const [count, width, height] of [
            [5, 760, 960],
            [7, 1200, 500],
            [2, 390, 300]
        ] as const) {
            const fit = fitTiles(count, width, height, 8);
            const rows = Math.ceil(count / fit.columns);
            expect(fit.columns * fit.width + (fit.columns - 1) * 8).toBeLessThanOrEqual(width);
            expect(rows * fit.height + (rows - 1) * 8).toBeLessThanOrEqual(height);
        }
    });

    it("is nothing until the panel has a size", () => {
        expect(fitTiles(3, 0, 0, 8).width).toBe(0);
        expect(fitTiles(0, 800, 600, 8).width).toBe(0);
    });
});

describe("fillsTile", () => {
    it("trims a camera near the tile's shape to fill it", () => {
        expect(fillsTile(16 / 9, TILE_RATIO)).toBe(true);
        expect(fillsTile(4 / 3, TILE_RATIO)).toBe(true);
    });

    it("shows an upright phone whole in a wide tile, and a wide camera whole in a tall one", () => {
        expect(fillsTile(9 / 16, TILE_RATIO)).toBe(false);
        expect(fillsTile(16 / 9, 390 / 844)).toBe(false);
    });

    it("fills an upright tile with an upright camera, as a phone held upright in full screen", () => {
        expect(fillsTile(9 / 16, 390 / 844)).toBe(true);
    });

    it("fills while either shape is still unknown", () => {
        expect(fillsTile(null, TILE_RATIO)).toBe(true);
        expect(fillsTile(4 / 3, null)).toBe(true);
    });
});
