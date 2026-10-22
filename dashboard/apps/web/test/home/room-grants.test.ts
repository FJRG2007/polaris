/**
 * A room lent as one key - a hotel guest's room, an office team's floor.
 * It reaches whatever is in the room when it is asked, not what was in it when
 * the key was cut; check-out ends it; and every use and refusal is logged.
 */

import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ROOM = "00000000-0000-4000-8000-0000000000b1";
const PLACE = "00000000-0000-4000-8000-0000000000a1";

/** Which room each device is in, as the database would answer now. */
let deviceRooms: Record<string, string | null> = {};
let cameraZones: Record<string, { placeId: string; zone: string; roomId?: string | null }> = {};
let lent: Record<string, { id: string; capability: string; counted: boolean; actions: string[] }[]> =
    {};
const recordGrantUse = vi.fn(async (_use: Record<string, unknown>) => undefined);

vi.mock("@/lib/session", () => ({ sessionCan: async () => false }));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async (_user: string, subject: string, id: string) => lent[`${subject}:${id}`] ?? [],
    grantedSubjects: async (_user: string, subject: string) =>
        new Map(
            Object.entries(lent)
                .filter(([key]) => key.startsWith(`${subject}:`))
                .map(([key, grants]) => [key.split(":")[1]!, grants[0]!.capability])
        ),
    grantedActions: async (_user: string, subject: string) =>
        new Map(
            Object.entries(lent)
                .filter(([key]) => key.startsWith(`${subject}:`))
                .map(([key, grants]) => [key.split(":")[1]!, grants[0]!.actions])
        ),
    reachesAnySubject: async () => true,
    spendGrant: async () => true,
    recordGrantUse
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        placeDevice: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id in deviceRooms ? { roomId: deviceRooms[where.id] } : null,
            findMany: async ({ where }: { where: { roomId: { in: string[] } } }) =>
                Object.entries(deviceRooms)
                    .filter(([, room]) => room && where.roomId.in.includes(room))
                    .map(([id, roomId]) => ({ id, roomId }))
        },
        camera: {
            findUnique: async ({ where }: { where: { id: string } }) => cameraZones[where.id] ?? null,
            findMany: async () =>
                Object.entries(cameraZones)
                    .filter(
                        ([, camera]) =>
                            camera.roomId === ROOM ||
                            (!camera.roomId && camera.zone.toLowerCase() === "suite 12")
                    )
                    .map(([id, camera]) => ({ roomId: null, ...camera, id }))
        },
        placeRoom: {
            findMany: async ({ where }: { where: { name?: { equals: string } } }) =>
                [{ id: ROOM, name: "Suite 12", placeId: PLACE }].filter(
                    (room) =>
                        !where.name || room.name.toLowerCase() === where.name.equals.toLowerCase()
                )
        }
    }
}));

const sharing = await import("@polaris-app/places/src/lib/sharing");

const GUEST = { id: "u7", isAdmin: false } as unknown as SessionUser;

beforeEach(() => {
    deviceRooms = { "door-12": ROOM, "lamp-12": ROOM, "door-14": null };
    cameraZones = { "cam-hall": { placeId: PLACE, zone: "suite 12" } };
    lent = {
        [`place.room:${ROOM}`]: [
            { id: "g-room", capability: "control", counted: false, actions: ["watch", "open"] }
        ]
    };
    vi.clearAllMocks();
});

