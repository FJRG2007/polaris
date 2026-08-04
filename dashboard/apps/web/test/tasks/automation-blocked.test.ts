/**
 * A rule that asks whether a task is blocked.
 *
 * The condition is offered wherever a filter is built, so it has to mean the
 * same thing to the engine as it does on a board: the stage the task sits in,
 * unfinished work it depends on, a date it waits for, or a reason somebody
 * wrote. A rule that saves fine and never fires is worse than one that cannot
 * be written at all.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "s1";

const taskFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const automationFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const automationUpdate = vi.fn(async (_args: unknown) => ({}));
const dependencyFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const activityCreate = vi.fn(async (_args: unknown) => ({}));
const taskUpdate = vi.fn(async (_args: unknown) => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findUnique: taskFindUnique, update: taskUpdate },
        taskAutomation: { findMany: automationFindMany, update: automationUpdate },
        taskDependency: { findMany: dependencyFindMany },
        taskActivity: { create: activityCreate }
    }
}));

const { runAutomations } = await import("../../src/lib/tasks/automation-service");

/** The projection the engine loads, with the parts a block can come from. */
function task(overrides: Partial<Record<string, unknown>> = {}) {
    taskFindUnique.mockResolvedValueOnce({
        id: "t1",
        name: "Ship it",
        spaceId: SPACE,
        listId: "l1",
        parentId: null,
        statusId: "todo",
        priority: "none",
        startDate: null,
        dueDate: null,
        timed: false,
        points: null,
        timeEstimate: null,
        archived: false,
        order: 1024,
        blockedUntil: null,
        blockedNote: "",
        completedAt: null,
        createdById: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: { type: "open" },
        assignees: [],
        watchers: [],
        tags: [],
        fieldValues: [],
        ...overrides
    });
}

/** One rule: when the status changes and the task is blocked, add a comment. */
function blockedRule(values: string[] = ["true"]) {
    automationFindMany.mockResolvedValueOnce([
        {
            id: "r1",
            name: "Flag it",
            trigger: "task.statusChanged",
            listId: null,
            enabled: true,
            conditions: JSON.stringify({
                match: "all",
                conditions: [{ field: "blocked", operator: "is", values }]
            }),
            actions: JSON.stringify([{ type: "archive" }])
        }
    ]);
}

/** Whether the rule ran, which is what the action and the counter record. */
function ran(): boolean {
    return automationUpdate.mock.calls.length > 0;
}

describe("a rule conditioned on blocked", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dependencyFindMany.mockResolvedValue([]);
    });

    it("fires for a task sitting in a stage of the blocked kind", async () => {
        task({ status: { type: "blocked" } });
        blockedRule();

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
    });

    it("fires for a task waiting on unfinished work", async () => {
        task();
        blockedRule();
        dependencyFindMany.mockResolvedValueOnce([{ blocker: { status: { type: "active" } } }]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
    });

    it("fires for a reason somebody wrote down", async () => {
        task({ blockedNote: "Waiting on legal" });
        blockedRule();

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
    });

    it("does not fire once the blocker is finished and nothing else holds it", async () => {
        task();
        blockedRule();
        dependencyFindMany.mockResolvedValueOnce([{ blocker: { status: { type: "done" } } }]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(false);
    });

    it("matches the other way for a task nothing is holding up", async () => {
        task();
        blockedRule(["false"]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
    });
});
