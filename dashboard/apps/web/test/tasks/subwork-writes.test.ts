/**
 * The writes behind arranging and renaming the work inside a task.
 *
 * Every one names the task the caller was authorized for and keeps to it: a
 * checklist, step or link id says nothing about which task it is on. A
 * dependency is drawn on two tasks and keeps an order on each, so moving it in
 * one task's list must only ever touch that list's key.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const taskDependency = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn()
};
const taskChecklist = { findFirst: vi.fn(), updateMany: vi.fn() };
const taskChecklistItem = { findFirst: vi.fn(), updateMany: vi.fn() };
const task = { findFirst: vi.fn() };

vi.mock("@polaris/db", () => ({
    prisma: {
        taskDependency,
        taskChecklist,
        taskChecklistItem,
        task,
        $transaction: async (operations: unknown[]) => Promise.all(operations)
    }
}));

// Only the writes are under test; what the service would notify or run after
// one is not, and reaching it drags in the whole sign-in stack.
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/follow/follow", () => ({}));
vi.mock("@/lib/comments/comments", () => ({}));
vi.mock("@/lib/tasks/automation-service", () => ({ runAutomations: vi.fn() }));
vi.mock("@/lib/rich-text/mention-notify", () => ({ notifyMentions: vi.fn() }));
vi.mock("@/lib/tasks/shelf", () => ({ spaceShelf: vi.fn() }));
vi.mock("@/lib/i18n/translate", () => ({ translate: vi.fn() }));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: vi.fn() }));

const details = await import("@/lib/tasks/task-detail-service");

const TASK = "task-1";

beforeEach(() => {
    for (const model of [taskDependency, taskChecklist, taskChecklistItem, task]) {
        for (const method of Object.values(model)) (method as ReturnType<typeof vi.fn>).mockReset();
    }
    taskDependency.updateMany.mockResolvedValue({ count: 1 });
    taskDependency.create.mockResolvedValue({});
    taskChecklist.updateMany.mockResolvedValue({ count: 1 });
    taskChecklistItem.updateMany.mockResolvedValue({ count: 1 });
});

describe("moving a dependency", () => {
    it("writes the waiting-on key, between neighbours read from this task's list", async () => {
        taskDependency.findFirst
            .mockResolvedValueOnce({ blockingOrder: 9000, waitingOrder: 1024 })
            .mockResolvedValueOnce({ blockingOrder: 1, waitingOrder: 2048 });
        await details.moveDependency(TASK, "edge-3", {
            direction: "waitingOn",
            beforeId: "edge-1",
            afterId: "edge-2"
        });
        expect(taskDependency.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "edge-1", blockedId: TASK } })
        );
        expect(taskDependency.updateMany).toHaveBeenCalledWith({
            where: { id: "edge-3", blockedId: TASK },
            data: { waitingOrder: 1536 }
        });
    });

    it("writes the blocking key for the other list, and nothing else", async () => {
        taskDependency.findFirst.mockResolvedValueOnce({ blockingOrder: 1024, waitingOrder: 7 });
        await details.moveDependency(TASK, "edge-3", {
            direction: "blocking",
            beforeId: null,
            afterId: "edge-1"
        });
        expect(taskDependency.updateMany).toHaveBeenCalledWith({
            where: { id: "edge-3", blockerId: TASK },
            data: { blockingOrder: 0 }
        });
    });

    it("re-spaces the list when the gap has run out", async () => {
        taskDependency.findFirst
            .mockResolvedValueOnce({ blockingOrder: 0, waitingOrder: 1024 })
            .mockResolvedValueOnce({ blockingOrder: 0, waitingOrder: 1024.0001 })
            .mockResolvedValueOnce({ blockingOrder: 0, waitingOrder: 1024 })
            .mockResolvedValueOnce({ blockingOrder: 0, waitingOrder: 2048 });
        taskDependency.findMany.mockResolvedValue([{ id: "edge-1" }, { id: "edge-2" }]);
        taskDependency.update.mockResolvedValue({});
        await details.moveDependency(TASK, "edge-3", {
            direction: "waitingOn",
            beforeId: "edge-1",
            afterId: "edge-2"
        });
        expect(taskDependency.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { blockedId: TASK } })
        );
        expect(taskDependency.update).toHaveBeenCalledTimes(2);
        expect(taskDependency.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { waitingOrder: 1536 } })
        );
    });

    it("refuses a neighbour that is not in this task's list", async () => {
        taskDependency.findFirst.mockResolvedValueOnce(null);
        await expect(
            details.moveDependency(TASK, "edge-3", {
                direction: "waitingOn",
                beforeId: "elsewhere",
                afterId: null
            })
        ).rejects.toThrow();
        expect(taskDependency.updateMany).not.toHaveBeenCalled();
    });

    it("refuses a link that is not on this task", async () => {
        taskDependency.updateMany.mockResolvedValue({ count: 0 });
        await expect(
            details.moveDependency(TASK, "other-task-edge", {
                direction: "blocking",
                beforeId: null,
                afterId: null
            })
        ).rejects.toThrow();
    });
});

describe("linking two tasks", () => {
    it("puts the new link at the end of both lists it is drawn in", async () => {
        task.findFirst.mockResolvedValue({ id: "task-2" });
        taskDependency.findMany.mockResolvedValue([]);
        taskDependency.findFirst
            .mockResolvedValueOnce({ blockingOrder: 3072 })
            .mockResolvedValueOnce(null);
        await details.addDependency("space-1", {
            taskId: TASK,
            relatedTaskId: "task-2",
            type: "blocks",
            reverse: false
        });
        expect(taskDependency.create).toHaveBeenCalledWith({
            data: {
                blockerId: TASK,
                blockedId: "task-2",
                type: "blocks",
                blockingOrder: 4096,
                waitingOrder: 1024
            }
        });
    });
});

describe("renaming", () => {
    it("renames a checklist only on the authorized task", async () => {
        await details.renameChecklist(TASK, "list-1", "Launch");
        expect(taskChecklist.updateMany).toHaveBeenCalledWith({
            where: { id: "list-1", taskId: TASK },
            data: { name: "Launch" }
        });
    });

    it("refuses a checklist on another task", async () => {
        taskChecklist.updateMany.mockResolvedValue({ count: 0 });
        await expect(details.renameChecklist(TASK, "theirs", "Launch")).rejects.toThrow();
    });

    it("rewords a step only on a checklist of the authorized task", async () => {
        await details.renameChecklistItem(TASK, "step-1", "Ship it");
        expect(taskChecklistItem.updateMany).toHaveBeenCalledWith({
            where: { id: "step-1", checklist: { taskId: TASK } },
            data: { name: "Ship it" }
        });
    });

    it("refuses a step on another task", async () => {
        taskChecklistItem.updateMany.mockResolvedValue({ count: 0 });
        await expect(details.renameChecklistItem(TASK, "theirs", "Ship it")).rejects.toThrow();
    });
});

describe("moving a checklist", () => {
    it("reads its neighbours on the same task only", async () => {
        taskChecklist.findFirst.mockResolvedValueOnce({ order: 1024 });
        await details.moveChecklist(TASK, "list-2", { beforeId: "list-1", afterId: null });
        expect(taskChecklist.findFirst).toHaveBeenCalledWith({
            where: { id: "list-1", taskId: TASK },
            select: { order: true }
        });
        expect(taskChecklist.updateMany).toHaveBeenCalledWith({
            where: { id: "list-2", taskId: TASK },
            data: { order: 2048 }
        });
    });
});
