/**
 * A change from the selection bar writes only the tasks it would change, and
 * "undo" puts back what each one said before - not one value for all of them,
 * since a selection rarely started out in one status or one priority.
 */

import { describe, expect, it } from "vitest";
import type { PersonRef, TaskRow } from "@/lib/tasks/facts";
import { affected, changes, undoSteps } from "@/app/(app)/tasks/bulk-edits";

const ANA: PersonRef = { id: "u1", name: "Ana Ruiz" };
const LUIS: PersonRef = { id: "u2", name: "Luis Gil" };

function row(id: string, overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        id,
        reference: `FJRG-${id}`,
        name: `Task ${id}`,
        description: "",
        spaceId: "s1",
        spaceName: "Space",
        listId: "l1",
        listName: "List",
        folderName: null,
        parentId: null,
        statusId: "open",
        statusName: "Open",
        statusColor: "#64748b",
        statusType: "open",
        priority: "none",
        assignees: [],
        tags: [],
        createdById: null,
        startDate: null,
        dueDate: null,
        timed: false,
        timeEstimate: null,
        points: null,
        milestone: false,
        archived: false,
        order: 1,
        sprintId: null,
        completedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        subtaskCount: 0,
        commentCount: 0,
        trackedSeconds: 0,
        blocked: false,
        blockedUntil: null,
        blockedNote: "",
        recurring: false,
        customValues: {},
        ...overrides
    };
}

const ids = (tasks: readonly TaskRow[]) => tasks.map((task) => task.id);

describe("what a bulk change reaches", () => {
    it("leaves out the tasks that already have the value", () => {
        const tasks = [row("1", { statusId: "done" }), row("2"), row("3")];
        expect(ids(affected(tasks, { statusId: "done" }))).toEqual(["2", "3"]);
        expect(changes(tasks[0]!, { statusId: "done" })).toBe(false);
    });

    it("counts an assignee as a change only where the person is not on the task yet", () => {
        const tasks = [row("1", { assignees: [ANA] }), row("2", { assignees: [LUIS] })];
        expect(ids(affected(tasks, { addAssigneeIds: ["u1"] }))).toEqual(["2"]);
    });

    it("measures priority and archiving the same way", () => {
        const tasks = [row("1", { priority: "urgent" }), row("2", { archived: true })];
        expect(ids(affected(tasks, { priority: "urgent" }))).toEqual(["2"]);
        expect(ids(affected(tasks, { archived: true }))).toEqual(["1"]);
    });

    it("treats a change it does not measure as reaching every task", () => {
        expect(affected([row("1")], { dueDate: "2026-02-01" })).toHaveLength(1);
    });
});

describe("taking a bulk change back", () => {
    it("puts each task back in the status it had, one write per status", () => {
        const before = [row("1", { statusId: "open" }), row("2", { statusId: "review" }), row("3")];
        const steps = undoSteps(before, { statusId: "done" });
        expect(steps.map((step) => [step.change, ids(step.tasks)])).toEqual([
            [{ statusId: "open" }, ["1", "3"]],
            [{ statusId: "review" }, ["2"]]
        ]);
    });

    it("leaves a task that had no status where the change put it", () => {
        const steps = undoSteps([row("1", { statusId: null })], { statusId: "done" });
        expect(steps).toEqual([]);
    });

    it("restores each priority", () => {
        const before = [row("1", { priority: "low" }), row("2", { priority: "high" })];
        expect(undoSteps(before, { priority: "urgent" }).map((step) => step.change)).toEqual([
            { priority: "low" },
            { priority: "high" }
        ]);
    });

    it("takes a person off only the tasks they were not already on", () => {
        const before = [row("1", { assignees: [ANA] }), row("2")];
        const steps = undoSteps(before, { addAssigneeIds: ["u1", "u2"] });
        expect(steps.map((step) => [step.change, ids(step.tasks)])).toEqual([
            [{ removeAssigneeIds: ["u1"] }, ["2"]],
            [{ removeAssigneeIds: ["u2"] }, ["1", "2"]]
        ]);
    });

    it("unarchives what it archived", () => {
        expect(undoSteps([row("1")], { archived: true })).toEqual([
            { tasks: [row("1")], change: { archived: false } }
        ]);
        expect(undoSteps([], { archived: true })).toEqual([]);
    });
});
