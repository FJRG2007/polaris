/**
 * A task written with Polaris out of reach: sent at once when it can be, kept
 * on the device when it cannot, a change behind a change folded into one, a
 * create carrying the id it will be made with, and everything for a task that
 * is still waiting kept in line behind it, sent in order when Polaris answers.
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createTaskAction = vi.fn();
const updateTaskAction = vi.fn();
const moveTaskAction = vi.fn();
vi.mock("@/app/(app)/tasks/actions", () => ({
    createTaskAction: (input: unknown) => createTaskAction(input),
    updateTaskAction: (input: unknown) => updateTaskAction(input),
    moveTaskAction: (input: unknown) => moveTaskAction(input)
}));
vi.mock("@/lib/reachability", () => ({
    noteRequestFailure: () => undefined,
    isNetworkFailure: (caught: unknown) => caught instanceof TypeError
}));
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: async () => undefined }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { TASK_CREATE, TASK_MOVE, TASK_UPDATE, writeTask } = await import("@/app/(app)/tasks/offline-writes");

const TASK = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const LIST = "0190a1b2-c3d4-7e5f-8a9b-000000000002";
const unreachable = () => new TypeError("Failed to fetch");

async function drained(): Promise<void> {
    appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
}

const waiting = async () =>
    (await appWrites.readAll())
        .filter((entry) => entry.kind.startsWith("task."))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    for (const action of [createTaskAction, updateTaskAction, moveTaskAction]) action.mockReset();
});

describe("a task's offline writes", () => {
    it("sends at once and answers what the action answered when Polaris is there", async () => {
        updateTaskAction.mockResolvedValue({});
        const failure = vi.fn();
        const result = await writeTask(TASK_UPDATE, { taskId: TASK, name: "Ship" }, failure);
        expect(result).toEqual({});
        expect(updateTaskAction).toHaveBeenCalledWith({ taskId: TASK, name: "Ship" });
        expect(await waiting()).toHaveLength(0);
        expect(failure).not.toHaveBeenCalled();
    });

    it("hands a refusal back to the screen instead of keeping it", async () => {
        updateTaskAction.mockResolvedValue({ error: "No access" });
        const result = await writeTask(TASK_UPDATE, { taskId: TASK, name: "Ship" }, vi.fn());
        expect(result).toEqual({ error: "No access" });
        expect(await waiting()).toHaveLength(0);
    });

    it("fails as it always did when the server threw, instead of keeping it", async () => {
        updateTaskAction.mockRejectedValue(new Error("boom"));
        const failure = vi.fn();
        expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "Ship" }, failure)).toBeNull();
        expect(failure).toHaveBeenCalledWith(expect.stringMatching(/\S/));
        expect(await waiting()).toHaveLength(0);
    });

    it("says it failed when there is no account on the device to keep it under", async () => {
        offlineStore.setOwner(null);
        updateTaskAction.mockRejectedValue(unreachable());
        const failure = vi.fn();
        expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "Ship" }, failure)).toBeNull();
        expect(failure).toHaveBeenCalledWith(expect.stringMatching(/\S/));
    });

    it("keeps a change on the device when Polaris cannot be reached, and folds the next one into it", async () => {
        updateTaskAction.mockRejectedValue(unreachable());
        expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "One", priority: 2 }, vi.fn())).toEqual({ queued: true });
        await drained();
        // Something for this task is waiting, so the second is not tried ahead of it.
        updateTaskAction.mockClear();
        expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "Two" }, vi.fn())).toEqual({ queued: true });
        expect(updateTaskAction).not.toHaveBeenCalled();
        const kept = await waiting();
        expect(kept).toHaveLength(1);
        expect(kept[0]?.payload).toEqual({ taskId: TASK, name: "Two", priority: 2 });
    });

    it("keeps a move behind a change as its own entry, and sends both in order when Polaris answers", async () => {
        updateTaskAction.mockRejectedValue(unreachable());
        await writeTask(TASK_UPDATE, { taskId: TASK, name: "One" }, vi.fn());
        await writeTask(TASK_MOVE, { taskId: TASK, listId: LIST }, vi.fn());
        expect((await waiting()).map((entry) => entry.kind)).toEqual([TASK_UPDATE, TASK_MOVE]);

        const order: string[] = [];
        updateTaskAction.mockImplementation(async () => (order.push("update"), {}));
        moveTaskAction.mockImplementation(async () => (order.push("move"), {}));
        await drained();
        expect(order).toEqual(["update", "move"]);
        expect(await waiting()).toHaveLength(0);
    });

    it("keeps the order of writes kept within the same millisecond", async () => {
        vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2026-11-24T12:00:00.000Z") });
        try {
            const keys = ["f", "e", "d", "c", "b", "a"];
            for (const key of keys)
                await appWrites.enqueue({ key, kind: TASK_UPDATE, target: TASK, payload: { taskId: TASK, name: key } });
            const stamps = (await waiting()).map((entry) => (entry.payload as { name: string }).name);
            expect(stamps).toEqual(keys);
        } finally {
            vi.useRealTimers();
        }
    });

    it("makes a task with an id of its own, and sends that same id when it is replayed", async () => {
        createTaskAction.mockRejectedValueOnce(unreachable());
        const result = await writeTask(TASK_CREATE, { listId: LIST, name: "Offline" }, vi.fn());
        expect(result).toEqual({ queued: true });
        const sentFirst = createTaskAction.mock.calls[0]?.[0] as { id: string };
        expect(sentFirst.id).toMatch(/^[0-9a-f-]{36}$/);
        const [kept] = await waiting();
        expect(kept?.target).toBe(sentFirst.id);

        createTaskAction.mockResolvedValue({ id: sentFirst.id, reference: "ENG-1" });
        await drained();
        expect(createTaskAction.mock.calls.at(-1)?.[0]).toMatchObject({ id: sentFirst.id, name: "Offline" });
        expect(await waiting()).toHaveLength(0);
    });

    it("keeps a subtask under a parent still waiting behind the parent's create, and sends it after", async () => {
        createTaskAction.mockRejectedValueOnce(unreachable());
        await writeTask(TASK_CREATE, { listId: LIST, name: "Parent" }, vi.fn());
        const parent = (createTaskAction.mock.calls[0]?.[0] as { id: string }).id;
        createTaskAction.mockClear();

        // Polaris answers again, but the parent has not been sent yet.
        const order: string[] = [];
        createTaskAction.mockImplementation(async (input: { id: string; name: string }) => (order.push(input.name), { id: input.id }));
        expect(await writeTask(TASK_CREATE, { listId: LIST, name: "Child", parentId: parent }, vi.fn())).toEqual({
            queued: true
        });
        await drained();
        expect(order).toEqual(["Parent", "Child"]);
        expect(await waiting()).toHaveLength(0);
    });

    it("keeps a move placed next to a task still waiting behind it", async () => {
        createTaskAction.mockRejectedValueOnce(unreachable());
        await writeTask(TASK_CREATE, { listId: LIST, name: "New" }, vi.fn());
        const made = (createTaskAction.mock.calls[0]?.[0] as { id: string }).id;
        expect(await writeTask(TASK_MOVE, { taskId: TASK, afterId: made }, vi.fn())).toEqual({ queued: true });
        expect(moveTaskAction).not.toHaveBeenCalled();
    });

    it("never folds two creates together", async () => {
        createTaskAction.mockRejectedValue(unreachable());
        await writeTask(TASK_CREATE, { listId: LIST, name: "A" }, vi.fn());
        await writeTask(TASK_CREATE, { listId: LIST, name: "B" }, vi.fn());
        expect((await waiting()).map((entry) => (entry.payload as { name: string }).name).sort()).toEqual(["A", "B"]);
    });

    it("does not try the network while the device says it is offline", async () => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        try {
            expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "Plane" }, vi.fn())).toEqual({ queued: true });
            expect(updateTaskAction).not.toHaveBeenCalled();
            expect(await waiting()).toHaveLength(1);
        } finally {
            // The own property goes; the prototype's getter is back.
            delete (navigator as { onLine?: boolean }).onLine;
        }
    });
});
