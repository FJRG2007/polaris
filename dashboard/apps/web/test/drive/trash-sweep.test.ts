/**
 * Drive's bin empties itself at the age its owner chose: only what is older,
 * only for somebody who chose an age, and the files go with the rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 24 * 60 * 60 * 1000;
const deleted = vi.hoisted(() => [] as string[]);
const state = vi.hoisted(() => ({
    prefs: [] as { userId: string; value: string }[],
    items: [] as {
        id: string;
        ownerId: string;
        connectionId: string;
        trashPath: string;
        deletedAt: Date;
    }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        drivePreference: { findMany: async () => state.prefs },
        trashItem: {
            findMany: async ({
                where
            }: {
                where: { ownerId: string; deletedAt?: { lt: Date }; id?: { in: string[] } };
            }) =>
                state.items.filter(
                    (item) =>
                        item.ownerId === where.ownerId &&
                        (!where.deletedAt || item.deletedAt < where.deletedAt.lt) &&
                        (!where.id || where.id.in.includes(item.id))
                ),
            deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                state.items = state.items.filter((item) => !where.id.in.includes(item.id));
                return { count: where.id.in.length };
            }
        }
    }
}));
vi.mock("@/lib/storage-service", () => ({
    getDriver: async () => ({
        delete: async (path: string) => {
            deleted.push(path);
        },
        dispose: async () => undefined
    })
}));
vi.mock("@/lib/drive-folder-size", () => ({
    invalidateFolderSizes: async () => undefined,
    invalidateFolderSizesMany: async () => undefined
}));

const { sweepDriveTrash } = await import("@/lib/trash-service");

const item = (id: string, ownerId: string, ageDays: number) => ({
    id,
    ownerId,
    connectionId: "c1",
    trashPath: `/.trash/${id}`,
    deletedAt: new Date(Date.now() - ageDays * DAY)
});

beforeEach(() => {
    deleted.length = 0;
    state.prefs = [];
    state.items = [];
});

describe("the Drive bin sweep", () => {
    it("deletes only what is older than the owner's choice, files and rows", async () => {
        state.prefs = [{ userId: "ana", value: JSON.stringify({ trashKeepDays: 30 }) }];
        state.items = [item("old", "ana", 31), item("new", "ana", 2)];
        expect(await sweepDriveTrash()).toBe(1);
        expect(deleted).toEqual(["/.trash/old"]);
        expect(state.items.map((row) => row.id)).toEqual(["new"]);
    });

    it("keeps everything for somebody who keeps the bin until they empty it", async () => {
        state.prefs = [
            { userId: "ana", value: JSON.stringify({ trashKeepDays: 0 }) },
            { userId: "bea", value: JSON.stringify({ trashKeepDays: 3 }) }
        ];
        state.items = [item("a", "ana", 400), item("b", "bea", 400)];
        expect(await sweepDriveTrash()).toBe(0);
        expect(deleted).toEqual([]);
        expect(state.items).toHaveLength(2);
    });
});
