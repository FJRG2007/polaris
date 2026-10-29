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
        expect(await prefs.loadDrivePreferences("u1")).toEqual({ confirmTrash: true });
        expect(prefs.readDrivePreferences("not json")).toEqual({ confirmTrash: true });
        expect(prefs.readDrivePreferences(JSON.stringify({ confirmTrash: "no" }))).toEqual({
            confirmTrash: true
        });
    });

    it("keeps a change, and writes nothing for one that changes nothing", async () => {
        expect(await prefs.saveDrivePreferences("u1", { confirmTrash: true })).toEqual({
            confirmTrash: true
        });
        expect(upsert).not.toHaveBeenCalled();
        expect(await prefs.saveDrivePreferences("u1", { confirmTrash: false })).toEqual({
            confirmTrash: false
        });
        expect(await prefs.loadDrivePreferences("u1")).toEqual({ confirmTrash: false });
        expect(upsert).toHaveBeenCalledTimes(1);
    });
});
