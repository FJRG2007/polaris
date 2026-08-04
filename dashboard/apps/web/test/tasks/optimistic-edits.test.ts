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
import { taskOverlay } from "../../src/app/(app)/tasks/optimistic";

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
