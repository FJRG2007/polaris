/**
 * What a change applied to a selection does beyond writing the rows.
 *
 * The same verbs reach this from the bulk toolbar and from a right-click on a
 * single task, so what a status change means must not depend on which one was
 * used: the rules run, a recurring job comes back, whoever was just handed the
 * work hears about it, and the history says what moved rather than that
 * something did.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SPACE = "s1";
const ACTOR = "u-actor";

interface BeforeRow {
    id: string;
    spaceId: string;
    name: string;
    listId: string;
    statusId: string | null;
    priority: string;
    dueDate: Date | null;
    completedAt: Date | null;
    recurrence: string | null;
}

const taskFindMany = vi.fn(async () => [] as BeforeRow[]);
const taskUpdateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const taskFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const taskUpdate = vi.fn(async (_args: unknown) => ({}));
const statusFindUnique = vi.fn(async (_args: unknown) => null as unknown);
const statusFindMany = vi.fn(async (_args: unknown) => [] as { id: string; name: string }[]);
const statusFindFirst = vi.fn(async (_args: unknown) => null as unknown);
const assigneeFindMany = vi.fn(async (_args: unknown) => [] as { taskId: string; userId: string }[]);
const assigneeDeleteMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const assigneeCreateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const tagFindMany = vi.fn(async (_args: unknown) => [] as { taskId: string; tagId: string }[]);
const activityCreateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const activityCreate = vi.fn(async (_args: unknown) => ({}));
const activityCount = vi.fn(async (_args: unknown) => 0);

vi.mock("@polaris/db", () => ({
    prisma: {
        task: { findMany: taskFindMany, updateMany: taskUpdateMany, findUnique: taskFindUnique, update: taskUpdate },
        taskStatus: { findUnique: statusFindUnique, findMany: statusFindMany, findFirst: statusFindFirst },
        taskAssignee: {
            findMany: assigneeFindMany,
            deleteMany: assigneeDeleteMany,
            createMany: assigneeCreateMany
        },
        taskTagLink: { findMany: tagFindMany, deleteMany: vi.fn(), createMany: vi.fn() },
        taskActivity: { createMany: activityCreateMany, create: activityCreate, count: activityCount }
    }
}));

const notify = vi.fn(async (_input: unknown) => undefined);
vi.mock("@/lib/notifications/dispatch", () => ({ notify }));

const runAutomations = vi.fn(async (_event: unknown) => undefined);
const runAutomationsFor = vi.fn(async (_event: unknown) => undefined);
const hasAutomationsFor = vi.fn(async () => true);
vi.mock("../../src/lib/tasks/automation-service", () => ({
    runAutomations,
    runAutomationsFor,
    hasAutomationsFor
}));

const { bulkUpdate } = await import("../../src/lib/tasks/task-service");

function row(overrides: Partial<BeforeRow> & { id: string }): BeforeRow {
    return {
        spaceId: SPACE,
        name: `Task ${overrides.id}`,
        listId: "l1",
        statusId: "todo",
        priority: "none",
        dueDate: null,
        completedAt: null,
        recurrence: null,
        ...overrides
    };
}

/** The selection, as the access layer hands it over. */
function selection(rows: BeforeRow[]) {
    taskFindMany.mockResolvedValueOnce(rows);
    return rows.map((entry) => ({ id: entry.id, spaceId: entry.spaceId }));
}

/** A status of this space, resolved by `statusInSpace` and then named. */
function status(id: string, type: string, name = id) {
    statusFindUnique.mockResolvedValueOnce({ id, name, type, spaceId: SPACE });
    statusFindMany.mockResolvedValueOnce([
        { id: "todo", name: "To do" },
        { id, name }
    ]);
}

/** Every history line the call wrote, flattened. */
function lines(): { taskId: string; action: string; fromValue: string | null; toValue: string | null }[] {
    return activityCreateMany.mock.calls.flatMap(
        ([args]) => (args as { data: { taskId: string; action: string; fromValue: string; toValue: string }[] }).data
    );
}

/** Which tasks a trigger was raised for. One call carries the whole set, so a
 *  selection costs the engine one pass per trigger rather than one per row. */
function raisedFor(trigger: string): string[] {
    return runAutomationsFor.mock.calls
        .map(([event]) => event as { trigger: string; taskIds: string[] })
        .filter((event) => event.trigger === trigger)
        .flatMap((event) => event.taskIds);
}

