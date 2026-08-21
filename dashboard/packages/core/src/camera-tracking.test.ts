/**
 * A walk-past, played frame by frame.
 *
 * The whole reason this module exists is that a detector answers "person" once
 * per frame and a house wants one line per visit. That is a claim about a
 * sequence, and a sequence is the one thing a camera cannot be used to check:
 * pointing one at a drive and watching the list tells you the count was wrong,
 * never which of the four rules got it wrong.
 *
 * So the sequences are here. Somebody walks in, crosses the picture and leaves;
 * somebody is missed for a frame; two people pass each other; a detector fires
 * once at nothing.
 */

import { describe, expect, it } from "vitest";
import * as tracking from "./camera-tracking.js";
import type { RelativeBox, Zone } from "./camera-zones.js";

/** A person-shaped box a fifth of the way up the picture, at x. */
function personAt(x: number, width = 0.08): RelativeBox {
    return { x1: x, y1: 0.4, x2: x + width, y2: 0.8 };
}

function walk(state: tracking.TrackingState, boxes: RelativeBox[], frame: number, score = 0.8) {
    return tracking.trackFrame(
        state,
        boxes.map((box) => ({ label: "person", score, box })),
        { now: 1000 + frame * 200, minHits: 3, maxMissing: 2 }
    );
}

describe("one visit is one event", () => {
    it("says nothing until it has been seen enough times", () => {
        let state = tracking.NO_TRACKING;
        let update = walk(state, [personAt(0.2)], 0);
        expect(update.appeared).toEqual([]);
        state = update.state;
        update = walk(state, [personAt(0.25)], 1);
        expect(update.appeared).toEqual([]);
        state = update.state;
        update = walk(state, [personAt(0.3)], 2);
        expect(update.appeared).toHaveLength(1);
    });

    it("announces it once however long it stays", () => {
        let state = tracking.NO_TRACKING;
        let announced = 0;
        for (let frame = 0; frame < 12; frame += 1) {
            const update = walk(state, [personAt(0.2 + frame * 0.03)], frame);
            announced += update.appeared.length;
            state = tracking.markReported(
                update.state,
                update.appeared.map((object) => object.id)
            );
        }
        expect(announced).toBe(1);
        expect(state.objects).toHaveLength(1);
    });

    it("does not lose somebody who was missed for a frame", () => {
        let state = tracking.NO_TRACKING;
        for (let frame = 0; frame < 4; frame += 1) state = walk(state, [personAt(0.2 + frame * 0.02)], frame).state;
        const id = state.objects[0]!.id;
        // Two frames where the detector saw nothing.
        state = walk(state, [], 4).state;
        state = walk(state, [], 5).state;
        state = walk(state, [personAt(0.3)], 6).state;
        expect(state.objects).toHaveLength(1);
        expect(state.objects[0]!.id).toBe(id);
    });

    it("closes the event once they have gone", () => {
        let state = tracking.NO_TRACKING;
        for (let frame = 0; frame < 4; frame += 1) {
            const update = walk(state, [personAt(0.2 + frame * 0.02)], frame);
            state = tracking.markReported(
                update.state,
                update.appeared.map((object) => object.id)
            );
        }
        state = walk(state, [], 4).state;
        state = walk(state, [], 5).state;
        const update = walk(state, [], 6);
        expect(update.ended).toHaveLength(1);
        expect(update.state.objects).toEqual([]);
    });

    it("says nothing at all about a detector that fired once at nothing", () => {
        let state = tracking.NO_TRACKING;
        const first = walk(state, [personAt(0.5)], 0);
        state = first.state;
        for (let frame = 1; frame < 5; frame += 1) {
            const update = walk(state, [], frame);
            expect(update.appeared).toEqual([]);
            expect(update.ended).toEqual([]);
            state = update.state;
        }
        expect(state.objects).toEqual([]);
    });
});

describe("telling two people apart", () => {
    it("keeps their identities as they cross", () => {
        let state = tracking.NO_TRACKING;
        for (let frame = 0; frame < 3; frame += 1) {
            state = walk(state, [personAt(0.1 + frame * 0.05), personAt(0.8 - frame * 0.05)], frame).state;
        }
        expect(state.objects).toHaveLength(2);
        const ids = state.objects.map((object) => object.id);
        state = walk(state, [personAt(0.25), personAt(0.65)], 3).state;
        expect(state.objects.map((object) => object.id).sort()).toEqual(ids.sort());
    });

    it("does not turn a person into the car they walked in front of", () => {
        const box = personAt(0.4);
        const state = tracking.trackFrame(
            tracking.NO_TRACKING,
            [{ label: "vehicle", score: 0.9, box }],
            { now: 0 }
        ).state;
        // A person is detected in exactly the same place the next frame. Same
        // box, different class: two things, not one that changed species.
        const update = tracking.trackFrame(state, [{ label: "person", score: 0.9, box }], { now: 200 });
        expect(update.state.objects).toHaveLength(2);
    });
});

