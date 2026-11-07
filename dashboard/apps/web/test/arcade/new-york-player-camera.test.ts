/**
 * New York on foot: the over-the-shoulder spring arm against walls, movement
 * relative to the camera, the body's turn-rate cap, jump coyote time and
 * buffering, the stick's look curve, and first and third person sharing one
 * view direction.
 */

import { describe, expect, it } from "vitest";

import * as rules from "../../../arcade/game/new-york/engine/player-rules.js";

const { PERSON_CAMERA, PERSON_MOVE } = rules;

// A 20 m tall block whose near face is the plane z = wallZ, running 40 m either side of x = 0
const wallAt = (wallZ: number) => ({ minX: -40, maxX: 40, minZ: wallZ - 30, maxZ: wallZ, minY: 0, maxY: 20 });

describe("spring arm", () => {
    const look = { yaw: 0, pitch: 0 }; // looking along +z, so the arm reaches back towards -z
    const feet = { x: 0, y: 0, z: 0 };

    it("keeps its full length with nothing behind", () => {
        const pose = rules.personCameraPose(feet, look, "third");
        const { side, arm } = rules.springArm([], pose);
        expect(side).toBeCloseTo(PERSON_CAMERA.shoulder);
        expect(arm).toBeCloseTo(PERSON_CAMERA.distance);
    });

    it("stops short of a wall behind, by the probe radius", () => {
        const pose = rules.personCameraPose(feet, look, "third");
        const { arm } = rules.springArm([wallAt(-2)], pose);
        expect(arm).toBeCloseTo(2 - PERSON_CAMERA.probe, 5);
    });

    it("never gets shorter than its minimum with the wall right behind", () => {
        const pose = rules.personCameraPose(feet, look, "third");
        expect(rules.springArm([wallAt(-0.3)], pose).arm).toBeCloseTo(PERSON_CAMERA.minArm);
    });

    it("pulls the shoulder offset in against a wall on the right", () => {
        // the camera's right at yaw 0 is -x; a wall face at x = -0.4
        const wall = { minX: -30, maxX: -0.4, minZ: -40, maxZ: 40, minY: 0, maxY: 20 };
        const pose = rules.personCameraPose(feet, look, "third");
        const { side } = rules.springArm([wall], pose);
        expect(side).toBeCloseTo(0.4 - PERSON_CAMERA.probe, 5);
    });

    it("ignores a building the ray passes over", () => {
        const low = { ...wallAt(-2), maxY: 1 };
        const pose = rules.personCameraPose(feet, look, "third");
        expect(rules.springArm([low], pose).arm).toBeCloseTo(PERSON_CAMERA.distance);
    });

    it("finds an oriented box and a polygon footprint", () => {
        const obb = { minX: -10, maxX: 10, minZ: -6, maxZ: -2, minY: 0, maxY: 9, obb: { cx: 0, cz: -4, hx: 10, hz: 2, cs: 1, sn: 0 } };
        const polygon = {
            minX: -10, maxX: 10, minZ: -6, maxZ: -2, minY: 0, maxY: 9,
            polygon: { outer: [{ x: -10, z: -6 }, { x: 10, z: -6 }, { x: 10, z: -2 }, { x: -10, z: -2 }], holes: [] }
        };
        const from = { x: 0, y: 1, z: 0 }, to = { x: 0, y: 1, z: -5 };
        expect(rules.clearLength([obb], from, to)).toBeCloseTo(2 - PERSON_CAMERA.probe, 5);
        expect(rules.clearLength([polygon], from, to)).toBeCloseTo(2 - PERSON_CAMERA.probe, 5);
    });

    it("comes in at once and goes back out gently", () => {
        expect(rules.stepArm(3.3, 1.2, 1 / 60)).toBe(1.2);
        const out = rules.stepArm(1.2, 3.3, 1 / 60);
        expect(out).toBeGreaterThan(1.2);
        expect(out).toBeLessThan(1.4);
    });
});

describe("movement relative to the camera", () => {
    it("forward goes where the camera looks, whatever way the body faces", () => {
        const yaw = 0.7;
        const move = rules.cameraRelativeMove(1, 0, yaw);
        expect(move.x).toBeCloseTo(Math.sin(yaw));
        expect(move.z).toBeCloseTo(Math.cos(yaw));
        expect(move.amount).toBe(1);
    });

    it("right goes to the camera's right", () => {
        // at yaw 0 the camera looks along +z and its right is -x
        const move = rules.cameraRelativeMove(0, 1, 0);
        expect(move.x).toBeCloseTo(-1);
        expect(move.z).toBeCloseTo(0);
        // backwards turns the body round towards the camera
        const back = rules.cameraRelativeMove(-1, 0, Math.PI / 2);
        expect(back.x).toBeCloseTo(-1);
    });

    it("a diagonal is not faster and a half tilt walks", () => {
        expect(rules.cameraRelativeMove(1, 1, 0).amount).toBe(1);
        expect(rules.cameraRelativeMove(0.4, 0, 0).amount).toBeCloseTo(0.4);
        expect(rules.cameraRelativeMove(0, 0, 0)).toEqual({ x: 0, z: 0, amount: 0 });
    });

    it("accelerates and brakes at a bounded rate", () => {
        let v = { vx: 0, vz: 0 };
        v = rules.approachVelocity(v.vx, v.vz, 0, PERSON_MOVE.run, PERSON_MOVE.accel, 0.1);
        expect(v.vz).toBeCloseTo(PERSON_MOVE.accel * 0.1);
        v = rules.approachVelocity(0, PERSON_MOVE.run, 0, 0, PERSON_MOVE.decel, 1);
        expect(v.vz).toBe(0);
    });
});

