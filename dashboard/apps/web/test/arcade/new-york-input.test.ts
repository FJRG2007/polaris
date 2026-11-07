// @vitest-environment jsdom

/**
 * New York's input rules: the browser's own menu and gestures stay off the game
 * but not out of its text fields, the helicopter climbs and descends from a
 * gamepad (triggers or A/B) with turbo on the left stick's click, turbo ramps,
 * and a mode switch starts the new body where the player is.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import * as rules from "../../../arcade/game/new-york/engine/player-rules.js";
import * as guards from "../../../arcade/game/new-york/engine/browser-defaults.js";
import * as gamepad from "../../../arcade/game/new-york/engine/gamepad-controls.js";
import * as placement from "../../../arcade/game/new-york/engine/arrival-placement.js";
import * as embed from "../../../arcade/game/new-york/engine/embed.js";
import * as quality from "../../../arcade/game/new-york/engine/quality.js";

// The gamepad module reads only the field check from the city config, which otherwise needs the city data
vi.mock("../../../arcade/game/new-york/engine/city-config.js", () => ({
    isTypingInField: () => false
}));

afterEach(() => document.body.replaceChildren());

type Button = { pressed: boolean; value: number };

function pad(values: Record<number, number>) {
    const buttons: Button[] = Array.from({ length: 17 }, (_, i) => ({
        pressed: (values[i] ?? 0) > 0.5,
        value: values[i] ?? 0
    }));
    return { buttons, axes: [0, 0, 0, 0] };
}

const heldFrom = (p: ReturnType<typeof pad>) => (i: number) => p.buttons[i].pressed;

describe("browser defaults over the game", () => {
    guards.installBrowserGuards(document);

    function fire(target: Element, type: string, init: MouseEventInit = {}) {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(event);
        return event.defaultPrevented;
    }

    it("blocks the context menu, drag, selection and middle-click autoscroll on the game", () => {
        const canvas = document.createElement("canvas");
        document.body.append(canvas);
        expect(fire(canvas, "contextmenu")).toBe(true);
        expect(fire(canvas, "dragstart")).toBe(true);
        expect(fire(canvas, "selectstart")).toBe(true);
        expect(fire(canvas, "mousedown", { button: 1 })).toBe(true);
        expect(fire(canvas, "auxclick", { button: 1 })).toBe(true);
    });

    it("leaves the left button alone so the camera drag and buttons still work", () => {
        const canvas = document.createElement("canvas");
        document.body.append(canvas);
        expect(fire(canvas, "mousedown", { button: 0 })).toBe(false);
    });

    it("keeps the menu and selection in a text field such as the map search", () => {
        const input = document.createElement("input");
        document.body.append(input);
        expect(fire(input, "contextmenu")).toBe(false);
        expect(fire(input, "selectstart")).toBe(false);
        expect(guards.keepsBrowserDefault(input)).toBe(true);
        expect(guards.keepsBrowserDefault(null)).toBe(false);
    });
});

describe("helicopter on a gamepad", () => {
    it("climbs on RT and descends on LT by how far they are pulled", () => {
        const up = pad({ 7: 0.8 });
        expect(gamepad.helicopterPadInput(up, heldFrom(up)).vertical).toBeCloseTo(0.8);
        const down = pad({ 6: 0.6 });
        expect(gamepad.helicopterPadInput(down, heldFrom(down)).vertical).toBeCloseTo(-0.6);
    });

    it("descends on B and climbs on A at full rate", () => {
        const b = pad({ 1: 1 });
        expect(gamepad.helicopterPadInput(b, heldFrom(b)).vertical).toBe(-1);
        const a = pad({ 0: 1 });
        expect(gamepad.helicopterPadInput(a, heldFrom(a)).vertical).toBe(1);
    });

    it("holds turbo on the left stick's click, and not otherwise", () => {
        const l3 = pad({ 10: 1 });
        expect(gamepad.helicopterPadInput(l3, heldFrom(l3)).turbo).toBe(1);
        const idle = pad({});
        expect(gamepad.helicopterPadInput(idle, heldFrom(idle))).toEqual({ vertical: 0, turbo: 0 });
    });

    it("ignores a button left over from before a reset", () => {
        const b = pad({ 1: 1 });
        expect(gamepad.helicopterPadInput(b, () => false).vertical).toBe(0);
    });
});

describe("helicopter turbo", () => {
    it("ramps in and out instead of jumping, and is bounded", () => {
        let turbo = 0;
        turbo = rules.stepTurbo(turbo, true, 0.25);
        expect(turbo).toBeCloseTo(0.3);
        for (let i = 0; i < 20; i++) turbo = rules.stepTurbo(turbo, true, 0.25);
        expect(turbo).toBe(1);
        turbo = rules.stepTurbo(turbo, false, 0.25);
        expect(turbo).toBeCloseTo(0.7);
        expect(rules.stepTurbo(undefined, true, Number.NaN)).toBe(0);
    });

    it("tops out at the turbo multiple of cruise", () => {
        expect(rules.heliTopSpeed(0)).toBe(rules.HELI_CRUISE_SPEED);
        expect(rules.heliTopSpeed(1)).toBeCloseTo(rules.HELI_CRUISE_SPEED * rules.HELI_TURBO);
        expect(rules.heliTopSpeed(5)).toBeCloseTo(rules.HELI_CRUISE_SPEED * rules.HELI_TURBO);
    });
});

describe("switching mode", () => {
    it("starts the new body under the old one, on the ground, facing the same way", () => {
        expect(rules.arrivalFor({ x: 10, y: 120, z: -40, heading: 1.2 }, "car")).toEqual({
            x: 10,
            z: -40,
            heading: 1.2,
            altitude: null
        });
    });

    it("puts a helicopter taken from the street on the street", () => {
        expect(rules.arrivalFor({ x: 3, y: 0, z: 4, heading: 0 }, "helicopter")?.altitude).toBe(
            0.25
        );
    });

    it("has nothing to offer without a finite place", () => {
        expect(rules.arrivalFor(null, "car")).toBeNull();
        expect(rules.arrivalFor({ x: Number.NaN, z: 0 }, "car")).toBeNull();
        expect(rules.arrivalFor({ x: 1, z: 2 }, "person")?.heading).toBe(Math.PI);
    });
});

describe("arrival placement", () => {
    // A northbound avenue (north = -z) along x = 0, lanes 2 m and 5 m right of its centre line, 200 m long
    const avenue = { sx: 0, sz: 100, dx: 0, dz: -1, rx: 1, rz: 0, len: 200, lanes: [2, 5] };
    // A building block east of the avenue, x 10..60, z -40..40
    const block = { minX: 10, maxX: 60, minZ: -40, maxZ: 40 };
    const inBlock = (p: { x: number; z: number }, r = 1) =>
        placement.overlapsFootprints([block], p.x, p.z, r);

    it("puts a car switched to above a road on the nearest lane, facing along it", () => {
        const at = placement.placeArrival({
            x: 3,
            z: 0,
            heading: 0.4,
            onRoad: true,
            edges: [avenue],
            clear: (p) => !inBlock(p)
        });
        expect(at).toEqual({ x: 2, z: 0, heading: placement.headingOf(0, -1) });
    });

    it("moves a body dropped onto a roof to the street beside it", () => {
        const onFoot = placement.placeArrival({
            x: 30,
            z: 0,
            heading: 1,
            clear: (p) => !inBlock(p)
        });
        expect(onFoot).not.toBeNull();
        expect(inBlock(onFoot!)).toBe(false);
        expect(Math.hypot(onFoot!.x - 30, onFoot!.z)).toBeLessThanOrEqual(24);
        const car = placement.placeArrival({
            x: 30,
            z: 0,
            onRoad: true,
            edges: [avenue],
            clear: (p) => !inBlock(p)
        });
        expect(car).toMatchObject({ x: 5, z: 0 });
    });

    it("stays on open ground in a park with no lane in reach", () => {
        const at = placement.placeArrival({
            x: 400,
            z: 0,
            heading: 2,
            onRoad: true,
            edges: [avenue],
            clear: () => true
        });
        expect(at).toEqual({ x: 400, z: 0, heading: 2 });
    });

    it("finds the gap between parked or queued cars", () => {
        const cars = [-6, -3, 0, 3, 6].flatMap((z) => [
            { x: 2, z, radius: 2.6 },
            { x: 5, z, radius: 2.6 }
        ]);
        const at = placement.placeArrival({
            x: 2,
            z: 0,
            onRoad: true,
            edges: [avenue],
            clear: (p) => !placement.overlapsBodies(cars, p.x, p.z, 1)
        });
        expect(at).not.toBeNull();
        expect(placement.overlapsBodies(cars, at!.x, at!.z, 1)).toBe(false);
        expect([2, 5]).toContain(at!.x);
        expect(Math.abs(at!.z)).toBeLessThan(15);
    });

    it("widens past the old 256 m search, and gives up with nothing clear", () => {
        const far = placement.placeArrival({
            x: 0,
            z: 0,
            clear: (p) => Math.hypot(p.x, p.z) > 300
        });
        expect(far && Math.hypot(far.x, far.z)).toBeGreaterThan(300);
        expect(placement.placeArrival({ x: 0, z: 0, clear: () => false })).toBeNull();
        expect(placement.placeArrival({ x: Number.NaN, z: 0, clear: () => true })).toBeNull();
    });

    it("lists lane points nearest first and skips edges out of reach", () => {
        const points = placement.laneCandidates([avenue], 3, 0);
        expect(points[0]).toMatchObject({ x: 2, z: 0 });
        expect(points.every((p, i) => i === 0 || p.distance >= points[i - 1].distance)).toBe(true);
        expect(placement.laneCandidates([avenue], 500, 0)).toEqual([]);
    });
});

describe("brake lamps", () => {
    it("burn full while slowing down, dimmer held at a standstill, and not at all cruising", () => {
        expect(rules.brakeLamp(-3, 8)).toBe(rules.BRAKE_LAMP.slowing);
        expect(rules.brakeLamp(0, 0)).toBe(rules.BRAKE_LAMP.holding);
        expect(rules.brakeLamp(0.5, 10)).toBe(0);
        expect(rules.BRAKE_LAMP.slowing).toBeGreaterThan(rules.BRAKE_LAMP.holding);
    });
});

describe("player turn signals", () => {
    const run = (
        signal: ReturnType<typeof rules.createTurnSignal>,
        steer: number,
        speed: number,
        seconds: number
    ) => {
        for (let t = 0; t < seconds; t += 0.05) rules.stepTurnSignal(signal, steer, speed, 0.05);
        return signal;
    };

    it("start on the side held past the threshold at town speed, and blink on the 0.8 s cycle", () => {
        const signal = run(rules.createTurnSignal(), 1, 6, 0.3);
        expect(signal.side).toBe(1);
        signal.clock = 0.1;
        expect(rules.turnLamps(signal)).toEqual({ left: 1, right: 0 });
        signal.clock = 0.5;
        expect(rules.turnLamps(signal)).toEqual({ left: 0, right: 0 });
        expect(run(rules.createTurnSignal(), -1, 6, 0.3).side).toBe(-1);
    });

    it("ignore a tap, a light touch, highway speed and a standstill", () => {
        expect(run(rules.createTurnSignal(), 1, 6, 0.1).side).toBe(0);
        expect(run(rules.createTurnSignal(), 0.3, 6, 2).side).toBe(0);
        expect(run(rules.createTurnSignal(), 1, 30, 2).side).toBe(0);
        expect(run(rules.createTurnSignal(), 1, 0, 2).side).toBe(0);
        expect(rules.turnLamps(rules.createTurnSignal())).toEqual({ left: 0, right: 0 });
    });

    it("cancel once the wheel has been straight a moment or the car speeds up", () => {
        const signal = run(rules.createTurnSignal(), 1, 6, 0.3);
        run(signal, 0, 6, 0.3);
        expect(signal.side).toBe(1);
        run(signal, 0, 6, 0.4);
        expect(signal.side).toBe(0);
        expect(signal.clock).toBe(0);
        const fast = run(rules.createTurnSignal(), -1, 6, 0.3);
        run(fast, -1, 20, 0.05);
        expect(fast.side).toBe(0);
    });
});

describe("car lamps shared in a call", () => {
    const car = (x: number, w: number, side = 0) => ({
        carState: { value: { x, y: 0, z: 0, w } },
        turnSignal: { side }
    });

    it("are shared only while one is lit, and only from a car", () => {
        expect(embed.carLamps(car(0, 0), "car")).toBeNull();
        expect(embed.carLamps(car(0.6, 0, 1), "car")).toEqual({
            brake: 0.6,
            reverse: false,
            signal: 1
        });
        expect(embed.carLamps(car(0, 1), "car")).toEqual({ brake: 0, reverse: true, signal: 0 });
        expect(embed.carLamps(car(1, 1), "cyclist")).toBeNull();
        expect(embed.carLamps({}, "car")).toBeNull();
    });

    it("read from another player as off when missing or out of range", () => {
        const off = { brake: 0, reverse: false, signal: 0 };
        expect(embed.readLamps(undefined)).toEqual(off);
        expect(embed.readLamps({ brake: 5, reverse: "yes", signal: 3 })).toEqual({
            ...off,
            brake: 1
        });
        expect(embed.readLamps({ brake: 0.6, reverse: true, signal: -1 })).toEqual({
            brake: 0.6,
            reverse: true,
            signal: -1
        });
    });
});

describe("cast lights by graphics quality", () => {
    afterEach(() => quality.setCastLightShare(1));

    it("light fewer of each pool on lower levels, never none and never more than the pool", () => {
        const lit = (level: "low" | "medium" | "high", pool: number) =>
            quality.lightBudget(pool, quality.PRESETS[level].castLights);
        for (const pool of [6, 28, 36, 48, 96]) {
            expect(lit("high", pool)).toBe(pool);
            expect(lit("medium", pool)).toBeLessThan(pool);
            expect(lit("low", pool)).toBeLessThan(lit("medium", pool));
            expect(lit("low", pool)).toBeGreaterThanOrEqual(1);
        }
        expect(lit("low", 96)).toBe(36);
        expect(quality.lightBudget(1, 0)).toBe(1);
    });

    it("follow the share set for the session, which a bad value cannot break", () => {
        quality.setCastLightShare(quality.PRESETS.low.castLights);
        expect(quality.lightBudget(48)).toBe(18);
        quality.setCastLightShare(Number.NaN);
        expect(quality.lightBudget(48)).toBe(48);
        quality.setCastLightShare(4);
        expect(quality.lightBudget(48)).toBe(48);
    });
});
