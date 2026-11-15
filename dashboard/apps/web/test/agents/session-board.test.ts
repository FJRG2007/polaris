import { describe, expect, it } from "vitest";
import * as board from "@/lib/agents/session-board";
import { SESSION_STATUSES } from "@/lib/agents/session-status";

const open = { merged: false, closed: false, ci: "passing" as const };

describe("boardColumnOf", () => {
    it("puts every status in one of the board's columns", () => {
        for (const status of SESSION_STATUSES) {
            expect(board.BOARD_COLUMNS).toContain(board.boardColumnOf(status, []));
        }
    });

    it("maps the lanes the way the work runs", () => {
        expect(board.boardColumnOf("needs_input", [])).toBe("needs_you");
        expect(board.boardColumnOf("idle", [])).toBe("needs_you");
        expect(board.boardColumnOf("working", [])).toBe("working");
        expect(board.boardColumnOf("no_signal", [])).toBe("working");
        for (const status of ["pr_open", "review_pending", "draft"] as const)
            expect(board.boardColumnOf(status, [open])).toBe("in_review");
        for (const status of ["ci_failed", "changes_requested", "commented", "merge_conflict"] as const)
            expect(board.boardColumnOf(status, [open])).toBe("fix_needed");
        expect(board.boardColumnOf("mergeable", [open])).toBe("ready");
        expect(board.boardColumnOf("approved", [open])).toBe("ready");
        for (const status of ["merged", "terminated", "exited"] as const)
            expect(board.boardColumnOf(status, [])).toBe("done");
    });

    it("keeps a pull request in review while its checks are still running", () => {
        expect(board.boardColumnOf("mergeable", [{ ...open, ci: "pending" }])).toBe("in_review");
        // A closed one with pending checks says nothing about the open one.
        expect(
            board.boardColumnOf("mergeable", [open, { merged: false, closed: true, ci: "pending" }])
        ).toBe("ready");
    });
});

describe("checksSummary", () => {
    it("counts what passed and never goes negative", () => {
        expect(board.checksSummary({ checksTotal: 5, checksFailed: 1, checksPending: 2 })).toEqual({
            total: 5,
            failed: 1,
            pending: 2,
            passed: 2
        });
        expect(board.checksSummary({ checksTotal: 1, checksFailed: 3, checksPending: 2 })).toEqual({
            total: 1,
            failed: 1,
            pending: 0,
            passed: 0
        });
    });
});

describe("cardPull", () => {
    it("names the newest open pull request, or the newest of all", () => {
        expect(board.cardPull([])).toBeNull();
        const merged = { number: 3, merged: true, closed: false };
        expect(board.cardPull([merged, { number: 2, merged: false, closed: false }])?.number).toBe(2);
        expect(board.cardPull([merged, { number: 1, merged: false, closed: true }])?.number).toBe(3);
    });
});

describe("stored filters", () => {
    it("reads back only what parses", () => {
        const repo = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
        expect(board.storedFilters(JSON.stringify({ repo, agent: "claude-code" }))).toEqual({
            repo,
            agent: "claude-code"
        });
        expect(board.storedFilters("not json")).toEqual({});
        expect(board.storedFilters(JSON.stringify({ repo: "x" }))).toEqual({});
        expect(board.storedFilters(JSON.stringify({ other: 1 }))).toEqual({});
        expect(board.storedFilters(null)).toEqual({});
    });

    it("writes a query with no empty values", () => {
        expect(board.filterQuery({})).toBe("");
        expect(board.filterQuery({ agent: "codex" }, "c1")).toBe("agent=codex&done=c1");
    });
});
