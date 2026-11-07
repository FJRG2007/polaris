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
