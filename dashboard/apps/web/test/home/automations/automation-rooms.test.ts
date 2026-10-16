/**
 * Rooms and floors: how a place's rooms read as a list, how "By target" groups
 * devices by them, and what a room's name and floor are checked against.
 */

import { describe, expect, it } from "vitest";
import * as auto from "@polaris-app/places/src/lib/automation-kinds";
import * as schemas from "@polaris-app/places/src/lib/schemas";
import { floorNames, roomsByFloor, type RoomView } from "@polaris-app/places/src/lib/room-kinds";
import { targetGroups } from "@polaris-app/places/src/screens/automations/add-block";

function room(id: string, name: string, floor = ""): RoomView {
    return { id, placeId: "place-1", name, floor };
}

const LEVELS = { noFloor: "On no floor", noRoom: "In no room" };

const ROOMS = [
    room("r1", "Kitchen", "Ground floor"),
    room("r2", "Bedroom 10", "First floor"),
    room("r3", "Bedroom 2", "First floor"),
    room("r4", "Garage")
];

describe("a place's rooms", () => {
    it("read floor by floor, rooms by name, the unsaid floor last", () => {
        expect(
            roomsByFloor(ROOMS).map((floor) => [floor.floor, floor.rooms.map((each) => each.name)])
        ).toEqual([
            ["First floor", ["Bedroom 2", "Bedroom 10"]],
            ["Ground floor", ["Kitchen"]],
            ["", ["Garage"]]
        ]);
    });

    it("offer the floor names already used, once each", () => {
        expect(floorNames(ROOMS)).toEqual(["First floor", "Ground floor"]);
    });

    it("group devices floor by floor, room by room, then the rest by what they are", () => {
        const devices = [
            { id: "lamp", kind: "light", roomId: "r1" },
            { id: "bed", kind: "light", roomId: "r3" },
            { id: "car", kind: "outlet", roomId: "r4" },
            { id: "plug", kind: "outlet", roomId: null },
            { id: "lock", kind: "lock" },
            { id: "lost", kind: "light", roomId: "gone" }
        ];
        const groups = targetGroups(
            devices,
            ROOMS,
            (device) => (device.kind === "lock" ? "Doors" : "Power"),
            LEVELS
        );
        expect(
            groups.map((group) => [group.section, group.label, group.devices.map((each) => each.id)])
        ).toEqual([
            ["First floor", "Bedroom 2", ["bed"]],
            ["Ground floor", "Kitchen", ["lamp"]],
            ["On no floor", "Garage", ["car"]],
            ["In no room", "Power", ["plug", "lost"]],
            ["In no room", "Doors", ["lock"]]
        ]);
    });

    it("draw no floor level where no room is on a floor", () => {
        const groups = targetGroups(
            [{ id: "lamp", kind: "light", roomId: "r4" }],
            [room("r4", "Garage")],
            () => "Power",
            LEVELS
        );
        expect(groups).toEqual([
            { id: "room:r4", label: "Garage", devices: [{ id: "lamp", kind: "light", roomId: "r4" }] }
        ]);
    });

    it("group by what they are alone where there are no rooms", () => {
        const groups = targetGroups([{ id: "plug", kind: "outlet" }], [], () => "Power", LEVELS);
        expect(groups).toEqual([
            { id: "Power", label: "Power", devices: [{ id: "plug", kind: "outlet" }] }
        ]);
    });
});

describe("a room's name and floor", () => {
    it("are trimmed before they are checked, and a blank name is refused", () => {
        const input = schemas.normalizeRoomInput({
            placeId: " place-1 ",
            name: "  Kitchen ",
            floor: " "
        });
        expect(schemas.roomCreateSchema.parse(input)).toEqual({
            placeId: "place-1",
            name: "Kitchen",
            floor: ""
        });
        expect(
            schemas.roomInputSchema.safeParse(schemas.normalizeRoomInput({ name: "   " })).success
        ).toBe(false);
    });

    it("leave a device's room as it is when a screen from before rooms saves it", () => {
        const parsed = schemas.deviceEditSchema.parse({
            name: "Lamp",
            zone: "",
            placeId: "place-1"
        });
        expect(parsed).not.toHaveProperty("roomId");
        expect(schemas.deviceEditSchema.parse({ name: "Lamp", roomId: null }).roomId).toBeNull();
    });
});

