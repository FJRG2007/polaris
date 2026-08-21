/**
 * How far through the work a status is, for the mark that draws it.
 *
 * A space that has drawn three stages of work in progress had them rendered as
 * three identical filled circles, so "In progress", "In review" and "Ready to
 * ship" were told apart only by a colour somebody had to have learned. The
 * fraction here is what makes the mark itself say which.
 */

import { describe, expect, it } from "vitest";
import { statusProgress } from "./tasks.js";

const STATUSES = [
    { id: "todo", type: "open" as const },
    { id: "doing", type: "active" as const },
    { id: "review", type: "active" as const },
    { id: "ready", type: "active" as const },
    { id: "held", type: "blocked" as const },
    { id: "done", type: "done" as const },
    { id: "dropped", type: "closed" as const }
];

describe("how far through a status is", () => {
    it("spreads the stages of work in progress across the turn", () => {
        expect(statusProgress(STATUSES, "doing")).toBeCloseTo(0.25);
        expect(statusProgress(STATUSES, "review")).toBeCloseTo(0.5);
        expect(statusProgress(STATUSES, "ready")).toBeCloseTo(0.75);
    });

    it("gives a space with one such stage a half-filled mark", () => {
        // Which is what an ordinary space looks like, and what the mark has
        // always meant on its own.
        expect(statusProgress([{ id: "doing", type: "active" }], "doing")).toBeCloseTo(0.5);
    });

    it("is never empty and never full", () => {
        // Empty reads as not started and full reads as done, and work in
        // progress is neither.
        for (const id of ["doing", "review", "ready"]) {
            const value = statusProgress(STATUSES, id)!;
            expect(value).toBeGreaterThan(0);
            expect(value).toBeLessThan(1);
        }
    });

    it("has no answer for the kinds that are not a position on a scale", () => {
        for (const id of ["todo", "held", "done", "dropped"]) {
            expect(statusProgress(STATUSES, id)).toBeNull();
        }
    });

    it("says nothing about a task with no status, or one from another space", () => {
        expect(statusProgress(STATUSES, null)).toBeNull();
        expect(statusProgress(STATUSES, "someone-elses")).toBeNull();
    });
});
