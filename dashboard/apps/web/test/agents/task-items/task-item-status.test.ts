/**
 * Where a session puts its Tasks item, and the rule that a status somebody set
 * by hand is never overwritten.
 */

import { describe, expect, it } from "vitest";
import * as rules from "@/lib/agents/task-item-status";
import { SESSION_STATUSES } from "@/lib/agents/session-status";

const STATUSES = [
    { id: "todo", type: "open", order: 1 },
    { id: "doing-late", type: "active", order: 5 },
    { id: "doing", type: "active", order: 2 },
    { id: "done", type: "done", order: 9 }
];

describe("statusTypeFor", () => {
    it("maps every derived status, and leaves the item alone when the session ended unmerged", () => {
        expect(rules.statusTypeFor("merged")).toBe("done");
        expect(rules.statusTypeFor("needs_input")).toBe("blocked");
        expect(rules.statusTypeFor("terminated")).toBeNull();
        expect(rules.statusTypeFor("exited")).toBeNull();
        expect(rules.statusTypeFor(null)).toBeNull();
        for (const status of SESSION_STATUSES) {
            if (["merged", "needs_input", "terminated", "exited"].includes(status)) continue;
            expect(rules.statusTypeFor(status)).toBe("active");
        }
    });
});

describe("pickStatus", () => {
    it("takes the first status of the kind in the space's order", () => {
        expect(rules.pickStatus(STATUSES, "active")).toBe("doing");
        expect(rules.pickStatus(STATUSES, "done")).toBe("done");
    });

    it("answers none for a kind the space has no status of", () => {
        expect(rules.pickStatus(STATUSES, "blocked")).toBeNull();
        expect(rules.pickStatus(STATUSES, null)).toBeNull();
    });
});

describe("decideLinkMove", () => {
    const link = { appliedStatusId: "todo", held: false };

    it("moves an item that still holds the status the link last wrote", () => {
        expect(rules.decideLinkMove(link, { statusId: "todo" }, "doing")).toEqual({
            kind: "move",
            statusId: "doing"
        });
    });

    it("holds when a person moved the item, even to where the session would put it", () => {
        expect(rules.decideLinkMove(link, { statusId: "done" }, "doing")).toEqual({ kind: "hold" });
        expect(rules.decideLinkMove(link, { statusId: "doing" }, "doing")).toEqual({ kind: "hold" });
        expect(rules.decideLinkMove(link, { statusId: null }, "doing")).toEqual({ kind: "hold" });
    });

    it("never writes a held link again", () => {
        expect(rules.decideLinkMove({ ...link, held: true }, { statusId: "todo" }, "doing")).toEqual({
            kind: "keep"
        });
    });

    it("keeps when there is nowhere to go or it is already there", () => {
        expect(rules.decideLinkMove(link, { statusId: "todo" }, null)).toEqual({ kind: "keep" });
        expect(rules.decideLinkMove(link, { statusId: "todo" }, "todo")).toEqual({ kind: "keep" });
    });
});

describe("plan prompts", () => {
    const items = [
        { id: "0190c6a0-0000-7000-8000-000000000001", reference: "ENG-1", name: "Fix login", description: "Line one\nline two" },
        { id: "0190c6a0-0000-7000-8000-000000000002", reference: "ENG-2", name: "Docs", description: "" }
    ];

    it("lists every item with the id the coordinator spawns it for, on a fixed first line", () => {
        const objective = rules.planObjective(items, "Ship it\nthis week");
        expect(objective.split("\n")[0]).toBe("Work through these Tasks items.");
        expect(objective).toContain("Ship it");
        expect(objective).toContain("- ENG-1 Fix login (item 0190c6a0-0000-7000-8000-000000000001)");
        expect(objective).toContain("  Line one line two");
        expect(objective).toContain("- ENG-2 Docs (item 0190c6a0-0000-7000-8000-000000000002)");
    });

    it("gives a worker the item and the person's words, skipping what is empty", () => {
        expect(rules.itemBrief(items[1]!, "")).toBe("ENG-2: Docs");
        expect(rules.itemBrief(items[0]!, "Be careful")).toBe("ENG-1: Fix login\n\nLine one\nline two\n\nBe careful");
    });
});
