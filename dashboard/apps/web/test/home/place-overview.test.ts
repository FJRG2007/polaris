/**
 * What a place's Overview says about its devices.
 *
 * The figures at the top count only what is there and answering - a light that
 * is not answering is not "on" - and the rooms are the zones the devices were
 * given, matched without case, with the devices placed nowhere last.
 */

import { describe, expect, it } from "vitest";
import type { DeviceView } from "@polaris-app/places/src/lib/device-kinds";
import { attentionFor, groupByRoom, summarizeDevices } from "@polaris-app/places/src/lib/overview";

let next = 0;

function device(overrides: Partial<DeviceView> = {}): DeviceView {
    next += 1;
    return {
        id: `device-${next}`,
        vendor: "fixture",
        kind: "light",
        name: `Device ${next}`,
        zone: "",
        placeId: "place-1",
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
        ...overrides
    };
}

describe("the summary", () => {
    it("counts what is online, and the lights that are on and answering", () => {
        const summary = summarizeDevices([
            device({ state: "on" }),
            device({ state: "off" }),
            device({ state: "on", online: false }),
            device({ kind: "outlet", state: "on" })
        ]);
        expect(summary.total).toBe(4);
        expect(summary.online).toBe(3);
        expect(summary.offline).toBe(1);
        expect(summary.lights).toBe(3);
        expect(summary.lightsOn).toBe(1);
    });

    it("counts locks left open and doors standing open", () => {
        const summary = summarizeDevices([
            device({ kind: "lock", state: "locked" }),
            device({ kind: "lock", state: "unlocked", doorState: "open" }),
            device({ kind: "opener", state: "unlatched" })
        ]);
        expect(summary.locks).toBe(3);
        expect(summary.unlocked).toBe(2);
        expect(summary.doorsOpen).toBe(1);
    });

    it("spans the room temperatures in the unit most of them use", () => {
        const climate = {
            mode: "cool" as const,
            modes: [],
            target: 24,
            min: 16,
            max: 30,
            step: 1,
            unit: "C" as const,
            fan: null,
            fans: [],
            options: {}
        };
        const summary = summarizeDevices([
            device({ kind: "climate", state: "on", climate: { ...climate, current: 26 } }),
            device({ kind: "sensor", reading: { value: "21.5", unit: "°C" } }),
            device({ kind: "sensor", reading: { value: "70", unit: "°F" } }),
            device({ kind: "sensor", reading: { value: "45", unit: "%" } })
        ]);
        expect(summary.climate).toBe(1);
        expect(summary.climateOn).toBe(1);
        expect(summary.temperatures).toEqual({ min: 21.5, max: 26, unit: "C" });
    });

    it("has no temperatures when nothing reads one", () => {
        expect(summarizeDevices([device()]).temperatures).toBeNull();
    });

    it("lists what needs somebody, worst first", () => {
        const stuck = device({ kind: "lock", state: "jammed", name: "Back door" });
        const gone = device({ online: false, name: "Porch" });
        const flat = device({ batteryCritical: true, name: "Gate" });
        const open = device({ kind: "lock", state: "unlocked", doorState: "open", name: "Front" });
        const summary = summarizeDevices([open, flat, gone, stuck, device()]);
        expect(summary.attention.map((entry) => [entry.device.name, entry.reason])).toEqual([
            ["Back door", "jammed"],
            ["Porch", "offline"],
            ["Gate", "battery"],
            ["Front", "door-open"]
        ]);
    });

    it("does not call a sensor's open contact a door left open", () => {
        expect(attentionFor(device({ kind: "sensor", doorState: "open" }))).toBeNull();
    });
});

describe("the rooms", () => {
    it("are the zones, matched without case or spaces, placed-nowhere last", () => {
        const rooms = groupByRoom([
            device({ zone: "kitchen ", name: "Kettle", kind: "outlet" }),
            device({ zone: "", name: "Spare" }),
            device({ zone: "Bedroom", name: "Lamp", state: "on" }),
            device({ zone: "Kitchen", name: "Back door", kind: "lock" })
        ]);
        expect(rooms.map((room) => room.name)).toEqual(["Bedroom", "kitchen", ""]);
        // Doors first inside a room, as on the devices screen.
        expect(rooms[1]!.devices.map((entry) => entry.name)).toEqual(["Back door", "Kettle"]);
        expect(rooms[0]!.on).toBe(1);
    });

    it("is nothing for a place with no devices", () => {
        expect(groupByRoom([])).toEqual([]);
    });
});
