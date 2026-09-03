/**
 * Pushing into a picture, and never being shown the void.
 *
 * Every hand-rolled version of this is wrong in one of two ways, and both look
 * like the camera has broken rather than like the control has: the picture gets
 * dragged off its own edge and leaves a black margin, or zooming dives at the
 * middle so whatever was being looked at is somewhere else afterwards.
 *
 * The transform order is here too, because it is the one line where a change
 * that reads identically moves the picture by a factor of the zoom.
 */

import { describe, expect, it } from "vitest";
import {
    FILLS,
    MAX_ZOOM,
    NO_ZOOM,
    clampOffset,
    coverOf,
    isZoomed,
    panBy,
    zoomBy,
    zoomTransform
} from "@/lib/home/zoom";

describe("how far in it goes", () => {
    it("starts all the way out", () => {
        expect(NO_ZOOM).toEqual({ scale: 1, x: 0, y: 0 });
        expect(isZoomed(NO_ZOOM)).toBe(false);
    });

    it("never goes further out than the frame", () => {
        // Zooming out past 1 would letterbox a picture that fills the frame.
        expect(zoomBy(NO_ZOOM, 0.5).scale).toBe(1);
        expect(zoomBy({ scale: 1.2, x: 0, y: 0 }, 0.1).scale).toBe(1);
    });

    it("stops at the point where there is no detail left to magnify", () => {
        expect(zoomBy(NO_ZOOM, 100).scale).toBe(MAX_ZOOM);
    });

    it("survives a factor that is not a number", () => {
        for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(zoomBy({ scale: 2, x: 0, y: 0 }, bad).scale).toBe(2);
        }
    });
});

describe("keeping the picture over the frame", () => {
    it("allows exactly the room the extra picture gives, and no more", () => {
        // At twice the size there is half a frame of picture spare, so half of
        // that in each direction.
        expect(clampOffset({ scale: 2, x: 5, y: -5 })).toEqual({ scale: 2, x: 0.5, y: -0.5 });
        expect(clampOffset({ scale: 4, x: 5, y: 5 })).toEqual({ scale: 4, x: 1.5, y: 1.5 });
    });

    it("re-centres the moment it is zoomed all the way out", () => {
        // Otherwise a picture dragged to a corner and then zoomed out would come
        // back off-centre, with a black edge and no way to tell why.
        expect(clampOffset({ scale: 1, x: 0.4, y: -0.4 })).toEqual({ scale: 1, x: 0, y: 0 });
        expect(zoomBy({ scale: 4, x: 1.5, y: 1.5 }, 0.01)).toEqual({ scale: 1, x: 0, y: 0 });
    });

    it("does not drift on a value that is not a number", () => {
        expect(clampOffset({ scale: 2, x: Number.NaN, y: 0 })).toEqual({ scale: 2, x: 0, y: 0 });
    });
});

describe("zooming towards where the pointer is", () => {
    it("keeps what is under the pointer under the pointer", () => {
        // The whole point of zooming at a point: push in over the gate and the
        // gate is still there, rather than the middle of the picture arriving.
        const at = { x: 0.25, y: -0.1 };
        const zoomed = zoomBy(NO_ZOOM, 2, at);
        // What was at `at` sat at picture coordinate `at` when nothing was
        // scaled; afterwards it sits at scale * q + offset, which has to be `at`
        // again.
        expect(zoomed.scale * at.x + zoomed.x).toBeCloseTo(at.x, 10);
        expect(zoomed.scale * at.y + zoomed.y).toBeCloseTo(at.y, 10);
    });

    it("dives at the middle when nothing said otherwise", () => {
        // Which is what a button press means: there is no pointer to aim with.
        expect(zoomBy(NO_ZOOM, 2)).toEqual({ scale: 2, x: 0, y: 0 });
    });

    it("stops panning once it has stopped zooming", () => {
        // Holding the wheel at full zoom must not keep sliding the picture.
        const full = zoomBy(NO_ZOOM, MAX_ZOOM, { x: 0.4, y: 0 });
        expect(zoomBy(full, 2, { x: 0.4, y: 0 })).toEqual(full);
    });
});

