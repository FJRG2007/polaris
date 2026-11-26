/**
 * Writes made while Polaris is updating: the dashboard restarting answers
 * nothing (or the edge answers for it), then a newer build answers that has
 * never heard of this tab's action ids. Neither is the reader's fault, so
 * neither is reported as a failed request - a queued write is kept and sent
 * once, with the same id, by the page that has the new build; any other save
 * waits for Polaris and is sent again when it answers.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createTaskAction = vi.fn();
const updateTaskAction = vi.fn();
const moveTaskAction = vi.fn();
vi.mock("@/app/(app)/tasks/actions", () => ({
    createTaskAction: (input: unknown) => createTaskAction(input),
    updateTaskAction: (input: unknown) => updateTaskAction(input),
    moveTaskAction: (input: unknown) => moveTaskAction(input)
}));
const checkForNewBuild = vi.fn(async (_options?: unknown) => false);
vi.mock("@/lib/new-build", () => ({ checkForNewBuild: (options: unknown) => checkForNewBuild(options) }));

const { appWrites, dropOfflineStore, offlineStore } = await import("@/lib/offline/app-writes");
const { TASK_CREATE, TASK_UPDATE, writeTask } = await import("@/app/(app)/tasks/offline-writes");
const { OUTAGE_WAIT_MS, actionFailureText, callsWaiting, resetCallsWaiting, runAction } = await import(
    "@/lib/run-action"
);
const { resetReachability } = await import("@/lib/reachability");

const TASK = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const LIST = "0190a1b2-c3d4-7e5f-8a9b-000000000002";

/** What Next throws when the server is a newer build than the tab. */
const replacedBuild = () =>
    new Error(
        "Server Action \"7f3a\" was not found on the server. \nRead more: https://nextjs.org/docs/messages/failed-to-find-server-action"
    );
/** What Next throws when the edge answers for a dashboard that is not there. */
const edgeAnswered = () => new Error("An unexpected response was received from the server.");

/** The probe route: down until `up` is set. */
let up = false;
const fetchMock = vi.fn(async () => {
    if (!up) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify({ build: "b2" }), { status: 200 });
});

async function drained(): Promise<void> {
    appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    appWrites.flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
}

const waiting = async () => (await appWrites.readAll()).filter((entry) => entry.kind.startsWith("task."));

beforeEach(async () => {
    await dropOfflineStore();
    offlineStore.setOwner("u1");
    for (const action of [createTaskAction, updateTaskAction, moveTaskAction]) action.mockReset();
    checkForNewBuild.mockClear();
    resetReachability();
    resetCallsWaiting();
    up = false;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("a task typed while Polaris is updating", () => {
    it("is kept, not reported, when a newer build answers, and asks for the reload", async () => {
        updateTaskAction.mockRejectedValue(replacedBuild());
        const failure = vi.fn();
        expect(await writeTask(TASK_UPDATE, { taskId: TASK, name: "Typed during the update" }, failure)).toEqual({
            queued: true
        });
        expect(failure).not.toHaveBeenCalled();
        expect(checkForNewBuild).toHaveBeenCalledWith({ failed: true });
        expect(await waiting()).toHaveLength(1);
    });

    it("is held by the old page without using up attempts, then sent once by the reloaded one", async () => {
        updateTaskAction.mockRejectedValue(replacedBuild());
        await writeTask(TASK_UPDATE, { taskId: TASK, name: "One" }, vi.fn());
        // This tab cannot send it, however often it flushes.
        for (let flush = 0; flush < 8; flush += 1) await drained();
        const held = await waiting();
        expect(held).toHaveLength(1);
        expect(held[0]?.state).toBe("pending");
        expect(held[0]?.attempts).toBe(0);

        // The page after the reload: the action exists again.
        updateTaskAction.mockReset();
        updateTaskAction.mockResolvedValue({});
        await drained();
        expect(updateTaskAction).toHaveBeenCalledTimes(1);
        expect(updateTaskAction).toHaveBeenCalledWith({ taskId: TASK, name: "One" });
        expect(await waiting()).toHaveLength(0);
    });

    it("keeps a task made during the restart under the id it will have, so it is made once", async () => {
        createTaskAction.mockRejectedValue(edgeAnswered());
        const failure = vi.fn();
        expect(await writeTask(TASK_CREATE, { listId: LIST, name: "New" }, failure)).toEqual({ queued: true });
        expect(failure).not.toHaveBeenCalled();
        const first = createTaskAction.mock.calls[0]?.[0] as { id: string };

        createTaskAction.mockReset();
        createTaskAction.mockImplementation(async (input: { id: string }) => ({ id: input.id }));
        await drained();
        await drained();
        expect(createTaskAction).toHaveBeenCalledTimes(1);
        expect((createTaskAction.mock.calls[0]?.[0] as { id: string }).id).toBe(first.id);
        expect(await waiting()).toHaveLength(0);
    });
});

describe("any other save made while Polaris is down", () => {
    it("waits for Polaris and is sent again when it answers, with nothing reported", async () => {
        vi.useFakeTimers();
        const call = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ ok: true });
        const failure = vi.fn();
        const result = runAction(call, failure);
        await vi.advanceTimersByTimeAsync(0);
        expect(callsWaiting()).toBe(1);
        expect(call).toHaveBeenCalledTimes(1);

        // Still restarting at the first probe after the backoff.
        await vi.advanceTimersByTimeAsync(2000);
        expect(call).toHaveBeenCalledTimes(1);

        up = true;
        await vi.advanceTimersByTimeAsync(4000);
        expect(await result).toEqual({ ok: true });
        expect(call).toHaveBeenCalledTimes(2);
        expect(failure).not.toHaveBeenCalled();
        expect(callsWaiting()).toBe(0);
    });

    it("fails at once, without sending again, when Polaris answers and only this request did not", async () => {
        up = true;
        const call = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        const failure = vi.fn();
        expect(await runAction(call, failure)).toBeNull();
        expect(call).toHaveBeenCalledTimes(1);
        expect(failure).toHaveBeenCalledWith(actionFailureText());
    });

    it("says to reload, not to try again, when a newer build answered", async () => {
        const call = vi.fn().mockRejectedValue(replacedBuild());
        const failure = vi.fn();
        expect(await runAction(call, failure)).toBeNull();
        expect(call).toHaveBeenCalledTimes(1);
        expect(failure).toHaveBeenCalledWith(expect.stringMatching(/updated/i));
        expect(failure).not.toHaveBeenCalledWith(actionFailureText());
    });

    it("gives up and says so after an outage longer than any update", async () => {
        vi.useFakeTimers();
        const call = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        const failure = vi.fn();
        const result = runAction(call, failure);
        await vi.advanceTimersByTimeAsync(OUTAGE_WAIT_MS + 1000);
        expect(await result).toBeNull();
        expect(call).toHaveBeenCalledTimes(1);
        expect(failure).toHaveBeenCalledWith(actionFailureText());
        expect(callsWaiting()).toBe(0);
    });
});