describe("a room lent as one key", () => {
    it("covers what is in the room, and a device put in it later", async () => {
        expect((await sharing.placesReach(GUEST)).devices.has("door-14")).toBe(false);
        deviceRooms["door-14"] = ROOM;
        const reach = await sharing.placesReach(GUEST);
        expect([...reach.devices.keys()].sort()).toEqual(["door-12", "door-14", "lamp-12"]);
        expect(reach.deviceActions.get("door-14")).toEqual(["open"]);
        expect(reach.cameras.has("cam-hall")).toBe(true);
    });

    it("stops covering a device taken out of the room", async () => {
        deviceRooms["lamp-12"] = null;
        expect((await sharing.placesReach(GUEST)).devices.has("lamp-12")).toBe(false);
        await expect(sharing.requireDeviceControl(GUEST, "lamp-12", "unlock")).rejects.toThrow();
    });

    it("opens a door in the room with the room's grant, and says it was the room's", async () => {
        const grant = await sharing.requireDeviceControl(GUEST, "door-12", "unlock");
        expect(grant).toMatchObject({ id: "g-room", subjectType: "place.room", subjectId: ROOM });
    });

    it("refuses what the room's key does not allow, and logs the refusal", async () => {
        await expect(sharing.requireDeviceControl(GUEST, "door-12", "lock")).rejects.toThrow();
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({
                grantId: "g-room",
                subjectType: "place.room",
                targetId: "door-12",
                outcome: "refused"
            })
        );
    });

    it("lets the room's cameras be watched, and no other", async () => {
        expect(await sharing.mayWatchCamera(GUEST, "cam-hall")).toBe(true);
        cameraZones["cam-hall"] = { placeId: PLACE, zone: "Lobby" };
        expect(await sharing.mayWatchCamera(GUEST, "cam-hall")).toBe(false);
    });

    it("shows none of its cameras when the room was lent without watch", async () => {
        lent[`place.room:${ROOM}`] = [
            { id: "g-room", capability: "control", counted: false, actions: ["open"] }
        ];
        const reach = await sharing.placesReach(GUEST);
        expect(reach.cameras.has("cam-hall")).toBe(false);
        expect(reach.devices.has("door-12")).toBe(true);
        expect(await sharing.mayWatchCamera(GUEST, "cam-hall")).toBe(false);
        await sharing.logCameraWatch(GUEST, "cam-hall");
        expect(recordGrantUse).not.toHaveBeenCalled();
    });
});

describe("check-in and check-out", () => {
    // A stay from Friday 15:00 to Sunday 11:00, Madrid time.
    const stay = {
        startsAt: new Date("2026-05-08T13:00:00Z"),
        endsAt: new Date("2026-05-10T09:00:00Z"),
        days: core.EVERY_DAY,
        startMinute: null,
        endMinute: null,
        timeZone: "Europe/Madrid",
        maxUses: null,
        uses: 0
    };

    it("does not open before check-in", () => {
        expect(core.judgeGrant(stay, new Date("2026-05-08T12:59:00Z")).standing).toBe("waiting");
    });

    it("opens during the stay", () => {
        expect(core.judgeGrant(stay, new Date("2026-05-09T23:00:00Z")).standing).toBe("live");
    });

    it("ends at the check-out time, not at the end of the day", () => {
        expect(core.judgeGrant(stay, new Date("2026-05-10T08:59:00Z")).standing).toBe("live");
        expect(core.judgeGrant(stay, new Date("2026-05-10T09:01:00Z")).standing).toBe("expired");
    });

    it("can be handed out as a link to the room", () => {
        expect(core.isGrantLinkSubject("place.room")).toBe(true);
        expect(core.linkCapabilities("place.room")).toEqual(["view", "control"]);
    });
});

describe("a stay typed in the share dialog", () => {
    it("starts at check-in and ends at check-out on the days picked", () => {
        const from = core.dayAt("2026-05-08", "15:00")!;
        const to = core.dayAt("2026-05-10", "11:00")!;
        expect([from.getHours(), from.getMinutes()]).toEqual([15, 0]);
        expect([to.getDate(), to.getHours()]).toEqual([10, 11]);
        expect(core.dayAt("2026-05-10", "25:00")).toBeNull();
    });
});

describe("a visitor watching a camera", () => {
    it("is logged once, against the room's key", async () => {
        await sharing.logCameraWatch(GUEST, "cam-hall");
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({
                grantId: "g-room",
                subjectType: "place.room",
                targetId: "cam-hall",
                action: "watch",
                outcome: "done"
            })
        );
    });
});

describe("a camera put in the room itself", () => {
    it("is covered by its room column, whatever its zone says", async () => {
        cameraZones["cam-desk"] = { placeId: PLACE, zone: "Front desk", roomId: ROOM };
        expect((await sharing.placesReach(GUEST)).cameras.has("cam-desk")).toBe(true);
        expect(await sharing.mayWatchCamera(GUEST, "cam-desk")).toBe(true);
    });

    it("is not covered by a zone that names the room once it is in another", async () => {
        cameraZones["cam-hall"] = { placeId: PLACE, zone: "suite 12", roomId: "another-room" };
        expect((await sharing.placesReach(GUEST)).cameras.has("cam-hall")).toBe(false);
        expect(await sharing.mayWatchCamera(GUEST, "cam-hall")).toBe(false);
    });
});
