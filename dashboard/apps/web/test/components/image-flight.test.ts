/**
 * A picture growing out of its thumbnail.
 *
 * `flight` lays the full picture over its thumbnail with a transform and a clip,
 * and `visibleBox` decides whether there is a thumbnail to fly to at all. Both
 * are geometry, so they are checked as numbers rather than by watching.
 */

import { describe, expect, it } from "vitest";
import { flight, visibleBox, type Box } from "@/components/image-flight";

const viewport = { width: 1000, height: 800 };

/** An element whose box is whatever the test says, on the page or not. */
function placed(rect: { left: number; top: number; width: number; height: number }, connected = true) {
    return {
        isConnected: connected,
        getBoundingClientRect: () => ({
            ...rect,
            right: rect.left + rect.width,
            bottom: rect.top + rect.height,
            x: rect.left,
            y: rect.top
        })
    } as unknown as Element;
}

/** Undo `flight`: where its transform and clip put the picture, as a box. */
function landing(to: Box, result: { transform: string; clipPath: string }): Box {
    const [, dx, dy, scale] = /translate\((.+)px, (.+)px\) scale\((.+)\)/
        .exec(result.transform)!
        .map(Number);
    const [, insetY, insetX] = /inset\((.+)px (.+)px\)/.exec(result.clipPath)!.map(Number);
    const width = (to.width - 2 * insetX!) * scale!;
    const height = (to.height - 2 * insetY!) * scale!;
    const centreX = to.x + to.width / 2 + dx!;
    const centreY = to.y + to.height / 2 + dy!;
    return { x: centreX - width / 2, y: centreY - height / 2, width, height };
}

function expectBox(actual: Box, expected: Box) {
    expect(actual.x).toBeCloseTo(expected.x, 6);
    expect(actual.y).toBeCloseTo(expected.y, 6);
    expect(actual.width).toBeCloseTo(expected.width, 6);
    expect(actual.height).toBeCloseTo(expected.height, 6);
}

describe("flight", () => {
    it("lands a picture of the same shape exactly on its thumbnail, unclipped", () => {
        const from = { x: 40, y: 60, width: 160, height: 90 };
        const to = { x: 100, y: 100, width: 800, height: 450 };
        const result = flight(from, to);
        expect(result.transform).toBe("translate(-380px, -220px) scale(0.2)");
        expect(result.clipPath).toBe("inset(0px 0px)");
        expectBox(landing(to, result), from);
    });

    it("grows a wide picture out of a square crop without stretching it", () => {
        const from = { x: 10, y: 20, width: 100, height: 100 };
        const to = { x: 0, y: 200, width: 1000, height: 500 };
        const result = flight(from, to);
        // Scaled evenly to cover the square: by height, so the sides are cut.
        expect(result.transform).toContain("scale(0.2)");
        expect(result.clipPath).toBe("inset(0px 250px)");
        expectBox(landing(to, result), from);
    });

    it("cuts top and bottom when the thumbnail is wider than the picture", () => {
        const from = { x: 500, y: 500, width: 300, height: 100 };
        const to = { x: 200, y: 50, width: 400, height: 600 };
        const result = flight(from, to);
        expect(result.transform).toContain("scale(0.75)");
        expect(result.clipPath).toBe(`inset(${(600 - 100 / 0.75) / 2}px 0px)`);
        expectBox(landing(to, result), from);
    });

    it("does not move a picture that already sits on its thumbnail", () => {
        const box = { x: 12, y: 34, width: 56, height: 78 };
        expect(flight(box, box)).toEqual({
            transform: "translate(0px, 0px) scale(1)",
            clipPath: "inset(0px 0px)"
        });
    });
});

describe("visibleBox", () => {
    it("is the box of a thumbnail on screen", () => {
        expect(visibleBox(placed({ left: 10, top: 20, width: 30, height: 40 }), viewport)).toEqual({
            x: 10,
            y: 20,
            width: 30,
            height: 40
        });
    });

    it("keeps a thumbnail that is only partly on screen", () => {
        const box = visibleBox(placed({ left: -20, top: 780, width: 50, height: 50 }), viewport);
        expect(box).toEqual({ x: -20, y: 780, width: 50, height: 50 });
    });

    it("has nothing to fly to without a thumbnail", () => {
        expect(visibleBox(null, viewport)).toBeNull();
    });

    it("has nothing to fly to once the thumbnail left the page", () => {
        const gone = placed({ left: 10, top: 20, width: 30, height: 40 }, false);
        expect(visibleBox(gone, viewport)).toBeNull();
    });

    it("has nothing to fly to when the thumbnail is hidden or has no size", () => {
        expect(visibleBox(placed({ left: 10, top: 20, width: 0, height: 0 }), viewport)).toBeNull();
        expect(visibleBox(placed({ left: 10, top: 20, width: 30, height: 0.5 }), viewport)).toBeNull();
    });

    it("has nothing to fly to when the thumbnail is scrolled off any edge", () => {
        const off = [
            { left: 10, top: -50, width: 30, height: 50 },
            { left: 10, top: 800, width: 30, height: 40 },
            { left: -30, top: 20, width: 30, height: 40 },
            { left: 1000, top: 20, width: 30, height: 40 }
        ];
        for (const rect of off) expect(visibleBox(placed(rect), viewport)).toBeNull();
    });
});
