/**
 * A read that found nothing new changes nothing on the screen.
 *
 * Every sync reads every device and stamps each with when it was read, so a
 * comparison that included that time would redraw every row every ten seconds.
 * These are the rules that keep a quiet house still: equality ignores the read
 * time, unchanged entries keep their identity (so a memoized row does not
 * redraw), and a list nothing changed in comes back as the same list.
 */

import { device } from "./fixtures";
import { describe, expect, it } from "vitest";
import {
    applyDeviceChange,
    changedSince,
    mergeDevices,
    sameDevice
} from "@polaris-app/places/src/lib/device-diff";

describe("comparing two reads of a device", () => {
    it("ignores when it was read", () => {
        expect(sameDevice(device(), device({ stateAt: "2026-01-01T10:00:30.000Z" }))).toBe(true);
    });

    it("notices its state, and settings nested inside it", () => {
        expect(sameDevice(device(), device({ state: "on" }))).toBe(false);
        const cool = device({
            kind: "climate",
            climate: {
                mode: "cool",
                modes: ["cool"],
                target: 22,
                min: 16,
                max: 30,
                step: 1,
                unit: "C",
                fan: null,
                fans: [],
                options: {},
                current: 24
            }
        });
        expect(sameDevice(cool, { ...cool, climate: { ...cool.climate!, target: 23 } })).toBe(
            false
        );
        expect(sameDevice(cool, { ...cool, climate: { ...cool.climate! } })).toBe(true);
    });

    it("treats a missing optional field and null as the same", () => {
        expect(sameDevice(device({ air: null }), device())).toBe(true);
    });
});

describe("merging a full list into the one on screen", () => {
    it("returns the very list when nothing but the read time moved", () => {
        const current = [device(), device({ id: "device-2", name: "Fan" })];
        const next = current.map((entry) => ({ ...entry, stateAt: "2026-01-01T11:00:00.000Z" }));
        expect(mergeDevices(current, next)).toBe(current);
    });

    it("keeps unchanged entries by identity and takes the changed one", () => {
        const lamp = device();
        const fan = device({ id: "device-2", name: "Fan" });
        const merged = mergeDevices([lamp, fan], [lamp, { ...fan, state: "on" }]);
        expect(merged[0]).toBe(lamp);
        expect(merged[1]).not.toBe(fan);
        expect(merged[1]!.state).toBe("on");
    });

    it("follows the server's order and membership", () => {
        const lamp = device();
        const fan = device({ id: "device-2", name: "Fan" });
        expect(mergeDevices([lamp, fan], [fan])).toEqual([fan]);
        const reordered = mergeDevices([lamp, fan], [fan, lamp]);
        expect(reordered.map((entry) => entry.id)).toEqual(["device-2", "device-1"]);
        expect(reordered[0]).toBe(fan);
    });

    it("keeps what was pushed after the read began, present or removed", () => {
        const lampOn = device({ state: "on" });
        const fan = device({ id: "device-2", name: "Fan" });
        // The read began before the lamp was pushed on and the fan pushed away.
        const stale = [device({ state: "off" }), fan];
        const pushed = new Set(["device-1", "device-2"]);
        const merged = mergeDevices([lampOn], stale, (id) => pushed.has(id));
        expect(merged).toEqual([lampOn]);
        expect(merged[0]).toBe(lampOn);
    });

    it("keeps a device pushed as new that the read began too early to see", () => {
        const lamp = device();
        const fan = device({ id: "device-2", name: "Fan" });
        const merged = mergeDevices([lamp, fan], [lamp], (id) => id === "device-2");
        expect(merged).toEqual([lamp, fan]);
        expect(merged[1]).toBe(fan);
    });

    it("takes the list whole when there was none", () => {
        expect(mergeDevices(null, [device()])).toEqual([device()]);
    });
});

describe("applying a pushed change", () => {
    it("replaces a changed device in place and leaves the rest alone", () => {
        const lamp = device();
        const fan = device({ id: "device-2", name: "Fan" });
        const next = applyDeviceChange([lamp, fan], {
            devices: [device({ state: "on" })],
            removed: []
        });
        expect(next!.map((entry) => entry.id)).toEqual(["device-1", "device-2"]);
        expect(next![0]!.state).toBe("on");
        expect(next![1]).toBe(fan);
    });

    it("returns the same list for a push that changes nothing", () => {
        const current = [device()];
        expect(
            applyDeviceChange(current, {
                devices: [device({ stateAt: "2026-01-02T00:00:00.000Z" })],
                removed: []
            })
        ).toBe(current);
    });

    it("removes and adds", () => {
        const lamp = device();
        const next = applyDeviceChange([lamp], {
            devices: [device({ id: "device-3", name: "Door" })],
            removed: ["device-1"]
        });
        expect(next!.map((entry) => entry.id)).toEqual(["device-3"]);
    });

    it("waits for the first read rather than drawing a partial list", () => {
        expect(applyDeviceChange(null, { devices: [device()], removed: [] })).toBeNull();
    });
});

describe("what the server publishes", () => {
    it("is only what differs from the last publish, remembering the new state", () => {
        const known = new Map();
        expect(changedSince(known, [device()])).toHaveLength(1);
        expect(changedSince(known, [device({ stateAt: "2026-01-01T12:00:00.000Z" })])).toEqual([]);
        expect(changedSince(known, [device({ state: "on" })])).toHaveLength(1);
        expect(known.get("device-1").state).toBe("on");
    });
});
