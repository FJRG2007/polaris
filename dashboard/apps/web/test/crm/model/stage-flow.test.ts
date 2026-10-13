/**
 * The stage flow: each deal's path read from its logged stage moves, the time
 * it stayed at each stage, how many reached a stage and were won, the win rate,
 * and reasons counted together whatever their case.
 */

import { describe, expect, it } from "vitest";
import { buildStageFlow, countReasons } from "@polaris-app/crm/src/model/stage-flow";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const move = (recordId: string, at: number, before: unknown, after: unknown) => ({
    recordId,
    at: day(at),
    changes: JSON.stringify([{ key: "stage", before, after }])
});

describe("buildStageFlow", () => {
    it("follows each deal from where it started through every move", () => {
        const flow = buildStageFlow(
            [
                { id: "a", stage: "customer", createdAt: day(0) },
                { id: "b", stage: "lost", createdAt: day(0) },
                { id: "c", stage: "new", createdAt: day(0) },
                { id: "d", stage: "meeting", createdAt: day(0) }
            ],
            [
                move("a", 4, "new", "proposal"),
                move("a", 10, "proposal", "customer"),
                move("b", 2, "new", "lost"),
                // Made at a stage: logged as a move from nothing, not a stay.
                move("d", 0, null, "meeting")
            ],
            []
        );
        const step = (stage: string) => flow.steps.find((entry) => entry.stage === stage)!;
        expect(step("new")).toEqual({ stage: "new", reached: 3, won: 1, now: 1, averageDays: 3 });
        expect(step("proposal")).toMatchObject({ reached: 1, won: 1, averageDays: 6 });
        expect(step("meeting")).toMatchObject({ reached: 1, now: 1, averageDays: null });
        expect(flow.steps.map((entry) => entry.stage)).not.toContain("lost");
        expect(flow).toMatchObject({ won: 1, lost: 1, winRate: 50 });
    });

    it("has no win rate before any deal is decided, and ignores unreadable changes", () => {
        const flow = buildStageFlow(
            [{ id: "a", stage: "new", createdAt: day(0) }],
            [{ recordId: "a", at: day(1), changes: "not json" }, move("a", 2, "new", "bogus")],
            []
        );
        expect(flow.winRate).toBeNull();
        expect(flow.steps.find((entry) => entry.stage === "new")).toMatchObject({
            reached: 1,
            averageDays: null
        });
    });
});

describe("countReasons", () => {
    it("adds up one reason however it was written, the most given first", () => {
        const rows = [
            { stage: "lost", reason: "Too expensive", deals: 1 },
            { stage: "lost", reason: " too  expensive ", deals: 2 },
            { stage: "lost", reason: "", deals: 1 },
            { stage: "customer", reason: "Fit", deals: 5 }
        ];
        expect(countReasons(rows, "lost")).toEqual([
            { reason: "Too expensive", deals: 3 },
            { reason: "", deals: 1 }
        ]);
    });
});
