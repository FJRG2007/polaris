/**
 * The issue search: what a typed line means, what it turns back into, and the
 * page boundaries every Telemetry list walks.
 */

import { describe, expect, it } from "vitest";
import * as q from "@/lib/telemetry/issue-query";
import { issueWhere, statusColumns } from "@/lib/telemetry/workflow-service";

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

describe("reading a search", () => {
    it("reads every filter Sentry's syntax names", () => {
        const query = q.parseIssueQuery(
            `is:resolved assigned:me level:error,fatal env:production release:"1.4 beta" project:web firstSeen:-24h lastSeen:+7d timeout`
        );
        expect(query).toEqual({
            status: "resolved",
            assigned: "me",
            levels: ["error", "fatal"],
            environment: "production",
            release: "1.4 beta",
            project: "web",
            firstSeen: { within: true, amount: 24, unit: "h" },
            lastSeen: { within: false, amount: 7, unit: "d" },
            text: "timeout"
        });
    });

    it("keeps what it does not understand as text rather than dropping it", () => {
        const query = q.parseIssueQuery("is:sleeping level:loud firstSeen:yesterday color:red");
        expect(query.status).toBeNull();
        expect(query.levels).toEqual([]);
        expect(query.firstSeen).toBeNull();
        expect(query.text).toBe("is:sleeping firstSeen:yesterday color:red");
    });

    it("knows the is: shorthands for assignment, and is:all clears the status", () => {
        expect(q.parseIssueQuery("is:unassigned").assigned).toBe("none");
        expect(q.parseIssueQuery("is:assigned").assigned).toBe("any");
        expect(q.parseIssueQuery("is:unresolved is:all").status).toBeNull();
        expect(q.parseIssueQuery(`assigned:${ID.toUpperCase()}`).assigned).toBe(ID);
        expect(q.parseIssueQuery("assigned:bob").text).toBe("assigned:bob");
    });

    it("keeps quoted phrases whole", () => {
        expect(q.tokenize(`"cannot read" env:"eu west"`)).toEqual([`"cannot read"`, `env:"eu west"`]);
        expect(q.parseIssueQuery(`"cannot read" x`).text).toBe("cannot read x");
    });

    it("round-trips to one canonical string", () => {
        const text = `timeout level:error is:unresolved release:"1.4 beta"`;
        const once = q.serializeIssueQuery(q.parseIssueQuery(text));
        expect(once).toBe(`is:unresolved level:error release:"1.4 beta" timeout`);
        expect(q.serializeIssueQuery(q.parseIssueQuery(once))).toBe(once);
    });

    it("changes one filter and leaves the rest", () => {
        expect(q.withFilter("is:unresolved boom", { assigned: "me" })).toBe(
            "is:unresolved assigned:me boom"
        );
        expect(q.withFilter("is:unresolved assigned:me", { status: null })).toBe("assigned:me");
    });

    it("starts on the open issues", () => {
        expect(q.parseIssueQuery(q.DEFAULT_QUERY).status).toBe("unresolved");
    });

    it("bounds what it is given", () => {
        expect(q.parseIssueQuery("x".repeat(2000)).text.length).toBeLessThanOrEqual(200);
        expect(q.issueSearchSchema.safeParse({ query: "a".repeat(501) }).success).toBe(false);
        expect(q.issueSearchSchema.safeParse({ sort: "random" }).success).toBe(false);
        expect(q.issueSearchSchema.safeParse({ cursor: "1 OR 1=1" }).success).toBe(false);
        expect(q.issueSearchSchema.parse({})).toEqual({ query: "", sort: "lastSeen" });
    });
});

