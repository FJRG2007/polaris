/**
 * Polar's Code history: each session once, each task once by its newest
 * session, newest first - on the server's page and across the pages the
 * browser has read.
 */

import { describe, expect, it } from "vitest";
import { codeTaskKey, dedupeCodeRows, mergeCodeRows } from "@/lib/polar/code-history";

function row(id: string, title: string, createdAt: string, repo = "acme/web") {
    return { id, title, repo, createdAt };
}

describe("codeTaskKey", () => {
    it("is the same task whatever the case and spacing of its words", () => {
        expect(codeTaskKey(row("a", " Fix  the form ", "1"))).toBe(
            codeTaskKey(row("b", "fix the form", "2"))
        );
    });

    it("is another task on another repository or in an empty workspace", () => {
        const here = codeTaskKey(row("a", "Fix the form", "1"));
        expect(codeTaskKey(row("b", "Fix the form", "1", "acme/api"))).not.toBe(here);
        expect(codeTaskKey(row("c", "Fix the form", "1", ""))).not.toBe(here);
    });
});

describe("dedupeCodeRows", () => {
    it("keeps the newest session of a task started again", () => {
        const rows = [
            row("old", "Fix the form", "2026-10-20T09:00:00.000Z"),
            row("other", "Review", "2026-10-20T09:30:00.000Z"),
            row("new", "Fix the form", "2026-10-20T10:00:00.000Z")
        ];
        expect(dedupeCodeRows(rows).map((entry) => entry.id)).toEqual(["new", "other"]);
    });

    it("lists newest first, breaking a tie on the time by the id", () => {
        const rows = [
            row("a", "One", "2026-10-20T09:00:00.000Z"),
            row("c", "Two", "2026-10-20T10:00:00.000Z"),
            row("b", "Three", "2026-10-20T10:00:00.000Z")
        ];
        expect(dedupeCodeRows(rows).map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    });

    it("is empty for nothing", () => {
        expect(dedupeCodeRows([])).toEqual([]);
    });
});

describe("mergeCodeRows", () => {
    it("lets a fresh copy of a session win and keeps the pages read before", () => {
        const current = [
            { ...row("s1", "Fix the form", "2026-10-20T10:00:00.000Z"), state: "working" },
            { ...row("s2", "Review", "2026-10-19T10:00:00.000Z"), state: "idle" }
        ];
        const fresh = [
            { ...row("s3", "New one", "2026-10-21T10:00:00.000Z"), state: "starting" },
            { ...row("s1", "Fix the form", "2026-10-20T10:00:00.000Z"), state: "stopped" }
        ];
        const merged = mergeCodeRows(current, fresh);
        expect(merged.map((entry) => [entry.id, entry.state])).toEqual([
            ["s3", "starting"],
            ["s1", "stopped"],
            ["s2", "idle"]
        ]);
    });

    it("drops an older attempt that a later page brings of a task already listed", () => {
        const page1 = [row("new", "Fix the form", "2026-10-20T10:00:00.000Z")];
        const page2 = [row("old", "Fix the form", "2026-10-01T10:00:00.000Z")];
        expect(mergeCodeRows(page1, page2).map((entry) => entry.id)).toEqual(["new"]);
    });

    it("starts the list over from null", () => {
        expect(mergeCodeRows(null, [row("a", "One", "1")]).map((entry) => entry.id)).toEqual(["a"]);
    });
});
