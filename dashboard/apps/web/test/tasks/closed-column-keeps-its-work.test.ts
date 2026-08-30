/**
 * A task dragged into Cancelled, and where it went.
 *
 * Reported as "it literally disappeared". It had not: the move saved and the
 * status changed. Cancelled is a `closed` status - one of the seven a new space
 * starts with - and the screen dropped every closed task before grouping, so
 * the column somebody had just dragged a card into was the one column that could
 * never draw it. The card vanished on release, and the only way back to it was a
 * checkbox in the toolbar that nobody had a reason to suspect.
 *
 * Hiding closed work is still right everywhere it does not have a column of its
 * own, which is what these pin apart. The board is the case that bit; the flat
 * list is the case the hiding was written for.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_STATUSES, hidesClosedWork, isFinishedStatus } from "@polaris/core";

describe("hiding closed work", () => {
    it("stands down when status is what the view is grouped by", () => {
        // The board, and a list grouped the same way. A closed task can only
        // land in the group of its own status, so nothing else is let through.
        expect(hidesClosedWork("status", false)).toBe(false);
    });

    it("still hides it from every other arrangement", () => {
        for (const groupBy of ["none", "assignee", "priority", "dueDate", "tag", "list", "blocked"] as const) {
            expect(hidesClosedWork(groupBy, false), groupBy).toBe(true);
        }
    });

    it("is off wherever the reader asked to see closed work", () => {
        expect(hidesClosedWork("none", true)).toBe(false);
        expect(hidesClosedWork("assignee", true)).toBe(false);
    });
});

describe("the statuses a new space starts with", () => {
    it("gives Cancelled a column that this rule has to keep filled", () => {
        // The regression in one line: if Cancelled were not a closed status
        // there would have been nothing to hide, and if it were not one of the
        // defaults it would not have happened to everybody.
        const cancelled = DEFAULT_TASK_STATUSES.find((status) => status.name === "Cancelled");
        expect(cancelled?.type).toBe("closed");
        expect(isFinishedStatus(cancelled?.type ?? "open")).toBe(true);
    });

    it("leaves Done alone, which is why only Cancelled was reported", () => {
        // Done is `done`, not `closed`, so it was never filtered - dragging onto
        // it always looked right, and that is what made Cancelled look broken
        // rather than deliberate.
        const done = DEFAULT_TASK_STATUSES.find((status) => status.name === "Done");
        expect(done?.type).toBe("done");
    });
});