describe("the database query a search stands for", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");

    it("measures ranges from now, within or before", () => {
        expect(q.rangeWhere({ within: true, amount: 24, unit: "h" }, now)).toEqual({
            gte: new Date("2026-11-09T12:00:00.000Z")
        });
        expect(q.rangeWhere({ within: false, amount: 1, unit: "w" }, now)).toEqual({
            lt: new Date("2026-11-03T12:00:00.000Z")
        });
    });

    it("filters in the database on the reader's projects only", () => {
        const where = issueWhere(
            ["p1", "p2"],
            q.parseIssueQuery("is:unresolved assigned:me level:error env:prod release:1.2 boom"),
            "viewer",
            now
        );
        expect(where.AND).toEqual([
            { projectId: { in: ["p1", "p2"] } },
            { status: "unresolved" },
            { assignedToId: "viewer" },
            { level: { in: ["error"] } },
            { events: { some: { environment: "prod" } } },
            { OR: [{ lastRelease: "1.2" }, { events: { some: { release: "1.2" } } }] },
            {
                OR: [
                    { title: { contains: "boom", mode: "insensitive" } },
                    { culprit: { contains: "boom", mode: "insensitive" } }
                ]
            }
        ]);
        expect(issueWhere([], q.parseIssueQuery("assigned:none"), "v", now).AND).toContainEqual({
            assignedToId: null
        });
    });

    it("orders by the chosen column with the id last", () => {
        expect(q.issueOrder("events")).toEqual([{ timesSeen: "desc" }, { id: "desc" }]);
        expect(q.issueOrder("firstSeen")).toEqual([{ firstSeen: "desc" }, { id: "desc" }]);
    });
});

describe("cursor pages", () => {
    const rows = Array.from({ length: 5 }, (_, at) => ({ id: `r${at}` }));

    it("asks for one past the page, skipping the cursor row itself", () => {
        expect(q.pageArgs(null, 50)).toEqual({ take: 51 });
        expect(q.pageArgs(ID, 50)).toEqual({ take: 51, skip: 1, cursor: { id: ID } });
    });

    it("says there is more only when the extra row came back", () => {
        expect(q.pageOf(rows, 4)).toEqual({ items: rows.slice(0, 4), next: "r3" });
        expect(q.pageOf(rows, 5)).toEqual({ items: rows, next: null });
        expect(q.pageOf([], 5)).toEqual({ items: [], next: null });
    });

    it("walks a list end to end without repeating or skipping a row", () => {
        const all = Array.from({ length: 123 }, (_, at) => ({ id: `id${String(at).padStart(3, "0")}` }));
        const read = (cursor: string | null) => {
            const args = q.pageArgs(cursor, 50);
            const start = args.cursor ? all.findIndex((row) => row.id === args.cursor!.id) + (args.skip ?? 0) : 0;
            return q.pageOf(all.slice(start, start + args.take), 50);
        };
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
            const page = read(cursor);
            seen.push(...page.items.map((row) => row.id));
            cursor = page.next;
        } while (cursor);
        expect(seen).toEqual(all.map((row) => row.id));
    });
});

describe("resolving", () => {
    const now = new Date("2026-11-10T00:00:00.000Z");

    it("resolving now lets any later event reopen it", () => {
        expect(statusColumns("resolved", "1.4", "u1", "now", now)).toEqual({
            status: "resolved",
            resolvedAt: now,
            resolvedById: "u1",
            resolvedInRelease: null
        });
    });

    it("in the next release, and by default, an event from the same release does not", () => {
        expect(statusColumns("resolved", "1.4", "u1", "nextRelease", now).resolvedInRelease).toBe("1.4");
        expect(statusColumns("resolved", "1.4", "u1", undefined, now).resolvedInRelease).toBe("1.4");
    });

    it("anything else clears the resolution", () => {
        expect(statusColumns("ignored", "1.4", "u1", "now", now)).toEqual({
            status: "ignored",
            resolvedAt: null,
            resolvedById: null,
            resolvedInRelease: null
        });
    });
});

describe("a task made from an issue", () => {
    it("is named after the error and links back to it", () => {
        const draft = q.issueTaskDraft(
            {
                title: "TypeError:   cannot read  x",
                culprit: "app.js in render",
                link: "https://polaris.example/telemetry/p/issues/i"
            },
            { where: "In app.js in render", seen: "error, seen 3 times", release: null }
        );
        expect(draft.name).toBe("TypeError: cannot read x");
        expect(draft.description.split("\n")).toEqual([
            "TypeError:   cannot read  x",
            "In app.js in render",
            "",
            "error, seen 3 times",
            "",
            "https://polaris.example/telemetry/p/issues/i"
        ]);
    });

    it("stays inside what Tasks accepts", () => {
        const draft = q.issueTaskDraft(
            { title: "x".repeat(500), culprit: "", link: "https://polaris.example/i" },
            { where: null, seen: "s", release: "r" }
        );
        expect(draft.name.length).toBe(200);
        expect(draft.description.length).toBeLessThanOrEqual(20_000);
    });
});
