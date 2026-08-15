/**
 * The history every app shares.
 *
 * Two things are worth pinning. A line keeps the id of whoever made it and no
 * foreign key, so the name is resolved on read and a departed account leaves the
 * line standing with nobody's name on it rather than taking it away. And nothing
 * cascades: `forget` is the only thing that removes history, so a subject being
 * deleted has to say so.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const activityCreate = vi.fn(async (_args: unknown) => ({}));
const activityCreateMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const activityDeleteMany = vi.fn(async (_args: unknown) => ({ count: 0 }));
const activityFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);
const userFindMany = vi.fn(async (_args: unknown) => [] as unknown[]);

vi.mock("@polaris/db", () => ({
    prisma: {
        activity: {
            create: activityCreate,
            createMany: activityCreateMany,
            deleteMany: activityDeleteMany,
            findMany: activityFindMany
        },
        user: { findMany: userFindMany }
    }
}));

const activity = await import("../../src/lib/activity/activity");

const AT = new Date("2026-08-15T10:00:00.000Z");

function line(overrides: Record<string, unknown> = {}) {
    return {
        id: "l1",
        action: "deployed",
        fromValue: null,
        toValue: null,
        userId: "u1",
        createdAt: AT,
        ...overrides
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("writing", () => {
    it("fills in the parts a caller left out", async () => {
        await activity.record({ subjectType: "app", subjectId: "s1", action: "restarted" });

        expect(activityCreate).toHaveBeenCalledWith({
            data: {
                subjectType: "app",
                subjectId: "s1",
                userId: null,
                action: "restarted",
                fromValue: null,
                toValue: null
            }
        });
    });

    it("writes a batch in one statement", async () => {
        await activity.recordMany([
            { subjectType: "task", subjectId: "a", action: "status", fromValue: "To do", toValue: "Doing" },
            { subjectType: "task", subjectId: "b", action: "bulk" }
        ]);

        expect(activityCreateMany).toHaveBeenCalledTimes(1);
        const call = activityCreateMany.mock.calls[0]?.[0] as { data: unknown[] };
        expect(call.data).toHaveLength(2);
    });

    it("does not go to the database for an empty batch", async () => {
        await activity.recordMany([]);
        expect(activityCreateMany).not.toHaveBeenCalled();
    });

    it("writes inside the transaction it is handed, so a rollback takes the line with it", async () => {
        const txCreate = vi.fn(async (_args: unknown) => ({}));
        await activity.record({ subjectType: "task", subjectId: "t1", action: "created" }, {
            activity: { create: txCreate }
        } as never);

        expect(txCreate).toHaveBeenCalledTimes(1);
        expect(activityCreate).not.toHaveBeenCalled();
    });
});

describe("reading", () => {
    it("names the author from a separate lookup", async () => {
        activityFindMany.mockResolvedValueOnce([line()]);
        userFindMany.mockResolvedValueOnce([{ id: "u1", name: "Ana" }]);

        const lines = await activity.history("app", "s1");

        expect(lines).toEqual([
            { id: "l1", action: "deployed", fromValue: null, toValue: null, authorName: "Ana", createdAt: AT.toISOString() }
        ]);
    });

    it("keeps the line when the account behind it is gone", async () => {
        activityFindMany.mockResolvedValueOnce([line()]);
        userFindMany.mockResolvedValueOnce([]);

        const [only] = await activity.history("app", "s1");

        expect(only?.action).toBe("deployed");
        expect(only?.authorName).toBeNull();
    });

    it("attributes a line with no author to nobody rather than looking one up", async () => {
        activityFindMany.mockResolvedValueOnce([line({ userId: null })]);

        const [only] = await activity.history("task", "t1");

        expect(only?.authorName).toBeNull();
        expect(userFindMany).not.toHaveBeenCalled();
    });

    it("asks for each author once however many lines they wrote", async () => {
        activityFindMany.mockResolvedValueOnce([line(), line({ id: "l2" }), line({ id: "l3", userId: "u2" })]);
        userFindMany.mockResolvedValueOnce([
            { id: "u1", name: "Ana" },
            { id: "u2", name: "Bo" }
        ]);

        await activity.history("app", "s1");

        const call = userFindMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } };
        expect(call.where.id.in).toEqual(["u1", "u2"]);
    });

    it("reads nothing for an empty set of subjects", async () => {
        expect(await activity.historyOfMany("app", [])).toEqual([]);
        expect(activityFindMany).not.toHaveBeenCalled();
    });
});

describe("forgetting", () => {
    it("takes one subject or a list of them", async () => {
        await activity.forget("app", "s1");
        expect(activityDeleteMany).toHaveBeenCalledWith({
            where: { subjectType: "app", subjectId: { in: ["s1"] } }
        });

        await activity.forget("task", ["a", "b"]);
        expect(activityDeleteMany).toHaveBeenLastCalledWith({
            where: { subjectType: "task", subjectId: { in: ["a", "b"] } }
        });
    });

    it("does nothing for an empty list rather than matching everything", async () => {
        await activity.forget("task", []);
        expect(activityDeleteMany).not.toHaveBeenCalled();
    });
});
