/**
 * A whole place lent as one key - a holiday let, a family member's house.
 * It reaches every door, switch and camera at the place when it is asked, not
 * what was there when the key was cut, and only the people who run the house
 * may hand it out.
 */

import type { SessionUser } from "@/lib/session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const PLACE = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";

/** Which place each device and camera is at, as the database would answer now. */
let devicePlaces: Record<string, string | null> = {};
let cameraPlaces: Record<string, string | null> = {};
let lent: Record<
    string,
    { id: string; capability: string; counted: boolean; actions: string[] }[]
> = {};
const recordGrantUse = vi.fn(async (_use: Record<string, unknown>) => undefined);

vi.mock("@/lib/session", () => ({ sessionCan: async () => false }));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async (_user: string, subject: string, id: string) =>
        lent[`${subject}:${id}`] ?? [],
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

const atPlaces = (rows: Record<string, string | null>, ids: string[]) =>
    Object.entries(rows)
        .filter(([, placeId]) => placeId && ids.includes(placeId))
        .map(([id, placeId]) => ({ id, placeId, roomId: null }));

vi.mock("@polaris/db", () => ({
    prisma: {
        placeDevice: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id in devicePlaces ? { roomId: null, placeId: devicePlaces[where.id] } : null,
            findMany: async ({ where }: { where: { placeId?: { in: string[] } } }) =>
                where.placeId ? atPlaces(devicePlaces, where.placeId.in) : []
        },
        camera: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id in cameraPlaces
                    ? { placeId: cameraPlaces[where.id], zone: null, roomId: null }
                    : null,
            findMany: async ({ where }: { where: { placeId?: { in: string[] } } }) =>
                where.placeId ? atPlaces(cameraPlaces, where.placeId.in) : []
        },
        placeRoom: { findMany: async () => [] }
    }
}));

const sharing = await import("@polaris-app/places/src/lib/sharing");
const core = await import("@polaris/core");

const GUEST = { id: "u7", isAdmin: false } as unknown as SessionUser;

beforeEach(() => {
    devicePlaces = { "front-door": PLACE, "garage": PLACE, "office-door": OTHER };
    cameraPlaces = { "cam-yard": PLACE, "cam-office": OTHER };
    lent = {
        [`place.place:${PLACE}`]: [
            { id: "g-place", capability: "control", counted: false, actions: ["watch", "open"] }
        ]
    };
    vi.clearAllMocks();
});

describe("a whole place lent as one key", () => {
    it("is a grant subject of its own, with a room key's actions", () => {
        expect(core.isGrantSubject("place.place")).toBe(true);
        expect(core.GRANT_CAPABILITIES["place.place"]).toEqual(["view", "control"]);
        expect(core.GRANT_ACTIONS["place.place"]).toEqual(["watch", "open", "close", "operate"]);
        // People, teams and roles: never handed out as a link.
        expect(core.isGrantLinkSubject("place.place")).toBe(false);
    });

    it("covers every device and camera at the place, and nothing at another", async () => {
        const reach = await sharing.placesReach(GUEST);
        expect([...reach.devices.keys()].sort()).toEqual(["front-door", "garage"]);
        expect(reach.deviceActions.get("garage")).toEqual(["open"]);
        expect(reach.cameras.has("cam-yard")).toBe(true);
        expect(reach.cameras.has("cam-office")).toBe(false);
        expect(sharing.reachesNothing(reach)).toBe(false);
    });

    it("covers a device brought to the place later, and drops one moved away", async () => {
        devicePlaces["office-door"] = PLACE;
        devicePlaces["garage"] = OTHER;
        const reach = await sharing.placesReach(GUEST);
        expect([...reach.devices.keys()].sort()).toEqual(["front-door", "office-door"]);
    });

    it("opens a door with the place's grant, and says it was the place's", async () => {
        const grant = await sharing.requireDeviceControl(GUEST, "front-door", "unlock");
        expect(grant).toMatchObject({ id: "g-place", subjectType: "place.place", subjectId: PLACE });
        await expect(sharing.requireDeviceView(GUEST, "garage")).resolves.toBeUndefined();
    });

    it("refuses what the key does not allow, and anything at another place", async () => {
        await expect(sharing.requireDeviceControl(GUEST, "front-door", "lock")).rejects.toThrow();
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({ grantId: "g-place", subjectType: "place.place" })
        );
        await expect(sharing.requireDeviceControl(GUEST, "office-door", "unlock")).rejects.toThrow();
        await expect(sharing.requireDeviceView(GUEST, "office-door")).rejects.toThrow();
    });

    it("lets the place's cameras be watched and logs it against the place's key", async () => {
        expect(await sharing.mayWatchCamera(GUEST, "cam-yard")).toBe(true);
        expect(await sharing.mayWatchCamera(GUEST, "cam-office")).toBe(false);
        await sharing.logCameraWatch(GUEST, "cam-yard");
        expect(recordGrantUse).toHaveBeenCalledWith(
            expect.objectContaining({
                grantId: "g-place",
                subjectType: "place.place",
                targetId: "cam-yard",
                action: "watch"
            })
        );
    });

    it("shows no camera when the place was lent without watch", async () => {
        lent[`place.place:${PLACE}`] = [
            { id: "g-place", capability: "view", counted: false, actions: [] }
        ];
        const reach = await sharing.placesReach(GUEST);
        expect(reach.cameras.size).toBe(0);
        expect(reach.devices.get("front-door")).toBe("view");
        expect(await sharing.mayWatchCamera(GUEST, "cam-yard")).toBe(false);
    });
});
