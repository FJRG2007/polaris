/**
 * What deleting something takes with it: the grants on it and to it, the log
 * of their use, and - for the kinds that keep them - its history, discussion
 * and followers. Batched, safe to repeat, and never handed an id that is not a
 * row's, since every one of those columns is a uuid.
 */

import { readFileSync } from "node:fs";
import { GRANT_SUBJECTS } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const grantDeletes = vi.fn(async (_args: unknown) => ({ count: 0 }));
const useDeletes = vi.fn(async (_args: unknown) => ({ count: 0 }));
const executeRaw = vi.fn(async (_sql: unknown) => 0);
const historyForget = vi.fn(async (..._args: unknown[]) => undefined);
const commentsForget = vi.fn(async (..._args: unknown[]) => undefined);
const followForget = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock("@polaris/db", () => ({
    Prisma: {
        raw: (text: string) => ({ raw: text }),
        sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values }),
        join: (parts: unknown[], separator: string) => ({ joined: parts, separator })
    },
    prisma: {
        accessGrant: { deleteMany: grantDeletes },
        grantUse: { deleteMany: useDeletes },
        $executeRaw: executeRaw
    }
}));
vi.mock("@/lib/activity/activity", () => ({ forget: historyForget }));
vi.mock("@/lib/comments/comments", () => ({ forget: commentsForget }));
vi.mock("@/lib/follow/follow", () => ({ forget: followForget }));

const forget = await import("@/lib/access/forget");

