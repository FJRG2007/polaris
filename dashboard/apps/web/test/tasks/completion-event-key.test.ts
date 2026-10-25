/**
 * A task finished again after being reopened is a new completion: the second
 * one has to reach the automations listening, not be taken for a repeat of
 * the first.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const emitted: { name: string; key: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        task: {
            findMany: async () => [{ id: "t1", name: "Ship it", listId: "l1", spaceId: "s1" }]
        },
        taskAutomation: { findMany: async () => [] }
    }
}));
vi.mock("@/lib/automations/app-events", () => ({
    anyListening: async () => true,
    emitAppEvent: async (name: string, _payload: unknown, options: { key: string }) => {
        emitted.push({ name, key: options.key });
        return true;
    }
}));
vi.mock("@/lib/tasks/access", () => ({ requireTask: async () => undefined }));

const { runAutomationsFor } = await import("../../src/lib/tasks/automation-service");

afterEach(() => {
    emitted.length = 0;
    vi.useRealTimers();
});

describe("task event keys", () => {
    it("keys a completion by when it happened, and a creation by the task alone", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
        await runAutomationsFor({
            trigger: "task.completed",
            taskIds: ["t1"],
            actorId: null
        } as never);
        vi.setSystemTime(new Date("2026-03-01T10:05:00.000Z"));
        await runAutomationsFor({
            trigger: "task.completed",
            taskIds: ["t1"],
            actorId: null
        } as never);
        await runAutomationsFor({
            trigger: "task.created",
            taskIds: ["t1"],
            actorId: null
        } as never);
        const completions = emitted.filter((event) => event.name === "task.completed");
        expect(completions).toHaveLength(2);
        expect(completions[0].key).not.toBe(completions[1].key);
        expect(completions.every((event) => event.key.startsWith("t1:"))).toBe(true);
        expect(emitted.find((event) => event.name === "task.created")?.key).toBe("t1");
    });
});
