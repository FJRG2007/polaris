/**
 * What happens when the bin cannot take something.
 *
 * Pressing Delete used to be able to end in "An error occurred in the Server
 * Components render" - Next's redacted text for an action that threw - which
 * tells the person nothing and hides which of several very different problems
 * they hit. So two things are pinned here: the cases the bin should absorb
 * quietly, and the case it must refuse in words rather than by throwing.
 *
 * The refusal that matters is a source with no connection row behind it - a
 * server or a container browsed directly. The bin is a database row pointing at
 * a moved file, and there is nothing there for it to point at: without this
 * guard the file is moved first and the bookkeeping fails afterwards, which
 * loses it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "018f2b7a-0000-7000-8000-0000000000a1";
const CONNECTION = "018f2b7a-0000-7000-8000-0000000000e1";

const stat = vi.fn(async () => ({ kind: "dir" as const, size: 0n }));
const move = vi.fn(async () => undefined);
const mkdir = vi.fn(async () => undefined);
const dispose = vi.fn(async () => undefined);
const create = vi.fn(async () => ({ id: "trash-1" }));

vi.mock("@polaris/db", () => ({ prisma: { trashItem: { create } } }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/storage-service", () => ({
    getDriver: async () => ({ stat, move, mkdir, dispose })
}));

const { moveToTrash, TrashUnavailableError } = await import("../../src/lib/trash-service");

beforeEach(() => {
    vi.clearAllMocks();
    stat.mockResolvedValue({ kind: "dir", size: 0n });
});

describe("moveToTrash", () => {
    it("moves an item into the bin and records where it came from", async () => {
        await moveToTrash(OWNER, CONNECTION, "test34");
        expect(move).toHaveBeenCalledWith("test34", expect.stringContaining(".polaris/trash/"));
        expect(create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ originalPath: "test34", name: "test34" })
            })
        );
    });

    it("refuses a source the bin cannot record against, before moving anything", async () => {
        await expect(
            moveToTrash(OWNER, "host:018f2b7a-0000-7000-8000-0000000000f1", "a.txt")
        ).rejects.toBeInstanceOf(TrashUnavailableError);
        expect(move).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it("says what to do instead rather than only that it failed", async () => {
        await expect(moveToTrash(OWNER, "container:abc", "a.txt")).rejects.toThrow(
            /Delete permanently/
        );
    });

    it("treats an item that is already gone as done", async () => {
        // Two people pressing Delete on the same row, or a listing that has gone
        // stale: the end state asked for is already true.
        stat.mockRejectedValue(new Error("not found"));
        await expect(moveToTrash(OWNER, CONNECTION, "test34")).resolves.toBeUndefined();
        expect(move).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it("never puts Polaris's own folder in the bin", async () => {
        await moveToTrash(OWNER, CONNECTION, ".polaris");
        await moveToTrash(OWNER, CONNECTION, ".polaris/trash");
        expect(move).not.toHaveBeenCalled();
    });
});
