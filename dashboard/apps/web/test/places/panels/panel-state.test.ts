/**
 * A press on a wall panel moves the card at once and moves it back on a
 * refusal - but only while the card still shows that press.
 */

import { describe, expect, it } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import {
    applyPanelChange,
    isNight,
    optimisticDevice,
    rolledBack
} from "@polaris-app/places/src/screens/panels/panel-state";

function device(overrides: Partial<DeviceView> = {}): DeviceView {
    return {
        id: "lamp",
        vendor: "hue",
        kind: "light",
        name: "Lamp",
        zone: "",
        placeId: "p",
        model: "",
        firmware: "",
        state: "off",
        doorState: "none",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        light: { brightness: { level: 40 }, temperature: null, color: null },
        ...overrides
    };
}

describe("optimistic presses", () => {
    it("switches on at once", () => {
        expect(optimisticDevice(device(), "turn-on")?.state).toBe("on");
    });

    it("sets the brightness at once", () => {
        const next = optimisticDevice(device(), "set-brightness", {
            action: "set-brightness",
            level: 80
        });
        expect(next?.light?.brightness?.level).toBe(80);
    });

    it("leaves a lock alone until it reports", () => {
        expect(optimisticDevice(device({ kind: "lock" }), "unlock")).toBeNull();
    });

    it("puts the old state back on a refusal", () => {
        const before = device();
        const pressed = optimisticDevice(before, "turn-on")!;
        expect(rolledBack(pressed, before, pressed)).toBe(before);
    });

    it("keeps a live update that arrived after the press", () => {
        const before = device();
        const pressed = optimisticDevice(before, "turn-on")!;
        const live = { ...pressed, state: "on" as const, stateAt: "later" };
        expect(rolledBack(live, before, pressed)).toBe(live);
    });
});

describe("live frames", () => {
    it("updates the panel's devices and never adds one that is not on it", () => {
        const current = [device()];
        const next = applyPanelChange(current, {
            devices: [device({ state: "on" }), device({ id: "stranger" })],
            removed: []
        });
        expect(next.map((entry) => [entry.id, entry.state])).toEqual([["lamp", "on"]]);
    });
});

describe("night", () => {
    it("runs from nine at night to seven in the morning", () => {
        expect(isNight(new Date(2026, 0, 1, 22))).toBe(true);
        expect(isNight(new Date(2026, 0, 1, 6))).toBe(true);
        expect(isNight(new Date(2026, 0, 1, 12))).toBe(false);
    });
});
