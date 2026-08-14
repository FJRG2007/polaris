/**
 * What a task edit shows before the server has answered.
 *
 * Assigning somebody is the control people use most and the one that felt slowest,
 * because several screens sent the change and then waited for a reload to repaint.
 * The resolution that makes the repaint possible - ids in, names and colours out -
 * is what this covers, plus the two ways it can go wrong quietly: a key nobody
 * touched being erased, and a shape the row cannot draw being copied in from the
 * wider patch the task panel sends.
 */

import { describe, expect, it } from "vitest";
import type { TaskRow } from "../../src/lib/tasks/facts";
import { bulkOverlay, taskOverlay, wouldChange } from "../../src/app/(app)/tasks/optimistic";

const context = {
    statuses: [
        { id: "s1", name: "In progress", color: "#3b82f6", type: "active" as const },
        { id: "s2", name: "Done", color: "#22c55e", type: "closed" as const }
    ],
    people: [
        { id: "u1", name: "Ada", email: "ada@example.com", image: null },
        { id: "u2", name: "Grace", email: "grace@example.com", image: null }
    ],
    tags: [
        { id: "t1", name: "bug", color: "#ef4444" },
        { id: "t2", name: "chore", color: "#a3a3a3" }
    ]
} as unknown as Parameters<typeof taskOverlay>[1];

describe("the overlay an edit paints straight away", () => {
    it("resolves assignee ids to the people a row draws", () => {
        const overlay = taskOverlay({ assigneeIds: ["u2"] }, context);

        expect(overlay.assignees?.map((person) => person.name)).toEqual(["Grace"]);
    });

    it("clears the assignees when the last one is taken off", () => {
        expect(taskOverlay({ assigneeIds: [] }, context).assignees).toEqual([]);
    });

    it("carries a status's name and colour with its id", () => {
        const overlay = taskOverlay({ statusId: "s2" }, context);

        expect(overlay.statusName).toBe("Done");
        expect(overlay.statusColor).toBe("#22c55e");
        expect(overlay.statusType).toBe("closed");
    });

    it("applies nothing for a status the space does not have", () => {
        // Half-applying it would leave a new id beside the old name and colour.
        expect(taskOverlay({ statusId: "gone" }, context)).toEqual({});
    });

    it("touches only what the change carries", () => {
        expect(taskOverlay({ priority: "high" }, context)).toEqual({ priority: "high" });
    });

    it("keeps a null the caller meant, and leaves out the keys it did not send", () => {
        const overlay = taskOverlay({ dueDate: null }, context);

        expect(overlay).toEqual({ dueDate: null });
        expect("assignees" in overlay).toBe(false);
    });

    it("ignores the keys of a patch that a row has nowhere to put", () => {
        // The task panel sends the whole update input, recurrence rules and all.
        const overlay = taskOverlay({ recurrence: { mode: "weekly" }, name: "Renamed" }, context);

        expect(overlay).toEqual({ name: "Renamed" });
    });
});

/** A row carrying what a bulk change folds against. */
function row(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        assignees: [{ id: "u1", name: "Ada", image: null }],
        tags: [{ id: "t1", name: "bug", color: "#ef4444" }],
        ...overrides
    } as TaskRow;
}

describe("the overlay a change to a selection paints", () => {
    it("adds a person without dropping the one already there", () => {
        const overlay = bulkOverlay(row(), { addAssigneeIds: ["u2"] }, context);

        expect(overlay.assignees?.map((person) => person.name)).toEqual(["Ada", "Grace"]);
    });

    it("takes a person off and leaves the rest", () => {
        const task = row({
            assignees: [
                { id: "u1", name: "Ada", image: null },
                { id: "u2", name: "Grace", image: null }
            ]
        });

        expect(
            bulkOverlay(task, { removeAssigneeIds: ["u1"] }, context).assignees?.map((p) => p.name)
        ).toEqual(["Grace"]);
    });

    it("adds a label the task does not have and keeps the one it does", () => {
        const overlay = bulkOverlay(row(), { addTagIds: ["t2"] }, context);

        expect(overlay.tags?.map((tag) => tag.name)).toEqual(["bug", "chore"]);
    });

    it("leaves people and tags alone when the change is about neither", () => {
        // Folding an untouched set back in would overwrite a row with itself and
        // repaint every avatar on the board for a priority change.
        const overlay = bulkOverlay(row(), { priority: "urgent" }, context);

        expect(overlay).toEqual({ priority: "urgent" });
    });

    it("paints nothing for a move or an archive, which take the row off the screen", () => {
        expect(bulkOverlay(row(), { listId: "l2" }, context)).toEqual({});
        expect(bulkOverlay(row(), { archived: true }, context)).toEqual({});
    });
});

describe("whether a change is worth writing", () => {
    it("skips a value the task already holds", () => {
        // A field that saves itself while it is being typed sends the same value
        // again on every pause, and each one would be a round trip and a line in
        // the task's history saying somebody changed nothing.
        expect(wouldChange({ description: "Ship it" }, row({ description: "Ship it" }))).toBe(
            false
        );
        expect(wouldChange({ points: null }, row({ points: null }))).toBe(false);
    });

    it("writes a value that came back to where it started as no change at all", () => {
        expect(wouldChange({ name: "Backup codes" }, row({ name: "Backup codes" }))).toBe(false);
    });

    it("writes anything that differs, including a value being cleared", () => {
        expect(wouldChange({ description: "Ship it" }, row({ description: "" }))).toBe(true);
        expect(wouldChange({ blockedNote: "" }, row({ blockedNote: "waiting on legal" }))).toBe(
            true
        );
        expect(wouldChange({ points: null }, row({ points: 3 }))).toBe(true);
    });

    it("treats anything the row does not hold under that name as a change", () => {
        // A list of ids, a recurrence rule: the row draws the resolved version of
        // those, so there is nothing to compare against. Writing one that was not
        // needed costs a request; skipping one that was costs somebody's edit.
        expect(wouldChange({ assigneeIds: ["u1"] }, row())).toBe(true);
        expect(wouldChange({ recurring: { every: "week" } }, row())).toBe(true);
    });

    it("writes when any one field of a change differs", () => {
        expect(wouldChange({ name: "Same", points: 5 }, row({ name: "Same", points: 3 }))).toBe(
            true
        );
    });
});
