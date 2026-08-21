/**
 * A windy afternoon, played through the motion detector.
 *
 * Everything this module is for is a claim about a sequence of frames, and none
 * of it can be checked by pointing a camera at a garden: "the tree stopped
 * setting it off after a minute" is a thing you find out by waiting a minute,
 * once, and never again. So the sequences are synthetic here - a scene, a person
 * walking into it, a light going on - and each rule is exercised against frames
 * whose right answer is known before the code runs.
 */

import * as motion from "./camera-motion.js";
import { describe, expect, it } from "vitest";
import type { Zone } from "./camera-zones.js";

const WIDTH = 40;
const HEIGHT = 30;

/** A flat grey scene. */
function scene(value = 100): Uint8Array {
    return new Uint8Array(WIDTH * HEIGHT).fill(value);
}

/** Paint a rectangle onto a frame, in pixels. */
function paint(frame: Uint8Array, x1: number, y1: number, x2: number, y2: number, value: number): Uint8Array {
    const painted = new Uint8Array(frame);
    for (let y = y1; y < y2; y += 1) {
        for (let x = x1; x < x2; x += 1) painted[y * WIDTH + x] = value;
    }
    return painted;
}

const OPTIONS = { width: WIDTH, height: HEIGHT, improveContrast: false, minArea: 4 };

/**
 * Run the detector until the scene really is the average.
 *
 * Deliberately hundreds of frames rather than a handful. Calibration ends as
 * soon as nothing is changing, which is well before the average has caught up
 * with the picture - it is still tens of shades short, and a test that starts
 * there is measuring the gap rather than the rule it meant to.
 */
function settled(frames = 600, background = scene()): motion.MotionState {
    let state = motion.newMotionState(WIDTH, HEIGHT);
    for (let index = 0; index < frames; index += 1) {
        state = motion.detectMotion(state, background, OPTIONS).state;
    }
    return state;
}

describe("learning what a still scene looks like", () => {
    it("reports nothing at all while it is still learning", () => {
        let state = motion.newMotionState(WIDTH, HEIGHT);
        const first = motion.detectMotion(state, scene(), OPTIONS);
        expect(first.boxes).toEqual([]);
        state = first.state;
        // Even something walking in during the first frames is not reported:
        // there is nothing yet to compare it against.
        const walking = motion.detectMotion(state, paint(scene(), 10, 10, 20, 20, 220), OPTIONS);
        expect(walking.boxes).toEqual([]);
    });

    it("settles on a still scene and stays quiet", () => {
        const state = settled();
        expect(state.calibrating).toBe(false);
        const quiet = motion.detectMotion(state, scene(), OPTIONS);
        expect(quiet.boxes).toEqual([]);
        expect(quiet.fraction).toBe(0);
    });
});

describe("somebody walks into the picture", () => {
    it("says where they are, not just that something happened", () => {
        const state = settled();
        const result = motion.detectMotion(state, paint(scene(), 10, 8, 18, 22, 220), OPTIONS);
        expect(result.boxes).toHaveLength(1);
        const box = result.boxes[0]!;
        // The box covers the painted patch, grown by the one-pixel close.
        expect(box.x1).toBeLessThanOrEqual(10 / WIDTH);
        expect(box.x2).toBeGreaterThanOrEqual(18 / WIDTH);
        expect(box.y1).toBeLessThanOrEqual(8 / HEIGHT);
        expect(box.y2).toBeGreaterThanOrEqual(22 / HEIGHT);
    });

    it("gives two separate things two boxes", () => {
        const state = settled();
        let frame = paint(scene(), 4, 4, 10, 12, 220);
        frame = paint(frame, 28, 16, 36, 26, 220);
        expect(motion.detectMotion(state, frame, OPTIONS).boxes).toHaveLength(2);
    });

    it("ignores a speck too small to be anything", () => {
        const state = settled();
        const speck = paint(scene(), 20, 15, 21, 16, 240);
        expect(motion.detectMotion(state, speck, OPTIONS).boxes).toEqual([]);
    });

    it("does not absorb somebody who stands still into the background", () => {
        let state = settled();
        const standing = paint(scene(), 12, 8, 22, 24, 220);
        for (let frame = 0; frame < 9; frame += 1) {
            const result = motion.detectMotion(state, standing, OPTIONS);
            expect(result.boxes).toHaveLength(1);
            state = result.state;
        }
    });
});