describe("a block naming a room or a floor", () => {
    const rooms = [
        { id: "kitchen", floorId: "ground" },
        { id: "bedroom", floorId: "upstairs" }
    ];
    const devices = [
        { id: "lamp1", kind: "light", name: "Lamp", controllable: true, roomId: "kitchen" },
        { id: "lamp2", kind: "light", name: "Lamp 2", controllable: true, roomId: null }
    ];
    const trigger = (target: { kind: "room" | "floor"; id: string }): auto.Trigger => ({
        id: "trigroom",
        kind: "change",
        deviceId: "lamp2",
        targets: [target],
        attribute: "state",
        from: "",
        to: "on"
    });
    const definition = (block: auto.Trigger): auto.AutomationDefinition => ({
        timeZone: "UTC",
        triggers: [block],
        conditions: { match: "all", groups: [] },
        actions: [{ id: "stepnote", kind: "notify", message: "hi" }]
    });
    const context = { automationIds: [], selfId: null, rooms };

    it("is accepted by the schema", () => {
        expect(auto.triggerSchema.safeParse(trigger({ kind: "floor", id: "ground" })).success).toBe(
            true
        );
    });

    it("resolves to what is in it, not to the device it was saved with", () => {
        const scope = { devices, rooms };
        expect(auto.resolvedTargets(trigger({ kind: "room", id: "kitchen" }), scope)).toEqual([
            "lamp1"
        ]);
        expect(auto.resolvedTargets(trigger({ kind: "floor", id: "upstairs" }), scope)).toEqual([]);
    });

    it("is refused where the room is gone, or holds nothing that can answer", () => {
        expect(
            auto
                .deviceIssues(definition(trigger({ kind: "room", id: "gone" })), devices, context)
                .map((issue) => issue.message)
        ).toEqual(["automations.errors.placeGone"]);
        expect(
            auto
                .deviceIssues(definition(trigger({ kind: "floor", id: "upstairs" })), devices, context)
                .map((issue) => issue.message)
        ).toEqual(["automations.errors.placeEmpty"]);
        expect(
            auto.deviceIssues(definition(trigger({ kind: "room", id: "kitchen" })), devices, context)
        ).toEqual([]);
    });

    it("keeps its room when its device is changed, and is read on every device", () => {
        const kept = auto.triggerOn(trigger({ kind: "room", id: "kitchen" }), {
            ...devices[0]!
        } as unknown as Parameters<typeof auto.triggerOn>[1]);
        expect(auto.placeTargets(kept)).toEqual([{ kind: "room", id: "kitchen" }]);
        expect(auto.devicesReadBy(definition(trigger({ kind: "room", id: "kitchen" })))).toBe(
            "all"
        );
    });
});

describe("a step on a set", () => {
    const devices = [
        { id: "lamp1", kind: "light", name: "Lamp", controllable: true, roomId: "kitchen" },
        { id: "lock1", kind: "lock", name: "Lock", controllable: false, roomId: "kitchen" }
    ];
    const withStep = (step: auto.Step): auto.AutomationDefinition => ({
        timeZone: "UTC",
        triggers: [{ id: "trigmanual", kind: "manual" }],
        conditions: { match: "all", groups: [] },
        actions: [step]
    });

    it("is accepted on a device step and a wait, and refused for a member that cannot", () => {
        const step: auto.Step = {
            id: "stepon",
            kind: "device",
            deviceId: "lamp1",
            targets: [
                { kind: "device", id: "lamp1" },
                { kind: "device", id: "lock1" }
            ],
            do: "turn-on"
        };
        expect(auto.actionSchema.safeParse(step).success).toBe(true);
        expect(
            auto.deviceIssues(withStep(step), devices, { automationIds: [], selfId: null })
        ).toEqual([
            {
                path: ["definition", "actions", 0, "targets", 1, "id"],
                message: "automations.errors.watchOnly"
            }
        ]);
        expect(
            auto.actionSchema.safeParse({
                id: "stepwait",
                kind: "wait",
                deviceId: "lamp1",
                targets: [{ kind: "room", id: "kitchen" }],
                quantifier: "all",
                attribute: "state",
                is: "on",
                timeoutMinutes: 5,
                onTimeout: "stop"
            }).success
        ).toBe(true);
    });

    it("reads a room as only the devices in it that can be told", () => {
        const step = {
            id: "stepon",
            kind: "device",
            deviceId: "lamp1",
            targets: [{ kind: "room" as const, id: "kitchen" }],
            do: "turn-on" as const
        };
        expect(
            auto.resolvedTargets(step, { devices, rooms: [{ id: "kitchen", floorId: "" }] })
        ).toEqual(["lamp1"]);
    });
});
