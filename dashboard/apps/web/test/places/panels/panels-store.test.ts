/**
 * Saving a panel: its cards are stored whole, only cards naming devices and
 * rooms at its own place are accepted, and what the panel reaches follows the
 * cards and the rooms as they are now.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLACE = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PLACE = "00000000-0000-4000-8000-0000000000a2";
const LAMP = "00000000-0000-4000-8000-0000000000b1";
const PLUG = "00000000-0000-4000-8000-0000000000b2";
const FAR_DOOR = "00000000-0000-4000-8000-0000000000b9";
const ROOM = "00000000-0000-4000-8000-0000000000c1";

type Row = Record<string, unknown>;
let panels: Row[] = [];
const devices: Row[] = [
    { id: LAMP, installedAppId: "i1", placeId: PLACE, roomId: null },
    { id: PLUG, installedAppId: "i1", placeId: PLACE, roomId: ROOM },
    { id: FAR_DOOR, installedAppId: "i1", placeId: OTHER_PLACE, roomId: null }
];
const rooms: Row[] = [{ id: ROOM, installedAppId: "i1", placeId: PLACE, name: "Kitchen" }];
const PORCH = "00000000-0000-4000-8000-0000000000e1";
const FAR_CAMERA = "00000000-0000-4000-8000-0000000000e9";
const NIGHT = "00000000-0000-4000-8000-0000000000f1";
const FAR_NIGHT = "00000000-0000-4000-8000-0000000000f9";
const cameras: Row[] = [
    { id: PORCH, installedAppId: "i1", placeId: PLACE, name: "Porch", privacy: false },
    { id: FAR_CAMERA, installedAppId: "i1", placeId: OTHER_PLACE, name: "Barn", privacy: false }
];
const automations: Row[] = [
    { id: NIGHT, installedAppId: "i1", placeId: PLACE, name: "Good night", enabled: true },
    { id: FAR_NIGHT, installedAppId: "i1", placeId: OTHER_PLACE, name: "Barn off", enabled: true }
];
const places: Row[] = [
    { id: PLACE, installedAppId: "i1" },
    { id: OTHER_PLACE, installedAppId: "i1" }
];

/** The part of a Prisma where clause these queries use. */
function matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, want]) => {
        if (key === "OR") return (want as Row[]).some((each) => matches(row, each));
        if (want !== null && typeof want === "object" && "in" in want)
            return (want as { in: unknown[] }).in.includes(row[key]);
        return row[key] === want;
    });
}

function table(rows: () => Row[]) {
    return {
        count: async ({ where }: { where: Row }) =>
            rows().filter((row) => matches(row, where)).length,
        findMany: async ({ where }: { where: Row }) => rows().filter((row) => matches(row, where)),
        findFirst: async ({ where }: { where: Row }) =>
            rows().find((row) => matches(row, where)) ?? null
    };
}

vi.mock("@polaris/db", () => ({
    prisma: {
        place: table(() => places),
        placeDevice: table(() => devices),
        placeRoom: table(() => rooms),
        camera: table(() => cameras),
        placeAutomation: table(() => automations),
        placePanel: {
            ...table(() => panels),
            create: async ({ data }: { data: Row }) => {
                const row = { id: `p${panels.length + 1}`, ...data };
                panels.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Row }) => {
                const row = panels.find((entry) => entry.id === where.id)!;
                Object.assign(row, data);
                return row;
            },
            deleteMany: async ({ where }: { where: Row }) => {
                const before = panels.length;
                panels = panels.filter((row) => !matches(row, where));
                return { count: before - panels.length };
            }
        }
    }
}));
const dropGrantsFor = vi.fn(async () => undefined);
vi.mock("@polaris/app-host", () => ({ host: { accessGrants: { dropGrantsFor } } }));
vi.mock("@polaris-app/places/src/lib/cameras", () => ({
    getCamera: async (_i: string, id: string) => cameras.find((camera) => camera.id === id) ?? null
}));
vi.mock("@polaris-app/places/src/lib/devices", () => ({
    listDevices: async () => devices.map((device) => ({ ...device, name: String(device.id) }))
}));

const store = await import("@polaris-app/places/src/lib/panels");

beforeEach(() => {
    panels = [];
});

