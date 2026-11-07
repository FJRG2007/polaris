// @vitest-environment jsdom

/**
 * New York on a Bluetooth or USB gamepad: a pad with no standard mapping is
 * read as one, a pad plugged in or lost is reported, the car horn and the
 * player's impacts reach the pad, and rumble uses whichever actuator the
 * browser has.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as gamepad from "../../../arcade/game/new-york/engine/gamepad-controls.js";

vi.mock("../../../arcade/game/new-york/engine/city-config.js", () => ({
    isTypingInField: () => false
}));

type Button = { pressed: boolean; value: number };

function buttons(values: Record<number, number>, length = 17): Button[] {
    return Array.from({ length }, (_, i) => ({
        pressed: (values[i] ?? 0) > 0.5,
        value: values[i] ?? 0
    }));
}

function device(fields: Record<string, unknown> = {}) {
    return {
        id: "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)",
        index: 0,
        connected: true,
        mapping: "standard",
        axes: [0, 0, 0, 0],
        buttons: buttons({}),
        ...fields
    };
}

function controller() {
    const input: Record<string, number> = {};
    return {
        input,
        activeMode: "person",
        setGamepadInput: (action: string, value: number) => {
            input[action] = value;
        },
        clearGamepadInput: () => {
            for (const key of Object.keys(input)) delete input[key];
        }
    };
}

const camera = () => ({ applyGamepadInput: vi.fn(), resetOrbit: vi.fn() });

function connect(pads: unknown[]) {
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => pads });
}

// jsdom's document never has the focus; the game only reads a pad while it does
beforeEach(() => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "getGamepads", { configurable: true, value: undefined });
});

describe("reading any gamepad as the standard layout", () => {
    it("passes a standard pad through", () => {
        const read = gamepad.normalizePad(
            device({ axes: [0.5, -0.5, 0.25, 1], buttons: buttons({ 0: 1, 7: 0.4 }) })
        );
        expect(read.standard).toBe(true);
        expect(read.axes).toEqual([0.5, -0.5, 0.25, 1]);
        expect(read.buttons[0]).toBe(1);
        expect(read.buttons[7]).toBe(0.4);
    });

    it("takes the right stick and analog triggers from a six-axis pad with no mapping, once a trigger is seen at rest", () => {
        const state = {};
        const pad = (axes: number[]) => device({ mapping: "", axes, buttons: buttons({}, 11) });
        // Before the trigger is touched some browsers report 0, which must not read as half pulled
        let read = gamepad.normalizePad(pad([0, 0, 0, 0.3, -0.7, 0]), state);
        expect(read.axes).toEqual([0, 0, 0.3, -0.7]);
        expect(read.buttons[6]).toBe(0);
        expect(read.buttons[7]).toBe(0);
        read = gamepad.normalizePad(pad([0, 0, -1, 0, 0, -1]), state);
        expect(read.buttons[7]).toBe(0);
        read = gamepad.normalizePad(pad([0, 0, -1, 0, 0, 1]), state);
        expect(read.buttons[7]).toBe(1);
        read = gamepad.normalizePad(pad([0, 0, 0, 0, 0, 0]), state);
        expect(read.buttons[6]).toBe(0.5);
    });

    it("reads a d-pad hat on an eight-axis pad with no d-pad buttons", () => {
        const read = gamepad.normalizePad(
            device({ mapping: "", axes: [0, 0, -1, 0, 0, -1, -1, 1], buttons: buttons({}, 12) })
        );
        expect(read.axes).toEqual([0, 0, 0, 0]);
        expect(read.buttons.slice(12, 16)).toEqual([0, 1, 1, 0]);
    });

    it("plays only a pad with sticks and buttons enough", () => {
        expect(gamepad.usablePad(device())).toBe(true);
        expect(
            gamepad.usablePad(device({ mapping: "", axes: [0, 0], buttons: buttons({}, 4) }))
        ).toBe(true);
        expect(
            gamepad.usablePad(device({ mapping: "", axes: [0], buttons: buttons({}, 10) }))
        ).toBe(false);
        expect(gamepad.usablePad(device({ connected: false }))).toBe(false);
        expect(gamepad.usablePad(null)).toBe(false);
    });

    it("names a pad without the vendor and product codes", () => {
        expect(
            gamepad.padLabel(
                "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
            )
        ).toBe("Xbox Wireless Controller");
        expect(gamepad.padLabel("054c-0ce6-DualSense Wireless Controller")).toBe(
            "DualSense Wireless Controller"
        );
        expect(gamepad.padLabel(undefined)).toBe("");
    });
});

describe("rumble on impacts", () => {
    it("scales with the impact and ignores a nudge", () => {
        expect(gamepad.impactRumble(1)).toBeNull();
        expect(gamepad.impactRumble(Number.NaN)).toBeNull();
        const soft = gamepad.impactRumble(4)!;
        const hard = gamepad.impactRumble(30)!;
        expect(soft.strong).toBeLessThan(hard.strong);
        expect(hard).toEqual({ strong: 1, weak: 1, duration: 350 });
    });

    it("uses the vibration actuator, then the haptic one, and survives a pad with neither", () => {
        const effect = { strong: 1, weak: 0.5, duration: 200 };
        const playEffect = vi.fn(() => Promise.resolve("complete"));
        expect(gamepad.rumble(device({ vibrationActuator: { playEffect } }), effect)).toBe(true);
        expect(playEffect).toHaveBeenCalledWith(
            "dual-rumble",
            expect.objectContaining({ duration: 200, strongMagnitude: 1, weakMagnitude: 0.5 })
        );
        const pulse = vi.fn(() => Promise.reject(new Error("busy")));
        expect(gamepad.rumble(device({ hapticActuators: [{ pulse }] }), effect)).toBe(true);
        expect(pulse).toHaveBeenCalledWith(1, 200);
        expect(gamepad.rumble(device(), effect)).toBe(false);
        expect(
            gamepad.rumble(
                device({
                    vibrationActuator: {
                        playEffect: () => {
                            throw new Error("no");
                        }
                    }
                }),
                effect
            )
        ).toBe(false);
    });

    it("shakes the pad in use, but not twice for one crash", () => {
        const playEffect = vi.fn(() => Promise.resolve("complete"));
        connect([device({ vibrationActuator: { playEffect } })]);
        const controls = new gamepad.GamepadControls(controller(), camera());
        controls.update(0.016);
        expect(controls.impact(10)).toBe(true);
        expect(controls.impact(10)).toBe(false);
        expect(playEffect).toHaveBeenCalledTimes(1);
    });
});

describe("a gamepad plugged in, lost, or used to honk", () => {
    it("reports a pad connecting and disconnecting, with its name", () => {
        const onPadChange = vi.fn();
        connect([device()]);
        const controls = new gamepad.GamepadControls(controller(), camera(), { onPadChange });
        controls.update(0.016);
        expect(onPadChange).toHaveBeenLastCalledWith({
            connected: true,
            name: "Xbox Wireless Controller",
            standard: true
        });
        controls.update(0.016);
        expect(onPadChange).toHaveBeenCalledTimes(1);
        connect([null]);
        controls.update(0.016);
        expect(onPadChange).toHaveBeenLastCalledWith({
            connected: false,
            name: "Xbox Wireless Controller",
            standard: true
        });
        expect(controls.connected).toBe(false);
    });

    it("drives with a pad that has no standard mapping", () => {
        const manager = controller();
        manager.activeMode = "person";
        connect([
            device({
                mapping: "",
                id: "Generic USB Joystick",
                axes: [0, -1, 0, 0],
                buttons: buttons({}, 12)
            })
        ]);
        const controls = new gamepad.GamepadControls(manager, camera());
        controls.update(0.016);
        expect(controls.standard).toBe(false);
        expect(manager.input.forward).toBe(1);
    });

    it("honks on X in the car only, on the press and not while held", () => {
        const onHorn = vi.fn();
        const manager = controller();
        manager.activeMode = "car";
        const pads = [device()];
        connect(pads);
        const controls = new gamepad.GamepadControls(manager, camera(), { onHorn });
        controls.update(0.016);
        pads[0] = device({ buttons: buttons({ 2: 1 }) });
        controls.update(0.016);
        controls.update(0.016);
        expect(onHorn).toHaveBeenCalledTimes(1);
        manager.activeMode = "person";
        pads[0] = device();
        controls.update(0.016);
        pads[0] = device({ buttons: buttons({ 2: 1 }) });
        controls.update(0.016);
        expect(onHorn).toHaveBeenCalledTimes(1);
    });
});
