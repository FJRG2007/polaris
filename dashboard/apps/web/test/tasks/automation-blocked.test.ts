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

const taskFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const automationFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const automationUpdate = vi.fn(async (_args: unknown) => ({}));
const dependencyFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const activityCreateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const taskUpdate = vi.fn(async (_args: unknown) => ({}));

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findMany: taskFindMany, update: taskUpdate },
        taskAutomation: { findMany: automationFindMany, update: automationUpdate },
        taskDependency: { findMany: dependencyFindMany },
        activity: { createMany: activityCreateMany }
    }
}));

const { runAutomations, runAutomationsFor } = await import("../../src/lib/tasks/automation-service");

/** The projection the engine loads, with the parts a block can come from. */
function facts(id: string, overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id,
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
    };
}

/** The one task the engine will load for this call. */
function task(overrides: Partial<Record<string, unknown>> = {}) {
    taskFindMany.mockResolvedValueOnce([facts("t1", overrides)]);
}

/** One rule: when the status changes and the task is blocked, archive it. */
function blockedRule(values: string[] = ["true"]) {
    automationFindMany.mockResolvedValueOnce([
        {
            id: "r1",
            name: "Flag it",
            spaceId: SPACE,
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
        dependencyFindMany.mockResolvedValueOnce([{ blockedId: "t1", blocker: { status: { type: "active" } } }]);

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
        dependencyFindMany.mockResolvedValueOnce([{ blockedId: "t1", blocker: { status: { type: "done" } } }]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(false);
    });

    it("matches the other way for a task nothing is holding up", async () => {
        task();
        blockedRule(["false"]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
    });

    it("does not ask what blocks a task when no rule reads it", async () => {
        task();
        automationFindMany.mockResolvedValueOnce([
            {
                id: "r2",
                name: "Always",
                spaceId: SPACE,
                trigger: "task.statusChanged",
                listId: null,
                enabled: true,
                conditions: JSON.stringify({ match: "all", conditions: [] }),
                actions: JSON.stringify([{ type: "archive" }])
            }
        ]);

        await runAutomations({ trigger: "task.statusChanged", taskId: "t1", actorId: null });

        expect(ran()).toBe(true);
        expect(dependencyFindMany).not.toHaveBeenCalled();
    });
});

describe("a rule raised for a selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dependencyFindMany.mockResolvedValue([]);
    });

    it("reads the rows, the rules and the blockers once for the whole batch", async () => {
        taskFindMany.mockResolvedValueOnce([
            facts("t1", { status: { type: "blocked" } }),
            facts("t2", { status: { type: "blocked" } }),
            facts("t3")
        ]);
        blockedRule();

        await runAutomationsFor({ trigger: "task.statusChanged", taskIds: ["t1", "t2", "t3"], actorId: null });

        expect(taskFindMany).toHaveBeenCalledTimes(1);
        expect(automationFindMany).toHaveBeenCalledTimes(1);
        expect(dependencyFindMany).toHaveBeenCalledTimes(1);
        // Two of the three matched, so the rule is one write carrying two runs.
        expect(automationUpdate).toHaveBeenCalledTimes(1);
        expect(automationUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ runCount: { increment: 2 } }) })
        );
        expect(taskUpdate).toHaveBeenCalledTimes(2);
    });

    it("does nothing at all for an empty selection", async () => {
        await runAutomationsFor({ trigger: "task.statusChanged", taskIds: [], actorId: null });

        expect(taskFindMany).not.toHaveBeenCalled();
    });
});
