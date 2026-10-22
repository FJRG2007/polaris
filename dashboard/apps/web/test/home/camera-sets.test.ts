/**
 * Rooms and camera sets as privacy targets: which cameras each names, and the
 * checks a set passes before it is stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    camera: { findMany: vi.fn(), count: vi.fn() },
    cameraSet: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    place: { findFirst: vi.fn() }
}));
vi.mock("@polaris/db", () => ({ prisma: db }));

import { camerasFor } from "@polaris-app/places/src/lib/privacy";
import { saveCameraSet, deleteCameraSet } from "@polaris-app/places/src/lib/camera-sets";
import {
    cameraSetInputSchema,
    normalizeCameraSetInput
} from "@polaris-app/places/src/lib/privacy-kinds";

const INSTALL = "0192f2a4-6c1e-7c3a-9a40-000000000001";
const PLACE = "0192f2a4-6c1e-7c3a-9a40-1d2b3c4d5e6f";
const ROOM = "0192f2a4-6c1e-7c3a-9a40-bbbbbbbbbbbb";
const SET = "0192f2a4-6c1e-7c3a-9a40-cccccccccccc";
const A = "0192f2a4-6c1e-7c3a-9a40-aaaaaaaaaaa1";
const B = "0192f2a4-6c1e-7c3a-9a40-aaaaaaaaaaa2";

beforeEach(() => {
    for (const table of Object.values(db)) for (const fn of Object.values(table)) fn.mockReset();
    db.camera.findMany.mockResolvedValue([{ id: A }]);
});

describe("which cameras a target names", () => {
    it("a room: the cameras in it, in this install only", async () => {
        expect(await camerasFor(INSTALL, { kind: "room", id: ROOM })).toEqual([A]);
        expect(db.camera.findMany.mock.calls[0]![0].where).toEqual({
            installedAppId: INSTALL,
            roomId: ROOM
        });
    });

    it("a set: its cameras that are still at its place", async () => {
        db.cameraSet.findFirst.mockResolvedValue({ placeId: PLACE, cameraIds: [A, B] });
        expect(await camerasFor(INSTALL, { kind: "set", id: SET })).toEqual([A]);
        expect(db.cameraSet.findFirst.mock.calls[0]![0].where).toEqual({
            id: SET,
            installedAppId: INSTALL
        });
        expect(db.camera.findMany.mock.calls[0]![0].where).toEqual({
            installedAppId: INSTALL,
            placeId: PLACE,
            id: { in: [A, B] }
        });
    });

    it("a set that is not this install's names nothing", async () => {
        db.cameraSet.findFirst.mockResolvedValue(null);
        expect(await camerasFor(INSTALL, { kind: "set", id: SET })).toEqual([]);
        expect(db.camera.findMany).not.toHaveBeenCalled();
    });
});

describe("saving a set", () => {
    const input = { placeId: PLACE, name: "Upstairs", cameraIds: [A, B] };

    it("normalizes before it validates: trimmed name, each camera once", () => {
        const parsed = cameraSetInputSchema.safeParse(
            normalizeCameraSetInput({
                placeId: PLACE,
                name: "  Up   stairs ",
                cameraIds: [A, A.toUpperCase(), B]
            })
        );
        expect(parsed.success && parsed.data).toEqual({
            placeId: PLACE,
            name: "Up stairs",
            cameraIds: [A, B]
        });
        expect(
            cameraSetInputSchema.safeParse({ placeId: PLACE, name: "x", cameraIds: [] }).success
        ).toBe(false);
    });

    it("refuses a camera from another place", async () => {
        db.place.findFirst.mockResolvedValue({ id: PLACE });
        db.camera.count.mockResolvedValue(1);
        await expect(saveCameraSet(INSTALL, null, input)).rejects.toThrow(
            "A camera in that set is not at this place"
        );
        expect(db.cameraSet.create).not.toHaveBeenCalled();
    });

    it("refuses a place that is not this install's", async () => {
        db.place.findFirst.mockResolvedValue(null);
        await expect(saveCameraSet(INSTALL, null, input)).rejects.toThrow("Place not found");
    });

    it("stores a set whose cameras are all at its place", async () => {
        db.place.findFirst.mockResolvedValue({ id: PLACE });
        db.camera.count.mockResolvedValue(2);
        db.cameraSet.create.mockResolvedValue({ id: SET, ...input });
        expect(await saveCameraSet(INSTALL, null, input)).toEqual({ id: SET, ...input });
        expect(db.cameraSet.create.mock.calls[0]![0].data.installedAppId).toBe(INSTALL);
    });

    it("says so when a set to remove is not there", async () => {
        db.cameraSet.deleteMany.mockResolvedValue({ count: 0 });
        await expect(deleteCameraSet(INSTALL, SET)).rejects.toThrow("Camera set not found");
    });
});
