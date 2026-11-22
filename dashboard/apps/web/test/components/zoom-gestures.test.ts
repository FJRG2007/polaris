/**
 * The arithmetic behind a pinch, a wheel and the transform the zoom writes.
 *
 * A pinch has to keep whatever is between the fingers between them, a wheel has
 * to treat a trackpad pinch as the small-step gesture it is, and the transform
 * has to be the compositor-only one - all of it pure, so it is asserted here
 * rather than by pinching a phone.
 */

import * as geometry from "@polaris/ui/zoom";
import { describe, expect, it } from "vitest";

const near = (value: number, expected: number) => expect(value).toBeCloseTo(expected, 6);

describe("pinchBy", () => {
    it("zooms by the ratio of the spread, around the midpoint", () => {
        const before = [
            { x: -0.1, y: 0 },
            { x: 0.1, y: 0 }
        ] as const;
        const after = [
            { x: -0.2, y: 0 },
            { x: 0.2, y: 0 }
        ] as const;
        const zoomed = geometry.pinchBy(geometry.NO_ZOOM, before, after);
        near(zoomed.scale, 2);
        // Centred fingers, centred zoom.
        near(zoomed.x, 0);
        near(zoomed.y, 0);
    });

    it("keeps the point between the fingers under them", () => {
        // Fingers around a point right of centre, spreading to double.
        const before = [
            { x: 0.2, y: 0.1 },
            { x: 0.3, y: 0.1 }
        ] as const;
        const after = [
            { x: 0.15, y: 0.1 },
            { x: 0.35, y: 0.1 }
        ] as const;
        const zoomed = geometry.pinchBy(geometry.NO_ZOOM, before, after);
        // The picture point under the midpoint (0.25, 0.1) maps back to itself:
        // screen = point * scale + shift.
        near(0.25 * zoomed.scale + zoomed.x, 0.25);
        near(0.1 * zoomed.scale + zoomed.y, 0.1);
    });

    it("carries the picture with the midpoint when the fingers drift", () => {
        const start = { scale: 3, x: 0, y: 0 };
        const before = [
            { x: -0.1, y: 0 },
            { x: 0.1, y: 0 }
        ] as const;
        const after = [
            { x: 0, y: 0.05 },
            { x: 0.2, y: 0.05 }
        ] as const;
        const moved = geometry.pinchBy(start, before, after);
        near(moved.scale, 3);
        near(moved.x, 0.1);
        near(moved.y, 0.05);
    });

    it("never divides by fingers on the same spot, and never leaves the clamp", () => {
        const same = [
            { x: 0, y: 0 },
            { x: 0, y: 0 }
        ] as const;
        expect(geometry.pinchBy(geometry.NO_ZOOM, same, same)).toEqual(geometry.NO_ZOOM);
        const huge = geometry.pinchBy(geometry.NO_ZOOM, [{ x: 0, y: 0 }, { x: 0.001, y: 0 }], [
            { x: -0.5, y: 0 },
            { x: 0.5, y: 0 }
        ]);
        expect(huge.scale).toBe(geometry.MAX_ZOOM);
    });
});

describe("wheelFactor", () => {
    it("zooms in on a wheel turned up and out on one turned down", () => {
        expect(geometry.wheelFactor({ deltaY: -100, deltaMode: 0 })).toBeGreaterThan(1);
        expect(geometry.wheelFactor({ deltaY: 100, deltaMode: 0 })).toBeLessThan(1);
        expect(geometry.wheelFactor({ deltaY: 0, deltaMode: 0 })).toBe(1);
    });

    it("weights a trackpad pinch (ctrl wheel) ten times", () => {
        near(
            Math.log(geometry.wheelFactor({ deltaY: -5, deltaMode: 0, ctrlKey: true })),
            10 * Math.log(geometry.wheelFactor({ deltaY: -5, deltaMode: 0 }))
        );
    });

    it("caps one event, whatever the device reports", () => {
        const most = geometry.wheelFactor({ deltaY: -240, deltaMode: 0 });
        expect(geometry.wheelFactor({ deltaY: -99999, deltaMode: 0 })).toBe(most);
        expect(geometry.wheelFactor({ deltaY: -15, deltaMode: 1 })).toBe(most);
        expect(geometry.wheelFactor({ deltaY: Number.NaN, deltaMode: 0 })).toBe(1);
    });
});

describe("zoomTransformPx", () => {
    it("is a translate3d in frame pixels, then the scale", () => {
        const value = geometry.zoomTransformPx({ scale: 2, x: 0.25, y: -0.1 }, geometry.FILLS, {
            width: 1000,
            height: 500
        });
        expect(value).toBe("translate3d(250px, -50px, 0) scale(2)");
    });

    it("clamps before it converts, so the picture never leaves its edge", () => {
        const value = geometry.zoomTransformPx({ scale: 2, x: 5, y: 0 }, geometry.FILLS, {
            width: 1000,
            height: 500
        });
        expect(value).toBe("translate3d(500px, 0px, 0) scale(2)");
    });

    it("is the identity for no zoom, even before the frame is measured", () => {
        expect(geometry.zoomTransformPx(geometry.NO_ZOOM, geometry.FILLS, { width: 0, height: 0 })).toBe(
            "translate3d(0px, 0px, 0) scale(1)"
        );
    });
});