const id = (n: number) => `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

beforeEach(() => {
    for (const mock of [grantDeletes, useDeletes, executeRaw, historyForget, commentsForget, followForget])
        mock.mockClear();
});

describe("forgetSubject", () => {
    it("drops the grants and their log for the subject", async () => {
        await forget.forgetSubject("task.space", id(1));
        expect(grantDeletes).toHaveBeenCalledWith({
            where: { subjectType: "task.space", subjectId: { in: [id(1)] } }
        });
        expect(useDeletes).toHaveBeenCalledWith({
            where: { subjectType: "task.space", subjectId: { in: [id(1)] } }
        });
        expect(historyForget).not.toHaveBeenCalled();
    });

    it("drops a task's history, discussion and followers too", async () => {
        await forget.forgetSubject("task.task", [id(1), id(2)]);
        expect(historyForget).toHaveBeenCalledWith("task", [id(1), id(2)], expect.anything());
        expect(commentsForget).toHaveBeenCalledWith("task", [id(1), id(2)], expect.anything());
        expect(followForget).toHaveBeenCalledWith("task", [id(1), id(2)], expect.anything());
    });

    it("works in batches, never one statement per thousands of ids", async () => {
        const ids = Array.from({ length: forget.FORGET_BATCH * 2 + 5 }, (_, n) => id(n + 1));
        await forget.forgetSubject("note.note", ids);
        expect(grantDeletes).toHaveBeenCalledTimes(3);
        const sizes = grantDeletes.mock.calls.map(
            ([args]) => (args as { where: { subjectId: { in: string[] } } }).where.subjectId.in.length
        );
        expect(sizes).toEqual([forget.FORGET_BATCH, forget.FORGET_BATCH, 5]);
    });

    it("skips duplicates, nothing at all, and ids that are not a row's", async () => {
        await forget.forgetSubject("crm.record", "companies:abc");
        await forget.forgetSubject("dns.filter", "network");
        await forget.forgetSubject("task.space", []);
        expect(grantDeletes).not.toHaveBeenCalled();
        await forget.forgetSubject("task.space", [id(1), id(1)]);
        expect(grantDeletes).toHaveBeenCalledWith({
            where: { subjectType: "task.space", subjectId: { in: [id(1)] } }
        });
    });

    it("writes through the transaction it is handed", async () => {
        const tx = {
            accessGrant: { deleteMany: vi.fn(async () => ({ count: 0 })) },
            grantUse: { deleteMany: vi.fn(async () => ({ count: 0 })) }
        };
        await forget.forgetSubject("task.folder", id(3), tx as never);
        expect(tx.accessGrant.deleteMany).toHaveBeenCalledTimes(1);
        expect(grantDeletes).not.toHaveBeenCalled();
    });
});

describe("forgetPrincipal", () => {
    it("drops every grant to that team", async () => {
        await forget.forgetPrincipal("team", id(9));
        expect(grantDeletes).toHaveBeenCalledWith({
            where: { principalType: "team", principalId: { in: [id(9)] } }
        });
    });
});

describe("the orphan sweep", () => {
    const tableBacked = Object.entries(forget.SUBJECT_TABLES).filter(([, table]) => table !== null);

    it("matches every kind with a table, and never a fixed or composite id", () => {
        const targets = forget.orphanTargets();
        for (const [kind, table] of tableBacked)
            expect(targets).toContainEqual({
                side: "subject",
                kind,
                tables: typeof table === "string" ? [table] : table
            });
        for (const kind of ["crm.record", "dns.filter", "watch.connectivity"])
            expect(targets.some((target) => target.kind === kind)).toBe(false);
        expect(targets.filter((target) => target.side === "principal")).toEqual([
            { side: "principal", kind: "user", tables: ["User"] },
            { side: "principal", kind: "team", tables: ["Team"] },
            { side: "principal", kind: "role", tables: ["OrgRole"] }
        ]);
    });

    it("passes the kind and the limit as parameters, and only the table raw", () => {
        const statement = forget.orphanGrantStatement(
            { side: "subject", kind: "place.camera", tables: ["Camera"] },
            7
        ) as unknown as { strings: string[]; values: unknown[] };
        expect(statement.values).toContain("place.camera");
        expect(statement.values).toContain(7);
        expect(JSON.stringify(statement.values)).toContain(JSON.stringify({ raw: '"Camera"' }));
        expect(statement.strings.join("")).not.toContain("place.camera");
    });

    it("keeps a grant on a site while either its service or its own record is left", () => {
        const target = forget.orphanTargets().find((one) => one.kind === "analytics.site");
        expect(target?.tables).toEqual(["Application", "AnalyticsSite"]);
        const statement = forget.orphanGrantStatement(target!) as unknown as { values: unknown[] };
        const text = JSON.stringify(statement.values);
        expect(text).toContain(JSON.stringify({ raw: '"Application"' }));
        expect(text).toContain(JSON.stringify({ raw: '"AnalyticsSite"' }));
    });

    it("refuses anything that is not a table name", () => {
        expect(() =>
            forget.orphanGrantStatement({ side: "subject", kind: "x", tables: ["User", 'User"; DROP TABLE "User'] })
        ).toThrow();
    });

    it("repeats a statement while it still finds a full batch", async () => {
        executeRaw.mockResolvedValueOnce(forget.SWEEP_BATCH).mockResolvedValueOnce(2);
        const total = await forget.sweepOrphanGrants();
        expect(total).toBe(forget.SWEEP_BATCH + 2);
        expect(executeRaw).toHaveBeenCalledTimes(forget.orphanTargets().length + 1);
    });

    it("never throws: the delete it follows has already happened", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        executeRaw.mockRejectedValueOnce(new Error("connection closed"));
        await expect(forget.sweepOrphanGrants()).resolves.toBe(0);
        quiet.mockRestore();
    });
});

describe("the orphan_cleanup migration", () => {
    const sql = readFileSync(
        new URL(
            "../../../../packages/db/prisma/migrations/20270329000000_orphan_cleanup/migration.sql",
            import.meta.url
        ),
        "utf8"
    );

    it("covers every subject kind the code knows a table for, in grants and their log", () => {
        expect(Object.keys(forget.SUBJECT_TABLES).sort()).toEqual([...GRANT_SUBJECTS].sort());
        for (const [kind, tables] of Object.entries(forget.SUBJECT_TABLES)) {
            if (tables === null) {
                expect(sql).not.toContain(`'${kind}'`);
                continue;
            }
            for (const table of typeof tables === "string" ? [tables] : tables) {
                const grant = new RegExp(
                    `DELETE FROM "AccessGrant" g\\s+WHERE g\\."subjectType" = '${kind.replace(".", "\\.")}'[^;]*FROM "${table}"`
                );
                const use = new RegExp(
                    `DELETE FROM "GrantUse" g\\s+WHERE g\\."subjectType" = '${kind.replace(".", "\\.")}'[^;]*FROM "${table}"`
                );
                expect(sql).toMatch(grant);
                expect(sql).toMatch(use);
            }
        }
    });

    it("only ever deletes", () => {
        const body = sql
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n");
        for (const statement of body.split(";").map((s) => s.trim()).filter(Boolean))
            expect(statement.startsWith("DELETE FROM")).toBe(true);
        expect(sql).not.toMatch(/\b(DROP|ALTER|TRUNCATE|UPDATE|INSERT)\b/);
    });
});