describe("body turn rate", () => {
    it("never turns faster than the cap", () => {
        const dt = 1 / 60;
        const next = rules.turnToward(0, Math.PI * 0.9, dt);
        expect(next).toBeCloseTo(PERSON_MOVE.turnRate * dt, 6);
    });

    it("turns the short way round across the wrap", () => {
        const next = rules.turnToward(3.0, -3.0, 1 / 60);
        expect(next).toBeGreaterThan(3.0);
    });

    it("eases into small turns instead of snapping", () => {
        const next = rules.turnToward(0, 0.05, 1 / 60);
        expect(next).toBeGreaterThan(0);
        expect(next).toBeLessThan(0.05);
    });
});

describe("jump timing", () => {
    const dt = 1 / 60;

    it("jumps on the press while standing, once per press", () => {
        const state = rules.createJumpState();
        expect(rules.stepJump(state, true, true, dt)).toBe(true);
        expect(rules.stepJump(state, true, true, dt)).toBe(false);
    });

    it("still jumps just after walking off a curb (coyote time)", () => {
        const state = rules.createJumpState();
        rules.stepJump(state, true, false, dt);
        let t = 0;
        while (t < PERSON_MOVE.coyote - 2 * dt) {
            rules.stepJump(state, false, false, dt);
            t += dt;
        }
        expect(rules.stepJump(state, false, true, dt)).toBe(true);
    });

    it("does not jump in mid-air once coyote time is over", () => {
        const state = rules.createJumpState();
        rules.stepJump(state, true, false, dt);
        for (let t = 0; t < PERSON_MOVE.coyote + 2 * dt; t += dt) rules.stepJump(state, false, false, dt);
        expect(rules.stepJump(state, false, true, dt)).toBe(false);
    });

    it("keeps a press made just before landing for the landing (buffer)", () => {
        const state = rules.createJumpState();
        rules.stepJump(state, false, false, dt);
        state.coyote = 0;
        expect(rules.stepJump(state, false, true, dt)).toBe(false);
        for (let t = 0; t < PERSON_MOVE.buffer - 3 * dt; t += dt) rules.stepJump(state, false, true, dt);
        expect(rules.stepJump(state, true, true, dt)).toBe(true);
    });

    it("forgets a press made too long before landing", () => {
        const state = rules.createJumpState();
        state.coyote = 0;
        rules.stepJump(state, false, true, dt);
        for (let t = 0; t < PERSON_MOVE.buffer + 2 * dt; t += dt) rules.stepJump(state, false, true, dt);
        expect(rules.stepJump(state, true, true, dt)).toBe(false);
    });
});

describe("look", () => {
    it("holds pitch inside each view's limits", () => {
        const look = { yaw: 0, pitch: 0 };
        rules.turnLook(look, 0, 5, "third");
        expect(look.pitch).toBe(PERSON_CAMERA.thirdPitch[1]);
        rules.turnLook(look, 0, 5, "first");
        expect(look.pitch).toBe(PERSON_CAMERA.firstPitch[1]);
        rules.turnLook(look, 0, -10, "third");
        expect(look.pitch).toBe(PERSON_CAMERA.thirdPitch[0]);
    });

    it("shapes the stick: small tilts aim finely, a full tilt is full speed, direction kept", () => {
        const half = rules.lookCurve(0.5, 0);
        expect(half.x).toBeCloseTo(0.25);
        const full = rules.lookCurve(0.6, 0.8);
        expect(Math.hypot(full.x, full.y)).toBeCloseTo(1);
        expect(full.y / full.x).toBeCloseTo(0.8 / 0.6);
        expect(rules.lookCurve(0, 0)).toEqual({ x: 0, y: 0 });
    });

    it("reads a stored sensitivity back within range", () => {
        expect(rules.clampSensitivity("1.5")).toBe(1.5);
        expect(rules.clampSensitivity("9")).toBe(rules.LOOK_SENSITIVITY.max);
        expect(rules.clampSensitivity(null)).toBe(1);
        expect(rules.clampSensitivity("nope")).toBe(1);
    });
});

describe("first and third person share the view", () => {
    it("switching keeps the yaw and the direction the camera looks", () => {
        const look = { yaw: 2.2, pitch: -0.2 };
        const feet = { x: 5, y: 0.15, z: -8 };
        const third = rules.personCameraPose(feet, look, "third");
        const first = rules.personCameraPose(feet, look, "first");
        expect(first.dir).toEqual(third.dir);
        expect(Math.atan2(third.dir.x, third.dir.z)).toBeCloseTo(look.yaw);
        // first person sits in the head, third behind and to the right of it
        expect(first.eye.y - feet.y).toBeCloseTo(PERSON_CAMERA.eyeHeight);
        const back = (third.eye.x - feet.x) * third.dir.x + (third.eye.z - feet.z) * third.dir.z;
        expect(back).toBeLessThan(-2.5);
    });

    it("clamps the pitch into first person's wider range without changing the yaw", () => {
        const look = { yaw: -1.1, pitch: PERSON_CAMERA.thirdPitch[0] };
        rules.turnLook(look, 0, 0, "first");
        expect(look.yaw).toBeCloseTo(-1.1);
        expect(look.pitch).toBe(PERSON_CAMERA.thirdPitch[0]);
    });
});
