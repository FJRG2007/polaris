/**
 * The viewer is drawn at the shape of what the camera actually sends.
 *
 * A fixed 16:9 box left black bands down both sides the moment a narrower
 * stream took over from the still, whatever the camera's stream description
 * claimed. The box follows the measured picture instead, and 16:9 is only what
 * it starts at before anything has been measured.
 */

import { describe, expect, it } from "vitest";
import {
    coverBox,
    pictureShape,
    streamBox,
    streamShape,
    viewerFrame
} from "@polaris-app/places/src/lib/viewer-shape";

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

/**
 * A camera that declares the wrong pixel shape: 2304x1296 pixels that the
 * browser reports, and drew, as 2304x1728. The box took that 4:3 and the
 * picture filled it, every timestamp and face a third taller than it is.
 */
describe("a stream whose declared shape is not its picture's", () => {
    const reported = { width: 2304, height: 1728 };

    it("is measured by its decoded pixels, not the element's report", () => {
        expect(streamShape(null, 2304 / 1296, reported)).toBeCloseTo(16 / 9);
        expect(streamShape(4 / 3, 2304 / 1296, reported)).toBeCloseTo(16 / 9);
    });

    it("keeps the still's shape while no frame has been decoded", () => {
        expect(streamShape(1280 / 720, null, reported)).toBeCloseTo(16 / 9);
    });

    it("falls back to the element's report only with nothing else", () => {
        expect(streamShape(null, null, reported)).toBeCloseTo(4 / 3);
        expect(streamShape(null, null)).toBeCloseTo(16 / 9);
        expect(streamShape(Number.NaN, 0, { width: 0, height: 0 })).toBeCloseTo(16 / 9);
    });

    it("is drawn at the measured shape, as large as the frame or the screen allows", () => {
        expect(streamBox(16 / 9)).toEqual({
            aspectRatio: String(16 / 9),
            width: `min(100%, calc(100dvh * ${16 / 9}))`
        });
        expect(streamBox(null).aspectRatio).toBe(String(16 / 9));
    });

    it("covers a tile at its own shape, overhanging rather than squashing", () => {
        expect(coverBox(16 / 9, 16 / 9)).toEqual({ width: "100.0000%", height: "100%" });
        expect(coverBox(4 / 3, 16 / 9)).toEqual({ width: "100%", height: "133.3333%" });
        expect(coverBox(32 / 9, 16 / 9)).toEqual({ width: "200.0000%", height: "100%" });
    });
});
