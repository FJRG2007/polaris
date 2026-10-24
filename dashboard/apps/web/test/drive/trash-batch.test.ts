/**
 * Restoring or deleting a selection from the bin opens one connection per
 * storage connection, not one per item, and removes the finished rows in one
 * write. A refusal on one item leaves its row in the bin and the rest go.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";

const stat = vi.fn(async () => {
    throw new Error("missing");
});
const move = vi.fn(async (_from: string, _to: string) => undefined);
const remove = vi.fn(async () => undefined);
const dispose = vi.fn(async () => undefined);
const getDriver = vi.fn(async () => ({ stat, move, delete: remove, dispose }));
const findMany = vi.fn();
const deleteMany = vi.fn(async () => ({ count: 0 }));

vi.mock("@polaris/db", () => ({ prisma: { trashItem: { findMany, deleteMany } } }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/storage-service", () => ({ getDriver }));

const { restoreTrashItems, deleteTrashItemsForever, restoreTrash } =
    await import("../../src/lib/trash-service");

function row(id: string, connectionId: string) {
    return {
        id,
        ownerId: OWNER,
        connectionId,
        name: id,
        originalPath: `docs/${id}`,
        trashPath: `.polaris/trash/x-${id}`,
        kind: "file",
        size: 1n,
        deletedAt: new Date()
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    findMany.mockResolvedValue([row("a", "c1"), row("b", "c1"), row("c", "c2")]);
});

describe("restoreTrashItems", () => {
    it("opens one driver per connection and removes the rows in one write", async () => {
        const outcome = await restoreTrashItems(OWNER, ["a", "b", "c"]);
        expect(getDriver).toHaveBeenCalledTimes(2);
        expect(move).toHaveBeenCalledTimes(3);
        expect(dispose).toHaveBeenCalledTimes(2);
        expect(deleteMany).toHaveBeenCalledTimes(1);
        expect(deleteMany).toHaveBeenCalledWith({
            where: { ownerId: OWNER, id: { in: ["a", "b", "c"] } }
        });
        expect(outcome.done.sort()).toEqual(["a", "b", "c"]);
        expect(outcome.failures).toEqual([]);
    });

    it("keeps a refused item in the bin and finishes the others", async () => {
        move.mockImplementation(async (from: string) => {
            if (from.endsWith("-b")) throw new Error("locked");
        });
        const outcome = await restoreTrashItems(OWNER, ["a", "b", "c"]);
        expect(outcome.failures.map((failure) => failure.id)).toEqual(["b"]);
        expect(deleteMany).toHaveBeenCalledWith({
            where: { ownerId: OWNER, id: { in: ["a", "c"] } }
        });
        move.mockReset();
    });

    it("counts an id that is not the owner's row as already done", async () => {
        findMany.mockResolvedValue([]);
        const outcome = await restoreTrashItems(OWNER, ["gone"]);
        expect(outcome.done).toEqual(["gone"]);
        expect(getDriver).not.toHaveBeenCalled();
        expect(deleteMany).not.toHaveBeenCalled();
    });

    it("still throws from the single-item restore when it fails", async () => {
        findMany.mockResolvedValue([row("a", "c1")]);
        move.mockRejectedValueOnce(new Error("locked"));
        await expect(restoreTrash(OWNER, "a")).rejects.toThrow("locked");
    });
});

describe("deleteTrashItemsForever", () => {
    it("deletes over one driver per connection and drops every row", async () => {
        const outcome = await deleteTrashItemsForever(OWNER, ["a", "b", "c"]);
        expect(getDriver).toHaveBeenCalledTimes(2);
        expect(remove).toHaveBeenCalledTimes(3);
        expect(deleteMany).toHaveBeenCalledTimes(1);
        expect(outcome.done.sort()).toEqual(["a", "b", "c"]);
    });
});
