/**
 * Polar's Code history: each session once, each task once by its newest
 * session unless one of it is still live, newest first - on the server's page
 * and across the pages the browser has read.
 */

import { describe, expect, it } from "vitest";
import {
    codeTaskKey,
    dedupeCodeRows,
    filterCodeRows,
    mergeCodeRows,
    polarCodeEditSchema
} from "@/lib/polar/code-history";

function row(
    id: string,
    title: string,
    createdAt: string,
    repo = "acme/web",
    { branch = "main", live = false } = {}
) {
    return { id, title, repo, branch, live, createdAt };
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

    it("is another task on another branch of the same repository", () => {
        const here = codeTaskKey(row("a", "Fix the form", "1"));
        expect(codeTaskKey(row("b", "Fix the form", "1", "acme/web", { branch: "next" }))).not.toBe(
            here
        );
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

    it("never merges away a session still live behind a newer attempt that ended", () => {
        const rows = [
            row("running", "Fix the form", "2026-10-20T09:00:00.000Z", "acme/web", { live: true }),
            row("failed", "Fix the form", "2026-10-20T10:00:00.000Z"),
            row("older", "Fix the form", "2026-10-19T10:00:00.000Z")
        ];
        expect(dedupeCodeRows(rows).map((entry) => entry.id)).toEqual(["running"]);
    });

    it("keeps every live session of one task", () => {
        const rows = [
            row("a", "Fix the form", "2026-10-20T09:00:00.000Z", "acme/web", { live: true }),
            row("b", "Fix the form", "2026-10-20T10:00:00.000Z", "acme/web", { live: true })
        ];
        expect(dedupeCodeRows(rows).map((entry) => entry.id)).toEqual(["b", "a"]);
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

describe("filterCodeRows", () => {
    const rows = [
        row("a", "Fix the login redirect", "3"),
        row("b", "Review the billing page", "2", "acme/billing"),
        row("c", "Tidy the README", "1", "")
    ];

    it("keeps every row for no words", () => {
        expect(filterCodeRows(rows, "  ").map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    });

    it("needs every word, in the title or the repository, whatever the case", () => {
        expect(filterCodeRows(rows, "LOGIN fix").map((entry) => entry.id)).toEqual(["a"]);
        expect(filterCodeRows(rows, "billing").map((entry) => entry.id)).toEqual(["b"]);
        expect(filterCodeRows(rows, "acme review").map((entry) => entry.id)).toEqual(["b"]);
    });

    it("is empty when nothing matches", () => {
        expect(filterCodeRows(rows, "deploy")).toEqual([]);
    });
});

describe("polarCodeEditSchema", () => {
    const sessionId = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

    it("takes a delete of one session", () => {
        expect(polarCodeEditSchema.safeParse({ action: "delete", sessionId }).success).toBe(true);
    });

    it("trims a new name and refuses an empty or overlong one", () => {
        const renamed = polarCodeEditSchema.safeParse({
            action: "rename",
            sessionId,
            title: "  New name  "
        });
        expect(renamed.success && renamed.data.action === "rename" && renamed.data.title).toBe(
            "New name"
        );
        expect(
            polarCodeEditSchema.safeParse({ action: "rename", sessionId, title: "   " }).success
        ).toBe(false);
        expect(
            polarCodeEditSchema.safeParse({ action: "rename", sessionId, title: "x".repeat(81) })
                .success
        ).toBe(false);
    });

    it("refuses an id that is not one, an unknown action and extra fields", () => {
        expect(polarCodeEditSchema.safeParse({ action: "delete", sessionId: "1" }).success).toBe(
            false
        );
        expect(polarCodeEditSchema.safeParse({ action: "pin", sessionId }).success).toBe(false);
        expect(
            polarCodeEditSchema.safeParse({ action: "delete", sessionId, title: "x" }).success
        ).toBe(false);
    });
});
