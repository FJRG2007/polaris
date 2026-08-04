/**
 * How much work one gesture may take on, and what is said when a write took less
 * than it was handed.
 *
 * Both are the same failure if they go unsaid. A shift-click crosses more rows
 * than a write accepts, and a selection spans spaces this account may only read:
 * either way something quietly does not happen, and the screen looks exactly the
 * same as if it had.
 */

import { describe, expect, it } from "vitest";
import { TASK_SELECTION_MAX } from "@polaris/core";
import { holdSelection, shortfallMessage } from "@/app/(app)/tasks/views/shared";

const ids = (count: number) => new Set(Array.from({ length: count }, (_, index) => `task-${index}`));

describe("how many tasks a selection may hold", () => {
    it("leaves a selection the write path accepts exactly as it is", () => {
        const picked = ids(12);
        const { taken, dropped } = holdSelection(picked);

        expect(taken).toBe(picked);
        expect(dropped).toBe(0);
    });

    it("takes everything right up to the limit", () => {
        const { taken, dropped } = holdSelection(ids(TASK_SELECTION_MAX));

        expect(taken.size).toBe(TASK_SELECTION_MAX);
        expect(dropped).toBe(0);
    });

    it("stops at the limit rather than sending a selection the server would refuse whole", () => {
        // The case the range gesture makes easy: a screen loads well past this,
        // and one shift-click used to reach all of it.
        const { taken, dropped } = holdSelection(ids(TASK_SELECTION_MAX + 100));

        expect(taken.size).toBe(TASK_SELECTION_MAX);
        expect(dropped).toBe(100);
    });

    it("keeps the ones picked first, so what was dropped is the far end of the reach", () => {
        const { taken } = holdSelection(ids(TASK_SELECTION_MAX + 1));

        expect(taken.has("task-0")).toBe(true);
        expect(taken.has(`task-${TASK_SELECTION_MAX}`)).toBe(false);
    });
});

describe("what is said when a write reached fewer tasks than it was handed", () => {
    it("says nothing when every task was written", () => {
        expect(shortfallMessage(20, 20, "Changed")).toBeNull();
    });

    it("says nothing when the count is not known", () => {
        expect(shortfallMessage(undefined, 20, "Deleted")).toBeNull();
    });

    it("names both numbers for a delete, which cannot be looked at afterwards", () => {
        expect(shortfallMessage(12, 20, "Deleted")).toBe("Deleted 12 of 20: 8 tasks are not yours to change.");
    });

    it("counts one task as one task", () => {
        expect(shortfallMessage(4, 5, "Changed")).toBe("Changed 4 of 5: one task is not yours to change.");
    });

    it("speaks up when nothing landed at all", () => {
        expect(shortfallMessage(0, 3, "Deleted")).toBe("Deleted 0 of 3: 3 tasks are not yours to change.");
    });
});