describe("dragging it about", () => {
    it("moves the picture by what the pointer moved, so it stays under the finger", () => {
        expect(panBy({ scale: 2, x: 0, y: 0 }, 0.1, -0.2)).toEqual({ scale: 2, x: 0.1, y: -0.2 });
    });

    it("stops at the edge rather than past it", () => {
        expect(panBy({ scale: 2, x: 0.4, y: 0 }, 0.5, 0).x).toBe(0.5);
    });

    it("does nothing at all when there is nothing to pan", () => {
        // A drag on an unzoomed picture is somebody moving the pointer, not
        // somebody asking for the picture to move.
        expect(panBy(NO_ZOOM, 0.3, 0.3)).toEqual(NO_ZOOM);
    });
});

describe("what is handed to the browser", () => {
    it("shifts after scaling, not before", () => {
        // The order is the whole of it. Written the other way round the browser
        // scales the shift too, and a picture clamped in frame fractions goes
        // off its own edge by a factor of the zoom.
        const transform = zoomTransform({ scale: 2, x: 0.25, y: -0.25 });
        expect(transform).toBe("translate(25.0000%, -25.0000%) scale(2)");
        expect(transform.indexOf("translate")).toBeLessThan(transform.indexOf("scale"));
    });

    it("hands back something harmless for a state that was never clamped", () => {
        expect(zoomTransform({ scale: 100, x: 9, y: 9 })).toBe(
            `translate(350.0000%, 350.0000%) scale(${MAX_ZOOM})`
        );
    });
});

describe("a picture that does not fill the frame", () => {
    it("works out what it covers from the two shapes", () => {
        // A 4:3 camera in a 16:9 dialog: it fits across the height and leaves a
        // bar down each side.
        expect(coverOf(4 / 3, 16 / 9)).toEqual({ x: (4 / 3) / (16 / 9), y: 1 });
        // And the other way round.
        expect(coverOf(21 / 9, 16 / 9)).toEqual({ x: 1, y: (16 / 9) / (21 / 9) });
        expect(coverOf(16 / 9, 16 / 9)).toEqual({ x: 1, y: 1 });
    });

    it("assumes it fills while the shapes are still unknown", () => {
        // Which is what the first frame is drawn under, before anything has
        // reported its size.
        expect(coverOf(null, 16 / 9)).toBe(FILLS);
        expect(coverOf(1.5, null)).toBe(FILLS);
        expect(coverOf(0, 1)).toBe(FILLS);
    });

    it("refuses to pan a narrow picture that has not been zoomed far enough", () => {
        // This is the bug. Measured against the frame there is room at any zoom
        // above 1, so the picture could be dragged until the black bar beside it
        // was in the middle of the screen - which reads as a camera that came
        // loose rather than as a control that let go.
        const narrow = { x: 0.75, y: 1 };
        expect(clampOffset({ scale: 1.2, x: 0.5, y: 0 }, narrow).x).toBe(0);
        expect(panBy({ scale: 1.2, x: 0, y: 0 }, 0.3, 0, narrow).x).toBe(0);
    });

    it("gives it exactly the room it has once it does reach across", () => {
        const narrow = { x: 0.75, y: 1 };
        // At twice the size a picture covering three quarters reaches one and a
        // half frames across, so a quarter of a frame each way.
        expect(clampOffset({ scale: 2, x: 5, y: 5 }, narrow)).toEqual({
            scale: 2,
            x: 0.25,
            y: 0.5
        });
    });

    it("still uses the whole frame for a picture that fills it", () => {
        expect(clampOffset({ scale: 2, x: 5, y: 5 }, FILLS)).toEqual({ scale: 2, x: 0.5, y: 0.5 });
    });
});
