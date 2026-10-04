/**
 * The project canvas's arithmetic: lines leave and enter cards through their
 * facing sides instead of running under them, zoom stays in range and holds
 * the point it zooms towards, and "fit" frames every service at once.
 */

import { describe, expect, it } from "vitest";
import * as geometry from "@/app/(app)/apps/deploy/canvas-geometry";

const card = (x: number, y: number): geometry.Rect => ({ x, y, w: 280, h: 116 });

/** The start and end points of a path drawn by `edgePath`. */
function ends(d: string): { start: geometry.Point; end: geometry.Point } {
    const numbers = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    return {
        start: { x: numbers[0]!, y: numbers[1]! },
        end: { x: numbers[numbers.length - 2]!, y: numbers[numbers.length - 1]! }
    };
}

describe("a line between two services", () => {
    it("runs from the right edge of the left card to the left edge of the right one", () => {
        const { start, end } = ends(geometry.edgePath(card(0, 0), card(400, 40)).d);
        expect(start).toEqual({ x: 280, y: 58 });
        expect(end).toEqual({ x: 400, y: 98 });
    });

    it("is drawn the same way whichever card it was dragged from", () => {
        const { start, end } = ends(geometry.edgePath(card(400, 40), card(0, 0)).d);
        expect(start).toEqual({ x: 400, y: 98 });
        expect(end).toEqual({ x: 280, y: 58 });
    });

    it("leaves through the bottom and enters through the top when the cards are stacked", () => {
        const { start, end } = ends(geometry.edgePath(card(0, 0), card(20, 300)).d);
        expect(start).toEqual({ x: 140, y: 116 });
        expect(end).toEqual({ x: 160, y: 300 });
    });

    it("clears the volume strips under a card, since its footprint includes them", () => {
        const withStrips = { ...card(0, 0), h: 116 + 2 * 44 };
        const { start } = ends(geometry.edgePath(withStrips, card(0, 400)).d);
        expect(start.y).toBe(204);
    });

    it("puts its midpoint between the two cards, where the remove control sits", () => {
        const { mid } = geometry.edgePath(card(0, 0), card(400, 0));
        expect(mid.x).toBeCloseTo(340);
        expect(mid.y).toBeCloseTo(58);
    });

    it("still draws a line between two cards dropped on top of each other", () => {
        const path = geometry.edgePath(card(0, 0), card(10, 10));
        expect(path.d).toMatch(/^M [\d.]+ [\d.]+ C /);
        expect(Number.isFinite(path.mid.x)).toBe(true);
    });
});

describe("zooming the board", () => {
    it("stays inside the range the board supports", () => {
        expect(geometry.clampZoom(10)).toBe(geometry.ZOOM_MAX);
        expect(geometry.clampZoom(0.01)).toBe(geometry.ZOOM_MIN);
        expect(geometry.clampZoom(Number.NaN)).toBe(1);
    });

    it("does not round a small pinch step away", () => {
        // A trackpad pinch is many steps of a fraction of a percent each.
        expect(geometry.clampZoom(1 * Math.exp(-4 * 0.002))).toBeLessThan(1);
    });

    it("keeps the point under the pointer where it was", () => {
        const scroll = { left: 100, top: 50 };
        const anchor = { x: 200, y: 120 };
        const next = geometry.scrollForZoom(scroll, anchor, 1, 1.5);
        // The board point under the anchor before and after is the same.
        expect((next.left + anchor.x) / 1.5).toBeCloseTo((scroll.left + anchor.x) / 1);
        expect((next.top + anchor.y) / 1.5).toBeCloseTo((scroll.top + anchor.y) / 1);
    });

    it("never asks for a scroll before the board's edge", () => {
        expect(geometry.scrollForZoom({ left: 0, top: 0 }, { x: 10, y: 10 }, 1, 0.5)).toEqual({
            left: 0,
            top: 0
        });
    });

    it("comes back to where it began after one step in and one step out", () => {
        const zoomed = geometry.clampZoom(
            geometry.clampZoom(1 * geometry.ZOOM_STEP) / geometry.ZOOM_STEP
        );
        expect(zoomed).toBeCloseTo(1);
    });
});

describe("fitting every service in the frame", () => {
    it("is null with no services to fit", () => {
        expect(geometry.boundsOf([])).toBeNull();
    });

    it("takes the smallest rectangle holding every card", () => {
        expect(geometry.boundsOf([card(40, 20), card(400, 300)])).toEqual({
            x: 40,
            y: 20,
            w: 640,
            h: 396
        });
    });

    it("zooms out until a wide project fits, and centres it", () => {
        const bounds = { x: 400, y: 0, w: 1600, h: 400 };
        const view = geometry.fitView(bounds, { width: 864, height: 600 });
        expect(view.zoom).toBeCloseTo(0.5);
        // The middle of the services (x 1200) lands in the middle of the frame.
        expect(view.scrollLeft).toBeCloseTo(1200 * 0.5 - 432);
    });

    it("does not blow a small project up past its real size", () => {
        const view = geometry.fitView(card(100, 100), { width: 1400, height: 900 });
        expect(view.zoom).toBe(1);
    });

    it("stops at the smallest readable zoom for a project too wide for any frame", () => {
        const view = geometry.fitView(
            { x: 0, y: 0, w: 20_000, h: 200 },
            { width: 390, height: 460 }
        );
        expect(view.zoom).toBe(geometry.ZOOM_MIN);
    });
});

describe("what a service is joined to", () => {
    it("follows links in both directions and ignores the rest", () => {
        const found = geometry.neighboursOf("api", [
            { source: "api", target: "db" },
            { source: "web", target: "api" },
            { source: "web", target: "cache" }
        ]);
        expect([...found].sort()).toEqual(["db", "web"]);
    });
});
