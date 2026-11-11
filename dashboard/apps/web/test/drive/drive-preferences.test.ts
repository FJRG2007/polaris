/**
 * Drive's per-account settings: an account with no row reads the defaults, a
 * stored document that is broken or older still reads, and a change that
 * changes nothing writes nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, string>());
const upsert = vi.hoisted(() => vi.fn());

vi.mock("@polaris/db", () => ({
    prisma: {
        drivePreference: {
            findUnique: async ({ where }: { where: { userId: string } }) =>
                rows.has(where.userId) ? { value: rows.get(where.userId)! } : null,
            upsert: async (args: { where: { userId: string }; create: { value: string } }) => {
                upsert(args);
                rows.set(args.where.userId, args.create.value);
            }
        }
    }
}));

const prefs = await import("@/lib/drive-preferences");

beforeEach(() => {
    rows.clear();
    upsert.mockClear();
});

describe("Drive settings", () => {
    it("asks before the bin until somebody says otherwise", async () => {
        const defaults = { confirmTrash: true, trashKeepDays: 0 };
        expect(await prefs.loadDrivePreferences("u1")).toEqual(defaults);
        expect(prefs.readDrivePreferences("not json")).toEqual(defaults);
        expect(prefs.readDrivePreferences(JSON.stringify({ confirmTrash: "no" }))).toEqual(
            defaults
        );
    });

    it("keeps a change, and writes nothing for one that changes nothing", async () => {
        expect(await prefs.saveDrivePreferences("u1", { confirmTrash: true })).toEqual({
            confirmTrash: true,
            trashKeepDays: 0
        });
        expect(upsert).not.toHaveBeenCalled();
        expect(await prefs.saveDrivePreferences("u1", { confirmTrash: false })).toEqual({
            confirmTrash: false,
            trashKeepDays: 0
        });
        expect(await prefs.loadDrivePreferences("u1")).toEqual({
            confirmTrash: false,
            trashKeepDays: 0
        });
        expect(upsert).toHaveBeenCalledTimes(1);
    });

    it("keeps the bin until it is emptied, and takes only the offered ages", async () => {
        expect(await prefs.saveDrivePreferences("u1", { trashKeepDays: 1 })).toMatchObject({
            trashKeepDays: 1
        });
        expect(await prefs.saveDrivePreferences("u1", { trashKeepDays: 30 })).toMatchObject({
            trashKeepDays: 30
        });
        await expect(prefs.saveDrivePreferences("u1", { trashKeepDays: 3 })).rejects.toThrow();
        // A stored age no longer offered reads as the default, never as itself.
        expect(prefs.readDrivePreferences(JSON.stringify({ trashKeepDays: 3 }))).toMatchObject({
            trashKeepDays: 0
        });
        expect(prefs.DRIVE_TRASH_KEEP_DAYS).toEqual([0, 1, 7, 30, 60, 90]);
    });
});
