/**
 * Places' Overview cards: the devices somebody picked, and their controls.
 *
 * What is pinned: a card shows only devices the reader reaches - the house for
 * somebody who lives there, only what was lent to a visitor - and leaves out
 * the rest; a control says why it cannot be used rather than offering it; and
 * a press is the devices screen's own action (`operateDeviceAction`), with its
 * permission checks, never a second path to a device.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let held = new Set<string>();
let lent: Record<string, string> = {};
const operateDeviceAction = vi.fn(async (..._args: unknown[]) => ({}) as { error?: string });

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "u1", isAdmin: false }),
    sessionCan: async (_user: unknown, permission: string) => held.has(permission),
    sessionCanAny: async (_user: unknown, permission: string) => held.has(permission)
}));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async () => [],
    grantedSubjects: async (_userId: string, subject: string) =>
        new Map(subject === "place.device" ? Object.entries(lent) : []),
    reachesAnySubject: async () => Object.keys(lent).length > 0,
    spendGrant: async () => true
}));
vi.mock("@polaris-app/places/src/lib/access", () => ({
    homeInstall: async () => ({ id: "install-1", ownerId: "owner", name: "Home" })
}));

const DEVICES = [
    {
        id: "ac",
        vendor: "gree",
        kind: "climate",
        name: "Living room AC",
        zone: "Living room",
        placeId: null,
        model: "",
        firmware: "",
        state: "on",
        doorState: "unknown",
        batteryPercent: null,
        batteryCritical: false,
        online: true,
        controllable: true,
        reading: null,
        stateAt: null,
        climate: {
            mode: "cool",
            modes: ["cool", "heat"],
            target: 23,
            min: 16,
            max: 30,
            step: 0.5,
            unit: "C",
            fan: null,
            fans: [],
            options: {},
            current: 26.5
        },
        air: null
    },
    {
        id: "plug",
        vendor: "shelly",
        kind: "switch",
        name: "Desk lamp",
        zone: "Office",
        placeId: null,
        model: "",
        firmware: "",
        state: "off",
        doorState: "unknown",
        batteryPercent: null,
        batteryCritical: false,
        online: false,
        controllable: true,
        reading: null,
        stateAt: null,
        climate: null,
        air: null
    }
];

vi.mock("@polaris-app/places/src/lib/devices", () => ({ listDevices: async () => DEVICES }));
vi.mock("@polaris-app/places/src/screens/actions", () => ({ operateDeviceAction }));

const cards = await import("@polaris-app/places/src/lib/overview-widgets");

beforeEach(() => {
    held = new Set(["home.read", "home.control"]);
    lent = {};
    operateDeviceAction.mockClear();
});

describe("what a card shows", () => {
    it("reads an air conditioner's room, target and mode, and offers its controls", async () => {
        const view = await cards.readDevices(["ac"], "controls");
        const [ac] = view.items;
        expect(ac?.readings.map((reading) => [reading.label, reading.value])).toEqual([
            ["Room", "26.5°C"],
            ["Set to", "23°C"],
            ["Mode", "Cool"]
        ]);
        expect(ac?.controls).toEqual([
            { kind: "toggle", id: "power", label: "Power", on: true, disabled: null },
            {
                kind: "number",
                id: "target",
                label: "Set to",
                value: 23,
                min: 16,
                max: 30,
                step: 0.5,
                unit: "°C",
                disabled: null
            }
        ]);
    });

    it("draws no controls on a glance card", async () => {
        const view = await cards.readDevices(["ac"], "status");
        expect(view.items[0]?.controls).toEqual([]);
    });

    it("says why a device that is not answering cannot be switched", async () => {
        const view = await cards.readDevices(["plug"], "controls");
        expect(view.items[0]?.state).toBe("Offline");
        expect(view.items[0]?.controls[0]).toMatchObject({ id: "power", disabled: "Offline" });
    });

    it("keeps the order the reader picked, and leaves out what is gone", async () => {
        const view = await cards.readDevices(["plug", "missing", "ac"], "status");
        expect(view.items.map((item) => item.id)).toEqual(["plug", "ac"]);
    });
});

describe("who sees and operates what", () => {
    it("shows a visitor only what was lent to them", async () => {
        held = new Set();
        lent = { ac: "view" };
        expect((await cards.deviceTargets("status")).map((target) => target.id)).toEqual(["ac"]);
        const view = await cards.readDevices(["ac", "plug"], "controls");
        expect(view.items.map((item) => item.id)).toEqual(["ac"]);
        // Lent to look at, not to operate: the controls say so.
        expect(view.items[0]?.controls[0]?.disabled).toBe("You cannot operate this from here");
    });

    it("lets a resident who may only read see the controls but not use them", async () => {
        held = new Set(["home.read"]);
        const view = await cards.readDevices(["ac"], "controls");
        expect(view.items[0]?.controls.every((control) => control.disabled)).toBe(true);
    });

    it("offers for quick controls only devices with something to change", async () => {
        const offered = await cards.deviceTargets("controls");
        expect(offered.map((target) => target.id)).toEqual(["ac", "plug"]);
        expect(offered[0]).toEqual({
            id: "ac",
            label: "Living room AC",
            detail: expect.stringContaining("Living room")
        });
    });
});

describe("a press", () => {
    it("is the devices screen's own action, with the setting it means", async () => {
        expect(await cards.operate(["ac"], { item: "ac", control: "target", value: 21.5 })).toEqual(
            {}
        );
        expect(operateDeviceAction).toHaveBeenCalledWith("ac", "set-temperature", {
            action: "set-temperature",
            target: 21.5
        });
        await cards.operate(["ac"], { item: "ac", control: "power", value: false });
        expect(operateDeviceAction).toHaveBeenLastCalledWith("ac", "turn-off", undefined);
    });

    it("carries that action's refusal back - its checks are the ones that count", async () => {
        operateDeviceAction.mockResolvedValueOnce({ error: "You cannot operate that from here" });
        expect(await cards.operate(["ac"], { item: "ac", control: "power", value: true })).toEqual({
            error: "You cannot operate that from here"
        });
    });

    it("is refused for a device or a control the card does not have", async () => {
        expect(
            (await cards.operate(["ac"], { item: "plug", control: "power", value: true })).error
        ).toBeTruthy();
        expect(
            (await cards.operate(["ac"], { item: "ac", control: "unlock", value: true })).error
        ).toBeTruthy();
        expect(
            (await cards.operate(["ac"], { item: "ac", control: "power", value: 3 })).error
        ).toBeTruthy();
        expect(operateDeviceAction).not.toHaveBeenCalled();
    });
});