describe("panel persistence", () => {
    it("creates a panel and stores its cards whole", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        const cards = [
            { id: "a", type: "device" as const, deviceId: LAMP, x: 0, y: 0, w: 3, h: 2 },
            { id: "b", type: "room" as const, roomId: ROOM, x: 3, y: 0, w: 4, h: 3 }
        ];
        expect((await store.savePanelCards("i1", panel.id, cards)).cards).toEqual(cards);
        expect((await store.requirePanel("i1", panel.id)).cards).toEqual(cards);
        const contents = await store.panelContents("i1", panel.id);
        expect(contents.devices.map((device) => device.id).sort()).toEqual([LAMP, PLUG].sort());
        expect(contents.rooms).toEqual([{ id: ROOM, name: "Kitchen", deviceIds: [PLUG] }]);
    });

    it("refuses a card naming a device at another place", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await expect(
            store.savePanelCards("i1", panel.id, [
                { id: "a", type: "device", deviceId: FAR_DOOR, x: 0, y: 0, w: 3, h: 2 }
            ])
        ).rejects.toThrow("A card on that panel is not at this place");
    });

    it("keeps installs apart", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await expect(store.requirePanel("i2", panel.id)).rejects.toThrow();
        await expect(store.createPanel("i2", PLACE, "Hall")).rejects.toThrow("Place not found");
    });

    it("reaches the devices in its rooms now and nothing else", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.savePanelCards("i1", panel.id, [
            { id: "b", type: "room", roomId: ROOM, x: 0, y: 0, w: 4, h: 3 }
        ]);
        expect([...(await store.panelReach("i1", panel.id))]).toEqual([PLUG]);
        expect(await store.panelPlaceReach("i1", panel.id)).toEqual({
            placeId: PLACE,
            devices: new Set([PLUG])
        });
        expect(await store.panelHolds("i1", panel.id, LAMP)).toBe(false);
        expect(await store.panelHolds("i1", panel.id, FAR_DOOR)).toBe(false);
    });

    it("stops reaching a device card once that device moves to another place", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.savePanelCards("i1", panel.id, [
            { id: "a", type: "device", deviceId: LAMP, x: 0, y: 0, w: 3, h: 2 }
        ]);
        devices[0]!.placeId = OTHER_PLACE;
        try {
            expect(await store.panelHolds("i1", panel.id, LAMP)).toBe(false);
        } finally {
            devices[0]!.placeId = PLACE;
        }
    });

    it("removes a panel with its links, and refuses one that is already gone", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.deletePanel("i1", panel.id);
        expect(dropGrantsFor).toHaveBeenCalledWith("place.panel", panel.id);
        await expect(store.deletePanel("i1", panel.id)).rejects.toThrow();
    });
});

describe("panel cameras, buttons and sensors", () => {
    const extra = [
        { id: "c", type: "camera" as const, cameraId: PORCH, x: 0, y: 0, w: 4, h: 3 },
        {
            id: "n",
            type: "action" as const,
            automationId: NIGHT,
            confirm: true,
            x: 4,
            y: 0,
            w: 3,
            h: 1
        },
        { id: "s", type: "sensor" as const, deviceId: LAMP, x: 7, y: 0, w: 3, h: 2 }
    ];

    it("stores them and draws them from what is at the place now", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.savePanelCards("i1", panel.id, extra);
        const contents = await store.panelContents("i1", panel.id);
        expect(contents.cameras.map((camera) => camera.id)).toEqual([PORCH]);
        expect(contents.automations).toEqual([
            expect.objectContaining({ id: NIGHT, name: "Good night" })
        ]);
        expect(contents.devices.map((device) => device.id)).toEqual([LAMP]);
        expect(await store.panelHolds("i1", panel.id, LAMP)).toBe(true);
    });

    it("refuses a camera or an automation of another place", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await expect(
            store.savePanelCards("i1", panel.id, [{ ...extra[0]!, cameraId: FAR_CAMERA }])
        ).rejects.toThrow("A card on that panel is not at this place");
        await expect(
            store.savePanelCards("i1", panel.id, [{ ...extra[1]!, automationId: FAR_NIGHT }])
        ).rejects.toThrow("A card on that panel is not at this place");
    });

    it("holds only the cameras and automations on its cards", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.savePanelCards("i1", panel.id, extra);
        expect(await store.panelHoldsCamera("i1", panel.id, PORCH)).toBe(true);
        expect(await store.panelHoldsCamera("i1", panel.id, FAR_CAMERA)).toBe(false);
        expect(await store.panelHoldsAutomation("i1", panel.id, NIGHT)).toBe(true);
        expect(await store.panelHoldsAutomation("i1", panel.id, FAR_NIGHT)).toBe(false);
        expect(await store.panelHoldsCamera("i2", panel.id, PORCH)).toBe(false);
    });

    it("stops holding a camera once it moves to another place", async () => {
        const panel = await store.createPanel("i1", PLACE, "Hall");
        await store.savePanelCards("i1", panel.id, extra);
        cameras[0]!.placeId = OTHER_PLACE;
        try {
            expect(await store.panelHoldsCamera("i1", panel.id, PORCH)).toBe(false);
        } finally {
            cameras[0]!.placeId = PLACE;
        }
    });
});