describe("applying a change to a selection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hasAutomationsFor.mockResolvedValue(true);
    });

    it("writes the line that says what moved, per row", async () => {
        const allowed = selection([row({ id: "a" }), row({ id: "b", statusId: "doing" })]);
        status("doing", "active", "In progress");

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], statusId: "doing" });

        expect(lines()).toEqual([
            { taskId: "a", userId: ACTOR, action: "status", fromValue: "To do", toValue: "In progress" },
            // Already there: nothing moved, so nothing is claimed to have.
            { taskId: "b", userId: ACTOR, action: "bulk", fromValue: null, toValue: null }
        ]);
    });

    it("raises the rules only for the rows something happened to", async () => {
        const allowed = selection([row({ id: "a" }), row({ id: "b", statusId: "done" })]);
        status("done", "done", "Done");

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], statusId: "done" });

        expect(raisedFor("task.statusChanged")).toEqual(["a"]);
        expect(raisedFor("task.completed")).toEqual(["a"]);
    });

    it("asks once whether the spaces have any rules at all", async () => {
        hasAutomationsFor.mockResolvedValue(false);
        const allowed = selection([row({ id: "a" })]);
        status("doing", "active", "In progress");

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a"], statusId: "doing" });

        expect(hasAutomationsFor).toHaveBeenCalledTimes(1);
        expect(runAutomationsFor).not.toHaveBeenCalled();
    });

    it("brings a recurring task back instead of leaving it finished", async () => {
        const recurrence = JSON.stringify({ mode: "weekly", interval: 1, weekdays: [1], basis: "schedule" });
        const allowed = selection([row({ id: "a", recurrence, dueDate: new Date("2026-01-05T00:00:00.000Z") })]);
        status("done", "done", "Done");
        taskFindUnique.mockResolvedValueOnce({
            recurrence,
            startDate: null,
            dueDate: new Date("2026-01-05T00:00:00.000Z"),
            spaceId: SPACE
        });
        statusFindFirst.mockResolvedValueOnce({ id: "todo" });

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a"], statusId: "done" });

        expect(taskUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "a" }, data: expect.objectContaining({ completedAt: null }) })
        );
        expect(activityCreate).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ action: "recurred" }) })
        );
    });

    it("keeps the completion date a task was already carrying", async () => {
        const stamped = new Date("2026-01-02T10:00:00.000Z");
        const allowed = selection([row({ id: "a" }), row({ id: "b", statusId: "done", completedAt: stamped })]);
        status("closed", "closed", "Cancelled");

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], statusId: "closed" });

        const written = taskUpdateMany.mock.calls.map(
            ([args]) => args as { where: { id: { in: string[] } }; data: Record<string, unknown> }
        );
        // The whole selection takes the status, and only the row with no stamp
        // takes a completion date.
        expect(written[0]?.where.id.in).toEqual(["a", "b"]);
        expect(written[0]?.data).not.toHaveProperty("completedAt");
        expect(written[1]?.where.id.in).toEqual(["a"]);
        expect(written[1]?.data.completedAt).toBeInstanceOf(Date);
    });

    it("tells the people it is news to, and nobody else", async () => {
        const allowed = selection([row({ id: "a" }), row({ id: "b" })]);
        assigneeFindMany.mockResolvedValueOnce([{ taskId: "b", userId: "u-dev" }]);

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], addAssigneeIds: ["u-dev"] });

        // Already on "b", so this is one task's worth of news, named as itself.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u-dev", href: "/tasks/t/a" }));
        expect(raisedFor("task.assigneeAdded")).toEqual(["a"]);
    });

    it("raises the tag rules only where the tag is new", async () => {
        const allowed = selection([row({ id: "a" }), row({ id: "b" })]);
        tagFindMany.mockResolvedValueOnce([{ taskId: "b", tagId: "bug" }]);

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], addTagIds: ["bug"] });

        expect(raisedFor("task.tagAdded")).toEqual(["a"]);
    });

    it("says once that a person was put on several, rather than once per task", async () => {
        const allowed = selection([row({ id: "a" }), row({ id: "b" })]);

        await bulkUpdate(ACTOR, allowed, { taskIds: ["a", "b"], addAssigneeIds: ["u-dev", ACTOR] });

        // Nothing for the person doing the assigning, one line for the other.
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith(
            expect.objectContaining({ userId: "u-dev", title: "2 tasks assigned to you" })
        );
    });
});