describe("the thing that moves every afternoon", () => {
    it("takes a scene that changed and makes it the new normal", () => {
        let state = settled();
        // A car parks in the drive and stays there.
        const parked = paint(scene(), 5, 18, 25, 28, 60);
        for (let frame = 0; frame < 400; frame += 1) {
            state = motion.detectMotion(state, parked, OPTIONS).state;
        }
        // It is part of the street now, and the empty drive is what changed.
        expect(motion.detectMotion(state, parked, OPTIONS).boxes).toEqual([]);
        expect(motion.detectMotion(state, scene(), OPTIONS).boxes).toHaveLength(1);
    });
});

describe("the whole picture changing", () => {
    it("reports nothing when the lights come on, and relearns the room", () => {
        const state = settled();
        const lit = motion.detectMotion(state, scene(230), OPTIONS);
        expect(lit.boxes).toEqual([]);
        expect(lit.state.calibrating).toBe(true);
        expect(lit.fraction).toBeGreaterThan(0.8);
    });
});

describe("the parts of the picture nobody asked about", () => {
    const road: Zone = {
        id: "z1",
        name: "Road",
        kind: "ignore",
        points: [
            { x: 0, y: 0.6 },
            { x: 1, y: 0.6 },
            { x: 1, y: 1 },
            { x: 0, y: 1 }
        ],
        objects: [],
        inertia: 1,
        loiterSeconds: 0,
        enabled: true
    };

    it("covers the pixels the area was drawn over", () => {
        const mask = motion.buildMotionMask([road], WIDTH, HEIGHT);
        expect(mask).not.toBeNull();
        // A row well inside the area, and one well outside it.
        expect(mask![25 * WIDTH + 20]).toBe(1);
        expect(mask![5 * WIDTH + 20]).toBe(0);
    });

    it("has no mask at all when nothing was drawn", () => {
        expect(motion.buildMotionMask([], WIDTH, HEIGHT)).toBeNull();
        expect(motion.buildMotionMask([{ ...road, kind: "watch" }], WIDTH, HEIGHT)).toBeNull();
        expect(motion.buildMotionMask([{ ...road, enabled: false }], WIDTH, HEIGHT)).toBeNull();
    });

    it("stops a car on the road from being movement, and still sees the garden", () => {
        const mask = motion.buildMotionMask([road], WIDTH, HEIGHT);
        const masked = { ...OPTIONS, mask };
        let state = motion.newMotionState(WIDTH, HEIGHT);
        for (let frame = 0; frame < 40; frame += 1) state = motion.detectMotion(state, scene(), masked).state;

        const car = paint(scene(), 4, 24, 30, 29, 240);
        expect(motion.detectMotion(state, car, masked).boxes).toEqual([]);

        const person = paint(scene(), 10, 4, 20, 14, 240);
        expect(motion.detectMotion(state, person, masked).boxes).toHaveLength(1);
    });
});

describe("a dark garden", () => {
    /** Night: the whole picture sits in a narrow dark band. */
    const night = (() => {
        const frame = new Uint8Array(WIDTH * HEIGHT);
        for (let y = 0; y < HEIGHT; y += 1) {
            for (let x = 0; x < WIDTH; x += 1) frame[y * WIDTH + x] = 30 + Math.floor((x / WIDTH) * 40);
        }
        return frame;
    })();

    /** Somebody in it, five shades lighter than what they are standing in
     *  front of - which is what a person in the dark actually is. */
    const person = (() => {
        const frame = new Uint8Array(night);
        for (let y = 8; y < 22; y += 1) {
            for (let x = 12; x < 22; x += 1) frame[y * WIDTH + x] = night[y * WIDTH + x]! + 5;
        }
        return frame;
    })();

    it("finds somebody the raw threshold cannot see at all", () => {
        const stretching = { width: WIDTH, height: HEIGHT, improveContrast: true, minArea: 4 };
        let state = motion.newMotionState(WIDTH, HEIGHT);
        for (let frame = 0; frame < 600; frame += 1) state = motion.detectMotion(state, night, stretching).state;
        expect(state.calibrating).toBe(false);
        expect(motion.detectMotion(state, person, stretching).boxes).toHaveLength(1);
    });

    it("misses them entirely without the stretch, which is why it is on", () => {
        const raw = settled(600, night);
        expect(motion.detectMotion(raw, person, OPTIONS).boxes).toEqual([]);
    });
});
