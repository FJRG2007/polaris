/**
 * Which part of a picture survives being framed.
 *
 * The cropper is a pointer dragging an image around, and none of that is worth
 * testing; `cropRect` is the whole of what it means, and it has two jobs that
 * are. One is that the untouched default is exactly the crop Polaris used to
 * take on its own - the middle, at the largest size the wanted shape fits in -
 * so nobody who ignores the dialog gets a worse picture than before it existed.
 * The other is that the frame can never leave the picture: a banner with a strip
 * of nothing down one side is what an unclamped centre produces, and it would
 * only be noticed by whoever it happened to.
 */

import { describe, expect, it } from "vitest";
import { BAND_CROP, cropRect, FACE_CROP } from "@/components/image-cropper";

const CENTRED = { x: 0.5, y: 0.5, zoom: 1 };

describe("cropRect", () => {
    it("takes the whole of a square picture for a square", () => {
        expect(cropRect(400, 400, FACE_CROP, CENTRED)).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    });

    it("takes the middle of a wide picture for a square", () => {
        // The old behaviour, which is what pressing Save without touching
        // anything still has to give.
        expect(cropRect(800, 400, FACE_CROP, CENTRED)).toEqual({ x: 200, y: 0, width: 400, height: 400 });
    });

    it("takes the middle of a tall picture for a square", () => {
        expect(cropRect(400, 800, FACE_CROP, CENTRED)).toEqual({ x: 0, y: 200, width: 400, height: 400 });
    });

    it("takes the widest band that fits, in the middle", () => {
        expect(cropRect(900, 900, BAND_CROP, CENTRED)).toEqual({ x: 0, y: 300, width: 900, height: 300 });
    });

    it("never asks for more of the picture than there is", () => {
        // A band wider than the picture is tall would read past the bottom edge
        // and come back transparent.
        const crop = cropRect(300, 60, BAND_CROP, CENTRED);
        expect(crop.height).toBeLessThanOrEqual(60);
        expect(crop.y).toBeGreaterThanOrEqual(0);
        expect(crop.y + crop.height).toBeLessThanOrEqual(60);
    });

    it("moves with the framing", () => {
        const crop = cropRect(800, 400, FACE_CROP, { x: 0.25, y: 0.5, zoom: 1 });
        expect(crop).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    });

    it("stops at the left edge rather than reading past it", () => {
        const crop = cropRect(800, 400, FACE_CROP, { x: 0, y: 0.5, zoom: 1 });
        expect(crop.x).toBe(0);
    });

    it("stops at the right edge rather than reading past it", () => {
        const crop = cropRect(800, 400, FACE_CROP, { x: 1, y: 0.5, zoom: 1 });
        expect(crop.x + crop.width).toBe(800);
    });

    it("takes less of the picture the further it is zoomed in", () => {
        expect(cropRect(400, 400, FACE_CROP, { x: 0.5, y: 0.5, zoom: 2 })).toEqual({
            x: 100,
            y: 100,
            width: 200,
            height: 200
        });
    });

    it("keeps a zoomed frame inside the picture too", () => {
        const crop = cropRect(400, 400, FACE_CROP, { x: 0, y: 1, zoom: 4 });
        expect(crop).toEqual({ x: 0, y: 300, width: 100, height: 100 });
    });

    it("keeps the shape it was asked for whatever the framing", () => {
        for (const zoom of [1, 1.7, 3, 5]) {
            const crop = cropRect(1234, 567, BAND_CROP, { x: 0.2, y: 0.8, zoom });
            expect(crop.width / crop.height).toBeCloseTo(3, 6);
        }
    });
});
