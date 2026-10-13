/**
 * The viewer is drawn at the shape of what the camera actually sends.
 *
 * A fixed 16:9 box left black bands down both sides the moment a narrower
 * stream took over from the still, whatever the camera's stream description
 * claimed. The box follows the measured picture instead, and 16:9 is only what
 * it starts at before anything has been measured.
 */

import { describe, expect, it } from "vitest";
import { pictureShape, viewerFrame } from "@polaris-app/places/src/lib/viewer-shape";

describe("the shape the viewer is drawn at", () => {
    it("starts at 16:9 before anything is measured", () => {
        expect(pictureShape(null)).toBeCloseTo(16 / 9);
        expect(viewerFrame(null).aspectRatio).toBe(String(16 / 9));
    });

    it("follows a 4:3 stream rather than pillarboxing it", () => {
        const frame = viewerFrame(640 / 480);
        expect(frame.aspectRatio).toBe(String(4 / 3));
        // The dialog narrows with it, so the box and the picture are one shape.
        expect(frame.maxWidth).toBe(`min(64rem, calc(85dvh * ${4 / 3}))`);
    });

    it("ignores a measurement that is not a shape", () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(pictureShape(bad)).toBeCloseTo(16 / 9);
        }
    });

    it("measures from the element's own size, and only once it has one", () => {
        expect(pictureShape(null, { width: 1440, height: 1080 })).toBeCloseTo(4 / 3);
        expect(pictureShape(16 / 9, { width: 0, height: 0 })).toBeCloseTo(16 / 9);
    });
});