describe("which frame is kept as the picture", () => {
    it("prefers the one where they are fully in shot", () => {
        const edge = { score: 0.95, box: { x1: 0, y1: 0.4, x2: 0.1, y2: 0.9 } };
        const middle = { score: 0.7, box: personAt(0.4) };
        expect(tracking.isBetterSnapshot({ ...edge, frame: 1 }, middle)).toBe(true);
        expect(tracking.isBetterSnapshot({ ...middle, frame: 1 }, edge)).toBe(false);
    });

    it("prefers a clearly better score, and ignores noise", () => {
        const held = { score: 0.7, box: personAt(0.4), frame: 1 };
        expect(tracking.isBetterSnapshot(held, { score: 0.8, box: personAt(0.4) })).toBe(true);
        expect(tracking.isBetterSnapshot(held, { score: 0.72, box: personAt(0.4) })).toBe(false);
    });

    it("prefers a clearly bigger box, because bigger is closer", () => {
        const held = { score: 0.8, box: personAt(0.4, 0.08), frame: 1 };
        expect(tracking.isBetterSnapshot(held, { score: 0.8, box: personAt(0.4, 0.12) })).toBe(true);
    });

    it("holds the best frame of a whole walk-past, not the first or the last", () => {
        let state = tracking.NO_TRACKING;
        // They come closer as they walk, so the box grows and the detector gets
        // surer; the third frame is the one worth keeping, and the fourth -
        // identical to it - must not replace it.
        state = walk(state, [personAt(0.3, 0.06)], 0, 0.6).state;
        state = walk(state, [personAt(0.3, 0.09)], 1, 0.7).state;
        state = walk(state, [personAt(0.29, 0.14)], 2, 0.9).state;
        state = walk(state, [personAt(0.29, 0.14)], 3, 0.9).state;
        expect(state.objects).toHaveLength(1);
        expect(state.objects[0]!.best?.frame).toBe(3);
        expect(state.objects[0]!.best?.score).toBeCloseTo(0.9);
    });
});

describe("what it decides it saw", () => {
    it("takes the middle of the scores rather than the best of them", () => {
        let state = tracking.NO_TRACKING;
        state = walk(state, [personAt(0.2)], 0, 0.9).state;
        state = walk(state, [personAt(0.22)], 1, 0.3).state;
        state = walk(state, [personAt(0.24)], 2, 0.3).state;
        expect(tracking.confidenceOf(state.objects[0]!)).toBeCloseTo(0.3);
    });
});

describe("zones follow the thing, not the frame", () => {
    const drive: Zone = {
        id: "z1",
        name: "Drive",
        kind: "watch",
        points: [
            { x: 0, y: 0.5 },
            { x: 0.5, y: 0.5 },
            { x: 0.5, y: 1 },
            { x: 0, y: 1 }
        ],
        objects: [],
        inertia: 2,
        loiterSeconds: 0,
        enabled: true
    };

    it("records everywhere one person went during their visit", () => {
        let state = tracking.NO_TRACKING;
        const step = (box: RelativeBox, frame: number) => {
            state = tracking.trackFrame(state, [{ label: "person", score: 0.9, box }], {
                now: frame * 200,
                zones: [drive],
                fps: 5,
                minHits: 2
            }).state;
        };
        // They walk out of the drive and onto the path, a step at a time. The
        // ground point leaves the outline at x + 0.04 > 0.5.
        let frame = 0;
        for (let x = 0.1; x <= 0.34; x += 0.04) step(personAt(x), frame++);
        expect(state.objects).toHaveLength(1);
        expect(state.objects[0]!.zones.current).toEqual(["Drive"]);
        for (let x = 0.38; x <= 0.62; x += 0.04) step(personAt(x), frame++);
        expect(state.objects).toHaveLength(1);
        // Out of it now, but the visit still records that they were in it.
        expect(state.objects[0]!.zones.current).toEqual([]);
        expect(state.objects[0]!.zones.entered).toEqual(["Drive"]);
    });
});
