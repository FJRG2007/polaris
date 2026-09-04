/**
 * A write about a space's vocabulary has to say which space.
 *
 * The actions authorize against a space the caller names, and then hand the
 * service the id of the row to change. If the write is keyed on that row alone,
 * administering any space at all is enough to rename, recolour or delete a
 * status, tag or field belonging to a space the caller has no part in - and, in
 * the delete case, to move another space's tasks onto a column they own. Every
 * write here is asserted to carry its space, and to refuse rather than quietly
 * do nothing when the row is not in it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const taskStatus = {
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn()
};
const taskTag = { updateMany: vi.fn(), deleteMany: vi.fn() };
const taskCustomField = { updateMany: vi.fn(), deleteMany: vi.fn() };
const task = { updateMany: vi.fn(), deleteMany: vi.fn() };

vi.mock("@polaris/db", () => ({
    prisma: {
        taskStatus,
        taskTag,
        taskCustomField,
        task,
        $transaction: async (operations: unknown[]) => Promise.all(operations)
    }
}));

const spaces = await import("@/lib/tasks/space-service");

const SPACE = "space-1";
const OTHER = "row-in-another-space";

beforeEach(() => {
    for (const model of [taskStatus, taskTag, taskCustomField, task]) {
        for (const method of Object.values(model)) (method as ReturnType<typeof vi.fn>).mockReset();
    }
    taskStatus.updateMany.mockResolvedValue({ count: 1 });
    taskStatus.deleteMany.mockResolvedValue({ count: 1 });
    taskStatus.count.mockResolvedValue(3);
    taskStatus.findFirst.mockResolvedValue({ id: "st1" });
    taskTag.updateMany.mockResolvedValue({ count: 1 });
    taskTag.deleteMany.mockResolvedValue({ count: 1 });
    taskCustomField.updateMany.mockResolvedValue({ count: 1 });
    taskCustomField.deleteMany.mockResolvedValue({ count: 1 });
    task.updateMany.mockResolvedValue({ count: 0 });
});

const field = { name: "Impact", type: "text" as const, config: {}, required: false, showOnCard: false };

describe("a status", () => {
    it("is renamed only inside the space that was authorized", async () => {
        await spaces.updateStatus(SPACE, "st1", { name: "Doing", type: "active", color: "#3b82f6" });
        expect(taskStatus.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "st1", spaceId: SPACE } })
        );
    });

    it("refuses a rename aimed at another space's status", async () => {
        taskStatus.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            spaces.updateStatus(SPACE, OTHER, { name: "Doing", type: "active", color: "#3b82f6" })
        ).rejects.toThrow(/not in this space/);
    });

    it("moves and removes only this space's rows when deleted", async () => {
        await spaces.deleteStatus(SPACE, "st1", { kind: "move", replacementId: "st2" });
        expect(task.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { statusId: "st1", spaceId: SPACE } })
        );
        expect(taskStatus.deleteMany).toHaveBeenCalledWith({ where: { id: "st1", spaceId: SPACE } });
    });

    it("takes the work with the column when that is what was asked for", async () => {
        // The one gesture on a board that destroys work, so it only happens on
        // being asked for by name.
        await spaces.deleteStatus(SPACE, "st1", { kind: "delete" });
        expect(task.deleteMany).toHaveBeenCalledWith({
            where: { statusId: "st1", spaceId: SPACE }
        });
        expect(task.updateMany).not.toHaveBeenCalled();
        expect(taskStatus.deleteMany).toHaveBeenCalledWith({ where: { id: "st1", spaceId: SPACE } });
    });

    it("archives the work instead, onto a column that is staying", async () => {
        // A task carries a status, so archiving it still means moving it off the
        // column that is going - which is why this is not just a flag.
        await spaces.deleteStatus(SPACE, "st1", { kind: "archive" });
        expect(task.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { statusId: "st1", spaceId: SPACE },
                data: expect.objectContaining({ archived: true })
            })
        );
        expect(task.deleteMany).not.toHaveBeenCalled();
    });

    it("refuses to delete a status that is not in the space", async () => {
        // The status itself is elsewhere: nothing was authorized about it.
        taskStatus.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(where.id === OTHER ? null : { id: where.id })
        );
        await expect(
            spaces.deleteStatus(SPACE, OTHER, { kind: "move", replacementId: "st2" })
        ).rejects.toThrow(/not in this space/);
        expect(task.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a replacement from another space, which would move work out of sight", async () => {
        taskStatus.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(where.id === OTHER ? null : { id: where.id })
        );
        await expect(
            spaces.deleteStatus(SPACE, "st1", { kind: "move", replacementId: OTHER })
        ).rejects.toThrow(/not in this space/);
        expect(task.updateMany).not.toHaveBeenCalled();
    });

    it("still keeps a space from losing its last one", async () => {
        taskStatus.count.mockResolvedValue(1);
        await expect(
            spaces.deleteStatus(SPACE, "st1", { kind: "move", replacementId: "st2" })
        ).rejects.toThrow(/at least one status/);
    });
});

describe("a tag", () => {
    it("is written inside its space, and refused outside it", async () => {
        await spaces.updateTag(SPACE, "tag1", "Urgent", "#ef4444");
        expect(taskTag.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "tag1", spaceId: SPACE } })
        );

        taskTag.deleteMany.mockResolvedValue({ count: 0 });
        await expect(spaces.deleteTag(SPACE, OTHER)).rejects.toThrow(/not in this space/);
    });
});

describe("a custom field", () => {
    it("is written inside its space, and refused outside it", async () => {
        await spaces.updateCustomField(SPACE, "f1", field);
        expect(taskCustomField.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "f1", spaceId: SPACE } })
        );

        taskCustomField.deleteMany.mockResolvedValue({ count: 0 });
        await expect(spaces.deleteCustomField(SPACE, OTHER)).rejects.toThrow(/not in this space/);
    });
});
